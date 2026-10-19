import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import type { WebSocketFactory } from '../electron/services/realtime-market.js'

const fiveMinutes = 300_000
const hour = 3_600_000
const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const ticker = { instId, last: '100', bidPx: '99.99', askPx: '100' }
const candle = (timestamp: number, quoteVolume = 200_000) => ({ instrument: instId, timeframe: '5m', timestamp, open: 99, high: 101, low: 98, close: 100, volume: 2_000, baseVolume: 20, quoteVolume, confirmed: true })
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const raw = (row: ReturnType<typeof candle>) => [row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume, row.quoteVolume, row.confirmed ? 1 : 0].map(String)
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
class CandleSocket extends EventTarget {
  readyState = 0
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(value: string) {
    if (value === 'ping') { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'pong' }))); return }
    const command = JSON.parse(value)
    for (const arg of command.args) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, event: command.op, arg }) })))
  }
  candle(row: ReturnType<typeof candle>) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ arg: { instId, channel: 'candle5m' }, data: [raw(row)] }) })) }
  close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
}
const waitFor = async (condition: () => boolean, advance = () => {}) => {
  const deadline = performance.now() + 2_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for catalog requalification.')
    advance()
    await new Promise(resolve => setImmediate(resolve))
  }
}

const fixture = async (now: number, options: { webSocketFactory?: WebSocketFactory } = {}) => {
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  for (const key of ['volume24h', 'spread', 'depth', 'openInterest'] as const) preferences.liquidity[key].enabled = true
  const root = await mkdtemp(join(tmpdir(), 'perp-catalog-renewal-'))
  const store = await MarketStore.open(root)
  let fetches = 0, offline = false, refreshes = 0
  const service = new MarketService(store, () => preferences, async input => {
    fetches += 1
    if (offline) throw new Error('A durable candle update must not request network data.')
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([instrument])
    if (path.endsWith('/market/tickers')) return response([ticker])
    if (path.endsWith('/market/books')) return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }])
    if (path.endsWith('/public/open-interest')) return response([{ instId, oiUsd: '6000000' }])
    throw new Error(`Unexpected endpoint: ${path}`)
  }, false, options)
  // Measure qualification renewal independently of automatic chart-history preparation.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  await service.ready
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.scheduleListProjection = () => undefined
  const ensurePrices = service.history.ensurePrices.bind(service.history)
  service.history.ensurePrices = async () => { throw new Error('Complete durable qualification data must not need acquisition.') }
  service.scheduleRefresh = () => undefined
  service.scheduleRenewal = () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
  await store.appendCandles(Array.from({ length: 288 }, (_, index) => candle(asOf - (288 - index) * fiveMinutes)))
  await service.refresh()
  assert.equal(service.catalog.get(instId)?.status, 'verified')
  const fetchesBefore = fetches
  const sourcesBefore = () => Object.fromEntries(['ticker', 'book', 'openInterest'].map(key => [key, structuredClone(service.observations.get(instId)[key])]))
  const enableLocalUpdates = () => {
    offline = true
    service.refresh = async () => { refreshes += 1; throw new Error('A durable candle update must not start discovery.') }
    service.autoRefresh = true
  }
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, preferences, asOf, ensurePrices, sourcesBefore, enableLocalUpdates, close,
    assertLocalOnly: () => { assert.equal(fetches, fetchesBefore); assert.equal(refreshes, 0) } }
}

const streamingFixture = async (now: number) => {
  const socket = new CandleSocket(), f = await fixture(now, { webSocketFactory: () => socket })
  const priceRequests: string[] = []
  const get = f.service.get.bind(f.service)
  f.service.get = async (path: string, parameters: Record<string, string | number>, ...rest: any[]) => {
    if (path === '/market/candles' || path === '/market/history-candles') {
      priceRequests.push(path)
      const timestamp = path === '/market/candles' ? Math.floor(Date.now() / fiveMinutes) * fiveMinutes - fiveMinutes : Number(parameters.after) - fiveMinutes
      return [raw(candle(timestamp, 400_000))]
    }
    return get(path, parameters, ...rest)
  }
  f.service.history.ensurePrices = f.ensurePrices
  f.service.history.ensureStatistics = async () => ({ rows: [] })
  f.service.realtime.start(); socket.open()
  await f.service.realtime.whenIdle()
  assert.equal(f.service.realtime.isSubscribed(instId, '5m'), true)
  f.enableLocalUpdates()
  return { ...f, socket, priceRequests }
}

