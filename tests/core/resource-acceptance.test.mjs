import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIndicatorSeries } from '../../electron/services/indicators.js'
import { assessResourceBudgets, assertResourceDeliveryBudget, installResourcePaintProbe, summarizeResourceDelivery } from '../../scripts/resource-acceptance.mjs'

const load = (count = 3) => ({ state: 'complete', emitted: count, completed: count, plannedTicks: count, failed: 0, maxScheduleLatenessMS: 0, cadenceMS: 100,
  ticks: Array.from({ length: count }, (_, index) => { const sequence = index + 1; return { sequence, plannedAt: sequence * 100, emittedAt: sequence * 100,
    receivedAt: sequence * 100 + 2, completedAt: sequence * 100 + 3, instId: 'BTC', timeframe: '5m' } }) })
const commit = (sequence, delay = 20, options = {}) => {
  const { instId = 'BTC', timeframe = '5m', committedAt = sequence * 100 + 10, nextFrameAt = sequence * 100 + delay,
    receivedAt = sequence * 100 + 2, endHour = 1000 } = options
  const livePrice = 100 + sequence / 1000, label = `${livePrice} ↑`, liveHour = 1100
  return { kind: 'commit', sequence, instId, timeframe, endHour, livePrice, priceObservedAt: receivedAt, committedAt, nextFrameAt, label, bars: 96,
    frame: { sameSnapshot: true, visible: true, instId, chartInst: instId, renderedInst: instId, timeframe, renderedTimeframe: timeframe,
      endHour, chartEnd: liveHour, renderedEnd: liveHour, requestedEnd: endHour, visualStale: 'false', liveHour, livePrice,
      priceObservedAt: receivedAt, sequence, label, expectedLivePrice: livePrice, bars: 96, renderedBars: 96 } }
}
const historyFrame = (nextFrameAt, { instId = 'BTC', timeframe = '5m', endHour = 900 } = {}) => ({
  kind: 'commit', sequence: 0, instId, timeframe, endHour, livePrice: null, committedAt: nextFrameAt - 5, nextFrameAt, label: '99 ↑', bars: 96,
  frame: { sameSnapshot: true, visible: true, instId, chartInst: instId, renderedInst: instId, timeframe, renderedTimeframe: timeframe,
    endHour, chartEnd: endHour, renderedEnd: endHour, requestedEnd: endHour, visualStale: 'false', liveHour: null, livePrice: null, sequence: 0, label: '99 ↑', bars: 96, renderedBars: 96 },
})
const laterThirdTick = input => Object.assign(input.ticks[2], { plannedAt: 500, emittedAt: 500, receivedAt: 502, completedAt: 503 })
const liveIntent = (at, extra = {}) => ({ at, instId: 'BTC', timeframe: '5m', liveEndHour: 1000, ...extra })
const historyIntent = at => liveIntent(at, { historical: true, endHour: 900 })
const returnIntent = at => liveIntent(at, { historical: false, endHour: 1000 })

function resourceProbeFixture(context, { indicators = false, frozen = false, cpuMarkerPrefix } = {}) {
  let now = 1000, mutation, disconnected = 0, disconnectError
  context.mock.method(performance, 'now', () => now)
  const names = ['window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const callbacks = [], cancelled = [], label = { textContent: '113.204 ↑' }
  const svg = { dataset: { renderedInst: 'SCALE000-USDT-SWAP', renderedTimeframe: '15m', renderedEnd: '1000' },
    style: { visibility: 'visible' }, isConnected: true, getAttribute: () => 'false', querySelector: () => label }
  const candles = Array.from({ length: 320 }, (_, index) => {
    const close = 110 + index * .01
    return { timestamp: -31_000 + index * 100, open: close - .02, high: close + .06, low: close - .05, close, baseVolume: 100 + index % 7 }
  })
  const bars = buildIndicatorSeries(candles, 100).bars.slice(-96).map(value => ({ ...value, indicatorsObserved: indicators }))
  const snapshot = { instId: 'SCALE000-USDT-SWAP', timeframe: '15m', endHour: 900, bars, liveBar: { hour: 1000, close: 113.204 },
    priceObservedAt: 402, indicatorState: 'ready', oiState: 'loading', takerState: 'loading' }
  if (frozen) { bars.forEach(Object.freeze); Object.freeze(bars); Object.freeze(snapshot.liveBar); Object.freeze(snapshot) }
  const chart = { __chartSnapshot: snapshot, dataset: { chartInst: snapshot.instId, chartEnd: '1000', chartRequestedEnd: '900',
    chartRenderedBars: '96', chartVisualStale: 'false', chartLoading: 'false' }, querySelector: () => svg }
  context.after(() => {
    try { window.__resourcePaint?.stop() }
    finally {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    }
  })
  globalThis.window = {}
  globalThis.document = { querySelector: () => chart }
  globalThis.MutationObserver = class {
    constructor(callback) { mutation = callback }
    observe() {}
    disconnect() { disconnected++; if (disconnectError) throw disconnectError }
  }
  globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length }
  globalThis.cancelAnimationFrame = id => cancelled.push(id)
  installResourcePaintProbe({ intervals: { '15m': 100 }, periods: 320, asOf: 1000, cpuMarkerPrefix })
  return { chart, bars, snapshot, svg, label, callbacks, cancelled, paint: window.__resourcePaint,
    mutation: () => mutation(), at: value => { now = value }, disconnected: () => disconnected,
    failDisconnect: error => { disconnectError = error } }
}

