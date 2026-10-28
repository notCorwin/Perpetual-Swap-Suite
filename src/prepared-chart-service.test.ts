import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { ChartController } from './chart-controller.ts'
import { ChartNotificationEncoder } from '../electron/services/chart-notifications.js'
import { MarketStore } from '../electron/services/market-store.js'
import { buildIndicatorSeries } from '../electron/services/indicators.js'
import { attachOperationSink, type OperationEvent } from '../electron/services/operations.js'
import { stopOperationWorker } from '../electron/services/operation-worker.js'

const interval = 900_000, instId = 'BTC-USDT-SWAP'
const end = () => Math.floor(Date.now() / interval) * interval - interval
const candle = (timestamp: number, index = 0) => ({ instrument: instId, timeframe: '15m', timestamp,
  open: 100 + index / 10, high: 102 + index / 10, low: 98 + index / 10, close: 101 + index / 10,
  volume: 100, baseVolume: 100, quoteVolume: 10_000, oi: 5_000, buy: 70, sell: 30, statisticsVersion: 11, confirmed: true })
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
// Commands declare backend demand; the subsequent reads never create it.
const focusLatest = async (pipeline: any, id: string, timeframe: string) => {
  pipeline.setFocus({ instId: id, timeframe })
  const frame = await pipeline.local(id, timeframe)
  await Promise.resolve()
  return frame
}
const focusHistory = async (pipeline: any, id: string, timeframe: string, endHour?: number) => {
  pipeline.setFocus({ instId: id, timeframe, endHour })
  const frame = await pipeline.localHistory(id, timeframe, endHour)
  await Promise.resolve()
  return frame
}
const finishSeed = async (pipeline: any) => { while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()]) }
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
const sqliteFixture = async (rows: any[]) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prefix-fence-')), store = await MarketStore.open(root)
  await store.appendCandles(rows)
  const pipeline: any = new PreparedChartPipeline({ store, history: {} as any, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined })
  return { store, pipeline, async close() { await pipeline.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('local and historical reads expose durable facts without creating backend demand', async () => {
  const rows = source(2000), calls: string[] = []
  const { pipeline, store } = fixture(rows, {
    async ensurePrices() { calls.push('prices') },
    async ensureStatistics() { calls.push('statistics') },
  })
  try {
    const latest = await pipeline.local(instId, '15m')
    const historical = await pipeline.localHistory(instId, '15m', rows[1000].timestamp)
    const missing = await pipeline.local('MISSING-USDT-SWAP', '15m')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(latest.bars.length, 96); assert.equal(latest.bars.at(-1).close, rows.at(-1)!.close)
    assert.ok(historical.bars.some((bar: any) => bar.hour === rows[1000].timestamp)); assert.equal(missing, null)
    assert.ok(store.queries.length > 0, 'Pure reads may hydrate existing SQLite facts.')
    assert.equal(pipeline.focus, null); assert.equal(pipeline.focusKey, null); assert.equal(pipeline.universe.size, 0)
    assert.equal(pipeline.state(instId, '15m').historyEnd, null, 'A historical read cannot select its cursor.')
    assert.equal(pipeline.nextCalculation, 0); assert.equal(pipeline.liveSeeds.size, 0); assert.equal(store.checkpoints.length, 0)
    assert.equal(pipeline.sourceTasks.size, 0); assert.equal(pipeline.sourceAttempts.size, 0); assert.deepEqual(calls, [])
  } finally { await pipeline.dispose() }
})

test('resident hydration is read-only and focus alone starts exact backend preparation', async () => {
  const rows = source(400), { pipeline, store } = fixture(rows)
  try {
    for (let read = 0; read < 3; read++) assert.deepEqual(pipeline.residentFrames(), { frames: [] })
    assert.equal(store.queries.length, 0); assert.equal(pipeline.series.size, 0); assert.equal(pipeline.nextCalculation, 0)
    assert.equal(pipeline.focus, null); assert.equal(pipeline.universe.size, 0)
    pipeline.setFocus({ instId, timeframe: '15m' }, 'explicit')
    const focus = pipeline.focus
    assert.ok(focus.task instanceof Promise)
    await focus.task; await finishSeed(pipeline)
    const frame = pipeline.cached(`${instId}:15m`), oracle = buildIndicatorSeries(rows, interval).bars.at(-1) as any
    assert.equal(frame.indicatorState, 'ready')
    for (const field of indicatorFields) assert.equal(frame.bars.at(-1)[field], oracle[field])
    const reads = store.queries.length, calculations = pipeline.nextCalculation, checkpoints = store.checkpoints.length
    for (let read = 0; read < 3; read++) {
      pipeline.residentFrames()
      await pipeline.local(instId, '15m')
    }
    assert.equal(pipeline.focus, focus); assert.equal(pipeline.focus.task, focus.task)
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations); assert.equal(store.checkpoints.length, checkpoints)
  } finally { await pipeline.dispose() }
})

test('historical focus alone repairs durable prices, statistics and exact indicators without renderer reads', async () => {
  const canonical = source(2500), target = canonical[1800].timestamp, absent = canonical[1780], statistic = canonical[1770]
  const calls: string[] = []
  const rows = canonical.filter(row => row.timestamp !== absent.timestamp)
    .map(row => row.timestamp === statistic.timestamp ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const { pipeline, store } = fixture(rows as any, {
    async ensurePrices(_id: string, _frame: string, from: number, through: number) {
      calls.push('price')
      if (from <= absent.timestamp && through >= absent.timestamp) store.change(absent)
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
    async ensureStatistics(_id: string, _frame: string, from: number, through: number, _priority: string, _signal: AbortSignal, source: string) {
      calls.push(source)
      store.rows = store.rows.map(row => row.timestamp < from || row.timestamp > through ? row
        : source === 'oi' ? { ...row, oi: 5000, statisticsVersion: row.buy === null ? 9 : 11 }
          : { ...row, buy: 70, sell: 30, statisticsVersion: row.oi === null ? 10 : 11 })
      return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'history-demand')
    await pipeline.focus.task
    while (pipeline.sourceTasks.size) await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task))
    await finishSeed(pipeline)
    const frame = pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target)
    const viewport = frame.bars.filter((bar: any) => bar.hour >= target - 95 * interval && bar.hour <= target)
    assert.equal(viewport.length, 96)
    assert.ok(viewport.every((bar: any) => bar.priceComplete && bar.oiObserved && bar.takerObserved && bar.indicatorsObserved))
    assert.ok(store.rows.some(row => row.timestamp === absent.timestamp), 'Focus repair commits the absent price into durable source data.')
    assert.deepEqual([...new Set(calls)].toSorted(), ['oi', 'price', 'taker'])
    const oracle = new Map(buildIndicatorSeries(canonical, interval).bars.map((bar: any) => [bar.hour, bar]))
    for (const bar of viewport) for (const field of indicatorFields) assert.equal(bar[field], (oracle.get(bar.hour) as any)[field])
  } finally { await pipeline.dispose() }
})

test('prepared historical focus reuses its rolling reserve without rereading, recalculating, or republishing', async () => {
  const rows = source(2200), target = rows[1700].timestamp
  let priceRepairs = 0
  const { pipeline, store } = fixture(rows, { async ensurePrices(_id: string, _timeframe: string, from: number, through: number) {
    priceRepairs += 1
    return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
  } })
  const operations: OperationEvent[] = [], frames: any[] = [], detach = attachOperationSink(operation => operations.push(operation))
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'scroll-0')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), original = pipeline.historyFrame(state, target)
    const reads = store.queries.length, calculations = pipeline.nextCalculation
    assert.ok(Object.isFrozen(state.rows.get(target)), 'Projected candle inputs are immutable snapshots.')
    assert.ok(Object.isFrozen(state.indicators.get(target)), 'Projected indicator inputs are immutable snapshots.')
    assert.equal(pipeline.preparedHistoryReserve(state, target, 96 + 256), true)
    operations.length = 0; frames.length = 0

    pipeline.setFocus({ instId, timeframe: '15m', endHour: target - interval }, 'scroll-1')
    const moved = await pipeline.focus.task

    assert.equal(moved, null, 'The focus command has no frame consumer on this path.')
    assert.equal(state.historyEnd, target - interval)
    assert.strictEqual(state.historyBarsCache.bars, original.bars, 'The whole resident projection remains shared across cursor changes.')
    assert.equal(store.queries.length, reads, 'A covered viewport plus safety margin needs no SQLite read.')
    assert.equal(pipeline.nextCalculation, calculations, 'A complete resident indicator basis needs no replay.')
    assert.deepEqual(operations.filter(operation => operation.name === 'chart.project'), [], 'Cached rows require no projection work.')
    assert.deepEqual(frames, [], 'A cursor-only move does not republish chart data.')

    pipeline.setFocus({ instId, timeframe: '15m', endHour: target - 1057 * interval }, 'scroll-edge')
    await pipeline.focus.task
    assert.ok(priceRepairs > 0, 'Moving past the safe resident edge starts the normal larger-reserve acquisition.')
  } finally { detach(); await pipeline.dispose() }
})

test('same-series cursor changes share canonical replay through the indicator reserve and series changes retire it', async () => {
  const rows = source(1800), eth = rows.map(row => ({ ...row, instrument: 'ETH-USDT-SWAP' })), target = rows[1600].timestamp
  const { pipeline } = fixture([...rows, ...eth]), gate = deferred(), entered = deferred()
  const calculate = pipeline.calculate.bind(pipeline), calculated: { instrument: string; first: number; last: number }[] = []
  pipeline.calculate = async (candles: any[], ...args: any[]) => {
    calculated.push({ instrument: candles[0]?.instrument, first: candles[0]?.timestamp, last: candles.at(-1)?.timestamp })
    if (calculated.length === 1) { entered.resolve(); await gate.promise }
    return calculate(candles, ...args)
  }
  let firstFocus: Promise<unknown> | undefined, nextFocus: Promise<unknown> | undefined, replay: Promise<unknown> | undefined
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'scroll-before')
    firstFocus = pipeline.focus.task
    await entered.promise
    replay = pipeline.liveSeeds.get(`${instId}:15m`)
    assert.ok(replay, 'The first viewport has one canonical replay in flight.')

    pipeline.setFocus({ instId, timeframe: '15m', endHour: target - interval }, 'scroll-during')
    nextFocus = pipeline.focus.task
    assert.strictEqual(pipeline.liveSeeds.get(`${instId}:15m`), replay, 'A cursor update retains the running replay task.')
    assert.strictEqual(pipeline.series.get(`${instId}:15m`).calculation, replay)
    gate.resolve()
    await Promise.all([firstFocus, nextFocus, replay])
    await finishSeed(pipeline)

    const state = pipeline.series.get(`${instId}:15m`), reserveFirst = target - interval - (96 + 256 - 1) * interval
    const btcChunks = calculated.filter(value => value.instrument === instId)
    assert.equal(btcChunks.filter(value => value.first === rows[0].timestamp).length, 1,
      'The initial recursive prefix is not replayed again after the cursor changes.')
    for (let hour = reserveFirst; hour <= target - interval; hour += interval) {
      assert.ok(state.indicators.has(hour), `The prepared navigation margin has an observed indicator at ${hour}.`)
    }
    assert.equal(pipeline.preparedHistoryReserve(state, target - interval, 96 + 256), true)
  } finally {
    gate.resolve()
    await Promise.allSettled([firstFocus, nextFocus, replay].filter(Boolean) as Promise<unknown>[])
    await pipeline.dispose()
  }

  const cancelled = fixture([...rows, ...eth]), cancelGate = deferred(), cancelEntered = deferred()
  const cancelCalculate = cancelled.pipeline.calculate.bind(cancelled.pipeline), cancelInputs: string[] = []
  cancelled.pipeline.calculate = async (candles: any[], ...args: any[]) => {
    cancelInputs.push(candles[0]?.instrument)
    if (cancelInputs.length === 1) { cancelEntered.resolve(); await cancelGate.promise }
    return cancelCalculate(candles, ...args)
  }
  let obsoleteFocus: Promise<unknown> | undefined, selectedFocus: Promise<unknown> | undefined, obsoleteReplay: Promise<unknown> | undefined
  try {
    cancelled.pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'old-series')
    obsoleteFocus = cancelled.pipeline.focus.task
    await cancelEntered.promise
    obsoleteReplay = cancelled.pipeline.liveSeeds.get(`${instId}:15m`)
    cancelled.pipeline.setFocus({ instId: 'ETH-USDT-SWAP', timeframe: '15m', endHour: target }, 'new-series')
    selectedFocus = cancelled.pipeline.focus.task
    cancelGate.resolve()
    await Promise.all([obsoleteFocus, selectedFocus, obsoleteReplay])
    await finishSeed(cancelled.pipeline)
    assert.equal(cancelInputs.filter(id => id === instId).length, 1, 'Changing series prevents the obsolete replay from admitting another chunk.')
    assert.equal(cancelled.pipeline.cached('ETH-USDT-SWAP:15m').indicatorState, 'ready')
  } finally {
    cancelGate.resolve()
    await Promise.allSettled([obsoleteFocus, selectedFocus, obsoleteReplay].filter(Boolean) as Promise<unknown>[])
    await cancelled.pipeline.dispose()
  }
})

test('fresh OHLC and forming price publish while both statistic requests are held', async () => {
  const hold = deferred(), rows = source(400).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  let statistics = 0
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { statistics += 1; await hold.promise } })
  try {
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval, 400), confirmed: false, close: 142, high: 143 }, { receivedAt: Date.now() })
    const frame = await pipeline.prepare(instId, '15m')
    assert.equal(frame.endHour, end()); assert.equal(frame.liveBar.close, 142)
    assert.equal(frame.realtimeState, 'live'); assert.equal(frame.oiState, 'loading'); assert.equal(frame.takerState, 'loading')
    assert.equal(statistics, 2)
    await finishSeed(pipeline)
    assert.equal(pipeline.cached(`${instId}:15m`).liveBar.close, 142)
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'ready')
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('resident history advertises its listing floor before the viewport reaches it and publishes boundary-only changes', async () => {
  const rows = source(600), floor = rows[0].timestamp, target = rows[400].timestamp
  const { pipeline } = fixture(rows)
  pipeline.instrument = () => ({ listTime: String(floor) })
  const frames: any[] = []
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'listing-floor')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), history = pipeline.historyFrame(state, target)
    assert.equal(pipeline.frame(state, target, true).historyExhausted, false, 'The visible window is still above the listing floor.')
    assert.equal(history.bars[0].hour, floor)
    assert.equal(history.historyExhausted, true, 'The delivered reserve already proves the listing boundary.')
    state.publishedHistoryFrame = { ...history, historyExhausted: false }
    frames.length = 0
    pipeline.publish(state)
    const update = frames.find(frame => frame.endHour === target)
    assert.ok(update, 'A changed boundary cannot be swallowed by identical bar content.')
    assert.equal(update.historyExhausted, true)
    assert.equal(update.bars.length, 96, 'Boundary metadata does not require another full reserve transfer.')
    assert.equal(pipeline.preparedHistoryReserve(state, floor - interval, 352), false)
  } finally { await pipeline.dispose() }
})

