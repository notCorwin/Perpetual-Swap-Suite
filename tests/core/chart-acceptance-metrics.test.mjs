import assert from 'node:assert/strict'
import test from 'node:test'

test('a different native timeframe or instrument cannot acknowledge a scroll target', () => {
  const intent = { instId: 'BTC', timeframe: '5m', at: 10, target: 1000 }
  for (const identity of [{ instId: 'BTC', timeframe: '1H' }, { instId: 'ETH', timeframe: '5m' }]) {
    const result = accountChartIntents([intent], [{ ...identity, at: 12, rafSampledAt: 18, end: 1000 }])
    assert.equal(result[0].status, 'unaccounted')
  }
})
import { accountChartIntents, assertScrollResponsiveness, assertWarmStatistics, summarizeLatencySamples } from '../../scripts/chart-acceptance-metrics.mjs'

test('RAF stalls fail even when the synthetic input loop resumes with fast responses', () => {
  const report = { intentLatenciesMS: [12, 15, 10], unaccountedInputs: [], maxFrameGapMS: 200 }
  assert.throws(() => assertScrollResponsiveness(report), /RAF gap exceeded/)
  assert.doesNotThrow(() => assertScrollResponsiveness({ ...report, maxFrameGapMS: 33.4 }))
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
