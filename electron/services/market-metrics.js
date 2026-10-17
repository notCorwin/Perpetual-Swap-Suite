const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null

export const signedRelativeChange = (current, previous) => {
  const next = finite(current), prior = finite(previous)
  return next === null || prior === null || prior === 0 ? null : (next - prior) / Math.abs(prior) * 100
}

export const takerImbalance = (buy, sell) => {
  const currentBuy = finite(buy), currentSell = finite(sell)
  const total = currentBuy === null || currentSell === null ? null : currentBuy + currentSell
  return total === null || total === 0 ? null : (currentBuy - currentSell) / total * 100
}

const emptyBreak = { status: 'insufficient-history' }
const noBreak = { status: 'none' }
const timestamp = bar => finite(bar?.hour ?? bar?.timestamp)
const width = bar => {
  const upper = finite(bar?.logBBUpper), middle = finite(bar?.logBBMiddle), lower = finite(bar?.logBBLower)
  return upper === null || middle === null || lower === null || middle <= 0 ? null : (upper - lower) / middle * 100
}

function priorExtreme(bars, index, period, field, direction) {
  if (index < period) return null
  const window = bars.slice(index - period, index)
  const values = window.map(bar => finite(bar[field]))
  if (values.some(value => value === null)) return null
  const extreme = direction === 'high' ? Math.max(...values) : Math.min(...values)
  // The most recent tied extreme is the effective prior extreme.
  for (let offset = window.length - 1; offset >= 0; offset -= 1) {
    if (finite(window[offset][field]) === extreme) return { value: extreme, index: index - period + offset }
  }
  return null
}

function recentBreak(bars, period, direction, search = 48) {
  if (bars.length < period + 1) return emptyBreak
  const field = direction === 'high' ? 'high' : 'low'
  const first = Math.max(period, bars.length - search)
  let event = null
  for (let index = first; index < bars.length; index += 1) {
    const value = finite(bars[index][field]), prior = priorExtreme(bars, index, period, field, direction)
    if (value === null || prior === null) return emptyBreak
    const broke = direction === 'high' ? value > prior.value : value < prior.value
    if (!broke) continue
    const hour = timestamp(bars[index]), priorHour = timestamp(bars[prior.index])
    if (hour === null || priorHour === null) return emptyBreak
    event = {
      status: 'event', hour, hoursAgo: bars.length - 1 - index,
      priorHour, priorAgeHours: index - prior.index, priorPrice: prior.value, live: false,
    }
  }
  return event ?? noBreak
}

export function bandwidthExpansion(bars) {
  if (!bars.length || width(bars.at(-1)) === null) return null
  let periods = 0
  for (let index = bars.length - 1; index > 0; index -= 1) {
    const current = width(bars[index]), previous = width(bars[index - 1])
    if (current === null || previous === null) return { hours: periods, complete: false }
    if (current <= previous) return { hours: periods, complete: true }
    periods += 1
  }
  return { hours: periods, complete: false }
}

export function summarizeMarketBars(source) {
  const bars = [...source].filter(bar => timestamp(bar) !== null).sort((left, right) => timestamp(left) - timestamp(right))
  const latest = bars.at(-1) ?? null, previous = bars.at(-2) ?? null
  const ema = finite(latest?.ema)
  const ema200Signal = latest === null || ema === null ? null
    : latest.open > ema && latest.close > ema ? 'Long'
      : latest.open < ema && latest.close < ema ? 'Short' : 'Unsure'
  const prior = (period, field, direction) => latest === null ? null : priorExtreme(bars, bars.length - 1, period, field, direction)?.value ?? null
  return {
    bars, latest, previous, ema200Signal,
    priceChange: signedRelativeChange(latest?.close, previous?.close),
    buy: finite(latest?.buy), sell: finite(latest?.sell),
    takerRatio: takerImbalance(latest?.buy, latest?.sell),
    oiChange: signedRelativeChange(latest?.oi, previous?.oi),
    highBreakout: recentBreak(bars, 48, 'high'), lowBreakdown: recentBreak(bars, 48, 'low'),
    highBreakout96: recentBreak(bars, 96, 'high'), lowBreakdown96: recentBreak(bars, 96, 'low'),
    logBBExpansion: bandwidthExpansion(bars),
    priorHigh48: prior(48, 'high', 'high'), priorLow48: prior(48, 'low', 'low'),
    priorHigh96: prior(96, 'high', 'high'), priorLow96: prior(96, 'low', 'low'),
  }
}