test('a listing with fewer than 96 candles publishes all available prices', async () => {
  const { pipeline } = fixture(source(12))
  try {
    const frame = await focusLatest(pipeline, instId, '15m')
    assert.equal(frame.bars.length, 12); assert.equal(frame.endHour, end())
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
    const frame = await focusLatest(pipeline, instId, '15m')
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
    await focusLatest(pipeline, instId, '15m')
    assert.equal(priceCalls, 1, 'Opening a complete persisted window must reuse its coverage.')
  } finally { gate.resolve(); await pipeline.dispose() }
})

for (const lag of [1, 12, 160]) test(`latest statistics cover the displayed left edge while confirmed prices lag ${lag} periods`, async () => {
  const canonical = source(600).slice(0, -lag), first = canonical.at(-1)!.timestamp - 95 * interval, gate = deferred()
  const rows = canonical.map(row => row.timestamp === first ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const calls: Array<{ source: string; from: number; through: number }> = []
  const { pipeline, store } = fixture(rows as any, {
    async ensurePrices() { await gate.promise },
    async ensureStatistics(_id: string, _frame: string, from: number, through: number, _priority: string, _signal: AbortSignal, source: string) {
      calls.push({ source, from, through })
      store.rows = store.rows.map(row => row.timestamp !== first || first < from || first > through ? row
        : source === 'oi' ? { ...row, oi: 5000, statisticsVersion: row.buy === null ? 9 : 11 }
          : { ...row, buy: 70, sell: 30, statisticsVersion: row.oi === null ? 10 : 11 })
      return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  try {
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false }, { receivedAt: Date.now() })
    await focusLatest(pipeline, instId, '15m')
    for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve))
    const frame = pipeline.cached(`${instId}:15m`)
    assert.equal(frame.bars[0].hour, first)
    assert.equal(frame.oiState, 'ready', 'Price catch-up cannot exclude an already displayed statistic slot.')
    assert.equal(frame.takerState, 'ready')
    assert.deepEqual(calls.filter(call => call.from <= first && call.through >= first).map(call => call.source).toSorted(), ['oi', 'taker'])
    const requested = calls.filter(call => call.from <= first && call.through >= first).length
    pipeline.refreshObservations(pipeline.series.get(`${instId}:15m`))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(calls.filter(call => call.from <= first && call.through >= first).length, requested, 'Successful left-edge observations remain reusable while prices are delayed.')
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
    const frame = await focusLatest(pipeline, instId, '15m')
    assert.equal(frame.priceState, 'partial'); assert.equal(frame.bars.length, 95)
    const state = pipeline.state(instId, '15m'), key = `prices:${state.key}:${end() - 95 * interval}:${end()}`
    const first = pipeline.refreshObservations(state)
    gate.resolve(); await first
    assert.equal(pipeline.cached(state.key).bars.length, 96)
    assert.equal(pipeline.cached(state.key).priceState, 'error', 'A completed repair that still lacks candle inputs publishes its failure.')
    assert.match(pipeline.cached(state.key).error, /Price history is incomplete/)
    assert.equal(pipeline.cached(state.key).priceStatus.retryAt, undefined)
    assert.equal(pipeline.cached(state.key).bars.find((bar: any) => bar.hour === incomplete.timestamp).priceComplete, false)
    assert.equal(pipeline.sourceAttempts.get(key).retryAt, undefined)
    pipeline.sourceStateChanged()
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
    const frame = await focusLatest(pipeline, instId, '15m')
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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

test('a complete price viewport automatically acquires its missing EMA warmup and republishes exact curves', async () => {
  const canonical = source(400), gate = deferred(), requests: Array<{ from: number; through: number }> = []
  const { pipeline, store } = fixture(canonical.slice(-96), {
    async ensurePrices(_instrument: string, _timeframe: string, from: number, through: number) {
      requests.push({ from, through }); await gate.promise
      const rows = canonical.filter(row => row.timestamp >= from && row.timestamp <= through)
      for (const row of rows) if (!store.rows.some(value => value.timestamp === row.timestamp)) store.change(row)
      return { rows }
    },
  })
  const controller = new ChartController({
    focus: (target, id) => pipeline.setFocus(target ? { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: target => pipeline.localHistory(target.instId, target.timeframe, target.end ?? undefined),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const encoder = new ChartNotificationEncoder()
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  await controller.setUniverse([instId], '15m', instId)
  const close = controller.open(instId, '15m')
  try {
    const frame = await pipeline.local(instId, '15m')
    assert.equal(frame.priceState, 'ready'); await pipeline.focus.task; await finishSeed(pipeline)
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'unavailable')
    assert.equal(controller.getSnapshot().presented?.indicatorState, 'unavailable')
    assert.equal(requests.length, 1, 'Calculated warmup nulls must trigger source demand without another user action.')
    assert.deepEqual(requests[0], { from: end() - 294 * interval, through: end() })
    pipeline.refreshObservations(pipeline.state(instId, '15m'))
    assert.equal(requests.length, 1, 'Repeated maintenance shares the pending warmup repair.')
    gate.resolve(); await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    const repaired = pipeline.cached(`${instId}:15m`)
    assert.equal(repaired.priceState, 'ready'); assert.equal(repaired.indicatorState, 'ready')
    assert.equal(controller.getSnapshot().presented?.indicatorState, 'ready', 'The pushed repair must replace the renderer cache without reopening the chart.')
    const oracle = new Map((buildIndicatorSeries(canonical.slice(-295), interval).bars as any[]).map(row => [row.hour, row]))
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], oracle.get(value.hour)[field], `${field} at ${value.hour}`)
    const calculations = pipeline.nextCalculation, reads = store.queries.length
    await pipeline.local(instId, '15m'); await finishSeed(pipeline)
    assert.equal(requests.length, 1); assert.equal(pipeline.nextCalculation, calculations); assert.equal(store.queries.length, reads)
  } finally { gate.resolve(); close(); unsubscribe(); await pipeline.dispose() }
})

test('an offscreen source hole repairs the selected historical indicators without reseeding from a truncated tail', async () => {
  const canonical = source(700), target = canonical[500].timestamp, absent = canonical[350]
  const requests: Array<{ from: number; through: number }> = []
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices(_instrument: string, _timeframe: string, from: number, through: number) {
      requests.push({ from, through }); store.change(absent)
      return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  pipeline.instrument = () => ({ listTime: canonical[0].timestamp })
  try {
    const frame = await focusHistory(pipeline, instId, '15m', target)
    assert.equal(frame.priceState, 'ready')
    await finishSeed(pipeline)
    await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    assert.equal(requests.length, 1); assert.ok(requests[0].from <= absent.timestamp); assert.equal(requests[0].through, target)
    const repaired = pipeline.historyFrame(pipeline.state(instId, '15m'), target)
    const oracle = new Map((buildIndicatorSeries(canonical, interval).bars as any[]).map(row => [row.hour, row]))
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], oracle.get(value.hour)[field], `${field} at ${value.hour}`)
    assert.equal(repaired.indicatorState, 'ready')
  } finally { await pipeline.dispose() }
})

test('warmup inputs committed before acquisition still replace cached null indicators without an observer', async () => {
  const canonical = source(295), { pipeline, store } = fixture(canonical.slice(-96))
  let requests = 0
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'unavailable')
    for (const row of canonical.slice(0, -96)) store.change(row)
    pipeline.history.ensurePrices = async () => { requests += 1; return { rows: store.rows } }
    await pipeline.refreshIndicators(pipeline.state(instId, '15m')); await finishSeed(pipeline)
    const repaired = pipeline.cached(`${instId}:15m`)
    assert.equal(repaired.indicatorState, 'ready')
    const oracle = new Map((buildIndicatorSeries(canonical, interval).bars as any[]).map(row => [row.hour, row]))
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], oracle.get(value.hour)[field])
    pipeline.refreshObservations(pipeline.state(instId, '15m'))
    assert.equal(requests, 1, 'Complete durable inputs must not leave a repeating successful acquisition loop.')
  } finally { await pipeline.dispose() }
})

test('a concurrent visible correction cannot suppress invalidation of a later offscreen warmup repair', async () => {
  const canonical = source(400), absent = canonical[240], gate = deferred()
  let requests = 0
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices() { requests += 1; await gate.promise; store.change(absent); return { rows: store.rows } },
  })
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    assert.equal(requests, 1)
    const state = pipeline.state(instId, '15m'), generation = state.generation
    const corrected = { ...canonical[390], close: canonical[390].close + 1 }
    const previous = store.change(corrected)
    pipeline.observe([corrected], previous); await finishSeed(pipeline)
    assert.ok(state.generation > generation)
    gate.resolve(); await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    const repaired = pipeline.cached(`${instId}:15m`)
    const oracle = new Map((buildIndicatorSeries(canonical.map(row => row.timestamp === corrected.timestamp ? corrected : row), interval).bars as any[]).map(row => [row.hour, row]))
    assert.equal(requests, 1); assert.equal(repaired.indicatorState, 'ready')
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], oracle.get(value.hour)[field])
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('indicator warmup acquisition retries after source recovery while complete prices remain visible', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
  const canonical = source(400), absent = canonical[240]
  let attempts = 0
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices() {
      if (++attempts === 1) { store.change(absent); throw new Error('Warmup committed before transport failure') }
      return { rows: store.rows }
    },
  })
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline); await flush()
    assert.equal(attempts, 1); assert.equal(pipeline.cached(`${instId}:15m`).priceState, 'ready')
    context.mock.timers.tick(60_000); await flush(); assert.equal(attempts, 1)
    pipeline.sourceStateChanged(); pipeline.refreshObservations(pipeline.state(instId, '15m')); await flush()
    await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    assert.equal(attempts, 2); assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'ready')
  } finally { await pipeline.dispose() }
})

test('missing offscreen VWAP volumes repair even when every visible EMA is already numeric', async () => {
  const canonical = source(400), incomplete = { ...canonical[300], baseVolume: null, quoteVolume: null }
  let requests = 0
  const { pipeline, store } = fixture(canonical.map(row => row.timestamp === incomplete.timestamp ? incomplete : row) as any, {
    async ensurePrices(_instrument: string, _timeframe: string, from: number, through: number) {
      requests += 1; assert.ok(from <= incomplete.timestamp); assert.ok(through >= incomplete.timestamp)
      store.change(canonical[300])
      return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    const repaired = pipeline.cached(`${instId}:15m`)
    assert.equal(requests, 1); assert.equal(repaired.indicatorState, 'ready')
    const oracle = new Map((buildIndicatorSeries(canonical, interval).bars as any[]).map(row => [row.hour, row]))
    for (const value of repaired.bars) assert.equal(value.vwap, oracle.get(value.hour).vwap)
  } finally { await pipeline.dispose() }
})

test('a wider indicator warmup demand respects the failed viewport source retry deadline', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000, retryAt = now + 60_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const canonical = source(400), absent = canonical[350], gate = deferred()
  let attempts = 0
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices() {
      if (++attempts === 1) throw Object.assign(new Error('Rate limited'), { retryAt })
      store.change(absent); return { rows: store.rows }
    },
  })
  const calculate = pipeline.calculate.bind(pipeline)
  pipeline.calculate = async (...args: any[]) => { await gate.promise; return calculate(...args) }
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await focusLatest(pipeline, instId, '15m'); await flush(); assert.equal(attempts, 1)
    gate.resolve(); await finishSeed(pipeline); await flush()
    assert.ok(pipeline.indicatorDemand(pipeline.state(instId, '15m')))
    assert.equal(attempts, 1, 'Completing calculation cannot bypass backoff by requesting a different overlapping range.')
    context.mock.timers.tick(59_999); await flush(); assert.equal(attempts, 1)
    context.mock.timers.tick(1); await flush()
    await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task)); await finishSeed(pipeline)
    assert.equal(attempts, 2); assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'ready')
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('genuine listing warmup and zero-volume VWAP do not cause repeated history acquisition', async () => {
  for (const count of [12, 220, 400]) {
    const rows = source(count).map(row => ({ ...row, baseVolume: 0, quoteVolume: 0 }))
    let requests = 0
    const { pipeline } = fixture(rows, { async ensurePrices() { requests += 1 } })
    pipeline.instrument = () => ({ listTime: rows[0].timestamp })
    try {
      await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
      await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
      assert.equal(requests, 0); assert.equal(pipeline.cached(`${instId}:15m`).indicatorState, 'unavailable')
    } finally { await pipeline.dispose() }
  }
})

test('source recovery repairs the selected historical viewport instead of the unrelated latest tail', async context => {
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
    const frame = await focusHistory(pipeline, instId, '15m', target)
    assert.equal(frame.priceState, 'partial')
    await flush(); assert.equal(requests.length, 1)
    context.mock.timers.tick(60_000); await flush(); assert.equal(requests.length, 1, 'Unchanged failed demand waits for a meaningful recovery event.')
    pipeline.sourceStateChanged(); pipeline.refreshObservations(pipeline.state(instId, '15m'), target); await flush()
    assert.equal(requests.length, 2); assert.equal(requests[1].through, target)
    assert.ok(requests[1].from <= target - 95 * interval)
    const repaired = pipeline.historyFrame(pipeline.state(instId, '15m'), target)
    assert.equal(repaired.priceState, 'ready')
  } finally { await pipeline.dispose() }
})

