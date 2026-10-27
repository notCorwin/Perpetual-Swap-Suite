import assert from 'node:assert/strict'
import test from 'node:test'
import { PreparedChartPipeline } from '../../electron/services/prepared-chart-service.js'
import { ChartNotificationEncoder } from '../../electron/services/chart-notifications.js'

const step = 900_000, instId = 'BTC-USDT-SWAP', timeframe = '15m'
const makeRow = (timestamp, index = 0) => ({ instrument: instId, timeframe, timestamp,
  open: 100 + index / 10, high: 102 + index / 10, low: 98 + index / 10, close: 101 + index / 10,
  volume: 100, baseVolume: 100, quoteVolume: 10_000, oi: 150, buy: 70, sell: 30, statisticsVersion: 11, confirmed: true })

async function fixture() {
  const end = Math.floor(Date.now() / step) * step - step
  const rows = Array.from({ length: 310 }, (_, index) => makeRow(end - (309 - index) * step, index))
  const store = {
    async candles(query) {
      let result = rows.filter(row => row.timestamp >= (query.from ?? 0) && row.timestamp <= (query.through ?? Infinity))
      if (query.order === 'desc') result = result.toReversed()
      return result.slice(0, query.limit).map(row => ({ ...row }))
    },
    async coverage() { return { first: rows[0].timestamp, last: end, count: rows.length } },
    async priceWatermark() { return '0' },
    async readIndicatorCheckpoint() { return null },
    async writeIndicatorCheckpoint() { return true },
  }
  const pipeline = new PreparedChartPipeline({ store, history: { ensureStatistics() {} }, normalize: value => value,
    revision: () => 0, instrument: () => ({ listTime: rows[0].timestamp }), streaming: () => true })
  const state = pipeline.state(instId, timeframe)
  await pipeline.read(state)
  await pipeline.seed(state)
  return { pipeline, state, rows, end }
}

// Count scans of the actual retained array, without replacing its frozen items.
function countScans(bars, operation) {
  const every = Array.prototype.every
  let scans = 0
  Array.prototype.every = function (...args) {
    if (this === bars) scans += 1
    return every.apply(this, args)
  }
  try { return { value: operation(), scans } }
  finally { Array.prototype.every = every }
}

test('resolved indicators reuse immutable projections across live ticks and invalidate for range and input basis', async () => {
  const { pipeline, state, end } = await fixture()
  try {
    state.chartRequested = true
    const quote = { ...makeRow(end + step, 310), confirmed: false }
    const first = await pipeline.setLive(instId, timeframe, quote)
    const encoder = new ChartNotificationEncoder()
    assert.equal(first.indicatorState, 'ready')
    assert.equal(encoder.encode(first).bars, first.bars)
    assert.ok(Object.isFrozen(first.bars))
    assert.ok(first.bars.every(Object.isFrozen))
    assert.ok(Object.isFrozen(first.indicatorStatus))
    assert.throws(() => { first.bars[0].ema = null }, TypeError)
    assert.throws(() => first.bars.pop(), TypeError)
    assert.throws(() => { first.indicatorStatus.state = 'error' }, TypeError)
    const again = countScans(first.bars, () => pipeline.frame(state))
    assert.equal(again.scans, 0)
    assert.equal(again.value.bars, first.bars)
    assert.equal(again.value.indicatorStatus, first.indicatorStatus)
    const tick = await pipeline.setLive(instId, timeframe, { ...quote, close: quote.close + 0.1, volume: quote.volume + 1 })
    assert.equal(tick.bars, first.bars)
    assert.equal(tick.indicatorStatus, first.indicatorStatus)
    assert.equal(tick.liveBar.close, quote.close + 0.1)
    assert.equal(encoder.encode(tick).type, 'live')

    const from = first.indicatorStatus.from, through = first.indicatorStatus.through
    for (const [nextFrom, nextThrough] of [[from + step, through], [from + step, through - step], [from, through]]) {
      const changed = countScans(first.bars, () => pipeline.indicatorStatus(state, first.bars, nextFrom, nextThrough))
      assert.ok(changed.scans > 0)
      assert.equal(changed.value.from, nextFrom)
      assert.equal(changed.value.through, nextThrough)
      assert.equal(countScans(first.bars, () => pipeline.indicatorStatus(state, first.bars, nextFrom, nextThrough)).scans, 0)
    }
    for (const change of [
      () => { state.generation += 1 },
      () => { state.priceVersion += 1 },
      () => { pipeline.priceJournal.set(state.key, [{ revision: 17, from }]) },
    ]) {
      const previous = pipeline.indicatorInputVersion(state)
      change()
      const changed = countScans(first.bars, () => pipeline.indicatorStatus(state, first.bars, from, through))
      assert.ok(changed.scans > 0)
      assert.notEqual(changed.value.inputVersion, previous)
      assert.equal(changed.value.inputVersion, pipeline.indicatorInputVersion(state))
      assert.equal(countScans(first.bars, () => pipeline.indicatorStatus(state, first.bars, from, through)).scans, 0)
    }
  } finally { await pipeline.dispose() }
})

