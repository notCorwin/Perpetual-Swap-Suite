import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { MarketStore } from '../electron/services/market-store.js'
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
const sqliteFixture = async (rows: any[]) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prefix-fence-')), store = await MarketStore.open(root)
  await store.appendCandles(rows)
  const pipeline: any = new PreparedChartPipeline({ store, history: {} as any, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined })
  return { store, pipeline, async close() { await pipeline.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

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
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
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

test('rows admitted behind an in-flight historical replay are eventually calculated exactly', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows), hold = deferred(), reached = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const write = store.writeIndicatorCheckpoint.bind(store)
    let blocked = false
    store.writeIndicatorCheckpoint = async (value: any) => {
      if (!blocked && value.timestamp === rows[1023].timestamp) { blocked = true; reached.resolve(); await hold.promise }
      return write(value)
    }
    await pipeline.localHistory(instId, '15m', rows[2000].timestamp)
    await reached.promise
    await pipeline.localHistory(instId, '15m', rows[600].timestamp)
    hold.resolve(); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), frame = pipeline.historyFrame(state, rows[600].timestamp)
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of frame.bars) {
      assert.equal(value.indicatorsObserved, true, `Admitted candle ${value.hour} must not be stranded behind a completed chunk.`)
      for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    }
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('historical replay cannot replace the exact latest recursive core or its known statistics', async () => {
  const rows = source(4000), { pipeline } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const current = { ...candle(end() + interval, 4000), high: 510, close: 501.5, confirmed: false }
    await pipeline.setLive(instId, '15m', current)
    const before = pipeline.cached(`${instId}:15m`)
    await pipeline.localHistory(instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
    const next = await pipeline.setLive(instId, '15m', { ...current, close: 501.6, volume: current.volume + 1 })
    assert.equal(next.bars.length, 96, 'A historical navigation reserve must not publish an empty latest tail.')
    assert.equal(next.bars.at(-1).oi, rows.at(-1)!.oi)
    assert.equal(pipeline.liveStates.get(`${instId}:15m`).indicatorState.lastTimestamp, rows.at(-1)!.timestamp)
    assert.equal(next.liveBar.indicatorsObserved, true)
    const oracle = buildIndicatorSeries([...rows, { ...current, close: 501.6, volume: current.volume + 1 }], interval).bars.at(-1) as any
    for (const key of indicatorFields) assert.equal(next.liveBar[key], oracle[key])
    assert.equal(next.generation, before.generation)
  } finally { await pipeline.dispose() }
})

test('price-only observations preserve independently known OI and Taker facts', async () => {
  const { pipeline, store } = fixture()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const previous = store.rows.at(-1)!, priceOnly = { ...previous, close: previous.close + 1, statisticsVersion: 0, oi: null, buy: null, sell: null }
    pipeline.observe([priceOnly], new Map([[previous.timestamp, previous]]))
    const frame = pipeline.cached(`${instId}:15m`), last = frame.bars.at(-1)
    assert.equal(last.oi, previous.oi); assert.equal(last.buy, previous.buy); assert.equal(last.sell, previous.sell)
    assert.equal(last.oiObserved, true); assert.equal(last.takerObserved, true)
  } finally { await pipeline.dispose() }
})