test('cold forming prices are visible without any historical candle or recursive seed', async () => {
  const { pipeline } = fixture([])
  try {
    pipeline.setUniverse([instId])
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false, close: 101.5 })
    const frame = await focusLatest(pipeline, instId, '15m')
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
    pipeline.setUniverse([instId, other])
    await focusLatest(pipeline, instId, '15m')
    await finishSeed(pipeline)
    const live = { ...candle(end() + interval), confirmed: false }
    await pipeline.setLive(instId, '15m', live)
    await focusLatest(pipeline, other, '15m')
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

test('collector subscriptions perform no eager source restoration', async () => {
  const { pipeline, store } = fixture()
  try {
    const ids = Array.from({ length: 287 }, (_, i) => `CANDIDATE${i}-USDT-SWAP`)
    pipeline.setRealtimeSubscriptions(ids.flatMap(instId => ['5m', '15m', '1H'].map(timeframe => ({ instId, timeframe }))))
    assert.equal(pipeline.realtimeKeys.size, 861)
    assert.equal(store.queries.length, 0); assert.equal(pipeline.nextCalculation, 0); assert.equal(pipeline.series.size, 0)
  } finally { await pipeline.dispose() }
})

test('full-universe forming intake retains raw prices without publishing charts that were never requested', async () => {
  const { pipeline, store } = fixture([]), frames: any[] = [], operations: OperationEvent[] = []
  const ids = Array.from({ length: 287 }, (_, index) => `CANDIDATE${index}-USDT-SWAP`)
  const timeframes = [['5m', 300000], ['15m', 900000], ['1H', 3600000]] as const
  pipeline.setRealtimeSubscriptions(ids.flatMap(instId => timeframes.map(([timeframe]) => ({ instId, timeframe }))))
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
    const selected = ids[178], opened = await focusLatest(pipeline, selected, '1H')
    assert.equal(opened.liveBar.close, 160.178, 'Opening a cold chart reads the latest retained native price immediately.')
    assert.equal(opened.realtimeState, 'live')
    frames.length = 0; operations.length = 0
    await tick(61)
    assert.equal(frames.length, 1, 'Only the explicitly materialized chart receives the next full-market revision.')
    assert.equal(frames[0].instId, selected)
    assert.equal(frames[0].timeframe, '1H')
    assert.equal(frames[0].liveBar.close, 161.178)
    assert.equal(operations.filter(operation => operation.name === 'chart.frame').length, 1)
    pipeline.setUniverse([selected])
    await new Promise<void>(resolve => setImmediate(resolve))
    await Promise.all([...pipeline.candidateTasks.values()])
    pipeline.maxSeries = 1
    await focusLatest(pipeline, ids[179], '5m')
    assert.equal(pipeline.series.has(`${selected}:1H`), false)
    const reads = store.queries.length
    frames.length = 0
    await tick(62)
    assert.deepEqual(frames.map(frame => `${frame.instId}:${frame.timeframe}`).toSorted(),
      [`${selected}:5m`, `${selected}:15m`, `${selected}:1H`, `${ids[179]}:5m`].toSorted(),
      'Every backend universe timeframe and the previously materialized compact cache stay current after history LRU eviction.')
    assert.equal(frames.find(frame => frame.instId === selected).liveBar.close, 162.178)
    assert.equal(store.queries.length, reads, 'Maintaining compact cached prices cannot restore their evicted history.')
    assert.equal(pipeline.realtimeKeys.size, 861, 'Publication demand cannot remove background market collection.')
  } finally { unsubscribe(); await pipeline.dispose() }
})

test('exact recursive work reads bounded chunks and durable checkpoints reproduce full-history math', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  let restarted: any
  try {
    const raw = await focusLatest(pipeline, instId, '15m')
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
    await focusLatest(restarted, instId, '15m'); await finishSeed(restarted)
    const chunks = store.queries.filter(query => query.order === 'asc')
    assert.ok(chunks[0].from > rows[0].timestamp, 'A verified prefix checkpoint avoids replaying the canonical origin.')
    for (const key of indicatorFields) assert.equal(restarted.cached(`${instId}:15m`).bars.at(-1)[key], oracle.at(-1)![key])
  } finally { await restarted?.dispose(); await pipeline.dispose() }
})

test('old price corrections invalidate descendant seeds and keep prices visible during exact recomputation', async () => {
  const rows = source(2500), { pipeline, store } = fixture(rows)
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const count = pipeline.nextCalculation, frame = pipeline.cached(`${instId}:15m`), last = store.rows.at(-1)!
    store.rows[store.rows.length - 1] = { ...last, oi: null, statisticsVersion: 11, statisticsOIExpiresAt: Date.now() - 1 }
    await pipeline.observeStatistics(instId, '15m', last.timestamp, last.timestamp)
    const next = pipeline.cached(`${instId}:15m`)
    assert.equal(next.endHour, end()); assert.equal(next.oiState, 'unavailable'); assert.equal(next.oiStatus.reason, 'unsupported'); assert.equal(next.indicatorState, 'ready')
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    const requested = rows[2000].timestamp, frame = await focusHistory(pipeline, instId, '15m', requested)
    assert.ok(frame.bars.length <= 2304); assert.equal(frame.endHour, requested)
    assert.ok(frame.bars.some((value: any) => value.hour === requested))
    assert.equal(frame.oiState, 'unavailable'); assert.equal(frame.oiStatus.reason, 'unsupported'); assert.ok(store.queries.every(query => query.limit))
  } finally { await pipeline.dispose() }
})

test('cache existence never certifies realtime when stream continuity or observation age is missing', async () => {
  const { pipeline } = fixture()
  try {
    await focusLatest(pipeline, instId, '15m')
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

test('failed statistic sources wait independently for source recovery while prices stay available', async context => {
  // Exercise source deadlines without also crossing a native candle boundary.
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const rows = source(400).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  let attempts = 0
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { attempts += 1; throw new Error('Statistics offline') } })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    const frame = await focusLatest(pipeline, instId, '15m')
    await flush()
    assert.equal(frame.priceState, 'ready'); assert.equal(attempts, 2)
    context.mock.timers.tick(60_000); await flush(); assert.equal(attempts, 2)
    pipeline.sourceStateChanged(); pipeline.refreshObservations(pipeline.state(instId, '15m')); await flush()
    assert.equal(attempts, 4)
    context.mock.timers.tick(60_000); await flush(); assert.equal(attempts, 4)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    context.mock.timers.tick(9_999); await flush(); assert.equal(attempts, 0)
    context.mock.timers.tick(1); await flush(); assert.equal(attempts, 2)
    assert.equal(pipeline.cached(`${instId}:15m`).endHour, end())
    assert.equal(pipeline.cached(`${instId}:15m`).oiState, 'unavailable')
    assert.equal(pipeline.cached(`${instId}:15m`).oiStatus.reason, 'not-published')
    context.mock.timers.tick(30_000); await flush(); assert.equal(attempts, 2)
  } finally { await pipeline.dispose() }
})

test('a quiet quote pushes its stale transition without periodic chart reads or source requests', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  let requests = 0
  const { pipeline } = fixture(source(400), { async latest() { requests += 1 }, async ensureStatistics() { requests += 1 } })
  const published: any[] = []
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    pipeline.subscribe((frame: any) => published.push(frame))
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false }, { receivedAt: Date.now() })
    assert.equal(published.at(-1).realtimeState, 'live')
    context.mock.timers.tick(30_000)
    assert.equal(published.at(-1).realtimeState, 'stale')
    assert.equal(requests, 0)
  } finally { await pipeline.dispose() }
})

test('continuous live quotes cannot postpone repairing a resident historical viewport', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
  const canonical = source(700), target = canonical[500].timestamp, first = target - 95 * interval
  const calls: string[] = []
  const rows = canonical.map(row => row.timestamp >= first && row.timestamp < target - 12 * interval
    ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const { pipeline, store } = fixture(rows as any, {
    async ensureStatistics(_instrument: string, _timeframe: string, from: number, through: number, _priority: string, _signal: AbortSignal, source: string) {
      calls.push(source)
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  pipeline.instrument = () => ({ listTime: canonical[0].timestamp })
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m')
    await pipeline.read(state, target, 1536); await pipeline.seed(state); await finishSeed(pipeline)
    const reads = store.queries.length
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'resident-history')
    for (let tick = 0; tick < 12; tick++) {
      context.mock.timers.tick(250)
      await pipeline.setLive(instId, '15m', { ...canonical.at(-1), timestamp: end() + interval, confirmed: false, volume: 100 + tick }, { receivedAt: Date.now() })
      await flush()
    }
    assert.deepEqual(calls.toSorted(), ['oi', 'taker'], 'A quiet period in the live market cannot be required before starting historical repairs.')
    const repaired = pipeline.historyFrame(state, target)
    assert.equal(repaired.oiState, 'ready'); assert.equal(repaired.takerState, 'ready')
    assert.equal(store.queries.length, reads, 'Statistics returned by acquisition must update the resident viewport without rereading its prices.')
  } finally { await pipeline.dispose() }
})

test('uncovered statistic samples are repaired without refetching known viewport edges', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
  const canonical = source(700), target = canonical[500].timestamp, oldEnd = target + 80 * interval, first = target - 95 * interval
  const calls: Array<{ source: string; from: number; through: number }> = []
  const rows = canonical.map(row => row.timestamp >= first && row.timestamp <= oldEnd
    && !(row.timestamp >= target - 15 * interval && row.timestamp <= target)
    ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const { pipeline } = fixture(rows as any, {
    async ensureStatistics(_instrument: string, _timeframe: string, from: number, through: number, _priority: string, signal: AbortSignal, source: string) {
      calls.push({ source, from, through })
      if (through === oldEnd) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  pipeline.instrument = () => ({ listTime: canonical[0].timestamp })
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m')
    await pipeline.read(state, target, 1536); await pipeline.seed(state); await finishSeed(pipeline)
    pipeline.setFocus({ instId, timeframe: '15m', endHour: oldEnd }, 'old-window')
    pipeline.refreshObservations(state, oldEnd); await flush()
    assert.deepEqual(calls.filter(call => call.through === oldEnd).map(call => call.source).toSorted(), ['oi', 'taker'])
    const acquired = calls.length
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'selected-window')
    assert.equal(pipeline.frame(state, target, true).bars.filter((bar: any) => bar.oiObserved).length, 96,
      'The backend reserve repairs uncovered samples before the user selects them.')
    for (let tick = 0; tick < 12; tick++) {
      context.mock.timers.tick(250)
      await pipeline.setLive(instId, '15m', { ...canonical.at(-1), timestamp: end() + interval, confirmed: false, volume: 100 + tick })
      await flush()
    }
    const repairs = calls.filter(call => call.from === first && call.through === target - 16 * interval)
    assert.deepEqual(repairs.map(call => call.source).toSorted(), ['oi', 'taker'])
    assert.equal(calls.length, acquired, 'Selecting the repaired reserve cannot request the same samples again.')
    assert.ok(calls.every(call => call.through < target - 15 * interval || call.from > target), 'Statistic acquisition excludes already observed samples.')
    const repaired = pipeline.historyFrame(state, target)
    assert.equal(repaired.oiState, 'ready'); assert.equal(repaired.takerState, 'ready')
  } finally { await pipeline.dispose() }
})

test('an active source on the known edge cannot hide an uncovered failure or its retry deadline', async () => {
  const canonical = source(700), target = canonical[500].timestamp, first = target - 95 * interval, gate = deferred()
  const rows = canonical.map(row => row.timestamp >= first && row.timestamp < target - 15 * interval
    ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { await gate.promise } })
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m')
    await pipeline.read(state, target, 1536); await pipeline.seed(state); await finishSeed(pipeline)
    const retryAt = Date.now() + 60_000
    pipeline.sourceAttempts.set('failed-missing-oi', { seriesKey: state.key, source: 'oi', from: first, through: target - 16 * interval,
      failures: 1, failedAt: Date.now(), retryAt, error: 'Historical OI failed' })
    const edge = pipeline.sourceJob('known-edge', async () => gate.promise, { state, source: 'oi', from: target - 15 * interval, through: target + 80 * interval })
    const frame = pipeline.historyFrame(state, target)
    assert.equal(frame.oiState, 'error'); assert.equal(frame.oiStatus.error, 'Historical OI failed'); assert.equal(frame.oiStatus.retryAt, retryAt)
    assert.equal(frame.takerState, 'loading', 'A failure is scoped to its own source.')
    gate.resolve(); await edge
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a newer statistic fences only its own slot while an admitted history page fills the other 95 samples', async () => {
  const canonical = source(400), rows = canonical.map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const { pipeline, store } = fixture(rows as any), gate = deferred(), started = deferred()
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const read = store.candles.bind(store), first = end() - 95 * interval
    store.candles = async (query: any) => {
      if (query.from === first && query.order === 'asc') { started.resolve(); await gate.promise; return canonical.slice(-96) }
      return read(query)
    }
    const observed = pipeline.observeStatistics(instId, '15m', first, end(), 'interactive', undefined, 'oi')
    await started.promise
    await pipeline.observeStatistics(instId, '15m', end(), end(), 'interactive', [{ ...canonical.at(-1), oi: 9000 }], 'oi')
    gate.resolve(); await observed
    const frame = pipeline.cached(`${instId}:15m`)
    assert.equal(frame.oiState, 'ready'); assert.equal(frame.bars.filter((bar: any) => bar.oiObserved).length, 96)
    assert.equal(frame.bars.at(-1).oi, 9000, 'The newer final slot remains authoritative.')
    assert.ok(frame.bars.slice(0, -1).every((bar: any) => bar.oi === 5000))
    assert.ok(frame.bars.every((bar: any) => !bar.takerObserved), 'Unrequested source observations stay independent.')
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a concurrent statistic update cannot discard unrelated left-edge observations from a local read', async () => {
  const canonical = source(400), rows = canonical.map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const { pipeline, store } = fixture(rows as any), gate = deferred(), entered = deferred()
  let reading: Promise<unknown> | undefined
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), read = store.candles.bind(store)
    store.rows = canonical
    store.candles = async (query: any) => {
      const result = await read(query)
      if (query.order === 'desc') { entered.resolve(); await gate.promise }
      return result
    }
    reading = pipeline.read(state)
    await entered.promise
    const last = canonical.at(-1)!
    await pipeline.observeStatistics(instId, '15m', last.timestamp, last.timestamp, 'interactive', [{ ...last, oi: 9000 }], 'oi')
    gate.resolve(); await reading
    const frame = pipeline.frame(state)
    assert.ok(frame.bars.slice(0, -1).every((bar: any) => bar.oi === 5000), 'A newer final slot cannot veto the other 95 native observations.')
    assert.ok(frame.bars.every((bar: any) => bar.buy === 70 && bar.sell === 30), 'The OI update cannot fence Taker observations.')
    assert.equal(frame.bars.at(-1).oi, 9000, 'The actual concurrent OI correction stays authoritative.')
  } finally { gate.resolve(); await reading; await pipeline.dispose() }
})

test('returning from deep history restores an evicted latest price locally before source work', async () => {
  const rows = source(5000), { pipeline, store } = fixture(rows)
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    await focusHistory(pipeline, instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(state.rows.has(rows.at(-1)!.timestamp), false, 'The test must actually evict the current tail.')
    const before = store.queries.length
    const latest = await focusLatest(pipeline, instId, '15m')
    assert.equal(latest.endHour, rows.at(-1)!.timestamp)
    assert.equal(latest.bars.at(-1).close, rows.at(-1)!.close)
    assert.equal(state.historyEnd, null)
    assert.ok(store.queries.slice(before).some(query => query.order === 'desc' && query.limit === 128))
  } finally { await pipeline.dispose() }
})

