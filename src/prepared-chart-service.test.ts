import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { ChartNotificationEncoder } from '../electron/services/chart-notifications.js'
import { MarketStore } from '../electron/services/market-store.js'
import { buildIndicatorSeries } from '../electron/services/indicators.js'
import { attachOperationSink, type OperationEvent } from '../electron/services/operations.js'

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
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
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

test('a current forming quote cannot certify a stale confirmed tail and its full window repairs immediately', async () => {
  const canonical = source(400), missing = canonical.slice(-12), gate = deferred()
  let latestCalls = 0, priceCalls = 0
  const { pipeline, store } = fixture(canonical.slice(0, -12), {
    async latest() { latestCalls += 1 },
    async ensurePrices(instrument: string, timeframe: string, from: number, through: number) {
      priceCalls += 1
      assert.equal(instrument, instId); assert.equal(timeframe, '15m')
      assert.equal(from, end() - 95 * interval); assert.equal(through, end())
      await gate.promise
      for (const row of missing) store.change(row)
    },
  })
  try {
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval, 400), confirmed: false }, { receivedAt: Date.now() })
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.bars.length, 96); assert.equal(frame.priceState, 'stale')
    assert.equal(frame.realtimeState, 'live', 'Fresh quotes do not prove completed history coverage.')
    const state = pipeline.state(instId, '15m'), repair = pipeline.refreshObservations(state)
    assert.equal(priceCalls, 1, 'Concurrent demand reuses the admitted durable repair.')
    assert.equal(latestCalls, 0, 'A latest-only response cannot replace ensuring the requested window.')
    gate.resolve(); await repair; await finishSeed(pipeline)
    const repaired = pipeline.cached(`${instId}:15m`)
    assert.equal(repaired.priceState, 'ready'); assert.equal(repaired.endHour, end())
    assert.equal(repaired.bars.length, 96)
    assert.ok(repaired.bars.every((bar: any, index: number) => bar.hour === end() - (95 - index) * interval))
    await pipeline.local(instId, '15m')
    assert.equal(priceCalls, 1, 'Opening a complete persisted window must reuse its coverage.')
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('interior holes and missing quote volume stay partial until persisted source inputs are complete', async () => {
  const canonical = source(400), absent = canonical[360], incomplete = { ...canonical[370], quoteVolume: null }
  const gate = deferred()
  let attempts = 0
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent).map(row => row.timestamp === incomplete.timestamp ? incomplete : row) as any, {
    async ensurePrices() {
      attempts += 1; await gate.promise
      if (attempts === 1) store.change(absent)
      else store.change(canonical[370])
    },
  })
  try {
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.priceState, 'partial'); assert.equal(frame.bars.length, 95)
    const state = pipeline.state(instId, '15m'), key = `prices:${state.key}:${end() - 95 * interval}:${end()}`
    const first = pipeline.refreshObservations(state)
    gate.resolve(); await first
    assert.equal(pipeline.cached(state.key).bars.length, 96)
    assert.equal(pipeline.cached(state.key).priceState, 'partial', 'Row count alone cannot certify complete candle inputs.')
    assert.equal(pipeline.cached(state.key).bars.find((bar: any) => bar.hour === incomplete.timestamp).priceComplete, false)
    assert.ok(pipeline.sourceAttempts.get(key).retryAt > Date.now())
    pipeline.sourceAttempts.delete(key)
    await pipeline.refreshObservations(state)
    assert.equal(pipeline.cached(state.key).priceState, 'ready'); assert.equal(attempts, 2)
    assert.ok(pipeline.cached(state.key).bars.every((bar: any) => bar.priceComplete === true))
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a verified recent listing uses the first completed native slot without requesting prelisting candles', async () => {
  const rows = source(12)
  let requests = 0
  const { pipeline } = fixture(rows, { async ensurePrices() { requests += 1 } })
  pipeline.instrument = () => ({ listTime: rows[0].timestamp - interval / 2 })
  try {
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.oldestHour, rows[0].timestamp); assert.equal(frame.historyExhausted, true)
    assert.equal(frame.bars.length, 12); assert.equal(frame.priceState, 'ready')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(requests, 0)
  } finally { await pipeline.dispose() }
})

