import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import type { LiquidityInput } from '../electron/services/liquidity.js'
import type { DataAuditSnapshot } from '../electron/services/market-service.js'

const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const fiveMinutes = 300_000
const hour = 3_600_000
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const rawCandle = (timestamp: number, close = 100) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: Math.max(0.000001, close - 1), high: close + 1, low: Math.max(0.000001, close - 2), close, volume: 1, baseVolume: 1, quoteVolume: close, confirmed: true })
const nativeCandle = (timestamp: number, timeframe: '5m' | '15m' | '1H', close = 100) => ({ ...rawCandle(timestamp, close), timeframe })
const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition.')
}


test('native candles preserve absent or explicit-null statistics without manufacturing a derived row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, fetch, false)
  try {
    const start = Date.UTC(2024, 0, 1)
    await service.persistCandles('BTC-USDT-SWAP', [{
      ...rawCandle(start),
      timeframe: '1H',
      oi: null,
      buy: null,
      sell: null,
    }])
    const [native] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '1H', from: start, through: start })
    assert.equal(native.oi, null)
    assert.equal(native.buy, null)
    assert.equal(native.sell, null)
    assert.deepEqual(await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: start, through: start }), [])
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('1H list projections read the native candle sequence instead of a 5m aggregation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 20, 12)
  const first = end - 200 * hour
  const native = Array.from({ length: 201 }, (_, index) => ({ ...rawCandle(first + index * hour, 200 + index), timeframe: '1H', statisticsVersion: 1, oi: 1_000 + index, buy: 100 + index, sell: 50 + index }))
  const raw = Array.from({ length: 12 }, (_, index) => rawCandle(end - index * fiveMinutes, 1))
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, fetch, false)
  try {
    await store.appendCandles([...native, ...raw])
    const projection = await service.readListBars({ instrument }, '1H')
    assert.equal(projection.end, end)
    assert.equal(projection.bars.at(-1)?.close, native.at(-1)?.close)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('5m writes do not mutate native timeframe OI or taker statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const start = Date.UTC(2024, 7, 1)
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, fetch, false)
  try {
    await store.appendCandles([{ ...rawCandle(start, 100), timeframe: '1H', oi: 9_999, buy: 8_888, sell: 7_777, statisticsVersion: 1 }])
    await service.persistCandles(instrument.instId, Array.from({ length: 12 }, (_, index) => ({
      ...rawCandle(start + index * fiveMinutes, 100 + index), oi: 10 + index, buy: 20 + index, sell: 30 + index,
    })))
    const [derived] = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: start, through: start })
    assert.equal(derived.oi, 9_999)
    assert.equal(derived.buy, 8_888)
    assert.equal(derived.sell, 7_777)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('Taker zero placeholders become unavailable without erasing genuine zero-volume periods or healthy direct values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 20, 12)
  const timestamps = Array.from({ length: 100 }, (_, index) => end - (99 - index) * hour)
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, fetch, false)
  try {
    await store.appendCandles(timestamps.map((timestamp, index) => ({
      ...nativeCandle(timestamp, '1H'),
      ...(index === 98 ? { volume: 0, quoteVolume: 0 } : {}),
      oi: 1_000 + index,
      buy: index === 97 ? 12 : null,
      sell: index === 97 ? 13 : null,
      statisticsVersion: index === 97 ? 1 : 5,
    })))
    const values = timestamps.map((timestamp, index) => [String(timestamp),
      index === 1 ? '-1' : [0, 97, 98].includes(index) ? '0' : '20',
      index === 2 ? '' : [0, 97, 98].includes(index) ? '0' : '30',
    ])
    await assert.rejects(service.persistStatisticsSource(instrument, '1H', end, 2, values), /statistics quantities/i, 'Malformed source quantities cannot certify an empty observation.')
    await service.persistStatisticsSource(instrument, '1H', end, 2, values.filter((_value, index) => index !== 1 && index !== 2))
    const rows = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: timestamps[0], through: end })
    for (const index of [0, 1, 2]) {
      assert.equal(rows[index].buy, null)
      assert.equal(rows[index].sell, null)
      assert.equal(rows[index].oi, 1_000 + index, 'Rejecting Taker must retain the independent OI source.')
      assert.equal(rows[index].statisticsVersion, 11, 'Invalid Taker is an observed null, not an unfetched source.')
      assert.ok(Number(rows[index].statisticsTakerExpiresAt) > Date.now() + 5 * hour)
    }
    assert.deepEqual([rows[3].sell, rows[3].buy], [20, 30], 'The direct endpoint order is sell then buy.')
    assert.deepEqual([rows[97].buy, rows[97].sell], [12, 13], 'A zero placeholder cannot erase healthy direct statistics.')
    assert.deepEqual([rows[98].buy, rows[98].sell], [0, 0], 'A candle with genuinely no trades may have zero on both sides.')
    assert.equal(rows[98].statisticsVersion, 1)
    assert.equal(rows[98].statisticsTakerExpiresAt, null)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

const prefs = () => structuredClone(DEFAULT_PREFERENCES) as import('../electron/services/metadata-store.js').Preferences
const disabled = () => {
  const value = prefs()
  for (const rule of Object.values(value.liquidity)) rule.enabled = false
  return value
}
const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const ticker = { instId, last: '100', bidPx: '99.99', askPx: '100', open24h: '90', high24h: '110', low24h: '80', volCcy24h: '999999999' }
const isolateChartPreparation = (service: MarketService) => {
  // Qualification/ranking assertions measure their own I/O, independently of chart background work.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
}
const fixture = async (preferences = disabled(), fetcher: typeof fetch = async () => { throw new Error('Unexpected network request.') }, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-service-integrated-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => preferences, fetcher, false, options)
  const prepareSubscriptions = service.preparedCharts.setRealtimeSubscriptions.bind(service.preparedCharts)
  isolateChartPreparation(service)
  await service.ready
  // Broad background targets are tested by MarketHistory; service tests control their source universe explicitly.
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  const resumeChartPreparation = () => { service.preparedCharts.setRealtimeSubscriptions = prepareSubscriptions; service.updateSubscriptions() }
  return { root, store, service, preferences, close, resumeChartPreparation }
}
const localCatalog = (service: MarketService, ids = [instId]) => service.replaceCatalog(ids.map(id => ({
  instrument: { ...instrument, instId: id }, ticker: { ...ticker, instId: id }, result: { eligible: true, status: 'verified', turnover: 40_000_000 },
})))

test('all candidate contracts retain native collection while unselected contracts avoid chart preparation', async () => {
  const f = await fixture(), other = 'ETH-USDT-SWAP', frames = ['5m', '15m', '1H']
  try {
    f.service.instruments.set(other, { ...instrument, instId: other })
    f.service.candidateIDs = new Set([instId, other])
    localCatalog(f.service)
    f.resumeChartPreparation()
    const expected = [instId, other].flatMap(id => frames.map(timeframe => `${id}:${timeframe}`)).sort()
    assert.deepEqual([...f.service.preparedCharts.realtimeKeys].sort(), expected)
    assert.deepEqual([...f.service.realtime.subscriptions.values()].map(({ instId, timeframe }: any) => `${instId}:${timeframe}`).sort(), expected)
    assert.equal(f.service.catalog.has(other), false, 'The second contract has no qualified list row or chart selection.')
    assert.deepEqual(f.service.chartSubscriptions, [])

    const timestamp = Math.floor(Date.now() / hour) * hour
    const row = { ...nativeCandle(timestamp, '1H', 123), instrument: other, confirmed: false }
    await f.service.realtime.options.onForming(row, { signal: new AbortController().signal, receivedAt: Date.now() })
    assert.equal(f.service.liveCandles.get(`${other}:1H`).close, 123)
    assert.equal(f.service.preparedCharts.liveStates.get(`${other}:1H`).live.close, 123, 'An unselected contract retains only its lightweight current candle.')
    assert.equal(f.service.preparedCharts.series.has(`${other}:1H`), false, 'Collector membership cannot initialize a full historical chart.')
    assert.equal(f.service.preparedCharts.liveSeeds.has(`${other}:1H`), false)
    await f.service.setChartUniverse([instId], '15m', instId)
    assert.deepEqual([...f.service.preparedCharts.realtimeKeys].sort(), expected, 'Focusing a qualified chart cannot remove any candidate subscription.')
  } finally { await f.close() }
})

test('snapshot versions omit unchanged rows, detect status changes, and isolate collector sessions', async () => {
  const f = await fixture()
  try {
    f.service.history.sync.listTasks = () => { throw new Error('Polling must not clone historical tasks.') }
    const first = await f.service.snapshot('15m')
    assert.equal(typeof first.serviceSession, 'string')
    const unchanged = await f.service.snapshot('15m', { sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('unchanged' in unchanged, true)
    assert.equal('rows' in unchanged, false)
    for (let tick = 1; tick <= 10; tick++) f.service.realtime.setState({ updatedAt: tick })
    assert.equal('unchanged' in await f.service.snapshot('15m', { sinceRevision: first.revision, serviceSession: first.serviceSession }), true)
    f.service.pendingCandidates.set('pending-qualification', { instId, configKey: f.service.catalogCriteriaKey() })
    f.service.touchList() // This fixture mutation represents candidate admission.
    const pending = await f.service.snapshot('15m', { sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('rows' in pending, true)
    assert.equal(pending.catalogProgress.pending, 1)
    assert.equal(pending.loading, true)
    assert.equal('unchanged' in await f.service.snapshot('15m', { sinceRevision: pending.revision, serviceSession: pending.serviceSession }), true, 'Stable qualification work must not change a read-only snapshot revision.')
    f.service.pendingCandidates.delete('pending-qualification')
    f.service.touchList()
    const settled = await f.service.snapshot('15m', { sinceRevision: pending.revision, serviceSession: pending.serviceSession })
    assert.equal('rows' in settled, true)
    assert.equal(settled.catalogProgress.pending, 0)
    assert.equal(settled.loading, false)
    f.service.realtime.setState({ status: 'connecting' })
    const connected = await f.service.snapshot('15m', { sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('rows' in connected, true)
    assert.equal(connected.realtimeState, 'connecting')
    f.service.error = 'Market source unavailable.'
    f.service.touchList()
    const changed = await f.service.snapshot('15m', { sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('rows' in changed, true)
    assert.ok(changed.revision > first.revision)
    assert.equal(changed.error, 'Market source unavailable.')
    const restarted = await f.service.snapshot('15m', { sinceRevision: changed.revision, serviceSession: 'retired-session' })
    assert.equal('rows' in restarted, true)
    const full = await f.service.snapshot('1H', { sinceRevision: -1, serviceSession: first.serviceSession })
    assert.equal('rows' in full, true)
    assert.equal(full.timeframe, '1H')
  } finally { await f.close() }
})

test('history completion without a new durable mutation does not invalidate list projections', async () => {
  const f = await fixture()
  let projections = 0
  try {
    f.service.projectListEntry = async () => { projections++; return null }
    localCatalog(f.service)
    await f.service.persistCandles(instId, [rawCandle(Math.floor(Date.now() / fiveMinutes) * fiveMinutes - fiveMinutes)])
    const before = projections
    const task = { instrument: instId, timeframe: '5m', status: 'completed' }
    for (let index = 0; index < 10; index++) f.service.onHistoryProgress(task)
    assert.equal(projections, before)
    const revision = f.service.revision
    for (const status of ['queued', 'running', 'completed']) f.service.onHistoryProgress({ ...task, status })
    assert.ok(f.service.revision > revision, 'Progress transitions must notify even when no durable market row changes.')
  } finally { await f.close() }
})

test('a failed list projection retries at its own deadline and publishes completion even when row values are unchanged', async context => {
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = await fixture()
  let attempts = 0
  try {
    f.service.updateRanking = async () => undefined
    f.service.readListBars = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Local projection worker is temporarily unavailable.')
      return { bars: [] }
    }
    localCatalog(f.service)
    await new Promise(resolve => setImmediate(resolve))
    const failed = await f.service.snapshot()
    assert.equal(attempts, 1)
    assert.match(failed.error, /Local projection worker/)
    assert.equal(failed.listProgress.pending, 1)
    context.mock.timers.tick(999)
    assert.equal(attempts, 1)
    const revision = f.service.revision
    context.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
    const completed = await f.service.snapshot()
    assert.equal(attempts, 2)
    assert.equal(completed.error, '')
    assert.equal(completed.listProgress.completed, 1)
    assert.equal(completed.listProgress.pending, 0)
    assert.ok(completed.revision > revision)
    context.mock.timers.tick(60_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(attempts, 2, 'Successful projection leaves no periodic retry.')
  } finally { await f.close() }
})
const discovery = (extra?: (url: URL) => Response | Promise<Response | null> | null): typeof fetch => async input => {
  const url = new URL(String(input))
  if (url.pathname.endsWith('/public/instruments')) return response([instrument])
  if (url.pathname.endsWith('/market/tickers')) return response([ticker])
  const result = await extra?.(url)
  if (result) return result
  throw new Error(`Unexpected ${url}`)
}

test('legacy inferred unavailable observations are revalidated through bounded HTTP while genuine history is retained', async () => {
  const timestamp = Math.floor((Date.now() - 30 * 86_400_000) / fiveMinutes) * fiveMinutes
  const calls: URL[] = []
  const f = await fixture(disabled(), async input => {
    const url = new URL(String(input)); calls.push(url)
    assert.ok(url.pathname.endsWith('/taker-volume-contract'))
    assert.equal(url.searchParams.get('begin'), String(timestamp - fiveMinutes))
    assert.equal(url.searchParams.get('end'), String(timestamp + fiveMinutes))
    return response([[String(timestamp), '333', '444']])
  })
  try {
    await f.store.appendCandles([{ ...rawCandle(timestamp), oi: 777, buy: null, sell: null,
      statisticsVersion: 7, statisticsTakerExpiresAt: Date.now() + hour }])
    const result = await f.service.history.ensureStatistics(instId, '5m', timestamp, timestamp)
    assert.deepEqual([result.rows[0].oi, result.rows[0].buy, result.rows[0].sell], [777, 444, 333])
    assert.equal(calls.length, 1)
    assert.equal(result.rows[0].statisticsTakerExpiresAt, null)
    await f.service.history.ensureStatistics(instId, '5m', timestamp, timestamp)
    assert.equal(calls.length, 1)
  } finally { await f.close() }
})

test('constructor requires full Preferences and opens durable owned metadata', async () => {
  const f = await fixture()
  try {
    assert.equal(f.service.metadata.getSettings().preferences.chartTimeframe, '15m')
    assert.equal(f.service.history.sync.closed, false)
    assert.throws(() => new MarketService(f.store, (() => ({ hourlyVolumeStabilityEnabled: true })) as any), /Preferences/)
    await f.service.persistCatalog([{ instrument, ticker, result: { eligible: true, status: 'verified' } }])
    await f.service.dispose()
    const metadata = await MetadataStore.open(join(f.root, 'Metadata'))
    assert.equal(metadata.getCatalogEntry(instId)?.status, 'verified')
    metadata.close()
  } finally { await f.close() }
})

test('discovery follows enabled conditions and publishes before a slower candidate completes', async () => {
  let resolveSlow!: (value: Response) => void
  let slowStarted = false
  const configuration = disabled()
  configuration.liquidity.openInterest.enabled = true
  configuration.liquidity.depth.enabled = true
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([instrument, { ...instrument, instId: 'ETH-USDT-SWAP' }])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker, { ...ticker, instId: 'ETH-USDT-SWAP' }])
    if (url.pathname.endsWith('/public/open-interest')) {
      return response([{ instId, oiUsd: '6000000' }, { instId: 'ETH-USDT-SWAP', oiUsd: '1' }])
    }
    if (url.pathname.endsWith('/market/books')) {
      if (url.searchParams.get('instId') === instId) return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }])
      slowStarted = true
      return new Promise(resolve => { resolveSlow = resolve })
    }
    if (url.pathname.endsWith('/market/history-candles')) return response([])
    throw new Error(`Disabled conditions must not request ${url}`)
  }
  const f = await fixture(configuration, fetcher)
  try {
    const refresh = f.service.refresh()
    await waitFor(() => slowStarted && f.service.catalog.has(instId))
    assert.equal((await f.service.snapshot()).rows[0].instId, instId)
    assert.equal(f.service.refreshing !== null, true)
    resolveSlow(response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }]))
    await refresh
    assert.deepEqual((await f.service.snapshot()).rows.map(row => row.instId), [instId])
  } finally { resolveSlow?.(response([])); await f.close() }
})

