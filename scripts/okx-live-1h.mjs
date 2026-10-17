import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketService } from '../electron/services/market-service.js'
import { MarketStore } from '../electron/services/market-store.js'

const INSTRUMENT_ID = 'BTC-USDT-SWAP'
const TIMEFRAME = '1H'
const HOUR = 3_600_000
const VISIBLE_CANDLES = 96
const timeoutFromEnvironment = Number(process.env.OKX_LIVE_TIMEOUT_MS)
const TEST_TIMEOUT = Number.isFinite(timeoutFromEnvironment) && timeoutFromEnvironment >= 10_000 ? timeoutFromEnvironment : 45_000
const REQUEST_TIMEOUT = 12_000

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function requestURL(input) {
  if (input instanceof Request) return new URL(input.url)
  return new URL(String(input))
}

function requestSummary(requests) {
  return requests.map(request => {
    const search = request.url.searchParams.toString()
    const status = request.status === null ? `error=${request.error}` : `status=${request.status}`
    return `${request.url.pathname}${search ? `?${search}` : ''} ${status} ${request.elapsedMS}ms`
  }).join('\n') || 'No OKX request was observed.'
}

function visibleWindow(result) {
  const completed = result.bars.filter(bar => bar.confirmed)
  const end = completed.at(-1)?.hour ?? null
  if (!Number.isFinite(end)) return { end: null, bars: [] }
  const first = end - (VISIBLE_CANDLES - 1) * HOUR
  return { end, bars: completed.filter(bar => bar.hour >= first && bar.hour <= end) }
}

function isCompleteHourlyWindow(window) {
  return window.end !== null
    && window.bars.length === VISIBLE_CANDLES
    && window.bars.every((bar, index) => bar.confirmed && bar.hour === window.end - (VISIBLE_CANDLES - 1 - index) * HOUR)
}

function hasStatistics(window) {
  return window.bars.every(bar => Number.isFinite(bar.oi) && Number.isFinite(bar.buy) && Number.isFinite(bar.sell))
}

function fixedWindow(result, end) {
  const first = end - (VISIBLE_CANDLES - 1) * HOUR
  return { end, bars: result.bars.filter(bar => bar.confirmed && bar.hour >= first && bar.hour <= end) }
}

async function waitForChart(service, focusToken) {
  const deadline = Date.now() + TEST_TIMEOUT
  let last = null
  while (Date.now() < deadline) {
    const result = await service.bars(INSTRUMENT_ID, TIMEFRAME, undefined, {
      hydrate: true,
      repair: true,
      statistics: true,
      foreground: true,
      focusToken,
    })
    const window = visibleWindow(result)
    last = { result, window }
    if (isCompleteHourlyWindow(window) && result.candleState === 'ready' && result.statisticsState === 'ready' && hasStatistics(window)) return last
    await sleep(125)
  }
  const state = last
    ? `candleState=${last.result.candleState}, statisticsState=${last.result.statisticsState}, visible=${last.window.bars.length}`
    : 'the service did not return a chart result'
  throw new Error(`Timed out after ${TEST_TIMEOUT}ms waiting for a complete ${TIMEFRAME} BTC chart (${state}).`)
}

const root = await mkdtemp(join(tmpdir(), 'perp-radar-okx-live-1h-'))
const store = await MarketStore.open(root)
const requests = []
const fetcher = async (input, init) => {
  const url = requestURL(input)
  const startedAt = Date.now()
  try {
    const response = await fetch(input, init)
    requests.push({ url, status: response.status, error: null, elapsedMS: Date.now() - startedAt })
    return response
  } catch (error) {
    requests.push({ url, status: null, error: error instanceof Error ? error.message : String(error), elapsedMS: Date.now() - startedAt })
    throw error
  }
}
const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher, false, { requestTimeout: REQUEST_TIMEOUT })