test('a persisted resident gap repair rebuilds descendant indicators before its observer arrives', async () => {
  const canonical = source(500), absent = canonical[450]
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent))
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m'), generation = state.generation
    assert.equal(pipeline.cached(state.key).bars.at(-1).ema, null)
    store.change(absent)
    await pipeline.read(state); await pipeline.seed(state); await finishSeed(pipeline)
    const repaired = pipeline.cached(state.key), oracle = buildIndicatorSeries(canonical, interval).bars as any[]
    assert.ok(repaired.generation > generation)
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], oracle.find(row => row.hour === value.hour)![field])
    assert.equal(repaired.priceState, 'ready'); assert.equal(repaired.indicatorState, 'ready')
  } finally { await pipeline.dispose() }
})

test('source retries repair the selected historical viewport instead of the unrelated latest tail', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const canonical = source(500), absent = canonical[330], target = canonical[350].timestamp
  const requests: Array<{ from: number; through: number }> = []
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices(_instrument: string, _timeframe: string, from: number, through: number) {
      requests.push({ from, through })
      if (requests.length === 1) throw new Error('Transient history failure')
      store.change(absent)
    },
  })
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    const frame = await pipeline.localHistory(instId, '15m', target)
    assert.equal(frame.priceState, 'partial')
    await flush(); assert.equal(requests.length, 1)
    context.mock.timers.tick(1000); await flush()
    assert.equal(requests.length, 2); assert.equal(requests[1].through, target)
    assert.equal(requests[1].from, target - 95 * interval)
    const repaired = pipeline.historyFrame(pipeline.state(instId, '15m'), target)
    assert.equal(repaired.priceState, 'ready')
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