test('24-hour turnover uses exactly 288 completed native quote-volume observations', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let historyCalls = 0
  const f = await fixture(configuration, discovery(url => {
    if (url.pathname.endsWith('/market/history-candles')) { historyCalls += 1; return response([]) }
    return null
  }))
  try {
    const candles = Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 }))
    await f.service.persistCandles(instId, candles)
    await f.service.refresh()
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.rows[0].turnover24hUSDT, 57_600_000)
    assert.equal(historyCalls, 0, 'Complete persisted ranges never redownload history.')
    assert.equal(f.service.metadata.getCatalogEntry(instId).configKey, JSON.stringify(configuration.liquidity))
  } finally { await f.close() }
})

test('missing 24-hour source data remains unknown instead of manufacturing zero turnover', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  const f = await fixture(configuration, discovery())
  try {
    f.service.history.ensurePrices = async () => ({ rows: [] })
    await f.service.persistCandles(instId, [rawCandle(asOf - fiveMinutes)])
    await f.service.refresh()
    assert.equal((await f.service.snapshot()).rows.length, 0)
    assert.equal(f.service.metadata.getCatalogEntry(instId).status, 'unknown')
  } finally { await f.close() }
})

test('failed and empty observations retain an existing valid lease without extending it', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  let empty = false
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response(empty ? [] : [{ instId, oiUsd: '6000000' }]) : null))
  try {
    await f.service.refresh()
    const initial = f.service.metadata.getCatalogEntry(instId)
    empty = true
    await f.service.refresh()
    const retained = f.service.metadata.getCatalogEntry(instId)
    assert.equal(retained.status, 'verified')
    assert.equal(retained.observations.openInterest.observedAt, initial.observations.openInterest.observedAt)
    assert.ok(retained.expiresAt <= initial.observations.openInterest.expiresAt, 'Renewed instrument metadata cannot extend the retained open-interest source lease.')
    f.service.catalog.get(instId).expiresAt = Date.now() - 1
    assert.equal((await f.service.snapshot()).rows.length, 0)
  } finally { await f.close() }
})

test('qualified contracts renew independently while discovery waits for another instrument history', async () => {
  const configuration = disabled()
  configuration.liquidity.openInterest.enabled = true
  configuration.liquidity.volume24h.enabled = true
  const otherID = 'ETH-USDT-SWAP'
  let discoverOther = false, oiCalls = 0, blocked = false
  let release!: () => void
  const historyGate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response(discoverOther ? [instrument, { ...instrument, instId: otherID }] : [instrument])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker, { ...ticker, instId: otherID }])
    if (url.pathname.endsWith('/public/open-interest')) {
      oiCalls += 1
      return response([{ instId, oiUsd: '6000000' }, { instId: otherID, oiUsd: '6000000' }])
    }
    throw new Error(`Unexpected ${url}`)
  })
  let refresh: Promise<void> | undefined
  try {
    f.service.updateRanking = async () => undefined
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      if (id === otherID) { blocked = true; await historyGate }
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    await f.service.refresh()
    assert.equal(f.service.catalog.has(instId), true)
    discoverOther = true
    refresh = f.service.refresh()
    await waitFor(() => blocked && oiCalls === 2 && f.service.candidateTasks.size === 1)
    const previous = f.service.catalog.get(instId)
    previous.expiresAt = Date.now() - 1
    assert.equal((await f.service.snapshot()).rows.length, 0, 'An expired contract is never displayed as currently qualified.')
    f.service.tickerCache.observedAt = Date.now() - 90_001
    await f.service.renewCatalog()
    await waitFor(() => oiCalls === 3 && f.service.candidateTasks.size === 1)
    assert.equal(f.service.refreshing !== null, true, 'Renewal must finish without waiting for full discovery.')
    assert.equal(oiCalls, 3)
    assert.deepEqual((await f.service.snapshot()).rows.map(row => row.instId), [instId])
    assert.ok(f.service.catalog.get(instId).expiresAt > Date.now())
  } finally { release(); await refresh; await f.close() }
})

test('expired qualification stays hidden after unavailable observations and recovers through independent renewal', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  let unavailable = false
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response(unavailable ? [] : [{ instId, oiUsd: '6000000' }]) : null))
  try {
    f.service.updateRanking = async () => undefined
    await f.service.refresh()
    const observed = f.service.observations.get(instId).openInterest
    observed.expiresAt = Date.now() - 1
    f.service.catalog.get(instId).expiresAt = Date.now() - 1
    assert.equal((await f.service.snapshot()).rows.length, 0)
    assert.equal(f.service.renewalTargets.has(instId), true)
    unavailable = true
    await f.service.renewCatalog()
    await waitFor(() => f.service.metadata.getCatalogEntry(instId).status === 'unknown' && f.service.candidateTasks.size === 0)
    const missing = await f.service.snapshot()
    assert.equal(missing.rows.length, 0)
    assert.equal(missing.catalogProgress.unknown, 1)
    assert.match(missing.error, /verification is unavailable/i)
    assert.equal(f.service.metadata.getCatalogEntry(instId).status, 'unknown')
    assert.equal(f.service.metadata.getCatalogEntry(instId).observations.openInterest.expiresAt, observed.expiresAt, 'A failed request cannot renew an old observation.')
    assert.equal(f.service.renewalTargets.has(instId), true, 'Missing data must not remove a previously qualified contract from renewal.')
    unavailable = false
    await f.service.renewCatalog()
    await waitFor(() => f.service.catalog.has(instId) && f.service.candidateTasks.size === 0)
    const recovered = await f.service.snapshot()
    assert.deepEqual(recovered.rows.map(row => row.instId), [instId])
    assert.equal(recovered.catalogProgress.verified, 1)
    assert.equal(recovered.error, '')
  } finally { await f.close() }
})

test('historical preparation completes before live liquidity and repairs only the ticker aged during the wait', async () => {
  const configuration = disabled()
  for (const key of ['spread', 'depth', 'slippage', 'volume24h', 'openInterest'] as const) configuration.liquidity[key].enabled = true
  let preparing = false, tickerCalls = 0, targetedTickerCalls = 0, bookCalls = 0, oiCalls = 0
  let release!: () => void
  const historyGate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([instrument])
    if (url.pathname.endsWith('/market/tickers')) { tickerCalls += 1; return response([{ ...ticker, last: tickerCalls === 1 ? '99' : '100' }]) }
    if (url.pathname.endsWith('/market/ticker')) { targetedTickerCalls += 1; assert.equal(url.searchParams.get('instId'), instId); return response([{ ...ticker, last: '100' }]) }
    if (url.pathname.endsWith('/market/books')) { bookCalls += 1; return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }]) }
    if (url.pathname.endsWith('/public/open-interest')) { oiCalls += 1; return response([{ instId, oiUsd: '6000000' }]) }
    throw new Error(`Unexpected ${url}`)
  })
  let refresh: Promise<void> | undefined
  try {
    f.service.updateRanking = async () => undefined
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 287 }, (_, index) => ({ ...rawCandle(asOf - (287 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      preparing = true; await historyGate
      await f.service.persistCandles(id, [{ ...rawCandle(from), quoteVolume: 200_000 }])
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    refresh = f.service.refresh()
    await waitFor(() => preparing)
    assert.deepEqual([tickerCalls, bookCalls, oiCalls], [1, 0, 0])
    f.service.tickerCache.observedAt = Date.now() - 90_001
    for (const value of f.service.tickerCache.values.values()) value.expiresAt = Date.now() - 1
    release(); await refresh
    assert.deepEqual([tickerCalls, targetedTickerCalls, bookCalls, oiCalls], [1, 1, 1, 1])
    assert.equal(f.service.metadata.getCatalogEntry(instId).status, 'verified')
    assert.equal((await f.service.snapshot()).rows[0].lastPrice, 100)
  } finally { release(); await refresh; await f.close() }
})

test('overlapping discovery and renewal checks share one instrument observation and publication', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  let oiCalls = 0, writes = 0
  let release!: () => void
  const oiGate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, discovery(async url => {
    if (!url.pathname.endsWith('/public/open-interest')) return null
    oiCalls += 1
    await oiGate
    return response([{ instId, oiUsd: '6000000' }])
  }))
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined
  try {
    f.service.updateRanking = async () => undefined
    const put = f.service.metadata.putCatalogEntry.bind(f.service.metadata)
    f.service.metadata.putCatalogEntry = (record: unknown) => { writes += 1; return put(record) }
    const observedAt = Date.now()
    f.service.instrumentObservations.set(instId, { observedAt, expiresAt: observedAt + 90_000 })
    const key = JSON.stringify(configuration.liquidity)
    first = f.service.checkCandidate(instrument, configuration.liquidity, key, new AbortController().signal)
    await waitFor(() => oiCalls === 1)
    second = f.service.checkCandidate(instrument, configuration.liquidity, key, new AbortController().signal, 'foreground')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(oiCalls, 1)
    release(); await Promise.all([first, second])
    assert.equal(writes, 1)
    assert.equal(f.service.candidateTasks.size, 0)
    assert.deepEqual((await f.service.snapshot()).rows.map(row => row.instId), [instId])
  } finally { release(); await Promise.allSettled([first, second]); await f.close() }
})

test('empty or unverifiable discovery reports unavailable market verification rather than no qualified contracts', async () => {
  for (const missing of ['instruments', 'tickers', 'supported-metadata'] as const) {
    const f = await fixture(disabled(), async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/public/instruments')) return response(missing === 'instruments' ? [] : [missing === 'supported-metadata' ? { ...instrument, instCategory: '' } : instrument])
      if (url.pathname.endsWith('/market/tickers')) return response(missing === 'tickers' ? [] : [ticker])
      throw new Error(`Unexpected ${url}`)
    })
    try {
      await f.service.refresh()
      const snapshot = await f.service.snapshot()
      assert.equal(snapshot.rows.length, 0)
      assert.match(snapshot.error, missing === 'instruments' ? /no swap instruments.*verification is unavailable/i : missing === 'tickers' ? /no swap tickers/i : /instrument metadata could be verified/i)
      assert.equal(snapshot.catalogProgress.failed, 0)
    } finally { await f.close() }
  }
})

test('restored renewal targets include prior qualification without turning every unknown contract into a priority scan', async () => {
  const f = await fixture()
  let restored: MarketService | undefined
  try {
    const timestamp = Date.now(), otherID = 'ETH-USDT-SWAP', priorID = 'SOL-USDT-SWAP'
    await f.service.persistCatalog([
      { instrument, ticker, result: { eligible: true, status: 'verified' }, status: 'verified', observedAt: timestamp - 90_001, expiresAt: timestamp - 1 },
      { instrument: { ...instrument, instId: otherID }, ticker: { ...ticker, instId: otherID }, result: { eligible: false, status: 'unknown' }, status: 'unknown', observedAt: timestamp, expiresAt: timestamp },
      { instrument: { ...instrument, instId: priorID }, ticker: { ...ticker, instId: priorID }, result: { eligible: false, status: 'unknown' }, status: 'unknown', renewalTarget: true, observedAt: timestamp, expiresAt: timestamp },
    ])
    await f.service.dispose()
    restored = new MarketService(f.store, () => f.preferences, async () => { throw new Error('Offline') }, false)
    isolateChartPreparation(restored)
    await restored.ready
    assert.deepEqual((await restored.snapshot()).rows, [], 'Cached expired or unknown contracts remain hidden.')
    assert.deepEqual([...restored.renewalTargets.keys()].sort(), [instId, priorID].sort())
    assert.equal(restored.renewalTargets.has(otherID), false)
  } finally { await restored?.dispose(); await f.close() }
})