test('the confirmed stream closes qualification and chart requests only after its durable commit', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now), held = deferred(), writing = deferred()
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  let latest: Promise<unknown> | undefined
  try {
    const append = f.store.appendCandles.bind(f.store)
    f.store.appendCandles = async (...args) => { writing.resolve(); await held.promise; return append(...args) }
    context.mock.timers.tick(f.asOf + fiveMinutes - Date.now())
    await settle(() => f.service.candleWaits.size === 1)
    const controller = new AbortController()
    const cancelled = f.service.history.ensurePrices(instId, '5m', f.asOf, f.asOf, 'continuity', controller.signal)
    const rejected = assert.rejects(cancelled, /abort/i)
    controller.abort(); await rejected
    let chartReady = false
    latest = f.service.history.latest(instId, '5m').then((value: unknown) => { chartReady = true; return value })
    await settle(() => [...f.service.candleWaits.values()][0]?.consumers >= 2)
    assert.deepEqual(f.priceRequests, [])
    assert.equal((await f.service.snapshot()).error, '')
    f.socket.candle(candle(f.asOf, 400_000))
    await writing.promise
    context.mock.timers.tick(10_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(chartReady, false, 'Receiving a final event is not durable price coverage.')
    assert.deepEqual(f.priceRequests, [], 'An accepted local commit cannot race a delivery-timeout REST request.')
    held.resolve()
    await latest; await f.service.realtime.whenIdle()
    await settle(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000 && f.service.sourceRecoveries.size === 0)
    assert.equal(f.service.realtime.getProgress(instId, '5m').committedThrough, f.asOf)
    assert.equal(f.service.candleWaits.size, 0)
    assert.deepEqual(f.priceRequests, [], 'All consumers reuse the one committed stream observation.')
    assert.equal((await f.service.snapshot()).error, '')
    f.assertLocalOnly()
  } finally { held.resolve(); latest?.catch(() => {}); await f.close(); await latest?.catch(() => {}) }
})

for (const fallback of ['missing', 'disconnected'] as const) test(`a ${fallback} closing stream uses bounded REST gap recovery`, async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now)
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  try {
    context.mock.timers.tick(f.asOf + fiveMinutes - Date.now())
    await settle(() => f.service.candleWaits.size === 1)
    assert.deepEqual(f.priceRequests, [])
    if (fallback === 'missing') {
      context.mock.timers.tick(9_999)
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(f.priceRequests, [])
      context.mock.timers.tick(1)
    } else f.socket.close()
    await settle(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000)
    assert.deepEqual(f.priceRequests, ['/market/history-candles'])
    assert.equal(f.service.candleWaits.size, 0)
    assert.equal((await f.service.snapshot()).error, '')
  } finally { await f.close() }
})

for (const connection of ['connected', 'disconnected'] as const) test(`a failed accepted stream commit releases recovery even when ${connection}`, async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now), held = deferred(), writing = deferred()
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  try {
    const append = f.store.appendCandles.bind(f.store)
    let writes = 0
    f.store.appendCandles = async (...args) => {
      if (++writes === 1) { writing.resolve(); await held.promise; throw new Error('Confirmed candle commit failed.') }
      return append(...args)
    }
    context.mock.timers.tick(f.asOf + fiveMinutes - Date.now())
    await settle(() => f.service.candleWaits.size === 1)
    f.socket.candle(candle(f.asOf, 400_000))
    await writing.promise
    context.mock.timers.tick(10_000)
    assert.equal([...f.service.candleWaits.values()][0]?.deadline, Infinity)
    if (connection === 'disconnected') {
      f.socket.close()
      await settle(() => !f.service.realtime.isSubscribed(instId, '5m'))
    }
    assert.deepEqual(f.priceRequests, [], 'A pending durable write remains authoritative after disconnect.')
    held.resolve()
    await settle(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000)
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.getProgress(instId, '5m').pendingConfirmations, 0)
    assert.equal(f.service.candleWaits.size, 0)
    assert.deepEqual(f.priceRequests, ['/market/history-candles'])
  } finally { held.resolve(); await f.close() }
})