test('renderer probe reads the displayed SVG and snapshot again at RAF, including an unchanged cached frame', context => {
  const { chart, snapshot, label, callbacks, paint, mutation, at } = resourceProbeFixture(context)
  mutation()
  const record = paint.records[0]
  chart.dataset.chartRequestedEnd = '800' // The requested history has not replaced the live SVG.
  at(1010)
  callbacks[1](10)
  assert.equal(record.frame.sameSnapshot, true)
  assert.equal(record.frame.requestedEnd, 800)
  assert.equal(record.frame.renderedEnd, 1000)
  assert.equal(record.frame.sequence, 4)
  assert.equal(record.frame.label, '113.204 ↑')
  assert.equal(paint.isFrame(record), true)
  assert.deepEqual(paint.violations, [])
  const input = { instId: snapshot.instId, timeframe: snapshot.timeframe, sequence: 4, afterAt: performance.timeOrigin + 1011 }
  assert.equal(paint.readyForLatest(input), false, 'An earlier verified frame must not satisfy a later return input.')

  at(1012)
  paint.recheck()
  const unchanged = paint.records.at(-1)
  at(1015)
  callbacks.at(-1)(20)
  assert.equal(unchanged.kind, 'recheck')
  assert.equal(unchanged.committedAt, record.committedAt)
  assert.equal(paint.isFrame(unchanged), true)
  assert.equal(paint.readyForLatest(input), true)
  chart.__chartSnapshot = { ...snapshot, liveBar: { hour: 1000, close: 113.203 } }
  assert.equal(paint.readyForLatest(input), false, 'A stale current snapshot cannot reuse an earlier good frame.')
  chart.__chartSnapshot = snapshot
  chart.dataset.chartRenderedBars = '95'
  assert.equal(paint.readyForLatest(input), false, 'Current DOM completeness must still match the verified frame.')
  chart.dataset.chartRenderedBars = '96'

  paint.recheck()
  const wrongLabel = paint.records.at(-1)
  label.textContent = '113.203 ↑'
  callbacks.at(-1)(25)
  assert.equal(paint.isFrame(wrongLabel), false)
  assert.deepEqual(paint.violations, [], 'Numerical validation must not run inside the timed RAF.')
  label.textContent = '113.204 ↑'

  paint.recheck()
  const replaced = paint.records.at(-1)
  chart.__chartSnapshot = { ...snapshot, liveBar: { hour: 1000, close: 113.205 } }
  label.textContent = '113.205 ↑'
  callbacks.at(-1)(30)
  assert.equal(replaced.frame.sequence, 5)
  assert.equal(replaced.frame.sameSnapshot, false)
  assert.equal(paint.isFrame(replaced), false)
  chart.__chartSnapshot = { ...snapshot, liveBar: { hour: 1000, close: 113.2044 } }
  label.textContent = '113.2044 ↑'
  mutation()
  const offGrid = paint.records.at(-1)
  callbacks.at(-1)(35)
  assert.equal(offGrid.frame.sequence, 4, 'Rounding alone would accept this incorrect quote.')
  assert.equal(paint.readyForLatest(input), false)
  assert.deepEqual(paint.violations, [])
  const result = paint.finish()
  assert.equal(result.complete, false)
  assert.ok(result.violations.some(value => /RAF SVG live-price label/.test(value)))
  assert.ok(result.violations.some(value => /synthetic quote/.test(value)))
})

