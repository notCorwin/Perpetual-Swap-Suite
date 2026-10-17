import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'

const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const hourly = Array.from({ length: 24 }, (_, index) => [String(1_700_000_000_000 + index * 3_600_000), '99', '101', '98', '100', '1', '1000', '100000', '1'])
const fiveMinutes = 300_000
const hour = 3_600_000
const rawCandle = (timestamp: number, close = 100) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: Math.max(0.000001, close - 1), high: close + 1, low: Math.max(0.000001, close - 2), close, volume: 1, baseVolume: 1, quoteVolume: close, confirmed: true })
const nativeCandle = (timestamp: number, timeframe: '5m' | '15m' | '1H', close = 100) => ({ ...rawCandle(timestamp, close), timeframe })
const okxCandle = (value: ReturnType<typeof rawCandle>) => [String(value.timestamp), String(value.open), String(value.high), String(value.low), String(value.close), String(value.volume), '1', String(value.quoteVolume), '1']
const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 2_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition.')
}

test('market discovery admits only a fully liquid USDT perpetual', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([{ instId: 'BTC-USDT-SWAP', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }, { instId: 'ETH-USD-SWAP', instCategory: '1', settleCcy: 'USD', state: 'live', ctVal: '1', ctValCcy: 'USD' }])
    if (url.pathname.endsWith('/market/tickers')) return response([{ instId: 'BTC-USDT-SWAP', last: '100', bidPx: '99.99', askPx: '100', open24h: '90', high24h: '110', low24h: '80', volCcy24h: '400000' }])
    if (url.pathname.endsWith('/market/books')) return response([{ asks: [['100', '100100']], bids: [['99.99', '100100']] }])
    if (url.pathname.endsWith('/public/open-interest')) return response([{ oiUsd: '6000000' }])
    if (url.pathname.endsWith('/market/candles')) return response(hourly)
    throw new Error(`Unexpected ${url}`)
  }
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher)
    await service.refresh()
    const snapshot = await service.snapshot()
    assert.equal(snapshot.error, '')
    assert.equal(snapshot.rows.length, 1)
    assert.equal(snapshot.rows[0].instId, 'BTC-USDT-SWAP')
    assert.equal(snapshot.rows[0].turnover24hUSDT, 40_000_000)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('native candles preserve absent or explicit-null statistics without manufacturing a derived row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
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
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('1H list projections read the native candle sequence instead of a 5m aggregation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 20, 12)
  const first = end - 200 * hour
  const native = Array.from({ length: 201 }, (_, index) => ({ ...rawCandle(first + index * hour, 200 + index), timeframe: '1H', statisticsVersion: 1, oi: 1_000 + index, buy: 100 + index, sell: 50 + index }))
  const raw = Array.from({ length: 12 }, (_, index) => rawCandle(end - index * fiveMinutes, 1))
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    await store.appendCandles([...native, ...raw])
    const projection = await service.readListBars({ instrument }, '1H')
    assert.equal(projection.end, end)
    assert.equal(projection.bars.at(-1)?.close, native.at(-1)?.close)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('OI and Taker use contract units, the requested timeframe, and an inclusive end cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const calls: URL[] = []
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const start = Date.UTC(2024, 0, 1)
  const end = start + 95 * hour
  const hourlyCandles = Array.from({ length: 96 }, (_, index) => ({ instrument: instrument.instId, timeframe: '1H', timestamp: start + index * hour, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, confirmed: true }))
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname.endsWith('/open-interest-history')) return response(hourlyCandles.map((value, index) => [String(value.timestamp), String(1_000 + index), '0', '0']))
    if (url.pathname.endsWith('/taker-volume-contract')) return response(hourlyCandles.map((value, index) => [String(value.timestamp), String(10 + index), String(20 + index)]))
    throw new Error(`Unexpected ${url}`)
  }
  try {
    await store.appendCandles(hourlyCandles)
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    const result = await service.hydrateStatistics(instrument, '1H', end)
    assert.equal(result.complete, true)
    const [last] = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: end, through: end })
    assert.equal(last.oi, 1_095)
    assert.equal(last.sell, 105)
    assert.equal(last.buy, 115)
    assert.equal(last.statisticsVersion, 1)
    const oi = calls.find(call => call.pathname.endsWith('/open-interest-history'))!
    const taker = calls.find(call => call.pathname.endsWith('/taker-volume-contract'))!
    assert.equal(oi.searchParams.get('period'), '1H')
    assert.equal(oi.searchParams.get('end'), String(end + hour))
    assert.equal(taker.searchParams.get('period'), '1H')
    assert.equal(taker.searchParams.get('unit'), '1')
    assert.equal(taker.searchParams.get('end'), String(end + hour))
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a history boundary uses fresh coverage after a successful earlier-page repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const firstStored = Date.UTC(2024, 3, 1, 12)
  const fetchedFirst = firstStored - 140 * fiveMinutes
  const gapFrom = fetchedFirst - 60 * fiveMinutes
  const gapThrough = firstStored - fiveMinutes
  let historyRequests = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url}`)
    historyRequests += 1
    if (historyRequests === 1) {
      return response(Array.from({ length: 140 }, (_, index) => okxCandle(rawCandle(fetchedFirst + index * fiveMinutes, 100 + index))))
    }
    return response([])
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(Array.from({ length: 24 }, (_, index) => rawCandle(firstStored + index * fiveMinutes, 300 + index)))
    let gap: { from: number; through: number; emptyResponses?: number } = { from: gapFrom, through: gapThrough, emptyResponses: 0 }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await service.repairGap(instrument, '5m', gap, new AbortController().signal, 'background', true)
      assert.equal(result.deferred, undefined)
      assert.ok(result.remaining?.length)
      // List warm-up preserves this counter by gap start while reconstructing
      // missing ranges from Parquet on the next retry.
      gap = { ...result.remaining[0], emptyResponses: gap.emptyResponses }
    }
    assert.equal(historyRequests, 4)
    assert.equal(service.historyBoundaries.get(service.seriesKey(instrument, '5m')), fetchedFirst)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('disposing an active refresh aborts it before the DuckDB store closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  let started = false, aborted = false
  const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    started = true
    init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('The request was aborted.', 'AbortError'))
    }, { once: true })
  })
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const hydration = service.hydrate(instrument)
    await waitFor(() => started)
    await service.dispose()
    assert.equal(await hydration, false)
    assert.equal(aborted, true)
    await store.close()
    await assert.rejects(() => store.candles({ instrument: instrument.instId, timeframe: '5m' }), /MarketStore is closed/)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('disposing during an OKX retry-after delay settles immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls += 1
    return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const hydration = service.hydrate(instrument)
    await waitFor(() => calls === 1)
    const completed = await Promise.race([
      service.dispose().then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
    ])
    assert.equal(completed, true)
    assert.equal(await hydration, false)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('5m writes do not mutate native timeframe OI or taker statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const start = Date.UTC(2024, 7, 1)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
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

test('rate-limited chart retries honor Retry-After and headerless 429s use bounded backoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  let directedCalls = 0, headerlessCalls = 0
  const directed = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async () => {
    directedCalls += 1
    return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
  }, false)
  const headerless = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async () => {
    headerlessCalls += 1
    return new Response(null, { status: 429 })
  }, false)
  try {
    await directed.hydrate(instrument)
    const limited = directed.latestCandleRetryState(instrument)
    assert.equal(limited.status, 'retrying')
    assert.ok((limited.retryAt ?? 0) - Date.now() >= 59_000)
    assert.ok((limited.retryAt ?? Infinity) - Date.now() <= 60_100)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(directedCalls, 1)

    const delays: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await headerless.hydrate(instrument)
      const state = headerless.latestCandleRetryState(instrument)
      delays.push((state.retryAt ?? Date.now()) - Date.now())
      if (state.timer) clearTimeout(state.timer)
      state.timer = null; state.retryAt = null
      // Advance this isolated retry state without waiting through the candle
      // lane's one-second cool-off on every test iteration.
      headerless.requestLane('candles').rateLimitedUntil = 0
    }
    const state = headerless.latestCandleRetryState(instrument)
    assert.equal(headerlessCalls, 5)
    assert.equal(state.status, 'unavailable')
    assert.ok(delays[0] >= 900 && delays[1] >= 2_900 && delays[2] >= 9_900 && delays[3] >= 29_900)
  } finally { await directed.dispose(); await headerless.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a foreground request cancels noncooperative background work instead of inheriting its queue slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  let backgroundStarted = false, foregroundStarted = false
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/background')) {
      backgroundStarted = true
      return new Promise<Response>(() => {})
    }
    foregroundStarted = true
    return response([])
  }, false)
  try {
    const background = service.get('/background', {}, undefined, 'background')
    const backgroundResult = background.then(() => null, (error: unknown) => error)
    await waitFor(() => backgroundStarted)
    await service.get('/foreground', {})
    assert.equal(foregroundStarted, true)
    assert.ok(await backgroundResult)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a candle repair starts beside OI and Taker without aborting either statistics lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  let oiStarted = false, takerStarted = false, repairStarted = false, oiAborts = 0, takerAborts = 0
  let releaseOI: (() => void) | undefined, releaseTaker: (() => void) | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/open-interest-history')) return new Promise<Response>((resolve, reject) => {
      oiStarted = true
      releaseOI = () => resolve(response([]))
      init?.signal?.addEventListener('abort', () => { oiAborts += 1; reject(new DOMException('The request was aborted.', 'AbortError')) }, { once: true })
    })
    if (path.endsWith('/taker-volume-contract')) return new Promise<Response>((resolve, reject) => {
      takerStarted = true
      releaseTaker = () => resolve(response([]))
      init?.signal?.addEventListener('abort', () => { takerAborts += 1; reject(new DOMException('The request was aborted.', 'AbortError')) }, { once: true })
    })
    if (path.endsWith('/market/history-candles')) { repairStarted = true; return response([]) }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const oi = service.get('/rubik/stat/contracts/open-interest-history', {}, undefined, 'statistics')
    const taker = service.get('/rubik/stat/taker-volume-contract', {}, undefined, 'statistics')
    await waitFor(() => oiStarted && takerStarted)
    await service.get('/market/history-candles', {}, undefined, 'repair')
    assert.equal(repairStarted, true)
    assert.equal(oiAborts, 0)
    assert.equal(takerAborts, 0)
    releaseOI?.(); releaseTaker?.()
    await Promise.all([oi, taker])
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('Taker zero placeholders become unavailable without erasing genuine zero-volume periods or healthy direct values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 20, 12)
  const timestamps = Array.from({ length: 100 }, (_, index) => end - (99 - index) * hour)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
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

// The market list must be a projection of the cache, not a catalogue-shaped
// placeholder which only acquires readings after a user opens a chart.
const listFixtureInstrument = { instId: 'BTC-USDT-SWAP', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }

const liquidCatalogueResponse = (url: URL) => {
  if (url.pathname.endsWith('/public/instruments')) return response([listFixtureInstrument])
  if (url.pathname.endsWith('/market/tickers')) return response([{
    instId: listFixtureInstrument.instId, last: '250', bidPx: '249.99', askPx: '250', open24h: '245', high24h: '255', low24h: '240', volCcy24h: '200000',
  }])
  if (url.pathname.endsWith('/market/books')) return response([{ asks: [['250', '60000']], bids: [['249.99', '60000']] }])
  if (url.pathname.endsWith('/public/open-interest')) return response([{ oiUsd: '6000000' }])
  if (url.pathname.endsWith('/market/candles')) return response(hourly)
  return null
}

const seedProjectedListCache = async (store: MarketStore) => {
  // Every list period is persisted from its own native OKX sequence. This
  // keeps the cache fixture faithful to the production no-aggregation path.
  const latestComplete = (interval: number) => Math.floor((Date.now() - interval) / interval) * interval
  const start = latestComplete(hour) - 200 * hour
  const closeAt = (timestamp: number) => 100 + (timestamp - start) / fiveMinutes * 0.05
  const ends: Record<string, number> = {}
  for (const [timeframe, interval, base] of [['5m', fiveMinutes, 1_000], ['15m', 3 * fiveMinutes, 2_000], ['1H', hour, 3_000]] as const) {
    const end = latestComplete(interval)
    ends[timeframe] = end
    const candles = Array.from({ length: 201 }, (_, index) => {
      const timestamp = end - (200 - index) * interval
      return {
        ...nativeCandle(timestamp, timeframe, closeAt(timestamp)),
        ...(index < 105 ? {} : {
          oi: base + (index - 105) * 11,
          sell: base + index - 105,
          buy: base + 200 + index - 105,
          statisticsVersion: 1,
        }),
      }
    })
    await store.appendCandles(candles)
  }
  return { rawLast: ends['5m'], start, ends, closeAt }
}

test('refresh projects cached 1H indicators and direct OI/Taker statistics into the list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const requests: string[] = []
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url.pathname)
    const result = liquidCatalogueResponse(url)
    if (result) return result
    throw new Error(`Unexpected list warm-up request: ${url.pathname}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const fixture = await seedProjectedListCache(store)
    await service.refresh()
    const base = await service.snapshot('1H')
    assert.ok(base.rows.find(value => value.instId === listFixtureInstrument.instId), 'A refresh must publish the liquid base row before its DuckDB projection settles.')
    await waitFor(async () => {
      const snapshot = await service.snapshot('1H')
      const row = snapshot.rows.find(value => value.instId === listFixtureInstrument.instId)
      return Boolean(row && Number.isFinite(row.roc) && row.oiChange !== null && row.takerRatio !== null)
    })
    const snapshot = await service.snapshot('1H')
    const row = snapshot.rows.find(value => value.instId === listFixtureInstrument.instId)!
    assert.equal(snapshot.timeframe, '1H')
    assert.equal(snapshot.listProgress.total, 1)
    assert.equal(row.ema200Signal, 'Long')
    assert.ok(Number.isFinite(row.roc))
    assert.ok(Number.isFinite(row.maroc))
    assert.ok(Number.isFinite(row.rsi6))
    assert.ok(Number.isFinite(row.rsi12))
    assert.ok(Number.isFinite(row.rsi24))
    assert.equal(row.oiChange, 11 / (3_000 + 94 * 11) * 100)
    assert.equal(row.buy, 3_000 + 200 + 95)
    assert.equal(row.sell, 3_000 + 95)
    assert.ok((row.takerRatio ?? 0) > 0)
    assert.notEqual(row.opportunity.status, 'Incomplete')
    assert.equal(row.price, fixture.closeAt(fixture.ends['1H']))
    assert.deepEqual(requests.sort(), [
      '/api/v5/market/books', '/api/v5/market/candles', '/api/v5/market/tickers', '/api/v5/public/instruments', '/api/v5/public/open-interest',
    ].sort(), 'A complete cached list must not fetch candles or statistics before displaying its readings.')
    await waitFor(() => service.listProgress('1H').completed === 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a persisted liquid catalog restores a base list immediately and projects cached readings without discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  let store = await MarketStore.open(root)
  const discovery: typeof fetch = async input => {
    const result = liquidCatalogueResponse(new URL(String(input)))
    if (result) return result
    throw new Error(`Unexpected discovery request: ${input}`)
  }
  let initial = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), discovery, false)
  let restored: MarketService | undefined
  let releaseCacheProjection: (() => void) | undefined
  try {
    await seedProjectedListCache(store)
    await initial.refresh()
    const savedAt = initial.catalogUpdatedAt
    assert.ok(Number.isFinite(savedAt))
    await initial.dispose()
    await store.close()

    store = await MarketStore.open(root)
    const originalCoverage = store.candles.bind(store)
    const cacheProjectionGate = new Promise<void>(resolve => { releaseCacheProjection = resolve })
    let cacheProjectionStarted = false
    store.candles = async (...arguments_) => {
      cacheProjectionStarted = true
      await cacheProjectionGate
      return originalCoverage(...arguments_)
    }
    let requests = 0
    restored = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async () => {
      requests += 1
      throw new Error('A cache restore must not wait for discovery.')
    }, false)
    const restoring = restored.restoreCatalog()
    await waitFor(() => cacheProjectionStarted)
    assert.equal(await Promise.race([restoring, new Promise(resolve => setTimeout(() => resolve(false), 100))]), true, 'Restoring the catalogue must not wait for per-entry DuckDB projections.')
    const initialSnapshot = await restored.snapshot('1H')
    const initialRow = initialSnapshot.rows.find(value => value.instId === listFixtureInstrument.instId)
    assert.equal(initialSnapshot.catalogSource, 'cache')
    assert.equal(initialSnapshot.updatedAt, savedAt)
    assert.equal(requests, 0)
    assert.ok(initialRow, 'The restored catalogue makes a price/liquidity row available before cache projection finishes.')

    if (!releaseCacheProjection) throw new Error('The cache projection gate was not installed.')
    releaseCacheProjection()
    await waitFor(async () => {
      const snapshot = await restored!.snapshot('1H')
      const row = snapshot.rows.find(value => value.instId === listFixtureInstrument.instId)
      return Boolean(row && Number.isFinite(row.roc) && Number.isFinite(row.rsi6) && row.oiChange !== null && row.takerRatio !== null)
    })
    const snapshot = await restored.snapshot('1H')
    const row = snapshot.rows.find(value => value.instId === listFixtureInstrument.instId)!
    assert.ok(Number.isFinite(row.roc))
    assert.ok(Number.isFinite(row.rsi6))
    assert.notEqual(row.oiChange, null)
    assert.notEqual(row.takerRatio, null)

    // Startup starts live discovery after restoring the local catalogue. A
    // failed discovery must report its error without erasing the last usable
    // rows or relabelling cache data as live.
    await restored.refresh()
    const afterFailedDiscovery = await restored.snapshot('1H')
    const retained = afterFailedDiscovery.rows.find(value => value.instId === listFixtureInstrument.instId)
    assert.ok(requests > 0)
    assert.equal(afterFailedDiscovery.catalogSource, 'cache')
    assert.equal(afterFailedDiscovery.updatedAt, savedAt)
    assert.ok(retained)
    assert.notEqual(retained.oiChange, null)
    assert.notEqual(retained.takerRatio, null)
  } finally { releaseCacheProjection?.(); await restored?.dispose(); await initial.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an unchanged catalogue keeps entry identity while a cache projection is in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  const entry = {
    instrument: { ...listFixtureInstrument },
    ticker: { instId: listFixtureInstrument.instId, last: '103', open24h: '100', low24h: '90', high24h: '110' },
    result: { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 },
    change24h: 3,
  }
  try {
    assert.equal(service.replaceCatalog([entry]), true)
    const activeEntry = service.catalogEntry(listFixtureInstrument.instId)
    assert.equal(service.replaceCatalog([JSON.parse(JSON.stringify(entry))]), false)
    assert.equal(service.catalogEntry(listFixtureInstrument.instId), activeEntry, 'An identical refresh must not invalidate an in-flight projection by changing entry identity.')
    assert.equal(service.catalogRevision, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a live catalogue replacement reuses the in-flight cache projection for its current row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  const entry = {
    instrument: { ...listFixtureInstrument },
    ticker: { instId: listFixtureInstrument.instId, last: '103', open24h: '100', low24h: '90', high24h: '110' },
    result: { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 },
    change24h: 3,
  }
  const originalCoverage = store.candles.bind(store)
  let releaseProjection: (() => void) | undefined, projectionStarted = false, coverageCalls = 0
  const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve })
  store.candles = async (...arguments_) => {
    coverageCalls += 1
    if (coverageCalls === 1) {
      projectionStarted = true
      await projectionGate
    }
    return originalCoverage(...arguments_)
  }
  try {
    await seedProjectedListCache(store)
    service.catalogSource = 'cache'
    service.catalogUpdatedAt = Date.now()
    service.replaceCatalog([entry])
    await waitFor(() => projectionStarted)

    const replacement = {
      ...entry,
      ticker: { ...entry.ticker, last: '104' },
      result: { ...entry.result, turnover: 41_000_000 },
      change24h: 4,
    }
    service.replaceCatalog([replacement])
    const currentPrime = service.primeListRowsFromCache('1H')
    if (!releaseProjection) throw new Error('The cache projection gate was not installed.')
    releaseProjection()
    await currentPrime

    const row = service.listRowsFor('1H').find(value => value.instId === listFixtureInstrument.instId)
    assert.ok(row, 'The replacement catalogue row should be published by the already-running cache projection.')
    assert.equal(row.lastPrice, 104, 'The projected row must use the live replacement ticker, not its stale cache-era object.')
    assert.ok(Number.isFinite(row.roc))
    assert.ok(Number.isFinite(row.rsi6))
    assert.notEqual(row.oiChange, null)
    assert.notEqual(row.takerRatio, null)
    assert.equal(service.listProjectionVersions.get('1H'), service.catalogRevision)
    assert.equal(coverageCalls, 1, 'A metadata-only catalogue replacement must reuse the existing instrument projection instead of queueing a second DuckDB read.')
  } finally { releaseProjection?.(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('disposing during a pending candle write never starts a late list projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  const entry = {
    instrument: { ...listFixtureInstrument },
    ticker: { instId: listFixtureInstrument.instId, last: '103', open24h: '100', low24h: '90', high24h: '110' },
    result: { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 },
    change24h: 3,
  }
  const originalAppend = store.appendCandles.bind(store), originalCoverage = store.coverage.bind(store)
  let releaseWrite: (() => void) | undefined, writeStarted = false, appendCalls = 0, coverageCalls = 0
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  store.appendCandles = async (...arguments_) => {
    appendCalls += 1
    if (appendCalls === 1) {
      writeStarted = true
      await writeGate
    }
    return originalAppend(...arguments_)
  }
  try {
    service.replaceCatalog([entry])
    await service.primeListRowsFromCache('1H')
    store.coverage = async (...arguments_) => {
      coverageCalls += 1
      return originalCoverage(...arguments_)
    }
    const timestamp = Math.floor((Date.now() - fiveMinutes) / fiveMinutes) * fiveMinutes
    const writing = service.persistCandles(listFixtureInstrument.instId, [rawCandle(timestamp, 101)])
    await waitFor(() => writeStarted)
    const disposing = service.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(disposed, false, 'dispose must wait for the admitted candle mutation before the Store can close.')
    if (!releaseWrite) throw new Error('The candle write gate was not installed.')
    releaseWrite()
    await writing
    await disposing
    assert.equal(coverageCalls, 0, 'A continuation after dispose must not enqueue a new DuckDB list projection.')
  } finally { releaseWrite?.(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a snapshot after disposal never restarts a cache projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  const entry = {
    instrument: { ...listFixtureInstrument },
    ticker: { instId: listFixtureInstrument.instId, last: '103', open24h: '100', low24h: '90', high24h: '110' },
    result: { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 },
    change24h: 3,
  }
  const originalCoverage = store.coverage.bind(store)
  let coverageCalls = 0
  try {
    service.replaceCatalog([entry])
    await service.primeListRowsFromCache('1H')
    await service.dispose()
    store.coverage = async (...arguments_) => {
      coverageCalls += 1
      return originalCoverage(...arguments_)
    }
    const snapshot = await service.snapshot('1H')
    await service.primeListRowsFromCache('1H')
    assert.equal(snapshot.rows.length, 1)
    assert.equal(coverageCalls, 0, 'A late renderer poll cannot revive DuckDB work after service disposal.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('list snapshots project each selected timeframe instead of reusing the 1H row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const fetcher: typeof fetch = async input => {
    const result = liquidCatalogueResponse(new URL(String(input)))
    if (result) return result
    throw new Error(`Unexpected list warm-up request: ${input}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const fixture = await seedProjectedListCache(store)
    assert.equal((await store.coverage(listFixtureInstrument.instId, '5m')).last, fixture.rawLast)
    await service.refresh()
    const [fiveMinute, fifteenMinute, oneHour] = await Promise.all([
      service.snapshot('5m'), service.snapshot('15m'), service.snapshot('1H'),
    ])
    assert.deepEqual([fiveMinute.timeframe, fifteenMinute.timeframe, oneHour.timeframe], ['5m', '15m', '1H'])
    assert.ok([fiveMinute, fifteenMinute, oneHour].every(snapshot => snapshot.rows.some(value => value.instId === listFixtureInstrument.instId)), 'Each selected timeframe gets an immediate base row.')
    await waitFor(async () => {
      const snapshots = await Promise.all(['5m', '15m', '1H'].map(timeframe => service.snapshot(timeframe as '5m' | '15m' | '1H')))
      return snapshots.every(snapshot => {
        const row = snapshot.rows.find(value => value.instId === listFixtureInstrument.instId)
        return Boolean(row && Number.isFinite(row.priceChange) && Number.isFinite(row.roc) && row.oiChange !== null && row.takerRatio !== null)
      })
    })
    const settled = await Promise.all(['5m', '15m', '1H'].map(timeframe => service.snapshot(timeframe as '5m' | '15m' | '1H')))
    const rows = settled.map(snapshot => snapshot.rows.find(value => value.instId === listFixtureInstrument.instId))
    assert.ok(rows.every(Boolean))
    const [five, fifteen, hourlyRow] = rows
    assert.ok(Number.isFinite(five!.priceChange))
    assert.ok(Number.isFinite(fifteen!.priceChange))
    assert.ok(Number.isFinite(hourlyRow!.priceChange))
    assert.notEqual(five!.priceChange, fifteen!.priceChange)
    assert.notEqual(fifteen!.priceChange, hourlyRow!.priceChange)
    assert.notEqual(five!.roc, hourlyRow!.roc)
    assert.notEqual(five!.oiChange, fifteen!.oiChange)
    assert.notEqual(fifteen!.oiChange, hourlyRow!.oiChange)
    assert.notEqual(five!.takerRatio, null, '5m must keep its direct Taker statistics.')
    const expectedFifteenEnd = fixture.ends['15m']
    const directFifteen = await store.candles({ instrument: listFixtureInstrument.instId, timeframe: '15m', from: expectedFifteenEnd - 95 * 3 * fiveMinutes, through: expectedFifteenEnd })
    assert.equal(directFifteen.length, 96)
    assert.ok(directFifteen.every(value => value.statisticsVersion === 1))
    assert.notEqual(fifteen!.takerRatio, null, '15m must keep its direct Taker statistics.')
    assert.notEqual(hourlyRow!.takerRatio, null, '1H must keep its direct Taker statistics.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a failed background list warm-up enters a scheduled retry instead of stopping permanently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  let candleRequests = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/candles')) {
      // Liquidity discovery uses a short 1H sample; the list's native 1H
      // cache hydration uses limit=300 and is the request under test.
      if (url.searchParams.get('limit') === '25') return response(hourly)
      candleRequests += 1
      return new Response('temporarily unavailable', { status: 503 })
    }
    const discovery = liquidCatalogueResponse(url)
    if (discovery) return discovery
    throw new Error(`Unexpected ${url.pathname}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 1_000 })
  try {
    await service.refresh()
    await waitFor(() => service.listWarmupState(listFixtureInstrument.instId, '1H').status === 'retrying')
    const state = service.listWarmupState(listFixtureInstrument.instId, '1H')
    const snapshot = await service.snapshot('1H')
    assert.ok(candleRequests >= 1)
    assert.ok((state.retryAt ?? 0) > Date.now())
    assert.equal(snapshot.listProgress.retrying, 1)
    assert.equal(snapshot.listProgress.completed, 0)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('list warm-up follows a latest-candle Retry-After instead of retrying around it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  let candleRequests = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/candles')) {
      if (url.searchParams.get('limit') === '25') return response(hourly)
      candleRequests += 1
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
    }
    const discovery = liquidCatalogueResponse(url)
    if (discovery) return discovery
    throw new Error(`Unexpected ${url.pathname}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 1_000 })
  try {
    await service.refresh()
    await waitFor(() => service.listWarmupState(listFixtureInstrument.instId, '1H').status === 'retrying')
    const state = service.listWarmupState(listFixtureInstrument.instId, '1H')
    assert.equal(candleRequests, 1)
    assert.ok((state.retryAt ?? 0) - Date.now() >= 59_000)
    assert.equal(state.attempt, 0, 'The list retry inherits the pending latest-candle cooldown rather than consuming its own attempts.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
