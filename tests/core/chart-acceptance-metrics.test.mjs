import assert from 'node:assert/strict'
import test from 'node:test'

test('a different native timeframe or instrument cannot acknowledge a scroll target', () => {
  const intent = { instId: 'BTC', timeframe: '5m', at: 10, target: 1000 }
  for (const identity of [{ instId: 'BTC', timeframe: '1H' }, { instId: 'ETH', timeframe: '5m' }]) {
    const result = accountChartIntents([intent], [{ ...identity, at: 12, rafSampledAt: 18, end: 1000 }])
    assert.equal(result[0].status, 'unaccounted')
  }
})
import { accountChartIntents, assertColdBoundaryResponsiveness, assertColdBoundaryTiming, assertScrollResponsiveness, assertWarmStatistics, coldBoundaryTiming, collectAcceptanceChecks, summarizeLatencySamples } from '../../scripts/chart-acceptance-metrics.mjs'
import { measureChartIntentLatency } from '../../scripts/chart-acceptance.mjs'

const coldTimes = () => ({ rendererTimeOrigin: 1_000_000, approachInputAt: 1_000, finalInputAt: 2_000,
  firstTargetRAFAt: 2_020, readyTargetRAFAt: 2_080, nearestStartedAt: 1_000_500,
  nearestCompletedAt: 1_000_700, preparedTargetAt: 1_000_750 })

test('pre-intent lead is reported but is not charged to target response', () => {
  const report = coldBoundaryTiming(coldTimes())
  assert.equal(report.dataInputOrder, 'data-before-input')
  assert.equal(report.preInputLeadMS, 1300)
  assert.equal(report.rawPageToFirstRAFMS, 1320)
  assert.equal(report.rawPageToReadyRAFMS, 1380)
  assert.equal(report.readyAfterPrerequisitesMS, 80)
  assert.equal(report.preparedAfterSourceMS, 50)
  assert.doesNotThrow(() => assertColdBoundaryTiming(report))
})

test('data arriving after input makes the source completion the ready-response prerequisite', () => {
  const report = coldBoundaryTiming({ ...coldTimes(), nearestStartedAt: 1_002_030, nearestCompletedAt: 1_002_050,
    preparedTargetAt: 1_002_070, readyTargetRAFAt: 2_120 })
  assert.equal(report.dataInputOrder, 'input-before-data')
  assert.equal(report.preInputLeadMS, -50)
  assert.equal(report.rawPageToFirstRAFMS, -30)
  assert.equal(report.inputToReadyRAFMS, 120)
  assert.equal(report.readyAfterPrerequisitesMS, 70)
  assert.throws(() => assertColdBoundaryTiming(report), /prefetch readiness cannot be established independently of demand/)
})

test('post-prerequisite and source-to-prepared stalls each retain the strict 1000 ms budget', () => {
  const readyStall = coldBoundaryTiming({ ...coldTimes(), readyTargetRAFAt: 3_000 })
  assert.equal(readyStall.readyAfterPrerequisitesMS, 1000)
  assert.throws(() => assertColdBoundaryTiming(readyStall), /ready RAF exceeded/)
  const preparationStall = coldBoundaryTiming({ ...coldTimes(), nearestCompletedAt: 1_000_700, preparedTargetAt: 1_001_700 })
  assert.equal(preparationStall.preparedAfterSourceMS, 1000)
  assert.throws(() => assertColdBoundaryTiming(preparationStall), /prefetch preparation exceeded/)
  assert.throws(() => assertColdBoundaryTiming({ readyAfterPrerequisitesMS: 1000, preparedAfterSourceMS: 1000, preparedBeforeFinalInput: false }), error => {
    assert.match(error.message, /ready RAF exceeded/)
    assert.match(error.message, /prefetch preparation exceeded/)
    assert.match(error.message, /prefetch readiness cannot be established/)
    return true
  })
})