test('resource capture ends before numerical validation and reuses unchanged immutable bars', context => {
  const { paint, mutation, callbacks, at, disconnected, cancelled } = resourceProbeFixture(context, { indicators: true, frozen: true })
  let oracleCalls = 0
  const markers = []
  context.mock.method(console, 'timeStamp', title => markers.push(JSON.parse(title.slice('resource-test:'.length))))
  const sqrt = Math.sqrt
  context.mock.method(Math, 'sqrt', value => { oracleCalls++; return sqrt(value) })
  mutation()
  at(1010); callbacks[1](10)
  assert.deepEqual(markers, [], 'Initial preparation must not enter the measured CPU stream.')
  paint.armCPU('resource-test:')
  at(1011); callbacks[0](11)
  paint.recheck()
  at(1015); callbacks.at(-1)(15)
  assert.equal(oracleCalls, 0)
  assert.equal(paint.indicatorValuesChecked, 0)
  const stopped = paint.stop(), count = paint.records.length, samples = paint.captureTimings.samples
  assert.equal(paint.active, false)
  assert.equal(oracleCalls, 0, 'Stopping timing must not start the oracle before memory/scheduler windows end.')
  assert.equal(disconnected(), 1)
  assert.ok(cancelled.includes(3), 'The next continuous RAF callback must be cancelled.')
  at(1050)
  mutation(); callbacks[0](50); callbacks[1](50); callbacks[2](50); paint.recheck()
  assert.equal(paint.records.length, count)
  assert.equal(paint.captureTimings.samples, samples)
  assert.equal(paint.stop(), stopped)
  assert.deepEqual(markers.map(value => [value.phase, value.index]), [['start', 0], ['raf', 1], ['stop', 2]])
  const result = paint.finish()
  assert.equal(result.complete, true)
  assert.deepEqual(result.violations, [])
  assert.equal(result.indicatorValuesChecked, 96 * 12)
  assert.equal(oracleCalls, 96, 'The identical retained bar set is checked once across commit and RAF captures.')
  assert.ok(result.deferredValidation.reusedBarChecks > 0)
  assert.ok(result.captureTimings.samples > 0)
  assert.equal(result.cpuMarkerTimings.samples, 3)
  assert.ok(result.deferredValidation.durationMS >= 0)
  assert.equal(paint.finish(), result)
  assert.ok(Object.isFrozen(result.captureTimings) && Object.isFrozen(result.violations))
})

test('raw resource RAF markers retain the original maximum frame pair and callback epoch across cadence reset', context => {
  const markers = []
  context.mock.method(console, 'timeStamp', title => markers.push(JSON.parse(title.slice('raw-raf:'.length))))
  const { paint, callbacks, at } = resourceProbeFixture(context, { cpuMarkerPrefix: 'raw-raf:' })
  assert.deepEqual(markers.map(marker => marker.phase), ['capture-start'])
  at(1001); callbacks[0](1000)
  at(1253); callbacks.at(-1)(1252)
  assert.equal(paint.frameCadence.maxGapMS, 252)
  assert.equal(paint.frameCadence.unmarkedFrames, 0)
  const original = markers.find(marker => marker.index === paint.frameCadence.maxGapMarkerIndex)
  assert.equal(original.rafTimestamp - original.previousRafTimestamp, 252)
  assert.equal(original.callbackAt, 1253)
  assert.equal(original.timeOrigin + original.callbackAt, performance.timeOrigin + 1253)
  paint.armCPU('raw-raf:') // Preserve the original post-readiness CPU boundary.
  assert.equal(markers.at(-1).phase, 'start')
  assert.throws(() => paint.armCPU('raw-raf:'), /armed once/)
  paint.resetFrameCadence()
  at(1254); callbacks.at(-1)(1253)
  at(1274); callbacks.at(-1)(1273)
  at(1424); callbacks.at(-1)(1423)
  const stop = paint.stop(), evidence = stop.frameCadence
  assert.equal(evidence.maxGapMS, 150)
  assert.deepEqual(paint.frameGaps, [20, 150])
  const retained = markers.find(marker => marker.index === evidence.maxGapMarkerIndex)
  assert.equal(retained.previousRafTimestamp, 1273)
  assert.equal(retained.rafTimestamp, 1423)
  assert.equal(retained.callbackAt, 1424)
  assert.equal(markers.find(marker => marker.index === evidence.firstRAFMarkerIndex).previousRafTimestamp, null)
  assert.equal(evidence.lastRAFMarkerIndex, retained.index)
  assert.equal(evidence.endedAt, 1424)
  assert.equal(evidence.frames, 3)
  assert.equal(evidence.unmarkedFrames, 0)
  assert.ok(Object.isFrozen(evidence))
  assert.equal(markers.at(-1).phase, 'stop')
})