test('a delayed statistics query cannot roll back canonical price fields or a newer statistic observation', async () => {
  const { pipeline, store } = fixture(), hold = deferred(), started = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const query = store.candles.bind(store), previous = store.rows.at(-1)!
    let blocked = false
    store.candles = async (value: any) => {
      const result = await query(value)
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return result
    }
    const statistics = pipeline.observeStatistics(instId, '15m', previous.timestamp, previous.timestamp)
    await started.promise
    const corrected = { ...previous, close: previous.close + 1, oi: previous.oi + 100 }
    const prior = store.change(corrected)
    pipeline.observe([corrected], prior)
    hold.resolve(); await statistics; await finishSeed(pipeline)
    const last = pipeline.cached(`${instId}:15m`).bars.at(-1)
    assert.equal(last.close, corrected.close); assert.equal(last.oi, corrected.oi)
    const oracle = buildIndicatorSeries(store.rows, interval).bars.at(-1) as any
    for (const key of indicatorFields) assert.equal(last[key], oracle[key])
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('restored latest cores do not share mutable recursive state and volume corrections invalidate derived values', async () => {
  const rows = source(500), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    pipeline.series.delete(`${instId}:15m`)
    await pipeline.local(instId, '15m')
    const state = pipeline.series.get(`${instId}:15m`), live = pipeline.liveStates.get(`${instId}:15m`)
    assert.notEqual(state.indicatorState, live.indicatorState)
    const next = candle(end() + interval, 500)
    const prior = store.change(next)
    pipeline.observe([next], prior)
    assert.equal(state.indicatorState.lastTimestamp, next.timestamp)
    assert.equal(live.indicatorState.lastTimestamp, next.timestamp)
    const generation = state.generation, corrected = { ...rows[490], baseVolume: 10_000 }
    pipeline.observe([corrected], store.change(corrected))
    assert.ok(state.generation > generation, 'VWAP input changes invalidate derived values even when OHLC is unchanged.')
    await finishSeed(pipeline)
    const oracle = buildIndicatorSeries(store.rows, interval).bars.at(-1) as any
    for (const key of indicatorFields) assert.equal(pipeline.cached(`${instId}:15m`).bars.at(-1)[key], oracle[key])
  } finally { await pipeline.dispose() }
})


test('the requested historical viewport publishes exact indicators before its remaining reserve finishes', async () => {
  const rows = source(3500), { pipeline } = fixture(rows), hold = deferred(), reached = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const calculate = pipeline.calculate.bind(pipeline), target = rows[2000].timestamp
    let blocked = false
    pipeline.calculate = async (candles: any[], ...args: any[]) => {
      if (!blocked && candles[0].timestamp === rows[0].timestamp) { blocked = true; reached.resolve(); await hold.promise }
      return calculate(candles, ...args)
    }
    await pipeline.localHistory(instId, '15m', target)
    await reached.promise
    const frame = pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target)
    const viewport = frame.bars.filter((value: any) => value.hour >= target - 95 * interval && value.hour <= target)
    assert.equal(viewport.length, 96)
    assert.equal(viewport.every((value: any) => value.indicatorsObserved && indicatorFields.every(field => Number.isFinite(value[field]))), true)
    assert.equal(frame.bars.some((value: any) => !value.indicatorsObserved), true, 'The test must hold a genuinely unfinished surrounding reserve.')
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('a checkpoint lookup cannot attach an old recursive seed to a later durable price revision', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  let restarted: any
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline); await pipeline.dispose()
    const read = store.readIndicatorCheckpoint.bind(store)
    let corrected = false
    store.readIndicatorCheckpoint = async (query: any) => {
      const result = await read(query)
      if (!corrected) { corrected = true; store.change({ ...rows[100], close: rows[100].close + 20, baseVolume: 1000 }) }
      return result
    }
    restarted = new PreparedChartPipeline({ store: store as any, history: {} as any, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined })
    await restarted.local(instId, '15m'); await finishSeed(restarted)
    const oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
    const frame = restarted.cached(`${instId}:15m`)
    for (const value of frame.bars) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    for (const checkpoint of store.checkpoints) assert.equal(checkpoint.state.ema, (oracle.get(checkpoint.timestamp) as any).ema, 'No stale recursive seed can be resurrected under a newer revision.')
    assert.ok(restarted.nextCalculation < 20, 'A source fence reloads once instead of spinning on the invalidated chunk.')
  } finally { await restarted?.dispose(); await pipeline.dispose() }
})

