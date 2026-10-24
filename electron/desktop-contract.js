import { validatePreferenceFields } from './services/preferences.js'

const TIMEFRAMES = ['5m', '15m', '1H']

export class DesktopRequestError extends Error {
  constructor(path, expectation) {
    super(`Invalid desktop bridge request: ${path} ${expectation}.`)
    this.name = 'DesktopRequestError'
    this.code = 'INVALID_DESKTOP_REQUEST'
  }
}

function invalid(path, expectation) { throw new DesktopRequestError(path, expectation) }

// IPC carries data, never prototypes, accessors, or hidden properties. Validate
// descriptors before reading values so rejected payloads cannot run getters.
function record(value, path, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'must be an object')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !allowed.includes(key)) invalid(path, 'contains an unsupported field')
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(path, 'must contain plain data fields')
  }
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'is required')
  return value
}

function text(value, path, { empty = false, maximum = 1_024 } = {}) {
  if (typeof value !== 'string' || !empty && !value.trim() || value.length > maximum || value.includes('\0')) invalid(path, 'must be a valid string')
  return value
}

function number(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || integer && !Number.isSafeInteger(value)) invalid(path, 'must be a number in the supported range')
  return value
}

function boolean(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean')
  return value
}

function choice(value, path, choices) {
  if (!choices.includes(value)) invalid(path, 'has an unsupported value')
  return value
}

function array(value, path, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid(path, 'must be an array in the supported range')
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(path, 'must contain plain array elements')
  }
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid(path, 'must not contain missing elements')
  return value
}

function optional(target, source, key, parse) {
  if (source[key] !== undefined) target[key] = parse(source[key])
  return target
}

function chart(value, path, window = false) {
  const fields = ['instId', 'timeframe']
  if (window) fields.push('endHour')
  if (path === 'chartWindow') fields.push('historyBars')
  if (path !== 'chartFocus.target') fields.push('focusId')
  record(value, path, fields, ['instId', 'timeframe'])
  const result = { instId: text(value.instId, `${path}.instId`, { maximum: 256 }), timeframe: choice(value.timeframe, `${path}.timeframe`, TIMEFRAMES) }
  optional(result, value, 'historyBars', input => number(input, `${path}.historyBars`, 96, 4_096, true))
  optional(result, value, 'focusId', input => text(input, `${path}.focusId`, { maximum: 256 }))
  return optional(result, value, 'endHour', input => number(input, `${path}.endHour`, 0, Number.MAX_SAFE_INTEGER, true))
}

function snapshot(value) {
  const path = 'snapshot'
  record(value, path, ['timeframe', 'sinceRevision', 'serviceSession'], ['timeframe'])
  const result = { timeframe: choice(value.timeframe, `${path}.timeframe`, TIMEFRAMES) }
  optional(result, value, 'sinceRevision', input => number(input, `${path}.sinceRevision`, -1, Number.MAX_SAFE_INTEGER, true))
  return optional(result, value, 'serviceSession', input => text(input, `${path}.serviceSession`, { maximum: 256 }))
}

function captureChart(value) {
  const path = 'captureChart'
  record(value, path, ['x', 'y', 'width', 'height', 'backgroundRGB', 'output'], ['x', 'y', 'width', 'height'])
  const result = {
    x: number(value.x, `${path}.x`), y: number(value.y, `${path}.y`),
    width: number(value.width, `${path}.width`, Number.MIN_VALUE), height: number(value.height, `${path}.height`, Number.MIN_VALUE),
  }
  optional(result, value, 'output', input => choice(input, `${path}.output`, ['png']))
  return optional(result, value, 'backgroundRGB', input => {
    array(input, `${path}.backgroundRGB`, 3)
    if (input.length !== 3) invalid(`${path}.backgroundRGB`, 'must have three color channels')
    return input.map((channel, index) => number(channel, `${path}.backgroundRGB[${index}]`, 0, 1))
  })
}

function analysisSettings(value) {
  const path = 'analysisSettings'
  record(value, path, ['action', 'model', 'apiKey'], ['action'])
  const action = choice(value.action, `${path}.action`, ['read', 'save', 'removeKey'])
  if (action !== 'save') { record(value, path, ['action']); return { action } }
  record(value, path, ['action', 'model', 'apiKey'], ['action', 'model', 'apiKey'])
  return { action, model: text(value.model, `${path}.model`, { maximum: 256 }), apiKey: text(value.apiKey, `${path}.apiKey`, { empty: true, maximum: 16_384 }) }
}

