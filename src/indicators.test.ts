import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { barsWithIndicators } from '../electron/services/indicators.js'

const candles = Array.from({ length: 220 }, (_, index) => ({ timestamp: index * 300_000, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, quoteVolume: 1_000 + index, confirmed: true }))
test('market indicators are calculated from persisted candle history', () => {
  const bars = barsWithIndicators(candles), latest = bars.at(-1)!
  assert.equal(bars.length, candles.length)
  assert.ok(latest.ema !== null)
  assert.ok(latest.vwap !== null)
  assert.ok(latest.logBBUpper !== null)
  assert.ok(latest.rsi6 !== null && latest.rsi12 !== null && latest.rsi24 !== null)
  assert.ok(latest.roc !== null && latest.maroc !== null)
})