test('cold timing rejects missing, nonfinite, negative, and out-of-order timestamps', () => {
  for (const patch of [{ readyTargetRAFAt: undefined }, { finalInputAt: NaN }, { preparedTargetAt: Infinity },
    { nearestStartedAt: -1 }, { nearestStartedAt: 1_000_701 }, { preparedTargetAt: 1_000_699 },
    { finalInputAt: 999 }, { firstTargetRAFAt: 1_999 }, { readyTargetRAFAt: 2_019 },
    { nearestCompletedAt: 1_002_081, preparedTargetAt: 1_002_082 }]) {
    assert.throws(() => coldBoundaryTiming({ ...coldTimes(), ...patch }), /timestamp|out of order|inconsistent/i)
  }
  assert.throws(() => assertColdBoundaryTiming({ readyAfterPrerequisitesMS: NaN }), /ready RAF exceeded/)
})

test('cold responsiveness gates cursor acknowledgment and prepared rendering, not unhydrated approach content', () => {
  const latency = { intentLatenciesMS: [20], unaccountedInputs: [], maxFrameGapMS: 25, maxInputToRafSampleMS: 20 }
  const acknowledgment = { ...latency, milestone: 'requested-cursor' }
  const rendered = { ...latency, milestone: 'rendered-window' }
  const report = { approachAcknowledgment: acknowledgment, approachLatency: { ...rendered, intentLatenciesMS: [125], maxInputToRafSampleMS: 125 },
    finalLatency: rendered, readyTargetInputToRAFMS: 33.2, sourcePhaseRAF: { maxGapMS: 50.2 }, targetPhaseRAF: { maxGapMS: 25 } }
  assert.doesNotThrow(() => assertColdBoundaryTiming(coldBoundaryTiming(coldTimes())))
  assert.doesNotThrow(() => assertColdBoundaryResponsiveness(report))
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, approachAcknowledgment: { ...acknowledgment, milestone: 'rendered-window' } }), /requested-cursor RAF acknowledgment/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, finalLatency: { ...rendered, milestone: 'requested-cursor' } }), /rendered-window RAF/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, approachAcknowledgment: { ...acknowledgment, intentLatenciesMS: [100] } }), /Scroll intent exceeded/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, approachAcknowledgment: { ...acknowledgment, unaccountedInputs: [{ index: 0 }] } }), /every input intent accounted/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, approachAcknowledgment: { ...acknowledgment, maxFrameGapMS: 100 } }), /renderer RAF gap exceeded/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, finalLatency: { ...rendered, intentLatenciesMS: [100], maxInputToRafSampleMS: 100 } }), /Scroll intent exceeded/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, finalLatency: { ...rendered, maxFrameGapMS: 100 } }), /renderer RAF gap exceeded/)
  for (const readyTargetInputToRAFMS of [100, NaN, -1, undefined]) {
    assert.throws(() => assertColdBoundaryResponsiveness({ ...report, readyTargetInputToRAFMS }), /complete ready RAF/)
  }
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, sourcePhaseRAF: { maxGapMS: 282 } }), /approach\/source renderer RAF gap/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, targetPhaseRAF: { maxGapMS: 100 } }), /target-to-ready renderer RAF gap/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, sourcePhaseRAF: { maxGapMS: NaN } }), /approach\/source renderer RAF gap/)
  assert.throws(() => assertColdBoundaryResponsiveness({ ...report, sourcePhaseRAF: { maxGapMS: -1 } }), /approach\/source renderer RAF gap/)
})

test('a coalesced requested-cursor acknowledgment retains its entire stall', () => {
  const intents = [{ instId: 'BTC', timeframe: '15m', at: 10, target: 1_000 }, { instId: 'BTC', timeframe: '15m', at: 20, target: 900 }]
  const accounted = accountChartIntents(intents, [{ instId: 'BTC', timeframe: '15m', at: 110, rafSampledAt: 120, end: 900 }])
  assert.equal(accounted[0].status, 'coalesced')
  assert.equal(accounted[0].latencyMS, 110)
  const acknowledgment = { milestone: 'requested-cursor', intentLatenciesMS: accounted.map(intent => intent.latencyMS),
    unaccountedInputs: [], maxFrameGapMS: 25 }
  const finalLatency = { milestone: 'rendered-window', intentLatenciesMS: [20], unaccountedInputs: [], maxFrameGapMS: 25, maxInputToRafSampleMS: 20 }
  assert.throws(() => assertColdBoundaryResponsiveness({ approachAcknowledgment: acknowledgment, finalLatency,
    readyTargetInputToRAFMS: 20, sourcePhaseRAF: { maxGapMS: 25 }, targetPhaseRAF: { maxGapMS: 25 } }), /Scroll intent exceeded/)
})