test('a rejected checkpoint write reloads changed canonical inputs before publishing calculated values', async () => {
  const rows = source(1800), { pipeline, store } = fixture(rows)
  let changed = false
  const write = store.writeIndicatorCheckpoint.bind(store)
  store.writeIndicatorCheckpoint = async (value: any) => {
    if (!changed) { changed = true; store.change({ ...rows[1750], close: rows[1750].close + 30 }) }
    return write(value)
  }
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const frame = pipeline.cached(`${instId}:15m`), oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of frame.bars) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    assert.equal(frame.bars.find((value: any) => value.hour === rows[1750].timestamp).close, store.rows[1750].close)
    assert.ok(pipeline.nextCalculation < 12)
  } finally { await pipeline.dispose() }
})

test('a durable correction reloaded through the live tail keeps its historical series generation coherent', async () => {
  const rows = source(3000), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const historicalEnd = rows[1500].timestamp
    await pipeline.localHistory(instId, '15m', historicalEnd); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), live = pipeline.liveStates.get(`${instId}:15m`)
    assert.equal(state.rows.has(state.latestHour), false, 'The historical reserve must be independent of the retained latest tail.')
    assert.equal(state.generation, live.generation)
    // Model a committed correction whose observer has not arrived yet. The
    // source-revision fence reloads history and then the independently kept tail.
    store.change({ ...rows[2975], close: rows[2975].close + 1 })
    const frames: any[] = []
    pipeline.subscribe((frame: any) => frames.push(frame))
    await pipeline.refreshChangedCanonical(state, state.priceVersion)
    assert.equal(state.generation, live.generation, 'Reloading a live-tail correction must invalidate every projection of the same series.')
    assert.ok(frames.some(frame => frame.endHour === historicalEnd))
    assert.ok(frames.some(frame => frame.endHour === state.latestHour))
    assert.ok(frames.every(frame => frame.generation === state.generation), 'A newer latest notification must never make the following historical frame obsolete.')
    await pipeline.seed(state); await finishSeed(pipeline)
    const oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.cached(`${instId}:15m`).bars) for (const field of indicatorFields) {
      assert.equal(value[field], (oracle.get(value.hour) as any)[field])
    }
  } finally { await pipeline.dispose() }
})


