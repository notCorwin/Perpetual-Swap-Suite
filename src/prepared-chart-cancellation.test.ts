import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketHistory } from '../electron/services/market-history.js'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { MarketBackend } from '../electron/services/market-backend.js'
import { parseDesktopRequest } from '../electron/desktop-contract.js'

const step = 900_000, btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'
const end = () => Math.floor(Date.now() / step) * step - step
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + 4000
  while (!await condition()) { assert.ok(performance.now() < deadline, 'Chart source demand did not settle.'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
type SourceCall = { path: string; parameters: Record<string, string | number>; signal: AbortSignal }
const values = ({ path, parameters }: SourceCall): unknown[][] => {
  if (path === '/market/history-candles') return Array.from({ length: Number(parameters.limit) }, (_, index) =>
    [String(Number(parameters.after) - (index + 1) * step), '100', '102', '99', '101', '10', '1', '1000', '1'])
  const first = Number(parameters.begin) + step, through = Number(parameters.end) - step
  return Array.from({ length: (through - first) / step + 1 }, (_, index) => path.includes('open-interest')
    ? [String(first + index * step), '500'] : [String(first + index * step), '4', '6'])
}
const untilAborted = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})
const fixture = async ({ acquire = async (_call: SourceCall) => {}, beforeWrite = async () => {} } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-chart-cancellation-')), store = await MarketStore.open(root), calls: SourceCall[] = []
  const metadata: any = { listSyncTasks: () => [], deleteSyncTask: () => true, listAudits: () => [], saveAudit: (value: unknown) => value }
  const history = new MarketHistory({ store, metadata,
    get: async (path, parameters, signal) => { const call = { path, parameters, signal }; calls.push(call); await acquire(call); return values(call) },
    parseCandle: (instrument, timeframe, value) => ({ instrument, timeframe, timestamp: Number(value[0]),
      open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]),
      volume: Number(value[5]), baseVolume: Number(value[6]), quoteVolume: Number(value[7]), confirmed: value[8] === '1' }),
    persistCandles: async (_id, rows, { priority }) => { await beforeWrite(); await store.appendCandles(rows, priority) },
    persistStatistics: (instrument, timeframe, _end, source, rows, bounds, priority) => store.appendStatistics({
      instrument: instrument.instId, timeframe, source: source === 1 ? 'oi' : 'taker', ...bounds, values: rows, expiresAt: Date.now() + 60_000 }, priority),
    replaceCandles: (bounds, rows, priority) => store.replaceCandles(bounds, rows, priority),
    instrument: instId => ({ instId, listTime: end() - 999 * step }),
  })
  await history.ready
  const pipeline: any = new PreparedChartPipeline({ store, history, normalize: value => value, revision: () => 0, instrument: () => ({ listTime: end() - 999 * step }) })
  pipeline.workerLimit = 1
  return { store, history, pipeline, calls, async close() { await pipeline.dispose(); await history.close(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('local chart reads never create source demand, seed indicators, or acquire and replace focus', async () => {
  const f = await fixture({ acquire: call => untilAborted(call.signal) }), through = end()
  const seeds: string[] = [], seed = f.pipeline.seed.bind(f.pipeline)
  f.pipeline.seed = (state: any, ...args: any[]) => { seeds.push(state.instId); return seed(state, ...args) }
  try {
    await f.store.appendCandles(Array.from({ length: 400 }, (_, index) => ({
      instrument: btc, timeframe: '15m', timestamp: through - (399 - index) * step,
      open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 1000,
      confirmed: true, oi: 500, buy: 6, sell: 4, statisticsVersion: 11,
    })))
    assert.ok((await f.pipeline.local(btc, '15m'))?.bars.length)
    assert.ok((await f.pipeline.localHistory(btc, '15m', through - 100 * step))?.bars.length)
    assert.equal(f.pipeline.focus, null)
    assert.equal(f.pipeline.focusKey, null)
    assert.equal(f.pipeline.sourceTasks.size, 0)
    assert.equal(f.history.sync.listTasks().length, 0)
    assert.equal(f.calls.length, 0, 'Local data reads must never start a source transport.')
    assert.deepEqual(seeds, [], 'Local data reads must never request indicator seeding.')
    assert.equal(f.pipeline.nextCalculation, 0)

    f.pipeline.setFocus({ instId: eth, timeframe: '15m' }, 'selected')
    await waitFor(() => f.calls.filter(call => call.parameters.instId === eth).length === 3)
    const selected = f.pipeline.focus
    assert.ok((await f.pipeline.local(btc, '15m'))?.bars.length)
    assert.ok((await f.pipeline.localHistory(btc, '15m', through - 101 * step))?.bars.length)
    assert.equal(f.pipeline.focus, selected, 'A local read cannot replace another explicit owner.')
    assert.equal(f.pipeline.focusKey, `${eth}:15m`)
    assert.ok(f.calls.every(call => call.parameters.instId === eth))
    assert.ok(f.calls.every(call => !call.signal.aborted), 'Reading another series cannot cancel selected transports.')
    assert.ok(seeds.every(instId => instId === eth), 'Only the explicitly focused series may seed indicators.')
  } finally { await f.close() }
})

test('superseding a chart aborts its actual price, OI and Taker transports while the current chart completes', async () => {
  const f = await fixture({ acquire: call => call.parameters.instId === btc ? untilAborted(call.signal) : Promise.resolve() })
  try {
    f.pipeline.setFocus({ instId: btc, timeframe: '15m' }, 'btc')
    await waitFor(() => f.calls.filter(call => call.parameters.instId === btc).length === 3)
    f.pipeline.setFocus({ instId: eth, timeframe: '15m' }, 'eth')
    const obsolete = f.calls.filter(call => call.parameters.instId === btc)
    await waitFor(() => obsolete.every(call => call.signal.aborted))
    await waitFor(() => f.calls.filter(call => call.parameters.instId === eth).length === 3)
    await f.history.sync.whenIdle()
    await waitFor(() => f.pipeline.sourceTasks.size === 0)
    assert.equal(f.pipeline.focusKey, `${eth}:15m`)
    assert.equal(f.pipeline.sourceAttempts.size, 0, 'Aborting a previous chart must not delay legitimate current work.')
    assert.equal((await f.store.candles({ instrument: eth, timeframe: '15m' })).length, 96)
    assert.ok(f.history.sync.listTasks().filter(task => task.instrument === btc).every(task => task.status === 'cancelled'))
    assert.ok(f.history.sync.listTasks().filter(task => task.instrument === eth).every(task => task.status === 'completed'))
  } finally { await f.close() }
})

test('hiding a chart cancels only its consumers while overlapping history observers keep the shared transports and durable facts', async () => {
  const hold = deferred(), f = await fixture({ acquire: () => hold.promise })
  const through = end(), from = through - 95 * step
  let price: ReturnType<MarketHistory['ensurePrices']> | undefined, statistics: ReturnType<MarketHistory['ensureStatistics']> | undefined
  try {
    price = f.history.ensurePrices(btc, '15m', from, through, 'continuity')
    statistics = f.history.ensureStatistics(btc, '15m', from, through, 'continuity')
    await waitFor(() => f.calls.length === 3)
    f.pipeline.setFocus({ instId: btc, timeframe: '15m' }, 'visible')
    await waitFor(() => f.history.sync.listTasks().length === 6)
    f.pipeline.setFocus(null, 'hidden')
    await waitFor(() => f.history.sync.listTasks().filter(task => task.status === 'cancelled').length === 3)
    assert.ok(f.calls.every(call => !call.signal.aborted), 'Another consumer still owns each shared source page.')
    hold.resolve(); await Promise.all([price, statistics]); await f.history.sync.whenIdle()
    const rows = await f.store.candles({ instrument: btc, timeframe: '15m', from, through })
    assert.equal(rows.length, 96)
    assert.ok(rows.every(row => row.oi === 500 && row.buy === 6 && row.sell === 4))
    assert.equal(f.calls.length, 3, 'Chart ownership never duplicates the already admitted native pages.')
    assert.equal(f.pipeline.focusKey, null)
    assert.equal(f.pipeline.refreshTimer, null)
    assert.equal(f.pipeline.sourceAttempts.size, 0)
    const generation = (await f.pipeline.local(btc, '15m')).generation
    const calculations = f.pipeline.nextCalculation
    const historical = await f.pipeline.localHistory(btc, '15m', through)
    assert.equal(f.calls.length, 3, 'Durable facts remain reusable after chart ownership ends.')
    assert.equal(f.pipeline.focusKey, null, 'Reading retained facts must not reacquire source ownership.')
    assert.equal(historical.generation, generation, 'A read-only projection keeps the admitted input generation.')
    assert.equal(f.pipeline.nextCalculation, calculations, 'Reading retained facts must not seed another calculation.')
  } finally { hold.resolve(); await Promise.allSettled([price, statistics]); await f.close() }
})

test('chart cancellation preserves an already admitted durable write and never reports it as source backoff', async () => {
  const hold = deferred(), writing = deferred()
  const f = await fixture({ beforeWrite: async () => { writing.resolve(); await hold.promise } })
  let preparation: Promise<unknown> | undefined
  try {
    preparation = f.pipeline.prepare(btc, '15m')
    await writing.promise
    f.pipeline.setFocus(null, 'hidden')
    await preparation
    assert.equal((await f.store.candles({ instrument: btc, timeframe: '15m' })).length, 0)
    hold.resolve(); await f.history.sync.whenIdle()
    const rows = await f.store.candles({ instrument: btc, timeframe: '15m' })
    assert.equal(rows.length, 96, 'The accepted write belongs to persistence after its chart consumer is cancelled.')
    assert.equal(f.pipeline.sourceAttempts.size, 0)
    assert.ok(f.history.sync.listTasks().every(task => task.status === 'cancelled' || task.status === 'completed'))
  } finally { hold.resolve(); await preparation; await f.close() }
})

test('superseded queued chart consumers never enter their source transports', async () => {
  const f = await fixture({ acquire: call => call.parameters.instId === btc ? untilAborted(call.signal) : Promise.resolve() })
  ;(f.history.sync as any).maxConcurrentTasks = 1
  try {
    f.pipeline.setFocus({ instId: btc, timeframe: '15m' }, 'btc')
    await waitFor(() => f.calls.length === 1 && f.history.sync.listTasks().length === 3)
    assert.equal(f.history.sync.listTasks().filter(task => task.status === 'queued').length, 2)
    f.pipeline.setFocus({ instId: eth, timeframe: '15m' }, 'eth')
    await waitFor(() => f.history.sync.listTasks().filter(task => task.instrument === eth).length === 3)
    await f.history.sync.whenIdle()
    await waitFor(() => f.pipeline.sourceTasks.size === 0)
    assert.equal(f.calls.filter(call => call.parameters.instId === btc).length, 1)
    assert.ok(f.history.sync.listTasks().filter(task => task.instrument === btc).every(task => task.status === 'cancelled'))
    assert.equal(f.pipeline.sourceAttempts.size, 0)
  } finally { await f.close() }
})

test('cached price history proactively fills both statistic reserves without scrolling or blocking the viewport', async () => {
  const hold = deferred(), target = end() - 300 * step
  const f = await fixture({ acquire: call => call.path.includes('open-interest') ? hold.promise : Promise.resolve() })
  try {
    const candles = Array.from({ length: 1000 }, (_, index) => {
      const timestamp = end() - (999 - index) * step, visible = timestamp >= target - 95 * step && timestamp <= target
      return { instrument: btc, timeframe: '15m', timestamp, open: 100, high: 102, low: 99, close: 101,
        volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true,
        ...(visible ? { oi: 500, buy: 6, sell: 4, statisticsVersion: 11 } : {}) }
    })
    await f.store.appendCandles(candles)
    f.pipeline.setFocus({ instId: btc, timeframe: '15m', endHour: target }, 'history')
    let frame: any
    await waitFor(async () => {
      frame = await f.pipeline.localHistory(btc, '15m', target)
      return frame?.priceState === 'ready' && frame?.oiState === 'ready' && frame?.takerState === 'ready'
    })
    assert.equal(frame.priceState, 'ready'); assert.equal(frame.oiState, 'ready'); assert.equal(frame.takerState, 'ready')
    await waitFor(() => f.calls.some(call => call.path.includes('open-interest')) && f.calls.some(call => call.path.includes('taker')))
    assert.ok(f.calls.every(call => !call.path.includes('candles')), 'Complete cached prices must not gate or duplicate statistic acquisition.')
    const state = f.pipeline.series.get(`${btc}:15m`), first = Math.min(...state.rows.keys()), last = Math.max(...state.rows.keys())
    assert.ok(first < target - 95 * step && last > target, 'The admitted reserve must extend in both navigation directions.')
    await waitFor(() => [...state.rows.values()].every((row: any) => row.buy === 6 && row.sell === 4))
    assert.ok([...state.rows.values()].some((row: any) => row.oi == null), 'Taker completes while offscreen OI remains held.')
    const pending = [...f.pipeline.sourceTasks.values()]
    f.pipeline.setFocus({ instId: btc, timeframe: '15m', endHour: target - step }, 'adjacent')
    await f.pipeline.localHistory(btc, '15m', target - step)
    assert.ok(pending.every((job: any) => !job.controller.signal.aborted), 'Adjacent scrolling reuses already admitted statistic reserves.')
    hold.resolve(); await f.history.sync.whenIdle()
    await waitFor(() => f.pipeline.sourceTasks.size === 0)
    assert.ok([...state.rows.values()].every((row: any) => row.oi === 500 && row.buy === 6 && row.sell === 4))
    const requests = f.calls.length
    f.pipeline.setFocus({ instId: btc, timeframe: '15m', endHour: target - 2 * step }, 'adjacent-next')
    await f.pipeline.localHistory(btc, '15m', target - 2 * step)
    await f.history.sync.whenIdle()
    assert.equal(f.calls.length, requests, 'Prepared statistic coverage remains reusable on subsequent navigation.')
  } finally { hold.resolve(); await f.close() }
})

test('cold historical price pages proactively populate their entire statistic reserve', async () => {
  const f = await fixture(), target = end() - 100 * step
  try {
    await f.pipeline.prepare(btc, '15m', target, 768)
    await f.history.sync.whenIdle()
    await waitFor(() => f.pipeline.sourceTasks.size === 0)
    const rows = await f.store.candles({ instrument: btc, timeframe: '15m', from: target - 767 * step, through: target })
    assert.equal(rows.length, 768)
    assert.ok(rows.every(row => row.oi === 500 && row.buy === 6 && row.sell === 4), 'Every acquired price page must prime both statistic sources before another scroll.')
    const frame = f.pipeline.historyFrame(f.pipeline.series.get(`${btc}:15m`), target)
    assert.equal(frame.oiState, 'ready'); assert.equal(frame.takerState, 'ready')
  } finally { await f.close() }
})

test('the chart focus IPC contract starts backend hydration and retired ownership permits pure local reads', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-focus-worker-')), backend = new MarketBackend({ userData, testMode: true })
  const request = (value: unknown) => backend.request(parseDesktopRequest(value))
  try {
    const through = end()
    const candles = Array.from({ length: 96 }, (_, index) => ({ instrument: btc, timeframe: '15m', timestamp: through - index * step,
      open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true }))
    await backend.request({ e2e: { action: 'seedCandles', candles } })
    assert.deepEqual(await request({ chartFocus: { id: 'visible', target: { instId: btc, timeframe: '15m' } } }), { ok: true })
    let local: any
    await waitFor(async () => {
      local = await request({ chartLocal: { instId: btc, timeframe: '15m' } })
      return local?.bars.length === 96
    })
    assert.equal(local.bars.length, 96)
    assert.deepEqual(await request({ chartFocus: { id: 'hidden', target: null } }), { ok: true })
    const stale = await request({ chartHistory: { instId: btc, timeframe: '15m', endHour: through } })
    assert.ok(stale.bars.length >= 96, 'Retired source ownership still permits reading durable facts.')
  } finally { await backend.dispose(); await rm(userData, { recursive: true, force: true }) }
})
