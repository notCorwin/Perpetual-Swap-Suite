import { statisticsMask, statisticsVersionFor } from './statistics-state.js'
import { appendIndicatorCandle } from './indicators.js'
import { completePriceCandle } from './market-records.js'

export const VISIBLE = 96, TAIL = 128, CHUNK = 1024, HISTORY = 1536, HISTORY_AHEAD = 256, HISTORY_PAGE = 300
export const LIVE_TURN_MS = 4, LIVE_TURN_FRAMES = 32
// 192 remaining candles after 1.5 s of two-candle input at 120 Hz.
export const HISTORY_BASE_VISIBLE = 288
export const HISTORY_RUNWAY = 192 + 2 * 120 * 1.5 + 2 // Include the two-candle gesture that crosses the threshold.
// One 1536-row read plus overlap is retained around the active cursor. The
// directional allocation leaves at least 768 slots on the opposite side so
// a reversal can start another read before its viewport reaches the edge.
export const HISTORY_RESIDENT = 2304, HISTORY_BALANCE = 768
export const HISTORY_SHARE_DISTANCE = 512
export const INDICATOR_WARMUP = 199 // EMA200 is the longest initial seed.
// The v5 state is compatible for all retained indicators, but must remain
// untouched for older producers that still require its rolling volume window.
export const LEGACY_FORMULA_VERSION = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-wilder-atr14-percent-bbw20-2-v5'
export const FORMULA_VERSION = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-roc9-maroc9-wilder-atr14-percent-bbw20-2-v6'
export const indicatorFields = ['ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
export const priceFields = ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
export const TIMEFRAMES = ['5m', '15m', '1H']
export const statisticsFields = ['oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt']
export const blankIndicators = Object.fromEntries(indicatorFields.map(field => [field, null]))

export const intervalFor = timeframe => ({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })[timeframe]

export const assertCandleGrid = (timestamp, interval) => {
  if (!interval || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp % interval) throw new TypeError('Candle timestamp must lie on its timeframe grid.')
}

export const seriesKey = (instId, timeframe) => `${instId}:${timeframe}`
export const numeric = value => typeof value === 'number' && Number.isFinite(value)

export const abortable = (operation, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    Promise.resolve(operation()).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  } catch (error) { signal.removeEventListener('abort', abort); reject(error) }
})

export const freshQuote = (timestamp, observedAt, intervalMS, now = Date.now()) => timestamp === Math.floor(now / intervalMS) * intervalMS
  && observedAt != null && now - observedAt < 30_000

export const samePrice = (left, right) => left && priceFields.every(field => Object.is(left[field], right[field]))
export const sameRecord = (left, right) => left === right || Boolean(left && right && JSON.stringify(left) === JSON.stringify(right))

// Only these forming-candle fields affect the indicator math. Other output
// fields, including quote volume and statistics, are taken from the new row.
const liveIndicatorFields = ['timestamp', 'high', 'low', 'close']
export const sameLiveIndicatorInput = (left, right) => left === right || Boolean(left && right
  && liveIndicatorFields.every(field => Object.is(left[field], right[field])))

// Cached projections use row/indicator identity. Own and freeze every resident
// record so no producer can mutate an admitted input behind that cache key.
export const immutableRecord = value => Object.isFrozen(value) ? value : Object.freeze({ ...value })

export const sourceFresh = (row, bit) => Boolean(statisticsMask(row) & bit)
  && (bit === 1 ? numeric(row.oi) || Number(row.statisticsOIExpiresAt) > Date.now()
    : numeric(row.buy) && numeric(row.sell) || Number(row.statisticsTakerExpiresAt) > Date.now())

