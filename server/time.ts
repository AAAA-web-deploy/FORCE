export const NEW_YORK = 'America/New_York'

type Parts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function nyParts(ms: number): Parts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(ms))) map[part.type] = part.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/** Convert a New York civil time to a UTC epoch. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let pass = 0; pass < 4; pass += 1) {
    const shown = nyParts(utc)
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second)
    const desired = Date.UTC(year, month - 1, day, hour, minute, second)
    const delta = shownUtc - desired
    if (delta === 0) return utc
    utc -= delta
  }
  return utc
}

export function startOfNyDay(ms: number): number {
  const parts = nyParts(ms)
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0)
}

export function formatNy(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms))
}

export function parseNyDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const utc = zonedTimeToUtc(year, month, day, 0, 0, 0)
  const check = nyParts(utc)
  if (check.year !== year || check.month !== month || check.day !== day) return null
  return utc
}

export type Range = { start: number; end: number; unit: 'hour' | 'day' }

export function resolveRange(input: {
  range: string
  now: number
  from?: string | null
  to?: string | null
}): Range | { error: string } {
  const { range, now } = input
  if (range === '24h') return { start: now - 24 * 60 * 60 * 1000, end: now, unit: 'hour' }
  if (range === '7d') return { start: now - 7 * 24 * 60 * 60 * 1000, end: now, unit: 'day' }
  if (range === 'custom') {
    if (!input.from || !input.to) return { error: 'Choose a start and end date.' }
    const start = parseNyDate(input.from)
    const endDay = parseNyDate(input.to)
    if (start == null || endDay == null) return { error: 'Use YYYY-MM-DD dates.' }
    const end = endDay + 24 * 60 * 60 * 1000 - 1
    if (end < start) return { error: 'The end date is before the start date.' }
    if (end - start > 366 * 24 * 60 * 60 * 1000) return { error: 'Choose a range of one year or less.' }
    return { start, end: Math.min(end, now), unit: end - start > 48 * 60 * 60 * 1000 ? 'day' : 'hour' }
  }
  if (range !== 'today') return { error: 'Unknown range.' }
  return { start: startOfNyDay(now), end: now, unit: 'hour' }
}
