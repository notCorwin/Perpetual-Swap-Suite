import assert from 'node:assert/strict'
import test from 'node:test'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { buildIndicatorSeries } from '../electron/services/indicators.js'
import { PreparedChartStore } from './chart-series-store.ts'

const periods = ['5m', '15m', '1H'] as const
type Period = typeof periods[number]
const intervalFor = (timeframe: Period) => ({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })[timeframe]
const step = intervalFor('15m')
const end = (timeframe: Period = '15m') => { const interval = intervalFor(timeframe); return Math.floor(Date.now() / interval) * interval - interval }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 8000
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'Candidate preparation did not settle.')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const rowsFor = (instrument: string, count = 400, timeframe: Period = '15m') => Array.from({ length: count }, (_, index) => ({
  instrument, timeframe, timestamp: end(timeframe) - (count - index - 1) * intervalFor(timeframe),
  open: 100 + index / 10, high: 102 + index / 10, low: 99 + index / 10, close: 101 + index / 10,
  volume: 10, baseVolume: 1, quoteVolume: 100 + index, confirmed: true,
  oi: 500, buy: 6, sell: 4, statisticsVersion: 11,
}))
const allRowsFor = (instrument: string, count = 400) => periods.flatMap(timeframe => rowsFor(instrument, count, timeframe))
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
    const rows = this.rows.filter(row => row.instrument === instrument && row.timeframe === timeframe).toSorted((left, right) => left.timestamp - right.timestamp)
    return { first: rows[0]?.timestamp ?? null, last: rows.at(-1)?.timestamp ?? null, count: rows.length }
  }
  candleRevision() { return 0 }
  async priceWatermark() { return '0' }
  async readIndicatorCheckpoint(query: any) {
    return this.checkpoints.filter(value => value.instrument === query.instrument && value.timeframe === query.timeframe
      && value.formulaVersion === query.formulaVersion && value.timestamp <= query.before).toSorted((left, right) => left.timestamp - right.timestamp).at(-1) ?? null
  }
  async writeIndicatorCheckpoint(checkpoint: any) { this.checkpoints.push(structuredClone(checkpoint)); return true }
}
const fixture = (rows: any[], history: any = {}) => {
  const store = new CandidateStore(rows)
  const pipeline: any = new PreparedChartPipeline({ store: store as any, history, normalize: value => value, revision: () => 0, instrument: () => undefined })
  pipeline.workerLimit = 2; pipeline.candidateLimit = 2
  return { store, pipeline }
}
const ready = (pipeline: any, id: string, timeframe: Period = '15m') => pipeline.cached(`${id}:${timeframe}`)?.indicatorState === 'ready'
const allReady = (pipeline: any, ids: string[]) => ids.every(id => periods.every(timeframe => ready(pipeline, id, timeframe)))
const settled = (pipeline: any) => pipeline.candidateTasks.size === 0 && pipeline.candidateQueue.length === 0 && pipeline.liveSeeds.size === 0

