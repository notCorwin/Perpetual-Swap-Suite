import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capturePriceMoves } from './price-move-signals.ts'

const hour = 3_600_000
const bars = (closes: number[]) => closes.map((close, index) => ({ hour: index * hour, close, confirmed: true }))

test('future move labels preserve the maximum swing before reversal', () => {
  const signals = capturePriceMoves(bars([100, 102, 101.5, 104, 102]))
  assert.deepEqual(signals.map(({ direction, hour: start, exitHour, periods }) => ({ direction, start, exitHour, periods })), [
    { direction: 'long', start: 0, exitHour: 3 * hour, periods: 3 },
    { direction: 'short', start: 3 * hour, exitHour: 4 * hour, periods: 1 },
  ])
  assert.equal(signals[0].changePercent, 4)
})

test('moves must exceed one percent and use the shortest span for equal extrema', () => {
  assert.deepEqual(capturePriceMoves(bars([100, 101])), [])
  const [signal] = capturePriceMoves(bars([100, 100, 102, 102]))
  assert.equal(signal.direction, 'long')
  assert.equal(signal.hour, hour)
  assert.equal(signal.exitHour, 2 * hour)
  assert.equal(signal.periods, 1)
})

test('live candles and gaps cannot leak into hindsight labels', () => {
  const input = bars([100, 102, 90])
  input[2].confirmed = false
  assert.deepEqual(capturePriceMoves(input).map(signal => signal.direction), ['long'])
  assert.deepEqual(capturePriceMoves([input[0], { ...input[1], hour: 2 * hour }]), [])
})

test('High / Low mode captures wick extremes independently from closes', () => {
  const input = [
    { hour: 0, open: 100, high: 100, low: 100, close: 100, confirmed: true },
    { hour, open: 100, high: 103, low: 100.5, close: 100, confirmed: true },
    { hour: 2 * hour, open: 100, high: 102, low: 99, close: 100, confirmed: true },
  ]
  assert.deepEqual(capturePriceMoves(input), [])
  const signals = capturePriceMoves(input, 1, 'highLow')
  assert.deepEqual(signals.map(({ direction, hour: start, exitHour, entryPrice, exitPrice, periods }) =>
    ({ direction, start, exitHour, entryPrice, exitPrice, periods })), [
    { direction: 'long', start: 0, exitHour: hour, entryPrice: 100, exitPrice: 103, periods: 1 },
    { direction: 'short', start: hour, exitHour: 2 * hour, entryPrice: 103, exitPrice: 99, periods: 1 },
  ])
})

test('High / Low candidates rank amplitude before candle count', () => {
  const input = [
    { hour: 0, high: 110, low: 100, close: 105, confirmed: true },
    { hour, high: 108, low: 90, close: 100, confirmed: true },
  ]
  const [signal] = capturePriceMoves(input, 1, 'highLow')
  assert.equal(signal.direction, 'short')
  assert.equal(signal.changePercent, (90 - 110) / 110 * 100)
})
