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
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 4000
  while (!condition()) { assert.ok(performance.now() < deadline, 'Chart source demand did not settle.'); await new Promise(resolve => setTimeout(resolve, 2)) }
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

test('superseding a chart aborts its actual price, OI and Taker transports while the current chart completes', async () => {
  const f = await fixture({ acquire: call => call.parameters.instId === btc ? untilAborted(call.signal) : Promise.resolve() })
  try {
    await f.pipeline.local(btc, '15m')
    await waitFor(() => f.calls.filter(call => call.parameters.instId === btc).length === 3)
    f.pipeline.setFocus({ instId: eth, timeframe: '15m' }, 'eth')
    await f.pipeline.local(eth, '15m', { focusId: 'eth' })
    const obsolete = f.calls.filter(call => call.parameters.instId === btc)
    await waitFor(() => obsolete.every(call => call.signal.aborted))
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
    await f.pipeline.local(btc, '15m')
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
    await f.pipeline.local(btc, '15m', { priority: 'background' })
    assert.equal(f.calls.length, 3, 'Durable facts remain reusable after chart ownership ends.')
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
    await f.pipeline.local(btc, '15m')
    await waitFor(() => f.calls.length === 1 && f.history.sync.listTasks().length === 3)
    assert.equal(f.history.sync.listTasks().filter(task => task.status === 'queued').length, 2)
    f.pipeline.setFocus({ instId: eth, timeframe: '15m' }, 'eth')
    await f.pipeline.local(eth, '15m', { focusId: 'eth' })
    await f.history.sync.whenIdle()
    await waitFor(() => f.pipeline.sourceTasks.size === 0)
    assert.equal(f.calls.filter(call => call.parameters.instId === btc).length, 1)
    assert.ok(f.history.sync.listTasks().filter(task => task.instrument === btc).every(task => task.status === 'cancelled'))
    assert.equal(f.pipeline.sourceAttempts.size, 0)
  } finally { await f.close() }
})

test('the chart focus IPC contract reaches the backend worker and local requests keep their ownership token', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-focus-worker-')), backend = new MarketBackend({ userData, testMode: true })
  const request = (value: unknown) => backend.request(parseDesktopRequest(value))
  try {
    const through = end()
    const candles = Array.from({ length: 96 }, (_, index) => ({ instrument: btc, timeframe: '15m', timestamp: through - index * step,
      open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true }))
    await backend.request({ e2e: { action: 'seedCandles', candles } })
    assert.deepEqual(await request({ chartFocus: { id: 'visible', target: { instId: btc, timeframe: '15m' } } }), { ok: true })
    const local = await request({ chartLocal: { instId: btc, timeframe: '15m', focusId: 'visible' } })
    assert.equal(local.bars.length, 96)
    assert.deepEqual(await request({ chartFocus: { id: 'hidden', target: null } }), { ok: true })
    const stale = await request({ chartHistory: { instId: btc, timeframe: '15m', endHour: through, focusId: 'visible' } })
    assert.ok(stale.bars.length >= 96, 'Retired source ownership still permits reading durable facts.')
  } finally { await backend.dispose(); await rm(userData, { recursive: true, force: true }) }
})
