import assert from 'node:assert/strict'
import test from 'node:test'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { buildIndicatorSeries } from '../electron/services/indicators.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import { PreparedChartStore } from './chart-series-store.ts'

const step = 900_000
const end = () => Math.floor(Date.now() / step) * step - step
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 8000
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'Candidate preparation did not settle.')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const rowsFor = (instrument: string, count = 400) => Array.from({ length: count }, (_, index) => ({
  instrument, timeframe: '15m', timestamp: end() - (count - index - 1) * step,
  open: 100 + index / 10, high: 102 + index / 10, low: 99 + index / 10, close: 101 + index / 10,
  volume: 10, baseVolume: 1, quoteVolume: 100 + index, confirmed: true,
  oi: 500, buy: 6, sell: 4, statisticsVersion: 11,
}))
class CandidateStore {
  rows: any[]
  queries: any[] = []
  checkpoints: any[] = []
  constructor(rows: any[]) { this.rows = rows }
  async candles(query: any) {
    this.queries.push(query)
    let rows = this.rows.filter(row => row.instrument === query.instrument && row.timeframe === query.timeframe
      && row.timestamp >= (query.from ?? 0) && row.timestamp <= (query.through ?? Infinity)).toSorted((a, b) => a.timestamp - b.timestamp)
    if (query.order === 'desc') rows.reverse()
    return (query.limit ? rows.slice(0, query.limit) : rows).map(row => ({ ...row }))
  }
  async coverage(instrument: string, timeframe: string) {
    const rows = this.rows.filter(row => row.instrument === instrument && row.timeframe === timeframe)
    return { first: rows[0]?.timestamp ?? null, last: rows.at(-1)?.timestamp ?? null, count: rows.length }
  }
  candleRevision() { return 0 }
  async priceWatermark() { return '0' }
  async readIndicatorCheckpoint(query: any) {
    return this.checkpoints.filter(value => value.instrument === query.instrument && value.timeframe === query.timeframe
      && value.formulaVersion === query.formulaVersion && value.timestamp <= query.before).at(-1) ?? null
  }
  async writeIndicatorCheckpoint(checkpoint: any) { this.checkpoints.push(structuredClone(checkpoint)); return true }
}
const fixture = (rows: any[], history: any = {}) => {
  const store = new CandidateStore(rows)
  const pipeline: any = new PreparedChartPipeline({ store: store as any, history, normalize: value => value, revision: () => 0, instrument: () => undefined })
  pipeline.workerLimit = 2; pipeline.candidateLimit = 2
  return { store, pipeline }
}
const ready = (pipeline: any, id: string) => pipeline.cached(`${id}:15m`)?.indicatorState === 'ready'
const settled = (pipeline: any) => pipeline.candidateTasks.size === 0 && pipeline.candidateQueue.length === 0 && pipeline.liveSeeds.size === 0