test('subscription changes immediately republish quote status from cached projections without source or calculation work', async () => {
  const { pipeline, store } = fixture(), other = 'ETH-USDT-SWAP'
  let connected = false
  pipeline.streaming = () => connected
  const encoder = new ChartNotificationEncoder(), notifications: any[] = []
  pipeline.subscribe((frame: any) => notifications.push(encoder.encode(frame)))
  try {
    pipeline.setUniverse([instId, other], '15m', instId)
    await pipeline.local(instId, '15m')
    await finishSeed(pipeline)
    const live = { ...candle(end() + interval), confirmed: false }
    await pipeline.setLive(instId, '15m', live)
    await pipeline.local(other, '15m')
    await pipeline.setLive(other, '15m', { ...live, instrument: other })
    pipeline.series.delete(`${other}:15m`) // Previously opened compact cache outlives its history LRU.
    const focused = pipeline.cached(`${instId}:15m`), cached = pipeline.cached(`${other}:15m`)
    assert.equal(focused.realtimeState, 'stale')
    assert.equal(cached.realtimeState, 'stale')
    const reads = store.queries.length, calculations = pipeline.nextCalculation, entries = pipeline.series.size
    const operations: OperationEvent[] = [], unsubscribe = attachOperationSink(operation => operations.push(operation))
    try {
      notifications.length = 0
      connected = true; pipeline.sourceStateChanged()
      assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'live')
      assert.equal(pipeline.cached(`${other}:15m`).realtimeState, 'live')
      assert.equal(notifications.length, 2)
      assert.equal(notifications.find(frame => frame.instId === instId)?.type, 'live', 'Known completed bars retain compact metadata publication.')
      connected = false; pipeline.sourceStateChanged()
      assert.equal(pipeline.cached(`${instId}:15m`).realtimeState, 'stale', 'Disconnect revokes the quote lease immediately.')
      assert.equal(pipeline.cached(`${other}:15m`).realtimeState, 'stale')
      assert.equal(notifications.length, 4)
      pipeline.sourceStateChanged()
      assert.equal(notifications.length, 4, 'Unchanged source status needs no repeated publication.')
      for (const [key, previous] of [[`${instId}:15m`, focused], [`${other}:15m`, cached]] as const) {
        assert.equal(pipeline.cached(key).bars, previous.bars)
        assert.equal(pipeline.cached(key).liveBar, previous.liveBar)
        assert.equal(pipeline.cached(key).generation, previous.generation)
        assert.ok(pipeline.cached(key).revision > previous.revision)
      }
      assert.equal(store.queries.length, reads)
      assert.equal(pipeline.nextCalculation, calculations)
      assert.equal(pipeline.series.size, entries, 'A cached-only quote must not restore a chart series.')
      assert.deepEqual(operations, [], 'Source status updates reuse the existing calculations and projections.')
    } finally { unsubscribe() }
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

test('full-universe forming intake retains raw prices without publishing charts that were never requested', async () => {
  const { pipeline, store } = fixture([]), frames: any[] = [], operations: OperationEvent[] = []
  const ids = Array.from({ length: 287 }, (_, index) => `CANDIDATE${index}-USDT-SWAP`)
  const timeframes = [['5m', 300000], ['15m', 900000], ['1H', 3600000]] as const
  pipeline.setRealtimeSubscriptions(ids.flatMap(instId => timeframes.map(([timeframe]) => ({ instId, timeframe }))))
  pipeline.setUniverse(ids, '15m')
  pipeline.subscribe((frame: any) => frames.push(frame))
  const unsubscribe = attachOperationSink(operation => operations.push(operation))
  const tick = async (sequence: number) => {
    for (const [index, instrument] of ids.entries()) for (const [timeframe, step] of timeframes) {
      await pipeline.setLive(instrument, timeframe, { ...candle(Math.floor(Date.now() / step) * step), instrument, timeframe,
        close: 100 + sequence + index / 1000, volume: 100 + sequence, confirmed: false })
    }
  }
  try {
    for (let sequence = 1; sequence <= 60; sequence++) await tick(sequence)
    assert.equal(pipeline.liveStates.size, 861)
    assert.equal(pipeline.snapshots.size, 0)
    assert.equal(pipeline.series.size, 0)
    assert.equal(pipeline.nextCalculation, 0)
    assert.equal(store.queries.length, 0)
    assert.equal(frames.length, 0, 'Collector membership alone cannot produce 51,660 unused chart notifications.')
    assert.equal(operations.filter(operation => operation.name === 'chart.frame').length, 0)
    const selected = ids[178], opened = await pipeline.local(selected, '1H')
    assert.equal(opened.liveBar.close, 160.178, 'Opening a cold chart reads the latest retained native price immediately.')
    assert.equal(opened.realtimeState, 'live')
    frames.length = 0; operations.length = 0
    await tick(61)
    assert.equal(frames.length, 1, 'Only the explicitly materialized chart receives the next full-market revision.')
    assert.equal(frames[0].instId, selected)
    assert.equal(frames[0].timeframe, '1H')
    assert.equal(frames[0].liveBar.close, 161.178)
    assert.equal(operations.filter(operation => operation.name === 'chart.frame').length, 1)
    pipeline.maxSeries = 1
    await pipeline.local(ids[179], '5m')
    assert.equal(pipeline.series.has(`${selected}:1H`), false)
    const reads = store.queries.length
    frames.length = 0
    await tick(62)
    assert.equal(frames.length, 2, 'A previously materialized compact cache stays current after history LRU eviction.')
    assert.equal(frames.find(frame => frame.instId === selected).liveBar.close, 162.178)
    assert.equal(store.queries.length, reads, 'Maintaining compact cached prices cannot restore their evicted history.')
    assert.equal(pipeline.realtimeKeys.size, 861, 'Publication demand cannot remove background market collection.')
  } finally { unsubscribe(); await pipeline.dispose() }
})

test('list-indicator reuse cannot materialize chart snapshots or notifications before a chart is opened', async () => {
  const { pipeline } = fixture(), frames: any[] = []
  pipeline.setUniverse([instId], '15m')
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    const projected = await pipeline.projectListSeries(instId, '15m')
    assert.ok(projected.bars.length > 0)
    assert.ok(pipeline.series.has(`${instId}:15m`))
    assert.equal(pipeline.snapshots.size, 0, 'Indicator residency is reusable source data, not an implicit chart subscription.')
    assert.equal(frames.length, 0)
    const calculations = pipeline.nextCalculation
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false, close: 250 })
    assert.equal(frames.length, 0)
    const opened = await pipeline.local(instId, '15m')
    assert.equal(opened.liveBar.close, 250)
    assert.equal(opened.indicatorState, 'ready')
    assert.equal(pipeline.nextCalculation, calculations, 'Opening reuses the existing exact recursive calculation.')
    assert.equal(frames.length, 1)
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
  const operations: OperationEvent[] = []
  const detach = attachOperationSink(operation => operations.push(operation))
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    assert.ok(operations.some(operation => operation.name === 'chart.project'), 'Cold chart work is observable through the shared operation recorder.')
    operations.length = 0
    const reads = store.queries.length, calculations = pipeline.nextCalculation, writes = store.checkpoints.length
    const completed = pipeline.cached(`${instId}:15m`).bars
    let last: any
    for (let index = 0; index < 40; index += 1) {
      last = { ...candle(end() + interval, 400), high: 150, close: 141 + index / 100, confirmed: false, volume: 100 + index }
      const frame = await pipeline.setLive(instId, '15m', last)
      assert.equal(frame.bars, completed, 'Live-only deltas reuse immutable confirmed bars.')
    }
    assert.deepEqual(operations.filter(operation => ['chart.project', 'indicators.build', 'indicators.observe'].includes(operation.name)), [],
      'Warm ticks must reuse confirmed projections and canonical indicator state without expensive recomputation.')
    detach()
    const frame = pipeline.cached(`${instId}:15m`), oracle = buildIndicatorSeries([...rows, last], interval).bars.at(-1) as any
    assert.equal(frame.liveBar.close, last.close)
    for (const key of indicatorFields) assert.equal(frame.liveBar[key], oracle[key])
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations); assert.equal(store.checkpoints.length, writes)
  } finally { detach(); await pipeline.dispose() }
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
  // Exercise source deadlines without also crossing a native candle boundary.
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
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
  // Exercise source deadlines without also crossing a native candle boundary.
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
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

