import type { IncomingMessage, ServerResponse } from 'node:http'

export const SESSION_COOKIE = 'selfish_session'
export const CSRF_COOKIE = 'selfish_csrf'
export const VISITOR_COOKIE = 'selfish_vid'

const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'cdn-cache-control': 'no-store',
  pragma: 'no-cache',
  vary: 'Cookie, Origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cookies: string[] = []) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) res.setHeader(name, value)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (cookies.length) res.setHeader('set-cookie', cookies)
  res.end(payload)
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  cookies: string[] = [],
  headers: Record<string, string> = {},
) {
  res.statusCode = status
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) res.setHeader(name, value)
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.setHeader('content-type', contentType)
  if (cookies.length) res.setHeader('set-cookie', cookies)
  res.end(body)
}

export function readCookies(header: string | string[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const raw = Array.isArray(header) ? header.join(';') : header
  if (!raw) return map
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) map.set(name, decodeURIComponent(value))
  }
  return map
}

export type CookieSite = 'Strict' | 'Lax' | 'None'

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: CookieSite; partitioned?: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${options.maxAge}`, `SameSite=${options.sameSite}`]
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.partitioned) parts.push('Partitioned')
  return parts.join('; ')
}

export function clearCookie(name: string, options: { secure: boolean; sameSite: CookieSite; partitioned?: boolean }): string {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', `SameSite=${options.sameSite}`, 'HttpOnly']
  if (options.secure) parts.push('Secure')
  if (options.partitioned) parts.push('Partitioned')
  return parts.join('; ')
}

export async function readJson(req: IncomingMessage, limit = 8192): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      const error = new Error('Body too large')
      error.name = 'PayloadTooLarge'
      throw error
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function originAllowed(req: IncomingMessage, allowedOrigins: string[] = []): boolean {
  const origin = headerValue(req.headers.origin)
  const host = headerValue(req.headers.host)
  if (!origin) {
    const site = headerValue(req.headers['sec-fetch-site'])
    if (site && site !== 'same-origin' && site !== 'none') return false
    return true
  }
  try {
    if (new URL(origin).host === host) return true
    return allowedOrigins.includes(origin)
  } catch {
    return false
  }
}

export function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const origin = headerValue(req.headers.origin)
  if (!origin || !allowedOrigins.includes(origin)) return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-headers', 'accept, authorization, content-type, x-csrf-token')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
  res.setHeader('vary', 'Cookie, Origin')
}

export function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export function requestIsHttps(req: IncomingMessage, trustForwardedProto: boolean): boolean {
  const socket = req.socket as { encrypted?: boolean }
  if (socket.encrypted) return true
  if (!trustForwardedProto) return false
  return headerValue(req.headers['x-forwarded-proto']).split(',')[0]?.trim() === 'https'
}

export function clientRefused(req: IncomingMessage): boolean {
  const gpc = headerValue(req.headers['sec-gpc'])
  const dnt = headerValue(req.headers.dnt)
  return gpc === '1' || dnt === '1'
}
