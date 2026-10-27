import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceChartWheel, chartRsiNavigationTarget, chartWheelContentOffset, createChartWheelBatch } from './chart-navigation.ts'

test('RSI keyboard navigation excludes overscan crossings and stops at visible boundaries', () => {
  const indices = [-1, 0, 25, 25, 60, -1]
  assert.equal(chartRsiNavigationTarget(indices, 0, -1), undefined)
  assert.equal(chartRsiNavigationTarget(indices, 25, -1), 0)
  assert.equal(chartRsiNavigationTarget(indices, -1, 1), 0)
  assert.equal(chartRsiNavigationTarget(indices, 60, 1), undefined)
  assert.equal(chartRsiNavigationTarget(indices, -1, -1), undefined, 'Moving outward from a left neighbour cannot wrap to the last crossing.')
  assert.equal(chartRsiNavigationTarget(indices, 96, 1), undefined, 'Moving outward from a right neighbour cannot wrap to the first crossing.')
})

test('wheel input moves by fractions immediately and commits exactly the accumulated whole bars', () => {
  let remainder = 0
  const progress = [3, 3, 3, 3].map(pixels => {
    const next = advanceChartWheel(remainder, pixels)
    remainder = next.remainderPixels
    return [next.steps, next.fraction]
  })
  assert.deepEqual(progress, [[0, 0.25], [0, 0.5], [0, 0.75], [1, 0]])
  assert.equal(remainder, 0)
})

test('opposite input cancels immediately and boundary overflow never accumulates', () => {
  const first = advanceChartWheel(0, -9)
  assert.deepEqual(first, { steps: 0, remainderPixels: -9, fraction: -0.75 })
  assert.deepEqual(advanceChartWheel(first.remainderPixels, 3), { steps: 0, remainderPixels: -6, fraction: -0.5 })
  const boundary = advanceChartWheel(0, 10_003)
  assert.equal(boundary.steps, 833)
  assert.equal(boundary.remainderPixels, 7)
  assert.equal(advanceChartWheel(boundary.remainderPixels, -7).fraction, 0)
})

test('same-frame wheel bursts produce one accumulated navigation update', () => {
  const batch = createChartWheelBatch()
  for (let event = 0; event < 32; event += 1) batch.add(3)
  assert.equal(batch.pending, true)
  const progress = batch.consume(0)
  assert.deepEqual(progress, { steps: 8, remainderPixels: 0, fraction: 0 })
  assert.equal(batch.pending, false)

  batch.add(3)
  assert.deepEqual(batch.consume(0), { steps: 0, remainderPixels: 3, fraction: 0.25 },
    'A 3 px input frame updates the sub-bar offset without waiting for a whole candle.')
})

test('plot translation follows the wheel fraction only when its adjacent candle is known', () => {
  assert.equal(chartWheelContentOffset(0.25, 10, true, true), -2.5)
  assert.equal(chartWheelContentOffset(-0.5, 10, true, false), 5)
  assert.equal(chartWheelContentOffset(-0.5, 10, false, true), 0)
  assert.equal(chartWheelContentOffset(0.5, 10, true, false), 0)
  assert.equal(chartWheelContentOffset(0.5, 10, true, true), -5)
})
