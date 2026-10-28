import assert from 'node:assert/strict'
import test from 'node:test'
import { installMainLoopWitness, startNodeDriverLoopWitness } from '../../scripts/main-loop-witness.mjs'

function harness(options = {}) {
  let wall = 10, cpu = { user: 100, system: 20 }, callback, cancelled = false, reads = 0
  const target = {}
  const runtime = { target, timeOriginMS: 1_000, now: () => wall,
    readCPU: () => { reads++; wall += .25; return { ...cpu } },
    schedule: (handler, interval) => { callback = handler; assert.equal(interval, 20); return 42 },
    cancel: id => { assert.equal(id, 42); cancelled = true } }
  installMainLoopWitness(null, { ...options, runtime })
  const stop = target.__mainLoopWitness.stop
  return { target, runtime, stop, fire: () => callback(), advance: (nextWall, nextCPU = cpu) => { wall = nextWall; cpu = nextCPU },
    get cancelled() { return cancelled }, get reads() { return reads } }
}

test('main-loop witness retains an aligned scheduling gap separately from actual thread CPU', () => {
  const host = harness()
  host.advance(30, { user: 102, system: 21 }); host.fire()
  host.advance(175, { user: 104, system: 22 }); host.fire()
  host.advance(195, { user: 106, system: 23 })
  const report = host.stop()
  assert.equal(report.timeOriginMS + report.samples[2].callbackAtMS, 1_175)
  assert.equal(report.samples[2].callbackAtMS - report.samples[1].callbackAtMS, 145)
  assert.equal(report.samples[2].threadCPUUS.user - report.samples[1].threadCPUUS.user, 2)
  assert.equal(report.samples[2].threadCPUUS.system - report.samples[1].threadCPUUS.system, 1)
  assert.deepEqual(report.samples.map(sample => sample.kind), ['start', 'timer', 'timer', 'stop'])
  assert.equal(report.captureCostMS, 1)
  assert.equal(report.maxCaptureCostMS, .25)
  assert.equal(report.omittedSamples, 0)
  assert.equal(report.complete, true)
  assert.equal(report.pid, process.pid)
  assert.equal(report.threadId, 0)
  assert.equal(report.isMainThread, true)
  assert.equal(report.sampleCount, 4)
  assert.equal(report.totalSamples, 4)
  assert.match(report.sampleRetention, /reserved final stop/)
  assert.equal(host.cancelled, true)
  assert.equal(host.target.__mainLoopWitness, undefined)
  const reads = host.reads
  host.fire()
  assert.equal(host.reads, reads, 'A queued callback after cleanup must not mutate the retained report.')
  assert.equal(host.stop(), report)
})

test('main-loop witness reports capacity loss and always retains its stop timestamp', () => {
  const host = harness({ capacity: 3 })
  host.advance(30); host.fire()
  host.advance(50); host.fire()
  host.advance(70); host.fire()
  host.advance(90)
  const report = host.stop()
  assert.deepEqual(report.samples.map(sample => sample.callbackAtMS), [10, 30, 90])
  assert.equal(report.omittedSamples, 2)
  assert.equal(report.complete, false)
  assert.equal(report.totalSamples, 5)
  assert.equal(report.captureCostMS, 1.25)
})

test('main-loop witness refuses replacement of an active sample', () => {
  const host = harness()
  assert.throws(() => installMainLoopWitness(null, { runtime: host.runtime }), /already installed/)
  host.stop()
  assert.doesNotThrow(() => installMainLoopWitness(null, { runtime: host.runtime }))
  host.target.__mainLoopWitness.stop()
})

test('Node driver witnesses own separate timers and preserve explicit process/thread identity', () => {
  const first = startNodeDriverLoopWitness({ capacity: 2 }), second = startNodeDriverLoopWitness({ capacity: 2 })
  try {
    assert.equal(globalThis.__mainLoopWitness, undefined)
    const report = first.stop()
    assert.equal(report.role, 'node-driver')
    assert.equal(report.pid, process.pid)
    assert.equal(report.threadId, 0)
    assert.equal(report.intervalMS, 20)
    assert.ok(report.timeOriginMS > 0)
    assert.equal(report.complete, true)
    assert.equal(first.stop(), report)
    assert.equal(second.stop().complete, true)
  } finally { first.stop(); second.stop() }
})

test('failed samples and cancellation retain explicit loss while releasing the owned target', () => {
  let callback, fail = false, cancelled = false
  const target = {}
  installMainLoopWitness(null, { ownerId: 'owned', runtime: { target, timeOriginMS: 1_000, now: () => 10,
    readCPU: () => { if (fail) throw new Error('CPU read failed'); return { user: 1, system: 1 } },
    schedule: operation => { callback = operation; return 1 },
    cancel: () => { cancelled = true; throw new Error('Cancel failed') } } })
  const stop = target.__mainLoopWitness.stop
  fail = true
  callback()
  const report = stop()
  assert.equal(cancelled, true)
  assert.equal(target.__mainLoopWitness, undefined)
  assert.equal(report.complete, false)
  assert.equal(report.totalSamples, 3)
  assert.equal(report.sampleCount, 1)
  assert.deepEqual(report.captureErrors.map(error => error.stage), ['timer', 'cancel', 'stop'])
  callback()
  assert.equal(report.totalSamples, 3)
})

test('a scheduling failure cleans up its partially installed witness and retains final evidence', () => {
  const target = {}, failure = new Error('Schedule failed')
  assert.throws(() => installMainLoopWitness(null, { runtime: { target,
    schedule: () => { throw failure } } }), error => {
    assert.equal(error, failure)
    assert.deepEqual(error.mainLoopWitness.samples.map(sample => sample.kind), ['start', 'stop'])
    return true
  })
  assert.equal(target.__mainLoopWitness, undefined)
})
