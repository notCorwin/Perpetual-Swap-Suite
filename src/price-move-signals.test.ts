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
