import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../timing-probes.js', import.meta.url), 'utf8')
const comparisonBridge = await readFile(new URL('../browser.js', import.meta.url), 'utf8')

for (const transport of ['http', 'native']) for (const telemetry of ['off', 'full']) {
  test(`comparison ${transport}/${telemetry} selects recording independently of notification delivery`, async () => {
    const requests = [], notifications = []
    let stream, subscriber, nonceCalls = 0, flushed = 0
    class Document { get visibilityState() { return 'hidden' } }
    const document = new Document()
    document.currentScript = { src: 'http://127.0.0.1/session/browser.js' }
    const respond = (path, body) => {
      requests.push([path, body])
      if (path === 'operations/init') return { sessionId: 'comparison', executionId: 'renderer' }
      return { ok: true }
    }
    class EventSource {
      constructor() { stream = this }
      close() {}
    }
    const context = vm.createContext({ Document, document, URL, EventSource,
      performance: { timeOrigin: 1, now: () => 1 },
      crypto: { randomUUID: () => { if (telemetry === 'off') throw new Error('Unexpected recording nonce'); nonceCalls++; return 'nonce' } },
      fetch: async (url, init) => ({ ok: true, json: async () => respond(url.pathname.split('/').slice(2).join('/'), JSON.parse(init.body)) }),
      __radarComparisonOptions: { transport, telemetry }, addEventListener() {},
    })
    context.window = context
    if (transport === 'native') context.__comparisonNative = {
      subscribe: async callback => { subscriber = callback },
      request: async (path, payload) => JSON.stringify(respond(path, JSON.parse(payload))),
    }
    vm.runInContext(comparisonBridge, context)
    await Promise.resolve()
    const emit = item => {
      const payload = JSON.stringify(item)
      if (transport === 'native') subscriber(payload); else stream.onmessage({ data: payload })
    }
    emit({ channel: 'radar:chart-prepared', detail: 'encoded-chart' })
    let bridge
    context.radarDesktopBootstrap.connect(value => { bridge = value })
    assert.equal(bridge.operationRecording, telemetry === 'full')
    bridge.subscribeNotifications((...values) => notifications.push(values))
    assert.equal(notifications[0][0], 'radar:chart-prepared')
    assert.equal(notifications[0][1], 'encoded-chart')
    emit({ channel: 'radar:market-changed', detail: 7 })
    assert.equal(notifications[1][1], 7)
    await bridge.request({ snapshot: {} })
    if (telemetry === 'full') {
      const identity = await bridge.initializeOperations(async () => { flushed++ })
      assert.equal(identity.executionId, 'renderer')
      await bridge.recordOperations({ batchId: 'test' })
      emit({ command: { id: 'drain', action: 'drain' } })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(flushed, 1)
      assert.ok(requests.some(([path]) => path === 'result'))
      assert.equal(nonceCalls, 1)
      assert.ok(requests.some(([path]) => path === 'operations/init'))
      assert.ok(requests.some(([path]) => path === 'operations/batch'))
    } else {
      assert.throws(() => bridge.initializeOperations(() => {}), /disabled/)
      assert.throws(() => bridge.recordOperations({}), /disabled/)
      assert.equal(nonceCalls, 0)
      assert.ok(requests.every(([path]) => !path.startsWith('operations/')))
    }
  })
}

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
