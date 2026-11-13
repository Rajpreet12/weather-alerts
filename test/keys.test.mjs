import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCheckHour, locKey, groupSorted } from '../src/keys.mjs'

test('toCheckHour normalises to two digits and rejects bad hours', () => {
  assert.equal(toCheckHour(7), '07')
  assert.equal(toCheckHour('7'), '07')
  assert.equal(toCheckHour('07'), '07')
  assert.equal(toCheckHour(23), '23')
  assert.throws(() => toCheckHour(24))
  assert.throws(() => toCheckHour('seven'))
})

test('locKey rounds to ~1 km and appends the id', () => {
  assert.equal(locKey(51.05011, -114.08529, 'abc'), '51.05,-114.09#abc')
})

test('groupSorted groups adjacent items from a GSI-sorted Query', () => {
  const sub = (lat, lon, id) => ({ id, latitude: lat, longitude: lon, locKey: locKey(lat, lon, id) })
  // Same order DynamoDB returns: sorted by locKey.
  const subs = [sub(43.7, -79.42, 'a'), sub(43.7, -79.42, 'b'), sub(51.051, -114.086, 'c'), sub(51.05011, -114.08529, 'd')]
    .sort((x, y) => x.locKey.localeCompare(y.locKey))
  const groups = groupSorted(subs)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.subs.map((s) => s.id)), [['a', 'b'], ['c', 'd']])
})

test('groupSorted handles an empty result', () => {
  assert.deepEqual(groupSorted([]), [])
})

test('recipientIdFor is stable per email and case-insensitive', async () => {
  const { recipientIdFor } = await import('../src/keys.mjs')
  assert.equal(recipientIdFor('A@Example.com '), recipientIdFor('a@example.com'))
  assert.notEqual(recipientIdFor('a@example.com'), recipientIdFor('b@example.com'))
  assert.match(recipientIdFor('a@example.com'), /^[0-9a-f]{32}$/)
})

test('newUnsubscribeToken is 48 hex chars and unique', async () => {
  const { newUnsubscribeToken } = await import('../src/keys.mjs')
  const a = newUnsubscribeToken(), b = newUnsubscribeToken()
  assert.match(a, /^[0-9a-f]{48}$/)
  assert.notEqual(a, b)
})
