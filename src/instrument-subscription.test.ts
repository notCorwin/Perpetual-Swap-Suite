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
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.readListBars = async () => ({ bars: [] })
  service.scheduleListProjection = () => undefined
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
  await service.ready
  projectionIsolation(service)
  const targets: { instId: string; historyDays: number; asOf: number }[] = []
  service.history.target = async (instId: string, target: { historyDays: number; asOf: number }) => { targets.push({ instId, ...target }); return [] }
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { root, store, service, preferences, fetcher, requests, targets, close }
}

const synchronized = async (service: MarketService) => {
  const controller = new AbortController(), context = { signal: controller.signal, receivedAt: Date.now() }
  await service.synchronizeInstruments(context)
  await settle(service)
  assert.equal(service.instrumentStream.synchronized, true)
  return { controller, context }
}
const ids = (service: MarketService) => [...service.candidateIDs].sort()
const listed = (service: MarketService) => service.listRowsFor('15m').map(row => row.instId).sort()

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
    assert.equal(f.service.realtime.subscriptions.size, 6, 'Both eligible contracts receive every native candle timeframe.')
    assert.equal(f.requests.filter(path => path.endsWith('/public/instruments')).length, 1)
  } finally { held.resolve([]); await synchronizing; await f.close() }
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
    assert.deepEqual(listed(f.service), [eth])
    assert.deepEqual([...f.service.publicRealtime.instruments], [eth])
    assert.ok([...f.service.realtime.subscriptions.values()].every(value => value.instId === eth))
    f.service.receiveInstruments([{ instId: eth, expTime: String(Date.now()) }], context)
    await settle(f.service)
    assert.deepEqual(ids(f.service), [])
    assert.deepEqual(listed(f.service), [])
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
    assert.deepEqual(listed(f.service), [])
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

test('a newly durable 5m candle advances only its instrument history target without a REST scan', async t => {
  const f = await fixture([instrument(), instrument(eth)])
  try {
    await synchronized(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    assert.deepEqual(f.targets.map(target => target.instId).sort(), [btc, eth])
    f.targets.length = 0
    const requests = f.requests.length
    t.mock.method(Date, 'now', () => asOf + fiveMinutes + 1)
    const row = { instrument: btc, timeframe: '5m', timestamp: asOf, open: 100, high: 102, low: 99, close: 101, volume: 1, baseVolume: 0.01, quoteVolume: 101, confirmed: true }
    await f.service.persistCandles(btc, [row])
    await settle(f.service)
    assert.deepEqual(f.targets, [{ instId: btc, historyDays: f.preferences.historyDays, asOf: asOf + fiveMinutes }])
    const [stored] = await f.store.candles({ instrument: btc, timeframe: '5m', from: asOf, through: asOf })
    assert.equal(stored.close, 101)
    await f.service.persistCandles(btc, [row])
    assert.equal(f.targets.length, 1, 'An unchanged confirmed revision cannot advance an already current target twice.')
    assert.equal(f.requests.length, requests)
  } finally { t.mock.restoreAll(); await f.close() }
})