test('a late historical SQL response cannot retarget or evict the newer requested viewport', async () => {
  const rows = source(5000), { pipeline, store } = fixture(rows), hold = deferred(), started = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const read = store.candles.bind(store), oldEnd = rows[1800].timestamp, newEnd = rows[3500].timestamp
    let blocked = false
    store.candles = async (query: any) => {
      const result = await read(query)
      if (!blocked && query.order === 'desc' && query.through === oldEnd + 256 * interval) { blocked = true; started.resolve(); await hold.promise }
      return result
    }
    const older = pipeline.localHistory(instId, '15m', oldEnd)
    await started.promise
    await pipeline.localHistory(instId, '15m', newEnd)
    hold.resolve(); await older; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), frame = pipeline.historyFrame(state, newEnd)
    assert.equal(state.historyEnd, newEnd)
    const viewport = frame.bars.filter((value: any) => value.hour >= newEnd - 95 * interval && value.hour <= newEnd)
    assert.equal(viewport.length, 96); assert.equal(viewport.every((value: any) => value.indicatorsObserved), true)
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('resident historical viewports reuse their canonical rows without another SQLite read', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  try {
    await pipeline.localHistory(instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
    const reads = store.queries.length
    const next = await pipeline.localHistory(instId, '15m', rows[1999].timestamp)
    const viewport = next.bars.filter((value: any) => value.hour >= rows[1904].timestamp && value.hour <= rows[1999].timestamp)
    assert.equal(viewport.length, 96)
    assert.equal(viewport.every((value: any) => value.indicatorsObserved), true)
    assert.equal(store.queries.length, reads, 'A resident cursor move must reuse rows and exact derived values.')
  } finally { await pipeline.dispose() }
})

test('the first history gesture expands a resident latest tail into its durable navigation reserve', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(state.rows.size, 128)
    const before = store.queries.length
    const historical = await pipeline.localHistory(instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(historical.bars.length >= 1280, 'A complete 96-candle viewport cannot substitute for the first bulk history admission.')
    assert.ok(store.queries.slice(before).some(query => query.order === 'desc' && query.limit === 1536))
    await finishSeed(pipeline)
    const reads = store.queries.length
    await pipeline.localHistory(instId, '15m', rows.at(-3)!.timestamp)
    assert.equal(store.queries.length, reads, 'Later resident gestures reuse the admitted historical reserve.')

    await pipeline.localHistory(instId, '15m', rows[1200].timestamp); await finishSeed(pipeline)
    assert.ok(state.historyRange.through < rows.at(-96)!.timestamp)
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const tail = [...state.rows.values()].filter((row: any) => row.timestamp >= rows.at(-128)!.timestamp)
    assert.equal(tail.length, 128, 'Returning from deep history restores only the latest tail.')
    const afterDeepHistory = store.queries.length
    const returned = await pipeline.localHistory(instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(returned.bars.filter((bar: any) => bar.hour >= rows.at(-1280)!.timestamp).length >= 1280,
      'A deep-history interval cannot certify the latest navigation reserve.')
    assert.ok(store.queries.slice(afterDeepHistory).some(query => query.order === 'desc' && query.limit === 1536))
    await finishSeed(pipeline)
    const admittedAgain = store.queries.length
    await pipeline.localHistory(instId, '15m', rows.at(-3)!.timestamp)
    assert.equal(store.queries.length, admittedAgain)

    await pipeline.local(instId, '15m')
    pipeline.invalidate(instId, '15m')
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    assert.equal(state.rows.size, 128)
    const afterInvalidation = store.queries.length
    const restored = await pipeline.localHistory(instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(restored.bars.length >= 1280, 'Invalidation also retires the previous bulk-history admission.')
    assert.ok(store.queries.slice(afterInvalidation).some(query => query.order === 'desc' && query.limit === 1536))
  } finally { await pipeline.dispose() }
})

test('a committed mutation invalidates resident history before its normal observer arrives', async () => {
  const rows = source(2500), fixtureValue = await sqliteFixture(rows), { pipeline, store } = fixtureValue
  try {
    const target = rows[1800].timestamp
    await pipeline.localHistory(instId, '15m', target); await finishSeed(pipeline)
    const corrected = { ...rows[1750], close: rows[1750].close + .5 }
    await store.appendCandles([corrected]) // Deliberately withhold pipeline.observe.
    const next = await pipeline.localHistory(instId, '15m', target)
    assert.equal(next.bars.find((value: any) => value.hour === corrected.timestamp).close, corrected.close)
    await finishSeed(pipeline)
    const oracle = new Map(buildIndicatorSeries(rows.map(row => row.timestamp === corrected.timestamp ? corrected : row), interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target).bars) if (value.indicatorsObserved) {
      for (const field of indicatorFields) assert.equal(value[field], (oracle.get(value.hour) as any)[field])
    }
  } finally { await fixtureValue.close() }
})

test('a delayed historical SQL result reloads a durable correction before merging stale observations', async () => {
  const rows = source(2500), fixtureValue = await sqliteFixture(rows), { pipeline, store } = fixtureValue
  const hold = deferred(), started = deferred()
  let reading: Promise<void> | undefined
  try {
    const target = rows[1800].timestamp
    await pipeline.localHistory(instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), read = store.candles.bind(store)
    let reads = 0
    store.candles = async (query: any, priority: any) => {
      const result = await read(query, priority)
      if (query.order === 'desc') {
        reads += 1
        if (reads === 1) { started.resolve(); await hold.promise }
      }
      return result
    }
    reading = pipeline.read(state, target, 1536)
    await started.promise
    const corrected = { ...rows[1750], close: rows[1750].close + .5 }
    await store.appendCandles([corrected]) // The normal observer is deliberately late.
    hold.resolve(); await reading
    assert.equal(reads, 2, 'A durable revision change rejects the delayed SQL snapshot before it enters the cache.')
    assert.equal(state.rows.get(corrected.timestamp).close, corrected.close)
    await pipeline.seed(state); await finishSeed(pipeline)
    const oracle = new Map(buildIndicatorSeries(rows.map(row => row.timestamp === corrected.timestamp ? corrected : row), interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.historyFrame(state, target).bars) if (value.indicatorsObserved) {
      for (const field of indicatorFields) assert.equal(value[field], (oracle.get(value.hour) as any)[field])
    }
  } finally { hold.resolve(); await reading; await fixtureValue.close() }
})

test('cold history publishes a mature nearest viewport before farther reserve pages or optional statistics finish', async () => {
  const rows = source(2500), target = rows[1800].timestamp, hold = deferred(), reached = deferred()
  const calls: { from: number; through: number }[] = [], frames: any[] = []
  let fixtureValue: ReturnType<typeof fixture>, finished = false
  fixtureValue = fixture(rows.slice(2100), {
    async ensurePrices(_instrument: string, _timeframe: string, from: number, through: number) {
      calls.push({ from, through })
      if (through < target) { reached.resolve(); await hold.promise }
      const page = rows.filter(row => row.timestamp >= from && row.timestamp <= through).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null })), prior = new Map()
      for (const row of page) for (const [hour, value] of fixtureValue.store.change(row)) prior.set(hour, value)
      fixtureValue.pipeline.observe(page, prior)
    },
    async ensureStatistics() { await hold.promise },
  })
  const { pipeline, store } = fixtureValue
  let preparation: Promise<unknown> | undefined
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    pipeline.subscribe((frame: any) => frames.push(frame))
    preparation = pipeline.prepare(instId, '15m', target, 4096).then(() => { finished = true })
    await reached.promise
    const ready = frames.find(frame => frame.endHour === target && frame.indicatorState === 'ready')
    assert.ok(ready, 'The nearest requested viewport must publish exact mature curves before another source page starts.')
    const viewport = ready.bars.filter((value: any) => value.hour >= target - 95 * interval && value.hour <= target)
    assert.equal(viewport.length, 96)
    assert.equal(ready.oiState, 'loading'); assert.equal(ready.takerState, 'loading')
    const oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of viewport) for (const field of indicatorFields) assert.equal(value[field], (oracle.get(value.hour) as any)[field])
    assert.deepEqual(calls[0], { from: target - 299 * interval, through: target })
    assert.equal(calls[1].through, target - 300 * interval)
    assert.equal(finished, false, 'The bulk request retains ownership of its unfinished reserve.')
    hold.resolve(); await preparation; await finishSeed(pipeline)
    assert.equal(calls.at(-1)!.from, target - 1279 * interval, 'The resident limit also includes its 256 newer candles.')
    assert.ok(calls.every(call => (call.through - call.from) / interval + 1 <= 300))
  } finally { hold.resolve(); await preparation; await pipeline.dispose() }
})

