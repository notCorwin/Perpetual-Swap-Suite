import assert from 'node:assert/strict'
import test from 'node:test'
import { ema, rsi } from './lib/indicators.ts'
import type { Candle } from './types.ts'

const candles = Array.from({ length: 20 }, (_, index): Candle => ({
  instrument: 'TEST-USDT-SWAP', timestamp: index * 300_000,
  open: index + 1, high: index + 1, low: index + 1, close: index + 1,
  volumeContracts: 1, volumeBase: null, volumeQuote: null, confirmed: true,
}))

test('EMA produces one value for every candle', () => {
  const values = ema(candles, 5)
  assert.equal(values.length, candles.length)
  assert.equal(values[0], 1)
  assert.ok(values.at(-1)! < 20)
})

test('RSI waits for its warmup and recognizes an uninterrupted rise', () => {
  const values = rsi(candles, 14)
  assert.equal(values[13], null)
  assert.equal(values[14], 100)
})