try {
  // The public candle/statistics endpoints only need the instrument identity.
  // Keeping this test at the service boundary avoids a cached catalogue or a
  // synthetic transport hiding an incorrect native-timeframe request.
  const instrument = { instId: INSTRUMENT_ID }
  service.instruments.set(INSTRUMENT_ID, instrument)
  const focusToken = 1
  assert.equal(service.focusChart(INSTRUMENT_ID, focusToken), true)

  const { window } = await waitForChart(service, focusToken)
  assert.ok(isCompleteHourlyWindow(window), 'The visible 1H chart must contain exactly 96 contiguous confirmed candles.')
  assert.ok(hasStatistics(window), 'Every visible 1H candle must have direct OI, buy, and sell contract data.')

  const candleRequests = requests.filter(request => /\/market\/(?:candles|history-candles)$/.test(request.url.pathname))
  const oiRequests = requests.filter(request => request.url.pathname.endsWith('/rubik/stat/contracts/open-interest-history'))
  const takerRequests = requests.filter(request => request.url.pathname.endsWith('/rubik/stat/taker-volume-contract'))

  assert.ok(candleRequests.some(request => request.url.searchParams.get('bar') === TIMEFRAME), `Expected an OKX candle request with bar=${TIMEFRAME}.\n${requestSummary(requests)}`)
  assert.ok(candleRequests.every(request => request.url.searchParams.get('bar') === TIMEFRAME), `All chart candle requests must stay native ${TIMEFRAME}.\n${requestSummary(candleRequests)}`)
  assert.ok(oiRequests.length > 0, `Expected an OKX open-interest request.\n${requestSummary(requests)}`)
  assert.ok(oiRequests.every(request => request.url.searchParams.get('period') === TIMEFRAME), `Open-interest requests must use period=${TIMEFRAME}.\n${requestSummary(oiRequests)}`)
  assert.ok(takerRequests.length > 0, `Expected an OKX taker-volume request.\n${requestSummary(requests)}`)
  assert.ok(takerRequests.every(request => request.url.searchParams.get('period') === TIMEFRAME && request.url.searchParams.get('unit') === '1'), `Taker requests must use period=${TIMEFRAME} and unit=1.\n${requestSummary(takerRequests)}`)
  assert.equal(requests.some(request => request.status === 429), false, `OKX rate limited the live 1H integration test.\n${requestSummary(requests)}`)

  // Match the renderer's maximum one-frame wheel geometry: 144px at
  // 12px/candle moves the chart 12 one-hour periods. Return immediately,
  // before the neighboring source page has any reason to settle. The chart
  // must keep the original page resident instead of aborting and downloading
  // it again (the root cause of the visible scroll-back gap).
  const sourceCursor = window.end + HOUR
  const scrolledEnd = window.end - 12 * HOUR
  assert.equal(service.focusChart(INSTRUMENT_ID, 2), true)
  const scrolled = await service.bars(INSTRUMENT_ID, TIMEFRAME, scrolledEnd, {
    hydrate: false,
    repair: false,
    statistics: true,
    foreground: true,
    focusToken: 2,
  })
  assert.ok(isCompleteHourlyWindow(fixedWindow(scrolled, scrolledEnd)), 'The 12-candle historical viewport must retain 96 native 1H candles immediately.')
  assert.equal(service.focusChart(INSTRUMENT_ID, 3), true)
  const returned = await service.bars(INSTRUMENT_ID, TIMEFRAME, window.end, {
    hydrate: false,
    repair: false,
    statistics: true,
    foreground: true,
    focusToken: 3,
  })
  const returnedWindow = fixedWindow(returned, window.end)
  assert.ok(isCompleteHourlyWindow(returnedWindow), 'Returning from a one-frame scroll must preserve the rendered 1H window.')
  assert.ok(hasStatistics(returnedWindow), 'Returning from a one-frame scroll must preserve OI and Taker samples without a gap.')
  // Give queued adjacent work a chance to begin. Its endpoint cursor may be
  // distinct, but the original page must remain exactly one request per
  // source throughout the round trip.
  await sleep(150)
  const originalOI = requests.filter(request => request.url.pathname.endsWith('/rubik/stat/contracts/open-interest-history') && Number(request.url.searchParams.get('end')) === sourceCursor)
  const originalTaker = requests.filter(request => request.url.pathname.endsWith('/rubik/stat/taker-volume-contract') && Number(request.url.searchParams.get('end')) === sourceCursor)
  assert.equal(originalOI.length, 1, `The original OI page was downloaded more than once after E→E−12→E.\n${requestSummary(requests)}`)
  assert.equal(originalTaker.length, 1, `The original Taker page was downloaded more than once after E→E−12→E.\n${requestSummary(requests)}`)

  console.log(JSON.stringify({
    integration: 'okx-live-1h',
    instrument: INSTRUMENT_ID,
    timeframe: TIMEFRAME,
    visibleCandles: window.bars.length,
    visibleStart: new Date(window.bars[0].hour).toISOString(),
    visibleEnd: new Date(window.end).toISOString(),
    scrollBack: {
      movedEnd: new Date(scrolledEnd).toISOString(),
      returnedRenderedCandles: returnedWindow.bars.length,
      originalOIRequests: originalOI.length,
      originalTakerRequests: originalTaker.length,
    },
    requestCount: requests.length,
    requests: requests.map(request => ({ path: request.url.pathname, status: request.status, elapsedMS: request.elapsedMS })),
  }, null, 2))
} catch (error) {
  const detail = `\nObserved OKX requests:\n${requestSummary(requests)}`
  if (error instanceof Error) error.message += detail
  throw error
} finally {
  await service.dispose()
  await store.close()
  await rm(root, { recursive: true, force: true })
}
