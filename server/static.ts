import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function normalizeSitePath(urlPath: string, base = '/'): string | null {
  let pathname = urlPath.split('?')[0] ?? '/'
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  const normalized = path.posix.normalize(pathname)
  if (!normalized.startsWith('/')) return null
  let relative = normalized
  if (relative === base || relative.startsWith(`${base}/`)) relative = relative.slice(base.length) || '/'
  let cleaned = path.posix.normalize(relative)
  if (!cleaned.startsWith('/') || cleaned.split('/').includes('..')) return null
  if (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1)
  return cleaned
}

export function isDashboardPath(pathname: string): boolean {
  return pathname === '/dashboard' || pathname === '/dashboard/' || pathname.endsWith('/dashboard')
}

export function fileInside(root: string, pathname: string): string | null {
  const file = path.resolve(root, `.${pathname}`)
  const base = path.resolve(root)
  if (file !== base && !file.startsWith(base + path.sep)) return null
  return file
}

export function withDashboardRobots(html: string): string {
  if (/name="robots"/i.test(html)) {
    return html.replace(/name="robots"\s+content="[^"]*"/i, 'name="robots" content="noindex, nofollow"')
  }
  return html.replace('<head>', '<head>\n    <meta name="robots" content="noindex, nofollow" />')
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, dist: string) {
  const pathname = normalizeSitePath(req.url ?? '/')
  if (!pathname) {
    res.statusCode = 400
    res.end('Bad request')
    return
  }
  const dashboard = isDashboardPath(pathname)
  const extension = path.extname(pathname)
  if (extension) {
    const file = fileInside(dist, pathname)
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', TYPES[extension] ?? 'application/octet-stream')
    res.setHeader('x-content-type-options', 'nosniff')
    createReadStream(file).pipe(res)
    return
  }
  const index = path.join(dist, dashboard ? path.join('dashboard', 'index.html') : 'index.html')
  if (!existsSync(index)) {
    res.statusCode = 404
    res.end('Build the site before starting the server.')
    return
  }
  const html = dashboard ? withDashboardRobots(readFileSync(index, 'utf8')) : readFileSync(index, 'utf8')
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (dashboard) {
    res.setHeader('cache-control', 'private, no-store')
    res.setHeader('x-robots-tag', 'noindex, nofollow')
  }
  res.end(html)
}
