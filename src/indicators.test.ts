import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { barsWithIndicators } from '../electron/services/indicators.js'

const candles = Array.from({ length: 220 }, (_, index) => ({ timestamp: index * 300_000, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, quoteVolume: 1_000 + index, oi: 50_000 + index, buy: 100 + index, sell: 90 + index, confirmed: true }))
test('market indicators are calculated from persisted candle history', () => {
  const bars = barsWithIndicators(candles), latest = bars.at(-1)!
  assert.equal(bars.length, candles.length)
  assert.ok(latest.ema !== null)
  assert.ok(latest.vwap !== null)
  assert.ok(latest.logBBUpper !== null)
  assert.ok(latest.rsi6 !== null && latest.rsi12 !== null && latest.rsi24 !== null)
  assert.ok(latest.roc !== null && latest.maroc !== null)
  assert.equal(latest.oi, 50_219)
  assert.equal(latest.buy, 319)
  assert.equal(latest.sell, 309)
})

test('indicators restart after a candle gap instead of bridging missing history', () => {
  const first = Array.from({ length: 220 }, (_, index) => ({ timestamp: index * 300_000, open: 100, high: 101, low: 99, close: 100 + index, quoteVolume: 1, confirmed: true }))
  const afterGap = Array.from({ length: 96 }, (_, index) => ({ timestamp: (300 + index) * 300_000, open: 200, high: 201, low: 199, close: 200 + index, quoteVolume: 1, confirmed: true }))
  const bars = barsWithIndicators([...first, ...afterGap])
  assert.equal(bars.at(-1)?.ema, null)
})

test('Log BB uses exactly 20 log-price samples and population deviation with a two-sigma band', () => {
  // A log-linear sequence has an independent closed-form mean and variance.
  // The first nine values deliberately differ, so a nine-period band fails.
  const source = Array.from({ length: 30 }, (_, index) => ({ timestamp: index * 300_000,
    open: Math.exp(index / 10), high: Math.exp(index / 10), low: Math.exp(index / 10),
    close: Math.exp(index / 10), quoteVolume: 1, confirmed: true }))
  const bars = barsWithIndicators(source)
  assert.equal(bars[18].logBBMiddle, null)
  const mean = (10 + 29) / 2 / 10
  const deviation = Math.sqrt((20 * 20 - 1) / 12) / 10
  assert.ok(Math.abs(bars[29].logBBMiddle! - Math.exp(mean)) < 1e-12)
  assert.ok(Math.abs(bars[29].logBBUpper! - Math.exp(mean + 2 * deviation)) < 1e-12)
  assert.ok(Math.abs(bars[29].logBBLower! - Math.exp(mean - 2 * deviation)) < 1e-12)
})

test('RSI seeds Wilder smoothing with average gains and losses rather than their sums', () => {
  const closes = [100, 102, 101, 104, 102, 103, 100, 104]
  const source = closes.map((close, index) => ({ timestamp: index * 300_000, open: close, high: close, low: close, close, confirmed: true }))
  const bars = barsWithIndicators(source)
  assert.equal(bars[6].rsi6, 50)
  // Initial averages are both1. The next+4 move gives averages9/6 and5/6,
  // hence RSI=100−100/(1+9/5)=450/7.
  assert.ok(Math.abs(bars[7].rsi6! - 450 / 7) < 1e-12)
})