test('an ATR upgrade ignores v4 checkpoints without ATR state even when they carry the current durable watermark', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  const legacyVersion = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-v4'
  const poisoned = structuredClone(buildIndicatorSeries(rows.slice(0, 3072), interval).state)
  assert.notEqual(poisoned.ema, null)
  poisoned.ema = poisoned.ema! + 10_000
  poisoned.rsi[0].gains += 1000
  delete (poisoned as any).atr
  delete (poisoned as any).atrCount
  delete (poisoned as any).atrSeedSum
  await store.writeIndicatorCheckpoint({ instrument: instId, timeframe: '15m', timestamp: poisoned.lastTimestamp,
    formulaVersion: legacyVersion, state: poisoned, sourceRevision: await store.priceWatermark() })
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of pipeline.cached(`${instId}:15m`).bars) for (const field of indicatorFields) {
      assert.equal(value[field], (oracle.get(value.hour) as any)[field], `The upgraded producer must reconstruct ${field} from canonical candles.`)
    }
    assert.equal(store.queries.find(query => query.order === 'asc').from, 0, 'An unsafe producer checkpoint cannot establish the canonical prefix.')
    assert.ok(store.checkpoints.some(value => value.formulaVersion.endsWith('-v5')))
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
      formulaVersion: 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-wilder-atr14-percent-bbw20-2-v5' })
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

test('cold adjacent acquisition retains its full 1280-before and 256-ahead reserve and reuses the active admission', async context => {
  const rows = source(8192), target = rows.at(-1)!.timestamp - 905 * interval
  let f: ReturnType<typeof fixture>
  f = fixture(rows.slice(-1000), {
    async ensurePrices(_id: string, _timeframe: string, from: number, through: number) {
      const page = rows.filter(row => row.timestamp >= from && row.timestamp <= through), prior = new Map()
      for (const row of page) for (const [hour, value] of f.store.change(row)) prior.set(hour, value)
      f.pipeline.observe(page, prior)
    },
  })
  const { pipeline, store } = f
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    await pipeline.prepare(instId, '15m', target, 1280); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), keys = [...state.rows.keys()].sort((a: number, b: number) => a - b)
    const first = target - 1279 * interval, last = target + 256 * interval, admitted = state.historyRange
    const reads = store.queries.length
    await pipeline.localHistory(instId, '15m', target - interval); await finishSeed(pipeline)
    context.diagnostic(JSON.stringify({ retainedFirst: keys[0], expectedFirst: first, retainedLast: keys.at(-1), expectedLast: last,
      retained: keys.length, admitted, revisitReads: store.queries.length - reads }))
    assert.equal(keys[0], first, 'Older acquired reserve pages must remain resident instead of competing with excess newer rows.')
    assert.equal(keys.at(-1), last)
    assert.equal(keys.length, 1536)
    assert.ok(admitted.from <= first && admitted.through >= last, 'A subpage read cannot replace the active reserve admission.')
    assert.equal(store.queries.length, reads, 'A neighboring resident viewport must reuse the acquired canonical reserve.')
    assert.ok(pipeline.liveStates.get(state.key).rows.size <= 128)
  } finally { await pipeline.dispose() }
})