test('RAF stalls fail even when the synthetic input loop resumes with fast responses', () => {
  const report = { intentLatenciesMS: [12, 15, 10], unaccountedInputs: [], maxFrameGapMS: 200 }
  assert.throws(() => assertScrollResponsiveness(report), /RAF gap exceeded/)
  assert.doesNotThrow(() => assertScrollResponsiveness({ ...report, maxFrameGapMS: 33.4 }))
})

test('prefetch latency can defer both deadlines without losing presentation proof or raw stalls', async () => {
  const inputs = [10, 20, 30], targets = [1_000, 900, 800]
  const probe = { instId: 'BTC', expectedTimeframe: '15m',
    commits: [{ instId: 'BTC', timeframe: '15m', at: 12, rafSampledAt: 18, end: 1_000 },
      { instId: 'BTC', timeframe: '15m', at: 190, rafSampledAt: 194.3, end: 800 }],
    inputBursts: inputs.map(at => ({ firstAt: at, lastAt: at, events: 1 })),
    frameSamples: [{ at: 18, gapMS: 16 }, { at: 194.3, gapMS: 152.2 }],
    validationSamples: [{ at: 18, durationMS: 1 }, { at: 194.3, durationMS: 2 }],
    schedulerObservers: [], scheduler: { entries: [] } }
  const previousWindow = globalThis.window, previousDocument = globalThis.document
  globalThis.window = { __chartPaintProbe: probe }
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true }
  const page = { waitForFunction: async (callback, args) => assert.ok(callback(args)), evaluate: async (callback, args) => callback(args) }
  try {
    const options = { inputs, targets, requireForeground: true }
    await assert.rejects(measureChartIntentLatency(page, options), /Scroll intent exceeded 100 ms/)
    const latency = await measureChartIntentLatency(page, { ...options, enforceBudgets: false })
    assert.equal(latency.documentVisibility, 'visible')
    assert.equal(latency.documentFocused, true)
    assert.equal(latency.intents[1].status, 'coalesced')
    assert.equal(latency.intents[1].inputAt, 20)
    assert.equal(latency.intents[1].commitAt, 190)
    assert.equal(latency.intents[1].rafSampledAt, 194.3)
    assert.equal(latency.intents[1].committedTarget, 800)
    assert.equal(latency.maxInputToRafSampleMS, 174.3)
    assert.equal(latency.maxFrameGapMS, 152.2)
    const order = []
    const checks = collectAcceptanceChecks([
      ['paint', () => { order.push('paint') }],
      ['delivery', () => { order.push('delivery') }],
      ['deadlines', () => { order.push('deadlines'); assertScrollResponsiveness(latency) }],
    ])
    assert.deepEqual(order, ['paint', 'delivery', 'deadlines'])
    assert.deepEqual(checks.results.map(result => result.passed), [true, true, false])
    assert.match(checks.failures[0].message, /Scroll intent exceeded 100 ms/)
    assert.match(checks.failures[0].message, /renderer RAF gap exceeded 100 ms/)
    const withBadPaint = collectAcceptanceChecks([['paint', () => assert.fail('incomplete SVG')], ['deadlines', () => assertScrollResponsiveness(latency)]])
    assert.equal(withBadPaint.failures.length, 2, 'A paint failure must not suppress either timing failure.')
    assert.match(withBadPaint.failures[1].message, /renderer RAF gap exceeded 100 ms/)
    globalThis.document.visibilityState = 'hidden'
    await assert.rejects(measureChartIntentLatency(page, { ...options, enforceBudgets: false }), /lost its visible, focused window/)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('fewer than 100 timing samples report a maximum but omit unstable p95 values', () => {
  assert.deepEqual(summarizeLatencySamples([5, 11]), {
    sampleCount: 2, p50MS: 5, p95MS: null, p95SampleMinimum: 100, p99MS: null, p99SampleMinimum: 1_000, maxMS: 11,
  })
  assert.equal(summarizeLatencySamples(Array.from({ length: 99 }, (_, index) => index + 1)).p95MS, null)
  assert.equal(summarizeLatencySamples(Array.from({ length: 100 }, (_, index) => index + 1)).p95MS, 95)
  assert.equal(summarizeLatencySamples(Array.from({ length: 999 }, (_, index) => index + 1)).p99MS, null)
  assert.equal(summarizeLatencySamples(Array.from({ length: 1_000 }, (_, index) => index + 1)).p99MS, 990)
})

test('latency summaries reject missing, negative, nonfinite, and nonnumeric measurements', () => {
  for (const samples of [[0, -1], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], [1, undefined], [1, '2']]) {
    assert.throws(() => summarizeLatencySamples(samples), TypeError)
  }
  assert.throws(() => summarizeLatencySamples(null), TypeError)
})

test('the explicit warm-statistics contract rejects fixture-known OI and Taker fields even when unobserved', () => {
  const expected = [{ hour: 1, oi: 100, buy: 20, sell: 30 }]
  const missing = [{ hour: 1, oi: null, buy: null, sell: null, oiObserved: false, takerObserved: false }]
  assert.throws(() => assertWarmStatistics(missing, expected), /oi is fixture-known but missing/)
  assert.throws(() => assertWarmStatistics([{ ...missing[0], oi: 100, oiObserved: true }], expected), /buy is fixture-known but missing/)
  assert.deepEqual(assertWarmStatistics([{ hour: 1, oi: 100, buy: 20, sell: 30, oiObserved: true, takerObserved: true }], expected), {
    bars: 1, oiValues: 1, takerValues: 1,
  })
})

test('a missing middle target is accounted through the next committed target and retains its stall', () => {
  const intents = [
    { instId: 'BTC', timeframe: '5m', at: 10, target: 1_000 },
    { instId: 'BTC', timeframe: '5m', at: 20, target: 900 },
    { instId: 'BTC', timeframe: '5m', at: 30, target: 800 },
  ]
  const commits = [
    { instId: 'BTC', timeframe: '5m', at: 12, rafSampledAt: 18, end: 1_000 },
    { instId: 'BTC', timeframe: '5m', at: 180, rafSampledAt: 190, end: 800 },
  ]

  const report = accountChartIntents(intents, commits)

  assert.deepEqual(report.map(({ status, supersededBy }) => ({ status, supersededBy })), [
    { status: 'committed', supersededBy: undefined },
    { status: 'coalesced', supersededBy: 2 },
    { status: 'committed', supersededBy: undefined },
  ])
  assert.equal(report[1].latencyMS, 170, 'The skipped middle intent must include the delay until a later actual chart update.')
  assert.ok(report[1].latencyMS > 100, 'The regression fixture must exceed the regular scroll responsiveness budget.')
})

test('a missing final target cannot disappear as legitimate coalescing', () => {
  const report = accountChartIntents([
    { instId: 'BTC', timeframe: '5m', at: 10, target: 1_000 },
    { instId: 'BTC', timeframe: '5m', at: 20, target: 900 },
  ], [{ instId: 'BTC', timeframe: '5m', at: 12, rafSampledAt: 18, end: 1_000 }])

  assert.equal(report.at(-1).status, 'unaccounted')
  assert.equal(report.at(-1).commit, null)
})

test('intent accounting rejects malformed commit timestamps instead of coalescing around them', () => {
  assert.throws(() => accountChartIntents([{ instId: 'BTC', timeframe: '5m', at: 10, target: 1_000 }], [
    { instId: 'BTC', timeframe: '5m', at: 12, rafSampledAt: Number.NaN, end: 1_000 },
  ]), /finite target and ordered commit\/RAF timestamps/)
})