test('resource cadence declares frames missing from a later-armed CPU stream', context => {
  const { paint, callbacks, at } = resourceProbeFixture(context)
  at(1001); callbacks[0](1000)
  at(1151); callbacks.at(-1)(1150)
  assert.equal(paint.frameCadence.maxGapMS, 150)
  assert.equal(paint.frameCadence.maxGapMarkerIndex, null)
  assert.equal(paint.frameCadence.unmarkedFrames, 2)
})

test('resource commit timestamps precede capture work and repaired incomplete paints remain rejected', context => {
  const { paint, mutation, callbacks, snapshot, bars, chart, at } = resourceProbeFixture(context)
  let advanced = false
  Object.defineProperty(snapshot, 'bars', { configurable: true, get() {
    if (!advanced) { advanced = true; at(1025) }
    return bars
  } })
  const removed = bars.pop()
  chart.dataset.chartRenderedBars = '95'
  mutation()
  const record = paint.records[0]
  assert.equal(record.committedAt, performance.timeOrigin + 1000, 'Observed commit time must not include capture or oracle work.')
  assert.equal(paint.captureTimings.maxMS, 25)
  at(1040); callbacks[1](40)
  assert.equal(paint.isFrame(record), false)
  bars.push(removed); chart.dataset.chartRenderedBars = '96'
  const result = paint.finish()
  assert.equal(result.complete, false)
  assert.ok(result.violations.some(value => /ready resource paint is incomplete/.test(value)))
})

test('deferred resource validation retains mutable corruption and wrong RAF labels after repair', context => {
  const { paint, mutation, callbacks, bars, label, at } = resourceProbeFixture(context, { indicators: true })
  const ema = bars[0].ema
  bars[0].ema += 7
  mutation()
  const record = paint.records[0]
  bars[0].ema = ema
  label.textContent = '113.203 ↑'
  at(1010); callbacks[1](10)
  assert.equal(record.frame.sameSnapshot, false, 'Mutating the same source object cannot reuse a retained earlier frame.')
  label.textContent = '113.204 ↑'
  const result = paint.finish()
  assert.equal(result.complete, false)
  assert.ok(result.violations.some(value => /224\/ema/.test(value)), 'Repairing the source must not rewrite the captured corruption.')
  assert.ok(result.violations.some(value => /RAF SVG live-price label/.test(value)), 'Repairing the current label must not rewrite the RAF observation.')
  assert.equal(Object.isFrozen(bars), false)
  assert.equal(Object.isFrozen(bars[0]), false, 'Capture must not mutate or freeze application-owned fixture data.')
})

test('continuous resource RAF capture retains repaired DOM-only corruption with an unchanged snapshot', context => {
  const { paint, mutation, callbacks, label, svg, at } = resourceProbeFixture(context, { frozen: true })
  mutation(); at(1010); callbacks[1](10)
  label.textContent = '113.203 ↑'
  at(1015); callbacks[0](15)
  label.textContent = '113.204 ↑'
  svg.dataset.renderedInst = 'SCALE999-USDT-SWAP'
  at(1020); callbacks[2](20)
  svg.dataset.renderedInst = 'SCALE000-USDT-SWAP'
  assert.equal(paint.records.length, 1, 'Continuous display checks must not fabricate extra commits.')
  const result = paint.finish()
  assert.equal(result.complete, false)
  assert.ok(result.violations.some(value => /RAF SVG live-price label/.test(value)))
  assert.ok(result.violations.some(value => /SVG mixed native series identities/.test(value)))
})

test('resource capture failures and pending RAF cleanup remain explicit and idempotent', context => {
  const { paint, mutation, callbacks, snapshot, bars, failDisconnect, disconnected, cancelled } = resourceProbeFixture(context)
  Object.defineProperty(snapshot, 'bars', { configurable: true, get() { throw new Error('injected retained-bar read failure') } })
  mutation()
  assert.equal(paint.records.length, 0)
  Object.defineProperty(snapshot, 'bars', { configurable: true, value: bars })
  mutation()
  failDisconnect(new Error('injected observer disconnect failure'))
  const result = paint.finish()
  assert.equal(paint.active, false)
  assert.equal(result.complete, false)
  assert.ok(result.captureErrors.some(value => /retained-bar read/.test(value.message)))
  assert.ok(result.captureErrors.some(value => value.stage === 'disconnect'))
  assert.equal(result.stopped.pendingFrameObservations, 1)
  assert.deepEqual(cancelled, [1, 2])
  const count = paint.records.length
  callbacks[1](20); mutation()
  assert.equal(paint.records.length, count)
  assert.equal(paint.records[0].nextFrameAt, null, 'A cancelled RAF must not turn into fabricated display evidence.')
  assert.equal(paint.finish(), result)
  assert.equal(disconnected(), 1)
})

