import assert from 'node:assert/strict'
import test from 'node:test'
import { chartStatisticsSamples } from './chart-legend.ts'

test('default statistics legends use independent latest visible observations', () => {
  const bars = [
    { hour: 1, oi: 100, buy: 10, sell: 20 },
    { hour: 2, oi: null, buy: 30, sell: 40 },
    { hour: 3, oi: 200, buy: null, sell: null },
    { hour: 4, oi: null, buy: null, sell: null },
  ]
  const samples = chartStatisticsSamples(bars, null)
  assert.equal(samples.oi, bars[2])
  assert.equal(samples.taker, bars[1])
  assert.deepEqual(chartStatisticsSamples(bars.slice(3), null), { oi: null, taker: null })
  assert.deepEqual(chartStatisticsSamples([], null), { oi: null, taker: null })
})

test('inspection never substitutes a different candle for missing statistics', () => {
  const bars = [
    { hour: 1, oi: 100, buy: 10, sell: 20 },
    { hour: 2, oi: null, buy: null, sell: null },
    { hour: 3, oi: 200, buy: 30, sell: 40 },
  ]
  assert.deepEqual(chartStatisticsSamples(bars, 1), { oi: null, taker: null })
  assert.deepEqual(chartStatisticsSamples(bars, 0), { oi: bars[0], taker: bars[0] })
  assert.deepEqual(chartStatisticsSamples(bars, 2), { oi: bars[2], taker: bars[2] })
})

test('zero observations are valid, while Taker pairs must share a complete candle', () => {
  const bars = [
    { hour: 1, oi: 100, buy: 10, sell: 20 },
    { hour: 2, oi: 0, buy: 0, sell: 0 },
    { hour: 3, oi: NaN, buy: 30, sell: null },
    { hour: 4, oi: Infinity, buy: null, sell: 40 },
  ]
  assert.deepEqual(chartStatisticsSamples(bars, null), { oi: bars[1], taker: bars[1] })
  bars[3] = { hour: 4, oi: 300, buy: 50, sell: 60 }
  assert.deepEqual(chartStatisticsSamples(bars, null), { oi: bars[3], taker: bars[3] })
})
