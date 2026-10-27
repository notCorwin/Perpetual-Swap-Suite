import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketHistory } from '../electron/services/market-history.js'
import { MarketStore } from '../electron/services/market-store.js'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import type { CandleRecord } from '../electron/services/market-store.js'
import type { AuditJob } from '../electron/services/data-audit.js'

const step = 300_000, day = 86400000, base = Date.UTC(2026, 9, 1), instId = 'BTC-USDT-SWAP'
const intervals: Record<string, number> = { '5m': step, '15m': 900000, '1H': 3600000 }
const row = (timestamp: number, timeframe = '5m'): CandleRecord => ({ instrument: instId, timeframe, timestamp, open: 100, high: 101, low: 99, close: 100, volume: 10, baseVolume: 0.1, quoteVolume: 10, confirmed: true })
const raw = (candle: CandleRecord) => [String(candle.timestamp), String(candle.open), String(candle.high), String(candle.low), String(candle.close), String(candle.volume), String(candle.baseVolume), String(candle.quoteVolume), candle.confirmed ? '1' : '0']
const parseCandle = (instrument: string, timeframe: string, value: unknown[]) => ({ instrument, timeframe, timestamp: Number(value[0]), open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]), volume: Number(value[5]), baseVolume: Number(value[6]), quoteVolume: Number(value[7]), confirmed: value[8] === '1' })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean) => { const deadline = performance.now() + 4000; while (!condition()) { assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 2)) } }
class MemoryMetadata {
  audits = new Map<string, AuditJob>()
  saveAudit(job: AuditJob) { this.audits.set(job.id, structuredClone(job)); return job }
  listAudits() { return [...this.audits.values()].map(job => structuredClone(job)) }
}
type Parameters = Record<string, string | number>
type Get = (path: string, parameters: Parameters, signal: AbortSignal, priority: string) => Promise<unknown[][]>
const source: Get = async (path, parameters) => {
  const timeframe = String(parameters.bar ?? parameters.period), interval = intervals[timeframe]
  if (path === '/market/history-candles') {
    const through = Number(parameters.after) - interval
    return Array.from({ length: Number(parameters.limit) }, (_, index) => raw(row(through - index * interval, timeframe)))
  }
  const through = Number(parameters.end) - interval
  return Array.from({ length: Number(parameters.limit) }, (_, index) => path.includes('open-interest')
    ? [String(through - index * interval), '50'] : [String(through - index * interval), '20', '30'])
    .filter(value => Number(value[0]) > Number(parameters.begin) && Number(value[0]) < Number(parameters.end))
}
const fixture = async (t: TestContext, options: { get?: Get; now?: () => number; listing?: number; onLive?: (row: CandleRecord) => void } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-sqlite-')), store = await MarketStore.open(root), metadata = new MemoryMetadata()
  const now = options.now ?? (() => base + 2 * day), calls: { path: string; parameters: Parameters; priority: string }[] = []
  const history = new MarketHistory({ store, metadata, now, parseCandle,
    get: (path, parameters, signal, priority) => { calls.push({ path, parameters, priority }); return (options.get ?? source)(path, parameters, signal, priority) },
    persistCandles: (_instrument, records, { priority }) => store.appendCandles(records, priority),
    persistStatistics: (instrument, timeframe, _end, source, values, bounds, priority) => store.appendStatistics({ instrument: instrument.instId, timeframe, source: source === 1 ? 'oi' : 'taker', ...bounds, values, expiresAt: now() + 60000 }, priority),
    replaceCandles: (bounds, records, priority) => store.replaceCandles(bounds, records, priority),
    instrument: () => ({ instId, listTime: options.listing }), onLive: (_instrument, _timeframe, value) => options.onLive?.(value),
  })
  const retries = history.sync as unknown as { retryBaseMS: number; maxRetryDelayMS: number; maxAttempts: number }
  retries.retryBaseMS = 1; retries.maxRetryDelayMS = 4; retries.maxAttempts = 1
  await history.ready
  t.after(async () => { await history.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return { history, store, metadata, calls }
}

test('native price coverage reuses durable rows and repairs only the missing slot', async t => {
  const { history, store, calls } = await fixture(t)
  await store.appendCandles([row(base), { ...row(base + step), baseVolume: null }, row(base + 2 * step)])
  const result = await history.ensurePrices(instId, '5m', base, base + 2 * step)
  assert.equal(result.rows.length, 3); assert.equal(result.rows[1].baseVolume, 0.1)
  assert.equal(calls.length, 1); assert.equal(calls[0].parameters.limit, 1)
  await history.ensurePrices(instId, '5m', base, base + 2 * step)
  assert.equal(calls.length, 1)
})

test('opening a chart repairs an outage through verified SQLite coverage and reuses it on reopening', async t => {
  const now = Date.now(), through = Math.floor(now / step) * step - step
  const canonical = Array.from({ length: 400 }, (_, index) => row(through - (399 - index) * step))
  const gate = deferred()
  const { history, store, calls } = await fixture(t, { now: () => now, listing: canonical[0].timestamp,
    get: async (path, parameters, signal, priority) => {
      if (path === '/market/history-candles') await gate.promise
      return source(path, parameters, signal, priority)
    } })
  await store.appendCandles(canonical.slice(0, -12))
  const pipeline: any = new PreparedChartPipeline({ store, history, normalize: value => value, revision: () => 0,
    instrument: () => ({ listTime: canonical[0].timestamp }), streaming: () => true })
  try {
    await pipeline.setLive(instId, '5m', { ...row(through + step), confirmed: false }, { receivedAt: now })
    const initial = await pipeline.local(instId, '5m')
    assert.equal(initial.priceState, 'stale'); assert.equal(initial.realtimeState, 'live')
    pipeline.setFocus({ instId, timeframe: '5m' })
    const repair = pipeline.focus.task
    gate.resolve(); await repair
    await waitFor(() => pipeline.cached(`${instId}:5m`)?.priceState === 'ready')
    const inspection = await store.inspectCandles({ instrument: instId, timeframe: '5m', from: through - 95 * step, through })
    assert.deepEqual(inspection.issues, []); assert.equal(inspection.checkedRows, 96)
    const repaired = pipeline.cached(`${instId}:5m`)
    assert.equal(repaired.priceState, 'ready'); assert.equal(repaired.endHour, through)
    const priceCalls = () => calls.filter(call => call.path.includes('/market/'))
    assert.equal(priceCalls().length, 1)
    assert.equal(priceCalls()[0].parameters.limit, 12, 'The planner must reuse the persisted part of the 96-candle viewport.')
    await pipeline.local(instId, '5m')
    assert.equal(priceCalls().length, 1)
  } finally { gate.resolve(); await pipeline.dispose() }
})

test('statistics persist without price rows or a price-source request', async t => {
  const { history, store, calls } = await fixture(t)
  const result = await history.ensureStatistics(instId, '5m', base, base + 2 * step)
  assert.deepEqual(result.rows, [])
  assert.ok(calls.every(call => !call.path.includes('/market/')))
  const observations = await store.statistics({ instrument: instId, timeframe: '5m', from: base, through: base + 2 * step })
  assert.deepEqual(observations.map(value => [value.oi, value.buy, value.sell]), [[50, 30, 20], [50, 30, 20], [50, 30, 20]])
  await store.appendCandles([row(base), row(base + step), row(base + 2 * step)])
  const joined = await store.candles({ instrument: instId, timeframe: '5m', from: base, through: base + 2 * step })
  assert.deepEqual(joined.map(value => [value.oi, value.buy, value.sell]), observations.map(value => [value.oi, value.buy, value.sell]))
})

test('OI and Taker finish while the independent price request remains blocked', async t => {
  const gate = deferred(); let priceStarted = false
  const { history, store } = await fixture(t, { get: async (path, parameters, signal, priority) => {
    if (path === '/market/history-candles') { priceStarted = true; await gate.promise }
    return source(path, parameters, signal, priority)
  } })
  const prices = history.ensurePrices(instId, '5m', base, base + 2 * step)
  await waitFor(() => priceStarted)
  await history.ensureStatistics(instId, '5m', base, base + 2 * step)
  assert.equal((await store.statistics({ instrument: instId, timeframe: '5m', source: 'oi' })).length, 3)
  assert.equal((await store.coverage(instId, '5m')).count, 0)
  gate.resolve(); assert.equal((await prices).rows.length, 3)
})

test('a long statistics request batches native pages and reuses numeric observations', async t => {
  const { history, store, calls } = await fixture(t, { now: () => base + 1600 * step })
  await history.ensureStatistics(instId, '5m', base, base + 1499 * step)
  assert.equal(calls.length, 30)
  assert.ok(calls.every(call => call.parameters.limit === 100))
  assert.equal((await store.statistics({ instrument: instId, timeframe: '5m' })).length, 1500)
  await history.ensureStatistics(instId, '5m', base, base + 1499 * step)
  assert.equal(calls.length, 30)
})

test('a visible OI failure reports its first retry deadline without delaying or certifying Taker', async t => {
  const { history, store, calls } = await fixture(t, { get: async (path, parameters, signal, priority) => {
    if (path.includes('open-interest')) throw new Error('OI temporarily offline')
    return source(path, parameters, signal, priority)
  } })
  Object.assign(history.sync, { maxAttempts: 5, retryBaseMS: 60_000, maxRetryDelayMS: 60_000 })
  const taker = history.ensureStatistics(instId, '5m', base, base + 2 * step, 'interactive', undefined, 'taker')
  await assert.rejects(history.ensureStatistics(instId, '5m', base, base + 2 * step, 'interactive', undefined, 'oi'), error => {
    assert.equal((error as Error).message, 'OI temporarily offline')
    assert.equal((error as Error & { retryAt: number }).retryAt, base + 2 * day + 60_000)
    return true
  })
  await taker
  assert.equal(calls.filter(call => call.path.includes('open-interest')).length, 1)
  assert.equal((await store.statistics({ instrument: instId, timeframe: '5m', source: 'oi' })).length, 0, 'Request failures cannot persist absence proofs.')
  const rows = await store.statistics({ instrument: instId, timeframe: '5m', source: 'taker' })
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.buy === 30 && row.sell === 20))
  assert.ok(history.sync.listTasks().filter(task => task.source === 'oi').every(task => task.status === 'cancelled'))
})