test('known failing historical turnover does not consume live liquidity requests', async () => {
  const configuration = disabled()
  for (const key of ['spread', 'depth', 'openInterest', 'volume24h'] as const) configuration.liquidity[key].enabled = true
  let liveCalls = 0
  const f = await fixture(configuration, discovery(url => {
    if (url.pathname.endsWith('/market/books') || url.pathname.endsWith('/public/open-interest')) liveCalls += 1
    throw new Error(`A known historical rejection must not request ${url}`)
  }))
  try {
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 1 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => ({ rows: await f.store.candles({ instrument: id, timeframe, from, through }) })
    await f.service.refresh()
    assert.equal(liveCalls, 0)
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.rows.length, 0)
    assert.equal(snapshot.catalogProgress.failed, 1)
    assert.equal(snapshot.error, '')
  } finally { await f.close() }
})

test('a genuine liquidity rejection has a completed failed check and no data error', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response([{ instId, oiUsd: '1' }]) : null))
  try {
    await f.service.refresh()
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.rows.length, 0)
    assert.equal(snapshot.error, '')
    assert.deepEqual(snapshot.catalogProgress, { total: 1, completed: 1, verified: 0, failed: 1, unknown: 0, pending: 0 })
    assert.equal(f.service.renewalTargets.has(instId), false)
  } finally { await f.close() }
})

test('SQLite catalogue restore enforces config key and expiry while historical charts remain readable', async () => {
  const f = await fixture()
  let restored: MarketService | undefined
  try {
    localCatalog(f.service)
    await f.service.persistCatalog([...f.service.catalog.values()])
    const first = Date.UTC(2024, 0, 1)
    await f.service.persistCandles(instId, Array.from({ length: 300 }, (_, index) => ({ ...rawCandle(first + index * fiveMinutes), oi: 100, buy: 10, sell: 8, statisticsVersion: 1 })))
    await f.service.dispose()
    restored = new MarketService(f.store, () => f.preferences, async () => { throw new Error('Offline') }, false)
    isolateChartPreparation(restored)
    await restored.ready
    assert.equal((await restored.snapshot()).rows.length, 1)
    restored.catalog.get(instId).expiresAt = Date.now() - 1
    assert.equal((await restored.snapshot()).rows.length, 0)
    const chart = await restored.prepareChartWindow(instId, '5m', first + 299 * fiveMinutes)
    assert.equal(chart.bars.filter(bar => bar.hour >= chart.endHour! - 95 * fiveMinutes).length, 96)
    f.preferences.liquidity.spread.maxPercent *= 2
    assert.equal(await restored.restoreCatalog(), false)
  } finally { await restored?.dispose(); await f.close() }
})

test('ranking uses one completed 5m boundary independently of chart timeframe', async () => {
  const f = await fixture()
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  try {
    localCatalog(f.service, [instId, 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'])
    for (const [id, change] of [[instId, 10], ['ETH-USDT-SWAP', -20]] as const) {
      const candles = Array.from({ length: 7 }, (_, index) => ({ ...rawCandle(asOf - (7 - index) * fiveMinutes, index >= 6 ? 100 + change : 100), instrument: id }))
      await f.service.persistCandles(id, candles)
      await f.service.updateRanking(id)
    }
    await f.service.ensureListTimeframe('15m')
    const before = await f.service.snapshot('15m')
    assert.deepEqual(before.rows.map(row => row.instId), ['ETH-USDT-SWAP', instId, 'SOL-USDT-SWAP'])
    assert.equal(before.rows[0].rankingAsOf, asOf)
    const previous = structuredClone(f.preferences)
    f.preferences.chartTimeframe = '1H'
    await f.service.reconfigure(previous)
    assert.deepEqual((await f.service.snapshot('1H')).rows.map(row => [row.instId, row.rankingChange]), before.rows.map(row => [row.instId, row.rankingChange]))
    const old = structuredClone(f.preferences); f.preferences.rankingLookback = 30
    await f.service.reconfigure(old)
    await waitFor(() => f.service.rankings.get(instId)?.rankingAsOf === asOf)
    assert.notEqual(f.service.rankings.get(instId)?.rankingChange, null)
  } finally { await f.close() }
})

test('ranking reads completed local data before any repair and memoizes repeated unchanged snapshots', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let reads = 0, repairs = 0
  try {
    f.service.projectListEntry = async () => null
    await f.store.appendCandles(Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)))
    const read = f.store.candles.bind(f.store)
    f.store.candles = async (...args) => { reads += 1; return read(...args) }
    f.service.history.ensurePrices = async () => { repairs += 1; throw new Error('Complete local ranking must not wait for network history.') }
    localCatalog(f.service)
    await f.service.updateRanking(instId, { ensure: true })
    const expected = (106 - 103) / 103 * 100
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, expected)
    assert.equal(repairs, 0)
    assert.equal(reads, 1)
    for (let index = 0; index < 10; index += 1) await f.service.snapshot()
    assert.equal(reads, 1, 'Snapshot reads must not admit local ranking reads.')
    assert.equal(repairs, 0)
  } finally { await f.close() }
})

test('confirmed candle cache gives the first list row and lookback changes immediate rankings without I/O', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let reads = 0
  try {
    f.service.projectListEntry = async () => null
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    const read = f.store.candles.bind(f.store)
    f.store.candles = async (...args) => { reads += 1; return read(...args) }
    localCatalog(f.service)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, (106 - 103) / 103 * 100)
    const previous = structuredClone(f.preferences)
    f.preferences.rankingLookback = 30
    await f.service.reconfigure(previous)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, 6)
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, asOf)
    assert.equal(reads, 0)
    assert.equal(f.service.rankingRepairs.size, 0)
    const correction = rawCandle(asOf - fiveMinutes, 110)
    await f.service.persistCandles(instId, [correction], { projectList: false })
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, 10, 'A confirmed close correction invalidates the memoized ranking immediately.')
    const persistenceReads = reads
    await f.service.updateRanking(instId)
    await f.service.snapshot()
    assert.equal(reads, persistenceReads, 'Ranking reuses the committed correction cache without admitting another database read.')
  } finally { await f.close() }
})

test('a changed lookback with incomplete cache stays unavailable without blocking on local or network work', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let release!: () => void, started = false
  const readGate = new Promise<void>(resolve => { release = resolve })
  try {
    f.service.projectListEntry = async () => null
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    localCatalog(f.service)
    const read = f.store.candles.bind(f.store)
    f.store.candles = async (...args) => { started = true; await readGate; return read(...args) }
    f.service.history.ensurePrices = async () => ({ rows: [] })
    const previous = structuredClone(f.preferences)
    f.preferences.rankingLookback = 60
    await f.service.reconfigure(previous)
    assert.equal(started, true)
    const row = f.service.listRowsFor('15m')[0]
    assert.equal(row.rankingChange, null, 'A 15-minute ranking cannot masquerade as a 60-minute ranking.')
    assert.equal(row.rankingAsOf, null)
    assert.equal(f.service.rankingTasks.size, 1, 'Settings complete while local ranking preparation is still pending.')
  } finally { release(); await f.close() }
})

test('a missing new boundary clears the previous ranking and an older read cannot overwrite a new close', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let release!: () => void
  const readGate = new Promise<void>(resolve => { release = resolve })
  let pending: Promise<unknown> | undefined
  try {
    f.service.projectListEntry = async () => null
    const rows = Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (8 - index) * fiveMinutes, 100 + index))
    await f.store.appendCandles(rows)
    f.service.cacheRankingCandles(instId, rows)
    f.service.cachedRanking(instId, 15, asOf - fiveMinutes)
    localCatalog(f.service)
    const previous = f.service.listRowsFor('15m')[0]
    assert.equal(previous.rankingAsOf, null)
    assert.equal(previous.rankingChange, null)
    const read = f.store.candles.bind(f.store)
    f.store.candles = async (query, priority) => {
      if (query.from !== query.through) { await readGate; return rows }
      return read(query, priority)
    }
    pending = f.service.updateRanking(instId, { ensure: true })
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, null)
    assert.equal(await f.service.persistCandles(instId, [{ ...rawCandle(asOf - fiveMinutes, 999), confirmed: false }]), false)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, previous.rankingChange, 'Forming candles never enter the rank cache.')
    await f.service.persistCandles(instId, [rawCandle(asOf - fiveMinutes, 110)], { projectList: false })
    const latest = f.service.listRowsFor('15m')[0]
    assert.equal(latest.rankingAsOf, asOf)
    assert.equal(latest.rankingChange, (110 - 104) / 104 * 100)
    release(); await pending
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, latest.rankingChange)
  } finally { release(); await pending; await f.close() }
})

test('the exact next 5m boundary clears a ranking without a final WS event and a committed close restores it', async context => {
  const boundary = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + fiveMinutes
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: boundary - 1_000 })
  const f = await fixture(), asOf = boundary - fiveMinutes
  try {
    f.service.projectListEntry = async () => null
    f.service.history.ensurePrices = async () => ({ rows: [] })
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    localCatalog(f.service)
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, asOf)
    context.mock.timers.tick(999)
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, asOf)
    const previousRevision = f.service.revision
    context.mock.timers.tick(1)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, null)
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, null)
    assert.ok(f.service.revision > previousRevision, 'The deadline itself publishes the unavailable new ranking.')
    await f.service.persistCandles(instId, [rawCandle(asOf, 110)], { projectList: false })
    assert.equal(f.service.listRowsFor('15m')[0].rankingAsOf, boundary)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, (110 - 104) / 104 * 100)
  } finally { await f.close() }
})

for (const status of ['verified', 'failed'] as const) test(`a published ${status} book assessment expires independently of newer raw observations while requalification is pending`, async context => {
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const preferences = disabled()
  preferences.liquidity.spread.enabled = true
  preferences.liquidity.depth.enabled = true
  const f = await fixture(preferences), gate = deferred()
  try {
    f.service.projectListEntry = async () => null
    f.service.updateRanking = async () => undefined
    f.service.instruments.set(instId, instrument)
    f.service.candidateIDs = new Set([instId])
    f.service.instrumentObservations.set(instId, { observedAt: now, expiresAt: now + 200_000 })
    const tickerObservation = { value: ticker, observedAt: now, expiresAt: now + 90_000 }
    const originalBook = { value: { bids: [['99.99', '200001']], asks: [['100', '200001']] }, observedAt: now, expiresAt: now + 1_000 }
    const observed = { ticker: tickerObservation, book: originalBook }
    const record = f.service.observedCandidate(instrument, preferences.liquidity, f.service.catalogCriteriaKey(), observed)
    if (status === 'failed') { record.status = 'failed'; record.result = { ...record.result, status: 'failed', eligible: false }; record.expiresAt = now }
    f.service.catalogChecks.set(instId, record)
    const newestBook = { ...originalBook, expiresAt: now + 180_000 }
    observed.book = newestBook
    f.service.observations.set(instId, observed)
    assert.equal(record.observations.book, originalBook, 'Raw source replacement cannot renew the assessment evidence without reevaluation.')
    f.service.streamLiquidity = { evaluate: async (input: LiquidityInput) => { await gate.promise; return f.service.evaluateLiquidity(input) }, close: async () => { gate.resolve() } }
    f.service.replaceCatalog(status === 'verified' ? [record] : [])
    assert.equal(f.service.marketDeadlineAt, now + 1_000)
    context.mock.timers.tick(999)
    assert.equal(f.service.catalogChecks.get(instId).status, status)
    context.mock.timers.tick(1)
    assert.equal(f.service.catalog.has(instId), false)
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown', 'Expired assessments must stop claiming a known result before the worker responds.')
    assert.equal(f.service.observations.get(instId).book, newestBook)
    assert.equal(f.service.streamEvaluations.has(instId), true)
  } finally { gate.resolve(); await f.close() }
})

for (const source of ['book', 'ticker', 'openInterest'] as const) test(`a late failing worker result cannot resurrect evidence after its ${source} lease expires`, async context => {
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const preferences = disabled()
  preferences.liquidity.spread.enabled = true
  preferences.liquidity.slippage.enabled = true
  preferences.liquidity.openInterest.enabled = true
  const f = await fixture(preferences), gate = deferred()
  try {
    f.service.projectListEntry = async () => null
    f.service.updateRanking = async () => undefined
    f.service.instruments.set(instId, instrument)
    f.service.candidateIDs = new Set([instId])
    f.service.instrumentObservations.set(instId, { observedAt: now, expiresAt: now + 90_000 })
    const observations = {
      ticker: { value: ticker, observedAt: now, expiresAt: now + 90_000 },
      openInterest: { value: { instId, oiUsd: '6000000' }, observedAt: now, expiresAt: now + 90_000 },
      book: { value: { asks: [['100', '1'], ['200', '200001']], bids: [['99.99', '1'], ['50', '200001']] }, observedAt: now, expiresAt: now + 90_000 },
    }
    observations[source].expiresAt = now + 1_000
    f.service.observations.set(instId, observations)
    const input = f.service.liquidityInput(instrument, preferences.liquidity, observations, now)
    const failed = f.service.evaluateLiquidity(input)
    assert.equal(failed.status, 'failed')
    assert.ok(failed.checks.some((check: { key: string; status: string }) => check.key === 'slippage' && check.status === 'failed'))
    f.service.catalogChecks.set(instId, f.service.observedCandidate(instrument, preferences.liquidity, f.service.catalogCriteriaKey(), observations))
    f.service.streamLiquidity = { evaluate: async () => { await gate.promise; return failed }, close: async () => { gate.resolve() } }
    f.service.queueStreamQualification(instId); f.service.flushStreamQualifications()
    const evaluation = f.service.streamEvaluations.get(instId)
    assert.ok(evaluation)
    context.mock.timers.tick(1_000)
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown')
    gate.resolve(); await evaluation
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown', 'An old slippage failure cannot survive any expired input evidence.')
    assert.equal(f.service.catalog.has(instId), false)
  } finally { gate.resolve(); await f.close() }
})

