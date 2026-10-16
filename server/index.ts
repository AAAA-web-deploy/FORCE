import { createServer } from 'node:http'
import path from 'node:path'
import { createApp } from './createApp.ts'
import { serveStatic } from './static.ts'

const dataDir = process.env.FORCE_DATA_DIR ?? path.join(process.cwd(), 'data')
const dist = path.resolve(process.env.FORCE_DIST ?? '.')
const port = Number(process.env.PORT ?? 8780)
const host = process.env.HOST ?? '127.0.0.1'
const trustProxy = process.env.TRUST_PROXY === '1'
const trustedProxies = (process.env.TRUSTED_PROXIES ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'https://gravityforce.online,https://www.gravityforce.online')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const app = createApp({
  dataDir,
  nodeEnv: process.env.NODE_ENV ?? 'production',
  trustProxy,
  trustedProxies,
  trustedIpHeader: process.env.TRUSTED_IP_HEADER ?? 'cf-connecting-ip',
  allowedOrigins,
})

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/api/')) {
    void app.handle(req, res)
    return
  }
  serveStatic(req, res, dist)
})

server.on('error', () => {
  console.error('The Musk Gravity server could not listen. Choose another PORT if this one is already in use.')
  app.close()
  process.exit(1)
})

server.listen(port, host, () => {
  console.log(`Musk Gravity server listening on http://${host}:${port}/`)
  console.log(`Dashboard: http://${host}:${port}/dashboard`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    app.close()
  })
}