test('an upgrade ignores poisoned v3 checkpoints even when they carry the current durable watermark', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  const legacyVersion = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-v3'
  const poisoned = structuredClone(buildIndicatorSeries(rows.slice(0, 3072), interval).state)
  assert.notEqual(poisoned.ema, null)
  poisoned.ema = poisoned.ema! + 10_000
  poisoned.rsi[0].gains += 1000
  await store.writeIndicatorCheckpoint({ instrument: instId, timeframe: '15m', timestamp: poisoned.lastTimestamp,
    formulaVersion: legacyVersion, state: poisoned, sourceRevision: await store.priceWatermark() })
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.cached(`${instId}:15m`).bars) for (const field of indicatorFields) {
      assert.equal(value[field], (oracle.get(value.hour) as any)[field], `The upgraded producer must reconstruct ${field} from canonical candles.`)
    }
    assert.equal(store.queries.find(query => query.order === 'asc').from, 0, 'An unsafe producer checkpoint cannot establish the canonical prefix.')
    assert.ok(store.checkpoints.some(value => value.formulaVersion.endsWith('-v4')))
    assert.deepEqual(store.rows, rows, 'Only derived checkpoints are replaced; canonical market records remain unchanged.')
  } finally { await pipeline.dispose() }
})

test('new archive pages after an open historical viewport cannot evict its prices, statistics or unaffected exact indicators', async () => {
  const all = source(5000), { pipeline, store } = fixture(all.filter((_, index) => index < 2100 || index >= 4000))
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const target = all[1800].timestamp
    await pipeline.localHistory(instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), first = target - 95 * interval
    const original = new Map([...state.indicators].filter(([hour]: any) => hour >= first && hour <= target))
    assert.equal(original.size, 96)
    for (let offset = 2100; offset < 3600; offset += 300) {
      const page = all.slice(offset, offset + 300), prior = new Map()
      for (const row of page) for (const [hour, value] of store.change(row)) prior.set(hour, value)
      pipeline.observe(page, prior)
      const visible = pipeline.historyFrame(state, target).bars.filter((value: any) => value.hour >= first && value.hour <= target)
      assert.equal(visible.length, 96, 'A later downloaded page must not evict the selected historical bars.')
      assert.equal(visible.every((value: any) => value.indicatorsObserved && value.oi === 5000 && value.buy === 70 && value.sell === 30), true)
      for (const [hour, value] of original) assert.equal(state.indicators.get(hour), value, 'Inputs after this historical prefix cannot invalidate its derived observations.')
      assert.ok(state.rows.size <= 1536)
      assert.ok(pipeline.liveStates.get(state.key).rows.size <= 128)
    }
    await finishSeed(pipeline)
  } finally { await pipeline.dispose() }
})

