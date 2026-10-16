import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Secrets = {
  pepper: Buffer
  ipKey: Buffer
}

export function ensureSecrets(dataDir: string): Secrets {
  mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'secrets.json')
  let parsed: { pepper?: string; ipKey?: string } | null = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { pepper?: string; ipKey?: string }
  } catch {
    parsed = null
  }
  if (!parsed?.pepper || !parsed.ipKey) {
    parsed = {
      pepper: randomBytes(32).toString('base64'),
      ipKey: randomBytes(32).toString('base64'),
    }
    writeFileSync(file, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 })
  }
  const pepperText = parsed.pepper
  const ipText = parsed.ipKey
  if (!pepperText || !ipText) throw new Error('Stored server secrets are unusable.')
  const pepper = Buffer.from(pepperText, 'base64')
  const ipKey = Buffer.from(ipText, 'base64')
  if (pepper.length < 32 || ipKey.length !== 32) throw new Error('Stored server secrets are unusable.')
  return { pepper, ipKey }
}
