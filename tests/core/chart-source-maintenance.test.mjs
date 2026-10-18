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
