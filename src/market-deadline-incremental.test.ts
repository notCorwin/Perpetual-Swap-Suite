import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'

const ids = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']
const instrument = (instId: string) => ({ instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live',
  ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal' })
const quote = (instId: string, now: number, last = '100') => ({ instId, last, bidPx: '100', askPx: '100.01', ts: String(now) })

async function pair(t: TestContext, now: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'perp-deadline-incremental-'))
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const [key, criterion] of Object.entries(preferences.liquidity)) criterion.enabled = key === 'spread'
  const make = async (name: string) => {
    const store = await MarketStore.open(join(root, name))
    const service = new MarketService(store, () => preferences, async () => new Response(JSON.stringify({ code: '0', data: [] })), false)
    service.preparedCharts.setUniverse = () => undefined
    await service.ready
    service.installInstruments(new Map(ids.map(id => [id, instrument(id)])))
    service.verifyCatalog()
    for (const id of ids) service.receivePublicObservation(id, 'ticker', quote(id, now()))
    service.flushStreamQualifications()
    return { service, store }
  }
  const expected = await make('full'), actual = await make('incremental')
  // The only difference is that one service uses the old full recomputation
  // whenever the optimized ticker path would update its single contract.
  expected.service.scheduleTickerDeadline = () => expected.service.scheduleMarketDeadline()
  t.after(async () => {
    for (const instance of [expected, actual]) { await instance.service.dispose(); await instance.store.close() }
    await rm(root, { recursive: true, force: true })
  })
  return { expected: expected.service, actual: actual.service, preferences }
}

function equalDeadlines(expected: MarketService, actual: MarketService) {
  const ordered = (service: MarketService) => [...service.marketDeadlines].sort(([left], [right]) => left.localeCompare(right))
  assert.deepEqual(ordered(actual), ordered(expected))
  if (expected.marketDeadlineAt === null) assert.equal(actual.marketDeadlineAt, null)
  else assert.ok(actual.marketDeadlineAt !== null && actual.marketDeadlineAt <= expected.marketDeadlineAt,
    'A retained early wake is allowed; an incrementally armed timer must never fire later.')
}

test('moving, deleting and restoring the earliest deadline avoid full rescans and preserve catalog order', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  const assign = (service: MarketService, id: string, deadline: number) => {
    const assessed = service.catalogChecks.get(id), published = service.catalog.get(id)
    assessed.expiresAt = deadline
    published.expiresAt = deadline
    assessed.observations.ticker.expiresAt = deadline
    published.observations.ticker.expiresAt = deadline
    service.observations.get(id).ticker.expiresAt = deadline
    service.instrumentObservations.get(id).expiresAt = deadline
  }
  for (const service of [expected, actual]) {
    assign(service, ids[0], now + 500)
    assign(service, ids[1], now + 1000)
    service.scheduleMarketDeadline()
  }
  let scans = 0
  const full = actual.scheduleMarketDeadline.bind(actual)
  actual.scheduleMarketDeadline = () => { scans++; return full() }
  const update = (id: string, deadline: number) => {
    for (const service of [expected, actual]) assign(service, id, deadline)
    expected.scheduleMarketDeadline()
    actual.scheduleTickerDeadline(id)
    equalDeadlines(expected, actual)
  }
  update(ids[0], now + 2000)
  assert.equal(actual.marketDeadlineAt, now + 1000)
  update(ids[0], Number.MAX_SAFE_INTEGER)
  assert.equal(actual.marketDeadlines.has(ids[0]), false)
  update(ids[0], now + 1000)
  assert.equal(scans, 0, 'Local changes must not rebuild every contract deadline.')
  const due: string[] = []
  actual.pruneCatalog = () => undefined
  actual.checkCandleWaits = () => undefined
  actual.flushStreamQualifications = () => undefined
  actual.recoverRequiredSources = () => undefined
  actual.scheduleQualification = (id: string) => { due.push(id) }
  now += 1000
  actual.processMarketDeadline()
  assert.deepEqual(due, ids, 'Tied deadlines are processed in catalog order after restoration.')
})

