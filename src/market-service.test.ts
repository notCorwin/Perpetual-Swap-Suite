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
    const snapshot = service.snapshot()
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
    const oi = calls.find(call => call.pathname.endsWith('/open-interest-history'))!
    const taker = calls.find(call => call.pathname.endsWith('/taker-volume-contract'))!
    assert.equal(oi.searchParams.get('period'), '1H')
    assert.equal(oi.searchParams.get('end'), String(end + hour))
    assert.equal(taker.searchParams.get('period'), '1H')
    assert.equal(taker.searchParams.get('unit'), '1')
    assert.equal(taker.searchParams.get('end'), String(end + hour))
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
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
    service.chartResults.set('cached', [])
    const revision = service.revision
    service.lastCandleHydration.delete(instrument.instId)
    await service.hydrate(instrument)
    const second = await service.bars(instrument.instId, '5m')
    assert.equal(service.liveCandles.get(instrument.instId)?.close, 102)
    assert.equal(second.bars.at(-1)?.close, 102)
    assert.equal(service.chartResults.has('cached'), false)
    assert.ok(service.revision > revision)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
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
    if (coverageCalls === 2) await coverageGate
    return originalCoverage(...arguments_)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    const bars = service.bars('BTC-USDT-SWAP', '5m', undefined, { hydrate: false, repair: false, statistics: false })
    await waitFor(() => coverageCalls === 2)
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
    await store.appendCandles([{ ...rawCandle(start, 100), timeframe: '1H', oi: 9_999, buy: 8_888, sell: 7_777 }])
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
  const originalCoverage = store.coverage.bind(store)
  let coverageStarted = false, coverageCalls = 0, releaseCoverage: (() => void) | undefined
  const coverageGate = new Promise<void>(resolve => { releaseCoverage = resolve })
  store.coverage = async (...arguments_) => {
    coverageCalls += 1
    if (!coverageStarted) {
      coverageStarted = true
      await coverageGate
    }
    return originalCoverage(...arguments_)
  }
  const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetch, false)
  try {
    service.instruments.set(instrument.instId, instrument)
    service.focusChart(instrument.instId, 1)
    const oldRequest = service.bars(instrument.instId, '1H', oldEnd, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 1 })
    await waitFor(() => coverageStarted)
    service.focusChart(instrument.instId, 2)
    await service.bars(instrument.instId, '1H', newEnd, { hydrate: false, repair: false, statistics: false, foreground: true, focusToken: 2 })
    releaseCoverage?.()
    const old = await oldRequest
    assert.equal(old.stale, true)
    assert.equal(coverageCalls, 3, 'The stale window stops after its first coverage read; the current viewport needs two.')
    assert.equal(service.activeChartViewport.end, newEnd)
  } finally { releaseCoverage?.(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
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