test('list admission immediately returns while every unselected current-timeframe candidate prepares in bounded compact storage', async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `C${index}-USDT-SWAP`), gate = deferred()
  const rows = ids.flatMap(id => rowsFor(id)), { pipeline, store } = fixture(rows), frames: any[] = []
  const read = store.candles.bind(store)
  let active = 0, peak = 0, initialReads = 0
  store.candles = async query => {
    if (query.order !== 'desc') return read(query)
    active += 1; peak = Math.max(peak, active); initialReads += 1
    try { await gate.promise; return await read(query) } finally { active -= 1 }
  }
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    assert.deepEqual(pipeline.setUniverse(ids, '15m'), { frames: [] })
    assert.equal(initialReads, 0, 'The synchronous universe response cannot wait for SQLite or calculation.')
    await waitFor(() => initialReads === 2)
    assert.equal(pipeline.series.size, 0)
    gate.resolve()
    await waitFor(() => ids.every(id => ready(pipeline, id)) && settled(pipeline))
    assert.equal(peak, 2); assert.equal(initialReads, ids.length)
    assert.equal(pipeline.series.size, 0, 'Candidates never allocate a deep-history LRU entry.')
    assert.equal(pipeline.liveStates.size, ids.length)
    assert.ok([...pipeline.liveStates.values()].every((state: any) => state.rows.size <= 128))
    assert.ok(store.queries.every(query => query.timeframe === '15m'))
    const oracle: any[] = buildIndicatorSeries(rowsFor(ids[0]), step).bars
    for (const id of ids) {
      const frame = frames.findLast(frame => frame.instId === id && frame.indicatorState === 'ready')
      assert.equal(frame.bars.length, 96); assert.equal(frame.priceState, 'ready')
      for (const [index, bar] of frame.bars.entries()) for (const field of ['ema', 'vwap', 'bollUpper', 'rsi6', 'rsi12', 'rsi24', 'roc', 'maroc', 'atrPercent', 'bbw']) {
        assert.equal(bar[field], oracle.at(-96 + index)?.[field], `${id} ${field} at ${bar.hour}`)
      }
    }
    const reads = store.queries.length, calculations = pipeline.nextCalculation
    assert.equal(pipeline.setUniverse(ids.toReversed(), '15m').frames.length, ids.length)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations)
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('optional statistics settle independently in bounded lanes while focus changes preserve every candidate consumer', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `STATS${index}-USDT-SWAP`), oi = deferred(), taker = deferred()
  const calls: any[] = [], active = { oi: 0, taker: 0 }, peak = { oi: 0, taker: 0 }
  const rows = ids.flatMap(id => rowsFor(id)).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const { pipeline } = fixture(rows, {
    async ensureStatistics(instrument: string, _timeframe: string, from: number, through: number, _priority: string, signal: AbortSignal, source: 'oi' | 'taker') {
      calls.push({ instrument, source, signal }); active[source] += 1; peak[source] = Math.max(peak[source], active[source])
      try {
        await (source === 'oi' ? oi : taker).promise
        return { rows: rowsFor(instrument).filter(row => row.timestamp >= from && row.timestamp <= through)
          .map(row => source === 'oi' ? { ...row, buy: null, sell: null, statisticsVersion: 9 } : { ...row, oi: null, statisticsVersion: 10 }) }
      } finally { active[source] -= 1 }
    },
  })
  try {
    pipeline.setUniverse(ids, '15m')
    await waitFor(() => ids.every(id => ready(pipeline, id)) && settled(pipeline))
    assert.equal(calls.length, 4)
    pipeline.setFocus({ instId: ids[0], timeframe: '15m' }, 'first')
    await pipeline.local(ids[0], '15m', { focusId: 'first' })
    pipeline.setFocus({ instId: ids[1], timeframe: '15m' }, 'second')
    pipeline.setFocus(null, 'hidden')
    assert.ok(calls.every(call => !call.signal.aborted))
    assert.equal(calls.filter(call => call.instrument === ids[0]).length, 2, 'Selection shares existing candidate sources.')
    oi.resolve()
    await waitFor(() => ids.every(id => pipeline.cached(`${id}:15m`)?.oiState === 'ready'))
    assert.ok(ids.every(id => pipeline.cached(`${id}:15m`).takerState === 'loading'))
    taker.resolve()
    await waitFor(() => ids.every(id => pipeline.cached(`${id}:15m`)?.takerState === 'ready') && pipeline.sourceTasks.size === 0)
    assert.deepEqual(peak, { oi: 2, taker: 2 })
    assert.equal(calls.length, ids.length * 2)
  } finally { oi.resolve(); taker.resolve(); await pipeline.dispose() }
})