test('newly downloaded older prefixes invalidate recursive descendants without discarding independent statistic facts', async () => {
  const all = source(1100), { pipeline, store } = fixture(all.slice(600)), target = all[1000].timestamp
  try {
    await pipeline.localHistory(instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    for (const page of [all.slice(300, 600), all.slice(0, 300)]) {
      const generation = state.generation, prior = new Map()
      for (const row of page) for (const [hour, value] of store.change(row)) prior.set(hour, value)
      pipeline.observe(page, prior)
      assert.ok(state.generation > generation, 'Extending the canonical recursive prefix requires a new exact basis.')
      const pending = pipeline.historyFrame(state, target).bars.filter((value: any) => value.hour >= target - 95 * interval && value.hour <= target)
      assert.equal(pending.length, 96)
      assert.equal(pending.every((value: any) => value.oiObserved && value.takerObserved && value.oi === 5000 && value.buy === 70 && value.sell === 30), true)
      await finishSeed(pipeline)
      const oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
      const actual = pipeline.historyFrame(state, target).bars.filter((value: any) => value.hour >= target - 95 * interval && value.hour <= target)
      for (const value of actual) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    }
  } finally { await pipeline.dispose() }
})

test('durable later-price changes do not restart an unaffected historical replay or clear its already prepared prefix', async () => {
  const rows = source(3500), f = await sqliteFixture(rows), { pipeline, store } = f, hold = deferred(), started = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline), inputs: string[] = []
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      inputs.push(`${input[0].timestamp}:${input.at(-1).timestamp}`)
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await pipeline.localHistory(instId, '15m', target)
    await started.promise
    const corrected = { ...rows[3400], close: rows[3400].close + .5 }
    await store.appendCandles([corrected])
    pipeline.observe([corrected], new Map([[corrected.timestamp, rows[3400]]]))
    const later = { ...rows[3401], close: rows[3401].close + .5 }, write = store.writeIndicatorCheckpoint.bind(store)
    let guardChanged = false
    store.writeIndicatorCheckpoint = async (value: any, priority?: any) => {
      if (!guardChanged && value.timestamp === target) {
        guardChanged = true
        await store.appendCandles([later])
        pipeline.observe([later], new Map([[later.timestamp, rows[3401]]]))
      }
      return write(value, priority)
    }
    hold.resolve(); await finishSeed(pipeline)
    assert.equal(guardChanged, true, 'A second later mutation must also race the checkpoint guard.')
    assert.equal(reloads, 0, 'A contiguous durable journal proves that this historical recursive prefix did not change.')
    assert.equal(inputs.filter(value => value.endsWith(`:${target}`)).length, 1, 'The completed historical calculation must be reused across an unrelated later mutation.')
    const oracleRows = rows.map(row => row.timestamp === corrected.timestamp ? corrected : row.timestamp === later.timestamp ? later : row)
    const oracle = new Map(buildIndicatorSeries(oracleRows, interval).bars.map((value: any) => [value.hour, value]))
    const state = pipeline.series.get(`${instId}:15m`)
    for (const value of pipeline.historyFrame(state, target).bars) if (value.indicatorsObserved) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    for (let index = 0; index < 260; index += 1) await store.appendCandles([{ ...corrected, baseVolume: 200 + index }])
    assert.equal(pipeline.priceJournal.get(state.key).length, 256)
    pipeline.maxSeries = 1
    await store.appendCandles([{ ...rows.at(-1)!, instrument: 'ETH-USDT-SWAP' }])
    await pipeline.local('ETH-USDT-SWAP', '15m'); await finishSeed(pipeline)
    assert.equal(pipeline.priceJournal.has(state.key), false, 'Evicting the resident reserve also releases its bounded mutation journal.')
  } finally { hold.resolve(); await f.close() }
})

