import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1

export function hashPassword(password: string): string {
  if (password.length < 1 || password.length > 200) throw new Error('Password length is not allowed.')
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 32, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (password.length < 1 || password.length > 200) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const cost = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(cost) || cost < 16384 || cost > 262144) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (salt.length < 16 || expected.length < 16) return false
  const key = scryptSync(password, salt, expected.length, { N: cost, r, p })
  if (key.length !== expected.length) return false
  return timingSafeEqual(key, expected)
}

export function hashToken(pepper: Buffer, token: string): string {
  return createHash('sha256').update(pepper).update(token).digest('base64url')
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}