test('timeframe changes and removal retire queued and active candidate sources without touching market subscriptions', async () => {
  const calls: any[] = [], ids = Array.from({ length: 7 }, (_, index) => `CANCEL${index}-USDT-SWAP`)
  const acquire = async (instrument: string, timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal, source = 'candles') => {
    calls.push({ instrument, timeframe, source, signal })
    await new Promise((_resolve, reject) => signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const { pipeline } = fixture([], { ensurePrices: acquire, ensureStatistics: acquire })
  try {
    pipeline.setRealtimeSubscriptions(ids.flatMap(instId => ['5m', '15m', '1H'].map(timeframe => ({ instId, timeframe }))))
    pipeline.setUniverse(ids, '15m')
    await waitFor(() => calls.length === 6)
    pipeline.setUniverse([ids[0]], '5m')
    await waitFor(() => calls.filter(call => call.timeframe === '5m').length === 3)
    assert.ok(calls.filter(call => call.timeframe === '15m').every(call => call.signal.aborted))
    assert.equal(calls.filter(call => call.timeframe === '15m' && call.source === 'candles').length, 2)
    pipeline.setUniverse([], '5m')
    await waitFor(() => pipeline.sourceTasks.size === 0 && settled(pipeline))
    assert.ok(calls.every(call => call.signal.aborted))
    assert.equal(pipeline.sourceAttempts.size, 0)
    assert.equal(pipeline.realtimeKeys.size, ids.length * 3)
  } finally { await pipeline.dispose() }
})

test('remove and readd during an admitted local read shares durable facts but only the new candidate continues', async () => {
  const id = 'ABA-USDT-SWAP', hold = deferred(), { pipeline, store } = fixture(rowsFor(id))
  const read = store.candles.bind(store)
  let admitted = 0
  store.candles = async query => { if (query.order === 'desc') { admitted += 1; await hold.promise }; return read(query) }
  try {
    pipeline.setUniverse([id], '15m')
    await waitFor(() => admitted === 1)
    const old = pipeline.universe.get(`${id}:15m`)
    pipeline.setUniverse([], '15m'); pipeline.setUniverse([id], '15m')
    assert.notEqual(pipeline.universe.get(`${id}:15m`), old)
    hold.resolve()
    await waitFor(() => ready(pipeline, id) && settled(pipeline))
    assert.equal(admitted, 1)
    assert.equal(pipeline.nextCalculation, 1)
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('retired candidates detach from a still-focused shared source and release their preparation slots', async () => {
  const a = 'SHARED-USDT-SWAP', b = 'NEXT-USDT-SWAP'
  let signalA: AbortSignal | undefined
  const { pipeline, store } = fixture([], {
    async ensurePrices(id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) {
      if (id === a) {
        signalA = signal
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      } else store.rows.push(...rowsFor(b))
    },
  })
  try {
    pipeline.setUniverse([a], '15m')
    await waitFor(() => signalA !== undefined)
    pipeline.setFocus({ instId: a, timeframe: '15m' }, 'keep-source')
    pipeline.setUniverse([], '15m'); pipeline.setUniverse([a], '15m')
    await new Promise(resolve => setImmediate(resolve))
    pipeline.setUniverse([b], '15m')
    await waitFor(() => ready(pipeline, b) && settled(pipeline))
    assert.equal(signalA?.aborted, false, 'Focus still owns the source after its candidate waiters detach.')
    pipeline.setFocus(null, 'hide')
    await waitFor(() => pipeline.sourceTasks.size === 0)
    assert.equal(signalA?.aborted, true)
  } finally { await pipeline.dispose() }
})

test('selection arriving during a candidate replay receives its native results without a second calculation', async () => {
  const id = 'SELECT-DURING-REPLAY-USDT-SWAP', gate = deferred(), entered = deferred(), { pipeline } = fixture(rowsFor(id))
  const calculate = pipeline.calculate.bind(pipeline)
  let calculations = 0
  pipeline.calculate = async (...args: any[]) => { calculations += 1; entered.resolve(); await gate.promise; return calculate(...args) }
  try {
    pipeline.setUniverse([id], '15m')
    await entered.promise
    pipeline.setFocus({ instId: id, timeframe: '15m' }, 'selected')
    await pipeline.local(id, '15m', { focusId: 'selected' })
    gate.resolve()
    await waitFor(() => ready(pipeline, id) && settled(pipeline))
    assert.equal(calculations, 1)
    assert.ok([...pipeline.series.get(`${id}:15m`).rows.keys()].every(hour => pipeline.series.get(`${id}:15m`).indicators.has(hour)))
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a candidate admitted during a list read keeps one generation through renderer readiness', async () => {
  const id = 'GENERATION-USDT-SWAP', gate = deferred(), entered = deferred(), { pipeline, store } = fixture(rowsFor(id))
  const renderer = new PreparedChartStore(), read = store.candles.bind(store), generations: number[] = []
  let first = true
  store.candles = async query => {
    if (first && query.order === 'desc') { first = false; entered.resolve(); await gate.promise }
    return read(query)
  }
  renderer.setUniverse([id], '15m')
  pipeline.subscribe((frame: any) => { generations.push(frame.generation); renderer.ingestLatest(frame) })
  let projection: Promise<unknown> | undefined
  try {
    projection = pipeline.projectListSeries(id, '15m')
    await entered.promise
    pipeline.setUniverse([id], '15m')
    await waitFor(() => ready(pipeline, id) && settled(pipeline))
    gate.resolve(); await projection
    await waitFor(() => renderer.window(id, '15m')?.indicatorState === 'ready')
    assert.ok(generations.every(generation => generation === generations[0]), 'Read admission never changes the canonical input generation.')
  } finally { gate.resolve(); await projection; await pipeline.dispose() }
})

test('candidate quote leases expire without core admission or a repeated immediate timer', async context => {
  const now = Math.floor(Date.now() / step) * step + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const id = 'QUIET-USDT-SWAP', entered = deferred()
  let sources = 0
  const { pipeline } = fixture(rowsFor(id), {
    async ensurePrices(_id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) {
      sources += 1; if (sources === 2) entered.resolve()
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  pipeline.streaming = () => true
  const flush = async () => { for (let index = 0; index < 10; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    pipeline.setUniverse([id], '15m')
    await flush(); while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()]); await flush()
    pipeline.setUniverse([id, 'SLOW1-USDT-SWAP', 'SLOW2-USDT-SWAP'], '15m')
    await entered.promise
    await pipeline.setLive(id, '15m', { ...rowsFor(id).at(-1), timestamp: end() + step, confirmed: false })
    assert.equal(pipeline.cached(`${id}:15m`).realtimeState, 'live')
    context.mock.timers.tick(30_000); await flush()
    assert.equal(pipeline.cached(`${id}:15m`).realtimeState, 'stale')
    assert.equal(pipeline.candidateTasks.size, 2, 'Slow native sources still own both core slots.')
    assert.ok(pipeline.candidateTimerAt > Date.now() + 1000)
  } finally { await pipeline.dispose(); context.mock.timers.reset() }
})

test('a healthy calculation recovers a compact candidate after its automatic worker retry is exhausted', async () => {
  const failed = 'FAILED-USDT-SWAP', healthy = 'HEALTHY-USDT-SWAP', { pipeline } = fixture([...rowsFor(failed), ...rowsFor(healthy)])
  const calculate = pipeline.calculate.bind(pipeline)
  let attempts = 0
  pipeline.calculate = async (rows: any[], ...args: any[]) => {
    if (rows[0].instrument === failed && ++attempts <= 2) throw Object.assign(new Error('Worker exited'), { code: 'PREPARED_CHART_WORKER_UNAVAILABLE' })
    return calculate(rows, ...args)
  }
  try {
    pipeline.setUniverse([failed], '15m')
    await waitFor(() => attempts === 2 && settled(pipeline))
    assert.equal(pipeline.cached(`${failed}:15m`).indicatorState, 'error')
    assert.equal(pipeline.series.size, 0)
    pipeline.setUniverse([failed, healthy], '15m')
    await waitFor(() => ready(pipeline, failed) && ready(pipeline, healthy) && settled(pipeline))
    assert.equal(attempts, 3)
    assert.equal(pipeline.series.size, 0)
  } finally { await pipeline.dispose() }
})

test('retiring a candidate during recursive replay cannot start another chunk or publish obsolete readiness', async () => {
  const id = 'REPLAY-USDT-SWAP', gate = deferred(), { pipeline } = fixture(rowsFor(id, 3500))
  const calculate = pipeline.calculate.bind(pipeline), frames: any[] = []
  let calculations = 0
  pipeline.calculate = async (...args: any[]) => { calculations += 1; await gate.promise; return calculate(...args) }
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setUniverse([id], '15m')
    await waitFor(() => calculations === 1)
    pipeline.setUniverse([], '15m')
    frames.length = 0; gate.resolve()
    await waitFor(() => settled(pipeline))
    assert.equal(calculations, 1)
    assert.equal(frames.length, 0)
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('crossing a candle boundary during preparation retains a refresh for the new confirmed slot', async context => {
  const now = Math.floor(Date.now() / step) * step + step - 10
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const id = 'BOUNDARY-USDT-SWAP', gate = deferred(), entered = deferred()
  let repairs = 0
  const { pipeline, store } = fixture(rowsFor(id), { async ensurePrices() { repairs += 1 } })
  const calculate = pipeline.calculate.bind(pipeline)
  pipeline.calculate = async (...args: any[]) => { entered.resolve(); await gate.promise; return calculate(...args) }
  try {
    pipeline.setUniverse([id], '15m')
    await entered.promise
    context.mock.timers.tick(1011)
    store.rows.push(rowsFor(id, 401).at(-1))
    gate.resolve()
    // Use real immediate turns while worker IO proceeds under the mocked clock.
    const deadline = performance.now() + 4000
    while (!(settled(pipeline) && pipeline.cached(`${id}:15m`)?.endHour === end())) {
      assert.ok(performance.now() < deadline)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(repairs, 1)
    assert.equal(pipeline.cached(`${id}:15m`).priceState, 'ready')
    assert.equal(pipeline.cached(`${id}:15m`).indicatorState, 'ready')
  } finally { gate.resolve(); await pipeline.dispose(); context.mock.timers.reset() }
})

test('warming beyond history capacity preserves the selected historical reserve and each compact latest frame', async () => {
  const history = 'HISTORY-USDT-SWAP', ids = Array.from({ length: 15 }, (_, index) => `POOL${index}-USDT-SWAP`)
  const canonical = rowsFor(history, 2000), { pipeline } = fixture([...canonical, ...ids.flatMap(id => rowsFor(id))])
  try {
    const target = canonical[800].timestamp
    await pipeline.localHistory(history, '15m', target)
    await waitFor(() => pipeline.liveSeeds.size === 0)
    const state = pipeline.series.get(`${history}:15m`), resident = [...state.rows.keys()]
    pipeline.setUniverse(ids, '15m')
    await waitFor(() => ids.every(id => ready(pipeline, id)) && settled(pipeline))
    assert.equal(pipeline.series.size, 1)
    assert.equal(state.historyEnd, target); assert.deepEqual([...state.rows.keys()], resident)
    assert.ok(ids.every(id => pipeline.cached(`${id}:15m`).bars.length === 96))
    assert.ok([...pipeline.liveStates.values()].every((state: any) => state.rows.size <= 128))
  } finally { await pipeline.dispose() }
})

test('a stationary historical reserve never reacquires statistics for an absent offscreen candle', async context => {
  const now = Math.floor(Date.now() / step) * step + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const id = 'RESERVE-GAP-USDT-SWAP', canonical = rowsFor(id, 2000), target = canonical[1500].timestamp, absent = canonical[1100]
  const calls: any[] = []
  const { pipeline, store } = fixture(canonical.filter(row => row.timestamp !== absent.timestamp), {
    async ensureStatistics(_id: string, _timeframe: string, from: number, through: number, _priority: string, _signal: AbortSignal, source: string) {
      calls.push({ from, through, source })
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    await pipeline.localHistory(id, '15m', target)
    while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()])
    const state = pipeline.series.get(`${id}:15m`)
    assert.ok(state.rows.has(absent.timestamp - step)); assert.ok(state.rows.has(absent.timestamp + step))
    assert.equal(state.rows.has(absent.timestamp), false)
    const reads = store.queries.length
    for (let turn = 0; turn < 4; turn++) { context.mock.timers.tick(1001); await flush() }
    assert.equal(calls.length, 0, 'Offscreen gaps do not own statistic consumers until their candle is resident.')
    assert.equal(store.queries.length, reads)
    // A later durable price restores only this native sample. Its statistics
    // are then primed without scrolling or re-fetching already complete runs.
    const arrived = { ...absent, oi: null, buy: null, sell: null, statisticsVersion: null }
    store.rows.push(arrived); store.rows.sort((left, right) => left.timestamp - right.timestamp)
    pipeline.observe([arrived], new Map())
    await flush()
    context.mock.timers.tick(1001); await flush()
    await Promise.all([...pipeline.sourceTasks.values()].map((job: any) => job.task))
    assert.deepEqual(calls.toSorted((left, right) => left.source.localeCompare(right.source)), [
      { from: absent.timestamp, through: absent.timestamp, source: 'oi' },
      { from: absent.timestamp, through: absent.timestamp, source: 'taker' },
    ])
    assert.equal(state.rows.get(absent.timestamp).oi, 500)
    assert.equal(state.rows.get(absent.timestamp).buy, 6)
  } finally { await pipeline.dispose(); context.mock.timers.reset() }
})

test('candidate replay stays ready while production list projections and stale-tail source reads overlap', async () => {
  const { seedInstrumentNavigationBenchmark } = await import(new URL('../electron/e2e-fixtures.js', import.meta.url).href)
  const root = await mkdtemp(join(tmpdir(), 'perp-candidate-overlap-')), store = await MarketStore.open(root)
  const service: any = new MarketService(store, () => ({ ...DEFAULT_PREFERENCES, chartTimeframe: '15m' }),
    async () => new Response(JSON.stringify({ code: '0', data: [] })), false)
  const pipeline = service.preparedCharts
  let admitted = ''
  const unsubscribe = service.subscribeMarket(() => {
    const ids = service.listRowsFor('15m').map((row: any) => row.instId).sort()
    if (!ids.length || admitted === ids.join(',')) return
    admitted = ids.join(',')
    service.setChartUniverse(ids, '15m', ids[0]).catch(() => {})
  })
  try {
    const fixture = await seedInstrumentNavigationBenchmark(store, service)
    await service.ensureListTimeframe('15m')
    const ids = fixture.instIds.toSorted()
    await service.setChartUniverse(ids, '15m', ids[0])
    pipeline.setFocus({ instId: ids[0], timeframe: '15m' }, 'selected')
    await pipeline.local(ids[0], '15m', { focusId: 'selected' })
    await waitFor(() => ids.every((id: string) => ready(pipeline, id)) && settled(pipeline)).catch(error => {
      console.error(JSON.stringify({ tasks: pipeline.candidateTasks.size, seeds: pipeline.liveSeeds.size, sources: pipeline.sourceTasks.size,
        states: ids.map((id: string) => { const key = `${id}:15m`, live = pipeline.liveStates.get(key), state = pipeline.series.get(key); return {
          id, status: pipeline.cached(key)?.indicatorState, frameGeneration: pipeline.cached(key)?.generation,
          live: live && { rows: live.rows.size, indicators: live.indicators.size, generation: live.generation, priceVersion: live.priceVersion, last: live.indicatorState?.lastTimestamp, latest: live.latestHour, calculating: Boolean(live.calculation), failures: [...live.indicatorFailures?.values() ?? []] },
          resident: state && { rows: state.rows.size, indicators: state.indicators.size, generation: state.generation, priceVersion: state.priceVersion, last: state.indicatorState?.lastTimestamp, calculating: Boolean(state.calculation) },
        } }) }))
      throw error
    })
    assert.ok(ids.every((id: string) => pipeline.cached(`${id}:15m`).bars.every((bar: any) => bar.indicatorsObserved)))
  } finally { unsubscribe(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
