import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeReport, summarizeResources } from './analyze.mjs'

// A small complete replay fixture, independent of ignored measurement artifacts.
function reportFixture() {
  const instIds = Array.from({ length: 287 }, (_, index) => `SCALE${String(index).padStart(3, '0')}-USDT-SWAP`)
  const processes = [{ webKitRoot: true, name: 'com.apple.WebKit.WebContent' }]
  const group = { complete: true, cpuNsExact: '100000000', cpuEnergyNjExact: '200000000' }
  const totals = Object.fromEntries(['runtime', 'backend', 'combined'].map(key => [key, { complete: true, physicalFootprintBytes: 1048576 }]))
  const samples = [
    { frontmostIsRuntime: false, responsibleLookupAvailable: true, processes, totals, interval: null },
    { frontmostIsRuntime: false, responsibleLookupAvailable: true, processes, totals,
      interval: { elapsedNsExact: '1000000000', runtime: group, backend: group, combined: group } },
  ]
  const phase = scenario => ({ scenario, durationMS: 1000, errors: [], failures: [], pendingInputs: 0, visibility: ['visible'],
    resources: { samples, skippedSamples: 0 },
    inputCounts: { planned: 1 }, inputs: [{ index: 0, kind: 'wheel', targetEnd: 1000, status: 'committed', correct: true, latencyMS: 10 }],
    ...(scenario === 'realtime' ? {
      load: { state: 'complete', plannedTicks: 60, cadenceMS: 500, emitted: 60, completed: 60, failed: 0 },
      deliveries: Array.from({ length: 60 }, (_, index) => ({ sequence: index + 1, expected: 100 + index, status: 'committed' })),
      live: Array.from({ length: 60 }, (_, index) => ({ close: 100 + index, status: 'committed', caughtUp: true, receiveToRAFMS: 5, sourceToRAFMS: 10 })),
    } : {}),
  })
  return { schemaVersion: 1, smoke: false, outcome: 'passed', rounds: 3, canonicalDataHash: 'same',
    measurement: { count: 287, requestedCadenceMS: 500, syntheticInteractionCadenceMS: 200 },
    runs: [1, 2, 3].flatMap(round => (round === 2 ? ['tauri', 'electron'] : ['electron', 'tauri']).map(runtime => ({
      round, runtime, outcome: 'passed', fixture: { count: 287, periods: 384, instIds, timeframes: ['5m', '15m', '1H'], rowsSeeded: 330624 },
      canonicalDataHash: 'same', pathComparison: { compatible: true },
      final: { liveMismatches: [], ticks: 60, nativeUpdates: 51660, actualRows: 330624 },
      phases: [phase('history'), phase('realtime')],
    }))) }
}

test('superseded work remains diagnostic and cannot produce paired resource deltas', () => {
  const report = reportFixture()
  assert.equal(analyzeReport(report).paired.history.pairs[0].validWorkload, true)
  report.runs[0].phases[0].inputs[0].status = 'superseded'
  const summary = analyzeReport(report)
  assert.equal(summary.trials[0].inputs.superseded, 1)
  assert.equal(summary.paired.history.pairs[0].validWorkload, false)
  assert.equal(summary.paired.history.pairs[0].relativePercent.combined.cpuSeconds, null)
})

test('missing focused live deliveries cannot produce paired resource deltas', () => {
  const report = reportFixture()
  assert.equal(analyzeReport(report).paired.realtime.pairs[0].validWorkload, true)
  report.runs[0].phases[1].deliveries[0].status = 'missing'
  const summary = analyzeReport(report)
  assert.equal(summary.trials[1].realtime.missing, 1)
  assert.equal(summary.paired.realtime.pairs[0].validWorkload, false)
  assert.equal(summary.paired.realtime.pairs[0].relativePercent.combined.cpuEnergyJoules, null)
})

test('explicit measurement boundaries exclude setup and reject incomplete boundaries', () => {
  const sample = (boundary, energy) => ({ boundary, totals: {}, interval: energy == null ? null : {
    elapsedNsExact: '1000000000', combined: { complete: true, cpuNsExact: '1', cpuEnergyNjExact: String(energy) },
  } })
  const resources = { samples: [sample(null, null), sample('start', 1000000000), sample('end', 2000000000), sample(null, 3000000000)] }
  const result = summarizeResources(resources).combined
  assert.equal(result.cpuEnergyJoules, 2)
  assert.equal(result.cpuMeanWatts, 2)
  assert.equal(result.coverage.boundaryStatus, 'explicit')
  resources.samples[2].boundary = null
  assert.equal(summarizeResources(resources).combined.cpuEnergyJoules, null)
  assert.equal(summarizeResources(resources).combined.coverage.boundaryStatus, 'invalid')
})

test('preserves a confirmed counter total when its P/E split is unavailable', () => {
  const part = { complete: false, totalComplete: true, totalExact: '123', pCoreExact: null, eCoreExact: null }
  const resources = { samples: [{ boundary: 'start' }, { boundary: 'end', interval: {
    elapsedNsExact: '1000000000', combined: { complete: true, cpuNsExact: '1', breakdown: { cpuCycles: part } },
  } }] }
  const cycles = summarizeResources(resources).combined.breakdown.cpuCycles
  assert.equal(cycles.totalExact, '123')
  assert.equal(cycles.totalComplete, true)
  assert.equal(cycles.complete, false)
  assert.equal(cycles.pCoreExact, null)
  assert.equal(cycles.eCoreExact, null)
})


test('rejects counter splits without duration or conservation', () => {
  const part = { complete: true, totalComplete: true, totalExact: '12', pCoreExact: '5', eCoreExact: '6' }
  const interval = { elapsedNsExact: '1000000000', combined: { breakdown: { cpuCycles: part } } }
  const resources = { samples: [{ boundary: 'start' }, { boundary: 'end', interval }] }
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.complete, false)
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.totalExact, '12')
  part.eCoreExact = '7'
  interval.elapsedNsExact = '0'
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.complete, false)
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.totalComplete, false)
})