test('persisted confirmed ranking is available on restart and never reused for a different lookback', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let restored: MarketService | undefined
  try {
    f.service.projectListEntry = async () => null
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    localCatalog(f.service)
    await f.service.persistCatalog([...f.service.catalog.values()])
    await f.service.updateRanking(instId)
    await f.service.flushRankingPersistence()
    const ranking = f.service.metadata.getCatalogEntry(instId).lastRanking
    assert.deepEqual(ranking, { lookback: 15, rankingChange: (106 - 103) / 103 * 100, rankingAsOf: asOf })
    await f.service.dispose()
    let requests = 0
    const offline: typeof fetch = async () => { requests += 1; throw new Error('Offline') }
    restored = new MarketService(f.store, () => f.preferences, offline, false)
    isolateChartPreparation(restored)
    restored.projectListEntry = async () => null
    await restored.ready
    assert.equal(restored.listRowsFor('15m')[0].rankingChange, ranking.rankingChange)
    assert.equal(restored.listRowsFor('15m')[0].rankingAsOf, asOf)
    assert.equal(requests, 0, 'Cached ranking restore needs neither market requests nor a history download.')
    await restored.dispose()
    f.preferences.rankingLookback = 30
    restored = new MarketService(f.store, () => f.preferences, offline, false)
    isolateChartPreparation(restored)
    restored.projectListEntry = async () => null
    await restored.ready
    assert.equal(restored.listRowsFor('15m')[0].rankingChange, null)
    assert.equal(requests, 0)
  } finally { await restored?.dispose(); await f.close() }
})

test('ranking publication defers and coalesces durability with latest values flushed before disposal', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let batches = 0, reads = 0
  const saved: Array<Array<{ instrumentID: string; lookback: number; rankingChange: number; rankingAsOf: number }>> = []
  try {
    f.service.projectListEntry = async () => null
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    localCatalog(f.service)
    await f.service.persistCatalog([...f.service.catalog.values()])
    await f.service.updateRanking(instId)
    await f.service.flushRankingPersistence()
    const get = f.service.metadata.getCatalogEntry.bind(f.service.metadata)
    const save = f.service.metadata.saveCatalogRankings.bind(f.service.metadata)
    f.service.metadata.getCatalogEntry = (id: string) => { reads += 1; return get(id) }
    f.service.metadata.saveCatalogRankings = (entries: typeof saved[number]) => { batches += 1; saved.push(entries); return save(entries) }
    for (const lookback of [30, 15, 30]) {
      const previous = structuredClone(f.preferences)
      f.preferences.rankingLookback = lookback
      await f.service.reconfigure(previous)
    }
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, 6)
    assert.equal(reads, 0, 'The immediate ranking path must not read SQLite catalog blobs.')
    assert.equal(batches, 0, 'Publication completes before the deferred persistence turn.')
    await f.service.flushRankingPersistence()
    assert.equal(batches, 1)
    assert.deepEqual(saved[0], [{ instrumentID: instId, lookback: 30, rankingChange: 6, rankingAsOf: asOf }])
    assert.equal(get(instId).lastRanking.lookback, 30)
    const previous = structuredClone(f.preferences)
    f.preferences.rankingLookback = 15
    await f.service.reconfigure(previous)
    await f.service.dispose()
    const metadata = await MetadataStore.open(join(f.root, 'Metadata'))
    try {
      const entry = metadata.getCatalogEntry(instId)
      assert.ok(entry)
      assert.equal((entry.lastRanking as { lookback: number }).lookback, 15)
    }
    finally { metadata.close() }
    assert.equal(f.service.pendingRankings.size, 0)
    assert.equal(f.service.rankingPersistenceImmediate, null)
  } finally { await f.close() }
})

test('history replacement invalidates the rank window while a different native timeframe preserves it', async () => {
  const f = await fixture(), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  try {
    f.service.projectListEntry = async () => null
    await f.service.persistCandles(instId, Array.from({ length: 7 }, (_, index) => rawCandle(asOf - (7 - index) * fiveMinutes, 100 + index)), { projectList: false })
    localCatalog(f.service)
    const cached = f.service.rankingWindows.get(instId)
    const hourlyTimestamp = Math.floor(asOf / hour) * hour - hour
    await f.service.replaceCandles({ instrument: instId, timeframe: '1H', from: hourlyTimestamp, through: hourlyTimestamp }, [nativeCandle(hourlyTimestamp, '1H', 999)])
    assert.equal(f.service.rankingWindows.get(instId), cached)
    assert.equal(f.service.listRowsFor('15m')[0].rankingChange, (106 - 103) / 103 * 100)
    const timestamp = asOf - fiveMinutes
    await f.service.replaceCandles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, [rawCandle(timestamp, 120)])
    await waitFor(() => f.service.listRowsFor('15m')[0].rankingChange === (120 - 103) / 103 * 100)
    assert.notEqual(f.service.rankingWindows.get(instId), cached)
  } finally { await f.close() }
})

test('candle, OI and Taker HTTP families proceed independently and Taker keeps contract unit', async () => {
  const calls: URL[] = []
  let releaseOI!: (response: Response) => void
  const f = await fixture(disabled(), async input => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname.endsWith('/open-interest-history')) return new Promise(resolve => { releaseOI = resolve })
    return response([])
  })
  try {
    const oi = f.service.get('/rubik/stat/contracts/open-interest-history', { period: '15m' }, undefined, 'background')
    await waitFor(() => calls.length === 1)
    await Promise.all([
      f.service.get('/market/history-candles', { bar: '15m', limit: 2 }, undefined, 'foreground'),
      f.service.get('/rubik/stat/taker-volume-contract', { period: '15m', unit: 1 }, undefined, 'foreground'),
    ])
    assert.equal(calls.length, 3)
    assert.equal(calls.find(url => url.pathname.endsWith('/taker-volume-contract'))?.searchParams.get('unit'), '1')
    releaseOI(response([])); await oi
  } finally { releaseOI?.(response([])); await f.close() }
})

test('paced HTTP lanes reserve interactive capacity and preserve pacing when RTT changes their concurrency', async context => {
  const starts: Array<{ id: string; at: number }> = [], releases = new Map<string, (value: Response) => void>()
  const requests: Promise<unknown>[] = []
  const f = await fixture(disabled(), async input => {
    const id = new URL(String(input)).searchParams.get('id')!
    starts.push({ id, at: Date.now() })
    return new Promise(resolve => releases.set(id, resolve))
  })
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const tick = async (milliseconds: number) => { context.mock.timers.tick(milliseconds); await new Promise(resolve => setImmediate(resolve)) }
  const issue = (id: string, priority: string) => { const pending = f.service.get('/market/history-candles', { id }, undefined, priority); requests.push(pending); void pending.catch(() => undefined) }
  const complete = (id: string) => { const release = releases.get(id); assert.ok(release, `${id} has not started.`); releases.delete(id); release(response([])) }
  try {
    for (const id of ['download-1', 'download-2', 'download-3', 'download-4']) issue(id, 'background')
    await tick(0); await tick(100); await tick(100); await tick(100)
    assert.deepEqual(starts.map(start => start.id), ['download-1', 'download-2', 'download-3'], 'Maintenance may use three of four slots while leaving one interactive slot.')
    issue('verify', 'interactive'); issue('chart', 'prepared')
    await tick(0)
    assert.equal(starts[3].id, 'verify', 'An interactive request uses the reserved slot without cancelling active downloads.')
    complete('verify'); await tick(0)
    complete('download-1'); complete('download-2'); await tick(100)
    assert.equal(starts[4].id, 'chart', 'Queued interactive work retains priority after RTT reduces the lane concurrency.')
    complete('chart'); complete('download-3'); await tick(100)
    assert.equal(starts[5].id, 'download-4')
    for (let index = 1; index < starts.length; index++) assert.ok(starts[index].at - starts[index - 1].at >= 100, 'Concurrent capacity cannot bypass endpoint request-start pacing.')
    complete('download-4'); await tick(0); await Promise.all(requests)
  } finally {
    for (const release of releases.values()) release(response([]))
    context.mock.timers.reset(); await f.close(); await Promise.allSettled(requests)
  }
})

test('dispose aborts noncooperative HTTP and Retry-After pacing before closing stores', async () => {
  let calls = 0
  const f = await fixture(disabled(), async () => { calls += 1; return new Response(null, { status: 429, headers: { 'retry-after': '60' } }) })
  try {
    await assert.rejects(f.service.get('/market/history-candles', {}, undefined, 'foreground'), /rate limited/)
    const pending = f.service.get('/market/history-candles', {}, undefined, 'foreground')
    const rejected = assert.rejects(pending)
    await f.service.dispose()
    await rejected
    assert.equal(calls, 1)
    assert.equal((await f.service.snapshot()).realtimeState, 'disconnected')
    assert.equal(f.service.history.sync.closed, true)
  } finally { await f.close() }
})

test('manual audit scans, repairs only its findings, and invalidates canonical generations', async () => {
  const f = await fixture()
  const reports: DataAuditSnapshot[] = []
  f.service.subscribeAudit(report => { reports.push(report) })
  try {
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    f.service.instruments.set(instId, { ...instrument, listTime: String(asOf - fiveMinutes) })
    const calls: Array<{ instrument: string; timeframe: string; from: number; through: number }> = []
    f.service.history.audit.inspect = async (query: any) => ({ issues: calls.length ? [] : [{ ...query, reason: 'gap', repairable: true }], checkedRows: 0, files: 0 })
    f.service.history.audit.repairRange = async (issue: any) => { calls.push(issue); f.service.onHistoryReplaced(issue.instrument, issue.timeframe) }
    const started = await f.service.dataAuditRequest({ action: 'start' })
    assert.equal(started.phase, 'running')
    await f.service.history.audit.whenIdle()
    const checked = await f.service.dataAuditRequest({ action: 'status' })
    assert.equal(checked.phase, 'completed')
    assert.ok(checked.issues.length > 0)
    const repairing = await f.service.dataAuditRequest({ action: 'repair' })
    assert.equal(repairing.phase, 'running')
    assert.ok(repairing.revision > checked.revision)
    assert.deepEqual(reports.find(report => report.revision === repairing.revision), repairing, 'An action returns its saved checkpoint, before jobs.set replaces the old completed job.')
    await f.service.history.audit.whenIdle()
    const repaired = await f.service.dataAuditRequest({ action: 'status' })
    assert.equal(repaired.issues.length, 0)
    assert.equal(calls.length, checked.issues.length)
    assert.ok(f.service.dataRevision(instId) > 0)
  } finally { await f.close() }
})

test('audit checkpoints push detached ordered reports while status reads remain observational', async () => {
  const f = await fixture()
  const release = deferred(), reports: DataAuditSnapshot[] = []
  let inspecting = false
  try {
    const idle = await f.service.dataAuditRequest({ action: 'status' })
    assert.equal(idle.revision, 0)
    assert.equal(idle.serviceSession, f.service.serviceSession)
    f.service.subscribeAudit(report => { report.progress.total = -1; throw new Error('Renderer closed.') })
    f.service.subscribeAudit(async () => { throw new Error('Async renderer closed.') })
    const unsubscribe = f.service.subscribeAudit(report => { reports.push(report) })
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    f.service.instruments.set(instId, { ...instrument, listTime: String(asOf - fiveMinutes) })
    f.service.history.audit.inspect = async () => { inspecting = true; await release.promise; return { issues: [], checkedRows: 0, files: 0 } }
    const started = await f.service.dataAuditRequest({ action: 'start' })
    assert.equal(started.phase, 'running')
    assert.ok(started.progress.total > 0)
    assert.deepEqual(reports.find(report => report.revision === started.revision), started)
    await waitFor(() => inspecting)
    const beforeRead = reports.length
    const status = await f.service.dataAuditRequest({ action: 'status' })
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'status' }), status)
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'start' }), status, 'Starting an active selected audit is also observational.')
    assert.equal(reports.length, beforeRead)
    status.progress.total = -100
    assert.ok((await f.service.dataAuditRequest({ action: 'status' })).progress.total > 0)
    const cancelled = await f.service.dataAuditRequest({ action: 'cancel' })
    assert.equal(cancelled.phase, 'cancelled')
    assert.deepEqual(reports.at(-1), cancelled)
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'cancel' }), cancelled)
    assert.equal(f.service.history.audit.get(started.id).status, 'cancelled')
    release.resolve(); await f.service.history.audit.whenIdle()
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'status' }), cancelled)
    assert.ok(reports.every((report, index) => index === 0 || report.revision > reports[index - 1].revision))
    assert.ok(reports.every(report => report.serviceSession === idle.serviceSession))
    unsubscribe()
    const count = reports.length
    await f.service.dataAuditRequest({ action: 'start' })
    await f.service.history.audit.whenIdle()
    assert.equal(reports.length, count)
  } finally { release.resolve(); await f.close() }
})

