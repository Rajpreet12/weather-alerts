import { DAILY_FIELDS } from './rules.mjs'

// Open-Meteo is free for non-commercial use and needs no API key.
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.json()
}

/** City name → { placeName, latitude, longitude, timezone } or null if not found. */
export async function geocode(city) {
  const data = await getJson(`${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en`)
  const r = data.results?.[0]
  if (!r) return null
  return {
    placeName: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? 'auto',
  }
}

/** Today's daily forecast for a point, in that point's local timezone. */
export async function getDailyForecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: DAILY_FIELDS.join(','),
    timezone: 'auto',
    forecast_days: '1',
  })
  const data = await getJson(`${FORECAST_URL}?${params}`)
  if (!data.daily) throw new Error('Forecast response had no daily block')
  return data.daily
}
