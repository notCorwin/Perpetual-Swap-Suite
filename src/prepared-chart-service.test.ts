import assert from 'node:assert/strict'
import test from 'node:test'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { buildIndicatorSeries } from '../electron/services/indicators.js'

const interval = 900_000, instId = 'BTC-USDT-SWAP'
const end = () => Math.floor(Date.now() / interval) * interval - interval
const candle = (timestamp: number, index = 0) => ({ instrument: instId, timeframe: '15m', timestamp,
  open: 100 + index / 10, high: 102 + index / 10, low: 98 + index / 10, close: 101 + index / 10,
  volume: 100, baseVolume: 100, quoteVolume: 10_000, oi: 5_000, buy: 70, sell: 30, statisticsVersion: 1, confirmed: true })
const deferred = () => { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const source = (count: number) => Array.from({ length: count }, (_, i) => candle(end() - (count - 1 - i) * interval, i))
class MemoryStore {
  rows: any[]
  queries: any[] = []
  checkpoints: any[] = []
  priceRevision = 0
  constructor(rows: any[]) { this.rows = rows }
  async candles(query: any) {
    this.queries.push(query)
    let rows = this.rows.filter(row => row.instrument === query.instrument && row.timeframe === query.timeframe && row.timestamp >= (query.from ?? 0) && row.timestamp <= (query.through ?? Infinity)).sort((a, b) => a.timestamp - b.timestamp)
    if (query.order === 'desc') rows.reverse()
    if (query.limit) rows = rows.slice(0, query.limit)
    return rows.map(row => ({ ...row }))
  }
  async coverage() { return { first: this.rows[0]?.timestamp ?? null, last: this.rows.at(-1)?.timestamp ?? null, count: this.rows.length } }
  async candleWatermark() { return String(this.priceRevision) }
  async priceWatermark() { return String(this.priceRevision) }
  async readIndicatorCheckpoint(query: any) { return this.checkpoints.filter(value => value.timestamp <= query.before && value.formulaVersion === query.formulaVersion).at(-1) ?? null }
  async writeIndicatorCheckpoint(value: any) {
    if (String(value.sourceRevision) !== String(this.priceRevision)) return false
    this.checkpoints = [...this.checkpoints.filter(checkpoint => checkpoint.timestamp !== value.timestamp), structuredClone(value)].sort((a, b) => a.timestamp - b.timestamp)
    return true
  }
  change(row: any) {
    const old = this.rows.find(value => value.timestamp === row.timestamp)
    this.rows = [...this.rows.filter(value => value.timestamp !== row.timestamp), row].sort((a, b) => a.timestamp - b.timestamp)
    this.priceRevision += 1
    this.checkpoints = this.checkpoints.filter(value => value.timestamp < row.timestamp)
    return new Map(old ? [[row.timestamp, old]] : [])
  }
}
const fixture = (rows = source(400), history: any = {}) => {
  const store = new MemoryStore(rows)
  const pipeline: any = new PreparedChartPipeline({ store: store as any, history, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined, streaming: () => true })
  pipeline.workerLimit = 2
  return { store, pipeline }
}
const finishSeed = async (pipeline: any) => { while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()]) }
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']

test('fresh OHLC and forming price publish while both statistic requests are held', async () => {
  const hold = deferred(), rows = source(400).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  let statistics = 0
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { statistics += 1; await hold.promise } })
  try {
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval, 400), confirmed: false, close: 142, high: 143 }, { receivedAt: Date.now() })
    const frame = await pipeline.prepare(instId, '15m')
    assert.equal(frame.endHour, end()); assert.equal(frame.liveBar.close, 142)
    assert.equal(frame.realtimeState, 'live'); assert.equal(frame.oiState, 'loading'); assert.equal(frame.takerState, 'loading')
    assert.equal(statistics, 1)
    await finishSeed(pipeline)
    assert.equal(pipeline.cached(`${instId}:15m`).liveBar.close, 142)
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'ready')
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('a listing with fewer than 96 candles publishes all available prices', async () => {
  const { pipeline } = fixture(source(12))
  try {
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.bars.length, 12); assert.equal(frame.endHour, end()); assert.equal(frame.unavailable, undefined)
    await finishSeed(pipeline)
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'unavailable', 'Observed warmup nulls are truthful calculated results.')
    assert.equal(pipeline.cached(`${instId}:15m`).bars.at(-1).ema, null)
  } finally { await pipeline.dispose() }
})

