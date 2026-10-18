import { signedRelativeChange as change } from './market-metrics.js'

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const EMA_PERIOD = 200
const EMA_MULTIPLIER = 2 / (EMA_PERIOD + 1)
const BOLL_PERIOD = 20
const VWAP_PERIOD = 14
const ROC_PERIOD = 9
const MAROC_PERIOD = 9
const RSI_PERIODS = [6, 12, 24]

// The state contains only recursive accumulators and bounded rolling windows.
// It is plain data so workers can return a seed without retaining source history.
export function createIndicatorState(intervalMS = 300_000) {
  if (!Number.isFinite(intervalMS) || intervalMS <= 0) throw new RangeError('Indicator interval must be positive.')
  return {
    intervalMS, lastTimestamp: null, count: 0, previousClose: null,
    emaSeedSum: 0, ema: null, closes: [], volumes: [], rocs: [],
    previousROC: null, previousMAROC: null,
    rsi: RSI_PERIODS.map(period => ({ period, gains: 0, losses: 0 })),
  }
}

const rsiValue = ({ gains, losses }) => gains === 0 && losses === 0 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)

// Append one immutable source observation. The caller builds confirmed state
// from durable history; corrections and prepends require rebuilding that state.
// A missing period resets every seed/window before accepting the next candle.
export function appendIndicatorCandle(state, candle) {
  if (finite(candle.timestamp) === null || finite(candle.close) === null) return null
  if (state.lastTimestamp !== null) {
    if (candle.timestamp <= state.lastTimestamp) throw new RangeError('Indicator corrections require rebuilding the confirmed state.')
    if (candle.timestamp - state.lastTimestamp !== state.intervalMS) Object.assign(state, createIndicatorState(state.intervalMS))
  }
  const index = state.count, price = candle.close
  const currentROC = index >= ROC_PERIOD ? change(price, state.closes.at(-ROC_PERIOD)) : null

  // EMA200 starts at the arithmetic mean of the first 200 contiguous closes.
  // Thereafter its recursive value preserves the influence of all prior closes.
  if (state.ema === null) {
    state.emaSeedSum += price
    if (index === EMA_PERIOD - 1) state.ema = state.emaSeedSum / EMA_PERIOD
  } else state.ema = price * EMA_MULTIPLIER + state.ema * (1 - EMA_MULTIPLIER)

  // Wilder RSI starts with period price changes, then smooths gain/loss means.
  // Flat = 50; only gains = 100; only losses = 0. No value precedes the seed.
  const rsis = []
  for (const value of state.rsi) {
    if (state.previousClose !== null) {
      const move = price - state.previousClose, gain = Math.max(move, 0), loss = Math.max(-move, 0)
      if (index <= value.period) {
        value.gains += gain
        value.losses += loss
        if (index === value.period) { value.gains /= value.period; value.losses /= value.period }
      } else {
        value.gains = (value.gains * (value.period - 1) + gain) / value.period
        value.losses = (value.losses * (value.period - 1) + loss) / value.period
      }
    }
    rsis.push(index >= value.period ? rsiValue(value) : null)
  }

  state.closes.push(price)
  if (state.closes.length > BOLL_PERIOD) state.closes.shift()
  let band = null
  if (state.closes.length === BOLL_PERIOD && state.closes.every(value => value > 0)) {
    // Population deviation, recomputed from the small window rather than a
    // cumulative sum of squares (which loses precision for nearly flat prices).
    const middle = state.closes.reduce((sum, value) => sum + value, 0) / BOLL_PERIOD
    const deviation = Math.sqrt(state.closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / BOLL_PERIOD)
    band = { upper: middle + 2 * deviation, middle, lower: middle - 2 * deviation }
  }

  state.volumes.push({ typicalPrice: (candle.high + candle.low + price) / 3, volume: finite(candle.baseVolume) })
  if (state.volumes.length > VWAP_PERIOD) state.volumes.shift()
  let vwap = null
  if (state.volumes.length === VWAP_PERIOD && state.volumes.every(value => value.volume !== null && value.volume >= 0 && Number.isFinite(value.typicalPrice))) {
    // VWAP14 uses typical price and base quantity. Missing/negative quantity,
    // invalid typical prices and an all-zero volume window are unavailable.
    const volume = state.volumes.reduce((sum, value) => sum + value.volume, 0)
    if (volume > 0) vwap = state.volumes.reduce((sum, value) => sum + value.typicalPrice * value.volume, 0) / volume
  }

  state.rocs.push(currentROC)
  if (state.rocs.length > MAROC_PERIOD) state.rocs.shift()
  const maroc = state.rocs.length === MAROC_PERIOD && state.rocs.every(value => value !== null && Number.isFinite(value))
    ? state.rocs.reduce((sum, value) => sum + value, 0) / MAROC_PERIOD : null
  const bandPosition = !band ? null : price > band.upper ? 'upper' : price > band.middle ? 'middle' : price > band.lower ? 'lower' : 'below'
  const result = {
    hour: candle.timestamp, quoteVolume: candle.quoteVolume ?? null,
    open: candle.open, high: candle.high, low: candle.low, close: price, confirmed: Boolean(candle.confirmed),
    statisticsSources: candle.statisticsSources, statisticsObserved: candle.statisticsObserved,
    vwap, ema: state.ema, bollUpper: band?.upper ?? null, bollMiddle: band?.middle ?? null, bollLower: band?.lower ?? null,
    roc: currentROC, maroc, rsi6: rsis[0], rsi12: rsis[1], rsi24: rsis[2],
    oi: finite(candle.oi), buy: finite(candle.buy), sell: finite(candle.sell), bandPosition,
    rocChange: change(currentROC, state.previousROC), marocChange: change(maroc, state.previousMAROC),
  }
  state.count += 1
  state.lastTimestamp = candle.timestamp
  state.previousClose = price
  state.previousROC = currentROC
  state.previousMAROC = maroc
  return result
}

// A forming candle is always projected from the same confirmed seed. Copying
// only fixed-size windows prevents ticks from cloning/recomputing history and
// keeps successive live revisions from changing EMA/RSI's confirmed state.
export function projectIndicatorCandle(state, candle) {
  return appendIndicatorCandle({
    ...state, closes: [...state.closes], volumes: [...state.volumes], rocs: [...state.rocs],
    rsi: state.rsi.map(value => ({ ...value })),
  }, candle)
}

export function buildIndicatorSeries(candles, intervalMS = 300_000) {
  const state = createIndicatorState(intervalMS), bars = []
  const unique = new Map()
  for (const candle of candles) if (finite(candle.timestamp) !== null && finite(candle.close) !== null) unique.set(candle.timestamp, candle)
  const ordered = [...unique.values()].sort((left, right) => left.timestamp - right.timestamp)
  for (const candle of ordered) bars.push(appendIndicatorCandle(state, candle))
  return { bars, state }
}

// Batch and incremental calculations share every formula and initialization
// rule. Windows never choose a new recursive seed inside a contiguous run.
export function barsWithIndicators(candles, intervalMS = 300_000) {
  return buildIndicatorSeries(candles, intervalMS).bars
}