test('resource acceptance rejects a middle stall even when the final input is fast', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), commit(2, 150), commit(3, 270, { committedAt: 360, nextFrameAt: 370 })])
  assert.throws(() => assertResourceDeliveryBudget(report), /waited 148/)
  assert.equal(report.samples.length, 3, 'A failed budget must retain every measured input for diagnostics.')
  assert.equal(report.samples[1].receiveToFrameMS, 148)
})

test('coalesced updates retain the scheduled wait of the older intent', () => {
  const input = load(); Object.assign(input.ticks[0], { plannedAt: 180, emittedAt: 180, receivedAt: 182, completedAt: 183 })
  const report = summarizeResourceDelivery(input, [commit(2), commit(3)])
  assert.equal(report.coalesced, 1)
  assert.equal(report.p95MS, null, 'Short samples do not masquerade as a tail distribution.')
  assert.equal(report.samples[0].scheduleToFrameMS, 40)
  assert.throws(() => assertResourceDeliveryBudget(summarizeResourceDelivery(load(), [commit(2), commit(3)])), /waited 118/)
})

test('a delayed input measures the viewport active when received while retaining its original schedule', () => {
  const input = load()
  Object.assign(input.ticks[1], { emittedAt: 240, receivedAt: 242, completedAt: 243 })
  input.maxScheduleLatenessMS = 40
  const report = summarizeResourceDelivery(input, [commit(1), commit(2, 60, { instId: 'ETH', committedAt: 250, receivedAt: 242 }),
    commit(3, 20, { instId: 'ETH' })], { intents: [liveIntent(0), liveIntent(210, { instId: 'ETH' })] })
  assert.equal(report.samples[1].receiveToFrameMS, 18)
  assert.equal(report.samples[1].scheduleToFrameMS, 60)
  assert.equal(report.samples[1].receivedAt, 242)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('source timestamps on one monotonic clock reject every reordered edge', () => {
  const input = load()
  input.ticks[0].emittedAt = input.ticks[0].receivedAt + 1
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
  input.ticks[0].emittedAt = input.ticks[0].plannedAt - .1
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
  input.ticks[0].emittedAt = input.ticks[0].plannedAt
  input.ticks[0].completedAt = input.ticks[0].receivedAt - 10
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
})

test('cross-process precision retains raw deltas and rejects frames outside its tolerance', () => {
  const early = commit(1, 20, { committedAt: 101.5, nextFrameAt: 101.75 })
  const report = summarizeResourceDelivery(load(), [early, commit(2), commit(3)])
  assert.equal(report.samples[0].receiveToCommitClockDeltaMS, -.5)
  assert.equal(report.samples[0].receiveToFrameClockDeltaMS, -.25)
  assert.equal(report.samples[0].receiveToCommitMS, 0)
  assert.equal(report.samples[0].receiveToFrameMS, 0)
  assert.equal(report.crossProcessOriginToleranceMS, 2)
  const tooEarly = commit(1, 20, { committedAt: 90, nextFrameAt: 120 })
  assert.throws(() => assertResourceDeliveryBudget(summarizeResourceDelivery(load(), [tooEarly, commit(2), commit(3)])), /waited 118/)
})

test('a selection supersedes the old viewport and acknowledges the update in the new visible series', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), commit(2, 20, { instId: 'ETH' }), commit(3, 20, { instId: 'ETH' })], {
    intents: [liveIntent(0), liveIntent(206, { instId: 'ETH' })],
  })
  assert.equal(report.samples[1].instId, 'ETH')
  assert.equal(report.samples[1].receiveToFrameMS, 18)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('a verified live SVG at RAF counts while history is requested but has not replaced the displayed frame', () => {
  const input = load(4), tick = input.ticks[3]
  const visible = commit(4, 20, { committedAt: tick.receivedAt + 9.65, nextFrameAt: tick.receivedAt + 15.25 })
  visible.frame.requestedEnd = 900
  const returned = commit(4, 20, { committedAt: tick.receivedAt + 271.75, nextFrameAt: tick.receivedAt + 289.65 })
  const report = summarizeResourceDelivery(input, [commit(1), commit(2), commit(3), visible,
    historyFrame(tick.receivedAt + 230), returned], { intents: [liveIntent(0), historyIntent(tick.receivedAt + 10.05),
    returnIntent(tick.receivedAt + 252.15)] })
  assert.ok(Math.abs(report.samples[3].receiveToFrameMS - 15.25) < 1e-9)
  assert.equal(report.samples[3].committedAt, visible.committedAt)
  assert.equal(report.supersededLiveInputs.length, 0)
  assert.equal(report.returnsToLive[0].requiredSequence, 4)
  assert.ok(Math.abs(report.returnsToLive[0].inputToFrameMS - 37.5) < 1e-9)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('an input received during a pending history request is measured when its live frame is actually visible', () => {
  const input = load()
  const visible = commit(2); visible.frame.requestedEnd = 900
  const report = summarizeResourceDelivery(input, [commit(1), visible, historyFrame(240), commit(3)], {
    intents: [liveIntent(0), historyIntent(190), returnIntent(260)],
  })
  assert.equal(report.samples[1].sequence, 2)
  assert.equal(report.samples[1].receiveToFrameMS, 18)
  assert.deepEqual(report.historicalViewportInputs, [])
})

test('a timely history request supersedes an unrendered live input but return still owes the latest quote', () => {
  const input = load(4)
  const report = summarizeResourceDelivery(input, [commit(1), historyFrame(240), commit(3, 65, { committedAt: 360, nextFrameAt: 365 }), commit(4)], {
    intents: [liveIntent(0), historyIntent(220), returnIntent(350)],
  })
  assert.deepEqual(report.supersededLiveInputs.map(value => value.sequence), [2])
  assert.deepEqual(report.historicalViewportInputs, [3])
  assert.equal(report.returnsToLive[0].requiredSequence, 3)
  assert.equal(report.returnsToLive[0].inputToFrameMS, 15)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('a definitely historical viewport requires an observed historical frame before receipt', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), historyFrame(175), commit(2, 80, { committedAt: 270, nextFrameAt: 280 }), commit(3)], {
    intents: [liveIntent(0), historyIntent(150), returnIntent(250)],
  })
  assert.deepEqual(report.historicalViewportInputs, [2])
  assert.deepEqual(report.viewportOriginAmbiguities, [])
  assert.equal(report.count, 2)
  assert.equal(report.returnsToLive[0].requiredSequence, 2)
})

