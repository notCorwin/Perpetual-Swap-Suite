import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecorderSelfTiming } from '../../electron/services/recorder-self-timing.js'

test('bulk recorder timing separates elapsed waiting from thread CPU and preserves operation results and errors', () => {
  let wall = 10, cpu = 3
  const timing = createRecorderSelfTiming({ now: () => wall, timeOrigin: 1_000, cpuTime: () => cpu })
  const result = {}
  assert.equal(timing.measure('batch-build', () => { wall = 30; cpu = 3.5; return result }), result)
  const failure = new Error('Injected disk failure')
  assert.throws(() => timing.measure('health-publish', () => { wall = 42; cpu = 3.75; throw failure }), error => error === failure)
  const snapshot = timing.snapshot()
  assert.deepEqual(snapshot.slowSamples, [
    { stage: 'batch-build', startedAt: 1_010, endedAt: 1_030, durationMS: 20, cpuTimeMS: .5, status: 'ok' },
    { stage: 'health-publish', startedAt: 1_030, endedAt: 1_042, durationMS: 12, cpuTimeMS: .25, status: 'error' },
  ])
  assert.equal(snapshot.stages['batch-build'].totalMS, 20)
  assert.equal(snapshot.stages['batch-build'].totalCPUTimeMS, .5)
  assert.equal(snapshot.stages['health-publish'].failed, 1)
})

test('slow recorder evidence is bounded and reports overflow without losing its aggregate', () => {
  let wall = 0
  const timing = createRecorderSelfTiming({ now: () => wall, timeOrigin: 1_000, cpuTime: null })
  for (let index = 0; index < 40; index++) timing.measure('pressure-write', () => { wall += 8 })
  const snapshot = timing.snapshot()
  assert.equal(snapshot.sampleLimit, 32)
  assert.equal(snapshot.sampleRetention, 'latest')
  assert.equal(snapshot.slowSamples.length, 32)
  assert.equal(snapshot.droppedSlowSamples, 8)
  assert.equal(snapshot.stages['pressure-write'].count, 40)
  assert.equal(snapshot.stages['pressure-write'].totalMS, 320)
  assert.equal(snapshot.slowSamples[0].startedAt, 1_064)
  assert.equal(snapshot.slowSamples.at(-1).endedAt, 1_320)
})

test('retained recorder snapshots neither change on future work nor expose mutable recorder state', () => {
  let wall = 0
  const timing = createRecorderSelfTiming({ now: () => wall, timeOrigin: 1_000, cpuTime: null })
  timing.measure('batch-build', () => { wall += 8 })
  const retained = timing.snapshot()
  timing.measure('batch-build', () => { wall += 2 })
  assert.equal(retained.stages['batch-build'].count, 1)
  assert.equal(retained.stages['batch-build'].totalMS, 8)
  retained.slowSamples[0].durationMS = -1
  retained.stages['batch-build'].count = -1
  const current = timing.snapshot()
  assert.equal(current.stages['batch-build'].count, 2)
  assert.equal(current.stages['batch-build'].totalMS, 10)
  assert.equal(current.slowSamples[0].durationMS, 8)
  assert.equal(current.cpuClock, null)
  assert.equal(current.stages['batch-build'].cpuMeasuredCount, 0)
})