function preferences(value) {
  const path = 'preferences'
  record(value, path, ['action', 'values'], ['action'])
  const action = choice(value.action, `${path}.action`, ['read', 'update'])
  if (action === 'read') { record(value, path, ['action']); return { action } }
  record(value, path, ['action', 'values'], ['action', 'values'])
  const valuesPath = `${path}.values`
  const values = record(value.values, valuesPath, ['chartTimeframe', 'rankingLookback', 'historyDays', 'liquidity'])
  if (Object.keys(values).length === 0) invalid(valuesPath, 'must contain an update')
  const result = {}
  optional(result, values, 'chartTimeframe', input => choice(input, `${valuesPath}.chartTimeframe`, TIMEFRAMES))
  optional(result, values, 'rankingLookback', input => {
    number(input, `${valuesPath}.rankingLookback`, 5, Number.MAX_SAFE_INTEGER, true)
    if (input % 5 !== 0) invalid(`${valuesPath}.rankingLookback`, 'must be a multiple of 5 minutes')
    return input
  })
  optional(result, values, 'historyDays', input => number(input, `${valuesPath}.historyDays`, 1, 3650, true))
  optional(result, values, 'liquidity', liquidity)
  try { validatePreferenceFields(result, true) } catch { invalid(valuesPath, 'must satisfy the preference schema') }
  return { action, values: result }
}

function liquidity(value) {
  const path = 'preferences.values.liquidity'
  const thresholds = {
    spread: { maxPercent: 0 }, depth: { minUSDT: 0 }, slippage: { maxPercent: 0, notionalUSDT: 0 },
    volume24h: { minUSDT: 0 }, openInterest: { minUSDT: 0 }, volumeStability: { maxRatio: 1 },
  }
  record(value, path, Object.keys(thresholds))
  const result = {}
  for (const [name, fields] of Object.entries(thresholds)) optional(result, value, name, input => {
    const fieldPath = `${path}.${name}`
    record(input, fieldPath, ['enabled', ...Object.keys(fields)])
    const rule = {}
    optional(rule, input, 'enabled', enabled => boolean(enabled, `${fieldPath}.enabled`))
    for (const [key, minimum] of Object.entries(fields)) optional(rule, input, key, threshold => {
      number(threshold, `${fieldPath}.${key}`, minimum)
      if (threshold <= minimum) invalid(`${fieldPath}.${key}`, 'must exceed the supported minimum')
      return threshold
    })
    return rule
  })
  return result
}

function e2e(value) {
  const path = 'e2e'
  record(value, path, ['action', 'candles', 'instrument', 'timeframe', 'from', 'through'], ['action'])
  const action = choice(value.action, `${path}.action`, ['seedCandles', 'readCandles', 'seedCachedListProjection', 'seedChartScrollBenchmark', 'seedHistoricalStatisticsBoundary', 'seedInstrumentNavigationBenchmark', 'settings', 'smokeStatus'])
  if (action === 'seedCandles') {
    record(value, path, ['action', 'candles'], ['action', 'candles'])
    array(value.candles, `${path}.candles`, 100_000)
    return { action, candles: value.candles.map(candle) }
  }
  if (action === 'readCandles') {
    record(value, path, ['action', 'instrument', 'timeframe', 'from', 'through'], ['action', 'instrument', 'timeframe'])
    const result = { action, instrument: text(value.instrument, `${path}.instrument`, { maximum: 256 }), timeframe: choice(value.timeframe, `${path}.timeframe`, TIMEFRAMES) }
    optional(result, value, 'from', input => number(input, `${path}.from`, 0, Number.MAX_SAFE_INTEGER, true))
    optional(result, value, 'through', input => number(input, `${path}.through`, 0, Number.MAX_SAFE_INTEGER, true))
    if (result.from !== undefined && result.through !== undefined && result.from > result.through) invalid(path, 'must have an ordered range')
    return result
  }
  record(value, path, ['action'])
  return { action }
}