test('late checkpoints cannot replace the selected audit or an empty-target completed report', async () => {
  const f = await fixture()
  const release = deferred(), reports: DataAuditSnapshot[] = []
  let inspecting = false
  try {
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    f.service.instruments.set(instId, { ...instrument, listTime: String(asOf - fiveMinutes) })
    f.service.history.audit.inspect = async () => { inspecting = true; await release.promise; return { issues: [], checkedRows: 0, files: 0 } }
    f.service.subscribeAudit(report => { reports.push(report) })
    const old = await f.service.dataAuditRequest({ action: 'start' })
    await waitFor(() => inspecting)
    await f.service.dataAuditRequest({ action: 'cancel' })
    const selected = await f.service.dataAuditRequest({ action: 'start' })
    assert.notEqual(selected.id, old.id)
    const count = reports.length
    f.service.onAuditCheckpoint({ ...f.service.history.audit.get(old.id), status: 'completed' })
    assert.equal(reports.length, count)
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'status' }), selected)
    await f.service.dataAuditRequest({ action: 'cancel' })
    f.service.instruments.clear()
    const empty = await f.service.dataAuditRequest({ action: 'start' })
    assert.equal(empty.id, undefined)
    assert.equal(empty.phase, 'completed')
    assert.deepEqual(empty.progress, { completed: 0, total: 0 })
    assert.deepEqual(reports.at(-1), empty)
    assert.ok(empty.revision > selected.revision)
    f.service.onAuditCheckpoint({ ...f.service.history.audit.get(selected.id), status: 'completed' })
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'status' }), empty)
    release.resolve(); await f.service.history.audit.whenIdle()
    assert.deepEqual(await f.service.dataAuditRequest({ action: 'status' }), empty)
  } finally { release.resolve(); await f.close() }
})

test('audit startup restores one versioned selected report and shutdown stops publications', async () => {
  const f = await fixture()
  let reopened: MarketService | undefined
  const release = deferred()
  try {
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    f.service.instruments.set(instId, { ...instrument, listTime: String(asOf - fiveMinutes) })
    f.service.history.audit.inspect = async () => ({ issues: [], checkedRows: 0, files: 0 })
    await f.service.dataAuditRequest({ action: 'start' })
    await f.service.history.audit.whenIdle()
    const saved = await f.service.dataAuditRequest({ action: 'status' })
    await f.service.dispose()
    reopened = new MarketService(f.store, () => f.preferences, async () => { throw new Error('Unexpected network request.') }, false)
    isolateChartPreparation(reopened)
    const restored = await reopened.dataAuditRequest({ action: 'status' })
    assert.equal(restored.id, saved.id)
    assert.equal(restored.phase, 'completed')
    assert.equal(restored.revision, 1)
    assert.notEqual(restored.serviceSession, saved.serviceSession)
    assert.deepEqual(await reopened.dataAuditRequest({ action: 'status' }), restored)
    reopened.instruments.set(instId, { ...instrument, listTime: String(asOf - fiveMinutes) })
    let inspecting = false
    reopened.history.audit.inspect = async () => { inspecting = true; await release.promise; return { issues: [], checkedRows: 0, files: 0 } }
    let published = 0
    reopened.subscribeAudit(() => { published += 1 })
    const started = await reopened.dataAuditRequest({ action: 'start' })
    await waitFor(() => inspecting)
    const count = published
    const closing = reopened.dispose()
    reopened.onAuditCheckpoint(reopened.history.audit.get(started.id))
    assert.equal(published, count)
    release.resolve(); await closing
    reopened.subscribeAudit(() => { published += 1 })
    reopened.onAuditCheckpoint(reopened.history.audit.get(started.id))
    assert.equal(published, count)
  } finally { release.resolve(); await reopened?.dispose(); await f.close() }
})

class TestSocket extends EventTarget {
  readyState = 0
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(data: string) {
    if (data === 'ping') return
    const command = JSON.parse(data)
    for (const arg of command.args) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, event: command.op, arg }) })))
  }
  candle(timestamp: number, close: number, confirmed: boolean) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ arg: { instId, channel: 'candle5m' }, data: [[String(timestamp), '100', '120', '90', String(close), '10', '1', '1000', confirmed ? '1' : '0']] }) }))
  }
  close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
}

test('live integration stays in memory and close drains accepted confirmation while preserving a newer forming bar', async () => {
  const socket = new TestSocket()
  const f = await fixture(disabled(), undefined, { webSocketFactory: () => socket })
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  try {
    const candles = Array.from({ length: 300 }, (_, index) => ({ ...rawCandle(asOf - (301 - index) * fiveMinutes), statisticsVersion: 1, oi: 100, buy: 20, sell: 10 }))
    await f.service.persistCandles(instId, candles)
    await f.service.localChartWindow(instId, '5m')
    const originalAppend = f.store.appendCandles.bind(f.store)
    let writes = 0
    f.store.appendCandles = async (...args) => { writes += 1; return originalAppend(...args) }
    f.service.realtime.setSubscriptions([{ instId, timeframe: '5m' }])
    f.service.realtime.start(); socket.open()
    await f.service.realtime.whenIdle()
    socket.candle(asOf - fiveMinutes, 105, false)
    await f.service.realtime.whenIdle()
    assert.equal(writes, 0)
    assert.equal(f.service.preparedCharts.cached(`${instId}:5m`).liveBar.close, 105)
    socket.candle(asOf, 106, false)
    await f.service.realtime.whenIdle()
    await f.service.setLive(instId, '5m', { ...rawCandle(asOf - fiveMinutes, 101), volume: 100, confirmed: false })
    await f.service.setLive(instId, '5m', { ...rawCandle(asOf, 101), volume: 5, confirmed: false })
    assert.equal(f.service.liveCandles.get(`${instId}:5m`).close, 106, 'Delayed REST initialization cannot regress stream state.')
    assert.equal(f.service.preparedCharts.series.get(`${instId}:5m`).live.close, 106)
    let releaseWrite!: () => void
    let writeStarted = false
    f.store.appendCandles = async (...args) => {
      writeStarted = true
      await new Promise<void>(resolve => { releaseWrite = resolve })
      return originalAppend(...args)
    }
    socket.candle(asOf - fiveMinutes, 107, true)
    await waitFor(() => writeStarted)
    let closed = false
    const closing = f.service.dispose().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    releaseWrite(); await closing
    const rows = await f.store.candles({ instrument: instId, timeframe: '5m', from: asOf - fiveMinutes, through: asOf - fiveMinutes })
    assert.equal(rows[0].close, 107)
    assert.equal(f.service.liveCandles.get(`${instId}:5m`).timestamp, asOf)
    assert.equal((await f.store.candles({ instrument: instId, timeframe: '5m', from: asOf })).length, 0)
  } finally { await f.close() }
})

test('an explicit empty SWAP multiplier uses the documented product value without broadening missing contract units', async () => {
  const configuration = disabled(); configuration.liquidity.depth.enabled = true; configuration.liquidity.slippage.enabled = true
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([{ ...instrument, ctMult: '' }])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    if (url.pathname.endsWith('/market/books')) return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }])
    if (url.pathname.endsWith('/market/history-candles')) return response([])
    throw new Error(`Unexpected ${url}`)
  })
  try {
    await f.service.refresh()
    assert.equal((await f.service.snapshot()).rows.length, 1)
    assert.equal(f.service.catalog.get(instId).instrument.ctMult, '1')
  } finally { await f.close() }
})


test('successful source checks leave no periodic discovery or renewal timers', async () => {
  const f = await fixture(disabled(), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([instrument])
    if (path.endsWith('/market/tickers')) return response([ticker])
    throw new Error(`Unexpected ${path}`)
  })
  try {
    await f.service.refresh()
    assert.equal(f.service.refreshTimer, undefined)
    assert.equal(f.service.renewalTimer, undefined)
  } finally { await f.close() }
})

test('concurrent price repair and independent statistics commit preserve both source facts', async () => {
  const timestamp = Math.floor(Date.now() / fiveMinutes) * fiveMinutes - fiveMinutes
  const repaired = { ...rawCandle(timestamp, 200), volume: 20, baseVolume: 2, quoteVolume: 400 }
  const f = await fixture(disabled(), async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/market/history-candles'))
    return response([[String(timestamp), String(repaired.open), String(repaired.high), String(repaired.low), String(repaired.close), '20', '2', '400', '1']])
  })
  try {
    await f.store.appendCandles([{ ...rawCandle(timestamp), oi: 10, buy: 20, sell: 30, statisticsVersion: 1 }])
    await Promise.all([
      f.service.persistStatisticsSource(instrument, '5m', timestamp, 1, [[timestamp, 777]], undefined, 'foreground', false, { range: { from: timestamp, through: timestamp, intervalMS: fiveMinutes } }),
      f.service.history.repair({ instrument: instId, timeframe: '5m', source: 'candles', from: timestamp, through: timestamp, reason: 'invalid-ohlc', repairable: true }, { signal: new AbortController().signal }),
    ])
    const [final] = await f.store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp })
    assert.deepEqual([final.open, final.high, final.low, final.close, final.volume, final.baseVolume, final.quoteVolume], [repaired.open, repaired.high, repaired.low, repaired.close, 20, 2, 400])
    assert.deepEqual([final.oi, final.buy, final.sell, final.statisticsVersion], [777, 20, 30, 1])
  } finally { await f.close() }
})

test('statistics queued behind a replacement merge against repaired OHLC', async () => {
  const f = await fixture(), timestamp = Math.floor(Date.now() / fiveMinutes) * fiveMinutes - fiveMinutes
  let release!: () => void
  let replacement: Promise<unknown> | undefined, statistics: Promise<unknown> | undefined
  try {
    await f.store.appendCandles([{ ...rawCandle(timestamp), oi: 10, buy: 20, sell: 30, statisticsVersion: 1 }])
    const original = f.store.replaceCandles.bind(f.store)
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.store.replaceCandles = async (...args) => { started(); await new Promise<void>(resolve => { release = resolve }); return original(...args) }
    const range = { instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }
    replacement = f.service.replaceCandles(range, [rawCandle(timestamp, 200)])
    await entered
    statistics = f.service.persistStatisticsSource(instrument, '5m', timestamp, 2, [[timestamp, 333, 444]], undefined, 'foreground', false, { range: { ...range, intervalMS: fiveMinutes } })
    release(); await Promise.all([replacement, statistics])
    const [row] = await f.store.candles(range)
    assert.deepEqual([row.close, row.oi, row.buy, row.sell], [200, 10, 444, 333])
  } finally { release?.(); await Promise.allSettled([replacement, statistics]); await f.close() }
})

test('replacement retains bounded null leases and revalidates Taker zeros against repaired traded volume', async () => {
  const f = await fixture(), timestamp = Math.floor(Date.now() / fiveMinutes) * fiveMinutes - 3 * fiveMinutes, expiry = Date.now() + 20_000
  try {
    await f.store.appendCandles([
      { ...rawCandle(timestamp), volume: 0, baseVolume: 0, quoteVolume: 0, oi: 10, buy: 0, sell: 0, statisticsVersion: 1 },
      { ...rawCandle(timestamp + fiveMinutes), oi: 11, buy: null, sell: null, statisticsVersion: 11, statisticsTakerExpiresAt: expiry },
      { ...rawCandle(timestamp + 2 * fiveMinutes), volume: 0, baseVolume: 0, quoteVolume: 0, oi: null, buy: 0, sell: 0, statisticsVersion: 10 },
    ])
    const range = { instrument: instId, timeframe: '5m', from: timestamp, through: timestamp + 2 * fiveMinutes }
    await f.service.replaceCandles(range, [rawCandle(timestamp, 200), rawCandle(timestamp + fiveMinutes, 201), rawCandle(timestamp + 2 * fiveMinutes, 202)])
    const [zero, leased, partialZero] = await f.store.candles(range)
    assert.deepEqual([zero.close, zero.oi, zero.buy, zero.sell], [200, 10, null, null])
    assert.ok(Number(zero.statisticsTakerExpiresAt) < Date.now(), 'An invalidated zero placeholder needs source revalidation.')
    assert.equal(leased.statisticsTakerExpiresAt, expiry, 'Price repair cannot extend the statistics observation lease.')
    assert.equal(leased.oi, 11)
    assert.deepEqual([partialZero.buy, partialZero.sell], [null, null])
    assert.ok(Number(partialZero.statisticsTakerExpiresAt) < Date.now(), 'A partial-source zero invalidated by a price correction cannot acquire a fresh null lease.')
  } finally { await f.close() }
})

