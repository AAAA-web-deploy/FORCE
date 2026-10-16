import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { formatPlace, type Place } from './geo.ts'
import { decryptIp, encryptIp, isPublicIp, maskIp } from './ip.ts'
import { nyParts, zonedTimeToUtc, type Range } from './time.ts'

type Sql = string | number | bigint | null

export type VisitRow = {
  id: string
  visitor_id: string
  started_at: number
  last_seen: number
  path: string
  section: string | null
  browser: string
  os: string
  device: string
  referrer_host: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  ip_cipher: string | null
  ip_iv: string | null
  ip_tag: string | null
  classification: string
}

export type StoredVisit = {
  id: string
  visitorId: string
  startedAt: number
  lastSeen: number
  path: string
  section: string | null
  browser: string
  os: string
  device: string
  referrer: string
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  classification: string
  ip: string
  ipAvailable: boolean
  location: string
}

export type Filters = {
  range: Range
  campaign: string | null
  referrer: string | null
  classes: string[]
}

const SCHEMA = `
CREATE TABLE auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_subject ON login_attempts(subject_hash, attempted_at);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY
);
CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  path TEXT NOT NULL,
  section TEXT,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  device TEXT NOT NULL,
  referrer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  ip_cipher TEXT,
  ip_iv TEXT,
  ip_tag TEXT,
  classification TEXT NOT NULL
);
CREATE INDEX visits_last_seen ON visits(last_seen);
CREATE INDEX visits_started ON visits(started_at);
CREATE INDEX visits_visitor ON visits(visitor_id, last_seen);
CREATE TABLE page_views (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  visit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX page_views_created ON page_views(created_at);
CREATE TABLE heartbeats (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  visit_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  section TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX heartbeats_visitor_time ON heartbeats(visitor_id, created_at);
CREATE TABLE clicks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  visit_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX clicks_created ON clicks(created_at);
`

function uniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message)
}

const LOCATION_TTL_MS = 12 * 60 * 60 * 1000

export class AnalyticsDb {
  readonly db: DatabaseSync
  private readonly ipKey: Buffer
  private readonly locate: (ip: string) => Promise<Place | null>

  constructor(dataDir: string, ipKey: Buffer, locate: (ip: string) => Promise<Place | null> = async () => null) {
    this.ipKey = ipKey
    this.locate = locate
    this.db = new DatabaseSync(path.join(dataDir, 'analytics.sqlite'))
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    this.apply(
      '001_init',
      SCHEMA,
    )
    this.apply(
      '002_locations',
      `CREATE TABLE IF NOT EXISTS ip_locations (
        ip_hash TEXT PRIMARY KEY,
        country TEXT NOT NULL,
        region TEXT NOT NULL,
        city TEXT NOT NULL,
        looked_up_at INTEGER NOT NULL
      )`,
    )
    this.ensureIpHashColumn()
  }

  private ensureIpHashColumn() {
    const columns = this.db.prepare('PRAGMA table_info(visits)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'ip_hash')) {
      this.db.exec('ALTER TABLE visits ADD COLUMN ip_hash TEXT')
      this.db.exec('CREATE INDEX IF NOT EXISTS visits_ip_hash ON visits(ip_hash)')
    }
    const pending = this.db
      .prepare('SELECT id, ip_cipher, ip_iv, ip_tag FROM visits WHERE ip_hash IS NULL AND ip_cipher IS NOT NULL')
      .all() as { id: string; ip_cipher: string; ip_iv: string; ip_tag: string }[]
    const update = this.db.prepare('UPDATE visits SET ip_hash = ? WHERE id = ?')
    for (const row of pending) {
      const plain = decryptIp(this.ipKey, row.ip_cipher, row.ip_iv, row.ip_tag)
      if (!plain) continue
      update.run(ipHash(plain), row.id)
    }
  }

  private apply(id: string, sql: string) {
    const existing = this.db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id)
    if (existing) return
    this.db.exec('BEGIN')
    try {
      this.db.exec(sql)
      this.db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.db.close()
  }

  hasPassword(): boolean {
    return Boolean(this.db.prepare('SELECT id FROM auth WHERE id = 1').get())
  }