test('a changed catalog removal deadline is indexed without replacing an already due wake', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  const assign = (service: MarketService, deadline: number) => {
    const assessed = service.catalogChecks.get(ids[0]), published = service.catalog.get(ids[0])
    assessed.expiresAt = deadline; published.expiresAt = deadline
    assessed.observations.ticker.expiresAt = deadline; published.observations.ticker.expiresAt = deadline
    service.observations.get(ids[0]).ticker.expiresAt = deadline
    service.instrumentObservations.get(ids[0]).expiresAt = deadline
    const other = service.catalogChecks.get(ids[1]), otherPublished = service.catalog.get(ids[1])
    other.expiresAt = Number.MAX_SAFE_INTEGER; otherPublished.expiresAt = Number.MAX_SAFE_INTEGER
    other.observations.ticker.expiresAt = Number.MAX_SAFE_INTEGER; otherPublished.observations.ticker.expiresAt = Number.MAX_SAFE_INTEGER
    service.observations.get(ids[1]).ticker.expiresAt = Number.MAX_SAFE_INTEGER
    service.instrumentObservations.get(ids[1]).expiresAt = Number.MAX_SAFE_INTEGER
  }
  for (const service of [expected, actual]) { assign(service, now - 1000); service.scheduleMarketDeadline() }
  assert.equal(actual.marketDeadlineAt, now + 29000)
  let scans = 0
  const full = actual.scheduleMarketDeadline.bind(actual)
  actual.scheduleMarketDeadline = () => { scans++; return full() }
  for (const service of [expected, actual]) assign(service, now + 50000)
  expected.scheduleMarketDeadline(); actual.scheduleTickerDeadline(ids[0]); equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlineAt, now + 50000)
  for (const service of [expected, actual]) assign(service, now - 2000)
  expected.scheduleMarketDeadline(); actual.scheduleTickerDeadline(ids[0]); equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlineAt, now + 28000)
  assert.equal(scans, 0)
  now += 28000
  for (const service of [expected, actual]) assign(service, now + 50000)
  expected.scheduleMarketDeadline(); actual.scheduleTickerDeadline(ids[0]); equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlineAt, now, 'A due callback owns its original timer even after a later observation.')
})

test('publishing or flushing a local stream assessment reuses the deadline index', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  let scans = 0
  const full = actual.scheduleMarketDeadline.bind(actual)
  actual.scheduleMarketDeadline = () => { scans++; return full() }
  for (const service of [expected, actual]) service.publishStreamRecords([{ ...service.catalog.get(ids[0]) }])
  equalDeadlines(expected, actual)
  for (const service of [expected, actual]) {
    service.queueStreamQualification(ids[0])
    service.flushStreamQualifications()
  }
  equalDeadlines(expected, actual)
  assert.equal(scans, 0, 'A same-membership update must not rebuild all market deadlines.')
})

test('ticker-local deadlines match full recomputation through early, late, tied and due observations', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  const both = (operation: (service: MarketService) => void) => { operation(expected); operation(actual); equalDeadlines(expected, actual) }
  equalDeadlines(expected, actual)
  assert.equal(expected.marketDeadlines.get(ids[0]), expected.marketDeadlines.get(ids[1]), 'Both observations start with the same expiry.')

  // An accepted observation may have waited in transport and thus have an
  // earlier lease than the existing assessed value.
  both(service => service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '101'), { receivedAt: now - 1000 }))
  assert.equal(actual.marketDeadlines.get(ids[0]), now + 89000)
  assert.equal(actual.marketDeadlines.get(ids[1]), now + 90000)
  now += 500
  both(service => service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '102')))

  // Publishing a new assessment changes the captured assessed lease too.
  both(service => service.flushStreamQualifications())
  assert.equal(actual.catalogChecks.get(ids[0]).ticker.last, '102')
  const due = expected.marketDeadlineAt!
  now = due
  const oldExpected = [...expected.marketDeadlines], oldActual = [...actual.marketDeadlines]
  for (const service of [expected, actual]) service.receivePublicObservation(ids[1], 'ticker', quote(ids[1], now, '103'))
  assert.deepEqual([...expected.marketDeadlines], oldExpected, 'A queued due timer retains its original deadline evidence.')
  assert.deepEqual([...actual.marketDeadlines], oldActual)
  equalDeadlines(expected, actual)
  for (const service of [expected, actual]) service.autoRefresh = true
  const [beforeExpected, beforeActual] = await Promise.all([expected.snapshot(), actual.snapshot()])
  assert.deepEqual(beforeActual.catalogProgress, beforeExpected.catalogProgress)
  assert.equal(beforeActual.loading, beforeExpected.loading)
  for (const service of [expected, actual]) service.autoRefresh = false
  both(service => service.processMarketDeadline())
})

