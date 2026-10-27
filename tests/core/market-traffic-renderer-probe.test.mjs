import assert from 'node:assert/strict'
import test from 'node:test'
import { installMarketTrafficRendererProbe } from '../../scripts/market-traffic-renderer-probe.mjs'

function browser({ observeLongFrames = true } = {}) {
  let now = 10, nextFrame = 1, resultCount = 1
  const frames = new Map(), listeners = new Map(), windowListeners = new Map(), observers = []
  const events = store => ({
    addEventListener: (name, callback) => { store.set(name, callback) },
    removeEventListener: (name, callback) => { assert.equal(store.get(name), callback); store.delete(name) },
  })
  class Observer {
    static supportedEntryTypes = observeLongFrames ? ['long-animation-frame'] : []
    constructor(callback) { this.callback = callback; this.queued = []; this.disconnected = false; observers.push(this) }
    observe(options) { assert.deepEqual(options, { type: 'long-animation-frame' }) }
    takeRecords() { return this.queued.splice(0) }
    disconnect() { this.disconnected = true }
    deliver(entries) { this.callback({ getEntries: () => entries }) }
  }
  const host = {
    performance: { timeOrigin: 1793140680000, now: () => now },
    document: { ...events(listeners), visibilityState: 'visible', hasFocus: () => true,
      querySelector: () => ({ getAttribute: () => String(resultCount) }) },
    window: events(windowListeners), PerformanceObserver: Observer,
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id },
    cancelAnimationFrame: id => { frames.delete(id) },
  }
  return {
    host, frames, listeners, windowListeners, observers,
    setNow(value) { now = value },
    frame(timestampMS, callbackAtMS = timestampMS) {
      now = callbackAtMS
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(timestampMS)
    },
    input(term, count = 1) {
      resultCount = count
      listeners.get('input')({ target: { getAttribute: () => 'Search contracts', value: term } })
    },
  }
}

test('formal renderer evidence preserves RAF timestamps separately from callback scheduling delay', () => {
  const fixture = browser()
  installMarketTrafficRendererProbe({ requireForeground: true, passingIDs: ['T000-USDT-SWAP', 'T001-USDT-SWAP'] }, fixture.host)
  fixture.frame(16, 17)
  fixture.setNow(20)
  fixture.input('T000')
  fixture.frame(32, 33)
  fixture.frame(160, 175)
  fixture.setNow(180)
  const report = fixture.host.__marketTrafficResponsiveness.stop()

  assert.deepEqual(report.clock, { timeOriginMS: 1793140680000, startedAtMS: 10, stoppedAtMS: 180 })
  assert.equal(report.elapsedMS, 170)
  assert.deepEqual(report.rafTimeline.samples, [
    { timestampMS: 16, callbackAtMS: 17 }, { timestampMS: 32, callbackAtMS: 33 }, { timestampMS: 160, callbackAtMS: 175 },
  ])
  // The acceptance gap stays the RAF timestamp difference, rather than the
  // callback difference (142 ms) or callback delay from its RAF timestamp (15 ms).
  assert.deepEqual(report.rafOpportunityGapMS.samples, [16, 128])
  assert.equal(report.rafOpportunityGapMS.max, 128)
  assert.equal(report.frameCount, 2)
  assert.deepEqual(report.searchInputToSecondRAFMS.samples, [{ term: 'T000', startedMS: 10, completedMS: 165,
    durationMS: 155, expectedResultCount: 1, actualResultCount: 1, correct: true }])
  assert.equal(report.presentation.totalViolations, 0)
})

test('stop drains queued LoAF timings, bounds them to the measured interval, and removes pending work', () => {
  const fixture = browser()
  installMarketTrafficRendererProbe({ requireForeground: true, passingIDs: ['T000-USDT-SWAP'] }, fixture.host)
  const observer = fixture.observers[0]
  observer.deliver([{ startTime: 0, duration: 5 }, { startTime: 5, duration: 65, blockingDuration: 0, renderStart: 69,
    styleAndLayoutStart: 69.1, firstUIEventTimestamp: 0, paintTime: 69.9, presentationTime: 70,
    scripts: [{ startTime: 6, duration: 1, executionStart: 6.1, forcedStyleAndLayoutDuration: 0,
      pauseDuration: 0, invoker: 'Window.requestAnimationFrame', invokerType: 'user-callback',
      sourceURL: 'app://renderer.js', sourceFunctionName: 'frame', sourceCharPosition: 50, windowAttribution: 'self' }] }])
  fixture.frame(16, 17)
  fixture.setNow(20)
  fixture.input('T000')
  observer.queued.push({ startTime: 110, duration: 95, blockingDuration: 0, renderStart: 204.9 }, { startTime: 210, duration: 60 })
  fixture.setNow(200)
  const report = fixture.host.__marketTrafficResponsiveness.stop()

  assert.deepEqual(report.longAnimationFrames, { supported: true, samples: [
    { startTimeMS: 5, durationMS: 65, blockingDurationMS: 0, renderStartMS: 69, styleAndLayoutStartMS: 69.1,
      firstUIEventTimestampMS: 0, paintTimeMS: 69.9, presentationTimeMS: 70,
      scripts: [{ startTimeMS: 6, durationMS: 1, executionStartMS: 6.1, forcedStyleAndLayoutDurationMS: 0, pauseDurationMS: 0,
        invoker: 'Window.requestAnimationFrame', invokerType: 'user-callback', sourceURL: 'app://renderer.js',
        sourceFunctionName: 'frame', sourceCharPosition: 50, windowAttribution: 'self' }] },
    { startTimeMS: 110, durationMS: 95, blockingDurationMS: 0, renderStartMS: 204.9, scripts: [] },
  ] })
  assert.equal(observer.disconnected, true)
  assert.equal(fixture.frames.size, 0)
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.windowListeners.size, 0)
  assert.equal(report.searchInputToSecondRAFMS.sampleCount, 0)
  fixture.frame(220, 220)
  assert.equal(report.rafTimeline.samples.length, 1)
  assert.equal(fixture.host.__marketTrafficResponsiveness.stop(), report)
  assert.equal(report.clock.stoppedAtMS, 200)
})

test('unsupported LoAF observation does not change RAF or input acceptance evidence', () => {
  const fixture = browser({ observeLongFrames: false })
  installMarketTrafficRendererProbe({ requireForeground: false, passingIDs: ['T000-USDT-SWAP'] }, fixture.host)
  fixture.setNow(11)
  fixture.input('', 1)
  fixture.frame(16, 17)
  fixture.frame(32, 33)
  const report = fixture.host.__marketTrafficResponsiveness.stop()
  assert.deepEqual(report.longAnimationFrames, { supported: false, samples: [] })
  assert.equal(report.searchInputToSecondRAFMS.sampleCount, 1)
  assert.equal(report.searchInputToSecondRAFMS.samples[0].correct, true)
  assert.equal(report.rafOpportunityGapMS.max, 16)
})