  getPasswordHash(): string | null {
    const row = this.db.prepare('SELECT password_hash FROM auth WHERE id = 1').get() as { password_hash: string } | undefined
    return row?.password_hash ?? null
  }

  setPasswordHash(hash: string, at: number) {
    this.db.prepare(
      `INSERT INTO auth (id, password_hash, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
    ).run(hash, at)
  }

  countFailures(subject: string, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE subject_hash = ? AND attempted_at >= ?')
      .get(subject, since) as { n: number }
    return Number(row.n)
  }

  addFailure(subject: string, at: number) {
    this.db.prepare('INSERT INTO login_attempts (subject_hash, attempted_at) VALUES (?, ?)').run(subject, at)
  }

  clearFailures(subject: string) {
    this.db.prepare('DELETE FROM login_attempts WHERE subject_hash = ?').run(subject)
  }

  createSession(tokenHash: string, createdAt: number, expiresAt: number) {
    this.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, createdAt, expiresAt)
  }

  getSession(tokenHash: string): { expires_at: number } | null {
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { expires_at: number }
      | undefined
    return row ?? null
  }

  deleteSession(tokenHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  }

  deleteAllSessions() {
    this.db.exec('DELETE FROM sessions')
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  record(input: {
    visitorId: string
    eventId: string
    type: 'pageview' | 'heartbeat' | 'section' | 'click'
    path: string
    section: string | null
    click: string | null
    at: number
    browser: string
    os: string
    device: string
    referrer: string | null
    utmSource: string | null
    utmMedium: string | null
    utmCampaign: string | null
    ip: string | null
    classification: string
    visitTimeoutMs: number
  }): boolean {
    try {
      this.transaction(() => {
        this.db.prepare('INSERT INTO events (event_id) VALUES (?)').run(input.eventId)
        this.db
          .prepare(
            `INSERT INTO visitors (id, first_seen, last_seen) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
          )
          .run(input.visitorId, input.at, input.at)
        const latest = this.db
          .prepare('SELECT id, last_seen FROM visits WHERE visitor_id = ? ORDER BY last_seen DESC LIMIT 1')
          .get(input.visitorId) as { id: string; last_seen: number } | undefined
        const gap = latest ? input.at - latest.last_seen : Number.POSITIVE_INFINITY
        let visitId = latest && gap >= 0 && gap <= input.visitTimeoutMs ? latest.id : null
        if (!visitId) {
          visitId = randomUUID()
          const encrypted = input.ip ? encryptIp(this.ipKey, input.ip) : null
          this.db
            .prepare(
              `INSERT INTO visits (
                id, visitor_id, started_at, last_seen, path, section, browser, os, device,
                referrer_host, utm_source, utm_medium, utm_campaign, ip_cipher, ip_iv, ip_tag, ip_hash, classification
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              visitId,
              input.visitorId,
              input.at,
              input.at,
              input.path,
              input.section,
              input.browser,
              input.os,
              input.device,
              input.referrer,
              input.utmSource,
              input.utmMedium,
              input.utmCampaign,
              encrypted?.cipher ?? null,
              encrypted?.iv ?? null,
              encrypted?.tag ?? null,
              input.ip ? ipHash(input.ip) : null,
              input.classification,
            )
        }
        if (input.type === 'pageview') {
          this.db
            .prepare('INSERT INTO page_views (id, event_id, visit_id, path, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(randomUUID(), input.eventId, visitId, input.path, input.at)
        } else if (input.type === 'heartbeat') {
          this.db
            .prepare('INSERT INTO heartbeats (id, event_id, visit_id, visitor_id, section, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), input.eventId, visitId, input.visitorId, input.section, input.at)
        } else if (input.type === 'click') {
          this.db
            .prepare('INSERT INTO clicks (id, event_id, visit_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(randomUUID(), input.eventId, visitId, input.click, input.at)
        }
        this.db
          .prepare('UPDATE visits SET last_seen = ?, path = ?, section = COALESCE(?, section) WHERE id = ?')
          .run(input.at, input.path, input.section, visitId)
        this.db.prepare('UPDATE visitors SET last_seen = ? WHERE id = ?').run(input.at, input.visitorId)
      })
      return true
    } catch (error) {
      if (uniqueError(error)) return false
      throw error
    }
  }

  private where(filters: Filters): { sql: string; args: Sql[] } {
    const placeholders = filters.classes.map(() => '?').join(', ')
    const args: Sql[] = [filters.range.start, filters.range.end, ...filters.classes]
    let sql = `started_at >= ? AND started_at <= ? AND classification IN (${placeholders})`
    if (filters.campaign) {
      sql += ' AND utm_campaign = ?'
      args.push(filters.campaign)
    }
    if (filters.referrer) {
      sql += ' AND referrer_host = ?'
      args.push(filters.referrer)
    }
    return { sql, args }
  }

  summary(filters: Filters, activeSince: number) {
    const where = this.where(filters)
    const classPlaceholders = filters.classes.map(() => '?').join(', ')
    const classArgs = filters.classes
    const visits = this.db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE ${where.sql}`).get(...where.args) as { n: number }
    const visitors = this.db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(ip_hash, visitor_id)) AS n FROM visits
         WHERE last_seen >= ? AND started_at <= ? AND classification IN (${classPlaceholders})
         ${filters.campaign ? 'AND utm_campaign = ?' : ''}
         ${filters.referrer ? 'AND referrer_host = ?' : ''}`,
      )
      .get(
        filters.range.start,
        filters.range.end,
        ...classArgs,
        ...(filters.campaign ? [filters.campaign] : []),
        ...(filters.referrer ? [filters.referrer] : []),
      ) as { n: number }
    const views = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM page_views p JOIN visits v ON v.id = p.visit_id
         WHERE p.created_at >= ? AND p.created_at <= ? AND v.classification IN (${classPlaceholders})
         ${filters.campaign ? 'AND v.utm_campaign = ?' : ''}
         ${filters.referrer ? 'AND v.referrer_host = ?' : ''}`,
      )
      .get(
        filters.range.start,
        filters.range.end,
        ...classArgs,
        ...(filters.campaign ? [filters.campaign] : []),
        ...(filters.referrer ? [filters.referrer] : []),
      ) as { n: number }
    const clickRows = this.db
      .prepare(
        `SELECT c.kind AS kind, COUNT(*) AS n FROM clicks c JOIN visits v ON v.id = c.visit_id
         WHERE c.created_at >= ? AND c.created_at <= ? AND v.classification IN (${classPlaceholders})
         ${filters.campaign ? 'AND v.utm_campaign = ?' : ''}
         ${filters.referrer ? 'AND v.referrer_host = ?' : ''}
         GROUP BY c.kind`,
      )
      .all(
        filters.range.start,
        filters.range.end,
        ...classArgs,
        ...(filters.campaign ? [filters.campaign] : []),
        ...(filters.referrer ? [filters.referrer] : []),
      ) as { kind: string; n: number }[]
    const clicks = { telegram: 0, x: 0, dextools: 0, copy: 0, film: 0, community: 0, total: 0 }
    for (const row of clickRows) {
      if (row.kind === 'telegram' || row.kind === 'x' || row.kind === 'dextools' || row.kind === 'copy' || row.kind === 'film' || row.kind === 'community') {
        clicks[row.kind] = Number(row.n)
        clicks.total += Number(row.n)
      }
    }
    const active = this.db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(v.ip_hash, h.visitor_id)) AS n FROM heartbeats h
         JOIN visits v ON v.id = h.visit_id
         WHERE h.created_at >= ? AND v.classification IN (${classPlaceholders})`,
      )
      .get(activeSince, ...classArgs) as { n: number }
    const started = this.db
      .prepare(`SELECT visitor_id, ip_hash, started_at FROM visits WHERE ${where.sql}`)
      .all(...where.args) as { visitor_id: string; ip_hash: string | null; started_at: number }[]
    const referrals = this.db
      .prepare(
        `SELECT COALESCE(referrer_host, '') AS host, COUNT(*) AS n FROM visits WHERE ${where.sql}
         GROUP BY host ORDER BY n DESC LIMIT 20`,
      )
      .all(...where.args) as { host: string; n: number }[]
    const campaigns = this.db
      .prepare(
        `SELECT COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, COALESCE(utm_campaign, '') AS campaign, COUNT(*) AS n
         FROM visits WHERE ${where.sql} AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
         GROUP BY source, medium, campaign ORDER BY n DESC LIMIT 20`,
      )
      .all(...where.args) as { source: string; medium: string; campaign: string; n: number }[]
    return {
      activeVisitors: Number(active.n),
      browserVisitors: Number(visitors.n),
      visits: Number(visits.n),
      pageViews: Number(views.n),
      clicks,
      trend: bucketTrend(
        started.map((row) => ({ visitorId: row.ip_hash ?? row.visitor_id, at: row.started_at })),
        filters.range,
      ),
      trendUnit: filters.range.unit,
      referrals: referrals.map((row) => ({ host: row.host || '(direct)', visits: Number(row.n) })),
      campaigns: campaigns.map((row) => ({
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        visits: Number(row.n),
      })),
    }
  }

  async listVisits(filters: Filters, page: number, pageSize: number) {
    const where = this.where(filters)
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE ${where.sql}`).get(...where.args) as { n: number }
    const rows = this.db
      .prepare(`SELECT * FROM visits WHERE ${where.sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...where.args, pageSize, (page - 1) * pageSize) as VisitRow[]
    const places = await this.placesFor(rows)
    return { total: Number(total.n), visits: rows.map((row) => this.present(row, false, places)) }
  }

  async getVisit(id: string, reveal: boolean): Promise<(StoredVisit & { pageViews: { path: string; createdAt: number }[]; clicks: { kind: string; createdAt: number }[] }) | null> {
    const row = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(id) as VisitRow | undefined
    if (!row) return null
    const places = await this.placesFor([row])
    const pageViews = this.db
      .prepare('SELECT path, created_at FROM page_views WHERE visit_id = ? ORDER BY created_at')
      .all(id) as { path: string; created_at: number }[]
    const clicks = this.db.prepare('SELECT kind, created_at FROM clicks WHERE visit_id = ? ORDER BY created_at').all(id) as {
      kind: string
      created_at: number
    }[]
    return {
      ...this.present(row, reveal, places),
      pageViews: pageViews.map((item) => ({ path: item.path, createdAt: item.created_at })),
      clicks: clicks.map((item) => ({ kind: item.kind, createdAt: item.created_at })),
    }
  }

  async exportVisits(filters: Filters, reveal: boolean, limit: number): Promise<StoredVisit[]> {
    const where = this.where(filters)
    const rows = this.db
      .prepare(`SELECT * FROM visits WHERE ${where.sql} ORDER BY started_at DESC LIMIT ?`)
      .all(...where.args, limit) as VisitRow[]
    const places = await this.placesFor(rows.slice(0, 200))
    return rows.map((row) => this.present(row, reveal, places))
  }

  deleteVisits(ids: string[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    return this.transaction(() => {
      this.db.prepare(`DELETE FROM page_views WHERE visit_id IN (${placeholders})`).run(...ids)
      this.db.prepare(`DELETE FROM heartbeats WHERE visit_id IN (${placeholders})`).run(...ids)
      this.db.prepare(`DELETE FROM clicks WHERE visit_id IN (${placeholders})`).run(...ids)
      const result = this.db.prepare(`DELETE FROM visits WHERE id IN (${placeholders})`).run(...ids)
      this.db.exec('DELETE FROM visitors WHERE id NOT IN (SELECT visitor_id FROM visits)')
      return Number(result.changes)
    })
  }

  purge(before: number, now: number) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM page_views WHERE visit_id IN (SELECT id FROM visits WHERE last_seen < ?)').run(before)
      this.db.prepare('DELETE FROM heartbeats WHERE visit_id IN (SELECT id FROM visits WHERE last_seen < ?)').run(before)
      this.db.prepare('DELETE FROM clicks WHERE visit_id IN (SELECT id FROM visits WHERE last_seen < ?)').run(before)
      this.db.prepare('DELETE FROM visits WHERE last_seen < ?').run(before)
      this.db.exec('DELETE FROM visitors WHERE id NOT IN (SELECT visitor_id FROM visits)')
      this.db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(before)
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    })
  }

  private async placesFor(rows: VisitRow[]): Promise<Map<string, Place | null>> {
    const wanted = new Map<string, string>()
    for (const row of rows) {
      const plain = row.ip_cipher && row.ip_iv && row.ip_tag ? decryptIp(this.ipKey, row.ip_cipher, row.ip_iv, row.ip_tag) : null
      if (!plain || !isPublicIp(plain)) continue
      wanted.set(ipHash(plain), plain)
    }
    const places = new Map<string, Place | null>()
    const pending: Promise<void>[] = []
    for (const [hash, ip] of wanted) {
      const cached = this.db
        .prepare('SELECT country, region, city, looked_up_at FROM ip_locations WHERE ip_hash = ?')
        .get(hash) as { country: string; region: string; city: string; looked_up_at: number } | undefined
      const fresh = cached && Date.now() - cached.looked_up_at < LOCATION_TTL_MS
      if (fresh) {
        places.set(hash, cached.country || cached.region || cached.city ? cached : null)
        continue
      }
      pending.push(
        this.locate(ip).then((place) => {
          const stored = place ?? { country: '', region: '', city: '' }
          this.db
            .prepare(
              `INSERT INTO ip_locations (ip_hash, country, region, city, looked_up_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(ip_hash) DO UPDATE SET country = excluded.country, region = excluded.region, city = excluded.city, looked_up_at = excluded.looked_up_at`,
            )
            .run(hash, stored.country, stored.region, stored.city, Date.now())
          places.set(hash, place)
        }),
      )
    }
    await Promise.all(pending)
    return places
  }

  private present(row: VisitRow, reveal: boolean, places: Map<string, Place | null> = new Map()): StoredVisit {
    const plain =
      row.ip_cipher && row.ip_iv && row.ip_tag ? decryptIp(this.ipKey, row.ip_cipher, row.ip_iv, row.ip_tag) : null
    const place = plain && isPublicIp(plain) ? places.get(ipHash(plain)) : null
    return {
      id: row.id,
      visitorId: row.visitor_id,
      startedAt: row.started_at,
      lastSeen: row.last_seen,
      path: row.path,
      section: row.section,
      browser: row.browser,
      os: row.os,
      device: row.device,
      referrer: row.referrer_host || '(direct)',
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      classification: row.classification,
      ip: reveal ? (plain ?? 'Unavailable') : maskIp(plain),
      ipAvailable: Boolean(plain),
      location: formatPlace(place),
    }
  }
}

function ipHash(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

function bucketTrend(rows: { visitorId: string; at: number }[], range: Range): { start: number; label: string; visitors: number }[] {
  const buckets = new Map<number, Set<string>>()
  const starts: number[] = []
  let cursor = range.unit === 'day' ? startOfDay(range.start) : startOfHour(range.start)
  const end = range.end
  while (cursor <= end && starts.length < 48) {
    starts.push(cursor)
    buckets.set(cursor, new Set())
    cursor = range.unit === 'day' ? cursor + 24 * 60 * 60 * 1000 : cursor + 60 * 60 * 1000
  }
  for (const row of rows) {
    const key = range.unit === 'day' ? startOfDay(row.at) : startOfHour(row.at)
    buckets.get(key)?.add(row.visitorId)
  }
  return starts.map((start) => ({
    start,
    label: trendLabel(start, range.unit),
    visitors: buckets.get(start)?.size ?? 0,
  }))
}

function trendLabel(ms: number, unit: 'hour' | 'day'): string {
  if (unit === 'day') {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(ms)
  }
  const hour = nyParts(ms).hour
  const suffix = hour < 12 ? 'a' : 'p'
  const shown = hour % 12 === 0 ? 12 : hour % 12
  return `${shown}${suffix}`
}

function startOfDay(ms: number): number {
  const parts = nyParts(ms)
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0)
}

function startOfHour(ms: number): number {
  const parts = nyParts(ms)
  return zonedTimeToUtc(parts.year, parts.month, parts.day, parts.hour, 0, 0)
}
