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
const rawCandle = (timestamp: number, close = 100) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: close - 1, high: close + 1, low: close - 2, close, volume: 1, quoteVolume: close, confirmed: true })
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
    assert.equal(snapshot.rows[0].filterMetrics.oiUSD, 6_000_000)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('derived candles never turn absent or explicit-null statistics into zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
    const start = Date.UTC(2024, 0, 1)
    await service.persistCandles('BTC-USDT-SWAP', Array.from({ length: 12 }, (_, index) => ({
      ...rawCandle(start + index * fiveMinutes),
      oi: null,
      buy: null,
      sell: null,
    })))
    const [derived] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '1H', from: start, through: start })
    assert.equal(derived.oi, null)
    assert.equal(derived.buy, null)
    assert.equal(derived.sell, null)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
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

test('latest derived 15m/1H charts stop at a complete raw bucket and hydrate that visible window', async () => {
  const cases = [['15m', 15 * 60_000], ['1H', hour]] as const
  for (const [timeframe, interval] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
    const store = await MarketStore.open(root)
    const instrument = { instId: 'BTC-USDT-SWAP' }
    const end = Date.UTC(2024, 0, 15, 12)
    const first = end - 95 * interval
    const incompleteNextBucket = end + interval
    const visibleTimestamps = Array.from({ length: 96 }, (_, index) => first + index * interval)
    const calls: URL[] = []
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input)); calls.push(url)
      if (url.pathname.endsWith('/open-interest-history')) return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
      if (url.pathname.endsWith('/taker-volume-contract')) return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
      throw new Error(`Unexpected ${url}`)
    }
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    try {
      const raw = []
      for (let timestamp = first; timestamp <= end + interval - fiveMinutes; timestamp += fiveMinutes) raw.push(rawCandle(timestamp, 100 + raw.length / 100))
      // A direct row for the next period may already be persisted while only
      // its opening 5m candle exists. It must not become the latest chart end.
      raw.push(rawCandle(incompleteNextBucket, 200))
      await store.appendCandles([
        ...raw,
        { ...rawCandle(incompleteNextBucket, 300), timeframe, oi: 99_999, buy: 88_888, sell: 77_777, statisticsVersion: 1 },
      ])
      service.instruments.set(instrument.instId, instrument)
      assert.equal(service.focusChart(instrument.instId, 1), true)

      const initial = await service.bars(instrument.instId, timeframe, undefined, { hydrate: false, repair: false, foreground: true, focusToken: 1 })
      assert.equal(initial.bars.at(-1)?.hour, end)
      assert.equal(service.activeChartViewport?.end, end)
      await waitFor(() => service.statisticsState(instrument, timeframe, end).status === 'ready')

      const chart = await service.bars(instrument.instId, timeframe, undefined, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 1 })
      const visible = chart.bars.filter((bar: any) => bar.hour >= first && bar.hour <= end)
      assert.equal(visible.length, 96)
      assert.equal(visible[0]?.hour, first)
      assert.equal(visible.at(-1)?.hour, end)
      assert.equal(chart.bars.some((bar: any) => bar.hour === incompleteNextBucket), false)
      assert.equal(visible.at(-1)?.oi, 1_095)
      assert.equal(visible.at(-1)?.sell, 105)
      assert.equal(visible.at(-1)?.buy, 115)
      assert.ok(visible.every((bar: any) => bar.oi !== null && bar.buy !== null && bar.sell !== null))

      const statisticsCalls = calls.filter(call => call.pathname.includes('/rubik/stat/'))
      assert.equal(statisticsCalls.length, 2)
      for (const call of statisticsCalls) {
        assert.equal(call.searchParams.get('period'), timeframe)
        assert.equal(call.searchParams.get('end'), String(end + interval))
      }
    } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  }
})