test('cold forming prices are visible without any historical candle or recursive seed', async () => {
  const { pipeline } = fixture([])
  try {
    pipeline.setUniverse([instId], '15m', instId)
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false, close: 101.5 })
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.bars.length, 0); assert.equal(frame.liveBar.close, 101.5); assert.equal(frame.indicatorState, 'loading')
  } finally { await pipeline.dispose() }
})

test('candidate subscription and renderer admission perform no eager source restoration', async () => {
  const { pipeline, store } = fixture()
  try {
    const ids = Array.from({ length: 287 }, (_, i) => `CANDIDATE${i}-USDT-SWAP`)
    pipeline.setRealtimeSubscriptions(ids.flatMap(instId => ['5m', '15m', '1H'].map(timeframe => ({ instId, timeframe }))))
    const response = await pipeline.setUniverse(ids, '15m', ids[0])
    assert.deepEqual(response, { frames: [] }); assert.equal(pipeline.realtimeKeys.size, 861)
    assert.equal(store.queries.length, 0); assert.equal(pipeline.nextCalculation, 0); assert.equal(pipeline.series.size, 0)
  } finally { await pipeline.dispose() }
})

test('exact recursive work reads bounded chunks and durable checkpoints reproduce full-history math', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  let restarted: any
  try {
    const raw = await pipeline.local(instId, '15m')
    assert.equal(raw.indicatorState, 'loading'); assert.equal(store.queries[0].limit, 128)
    await finishSeed(pipeline)
    const frame = pipeline.cached(`${instId}:15m`), oracle = buildIndicatorSeries(rows, interval).bars as any[]
    for (const value of frame.bars) for (const key of indicatorFields) assert.equal(value[key], oracle.find(row => row.hour === value.hour)![key])
    assert.ok(store.queries.every(query => query.limit <= 1536), 'No query can load the complete native history.')
    assert.ok(store.checkpoints.length >= 3)
    await pipeline.dispose()
    restarted = new PreparedChartPipeline({ store: store as any, history: {} as any, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined })
    restarted.workerLimit = 2
    store.queries = []
    await restarted.local(instId, '15m'); await finishSeed(restarted)
    const chunks = store.queries.filter(query => query.order === 'asc')
    assert.ok(chunks[0].from > rows[0].timestamp, 'A verified prefix checkpoint avoids replaying the canonical origin.')
    for (const key of indicatorFields) assert.equal(restarted.cached(`${instId}:15m`).bars.at(-1)[key], oracle.at(-1)![key])
  } finally { await restarted?.dispose(); await pipeline.dispose() }
})

test('old price corrections invalidate descendant seeds and keep prices visible during exact recomputation', async () => {
  const rows = source(2500), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const changed = { ...rows[100], close: rows[100].close + .5 }
    const previous = store.change(changed)
    pipeline.observe([changed], previous)
    assert.equal(pipeline.cached(`${instId}:15m`).priceState, 'ready')
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'loading')
    await finishSeed(pipeline)
    const oracle = buildIndicatorSeries(store.rows, interval).bars.at(-1) as any
    for (const key of indicatorFields) assert.equal(pipeline.cached(`${instId}:15m`).bars.at(-1)[key], oracle[key])
  } finally { await pipeline.dispose() }
})

