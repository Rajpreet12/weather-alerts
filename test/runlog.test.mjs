import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateInTz, lastNDates, emfLine } from '../src/runlog.mjs'
import { renderStatusPage } from '../src/statuspage.mjs'

test('dateInTz uses the schedule timezone, not UTC', () => {
  const instant = new Date('2026-11-15T05:30:00Z') // 22:30 on Nov 14 in Calgary
  assert.equal(dateInTz(instant, 'America/Edmonton'), '2026-11-14')
  assert.equal(dateInTz(instant, 'UTC'), '2026-11-15')
})

test('lastNDates walks back across a month boundary', () => {
  assert.deepEqual(lastNDates('2026-11-02', 3), ['2026-11-02', '2026-11-01', '2026-10-31'])
})

test('emfLine emits 5 count metrics with no dimensions', () => {
  const o = JSON.parse(emfLine({ subscriptions: 4, sent: 1, not_triggered: 2, already_sent: 1, failed: 0 }, 123))
  const cw = o._aws.CloudWatchMetrics[0]
  assert.equal(cw.Namespace, 'WeatherAlerts')
  assert.deepEqual(cw.Dimensions, [[]])
  assert.equal(cw.Metrics.length, 5)
  assert.equal(o.Sent, 1)
  assert.equal(o.NotTriggered, 2)
})

test('status page shows counts and escapes the timezone', () => {
  const html = renderStatusPage({
    alerts: 3, cities: 2, timezone: '<script>', checkHour: '07',
    days: [{ date: '2026-11-15', run: { subscriptions: 3, sent: 1, not_triggered: 2, already_sent: 0, failed: 0, durationMs: 840 } }, { date: '2026-11-14' }],
  })
  assert.match(html, /<div class="n">3<\/div><div class="l">active alerts/)
  assert.match(html, /🔔 1 sent/)
  assert.match(html, /no run/)
  assert.doesNotMatch(html, /<script>/)
})

test('status page marks days rebuilt from logs', () => {
  const html = renderStatusPage({ alerts: 1, cities: 1, timezone: 'UTC', checkHour: '07',
    days: [{ date: '2026-11-14', run: { subscriptions: 1, sent: 1, not_triggered: 0, already_sent: 0, failed: 0, source: 'cloudwatch-logs-backfill' } }] })
  assert.match(html, /Nov 14 ↺/)
  assert.match(html, /rebuilt from the job's CloudWatch Logs/)
})
