export const CANDLE_INTERVALS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })
// A timestamp alone cannot prove usable source coverage after legacy imports.
export const completePriceCandle = row => row?.confirmed === true
  && [row.baseVolume, row.quoteVolume].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
export const validInstrument = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._=-]*$/.test(value)
export function validateQuery({ instrument, timeframe, from = 0, through = Number.MAX_SAFE_INTEGER, limit, order = 'asc' }) {
  if (!validInstrument(instrument)) throw new TypeError('Invalid market instrument.')
  if (!Object.hasOwn(CANDLE_INTERVALS, timeframe)) throw new TypeError('Unsupported candle timeframe.')
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(through) || through < from) throw new TypeError('Invalid candle range.')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 65_536)) throw new TypeError('Invalid candle limit.')
  if (!['asc', 'desc'].includes(order)) throw new TypeError('Invalid candle order.')
  return { instrument, timeframe, from, through, limit, order }
}
export function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') throw new TypeError('Invalid candle record.')
  const { timeframe } = validateQuery(candle), interval = CANDLE_INTERVALS[timeframe]
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp < 0 || candle.timestamp % interval) throw new TypeError('Candle timestamp must lie on its timeframe grid.')
  if (candle.confirmed !== true) throw new TypeError('Only confirmed candles may be persisted.')
  if (['open', 'high', 'low', 'close'].some(field => typeof candle[field] !== 'number' || !Number.isFinite(candle[field]) || candle[field] <= 0)
    || candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) throw new TypeError('Invalid candle OHLC values.')
  if (typeof candle.volume !== 'number' || !Number.isFinite(candle.volume) || candle.volume < 0
    || ['baseVolume', 'quoteVolume', 'oi', 'buy', 'sell'].some(field => candle[field] != null && (typeof candle[field] !== 'number' || !Number.isFinite(candle[field]) || candle[field] < 0))) throw new TypeError('Candle quantities must be finite and nonnegative.')
  if (['statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt', 'writtenAt'].some(field => candle[field] != null && (!Number.isSafeInteger(candle[field]) || candle[field] < 0))
    || candle.statisticsVersion > 2_147_483_647) throw new TypeError('Invalid candle statistics metadata.')
  return candle
}
