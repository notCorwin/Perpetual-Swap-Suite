import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capturePriceMoves } from './price-move-signals.ts'

const hour = 3_600_000
const bars = (closes: number[]) => closes.map((close, index) => ({ hour: index * hour, close, confirmed: true }))

test('future move labels rank globally strongest non-overlapping moves', () => {
  const signals = capturePriceMoves(bars([100, 102, 101.5, 104, 102]))
  assert.deepEqual(signals.map(({ direction, hour: start, exitHour, periods, rank }) => ({ direction, start, exitHour, periods, rank })), [
    { direction: 'long', start: 0, exitHour: 3 * hour, periods: 3, rank: 1 },
    { direction: 'short', start: 3 * hour, exitHour: 4 * hour, periods: 1, rank: 2 },
  ])
  assert.equal(signals[0].changePercent, 4)
})

test('a temporary reversal does not split a larger future move', () => {
  const [signal] = capturePriceMoves(bars([100, 103, 101, 110]))
  assert.equal(signal.direction, 'long')
  assert.equal(signal.hour, 0)
  assert.equal(signal.exitHour, 3 * hour)
  assert.equal(signal.changePercent, 10)
})

test('efficiency objective prefers more movement per candle over total amplitude', () => {
  const input = bars([100, 102, 102.8, 103.6, 104.4, 105.2, 106, 106.8, 107.6, 108.4, 109.2, 110])
  const [amplitude] = capturePriceMoves(input)
  assert.equal(amplitude.hour, 0)
  assert.equal(amplitude.exitHour, 11 * hour)
  assert.equal(amplitude.changePercent, 10)
  const [efficient] = capturePriceMoves(input, 1, 'close', 'efficiency')
  assert.equal(efficient.hour, 0)
  assert.equal(efficient.exitHour, hour)
  assert.equal(efficient.changePercent, 2)
  assert.equal(efficient.efficiencyScore, 2)
  assert.equal(efficient.rank, 1)
  const noTimePenalty = capturePriceMoves(input, 1, 'close', 'efficiency', 0).find(signal => signal.rank === 1)!
  assert.equal(noTimePenalty.exitHour, 11 * hour)
  const strongerTimePenalty = capturePriceMoves(input, 1, 'close', 'efficiency', 2).find(signal => signal.rank === 1)!
  assert.equal(strongerTimePenalty.exitHour, hour)
})

test('efficiency objective ranks every non-overlapping move above the amplitude threshold', () => {
  const signals = capturePriceMoves(bars([100, 102, 100, 103]), 1, 'close', 'efficiency')
  assert.deepEqual(signals.map(({ direction, hour: start, exitHour, rank }) => ({ direction, start, exitHour, rank })), [
    { direction: 'long', start: 0, exitHour: hour, rank: 2 },
    { direction: 'short', start: hour, exitHour: 2 * hour, rank: 3 },
    { direction: 'long', start: 2 * hour, exitHour: 3 * hour, rank: 1 },
  ])
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