test('forming ticks never rebuild or republish an open historical navigation reserve', async () => {
  const rows = source(2000), { pipeline, store } = fixture(rows), target = rows[1900].timestamp
  try {
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
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
    const selected = focusLatest(pipeline, instId, '15m')
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const write = store.writeIndicatorCheckpoint.bind(store)
    let blocked = false
    store.writeIndicatorCheckpoint = async (value: any) => {
      if (!blocked && value.timestamp === rows[1023].timestamp) { blocked = true; reached.resolve(); await hold.promise }
      return write(value)
    }
    await focusHistory(pipeline, instId, '15m', rows[2000].timestamp)
    await reached.promise
    await focusHistory(pipeline, instId, '15m', rows[600].timestamp)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const current = { ...candle(end() + interval, 4000), high: 510, close: 501.5, confirmed: false }
    await pipeline.setLive(instId, '15m', current)
    const before = pipeline.cached(`${instId}:15m`)
    await focusHistory(pipeline, instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    pipeline.series.delete(`${instId}:15m`)
    await focusLatest(pipeline, instId, '15m')
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const calculate = pipeline.calculate.bind(pipeline), target = rows[2000].timestamp
    let blocked = false
    pipeline.calculate = async (candles: any[], ...args: any[]) => {
      if (!blocked && candles[0].timestamp === rows[0].timestamp) { blocked = true; reached.resolve(); await hold.promise }
      return calculate(candles, ...args)
    }
    await focusHistory(pipeline, instId, '15m', target)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline); await pipeline.dispose()
    const read = store.readIndicatorCheckpoint.bind(store)
    let corrected = false
    store.readIndicatorCheckpoint = async (query: any) => {
      const result = await read(query)
      if (!corrected) { corrected = true; store.change({ ...rows[100], close: rows[100].close + 20, baseVolume: 1000 }) }
      return result
    }
    restarted = new PreparedChartPipeline({ store: store as any, history: {} as any, normalize: (row: any) => row, revision: () => 0, instrument: () => undefined })
    await focusLatest(restarted, instId, '15m'); await finishSeed(restarted)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const frame = pipeline.cached(`${instId}:15m`), oracle = new Map(buildIndicatorSeries(store.rows, interval).bars.map((value: any) => [value.hour, value]))
    for (const value of frame.bars) for (const key of indicatorFields) assert.equal(value[key], (oracle.get(value.hour) as any)[key])
    assert.equal(frame.bars.find((value: any) => value.hour === rows[1750].timestamp).close, store.rows[1750].close)
    assert.ok(pipeline.nextCalculation < 12)
  } finally { await pipeline.dispose() }
})

test('a durable correction reloaded through the live tail keeps its historical series generation coherent', async () => {
  const rows = source(3000), { pipeline, store } = fixture(rows)
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const historicalEnd = rows[1500].timestamp
    await focusHistory(pipeline, instId, '15m', historicalEnd); await pipeline.focus.task; await finishSeed(pipeline)
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


for (const oldIndex of [1800, 3300, 3700]) test(`a late historical SQL response at ${oldIndex} preserves the newer navigation reserve`, async () => {
  const rows = source(5000), { pipeline, store } = fixture(rows), hold = deferred(), started = deferred()
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const read = store.candles.bind(store), oldEnd = rows[oldIndex].timestamp, newEnd = rows[3500].timestamp
    let blocked = false
    store.candles = async (query: any) => {
      const result = await read(query)
      if (!blocked && query.order === 'desc' && query.through === oldEnd + 256 * interval) { blocked = true; started.resolve(); await hold.promise }
      return result
    }
    const older = focusHistory(pipeline, instId, '15m', oldEnd)
    await started.promise
    await focusHistory(pipeline, instId, '15m', newEnd); await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), retained = [...state.rows.keys()].sort((a: number, b: number) => a - b)
    assert.ok(retained.length >= 96 && retained.length <= 2304)
    hold.resolve(); await older; await finishSeed(pipeline)
    const frame = pipeline.historyFrame(state, newEnd)
    assert.equal(state.historyEnd, newEnd)
    assert.ok(state.rows.size <= 2304)
    assert.ok(retained.every(hour => state.rows.has(hour)), 'An obsolete query must preserve the entire current reserve.')
    const viewport = frame.bars.filter((value: any) => value.hour >= newEnd - 95 * interval && value.hour <= newEnd)
    assert.equal(viewport.length, 96); assert.equal(viewport.every((value: any) => value.indicatorsObserved), true)
    const reads = store.queries.length
    await pipeline.localHistory(instId, '15m', newEnd - 500 * interval)
    await pipeline.localHistory(instId, '15m', newEnd + 128 * interval)
    assert.equal(store.queries.length, reads, 'The retained reserve remains admitted for local navigation.')
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('resident historical viewports reuse their canonical rows without another SQLite read', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  try {
    await focusHistory(pipeline, instId, '15m', rows[2000].timestamp); await finishSeed(pipeline)
    const reads = store.queries.length
    const next = await focusHistory(pipeline, instId, '15m', rows[1999].timestamp)
    const viewport = next.bars.filter((value: any) => value.hour >= rows[1904].timestamp && value.hour <= rows[1999].timestamp)
    assert.equal(viewport.length, 96)
    assert.equal(viewport.every((value: any) => value.indicatorsObserved), true)
    assert.equal(store.queries.length, reads, 'A resident cursor move must reuse rows and exact derived values.')
  } finally { await pipeline.dispose() }
})

test('the first history gesture expands a resident latest tail into its durable navigation reserve', async () => {
  const rows = source(3500), { pipeline, store } = fixture(rows)
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    assert.equal(state.rows.size, 128)
    const before = store.queries.length
    const historical = await focusHistory(pipeline, instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(historical.bars.length >= 1280, 'A complete 96-candle viewport cannot substitute for the first bulk history admission.')
    assert.ok(store.queries.slice(before).some(query => query.order === 'desc' && query.limit === 1536))
    await finishSeed(pipeline)
    const reads = store.queries.length
    await focusHistory(pipeline, instId, '15m', rows.at(-3)!.timestamp)
    assert.equal(store.queries.length, reads, 'Later resident gestures reuse the admitted historical reserve.')

    await focusHistory(pipeline, instId, '15m', rows[1200].timestamp); await finishSeed(pipeline)
    assert.ok(state.historyRange.through < rows.at(-96)!.timestamp)
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const tail = [...state.rows.values()].filter((row: any) => row.timestamp >= rows.at(-128)!.timestamp)
    assert.equal(tail.length, 128, 'Returning from deep history restores only the latest tail.')
    const afterDeepHistory = store.queries.length
    const returned = await focusHistory(pipeline, instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(returned.bars.filter((bar: any) => bar.hour >= rows.at(-1280)!.timestamp).length >= 1280,
      'A deep-history interval cannot certify the latest navigation reserve.')
    assert.ok(store.queries.slice(afterDeepHistory).some(query => query.order === 'desc' && query.limit === 1536))
    await finishSeed(pipeline)
    const admittedAgain = store.queries.length
    await focusHistory(pipeline, instId, '15m', rows.at(-3)!.timestamp)
    assert.equal(store.queries.length, admittedAgain)

    await focusLatest(pipeline, instId, '15m')
    pipeline.invalidate(instId, '15m')
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    assert.equal(state.rows.size, 128)
    const afterInvalidation = store.queries.length
    const restored = await focusHistory(pipeline, instId, '15m', rows.at(-2)!.timestamp)
    assert.ok(restored.bars.length >= 1280, 'Invalidation also retires the previous bulk-history admission.')
    assert.ok(store.queries.slice(afterInvalidation).some(query => query.order === 'desc' && query.limit === 1536))
  } finally { await pipeline.dispose() }
})

test('continuous navigation extends persisted history before a held delivery reaches the resident boundary', { timeout: 30_000 }, async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp
  const sourceGate = deferred()
  let sourceRequests = 0, firstSourceAt: number | null = null, step = 0, sourceReleased = false
  const { pipeline, store } = fixture(rows, { async ensurePrices(_id: string, _timeframe: string, from: number, through: number) {
    sourceRequests += 1
    firstSourceAt ??= step
    await sourceGate.promise
    return { rows: rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
  } })
  const encoder = new ChartNotificationEncoder(), pending: Array<{ due: number; deliver: () => void }> = []
  let initialFirst = -Infinity, firstExtension: number | null = null, holding = false
  const hold = (frame: any, deliver: (value: any) => void) => {
    if (!holding || !frame?.bars?.length || frame.bars[0].hour >= initialFirst) { deliver(frame); return }
    firstExtension ??= step
    pending.push({ due: step + 90, deliver: () => deliver(frame) }) // 1500 ms at 60 input frames per second.
  }
  const controller = new ChartController({
    focus: (target, id) => pipeline.setFocus(target ? { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: async target => {
      const frame = await pipeline.localHistory(target.instId, target.timeframe, target.end ?? undefined)
      return new Promise(resolve => hold(frame, resolve))
    },
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const unsubscribe = pipeline.subscribe((frame: any) => hold(frame, value => controller.ingestPrepared(encoder.encode(value))))
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  const close = controller.open(instId, '15m')
  try {
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    controller.scroll(-1)
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    const state = pipeline.series.get(`${instId}:15m`), initial = pipeline.historyFrame(state, latest - interval)
    assert.ok(initial.bars.length > 96 && initial.bars.every((bar: any) => bar.indicatorsObserved))
    initialFirst = initial.bars[0].hour
    const initialBars = (latest - initialFirst) / interval + 1
    assert.equal(initialBars, 1281)
    controller.scroll(1)
    await flush(); await pipeline.focus.task; await flush()
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    holding = true
    for (step = 1; step <= 768; step += 1) {
      controller.scroll(-2)
      await flush()
      // If the implementation incorrectly routes already-persisted rows via
      // source preparation, let input continue while that work is held.
      if (firstSourceAt !== null && step >= firstSourceAt + 80 && !sourceReleased) { sourceReleased = true; sourceGate.resolve() }
      if (firstSourceAt === null || sourceReleased) await pipeline.focus.task
      await finishSeed(pipeline); await flush()
      for (const entry of pending.filter(item => item.due <= step)) entry.deliver()
      for (let index = pending.length - 1; index >= 0; index -= 1) if (pending[index].due <= step) pending.splice(index, 1)
      await flush()
      const view = controller.getSnapshot(), bars = view.presented?.bars ?? []
      assert.equal(view.pending, false, `Input ${step} must not expose a pending viewport.`)
      assert.equal(bars.length, 96, `Input ${step} must retain the complete viewport.`)
      assert.equal(view.presented?.endHour, latest - step * 2 * interval)
      for (const bar of bars) {
        assert.equal(bar.indicatorsObserved, true)
        for (const field of indicatorFields) assert.equal(bar[field as keyof typeof bar], (oracle.get(bar.hour) as any)[field])
      }
    }
    assert.notEqual(firstExtension, null, 'A reserve extension must be delivered during the gesture.')
    assert.ok(initialBars - 96 - firstExtension! * 2 >= 192, 'The extension starts with at least 192 resident candles of runway.')
    assert.equal(sourceRequests, 0)
    assert.ok(store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length <= 4)
  } finally {
    holding = false
    sourceGate.resolve()
    for (const entry of pending) entry.deliver()
    close(); unsubscribe(); await pipeline.dispose()
  }
})

test('a reserve read survives nearby focus changes and shares its admission', async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp, { pipeline, store } = fixture(rows)
  const entered = deferred(), release = deferred(), read = store.candles.bind(store)
  let heldReads = 0, hold = false
  store.candles = async query => {
    if (hold && query.order === 'desc' && query.limit === 1536) {
      heldReads += 1
      entered.resolve()
      await release.promise
    }
    return read(query)
  }
  try {
    await focusHistory(pipeline, instId, '15m', latest - interval); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), first = Math.min(...state.rows.keys())
    hold = true
    const target = latest - 802 * interval
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'reserve-0')
    await entered.promise
    for (let index = 1; index <= 20; index += 1) {
      pipeline.setFocus({ instId, timeframe: '15m', endHour: target - 2 * index * interval }, `reserve-${index}`)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(heldReads, 1, 'Nearby cursor changes must join the same durable read.')
    assert.ok([...pipeline.focusReads].every((entry: any) => entry.waiters.size <= 1), 'A held read must not retain obsolete cursor waiters.')
    release.resolve(); await pipeline.focus.task; await finishSeed(pipeline)
    const current = target - 40 * interval, frame = pipeline.historyFrame(state, current)
    assert.ok(frame.bars[0].hour < first, 'The admitted read must extend the original reserve.')
    const visible = frame.bars.filter((bar: any) => bar.hour >= current - 95 * interval && bar.hour <= current)
    assert.equal(visible.length, 96)
    assert.ok(visible.every((bar: any) => bar.indicatorsObserved))
    assert.equal(state.historyEnd, current)
    assert.equal(heldReads, 1)
  } finally { release.resolve(); await pipeline.dispose() }
})

test('a distant missing viewport is not blocked by an older held reserve read', async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp, { pipeline, store } = fixture(rows)
  const entered = deferred(), release = deferred(), read = store.candles.bind(store)
  let hold = false, held = false
  store.candles = async query => {
    if (hold && !held && query.order === 'desc' && query.limit === 1536) {
      held = true; entered.resolve(); await release.promise
    }
    return read(query)
  }
  try {
    await focusHistory(pipeline, instId, '15m', latest - interval); await finishSeed(pipeline)
    hold = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: latest - 802 * interval }, 'near')
    await entered.promise
    const distant = latest - 2200 * interval
    pipeline.setFocus({ instId, timeframe: '15m', endHour: distant }, 'distant')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), visible = pipeline.historyFrame(state, distant).bars
      .filter((bar: any) => bar.hour >= distant - 95 * interval && bar.hour <= distant)
    assert.equal(visible.length, 96)
    assert.ok(visible.every((bar: any) => bar.indicatorsObserved))
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(state.historyEnd, distant)
    assert.ok(visible.every((bar: any) => state.rows.has(bar.hour)), 'The late read must not evict the active viewport.')
  } finally { release.resolve(); await pipeline.dispose() }
})

test('an inspected sparse reserve does not cause a durable reread on each cursor move', async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp, gate = deferred()
  let sourceRequests = 0
  const { pipeline, store } = fixture(rows.slice(-1281), { async ensurePrices() { sourceRequests += 1; await gate.promise; return { rows: [] } } })
  try {
    await focusHistory(pipeline, instId, '15m', latest - interval); await finishSeed(pipeline)
    const before = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length
    for (let index = 0; index < 20; index += 1) {
      pipeline.setFocus({ instId, timeframe: '15m', endHour: latest - (802 + 2 * index) * interval }, `sparse-${index}`)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const reads = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length - before
    assert.equal(reads, 1, 'A proven empty part of the reserve is inspected once, not once per focus.')
    assert.ok(sourceRequests > 0, 'Missing durable facts still reach the source acquisition path.')
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a price change during coverage cannot certify a reserve read against the newer input', async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp, { pipeline, store } = fixture(rows)
  const entered = deferred(), release = deferred(), coverage = store.coverage.bind(store)
  let hold = false, held = false
  store.coverage = async () => {
    if (hold && !held) { held = true; entered.resolve(); await release.promise }
    return coverage()
  }
  try {
    await focusHistory(pipeline, instId, '15m', latest - interval); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), before = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length
    hold = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: latest - 802 * interval }, 'revision-race')
    await entered.promise
    state.priceVersion += 1 // An observer advances the input after rows were read, while coverage is pending.
    release.resolve(); await pipeline.focus.task; await finishSeed(pipeline)
    const reads = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length - before
    assert.ok(reads >= 2 && reads <= 3, 'The stale read proof must be refreshed for the new price input and either edge.')
    assert.equal(state.historyReadRange.priceVersion, state.priceVersion)
  } finally { release.resolve(); await pipeline.dispose() }
})