test('resident frame reads do not admit candidates, hydrate local rows or start calculations', async () => {
  const { pipeline, store } = fixture(allRowsFor('RESIDENT-USDT-SWAP'))
  try {
    assert.deepEqual(pipeline.residentFrames(), { frames: [] })
    assert.deepEqual(pipeline.residentFrames(), { frames: [] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.queries.length, 0)
    assert.equal(pipeline.nextCalculation, 0)
    assert.equal(pipeline.liveStates.size, 0)
    assert.equal(pipeline.series.size, 0)
    assert.equal(pipeline.universe.size, 0)
    assert.equal(pipeline.focusKey, null)
  } finally { await pipeline.dispose() }
})

test('list admission immediately returns while all periods of every unselected candidate prepare in bounded compact storage', async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `C${index}-USDT-SWAP`), gate = deferred()
  const rows = ids.flatMap(id => allRowsFor(id)), { pipeline, store } = fixture(rows), frames: any[] = []
  const read = store.candles.bind(store)
  let active = 0, peak = 0, initialReads = 0
  store.candles = async query => {
    if (query.order !== 'desc') return read(query)
    active += 1; peak = Math.max(peak, active); initialReads += 1
    try { await gate.promise; return await read(query) } finally { active -= 1 }
  }
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setUniverse(ids)
    assert.deepEqual(pipeline.residentFrames(), { frames: [] })
    assert.equal(initialReads, 0, 'The synchronous universe response cannot wait for SQLite or calculation.')
    await waitFor(() => initialReads === 2)
    assert.equal(pipeline.series.size, 0)
    gate.resolve()
    await waitFor(() => allReady(pipeline, ids) && settled(pipeline))
    assert.equal(peak, 2); assert.equal(initialReads, ids.length * periods.length)
    assert.equal(pipeline.series.size, 0, 'Candidates never allocate a deep-history LRU entry.')
    assert.equal(pipeline.liveStates.size, ids.length * periods.length)
    assert.ok([...pipeline.liveStates.values()].every((state: any) => state.rows.size <= 128))
    assert.deepEqual([...new Set(store.queries.map(query => query.timeframe))].sort(), [...periods].sort())
    for (const id of ids) for (const timeframe of periods) {
      const oracle: any[] = buildIndicatorSeries(rowsFor(id, 400, timeframe), intervalFor(timeframe)).bars
      const frame = frames.findLast(frame => frame.instId === id && frame.timeframe === timeframe && frame.indicatorState === 'ready')
      assert.equal(frame.bars.length, 96); assert.equal(frame.priceState, 'ready')
      for (const [index, bar] of frame.bars.entries()) for (const field of ['ema', 'vwap', 'bollUpper', 'rsi6', 'rsi12', 'rsi24', 'roc', 'maroc', 'atrPercent', 'bbw']) {
        assert.equal(bar[field], oracle.at(-96 + index)?.[field], `${id} ${timeframe} ${field} at ${bar.hour}`)
      }
    }
    const reads = store.queries.length, calculations = pipeline.nextCalculation
    const resident = pipeline.residentFrames().frames
    assert.equal(resident.length, ids.length * periods.length)
    pipeline.setUniverse(ids.toReversed())
    assert.deepEqual(new Set(pipeline.residentFrames().frames), new Set(resident))
    pipeline.residentFrames(); pipeline.residentFrames()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.queries.length, reads); assert.equal(pipeline.nextCalculation, calculations)
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('optional statistics settle independently in bounded lanes while focus changes preserve every candidate consumer', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `STATS${index}-USDT-SWAP`), oi = deferred(), taker = deferred()
  const calls: any[] = [], active = { oi: 0, taker: 0 }, peak = { oi: 0, taker: 0 }
  const rows = ids.flatMap(id => allRowsFor(id)).map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null }))
  const { pipeline } = fixture(rows, {
    async ensureStatistics(instrument: string, timeframe: Period, from: number, through: number, _priority: string, signal: AbortSignal, source: 'oi' | 'taker') {
      calls.push({ instrument, timeframe, source, signal }); active[source] += 1; peak[source] = Math.max(peak[source], active[source])
      try {
        await (source === 'oi' ? oi : taker).promise
        return { rows: rowsFor(instrument, 400, timeframe).filter(row => row.timestamp >= from && row.timestamp <= through)
          .map(row => source === 'oi' ? { ...row, buy: null, sell: null, statisticsVersion: 9 } : { ...row, oi: null, statisticsVersion: 10 }) }
      } finally { active[source] -= 1 }
    },
  })
  try {
    pipeline.setUniverse(ids)
    await waitFor(() => allReady(pipeline, ids) && settled(pipeline))
    assert.equal(calls.length, 4)
    pipeline.setFocus({ instId: ids[0], timeframe: '5m' }, 'first')
    await pipeline.local(ids[0], '5m')
    pipeline.setFocus({ instId: ids[0], timeframe: '15m' }, 'second')
    pipeline.setFocus(null, 'hidden')
    assert.ok(calls.every(call => !call.signal.aborted))
    assert.equal(calls.filter(call => call.instrument === ids[0] && call.timeframe === '5m').length, 2, 'Selection shares existing candidate sources.')
    oi.resolve()
    await waitFor(() => ids.every(id => periods.every(timeframe => pipeline.cached(`${id}:${timeframe}`)?.oiState === 'ready')))
    assert.ok(ids.every(id => periods.every(timeframe => pipeline.cached(`${id}:${timeframe}`).takerState === 'loading')))
    taker.resolve()
    await waitFor(() => ids.every(id => periods.every(timeframe => pipeline.cached(`${id}:${timeframe}`)?.takerState === 'ready')) && pipeline.sourceTasks.size === 0)
    assert.deepEqual(peak, { oi: 2, taker: 2 })
    assert.equal(calls.length, ids.length * periods.length * 2)
  } finally { oi.resolve(); taker.resolve(); await pipeline.dispose() }
})