test('direct empty source observations own bounded retry leases without inventing availability', async t => {
  let now = base + day
  const { history, store, calls } = await fixture(t, { now: () => now, get: async () => [] })
  await history.ensureStatistics(instId, '5m', base, base + step)
  assert.equal(calls.length, 2)
  const observations = await store.statistics({ instrument: instId, timeframe: '5m' })
  assert.ok(observations.every(value => value.oi === null && value.buy === null && value.sell === null && value.statisticsOIExpiresAt === now + 60000))
  assert.ok(history.sync.listTasks().every(task => task.unavailableRanges.length === 0 && task.status === 'completed'))
  await history.ensureStatistics(instId, '5m', base, base + step); assert.equal(calls.length, 2)
  now += 60001
  await history.ensureStatistics(instId, '5m', base, base + step); assert.equal(calls.length, 4)
})

test('source evidence before listing is unavailable and never requested', async t => {
  const { history, calls } = await fixture(t, { listing: base + 3 * step })
  const result = await history.ensurePrices(instId, '5m', base, base + step)
  assert.deepEqual(result.rows, []); assert.deepEqual(calls, [])
  assert.equal(history.sync.listTasks()[0].status, 'unavailable')
})

test('cancellation removes only its viewport demand while another consumer completes shared price history', async t => {
  const gate = deferred(); let entered = false, sourceSignal: AbortSignal | undefined
  const { history } = await fixture(t, { get: async (path, parameters, signal, priority) => { entered = true; sourceSignal = signal; await gate.promise; return source(path, parameters, signal, priority) } })
  const controller = new AbortController()
  const first = history.ensurePrices(instId, '5m', base, base + 2 * step, 'foreground', controller.signal)
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const second = history.ensurePrices(instId, '5m', base, base + 2 * step)
  await waitFor(() => entered); controller.abort(); await rejected
  assert.equal(sourceSignal?.aborted, false)
  gate.resolve(); assert.equal((await second).rows.length, 3)
})