test('evicting a previously inspected reserve also retires its read proof', async () => {
  const rows = source(4000), latest = rows.at(-1)!.timestamp, { pipeline, store } = fixture(rows)
  try {
    await focusHistory(pipeline, instId, '15m', latest - interval); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    pipeline.setFocus({ instId, timeframe: '15m', endHour: latest - 802 * interval }, 'extend')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.ok(state.historyReadRange.from <= latest - 2000 * interval)
    pipeline.setFocus({ instId, timeframe: '15m', endHour: latest - 200 * interval }, 'newer')
    await pipeline.focus.task
    pipeline.retainRows(state, 1536)
    assert.ok(state.historyReadRange.from >= latest - 1479 * interval)
    const before = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length
    const target = latest - 1100 * interval
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'older')
    await pipeline.focus.task; await finishSeed(pipeline)
    const newReads = store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length - before
    assert.ok(newReads >= 1 && newReads <= 2, 'The evicted older reserve and an uncovered newer edge must be inspected locally.')
    assert.ok(state.rows.has(target - (96 + 384 - 1) * interval), 'Navigation must read back evicted durable rows before the margin runs out.')
  } finally { await pipeline.dispose() }
})

test('evictions during coverage cannot restore a discarded reserve inspection', async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows)
  const coverageEntered = deferred(), coverageRelease = deferred(), returnEntered = deferred(), returnRelease = deferred()
  const coverage = store.coverage.bind(store), read = store.candles.bind(store)
  let holdCoverage = false, coverageHeld = false, holdReturn = false, returnHeld = false, sourceRequests = 0
  store.coverage = async () => {
    if (holdCoverage && !coverageHeld) { coverageHeld = true; coverageEntered.resolve(); await coverageRelease.promise }
    return coverage()
  }
  store.candles = async query => {
    const result = await read(query)
    if (holdReturn && !returnHeld && query.limit === 1536 && query.order === 'desc') { returnHeld = true; returnEntered.resolve(); await returnRelease.promise }
    return result
  }
  const a = rows[4000].timestamp, b = rows[4600].timestamp
  try {
    await focusLatest(pipeline, instId, '15m'); await pipeline.focus.task; await finishSeed(pipeline)
    holdCoverage = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: a }, 'inspection-a')
    const oldRead = pipeline.focus.task
    await coverageEntered.promise
    const oldEntry = [...pipeline.focusReads][0] as any
    pipeline.setFocus({ instId, timeframe: '15m', endHour: b }, 'inspection-b')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), version = state.retentionVersion
    assert.equal(state.rows.has(a - 1000 * interval), false, 'The intervening selection evicted the older admitted rows.')
    holdReturn = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: a }, 'inspection-a-return')
    const currentRead = pipeline.focus.task
    await returnEntered.promise
    coverageRelease.resolve(); await oldRead; await oldEntry.done
    assert.ok((state.retentionVersion ?? 0) >= version)
    assert.ok(!state.historyReadRange || state.historyReadRange.from > a - 1000 * interval,
      'An obsolete A read cannot restore the proof after A → B → A eviction.')
    returnRelease.resolve(); await currentRead; await finishSeed(pipeline)
    pipeline.history.ensurePrices = async (_id: string, _timeframe: string, from: number, through: number) => {
      sourceRequests += 1
      return { rows: rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    }
    const target = a - 250 * interval
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'after-eviction')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.equal(sourceRequests, 0, 'The persisted reserve must be read locally after any intervening eviction.')
    const visible = pipeline.frame(state, target, true).bars
    assert.equal(visible.length, 96)
    assert.ok(visible.every((bar: any) => bar.indicatorsObserved))
  } finally { coverageRelease.resolve(); returnRelease.resolve(); await pipeline.dispose() }
})

test('implicit latest history cannot certify rows omitted by its descending SQL limit', async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows)
  const a = rows[3000].timestamp, b = rows[3600].timestamp
  let sourceRequests = 0
  try {
    await focusHistory(pipeline, instId, '15m', b); await pipeline.focus.task; await finishSeed(pipeline)
    pipeline.setFocus({ instId, timeframe: '15m', endHour: a }, 'older-resident')
    await pipeline.focus.task; await finishSeed(pipeline)
    await pipeline.localHistory(instId, '15m', undefined)
    const query = store.queries.at(-1), state = pipeline.series.get(`${instId}:15m`)
    assert.equal(query.from, undefined)
    assert.equal(query.limit, 1536)
    assert.ok(rows.at(-1536)!.timestamp > a + 256 * interval, 'Every selected latest row is outside the active historical reserve.')
    assert.equal(state.rows.has(a - 1000 * interval), false)
    pipeline.history.ensurePrices = async (_id: string, _timeframe: string, from: number, through: number) => {
      sourceRequests += 1
      return { rows: rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    }
    const target = a - 250 * interval
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'after-limited-read')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.equal(sourceRequests, 0, 'An unselected persisted interval must not be redirected through source acquisition.')
    const visible = pipeline.frame(state, target, true).bars
    assert.equal(visible.length, 96)
    assert.ok(visible.every((bar: any) => bar.indicatorsObserved))
  } finally { await pipeline.dispose() }
})

for (const heldReplay of [false, true]) test(`historical invalidation restarts backend focus without renderer reads${heldReplay ? ' while an obsolete replay is in flight' : ''}`, async () => {
  const rows = source(5000), target = rows[2000].timestamp, { pipeline, store } = fixture(rows)
  const gate = deferred(), entered = deferred(), frames: any[] = []
  let held = false
  const settleCandidates = async () => {
    while (pipeline.candidateTasks.size || pipeline.candidateQueue.length) {
      await Promise.all([...pipeline.candidateTasks.values()])
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    await finishSeed(pipeline)
  }
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'latest')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.ok(store.checkpoints.some(value => value.timestamp > target), 'A mature latest checkpoint cannot calculate an older viewport by itself.')
    pipeline.setUniverse([instId]); await settleCandidates()
    if (heldReplay) {
      const calculate = pipeline.calculate.bind(pipeline)
      pipeline.calculate = async (...args: any[]) => {
        if (!held) {
          held = true; entered.resolve(); await gate.promise
          const result = await calculate(...args)
          return { ...result, bars: result.bars.map((bar: any) => ({ ...bar, ema: -12345 })) }
        }
        return calculate(...args)
      }
    }
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'historical-owner')
    const previousFocus = pipeline.focus
    if (heldReplay) await entered.promise
    else { await previousFocus.task; await finishSeed(pipeline) }
    const generation = pipeline.series.get(`${instId}:15m`).generation
    pipeline.subscribe((frame: any) => frames.push(frame))
    pipeline.invalidate(instId, '15m')
    const renewed = pipeline.focus
    assert.notEqual(renewed, previousFocus, 'Invalidation retires the old preparation identity, even though renderer ownership is unchanged.')
    assert.equal(renewed.id, 'historical-owner'); assert.equal(renewed.end, target)
    assert.equal(pipeline.series.get(`${instId}:15m`).generation, pipeline.liveStates.get(`${instId}:15m`).generation)
    gate.resolve()
    await Promise.all([previousFocus.task, renewed.task]); await settleCandidates()
    const state = pipeline.series.get(`${instId}:15m`), frame = pipeline.historyFrame(state, target)
    const viewport = frame.bars.filter((bar: any) => bar.hour >= target - 95 * interval && bar.hour <= target)
    assert.ok(frame.generation > generation); assert.equal(viewport.length, 96)
    assert.ok(viewport.every((bar: any) => bar.indicatorsObserved), 'Focused historical math must rebuild without a renderer read or prepare retry.')
    assert.ok(frames.some(frame => frame.endHour === target && frame.indicatorState === 'ready'))
    assert.ok(frames.every(frame => frame.bars.every((bar: any) => bar.ema !== -12345)), 'An obsolete worker result cannot enter the renewed generation.')
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    for (const bar of viewport) for (const field of indicatorFields) assert.equal(bar[field], (oracle.get(bar.hour) as any)[field])
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a committed mutation invalidates resident history before its normal observer arrives', async () => {
  const rows = source(2500), fixtureValue = await sqliteFixture(rows), { pipeline, store } = fixtureValue
  try {
    const target = rows[1800].timestamp
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
    const corrected = { ...rows[1750], close: rows[1750].close + .5 }
    await store.appendCandles([corrected]) // Deliberately withhold pipeline.observe.
    const next = await focusHistory(pipeline, instId, '15m', target)
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
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    pipeline.subscribe((frame: any) => frames.push(frame))
    preparation = pipeline.prepare(instId, '15m', target).then(() => { finished = true })
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const target = all[1800].timestamp
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
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
      assert.ok(state.rows.size <= 2304)
      assert.ok(pipeline.liveStates.get(state.key).rows.size <= 128)
    }
    await finishSeed(pipeline)
  } finally { await pipeline.dispose() }
})

test('newly downloaded older prefixes invalidate recursive descendants without discarding independent statistic facts', async () => {
  const all = source(1100), { pipeline, store } = fixture(all.slice(600)), target = all[1000].timestamp
  try {
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline), inputs: string[] = []
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      inputs.push(`${input[0].timestamp}:${input.at(-1).timestamp}`)
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await focusHistory(pipeline, instId, '15m', target)
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
    await focusLatest(pipeline, 'ETH-USDT-SWAP', '15m'); await finishSeed(pipeline)
    assert.equal(pipeline.priceJournal.has(state.key), false, 'Evicting the resident reserve also releases its bounded mutation journal.')
  } finally { hold.resolve(); await f.close() }
})

test('a durable prefix correction with a late observer retains the strict fence and cannot certify stale recursive state', async () => {
  const rows = source(3500), f = await sqliteFixture(rows), { pipeline, store } = f, hold = deferred(), started = deferred()
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline)
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await focusHistory(pipeline, instId, '15m', target)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const target = rows[1800].timestamp, calculate = pipeline.calculate.bind(pipeline)
    let blocked = false, reloads = 0
    const reload = pipeline.refreshChangedCanonical.bind(pipeline)
    pipeline.refreshChangedCanonical = (...args: any[]) => { reloads += 1; return reload(...args) }
    pipeline.calculate = async (input: any[], ...args: any[]) => {
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return calculate(input, ...args)
    }
    await focusHistory(pipeline, instId, '15m', target)
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

test('cold adjacent acquisition retains its full older reserve and balanced newer history and reuses the active admission', async context => {
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    await pipeline.prepare(instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), keys = [...state.rows.keys()].sort((a: number, b: number) => a - b)
    const first = target - 1279 * interval, last = target + 256 * interval, admitted = state.historyRange
    const reads = store.queries.length
    await focusHistory(pipeline, instId, '15m', target - interval); await finishSeed(pipeline)
    context.diagnostic(JSON.stringify({ retainedFirst: keys[0], expectedFirst: first, retainedLast: keys.at(-1), expectedLast: last,
      retained: keys.length, admitted, revisitReads: store.queries.length - reads }))
    assert.equal(keys[0], first, 'Older acquired reserve pages must remain resident instead of competing with excess newer rows.')
    assert.ok(keys.at(-1) >= last && keys.at(-1) <= target + 768 * interval)
    assert.ok(keys.length >= 1536 && keys.length <= 2304)
    for (let hour = first; hour <= last; hour += interval) assert.ok(state.rows.has(hour))
    assert.ok(admitted.from <= first && admitted.through >= last, 'A subpage read cannot replace the active reserve admission.')
    assert.equal(store.queries.length, reads, 'A neighboring resident viewport must reuse the acquired canonical reserve.')
    assert.ok(pipeline.liveStates.get(state.key).rows.size <= 128)
  } finally { await pipeline.dispose() }
})

test('a latest-boundary history admission is reusable when its end is implicit', async () => {
  const rows = source(8192), { pipeline, store } = fixture(rows)
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
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
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    preparation = pipeline.prepare(instId, '15m', target)
    await reached.promise
    await focusLatest(pipeline, instId, '15m')
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
    await focusLatest(pipeline, other, '15m')
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
  const owners: string[] = []
  pipeline.history.ensurePrices = async () => { calls += 1; owners.push(pipeline.focus.id) }
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'first')
    stale = pipeline.focus.task
    await reached.promise
    pipeline.setFocus(null, 'hidden')
    pipeline.setFocus({ instId, timeframe: '15m' }, 'second')
    hold.resolve(); await stale; await pipeline.focus.task
    assert.equal(calls, 1)
    assert.deepEqual(owners, ['second'], 'Only the new explicit focus may create source demand.')
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
    assert.ok([...pipeline.sourceTasks.values()].every((job: any) => job.demands.has(pipeline.focus)), 'Only current viewport consumers may keep source work alive.')
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
    await focusLatest(pipeline, instId, '15m'); await flush()
    pipeline.setFocus(null)
    await focusLatest(pipeline, instId, '15m'); await flush()
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

test('an OI failure publishes its error and retry while Taker completes independently', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const rows = source(400).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const calls: string[] = [], priorities: string[] = [], retryAt = now + 8_000
  let oiCalls = 0
  const { pipeline, store } = fixture(rows as any, {
    async ensureStatistics(_id: string, _frame: string, from: number, through: number, priority: string, _signal: AbortSignal, source: string) {
      calls.push(source); priorities.push(priority)
      if (source === 'oi' && ++oiCalls === 1) throw Object.assign(new Error('OI endpoint temporarily unavailable'), { retryAt })
      store.rows = store.rows.map(row => row.timestamp < from || row.timestamp > through ? row
        : source === 'oi' ? { ...row, oi: 5000, statisticsVersion: row.buy === null ? 9 : 11 }
          : { ...row, buy: 70, sell: 30, statisticsVersion: row.oi === null ? 10 : 11 })
    },
  })
  const reads: string[] = [], read = store.candles.bind(store)
  store.candles = async (query: any, priority?: string) => { if (query.order === 'asc' && query.limit === 1536) reads.push(priority!); return read(query) }
  const flush = async () => { for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await focusLatest(pipeline, instId, '15m'); await flush()
    const failed = pipeline.cached(`${instId}:15m`)
    assert.equal(failed.priceState, 'ready'); assert.equal(failed.takerState, 'ready')
    assert.equal(failed.oiState, 'error'); assert.equal(failed.oiStatus.error, 'OI endpoint temporarily unavailable')
    assert.equal(failed.oiStatus.retryAt, retryAt)
    assert.ok(failed.bars.every((bar: any) => bar.buy === 70 && bar.sell === 30 && bar.oi === null))
    assert.deepEqual(calls.toSorted(), ['oi', 'taker']); assert.deepEqual(priorities, ['interactive', 'interactive'])
    assert.deepEqual(reads, ['interactive'], 'Statistics SQLite projections share the visible acquisition priority.')
    context.mock.timers.tick(7_999); await flush(); assert.equal(oiCalls, 1)
    context.mock.timers.tick(1); await flush()
    assert.equal(oiCalls, 2); assert.equal(calls.filter(source => source === 'taker').length, 1)
    const repaired = pipeline.cached(`${instId}:15m`)
    assert.equal(repaired.oiState, 'ready'); assert.equal(repaired.oiStatus.error, undefined)
    assert.equal(repaired.takerState, 'ready')
    assert.equal(pipeline.sourceAttempts.size, 0)
  } finally { await pipeline.dispose() }
})

