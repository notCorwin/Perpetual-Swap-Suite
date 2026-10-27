import assert from 'node:assert/strict'
import test from 'node:test'
import { createChartColdBoundaryFixture } from '../../electron/e2e-fixtures.js'

for (const failNearestCandles of [false, true]) test(`cold source ${failNearestCandles ? 'failure' : 'success'} waits through an early timer and wall-clock adjustment`, async context => {
  const service = { get: async () => [], persistCandles: async () => {},
    preparedCharts: { observeStatistics: async () => {} }, instruments: new Map(), replaceCatalog() {} }
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service,
    { scenario: 'full-missing-window', sourceDelayMS: 1800, failNearestCandles })
  const timers = []
  let now = 1000, settled = false
  const wall = Date.now()
  context.mock.method(performance, 'now', () => now)
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return timers.length })
  const { fixture } = control
  const result = service.get('/market/history-candles', { instId: fixture.instId, bar: fixture.timeframe,
    after: String(fixture.targetEnd + fixture.intervalMS), limit: 96 }, new AbortController().signal, 'foreground')
    .then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  try {
    assert.equal(timers.length, 1)
    context.mock.method(Date, 'now', () => wall - 30_000)
    now = 2799.5
    timers.shift().callback()
    for (let index = 0; index < 4; index++) await Promise.resolve()
    assert.equal(settled, false, 'An early timer must not resolve or fail the source before the complete delay.')
    assert.equal(control.read().requests[0].completedAt, null)
    assert.equal(control.read().requests[0].failedAt, null)
    assert.equal(timers[0].delay, 1)
    now = 2800
    timers.shift().callback()
    const outcome = await result, request = control.read().requests[0]
    assert.equal((request.failedAt ?? request.completedAt) - request.startedAt, 1800,
      'Elapsed source time follows the monotonic clock independently of wall time.')
    if (failNearestCandles) assert.match(outcome.error.message, /Configured cold-window source failure/)
    else assert.equal(outcome.value.length, 96)
  } finally { control.remove() }
})