test('a pending historical frame can supersede a live input only when history is shown before the deadline', () => {
  const input = load()
  const report = summarizeResourceDelivery(input, [commit(1), historyFrame(230), commit(2, 80, { committedAt: 270, nextFrameAt: 280 }), commit(3)], {
    intents: [liveIntent(0), historyIntent(190), returnIntent(250)],
  })
  assert.deepEqual(report.supersededLiveInputs.map(value => value.sequence), [2])
  assert.equal(report.supersededLiveInputs[0].historicalFrameAt, 230)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('clock-ambiguous transitions to history stay measured instead of silently excluding a possibly live input', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), commit(2, 30, { committedAt: 220 }), commit(3)], {
    intents: [liveIntent(0), historyIntent(201), returnIntent(215)],
  })
  assert.deepEqual(report.historicalViewportInputs, [])
  assert.equal(report.viewportOriginAmbiguities[0].sequence, 2)
  assert.equal(report.samples[1].receiveToFrameMS, 28)
})

test('transitions at either edge of the clock tolerance remain ambiguous', () => {
  const input = load(); laterThirdTick(input)
  const delayed = commit(2, 150), later = commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })
  for (const at of [200, 204]) {
    const report = summarizeResourceDelivery(input, [commit(1), delayed, later], { intents: [liveIntent(0), historyIntent(at)] })
    assert.equal(report.viewportOriginAmbiguities[0].sequence, 2)
    assert.deepEqual(report.supersededLiveInputs, [])
    assert.throws(() => assertResourceDeliveryBudget(report), /waited 148/)
  }
})

test('a later unambiguous history transition can supersede debt after an ambiguous toggle', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), historyFrame(245),
    commit(2, 75, { committedAt: 270, nextFrameAt: 275 }), commit(3)], {
    intents: [liveIntent(0), historyIntent(203), returnIntent(210), historyIntent(230), returnIntent(260)],
  })
  assert.equal(report.viewportOriginAmbiguities[0].sequence, 2)
  assert.deepEqual(report.supersededLiveInputs.map(value => [value.sequence, value.historyIntentAt]), [[2, 230]])
  assert.deepEqual(report.returnsToLive.map(value => value.inputToFrameMS), [65, 15])
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('history cannot erase an overdue input or one ambiguous with the deadline', () => {
  const input = load(); laterThirdTick(input)
  const late = commit(2, 150), last = commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })
  for (const at of [300, 300.01, 302, 303]) {
    const report = summarizeResourceDelivery(input, [commit(1), late, last], { intents: [liveIntent(0), historyIntent(at)] })
    assert.deepEqual(report.supersededLiveInputs, [], `history at ${at} cannot cancel at the uncertainty boundary`)
    assert.throws(() => assertResourceDeliveryBudget(report), /waited 148/)
  }
  const timely = summarizeResourceDelivery(input, [commit(1), last], { intents: [liveIntent(0), historyIntent(299.99)] })
  assert.deepEqual(timely.supersededLiveInputs.map(value => value.sequence), [2])
})

