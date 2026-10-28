import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceChartWheel, chartRsiNavigationTarget, chartWheelContentOffset, createChartWheelBatch, createChartWheelScheduler } from './chart-navigation.ts'

function wheelSchedulerHarness() {
  const microtasks: Array<() => void> = []
  const frames = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextFrame = 0
  const scheduler = createChartWheelScheduler({
    queueMicrotask: callback => { microtasks.push(callback) },
    requestFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id },
    cancelFrame: id => { cancelled.push(id); frames.delete(id) },
  })
  return {
    scheduler, microtasks, frames, cancelled,
    runMicrotasks() { while (microtasks.length) microtasks.shift()!() },
    runFrame() {
      const next = frames.entries().next().value
      assert.ok(next, 'Expected an animation frame.')
      const [id, callback] = next
      frames.delete(id)
      callback()
    },
  }
}

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

test('same-turn wheel bursts apply once in a microtask before their frame', () => {
  const { scheduler, microtasks, frames, runMicrotasks, runFrame } = wheelSchedulerHarness()
  const batch = createChartWheelBatch()
  const applied: Array<{ event: number; steps: number; remainderPixels: number; fraction: number }> = []
  for (let event = 0; event < 32; event += 1) {
    batch.add(3)
    scheduler.schedule(() => { applied.push({ event, ...batch.consume(0) }) })
  }
  assert.deepEqual(applied, [])
  assert.equal(microtasks.length, 1)
  assert.equal(frames.size, 1)
  runMicrotasks()
  assert.deepEqual(applied, [{ event: 31, steps: 8, remainderPixels: 0, fraction: 0 }])
  assert.equal(frames.size, 1, 'The leading update must precede the frame.')
  runFrame()
  assert.equal(applied.length, 1, 'An empty trailing frame must not repeat the navigation.')
})

test('later tasks aggregate through the pending frame using the latest callback and remainder', () => {
  const { scheduler, microtasks, frames, runMicrotasks, runFrame } = wheelSchedulerHarness()
  const batch = createChartWheelBatch()
  let remainder = 0
  const applied: Array<{ owner: string; steps: number; remainderPixels: number; fraction: number }> = []
  const input = (pixels: number, owner: string) => {
    batch.add(pixels)
    scheduler.schedule(() => {
      const progress = batch.consume(remainder)
      remainder = progress.remainderPixels
      applied.push({ owner, ...progress })
    })
  }
  input(-9, 'leading')
  runMicrotasks()
  input(-12, 'older metadata')
  runMicrotasks()
  input(3, 'latest metadata')
  assert.equal(microtasks.length, 0, 'Later tasks must wait for the pending frame.')
  assert.equal(frames.size, 1)
  assert.deepEqual(applied, [{ owner: 'leading', steps: 0, remainderPixels: -9, fraction: -0.75 }])
  runFrame()
  assert.deepEqual(applied.at(-1), { owner: 'latest metadata', steps: -1, remainderPixels: -6, fraction: -0.5 })
  input(6, 'next frame')
  runMicrotasks()
  assert.deepEqual(applied.at(-1), { owner: 'next frame', steps: 0, remainderPixels: 0, fraction: 0 })
  runFrame()
  assert.equal(applied.length, 3)
})

test('cancellation and a frame arriving first invalidate stale work even after rescheduling', () => {
  const { scheduler, microtasks, frames, cancelled, runMicrotasks, runFrame } = wheelSchedulerHarness()
  const applied: string[] = []
  scheduler.schedule(() => applied.push('cancelled'))
  const staleFrame = [...frames.values()][0]
  scheduler.cancel()
  assert.deepEqual(cancelled, [1])
  scheduler.schedule(() => applied.push('current'))
  staleFrame()
  assert.equal(applied.length, 0)
  runMicrotasks()
  assert.deepEqual(applied, ['current'])
  scheduler.schedule(() => applied.push('cancelled trailing'))
  scheduler.cancel()
  assert.deepEqual(cancelled, [1, 2])
  assert.equal(frames.size, 0)

  scheduler.schedule(() => applied.push('frame first'))
  const staleMicrotask = microtasks.shift()!
  runFrame()
  scheduler.schedule(() => applied.push('fresh'))
  staleMicrotask()
  assert.deepEqual(applied, ['current', 'frame first'])
  runMicrotasks()
  runFrame()
  assert.deepEqual(applied, ['current', 'frame first', 'fresh'])
})

test('reentrant input joins the trailing frame or starts a fresh frame after it', () => {
  const { scheduler, frames, runMicrotasks, runFrame } = wheelSchedulerHarness()
  const applied: string[] = []
  scheduler.schedule(() => {
    applied.push('leading')
    scheduler.schedule(() => {
      applied.push('trailing')
      scheduler.schedule(() => applied.push('next leading'))
    })
  })
  runMicrotasks()
  assert.deepEqual(applied, ['leading'])
  assert.equal(frames.size, 1)
  runFrame()
  assert.deepEqual(applied, ['leading', 'trailing'])
  assert.equal(frames.size, 1)
  runMicrotasks()
  runFrame()
  assert.deepEqual(applied, ['leading', 'trailing', 'next leading'])
})

test('plot translation follows the wheel fraction only when its adjacent candle is known', () => {
  assert.equal(chartWheelContentOffset(0.25, 10, true, true), -2.5)
  assert.equal(chartWheelContentOffset(-0.5, 10, true, false), 5)
  assert.equal(chartWheelContentOffset(-0.5, 10, false, true), 0)
  assert.equal(chartWheelContentOffset(0.5, 10, true, false), 0)
  assert.equal(chartWheelContentOffset(0.5, 10, true, true), -5)
})
