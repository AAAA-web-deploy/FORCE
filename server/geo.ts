export type Place = {
  country: string
  region: string
  city: string
}

const PLACE = /^[\p{L}\p{N} .,'’()-]{1,80}$/u

function clean(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return PLACE.test(text) ? text : ''
}

/** Coarse place from a public IP. Coordinates and the address itself are discarded. */
export async function lookupPlace(ip: string, fetchImpl: typeof fetch = fetch): Promise<Place | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1800)
  try {
    const response = await fetchImpl(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const data = (await response.json()) as { success?: boolean; country?: unknown; region?: unknown; city?: unknown }
    if (!data || data.success === false) return null
    const country = clean(data.country)
    const region = clean(data.region)
    const city = clean(data.city)
    if (!country && !region && !city) return null
    return { country, region, city }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function formatPlace(place: Place | null | undefined): string {
  if (!place) return 'Unavailable'
  const parts = [place.city, place.region, place.country].filter(Boolean)
  const unique = parts.filter((part, index) => parts.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index)
  return unique.join(', ') || 'Unavailable'
}
