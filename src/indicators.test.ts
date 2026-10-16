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
