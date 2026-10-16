import type { IncomingMessage, ServerResponse } from 'node:http'
import { AnalyticsDb, type Filters } from './db.ts'
import { toCsv } from './csv.ts'
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  VISITOR_COOKIE,
  applyCors,
  clearCookie,
  clientRefused,
  cookieHeader,
  headerValue,
  originAllowed,
  type CookieSite,
  readCookies,
  readJson,
  requestIsHttps,
  sendJson,
  sendText,
} from './http.ts'
import { lookupPlace, type Place } from './geo.ts'
import { normalizeIp, resolveVisitorIp } from './ip.ts'
import { hashPassword, hashToken, newToken, safeEqual, verifyPassword } from './passwords.ts'
import { ensureSecrets } from './secrets.ts'
import { isDashboardPath, normalizeSitePath } from './static.ts'
import { formatNy, resolveRange } from './time.ts'
import { isLikelyBot, parseUserAgent } from './ua.ts'

const SESSION_MS = 8 * 60 * 60 * 1000
const VISIT_TIMEOUT_MS = 30 * 60 * 1000
const ACTIVE_MS = 90 * 1000
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SECTIONS = new Set(['hero', 'token', 'film', 'story'])
const CLICKS = new Set(['telegram', 'x', 'dextools', 'copy', 'film', 'community'])
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/

export type AppOptions = {
  dataDir: string
  bootstrapPassword?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  nodeEnv?: string
  trustProxy?: boolean
  trustedProxies?: string[]
  trustedIpHeader?: string
  retentionMs?: number
  maxFailures?: number
  delaySchedule?: number[]
  classifyLocalHost?: boolean
  treatNonProductionAsDevelopment?: boolean
  allowedOrigins?: string[]
  locate?: (ip: string) => Promise<Place | null>
}

export type App = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  close: () => void
  purge: () => void
  hasPassword: () => boolean
}

type ObjectBody = Record<string, unknown>

