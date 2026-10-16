import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type IpRequest = {
  remoteAddress?: string | null
  headers: Record<string, string | string[] | undefined>
  trustProxy: boolean
  trustedProxies: string[]
  trustedIpHeader: string
}

export function normalizeIp(value: string | undefined | null): string | null {
  if (!value) return null
  let ip = value.trim()
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length)
  if (!isIpLiteral(ip)) return null
  return ip
}

function isIpLiteral(ip: string): boolean {
  if (ip.includes(':')) return /^[0-9a-f:]+$/i.test(ip)
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function isPublicIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return false
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return false
  const parts = ip.split('.').map(Number)
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('::')) return false
  return true
}

/**
 * The visitor address is taken from the socket, or from one configured header
 * when the immediate peer is an explicitly trusted proxy. Forwarded headers
 * are ignored otherwise so a proxy address is not stored as the visitor.
 */
export function resolveVisitorIp(input: IpRequest): string | null {
  const remote = normalizeIp(input.remoteAddress)
  const peerTrusted = Boolean(remote && input.trustProxy && input.trustedProxies.includes(remote))
  if (peerTrusted) {
    const raw = input.headers[input.trustedIpHeader.toLowerCase()]
    if (typeof raw !== 'string' || raw.includes(',')) return null
    const forwarded = normalizeIp(raw)
    if (!forwarded || !isPublicIp(forwarded)) return null
    return forwarded
  }
  if (remote && isPublicIp(remote)) return remote
  return null
}

export function encryptIp(key: Buffer, ip: string): { cipher: string; iv: string; tag: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(ip, 'utf8'), cipher.final()])
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptIp(key: Buffer, cipher: string, iv: string, tag: string): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()])
    return plain.toString('utf8')
  } catch {
    return null
  }
}

export function maskIp(ip: string | null): string {
  if (!ip) return 'Unavailable'
  if (ip.includes(':')) {
    const head = ip.split(':').find((part) => part.length > 0) ?? '****'
    return `${head}:****:****`
  }
  const parts = ip.split('.')
  if (parts.length !== 4) return 'Unavailable'
  return `${parts[0]}.${parts[1]}.***.***`
}
