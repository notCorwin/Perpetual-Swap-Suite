import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { analyzeAttribution } from './attribution-analysis.mjs'

// Small synthetic measurements, but the complete formal workload and matrix:
// these records exercise the external report contract without launching apps.
function formalReport() {
  const instIds = Array.from({ length: 287 }, (_, i) => `SCALE${String(i).padStart(3, '0')}-USDT-SWAP`)
  const fixture = { instIds, count: 287, periods: 384, timeframes: ['5m', '15m', '1H'], rowsSeeded: 330624 }
  const chart = { instId: instIds[0], endHour: 1000, bars: Array.from({ length: 96 }, (_, i) => ({ hour: i, close: i })), svgPaths: [['ema', 'M0 0']] }
  const hash = createHash('sha256').update(JSON.stringify({ ...chart, svgPaths: undefined })).digest('hex')
  const variants = ['http', 'native'].flatMap(transport => ['full', 'off'].map(telemetry => ({ transport, telemetry })))
  const ticks = Array.from({ length: 60 }, (_, i) => ({ sequence: i + 1, expected: 100 + 10 + 384 * .01 + (i + 1) * .001,
    instId: instIds[0], timeframe: '15m', nativeUpdates: 861 }))
  const load = { state: 'complete', plannedTicks: 60, cadenceMS: 500, firstSequence: 1, emitted: 60, completed: 60, pending: 0, failed: 0, ticks }
  const runs = [1, 2, 3].flatMap(round => variants.flatMap(({ transport, telemetry }) => ['electron', 'tauri'].map(runtime => {
    const value = (transport === 'http' ? 2 : 1) - (telemetry === 'off' ? .5 : 0) + (runtime === 'tauri' ? 1 : 0) + (round - 1) * .1
    const group = { complete: true, cpuNsExact: String(Math.round(value * 1e9)), cpuEnergyNjExact: String(Math.round(value * 2e9)) }
    const totals = Object.fromEntries(['runtime', 'backend', 'combined'].map(key => [key, { complete: true, physicalFootprintBytes: 1048576 }]))
    const processes = [{ webKitRoot: true, name: 'com.apple.WebKit.WebContent' }]
    const samples = [{ frontmostIsRuntime: false, responsibleLookupAvailable: true, processes, totals, interval: null },
      { frontmostIsRuntime: false, responsibleLookupAvailable: true, processes, totals,
        interval: { elapsedNsExact: '1000000000', runtime: group, backend: group, combined: group } }]
    const inputs = Array.from({ length: 152 }, (_, index) => ({ index, kind: 'search', term: index % 2 ? '' : instIds[0].toLowerCase(),
      expectedCount: index % 2 ? fixture.count : 1, status: 'committed', correct: true, latencyMS: round }))
    const deliveries = ticks.map(({ sequence, expected }) => ({ sequence, expected, status: 'committed' }))
    const live = ticks.map(({ expected }) => ({ close: expected, displayedClose: expected, status: 'committed', caughtUp: true, receiveToRAFMS: round * 2, sourceToRAFMS: round * 3 }))
    return structuredClone({ round, runtime, transport, telemetry, outcome: 'passed', fixture,
      canonicalDataHash: hash, pathComparison: { compatible: true }, prepared: { visibility: 'visible', errors: [], bars: 96, chart },
      final: { ticks: 60, nativeUpdates: 51660, actualRows: 330624, minimumRowsPerSeries: 384, liveProjectionSeeds: 861, liveMismatches: [], load },
      phases: [{ scenario: 'realtime', durationMS: 30600, errors: [], failures: [], visibility: ['visible'], finalChart: chart,
        inputs, pendingInputs: 0, inputCounts: { planned: 152, dispatched: 152, committed: 152, superseded: 0 }, deliveries, live, load,
        expectedClose: ticks.at(-1).expected, rafCount: 1836, resources: { samples, skippedSamples: 0 },
        transportMetrics: { requests: { request: 10 }, requestBytes: { request: 100 }, responseBytes: { request: 200 },
          events: { 'radar:chart-prepared': 60 }, eventBytes: { 'radar:chart-prepared': 1000 } } }],
    })
  })))
  return { schemaVersion: 1, smoke: false, outcome: 'passed', rounds: 3, variants, scenarios: ['realtime'],
    diagnostics: false, sampleStacks: false, v8Profile: false, engineProfile: false, canonicalDataHash: hash,
    measurement: { count: 287, periods: 384, requestedCadenceMS: 500, syntheticInteractionCadenceMS: 200 }, runs }
}
const run = (report, round, runtime = 'electron', transport = 'http', telemetry = 'full') =>
  report.runs.find(item => item.round === round && item.runtime === runtime && item.transport === transport && item.telemetry === telemetry)