export const liveStatisticsDeadline = (state, now) => {
  const row = state?.live
  if (!row) return Infinity
  let deadline = Infinity
  for (const bit of [1, 2]) if (sourceFresh(row, bit) && (bit === 1 ? !numeric(row.oi) : !numeric(row.buy) || !numeric(row.sell))) {
    const expiry = Number(row[bit === 1 ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'])
    if (expiry > now) deadline = Math.min(deadline, expiry)
  }
  return deadline
}

export const priorityRank = priority => ({ interactive: 5, foreground: 4, prepared: 4, repair: 4, continuity: 3, statistics: 2, prefetch: 1, chartWarm: 1, background: 0 })[priority] ?? 0

export const sourceState = (rows, bit) => rows.length && rows.every(row => sourceFresh(row, bit))
  ? rows.every(row => bit === 1 ? numeric(row.oi) : numeric(row.buy) && numeric(row.sell)) ? 'ready' : 'unavailable' : 'loading'

export const changedSource = (left, right, bit) => !left || (statisticsMask(left) & bit) !== (statisticsMask(right) & bit)
  || (bit === 1 ? ['oi', 'statisticsOIExpiresAt'] : ['buy', 'sell', 'statisticsTakerExpiresAt']).some(field => !Object.is(left[field], right[field]))

// Price records and either statistic family have independent write lifetimes.
// An unobserved family is not an instruction to erase an existing observation.
export const mergeStatistics = (previous, incoming, allowed = 3) => {
  const value = { ...incoming }, priorMask = statisticsMask(previous), incomingMask = statisticsMask(incoming)
  let sources = 0
  for (const bit of [1, 2]) {
    const accept = !previous || Boolean(allowed & bit) && Boolean(incomingMask & bit)
    const source = accept ? incoming : previous
    if ((accept ? incomingMask : priorMask) & bit) sources |= bit
    for (const field of bit === 1 ? ['oi', 'statisticsOIExpiresAt'] : ['buy', 'sell', 'statisticsTakerExpiresAt']) value[field] = source?.[field] ?? null
  }
  value.statisticsVersion = statisticsVersionFor(sources)
  return value
}

export const bar = (row, calculated, oiFresh = sourceFresh(row, 1), takerFresh = sourceFresh(row, 2)) => ({ ...blankIndicators, ...calculated,
  hour: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, confirmed: Boolean(row.confirmed),
  priceComplete: completePriceCandle(row),
  oi: numeric(row.oi) ? row.oi : null, buy: numeric(row.buy) ? row.buy : null, sell: numeric(row.sell) ? row.sell : null,
  statisticsSources: statisticsMask(row), statisticsObserved: oiFresh && takerFresh,
  oiObserved: oiFresh, takerObserved: takerFresh,
  indicatorsObserved: Boolean(calculated),
  ...(oiFresh && !numeric(row.oi) ? { oiUnavailableReason: 'not-published' } : {}),
  ...(takerFresh && (!numeric(row.buy) || !numeric(row.sell)) ? { takerUnavailableReason: 'not-published' } : {}),
})

// A confirmed seed is shared by the latest tail and a resident history view.
// Only appending a new confirmed candle creates a successor; projections and
// promotions must never mutate the admitted prefix behind another owner.
export const sharedIndicatorState = state => {
  if (!state || Object.isFrozen(state)) return state
  for (const value of state.rsi) Object.freeze(value)
  for (const field of ['closes', 'rocs', 'rsi']) Object.freeze(state[field])
  if (state.bollExpansion) Object.freeze(state.bollExpansion)
  return Object.freeze(state)
}

export const appendConfirmed = (previous, candle) => {
  const state = { ...previous, closes: [...previous.closes], rocs: [...previous.rocs],
    rsi: previous.rsi.map(value => ({ ...value })) }
  const previousHour = state.lastTimestamp, previousWidth = state.previousBandWidth ?? null
  const value = appendIndicatorCandle(state, candle)
  if (!value) return { state: previous, value: null }
  const width = value.bbw
  state.bollExpansion = width === null ? null : previousWidth === null || previousHour + state.intervalMS !== candle.timestamp
    ? { hours: 0, complete: false } : width <= previousWidth ? { hours: 0, complete: true }
      : { hours: (state.bollExpansion?.hours ?? 0) + 1, complete: state.bollExpansion?.complete ?? false }
  state.previousBandWidth = width
  return { state: sharedIndicatorState(state), value: immutableRecord({ ...value, indicatorsObserved: true }) }
}

// Source work and failures are owned by a series/source pair. Keep that index
// at the mutation boundary, so a status query never scans unrelated contracts.
// Its identity/version also fences cached task coverage on add/remove/replace.
export class SourceRegistry extends Map {
  groups = new Map()

  group(series, source) { return this.groups.get(`${series}:${source}`) }

  change(key, value, adding) {
    const identity = `${value.seriesKey}:${value.source}`
    let group = this.groups.get(identity)
    if (!group) { group = { entries: new Map(), version: 0, sorted: null }; this.groups.set(identity, group) }
    if (adding) group.entries.set(key, value)
    else group.entries.delete(key)
    group.version += 1; group.sorted = null
    if (!group.entries.size) this.groups.delete(identity)
  }

  set(key, value) {
    const previous = this.get(key)
    if (previous === value) return this
    if (previous) this.change(key, previous, false)
    super.set(key, value); this.change(key, value, true)
    return this
  }

  delete(key) {
    const previous = this.get(key)
    if (!super.delete(key)) return false
    this.change(key, previous, false)
    return true
  }

  clear() { super.clear(); this.groups.clear() }
}

export const sameStatus = (left, right) => left === right || Boolean(left && right
  && Object.keys(left).every(key => Object.is(left[key], right[key]))
  && Object.keys(right).every(key => Object.is(left[key], right[key])))