test('ticker-local scheduling remains bounded while other contracts, source leases and rollover retain their deadlines', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual, preferences } = await pair(t, () => now)
  let fullScans = 0
  const original = actual.scheduleMarketDeadline.bind(actual)
  actual.scheduleMarketDeadline = () => { fullScans++; return original() }
  for (let i = 0; i < 100; i++) {
    now += 1
    expected.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, String(100 + i)))
    actual.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, String(100 + i)))
    equalDeadlines(expected, actual)
  }
  assert.ok(fullScans < 5, `Normal ticker pushes must avoid a market-wide scan (got ${fullScans}).`)
  for (const service of [expected, actual]) service.flushStreamQualifications()
  equalDeadlines(expected, actual)

  preferences.liquidity.openInterest.enabled = true
  for (const service of [expected, actual]) {
    service.receivePublicObservation(ids[1], 'openInterest', { instId: ids[1], oiUsd: '10000000', ts: String(now) })
    service.flushStreamQualifications()
  }
  equalDeadlines(expected, actual)
  now = Math.floor(now / 300000) * 300000 + 300000
  for (const service of [expected, actual]) service.processMarketDeadline()
  equalDeadlines(expected, actual)
  assert.equal(actual.marketBoundary, expected.marketBoundary)
  const [first, second] = await Promise.all([expected.snapshot(), actual.snapshot()])
  assert.deepEqual(second.catalogProgress, first.catalogProgress)
})

test('subscription faults, recovery cancellation and instrument removal match the full scheduler', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  const controllers = [new AbortController(), new AbortController()]
  for (const [index, service] of [expected, actual].entries()) {
    const controller = controllers[index], subscription = { channel: 'tickers', instId: ids[0] }
    service.publicRealtime.subscriptions.set(`tickers:${ids[0]}`, subscription)
    service.tickerSubscribed(ids[0], { signal: controller.signal, receivedAt: now })
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now), { signal: controller.signal, receivedAt: now, acknowledged: true })
    service.flushStreamQualifications()
  }
  equalDeadlines(expected, actual)
  for (const [index, service] of [expected, actual].entries()) {
    service.receivePublicObservation(ids[0], 'ticker', { ...quote(ids[0], now), last: '0' },
      { signal: controllers[index].signal, receivedAt: now, acknowledged: true })
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.tickerRecoveries.get(ids[0])?.retryAt, expected.tickerRecoveries.get(ids[0])?.retryAt)
  now += 500
  for (const [index, service] of [expected, actual].entries()) {
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now), { signal: controllers[index].signal, receivedAt: now, acknowledged: true })
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.tickerRecoveries.has(ids[0]), expected.tickerRecoveries.has(ids[0]))
  for (const [index, service] of [expected, actual].entries()) {
    controllers[index].abort()
    service.tickerDisconnected([ids[0]], { signal: controllers[index].signal })
  }
  equalDeadlines(expected, actual)
  for (const service of [expected, actual]) service.installInstruments(new Map([[ids[1], instrument(ids[1])]]))
  equalDeadlines(expected, actual)
  // A previously due wake owns its captured map until its callback runs.
  for (const service of [expected, actual]) service.processMarketDeadline()
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.has(ids[0]), false)
})

test('a wall-clock rollback rebuilds other contracts after their deadlines had expired', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const start = now, { expected, actual } = await pair(t, () => now)
  now += 90001
  for (const service of [expected, actual]) service.processMarketDeadline()
  equalDeadlines(expected, actual)
  for (const id of [ids[1], ids[0]]) {
    for (const service of [expected, actual]) service.receivePublicObservation(id, 'ticker', quote(id, now))
    equalDeadlines(expected, actual)
  }
  assert.deepEqual(new Set(actual.marketDeadlines.keys()), new Set(ids))
  now = start + 1000
  // Keep source timestamps monotonic while the local wall clock moves back.
  for (const service of [expected, actual]) service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], start + 90001))
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.get(ids[1]), expected.marketDeadlines.get(ids[1]), 'A different contract can become future-dated after rollback.')
  for (const service of [expected, actual]) {
    await service.dispose()
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], start + 90002))
    assert.equal(service.marketDeadlineTimer, null)
    assert.equal(service.marketDeadlineAt, null)
  }
})

test('another contract’s OI and book changes are reflected by the next ticker without losing a due callback', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual, preferences } = await pair(t, () => now)
  preferences.liquidity.openInterest.enabled = true
  preferences.liquidity.depth.enabled = true
  for (const service of [expected, actual]) service.scheduleMarketDeadline()
  const book = (id: string) => ({ instId: id, bids: [['100', '2000']], asks: [['100.01', '2000']], ts: String(now) })
  for (const service of [expected, actual]) {
    // Both contracts change outside the ticker path. In particular, B's OI
    // has just one millisecond of its accepted source lease remaining.
    service.receivePublicObservation(ids[1], 'openInterest', { instId: ids[1], oiUsd: '10000000', ts: String(now) }, { receivedAt: now - 89999 })
    service.receivePublicObservation(ids[1], 'book', book(ids[1]), { receivedAt: now - 2000 })
    service.receivePublicObservation(ids[0], 'openInterest', { instId: ids[0], oiUsd: '10000000', ts: String(now) }, { receivedAt: now - 1000 })
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '101'))
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.get(ids[1]), now + 1)
  assert.equal(actual.marketDeadlineAt, now + 1)

  now += 1
  const captured = [...actual.marketDeadlines]
  for (const service of [expected, actual]) {
    service.receivePublicObservation(ids[1], 'openInterest', { instId: ids[1], oiUsd: '10000000', ts: String(now) }, { receivedAt: now })
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '102'))
  }
  assert.deepEqual([...actual.marketDeadlines], captured, 'A due callback must retain its captured, now-expired source evidence.')
  equalDeadlines(expected, actual)
  for (const service of [expected, actual]) service.autoRefresh = true
  const [oldSnapshot, newSnapshot] = await Promise.all([expected.snapshot(), actual.snapshot()])
  assert.deepEqual(newSnapshot.catalogProgress, oldSnapshot.catalogProgress)
  assert.equal(newSnapshot.loading, oldSnapshot.loading)
  for (const service of [expected, actual]) service.autoRefresh = false
  for (const service of [expected, actual]) service.processMarketDeadline()
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlineDirty.size, 0, 'A completed full scan consumes the dirty observations.')
})