test('a failed SQLite replacement transaction propagates its error and preserves committed source facts', async () => {
  const f = await fixture(), timestamp = Math.floor(Date.now() / fiveMinutes) * fiveMinutes - fiveMinutes
  const range = { instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, originalReplace = f.store.replaceCandles.bind(f.store)
  try {
    await f.store.appendCandles([{ ...rawCandle(timestamp), oi: 10, buy: 20, sell: 30, statisticsVersion: 1 }])
    f.store.replaceCandles = async () => { throw new Error('SQLite transaction could not commit.') }
    await assert.rejects(f.service.replaceCandles(range, [rawCandle(timestamp, 300)]), /SQLite transaction could not commit/)
    const [row] = await f.store.candles(range)
    assert.deepEqual([row.close, row.oi, row.buy, row.sell], [100, 10, 20, 30])
  } finally { f.store.replaceCandles = originalReplace; await f.close() }
})

test('an explicit REST confirmed revision invalidates the prepared generation and preserves its direct statistics', async () => {
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, timestamp = asOf - fiveMinutes
  const revised = rawCandle(timestamp, 200)
  const f = await fixture(disabled(), async input => {
    const url = new URL(String(input))
    assert.ok(url.pathname.endsWith('/market/candles'), 'Returned latest data does not need a second historical fetch.')
    return response([[String(timestamp), String(revised.open), String(revised.high), String(revised.low), '200', '1', '1', '200', '1']])
  })
  try {
    await f.store.appendCandles(Array.from({ length: 300 }, (_, index) => ({ ...rawCandle(timestamp - (299 - index) * fiveMinutes), oi: 10, buy: 20, sell: 30, statisticsVersion: 1 })))
    const before = await f.service.localChartWindow(instId, '5m')
    await f.service.history.latest(instId, '5m')
    const after = await f.service.localChartWindow(instId, '5m')
    assert.ok(after!.generation > before!.generation)
    const bar = after!.bars.find(bar => bar.hour === timestamp)!
    assert.deepEqual([bar.close, bar.oi, bar.buy, bar.sell], [200, 10, 20, 30])
  } finally { await f.close() }
})

const isolateQualification = (service: MarketService) => {
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.readListBars = async () => ({ bars: [] })
  service.scheduleListProjection = () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
}

test('liquidity threshold edits immediately reuse valid observations without network, storage reads, or catalog writes', async () => {
  const configuration = disabled()
  configuration.liquidity.spread.enabled = true
  configuration.liquidity.openInterest.enabled = true
  let fetches = 0, reads = 0, writes = 0
  const source = discovery(url => url.pathname.endsWith('/public/open-interest') ? response([{ instId, oiUsd: '6000000' }]) : null)
  const f = await fixture(configuration, async (...args) => { fetches += 1; return source(...args) })
  try {
    isolateQualification(f.service)
    await f.service.refresh()
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    const fetchesBefore = fetches
    const observationBefore = structuredClone(f.service.observations.get(instId))
    f.store.candles = async () => { reads += 1; throw new Error('Threshold verification must use memory.') }
    f.service.metadata.putCatalogEntry = () => { writes += 1; throw new Error('Threshold verification must not persist a fresh lease.') }

    let previous = structuredClone(configuration)
    configuration.liquidity.openInterest.minUSDT = 7_000_000
    await f.service.reconfigure(previous)
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    previous = structuredClone(configuration)
    configuration.liquidity.openInterest.minUSDT = 5_000_000
    await f.service.reconfigure(previous)
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    previous = structuredClone(configuration)
    configuration.liquidity.spread.maxPercent = 0.001
    await f.service.reconfigure(previous)
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    previous = structuredClone(configuration)
    configuration.liquidity.spread.enabled = false
    await f.service.reconfigure(previous)
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    assert.deepEqual([fetches - fetchesBefore, reads, writes], [0, 0, 0])
    assert.deepEqual(f.service.observations.get(instId), observationBefore, 'Changing a threshold must not refresh observation timestamps or expiry.')
  } finally { await f.close() }
})

test('a liquidity edit does not wait for a previous candidate source that ignores cancellation', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response([{ instId, oiUsd: '6000000' }]) : null))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked = false, refresh: Promise<void> | undefined, reconfigured: Promise<void> | undefined
  try {
    isolateQualification(f.service)
    await f.service.refresh()
    const get = f.service.get.bind(f.service)
    f.service.get = async (path: string, ...args: unknown[]) => {
      if (path === '/public/open-interest') {
        blocked = true
        await gate
        return [{ instId, oiUsd: '1' }]
      }
      return get(path, ...args)
    }
    refresh = f.service.refresh()
    await waitFor(() => blocked)
    const previous = structuredClone(configuration)
    configuration.liquidity.openInterest.minUSDT = 4_000_000
    reconfigured = f.service.reconfigure(previous)
    const immediate = await Promise.race([
      reconfigured.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ])
    assert.equal(immediate, true, 'Cached verification must finish while the obsolete source is still blocked.')
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    release(); await refresh
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId], 'The obsolete result must not overwrite the new configuration.')
  } finally { release(); await Promise.allSettled([refresh, reconfigured]); await f.close() }
})

test('in-memory verification rejects expired observations without extending either valid or expired leases', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response([{ instId, oiUsd: '6000000' }]) : null))
  try {
    isolateQualification(f.service)
    await f.service.refresh()
    const observations = f.service.observations.get(instId)
    const original = structuredClone(observations.openInterest)
    f.service.verifyCatalog()
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    assert.deepEqual(observations.openInterest, original)
    assert.ok(f.service.catalog.get(instId).expiresAt <= original.expiresAt)
    observations.openInterest.expiresAt = Date.now() - 1
    const expired = structuredClone(observations.openInterest)
    f.service.verifyCatalog()
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown')
    assert.deepEqual(observations.openInterest, expired, 'Verification cannot turn an expired source into a fresh observation.')
    delete observations.openInterest
    f.service.verifyCatalog()
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown')
  } finally { await f.close() }
})

test('qualification reuses completed historical windows until the 5m or hourly boundary changes', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 17 * 60_000
  context.mock.method(Date, 'now', () => now)
  const configuration = disabled()
  configuration.liquidity.volume24h.enabled = true
  configuration.liquidity.volumeStability.enabled = true
  const f = await fixture(configuration, discovery())
  const reads: string[] = [], acquisitions: string[] = []
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(now / fiveMinutes) * fiveMinutes, hourlyEnd = Math.floor(now / hour) * hour
    await f.store.appendCandles([
      ...Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })),
      ...Array.from({ length: 24 }, (_, index) => ({ ...nativeCandle(hourlyEnd - (24 - index) * hour, '1H'), quoteVolume: 2_000_000 })),
    ])
    const read = f.store.candles.bind(f.store)
    f.store.candles = async (query, priority) => { reads.push(query.timeframe); return read(query, priority) }
    f.service.history.ensurePrices = async (_id: string, timeframe: string) => {
      acquisitions.push(timeframe)
      throw new Error('Complete durable windows must be used before history acquisition.')
    }
    await f.service.refresh()
    assert.deepEqual(reads.sort(), ['1H', '5m'])
    await f.service.refresh()
    assert.equal(reads.length, 2, 'The unchanged completed windows must not repeat local historical reads.')
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])

    now += fiveMinutes
    f.service.verifyCatalog()
    assert.deepEqual(f.service.listRowsFor('15m'), [], 'The previous 24h window cannot qualify the next completed 5m boundary.')
    await f.store.appendCandles([{ ...rawCandle(asOf), quoteVolume: 200_000 }])
    await f.service.refresh()
    assert.deepEqual(reads.sort(), ['1H', '5m', '5m'], 'Only the 5m window rolled over.')
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])

    now = hourlyEnd + hour + 2 * 60_000
    const nextAsOf = Math.floor(now / fiveMinutes) * fiveMinutes
    await f.store.appendCandles([
      ...Array.from({ length: (nextAsOf - asOf) / fiveMinutes }, (_, index) => ({ ...rawCandle(asOf + index * fiveMinutes), quoteVolume: 200_000 })),
      { ...nativeCandle(hourlyEnd, '1H'), quoteVolume: 2_000_000 },
    ])
    await f.service.refresh()
    assert.deepEqual(reads.sort(), ['1H', '1H', '5m', '5m', '5m'], 'Both completed windows rolled over at the next hour.')
    assert.deepEqual(acquisitions, [], 'Complete local history must never wait for a synchronization job.')
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
  } finally { await f.close() }
})

test('durable volume corrections and replacements invalidate cached qualification facts', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration, discovery())
  let preparations = 0
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, timestamp = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      preparations += 1
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    await f.service.refresh()
    assert.equal(f.service.catalog.get(instId).result.turnover, 57_600_000)
    await f.service.persistCandles(instId, [{ ...rawCandle(timestamp), quoteVolume: 400_000 }])
    assert.deepEqual((await f.service.snapshot()).rows, [], 'A corrected historical fact must immediately hide the previous qualification before recomputation.')
    assert.equal(f.service.metadata.getCatalogEntry(instId).observations.turnover, undefined, 'Restart must not restore the invalidated persisted qualification fact.')
    assert.equal(f.service.catalogChecks.get(instId).status, 'unknown')
    await f.service.refresh()
    assert.equal(preparations, 0, 'A durable correction must recompute from complete local candles without history acquisition.')
    assert.equal(f.service.catalog.get(instId).result.turnover, 57_800_000)
    await f.service.replaceCandles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, [{ ...rawCandle(timestamp), quoteVolume: 600_000 }])
    assert.deepEqual((await f.service.snapshot()).rows, [], 'A replacement must immediately hide the previous qualification before recomputation.')
    assert.equal(f.service.metadata.getCatalogEntry(instId).observations.turnover, undefined)
    await f.service.refresh()
    assert.equal(preparations, 0, 'A replacement must recompute from complete local candles without history acquisition.')
    assert.equal(f.service.catalog.get(instId).result.turnover, 58_000_000)
  } finally { await f.close() }
})

test('a historical correction during a live observation cannot restore the previous qualification total', async () => {
  const configuration = disabled()
  configuration.liquidity.volume24h.enabled = true
  configuration.liquidity.volume24h.minUSDT = 57_500_000
  configuration.liquidity.openInterest.enabled = true
  let blockOI = false, blocked = false, preparations = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, discovery(async url => {
    if (!url.pathname.endsWith('/public/open-interest')) return null
    if (blockOI) { blocked = true; await gate }
    return response([{ instId, oiUsd: '6000000' }])
  }))
  let refresh: Promise<void> | undefined
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, timestamp = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      preparations += 1
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    await f.service.refresh()
    assert.equal(f.service.catalog.get(instId).result.turnover, 57_600_000)
    blockOI = true
    refresh = f.service.refresh()
    await waitFor(() => blocked)
    assert.equal(preparations, 0, 'The pending check starts with the cached completed historical window.')
    await f.service.persistCandles(instId, [{ ...rawCandle(timestamp), quoteVolume: 0 }])
    assert.deepEqual((await f.service.snapshot()).rows, [])
    release(); await refresh
    const invalidated = f.service.metadata.getCatalogEntry(instId)
    assert.equal(invalidated.status, 'unknown')
    assert.equal(invalidated.result.turnover, null, 'Completing a live request must not republish a historical total invalidated during that request.')
    assert.deepEqual((await f.service.snapshot()).rows, [])
    blockOI = false
    await f.service.refresh()
    const recomputed = f.service.metadata.getCatalogEntry(instId)
    assert.equal(preparations, 0, 'The corrected complete local range must not enqueue historical acquisition.')
    assert.equal(recomputed.status, 'failed')
    assert.equal(recomputed.result.turnover, 57_400_000)
    assert.deepEqual((await f.service.snapshot()).rows, [])
  } finally { release(); await refresh; await f.close() }
})

test('a historical correction after acquisition reads but before it returns cannot publish the obsolete total', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration, discovery())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let readStarted = false, preparations = 0, refresh: Promise<void> | undefined
  const publishedTotals: Array<number | null> = []
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, timestamp = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 287 }, (_, index) => ({ ...rawCandle(asOf - (287 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      preparations += 1
      await f.service.persistCandles(id, [{ ...rawCandle(from), quoteVolume: 200_000 }])
      const rows = await f.store.candles({ instrument: id, timeframe, from, through })
      readStarted = true
      await gate
      return { rows }
    }
    const put = f.service.metadata.putCatalogEntry.bind(f.service.metadata)
    f.service.metadata.putCatalogEntry = (record: any) => {
      publishedTotals.push(record.result.turnover)
      return put(record)
    }
    refresh = f.service.refresh()
    await waitFor(() => readStarted)
    assert.equal(f.service.observations.get(instId)?.turnover, undefined, 'The first historical observation is not available yet.')
    await f.service.persistCandles(instId, [{ ...rawCandle(timestamp), quoteVolume: 400_000 }])
    release(); await refresh
    assert.equal(preparations, 1, 'A durable correction needs a local reread, without repeating historical acquisition.')
    assert.equal(f.service.observations.get(instId).turnover.value.turnover, 57_800_000)
    assert.equal(f.service.catalog.get(instId).result.turnover, 57_800_000)
    assert.deepEqual(publishedTotals, [57_800_000], 'The original acquired rows must never become a persisted qualification fact.')
  } finally { release(); await refresh; await f.close() }
})

test('a rejected contract restored with fresh instrument and liquidity observations qualifies offline after relaxing its threshold', async () => {
  const configuration = disabled()
  configuration.liquidity.openInterest.enabled = true
  configuration.liquidity.openInterest.minUSDT = 7_000_000
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response([{ instId, oiUsd: '6000000' }]) : null))
  let restored: MarketService | undefined, fetches = 0, reads = 0
  try {
    isolateQualification(f.service)
    await f.service.refresh()
    const rejected = f.service.metadata.getCatalogEntry(instId)
    assert.equal(rejected.status, 'failed')
    assert.ok(rejected.instrumentObservation.expiresAt > Date.now(), 'A rejected criterion must preserve its independently fresh instrument metadata.')
    await f.service.dispose()
    restored = new MarketService(f.store, () => configuration, async () => { fetches += 1; throw new Error('Offline') }, false)
    isolateChartPreparation(restored)
    await restored.ready
    isolateQualification(restored)
    f.store.candles = async () => { reads += 1; throw new Error('Restored verification must use its saved observations.') }
    assert.deepEqual(restored.listRowsFor('15m'), [])
    const previous = structuredClone(configuration)
    configuration.liquidity.openInterest.minUSDT = 5_000_000
    await restored.reconfigure(previous)
    assert.deepEqual(restored.listRowsFor('15m').map(row => row.instId), [instId])
    assert.deepEqual([fetches, reads], [0, 0])
    assert.deepEqual(restored.observations.get(instId).openInterest, rejected.observations.openInterest)
    assert.deepEqual(restored.instrumentObservations.get(instId), rejected.instrumentObservation)
  } finally { await restored?.dispose(); await f.close() }
})