test('visible prices and statistic jobs outrank reserve acquisition and shared reserve jobs promote in place', async () => {
  const rows = source(2200).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const calls: Array<{ source: string; priority: string; from: number; through: number; signal: AbortSignal }> = [], promotions: any[] = []
  const acquire = async (_id: string, _frame: string, from: number, through: number, priority: string, signal: AbortSignal, source = 'candles') => {
    calls.push({ source, priority, from, through, signal })
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const { pipeline } = fixture(rows as any, { ensureStatistics: acquire, ensurePrices: acquire,
    promoteSource(...args: unknown[]) { promotions.push(args) },
  })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    await focusLatest(pipeline, instId, '15m'); await flush()
    assert.deepEqual(calls.map(call => [call.source, call.priority]), [['oi', 'interactive'], ['taker', 'interactive']])
    const state = pipeline.state(instId, '15m'), reserveEnd = rows[1000].timestamp
    const reserve = { from: reserveEnd - 299 * interval, through: reserveEnd }
    pipeline.refreshObservations(state, reserveEnd, 300, 300, pipeline.focus, reserve)?.catch(() => {})
    await flush()
    const reserved = calls.filter(call => call.through === reserveEnd)
    assert.deepEqual(reserved.map(call => [call.source, call.priority]), [['oi', 'prefetch'], ['taker', 'prefetch'], ['candles', 'prefetch']])
    pipeline.setFocus({ instId, timeframe: '15m', endHour: reserveEnd })
    pipeline.refreshObservations(state, reserveEnd, 96, 96, pipeline.focus, reserve)?.catch(() => {})
    await flush()
    assert.equal(calls.filter(call => call.through === reserveEnd).length, 3, 'Promotion keeps each existing acquisition.')
    assert.ok(reserved.every(call => !call.signal.aborted))
    assert.deepEqual(promotions.map(args => [args[2], args[5]]).toSorted(), [['candles', 'interactive'], ['oi', 'interactive'], ['taker', 'interactive']])
  } finally { pipeline.setFocus(null); await pipeline.dispose() }
})

test('cached successful-empty and numeric statistics acquire no new source data across viewport revisits', async () => {
  const rows: any[] = source(1800), expiresAt = Date.now() + 60_000
  rows[1000] = { ...rows[1000], oi: null, statisticsVersion: 11, statisticsOIExpiresAt: expiresAt }
  let requests = 0
  const { pipeline } = fixture(rows, {
    async ensurePrices() { requests += 1; throw new Error('Cached prices must not acquire HTTP') },
    async ensureStatistics() { requests += 1; throw new Error('Cached statistics must not acquire HTTP') },
  })
  try {
    await focusLatest(pipeline, instId, '15m')
    await focusHistory(pipeline, instId, '15m', rows[1000].timestamp)
    await focusLatest(pipeline, instId, '15m')
    const old = await focusHistory(pipeline, instId, '15m', rows[1000].timestamp)
    assert.equal(old.oiState, 'unavailable'); assert.equal(old.oiStatus.reason, 'not-published')
    assert.equal(old.takerState, 'ready'); assert.equal(requests, 0)
  } finally { await pipeline.dispose() }
})