test('a latest candidate keeps selected one-slot statistics repairs at its lagging left edge after focus changes', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Math.floor(Date.now() / step) * step + 1000 })
  const id = 'LAGGING-EDGE-USDT-SWAP', other = 'NEXT-FOCUS-USDT-SWAP', oi = deferred(), taker = deferred()
  const canonical = rowsFor(id).slice(0, -1), latest = canonical.at(-1)!.timestamp, edge = canonical.at(-96)!
  const calls: Array<{ instrument: string; source: string; from: number; through: number; signal: AbortSignal }> = []
  const rows = canonical.map(row => row.timestamp === edge.timestamp
    ? { ...row, oi: null, buy: null, sell: null, statisticsVersion: null } : row)
  const { pipeline, store } = fixture([...rows, ...periods.filter(timeframe => timeframe !== '15m').flatMap(timeframe => rowsFor(id, 400, timeframe)), ...allRowsFor(other)], {
    async ensureStatistics(instrument: string, _timeframe: string, from: number, through: number, _priority: string, signal: AbortSignal, source: string) {
      calls.push({ instrument, source, from, through, signal })
      await (source === 'oi' ? oi : taker).promise
      signal.throwIfAborted()
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through)
        .map(row => source === 'oi' ? { ...row, buy: null, sell: null, statisticsVersion: 9 } : { ...row, oi: null, statisticsVersion: 10 }) }
    },
  })
  const edgeCalls = () => calls.filter(call => call.instrument === id && call.from === edge.timestamp && call.through === edge.timestamp)
  try {
    // The displayed latest window trails the clock by one native candle. Its
    // left edge falls outside the clock-aligned viewport; no history is opened.
    assert.equal(latest, end() - step); assert.equal(edge.timestamp, end() - 96 * step)
    pipeline.setFocus({ instId: id, timeframe: '15m' }, 'original-selection')
    await pipeline.local(id, '15m')
    await waitFor(() => ready(pipeline, id) && settled(pipeline) && edgeCalls().length === 2)
    assert.equal(pipeline.universe.size, 0, 'The selected focus starts both one-slot repairs before candidate admission.')
    assert.deepEqual(edgeCalls().map(call => call.source).toSorted(), ['oi', 'taker'])
    const originalRepairs = edgeCalls(), initial = pipeline.cached(`${id}:15m`)
    assert.equal(initial.endHour, latest); assert.equal(initial.bars[0].hour, edge.timestamp)
    assert.equal(initial.bars[0].oiObserved, false); assert.equal(initial.bars[0].takerObserved, false)

    pipeline.setUniverse([id, other])
    await waitFor(() => allReady(pipeline, [id, other]) && settled(pipeline))
    assert.equal(edgeCalls().length, 2, 'Candidate warming reuses the active one-slot repairs.')
    const reads = store.queries.filter(query => query.instrument === id).length
    pipeline.setFocus({ instId: other, timeframe: '15m' }, 'next-selection')
    await pipeline.local(other, '15m')
    for (const repair of originalRepairs) assert.equal(repair.signal.aborted, false, `${repair.source} repair still belongs to the original latest candidate.`)

    oi.resolve()
    await waitFor(() => pipeline.cached(`${id}:15m`)?.oiState === 'ready')
    assert.equal(pipeline.cached(`${id}:15m`).takerState, 'loading')
    taker.resolve()
    await waitFor(() => pipeline.cached(`${id}:15m`)?.takerState === 'ready' && pipeline.sourceTasks.size === 0)
    const repaired = pipeline.cached(`${id}:15m`)
    assert.equal(repaired.endHour, latest); assert.equal(repaired.bars.length, 96)
    assert.equal(repaired.indicatorState, 'ready'); assert.equal(repaired.oiState, 'ready')
    assert.deepEqual(repaired.bars.map((bar: any) => [bar.hour, bar.oi, bar.buy, bar.sell]),
      canonical.slice(-96).map(row => [row.timestamp, row.oi, row.buy, row.sell]))
    assert.equal(edgeCalls().length, 2, 'Focus changes never abort and restart a repair still demanded by a candidate.')
    assert.equal(store.queries.filter(query => query.instrument === id).length, reads, 'Returned statistics fill both residencies without rereading prices.')
    assert.equal(pipeline.series.get(`${id}:15m`).historyEnd, null)
  } finally { oi.resolve(); taker.resolve(); await pipeline.dispose(); context.mock.timers.reset() }
})

