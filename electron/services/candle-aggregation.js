import { CANDLE_INTERVALS, completePriceCandle } from './market-records.js'

const BASE = CANDLE_INTERVALS['5m']
const finite = value => typeof value === 'number' && Number.isFinite(value)

// At most twelve terms. Preserve small quantities alongside large ones without
// introducing an unbounded accumulator or rounding contract/base/quote units.
function sumQuantities(values) {
  let sum = 0, correction = 0
  for (const value of values) {
    const next = sum + value
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
    sum = next
  }
  const result = sum + correction
  return finite(result) ? result : null
}

function window(rows, timeframe, forming) {
  const interval = CANDLE_INTERVALS[timeframe]
  if (!['15m', '1H'].includes(timeframe) || !Array.isArray(rows) || !rows.length || rows.length > interval / BASE) return null
  const first = rows[0], start = Math.floor(first.timestamp / interval) * interval
  if (first.timestamp !== start || !forming && rows.length !== interval / BASE) return null
  if (rows.some((row, index) => row.instrument !== first.instrument || row.timeframe !== '5m'
    || row.timestamp !== start + index * BASE || !completePriceCandle(row.confirmed ? row : { ...row, confirmed: true })
    || ['open', 'high', 'low', 'close', 'volume'].some(field => !finite(row[field])) || row.volume < 0
    || row.low <= 0 || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close)
    || row.confirmed !== true && !(forming && index === rows.length - 1 && row.confirmed === false))) return null
  return { interval, start, first, last: rows.at(-1) }
}

/** One complete confirmed bucket, or its contiguous live prefix. Never fill gaps. */
export function aggregatePriceCandles(rows, timeframe, { forming = false } = {}) {
  const selected = window(rows, timeframe, forming)
  if (!selected) return null
  const { interval, start, first, last } = selected
  const volume = sumQuantities(rows.map(row => row.volume))
  const baseVolume = sumQuantities(rows.map(row => row.baseVolume))
  const quoteVolume = sumQuantities(rows.map(row => row.quoteVolume))
  if ([volume, baseVolume, quoteVolume].some(value => value === null)) return null
  return { instrument: first.instrument, timeframe, timestamp: start,
    open: first.open, high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: last.close,
    volume, baseVolume, quoteVolume, confirmed: rows.length === interval / BASE && last.confirmed === true }
}

