import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('renderer probe reads the displayed SVG and snapshot again at RAF, including an unchanged cached frame', context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const names = ['window', 'document', 'MutationObserver', 'requestAnimationFrame']
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const callbacks = [], label = { textContent: '113.204 ↑' }
  let mutation
  const svg = { dataset: { renderedInst: 'SCALE000-USDT-SWAP', renderedTimeframe: '15m', renderedEnd: '1000' },
    style: { visibility: 'visible' }, isConnected: true, getAttribute: () => 'false', querySelector: () => label }
  const bars = Array.from({ length: 96 }, (_, offset) => {
    const index = 224 + offset, close = 110 + index * .01
    return { hour: -31_000 + index * 100, open: close - .02, high: close + .06, low: close - .05, close, indicatorsObserved: false }
  })
  const snapshot = { instId: 'SCALE000-USDT-SWAP', timeframe: '15m', endHour: 900, bars, liveBar: { hour: 1000, close: 113.204 },
    priceObservedAt: 402, indicatorState: 'ready', oiState: 'loading', takerState: 'loading' }
  const chart = { __chartSnapshot: snapshot, dataset: { chartInst: snapshot.instId, chartEnd: '1000', chartRequestedEnd: '900',
    chartRenderedBars: '96', chartVisualStale: 'false', chartLoading: 'false' }, querySelector: () => svg }
  try {
    globalThis.window = {}
    globalThis.document = { querySelector: () => chart }
    globalThis.MutationObserver = class { constructor(callback) { mutation = callback } observe() {} }
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback) }
    installResourcePaintProbe({ intervals: { '15m': 100 }, periods: 320, asOf: 1000 })
    mutation()
    const paint = window.__resourcePaint, record = paint.records[0]
    chart.dataset.chartRequestedEnd = '800' // The requested history has not replaced the live SVG.
    now = 1010
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

    now = 1012
    paint.recheck()
    const unchanged = paint.records.at(-1)
    now = 1015
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
    assert.match(paint.violations.at(-1), /RAF SVG live-price label/)
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
    assert.match(paint.violations.at(-1), /synthetic quote/)
  } finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
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
