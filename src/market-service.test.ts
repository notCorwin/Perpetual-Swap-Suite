import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const fiveMinutes = 300_000
const hour = 3_600_000
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
    await service.persistStatisticsSource(instrument, '1H', end, 2, values)
    const rows = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: timestamps[0], through: end })
    for (const index of [0, 1, 2]) {
      assert.equal(rows[index].buy, null)
      assert.equal(rows[index].sell, null)
      assert.equal(rows[index].oi, 1_000 + index, 'Rejecting Taker must retain the independent OI source.')
      assert.equal(rows[index].statisticsVersion, 7, 'Invalid Taker is an observed null, not an unfetched source.')
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
const fixture = async (preferences = disabled(), fetcher: typeof fetch = async () => { throw new Error('Unexpected network request.') }, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-service-integrated-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => preferences, fetcher, false, options)
  await service.ready
  // Broad background targets are tested by MarketHistory; service tests control their source universe explicitly.
  service.history.target = async () => []
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { root, store, service, preferences, close }
}
const localCatalog = (service: MarketService, ids = [instId]) => service.replaceCatalog(ids.map(id => ({
  instrument: { ...instrument, instId: id }, ticker: { ...ticker, instId: id }, result: { eligible: true, status: 'verified', turnover: 40_000_000 },
})))
const discovery = (extra?: (url: URL) => Response | Promise<Response> | null): typeof fetch => async input => {
  const url = new URL(String(input))
  if (url.pathname.endsWith('/public/instruments')) return response([instrument])
  if (url.pathname.endsWith('/market/tickers')) return response([ticker])
  const result = extra?.(url)
  if (result) return result
  throw new Error(`Unexpected ${url}`)
}

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
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([instrument, { ...instrument, instId: 'ETH-USDT-SWAP' }])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker, { ...ticker, instId: 'ETH-USDT-SWAP' }])
    if (url.pathname.endsWith('/public/open-interest')) {
      if (url.searchParams.get('instId') === instId) return response([{ oiUsd: '6000000' }])
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
    resolveSlow(response([{ oiUsd: '1' }]))
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
  const f = await fixture(configuration, discovery(url => url.pathname.endsWith('/public/open-interest') ? response(empty ? [] : [{ oiUsd: '6000000' }]) : null))
  try {
    await f.service.refresh()
    const initial = f.service.metadata.getCatalogEntry(instId)
    empty = true
    await f.service.refresh()
    const retained = f.service.metadata.getCatalogEntry(instId)
    assert.equal(retained.status, 'verified')
    assert.equal(retained.observations.openInterest.observedAt, initial.observations.openInterest.observedAt)
    assert.equal(retained.expiresAt, initial.expiresAt)
    f.service.catalog.get(instId).expiresAt = Date.now() - 1
    assert.equal((await f.service.snapshot()).rows.length, 0)
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
    await f.service.dataAuditRequest({ action: 'repair' })
    await f.service.history.audit.whenIdle()
    const repaired = await f.service.dataAuditRequest({ action: 'status' })
    assert.equal(repaired.issues.length, 0)
    assert.equal(calls.length, checked.issues.length)
    assert.ok(f.service.dataRevision(instId) > 0)
  } finally { await f.close() }
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


test('refresh cadence follows scan start so a long scan does not extend the ticker lease gap', async () => {
  const f = await fixture()
  try {
    f.service.autoRefresh = true
    f.service.lastRefreshAt = Date.now()
    f.service.refreshStartedAt = Date.now() - 50_000
    f.service.scheduleRefresh()
    assert.ok(f.service.refreshTimer._idleTimeout <= 10_000)
    assert.ok(f.service.refreshTimer._idleTimeout > 9_000)
    f.service.refreshStartedAt = Date.now() - 90_000
    f.service.scheduleRefresh()
    assert.equal(f.service.refreshTimer._idleTimeout, 1, 'An overlong scan immediately revalidates its expired observations.')
  } finally { await f.close() }
})