test('shutdown aborts shared closing-candle waiters without requesting fallback data', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now)
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  try {
    context.mock.timers.tick(f.asOf + fiveMinutes - Date.now())
    await settle(() => f.service.candleWaits.size === 1)
    const latest = f.service.history.latest(instId, '5m')
    const aborted = assert.rejects(latest, /closed|abort/i)
    await settle(() => [...f.service.candleWaits.values()][0]?.consumers >= 2)
    await f.service.dispose(); await aborted
    assert.equal(f.service.candleWaits.size, 0)
    assert.equal(f.service.candleWaitImmediate, null)
    assert.deepEqual(f.priceRequests, [])
    context.mock.timers.tick(10_000)
    assert.deepEqual(f.priceRequests, [])
  } finally { await f.close() }
})

test('a repair admitted during stream delivery still queries its authoritative source', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now)
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  let repair: Promise<unknown> | undefined
  try {
    context.mock.timers.tick(f.asOf + fiveMinutes - Date.now())
    await settle(() => f.service.candleWaits.size === 1)
    repair = f.service.history.repair({ instrument: instId, timeframe: '5m', source: 'candles', from: f.asOf, through: f.asOf, reason: 'invalid-ohlc', repairable: true }, { signal: new AbortController().signal })
    await settle(() => f.service.history.repairs.size === 1)
    f.socket.candle(candle(f.asOf, 400_000))
    await settle(() => f.priceRequests.length === 1 && f.service.history.repairs.size === 0)
    await repair
    assert.deepEqual(f.priceRequests, ['/market/history-candles'])
    assert.equal(f.service.candleWaits.size, 0)
  } finally { repair?.catch(() => {}); await f.close(); await repair?.catch(() => {}) }
})

test('older gaps and explicit latest-slot repairs query their authoritative source immediately', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 5 * 60_000 + 1_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await streamingFixture(now)
  const settle = (condition: () => boolean) => waitFor(condition, () => context.mock.timers.tick(0))
  try {
    const older = f.asOf - 300 * fiveMinutes
    const olderGap = f.service.history.ensurePrices(instId, '5m', older, older, 'foreground')
    await settle(() => f.priceRequests.length === 1)
    await olderGap
    assert.deepEqual(f.priceRequests, ['/market/history-candles'])
    const latest = f.asOf - fiveMinutes
    const repair = f.service.history.repair({ instrument: instId, timeframe: '5m', source: 'candles', from: latest, through: latest, reason: 'invalid-ohlc', repairable: true }, { signal: new AbortController().signal })
    await settle(() => f.priceRequests.length === 2)
    await repair
    assert.deepEqual(f.priceRequests, ['/market/history-candles', '/market/history-candles'])
    assert.equal(f.service.candleWaits.size, 0)
  } finally { await f.close() }
})

test('temporarily expired qualification retains the confirmed-candle feeds needed for recovery', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    const subscriptions = () => [...f.service.realtime.subscriptions.values()].map(value => `${value.instId}:${value.timeframe}`).sort()
    const before = subscriptions()
    assert.deepEqual(before, ['15m', '1H', '5m'].map(timeframe => `${instId}:${timeframe}`))
    now = f.asOf + fiveMinutes
    const expired = await f.service.snapshot()
    assert.deepEqual(expired.rows, [], 'Expired qualification cannot remain in the eligible list.')
    assert.equal(expired.catalogProgress.unknown, 1)
    assert.deepEqual(subscriptions(), before, 'A previously qualified contract must keep receiving final candles while its observations renew.')
    f.assertLocalOnly()
  } finally { await f.close() }
})