test('membership removal retires queued and active sources for every period without touching market subscriptions', async () => {
  const calls: any[] = [], ids = Array.from({ length: 7 }, (_, index) => `CANCEL${index}-USDT-SWAP`)
  const acquire = async (instrument: string, timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal, source = 'candles') => {
    calls.push({ instrument, timeframe, source, signal })
    await new Promise((_resolve, reject) => signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const { pipeline } = fixture([], { ensurePrices: acquire, ensureStatistics: acquire })
  try {
    pipeline.setRealtimeSubscriptions(ids.flatMap(instId => periods.map(timeframe => ({ instId, timeframe }))))
    pipeline.setUniverse(ids)
    await waitFor(() => calls.length === 6)
    const retired = [...calls], retained = ids.at(-1)
    pipeline.setUniverse([retained])
    await waitFor(() => calls.filter(call => call.instrument === retained).length === 6)
    assert.ok(retired.every(call => call.signal.aborted))
    assert.equal(calls.filter(call => call.instrument !== retained && call.source === 'candles').length, 2,
      'Removed queued periods never start their price transports.')
    assert.equal(pipeline.universe.size, periods.length)
    pipeline.setUniverse([])
    await waitFor(() => pipeline.sourceTasks.size === 0 && settled(pipeline))
    assert.ok(calls.every(call => call.signal.aborted))
    assert.equal(pipeline.sourceAttempts.size, 0)
    assert.equal(pipeline.realtimeKeys.size, ids.length * 3)
  } finally { await pipeline.dispose() }
})

test('remove and readd during an admitted local read shares durable facts but only the new candidate continues', async () => {
  const id = 'ABA-USDT-SWAP', hold = deferred(), { pipeline, store } = fixture(allRowsFor(id))
  const read = store.candles.bind(store)
  let admitted = 0
  store.candles = async query => { if (query.order === 'desc') { admitted += 1; await hold.promise }; return read(query) }
  try {
    pipeline.setUniverse([id])
    await waitFor(() => admitted === 2)
    const old = pipeline.universe.get(`${id}:15m`)
    pipeline.setUniverse([]); pipeline.setUniverse([id])
    assert.notEqual(pipeline.universe.get(`${id}:15m`), old)
    hold.resolve()
    await waitFor(() => allReady(pipeline, [id]) && settled(pipeline))
    assert.equal(admitted, periods.length)
    assert.equal(pipeline.nextCalculation, periods.length)
    for (const timeframe of periods) assert.equal(store.queries.filter(query => query.order === 'desc' && query.timeframe === timeframe).length, 1)
  } finally { hold.resolve(); await pipeline.dispose() }
})

test('retired candidates detach from a still-focused shared source and release their preparation slots', async () => {
  const a = 'SHARED-USDT-SWAP', b = 'NEXT-USDT-SWAP'
  let signalA: AbortSignal | undefined
  const { pipeline, store } = fixture([], {
    async ensurePrices(id: string, timeframe: Period, _from: number, _through: number, _priority: string, signal: AbortSignal) {
      if (id === a) {
        if (timeframe === '15m') signalA = signal
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      } else store.rows.push(...rowsFor(b, 400, timeframe))
    },
  })
  try {
    pipeline.setUniverse([a])
    await waitFor(() => signalA !== undefined)
    pipeline.setFocus({ instId: a, timeframe: '15m' }, 'keep-source')
    pipeline.setUniverse([]); pipeline.setUniverse([a])
    await new Promise(resolve => setImmediate(resolve))
    pipeline.setUniverse([b])
    await waitFor(() => allReady(pipeline, [b]) && settled(pipeline))
    assert.equal(signalA?.aborted, false, 'Focus still owns the source after its candidate waiters detach.')
    pipeline.setFocus(null, 'hide')
    await waitFor(() => pipeline.sourceTasks.size === 0)
    assert.equal(signalA?.aborted, true)
  } finally { await pipeline.dispose() }
})

test('selection arriving during a candidate replay receives its native results without a second calculation', async () => {
  const id = 'SELECT-DURING-REPLAY-USDT-SWAP', gate = deferred(), entered = deferred(), { pipeline } = fixture(allRowsFor(id))
  const calculate = pipeline.calculate.bind(pipeline)
  let calculations = 0
  pipeline.calculate = async (rows: any[], ...args: any[]) => {
    if (rows[0].timeframe === '15m') { calculations += 1; entered.resolve(); await gate.promise }
    return calculate(rows, ...args)
  }
  try {
    pipeline.setUniverse([id])
    await entered.promise
    pipeline.setFocus({ instId: id, timeframe: '15m' }, 'selected')
    await pipeline.local(id, '15m')
    gate.resolve()
    await waitFor(() => allReady(pipeline, [id]) && settled(pipeline))
    assert.equal(calculations, 1)
    assert.ok([...pipeline.series.get(`${id}:15m`).rows.keys()].every(hour => pipeline.series.get(`${id}:15m`).indicators.has(hour)))
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('a candidate admitted during a pure local read keeps one generation through renderer readiness', async () => {
  const id = 'GENERATION-USDT-SWAP', gate = deferred(), entered = deferred(), { pipeline, store } = fixture(allRowsFor(id))
  const renderer = new PreparedChartStore(), read = store.candles.bind(store), generations: number[] = []
  let first = true
  store.candles = async query => {
    if (first && query.order === 'desc' && query.timeframe === '15m') { first = false; entered.resolve(); await gate.promise }
    return read(query)
  }
  renderer.setUniverse([id], '15m')
  pipeline.subscribe((frame: any) => { if (frame.timeframe === '15m') generations.push(frame.generation); renderer.ingestLatest(frame) })
  let local: Promise<unknown> | undefined
  try {
    local = pipeline.local(id, '15m')
    await entered.promise
    pipeline.setUniverse([id])
    gate.resolve(); await local
    await waitFor(() => allReady(pipeline, [id]) && settled(pipeline))
    await waitFor(() => renderer.window(id, '15m')?.indicatorState === 'ready')
    assert.ok(generations.every(generation => generation === generations[0]), 'Read admission never changes the canonical input generation.')
  } finally { gate.resolve(); await local; await pipeline.dispose() }
})

test('candidate quote leases expire without core admission or a repeated immediate timer', async context => {
  const now = Math.floor(Date.now() / step) * step + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const id = 'QUIET-USDT-SWAP', entered = deferred()
  let sources = 0
  const { pipeline } = fixture(allRowsFor(id), {
    async ensurePrices(_id: string, _timeframe: string, _from: number, _through: number, _priority: string, signal: AbortSignal) {
      sources += 1; if (sources === 2) entered.resolve()
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  pipeline.streaming = () => true
  const flush = async () => { for (let index = 0; index < 10; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    pipeline.setUniverse([id])
    await flush(); while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()]); await flush()
    pipeline.setUniverse([id, 'SLOW1-USDT-SWAP', 'SLOW2-USDT-SWAP'])
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
  const failed = 'FAILED-USDT-SWAP', healthy = 'HEALTHY-USDT-SWAP', { pipeline } = fixture([...rowsFor(failed), ...allRowsFor(healthy)])
  const calculate = pipeline.calculate.bind(pipeline)
  let attempts = 0
  pipeline.calculate = async (rows: any[], ...args: any[]) => {
    if (rows[0].instrument === failed && rows[0].timeframe === '15m' && ++attempts <= 2) throw Object.assign(new Error('Worker exited'), { code: 'PREPARED_CHART_WORKER_UNAVAILABLE' })
    return calculate(rows, ...args)
  }
  try {
    pipeline.setUniverse([failed])
    await waitFor(() => attempts === 2 && settled(pipeline))
    assert.equal(pipeline.cached(`${failed}:15m`).indicatorState, 'error')
    assert.equal(pipeline.series.size, 0)
    pipeline.setUniverse([failed, healthy])
    await waitFor(() => ready(pipeline, failed) && allReady(pipeline, [healthy]) && settled(pipeline))
    assert.equal(attempts, 3)
    assert.equal(pipeline.series.size, 0)
  } finally { await pipeline.dispose() }
})

test('retiring a candidate during recursive replay cannot start another chunk or publish obsolete readiness', async () => {
  const id = 'REPLAY-USDT-SWAP', gate = deferred(), { pipeline } = fixture(allRowsFor(id, 3500))
  const calculate = pipeline.calculate.bind(pipeline), frames: any[] = []
  let calculations = 0
  pipeline.calculate = async (rows: any[], ...args: any[]) => {
    if (rows[0].timeframe === '15m') calculations += 1
    await gate.promise; return calculate(rows, ...args)
  }
  pipeline.subscribe((frame: any) => frames.push(frame))
  try {
    pipeline.setUniverse([id])
    await waitFor(() => calculations === 1)
    pipeline.setUniverse([])
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
  const repairs: Period[] = []
  const { pipeline, store } = fixture(allRowsFor(id), { async ensurePrices(_id: string, timeframe: Period) { repairs.push(timeframe) } })
  const calculate = pipeline.calculate.bind(pipeline)
  pipeline.calculate = async (...args: any[]) => { entered.resolve(); await gate.promise; return calculate(...args) }
  try {
    pipeline.setUniverse([id])
    await entered.promise
    context.mock.timers.tick(1011)
    for (const timeframe of periods) {
      const latest = rowsFor(id, 401, timeframe).at(-1)!
      if (!store.rows.some(row => row.timeframe === timeframe && row.timestamp === latest.timestamp)) store.rows.push(latest)
    }
    gate.resolve()
    // Use real immediate turns while worker IO proceeds under the mocked clock.
    const deadline = performance.now() + 4000
    while (!(settled(pipeline) && pipeline.cached(`${id}:15m`)?.endHour === end())) {
      assert.ok(performance.now() < deadline)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(repairs.filter(timeframe => timeframe === '15m').length, 1)
    assert.equal(pipeline.cached(`${id}:15m`).priceState, 'ready')
    assert.equal(pipeline.cached(`${id}:15m`).indicatorState, 'ready')
  } finally { gate.resolve(); await pipeline.dispose(); context.mock.timers.reset() }
})

test('warming beyond history capacity preserves the selected historical reserve and each compact latest frame', async () => {
  const history = 'HISTORY-USDT-SWAP', ids = Array.from({ length: 15 }, (_, index) => `POOL${index}-USDT-SWAP`)
  const canonical = rowsFor(history, 2000), { pipeline } = fixture([...canonical, ...ids.flatMap(id => allRowsFor(id))])
  try {
    const target = canonical[800].timestamp
    pipeline.setFocus({ instId: history, timeframe: '15m', endHour: target }, 'history')
    await pipeline.localHistory(history, '15m', target)
    await pipeline.focus.task
    await waitFor(() => settled(pipeline))
    const state = pipeline.series.get(`${history}:15m`), resident = [...state.rows.keys()]
    pipeline.setUniverse(ids)
    await waitFor(() => allReady(pipeline, ids) && settled(pipeline))
    assert.equal(pipeline.series.size, 1)
    assert.equal(state.historyEnd, target); assert.deepEqual([...state.rows.keys()], resident)
    assert.ok(ids.every(id => periods.every(timeframe => pipeline.cached(`${id}:${timeframe}`).bars.length === 96)))
    assert.ok([...pipeline.liveStates.values()].every((state: any) => state.rows.size <= 128))
  } finally { await pipeline.dispose() }
})

test('a stationary historical reserve never reacquires statistics for an absent offscreen candle', async context => {
  const now = Math.floor(Date.now() / step) * step + 1000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const id = 'RESERVE-GAP-USDT-SWAP', canonical = rowsFor(id, 2000), target = canonical[1500].timestamp, absent = canonical[1600]
  const calls: any[] = []
  const { pipeline, store } = fixture(canonical.filter(row => row.timestamp !== absent.timestamp), {
    async ensureStatistics(_id: string, _timeframe: string, from: number, through: number, _priority: string, _signal: AbortSignal, source: string) {
      calls.push({ from, through, source })
      return { rows: canonical.filter(row => row.timestamp >= from && row.timestamp <= through) }
    },
  })
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    pipeline.setFocus({ instId: id, timeframe: '15m', endHour: target }, 'stationary')
    await pipeline.localHistory(id, '15m', target)
    await pipeline.focus.task
    while (pipeline.liveSeeds.size) await Promise.all([...pipeline.liveSeeds.values()])
    const state = pipeline.series.get(`${id}:15m`)
    assert.ok(state.rows.has(absent.timestamp - step)); assert.ok(state.rows.has(absent.timestamp + step))
    assert.equal(state.rows.has(absent.timestamp), false)
    const reads = store.queries.length
    for (let turn = 0; turn < 4; turn++) { context.mock.timers.tick(1001); await flush() }
    assert.equal(calls.length, 0, 'An absent candle ahead of the selected viewport never owns a statistic consumer.')
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