test('indicator changes and observed nulls replace only changed projections and preserve retained frames', async () => {
  const { pipeline, state, end } = await fixture()
  try {
    const ready = pipeline.frame(state), hour = end - 10 * step, index = ready.bars.findIndex(value => value.hour === hour)
    const original = state.indicators.get(hour)
    state.indicators.set(hour, Object.freeze({ ...original, vwap: null }))
    const undefinedValue = pipeline.frame(state)
    assert.notEqual(undefinedValue.bars, ready.bars)
    assert.notEqual(undefinedValue.bars[index], ready.bars[index])
    assert.equal(undefinedValue.bars[index - 1], ready.bars[index - 1])
    assert.equal(undefinedValue.indicatorStatus.state, 'unavailable')
    assert.equal(undefinedValue.indicatorStatus.reason, 'undefined-value')
    assert.equal(countScans(undefinedValue.bars, () => pipeline.frame(state)).scans, 0)

    state.indicators.set(hour, Object.freeze({ ...original, ema: null }))
    const warmup = pipeline.frame(state)
    assert.equal(warmup.indicatorStatus.reason, 'insufficient-history')
    assert.equal(countScans(warmup.bars, () => pipeline.frame(state)).scans, 0)
    state.indicators.set(hour, Object.freeze({ ...original, ema: original.ema + 1 }))
    const corrected = pipeline.frame(state)
    assert.equal(corrected.indicatorState, 'ready')
    assert.equal(corrected.bars[index].ema, original.ema + 1)
    assert.equal(ready.bars[index].ema, original.ema)
    assert.equal(undefinedValue.bars[index].vwap, null)
    assert.ok(Object.isFrozen(corrected.bars[index]))

    const history = pipeline.historyFrame(state, end)
    assert.ok(Object.isFrozen(history.bars))
    assert.ok(history.bars.every(Object.isFrozen))
  } finally { await pipeline.dispose() }
})

test('unobserved indicators always reflect failures, retry changes and recovery with the same bars', async () => {
  const { pipeline, state, end } = await fixture()
  try {
    const original = state.indicators.get(end)
    state.indicators.delete(end)
    const loading = pipeline.frame(state)
    assert.equal(loading.indicatorState, 'loading')
    const failure = { inputVersion: pipeline.indicatorInputVersion(state), error: 'Worker interrupted', retryOn: 'worker-recovery' }
    state.indicatorFailures.set(end, failure)
    const failed = pipeline.frame(state)
    assert.equal(failed.bars, loading.bars)
    assert.equal(failed.indicatorStatus.error, 'Worker interrupted')
    assert.equal(failed.indicatorStatus.retryOn, 'worker-recovery')
    state.generation += 1
    const staleFailure = pipeline.frame(state)
    assert.equal(staleFailure.bars, loading.bars)
    assert.equal(staleFailure.indicatorState, 'loading')
    failure.inputVersion = pipeline.indicatorInputVersion(state)
    assert.equal(pipeline.frame(state).indicatorState, 'error')
    failure.error = 'Input rejected'; failure.retryOn = 'input-change'
    const rejected = pipeline.frame(state)
    assert.equal(rejected.bars, loading.bars)
    assert.equal(rejected.indicatorStatus.error, 'Input rejected')
    assert.equal(rejected.indicatorStatus.retryOn, 'input-change')
    state.indicatorFailures.delete(end)
    assert.equal(pipeline.frame(state).indicatorState, 'loading')
    state.indicators.set(end, original)
    const recovered = pipeline.frame(state)
    assert.equal(recovered.indicatorState, 'ready')
    assert.notEqual(recovered.bars, loading.bars)
    assert.equal(countScans(recovered.bars, () => pipeline.frame(state)).scans, 0)
  } finally { await pipeline.dispose() }
})

