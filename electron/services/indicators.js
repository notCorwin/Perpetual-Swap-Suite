const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const change = (current, previous) => current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100

export function ema(candles, period = 200) {
  const values = new Map(), multiplier = 2 / (period + 1)
  let value = null
  for (let index = 0; index < candles.length; index += 1) {
    const close = finite(candles[index].close)
    if (close === null) continue
    if (value === null && index >= period - 1) {
      const seed = candles.slice(index - period + 1, index + 1).map(candle => finite(candle.close))
      if (seed.every(item => item !== null)) value = seed.reduce((sum, item) => sum + item, 0) / period
    } else if (value !== null) value = close * multiplier + value * (1 - multiplier)
    if (value !== null) values.set(candles[index].timestamp, value)
  }
  return values
}

export function rsi(candles, period) {
  const values = new Map()
  if (candles.length <= period) return values
  let gains = 0, losses = 0
  for (let index = 1; index <= period; index += 1) {
    const move = candles[index].close - candles[index - 1].close
    gains += Math.max(move, 0); losses += Math.max(-move, 0)
  }
  const calculate = () => losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)
  values.set(candles[period].timestamp, calculate())
  for (let index = period + 1; index < candles.length; index += 1) {
    const move = candles[index].close - candles[index - 1].close
    gains = (gains * (period - 1) + Math.max(move, 0)) / period
    losses = (losses * (period - 1) + Math.max(-move, 0)) / period
    values.set(candles[index].timestamp, calculate())
  }
  return values
}

export function bollinger(candles, period = 9) {
  const values = new Map()
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1).map(candle => candle.close)
    if (window.some(value => value <= 0 || !Number.isFinite(value))) continue
    const logs = window.map(Math.log), middleLog = logs.reduce((sum, value) => sum + value, 0) / period
    const deviation = Math.sqrt(logs.reduce((sum, value) => sum + (value - middleLog) ** 2, 0) / period)
    values.set(candles[index].timestamp, { upper: Math.exp(middleLog + 2 * deviation), middle: Math.exp(middleLog), lower: Math.exp(middleLog - 2 * deviation) })
  }
  return values
}

export function vwap(candles, period = 14) {
  const values = new Map()
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1)
    const volume = window.reduce((sum, candle) => sum + (finite(candle.quoteVolume) ?? 0), 0)
    if (volume > 0) values.set(candles[index].timestamp, window.reduce((sum, candle) => sum + (candle.high + candle.low + candle.close) / 3 * (finite(candle.quoteVolume) ?? 0), 0) / volume)
  }
  return values
}

export function roc(candles, period = 9) {
  const values = new Map()
  for (let index = period; index < candles.length; index += 1) values.set(candles[index].timestamp, change(candles[index].close, candles[index - period].close))
  return values
}

function indicatorBars(ordered) {
  const ema200 = ema(ordered), rsi6 = rsi(ordered, 6), rsi12 = rsi(ordered, 12), rsi24 = rsi(ordered, 24), bands = bollinger(ordered), vwaps = vwap(ordered), rocs = roc(ordered), marocValues = new Map()
  for (let index = 8; index < ordered.length; index += 1) {
    const window = ordered.slice(index - 8, index + 1).map(candle => rocs.get(candle.timestamp)).filter(value => value !== undefined)
    if (window.length === 9) marocValues.set(ordered[index].timestamp, window.reduce((sum, value) => sum + value, 0) / 9)
  }
  return ordered.map((candle, index) => {
    const band = bands.get(candle.timestamp), price = candle.close, prior = ordered[index - 1], previousROC = prior ? rocs.get(prior.timestamp) : null, previousMAROC = prior ? marocValues.get(prior.timestamp) : null
    const bandPosition = !band ? null : price > band.upper ? 'upper' : price > band.middle ? 'middle' : price > band.lower ? 'lower' : 'below'
    return { hour: candle.timestamp, quoteVolume: candle.quoteVolume ?? null, open: candle.open, high: candle.high, low: candle.low, close: price, confirmed: Boolean(candle.confirmed), statisticsSources: candle.statisticsSources, statisticsObserved: candle.statisticsObserved, vwap: vwaps.get(candle.timestamp) ?? null, ema: ema200.get(candle.timestamp) ?? null, logBBUpper: band?.upper ?? null, logBBMiddle: band?.middle ?? null, logBBLower: band?.lower ?? null, roc: rocs.get(candle.timestamp) ?? null, maroc: marocValues.get(candle.timestamp) ?? null, rsi6: rsi6.get(candle.timestamp) ?? null, rsi12: rsi12.get(candle.timestamp) ?? null, rsi24: rsi24.get(candle.timestamp) ?? null, oi: finite(candle.oi), buy: finite(candle.buy), sell: finite(candle.sell), bandPosition, rocChange: change(rocs.get(candle.timestamp) ?? null, previousROC ?? null), marocChange: change(marocValues.get(candle.timestamp) ?? null, previousMAROC ?? null) }
  })
}

// Indicators may never span missing periods. Split the input into contiguous
// runs so each calculation restarts after a gap instead of silently using an
// old close as the seed for a newer time range.
export function barsWithIndicators(candles, intervalMS = 300_000) {
  const ordered = [...candles].filter(candle => finite(candle.timestamp) !== null && finite(candle.close) !== null).sort((left, right) => left.timestamp - right.timestamp)
  const runs = []
  for (const candle of ordered) {
    const current = runs.at(-1)
    if (!current || candle.timestamp - current.at(-1).timestamp !== intervalMS) runs.push([candle])
    else current.push(candle)
  }
  return runs.flatMap(indicatorBars)
}