test('missing qualification history requests continuity acquisition after inspecting the local durable window', async () => {
  const configuration = disabled()
  configuration.liquidity.volume24h.enabled = true
  configuration.liquidity.volumeStability.enabled = true
  const f = await fixture(configuration, discovery())
  const requests: Array<[string, string]> = []
  try {
    isolateQualification(f.service)
    f.service.history.ensurePrices = async (id: string, timeframe: '5m' | '1H', from: number, through: number, priority: string) => {
      requests.push([timeframe, priority])
      const step = timeframe === '5m' ? fiveMinutes : hour
      const records = Array.from({ length: (through - from) / step + 1 }, (_, index) => ({ ...nativeCandle(from + index * step, timeframe), quoteVolume: timeframe === '5m' ? 200_000 : 2_000_000 }))
      await f.service.persistCandles(id, records)
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    await f.service.refresh()
    assert.deepEqual(requests.sort(), [['1H', 'continuity'], ['5m', 'continuity']], 'Qualification cannot queue missing windows behind broad historical backfills.')
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    assert.equal(f.service.catalog.get(instId).result.turnover, 57_600_000)
  } finally { await f.close() }
})

test('a fifth candidate with complete local history qualifies while four earlier historical acquisitions are blocked', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const ids = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(base => `${base}-USDT-SWAP`), availableID = ids[4]
  const blocked = new Set<string>()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response(ids.map(id => ({ ...instrument, instId: id, ctValCcy: id.split('-')[0] })))
    if (url.pathname.endsWith('/market/tickers')) return response(ids.map(id => ({ ...ticker, instId: id })))
    throw new Error(`Unexpected ${url}`)
  })
  let refresh: Promise<void> | undefined
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), instrument: availableID, quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (id: string) => {
      assert.notEqual(id, availableID, 'The complete local candidate must not request history acquisition.')
      blocked.add(id)
      await gate
      return { rows: [] }
    }
    refresh = f.service.refresh()
    await waitFor(() => blocked.size === 4 && f.service.catalog.has(availableID))
    const pending = await f.service.snapshot()
    assert.deepEqual(pending.rows.map(row => row.instId), [availableID])
    assert.equal(pending.catalogProgress.pending, 4, 'Only distinct candidate acquisitions still in progress count as pending.')
    assert.equal(f.service.refreshing !== null, true)
    release(); await refresh
    const finished = await f.service.snapshot()
    assert.equal(finished.catalogProgress.pending, 0)
    assert.equal(finished.catalogProgress.unknown, 4)
    assert.equal(finished.catalogProgress.verified, 1)
  } finally { release(); await refresh; await f.close() }
})

test('renewal refreshes metadata and bulk tickers even when it starts with no qualified renewal targets', async () => {
  let metadataRequests = 0, tickerRequests = 0
  const f = await fixture(disabled(), async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) { metadataRequests += 1; return response([instrument]) }
    if (url.pathname.endsWith('/market/tickers')) { tickerRequests += 1; return response([ticker]) }
    throw new Error(`Unexpected ${url}`)
  })
  try {
    isolateQualification(f.service)
    assert.equal(f.service.renewalTargets.size, 0)
    await f.service.renewCatalog()
    assert.deepEqual([metadataRequests, tickerRequests], [1, 1])
    await Promise.all([...f.service.candidateTasks.values()])
    assert.ok(f.service.instrumentObservations.get(instId).expiresAt > Date.now())
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    assert.equal((await f.service.snapshot()).catalogProgress.pending, 0)
  } finally { await f.close() }
})

test('a completed unavailable check has no pending candidate while unrelated metadata renewal is blocked', async () => {
  const configuration = disabled(); configuration.liquidity.openInterest.enabled = true
  let blockMetadata = false, metadataBlocked = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) {
      if (blockMetadata) { metadataBlocked = true; await gate }
      return response([instrument])
    }
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    if (url.pathname.endsWith('/public/open-interest')) return response([])
    throw new Error(`Unexpected ${url}`)
  })
  let renewal: Promise<void> | undefined
  try {
    isolateQualification(f.service)
    await f.service.refresh()
    assert.equal(f.service.renewalTargets.size, 0)
    const completed = await f.service.snapshot()
    assert.equal(completed.catalogProgress.unknown, 1)
    assert.equal(completed.catalogProgress.pending, 0)
    blockMetadata = true
    renewal = f.service.renewCatalog()
    await waitFor(() => metadataBlocked)
    const duringRenewal = await f.service.snapshot()
    assert.equal(duringRenewal.loading, true)
    assert.equal(duringRenewal.catalogProgress.unknown, 1)
    assert.equal(duringRenewal.catalogProgress.pending, 0, 'Unknown observations must not masquerade as candidate work that is still running.')
    assert.deepEqual(duringRenewal.rows, [])
    assert.match(duringRenewal.error, /verification is unavailable/i, 'Unrelated renewal work cannot hide an already completed unavailable check.')
  } finally { release(); await renewal; await f.close() }
})

test('global renewal finishes and runs again while an earlier candidate historical acquisition remains blocked', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  let metadataRequests = 0, historyBlocked = false, acquisitions = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(configuration, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) { metadataRequests += 1; return response([instrument]) }
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    throw new Error(`Unexpected ${url}`)
  })
  try {
    isolateQualification(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, timestamp = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    await f.service.refresh()
    await f.service.replaceCandles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, [])
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      acquisitions += 1
      historyBlocked = true
      await gate
      await f.service.persistCandles(id, [{ ...rawCandle(timestamp), quoteVolume: 200_000 }])
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    const discoveriesBefore = metadataRequests
    const first = f.service.renewCatalog()
    await waitFor(() => historyBlocked)
    const firstFinished = await Promise.race([first.then(() => true), new Promise<boolean>(resolve => setImmediate(() => resolve(false)))])
    assert.equal(firstFinished, true, 'Global lease renewal must not wait for a candidate historical acquisition.')
    assert.equal(f.service.renewing, null)
    assert.equal((await f.service.snapshot()).catalogProgress.pending, 1)
    await f.service.renewCatalog()
    assert.equal(f.service.renewing, null)
    assert.equal(metadataRequests, discoveriesBefore + 2, 'A second global metadata renewal must run while the first acquisition is pending.')
    assert.equal(acquisitions, 1, 'Independent global renewal must still deduplicate the same candidate acquisition.')
    release()
    await waitFor(() => f.service.candidateTasks.size === 0)
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    assert.equal((await f.service.snapshot()).catalogProgress.pending, 0)
  } finally { release(); await f.close() }
})

test('repeated malformed native tickers cannot reset targeted failure backoff', async t => {
  const f = await fixture()
  let now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000, calls = 0
  t.mock.method(Date, 'now', () => now)
  try {
    isolateQualification(f.service)
    f.service.installInstruments(new Map([[instId, instrument]]))
    const context = { signal: new AbortController().signal, receivedAt: now, acknowledged: true }
    f.service.tickerSubscribed(instId, context)
    f.service.receivePublicObservation(instId, 'ticker', ticker, context)
    f.service.get = async (path: string) => { assert.equal(path, '/market/ticker'); calls++; throw new Error('Targeted ticker offline.') }
    f.service.receivePublicObservation(instId, 'ticker', { last: '0' }, context)
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    const firstRetry = f.service.tickerRecoveries.get(instId).retryAt
    assert.equal(calls, 1)
    assert.equal(firstRetry, now + 1_000)
    now += 500
    for (let event = 0; event < 20; event++) f.service.receivePublicObservation(instId, 'ticker', { last: '0' }, { ...context, receivedAt: now })
    assert.equal(f.service.tickerRecoveries.get(instId).retryAt, firstRetry)
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    assert.equal(calls, 1)
    now = firstRetry
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    assert.equal(calls, 2)
    assert.equal(f.service.tickerRecoveries.get(instId).retryAt, now + 2_000)
  } finally { t.mock.restoreAll(); await f.close() }
})

test('a bounded REST ticker fallback expires into scoped recovery even with spread disabled', async t => {
  const f = await fixture()
  let now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000, calls = 0
  t.mock.method(Date, 'now', () => now)
  try {
    isolateQualification(f.service)
    f.service.installInstruments(new Map([[instId, instrument]]))
    const context = { signal: new AbortController().signal, receivedAt: now, acknowledged: true }
    f.service.tickerSubscribed(instId, context)
    f.service.receivePublicObservation(instId, 'ticker', ticker, context)
    f.service.get = async (path: string) => { assert.equal(path, '/market/ticker'); calls++; return [{ ...ticker, ts: String(now) }] }
    f.service.receivePublicObservation(instId, 'ticker', { last: '0' }, context)
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    const first = f.service.tickerCache.values.get(instId)
    assert.equal(calls, 1)
    assert.equal(f.service.tickerRecoveries.get(instId).retryAt, first.expiresAt)
    now = first.expiresAt - 1
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    assert.equal(calls, 1, 'A finite usable HTTP fallback has no minute renewal loop.')
    now = first.expiresAt
    f.service.processMarketDeadline()
    await Promise.all([...f.service.backgroundTasks])
    assert.equal(calls, 2)
    assert.equal(f.service.tickerCache.values.get(instId).observedAt, now)
    assert.equal(first.expiresAt, context.receivedAt + 90_000, 'Recovery never changes an earlier observation lease.')
  } finally { t.mock.restoreAll(); await f.close() }
})

for (const nativeFirst of [false, true]) test(`native ticker recovery clears only its bootstrap HTTP error ${nativeFirst ? 'before' : 'after'} the failed request settles`, async () => {
  const configuration = disabled(); configuration.liquidity.spread.enabled = true
  const f = await fixture(configuration)
  let release!: (value: unknown) => void, reject!: (reason: Error) => void
  const held = new Promise((resolve, fail) => { release = resolve; reject = fail })
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  let refreshing: Promise<void> | undefined
  try {
    isolateQualification(f.service)
    f.service.get = async (path: string) => {
      if (path === '/public/instruments') return [instrument]
      assert.equal(path, '/market/tickers'); began(); return held
    }
    refreshing = f.service.refresh()
    await started
    const context = { signal: new AbortController().signal, receivedAt: Date.now() }
    await f.service.synchronizeInstruments(context)
    if (nativeFirst) f.service.receivePublicObservation(instId, 'ticker', ticker, context)
    reject(new Error('Initial ticker HTTP unavailable.'))
    await refreshing
    await Promise.all([...f.service.backgroundTasks])
    if (!nativeFirst) {
      assert.match(f.service.error, /Initial ticker HTTP unavailable/)
      f.service.sourceError('liquidity', new Error('Independent calculation fault.'))
      f.service.receivePublicObservation(instId, 'ticker', ticker, context)
    }
    f.service.flushStreamQualifications()
    assert.deepEqual((await f.service.snapshot()).rows.map(row => row.instId), [instId])
    assert.equal(f.service.error, nativeFirst ? '' : 'Independent calculation fault.')
  } finally { release([]); await refreshing; await f.close() }
})

test('an older malformed native ticker is ignored before source-fault policy', async () => {
  const configuration = disabled(); configuration.liquidity.spread.enabled = true
  const f = await fixture(configuration)
  try {
    isolateQualification(f.service)
    f.service.installInstruments(new Map([[instId, instrument]]))
    const context = { signal: new AbortController().signal, receivedAt: Date.now(), acknowledged: true }
    f.service.tickerSubscribed(instId, context)
    f.service.receivePublicObservation(instId, 'ticker', { ...ticker, ts: '200' }, context)
    const accepted = f.service.tickerCache.values.get(instId)
    f.service.receivePublicObservation(instId, 'ticker', { last: '0', ts: '100' }, context)
    assert.equal(f.service.tickerCache.values.get(instId), accepted)
    assert.equal(f.service.observationExpiry(accepted, 'ticker', instId), Number.MAX_SAFE_INTEGER)
    assert.equal(f.service.tickerRecoveries.size, 0)
    assert.equal(f.service.error, '')
  } finally { await f.close() }
})

for (const keepRecovered of [true, false]) test(`an early bootstrap ticker fault retires when ${keepRecovered ? 'the last missing contract delists' : 'the eligible universe becomes empty'}`, async () => {
  const f = await fixture()
  try {
    isolateQualification(f.service)
    f.service.get = async (path: string) => { assert.equal(path, '/market/tickers'); throw new Error('Initial ticker HTTP unavailable.') }
    await assert.rejects(f.service.tickerObservations(new AbortController().signal), /Initial ticker HTTP unavailable/)
    assert.match((await f.service.snapshot()).error, /Initial ticker HTTP unavailable/)
    const missing = { ...instrument, instId: 'ETH-USDT-SWAP', ctValCcy: 'ETH' }
    f.service.installInstruments(new Map([[instId, instrument], [missing.instId, missing]]))
    f.service.receivePublicObservation(instId, 'ticker', ticker)
    assert.match((await f.service.snapshot()).error, /Initial ticker HTTP unavailable/, 'A still-missing eligible contract retains its source fault.')
    f.service.installInstruments(new Map(keepRecovered ? [[instId, instrument]] : []))
    assert.equal((await f.service.snapshot()).error, '')
  } finally { await f.close() }
})

test('a delayed bootstrap ticker failure cannot create a wildcard fault for a known empty universe', async () => {
  const f = await fixture()
  let fail!: (error: Error) => void
  const held = new Promise<never>((_, reject) => { fail = reject })
  try {
    isolateQualification(f.service)
    f.service.get = async () => held
    const acquisition = f.service.tickerObservations(new AbortController().signal)
    f.service.installInstruments(new Map())
    fail(new Error('Retired bootstrap request failed.'))
    await assert.rejects(acquisition, /Retired bootstrap request failed/)
    assert.equal((await f.service.snapshot()).error, '')
    assert.equal(f.service.tickerFaults.size, 0)
  } finally { fail(new Error('Disposed.')); await f.close() }
})

const turnoverRecovery = (service: MarketService) => {
  isolateQualification(service)
  service.instruments.set(instId, instrument)
  service.candidateIDs = new Set([instId])
  service.instrumentObservations.set(instId, { observedAt: Date.now(), expiresAt: Date.now() + 60_000 })
  service.observations.set(instId, { ticker: { value: { ...ticker, bidPx: '99', askPx: '101' }, observedAt: Date.now(), expiresAt: Date.now() + 60_000 } })
  const recovery = { key: `${instId}:turnover`, instId, source: 'turnover', attempts: 0, retryAt: 0, task: null, controller: new AbortController() }
  service.sourceRecoveries.set(recovery.key, recovery)
  return recovery
}