test('a durable prefix correction with a late observer retains the strict fence and cannot certify stale recursive state', async () => {
  const rows = source(3500), f = await sqliteFixture(rows), { pipeline, store } = f, hold = deferred(), started = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline)
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await pipeline.localHistory(instId, '15m', target)
    await started.promise
    const corrected = { ...rows[1000], close: rows[1000].close + .5, baseVolume: 500 }
    await store.appendCandles([corrected]) // Deliberately withhold pipeline.observe.
    hold.resolve(); await finishSeed(pipeline)
    assert.ok(reloads > 0, 'A dependency mutation cannot be rebased merely because its observer is late.')
    const oracle = new Map(buildIndicatorSeries(rows.map(row => row.timestamp === corrected.timestamp ? corrected : row), interval).bars.map((value: any) => [value.hour, value]))
    const actual = pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target).bars
    for (const value of actual) if (value.indicatorsObserved) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    assert.equal(actual.filter((value: any) => value.hour >= target - 95 * interval && value.hour <= target && value.indicatorsObserved).length, 96)
    const checkpoint = await store.readIndicatorCheckpoint({ instrument: instId, timeframe: '15m', before: target,
      formulaVersion: 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-v4' })
    assert.ok(checkpoint)
    assert.equal(checkpoint.state.ema, (oracle.get(checkpoint.timestamp) as any).ema)
  } finally { hold.resolve(); await f.close() }
})

test('a missing durable mutation event cannot authorize rebasing even a later-price change', async () => {
  const rows = source(3500), f = await sqliteFixture(rows), { pipeline, store } = f, hold = deferred(), started = deferred()
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline)
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await pipeline.localHistory(instId, '15m', target)
    await started.promise
    pipeline.unsubscribeStore()
    const corrected = { ...rows[3400], close: rows[3400].close + .5 }
    await store.appendCandles([corrected])
    hold.resolve(); await finishSeed(pipeline)
    assert.ok(reloads > 0, 'A durable watermark alone provides no dependency-range proof.')
    const oracle = new Map(buildIndicatorSeries(rows.map(row => row.timestamp === corrected.timestamp ? corrected : row), interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target).bars) if (value.indicatorsObserved) {
      for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    }
  } finally { hold.resolve(); await f.close() }
})
