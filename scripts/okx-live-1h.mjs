import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketService } from '../electron/services/market-service.js'
import { MarketStore } from '../electron/services/market-store.js'

const INSTRUMENT_ID = 'BTC-USDT-SWAP'
const TIMEFRAME = '1H'
const HOUR = 3_600_000
const configuredTimeout = Number(process.env.OKX_LIVE_TIMEOUT_MS)
const TEST_TIMEOUT = Number.isFinite(configuredTimeout) && configuredTimeout >= 10_000 ? configuredTimeout : 45_000
const requests = []
const root = await mkdtemp(join(tmpdir(), 'perp-radar-okx-live-1h-'))
const store = await MarketStore.open(root)
const fetcher = async (input, options) => {
  const url = new URL(String(input)), started = Date.now()
  try {
    const response = await fetch(input, options)
    requests.push({ url, status: response.status, elapsedMS: Date.now() - started })
    return response
  } catch (error) {
    requests.push({ url, error: error.message, elapsedMS: Date.now() - started })
    throw error
  }
}
const service = new MarketService(store, undefined, fetcher, false, { requestTimeout: 12_000 })
const windowBars = (result, end) => result.bars.filter(bar => bar.hour >= end - 95 * HOUR && bar.hour <= end)
const assertPrepared = result => {
  assert.equal(result.error, '')
  assert.equal(result.unavailable, undefined)
  const bars = windowBars(result, result.endHour)
  assert.equal(bars.length, 96)
  assert.ok(bars.every((bar, index) => bar.confirmed && bar.hour === result.endHour - (95 - index) * HOUR
    && bar.statisticsObserved && bar.indicatorsObserved && bar.statisticsSources === 3))
  // The most recent closed statistics feed may legitimately lag candles.
  // Published values must be numeric; an observed null is explicitly unavailable.
  assert.equal(result.oiState, bars.every(bar => Number.isFinite(bar.oi)) ? 'ready' : 'unavailable')
  assert.equal(result.takerState, bars.every(bar => Number.isFinite(bar.buy) && Number.isFinite(bar.sell)) ? 'ready' : 'unavailable')
  return bars
}
let timeout
try {
  const initial = await Promise.race([
    service.prepareChartWindow(INSTRUMENT_ID, TIMEFRAME),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Preparation exceeded ${TEST_TIMEOUT}ms.`)), TEST_TIMEOUT) }),
  ])
  clearTimeout(timeout)
  const bars = assertPrepared(initial)
  const originalCalls = requests.length
  const returned = await service.prepareChartWindow(INSTRUMENT_ID, TIMEFRAME, initial.endHour)
  assertPrepared(returned)
  assert.equal(requests.length, originalCalls, 'Returning to a prepared window must reuse durable source pages.')
  const adjacent = await service.prepareChartWindow(INSTRUMENT_ID, TIMEFRAME, initial.endHour - 12 * HOUR)
  assertPrepared(adjacent)
  const afterAdjacent = requests.length
  assertPrepared(await service.prepareChartWindow(INSTRUMENT_ID, TIMEFRAME, initial.endHour))
  assert.equal(requests.length, afterAdjacent, 'A scroll round trip must not redownload the original page.')
  const candleRequests = requests.filter(request => /\/market\/(?:candles|history-candles)$/.test(request.url.pathname))
  assert.ok(candleRequests.length > 0)
  assert.ok(candleRequests.every(request => request.url.searchParams.get('bar') === TIMEFRAME))
  const sourceRequests = requests.filter(request => request.url.pathname.includes('/rubik/stat/'))
  assert.ok(sourceRequests.some(request => request.url.pathname.endsWith('/open-interest-history')))
  assert.ok(sourceRequests.some(request => request.url.pathname.endsWith('/taker-volume-contract')))
  assert.ok(sourceRequests.every(request => request.url.searchParams.get('period') === TIMEFRAME))
  assert.ok(sourceRequests.filter(request => request.url.pathname.endsWith('/taker-volume-contract')).every(request => request.url.searchParams.get('unit') === '1'))
  assert.equal(requests.some(request => request.status === 429), false)
  console.log(JSON.stringify({ integration: 'okx-prepared-1h', instrument: INSTRUMENT_ID, timeframe: TIMEFRAME,
    visibleCandles: bars.length, visibleStart: new Date(bars[0].hour).toISOString(), visibleEnd: new Date(initial.endHour).toISOString(),
    generation: initial.generation, oiState: initial.oiState, takerState: initial.takerState,
    requests: requests.map(request => ({ path: request.url.pathname, query: request.url.search, status: request.status, error: request.error, elapsedMS: request.elapsedMS })),
  }, null, 2))
} catch (error) {
  if (error instanceof Error) error.message += `\nObserved requests:\n${requests.map(request => `${request.url} status=${request.status ?? request.error}`).join('\n')}`
  throw error
} finally {
  clearTimeout(timeout)
  await service.dispose()
  await store.close()
  await rm(root, { recursive: true, force: true })
}
