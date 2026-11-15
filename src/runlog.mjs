// Pure helpers for run history + metrics. No AWS calls, unit tested.

export const RUN_PREFIX = 'run#'
export const METRIC_NAMESPACE = 'WeatherAlerts'
const METRIC_FIELDS = { subscriptions: 'Subscriptions', sent: 'Sent', not_triggered: 'NotTriggered', already_sent: 'AlreadySent', failed: 'Failed' }

/** "2026-11-15" for the given instant, in the given IANA timezone. */
export function dateInTz(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** ["2026-11-15", "2026-11-14", ...] — n calendar days ending at `today` (a yyyy-mm-dd string). */
export function lastNDates(today, n) {
  const [y, m, d] = today.split('-').map(Number)
  const base = Date.UTC(y, m - 1, d)
  return Array.from({ length: n }, (_, i) => new Date(base - i * 86400000).toISOString().slice(0, 10))
}

/**
 * CloudWatch Embedded Metric Format: printing this JSON line from Lambda creates
 * custom metrics with no API call (and no extra IAM permission).
 * No dimensions, so it stays at 5 metrics — inside the 10 free custom metrics.
 */
export function emfLine(stats, timestampMs) {
  const metrics = Object.entries(METRIC_FIELDS).map(([, Name]) => ({ Name, Unit: 'Count' }))
  const values = Object.fromEntries(Object.entries(METRIC_FIELDS).map(([k, Name]) => [Name, Number(stats[k] ?? 0)]))
  return JSON.stringify({
    _aws: { Timestamp: timestampMs, CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [[]], Metrics: metrics }] },
    ...values,
  })
}