test('offscreen statistic absence expires and revalidates only its native slots without another gesture', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const rows: any[] = source(1800), target = rows[1400].timestamp, absent = rows[500].timestamp
  rows[500] = { ...rows[500], oi: null, statisticsOIExpiresAt: now + 5000 }
  const calls: Array<{ source: string; from: number; through: number; priority: string }> = []
  const { pipeline, store } = fixture(rows, {
    async ensureStatistics(_id: string, _frame: string, from: number, through: number, priority: string, _signal: AbortSignal, source: string) {
      calls.push({ source, from, through, priority })
      store.rows = store.rows.map(row => row.timestamp === absent ? { ...row, oi: 5000 } : row)
      return { rows: store.rows.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
    pipeline.scheduleRefresh()
    assert.equal(calls.length, 0, 'An unexpired direct empty observation is reusable outside the viewport.')
    context.mock.timers.tick(4999); await flush(); assert.equal(calls.length, 0)
    context.mock.timers.tick(1); await flush()
    assert.deepEqual(calls, [{ source: 'oi', from: absent, through: absent, priority: 'prefetch' }])
    assert.equal(pipeline.series.get(`${instId}:15m`).rows.get(absent).oi, 5000)
    pipeline.prefetchStatistics(pipeline.series.get(`${instId}:15m`)); await flush()
    assert.equal(calls.length, 1, 'Numeric coverage needs no repeated acquisition.')
  } finally { await pipeline.dispose() }
})


test('a historical source failure republishes status while reusing its prepared price and indicator projection', async () => {
  const rows = source(500).map(row => ({ ...row, oi: null, statisticsVersion: 10 })), gate = deferred()
  const { pipeline } = fixture(rows as any, { async ensureStatistics() { await gate.promise; throw new Error('OI offline') } })
  try {
    const target = rows[350].timestamp
    await focusHistory(pipeline, instId, '15m', target); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m'), before = pipeline.historyFrame(state, target), calculations = pipeline.nextCalculation
    gate.resolve()
    for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve))
    const failed = pipeline.historyFrame(state, target)
    assert.equal(failed.oiState, 'error'); assert.equal(failed.takerState, 'ready')
    assert.equal(failed.bars, before.bars, 'A changed error or retry deadline does not rebuild the prepared reserve.')
    assert.equal(pipeline.nextCalculation, calculations)
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('an unchanged price and indicator failure publishes the new cursor range in a viewport frame', async () => {
  const rows = source(500), target = rows[350].timestamp, { pipeline } = fixture(rows)
  const originalSourceStatus = pipeline.sourceStatus.bind(pipeline), frames: any[] = []
  pipeline.sourceStatus = (state: any, source: string, from: number, through: number, availability: string) => source === 'candles'
    ? { state: 'error', from, through, error: 'Price offline', retryAt: 123_456 }
    : originalSourceStatus(state, source, from, through, availability)
  pipeline.indicatorStatus = (_state: any, _bars: any[], from: number, through: number) => ({
    state: 'error', from, through, inputVersion: 'same-input', error: 'Indicator worker offline', retryOn: 'worker-recovery',
  })
  try {
    await pipeline.localHistory(instId, '15m', target)
    const state = pipeline.state(instId, '15m')
    state.historyEnd = target
    state.publishedHistoryFrame = pipeline.historyFrame(state, target)
    const residentBars = state.publishedHistoryFrame.bars
    pipeline.subscribe((frame: any) => frames.push(frame))

    state.historyEnd = target - interval
    pipeline.publish(state)

    const update = frames.at(-1)
    assert.equal(update.endHour, target - interval)
    assert.equal(update.bars.length, 96, 'Status-only cursor changes use the selected viewport.')
    assert.equal(update.priceStatus.error, 'Price offline')
    assert.equal(update.priceStatus.from, target - 96 * interval)
    assert.equal(update.priceStatus.through, target - interval)
    assert.equal(update.indicatorStatus.error, 'Indicator worker offline')
    assert.equal(update.indicatorStatus.from, target - 96 * interval)
    assert.equal(update.indicatorStatus.through, target - interval)
    assert.strictEqual(state.historyBarsCache.bars, residentBars, 'No 1536-bar projection is rebuilt for range metadata.')
  } finally { await pipeline.dispose() }
})

test('covered focus navigation still publishes a known indicator failure for the new viewport', async () => {
  const rows = source(2200), target = rows[1700].timestamp, { pipeline } = fixture(rows)
  const frames: any[] = []
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'before-failure')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`), failedHour = target - interval
    state.indicators.delete(failedHour)
    state.indicatorFailures.set(failedHour, { inputVersion: pipeline.indicatorInputVersion(state),
      error: 'Worker unavailable', retryOn: 'worker-recovery' })
    pipeline.publish(state)
    frames.length = 0
    const reads = pipeline.nextCalculation
    pipeline.setFocus({ instId, timeframe: '15m', endHour: failedHour }, 'cached-failure')
    await pipeline.focus.task
    const update = frames.findLast(frame => frame.endHour === failedHour)
    assert.ok(update, 'The reserve fast path cannot hide a selected failure lifecycle.')
    assert.equal(update.bars.length, 96)
    assert.equal(update.indicatorStatus.state, 'error')
    assert.equal(update.indicatorStatus.through, failedHour)
    assert.equal(pipeline.nextCalculation, reads, 'An unchanged worker failure does not start another replay.')
  } finally { await pipeline.dispose() }
})


test('a failed cached price repair publishes its retry deadline through the encoder, store and controller, then recovers', async context => {
  const now = Math.floor(Date.now() / interval) * interval + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const canonical = source(400), absent = canonical[380], retryAt = now + 7000
  let calls = 0
  const { pipeline, store } = fixture(canonical.filter(row => row !== absent), {
    async ensurePrices() {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('Price endpoint offline'), { retryAt })
      store.change(absent)
    },
  })
  const controller = new ChartController({
    focus: (target, id) => pipeline.setFocus(target ? { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: target => pipeline.localHistory(target.instId, target.timeframe, target.end ?? undefined),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const encoder = new ChartNotificationEncoder()
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  const flush = async () => { for (let count = 0; count < 10; count++) await new Promise<void>(resolve => setImmediate(resolve)) }
  await controller.setUniverse([instId], '15m', instId)
  const close = controller.open(instId, '15m')
  try {
    await flush()
    const failed = controller.getSnapshot(), frame = pipeline.cached(`${instId}:15m`)
    assert.equal(calls, 1); assert.equal(failed.pending, false)
    assert.equal(frame.error, 'Price endpoint offline'); assert.equal(frame.priceStatus.state, 'error'); assert.equal(frame.priceStatus.retryAt, retryAt)
    assert.equal(failed.presented?.bars.length, 95); assert.equal(failed.presented?.priceState, 'error')
    assert.equal(failed.presented?.priceStatus?.retryAt, retryAt)
    assert.match(failed.error, /Price endpoint offline/); assert.match(failed.error, /retry at/)
    const cached = await pipeline.local(instId, '15m')
    assert.equal(cached.bars, frame.bars); assert.equal(cached.error, 'Price endpoint offline'); assert.equal(cached.priceStatus.retryAt, retryAt)
    context.mock.timers.tick(6999); await flush(); assert.equal(calls, 1)
    context.mock.timers.tick(1); await flush()
    const recovered = controller.getSnapshot()
    assert.equal(calls, 2); assert.equal(recovered.presented?.bars.length, 96); assert.equal(recovered.presented?.priceState, 'ready')
    assert.equal(recovered.error, ''); assert.equal(recovered.presented?.priceStatus?.error, undefined)
    assert.equal(recovered.presented?.priceStatus?.retryAt, undefined)
  } finally { close(); unsubscribe(); await pipeline.dispose() }
})

test('forming-only cached charts expose failed price acquisition without discarding their live quote', async () => {
  const { pipeline } = fixture([], { async ensurePrices() { throw new Error('Price history offline') } })
  try {
    await pipeline.setLive(instId, '15m', { ...candle(end() + interval), confirmed: false })
    await pipeline.prepare(instId, '15m')
    for (let count = 0; count < 8; count++) await new Promise<void>(resolve => setImmediate(resolve))
    const frame = pipeline.cached(`${instId}:15m`)
    assert.equal(frame.bars.length, 0); assert.equal(frame.liveBar.close, 101)
    assert.equal(frame.priceState, 'error'); assert.equal(frame.error, 'Price history offline')
    assert.equal(frame.priceStatus.retryAt, undefined)
  } finally { await pipeline.dispose() }
})

test('a deterministic indicator failure publishes its input and range once, then recovers only after price input changes', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Math.floor(Date.now() / interval) * interval + 1000 })
  const { pipeline, store } = fixture(), calculate = pipeline.calculate.bind(pipeline)
  const states: string[] = []
  pipeline.subscribe((frame: any) => states.push(frame.indicatorState))
  let attempts = 0, fail = true
  pipeline.calculate = (...args: any[]) => {
    attempts += 1
    if (fail) throw new Error('Indicator input rejected')
    return calculate(...args)
  }
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const state = pipeline.state(instId, '15m'), failed = pipeline.cached(state.key), reads = store.queries.length
    assert.equal(failed.priceState, 'ready'); assert.equal(failed.oiState, 'ready')
    assert.equal(failed.indicatorState, 'error'); assert.equal(failed.indicatorStatus.error, 'Indicator input rejected')
    assert.equal(failed.indicatorStatus.from, end() - 95 * interval); assert.equal(failed.indicatorStatus.through, end())
    assert.equal(failed.indicatorStatus.retryOn, 'input-change'); assert.ok(failed.indicatorStatus.inputVersion)
    const version = failed.indicatorStatus.inputVersion
    for (let count = 0; count < 4; count++) {
      await focusLatest(pipeline, instId, '15m'); await pipeline.seed(state)
      pipeline.sourceStateChanged()
    }
    context.mock.timers.tick(60_000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(attempts, 1, 'Refreshes, source reconnections and timers cannot replay a deterministic rejected input.')
    assert.equal(store.queries.length, reads, 'The cached failure also avoids repeating its source scans.')
    fail = false
    const original = store.rows.at(-1)!, corrected = { ...original, close: original.close + .25 }
    pipeline.observe([corrected], store.change(corrected))
    await finishSeed(pipeline)
    const repaired = pipeline.cached(state.key)
    assert.equal(repaired.indicatorState, 'ready'); assert.equal(repaired.indicatorStatus.error, undefined)
    assert.notEqual(repaired.indicatorStatus.inputVersion, version)
    assert.ok(states.includes('error')); assert.ok(states.lastIndexOf('loading') > states.indexOf('error'))
    const expected = new Map((buildIndicatorSeries(store.rows, interval).bars as any[]).map(value => [value.hour, value]))
    for (const value of repaired.bars) for (const field of indicatorFields) assert.equal(value[field], expected.get(value.hour)[field])
  } finally { await pipeline.dispose() }
})

test('an interrupted indicator worker publishes a recoverable failure and its replacement reproduces exact values', async () => {
  const { pipeline, store } = fixture(), calculate = pipeline.calculate.bind(pipeline)
  const failures: any[] = []
  pipeline.workerLimit = 1
  await calculate(source(1), interval)
  pipeline.subscribe((frame: any) => { if (frame.indicatorState === 'error') failures.push(frame.indicatorStatus) })
  let attempts = 0
  let stopped: Promise<void> | undefined
  pipeline.calculate = (...args: any[]) => {
    attempts += 1
    if (attempts === 1) {
      const worker = pipeline.worker, send = worker.postMessage.bind(worker)
      worker.postMessage = (message: any, ...parameters: any[]) => {
        if (message.candles) {
          // Lose an admitted request, then end its real worker after flushing
          // diagnostics so fault injection retains the complete operation log.
          stopped = stopOperationWorker(worker, 'prepared-chart')
          return
        }
        return send(message, ...parameters)
      }
    }
    const task = calculate(...args)
    return task
  }
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    const recovered = pipeline.cached(`${instId}:15m`)
    assert.equal(failures.length, 1); assert.equal(failures[0].retryOn, 'worker-recovery')
    assert.match(failures[0].error, /Worker exited/)
    assert.equal(attempts, 2); assert.equal(recovered.indicatorState, 'ready')
    assert.equal(recovered.indicatorStatus.inputVersion, failures[0].inputVersion)
    const expected = new Map((buildIndicatorSeries(store.rows, interval).bars as any[]).map(value => [value.hour, value]))
    for (const value of recovered.bars) for (const field of indicatorFields) assert.equal(value[field], expected.get(value.hour)[field])
  } finally { await stopped; await pipeline.dispose() }
})

test('repeated worker failures stop automatic recovery and a healthy worker resumes the failed range', async () => {
  const { pipeline } = fixture(), calculate = pipeline.calculate.bind(pipeline)
  let attempts = 0
  pipeline.calculate = (...args: any[]) => {
    attempts += 1
    if (attempts <= 2) throw Object.assign(new Error('Worker unavailable'), { name: 'WorkerExitError' })
    return calculate(...args)
  }
  try {
    await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
    assert.equal(attempts, 2)
    const state = pipeline.state(instId, '15m')
    await pipeline.seed(state); await focusLatest(pipeline, instId, '15m')
    assert.equal(attempts, 2); assert.equal(pipeline.cached(state.key).indicatorState, 'error')
    const other = 'ETH-USDT-SWAP'
    await pipeline.calculate(source(12).map(row => ({ ...row, instrument: other })), interval)
    for (let count = 0; count < 4; count++) await new Promise<void>(resolve => setImmediate(resolve))
    await finishSeed(pipeline)
    assert.equal(attempts, 4); assert.equal(pipeline.cached(state.key).indicatorState, 'ready')
  } finally { await pipeline.dispose() }
})

test('observed indicator warmup and mathematically undefined values are distinguished from failures', async () => {
  for (const [count, zeroVolume, reason] of [[12, false, 'insufficient-history'], [400, true, 'undefined-value']] as const) {
    const rows = source(count).map(row => zeroVolume ? { ...row, baseVolume: 0, quoteVolume: 0 } : row)
    const { pipeline } = fixture(rows)
    try {
      await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
      const frame = pipeline.cached(`${instId}:15m`)
      assert.equal(frame.indicatorState, 'unavailable'); assert.equal(frame.indicatorStatus.reason, reason)
      assert.equal(frame.indicatorStatus.error, undefined); assert.equal(frame.indicatorStatus.retryOn, undefined)
      const calls = pipeline.nextCalculation
      await focusLatest(pipeline, instId, '15m'); await finishSeed(pipeline)
      assert.equal(pipeline.nextCalculation, calls)
    } finally { await pipeline.dispose() }
  }
})

for (const direction of [-1, 1]) for (const hz of [60, 120]) test(`historical ${direction < 0 ? 'older' : 'newer'} input keeps a 192-bar margin during a held 1.5 s read at ${hz} Hz`, { timeout: 30_000 }, async () => {
  const rows = source(6000), latest = rows.at(-1)!.timestamp, target = latest - 3000 * interval
  let sourceRequests = 0, holding = false, entered = false
  const gate = deferred(), { pipeline, store } = fixture(rows, { async ensurePrices() { sourceRequests += 1; throw new Error('complete local prices must not be fetched') } })
  const read = store.candles.bind(store)
  store.candles = async query => {
    if (holding && !entered && query.order === 'desc' && query.limit === 1536) { entered = true; await gate.promise }
    return read(query)
  }
  const encoder = new ChartNotificationEncoder()
  const controller = new ChartController({
    focus: (value, id) => pipeline.setFocus(value ? { instId: value.instId, timeframe: value.timeframe, endHour: value.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: (value, id) => pipeline.localHistory(value.instId, value.timeframe, value.end ?? undefined, { focusId: id }),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  const close = controller.open(instId, '15m')
  try {
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    controller.scroll(-3000)
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    assert.equal(controller.getSnapshot().presented?.endHour, target)
    const state = pipeline.series.get(`${instId}:15m`), initial = pipeline.historyFrame(state, target).bars
    const first = initial[0].hour, last = initial.at(-1).hour
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    const check = (expected: number) => {
      const view = controller.getSnapshot(), bars = view.presented?.bars ?? []
      assert.equal(view.pending, false, `At ${expected}, the current viewport must not be pending.`)
      assert.equal(view.presented?.endHour, expected)
      assert.equal(bars.length, 96)
      for (const bar of bars) {
        assert.ok(bar.priceComplete && bar.indicatorsObserved && bar.oiObserved && bar.takerObserved)
        for (const field of indicatorFields) assert.equal(bar[field as keyof typeof bar], (oracle.get(bar.hour) as any)[field])
      }
    }
    holding = true
    let moves = 0
    while (!entered && moves < 400) {
      moves += 1; controller.scroll(direction * 2); await flush()
      check(target + direction * moves * 2 * interval)
    }
    assert.ok(entered, 'A reserve read must start before reaching the resident edge.')
    for (let frame = 0; frame < hz * 1.5; frame += 1) {
      moves += 1; controller.scroll(direction * 2); await flush()
      check(target + direction * moves * 2 * interval)
    }
    const current = target + direction * moves * 2 * interval
    const runway = direction < 0 ? (current - 95 * interval - first) / interval : (last - current) / interval
    assert.ok(runway >= 192, `A held read left only ${runway} candles of runway.`)
    gate.resolve(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    check(current)
    assert.equal(sourceRequests, 0)
  } finally { holding = false; gate.resolve(); close(); unsubscribe(); await pipeline.dispose() }
})

test('distant focus reads have two active lanes and discard superseded queued targets before IO', { timeout: 30_000 }, async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows), read = store.candles.bind(store)
  const holds = [deferred(), deferred()], started = [deferred(), deferred()]
  const operations: OperationEvent[] = [], detach = attachOperationSink(operation => operations.push(operation))
  let holding = false, reads = 0, active = 0, maxActive = 0
  const admitted: any[] = []
  store.candles = async query => {
    if (holding && query.order === 'desc' && query.limit === 1536) {
      const index = reads++
      admitted.push(query)
      active += 1; maxActive = Math.max(maxActive, active)
      try { if (index < 2) { started[index].resolve(); await holds[index].promise } } finally { active -= 1 }
    }
    return read(query)
  }
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'latest'); await pipeline.focus.task; await finishSeed(pipeline)
    holding = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[500].timestamp }, 'held-first'); await started[0].promise
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[2600].timestamp }, 'held-second'); await started[1].promise
    for (let index = 0; index < 16; index += 1) {
      const endHour = rows[(index % 2 ? 4300 : 1200) + index].timestamp
      pipeline.setFocus({ instId, timeframe: '15m', endHour }, `superseded-${index}`); await flush()
    }
    const target = rows[4400].timestamp
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'current'); await flush()
    const hydration = pipeline.localHistory(instId, '15m', target, { focusId: 'current' })
    assert.ok(pipeline.pendingFocusRead, 'Renderer hydration and backend preparation must share the waiting owner.')
    assert.equal(reads, 2, 'No obsolete queued selection enters SQLite while both lanes are held.')
    assert.equal(maxActive, 2)
    assert.ok(operations.some(operation => operation.name === 'chart.history.admission' && operation.status === 'cancelled'
      && operation.attributes?.reason === 'superseded'), 'Superseded admission is explicitly recorded.')
    holds[1].resolve(); await pipeline.focus.task; assert.ok(await hydration); await finishSeed(pipeline); await flush()
    assert.ok(reads <= 4, 'Only the latest selection and its older reserve inspection may take the released lane.')
    assert.ok(admitted.slice(2).every(query => query.from <= target - 95 * interval && query.through >= target),
      'Every subsequent read must serve the latest selected viewport.')
    assert.equal(maxActive, 2)
    const state = pipeline.series.get(`${instId}:15m`), frame = pipeline.historyFrame(state, target)
    const viewport = frame.bars.filter((bar: any) => bar.hour >= target - 95 * interval && bar.hour <= target)
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    assert.equal(viewport.length, 96)
    for (const bar of viewport) {
      assert.ok(bar.priceComplete && bar.indicatorsObserved && bar.oiObserved && bar.takerObserved)
      for (const field of indicatorFields) assert.equal(bar[field], (oracle.get(bar.hour) as any)[field])
    }
    holds[0].resolve(); await flush(); await finishSeed(pipeline)
    assert.equal(state.historyEnd, target)
    assert.ok(viewport.every((bar: any) => state.rows.has(bar.hour)), 'Late obsolete rows cannot evict the current viewport.')
  } finally { holds.forEach(hold => hold.resolve()); await pipeline.dispose(); detach() }
})

test('a 120 Hz reversal keeps exact resident windows while replay and the opposite read are held', { timeout: 30_000 }, async () => {
  const rows = source(7000), target = rows[3500].timestamp, { pipeline, store } = fixture(rows)
  const replayGate = deferred(), readGate = deferred(), flush = () => new Promise<void>(resolve => setImmediate(resolve))
  let holdReplay = false, replayHeld = false, holdRead = false, readHeld = false, sourceRequests = 0
  pipeline.history.ensurePrices = async () => { sourceRequests += 1; throw new Error('local history must not invoke the source') }
  const calculate = pipeline.calculate.bind(pipeline), read = store.candles.bind(store)
  pipeline.calculate = async (...args: any[]) => {
    if (holdReplay && !replayHeld) { replayHeld = true; await replayGate.promise }
    return calculate(...args)
  }
  store.candles = async query => {
    if (holdRead && !readHeld && query.order === 'desc' && query.limit === 1536) { readHeld = true; await readGate.promise }
    return read(query)
  }
  const encoder = new ChartNotificationEncoder(), controller = new ChartController({
    focus: (value, id) => pipeline.setFocus(value ? { instId: value.instId, timeframe: value.timeframe, endHour: value.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: (value, id) => pipeline.localHistory(value.instId, value.timeframe, value.end ?? undefined, { focusId: id }),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  const close = controller.open(instId, '15m')
  try {
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    controller.scroll((target - rows.at(-1)!.timestamp) / interval)
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    let current = target
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    const move = async (direction: number) => {
      current += direction * 2 * interval; controller.scroll(direction * 2); await flush()
      const view = controller.getSnapshot(), bars = view.presented?.bars ?? []
      assert.equal(view.pending, false); assert.equal(view.presented?.endHour, current); assert.equal(bars.length, 96)
      for (const bar of [bars[0], bars.at(-1)!]) {
        assert.ok(bar.priceComplete && bar.indicatorsObserved && bar.oiObserved && bar.takerObserved)
        for (const field of indicatorFields) assert.equal(bar[field as keyof typeof bar], (oracle.get(bar.hour) as any)[field])
      }
    }
    holdReplay = true
    for (let moves = 0; !replayHeld && moves < 700; moves += 1) await move(-1)
    assert.ok(replayHeld, 'The older extension must start a real worker replay.')
    for (let frame = 0; frame < 180; frame += 1) await move(-1)
    assert.ok(pipeline.series.get(`${instId}:15m`).active <= 4, 'A held replay must not retain obsolete focus preparation tasks.')
    assert.ok([...pipeline.focusWaits.values()].every((group: any) => group.waiters.size <= 1), 'A replay keeps only the current focus waiter.')
    replayGate.resolve(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    holdRead = true
    for (let moves = 0; !readHeld && moves < 900; moves += 1) await move(1)
    assert.ok(readHeld, 'The reversed direction must admit its own newer reserve before the edge.')
    for (let frame = 0; frame < 180; frame += 1) await move(1)
    readGate.resolve(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    assert.equal(sourceRequests, 0)
    assert.ok(pipeline.series.get(`${instId}:15m`).rows.size <= 2304)
  } finally { replayGate.resolve(); readGate.resolve(); close(); unsubscribe(); await pipeline.dispose() }
})

test('admitted reads share one replay continuation across distant focus changes', async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows)
  const entered = deferred(), release = deferred()
  pipeline.calculate = async () => { entered.resolve(); await release.promise; throw new Error('Released held replay.') }
  let running: any, then: any, continuations = 0
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[2000].timestamp }, 'first-replay')
    await entered.promise
    running = pipeline.series.get(`${instId}:15m`).calculation
    then = running.then
    running.then = function (...args: any[]) { continuations += 1; return then.apply(this, args) }
    for (let index = 0; index < 20; index += 1) {
      pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[index % 2 ? 4500 : 1000].timestamp }, `replay-owner-${index}`)
      for (let turn = 0; turn < 3; turn += 1) await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(store.queries.filter(query => query.order === 'desc' && query.limit === 1536).length >= 4,
      'The held replay must coexist with multiple completed durable admissions.')
    assert.ok(continuations <= 4, `One held replay accumulated ${continuations} continuation registrations.`)
    assert.ok([...pipeline.focusWaits.values()].every((group: any) => group.waiters.size <= 1))
  } finally {
    if (running) running.then = then
    const disposed = pipeline.dispose(); release.resolve(); await disposed
  }
})

for (const failedRead of [false, true]) test(`read finalization settles consumers despite cleanup failure${failedRead ? ' and preserves the original read failure' : ''}`, async () => {
  const { pipeline } = fixture()
  const readFailure = new Error('Injected SQLite read failure.'), trimFailure = new Error('Injected resident trim failure.')
  const trim = pipeline.trim
  const target = end() - 1000 * interval
  pipeline.prepareFocus = async () => null // Isolate the admitted read's completion from independent source preparation.
  pipeline.replaceFocus({ instId, timeframe: '15m', endHour: target }, 'read-finalizer')
  const state = pipeline.series.get(`${instId}:15m`)
  pipeline.read = async () => { if (failedRead) throw readFailure; return true }
  pipeline.trim = () => { throw trimFailure }
  let outcome: { value?: unknown; error?: unknown } | undefined, done = false
  try {
    const consumer = pipeline.focusHistoryRead(state, pipeline.focus, 256, target)
      .then((value: unknown) => { outcome = { value } }, (error: unknown) => { outcome = { error } })
    const entry = [...pipeline.focusReads][0]
    entry.done.then(() => { done = true })
    for (let turn = 0; turn < 3; turn += 1) await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(outcome, 'Cleanup must not strand the read consumer.')
    assert.equal(done, true, 'The physical-read completion barrier must settle independently of cleanup.')
    assert.equal(pipeline.focusReads.size, 0)
    if (failedRead) {
      assert.ok(outcome.error instanceof AggregateError)
      assert.deepEqual(outcome.error.errors, [readFailure, trimFailure])
    } else assert.equal(outcome.error, trimFailure)
    await consumer
  } finally { pipeline.trim = trim; await pipeline.dispose() }
})

test('closing focus cancels queued reads before IO and drains only already admitted lanes', { timeout: 30_000 }, async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows), read = store.candles.bind(store)
  const gate = deferred(), starts = [deferred(), deferred()], operations: OperationEvent[] = []
  const detach = attachOperationSink(operation => operations.push(operation))
  let holding = false, reads = 0
  store.candles = async query => {
    if (holding && query.order === 'desc' && query.limit === 1536) { const index = reads++; starts[index]?.resolve(); await gate.promise }
    return read(query)
  }
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'latest'); await pipeline.focus.task; await finishSeed(pipeline)
    holding = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[500].timestamp }, 'held-one'); await starts[0].promise
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[3000].timestamp }, 'held-two'); await starts[1].promise
    const target = rows[5000].timestamp
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'queued')
    await new Promise<void>(resolve => setImmediate(resolve))
    const queued = pipeline.focus.task
    const hydration = pipeline.localHistory(instId, '15m', target, { focusId: 'queued' })
    const window = pipeline.prepare(instId, '15m', target, 96, { focusId: 'queued' })
    assert.equal(reads, 2)
    pipeline.setFocus(null, 'closed')
    await queued
    assert.equal(await hydration, null)
    assert.equal(await window, null, 'A superseded chartWindow cannot start an independent historical read.')
    assert.equal(reads, 2)
    assert.equal(pipeline.pendingFocusRead, null)
    assert.ok(operations.some(operation => operation.name === 'chart.history.admission' && operation.status === 'cancelled'))
    const closing = pipeline.dispose()
    gate.resolve(); await closing
    assert.equal(reads, 2, 'Draining admitted reads must not start the cancelled target.')
    assert.equal(pipeline.focusReads.size, 0)
    assert.equal(pipeline.sourceTasks.size, 0)
  } finally { gate.resolve(); await pipeline.dispose(); detach() }
})

for (const direction of [-1, 1]) test(`768 sustained ${direction < 0 ? 'older' : 'newer'} inputs retain 192 bars with repeated 1.5 s reads at 120 Hz`, { timeout: 30_000 }, async () => {
  const rows = source(7000), target = rows[3500].timestamp, { pipeline, store } = fixture(rows)
  const read = store.candles.bind(store), delayed: Array<{ due: number; release: () => void }> = []
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  let holding = false, step = 0, reads = 0, sourceRequests = 0
  pipeline.history.ensurePrices = async () => { sourceRequests += 1; throw new Error('local prices must not reach the source') }
  store.candles = async query => {
    if (holding && query.order === 'desc' && query.limit === 1536) {
      reads += 1
      const gate = deferred()
      delayed.push({ due: step + 180, release: gate.resolve })
      await gate.promise
    }
    return read(query)
  }
  const encoder = new ChartNotificationEncoder(), controller = new ChartController({
    focus: (value, id) => pipeline.setFocus(value ? { instId: value.instId, timeframe: value.timeframe, endHour: value.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: (value, id) => pipeline.localHistory(value.instId, value.timeframe, value.end ?? undefined, { focusId: id }),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  const close = controller.open(instId, '15m')
  try {
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    controller.scroll((target - rows.at(-1)!.timestamp) / interval)
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    const initial = pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target).bars
    let edge = direction < 0 ? initial[0].hour : initial.at(-1).hour
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    holding = true
    for (step = 1; step <= 768; step += 1) {
      controller.scroll(direction * 2); await flush()
      const due = delayed.filter(item => item.due <= step)
      for (const item of due) { delayed.splice(delayed.indexOf(item), 1); item.release() }
      if (due.length) { await flush(); await finishSeed(pipeline); await flush() }
      for (;;) {
        const next = edge + direction * interval, bar = controller.store.knownBars(instId, '15m', [next])[0]
        if (!bar?.indicatorsObserved) break
        edge = next
      }
      const current = target + direction * step * 2 * interval
      const view = controller.getSnapshot(), bars = view.presented?.bars ?? []
      assert.equal(view.pending, false, `Input ${step} must not expose a pending viewport.`)
      assert.equal(view.presented?.endHour, current); assert.equal(bars.length, 96)
      const runway = direction < 0 ? (current - 95 * interval - edge) / interval : (edge - current) / interval
      assert.ok(runway >= 192, `Input ${step} has only ${runway} fully prepared candles of runway.`)
      for (const bar of [bars[0], bars.at(-1)!]) {
        assert.ok(bar.priceComplete && bar.indicatorsObserved && bar.oiObserved && bar.takerObserved)
        for (const field of indicatorFields) assert.equal(bar[field as keyof typeof bar], (oracle.get(bar.hour) as any)[field])
      }
    }
    assert.ok(reads >= 1 && reads <= 4, `The 1536-row read was admitted ${reads} times.`)
    assert.equal(sourceRequests, 0)
  } finally {
    holding = false
    for (const item of delayed) item.release()
    close(); unsubscribe(); await pipeline.dispose()
  }
})

test('an empty balanced read inspects locally persisted older reserve before asking the source', async () => {
  const rows = source(7000), target = rows[3000].timestamp
  const gate = deferred(), reached = deferred(), calls: Array<{ from: number; through: number }> = []
  const older = rows.slice(1721, 2201), { pipeline, store } = fixture([...older, ...rows.slice(-128)])
  try {
    pipeline.setFocus({ instId, timeframe: '15m' }, 'latest'); await pipeline.focus.task; await finishSeed(pipeline)
    pipeline.history.ensurePrices = async (_id: string, _timeframe: string, from: number, through: number) => {
      calls.push({ from, through }); reached.resolve(); await gate.promise
      return { rows: [] }
    }
    pipeline.setFocus({ instId, timeframe: '15m', endHour: target }, 'cold'); const focus = pipeline.focus.task
    await reached.promise
    const state = pipeline.series.get(`${instId}:15m`)
    assert.ok(state.rows.has(target - 1000 * interval), 'The otherwise invisible durable prefix must be admitted before source repair.')
    assert.ok(store.queries.some(query => query.order === 'desc' && query.limit === 1536
      && query.from <= target - 1279 * interval && query.through >= target + 256 * interval))
    assert.deepEqual(calls[0], { from: target - 299 * interval, through: target })
    pipeline.setFocus(null, 'hidden'); gate.resolve(); await focus
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('an independent read cannot restore an evicted A → B → A inspection after coverage', { timeout: 30_000 }, async () => {
  const rows = source(6000), { pipeline, store } = fixture(rows), a = rows[4000].timestamp, b = rows[4600].timestamp
  const coverageEntered = deferred(), coverageRelease = deferred(), returnEntered = deferred(), returnRelease = deferred()
  const coverage = store.coverage.bind(store), read = store.candles.bind(store)
  let holdCoverage = false, coverageHeld = false, holdReturn = false, returnHeld = false
  store.coverage = async () => {
    if (holdCoverage && !coverageHeld) { coverageHeld = true; coverageEntered.resolve(); await coverageRelease.promise }
    return coverage()
  }
  store.candles = async query => {
    if (holdReturn && !returnHeld && query.order === 'desc' && query.limit === 1536) { returnHeld = true; returnEntered.resolve(); await returnRelease.promise }
    return read(query)
  }
  let inspection: Promise<unknown> | undefined
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: a }, 'initial-a')
    await pipeline.focus.task; await finishSeed(pipeline)
    const state = pipeline.series.get(`${instId}:15m`)
    holdCoverage = true
    inspection = pipeline.read(state, a, 1536)
    await coverageEntered.promise
    const version = state.retentionVersion ?? 0
    pipeline.setFocus({ instId, timeframe: '15m', endHour: b }, 'b')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.ok(state.retentionVersion > version)
    assert.equal(state.rows.has(a - 1000 * interval), false)
    holdReturn = true
    pipeline.setFocus({ instId, timeframe: '15m', endHour: a }, 'return-a')
    const current = pipeline.focus.task
    await returnEntered.promise
    coverageRelease.resolve(); await inspection
    assert.ok(!state.historyReadRange || state.historyReadRange.from > a - 1000 * interval,
      'A completed independent read cannot certify rows discarded after its own retention pass.')
    returnRelease.resolve(); await current; await finishSeed(pipeline)
    const viewport = pipeline.historyFrame(state, a).bars.filter((bar: any) => bar.hour >= a - 95 * interval && bar.hour <= a)
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    assert.equal(viewport.length, 96)
    for (const bar of viewport) for (const field of indicatorFields) assert.equal(bar[field], (oracle.get(bar.hour) as any)[field])
  } finally { coverageRelease.resolve(); returnRelease.resolve(); await inspection; await pipeline.dispose() }
})

test('SQLite workers and controller preserve newer navigation while the reserve read is held', { timeout: 30_000 }, async () => {
  const rows = source(5000), target = rows[2500].timestamp, f = await sqliteFixture(rows), { pipeline, store } = f
  const gate = deferred(), flush = () => new Promise<void>(resolve => setImmediate(resolve))
  let holding = false, held = false, sourceRequests = 0
  const bounds = { instrument: instId, timeframe: '15m' as const, from: rows[0].timestamp, through: rows.at(-1)!.timestamp }
  await store.appendStatistics({ ...bounds, source: 'oi', values: rows.map(row => [row.timestamp, row.oi]) })
  await store.appendStatistics({ ...bounds, source: 'taker', values: rows.map(row => [row.timestamp, row.sell, row.buy]) })
  pipeline.history.ensurePrices = async () => { sourceRequests += 1; throw new Error('persisted prices must not reach the source') }
  const read = store.candles.bind(store)
  store.candles = async (query, priority) => {
    if (holding && !held && query.order === 'desc' && query.limit === 1536) { held = true; await gate.promise }
    return read(query, priority)
  }
  const encoder = new ChartNotificationEncoder(), controller = new ChartController({
    focus: (value, id) => pipeline.setFocus(value ? { instId: value.instId, timeframe: value.timeframe, endHour: value.end ?? undefined } : null, id),
    local: (id, timeframe) => pipeline.local(id, timeframe),
    history: (value, id) => pipeline.localHistory(value.instId, value.timeframe, value.end ?? undefined, { focusId: id }),
    universe: () => Promise.resolve(pipeline.residentFrames()),
  })
  const unsubscribe = pipeline.subscribe((frame: any) => controller.ingestPrepared(encoder.encode(frame)))
  const close = controller.open(instId, '15m')
  try {
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    controller.scroll((target - rows.at(-1)!.timestamp) / interval)
    await flush(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    const initial = pipeline.historyFrame(pipeline.series.get(`${instId}:15m`), target).bars, last = initial.at(-1).hour
    const oracle = new Map(buildIndicatorSeries(rows, interval).bars.map((bar: any) => [bar.hour, bar]))
    let moves = 0
    const move = async () => {
      moves += 1; controller.scroll(2); await flush()
      const view = controller.getSnapshot(), bars = view.presented?.bars ?? []
      assert.equal(view.pending, false); assert.equal(view.presented?.endHour, target + 2 * moves * interval); assert.equal(bars.length, 96)
      for (const bar of bars) assert.ok(bar.priceComplete && bar.indicatorsObserved && bar.oiObserved && bar.takerObserved)
      for (const bar of [bars[0], bars.at(-1)!]) {
        assert.equal(bar.oi, 5000); assert.equal(bar.buy, 70); assert.equal(bar.sell, 30)
        for (const field of indicatorFields) assert.equal(bar[field as keyof typeof bar], (oracle.get(bar.hour) as any)[field])
      }
    }
    holding = true
    while (!held && moves < 400) await move()
    assert.ok(held)
    for (let frame = 0; frame < 180; frame += 1) await move()
    assert.ok((last - (target + 2 * moves * interval)) / interval >= 192)
    gate.resolve(); await pipeline.focus.task; await finishSeed(pipeline); await flush()
    assert.equal(sourceRequests, 0)
  } finally { gate.resolve(); close(); unsubscribe(); await f.close() }
})

test('focus read and shared wait propagate even a non-Error rejection', async () => {
  const rows = source(2000), { pipeline, store } = fixture(rows)
  store.candles = async () => { throw undefined }
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[1000].timestamp }, 'failing-read')
    let rejected = false
    await pipeline.focus.task.then(() => {}, (error: unknown) => { rejected = true; assert.equal(error, undefined) })
    assert.equal(rejected, true, 'A failed SQL read must not be acknowledged as a completed admission.')
    rejected = false
    await pipeline.waitForFocus(pipeline.focus, Promise.reject(undefined)).then(() => {}, (error: unknown) => { rejected = true; assert.equal(error, undefined) })
    assert.equal(rejected, true, 'A shared failure must reach its current focus even without an Error object.')
  } finally { await pipeline.dispose() }
})

test('a drained obsolete focus read releases its pinned resident state without another request', async () => {
  const rows = source(3000), other = 'ETH-USDT-SWAP'
  const { pipeline, store } = fixture([...rows, ...rows.map(row => ({ ...row, instrument: other }))])
  const gate = deferred(), entered = deferred(), read = store.candles.bind(store)
  let held = false
  store.candles = async query => {
    if (!held && query.instrument === instId && query.order === 'desc' && query.limit === 1536) { held = true; entered.resolve(); await gate.promise }
    return read(query)
  }
  pipeline.maxSeries = 1
  try {
    pipeline.setFocus({ instId, timeframe: '15m', endHour: rows[1000].timestamp }, 'old')
    await entered.promise
    const old = [...pipeline.focusReads][0] as any
    pipeline.setFocus({ instId: other, timeframe: '15m', endHour: rows[2200].timestamp }, 'current')
    await pipeline.focus.task; await finishSeed(pipeline)
    assert.equal(pipeline.series.has(`${instId}:15m`), true, 'The actual in-flight read pins its state.')
    gate.resolve(); await old.done
    assert.equal(pipeline.series.has(`${instId}:15m`), false, 'The obsolete state is trimmed immediately after its read drains.')
    assert.equal(pipeline.series.has(`${other}:15m`), true)
  } finally { gate.resolve(); await pipeline.dispose() }
})
