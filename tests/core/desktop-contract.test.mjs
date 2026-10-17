import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DesktopRequestError, parseDesktopRequest } from '../../electron/desktop-contract.js'

const instId = 'BTC-USDT-SWAP'
const candle = { instrument: instId, timeframe: '5m', timestamp: 1_729_080_000_000, open: 100, high: 112, low: 99, close: 108, volume: 1234, confirmed: true }
const reject = (request, options) => assert.throws(() => parseDesktopRequest(request, options), DesktopRequestError)

test('desktop requests accept each supported operation and preserve the public payload shape', () => {
  for (const request of [
    { snapshot: { timeframe: '15m' } },
    { snapshot: { timeframe: '1H', sinceRevision: -1, serviceSession: 'collector-1' } },
    { preferences: { action: 'read' } },
    { preferences: { action: 'update', values: { chartTimeframe: '5m', rankingLookback: 15, historyDays: 30, liquidity: { spread: { enabled: true, maxPercent: .05 }, depth: { enabled: false, minUSDT: 100_000 }, slippage: { enabled: true, maxPercent: .1, notionalUSDT: 100_000 }, volume24h: { minUSDT: 30_000_000 }, openInterest: { minUSDT: 5_000_000 }, volumeStability: { maxRatio: 2, enabled: false } } } } },
    { preferences: { action: 'update', values: { liquidity: { slippage: { notionalUSDT: 200_000 } } } } },
    ...['start', 'cancel', 'status', 'repair'].map(action => ({ dataAudit: { action } })),
    { chartWindow: { instId, timeframe: '5m', endHour: 1_729_080_000_000 } },
    { chartLocal: { instId, timeframe: '15m' } },
    { chartHistory: { instId, timeframe: '5m' } },
    { chartHistory: { instId, timeframe: '1H', endHour: 1_729_080_000_000 } },
    { chartUniverse: { instIds: [instId], timeframe: '1H', focusInstId: instId } },
    { chartUniverse: { instIds: [], timeframe: '5m' } },
    { captureChart: { x: 0, y: 0, width: 80, height: 60 } },
    { captureChart: { x: 1.5, y: 2.5, width: 80.5, height: 60.5, backgroundRGB: [.1, .2, .3], output: 'png' } },
    { copyText: '' },
    { copyText: 'Chart analysis' },
    { analysisSettings: { action: 'read' } },
    { analysisSettings: { action: 'save', model: 'test-model', apiKey: 'test-key' } },
    { analysisSettings: { action: 'save', model: 'test-model', apiKey: '' } },
    { analysisSettings: { action: 'removeKey' } },
    { gatewayFetch: { id: 'request-1', body: '{"messages":[]}' } },
    { cancelGatewayFetch: 'request-1' },
  ]) assert.deepEqual(parseDesktopRequest(request), request)
})

test('mixed commands and unknown top-level or nested fields are rejected before dispatch', () => {
  let effects = 0
  const dispatch = input => { const request = parseDesktopRequest(input); effects++; return request }
  for (const request of [
    { copyText: 'text', preferences: { action: 'update', values: { historyDays: 10 } } },
    { copyText: 'text', unsupported: true },
    { snapshot: { timeframe: '5m', rocPeriod: 9 } },
    { preferences: { action: 'read', values: { historyDays: 10 } } },
    { preferences: { action: 'update', values: { historyDays: 10, arbitrary: true } } },
    { preferences: { action: 'update', values: { liquidity: { spread: { maxPercent: .1, ignored: true } } } } },
    { dataAudit: { action: 'start', range: 'all' } },
    { chartWindow: { instId, timeframe: '5m', extra: true } },
    { chartLocal: { instId, timeframe: '5m', endHour: 1 } },
    { chartHistory: { instId, timeframe: '5m', extra: true } },
    { chartUniverse: { instIds: [instId], timeframe: '5m', extra: true } },
    { captureChart: { x: 0, y: 0, width: 80, height: 60, ignored: true } },
    { analysisSettings: { action: 'read', apiKey: 'test-key' } },
    { analysisSettings: { action: 'save', model: 'test-model', apiKey: 'test-key', endpoint: 'https://example.com' } },
    { gatewayFetch: { id: 'request-1', body: '{}', url: 'https://example.com' } },
  ]) assert.throws(() => dispatch(request), DesktopRequestError)
  assert.equal(effects, 0)
})

test('retired protocol operations and appearance preferences have no accepted compatibility path', () => {
  for (const request of [
    { rocPeriod: 9, marocPeriod: 9, timeframe: '5m' },
    { webkit: {} }, { windowTint: [0, 0, 0] }, { windowTintRGB: [0, 0, 0] }, { previewWindowBlur: 10 },
    { hourlyVolumeStabilityEnabled: true },
    { preferences: { action: 'update', values: { windowBlurRadius: 10 } } },
    { preferences: { action: 'update', values: { frostedBackgroundEnabled: true } } },
  ]) reject(request)
})