function candle(value, index) {
  const path = `e2e.candles[${index}]`
  const base = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed']
  const extras = ['baseVolume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt']
  record(value, path, [...base, ...extras], base)
  const result = {
    instrument: text(value.instrument, `${path}.instrument`, { maximum: 256 }), timeframe: choice(value.timeframe, `${path}.timeframe`, TIMEFRAMES),
    timestamp: number(value.timestamp, `${path}.timestamp`, 0, Number.MAX_SAFE_INTEGER, true),
    open: number(value.open, `${path}.open`, Number.MIN_VALUE), high: number(value.high, `${path}.high`, Number.MIN_VALUE),
    low: number(value.low, `${path}.low`, Number.MIN_VALUE), close: number(value.close, `${path}.close`, Number.MIN_VALUE),
    volume: number(value.volume, `${path}.volume`), confirmed: boolean(value.confirmed, `${path}.confirmed`),
  }
  for (const key of extras) optional(result, value, key, input => input === null ? null : number(input, `${path}.${key}`))
  return result
}

/** Validate the complete request before dispatching any operation or side effect. */
export function parseDesktopRequest(value, { allowE2E = false } = {}) {
  const operations = ['snapshot', 'preferences', 'dataAudit', 'historyDownload', 'chartFocus', 'chartWindow', 'chartLocal', 'chartHistory', 'chartUniverse', 'captureChart', 'copyText', 'analysisSettings', 'gatewayFetch', 'cancelGatewayFetch', 'e2e']
  record(value, 'request', operations)
  const keys = Object.keys(value)
  if (keys.length !== 1) invalid('request', 'must contain exactly one operation')
  const operation = keys[0]
  const input = value[operation]
  switch (operation) {
    case 'snapshot': return { snapshot: snapshot(input) }
    case 'preferences': return { preferences: preferences(input) }
    case 'dataAudit': {
      record(input, operation, ['action'], ['action'])
      return { dataAudit: { action: choice(input.action, 'dataAudit.action', ['start', 'cancel', 'status', 'repair']) } }
    }
    case 'historyDownload': {
      record(input, operation, ['action'], ['action'])
      return { historyDownload: { action: choice(input.action, 'historyDownload.action', ['start', 'cancel', 'status']) } }
    }
    case 'chartWindow': return { chartWindow: chart(input, operation, true) }
    case 'chartFocus': {
      record(input, operation, ['id', 'target'], ['id', 'target'])
      return { chartFocus: { id: text(input.id, 'chartFocus.id', { maximum: 256 }), target: input.target === null ? null : chart(input.target, 'chartFocus.target', true) } }
    }
    case 'chartLocal': return { chartLocal: chart(input, operation) }
    case 'chartHistory': return { chartHistory: chart(input, operation, true) }
    case 'chartUniverse': {
      record(input, operation, ['instIds', 'timeframe', 'focusInstId'], ['instIds', 'timeframe'])
      array(input.instIds, 'chartUniverse.instIds', 1_000)
      const result = { instIds: input.instIds.map((id, index) => text(id, `chartUniverse.instIds[${index}]`, { maximum: 256 })), timeframe: choice(input.timeframe, 'chartUniverse.timeframe', TIMEFRAMES) }
      return { chartUniverse: optional(result, input, 'focusInstId', id => text(id, 'chartUniverse.focusInstId', { maximum: 256 })) }
    }
    case 'captureChart': return { captureChart: captureChart(input) }
    case 'copyText': return { copyText: text(input, operation, { empty: true, maximum: 16_777_216 }) }
    case 'analysisSettings': return { analysisSettings: analysisSettings(input) }
    case 'gatewayFetch': {
      record(input, operation, ['id', 'body'], ['id', 'body'])
      return { gatewayFetch: { id: text(input.id, 'gatewayFetch.id', { maximum: 256 }), body: text(input.body, 'gatewayFetch.body', { maximum: 33_554_432 }) } }
    }
    case 'cancelGatewayFetch': return { cancelGatewayFetch: text(input, operation, { maximum: 256 }) }
    case 'e2e':
      if (allowE2E !== true) invalid('e2e', 'is unavailable outside tests')
      return { e2e: e2e(input) }
    default: invalid('request', 'contains an unsupported operation')
  }
}