const finiteInRange = (value, minimum, maximum) => {
  const numeric = finite(value)
  return numeric !== null && numeric >= minimum && numeric <= maximum ? numeric : null
}

const cappedBonus = (value, maximum) => value === null ? 0 : 10 * Math.min(1, Math.max(0, value / maximum))
const bandRank = { upper: 3, middle: 2, lower: 1, below: 0 }

// This is deliberately shared by the Electron list projection and the React
// details panel. Opportunity results must be derived from exactly the values
// shown in the row, never from a separate chart-only calculation.
export function evaluateMarketOpportunity(input) {
  const direction = input.ema200Signal === 'Long' || input.ema200Signal === 'Short' ? input.ema200Signal : null
  const price = finite(input.priceChange), roc = finite(input.roc), maroc = finite(input.maroc)
  const rsi6 = finiteInRange(input.rsi6, 0, 100), rsi12 = finiteInRange(input.rsi12, 0, 100), rsi24 = finiteInRange(input.rsi24, 0, 100)
  const band = input.logBBAboveBand == null ? undefined : bandRank[input.logBBAboveBand]
  const expansion = input.logBBExpansion
  const validExpansion = expansion != null && Number.isSafeInteger(expansion.hours) && expansion.hours >= 0 && typeof expansion.complete === 'boolean' ? expansion : null
  const taker = finiteInRange(input.takerRatio, -100, 100), oi = finite(input.oiChange)
  const missing = []
  if (direction === null && input.ema200Signal !== 'Unsure') missing.push('EMA200 is unavailable or invalid.')
  for (const [label, value] of [['Price change', price], ['ROC', roc], ['MAROC', maroc], ['RSI6', rsi6], ['RSI12', rsi12], ['RSI24', rsi24]]) if (value === null) missing.push(`${label} is unavailable or invalid.`)
  if (typeof band !== 'number') missing.push('Log BB position is unavailable or invalid.')
  if (validExpansion === null) missing.push('Log BB expansion is unavailable or invalid.')
  const optionalReasons = []
  if (taker === null) optionalReasons.push('Taker imbalance is unavailable or invalid; its participation bonus is zero.')
  if (oi === null) optionalReasons.push('OI change is unavailable or non-finite; its participation bonus is zero.')
  if (missing.length || price === null || roc === null || maroc === null || rsi6 === null || rsi12 === null || rsi24 === null || typeof band !== 'number' || validExpansion === null) return { direction, setup: null, status: 'Incomplete', score: null, components: null, reasons: [...missing, ...optionalReasons] }
  if (direction === null) return {
    direction: null, setup: null, status: 'Watch', score: 0,
    components: { trend: 0, entry: 0, participation: 0, timing: 0, penalty: 0 },
    reasons: ['The live candle body crosses or touches EMA200; direction is unclear.', ...optionalReasons],
  }

  const sign = direction === 'Long' ? 1 : -1
  const directionalPrice = sign * price, directionalROC = sign * roc, directionalMAROC = sign * maroc
  const directionalTaker = taker === null ? null : sign * taker
  const fast = direction === 'Long' ? rsi6 : 100 - rsi6, medium = direction === 'Long' ? rsi12 : 100 - rsi12, slow = direction === 'Long' ? rsi24 : 100 - rsi24
  const position = direction === 'Long' ? band : 3 - band
  const { hours, complete } = validExpansion
  const priceConfirms = directionalPrice > 0, takerConfirms = directionalTaker !== null && directionalTaker > 0
  const startup = slow > 50 && directionalROC >= directionalMAROC && directionalMAROC > 0 && fast >= 50 && fast < 75 && medium >= 50 && medium < 70 && fast > medium && position >= 2 && complete && hours >= 1 && hours <= 3 && (priceConfirms || takerConfirms)
  const pullback = slow > 50 && directionalMAROC > 0 && fast >= 40 && fast <= 60 && medium >= 45 && medium <= 65 && fast <= medium && (position === 1 || position === 2) && priceConfirms && takerConfirms
  const setup = startup ? 'Startup' : pullback ? 'Pullback' : null
  const reasons = [`The live candle body is ${direction === 'Long' ? 'above' : 'below'} EMA200.`]
  if (directionalROC > 0) reasons.push('ROC supports the direction.')
  if (directionalMAROC > 0) reasons.push('MAROC supports the direction.')
  if (slow > 50) reasons.push('RSI24 supports the direction.')
  if (setup === 'Startup') reasons.push('Startup: strengthening momentum with a complete 1–3h expansion.')
  else if (setup === 'Pullback') reasons.push('Pullback: RSI cooling inside Log BB with price and taker confirmation.')
  else reasons.push('No Startup or Pullback setup matches the live readings.')
  if (priceConfirms && takerConfirms) reasons.push('Price and taker flow both confirm the direction.')
  else if (priceConfirms || takerConfirms) reasons.push(`Only ${priceConfirms ? 'price' : 'taker flow'} confirms the direction.`)
  else reasons.push('Neither price nor taker flow confirms the direction.')
  if (taker !== null) reasons.push(takerConfirms ? 'Same-direction taker participation adds up to 10 points, capped at 20%.' : 'Taker flow adds no participation bonus.')
  if (oi !== null) reasons.push(oi > 0 ? 'Rising OI value adds up to 10 points, capped at 5%; it does not determine direction.' : 'Flat or falling OI value adds no participation bonus.')
  reasons.push(...optionalReasons)
  const event = direction === 'Long' ? input.highBreakout : input.lowBreakdown
  let breakBonus = 0
  if (event?.status === 'event' && Number.isSafeInteger(event.hoursAgo) && event.hoursAgo >= 0) {
    breakBonus = event.hoursAgo <= 3 ? 10 : event.hoursAgo <= 12 ? 5 : 0
    if (breakBonus) reasons.push(`${direction === 'Long' ? 'High breakout' : 'Low breakdown'} ${event.hoursAgo}h ago supports entry timing.`)
  } else if (event?.status === 'loading' || event?.status === 'insufficient-history') reasons.push('Same-direction break history is incomplete; no break timing bonus.')
  let expansionBonus = 0
  if (complete) {
    if (setup === 'Pullback') expansionBonus = hours <= 2 ? 10 : hours <= 5 ? 5 : 0
    else expansionBonus = hours >= 1 && hours <= 3 ? 10 : hours <= 6 ? 5 : 0
    if (expansionBonus) reasons.push(`A complete ${hours}h expansion supports ${setup === 'Pullback' ? 'pullback' : 'early-entry'} timing.`)
  } else reasons.push(`Expansion is a lower bound (≥ ${hours}h); no expansion timing bonus.`)
  let penalty = 0
  if (fast >= 70) { penalty += 10; reasons.push(`RSI6 ${direction === 'Long' ? '≥ 70' : '≤ 30'}: fast momentum is stretched (−10).`) }
  if (medium >= 65) { penalty += 10; reasons.push(`RSI12 ${direction === 'Long' ? '≥ 65' : '≤ 35'}: medium momentum is stretched (−10).`) }
  if (position === 3) { penalty += 10; reasons.push(`Price is ${direction === 'Long' ? 'above the upper' : 'at or below the lower'} Log BB band (−10).`) }
  if (hours >= 4) { penalty += 10; reasons.push(`Expansion has lasted ${complete ? '' : 'at least '}${hours}h (−10).`) }
  const extremeRSI = fast >= 80 && medium >= 70, stretchedBand = position === 3 && fast >= 75, extendedBand = position === 3 && hours >= 6 && medium >= 65
  const overheated = extremeRSI || stretchedBand || extendedBand
  if (extremeRSI) reasons.push('RSI6 and RSI12 are extreme together: Overheated.')
  if (stretchedBand) reasons.push('An outer-band reading combines with extreme RSI6: Overheated.')
  if (extendedBand) reasons.push('Outer-band price, extended expansion and elevated RSI12 combine: Overheated.')
  const components = {
    trend: 15 + (directionalROC > 0 ? 5 : 0) + (directionalMAROC > 0 ? 5 : 0) + (slow > 50 ? 5 : 0),
    entry: (setup === null ? 0 : 20) + (priceConfirms && takerConfirms ? 10 : priceConfirms || takerConfirms ? 5 : 0),
    participation: cappedBonus(directionalTaker, 20) + cappedBonus(oi, 5), timing: breakBonus + expansionBonus, penalty,
  }
  const score = Math.round(Math.max(0, Math.min(100, components.trend + components.entry + components.participation + components.timing - penalty)))
  const status = overheated ? 'Overheated' : setup !== null && score >= 65 ? 'Candidate' : 'Watch'
  if (!overheated && setup !== null && score < 65) reasons.push('The entry setup is below the 65-point Candidate threshold.')
  return { direction, setup, status, score, components, reasons }
}
