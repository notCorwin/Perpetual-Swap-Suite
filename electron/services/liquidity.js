import { measureOperation } from './operations.js'

const FIVE_MINUTES = 300_000
const HOUR = 3_600_000
const HUNDRED = { n: 100n, d: 1n }
const ZERO = { n: 0n, d: 1n }

// Compare decimal API prices and configured boundaries exactly. Binary
// subtraction alone can turn an exactly 0.05% spread into 0.049999999999997%.
const gcd = (left, right) => {
  let a = left < 0n ? -left : left, b = right
  while (b) [a, b] = [b, a % b]
  return a
}
const fraction = (n, d = 1n) => {
  if (d < 0n) { n = -n; d = -d }
  const divisor = gcd(n, d)
  return { n: n / divisor, d: d / divisor }
}
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d)
const subtract = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d)
const multiply = (a, b) => fraction(a.n * b.n, a.d * b.d)
const divide = (a, b) => fraction(a.n * b.d, a.d * b.n)
const compare = (a, b) => {
  const difference = a.n * b.d - b.n * a.d
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

function decimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  if (!Number.isFinite(Number(value))) return null
  const text = String(value).trim()
  if (text.length > 350) return null
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text)
  if (!match) return null
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0)
  if (Math.abs(scale) > 350) return null
  const numerator = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] ?? ''}`)
  return scale >= 0 ? fraction(numerator, 10n ** BigInt(scale)) : fraction(numerator * 10n ** BigInt(-scale))
}

function numeric(value) {
  if (!value) return null
  let result = Number(value.n) / Number(value.d)
  if (!Number.isFinite(result)) {
    const numerator = (value.n < 0n ? -value.n : value.n).toString(), denominator = value.d.toString()
    const n = numerator.slice(0, 16), d = denominator.slice(0, 16)
    result = (value.n < 0n ? -1 : 1) * Number(n) / Number(d) * 10 ** (numerator.length - n.length - denominator.length + d.length)
  }
  return Number.isFinite(result) ? result : null
}

const positive = value => {
  const parsed = decimal(value)
  return parsed && parsed.n > 0n ? parsed : null
}
const nonnegative = value => {
  const parsed = decimal(value)
  return parsed && parsed.n >= 0n ? parsed : null
}
const configured = (config, key) => typeof config?.[key] === 'number' ? positive(config[key]) : null
const populated = value => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)

function instrumentCheck(instrument) {
  if (!instrument || typeof instrument !== 'object' || Array.isArray(instrument)) return { status: 'unknown', reason: 'Instrument metadata is unavailable.' }
  const fields = { instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', instCategory: '1', ruleType: 'normal' }
  for (const [field, expected] of Object.entries(fields)) {
    const value = instrument[field]
    if (typeof value !== 'string' || !value) return { status: 'unknown', reason: `Instrument ${field} is unavailable.` }
    if (value !== expected) return { status: 'failed', reason: `Instrument ${field} must be ${expected}.` }
  }
  if (typeof instrument.instId !== 'string' || !/^[A-Z0-9]+-USDT-SWAP$/.test(instrument.instId)) return { status: 'unknown', reason: 'Instrument ID must identify a USDT perpetual.' }
  if (populated(instrument.expTime)) return { status: 'failed', reason: 'An expiring or scheduled delisting instrument is ineligible.' }
  // instCategory=1 is the documented Crypto class, whose normal perpetual
  // rules specify continuous 24/7 trading. Reject any additional session or
  // TradFi restriction rather than guessing what an undocumented value means.
  // openType and contTdSwTime describe initial listing, not recurring sessions.
  if (Object.entries(instrument).some(([key, value]) => /session|tradfi|tradinghours|markethours|tradingcalendar/i.test(key) && populated(value))) {
    return { status: 'unknown', reason: 'Instrument has unsupported trading-session or TradFi metadata.' }
  }
  return { status: 'verified', reason: 'Live, normal Crypto USDT linear perpetual with continuous trading rules.' }
}

export function eligibleInstrument(instrument) {
  return instrumentCheck(instrument).status === 'verified'
}

function closedWindow(candles, asOf, interval, timeframe, count) {
  if (!Number.isSafeInteger(asOf) || asOf < 0 || !Array.isArray(candles)) return null
  const end = Math.floor(asOf / interval) * interval, start = end - count * interval
  const window = new Map()
  let instrument
  for (const candle of candles) {
    if (!candle || !Number.isSafeInteger(candle.timestamp)) return null
    if (candle.timestamp < start || candle.timestamp >= end) continue
    if (candle.timestamp % interval !== 0 || candle.timeframe !== timeframe || candle.confirmed !== true || window.has(candle.timestamp)) return null
    if (candle.instrument !== undefined) {
      if (typeof candle.instrument !== 'string' || !candle.instrument || instrument !== undefined && instrument !== candle.instrument) return null
      instrument = candle.instrument
    }
    const volume = typeof candle.quoteVolume === 'number' ? nonnegative(candle.quoteVolume) : null
    if (!volume) return null
    window.set(candle.timestamp, volume)
  }
  if (window.size !== count) return null
  const volumes = []
  for (let timestamp = start; timestamp < end; timestamp += interval) {
    if (!window.has(timestamp)) return null
    volumes.push(window.get(timestamp))
  }
  return volumes
}

// Window ends at floor(asOf / 5m) * 5m, excludes the forming candle, and
// contains exactly 288 confirmed, native 5m quote amounts. Never reprice base
// volume, aggregate another timeframe, or deduplicate a missing interval away.
export function quoteTurnover24h(candles, asOf) {
  const volumes = closedWindow(candles, asOf, FIVE_MINUTES, '5m', 288)
  return volumes ? numeric(volumes.reduce(add, ZERO)) : null
}

function bookSide(levels, instrument, side) {
  if (!Array.isArray(levels)) return null
  const contractValue = positive(instrument?.ctVal), multiplier = positive(instrument?.ctMult)
  const baseCurrency = typeof instrument?.instId === 'string' ? instrument.instId.split('-')[0] : null
  const denomination = instrument?.ctValCcy
  if (!contractValue || !multiplier || !baseCurrency || denomination !== baseCurrency && denomination !== 'USDT') return null
  const units = multiply(contractValue, multiplier)
  let previous = null, depth = ZERO
  const parsed = []
  for (const level of levels) {
    if (!Array.isArray(level)) return null
    const price = positive(level[0]), contracts = nonnegative(level[1])
    if (!price || !contracts || previous && (side === 'ask' ? compare(price, previous) <= 0 : compare(price, previous) >= 0)) return null
    previous = price
    const amount = multiply(contracts, units)
    const quote = denomination === 'USDT' ? amount : multiply(amount, price)
    depth = add(depth, quote)
    if (contracts.n > 0n) parsed.push({ price, quote, through: depth })
  }
  return { levels: parsed, depth }
}

function sideSlippage(side, target, direction) {
  if (!side?.levels.length || !target || compare(side.depth, target) < 0) return null
  // Find the terminal fill level, then reuse exact quantities for fully
  // consumed levels. A trade-size edit only recalculates its partial fill.
  let first = 0, last = side.levels.length - 1
  while (first < last) {
    const middle = Math.floor((first + last) / 2)
    if (compare(side.levels[middle].through, target) < 0) first = middle + 1
    else last = middle
  }
  const prefix = side.baseQuantities ??= [ZERO]
  while (prefix.length <= first) {
    const level = side.levels[prefix.length - 1]
    prefix.push(add(prefix.at(-1), divide(level.quote, level.price)))
  }
  const level = side.levels[first], remaining = subtract(target, first ? side.levels[first - 1].through : ZERO)
  const baseQuantity = add(prefix[first], divide(remaining, level.price))
  if (baseQuantity.n <= 0n) return null
  const average = divide(target, baseQuantity), reference = side.levels[0].price
  return multiply(divide(direction === 'ask' ? subtract(average, reference) : subtract(reference, average), reference), HUNDRED)
}

export function evaluateLiquidity(input) {
  return evaluateLiquiditySnapshot(input)
}

// Market observations are immutable snapshots. Cache their exact fractions,
// never rounded output values, while comparing every new threshold afresh.
export function createLiquidityEvaluator() {
  const books = new WeakMap()
  return input => evaluateLiquiditySnapshot(input, books)
}

function evaluateLiquiditySnapshot(input, books) {
  return measureOperation({ category: 'cpu', name: 'liquidity.evaluate', resource: input?.instrument?.instId,
    attributes: { bidLevels: input?.book?.bids?.length ?? 0, askLevels: input?.book?.asks?.length ?? 0, bookResident: Boolean(books?.has(input?.book)) } }, () => {
  const { instrument, ticker, book, openInterest, hourlyCandles, turnover24hUSDT, asOf, config } = input ?? {}
  const metadata = instrumentCheck(instrument)
  const checks = [{ key: 'instrument', ...metadata, value: null }]
  const result = { turnover: null, spread: null, oiUSD: null, askSlippage: null, bidSlippage: null, volumeRatio: null, depthBid: null, depthAsk: null }
  const check = (key, evaluate) => {
    const criterion = config?.[key]
    if (criterion?.enabled === false) { checks.push({ key, status: 'disabled', value: null, reason: 'Disabled.' }); return }
    if (criterion?.enabled !== true) { checks.push({ key, status: 'unknown', value: null, reason: `The ${key} configuration is unavailable.` }); return }
    checks.push({ key, ...evaluate(criterion) })
  }
  const unknown = reason => ({ status: 'unknown', value: null, reason })
  const threshold = (value, limit, relation, reason) => {
    if (!limit) return unknown('The enabled threshold must be a finite positive number.')
    const measured = numeric(value)
    if (measured === null) return unknown('The measured value is unavailable or outside the supported numeric range.')
    return { status: relation(compare(value, limit)) ? 'verified' : 'failed', value: measured, reason }
  }

  check('spread', criterion => {
    const bid = positive(ticker?.bidPx), ask = positive(ticker?.askPx)
    if (!bid || !ask || compare(ask, bid) < 0) return unknown('A valid, non-crossed bid and ask are required for spread.')
    const spread = multiply(divide(subtract(ask, bid), bid), HUNDRED)
    result.spread = numeric(spread)
    return threshold(spread, configured(criterion, 'maxPercent'), comparison => comparison < 0, `Spread must be strictly below ${criterion.maxPercent}%.`)
  })

  let bidSide, askSide, snapshot
  const loadBook = () => {
    if (bidSide === undefined) {
      const units = [instrument?.instId, instrument?.ctVal, instrument?.ctMult, instrument?.ctValCcy].join('|')
      const cacheable = book && typeof book === 'object'
      snapshot = cacheable ? books?.get(book) : null
      if (!snapshot || snapshot.units !== units) {
        bidSide = bookSide(book?.bids, instrument, 'bid')
        askSide = bookSide(book?.asks, instrument, 'ask')
        // A crossed snapshot cannot support either depth or fill calculations.
        if (bidSide?.levels.length && askSide?.levels.length && compare(bidSide.levels[0].price, askSide.levels[0].price) > 0) bidSide = askSide = null
        snapshot = { units, bidSide, askSide }
        if (cacheable) books?.set(book, snapshot)
      }
      bidSide = snapshot.bidSide
      askSide = snapshot.askSide
      result.depthBid = numeric(bidSide?.depth)
      result.depthAsk = numeric(askSide?.depth)
    }
  }
  check('depth', criterion => {
    loadBook()
    const minimum = configured(criterion, 'minUSDT')
    if (!minimum) return unknown('The enabled depth minimum must be a finite positive number.')
    if (!bidSide || !askSide || result.depthBid === null || result.depthAsk === null) return unknown('Valid book levels and explicit contract units are required for depth.')
    const depth = compare(bidSide.depth, askSide.depth) < 0 ? bidSide.depth : askSide.depth
    // A finite snapshot proves a lower bound, not the absence of deeper orders.
    if (compare(depth, minimum) <= 0) return { status: 'unknown', value: numeric(depth), reason: `Visible depth does not prove that both sides strictly exceed ${criterion.minUSDT} USDT.` }
    return { status: 'verified', value: numeric(depth), reason: `Both visible book sides strictly exceed ${criterion.minUSDT} USDT.` }
  })

  check('slippage', criterion => {
    loadBook()
    const target = configured(criterion, 'notionalUSDT'), maximum = configured(criterion, 'maxPercent')
    if (!target || !maximum) return unknown('Slippage requires finite positive notionalUSDT and maxPercent.')
    if (!snapshot.slippage || snapshot.slippage.notionalUSDT !== criterion.notionalUSDT) snapshot.slippage = {
      notionalUSDT: criterion.notionalUSDT,
      ask: sideSlippage(askSide, target, 'ask'), bid: sideSlippage(bidSide, target, 'bid'),
    }
    const { ask, bid } = snapshot.slippage
    result.askSlippage = numeric(ask)
    result.bidSlippage = numeric(bid)
    if (ask && compare(ask, maximum) >= 0 || bid && compare(bid, maximum) >= 0) {
      const worst = !ask ? bid : !bid ? ask : compare(ask, bid) > 0 ? ask : bid
      return threshold(worst, maximum, comparison => comparison < 0, `Both sides' ${criterion.notionalUSDT} USDT slippage must be strictly below ${criterion.maxPercent}%.`)
    }
    if (!ask || !bid || result.askSlippage === null || result.bidSlippage === null) return unknown('Both book sides must fill the entire configured USDT notional with explicit contract units.')
    return threshold(compare(ask, bid) > 0 ? ask : bid, maximum, comparison => comparison < 0, `Both sides' ${criterion.notionalUSDT} USDT slippage must be strictly below ${criterion.maxPercent}%.`)
  })

  check('volume24h', criterion => {
    const turnover = typeof turnover24hUSDT === 'number' ? nonnegative(turnover24hUSDT) : null
    if (!turnover) return unknown('Complete, actual 24h USDT quote turnover is required.')
    result.turnover = numeric(turnover)
    return threshold(turnover, configured(criterion, 'minUSDT'), comparison => comparison > 0, `Actual 24h quote turnover must strictly exceed ${criterion.minUSDT} USDT.`)
  })

  check('openInterest', criterion => {
    const oi = nonnegative(openInterest?.oiUsd)
    if (!oi) return unknown('USDT-quoted open interest is unavailable.')
    result.oiUSD = numeric(oi)
    return threshold(oi, configured(criterion, 'minUSDT'), comparison => comparison > 0, `Open interest must strictly exceed ${criterion.minUSDT} USDT.`)
  })

  check('volumeStability', criterion => {
    const maximum = configured(criterion, 'maxRatio')
    if (!maximum) return unknown('The enabled volume-stability maximum must be a finite positive number.')
    const volumes = closedWindow(hourlyCandles, asOf, HOUR, '1H', 24)
    if (!volumes) return unknown('The latest 24 consecutive, confirmed native hours with quote volumes are required.')
    if (volumes.some(volume => volume.n === 0n)) return { status: 'failed', value: null, reason: 'An hourly quote volume is zero; the max/min volume ratio is undefined or unbounded.' }
    const minimum = volumes.reduce((a, b) => compare(a, b) < 0 ? a : b), largest = volumes.reduce((a, b) => compare(a, b) > 0 ? a : b)
    const ratio = divide(largest, minimum)
    result.volumeRatio = numeric(ratio)
    return threshold(ratio, maximum, comparison => comparison < 0, `Hourly quote-volume max/min must be strictly below ${criterion.maxRatio}.`)
  })

  const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'verified'
  return { eligible: status === 'verified', status, reasons: checks.filter(item => item.status === 'failed' || item.status === 'unknown').map(item => item.reason), ...result, checks }
  })
}