test('complete matrix produces signed paired effects and trial-percentile summaries', () => {
  const result = analyzeAttribution(formalReport())
  assert.deepEqual(result.baselineEligibility, { eligible: true, reasons: [] })
  const removal = result.contrasts.telemetryRemoval.electron.http.metrics.combined
  assert.equal(removal.cpuEnergyJoules.absoluteChange.median, -1)
  assert.equal(removal.cpuPercentOfOneCore.absoluteChange.median, -50)
  assert.equal(removal.cpuEnergyJoules.absoluteChange.n, 3)
  assert.equal(result.contrasts.transportSwitch.electron.full.metrics.combined.cpuEnergyJoules.absoluteChange.median, -2)
  assert.equal(result.contrasts.crossRuntimeNativeOff.metrics.combined.cpuEnergyJoules.absoluteChange.median, 2)
  assert.equal(result.contrasts.interaction.electron.metrics.combined.cpuEnergyJoules.absoluteInteraction.median, 0)
  assert.equal(result.grouped.electron.http.full.latencyMS.p95.input.median, 2)
  assert.equal(result.grouped.electron.http.full.latencyMS.p95.receiveToRAF.median, 4)
  assert.equal(result.trials[0].transportMetrics.routes.request.requestBytes, 100)
  assert.equal(result.trials[0].transportMetrics.events['radar:chart-prepared'].count, 60)
  assert.equal(result.trials[0].inputs.acknowledged, 152)
  assert.equal(result.trials[0].raf.opportunitiesPerSecond, 60)
})

test('incomplete inputs, unequal deliveries or throttled scheduling invalidate baseline causal estimates', () => {
  for (const tamper of [
    phase => { phase.inputs[0].status = 'superseded' },
    phase => { phase.deliveries[0].expected += 1 },
    phase => { phase.live[0].status = 'coalesced' },
    phase => { phase.inputs[0].term = 'different contract' },
    phase => { phase.rafCount = 0 },
  ]) {
    const report = formalReport()
    tamper(run(report, 1).phases[0])
    const result = analyzeAttribution(report), contrast = result.contrasts.telemetryRemoval.electron.http
    assert.equal(result.baselineEligibility.eligible, false)
    assert.equal(contrast.metrics.combined.cpuEnergyJoules.absoluteChange.n, 0)
    assert.equal(contrast.pairs[0].values.combined.cpuEnergyJoules.absoluteChange, null)
    assert.ok(contrast.pairs[0].values.combined.cpuEnergyJoules.reasons.length)
  }
})

test('incomplete energy intervals invalidate only the affected metric and require all three pairs', () => {
  const report = formalReport()
  run(report, 2).phases[0].resources.samples[1].interval.combined.cpuEnergyNjExact = null
  const result = analyzeAttribution(report), contrast = result.contrasts.telemetryRemoval.electron.http
  assert.equal(result.baselineEligibility.eligible, true)
  assert.equal(contrast.pairs[1].values.combined.cpuEnergyJoules.valid, false)
  assert.match(contrast.pairs[1].values.combined.cpuEnergyJoules.reasons.join(), /coverage/)
  assert.equal(contrast.metrics.combined.cpuEnergyJoules.availablePairs, 2)
  assert.equal(contrast.metrics.combined.cpuEnergyJoules.absoluteChange.n, 0)
  assert.equal(contrast.metrics.combined.cpuPercentOfOneCore.absoluteChange.n, 3)
  assert.equal(result.trials.find(t => t.round === 2 && t.runtime === 'electron' && t.transport === 'http' && t.telemetry === 'full').resources.combined.cpuEnergyJoules, null)
})

test('zero baselines retain absolute changes but cannot produce relative percentages', () => {
  const report = formalReport()
  for (const round of [1, 2, 3]) {
    run(report, round).phases[0].resources.samples[1].interval.combined.cpuNsExact = '0'
  }
  const metric = analyzeAttribution(report).contrasts.telemetryRemoval.electron.http.metrics.combined.cpuPercentOfOneCore
  assert.equal(metric.absoluteChange.n, 3)
  assert.equal(metric.relativePercent.n, 0)
  assert.match(metric.relativeReasons.join(), /not positive/)
})

test('diagnostic and smoke opt-ins show trials without producing baseline estimates', () => {
  const report = formalReport()
  report.diagnostics = true
  assert.throws(() => analyzeAttribution(report), /allow-diagnostics/)
  let result = analyzeAttribution(report, { allowDiagnostics: true })
  assert.equal(result.trials.length, 24)
  assert.equal(result.contrasts.interaction.electron.metrics.combined.cpuEnergyJoules.absoluteInteraction.n, 0)
  report.diagnostics = false
  report.engineProfile = true
  assert.throws(() => analyzeAttribution(report), /allow-diagnostics/)
  assert.equal(analyzeAttribution(report, { allowDiagnostics: true }).baselineEligibility.eligible, false)
  report.engineProfile = false
  report.smoke = true
  assert.throws(() => analyzeAttribution(report), /allow-smoke/)
  result = analyzeAttribution(report, { allowSmoke: true })
  assert.equal(result.baselineEligibility.eligible, false)
  assert.equal(result.contrasts.crossRuntimeNativeOff.metrics.combined.cpuEnergyJoules.absoluteChange.n, 0)
})

test('missing or modified correctness evidence cannot be silently accepted', () => {
  const report = formalReport()
  run(report, 3).prepared.chart.bars[0].close += 1
  const result = analyzeAttribution(report)
  assert.equal(result.baselineEligibility.eligible, false)
  assert.match(result.baselineEligibility.reasons.join(), /hash/)
  assert.equal(result.contrasts.transportSwitch.electron.full.metrics.combined.cpuMeanWatts.absoluteChange.n, 0)
})
