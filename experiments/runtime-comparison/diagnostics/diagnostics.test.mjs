import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { initializeOperationTelemetry } from '../telemetry-off.ts'

const source = await readFile(new URL('../timing-probes.js', import.meta.url), 'utf8')

test('telemetry-off retains notification decoding without recording or timers', async () => {
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  const events = []; let hooks, initializations = 0
  globalThis.window = { radarDesktop: { async initializeOperations(value) { initializations++; hooks = value; return {} } },
    dispatchEvent(event) { events.push(event); return true } }
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail } }
  try {
    const cleanup = await initializeOperationTelemetry()
    assert.equal(initializations, 1)
    const first = hooks.beginRequest('snapshot'), second = hooks.beginRequest('chartWindow')
    assert.notEqual(first.id, second.id)
    assert.deepEqual(first.context, {})
    hooks.endRequest(first.id, 'ok')
    hooks.receive('radar:chart-prepared', 'wire', undefined, value => ({ decoded: value }))
    hooks.receive('radar:market-changed', 7)
    assert.equal(events[0].type, 'radar-chart-prepared')
    assert.deepEqual(events[0].detail, { decoded: 'wire' })
    assert.equal(events[1].type, 'radar-market-changed')
    assert.equal(events[1].detail, 7)
    assert.throws(() => hooks.receive('radar:chart-prepared', 'bad', undefined, () => { throw new Error('bad wire') }), /bad wire/)
    await hooks.flush(); await cleanup()
  } finally { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent }
})

function browser({ observerTypes = ['longtask'] } = {}) {
  let clock = 0
  const observers = []
  class Element {
    setAttribute(name, value) { if (name === '!') throw new Error('bad name'); this[name] = value }
    getBoundingClientRect() { return { width: 10 } }
  }
  class SVGElement extends Element {}
  class SVGGraphicsElement extends SVGElement { getBBox() { return { width: 5 } } }
  class TextEncoder {
    encode(value = '') { return new Uint8Array(String(value).length) }
    encodeInto(value, target) { const written = Math.min(value.length, target.length); return { read: written, written } }
  }
  class Observer {
    static supportedEntryTypes = observerTypes
    constructor(callback) { this.callback = callback; this.pending = []; observers.push(this) }
    observe({ type }) { this.type = type }
    takeRecords() { return this.pending.splice(0) }
  }
  const context = vm.createContext({ Element, SVGElement, SVGGraphicsElement, TextEncoder, PerformanceObserver: Observer,
    performance: { now: () => ++clock, timeOrigin: 1234 },
    structuredClone: value => ({ ...value }), getComputedStyle: () => ({ color: 'red' }) })
  context.window = context
  vm.runInContext(source, context)
  return { context, observers, run: script => vm.runInContext(script, context) }
}

test('probes preserve results, count explicit calls and bytes, and reset without reinstalling', () => {
  const b = browser()
  b.run(`
    const costs = window.__comparisonCosts
    window.savedCosts = costs
    costs.reset()
    JSON.parse('{"a":1}')
    try { JSON.parse('{') } catch {}
    JSON.stringify({ a: 1 })
    const encoder = new TextEncoder()
    encoder.encode('abc')
    encoder.encodeInto('abcd', new Uint8Array(2))
    structuredClone({ a: 1 })
    const path = new SVGGraphicsElement()
    path.setAttribute('d', 'M0 0')
    path.getBoundingClientRect()
    path.getBBox()
    getComputedStyle(path)
  `)
  const snapshot = b.context.__comparisonCosts.snapshot(), m = snapshot.measurements
  assert.equal(m.jsonParse.calls, 2); assert.equal(m.jsonParse.errors, 1); assert.equal(m.jsonParse.inputChars, 8)
  assert.equal(m.jsonStringify.calls, 1); assert.equal(m.jsonStringify.outputChars, 7)
  assert.equal(m.textEncoderEncode.inputChars, 3); assert.equal(m.textEncoderEncode.outputBytes, 3)
  assert.equal(m.textEncoderEncodeInto.inputChars, 4); assert.equal(m.textEncoderEncodeInto.consumedChars, 2); assert.equal(m.textEncoderEncodeInto.outputBytes, 2)
  assert.equal(m.svgDAttribute.calls, 1); assert.equal(m.svgDAttribute.inputChars, 4)
  assert.equal(m.setAttribute.calls, 1); assert.equal(m.getBoundingClientRect.calls, 1); assert.equal(m.getBBox.calls, 1)
  assert.equal(m.getComputedStyle.calls, 1); assert.equal(m.structuredClone.calls, 1)
  assert.ok(m.jsonParse.wallMS > 0); assert.ok(m.jsonParse.maxWallMS > 0)
  assert.equal(snapshot.availability.performanceEntries.longtask.available, true)
  assert.equal(snapshot.availability.performanceEntries['long-animation-frame'].available, false)
  b.run(source)
  assert.equal(b.context.savedCosts, b.context.__comparisonCosts)
  b.context.__comparisonCosts.reset()
  assert.equal(b.context.__comparisonCosts.snapshot().measurements.jsonParse.calls, 0)
})

test('observers discard pre-reset and crossing entries and keep bounded summaries', () => {
  const b = browser(), observer = b.observers[0]
  observer.pending.push({ startTime: 0, duration: 90 })
  b.context.__comparisonCosts.reset()
  const start = b.context.__comparisonCosts.snapshot().phaseStartMS
  observer.pending.push({ startTime: start - 1, duration: 10 }, { startTime: start + 1, duration: 80, blockingDuration: 30 })
  const snapshot = b.context.__comparisonCosts.snapshot(), observed = snapshot.measurements.longtask
  assert.equal(observed.count, 1); assert.equal(observed.durationMS, 80); assert.equal(observed.maxDurationMS, 80)
  assert.equal(observed.blockingDurationMS, 30); assert.equal(observed.excludedBeforeReset, 1)
  assert.doesNotThrow(() => JSON.stringify(snapshot))
  assert.ok(snapshot.limitations.some(value => value.includes('not CPU time')))
})