test('statistics changes refresh only their observations without recalculating price indicators', async () => {
  const { pipeline, store } = fixture()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const count = pipeline.nextCalculation, frame = pipeline.cached(`${instId}:15m`), last = store.rows.at(-1)!
    store.rows[store.rows.length - 1] = { ...last, oi: null, statisticsVersion: 11, statisticsOIExpiresAt: Date.now() - 1 }
    await pipeline.observeStatistics(instId, '15m', last.timestamp, last.timestamp)
    const next = pipeline.cached(`${instId}:15m`)
    assert.equal(next.endHour, end()); assert.equal(next.oiState, 'loading'); assert.equal(next.indicatorState, 'ready')
    assert.equal(next.bars.at(-1).ema, frame.bars.at(-1).ema); assert.equal(pipeline.nextCalculation, count)
    assert.equal(next.sourceVersions.price, frame.sourceVersions.price)
    assert.ok(next.sourceVersions.oi > frame.sourceVersions.oi)
    assert.equal(next.sourceVersions.taker, frame.sourceVersions.taker)
  } finally { await pipeline.dispose() }
})

test('warm forming ticks preserve exact confirmed state and never read or replay history', async () => {
  const rows = source(400), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const reads = store.queries.length, calculations = pipeline.nextCalculation, writes = store.checkpoints.length
    const completed = pipeline.cached(`${instId}:15m`).bars
    let last: any
    for (let index = 0; index < 40; index += 1) {
      last = { ...candle(end() + interval, 400), high: 150, close: 141 + index / 100, confirmed: false, volume: 100 + index }
      const frame = await pipeline.setLive(instId, '15m', last)
      assert.equal(frame.bars, completed, 'Live-only deltas reuse immutable confirmed bars.')
    }
    const frame = pipeline.cached(`${instId}:15m`), oracle = buildIndicatorSeries([...rows, last], interval).bars.at(-1) as any
    assert.equal(frame.liveBar.close, last.close)
    for (const key of indicatorFields) assert.equal(frame.liveBar[key], oracle[key])
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations); assert.equal(store.checkpoints.length, writes)
  } finally { await pipeline.dispose() }
})

test('bounded local historical prices remain navigable across unknown and expired statistic holes', async () => {
  const rows = source(5000).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null })), { pipeline, store } = fixture(rows as any)
  try {
    const requested = rows[2000].timestamp, frame = await pipeline.localHistory(instId, '15m', requested)
    assert.ok(frame.bars.length <= 1536); assert.equal(frame.endHour, requested)
    assert.ok(frame.bars.some((value: any) => value.hour === requested))
    assert.equal(frame.oiState, 'loading'); assert.ok(store.queries.every(query => query.limit))
  } finally { await pipeline.dispose() }
})

test('cache existence never certifies realtime when stream continuity or observation age is missing', async () => {
  const { pipeline } = fixture()
  try {
    await pipeline.local(instId, '15m')
    assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'stale')
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false }, { receivedAt: Date.now() - 60_000 })
    assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'stale')
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false }, { receivedAt: Date.now() })
    assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'live')
    pipeline.streaming = () => false
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false })
    assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'stale')
  } finally { await pipeline.dispose() }
})

test('failed statistic sources use independent exponential deadlines while prices stay available', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const rows = source(400).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  let attempts = 0
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { attempts += 1; throw new Error('Statistics offline') } })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    const frame = await pipeline.local(instId, '15m')
    await flush()
    assert.equal(frame.priceState, 'ready'); assert.equal(attempts, 1)
    context.mock.timers.tick(4_999); await flush(); assert.equal(attempts, 1)
    context.mock.timers.tick(1); await flush(); assert.equal(attempts, 2)
    context.mock.timers.tick(9_999); await flush(); assert.equal(attempts, 2)
    context.mock.timers.tick(1); await flush(); assert.equal(attempts, 3)
    assert.equal(pipeline.cached(`${instId}:15m`).endHour, end())
  } finally { await pipeline.dispose() }
})