test('return to live must show the latest accepted quote promptly even without a new tick', () => {
  const input = load(); laterThirdTick(input)
  const later = commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })
  const intents = [liveIntent(0), historyIntent(150), returnIntent(250)]
  const fresh = commit(2, 70, { committedAt: 260, nextFrameAt: 270 })
  fresh.kind = 'recheck' // A previously committed snapshot is also valid when actually rechecked at RAF.
  const report = summarizeResourceDelivery(input, [commit(1), historyFrame(175), fresh, later], { intents })
  assert.equal(report.returnsToLive[0].requiredSequence, 2)
  assert.equal(report.returnsToLive[0].renderedSequence, 2)
  assert.equal(report.returnsToLive[0].inputToFrameMS, 20)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))

  for (const invalid of [
    commit(1, 170, { committedAt: 260, nextFrameAt: 270 }),
    commit(2, 70, { instId: 'ETH', committedAt: 260, nextFrameAt: 270 }),
    commit(2, 70, { timeframe: '15m', committedAt: 260, nextFrameAt: 270 }),
    { ...fresh, frame: { ...fresh.frame, sameSnapshot: false } },
    { ...fresh, frame: { ...fresh.frame, renderedInst: 'ETH' } },
    { ...fresh, frame: { ...fresh.frame, visible: false } },
    { ...fresh, frame: { ...fresh.frame, sequence: 1 } },
    { ...fresh, endHour: 900, frame: { ...fresh.frame, endHour: 900 } },
    { ...fresh, frame: { ...fresh.frame, priceObservedAt: 102 } },
    { ...fresh, frame: { ...fresh.frame, label: '100.001 ↑' } },
  ]) {
    const late = summarizeResourceDelivery(input, [commit(1), historyFrame(175), invalid, later], { intents })
    assert.equal(late.returnsToLive[0].renderedSequence, 3)
    assert.throws(() => assertResourceDeliveryBudget(late), /Return to live waited 270/)
  }
})

test('a rechecked cached live snapshot can satisfy return without a new commit or tick', () => {
  const input = load(); laterThirdTick(input)
  const cached = commit(2, 165, { committedAt: 210, nextFrameAt: 365 })
  cached.kind = 'recheck'
  const report = summarizeResourceDelivery(input, [commit(1), commit(2), historyFrame(275), cached,
    commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })], {
    intents: [liveIntent(0), historyIntent(250), returnIntent(350)],
  })
  assert.equal(report.returnsToLive[0].requiredSequence, 2)
  assert.equal(report.returnsToLive[0].committedAt, 210)
  assert.equal(report.returnsToLive[0].inputToFrameMS, 15)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('a quote within clock uncertainty of returning to live is required conservatively', () => {
  const input = load(); Object.assign(input.ticks[1], { receivedAt: 251, completedAt: 252 })
  const stale = commit(1, 160, { committedAt: 255, nextFrameAt: 260 })
  const fresh = commit(2, 80, { committedAt: 270, nextFrameAt: 280, receivedAt: 251 })
  const report = summarizeResourceDelivery(input, [commit(1), historyFrame(175), stale, fresh, commit(3)], {
    intents: [liveIntent(0), historyIntent(150), returnIntent(250)],
  })
  assert.equal(report.returnsToLive[0].requiredSequence, 2)
  assert.equal(report.returnsToLive[0].renderedSequence, 2)
  assert.equal(report.returnsToLive[0].inputToFrameMS, 30)
})

test('selecting another live series from history creates the same freshness obligation', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), historyFrame(175),
    commit(2, 70, { instId: 'ETH', committedAt: 260, nextFrameAt: 270 }), commit(3, 20, { instId: 'ETH' })], {
    intents: [liveIntent(0), historyIntent(150), liveIntent(250, { instId: 'ETH' })],
  })
  assert.equal(report.returnsToLive[0].instId, 'ETH')
  assert.equal(report.returnsToLive[0].requiredSequence, 2)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('another history toggle cannot silently cancel an outstanding return-to-live obligation', () => {
  const input = load(4)
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), historyFrame(275), historyFrame(380)], {
    intents: [liveIntent(0), historyIntent(250), returnIntent(350), historyIntent(360)],
  }), /Return to live.*never reached a verified renderer frame/)
})