test('a latest-boundary history admission is reusable when its end is implicit', async () => {
  const rows = source(8192), { pipeline, store } = fixture(rows)
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    await pipeline.localHistory(instId, '15m', undefined); await finishSeed(pipeline)
    const reads = store.queries.length
    await pipeline.localHistory(instId, '15m', rows.at(-2)!.timestamp); await finishSeed(pipeline)
    assert.equal(store.queries.length, reads, 'An implicit latest end must retain the same canonical admission proof as an explicit end.')
  } finally { await pipeline.dispose() }
})

test('returning to latest while one reserve page is held retires the obsolete older-page loop', async () => {
  const rows = source(8192), target = rows.at(-1)!.timestamp - 905 * interval, hold = deferred(), reached = deferred(), calls: number[] = []
  let f: ReturnType<typeof fixture>, preparation: Promise<unknown> | undefined
  f = fixture(rows.slice(-1000), {
    async ensurePrices(_id: string, _timeframe: string, from: number, through: number) {
      calls.push(through)
      if (through === target - 300 * interval) { reached.resolve(); await hold.promise }
      const page = rows.filter(row => row.timestamp >= from && row.timestamp <= through), prior = new Map()
      for (const row of page) for (const [hour, value] of f.store.change(row)) prior.set(hour, value)
      f.pipeline.observe(page, prior)
    },
  })
  const { pipeline } = f
  try {
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    preparation = pipeline.prepare(instId, '15m', target, 1280)
    await reached.promise
    await pipeline.local(instId, '15m')
    hold.resolve(); await preparation; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(state.historyEnd, null)
    assert.deepEqual(calls, [target, target - 300 * interval], 'The accepted page may finish, but a retired viewport cannot acquire further older reserve pages.')
    assert.equal(pipeline.cached(state.key).endHour, rows.at(-1)!.timestamp)
    assert.equal(state.active, 0)
  } finally { hold.resolve(); await preparation; await pipeline.dispose() }
})

test('a superseded local probe retains its admitted facts without reviving source demand or focus', async () => {
  const other = 'ETH-USDT-SWAP', rows = source(400)
  const { pipeline, store } = fixture([...rows.slice(0, -12), ...rows.map(row => ({ ...row, instrument: other }))])
  const hold = deferred(), reached = deferred(), requests: string[] = []
  const candles = store.candles.bind(store)
  let held = false
  store.candles = async (query: any) => {
    const result = await candles(query)
    if (!held && query.instrument === instId && query.order === 'desc') { held = true; reached.resolve(); await hold.promise }
    return result
  }
  pipeline.history.ensurePrices = async (id: string) => { requests.push(id) }
  let stale: Promise<unknown> | undefined
  try {
    stale = pipeline.prepare(instId, '15m')
    await reached.promise
    await pipeline.local(other, '15m')
    hold.resolve(); await stale
    assert.equal(pipeline.focusKey, `${other}:15m`)
    assert.deepEqual(requests, [], 'Finishing an obsolete local read cannot start a new source consumer.')
    assert.ok(pipeline.series.get(`${instId}:15m`).rows.size > 0, 'Already admitted local observations remain reusable.')
    assert.equal(pipeline.sourceAttempts.size, 0)
  } finally { hold.resolve(); await stale; await pipeline.dispose() }
})

test('returning to the same target cannot resurrect an earlier local probe ownership', async () => {
  const { pipeline, store } = fixture(source(400).slice(0, -12)), hold = deferred(), reached = deferred()
  const candles = store.candles.bind(store)
  let held = false, calls = 0, stale: Promise<unknown> | undefined
  store.candles = async (query: any) => {
    const result = await candles(query)
    if (!held && query.order === 'desc') { held = true; reached.resolve(); await hold.promise }
    return result
  }
  pipeline.history.ensurePrices = async () => { calls += 1 }
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'first')
    stale = pipeline.prepare(instId, '15m', undefined, 96, { focusId: 'first' })
    await reached.promise
    pipeline.setFocus(null, 'hidden')
    pipeline.setFocus({ instId, timeframe: '15m' }, 'second')
    hold.resolve(); await stale
    assert.equal(calls, 0)
    assert.equal(pipeline.focus.id, 'second')
  } finally { hold.resolve(); await stale; await pipeline.dispose() }
})

