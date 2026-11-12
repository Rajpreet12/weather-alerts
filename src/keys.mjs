// Pure helpers for the ByCheckHour GSI. No AWS, easy to unit test.
//
// GSI partition key: checkHour  e.g. "07"   → "which subscriptions are due now?"
// GSI sort key:      locKey     e.g. "51.05,-114.09#<id>"
//
// Sorting by locKey means a Query returns subscriptions already grouped by
// location (rounded to ~1 km), so one forecast call serves the whole group.

export const DEFAULT_CHECK_HOUR = '07'

/** Normalises an hour (7, "7", "07") to the two-digit string stored in the GSI. */
export function toCheckHour(hour) {
  const h = Number(hour)
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`Invalid check hour: ${hour}`)
  return String(h).padStart(2, '0')
}

export function locationCell(latitude, longitude) {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`
}

export function locKey(latitude, longitude, id) {
  return `${locationCell(latitude, longitude)}#${id}`
}

/**
 * Groups subscriptions that arrive sorted by locKey. Because the GSI already
 * sorted them, adjacent items with the same cell belong together: one pass, no map.
 */
export function groupSorted(subs) {
  const groups = []
  for (const s of subs) {
    const cell = s.locKey.slice(0, s.locKey.indexOf('#'))
    const last = groups[groups.length - 1]
    if (last && last.cell === cell) last.subs.push(s)
    else groups.push({ cell, latitude: s.latitude, longitude: s.longitude, subs: [s] })
  }
  return groups
}
