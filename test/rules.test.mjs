import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, validateRule, formatAlert } from '../src/rules.mjs'

const daily = {
  time: ['2026-11-10'],
  temperature_2m_max: [4.1],
  temperature_2m_min: [-6.3],
  precipitation_probability_max: [72],
  snowfall_sum: [3.5],
  wind_speed_10m_max: [41.2],
}

test('rain triggers at or above threshold', () => {
  assert.deepEqual(evaluate({ type: 'rain', threshold: 70 }, daily), { triggered: true, value: 72 })
  assert.equal(evaluate({ type: 'rain', threshold: 80 }, daily).triggered, false)
})

test('below compares the daily low, inclusive', () => {
  assert.equal(evaluate({ type: 'below', threshold: -5 }, daily).triggered, true)
  assert.equal(evaluate({ type: 'below', threshold: -6.3 }, daily).triggered, true)
  assert.equal(evaluate({ type: 'below', threshold: -10 }, daily).triggered, false)
})

test('above, snow and wind', () => {
  assert.equal(evaluate({ type: 'above', threshold: 30 }, daily).triggered, false)
  assert.equal(evaluate({ type: 'snow', threshold: 2 }, daily).triggered, true)
  assert.equal(evaluate({ type: 'wind', threshold: 50 }, daily).triggered, false)
})

test('missing forecast data never alerts', () => {
  assert.deepEqual(evaluate({ type: 'rain', threshold: 1 }, { time: ['x'] }), { triggered: false, value: null })
  assert.deepEqual(evaluate({ type: 'rain', threshold: 1 }, { precipitation_probability_max: [null] }), { triggered: false, value: null })
})

test('validateRule rejects bad input', () => {
  assert.equal(validateRule({ type: 'rain', threshold: 60 }), null)
  assert.match(validateRule({ type: 'hail', threshold: 1 }), /must be one of/)
  assert.match(validateRule({ type: 'rain', threshold: '60' }), /must be a number/)
  assert.match(validateRule({ type: 'rain', threshold: 150 }), /between/)
  assert.match(validateRule(undefined), /must be one of/)
})

test('formatAlert subject stays under the SNS 100-char limit', () => {
  const sub = { placeName: 'A'.repeat(200), rule: { type: 'rain', threshold: 60 } }
  const { subject, message } = formatAlert(sub, daily, 72)
  assert.ok(subject.length < 100)
  assert.match(message, /rain chance ≥ 60%/)
})
