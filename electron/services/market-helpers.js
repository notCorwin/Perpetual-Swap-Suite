import { statisticsMask, statisticsVersionFor, validTakerVolumes, STATISTICS_OI, STATISTICS_TAKER } from './statistics-state.js'

export const FIVE_MINUTES = 300_000
export const CHART_TIMEFRAMES = ['5m', '15m', '1H']
// Only prefs() admits configurations owned and deeply frozen by validation.
// Replacements receive a new identity; mutable/foreign inputs are encoded anew.
// Weak keys release obsolete settings without a time-based validity policy.
export const liquidityConfigKeys = new WeakMap()
export const liquidityConfigKey = config => liquidityConfigKeys.get(config) ?? JSON.stringify(config)
export const LIQUIDITY_SOURCE_CRITERIA = {
  ticker: ['spread'], book: ['depth', 'slippage'], openInterest: ['openInterest'],
  turnover: ['volume24h'], hourly: ['volumeStability'],
}
export const requiredLiquiditySources = config => Object.entries(LIQUIDITY_SOURCE_CRITERIA)
  .filter(([, criteria]) => criteria.some(key => config[key].enabled)).map(([source]) => source)
export const OBSERVATION_TTL = 90_000
export const TICKER_BOOTSTRAP_MS = 10_000
export const CANDLE_DELIVERY_MS = 10_000
export const CATALOG_RENEW_INTERVAL = 30_000
// Intentional 30-second hysteresis buffer: prevents contracts oscillating at
// liquidity thresholds from flickering in and out of the visible list.
export const LIST_REMOVAL_DELAY_MS = 30_000
export const REQUEST_TIMEOUT = 12_000

export const statisticsExpiryField = source => source === STATISTICS_OI ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
export const timeframeMilliseconds = timeframe => timeframe === '5m' ? FIVE_MINUTES : timeframe === '15m' ? 900_000 : 3_600_000
export const closedBoundary = (timeframe, now = Date.now()) => Math.floor(now / timeframeMilliseconds(timeframe)) * timeframeMilliseconds(timeframe)
export const emptyAudit = () => ({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })

export const abortable = (promise, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error('The request was aborted.')); return }
  const abort = () => reject(signal?.reason ?? new Error('The request was aborted.'))
  signal?.addEventListener('abort', abort, { once: true })
  Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
})

// Each consumer owns only its wait. Retire the shared work when its last
// consumer leaves, and detach it before aborting so a new caller starts fresh.
export function sharedWait(entry, signal, retire) {
  return new Promise((resolve, reject) => {
    const waiter = {}
    const finish = (complete, value) => {
      if (!entry.waiters.delete(waiter)) return
      signal?.removeEventListener('abort', onAbort)
      complete(value)
      if (!entry.settled && !entry.waiters.size) retire(entry, signal?.reason)
    }
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('The request was aborted.', 'AbortError'))
    entry.waiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    entry.task.then(value => finish(resolve, value), error => finish(reject, error))
    if (signal?.aborted) onAbort()
  })
}

export const number = value => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizedStatistics(candle) {
  const sources = statisticsMask(candle)
  const volumes = sources & STATISTICS_TAKER ? validTakerVolumes(candle) : null
  const next = {
    ...candle,
    oi: sources & STATISTICS_OI ? number(candle.oi) : null,
    buy: volumes?.buy ?? null,
    sell: volumes?.sell ?? null,
  }
  // Preserve genuine observations independently. Old inferred nulls and
  // traded-period zero placeholders require a real bounded source request.
  next.statisticsVersion = sources ? statisticsVersionFor(sources) : null
  for (const source of [STATISTICS_OI, STATISTICS_TAKER]) {
    const field = statisticsExpiryField(source)
    const missing = source === STATISTICS_OI ? next.oi === null : next.buy === null || next.sell === null
    // Only persisted source proof can lease an empty observation. A price
    // correction or import must never manufacture a new successful response.
    next[field] = sources & source && missing
      ? number(candle[field]) ?? 0
      : null
  }
  return next
}

export function candle(instrument, timeframe, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe, timestamp, open, high, low, close, volume: number(value[5]), baseVolume: number(value[6]), quoteVolume: number(value[7]), confirmed: value[8] === '1' }
}

const candleFields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
export const priceRecord = row => Object.fromEntries(candleFields.map(field => [field, row[field] ?? null]))