test('legacy unversioned OI/Taker rows are rehydrated instead of accepted as complete statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 16, 12)
  const first = end - 95 * hour
  const timestamps = Array.from({ length: 96 }, (_, index) => first + index * hour)
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(10_000 + index), '0', '0']))
    }
    if (url.pathname.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), String(2_000 + index)]))
    }
    throw new Error(`Unexpected ${url}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const raw = Array.from({ length: 96 * 12 }, (_, index) => rawCandle(first + index * fiveMinutes, 100 + index / 100))
    const legacy = timestamps.map((timestamp, index) => ({
      ...rawCandle(timestamp, 100 + index), timeframe: '1H',
      // This is the legacy shape: values look complete but have no proof that
      // they came from current-timeframe, contract-unit endpoints.
      oi: 500 + index, buy: 600 + index, sell: 700 + index,
    }))
    await store.appendCandles([...raw, ...legacy])
    assert.equal(await service.hasCompleteStoredStatistics(instrument, '1H', end), false)

    service.instruments.set(instrument.instId, instrument)
    const cached = await service.bars(instrument.instId, '1H', end, { hydrate: false, repair: false, statistics: false })
    const cachedVisible = cached.bars.filter((bar: any) => bar.hour >= first && bar.hour <= end)
    assert.equal(cachedVisible.length, 96)
    assert.ok(cachedVisible.every((bar: any) => bar.oi === null && bar.buy === null && bar.sell === null), 'Unversioned legacy statistics must never reach the chart.')
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'ready')

    assert.equal(oiCalls, 1)
    assert.equal(takerCalls, 1)
    const rehydrated = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: first, through: end })
    assert.equal(rehydrated.length, 96)
    assert.ok(rehydrated.every((bar: any) => bar.statisticsVersion === 1))
    assert.equal(rehydrated[0]?.oi, 10_000)
    assert.equal(rehydrated[0]?.sell, 1_000)
    assert.equal(rehydrated[0]?.buy, 2_000)
    assert.equal(rehydrated.at(-1)?.oi, 10_095)
    assert.equal(rehydrated.at(-1)?.sell, 1_095)
    assert.equal(rehydrated.at(-1)?.buy, 2_095)
    assert.equal(await service.hasCompleteStoredStatistics(instrument, '1H', end), true)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a partial direct statistics response clears legacy fields and keeps the viewport retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 17, 12)
  const first = end - 95 * hour
  const timestamps = Array.from({ length: 96 }, (_, index) => first + index * hour)
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(10_000 + index), '0', '0']))
    }
    if (url.pathname.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response([])
    }
    throw new Error(`Unexpected ${url}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(timestamps.map((timestamp, index) => ({
      ...rawCandle(timestamp, 100 + index), timeframe: '1H',
      oi: 500 + index, buy: 600 + index, sell: 700 + index,
    })))
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'retrying')

    assert.equal(oiCalls, 1)
    assert.equal(takerCalls, 1)
    const partial = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: first, through: end })
    assert.ok(partial.every((bar: any) => bar.statisticsVersion === 1))
    assert.equal(partial[0]?.oi, 10_000)
    assert.equal(partial.at(-1)?.oi, 10_095)
    assert.ok(partial.every((bar: any) => bar.buy === null && bar.sell === null), 'Legacy unit=2 taker values must not be re-certified by a partial response.')
    assert.ok(partial.every((bar: any) => !('replaceStatistics' in bar)), 'The in-memory replacement marker must never reach Parquet.')
    assert.equal(await service.hasCompleteStoredStatistics(instrument, '1H', end), false)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an internally gapped newest raw bucket falls back for display while its tail stays repairable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 0, 18, 12)
  const displayEnd = end - hour
  const first = displayEnd - (95 + 199) * hour
  const missing = end + 30 * 60_000
  let historyCalls = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/history-candles')) {
      historyCalls += 1
      return response([okxCandle(rawCandle(missing, 200))])
    }
    if (url.pathname.endsWith('/open-interest-history') || url.pathname.endsWith('/taker-volume-contract')) return response([])
    throw new Error(`Unexpected ${url}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const source = []
    for (let timestamp = first; timestamp <= end + hour - fiveMinutes; timestamp += fiveMinutes) {
      if (timestamp !== missing) source.push(rawCandle(timestamp, 100 + source.length / 100))
    }
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)

    const chart = await service.bars(instrument.instId, '1H', undefined, { hydrate: false, repair: true, statistics: false, foreground: true, focusToken: 1 })
    assert.equal(chart.bars.at(-1)?.hour, displayEnd)
    assert.equal(service.activeChartViewport?.end, displayEnd)
    assert.equal(service.activeChartViewport?.repairEnd, end)
    assert.equal(chart.candleState, 'loading')
    await waitFor(() => historyCalls === 1)
    await waitFor(async () => (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: missing, through: missing })).length === 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an internal 5m gap is repaired immediately instead of being mistaken for a history boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 1, 1, 12)
  const from = target - (95 + 199) * hour
  const through = target + hour - fiveMinutes
  const gapStart = target - 10 * hour
  const missing = Array.from({ length: 12 }, (_, index) => rawCandle(gapStart + index * fiveMinutes, 200 + index))
  let historyCalls = 0, cursor = ''
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/history-candles')) {
      historyCalls += 1; cursor = url.searchParams.get('after') ?? ''
      return response(missing.map(okxCandle))
    }
    throw new Error(`Unexpected ${url}`)
  }
  try {
    const seed = []
    for (let timestamp = from; timestamp <= through; timestamp += fiveMinutes) {
      if (timestamp < gapStart || timestamp >= gapStart + hour) seed.push(rawCandle(timestamp))
    }
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    service.lastCandleHydration.set(instrument.instId, Date.now())
    await service.persistCandles(instrument.instId, seed)
    const loading = await service.bars(instrument.instId, '1H', target)
    assert.equal(loading.candleState, 'loading')
    await waitFor(() => service.candleRepairState(instrument.instId).status === 'ready')
    const availability = await service.ensureChartRange(instrument, '1H', target)
    assert.equal(availability.candleState, 'ready')
    assert.equal(historyCalls, 1)
    assert.equal(cursor, String(gapStart + hour))
    const [repaired] = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: gapStart, through: gapStart })
    assert.equal(repaired.confirmed, true)
    assert.equal(service.isHistoryExhausted(instrument.instId), false)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a successful response with no missing candles repaired retries without declaring an internal gap exhausted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 2, 1)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let calls = 0
  let service: MarketService | undefined
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url}`)
    calls += 1
    return response(calls === 1 ? [okxCandle(rawCandle(gap - fiveMinutes))] : [])
  }
  try {
    const seed = Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap)
    await store.appendCandles(seed)
    service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    await service.ensureChartRange(instrument, '5m', target)
    await waitFor(() => {
      const state = service?.candleRepairState(instrument.instId)
      return calls >= 2 && state?.status === 'retrying' && (state.retryAt ?? 0) > Date.now()
    }, 2_500)
    const state = service.candleRepairState(instrument.instId)
    assert.ok(state.retryAt > Date.now())
    assert.equal(service.isHistoryExhausted(instrument.instId), false)
  } finally { await service?.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('one empty history response before local coverage retries instead of fixing a false history boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 2, 2)
  const from = target - (95 + 199) * fiveMinutes
  const firstStored = from + fiveMinutes
  let calls = 0
  let service: MarketService | undefined
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url}`)
    calls += 1
    return response(calls === 1 ? [] : [okxCandle(rawCandle(from, 250))])
  }
  try {
    await store.appendCandles(Array.from({ length: 294 }, (_, index) => rawCandle(firstStored + index * fiveMinutes)))
    service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    await service.ensureChartRange(instrument, '5m', target)
    await waitFor(async () => {
      const state = service?.candleRepairState(instrument.instId)
      return calls >= 2 && (await store.candles({ instrument: instrument.instId, timeframe: '5m', from, through: from })).length === 1 && state?.status === 'ready' && !state.running
    }, 2_500)
    assert.equal(service.historyBoundaries.has(instrument.instId), false)
    assert.equal(service.isHistoryExhausted(instrument.instId), false)
  } finally { await service?.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
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
      const result = await service.repairGap(instrument, gap, new AbortController().signal, 'background', true)
      assert.equal(result.deferred, undefined)
      assert.ok(result.remaining?.length)
      // List warm-up preserves this counter by gap start while reconstructing
      // missing ranges from Parquet on the next retry.
      gap = { ...result.remaining[0], emptyResponses: gap.emptyResponses }
    }
    assert.equal(historyRequests, 4)
    assert.equal(service.historyBoundaries.get(instrument.instId), fetchedFirst)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a historical gap repair never waits for an unrelated latest-candle refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 3, 1)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let latestCalls = 0, historyCalls = 0
  let service: MarketService | undefined
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/candles')) {
      latestCalls += 1
      return response(latestCalls === 1 ? [] : [okxCandle(rawCandle(target))])
    }
    if (url.pathname.endsWith('/market/history-candles')) {
      historyCalls += 1
      return response([okxCandle(rawCandle(gap, 300))])
    }
    throw new Error(`Unexpected ${url}`)
  }
  try {
    const seed = Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap)
    await store.appendCandles(seed)
    service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    const chart = await service.bars(instrument.instId, '5m', target)
    assert.equal(chart.candleState, 'loading')
    assert.equal(latestCalls, 0)
    assert.equal(service.lastCandleHydration.has(instrument.instId), false)
    await waitFor(async () => (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: gap, through: gap })).length === 1)
    assert.equal(historyCalls, 1)
    assert.equal(latestCalls, 0)
  } finally { await service?.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a changed live candle invalidates cached chart results even when no 5m candle closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const timestamp = Date.UTC(2024, 3, 2)
  let call = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/candles')) throw new Error(`Unexpected ${url}`)
    const live = okxCandle(rawCandle(timestamp + fiveMinutes, call++ === 0 ? 101 : 102))
    live[8] = '0'
    return response([okxCandle(rawCandle(timestamp, 100)), live])
  }
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    await service.hydrate(instrument)
    const first = await service.bars(instrument.instId, '5m')
    assert.equal(first.bars.at(-1)?.close, 101)
    service.chartResults.set('ETH-USDT-SWAP:5m:cached', [])
    const revision = service.dataRevision(instrument.instId)
    service.lastCandleHydration.delete(instrument.instId)
    await service.hydrate(instrument)
    const second = await service.bars(instrument.instId, '5m')
    assert.equal(service.liveCandles.get(instrument.instId)?.close, 102)
    assert.equal(second.bars.at(-1)?.close, 102)
    assert.ok(service.dataRevision(instrument.instId) > revision)
    // A live-candle change invalidates this instrument's cached charts, but
    // another contract's cached chart must survive untouched.
    assert.equal(service.chartResults.has('ETH-USDT-SWAP:5m:cached'), true)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('statistics hydration starts while visible candles are still repairing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 6, 1)
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/history-candles')) return response([])
    if (url.pathname.endsWith('/open-interest-history')) { oiCalls += 1; return response([]) }
    if (url.pathname.endsWith('/taker-volume-contract')) { takerCalls += 1; return response([]) }
    throw new Error(`Unexpected ${url}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const chart = await service.bars(instrument.instId, '1H', end, { hydrate: false, repair: true, statistics: true, foreground: true, focusToken: 1 })
    assert.equal(chart.visibleCandleReady, false)
    // OKX publishes no 5m history, so the visible window can never fill.
    // Direct OI/Taker hydration must still run instead of waiting for it.
    await waitFor(() => oiCalls === 1 && takerCalls === 1)
    assert.equal(chart.candleState, 'loading')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a fresh internal gap repairs immediately while a different gap is backing off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 4, 1)
  const from = target - (95 + 199) * fiveMinutes
  const olderGap = target - 200 * fiveMinutes
  const newerGap = target - 20 * fiveMinutes
  const cursors: number[] = []
  let service: MarketService | undefined
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url}`)
    const cursor = Number(url.searchParams.get('after')); cursors.push(cursor)
    if (cursor === newerGap + fiveMinutes) return response([])
    if (cursor === olderGap + fiveMinutes) return response([okxCandle(rawCandle(olderGap, 400))])
    throw new Error(`Unexpected history cursor ${cursor}`)
  }
  try {
    const seed = Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== olderGap && value.timestamp !== newerGap)
    await store.appendCandles(seed)
    service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    await service.ensureChartRange(instrument, '5m', target)
    await waitFor(async () => {
      const olderRepaired = (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: olderGap, through: olderGap })).length === 1
      const state = service?.candleRepairState(instrument.instId)
      const newerRetry = state?.ranges.find((range: any) => range.from <= newerGap && range.through >= newerGap)
      return olderRepaired && newerRetry?.status === 'retrying' && (newerRetry.retryAt ?? 0) > Date.now() && !state?.running
    })
    const state = service.candleRepairState(instrument.instId)
    const newerRetry = state.ranges.find((range: any) => range.from <= newerGap && range.through >= newerGap)
    assert.deepEqual(cursors.slice(0, 2), [newerGap + fiveMinutes, olderGap + fiveMinutes])
    assert.equal((await store.candles({ instrument: instrument.instId, timeframe: '5m', from: newerGap, through: newerGap })).length, 0)
    assert.equal(newerRetry?.status, 'retrying')
    assert.ok((newerRetry?.retryAt ?? 0) > Date.now())
  } finally { await service?.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('switching charts pauses an old multi-page repair before it can delay the foreground gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const oldInstrument = { instId: 'BTC-USDT-SWAP' }
  const activeInstrument = { instId: 'ETH-USDT-SWAP' }
  const target = Date.UTC(2024, 5, 1)
  const from = target - (95 + 199) * fiveMinutes
  const oldGap = target - 20 * fiveMinutes
  const activeGap = target - 30 * fiveMinutes
  let oldCalls = 0, oldAborts = 0, activeCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), id = url.searchParams.get('instId')
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url}`)
    if (id === oldInstrument.instId) {
      oldCalls += 1
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        oldAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
    }
    if (id === activeInstrument.instId) { activeCalls += 1; return response([okxCandle({ ...rawCandle(activeGap, 500), instrument: activeInstrument.instId })]) }
    throw new Error(`Unexpected instrument ${id}`)
  }
  let service: MarketService | undefined
  try {
    const oldSeed = Array.from({ length: 295 }, (_, index) => ({ ...rawCandle(from + index * fiveMinutes), instrument: oldInstrument.instId })).filter(value => value.timestamp !== oldGap)
    const activeSeed = Array.from({ length: 295 }, (_, index) => ({ ...rawCandle(from + index * fiveMinutes), instrument: activeInstrument.instId })).filter(value => value.timestamp !== activeGap)
    await store.appendCandles([...oldSeed, ...activeSeed])
    service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(oldInstrument.instId, oldInstrument)
    service.instruments.set(activeInstrument.instId, activeInstrument)
    service.lastCandleHydration.set(oldInstrument.instId, Date.now())
    service.lastCandleHydration.set(activeInstrument.instId, Date.now())
    assert.equal(service.focusChart(oldInstrument.instId, 1), true)
    await service.bars(oldInstrument.instId, '5m', target, { foreground: true, focusToken: 1 })
    await waitFor(() => oldCalls === 1)
    assert.equal(service.focusChart(activeInstrument.instId, 2), true)
    assert.equal(service.focusChart(oldInstrument.instId, 1), false, 'A delayed stale request cannot retake foreground ownership.')
    await service.bars(activeInstrument.instId, '5m', target, { foreground: true, focusToken: 2 })
    await waitFor(async () => oldAborts > 0 && activeCalls === 1 && (await store.candles({ instrument: activeInstrument.instId, timeframe: '5m', from: activeGap, through: activeGap })).length === 1)
    await waitFor(() => service?.candleRepairState(oldInstrument.instId).running === false)
    assert.equal(oldCalls, 1)
  } finally { await service?.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('background chart previews read cache only and cannot start network work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  let calls = 0
  const fetcher: typeof fetch = async () => { calls += 1; throw new Error('Preview must not fetch') }
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
    service.instruments.set(instrument.instId, instrument)
    const preview = await service.bars(instrument.instId, '5m', undefined, { hydrate: false, repair: false, statistics: false })
    assert.deepEqual(preview.bars, [])
    assert.equal(calls, 0)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
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

test('disposing waits for an already-running chart read before callers may close the store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const originalCoverage = store.coverage.bind(store)
  let coverageCalls = 0, releaseCoverage: (() => void) | undefined
  const coverageGate = new Promise<void>(resolve => { releaseCoverage = resolve })
  store.coverage = async (...arguments_) => {
    coverageCalls += 1
    if (coverageCalls === 1) await coverageGate
    return originalCoverage(...arguments_)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    const bars = service.bars('BTC-USDT-SWAP', '5m', undefined, { hydrate: false, repair: false, statistics: false })
    await waitFor(() => coverageCalls === 1)
    let disposed = false
    const shutdown = service.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(disposed, false)
    releaseCoverage?.()
    await bars
    await shutdown
    assert.equal(disposed, true)
  } finally { releaseCoverage?.(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('switching charts aborts stale OI/Taker work and immediately serves the new foreground viewport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const btc = { instId: 'BTC-USDT-SWAP' }, eth = { instId: 'ETH-USDT-SWAP' }
  const end = Date.UTC(2024, 6, 1, 12)
  const timestamps = Array.from({ length: 96 }, (_, index) => end - (95 - index) * hour)
  let staleAborts = 0, freshRequests = 0, staleRequests = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), id = url.searchParams.get('instId')
    if (!url.pathname.includes('/rubik/stat/')) throw new Error(`Unexpected ${url}`)
    if (id === btc.instId) {
      staleRequests += 1
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        staleAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
    }
    freshRequests += 1
    if (url.pathname.endsWith('/open-interest-history')) return response(timestamps.map((timestamp, index) => [String(timestamp), String(index + 1), '0', '0']))
    return response(timestamps.map((timestamp, index) => [String(timestamp), String(index + 1), String(index + 2)]))
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(timestamps.flatMap(timestamp => [
      { ...rawCandle(timestamp), instrument: btc.instId, timeframe: '1H' },
      { ...rawCandle(timestamp), instrument: eth.instId, timeframe: '1H' },
    ]))
    service.instruments.set(btc.instId, btc); service.instruments.set(eth.instId, eth)
    service.lastCandleHydration.set(btc.instId, Date.now()); service.lastCandleHydration.set(eth.instId, Date.now())
    service.focusChart(btc.instId, 1)
    service.activateChartViewport(btc, '1H', end)
    service.requestStatistics(btc, '1H', end)
    await waitFor(() => staleRequests > 0)
    service.focusChart(eth.instId, 2)
    service.activateChartViewport(eth, '1H', end)
    service.requestStatistics(eth, '1H', end)
    await waitFor(() => staleAborts > 0 && freshRequests === 2 && !service.statistics.has(service.statisticsKey(btc, '1H', end)) && service.statisticsState(eth, '1H', end).status === 'ready')
    assert.equal(service.statistics.has(service.statisticsKey(btc, '1H', end)), false)
    assert.equal(service.statisticsState(eth, '1H', end).status, 'ready')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a raw rebuild never overwrites direct timeframe OI or taker statistics', async () => {
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

test('a partial derived parquet range cannot make a complete raw hourly chart stutter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = 'BTC-USDT-SWAP'
  const end = Date.UTC(2024, 7, 8)
  const first = end - 95 * hour
  const raw = Array.from({ length: 96 * 12 }, (_, index) => rawCandle(first + index * fiveMinutes, 100 + index / 100))
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    await store.appendCandles([...raw, { ...rawCandle(end, 200), timeframe: '1H' }])
    const chart = await service.bars(instrument, '1H', end, { hydrate: false, repair: false, statistics: false })
    const visible = chart.bars.filter((bar: any) => bar.hour >= first && bar.hour <= end)
    assert.equal(visible.length, 96)
    assert.equal(visible[0]?.hour, first)
    assert.equal(visible.at(-1)?.hour, end)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('OI/Taker hydration rebuilds a partial hourly Parquet window from complete raw candles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 7, 9)
  const first = end - 95 * hour
  const timestamps = Array.from({ length: 96 }, (_, index) => first + index * hour)
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
    }
    if (path.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const raw = Array.from({ length: 96 * 12 }, (_, index) => rawCandle(first + index * fiveMinutes, 100 + index / 100))
    // Simulate an interrupted derived rebuild: raw coverage is intact while
    // Parquet has just one direct 1H row for the visible window.
    await store.appendCandles([...raw, { ...rawCandle(end, 200), timeframe: '1H' }])
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const initial = await service.bars(instrument.instId, '1H', end, { hydrate: false, repair: false, foreground: true, focusToken: 1 })
    assert.equal(initial.bars.filter((bar: any) => bar.hour >= first && bar.hour <= end).length, 96)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'ready')
    const direct = await store.candles({ instrument: instrument.instId, timeframe: '1H', from: first, through: end })
    assert.equal(direct.length, 96)
    assert.ok(direct.every((bar: any) => bar.oi !== null && bar.buy !== null && bar.sell !== null))
    const hydrated = await service.bars(instrument.instId, '1H', end, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 1 })
    const missing = hydrated.bars.filter((bar: any) => bar.hour >= first && bar.hour <= end && (bar.oi === null || bar.buy === null || bar.sell === null)).map((bar: any) => bar.hour)
    assert.equal(hydrated.bars.find((bar: any) => bar.hour === first)?.oi, direct[0]?.oi)
    assert.deepEqual(missing, [])
    assert.equal(oiCalls, 1)
    assert.equal(takerCalls, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('persisted historical OI/Taker is reused after A-to-B-to-A navigation without endpoint downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const firstEnd = Date.UTC(2024, 7, 1, 12)
  const secondEnd = firstEnd + 200 * hour
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    const end = Number(url.searchParams.get('end')) - hour
    const timestamps = Array.from({ length: 96 }, (_, index) => end - (95 - index) * hour)
    if (url.pathname.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
    }
    if (url.pathname.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(timestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    }
    throw new Error(`Unexpected ${url}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  const show = async (end: number, token: number) => {
    service.focusChart(instrument.instId, token)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'ready')
  }
  try {
    const hourlyRows = [firstEnd, secondEnd].flatMap(end => Array.from({ length: 96 }, (_, index) => ({ ...rawCandle(end - (95 - index) * hour), timeframe: '1H' })))
    await store.appendCandles(hourlyRows)
    await show(firstEnd, 1)
    await show(secondEnd, 2)
    await show(firstEnd, 3)
    assert.equal(oiCalls, 2)
    assert.equal(takerCalls, 2)

    // Even if an in-memory state is evicted (or after an app restart), the
    // completed Parquet window itself is authoritative and prevents a fetch.
    service.statistics.delete(service.statisticsKey(instrument, '1H', firstEnd))
    service.requestStatistics(instrument, '1H', firstEnd)
    await waitFor(() => service.statisticsState(instrument, '1H', firstEnd).status === 'ready')
    assert.equal(oiCalls, 2)
    assert.equal(takerCalls, 2)
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
      // Advance this isolated retry state without waiting through the shared
      // one-second global cool-off on every test iteration.
      headerless.rateLimitedUntil = 0
    }
    const state = headerless.latestCandleRetryState(instrument)
    assert.equal(headerlessCalls, 5)
    assert.equal(state.status, 'unavailable')
    assert.ok(delays[0] >= 900 && delays[1] >= 2_900 && delays[2] >= 9_900 && delays[3] >= 29_900)
  } finally { await directed.dispose(); await headerless.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an explicit statistics Retry-After remains observable across a foreground viewport change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 8, 1)
  let requests = 0
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async input => {
    const path = new URL(String(input)).pathname
    if (!path.includes('/rubik/stat/')) throw new Error(`Unexpected ${path}`)
    requests += 1
    return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
  }, false)
  try {
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'retrying')
    const retryAt = service.statisticsState(instrument, '1H', end).retryAt
    assert.ok((retryAt ?? 0) - Date.now() >= 59_000)

    service.focusChart(instrument.instId, 2)
    service.activateChartViewport(instrument, '1H', end)
    const state = service.requestStatistics(instrument, '1H', end)
    assert.equal(state.status, 'retrying')
    assert.equal(state.retryAt, retryAt)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(requests, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an explicit missing-candle Retry-After remains observable across a foreground viewport change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 8, 10)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let requests = 0
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), async input => {
    const path = new URL(String(input)).pathname
    if (!path.endsWith('/market/history-candles')) throw new Error(`Unexpected ${path}`)
    requests += 1
    return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
  }, false)
  try {
    await store.appendCandles(Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap))
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '5m', target)
    await service.ensureChartRange(instrument, '5m', target, 1)
    await waitFor(() => service.candleRepairState(instrument.instId).status === 'retrying')
    const retryAt = service.candleRepairState(instrument.instId).retryAt
    assert.ok((retryAt ?? 0) - Date.now() >= 59_000)

    service.focusChart(instrument.instId, 2)
    service.activateChartViewport(instrument, '5m', target)
    const availability = await service.ensureChartRange(instrument, '5m', target, 2)
    assert.equal(availability.candleState, 'retrying')
    assert.equal(availability.candleRetryAt, retryAt)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(requests, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
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

test('a hung missing-candle page times out, schedules retry, and frees the foreground queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 8, 15)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let historyCalls = 0, foregroundCalls = 0
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/market/history-candles')) {
      historyCalls += 1
      return new Promise<Response>(() => {})
    }
    if (path.endsWith('/foreground')) { foregroundCalls += 1; return response([]) }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 25 })
  try {
    await store.appendCandles(Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap))
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '5m', target)
    await service.ensureChartRange(instrument, '5m', target, 1)
    await waitFor(() => historyCalls === 1)
    await waitFor(() => {
      const state = service.candleRepairState(instrument.instId)
      const range = state.ranges.find((value: any) => value.from <= gap && value.through >= gap)
      return range?.status === 'retrying' && (range.retryAt ?? 0) > Date.now()
    })
    await service.get('/foreground', {})
    assert.equal(foregroundCalls, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a same-instrument history viewport aborts a hanging latest request without reviving it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 8, 20)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let latestCalls = 0, latestAborts = 0, historyCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/market/candles')) {
      latestCalls += 1
      if (latestCalls === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        latestAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
      return response([okxCandle(rawCandle(target + fiveMinutes, 250))])
    }
    if (path.endsWith('/market/history-candles')) {
      historyCalls += 1
      return response([okxCandle(rawCandle(gap, 300))])
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap))
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const latest = service.bars(instrument.instId, '5m', undefined, { foreground: true, focusToken: 1, statistics: false })
    await waitFor(() => latestCalls === 1)

    service.focusChart(instrument.instId, 2)
    const history = await service.bars(instrument.instId, '5m', target, { hydrate: false, statistics: false, foreground: true, focusToken: 2 })
    assert.equal(history.stale, undefined)
    await waitFor(async () => latestAborts === 1 && historyCalls === 1 && (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: gap, through: gap })).length === 1)
    await latest
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(latestCalls, 1, 'The aborted latest request must not revive while history owns the viewport.')

    service.focusChart(instrument.instId, 3)
    await service.bars(instrument.instId, '5m', undefined, { foreground: true, focusToken: 3, statistics: false })
    assert.equal(latestCalls, 2)
    assert.equal(service.activeChartViewport?.latest, true)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('OI/Taker starts when the visible hourly window is complete despite an EMA warm-up gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 9, 15, 12)
  const sourceFrom = end - (95 + 199) * hour
  const sourceThrough = end + hour - fiveMinutes
  const warmupGap = end - 150 * hour
  const visibleTimestamps = Array.from({ length: 96 }, (_, index) => end - (95 - index) * hour)
  let oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/market/history-candles')) return response([])
    if (path.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
    }
    if (path.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const source = []
    for (let timestamp = sourceFrom; timestamp <= sourceThrough; timestamp += fiveMinutes) if (timestamp !== warmupGap) source.push(rawCandle(timestamp))
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const chart = await service.bars(instrument.instId, '1H', end, { hydrate: false, foreground: true, focusToken: 1 })
    assert.notEqual(chart.candleState, 'ready', 'The warm-up gap must still keep indicator repair active.')
    await waitFor(() => oiCalls === 1 && takerCalls === 1)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'ready')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a hung EMA warm-up repair never delays or interrupts visible OI/Taker hydration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 9, 18, 12)
  const sourceFrom = end - (95 + 199) * hour
  const sourceThrough = end + hour - fiveMinutes
  const warmupGap = end - 150 * hour
  const visibleTimestamps = Array.from({ length: 96 }, (_, index) => end - (95 - index) * hour)
  let warmupCalls = 0, warmupAborts = 0, oiCalls = 0, oiAborts = 0, takerCalls = 0, releaseOI: (() => void) | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/market/history-candles')) {
      warmupCalls += 1
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        warmupAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
    }
    if (path.endsWith('/open-interest-history')) {
      oiCalls += 1
      return new Promise<Response>((resolve, reject) => {
        releaseOI = () => resolve(response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0'])))
        init?.signal?.addEventListener('abort', () => { oiAborts += 1; reject(new DOMException('The request was aborted.', 'AbortError')) }, { once: true })
      })
    }
    if (path.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 5_000 })
  try {
    const source = []
    for (let timestamp = sourceFrom; timestamp <= sourceThrough; timestamp += fiveMinutes) if (timestamp !== warmupGap) source.push(rawCandle(timestamp))
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    await service.ensureChartRange(instrument, '1H', end, 1)
    await waitFor(() => warmupCalls === 1)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => oiCalls === 1 && releaseOI !== undefined)
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal(oiAborts, 0, 'The next warm-up retry stays below the active statistics request.')
    assert.ok(warmupCalls >= 1)
    assert.ok(warmupAborts >= 1, 'Statistics may preempt warm-up work, never the other way around.')
    releaseOI?.()
    await waitFor(() => takerCalls === 1 && service.statisticsState(instrument, '1H', end).status === 'ready')
    assert.equal(oiCalls, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a crossing repair releases OI/Taker as soon as its visible segment is complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 9, 19, 12)
  const sourceFrom = end - (95 + 199) * hour
  const sourceThrough = end + hour - fiveMinutes
  const visibleFrom = end - 95 * hour
  const gapFrom = visibleFrom - 2 * fiveMinutes
  const gapThrough = visibleFrom + 2 * fiveMinutes
  const visibleTimestamps = Array.from({ length: 96 }, (_, index) => end - (95 - index) * hour)
  let visibleRepairCalls = 0, warmupCalls = 0, warmupAborts = 0, oiCalls = 0, takerCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), path = url.pathname
    if (path.endsWith('/market/history-candles')) {
      const cursor = Number(url.searchParams.get('after'))
      if (cursor === gapThrough + fiveMinutes) {
        visibleRepairCalls += 1
        return response([visibleFrom, visibleFrom + fiveMinutes, visibleFrom + 2 * fiveMinutes].map(timestamp => okxCandle(rawCandle(timestamp, 300))))
      }
      if (cursor === visibleFrom) {
        warmupCalls += 1
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
          warmupAborts += 1
          reject(new DOMException('The request was aborted.', 'AbortError'))
        }, { once: true }))
      }
      throw new Error(`Unexpected history cursor ${cursor}`)
    }
    if (path.endsWith('/open-interest-history')) {
      oiCalls += 1
      return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
    }
    if (path.endsWith('/taker-volume-contract')) {
      takerCalls += 1
      return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 5_000 })
  try {
    const source = []
    for (let timestamp = sourceFrom; timestamp <= sourceThrough; timestamp += fiveMinutes) {
      if (timestamp < gapFrom || timestamp > gapThrough) source.push(rawCandle(timestamp))
    }
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const chart = await service.bars(instrument.instId, '1H', end, { hydrate: false, foreground: true, focusToken: 1 })
    assert.equal(chart.candleState, 'loading')
    await waitFor(() => visibleRepairCalls === 1 && oiCalls === 1 && takerCalls === 1)
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'ready')
    assert.ok(warmupCalls <= 1)
    assert.ok(warmupAborts <= 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('one-candle viewport scroll repartitions an old warm-up repair at the new visible boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const oldEnd = Date.UTC(2024, 9, 22, 12)
  const newEnd = oldEnd - hour
  const newVisibleFrom = newEnd - 95 * hour
  const gapFrom = newVisibleFrom - fiveMinutes
  const gapThrough = newVisibleFrom + fiveMinutes
  const sourceFrom = newEnd - (95 + 199) * hour
  const sourceThrough = oldEnd + hour - fiveMinutes
  const visibleTimestamps = Array.from({ length: 96 }, (_, index) => newEnd - (95 - index) * hour)
  let historyCalls = 0, oldAborts = 0
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/market/history-candles')) {
      historyCalls += 1
      if (historyCalls === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        oldAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
      if (historyCalls === 2) return response([newVisibleFrom, newVisibleFrom + fiveMinutes].map(timestamp => okxCandle(rawCandle(timestamp, 350))))
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The request was aborted.', 'AbortError')), { once: true }))
    }
    if (path.endsWith('/open-interest-history')) return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(1_000 + index), '0', '0']))
    if (path.endsWith('/taker-volume-contract')) return response(visibleTimestamps.map((timestamp, index) => [String(timestamp), String(10 + index), String(20 + index)]))
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 5_000 })
  const crossesVisibleBoundary = (range: { from: number; through: number }) => range.from < newVisibleFrom && range.through >= newVisibleFrom
  try {
    const source = []
    for (let timestamp = sourceFrom; timestamp <= sourceThrough; timestamp += fiveMinutes) {
      if (timestamp < gapFrom || timestamp > gapThrough) source.push(rawCandle(timestamp))
    }
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', oldEnd)
    await service.ensureChartRange(instrument, '1H', oldEnd, 1)
    await waitFor(() => historyCalls === 1)

    service.focusChart(instrument.instId, 2)
    service.activateChartViewport(instrument, '1H', newEnd)
    assert.equal(service.candleRepairState(instrument.instId).ranges.some(crossesVisibleBoundary), false)
    await service.ensureChartRange(instrument, '1H', newEnd, 2)
    await waitFor(async () => oldAborts === 1 && historyCalls >= 2
      && (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: newVisibleFrom, through: newVisibleFrom + fiveMinutes })).length === 2)
    assert.equal(service.candleRepairState(instrument.instId).ranges.some(crossesVisibleBoundary), false)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a visible gap repair preempts a hung OI request instead of waiting for its request deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 9, 20, 12)
  const sourceFrom = end - (95 + 199) * hour
  const sourceThrough = end + hour - fiveMinutes
  const visibleGap = end - 20 * hour
  let oiStarted = 0, oiAborts = 0, takerStarted = 0, historyCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/open-interest-history')) {
      oiStarted += 1
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        oiAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
    }
    if (path.endsWith('/taker-volume-contract')) { takerStarted += 1; return response([]) }
    if (path.endsWith('/market/history-candles')) {
      historyCalls += 1
      return response([okxCandle(rawCandle(visibleGap, 300))])
    }
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 10_000 })
  try {
    const source = []
    for (let timestamp = sourceFrom; timestamp <= sourceThrough; timestamp += fiveMinutes) if (timestamp !== visibleGap) source.push(rawCandle(timestamp))
    await service.persistCandles(instrument.instId, source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => oiStarted === 1)

    await service.ensureChartRange(instrument, '1H', end, 1)
    await waitFor(async () => oiAborts === 1 && historyCalls === 1
      && (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: visibleGap, through: visibleGap })).length === 1)
    assert.equal(takerStarted, 0, 'The paired statistics request is cancelled with its preempted OI request.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a newer same-instrument viewport cannot be retaken by a delayed older request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const oldEnd = Date.UTC(2024, 8, 1), newEnd = oldEnd - hour
  const originalCandles = store.candles.bind(store)
  let candlesStarted = false, candlesCalls = 0, releaseCandles: (() => void) | undefined
  const candlesGate = new Promise<void>(resolve => { releaseCandles = resolve })
  store.candles = async (...arguments_) => {
    candlesCalls += 1
    if (!candlesStarted) {
      candlesStarted = true
      await candlesGate
    }
    return originalCandles(...arguments_)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const oldRequest = service.bars(instrument.instId, '1H', oldEnd, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 1 })
    await waitFor(() => candlesStarted)
    service.focusChart(instrument.instId, 2)
    await service.bars(instrument.instId, '1H', newEnd, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 2 })
    releaseCandles?.()
    const old = await oldRequest
    assert.equal(old.stale, true)
    assert.equal(candlesCalls, 4, 'The stale and current viewports each read their 5m source and direct rows once.')
    assert.equal(service.activeChartViewport.end, newEnd)
  } finally { releaseCandles?.(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a focus transition does not revive a same-instrument repair before its next viewport activates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const target = Date.UTC(2024, 10, 1)
  const from = target - (95 + 199) * fiveMinutes
  const gap = target - 20 * fiveMinutes
  let calls = 0, aborts = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      aborts += 1
      reject(new DOMException('The request was aborted.', 'AbortError'))
    }, { once: true }))
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(Array.from({ length: 295 }, (_, index) => rawCandle(from + index * fiveMinutes)).filter(value => value.timestamp !== gap))
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '5m', target)
    await service.ensureChartRange(instrument, '5m', target, 1)
    await waitFor(() => calls === 1)
    service.focusChart(instrument.instId, 2)
    await waitFor(() => aborts === 1 && !service.candleRepairState(instrument.instId).running)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(calls, 1)
    assert.equal(service.activeChartViewport, null)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a same-instrument viewport change parks an old repair instead of restarting it ahead of the new gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const oldEnd = Date.UTC(2024, 10, 10)
  const newEnd = oldEnd - 400 * fiveMinutes
  const oldFrom = oldEnd - (95 + 199) * fiveMinutes
  const newFrom = newEnd - (95 + 199) * fiveMinutes
  const oldGap = oldEnd - 20 * fiveMinutes
  const newGap = newEnd - 20 * fiveMinutes
  let oldCalls = 0, oldAborts = 0, newCalls = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith('/market/history-candles')) throw new Error(`Unexpected ${url.pathname}`)
    const cursor = Number(url.searchParams.get('after'))
    if (cursor === oldGap + fiveMinutes) {
      oldCalls += 1
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        oldAborts += 1
        reject(new DOMException('The request was aborted.', 'AbortError'))
      }, { once: true }))
    }
    if (cursor === newGap + fiveMinutes) { newCalls += 1; return response([okxCandle(rawCandle(newGap, 400))]) }
    throw new Error(`Unexpected history cursor ${cursor}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    const source = [
      ...Array.from({ length: 295 }, (_, index) => rawCandle(oldFrom + index * fiveMinutes)).filter(value => value.timestamp !== oldGap),
      ...Array.from({ length: 295 }, (_, index) => rawCandle(newFrom + index * fiveMinutes)).filter(value => value.timestamp !== newGap),
    ]
    await store.appendCandles(source)
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '5m', oldEnd)
    await service.ensureChartRange(instrument, '5m', oldEnd, 1)
    await waitFor(() => oldCalls === 1)

    service.focusChart(instrument.instId, 2)
    service.activateChartViewport(instrument, '5m', newEnd)
    await service.ensureChartRange(instrument, '5m', newEnd, 2)
    await waitFor(async () => oldAborts === 1 && newCalls === 1
      && (await store.candles({ instrument: instrument.instId, timeframe: '5m', from: newGap, through: newGap })).length === 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(oldCalls, 1, 'The parked old gap must not reclaim the request lane after its abort.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an OI failure cancels the queued taker request before retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }
  const end = Date.UTC(2024, 9, 1)
  let rejectOI: ((reason?: unknown) => void) | undefined, takerStarted = false
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/open-interest-history')) return new Promise<Response>((_resolve, reject) => { rejectOI = reject })
    if (path.endsWith('/taker-volume-contract')) return new Promise<Response>((_resolve, reject) => {
      takerStarted = true
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The request was aborted.', 'AbortError')), { once: true })
    })
    throw new Error(`Unexpected ${path}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    service.focusChart(instrument.instId, 1)
    service.activateChartViewport(instrument, '1H', end)
    service.requestStatistics(instrument, '1H', end)
    await waitFor(() => rejectOI !== undefined)
    rejectOI?.(new Error('OI failed'))
    await waitFor(() => service.statisticsState(instrument, '1H', end).status === 'retrying')
    assert.equal(takerStarted, false)
    assert.equal(service.statisticsState(instrument, '1H', end).status, 'retrying')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

// The market list must be a projection of the cache, not a catalogue-shaped
// placeholder which only acquires readings after a user opens a chart.
const listFixtureInstrument = { instId: 'BTC-USDT-SWAP', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }
const completeListEnd = (rawLast: number, interval: number) => {
  const bucket = Math.floor(rawLast / interval) * interval
  return rawLast >= bucket + interval - fiveMinutes ? bucket : bucket - interval
}

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
  // Keep the newest raw observation fresh. This means list warm-up verifies
  // the cache rather than replacing this deterministic fixture over HTTP.
  const rawLast = Math.floor((Date.now() - fiveMinutes) / fiveMinutes) * fiveMinutes
  const oneHourEnd = completeListEnd(rawLast, hour)
  const start = oneHourEnd - 200 * hour
  const closeAt = (timestamp: number) => 100 + (timestamp - start) / fiveMinutes * 0.05
  const raw = []
  for (let timestamp = start; timestamp <= rawLast; timestamp += fiveMinutes) raw.push(rawCandle(timestamp, closeAt(timestamp)))
  await store.appendCandles(raw)

  const ends: Record<string, number> = {}
  for (const [timeframe, interval, base] of [['5m', fiveMinutes, 1_000], ['15m', 3 * fiveMinutes, 2_000], ['1H', hour, 3_000]] as const) {
    const end = completeListEnd(rawLast, interval)
    ends[timeframe] = end
    const statistics = Array.from({ length: 96 }, (_, index) => {
      const timestamp = end - (95 - index) * interval
      return {
        ...rawCandle(timestamp, closeAt(timestamp)), timeframe,
        oi: base + index * 11,
        sell: base + index,
        buy: base + 200 + index,
        statisticsVersion: 1,
      }
    })
    await store.appendCandles(statistics)
  }
  return { rawLast, start, ends, closeAt }
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
    assert.ok(Number.isFinite(row.filterMetrics.ema200))
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
    assert.equal(row.filterMetrics.liveClose, fixture.closeAt(fixture.ends['1H'] + hour - fiveMinutes))
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
    const originalCoverage = store.coverage.bind(store)
    const cacheProjectionGate = new Promise<void>(resolve => { releaseCacheProjection = resolve })
    let cacheProjectionStarted = false
    store.coverage = async (...arguments_) => {
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
  const originalCoverage = store.coverage.bind(store)
  let releaseProjection: (() => void) | undefined, projectionStarted = false, coverageCalls = 0
  const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve })
  store.coverage = async (...arguments_) => {
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
    const expectedFifteenEnd = completeListEnd((await store.coverage(listFixtureInstrument.instId, '5m')).last!, 3 * fiveMinutes)
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
    const discovery = url.pathname.endsWith('/market/candles') && url.searchParams.get('bar') === '5m' ? null : liquidCatalogueResponse(url)
    if (discovery) return discovery
    if (url.pathname.endsWith('/market/candles')) {
      candleRequests += 1
      return new Response('temporarily unavailable', { status: 503 })
    }
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
    const discovery = url.pathname.endsWith('/market/candles') && url.searchParams.get('bar') === '5m' ? null : liquidCatalogueResponse(url)
    if (discovery) return discovery
    if (url.pathname.endsWith('/market/candles')) {
      candleRequests += 1
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } })
    }
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

test('list history repair remains runnable behind another chart and records an unavailable history boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const instrument = { ...listFixtureInstrument }
  const now = Math.floor((Date.now() - fiveMinutes) / fiveMinutes) * fiveMinutes
  const raw = Array.from({ length: 300 }, (_, index) => rawCandle(now - (299 - index) * fiveMinutes, 100 + index / 100))
  let historyRequests = 0
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/history-candles')) { historyRequests += 1; return response([]) }
    throw new Error(`Unexpected ${url.pathname}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false)
  try {
    await store.appendCandles(raw)
    service.replaceCatalog([{ instrument, ticker: { instId: instrument.instId, last: '103', open24h: '100', low24h: '90', high24h: '110' }, result: { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 }, change24h: 3 }])
    service.hasCompleteStoredStatistics = async () => true
    assert.equal(service.focusChart('ETH-USDT-SWAP', 1), true)
    const entry = service.catalogEntry(instrument.instId), state = service.listWarmupState(instrument.instId, '1H')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.warmListEntry(entry, '1H', state, new AbortController().signal)
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
    }
    assert.equal(historyRequests, 3, 'The background repair is allowed even while an unrelated chart owns focus.')
    assert.equal(service.historyBoundaries.get(instrument.instId), raw[0].timestamp)
    assert.equal(state.status, 'ready')
    await service.warmListEntry(entry, '1H', state, new AbortController().signal)
    assert.equal(historyRequests, 3, 'The known listing boundary prevents an endless missing-history retry loop.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a foreground chart hydration preempts a hung background list warm-up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  let candleRequests = 0, backgroundAborts = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const discovery = url.pathname.endsWith('/market/candles') && url.searchParams.get('bar') === '5m' ? null : liquidCatalogueResponse(url)
    if (discovery) return discovery
    if (url.pathname.endsWith('/market/candles')) {
      candleRequests += 1
      if (candleRequests === 1) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          backgroundAborts += 1
          reject(new DOMException('The request was aborted.', 'AbortError'))
        }, { once: true })
      })
      const end = Math.floor((Date.now() - fiveMinutes) / fiveMinutes) * fiveMinutes
      return response(Array.from({ length: 300 }, (_, index) => okxCandle(rawCandle(end - (299 - index) * fiveMinutes, 100 + index / 10))))
    }
    throw new Error(`Unexpected ${url.pathname}`)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: 5_000 })
  try {
    await service.refresh()
    await waitFor(() => candleRequests === 1)
    assert.equal(service.focusChart(listFixtureInstrument.instId, 1), true)
    const chart = await Promise.race([
      service.bars(listFixtureInstrument.instId, '5m', undefined, { repair: false, statistics: false, foreground: true, focusToken: 1 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Foreground hydration was blocked by the background list request.')), 1_500)),
    ])
    assert.equal(backgroundAborts, 1)
    assert.ok(candleRequests >= 2)
    assert.ok(chart.bars.length > 0)
    await waitFor(() => service.listWarmupState(listFixtureInstrument.instId, '1H').status === 'retrying')
    assert.ok((service.listWarmupState(listFixtureInstrument.instId, '1H').retryAt ?? 0) > Date.now(), 'A foreground cancellation defers the background list work instead of immediately requeueing it.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