export function createApp(options: AppOptions): App {
  const secrets = ensureSecrets(options.dataDir)
  const db = new AnalyticsDb(options.dataDir, secrets.ipKey, options.locate ?? lookupPlace)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development'
  const trustProxy = options.trustProxy ?? false
  const trustedProxies = options.trustedProxies ?? []
  const trustedIpHeader = (options.trustedIpHeader ?? 'cf-connecting-ip').toLowerCase()
  const retentionMs = options.retentionMs ?? RETENTION_MS
  const maxFailures = options.maxFailures ?? 8
  const delaySchedule = options.delaySchedule ?? [0, 500, 1000, 2000, 4000, 8000]
  const classifyLocalHost = options.classifyLocalHost ?? nodeEnv === 'production'
  const treatNonProductionAsDevelopment =
    options.treatNonProductionAsDevelopment ?? (nodeEnv !== 'production' && nodeEnv !== 'test')
  const allowedOrigins = options.allowedOrigins ?? []
  const bootstrap = options.bootstrapPassword ?? process.env.DASHBOARD_PASSWORD
  if (!db.hasPassword() && bootstrap) db.setPasswordHash(hashPassword(bootstrap), now())

  const timer = setInterval(() => {
    db.purge(now() - retentionMs, now())
  }, 60 * 60 * 1000)
  timer.unref?.()
  db.purge(now() - retentionMs, now())

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    try {
      applyCors(req, res, allowedOrigins)
      if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        if (!originAllowed(req, allowedOrigins)) {
          sendJson(res, 403, { ok: false })
          return
        }
        res.statusCode = 204
        for (const [name, value] of Object.entries({
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        })) {
          res.setHeader(name, value)
        }
        res.end()
        return
      }
      if (req.method === 'POST' && !originAllowed(req, allowedOrigins)) {
        sendJson(res, 403, { ok: false })
        return
      }
      if (pathname === '/api/analytics/collect' && req.method === 'POST') {
        await collect(req, res, 'collect')
        return
      }
      if (pathname === '/api/analytics/heartbeat' && req.method === 'POST') {
        await collect(req, res, 'heartbeat')
        return
      }
      if (pathname === '/api/dashboard/session' && req.method === 'GET') {
        sessionStatus(req, res)
        return
      }
      if (pathname === '/api/dashboard/login' && req.method === 'POST') {
        await login(req, res)
        return
      }
      if (pathname === '/api/dashboard/logout' && req.method === 'POST') {
        logout(req, res)
        return
      }
      if (pathname === '/api/dashboard/change-password' && req.method === 'POST') {
        await changePassword(req, res)
        return
      }
      if (pathname.startsWith('/api/dashboard/analytics/')) {
        await analytics(req, res, pathname, url)
        return
      }
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false })
        return
      }
      sendJson(res, 404, { ok: false })
    } catch (error) {
      if (error instanceof Error && error.name === 'PayloadTooLarge') {
        sendJson(res, 413, { ok: false })
        return
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false })
        return
      }
      sendJson(res, 500, { ok: false })
    }
  }

  function secure(req: IncomingMessage): boolean {
    const remote = normalizeIp(req.socket.remoteAddress)
    const trustedPeer = Boolean(remote && trustProxy && trustedProxies.includes(remote))
    return requestIsHttps(req, trustedPeer)
  }

  function cookieFlags(req: IncomingMessage, sameSite: CookieSite): { secure: boolean; sameSite: CookieSite; partitioned: boolean } {
    const origin = headerValue(req.headers.origin)
    let crossSite = false
    if (origin) {
      try {
        crossSite = new URL(origin).host !== headerValue(req.headers.host)
      } catch {
        crossSite = false
      }
    }
    if (crossSite) return { secure: true, sameSite: 'None', partitioned: true }
    return { secure: secure(req), sameSite, partitioned: false }
  }

  function csrfCookie(token: string, req: IncomingMessage): string {
    return cookieHeader(CSRF_COOKIE, token, { maxAge: SESSION_MS / 1000, httpOnly: true, ...cookieFlags(req, 'Strict') })
  }

  function sessionCookie(token: string, req: IncomingMessage): string {
    return cookieHeader(SESSION_COOKIE, token, { maxAge: SESSION_MS / 1000, httpOnly: true, ...cookieFlags(req, 'Strict') })
  }

  function visitorCookie(token: string, req: IncomingMessage): string {
    return cookieHeader(VISITOR_COOKIE, token, { maxAge: 400 * 24 * 60 * 60, httpOnly: true, ...cookieFlags(req, 'Lax') })
  }

  function currentSession(req: IncomingMessage): { hash: string } | null {
    const token = readCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (!token) return null
    const hash = hashToken(secrets.pepper, token)
    const row = db.getSession(hash)
    if (!row || row.expires_at <= now()) {
      if (row) db.deleteSession(hash)
      return null
    }
    return { hash }
  }

  function requireSession(req: IncomingMessage, res: ServerResponse): boolean {
    if (currentSession(req)) return true
    sendJson(res, 401, { error: 'Unauthorized' })
    return false
  }

  function requireCsrf(req: IncomingMessage, res: ServerResponse): boolean {
    const cookies = readCookies(req.headers.cookie)
    const expected = cookies.get(CSRF_COOKIE) ?? ''
    const presented = headerValue(req.headers['x-csrf-token'])
    if (!expected || !safeEqual(expected, presented)) {
      sendJson(res, 403, { error: 'Request could not be verified.' })
      return false
    }
    return true
  }

  function sessionStatus(req: IncomingMessage, res: ServerResponse) {
    const cookies = readCookies(req.headers.cookie)
    let csrf = cookies.get(CSRF_COOKIE) ?? ''
    const issued: string[] = []
    if (!/^[A-Za-z0-9_-]{20,}$/.test(csrf)) {
      csrf = newToken()
      issued.push(csrfCookie(csrf, req))
    }
    const session = currentSession(req)
    sendJson(res, 200, { authenticated: Boolean(session), csrfToken: csrf }, issued)
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    if (!requireCsrf(req, res)) return
    if (!db.hasPassword()) {
      sendJson(res, 503, { error: 'Dashboard password is not configured.' })
      return
    }
    const body = asObject(await readJson(req))
    const password = typeof body.password === 'string' ? body.password : ''
    const visitorIp =
      resolveVisitorIp({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        trustProxy,
        trustedProxies,
        trustedIpHeader,
      }) ??
      normalizeIp(req.socket.remoteAddress) ??
      'unavailable'
    const subject = hashToken(secrets.pepper, `${visitorIp}|${headerValue(req.headers['user-agent'])}`)
    const failures = db.countFailures(subject, now() - ATTEMPT_WINDOW_MS)
    if (failures >= maxFailures) {
      sendJson(res, 429, { error: 'Too many attempts. Please try again later.' })
      return
    }
    const delay = delaySchedule[Math.min(failures, delaySchedule.length - 1)] ?? 0
    if (delay > 0) await sleep(delay)
    const stored = db.getPasswordHash()
    const valid = stored ? verifyPassword(password, stored) : false
    if (!valid) {
      db.addFailure(subject, now())
      sendJson(res, 401, { error: 'Incorrect password. Please try again.' })
      return
    }
    const previous = readCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (previous) db.deleteSession(hashToken(secrets.pepper, previous))
    const token = newToken()
    const csrf = newToken()
    const at = now()
    db.clearFailures(subject)
    db.createSession(hashToken(secrets.pepper, token), at, at + SESSION_MS)
    sendJson(res, 200, { ok: true, csrfToken: csrf }, [sessionCookie(token, req), csrfCookie(csrf, req)])
  }

  function logout(req: IncomingMessage, res: ServerResponse) {
    if (!requireCsrf(req, res)) return
    const token = readCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (token) db.deleteSession(hashToken(secrets.pepper, token))
    const flags = cookieFlags(req, 'Strict')
    sendJson(res, 200, { ok: true }, [clearCookie(SESSION_COOKIE, flags), clearCookie(CSRF_COOKIE, flags)])
  }

  async function changePassword(req: IncomingMessage, res: ServerResponse) {
    if (!requireSession(req, res)) return
    if (!requireCsrf(req, res)) return
    const body = asObject(await readJson(req))
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const next = typeof body.newPassword === 'string' ? body.newPassword : ''
    const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
    if (next.length < 4 || next.length > 200) {
      sendJson(res, 400, { error: 'Use a new password of at least 4 characters.' })
      return
    }
    if (next !== confirm) {
      sendJson(res, 400, { error: 'New password and confirmation do not match.' })
      return
    }
    const stored = db.getPasswordHash()
    if (!stored || !verifyPassword(current, stored)) {
      sendJson(res, 400, { error: 'Current password is incorrect.' })
      return
    }
    if (verifyPassword(next, stored)) {
      sendJson(res, 400, { error: 'Choose a different password.' })
      return
    }
    db.setPasswordHash(hashPassword(next), now())
    db.deleteAllSessions()
    const flags = cookieFlags(req, 'Strict')
    sendJson(res, 200, { ok: true, message: 'Password changed. Sign in with the new password.' }, [
      clearCookie(SESSION_COOKIE, flags),
      clearCookie(CSRF_COOKIE, flags),
    ])
  }

  async function collect(req: IncomingMessage, res: ServerResponse, route: 'collect' | 'heartbeat') {
    if (clientRefused(req)) {
      sendJson(res, 200, { ok: true })
      return
    }
    const body = asObject(await readJson(req))
    const type = typeof body.type === 'string' ? body.type : ''
    if (route === 'heartbeat' && type !== 'heartbeat') {
      sendJson(res, 400, { ok: false })
      return
    }
    if (route === 'collect' && type !== 'pageview' && type !== 'section' && type !== 'click') {
      sendJson(res, 400, { ok: false })
      return
    }
    const eventId = typeof body.eventId === 'string' ? body.eventId : ''
    const eventPath = cleanPath(body.path)
    if (!EVENT_ID.test(eventId) || !eventPath) {
      sendJson(res, 400, { ok: false })
      return
    }
    const section = typeof body.section === 'string' && SECTIONS.has(body.section) ? body.section : null
    const click = typeof body.click === 'string' && CLICKS.has(body.click) ? body.click : null
    if (type === 'click' && !click) {
      sendJson(res, 400, { ok: false })
      return
    }
    const cookies = readCookies(req.headers.cookie)
    let visitorId = cookies.get(VISITOR_COOKIE) ?? ''
    const issued: string[] = []
    if (!ID_PATTERN.test(visitorId)) {
      visitorId = newToken()
      issued.push(visitorCookie(visitorId, req))
    }
    const device = parseUserAgent(headerValue(req.headers['user-agent']))
    const sitePath = normalizeSitePath(eventPath) ?? eventPath
    const classification = classify(req, sitePath)
    db.record({
      visitorId,
      eventId,
      type: type as 'pageview' | 'heartbeat' | 'section' | 'click',
      path: sitePath.slice(0, 200),
      section,
      click,
      at: now(),
      browser: device.browser,
      os: device.os,
      device: device.device,
      referrer: referrerHost(body.referrer),
      utmSource: cleanUtm(body.utmSource),
      utmMedium: cleanUtm(body.utmMedium),
      utmCampaign: cleanUtm(body.utmCampaign),
      ip: resolveVisitorIp({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        trustProxy,
        trustedProxies,
        trustedIpHeader,
      }),
      classification,
      visitTimeoutMs: VISIT_TIMEOUT_MS,
    })
    sendJson(res, 200, { ok: true }, issued)
  }

  function classify(req: IncomingMessage, sitePath: string): string {
    if (currentSession(req) || isDashboardPath(sitePath)) return 'admin'
    if (isLikelyBot(headerValue(req.headers['user-agent']))) return 'bot'
    const host = headerValue(req.headers.host).split(':')[0]?.toLowerCase() ?? ''
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    if (treatNonProductionAsDevelopment || (classifyLocalHost && local)) return 'development'
    return 'visitor'
  }

  async function analytics(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
    if (!requireSession(req, res)) return
    if (req.method === 'GET' && pathname === '/api/dashboard/analytics/summary') {
      const filters = readFilters(url)
      if ('error' in filters) {
        sendJson(res, 400, { error: filters.error })
        return
      }
      sendJson(res, 200, { ...db.summary(filters, now() - ACTIVE_MS), estimated: true, timezone: 'America/New_York', generatedAt: now() })
      return
    }
    if (req.method === 'GET' && pathname === '/api/dashboard/analytics/visits') {
      const filters = readFilters(url)
      if ('error' in filters) {
        sendJson(res, 400, { error: filters.error })
        return
      }
      const page = clampInt(url.searchParams.get('page'), 1, 100000)
      const pageSize = clampInt(url.searchParams.get('pageSize'), 25, 100)
      const listed = await db.listVisits(filters, page, pageSize)
      sendJson(res, 200, { page, pageSize, total: listed.total, visits: listed.visits, timezone: 'America/New_York' })
      return
    }
    if (req.method === 'GET' && pathname === '/api/dashboard/analytics/export') {
      if (!requireCsrf(req, res)) return
      const filters = readFilters(url)
      if ('error' in filters) {
        sendJson(res, 400, { error: filters.error })
        return
      }
      const reveal = url.searchParams.get('reveal') === '1'
      const rows = await db.exportVisits(filters, reveal, 5000)
      const csv = toCsv([
        ['visit_id', 'visitor_id', 'ip', 'location', 'started_at', 'last_seen', 'path', 'section', 'browser', 'os', 'device', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'classification'],
        ...rows.map((row) => [
          row.id,
          row.visitorId,
          row.ip,
          row.location,
          formatNy(row.startedAt),
          formatNy(row.lastSeen),
          row.path,
          row.section ?? '',
          row.browser,
          row.os,
          row.device,
          row.referrer,
          row.utmSource ?? '',
          row.utmMedium ?? '',
          row.utmCampaign ?? '',
          row.classification,
        ]),
      ])
      sendText(res, 200, csv, 'text/csv; charset=utf-8', [], {
        'content-disposition': 'attachment; filename="musk-gravity-visits.csv"',
      })
      return
    }
    const detail = /^\/api\/dashboard\/analytics\/visits\/([^/]+)$/.exec(pathname)
    if (req.method === 'GET' && detail) {
      const visit = await db.getVisit(detail[1], url.searchParams.get('reveal') === '1')
      if (!visit) {
        sendJson(res, 404, { error: 'Visit not found.' })
        return
      }
      sendJson(res, 200, visit)
      return
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/analytics/delete') {
      await deleteVisits(req, res)
      return
    }
    sendJson(res, 404, { error: 'Not found.' })
  }

  async function deleteVisits(req: IncomingMessage, res: ServerResponse) {
    if (!requireCsrf(req, res)) return
    const body = asObject(await readJson(req))
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && EVENT_ID.test(id)).slice(0, 100) : []
    if (ids.length === 0) {
      sendJson(res, 400, { error: 'Select at least one visit.' })
      return
    }
    const deleted = db.deleteVisits(ids)
    sendJson(res, 200, { ok: true, deleted })
  }

  function readFilters(url: URL): Filters | { error: string } {
    const range = resolveRange({
      range: url.searchParams.get('range') ?? 'today',
      now: now(),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    })
    if ('error' in range) return range
    const campaign = optionalUtm(url.searchParams.get('campaign'))
    const referrer = optionalHost(url.searchParams.get('referrer'))
    if (campaign === false || referrer === false) return { error: 'That filter is not valid.' }
    const classes = ['visitor']
    if (url.searchParams.get('bots') === '1') classes.push('bot')
    if (url.searchParams.get('tests') === '1') classes.push('admin', 'development')
    return { range, campaign, referrer, classes }
  }

  return {
    handle,
    purge: () => db.purge(now() - retentionMs, now()),
    hasPassword: () => db.hasPassword(),
    close: () => {
      clearInterval(timer)
      db.close()
    },
  }
}

function asObject(value: unknown): ObjectBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as ObjectBody
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return null
  }
  return value.split('#')[0]?.slice(0, 200) ?? null
}

function cleanUtm(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim().slice(0, 80)
  if (!/^[A-Za-z0-9._~+-]+$/.test(trimmed)) return null
  return trimmed
}

function optionalUtm(value: string | null): string | null | false {
  if (!value) return null
  return cleanUtm(value) ?? false
}

function optionalHost(value: string | null): string | null | false {
  if (!value) return null
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(value) || value.includes('..')) return false
  return value.toLowerCase()
}

function referrerHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.slice(0, 253)
    return host || null
  } catch {
    return null
  }
}

function clampInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return Math.min(fallback, max)
  return Math.min(parsed, max)
}