test('required fields, action-specific fields, types, and numeric boundaries are validated', () => {
  for (const request of [
    null, [], '', 1, {}, new Date(),
    { snapshot: {} }, { snapshot: { timeframe: '1m' } },
    { snapshot: { timeframe: '5m', sinceRevision: -2 } }, { snapshot: { timeframe: '5m', sinceRevision: .5 } },
    { snapshot: { timeframe: '5m', serviceSession: '' } },
    { preferences: { action: 'save', values: {} } }, { preferences: { action: 'update' } },
    { preferences: { action: 'update', values: {} } },
    ...[0, -5, 7, 5.5, Infinity, '15'].map(rankingLookback => ({ preferences: { action: 'update', values: { rankingLookback } } })),
    ...[0, -1, 1.5, 3651, NaN].map(historyDays => ({ preferences: { action: 'update', values: { historyDays } } })),
    { preferences: { action: 'update', values: { liquidity: { spread: { enabled: 1 } } } } },
    ...[0, -1, Infinity, '1'].map(maxPercent => ({ preferences: { action: 'update', values: { liquidity: { spread: { maxPercent } } } } })),
    { preferences: { action: 'update', values: { liquidity: { volumeStability: { maxRatio: 1 } } } } },
    { dataAudit: { action: 'delete' } },
    { chartWindow: { instId: '', timeframe: '5m' } },
    { chartWindow: { instId, timeframe: '5m', endHour: 1.5 } },
    { chartHistory: { instId, timeframe: '5m', endHour: -1 } },
    { chartHistory: { instId, timeframe: '5m', endHour: 1.5 } },
    { chartUniverse: { instIds: [instId, null], timeframe: '5m' } },
    { chartUniverse: { instIds: Array(1001).fill(instId), timeframe: '5m' } },
    { captureChart: { x: 0, y: 0, width: 0, height: 60 } },
    { captureChart: { x: NaN, y: 0, width: 80, height: 60 } },
    { captureChart: { x: 0, y: 0, width: Infinity, height: 60 } },
    { captureChart: { x: 0, y: 0, width: 80, height: 60, output: 'jpeg' } },
    { captureChart: { x: 0, y: 0, width: 80, height: 60, backgroundRGB: [0, 0, 2] } },
    { copyText: 42 }, { copyText: null },
    { analysisSettings: { action: 'save', model: 'test-model' } },
    { analysisSettings: { action: 'save', model: '', apiKey: 'test-key' } },
    { analysisSettings: { action: 'removeKey', model: 'test-model' } },
    { gatewayFetch: { id: '', body: '{}' } }, { gatewayFetch: { id: 'request-1', body: {} } },
    { cancelGatewayFetch: '' },
  ]) reject(request)
})

test('validated requests are detached data and cannot invoke accessors or inherit operations', () => {
  let reads = 0
  const accessor = Object.defineProperty({}, 'copyText', { enumerable: true, get() { reads++; return 'text' } })
  reject(accessor)
  reject(Object.create({ copyText: 'text' }))
  reject({ copyText: 'text', [Symbol('hidden')]: true })
  reject(Object.defineProperty({ copyText: 'text' }, 'hidden', { value: true }))
  const nestedAccessor = { snapshot: Object.defineProperty({}, 'timeframe', { enumerable: true, get() { reads++; return '5m' } }) }
  reject(nestedAccessor)
  assert.equal(reads, 0)
  const sparse = Array(1)
  reject({ chartUniverse: { instIds: sparse, timeframe: '5m' } })
  const customArray = Object.assign([instId], { ignored: true })
  reject({ chartUniverse: { instIds: customArray, timeframe: '5m' } })
  const request = { chartUniverse: { instIds: [instId], timeframe: '5m' } }
  const parsed = parseDesktopRequest(request)
  request.chartUniverse.instIds.push('ETH-USDT-SWAP')
  assert.deepEqual(parsed.chartUniverse.instIds, [instId])
  const partial = { preferences: { action: 'update', values: { liquidity: { depth: { enabled: false } } } } }
  const parsedPartial = parseDesktopRequest(partial)
  partial.preferences.values.liquidity.depth.enabled = true
  assert.equal(parsedPartial.preferences.values.liquidity.depth.enabled, false)
  assert.deepEqual(parseDesktopRequest({ chartWindow: { instId, timeframe: '5m', endHour: undefined } }), { chartWindow: { instId, timeframe: '5m' } })
})

test('test-only actions require explicit boolean opt-in and retain their own strict schemas', () => {
  const actions = ['seedCachedListProjection', 'seedChartScrollBenchmark', 'seedHistoricalStatisticsBoundary', 'seedInstrumentNavigationBenchmark', 'settings', 'smokeStatus']
  for (const action of actions) {
    const request = { e2e: { action } }
    reject(request)
    reject(request, { allowE2E: 'true' })
    assert.deepEqual(parseDesktopRequest(request, { allowE2E: true }), request)
    reject({ e2e: { action, extra: true } }, { allowE2E: true })
  }
  for (const request of [
    { e2e: { action: 'seedCandles', candles: [candle] } },
    { e2e: { action: 'readCandles', instrument: instId, timeframe: '5m', from: candle.timestamp, through: candle.timestamp } },
  ]) assert.deepEqual(parseDesktopRequest(request, { allowE2E: true }), request)
  for (const request of [
    { e2e: { action: 'unknown' } },
    { e2e: { action: 'seedCandles', candles: [{ ...candle, ignored: true }] } },
    { e2e: { action: 'seedCandles', candles: [{ ...candle, close: Infinity }] } },
    { e2e: { action: 'seedCandles', candles: Array(1) } },
    { e2e: { action: 'readCandles', instrument: instId, timeframe: '5m', from: 2, through: 1 } },
  ]) reject(request, { allowE2E: true })
})

test('validation errors never include rejected credential values', () => {
  const rejectedCredential = 'fake-credential-must-not-appear'
  assert.throws(() => parseDesktopRequest({ analysisSettings: { action: 'save', model: 1, apiKey: rejectedCredential } }), error => error.code === 'INVALID_DESKTOP_REQUEST' && !error.message.includes(rejectedCredential))
})
