// Pure alert logic: no AWS, no network. Easy to unit test.

export const RULES = {
  rain: { label: 'Rain', unit: '%', min: 1, max: 100, field: 'precipitation_probability_max', describe: (t) => `rain chance ≥ ${t}%` },
  snow: { label: 'Snow', unit: 'cm', min: 0.1, max: 200, field: 'snowfall_sum', describe: (t) => `snowfall ≥ ${t} cm` },
  below: { label: 'Cold', unit: '°C', min: -60, max: 50, field: 'temperature_2m_min', describe: (t) => `low ≤ ${t}°C` },
  above: { label: 'Heat', unit: '°C', min: -30, max: 60, field: 'temperature_2m_max', describe: (t) => `high ≥ ${t}°C` },
  wind: { label: 'Wind', unit: 'km/h', min: 1, max: 300, field: 'wind_speed_10m_max', describe: (t) => `wind ≥ ${t} km/h` },
}

export const DAILY_FIELDS = [...new Set(Object.values(RULES).map((r) => r.field))]

/** Returns an error string, or null if the rule is valid. */
export function validateRule(rule) {
  const def = RULES[rule?.type]
  if (!def) return `rule.type must be one of: ${Object.keys(RULES).join(', ')}`
  if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold)) return 'rule.threshold must be a number'
  if (rule.threshold < def.min || rule.threshold > def.max) return `rule.threshold for ${rule.type} must be between ${def.min} and ${def.max}`
  return null
}

/**
 * Checks one rule against one day of an Open-Meteo `daily` block.
 * Returns { triggered, value } — value is the forecast number we compared.
 */
export function evaluate(rule, daily, dayIndex = 0) {
  const def = RULES[rule.type]
  const value = daily?.[def.field]?.[dayIndex]
  if (typeof value !== 'number') return { triggered: false, value: null } // missing data never alerts
  const triggered = rule.type === 'below' ? value <= rule.threshold : value >= rule.threshold
  return { triggered, value }
}

export function formatAlert(sub, daily, value, dayIndex = 0) {
  const def = RULES[sub.rule.type]
  const d = daily
  const date = d.time?.[dayIndex] ?? 'today'
  return {
    subject: `${def.label} alert for ${sub.placeName}: ${value}${def.unit}`.slice(0, 99),
    message: [
      `Your alert (${def.describe(sub.rule.threshold)}) was triggered for ${sub.placeName} on ${date}.`,
      '',
      `Forecast for ${date}:`,
      `  High / low: ${d.temperature_2m_max?.[dayIndex]}°C / ${d.temperature_2m_min?.[dayIndex]}°C`,
      `  Rain chance: ${d.precipitation_probability_max?.[dayIndex]}%`,
      `  Snowfall: ${d.snowfall_sum?.[dayIndex]} cm`,
      `  Max wind: ${d.wind_speed_10m_max?.[dayIndex]} km/h`,
      '',
      'Weather data by Open-Meteo.com (CC BY 4.0).',
    ].join('\n'),
  }
}