test('turnover source recovery succeeds from complete durable facts even when another liquidity criterion rejects the contract', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true; configuration.liquidity.spread.enabled = true
  const f = await fixture(configuration)
  try {
    const recovery = turnoverRecovery(f.service), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    let acquisitions = 0
    f.service.history.ensurePrices = async (_id: string, timeframe: string, from: number, through: number) => { acquisitions += 1; return { rows: await f.store.candles({ instrument: instId, timeframe, from, through }) } }
    f.service.sourceError(recovery.key, new Error('Previous source fault.'))
    await f.service.repairRequiredSource(recovery)
    assert.equal(f.service.error, '', 'A rejected spread cannot manufacture an unavailable turnover-source error.')
    assert.equal(f.service.observations.get(instId).turnover.value.turnover, 57_600_000)
    assert.equal(acquisitions, 0, 'Complete canonical rows require no provider request or history acquisition.')
    assert.equal(f.service.sourceRecoveries.has(recovery.key), false)
    f.service.flushStreamQualifications()
    assert.equal(f.service.catalogChecks.get(instId).status, 'failed', 'Recovering a source does not bypass the genuine spread rejection.')
  } finally { await f.close() }
})

test('a genuine missing turnover slot remains a source failure without a fabricated observation', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration)
  try {
    const recovery = turnoverRecovery(f.service), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 287 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    f.service.history.ensurePrices = async (_id: string, timeframe: string, from: number, through: number) => ({ rows: await f.store.candles({ instrument: instId, timeframe, from, through }) })
    await f.service.repairRequiredSource(recovery)
    assert.match(f.service.error, /incomplete|not available|not yet durable/i)
    assert.equal(f.service.observations.get(instId).turnover, undefined)
    assert.equal(recovery.attempts, 1)
  } finally { await f.close() }
})

test('turnover source recovery rereads a durable correction and cannot publish an aborted earlier recovery', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration), hold = deferred(), started = deferred()
  try {
    const recovery = turnoverRecovery(f.service), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, latest = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    const read = f.store.candles.bind(f.store)
    let blocked = false
    f.store.candles = async (query, priority) => {
      const rows = await read(query, priority)
      if (!blocked) { blocked = true; started.resolve(); await hold.promise }
      return rows
    }
    const pending = f.service.repairRequiredSource(recovery)
    await started.promise
    await f.service.persistCandles(instId, [{ ...rawCandle(latest), quoteVolume: 400_000 }], { projectList: false })
    hold.resolve(); await pending
    assert.equal(f.service.observations.get(instId).turnover.value.turnover, 57_800_000)
    delete f.service.observations.get(instId).turnover
    const retired = turnoverRecovery(f.service), cancelled = deferred(), entered = deferred()
    blocked = false
    f.store.candles = async (query, priority) => {
      const rows = await read(query, priority)
      if (!blocked) { blocked = true; entered.resolve(); await cancelled.promise }
      return rows
    }
    const old = f.service.repairRequiredSource(retired)
    await entered.promise
    f.service.cancelRequiredRecovery(retired.key)
    cancelled.resolve(); await old
    assert.equal(f.service.observations.get(instId).turnover, undefined)
    assert.equal(f.service.sourceRecoveries.has(retired.key), false)
  } finally { hold.resolve(); await f.close() }
})

test('concurrent historical source consumers share one local read and calculation while cancellation retires only its consumer', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration), hold = deferred(), started = deferred()
  try {
    turnoverRecovery(f.service)
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    const read = f.store.candles.bind(f.store)
    let reads = 0
    f.store.candles = async (query, priority) => { reads += 1; const rows = await read(query, priority); started.resolve(); await hold.promise; return rows }
    const observations = f.service.observations.get(instId), retiring = new AbortController(), remaining = new AbortController()
    const first = f.service.observeHistoricalSource(instId, 'turnover', observations, retiring.signal, false, () => true)
    const rejected = assert.rejects(first, /abort/i)
    await started.promise
    const second = f.service.observeHistoricalSource(instId, 'turnover', observations, remaining.signal, false, () => true)
    retiring.abort(); await rejected
    hold.resolve(); await second
    assert.equal(reads, 1)
    assert.equal(observations.turnover.value.turnover, 57_600_000)
    await f.service.observeHistoricalSource(instId, 'turnover', observations, remaining.signal, false, () => true)
    assert.equal(reads, 1, 'A still-current source observation requires neither another local read nor recalculation.')
    assert.equal(f.service.historicalSourceReads.size, 0)
  } finally { hold.resolve(); await f.close() }
})

test('turnover source recovery crossing a native boundary acquires only the newly missing current range and never renews the old proof', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 17 * 60_000
  context.mock.method(Date, 'now', () => now)
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration), hold = deferred(), started = deferred(), requests: number[] = []
  try {
    const recovery = turnoverRecovery(f.service), oldEnd = Math.floor(now / fiveMinutes) * fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(oldEnd - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    const read = f.store.candles.bind(f.store)
    let blocked = false
    f.store.candles = async (query, priority) => { const rows = await read(query, priority); if (!blocked) { blocked = true; started.resolve(); await hold.promise } return rows }
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      requests.push(through)
      await f.service.persistCandles(id, [{ ...rawCandle(through), quoteVolume: 400_000 }], { projectList: false })
      return { rows: await read({ instrument: id, timeframe, from, through }) }
    }
    const pending = f.service.repairRequiredSource(recovery)
    await started.promise
    now += fiveMinutes
    hold.resolve(); await pending
    assert.deepEqual(requests, [oldEnd])
    const observation = f.service.observations.get(instId).turnover
    assert.equal(observation.value.asOf, oldEnd + fiveMinutes)
    assert.equal(observation.value.turnover, 57_800_000)
    assert.equal(observation.expiresAt, oldEnd + 2 * fiveMinutes)
    assert.equal(f.service.error, '')
  } finally { hold.resolve(); await f.close() }
})

test('a failed newer historical source read cannot renew the aggregate calculated from its earlier complete window', async () => {
  const configuration = disabled(); configuration.liquidity.volume24h.enabled = true
  const f = await fixture(configuration), hold = deferred(), started = deferred()
  try {
    const recovery = turnoverRecovery(f.service), asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, latest = asOf - fiveMinutes
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ ...rawCandle(asOf - (288 - index) * fiveMinutes), quoteVolume: 200_000 })))
    const read = f.store.candles.bind(f.store)
    let blocked = false
    f.store.candles = async (query, priority) => { const rows = await read(query, priority); if (!blocked) { blocked = true; started.resolve(); await hold.promise } return rows }
    f.service.history.ensurePrices = async (_id: string, timeframe: string, from: number, through: number) => ({ rows: await read({ instrument: instId, timeframe, from, through }) })
    const pending = f.service.repairRequiredSource(recovery)
    await started.promise
    await f.service.persistCandles(instId, [{ ...rawCandle(latest), quoteVolume: null }], { projectList: false })
    hold.resolve(); await pending
    assert.equal(f.service.observations.get(instId).turnover, undefined, 'A stale previous aggregate cannot certify the newly incomplete source window.')
    assert.match(f.service.error, /incomplete/i)
  } finally { hold.resolve(); await f.close() }
})

test('manual history downloads select only currently verified saved-filter matches', async () => {
  const f = await fixture()
  try {
    isolateQualification(f.service)
    const now = Date.now(), listing = String(Date.UTC(2020, 0, 1))
    const entry = (id: string, overrides: Record<string, unknown> = {}) => f.service.catalogRecord({
      instrument: { ...instrument, instId: id, listTime: listing }, ticker: { ...ticker, instId: id },
      result: { eligible: true, status: 'verified' }, status: 'verified', expiresAt: now + 60_000, ...overrides,
    })
    const entries = [entry(instId), entry('EXPIRED-USDT-SWAP', { expiresAt: now - 1 }),
      entry('REJECTED-USDT-SWAP', { result: { eligible: false, status: 'failed' } }),
      entry('UNKNOWN-USDT-SWAP', { status: 'unknown' }), entry('OLD-FILTER-USDT-SWAP', { configKey: 'obsolete' }),
      entry('NO-TICKER-USDT-SWAP', { ticker: null })]
    f.service.catalog = new Map(entries.map(value => [value.instrumentID, value]))
    f.service.instruments.set(instId, { ...instrument, listTime: listing })
    const targets: unknown[][] = []
    f.service.historyDownload.start = (values: unknown[]) => { targets.push(structuredClone(values)) }
    await f.service.historyDownloadRequest({ action: 'start' })
    assert.deepEqual(targets, [[{ ...instrument, listTime: listing }]], 'Expired, rejected, unknown and old-filter entries must not acquire full history.')
  } finally { await f.close() }
})

test('a manual download freezes listing-to-start scope across every native timeframe and source', async () => {
  const configuration = disabled(); configuration.historyDays = 1
  const f = await fixture(configuration), hold = deferred()
  try {
    isolateQualification(f.service)
    const listing = Date.UTC(2020, 0, 1, 0, 2), startedAt = Date.UTC(2026, 9, 19, 12, 7)
    f.service.replaceCatalog([{ instrument: { ...instrument, listTime: String(listing) }, ticker,
      result: { eligible: true, status: 'verified' } }])
    f.service.historyDownload.now = () => startedAt
    f.service.historyDownload.run = () => hold.promise
    const started = await f.service.historyDownloadRequest({ action: 'start' })
    const scope = structuredClone(f.service.historyDownload.job.streams)
    assert.equal(started.phase, 'running')
    assert.equal(started.contracts.total, 1)
    assert.equal(started.streams.total, 9)
    assert.deepEqual(scope.map((stream: any) => `${stream.timeframe}:${stream.source}`).sort(),
      ['5m', '15m', '1H'].flatMap(timeframe => ['candles', 'oi', 'taker'].map(source => `${timeframe}:${source}`)).sort())
    for (const stream of scope) {
      const step = stream.timeframe === '1H' ? hour : stream.timeframe === '15m' ? 3 * fiveMinutes : fiveMinutes
      assert.equal(stream.from, Math.ceil(listing / step) * step)
      assert.equal(stream.through, Math.floor(startedAt / step) * step - step)
      assert.ok(stream.from < startedAt - 365 * 24 * hour, 'The saved one-day audit lookback cannot cap full history.')
    }
    assert.equal(started.progress.total, scope.reduce((sum: number, stream: any) => sum + (stream.through - stream.from) / stream.step + 1, 0))
    configuration.liquidity.spread.enabled = true
    f.service.catalog.clear()
    f.service.instruments.set(instId, { ...instrument, listTime: String(startedAt) })
    const current = await f.service.historyDownloadRequest({ action: 'status' })
    assert.equal(current.progress.total, started.progress.total)
    assert.deepEqual(f.service.historyDownload.job.streams, scope, 'Later filters, catalog and listing updates cannot move an active download denominator.')
    hold.resolve()
    await f.service.historyDownloadRequest({ action: 'cancel' })
  } finally { hold.resolve(); await f.close() }
})

test('instrument installation, catalog persistence, settings and market deadlines never start silent archives', async () => {
  const configuration = disabled(), f = await fixture(configuration)
  try {
    isolateQualification(f.service)
    let starts = 0, enqueues = 0
    f.service.historyDownload.start = () => { starts++ }
    f.service.history.audit.start = async () => { starts++; throw new Error('Unexpected automatic audit.') }
    const enqueue = f.service.history.sync.enqueue.bind(f.service.history.sync)
    f.service.history.sync.enqueue = (...args: unknown[]) => { enqueues++; return enqueue(...args) }
    const definition = { ...instrument, listTime: String(Date.UTC(2020, 0, 1)) }
    f.service.installInstruments(new Map([[instId, definition]]))
    f.service.replaceCatalog([{ instrument: definition, ticker, result: { eligible: true, status: 'verified' } }])
    await f.service.persistCatalog([...f.service.catalog.values()])
    const previous = structuredClone(configuration)
    configuration.historyDays = 3650
    await f.service.reconfigure(previous)
    f.service.marketBoundary -= fiveMinutes
    f.service.processMarketDeadline()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual({ starts, enqueues }, { starts: 0, enqueues: 0 })
    assert.deepEqual(f.service.history.sync.listTasks(), [])
    assert.equal((await f.service.historyDownloadRequest({ action: 'status' })).phase, 'idle')
  } finally { await f.close() }
})

test('history download checkpoints and replies carry detached snapshots with monotonic service revisions', async () => {
  const f = await fixture()
  try {
    const observed: import('./desktop-contract.ts').HistoryDownload[] = []
    const unsubscribeMutation = f.service.subscribeHistoryDownload(report => { report.progress.completed = 999 })
    const unsubscribe = f.service.subscribeHistoryDownload(report => { observed.push(report) })
    f.service.subscribeHistoryDownload(() => { throw new Error('Disconnected renderer.') })
    f.service.subscribeHistoryDownload(async () => { throw new Error('Disconnected async renderer.') })
    const initial = await f.service.historyDownloadRequest({ action: 'status' })
    f.service.historyDownload.report = { ...f.service.historyDownload.snapshot(), phase: 'running',
      progress: { completed: 2, total: 5, available: 1, unavailable: 1, reused: 1, pending: 3 } }
    f.service.publishHistoryDownload(f.service.historyDownload.snapshot())
    const current = await f.service.historyDownloadRequest({ action: 'status' })
    assert.equal(initial.phase, 'idle')
    assert.equal(initial.progress.completed, 0, 'A previously returned reply must remain detached from later checkpoints and listeners.')
    assert.equal(current.progress.completed, 2)
    assert.equal(current.serviceSession, initial.serviceSession)
    assert.ok(observed.length >= 3)
    assert.ok(observed.every((report, index) => report.serviceSession === initial.serviceSession && (index === 0 || report.revision > observed[index - 1].revision)))
    assert.ok(current.revision > initial.revision)
    unsubscribeMutation(); unsubscribe()
  } finally { await f.close() }
})