test('unverified old records and stale, wrong-series, or wrong-label RAF evidence cannot satisfy live delivery', () => {
  const input = load(); laterThirdTick(input)
  const later = commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })
  const correct = commit(2)
  const invalid = [
    { ...correct, frame: undefined }, { ...correct, frame: { ...correct.frame, sameSnapshot: false } },
    { ...correct, frame: { ...correct.frame, visible: false } }, { ...correct, frame: { ...correct.frame, renderedInst: 'ETH' } },
    { ...correct, frame: { ...correct.frame, renderedTimeframe: '15m' } }, { ...correct, frame: { ...correct.frame, renderedEnd: 900 } },
    { ...correct, endHour: 900, frame: { ...correct.frame, endHour: 900 } },
    { ...correct, frame: { ...correct.frame, sequence: 1 } }, { ...correct, frame: { ...correct.frame, label: '100.001 ↑' } },
    { ...correct, priceObservedAt: 102, frame: { ...correct.frame, priceObservedAt: 102 } },
    { ...correct, bars: 95 }, { ...correct, frame: { ...correct.frame, bars: 95 } },
    { ...correct, frame: { ...correct.frame, renderedBars: 95 } },
    { ...correct, frame: { ...correct.frame, expectedLivePrice: undefined } },
    { ...correct, livePrice: correct.livePrice + .0004, label: `${correct.livePrice + .0004} ↑`,
      frame: { ...correct.frame, livePrice: correct.livePrice + .0004, label: `${correct.livePrice + .0004} ↑` } },
  ]
  for (const record of invalid) {
    const report = summarizeResourceDelivery(input, [commit(1), record, later], { intents: [liveIntent(0)] })
    assert.throws(() => assertResourceDeliveryBudget(report), /waited 318/)
  }
})

test('an active-live 288.2 ms delivery remains a genuine failure', () => {
  const input = load(); laterThirdTick(input)
  const slow = commit(2, 20, { committedAt: 436.9, nextFrameAt: 490.2 })
  const report = summarizeResourceDelivery(input, [commit(1), slow, commit(3, 220, { committedAt: 510, nextFrameAt: 520, receivedAt: 502 })], {
    intents: [liveIntent(0)],
  })
  assert.ok(Math.abs(report.samples[1].receiveToFrameMS - 288.2) < 1e-9)
  assert.throws(() => assertResourceDeliveryBudget(report), /waited 288\.20/)
})

test('missing output, omitted scheduled input and unfinished intake cannot pass', () => {
  assert.throws(() => summarizeResourceDelivery(load(), [commit(1)]), /never reached/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), emitted: 2 }, []), /scheduled input/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), state: 'draining' }, []), /finish/)
})

test('source overload retains valid delivery samples and still fails its unchanged cadence budget', () => {
  const input = { ...load(), maxScheduleLatenessMS: 101 }
  const delivery = summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)])
  assert.equal(delivery.samples.length, 3)
  const failures = assessResourceBudgets({ load: input, delivery }, { offscreen: true })
  assert.deepEqual(failures.map(value => value.gate), ['source-cadence'])
  assert.match(failures[0].message, /101 ms.*100 ms/)
})

test('independent resource budget failures remain visible instead of masking one another', () => {
  const input = { ...load(), maxScheduleLatenessMS: 101 }
  const failures = assessResourceBudgets({ load: input, delivery: { receiveToFrameMaxMS: 110, returnsToLive: [{ requiredSequence: 2, inputToFrameMS: 120 }] },
    switches: [{ rowClickToFrameMS: 155 }], frameCadence: { maxMS: 101, p95MS: 51 } })
  assert.deepEqual(failures.map(value => value.gate), ['source-cadence', 'receive-to-raf', 'return-to-live', 'prepared-selection', 'raf-gap', 'raf-p95'])
  assert.deepEqual(assessResourceBudgets({ load: load(), delivery: { receiveToFrameMaxMS: 100, returnsToLive: [] },
    switches: [{ rowClickToFrameMS: 100 }], frameCadence: { maxMS: 99.9, p95MS: 50 } }), [])
})

test('foreground resource budgets reject missing or non-finite measurements', () => {
  const failures = assessResourceBudgets({ load: { ...load(), maxScheduleLatenessMS: NaN },
    delivery: { receiveToFrameMaxMS: NaN, returnsToLive: [] }, switches: [], frameCadence: { maxMS: null, p95MS: null } })
  assert.equal(failures.length, 5)
})

test('an older delivery summary cannot bypass missing RAF and return-to-live evidence', () => {
  assert.throws(() => assertResourceDeliveryBudget({ receiveToFrameMaxMS: 10 }), /older reports/)
  assert.throws(() => assertResourceDeliveryBudget({ receiveToFrameMaxMS: 10 }, null), /older reports/)
})
