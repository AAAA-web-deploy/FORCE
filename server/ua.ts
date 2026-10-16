export type ClientDevice = {
  browser: string
  os: string
  device: string
}

export function parseUserAgent(ua: string | undefined): ClientDevice {
  const raw = ua ?? ''
  const browser = /edg\//i.test(raw)
    ? 'Edge'
    : /chrome|crios/i.test(raw)
      ? 'Chrome'
      : /firefox|fxios/i.test(raw)
        ? 'Firefox'
        : /safari/i.test(raw)
          ? 'Safari'
          : 'Other'
  const os = /windows/i.test(raw)
    ? 'Windows'
    : /android/i.test(raw)
      ? 'Android'
      : /iphone|ipad|ios/i.test(raw)
        ? 'iOS'
        : /mac os/i.test(raw)
          ? 'macOS'
          : /linux/i.test(raw)
            ? 'Linux'
            : 'Other'
  const device = /ipad|tablet/i.test(raw) ? 'tablet' : /mobile|iphone|android/i.test(raw) ? 'mobile' : 'desktop'
  return { browser, os, device }
}

export function isLikelyBot(ua: string | undefined): boolean {
  if (!ua || ua.trim().length < 12) return true
  return /bot|crawl|spider|slurp|mediapartners|headless|wget|curl|python-requests|go-http-client|preview|facebookexternalhit/i.test(
    ua,
  )
}