test('source cancellation, errors and retry deadlines remain fresh even while resolved indicators are reused', async () => {
  const { pipeline, state, end } = await fixture()
  try {
    const ready = pipeline.frame(state), floor = state.floor
    state.floor = end - 40 * step
    const partial = pipeline.frame(state)
    assert.equal(partial.bars, ready.bars)
    assert.equal(partial.priceState, 'partial')
    state.floor = floor
    assert.equal(pipeline.frame(state).priceState, 'ready')
    const old = state.rows.get(end)
    state.rows.set(end, Object.freeze({ ...old, baseVolume: null, oi: null, statisticsVersion: 10 }))
    const initial = pipeline.frame(state), failures = [
      ['candles', 'Prices offline'], ['oi', 'OI offline'],
    ]
    for (const [source, error] of failures) {
      const key = `${source}-test`, failure = { seriesKey: state.key, source, from: end, through: end,
        failedAt: Date.now(), error, retryAt: Date.now() + 5000 }
      pipeline.sourceAttempts.set(key, failure)
      pipeline.sourceTasks.set(key, { seriesKey: state.key, source, from: end, through: end, controller: new AbortController() })
      const statusField = source === 'candles' ? 'priceStatus' : 'oiStatus'
      assert.notEqual(pipeline.frame(state)[statusField].state, 'error')
      pipeline.sourceTasks.delete(key)
      const failed = pipeline.frame(state)
      assert.equal(failed.bars, initial.bars)
      assert.equal(failed.indicatorStatus, initial.indicatorStatus)
      assert.equal(failed[statusField].state, 'error')
      assert.equal(failed[statusField].error, error)
      assert.equal(failed[statusField].retryAt, failure.retryAt)
      failure.retryAt += 1000
      assert.equal(pipeline.frame(state)[statusField].retryAt, failure.retryAt)
      pipeline.sourceAttempts.delete(key)
      assert.notEqual(pipeline.frame(state)[statusField].state, 'error')
    }
    assert.equal(countScans(initial.bars, () => pipeline.frame(state)).scans, 0)
  } finally { await pipeline.dispose() }
})

test('absence and quote leases expire, and a statistic correction is visible even without version changes', async context => {
  const now = Math.floor(Date.now() / step) * step + 1000
  context.mock.timers.enable({ apis: ['Date'], now })
  const { pipeline, state, end } = await fixture()
  try {
    const old = state.rows.get(end)
    state.rows.set(end, Object.freeze({ ...old, oi: null, statisticsOIExpiresAt: now + 5000 }))
    state.live = { ...makeRow(end + step, 310), confirmed: false }
    state.observedAt = now
    const before = pipeline.frame(state)
    assert.equal(before.oiState, 'unavailable')
    assert.equal(before.bars.at(-1).oiObserved, true)
    assert.equal(before.realtimeState, 'live')
    context.mock.timers.tick(5001)
    const expired = pipeline.frame(state)
    assert.equal(expired.oiState, 'loading')
    assert.equal(expired.bars.at(-1).oiObserved, false)
    assert.notEqual(expired.bars, before.bars)
    assert.equal(expired.indicatorState, 'ready')
    context.mock.timers.tick(25_000)
    assert.equal(pipeline.frame(state).realtimeState, 'stale')

    // syncLive can transfer a newer statistic while both residents retain the
    // same counters. Array identity, not versions, fences that correction.
    const live = pipeline.liveStates.get(state.key)
    state.rows.set(end, Object.freeze({ ...old, oi: 200 }))
    const versions = [live.sourceVersion, live.oiVersion, live.priceVersion]
    const priorLive = pipeline.frame(live)
    pipeline.syncLive(state)
    const corrected = pipeline.frame(live)
    assert.deepEqual([live.sourceVersion, live.oiVersion, live.priceVersion], versions)
    assert.equal(priorLive.bars.at(-1).oi, 150)
    assert.equal(corrected.bars.at(-1).oi, 200)
    assert.notEqual(corrected.bars, priorLive.bars)
    assert.equal(corrected.oiState, 'ready')
  } finally { await pipeline.dispose() }
})

test('only owned projections are frozen or eligible for status reuse', async () => {
  const { pipeline, state } = await fixture()
  try {
    const row = { ...state.rows.get(state.latestHour) }
    const indicator = { ...state.indicators.get(state.latestHour) }
    state.rows.set(row.timestamp, row); state.indicators.set(row.timestamp, indicator)
    const frame = pipeline.frame(state)
    assert.equal(Object.isFrozen(row), false)
    assert.equal(Object.isFrozen(indicator), false)
    assert.equal(Object.isFrozen(state.indicatorState), false)
    assert.ok(Object.isFrozen(frame.bars.at(-1)))
    const foreignBar = { ...frame.bars.at(-1) }, foreign = Object.freeze([foreignBar])
    const { from, through } = frame.indicatorStatus
    assert.equal(pipeline.indicatorStatus(state, foreign, from, through).state, 'ready')
    foreignBar.ema = null
    const changed = pipeline.indicatorStatus(state, foreign, from, through)
    assert.equal(changed.state, 'unavailable')
    assert.equal(changed.reason, 'insufficient-history')
  } finally { await pipeline.dispose() }
})