test('a nearby cursor adopts overlapping viewport sources and a disjoint jump releases them without backoff', async () => {
  const rows = source(2000), { pipeline } = fixture(rows.slice(-128)), signals: AbortSignal[] = [], reached = deferred()
  pipeline.history.ensurePrices = async (_id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) => {
    signals.push(signal); reached.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const target = rows[500].timestamp
  let preparation: Promise<unknown> | undefined
  try {
    preparation = pipeline.prepare(instId, '15m', target)
    await reached.promise
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target - interval })
    assert.equal(signals[0].aborted, false, 'A shared page is still useful to the neighboring viewport.')
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[1500].timestamp })
    assert.equal(signals[0].aborted, true)
    await preparation
    assert.equal(pipeline.sourceAttempts.size, 0, 'Navigation cancellation is not a source failure.')
    assert.equal(pipeline.sourceTasks.size, 0)
  } finally { pipeline.setFocus(null); await preparation; await pipeline.dispose() }
})

test('an aborted source finalizer cannot remove a replacement consumer for the same target', async () => {
  const { pipeline } = fixture([]), signals: AbortSignal[] = []
  pipeline.history.ensurePrices = async (_id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) => {
    signals.push(signal)
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await pipeline.local(instId, '15m'); await flush()
    pipeline.setFocus(null)
    await pipeline.local(instId, '15m'); await flush()
    assert.equal(signals.length, 2)
    assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false)
    const state = pipeline.series.get(`${instId}:15m`), active = pipeline.refreshObservations(state)
    assert.equal(pipeline.sourceTasks.size, 1)
    await flush()
    assert.equal(pipeline.tasks.size, 1)
    assert.equal(pipeline.refreshObservations(state), active, 'The replacement remains the deduplication owner after the old finalizer runs.')
    assert.equal(pipeline.sourceAttempts.size, 0)
  } finally { pipeline.setFocus(null); await pipeline.dispose() }
})

test('an admitted prefetch reserve preserves selected focus and can transfer its useful source to a new cursor', async () => {
  const rows = source(2000), { pipeline } = fixture(rows.slice(-128)), started = deferred(), signals: AbortSignal[] = []
  const selected = rows[1800].timestamp, prefetch = rows[1000].timestamp
  pipeline.history.ensurePrices = async (_id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) => {
    signals.push(signal); started.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  let preparation: Promise<unknown> | undefined
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: selected }, 'selected')
    preparation = pipeline.prepare(instId, '15m', prefetch, 768, { focusId: 'selected' })
    await started.promise
    assert.equal(pipeline.focus.end, selected, 'The reserve cursor is independent of the selected viewport.')
    pipeline.setFocus({ instId, timeframe: '15m', endHour: prefetch - 600 * interval }, 'inside-reserve')
    assert.equal(signals[0].aborted, false, 'An already admitted reserve source remains useful inside its requested runway.')
    pipeline.setFocus({ instId, timeframe: '15m' }, 'latest')
    assert.equal(signals[0].aborted, true)
    await preparation
    assert.equal(signals.length, 1, 'Retiring a reserve stops the rest of its page loop.')
    assert.equal(pipeline.sourceAttempts.size, 0)
  } finally { pipeline.setFocus(null); await preparation; await pipeline.dispose() }
})

test('a disjoint prefetch reserve retains the selected viewport and cannot trigger repeated source maintenance', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
  const rows = source(2500), { pipeline, store } = fixture(rows), selected = rows.at(-1)!.timestamp, target = rows[900].timestamp
  let sourceCalls = 0
  pipeline.history.ensurePrices = async () => { sourceCalls += 1 }
  pipeline.history.ensureStatistics = async () => { sourceCalls += 1 }
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'visible')
    await pipeline.local(instId, '15m', { focusId: 'visible' }); await finishSeed(pipeline)
    await pipeline.prepare(instId, '15m', target, 768, { focusId: 'visible' }); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(pipeline.focus.end, undefined)
    assert.equal(state.historyEnd, target)
    for (let hour = selected - 95 * interval; hour <= selected; hour += interval) assert.ok(state.rows.has(hour))
    assert.equal(pipeline.frame(state, selected).bars.length, 96)
    const reads = store.queries.length
    pipeline.scheduleRefresh()
    context.mock.timers.tick(5000); await flush()
    assert.equal(sourceCalls, 0, 'Resident reserve eviction must not manufacture a source outage for the selected viewport.')
    assert.equal(store.queries.length, reads)
    assert.ok(state.rows.size <= 1536 + 96, 'One bounded selected viewport accompanies the bounded acquisition reserve.')
  } finally { await pipeline.dispose() }
})
