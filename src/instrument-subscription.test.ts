import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const fiveMinutes = 300_000
const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP', sol = 'SOL-USDT-SWAP'
const instrument = (instId = btc) => ({
  instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live',
  ctVal: '0.01', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal',
})
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const configuration = () => {
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  return preferences
}
const projectionIsolation = (service: MarketService) => {
  // These tests exercise collection, membership and durable writes. Rendering
  // and indicator projection have their own source-window integration tests.
  service.preparedCharts.setUniverse = () => ({ frames: [] })
  service.updateRanking = async () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
}
const settle = async (service: MarketService) => {
  service.flushStreamQualifications()
  while (service.backgroundTasks.size || service.candidateTasks.size || service.catalogPublicationTask) {
    await Promise.allSettled([...service.backgroundTasks, ...service.candidateTasks.values(), ...(service.catalogPublicationTask ? [service.catalogPublicationTask] : [])])
    await setImmediate()
  }
}

async function fixture(definitions = [instrument()], acquire?: () => Promise<unknown[]>) {
  const root = await mkdtemp(join(tmpdir(), 'perp-instrument-subscription-'))
  const store = await MarketStore.open(root), preferences = configuration(), requests: string[] = []
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    requests.push(url.pathname)
    if (url.pathname.endsWith('/public/instruments')) return response(acquire ? await acquire() : definitions)
    if (url.pathname.endsWith('/market/tickers')) return response([btc, eth, sol].map(instId => ({ instId, last: '100', bidPx: '99.99', askPx: '100' })))
    throw new Error(`Unexpected network acquisition: ${url.pathname}`)
  }
  const service = new MarketService(store, () => preferences, fetcher, false)
  // Realtime chart keys are lightweight membership and do not prepare history.
  await service.ready
  projectionIsolation(service)
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { root, store, service, preferences, fetcher, requests, close }
}

const synchronized = async (service: MarketService) => {
  const controller = new AbortController(), context = { signal: controller.signal, receivedAt: Date.now() }
  await service.synchronizeInstruments(context)
  await settle(service)
  assert.equal(service.instrumentStream.synchronized, true)
  return { controller, context }
}
const ids = (service: MarketService) => [...service.candidateIDs].sort()
const listed = (service: MarketService) => service.listRowsFor().map(row => row.instId).sort()

test('subscribe-before-snapshot reconciliation merges buffered listing, delisting and partial definition updates', async () => {
  const held = deferred<unknown[]>(), began = deferred()
  const f = await fixture([], async () => { began.resolve(); return held.promise })
  const controller = new AbortController(), context = { signal: controller.signal, receivedAt: Date.now() }
  const synchronizing = f.service.synchronizeInstruments(context)
  try {
    await began.promise
    f.service.receiveInstruments([{ instId: btc, ctVal: '0.02' }], context)
    f.service.receiveInstruments([{ instId: eth, state: 'expired' }, instrument(sol)], context)
    assert.equal(f.service.candidateIDs, null, 'Buffered deltas cannot be mistaken for a complete initial universe.')
    held.resolve([instrument(), instrument(eth)])
    await synchronizing
    await settle(f.service)
    assert.deepEqual(ids(f.service), [btc, sol])
    assert.equal(f.service.instruments.get(btc).ctVal, '0.02', 'An older REST snapshot cannot overwrite a buffered definition revision.')
    assert.deepEqual(listed(f.service), [btc, sol])
    assert.deepEqual([...f.service.publicRealtime.instruments].sort(), [btc, sol])
    assert.deepEqual([...f.service.realtime.subscriptions.keys()].sort(), ['5m:BTC-USDT-SWAP', '5m:SOL-USDT-SWAP'])
    assert.equal(f.service.preparedCharts.realtimeKeys.size, 6, 'Chart projections retain all periods from each candidate’s 5m source.')
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 1)
  } finally { held.resolve([]); await synchronizing; await f.close() }
})

test('reconnect snapshot preserves fields omitted from buffered partial instrument deltas', async () => {
  const held = deferred<unknown[]>(), began = deferred()
  let snapshots = 0
  const f = await fixture([], async () => {
    if (++snapshots === 1) return [instrument()]
    began.resolve(); return held.promise
  })
  let reconciling: Promise<void> | undefined
  try {
    const first = await synchronized(f.service)
    first.controller.abort(); f.service.instrumentStreamDisconnected(first.context)
    const context = { signal: new AbortController().signal, receivedAt: Date.now() }
    reconciling = f.service.synchronizeInstruments(context)
    await began.promise
    f.service.receiveInstruments([{ instId: btc, tickSz: '0.1' }], context)
    f.service.receiveInstruments([{ instId: btc, lotSz: '1' }], context)
    held.resolve([{ ...instrument(), ctVal: '0.02', tickSz: '0.01', lotSz: '2' }])
    await reconciling; await settle(f.service)
    const current = f.service.instruments.get(btc)
    assert.equal(current.ctVal, '0.02', 'A buffered patch cannot restore a field from the previous socket session.')
    assert.equal(current.tickSz, '0.1')
    assert.equal(current.lotSz, '1')
  } finally { held.resolve([]); await reconciling; await f.close() }
})

