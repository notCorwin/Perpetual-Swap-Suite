import assert from 'node:assert/strict'
import { test } from 'node:test'
import { separateSourceMaintenance } from '../../scripts/chart-acceptance.mjs'

test('scroll validation distinguishes bounded latest maintenance from historical or ambiguous requests', () => {
  const fixture = { end: 3_600_000, series: { '5m': { intervalMS: 300_000 }, '1H': { intervalMS: 3_600_000 } } }
  const latest = { path: '/market/candles', parameters: { bar: '5m', limit: 2 } }
  const requests = [latest,
    { path: '/market/history-candles', parameters: { bar: '5m', limit: 2, after: fixture.end } },
    { path: '/market/candles', parameters: { bar: '5m', limit: 300 } },
    { path: '/market/candles', parameters: { bar: '5m', limit: 2, after: fixture.end } },
    { path: '/market/candles', parameters: { bar: 'unknown', limit: 2 } },
  ]
  const result = separateSourceMaintenance(requests, fixture)
  assert.deepEqual(result.currentMaintenance, [latest])
  assert.deepEqual(result.historical, requests.slice(1))
})

test('speculative history extensions cannot hide source downloads overlapping saved candles', () => {
  const first = 3_600_000
  const fixture = { end: first * 10, series: { '1H': { intervalMS: first, bars: [{ hour: first }] } } }
  const older = [
    { path: '/market/history-candles', parameters: { bar: '1H', limit: 100, after: first } },
    { path: '/rubik/stat/contracts/open-interest-history', parameters: { period: '1H', begin: 0, end: first } },
  ]
  const overlapping = [
    { path: '/market/history-candles', parameters: { bar: '1H', limit: 100, after: first + 1 } },
    { path: '/rubik/stat/contracts/open-interest-history', parameters: { period: '1H', begin: 0, end: first + 1 } },
    { path: '/market/history-candles', parameters: { bar: 'unknown', limit: 100, after: first } },
  ]
  const result = separateSourceMaintenance([...older, ...overlapping], fixture)
  assert.deepEqual(result.historicalExtensions, older)
  assert.deepEqual(result.historical, overlapping)
  assert.deepEqual(result.currentMaintenance, [])
})
