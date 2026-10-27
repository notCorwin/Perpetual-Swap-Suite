import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemorySampler } from '../../scripts/operation-overhead-memory.mjs'

function fixture() {
  let memory = { rss: 10, heapUsed: 5 }
  let reads = 0
  const timers = [], cancelled = []
  const sampler = createMemorySampler({
    read: () => { reads++; return memory },
    schedule: (callback, interval) => {
      const timer = { callback, interval, unrefs: 0, unref() { this.unrefs++ } }
      timers.push(timer)
      return timer
    },
    cancel: timer => cancelled.push(timer),
  })
  return { sampler, timers, cancelled, reads: () => reads, memory: (rss, heapUsed) => { memory = { rss, heapUsed } } }
}

test('the default sampler preserves RSS and heap peaks without a full process-memory scan', () => {
  const original = process.memoryUsage
  let rss = 100, reads = 0, tick
  const fullScan = () => { throw new Error('The sampler must not request unmeasured process counters.') }
  fullScan.rss = () => { reads++; return rss }
  process.memoryUsage = fullScan
  try {
    const sampler = createMemorySampler({ schedule: callback => { tick = callback; return 0 }, cancel() {} })
    const window = sampler.begin()
    rss = 300
    tick()
    rss = 200
    const result = window.end()
    assert.equal(reads, 3)
    assert.deepEqual(Object.keys(window.initial).sort(), ['heapUsed', 'rss'])
    assert.ok(window.initial.heapUsed > 0 && result.final.heapUsed > 0)
    assert.equal(result.peakRSSBytes, 300)
    assert.ok(result.peakHeapBytes >= Math.max(window.initial.heapUsed, result.final.heapUsed))
    assert.equal(sampler.snapshot().intervalMS, 5)
  } finally {
    process.memoryUsage = original
  }
})

test('overlapping windows share one 5 ms scan and observe all boundary scans', () => {
  const f = fixture()
  const outer = f.sampler.begin()
  f.memory(30, 8)
  const inner = f.sampler.begin()
  assert.equal(f.timers.length, 1)
  assert.equal(f.timers[0].interval, 5)
  assert.equal(f.timers[0].unrefs, 1)
  assert.equal(f.reads(), 2)
  f.memory(20, 40)
  f.timers[0].callback()
  assert.equal(f.reads(), 3, 'A tick scans once even with two active windows.')
  f.memory(50, 12)
  const innerResult = inner.end()
  assert.deepEqual(inner.initial, { rss: 30, heapUsed: 8 })
  assert.deepEqual(innerResult, { final: { rss: 50, heapUsed: 12 }, peakRSSBytes: 50, peakHeapBytes: 40 })
  assert.equal(f.cancelled.length, 0)
  f.memory(15, 6)
  assert.deepEqual(outer.end(), { final: { rss: 15, heapUsed: 6 }, peakRSSBytes: 50, peakHeapBytes: 40 })
  assert.deepEqual(outer.initial, { rss: 10, heapUsed: 5 })
  assert.deepEqual(f.cancelled, [f.timers[0]])
  assert.deepEqual(f.sampler.snapshot(), { intervalMS: 5, reads: 5, scheduledSamples: 1, activeWindows: 0, timerActive: false })
})

test('completed windows retain isolated peaks and repeated end performs no scan', () => {
  const f = fixture()
  const outer = f.sampler.begin()
  const inner = f.sampler.begin()
  const result = inner.end()
  const before = f.reads()
  assert.equal(inner.end(), result)
  assert.equal(f.reads(), before)
  f.memory(100, 200)
  f.timers[0].callback()
  assert.equal(result.peakRSSBytes, 10)
  assert.equal(result.peakHeapBytes, 5)
  assert.equal(outer.end().peakHeapBytes, 200)
  f.timers[0].callback()
  const stopped = f.reads()
  assert.equal(outer.end().peakRSSBytes, 100)
  assert.equal(f.reads(), stopped)
})

test('the final window stops sampling and a later window starts a new timer', () => {
  const f = fixture()
  const first = f.sampler.begin()
  first.end()
  assert.deepEqual(f.cancelled, [f.timers[0]])
  f.memory(1, 2)
  const second = f.sampler.begin()
  assert.equal(f.timers.length, 2)
  assert.deepEqual(second.end(), { final: { rss: 1, heapUsed: 2 }, peakRSSBytes: 1, peakHeapBytes: 2 })
  assert.deepEqual(f.cancelled, f.timers)
})

test('a zero-valued timer handle is cancelled and does not create duplicate timers', () => {
  const scheduled = [], cancelled = []
  const sampler = createMemorySampler({ read: () => ({ rss: 1, heapUsed: 2 }), schedule: (...args) => { scheduled.push(args); return 0 }, cancel: id => cancelled.push(id) })
  const first = sampler.begin(), second = sampler.begin()
  assert.equal(scheduled.length, 1)
  first.end()
  second.end()
  assert.deepEqual(cancelled, [0])
  assert.equal(sampler.snapshot().timerActive, false)
})