test('live metadata additions and delistings update list membership and subscriptions without another discovery request', async () => {
  const f = await fixture()
  try {
    const { context } = await synchronized(f.service)
    const requests = f.requests.length
    f.service.receiveInstruments([instrument(eth)], context)
    await settle(f.service)
    assert.deepEqual(ids(f.service), [btc, eth])
    assert.deepEqual(listed(f.service), [btc, eth])
    f.service.receiveInstruments([{ instId: btc, state: 'suspend' }], context)
    await settle(f.service)
    assert.deepEqual(ids(f.service), [eth])
    assert.deepEqual([...f.service.catalog.keys()], [eth], 'Delisting revokes eligibility immediately.')
    assert.deepEqual(listed(f.service), [btc, eth], 'Published membership has a bounded exit buffer.')
    assert.deepEqual([...f.service.publicRealtime.instruments], [eth])
    assert.ok([...f.service.realtime.subscriptions.values()].every(value => value.instId === eth))
    f.service.receiveInstruments([{ instId: eth, expTime: String(Date.now()) }], context)
    await settle(f.service)
    assert.deepEqual(ids(f.service), [])
    assert.equal(f.service.catalog.size, 0)
    assert.deepEqual(listed(f.service), [btc, eth])
    assert.equal(f.service.publicRealtime.instruments.size, 0)
    assert.equal(f.service.realtime.subscriptions.size, 0)
    assert.equal(f.requests.length, requests, 'An instruments delta needs no REST scan or timer-driven renewal.')
  } finally { await f.close() }
})

test('quiet synchronized metadata remains verified beyond its bounded REST lease without refreshing source timestamps', async t => {
  const f = await fixture()
  try {
    await synchronized(f.service)
    const before = structuredClone(f.service.instrumentObservations.get(btc)), requests = f.requests.length
    const future = before.expiresAt + 120_000
    t.mock.method(Date, 'now', () => future)
    f.service.verifyCatalog()
    assert.deepEqual(listed(f.service), [btc])
    assert.equal(f.service.catalogChecks.get(btc).status, 'verified')
    assert.deepEqual(f.service.instrumentObservations.get(btc), before, 'Quiet channel continuity does not invent another metadata observation.')
    assert.equal(f.requests.length, requests)
  } finally { t.mock.restoreAll(); await f.close() }
})

test('disconnect removes continuous metadata eligibility and a restart cannot restore its session-wide lease', async t => {
  const f = await fixture()
  let restarted: MarketService | undefined
  try {
    const { controller, context } = await synchronized(f.service)
    const observation = structuredClone(f.service.instrumentObservations.get(btc))
    const future = observation.expiresAt + 1
    t.mock.method(Date, 'now', () => future)
    f.service.verifyCatalog()
    assert.deepEqual(listed(f.service), [btc])
    await f.service.persistCatalog([...f.service.catalog.values()])
    assert.ok(f.service.metadata.getCatalogEntry(btc).expiresAt > future, 'The checkpoint captures the currently verified streaming session.')
    controller.abort()
    f.service.instrumentStreamDisconnected({ ...context, receivedAt: future })
    assert.equal(f.service.catalog.size, 0)
    assert.deepEqual(listed(f.service), [btc], 'Disconnect cannot renew eligibility but preserves the exit buffer.')
    assert.equal(f.service.catalogChecks.get(btc).status, 'unknown')
    await f.service.dispose()
    restarted = new MarketService(f.store, () => f.preferences, f.fetcher, false)
    await restarted.ready
    projectionIsolation(restarted)
    assert.deepEqual(listed(restarted), [])
    assert.equal(restarted.catalogChecks.get(btc).status === 'verified' && restarted.validCatalogEntry(restarted.catalogChecks.get(btc)), false, 'Persisted metadata continuity must be capped by its original finite lease.')
    assert.equal(restarted.instrumentStream?.synchronized ?? false, false)
  } finally { t.mock.restoreAll(); await restarted?.dispose(); await f.close() }
})

test('metadata synchronization schedules no idle 30-second or 60-second REST renewal', async t => {
  const f = await fixture()
  try {
    // Enable the ongoing mode after initialization so only the requested
    // metadata synchronization owns startup; sockets remain deterministic.
    f.service.autoRefresh = true
    await synchronized(f.service)
    const requests = [...f.requests]
    assert.equal(f.service.refreshTimer ?? null, null)
    assert.equal(f.service.renewalTimer ?? null, null)
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    t.mock.timers.tick(120_000)
    await setImmediate()
    await settle(f.service)
    assert.deepEqual(f.requests, requests)
    assert.equal(f.service.refreshTimer ?? null, null)
    assert.equal(f.service.renewalTimer ?? null, null)
  } finally { t.mock.timers.reset(); await f.close() }
})

test('a newly durable 5m candle persists without starting bulk history downloads', async t => {
  const f = await fixture([instrument(), instrument(eth)])
  try {
    await synchronized(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    assert.deepEqual(f.service.history.sync.listTasks(), [])
    const requests = f.requests.length
    t.mock.method(Date, 'now', () => asOf + fiveMinutes + 1)
    const row = { instrument: btc, timeframe: '5m', timestamp: asOf, open: 100, high: 102, low: 99, close: 101, volume: 1, baseVolume: 0.01, quoteVolume: 101, confirmed: true }
    await f.service.persistCandles(btc, [row])
    await settle(f.service)
    assert.deepEqual(f.service.history.sync.listTasks(), [])
    const [stored] = await f.store.candles({ instrument: btc, timeframe: '5m', from: asOf, through: asOf })
    assert.equal(stored.close, 101)
    await f.service.persistCandles(btc, [row])
    assert.deepEqual(f.service.history.sync.listTasks(), [], 'An unchanged confirmed revision must not start an archive either.')
    assert.equal(f.requests.length, requests)
  } finally { t.mock.restoreAll(); await f.close() }
})