test('REST source replacements and remove/re-add cannot leave another contract with a stale deadline', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual, preferences } = await pair(t, () => now)
  preferences.liquidity.openInterest.enabled = true
  for (const service of [expected, actual]) service.scheduleMarketDeadline()
  for (const service of [expected, actual]) {
    service.acceptObservation(ids[1], 'openInterest', { value: { oiUsd: '10000000' }, source: 'rest', observedAt: now - 89999, expiresAt: now + 1 })
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '101'))
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.get(ids[1]), now + 1)
  for (const service of [expected, actual]) service.installInstruments(new Map([[ids[0], instrument(ids[0])]]))
  for (const service of [expected, actual]) service.installInstruments(new Map(ids.map(id => [id, instrument(id)])))
  await Promise.all([expected, actual].flatMap(service => [...service.instrumentRetirements.values()]))
  for (const service of [expected, actual]) service.verifyCatalog()
  for (const service of [expected, actual]) {
    service.receivePublicObservation(ids[1], 'openInterest', { instId: ids[1], oiUsd: '10000000', ts: String(now) }, { receivedAt: now - 1000 })
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '102'))
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.get(ids[1]), now + 89000)
})

test('committed historical observation on another contract becomes visible at the next ticker', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 299000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual, preferences } = await pair(t, () => now)
  preferences.liquidity.volume24h.enabled = true
  const asOf = Math.floor(now / 300000) * 300000
  const rows = Array.from({ length: 288 }, (_, index) => ({ instrument: ids[1], timeframe: '5m', timestamp: asOf - (288 - index) * 300000,
    open: 100, high: 101, low: 99, close: 100, volume: 10, baseVolume: 1, quoteVolume: 200000, confirmed: true }))
  for (const service of [expected, actual]) {
    await service.store.appendCandles(rows)
    service.scheduleMarketDeadline()
    const observations = service.observations.get(ids[1])
    const observation = await service.observeHistoricalSource(ids[1], 'turnover', observations, service.shutdownController.signal, false, () => true)
    assert.equal(observation?.value.turnover, 57600000)
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '101'))
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlines.get(ids[1]), now + 1000)
  for (const service of [expected, actual]) {
    service.invalidateLiquidityHistory(ids[1], null, '5m')
    service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now, '102'))
  }
  equalDeadlines(expected, actual)
})

test('ticker updates preserve pending list and book retirement deadlines', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 20000
  t.mock.method(Date, 'now', () => now)
  const { expected, actual } = await pair(t, () => now)
  const retirementAt = now + 9000
  for (const service of [expected, actual]) {
    const entry = service.catalog.get(ids[1])
    service.listRemovals.set(ids[1], { entry, removeAt: now + 14000 })
    service.bookRetirements.set(ids[1], retirementAt)
    service.scheduleMarketDeadline()
  }
  let scans = 0
  const full = actual.scheduleMarketDeadline.bind(actual)
  actual.scheduleMarketDeadline = () => { scans++; return full() }
  for (let i = 0; i < 50; i++) {
    now++
    for (const service of [expected, actual]) service.receivePublicObservation(ids[0], 'ticker', quote(ids[0], now))
    equalDeadlines(expected, actual)
    assert.equal(actual.marketDeadlineAt, retirementAt)
  }
  assert.equal(scans, 0)
  // The owning operation may replace deadlines without changing map sizes.
  // Its reconciliation must immediately publish the earlier deadline.
  for (const service of [expected, actual]) {
    service.bookRetirements.set(ids[1], now + 1000)
    service.scheduleMarketDeadline()
  }
  equalDeadlines(expected, actual)
  assert.equal(actual.marketDeadlineAt, now + 1000)
})
