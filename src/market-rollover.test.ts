import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore, type CandleRecord } from '../electron/services/market-store.js'
import { MarketService, type MarketServiceSnapshot } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const fiveMinutes = 300_000
const hour = 3_600_000
const epoch = Date.UTC(2026, 9, 24)
const instruments = ['BTC', 'ETH', 'SOL'].map(base => ({
  instId: `${base}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT',
  ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: base, ruleType: 'normal',
}))
const ids = instruments.map(instrument => instrument.instId)
const candle = (instrument: string, timestamp: number, quoteVolume = 200_000, timeframe = '5m'): CandleRecord => ({
  instrument, timeframe, timestamp, open: 99, high: 101, low: 98, close: 100,
  volume: 2_000, baseVolume: 20, quoteVolume, confirmed: true,
})
const raw = (row: CandleRecord) => [row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume, row.quoteVolume, row.confirmed ? 1 : 0].map(String)
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Exercise the transport's real subscription ownership and acknowledgement
// handling. Merely listing a desired subscription is not continuity proof.
class CandleSocket extends EventTarget {
  readyState = 0
  heldAcknowledgements = new Set<string>()
  acknowledgements: (() => void)[] = []
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(value: string) {
    if (value === 'ping') { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: 'pong' }))); return }
    const command = JSON.parse(value)
    for (const arg of command.args) {
      const acknowledge = () => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, event: command.op, arg }) }))
      if (this.heldAcknowledgements.has(`${arg.channel}:${arg.instId}`)) this.acknowledgements.push(acknowledge)
      else queueMicrotask(acknowledge)
    }
  }
  releaseAcknowledgements() { this.heldAcknowledgements.clear(); for (const acknowledge of this.acknowledgements.splice(0)) queueMicrotask(acknowledge) }
  candle(row: CandleRecord) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      arg: { instId: row.instrument, channel: `candle${row.timeframe}` }, data: [raw(row)],
    }) }))
  }
  close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
}

const fixture = async (context: TestContext, { hourly = false, connected = true, partialAck = false, threshold = 30_000_000 } = {}) => {
  const now = epoch + (hourly ? hour : fiveMinutes) - 15_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
  const boundary = asOf + fiveMinutes
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  for (const key of ['volume24h', 'spread', 'depth', 'openInterest'] as const) preferences.liquidity[key].enabled = true
  preferences.liquidity.volume24h.minUSDT = threshold
  preferences.liquidity.volumeStability.enabled = hourly
  const root = await mkdtemp(join(tmpdir(), 'perp-market-rollover-'))
  const store = await MarketStore.open(root), socket = new CandleSocket()
  let offline = false, fetches = 0
  const fetcher: typeof fetch = async input => {
    fetches++
    assert.equal(offline, false, 'Rollover must reuse the existing live observations, not refresh discovery or REST leases.')
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(ids.map(instId => ({ instId, last: '100', bidPx: '99.99', askPx: '100' })))
    if (path.endsWith('/market/books')) return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }])
    if (path.endsWith('/public/open-interest')) return response(ids.map(instId => ({ instId, oiUsd: '6000000' })))
    throw new Error(`Unexpected fixture endpoint: ${path}`)
  }
  const service = new MarketService(store, () => preferences, fetcher, false, { webSocketFactory: () => socket })
  const isolateQualification = (value: MarketService) => {
    value.preparedCharts.setRealtimeSubscriptions = () => undefined
    value.preparedCharts.setUniverse = () => ({ frames: [] })
    value.updateRanking = async () => undefined
    value.scheduleRefresh = () => undefined
    value.scheduleRenewal = () => undefined
  }
  isolateQualification(service)
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  try {
    await service.ready
    for (const lane of service.requestLanes.values()) lane.interval = 0
    await store.appendCandles(ids.flatMap(id => [
      ...Array.from({ length: 288 }, (_, index) => candle(id, asOf - (288 - index) * fiveMinutes)),
      ...(hourly ? Array.from({ length: 24 }, (_, index) => candle(id, epoch - (24 - index) * hour, 2_000_000, '1H')) : []),
    ]))
    const ensurePrices = service.history.ensurePrices.bind(service.history)
    service.history.ensurePrices = async () => { throw new Error('The initial qualification window is already durable.') }
    await service.refresh()
    assert.deepEqual((await service.snapshot()).rows.map(row => row.instId).sort(), [...ids].sort())
    service.history.ensurePrices = ensurePrices
    service.history.ensureStatistics = async () => ({ rows: [] })
    const priceRequests: string[] = []
    const get = service.get.bind(service)
    service.get = async (path: string, ...args: unknown[]) => {
      if (path === '/market/candles' || path === '/market/history-candles') {
        priceRequests.push(path)
        // Keep recovery unavailable, so a fresh REST result cannot conceal
        // incorrectly retained or prematurely discarded runtime facts.
        throw new Error('Historical REST recovery is intentionally unavailable in this fixture.')
      }
      return get(path, ...args)
    }
    if (connected) {
      if (partialAck) {
        service.realtime.ackTimeoutMs = 30_000
        socket.heldAcknowledgements.add(`candle5m:${ids[1]}`)
      }
      service.realtime.start(); socket.open()
      await service.realtime.whenIdle()
      for (const id of ids) {
        assert.equal(service.realtime.isSubscribed(id, '5m'), !partialAck || id !== ids[1])
        if (hourly) assert.equal(service.realtime.isSubscribed(id, '1H'), false)
      }
    }
    offline = true
    service.autoRefresh = true
    const initialFetches = fetches
    const waitFor = async (condition: () => boolean, sample?: () => Promise<void>) => {
      const deadline = performance.now() + 3_000
      while (!condition()) {
        if (performance.now() >= deadline) assert.fail(`Timed out waiting for rollover: ${JSON.stringify({
          now: Date.now(), waits: [...service.candleWaits.keys()], error: service.error,
          recoveries: [...service.sourceRecoveries.values()].map(value => ({ source: value.source, instId: value.instId, retryAt: value.retryAt, active: Boolean(value.task) })),
          sync: [...service.history.sync.tasks.values()].map(value => ({ instrument: value.instrument, timeframe: value.timeframe, status: value.status, error: value.lastError })),
          priceRequests,
        })}`)
        context.mock.timers.tick(0)
        await turn()
        await sample?.()
      }
    }
    const advance = async (milliseconds: number) => { context.mock.timers.tick(milliseconds); await turn() }
    const roll = async () => { await advance(boundary - Date.now()) }
    const qualifiedIDs = () => [...service.catalog.values()].filter(entry => service.validCatalogEntry(entry)).map(entry => entry.instrumentID).sort()
    const publishedIDs = async () => (await service.snapshot()).rows.map(row => row.instId).sort()
    const historical = (id: string, key = 'turnover') => structuredClone(service.observations.get(id)?.[key])
    const live = () => ids.map(id => Object.fromEntries(['ticker', 'book', 'openInterest'].map(key => [key, structuredClone(service.observations.get(id)?.[key])])))
    return { service, store, socket, preferences, asOf, boundary, root, fetcher, isolateQualification,
      waitFor, advance, roll, qualifiedIDs, publishedIDs, historical, live, priceRequests, close,
      assertNoRefresh: () => assert.equal(fetches, initialFetches),
    }
  } catch (error) { await close(); throw error }
}

test('a live 5m rollover keeps all rows and original source provenance, then replaces staggered instruments atomically', async context => {
  const f = await fixture(context), samples: MarketServiceSnapshot[] = [], notifications: Promise<void>[] = []
  const sample = async () => { samples.push(await f.service.snapshot()) }
  let unsubscribe = () => {}
  try {
    const original = ids.map(id => f.historical(id)), sources = f.live()
    await f.advance(16)
    unsubscribe = f.service.subscribeMarket(() => { notifications.push(sample()) })
    await f.roll()
    await sample()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort(), 'Calendar rollover alone must not empty the eligible list.')
    await f.waitFor(() => f.service.candleWaits.size === ids.length, sample)
    assert.deepEqual(f.priceRequests, [], 'All instruments must concurrently await their subscribed closing candles.')
    for (const [index, id] of ids.entries()) assert.deepEqual(f.historical(id), original[index], 'Retention must not rewrite asOf, observedAt, or the original expiry.')

    for (const [index, id] of ids.entries()) {
      await f.advance(1_000)
      const turnover = 57_800_000 + index * 200_000
      f.socket.candle(candle(id, f.asOf, 400_000 + index * 200_000))
      await f.waitFor(() => f.service.catalog.get(id)?.result.turnover === turnover, sample)
      await f.service.realtime.whenIdle()
      const snapshot = await f.service.snapshot()
      assert.equal(snapshot.rows.find(row => row.instId === id)?.turnover24hUSDT, turnover)
      assert.equal(f.historical(id).value.asOf, f.boundary)
      for (let pending = index + 1; pending < ids.length; pending++) assert.deepEqual(f.historical(ids[pending]), original[pending])
      await f.advance(16)
      await Promise.all(notifications)
    }
    assert.ok(notifications.length >= ids.length, 'Renderer listeners must observe each independently completed replacement.')
    for (const snapshot of samples) {
      assert.deepEqual(snapshot.rows.map(row => row.instId).sort(), [...ids].sort(), 'Neither polling nor a listener snapshot may observe an intermediate disappearance.')
      assert.equal(snapshot.catalogProgress.verified, ids.length)
      assert.equal(snapshot.error, '')
    }
    assert.deepEqual(f.live(), sources, 'Local historical renewal cannot extend unrelated source leases.')
    assert.deepEqual(f.priceRequests, [])
    f.assertNoRefresh()
  } finally { unsubscribe(); await f.close() }
})

test('continuity binds when the native ACK arrives between historical validation and deferred publication', async context => {
  const f = await fixture(context, { connected: false })
  try {
    f.socket.heldAcknowledgements.add(`candle5m:${ids[0]}`)
    f.service.realtime.start(); f.socket.open()
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), false)
    f.service.catalog.delete(ids[0])
    const put = f.service.metadata.putCatalogEntry.bind(f.service.metadata)
    f.service.metadata.putCatalogEntry = (record: unknown) => {
      const result = put(record)
      for (const acknowledge of f.socket.acknowledgements.splice(0)) acknowledge()
      return result
    }
    await f.service.checkCandidate(instruments[0], f.preferences.liquidity, f.service.catalogCriteriaKey(), f.service.shutdownController.signal, 'foreground', { localOnly: true })
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), true)
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort(), 'The ACK/publication ordering cannot revoke a validated continuous subscription at its first close.')
  } finally { await f.close() }
})

test('one completed 5m source rolls both qualification windows forward without another full-window database read', async context => {
  const f = await fixture(context, { hourly: true })
  try {
    let historicalReads = 0
    const read = f.service.readQualificationCandles.bind(f.service)
    f.service.readQualificationCandles = (...args: unknown[]) => { historicalReads++; return read(...args) }
    for (const id of ids) await f.store.appendStatistics({ instrument: id, timeframe: '5m', source: 'oi',
      from: f.asOf - fiveMinutes, through: f.asOf - fiveMinutes, values: [[f.asOf - fiveMinutes, 100]], observedAt: Date.now() })
    await f.roll()
    for (const id of ids) {
      f.socket.candle(candle(id, f.asOf, 400_000))
    }
    await f.service.realtime.whenIdle()
    await f.waitFor(() => ids.every(id => f.service.catalog.get(id)?.observations.turnover.value.asOf === f.boundary
      && f.service.catalog.get(id)?.observations.hourly.value.asOf === f.boundary))
    assert.equal(historicalReads, 0, 'Previously validated windows consume only the new source and derived commits.')
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    assert.ok(ids.every(id => f.service.catalog.get(id).result.turnover === 57_800_000))
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('ordinary forming ticks do not rescan every instrument deadline', async context => {
  const f = await fixture(context)
  try {
    let scans = 0
    const schedule = f.service.scheduleMarketDeadline.bind(f.service)
    f.service.scheduleMarketDeadline = () => { scans++; return schedule() }
    for (let index = 0; index < 100; index++) {
      context.mock.timers.tick(1)
      f.socket.candle({ ...candle(ids[index % ids.length], f.asOf), confirmed: false, volume: 2_000 + index })
    }
    await f.service.realtime.whenIdle()
    assert.equal(scans, 0, 'Updated quote timestamps do not change qualification deadlines.')
  } finally { await f.close() }
})

test('a newly committed final that fails the volume threshold removes only its instrument', async context => {
  const f = await fixture(context, { threshold: 57_500_000 })
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.socket.candle(candle(ids[0], f.asOf, 0))
    await f.waitFor(() => f.service.catalogChecks.get(ids[0])?.status === 'failed')
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort(), 'A known failed final must not use the old passing assessment for the rest of the delivery window.')
    assert.deepEqual(await f.publishedIDs(), [...ids].sort(), 'The failed contract remains in published rows during the 30-second list-removal buffer.')
    assert.equal(f.service.catalogChecks.get(ids[0]).result.turnover, 57_400_000)
    assert.equal(f.historical(ids[0]).value.asOf, f.boundary)
    assert.deepEqual(f.priceRequests, [])
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('an accepted final does not expose the next historical window before its local write commits', async context => {
  const f = await fixture(context), held = deferred(), writing = deferred()
  try {
    const original = f.historical(ids[0]), append = f.store.appendCandles.bind(f.store)
    f.store.appendCandles = async (...args) => {
      if (args[0].some(row => row.instrument === ids[0])) { writing.resolve(); await held.promise }
      return append(...args)
    }
    await f.roll()
    f.socket.candle(candle(ids[0], f.asOf, 400_000))
    await writing.promise
    f.socket.candle(candle(ids[1], f.asOf, 600_000))
    await f.waitFor(() => f.service.catalog.get(ids[1])?.result.turnover === 58_000_000)
    await f.advance(9_999)
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    assert.deepEqual(f.historical(ids[0]), original)
    assert.equal((await f.service.snapshot()).rows.find(row => row.instId === ids[0])?.turnover24hUSDT, 57_600_000)
    assert.deepEqual(await f.store.candles({ instrument: ids[0], timeframe: '5m', from: f.asOf, through: f.asOf }), [])
    assert.equal(f.service.realtime.getProgress(ids[0], '5m').committedThrough, null)
    // The local commit may keep its acquisition waiter; it cannot extend the
    // renderer's permission to display the old assessment beyond ten seconds.
    await f.advance(1)
    assert.deepEqual(await f.qualifiedIDs(), [ids[1]], 'A pending write cannot retain stale rows; another instrument already committed its replacement independently.')
    held.resolve()
    await f.service.realtime.whenIdle()
    await f.waitFor(() => f.service.catalog.get(ids[0])?.result.turnover === 57_800_000)
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(0, 2).sort())
    assert.equal(f.historical(ids[0]).value.asOf, f.boundary)
    f.assertNoRefresh()
  } finally { held.resolve(); await f.close() }
})

test('missing finals retain their old assessment for less than ten seconds and cannot renew it indefinitely', async context => {
  const f = await fixture(context)
  try {
    const original = ids.map(id => f.historical(id))
    await f.roll()
    await f.advance(9_999)
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    assert.deepEqual(f.priceRequests, [])
    await f.advance(1)
    assert.deepEqual(await f.qualifiedIDs(), [], 'The calendar grace period has a fixed delivery deadline.')
    await f.waitFor(() => f.priceRequests.length >= ids.length)
    await f.advance(29_999)
    assert.deepEqual(await f.qualifiedIDs(), [])
    assert.deepEqual(await f.publishedIDs(), [...ids].sort(), 'Published rows remain buffered after rollover retention ends and before 30 seconds elapse.')
    await f.advance(1)
    assert.deepEqual(await f.publishedIDs(), [], 'The exit buffer lasts exactly 30 seconds after the delivery allowance ends.')
    for (const [index, id] of ids.entries()) {
      const retained = f.historical(id)
      if (retained) assert.equal(retained.value.asOf, original[index].value.asOf, 'Retries must not relabel stale input as a newer window.')
    }
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('disconnecting the confirmed-candle socket immediately ends rollover retention', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.socket.close()
    await turn()
    assert.deepEqual(await f.qualifiedIDs(), [], 'Desired subscriptions without an active acknowledged transport cannot retain old facts.')
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), false)
    await f.advance(16)
    assert.deepEqual(await f.qualifiedIDs(), [])
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('a desired but never acknowledged candle subscription does not admit rollover retention', async context => {
  const f = await fixture(context, { connected: false })
  try {
    assert.ok(f.service.realtime.subscriptions.size > 0)
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), false)
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [])
    f.assertNoRefresh()
  } finally { await f.close() }
})

for (const source of ['ticker', 'book', 'openInterest'] as const) test(`an expired ${source} removes retained rows at its own deadline`, async context => {
  const f = await fixture(context)
  try {
    // Shorten a real source's fixture lease before the rollover. Historical
    // continuity must never turn these independent finite leases into grace.
    f.service.observations.get(ids[0])[source].expiresAt = f.boundary + 1_000
    if (source === 'openInterest') {
      // The canonical bulk snapshot is reusable evidence too. Expire it so
      // recovery cannot correctly restore the source from a still-valid copy.
      f.service.openInterest.snapshot.expiresAt = f.boundary + 1_000
      f.service.openInterest.snapshot.values.get(ids[0]).expiresAt = f.boundary + 1_000
    }
    f.service.scheduleMarketDeadline()
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    await f.advance(1_000)
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort())
    assert.deepEqual(await f.publishedIDs(), [...ids].sort(), 'An expired required source removes strict eligibility immediately while its row is buffered.')
  } finally { await f.close() }
})

test('an explicit source invalidation ends the retained assessment immediately', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.service.bookUnsubscribed(ids[0])
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort())
    assert.deepEqual(await f.publishedIDs(), [...ids].sort(), 'Explicit source revocation invalidates qualification immediately but published rows use the removal buffer.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('a correction inside the retained history invalidates it before replacement qualification completes', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    await f.service.persistCandles(ids[0], [candle(ids[0], f.asOf - fiveMinutes, 0)])
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort(), 'A changed input invalidates the retained proof immediately after its durable commit.')
    await f.advance(16)
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort())
    assert.equal(f.historical(ids[0]), undefined)
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('changing liquidity criteria cannot reuse an assessment retained under the previous configuration', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.preferences.liquidity.volume24h.minUSDT = 31_000_000
    assert.deepEqual(await f.qualifiedIDs(), [], 'Another passing threshold still needs a matching criteria identity.')
    f.service.verifyCatalog()
    assert.deepEqual(await f.qualifiedIDs(), [], 'Local re-evaluation must not manufacture a current historical window from the retained one.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('restoring previous criteria during rollover cannot restore their revoked runtime authority', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.service.autoRefresh = false
    let previous = structuredClone(f.preferences)
    f.preferences.liquidity.volume24h.minUSDT = 31_000_000
    await f.service.reconfigure(previous)
    previous = structuredClone(f.preferences)
    f.preferences.liquidity.volume24h.minUSDT = 30_000_000
    await f.service.reconfigure(previous)
    f.service.autoRefresh = true
    f.service.verifyCatalog()
    assert.deepEqual(await f.qualifiedIDs(), [], 'A → B → A settings must require fresh current-window evidence.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('a reconnect acknowledgement cannot restore the old connection’s rollover authority', async context => {
  const f = await fixture(context)
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    const originalConnection = f.service.realtime.connection
    f.socket.close()
    await turn()
    f.service.realtime.options.onReconnect = async () => undefined
    f.service.realtime.cancelRetry()
    f.service.realtime.connect()
    f.socket.open()
    await f.service.realtime.whenIdle()
    assert.notEqual(f.service.realtime.connection, originalConnection)
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), true)
    f.service.verifyCatalog()
    assert.deepEqual(await f.qualifiedIDs(), [], 'Only the original continuously acknowledged connection may bridge its closing boundary.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('reconnecting before a close cannot rebind a fresh observation to the replacement connection', async context => {
  const f = await fixture(context)
  try {
    f.socket.close()
    await turn()
    f.service.realtime.options.onReconnect = async () => undefined
    f.service.realtime.cancelRetry()
    f.service.realtime.connect()
    f.socket.open()
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), true)
    f.service.verifyCatalog()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort(), 'The original window remains fresh until the close.')
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [], 'Rechecking a still-fresh value cannot transfer its original connection ownership.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('removing and readding a subscription on one connection cannot reuse its previous membership proof', async context => {
  const f = await fixture(context)
  try {
    const connection = f.service.realtime.connection
    const subscriptions = [...f.service.realtime.subscriptions.values()]
    f.service.realtime.setSubscriptions(subscriptions.filter((value: { instId: string; timeframe: string }) => value.instId !== ids[0] || value.timeframe !== '5m'))
    await f.service.realtime.whenIdle()
    f.service.realtime.setSubscriptions(subscriptions)
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.connection, connection)
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), true)
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort(), 'A replacement subscription must not compare equal to an absent ownership token.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('an unrelated pending acknowledgement cannot prevent a continuously subscribed instrument from bridging its close', async context => {
  const f = await fixture(context, { partialAck: true })
  try {
    assert.equal(f.service.realtime.getState().status, 'connecting')
    assert.equal(f.service.realtime.isSubscribed(ids[0], '5m'), true)
    await f.roll()
    const continuous = [ids[0], ids[2]].sort()
    assert.deepEqual(await f.qualifiedIDs(), continuous, 'Only the unacknowledged source loses continuity; the other series retain their own authority.')
    await f.advance(1_000)
    f.socket.releaseAcknowledgements()
    await f.service.realtime.whenIdle()
    assert.equal(f.service.realtime.getState().status, 'live')
    assert.deepEqual(await f.qualifiedIDs(), continuous, 'A late ACK cannot renew the previous historical assessment.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('equal metadata refreshes preserve rollover while changed and restored contract units revoke it', async context => {
  const f = await fixture(context)
  try {
    const previous = structuredClone(f.preferences)
    f.service.autoRefresh = false
    f.preferences.liquidity.depth.enabled = false
    await f.service.reconfigure(previous)
    f.service.autoRefresh = true
    await f.roll()
    const definitions = () => new Map(structuredClone(instruments).map(instrument => [instrument.instId, instrument]))
    f.service.installInstruments(definitions())
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort(), 'A semantically identical metadata response must reuse the same contract epoch.')
    const changed = definitions()
    changed.get(ids[0])!.ctVal = '0.02'
    f.service.installInstruments(changed)
    f.service.installInstruments(definitions())
    f.service.verifyCatalog()
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort(), 'Changing and restoring units must not revive the original assessment.')
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('reopening durable catalog checkpoints cannot resurrect runtime rollover retention', async context => {
  const f = await fixture(context)
  let reopened: MarketService | undefined
  try {
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    await f.service.dispose()
    reopened = new MarketService(f.store, () => f.preferences, f.fetcher, false, { webSocketFactory: () => new CandleSocket() })
    f.isolateQualification(reopened)
    await reopened.ready
    assert.deepEqual((await reopened.snapshot()).rows, [], 'Disk checkpoints carry their original historical lease, not a live socket or a newly minted delivery window.')
    assert.equal(reopened.realtime.isSubscribed(ids[0], '5m'), false)
    f.assertNoRefresh()
  } finally { await reopened?.dispose(); await f.close() }
})

test('acknowledging a new socket alone cannot give a fresh checkpoint runtime rollover authority', async context => {
  const f = await fixture(context), socket = new CandleSocket()
  let reopened: MarketService | undefined
  try {
    await f.service.dispose()
    reopened = new MarketService(f.store, () => f.preferences, f.fetcher, false, { webSocketFactory: () => socket })
    f.isolateQualification(reopened)
    await reopened.ready
    assert.deepEqual((await reopened.snapshot()).rows.map(row => row.instId).sort(), [...ids].sort())
    reopened.realtime.start(); socket.open()
    await reopened.realtime.whenIdle()
    assert.equal(reopened.realtime.isSubscribed(ids[0], '5m'), true)
    await f.roll()
    assert.ok([...reopened.catalog.values()].every(entry => !reopened!.validCatalogEntry(entry)), 'Acknowledgement cannot renew a checkpoint’s historical qualification.')
    assert.deepEqual((await reopened.snapshot()).rows.map(row => row.instId).sort(), [...ids].sort(), 'A checkpoint admitted while fresh gets the ordinary exit buffer when its lease later expires.')
    f.assertNoRefresh()
  } finally { await reopened?.dispose(); await f.close() }
})

test('a current-window read racing a new durable close cannot invalidate the unaffected published window', async context => {
  const f = await fixture(context), samples: Promise<MarketServiceSnapshot>[] = []
  try {
    await f.roll()
    const append = f.service.appendChangedCandlesLocked.bind(f.service)
    f.service.appendChangedCandlesLocked = async (rows: CandleRecord[], priority?: string) => {
      const changed = await append(rows, priority)
      const observations = f.service.observations.get(ids[0])
      await f.service.observeHistoricalSource(ids[0], 'turnover', observations, new AbortController().signal, false, () => true)
      f.service.verifyCatalog()
      return changed
    }
    const invalidate = f.service.invalidateLiquidityHistory.bind(f.service)
    f.service.invalidateLiquidityHistory = (instrument: string, rows: CandleRecord[] | null, timeframe?: string) => {
      invalidate(instrument, rows, timeframe); samples.push(f.service.snapshot())
    }
    f.socket.candle(candle(ids[0], f.asOf, 400_000))
    await f.service.realtime.whenIdle()
    await f.waitFor(() => f.service.catalog.get(ids[0])?.result.turnover === 57_800_000)
    assert.ok(samples.length > 0)
    for (const snapshot of await Promise.all(samples)) assert.deepEqual(snapshot.rows.map(row => row.instId).sort(), [...ids].sort())
    f.assertNoRefresh()
  } finally { await f.close() }
})

test('live-source recovery during an hourly rollover waits for a complete new historical tuple before readmission', async context => {
  const f = await fixture(context, { hourly: true })
  const writing = deferred(), held = deferred()
  const aggregate = f.store.aggregateCandles.bind(f.store)
  f.store.aggregateCandles = async (range, priority) => {
    if (range.instrument === ids[0] && range.timeframe === '1H') { writing.resolve(); await held.promise }
    return aggregate(range, priority)
  }
  try {
    await f.roll()
    f.socket.candle(candle(ids[0], f.asOf, 400_000))
    await writing.promise
    const observation = f.service.observations.get(ids[0]).openInterest
    observation.expiresAt = Date.now()
    f.service.streamQualifications.add(ids[0]); f.service.flushStreamQualifications()
    await f.waitFor(() => !f.service.streamEvaluations.has(ids[0]))
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort())
    f.service.acceptObservation(ids[0], 'openInterest', { ...observation, observedAt: Date.now(), expiresAt: Date.now() + 90_000 })
    f.service.streamQualifications.add(ids[0]); f.service.flushStreamQualifications()
    await turn()
    assert.deepEqual(await f.qualifiedIDs(), ids.slice(1).sort(), 'Recovered live input must not admit new turnover with the previous hour’s window.')
    held.resolve()
    await f.service.realtime.whenIdle()
    await f.waitFor(() => f.service.catalog.get(ids[0])?.result.volumeRatio === 1.3)
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    f.assertNoRefresh()
  } finally { held.resolve(); await f.close() }
})

for (const blocked of ['15m', '1H']) test(`an hourly rollover keeps the complete assessment while its ${blocked} derivation is committing`, async context => {
  const f = await fixture(context, { hourly: true })
  const writing = deferred(), held = deferred()
  const aggregate = f.store.aggregateCandles.bind(f.store)
  f.store.aggregateCandles = async (range, priority) => {
    if (range.instrument === ids[0] && range.timeframe === blocked) { writing.resolve(); await held.promise }
    return aggregate(range, priority)
  }
  try {
    const originalTurnover = f.historical(ids[0]), originalHourly = f.historical(ids[0], 'hourly')
    await f.roll()
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    assert.deepEqual(f.historical(ids[0]), originalTurnover)
    assert.deepEqual(f.historical(ids[0], 'hourly'), originalHourly)
    f.socket.candle(candle(ids[0], f.asOf, 400_000))
    await writing.promise
    assert.equal(f.service.realtime.getProgress(ids[0], '5m').pendingConfirmations, 1)
    await f.advance(16)
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort(), 'The source transaction must not publish an intermediate historical tuple.')
    assert.equal((await f.service.snapshot()).rows.find(row => row.instId === ids[0])?.turnover24hUSDT, 57_600_000)
    await f.advance(1_000)
    held.resolve()
    await f.service.realtime.whenIdle()
    await f.waitFor(() => f.service.catalog.get(ids[0])?.result.turnover === 57_800_000 && f.service.catalog.get(ids[0])?.result.volumeRatio === 1.3)
    assert.deepEqual(await f.qualifiedIDs(), [...ids].sort())
    assert.equal(f.historical(ids[0]).value.asOf, f.boundary)
    assert.equal(f.historical(ids[0], 'hourly').value.asOf, f.boundary)
    assert.deepEqual(f.priceRequests, [])
    f.assertNoRefresh()
  } finally { held.resolve(); await f.close() }
})