test('malformed or conflicting direct statistics fail without certifying source coverage', async t => {
  const { history, store } = await fixture(t, { get: async (_path, parameters) => [[String(Number(parameters.end) - step), '50'], [String(Number(parameters.end) - step), '51']] })
  await assert.rejects(history.ensureStatistics(instId, '5m', base, base), /conflicting|quantities/)
  assert.deepEqual(await store.statistics({ instrument: instId, timeframe: '5m' }), [])
})

test('latest initialization publishes actual observations without inventing missing closes', async t => {
  const live = { ...row(base + step), close: 101, confirmed: false }, published: CandleRecord[] = []
  const { history, store, calls } = await fixture(t, { get: async path => path === '/market/candles' ? [raw(live), raw(row(base))] : [], onLive: value => published.push(value) })
  const result = await history.latest(instId, '5m')
  assert.equal(published[0]?.timestamp, live.timestamp); assert.equal(published.length, 1)
  assert.ok(!('live' in result), 'The guarded publication is the single owner of forming source delivery.')
  assert.equal((await store.coverage(instId, '5m')).count, 1)
  assert.equal(calls.length, 1)
  assert.equal(history.sync.listTasks()[0].writtenRecords, 1)
})

test('delisting removes finite consumer demand without deleting source facts', async t => {
  const gate = deferred()
  const { history, store } = await fixture(t, { get: async (path, parameters, signal, priority) => { await gate.promise; signal.throwIfAborted(); return source(path, parameters, signal, priority) } })
  await store.appendCandles([row(base)])
  const task = await history.sync.enqueue({ instrument: instId, timeframe: '5m', source: 'candles', from: base + step, through: base + 2 * step })
  assert.equal(history.sync.listTasks().length, 1)
  const cancelled = history.sync.waitFor(task.id)
  await history.removeTargets([instId]); gate.resolve(); await history.sync.whenIdle()
  assert.equal((await cancelled).status, 'cancelled')
  assert.equal(history.sync.listTasks().length, 0)
  assert.equal((await store.coverage(instId, '5m')).count, 1)
})

test('manual integrity repair uses bounded native pages and verifies actual SQLite coverage', async t => {
  const { history, store, calls } = await fixture(t, { now: () => base + 4 * day })
  await store.appendCandles([row(base - step), row(base + 650 * step)])
  const audit = history.audit.start({ targets: [{ instrument: instId, timeframe: '5m', from: base, through: base + 649 * step }] })
  await history.audit.whenIdle()
  assert.ok(history.audit.get(audit.id)!.summary.open > 0)
  history.audit.repair(audit.id); await history.audit.whenIdle()
  const completed = history.audit.get(audit.id)!
  assert.equal(completed.status, 'completed'); assert.equal(completed.summary.open, 0)
  assert.equal((await store.coverage(instId, '5m')).count, 652)
  assert.ok(calls.length > 0 && calls.every(call => Number(call.parameters.limit) <= 300))
})