test('successful unavailable observations renew only at their actual lease deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const rows: any[] = source(400), expiresAt = Date.now() + 10_000
  rows[399] = { ...rows[399], oi: null, buy: null, sell: null, statisticsVersion: 11, statisticsOIExpiresAt: expiresAt, statisticsTakerExpiresAt: expiresAt }
  let attempts = 0
  const { pipeline, store } = fixture(rows, { async ensureStatistics() {
    attempts += 1
    store.rows[399] = { ...store.rows[399], statisticsOIExpiresAt: Date.now() + 60_000, statisticsTakerExpiresAt: Date.now() + 60_000 }
  } })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    context.mock.timers.tick(9_999); await flush(); assert.equal(attempts, 0)
    context.mock.timers.tick(1); await flush(); assert.equal(attempts, 1)
    assert.equal(pipeline.cached(`${instId}:15m`).endHour, end())
    assert.equal(pipeline.cached(`${instId}:15m`).oiState, 'unavailable')
    context.mock.timers.tick(30_000); await flush(); assert.equal(attempts, 1)
  } finally { await pipeline.dispose() }
})

test('a quiet quote pushes its stale transition without periodic chart reads or source requests', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  let requests = 0
  const { pipeline } = fixture(source(400), { async latest() { requests += 1 }, async ensureStatistics() { requests += 1 } })
  const published: any[] = []
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    pipeline.subscribe((frame: any) => published.push(frame))
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false }, { receivedAt: Date.now() })
    assert.equal(published.at(-1).realtimeState, 'live')
    context.mock.timers.tick(30_000)
    assert.equal(published.at(-1).realtimeState, 'stale')
    assert.equal(requests, 0)
  } finally { await pipeline.dispose() }
})

test('returning from deep history restores an evicted latest price locally before source work', async () => {
  const rows = source(5000), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    await pipeline.localHistory(instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(state.rows.has(rows.at(-1)!.timestamp), false, 'The test must actually evict the current tail.')
    const before = store.queries.length
    const latest = await pipeline.local(instId, '15m')
    assert.equal(latest.endHour, rows.at(-1)!.timestamp)
    assert.equal(latest.bars.at(-1).close, rows.at(-1)!.close)
    assert.equal(state.historyEnd, null)
    assert.ok(store.queries.slice(before).some(query => query.order === 'desc' && query.limit === 128))
  } finally { await pipeline.dispose() }
})

test('forming ticks never rebuild or republish an open historical navigation reserve', async () => {
  const rows = source(2000), { pipeline, store } = fixture(rows), target = rows[1900].timestamp
  try {
    await pipeline.localHistory(instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), history = pipeline.historyFrame(state, target)
    const reads = store.queries.length, calculations = pipeline.nextCalculation, published: any[] = []
    pipeline.subscribe((frame: any) => published.push(frame))
    for (let index = 0; index < 30; index += 1) await pipeline.setLive(instId, '15m', { ...candle(end() + interval, 2000), volume: 100 + index, confirmed: false })
    assert.equal(pipeline.historyFrame(state, target).bars, history.bars, 'A bounded reserve is immutable until its source or indicator generation changes.')
    assert.equal(published.filter(frame => frame.endHour === target).length, 0, 'Only the current forming projection crosses IPC on ticks.')
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations)
  } finally { await pipeline.dispose() }
})


test('in-flight local SQLite reads remain admitted while other series exceed the resident limit', async () => {
  const { pipeline, store } = fixture(), hold = deferred(), started = deferred()
  const original = store.candles.bind(store)
  store.candles = async (query: any) => {
    if (query.instrument === instId && query.order === 'desc') { started.resolve(); await hold.promise }
    return original(query)
  }
  pipeline.maxSeries = 1
  try {
    const selected = pipeline.local(instId, '15m')
    await started.promise
    const admitted = pipeline.series.get(`${instId}:15m`)
    for (let index = 0; index < 20; index += 1) {
      pipeline.focusKey = `OTHER${index}:15m`
      pipeline.state(`OTHER${index}`, '15m'); pipeline.trim()
      assert.equal(pipeline.series.get(`${instId}:15m`), admitted, 'A read must retain its own state across the asynchronous query.')
    }
    hold.resolve()
    const frame = await selected
    assert.equal(frame.bars.length, 96); assert.equal(frame.bars.at(-1).close, store.rows.at(-1).close)
    await finishSeed(pipeline)
    assert.ok(pipeline.series.size <= 1, 'Temporary in-flight admission is released after completion.')
  } finally { hold.resolve(); await pipeline.dispose() }
})