for (const outcome of ['confirmed', 'failed'] as const) test(`a 5m deadline reports pending revalidation before ${outcome === 'confirmed' ? 'the final candle restores qualification' : 'a genuine acquisition failure remains visible'}`, async context => {
  const now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await fixture(now)
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { started = resolve })
  const acquisitions: { from: number; through: number; priority: string }[] = []
  try {
    f.enableLocalUpdates()
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number, priority: string) => {
      acquisitions.push({ from, through, priority }); started()
      await held
      if (outcome === 'failed') throw new Error('OKX candle history unavailable.')
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    const deadline = f.asOf + fiveMinutes
    assert.equal(f.service.marketDeadlineAt, deadline)
    context.mock.timers.tick(deadline - Date.now())
    await requested
    const pending = await f.service.snapshot()
    assert.deepEqual(pending.rows, [], 'The expired rolling window cannot keep a contract qualified.')
    assert.equal(pending.catalogProgress.unknown, 1)
    assert.equal(pending.catalogProgress.pending, 1)
    assert.equal(pending.loading, true)
    assert.equal(pending.error, '', 'Waiting for a just-closed candle is normal revalidation, not unavailable verification.')
    assert.deepEqual(acquisitions, [{ from: deadline - 288 * fiveMinutes, through: f.asOf, priority: 'continuity' }])
    if (outcome === 'confirmed') {
      await f.service.persistCandles(instId, [candle(f.asOf, 400_000)])
      release()
      await waitFor(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000 && f.service.sourceRecoveries.size === 0 && f.service.candidateTasks.size === 0)
      const completed = await f.service.snapshot()
      assert.deepEqual(completed.rows.map(row => row.instId), [instId])
      assert.equal(completed.error, '')
      assert.equal(completed.catalogProgress.pending, 0)
      assert.equal(f.service.observations.get(instId).turnover.value.asOf, deadline)
    } else {
      release()
      await waitFor(() => f.service.error === 'OKX candle history unavailable.')
      const failed = await f.service.snapshot()
      assert.equal(failed.error, 'OKX candle history unavailable.', 'A real source error must remain visible even while retries are scheduled.')
      assert.deepEqual(failed.rows, [])
      assert.notEqual(f.service.observations.get(instId)?.turnover?.value.asOf, deadline)
    }
    f.assertLocalOnly()
  } finally { release(); await f.close() }
})

test('the next durable final candle immediately restores the exact rolling turnover without live requests or extended leases', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    const sources = f.sourcesBefore()
    const metadataLease = structuredClone(f.service.instrumentObservations.get(instId))
    f.enableLocalUpdates()
    now = f.asOf + fiveMinutes + 1
    assert.deepEqual((await f.service.snapshot()).rows, [])
    await f.service.persistCandles(instId, [candle(f.asOf, 400_000)])
    await waitFor(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000)
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    const turnover = f.service.metadata.getCatalogEntry(instId).observations.turnover
    assert.equal(turnover.value.asOf, f.asOf + fiveMinutes)
    assert.equal(turnover.value.turnover, 57_800_000, 'Drop the oldest 200,000 and add the newly completed 400,000 quote volume.')
    assert.deepEqual(f.sourcesBefore(), sources, 'Local historical recomputation cannot renew ticker, book, or open-interest leases.')
    assert.deepEqual(f.service.instrumentObservations.get(instId), metadataLease)
    f.assertLocalOnly()
  } finally { await f.close() }
})

test('a durable historical volume correction immediately applies the resulting qualification failure', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 2 * 60_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    f.preferences.liquidity.volume24h.minUSDT = 57_500_000
    f.service.verifyCatalog()
    assert.equal(f.service.catalog.get(instId)?.result.turnover, 57_600_000)
    const sources = f.sourcesBefore()
    f.enableLocalUpdates()
    await f.service.persistCandles(instId, [candle(f.asOf - fiveMinutes, 0)])
    await waitFor(() => f.service.catalogChecks.get(instId)?.status === 'failed')
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    assert.equal(f.service.metadata.getCatalogEntry(instId).result.turnover, 57_400_000)
    assert.equal(f.service.renewalTargets.has(instId), false, 'A verified condition failure must stop priority renewal.')
    assert.deepEqual(f.sourcesBefore(), sources)
    f.assertLocalOnly()
  } finally { await f.close() }
})
