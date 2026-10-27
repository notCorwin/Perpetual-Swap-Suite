import assert from 'node:assert/strict'
import test from 'node:test'
import { createChartColdBoundaryFixture } from '../../electron/e2e-fixtures.js'

for (const failNearestCandles of [false, true]) test(`cold source ${failNearestCandles ? 'failure' : 'success'} waits through an early timer and wall-clock adjustment`, async context => {
  const service = { get: async () => [], persistCandles: async () => {},
    preparedCharts: { observeStatistics: async () => {} }, subscribePreparedCharts: () => () => {}, instruments: new Map(), replaceCatalog() {} }
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

test('the passive prepared witness requires the exact completed source and a complete target in a history publication', async () => {
  const listeners = new Set()
  const service = { get: async () => [], persistCandles: async () => {}, preparedCharts: { observeStatistics: async () => {} },
    subscribePreparedCharts(listener) { listeners.add(listener); return () => listeners.delete(listener) }, instruments: new Map(), replaceCatalog() {} }
  const control = await createChartColdBoundaryFixture({ appendStatistics: async () => {} }, service, { sourceDelayMS: 0 })
  const { fixture } = control, allBars = fixture.series[fixture.timeframe].bars
  const first = allBars.findIndex(bar => bar.hour === fixture.targetWindowStart)
  const bars = allBars.slice(first, first + 97).map(bar => ({ ...bar, indicatorsObserved: true }))
  const publish = frame => { for (const listener of listeners) listener(frame) }
  const frame = { instId: fixture.instId, timeframe: fixture.timeframe, endHour: fixture.end, generation: 4, revision: 7, bars }
  const source = through => service.get('/market/history-candles', { instId: fixture.instId, bar: fixture.timeframe,
    after: String(through + fixture.intervalMS), limit: 248 }, new AbortController().signal, 'foreground')
  try {
    publish(frame)
    await source(fixture.firstMissingEnd + fixture.intervalMS)
    publish(frame)
    assert.equal(control.read().preparedTarget, null, 'An unrelated completed page must not start the witness.')
    await source(fixture.firstMissingEnd)
    publish({ ...frame, instId: 'OTHER' })
    publish({ ...frame, bars: bars.slice(0, 96) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, indicatorsObserved: false }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, ema: null }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, close: null }) })
    publish({ ...frame, bars: bars.map((bar, index) => index ? bar : { ...bar, priceComplete: false }) })
    assert.equal(control.read().preparedTarget, null, 'Other instruments, viewport-only frames, and incomplete target values are not witnesses.')
    publish(frame)
    const witness = control.read().preparedTarget
    const nearest = control.read().requests.find(request => request.through === fixture.firstMissingEnd)
    assert.equal(witness.sourceCompletedAt, nearest.completedAt)
    assert.ok(witness.at >= nearest.completedAt)
    assert.equal(witness.targetStart, fixture.targetWindowStart)
    assert.equal(witness.targetEnd, fixture.targetEnd)
    assert.equal(witness.historyBars, 97)
    publish({ ...frame, revision: 8 })
    assert.deepEqual(control.read().preparedTarget, witness, 'Later publications must not replace the first witness.')
  } finally { control.remove() }
  assert.equal(listeners.size, 0)
})
