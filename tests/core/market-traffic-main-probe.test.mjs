import assert from 'node:assert/strict'
import test from 'node:test'
import { installMarketTrafficMainProbe } from '../../scripts/market-traffic-main-probe.mjs'

function harness(options = {}) {
  let wall = 10, cpu = { user: 100, system: 20 }, callback, cancelled = false, reads = 0
  const target = {}
  const runtime = { target, timeOriginMS: 1_000, now: () => wall,
    readCPU: () => { reads++; wall += .25; return { ...cpu } },
    schedule: (handler, interval) => { callback = handler; assert.equal(interval, 20); return 42 },
    cancel: id => { assert.equal(id, 42); cancelled = true } }
  installMarketTrafficMainProbe(null, { ...options, runtime })
  const stop = target.__marketTrafficMainLoop.stop
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
  assert.equal(host.cancelled, true)
  assert.equal(host.target.__marketTrafficMainLoop, undefined)
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
  assert.equal(report.captureCostMS, 1.25)
})

test('main-loop witness refuses replacement of an active sample', () => {
  const host = harness()
  assert.throws(() => installMarketTrafficMainProbe(null, { runtime: host.runtime }), /already installed/)
  host.stop()
  assert.doesNotThrow(() => installMarketTrafficMainProbe(null, { runtime: host.runtime }))
  host.target.__marketTrafficMainLoop.stop()
})
