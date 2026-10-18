import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiquidityEvaluator, eligibleInstrument, evaluateLiquidity, quoteTurnover24h, type LiquidityConfig, type LiquidityInput, type QuoteVolumeCandle } from '../electron/services/liquidity.js'

const fiveMinutes = 300_000
const hour = 3_600_000
const asOf = Date.UTC(2026, 9, 18, 12, 15)
const instrument = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', instCategory: '1', ruleType: 'normal', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', expTime: '' }
const preferences = (): LiquidityConfig => ({
  spread: { enabled: true, maxPercent: 0.05 },
  depth: { enabled: true, minUSDT: 100_000 },
  slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 },
  volume24h: { enabled: true, minUSDT: 30_000_000 },
  openInterest: { enabled: true, minUSDT: 5_000_000 },
  volumeStability: { enabled: false, maxRatio: 2 },
})
const only = (key?: keyof LiquidityConfig): LiquidityConfig => {
  const config = preferences()
  for (const name of Object.keys(config) as (keyof LiquidityConfig)[]) config[name].enabled = name === key
  return config
}
const hourly = (volumes = Array<number>(24).fill(100)): QuoteVolumeCandle[] => {
  const end = Math.floor(asOf / hour) * hour
  return volumes.map((quoteVolume, index) => ({ instrument: instrument.instId, timeframe: '1H', timestamp: end - (24 - index) * hour, confirmed: true, quoteVolume }))
}
const fiveMinuteCandles = (): QuoteVolumeCandle[] => Array.from({ length: 288 }, (_, index) => ({
  instrument: instrument.instId, timeframe: '5m', timestamp: asOf - (288 - index) * fiveMinutes, confirmed: true, quoteVolume: index % 2 === 0 ? 100 : 200,
}))
const fixture = (overrides: Partial<LiquidityInput> = {}): LiquidityInput => ({
  instrument, ticker: { bidPx: '100', askPx: '100.01', last: '100', volCcy24h: '999999999' },
  book: { bids: [['100', '200000']], asks: [['100.01', '200000']] },
  openInterest: { oiUsd: '6000000' }, hourlyCandles: hourly(), turnover24hUSDT: 40_000_000, asOf, config: preferences(), ...overrides,
})
const inspect = (input: LiquidityInput, key: string) => {
  const result = evaluateLiquidity(input)
  return { result, check: result.checks.find(item => item.key === key)! }
}
const near = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null)
  assert.ok(Math.abs(actual! - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`)
}

test('only explicit live normal Crypto USDT linear perpetual metadata qualifies', () => {
  assert.equal(eligibleInstrument(instrument), true)
  // These describe the initial listing, not a recurring trading schedule.
  assert.equal(eligibleInstrument({ ...instrument, openType: 'call_auction', contTdSwTime: '1700000000000' }), true)
  for (const [key, value] of Object.entries({ instType: 'FUTURES', ctType: 'inverse', settleCcy: 'USDC', state: 'suspend', instCategory: '2', ruleType: 'pre_market', instId: 'BTC-USD-SWAP', expTime: '1800000000000' })) {
    assert.equal(eligibleInstrument({ ...instrument, [key]: value }), false, key)
  }
  for (const key of ['instType', 'ctType', 'settleCcy', 'state', 'instCategory', 'ruleType', 'instId']) {
    for (const value of [undefined, null, '', 'unknown', 1]) assert.equal(eligibleInstrument({ ...instrument, [key]: value }), false, key)
  }
  for (const extra of [{ tradingSessions: ['09:30-16:00'] }, { session: 'regular' }, { tradFi: true }, { tradfiType: 'stock' }, { tradingHours: '24/5' }, { session: false }]) {
    assert.equal(eligibleInstrument({ ...instrument, ...extra }), false)
  }
  for (const value of [null, undefined, {}, [], 'BTC-USDT-SWAP']) assert.equal(eligibleInstrument(value), false)
})

test('all enabled criteria are ANDed, observations and preferences are not mutated', () => {
  const input = fixture(), before = structuredClone(input)
  const result = evaluateLiquidity(input)
  assert.equal(result.eligible, true)
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.reasons, [])
  assert.equal(result.checks.length, 7)
  assert.equal(result.checks.find(item => item.key === 'volumeStability')?.status, 'disabled')
  assert.equal(result.turnover, 40_000_000)
  assert.equal(result.oiUSD, 6_000_000)
  assert.equal(result.depthBid, 200_000)
  assert.equal(result.depthAsk, 200_020)
  assert.equal(result.askSlippage, 0)
  assert.equal(result.bidSlippage, 0)
  assert.deepEqual(input, before)
})

test('disabled criteria require neither data nor thresholds but never disable instrument restrictions', () => {
  const result = evaluateLiquidity({ instrument, asOf, config: only() })
  assert.equal(result.status, 'verified')
  assert.equal(result.eligible, true)
  assert.ok(result.checks.slice(1).every(item => item.status === 'disabled' && item.value === null))
  assert.equal(evaluateLiquidity({ instrument: { ...instrument, instCategory: '' }, asOf, config: only() }).status, 'unknown')
  assert.equal(evaluateLiquidity({ instrument: { ...instrument, instCategory: '2' }, asOf, config: only() }).status, 'failed')
  assert.equal(evaluateLiquidity({ instrument: { ...instrument, tradingSession: 'regular' }, asOf, config: only() }).eligible, false)
})

test('each enabled criterion alone demands its observations, and missing config never supplies defaults', () => {
  for (const key of Object.keys(preferences()) as (keyof LiquidityConfig)[]) {
    const result = evaluateLiquidity({ instrument, asOf, config: only(key) })
    assert.equal(result.status, 'unknown', key)
    assert.equal(result.eligible, false)
    assert.equal(result.checks.find(item => item.key === key)?.status, 'unknown')
    assert.equal(evaluateLiquidity({ instrument, asOf, config: only() }).eligible, true)
  }
  assert.equal(evaluateLiquidity({ instrument, asOf, config: {} as LiquidityConfig }).status, 'unknown')
  const config = only('spread')
  config.spread.enabled = undefined as unknown as boolean
  assert.equal(evaluateLiquidity(fixture({ config })).status, 'unknown')
})

test('spread uses bid as denominator and exact strict decimal boundaries', () => {
  for (const [askPx, status] of [['100.049999', 'verified'], ['100.05', 'failed'], ['100.050001', 'failed']] as const) {
    const { result, check } = inspect(fixture({ config: only('spread'), ticker: { bidPx: '100', askPx } }), 'spread')
    assert.equal(check.status, status)
    assert.equal(result.status, status)
    near(result.spread, (Number(askPx) - 100) / 100 * 100)
  }
  assert.equal(evaluateLiquidity(fixture({ config: only('spread'), ticker: { bidPx: '100', askPx: '100.05' } })).spread, 0.05)
  for (const ticker of [{ bidPx: 0, askPx: 100 }, { bidPx: -1, askPx: 100 }, { bidPx: '', askPx: '100' }, { bidPx: '101', askPx: '100' }]) {
    assert.equal(evaluateLiquidity(fixture({ config: only('spread'), ticker })).status, 'unknown')
  }
})

test('uncapped two-sided depth strictly above the threshold is proven; insufficient finite depth is unknown', () => {
  for (const [size, expected] of [['99999.99', 'unknown'], ['100000', 'unknown'], ['100000.01', 'verified']] as const) {
    const { result, check } = inspect(fixture({ config: only('depth'), book: { bids: [['100', size]], asks: [['100', size]] } }), 'depth')
    assert.equal(check.status, expected)
    assert.equal(result.depthBid, Number(size))
    assert.equal(result.depthAsk, Number(size))
  }
  const result = evaluateLiquidity(fixture({ config: only('depth'), book: { bids: [['100', '100000'], ['99', '200000']], asks: [['100', '100000'], ['101', '200000']] } }))
  assert.equal(result.depthBid, 298_000)
  assert.equal(result.depthAsk, 302_000)
  assert.equal(result.eligible, true)
  assert.equal(evaluateLiquidity(fixture({ config: only('depth'), book: { bids: [], asks: [['100', '200000']] } })).status, 'unknown')
  assert.equal(evaluateLiquidity(fixture({ config: only('depth'), book: { bids: [['100', '99999']], asks: [['100', '200000']] } })).eligible, false)
})

test('contract value and multiplier are applied once with explicit base or quote units', () => {
  const book = { bids: [['100', '2'], ['90', '3']], asks: [['100', '2'], ['110', '3']] }
  const config = only('depth')
  config.depth.minUSDT = 1
  const base = evaluateLiquidity(fixture({ instrument: { ...instrument, ctVal: '0.5', ctMult: '4' }, book, config }))
  assert.equal(base.depthBid, 940)
  assert.equal(base.depthAsk, 1060)
  // A dimensionally quote-valued fixture: contract count * face quote amount.
  const quote = evaluateLiquidity(fixture({ instrument: { ...instrument, ctVal: '50', ctMult: '4', ctValCcy: 'USDT' }, book, config }))
  assert.equal(quote.depthBid, 1000)
  assert.equal(quote.depthAsk, 1000)
  for (const metadata of [{ ctVal: '' }, { ctVal: '0' }, { ctVal: '-1' }, { ctMult: undefined }, { ctMult: '0' }, { ctMult: 'bad' }, { ctValCcy: '' }, { ctValCcy: 'ETH' }, { instId: 123 }]) {
    assert.equal(evaluateLiquidity(fixture({ instrument: { ...instrument, ...metadata }, book, config })).eligible, false)
  }
})

test('slippage fills each side independently by quote notional and volume-weighted base quantity', () => {
  const config = only('slippage')
  config.slippage.notionalUSDT = 150
  config.slippage.maxPercent = 10
  const result = evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '1', ctMult: '1' }, book: { asks: [['100', '1'], ['110', '1']], bids: [['100', '1'], ['90', '1']] } }))
  // Ask: 1 + 50/110 base bought. Bid: 1 + 50/90 base sold.
  near(result.askSlippage, (150 / (1 + 50 / 110) - 100) / 100 * 100)
  near(result.bidSlippage, (100 - 150 / (1 + 50 / 90)) / 100 * 100)
  assert.equal(result.status, 'verified')
  config.slippage.maxPercent = 3.5
  assert.equal(evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '1', ctMult: '1' }, book: { asks: [['100', '1'], ['110', '1']], bids: [['100', '1'], ['90', '1']] } })).status, 'failed')
})

test('slippage exact threshold fails, and changing notional never changes observed depth', () => {
  const config = only('slippage')
  config.slippage.notionalUSDT = 200.2
  const book = { asks: [['100', '1'], ['100.2', '1']], bids: [['100', '3']] }
  for (const [maximum, status] of [[0.099999, 'failed'], [0.1, 'failed'], [0.100001, 'verified']] as const) {
    config.slippage.maxPercent = maximum
    const result = evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '1' }, book }))
    assert.equal(result.askSlippage, 0.1)
    assert.equal(result.status, status)
  }
  config.slippage.notionalUSDT = 100
  const low = evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '1' }, book }))
  config.slippage.notionalUSDT = 200.2
  const high = evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '1' }, book }))
  assert.equal(low.askSlippage, 0)
  assert.equal(high.askSlippage, 0.1)
  assert.equal(low.depthAsk, high.depthAsk)
  assert.equal(low.depthBid, high.depthBid)
})

const assertCachedLiquidity = (evaluate: ReturnType<typeof createLiquidityEvaluator>, input: LiquidityInput) => {
  const before = structuredClone(input)
  const expected = evaluateLiquidity(input)
  const actual = evaluate(input)
  assert.deepEqual(actual, expected)
  assert.deepEqual(input, before, 'Neither evaluator may mutate the observed snapshot, instrument, or preferences.')
  return actual
}
const freezeBook = (book: NonNullable<LiquidityInput['book']>) => {
  for (const levels of [book.bids, book.asks]) {
    for (const level of levels ?? []) Object.freeze(level)
    if (levels) Object.freeze(levels)
  }
  return Object.freeze(book)
}

test('cached book evaluation preserves exact strict thresholds and recomputes fills when trade notional changes', () => {
  const evaluate = createLiquidityEvaluator(), config = only('slippage')
  config.depth.enabled = true
  config.depth.minUSDT = 200
  config.slippage.notionalUSDT = 200.2
  const book = freezeBook({ asks: [['100', '1'], ['100.2', '1']], bids: [['100', '3']] })
  const input = fixture({ instrument: { ...instrument, ctVal: '1' }, book, config })
  for (const [maximum, status] of [[0.099999, 'failed'], [0.1, 'failed'], [0.100001, 'verified']] as const) {
    config.slippage.maxPercent = maximum
    const result = assertCachedLiquidity(evaluate, input)
    assert.equal(result.askSlippage, 0.1)
    assert.equal(result.status, status, 'A cached exact 0.1% fill must retain the strict decimal comparison.')
  }
  for (const [minimum, status] of [[200.199999, 'verified'], [200.2, 'unknown'], [200.200001, 'unknown']] as const) {
    config.depth.minUSDT = minimum
    const result = assertCachedLiquidity(evaluate, input)
    assert.equal(result.checks.find(check => check.key === 'depth')?.status, status)
  }
  config.depth.enabled = false
  config.slippage.maxPercent = 10
  for (const [notional, slippage] of [[100, 0], [200.2, 0.1], [250, null], [200.2, 0.1]] as const) {
    config.slippage.notionalUSDT = notional
    const result = assertCachedLiquidity(evaluate, input)
    assert.equal(result.askSlippage, slippage)
    assert.equal(result.depthAsk, 200.2, 'Changing trade size cannot change the observed depth.')
  }
  config.slippage.enabled = false
  assert.equal(assertCachedLiquidity(evaluate, input).status, 'verified')
  config.slippage.enabled = true
  assert.equal(assertCachedLiquidity(evaluate, input).askSlippage, 0.1)
})

test('cached book evaluation respects changed contract units, denomination, instrument identity, and new snapshots', () => {
  const evaluate = createLiquidityEvaluator(), config = only('slippage')
  config.depth.enabled = true
  config.depth.minUSDT = 1
  config.slippage.notionalUSDT = 150
  config.slippage.maxPercent = 50
  const metadata = { ...instrument, ctVal: '1' }
  const book = freezeBook({ asks: [['100', '1'], ['110', '1']], bids: [['100', '1'], ['90', '1']] })
  const input = fixture({ instrument: metadata, book, config })
  const baseline = assertCachedLiquidity(evaluate, input)
  assert.deepEqual([baseline.depthBid, baseline.depthAsk], [190, 210])
  for (const units of [
    { instId: 'BTC-USDT-SWAP', ctVal: '2', ctMult: '1', ctValCcy: 'BTC' },
    { instId: 'BTC-USDT-SWAP', ctVal: '1', ctMult: '3', ctValCcy: 'BTC' },
    { instId: 'BTC-USDT-SWAP', ctVal: '100', ctMult: '1', ctValCcy: 'USDT' },
    { instId: 'BTC-USDT-SWAP', ctVal: '1', ctMult: '', ctValCcy: 'BTC' },
    { instId: 'ETH-USDT-SWAP', ctVal: '1', ctMult: '1', ctValCcy: 'BTC' },
    { instId: 'ETH-USDT-SWAP', ctVal: '1', ctMult: '1', ctValCcy: 'ETH' },
    { instId: 'BTC-USDT-SWAP', ctVal: '1', ctMult: '1', ctValCcy: 'BTC' },
  ]) {
    Object.assign(metadata, units)
    assertCachedLiquidity(evaluate, input)
  }
  assert.deepEqual(assertCachedLiquidity(evaluate, input), baseline)
  const replacement = freezeBook({ asks: [['100', '4']], bids: [['100', '4']] })
  const updated = assertCachedLiquidity(evaluate, { ...input, book: replacement })
  assert.deepEqual([updated.depthBid, updated.depthAsk, updated.askSlippage, updated.bidSlippage], [400, 400, 0, 0])
  const crossed = freezeBook({ asks: [['99', '4']], bids: [['100', '4']] })
  assert.equal(assertCachedLiquidity(evaluate, { ...input, book: crossed }).status, 'unknown')
  assert.deepEqual(assertCachedLiquidity(evaluate, input), baseline, 'Revisiting an older immutable snapshot must retain its own exact calculations.')
})

test('the pure liquidity evaluator recomputes a mutable book without retaining snapshot cache state', () => {
  const book = { asks: [['100', '200000']], bids: [['100', '200000']] }
  const input = fixture({ config: only('depth'), book })
  assert.equal(evaluateLiquidity(input).depthAsk, 200_000)
  book.asks[0][1] = '300000'
  const before = structuredClone(input)
  assert.equal(evaluateLiquidity(input).depthAsk, 300_000)
  assert.deepEqual(input, before)
})

test('quote-denominated fill averages convert quote to base rather than counting contracts as coins', () => {
  const config = only('slippage')
  config.slippage.notionalUSDT = 150
  config.slippage.maxPercent = 10
  const result = evaluateLiquidity(fixture({ config, instrument: { ...instrument, ctVal: '50', ctMult: '2', ctValCcy: 'USDT' }, book: { asks: [['100', '1'], ['110', '1']], bids: [['100', '1'], ['90', '1']] } }))
  near(result.askSlippage, 150 / (1 + 50 / 110) - 100)
  near(result.bidSlippage, 100 - 150 / (1 + 50 / 90))
  assert.equal(result.depthAsk, 200)
  assert.equal(result.depthBid, 200)
})

test('incomplete notional fills are unknown and malformed book levels cannot prove qualification', () => {
  const config = only('slippage')
  const small = evaluateLiquidity(fixture({ config, book: { asks: [['100', '99999']], bids: [['100', '99999']] } }))
  assert.equal(small.status, 'unknown')
  assert.equal(small.askSlippage, null)
  assert.equal(small.bidSlippage, null)
  for (const book of [
    { asks: [], bids: [] }, { asks: [['100', '-1']], bids: [['100', '200000']] },
    { asks: [['100', 'NaN']], bids: [['100', '200000']] }, { asks: [['0', '200000']], bids: [['100', '200000']] },
    { asks: [['101', '200000'], ['100', '200000']], bids: [['100', '200000']] },
    { asks: [['100', '200000']], bids: [['99', '200000'], ['100', '200000']] },
    { asks: [['100', '200000'], ['100', '200000']], bids: [['100', '200000']] },
    { asks: [['99', '200000']], bids: [['100', '200000']] },
  ]) assert.equal(evaluateLiquidity(fixture({ config, book })).status, 'unknown')
})

test('zero-size rows contribute no depth or reference quote, and a proven failed side overrides an unknown fill', () => {
  const config = only('slippage')
  config.slippage.notionalUSDT = 199.8
  const metadata = { ...instrument, ctVal: '1' }
  const zeroTop = evaluateLiquidity(fixture({ config, instrument: metadata, book: { asks: [['100', '0'], ['101', '2']], bids: [['100', '2']] } }))
  assert.equal(zeroTop.askSlippage, 0)
  assert.equal(zeroTop.depthAsk, 202)
  assert.equal(zeroTop.status, 'verified')
  const noQuantity = evaluateLiquidity(fixture({ config, instrument: metadata, book: { asks: [['100', '0']], bids: [['100', '2']] } }))
  assert.equal(noQuantity.status, 'unknown')
  assert.equal(noQuantity.askSlippage, null)
  const failedBid = evaluateLiquidity(fixture({ config, instrument: metadata, book: { asks: [['100', '1']], bids: [['100', '1'], ['99.8', '1']] } }))
  assert.equal(failedBid.askSlippage, null)
  assert.equal(failedBid.bidSlippage, 0.1)
  assert.equal(failedBid.status, 'failed')
})

test('actual turnover and OI enforce strict greater-than boundaries and keep zero as failure', () => {
  for (const key of ['volume24h', 'openInterest'] as const) {
    const minimum = preferences()[key].minUSDT
    for (const [value, expected] of [[0, 'failed'], [minimum - 0.01, 'failed'], [minimum, 'failed'], [minimum + 0.01, 'verified']] as const) {
      const input = fixture({ config: only(key), ...(key === 'volume24h' ? { turnover24hUSDT: value } : { openInterest: { oiUsd: String(value) } }) })
      assert.equal(inspect(input, key).check.status, expected, `${key} ${value}`)
    }
    const missing = fixture({ config: only(key), ...(key === 'volume24h' ? { turnover24hUSDT: null } : { openInterest: { oi: '999999999', oiCcy: '999999999' } }) })
    assert.equal(evaluateLiquidity(missing).status, 'unknown')
  }
})

test('base 24h volume and latest price never substitute for actual quote turnover', () => {
  const config = only('volume24h')
  assert.equal(evaluateLiquidity(fixture({ config, turnover24hUSDT: undefined })).status, 'unknown')
  const first = evaluateLiquidity(fixture({ config, turnover24hUSDT: 29_000_000, ticker: { last: '100', volCcy24h: '1000000' } }))
  const repriced = evaluateLiquidity(fixture({ config, turnover24hUSDT: 29_000_000, ticker: { last: '999999', volCcy24h: '1000000' } }))
  assert.equal(first.turnover, 29_000_000)
  assert.equal(repriced.turnover, first.turnover)
  assert.equal(first.status, 'failed')
  assert.equal(repriced.status, 'failed')
})

test('quote turnover sums precisely 288 actual native 5m amounts at the shared closed boundary', () => {
  const candles = fiveMinuteCandles(), before = structuredClone(candles)
  assert.equal(quoteTurnover24h(candles, asOf), 43_200)
  assert.equal(quoteTurnover24h([...candles].reverse(), asOf + fiveMinutes - 1), 43_200)
  assert.equal(quoteTurnover24h(candles, asOf + fiveMinutes), null)
  assert.equal(quoteTurnover24h(candles, asOf - 1), null)
  const forming = { ...candles[0], timestamp: asOf, confirmed: false, quoteVolume: 1e12 }
  assert.equal(quoteTurnover24h([...candles, forming], asOf + 100), 43_200)
  assert.equal(quoteTurnover24h(candles.map(candle => ({ ...candle, quoteVolume: 0 })), asOf), 0)
  assert.deepEqual(candles, before)
})

test('quote turnover cannot patch missing intervals with duplicates, wrong frames, or estimated amounts', () => {
  const candles = fiveMinuteCandles()
  assert.equal(quoteTurnover24h(candles.slice(1), asOf), null)
  assert.equal(quoteTurnover24h([...candles.slice(1), candles[1]], asOf), null)
  assert.equal(quoteTurnover24h([...candles, candles[1]], asOf), null)
  for (const replacement of [{ timeframe: '15m' }, { timeframe: undefined }, { confirmed: false }, { confirmed: '1' }, { quoteVolume: null }, { quoteVolume: -1 }, { quoteVolume: NaN }, { quoteVolume: '100' }, { timestamp: candles[1].timestamp + 1 }, { instrument: 'ETH-USDT-SWAP' }]) {
    const changed = [...candles]
    changed[1] = { ...changed[1], ...replacement } as QuoteVolumeCandle
    assert.equal(quoteTurnover24h(changed, asOf), null, JSON.stringify(replacement))
  }
  const repriced = candles.map(candle => ({ ...candle, baseVolume: 1e9, close: 1e9 }))
  assert.equal(quoteTurnover24h(repriced, asOf), 43_200)
  assert.equal(quoteTurnover24h(repriced.map(({ quoteVolume: _quote, ...candle }) => candle), asOf), null)
})

test('stability requires the latest 24 consecutive complete native hours and strict ratio boundaries', () => {
  const config = only('volumeStability')
  for (const [largest, expected] of [[199.9999, 'verified'], [200, 'failed'], [200.0001, 'failed']] as const) {
    const { result, check } = inspect(fixture({ config, hourlyCandles: hourly([largest, ...Array<number>(23).fill(100)]) }), 'volumeStability')
    assert.equal(check.status, expected)
    near(result.volumeRatio, largest / 100)
  }
  const candles = hourly()
  assert.equal(evaluateLiquidity(fixture({ config, hourlyCandles: [...candles].reverse() })).status, 'verified')
  for (const bad of [candles.slice(1), [...candles.slice(1), candles[1]], [...candles, candles[1]], candles.map(candle => ({ ...candle, timestamp: candle.timestamp - hour }))]) {
    assert.equal(evaluateLiquidity(fixture({ config, hourlyCandles: bad })).status, 'unknown')
  }
  assert.equal(evaluateLiquidity(fixture({ config, hourlyCandles: candles.map(candle => ({ ...candle, timeframe: '5m' })) })).status, 'unknown')
  assert.equal(evaluateLiquidity(fixture({ config, hourlyCandles: candles.map((candle, index) => index === 1 ? { ...candle, confirmed: false } : candle) })).status, 'unknown')
  assert.equal(evaluateLiquidity(fixture({ config, asOf: Math.floor(asOf / hour) * hour + hour - 1 })).status, 'verified')
  assert.equal(evaluateLiquidity(fixture({ config, asOf: Math.floor(asOf / hour) * hour + hour })).status, 'unknown')
})

test('zero hourly volume is failed, missing hours unknown, and IPC never contains Infinity', () => {
  const config = only('volumeStability')
  for (const volumes of [[0, ...Array<number>(23).fill(100)], Array<number>(24).fill(0)]) {
    const result = evaluateLiquidity(fixture({ config, hourlyCandles: hourly(volumes) }))
    assert.equal(result.status, 'failed')
    assert.equal(result.volumeRatio, null)
    assert.match(result.reasons[0], /zero/)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  }
  assert.equal(evaluateLiquidity(fixture({ config, hourlyCandles: hourly().slice(1) })).status, 'unknown')
})

test('each independent threshold changes qualification and disabling it removes its data requirement', () => {
  const mutations: Record<keyof LiquidityConfig, (config: LiquidityConfig) => void> = {
    spread: config => { config.spread.maxPercent = 0.001 },
    depth: config => { config.depth.minUSDT = 300_000 },
    slippage: config => { config.slippage.notionalUSDT = 300_000 },
    volume24h: config => { config.volume24h.minUSDT = 50_000_000 },
    openInterest: config => { config.openInterest.minUSDT = 7_000_000 },
    volumeStability: config => { config.volumeStability.maxRatio = 1 },
  }
  for (const key of Object.keys(mutations) as (keyof LiquidityConfig)[]) {
    const config = only(key)
    assert.equal(evaluateLiquidity(fixture({ config })).status, 'verified', key)
    mutations[key](config)
    assert.equal(evaluateLiquidity(fixture({ config })).eligible, false, key)
    config[key].enabled = false
    assert.equal(evaluateLiquidity({ instrument, asOf, config }).status, 'verified', key)
  }
})

test('known failed criteria take precedence over missing observations without reusing earlier results', () => {
  const input = fixture()
  assert.equal(evaluateLiquidity(input).status, 'verified')
  input.turnover24hUSDT = 0
  input.book = null
  const result = evaluateLiquidity(input)
  assert.equal(result.status, 'failed')
  assert.equal(result.checks.find(item => item.key === 'volume24h')?.status, 'failed')
  assert.equal(result.checks.find(item => item.key === 'depth')?.status, 'unknown')
  assert.ok(result.reasons.length >= 2)
  for (const key of Object.keys(preferences()) as (keyof LiquidityConfig)[]) {
    const config = only(key)
    const parameter = key === 'spread' || key === 'slippage' ? 'maxPercent' : key === 'volumeStability' ? 'maxRatio' : 'minUSDT'
    for (const invalid of [0, -1, NaN, Infinity, undefined]) {
      Object.assign(config[key], { [parameter]: invalid })
      assert.equal(evaluateLiquidity(fixture({ config })).status, 'unknown', key)
    }
  }
})
