#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const installedBaseline = '/Applications/Perpetual Swap Suite.app'
const baselineRevision = 'ab9cb551bd00252abf370a324fe17d1eeacd6db1'

const { values } = parseArgs({
  options: {
    'before-navigation': { type: 'string' },
    'after-navigation': { type: 'string' },
    'before-chart': { type: 'string' },
    'after-chart': { type: 'string' },
    'before-traffic': { type: 'string' },
    'after-traffic': { type: 'string' },
    output: { type: 'string' },
  },
  allowPositionals: false,
})

for (const option of ['before-navigation', 'after-navigation', 'before-chart', 'after-chart']) {
  if (!values[option]) throw new Error(`Missing required --${option} report path.`)
}
if (Boolean(values['before-traffic']) !== Boolean(values['after-traffic'])) {
  throw new Error('Provide both --before-traffic and --after-traffic, or neither.')
}

const noise = {
  rendererTaskMS: { absoluteMS: 10, relative: .15 },
  rendererScriptMS: { absoluteMS: 5, relative: .15 },
  rendererFrameGapP95MS: { absoluteMS: 2, relative: .12 },
  inputToSVGCommitP95MS: { absoluteMS: 2, relative: .2 },
  inputToNextPaintP95MS: { absoluteMS: 2, relative: .12 },
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0
}

function navigationInputs(report) {
  const inputs = []
  for (const [run, source] of [['initial', report], ['restart', report.restart]]) {
    if (!source) continue
    if (run === 'restart' && source.startup) inputs.push({ run, timeframe: source.startup.timeframe, name: 'startup', ...source.startup })
    for (const phase of source.phases ?? []) {
      for (const name of ['firstVisit', 'mouseSwitch', 'rapid', ...(phase.timeframeSwitch ? ['timeframeSwitch'] : [])]) {
        inputs.push({ run, timeframe: phase.timeframe, name, ...phase[name] })
      }
      for (const [index, input] of (phase.keyboard ?? []).entries()) {
        inputs.push({ run, timeframe: phase.timeframe, name: `keyboard-${index + 1}`, ...input })
      }
    }
  }
  return inputs
}

function validateNavigation(report, label) {
  assert.equal(report.mode, 'electron-native-instrument-navigation-input-to-svg-and-next-paint', `${label} is not an instrument navigation benchmark.`)
  assert.equal(report.metadata?.runtime?.network, 'sandbox network disabled; seeded offline fixture', `${label} must use the seeded offline fixture.`)
  assert.deepEqual(report.metadata?.runtime?.native, { visible: false, focused: false, minimized: false, offscreen: true }, `${label} must stay hidden, unfocused and offscreen.`)
  assert.equal(report.metadata?.runtime?.presentation, 'background-only-offscreen', `${label} must use the protected background-only Electron runtime.`)
  assert.equal(report.fixture?.candidates, 16, `${label} must measure the complete 16-contract fixture.`)
  assert.deepEqual(report.fixture?.timeframes, ['5m', '15m', '1H'], `${label} must cover all three chart timeframes.`)
  assert.equal(report.fixture?.periodsPerNativeSeries, 1280, `${label} must use the canonical navigation dataset.`)
  assert.deepEqual(report.violations ?? [], [], `${label} recorded chart correctness violations.`)
  assert.equal(report.minimumBars, 96, `${label} did not present complete 96-bar charts.`)
  const inputs = navigationInputs(report)
  assert.ok(inputs.length > 0, `${label} has no measured navigation inputs.`)
  for (const input of inputs) {
    assert.ok(Number.isFinite(input.inputToSVGCommitMS) && input.inputToSVGCommitMS >= 0, `${label} has an invalid SVG commit measurement.`)
    assert.ok(Number.isFinite(input.inputToNextPaintMS) && input.inputToNextPaintMS >= input.inputToSVGCommitMS, `${label} has an invalid next-paint measurement.`)
    assert.ok(input.framesToCommit <= 1, `${label} exceeded the existing one-frame chart commit budget.`)
    assert.ok(input.selectionIPC <= 2, `${label} exceeded the existing two-request local selection budget.`)
    assert.deepEqual(input.violations ?? [], [], `${label} startup selection used mismatched chart values.`)
  }
  for (const run of [report, report.restart].filter(Boolean)) for (const phase of run.phases ?? []) {
    assert.equal(phase.rendererFrames?.readyCount, 16, `${label} must receive each canonical fixture frame before measuring.`)
    assert.equal(phase.distinctContracts, 16, `${label} did not navigate the full instrument set.`)
  }
  return inputs
}

function chartScenarios(report, label) {
  assert.deepEqual(report.presentation, {
    visible: false, focused: false, offscreen: true, headless: false, disableGPU: false,
    type: 'protected hidden offscreen Electron',
    measurements: 'Full backend focus and prepared-frame delivery, renderer TaskDuration, and renderer RAF gaps. Native compositor paint is not measured.',
  }, `${label} must use the same protected offscreen presentation and measurement scope.`)
  assert.deepEqual(report.fixture?.timeframes, ['5m', '15m', '1H'], `${label} must cover every chart timeframe.`)
  assert.equal(report.fixture?.periods, 3072, `${label} must use the canonical chart scroll fixture.`)
  assert.equal(report.movement?.crossesResidentReserveBoundary, true, `${label} must exercise resident and reserve-boundary scrolling.`)
  const result = new Map()
  for (const trial of report.dataReadyCached?.trials ?? []) {
    for (const name of ['cached90Step', 'reserveTraversal']) {
      const scenario = trial.scenarios?.[name]
      assert.ok(scenario, `${label} is missing ${trial.timeframe}/${name}.`)
      assert.equal(scenario.oracle?.matchedBars, 96, `${label} ${trial.timeframe}/${name} must match all visible candles.`)
      assert.equal(scenario.oracle?.matchedFieldsPerBar, 19, `${label} ${trial.timeframe}/${name} must match all canonical output fields.`)
      assert.equal(scenario.deliveryBudget?.withinBudget, true, `${label} ${trial.timeframe}/${name} exceeded its data-driven delivery budget.`)
      assert.ok(scenario.fullPipeline?.duplicateFullHistorySignatures === 0, `${label} ${trial.timeframe}/${name} repeated a full-history payload.`)
      assert.equal(scenario.fullPipeline?.historicalSourceRequests, 0, `${label} ${trial.timeframe}/${name} unexpectedly fetched historical source pages.`)
      assert.equal(scenario.fullPipeline?.repeatedSourceDownloads, 0, `${label} ${trial.timeframe}/${name} repeated a historical download.`)
      for (const field of ['fullHistoryPushBars', 'historicalPullBars']) {
        assert.ok(Number.isFinite(scenario.fullPipeline?.[field]) && scenario.fullPipeline[field] >= 0,
          `${label} ${trial.timeframe}/${name} has invalid ${field} evidence.`)
      }
      assert.equal(scenario.offscreenObservation?.nativePaintMeasured, false, `${label} cannot claim native compositor paint from the offscreen run.`)
      assert.ok(Number.isFinite(scenario.offscreenObservation?.rendererTaskMS), `${label} has no renderer task measurement.`)
      assert.ok(Number.isFinite(scenario.offscreenObservation?.rendererScriptMS), `${label} has no renderer script measurement.`)
      assert.ok(Number.isFinite(scenario.offscreenObservation?.rafGapMS?.p95), `${label} has no renderer frame gap measurement.`)
      result.set(`${trial.timeframe}/${name}`, scenario)
    }
  }
  assert.equal(result.size, 6, `${label} must include both scroll scenarios for all three timeframes.`)
  const cold = report.coldAcquisition?.boundary
  assert.ok(cold, `${label} has no cold acquisition boundary.`)
  assert.deepEqual(cold.violations, [], `${label} cold acquisition reported an output correctness violation.`)
  assert.equal(cold.observedFieldOracle?.checksCanonicalValues, true, `${label} cold acquisition did not check canonical field values.`)
  assert.equal(cold.observedFieldOracle?.unobservedFieldsRemainNull, true, `${label} cold acquisition must preserve explicit missing values.`)
  return { scenarios: result, cold }
}

function compareMetric(before, after, metric) {
  const tolerance = noise[metric]
  const allowedIncrease = Math.max(tolerance.absoluteMS, Math.abs(before) * tolerance.relative)
  const ratio = before === 0 ? (after === 0 ? 1 : Infinity) : after / before
  return { before, after, allowedIncreaseMS: Number(allowedIncrease.toFixed(3)), ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : null,
    passed: after <= before + allowedIncrease }
}

function networkSummary(evidence, label) {
  const source = evidence.evidence ?? evidence
  const sample = source.recentSample
  assert.ok(sample && Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0, `${label} has no bounded traffic sample duration.`)
  for (const field of ['publicMessagePayloadBytes', 'businessMessagePayloadBytes', 'httpResponseBodyBytes', 'publicMessageCount']) {
    assert.ok(Number.isFinite(sample[field]) && sample[field] >= 0, `${label} is missing recentSample.${field}.`)
  }
  const plan = source.computedDefaultSubscriptions ?? {}
  return {
    revision: source.revision ?? null,
    durationSeconds: sample.durationSeconds,
    publicMessagePayloadBytesPerSecond: sample.publicMessagePayloadBytes / sample.durationSeconds,
    businessMessagePayloadBytesPerSecond: sample.businessMessagePayloadBytes / sample.durationSeconds,
    httpResponseBodyBytesPerSecond: sample.httpResponseBodyBytes / sample.durationSeconds,
    totalPayloadBytesPerSecond: (sample.publicMessagePayloadBytes + sample.businessMessagePayloadBytes + sample.httpResponseBodyBytes) / sample.durationSeconds,
    publicMessagesPerSecond: sample.publicMessageCount / sample.durationSeconds,
    marketChannels: Number.isFinite(plan.marketChannels) ? plan.marketChannels : null,
    publicSockets: Number.isFinite(plan.publicSockets) ? plan.publicSockets : null,
    publicSharePercent: Number.isFinite(source.recentSample?.publicSharePercent) ? source.recentSample.publicSharePercent : null,
  }
}

const [beforeNavigation, afterNavigation, beforeChart, afterChart] = await Promise.all([
  json(values['before-navigation']), json(values['after-navigation']), json(values['before-chart']), json(values['after-chart']),
])
const beforeInputs = validateNavigation(beforeNavigation, 'Before navigation')
const afterInputs = validateNavigation(afterNavigation, 'After navigation')
assert.equal(beforeInputs.length, afterInputs.length, 'Before and after navigation runs must contain the same number of measured inputs.')
assert.equal(beforeNavigation.metadata.runtime.electronVersion, afterNavigation.metadata.runtime.electronVersion, 'Before and after must use the same protected Electron version.')
assert.equal(beforeNavigation.metadata.runtime.sourceFingerprint, afterNavigation.metadata.runtime.sourceFingerprint, 'Before and after must use the same protected Electron runtime bundle.')
assert.equal(beforeNavigation.metadata.targetBuild.revision, 'ab9cb551bd00252abf370a324fe17d1eeacd6db1', 'Before navigation artifact must come from the installed ab9cb551 baseline.')
assert.equal(beforeNavigation.metadata.targetBuild.dirty, false, 'Before navigation artifact must come from a clean installed build.')
assert.equal(resolve(beforeNavigation.appRoot), installedBaseline, 'Before navigation must run the installed baseline app.')
assert.equal(resolve(beforeChart.appRoot), installedBaseline, 'Before chart scrolling must run the installed baseline app.')
assert.equal(resolve(afterNavigation.appRoot), projectRoot, 'After navigation must run the future working-tree app entry.')
assert.equal(resolve(afterChart.appRoot), projectRoot, 'After chart scrolling must run the future working-tree app entry.')
assert.equal(afterNavigation.metadata.targetBuild.provenance, 'working-tree checkout', 'After navigation must record working-tree provenance.')

const beforeCharts = chartScenarios(beforeChart, 'Before chart')
const afterCharts = chartScenarios(afterChart, 'After chart')
assert.deepEqual(beforeChart.fixture, afterChart.fixture, 'Before and after chart runs must use identical offline fixture identity and ranges.')

const performance = {}
for (const [key, beforeScenario] of beforeCharts.scenarios) {
  const afterScenario = afterCharts.scenarios.get(key)
  assert.ok(afterScenario, `After chart is missing ${key}.`)
  const beforeMetrics = beforeScenario.offscreenObservation
  const afterMetrics = afterScenario.offscreenObservation
    const beforePushBars = beforeScenario.fullPipeline.fullHistoryPushBars
    const afterPushBars = afterScenario.fullPipeline.fullHistoryPushBars
    const beforePullBars = beforeScenario.fullPipeline.historicalPullBars
    const afterPullBars = afterScenario.fullPipeline.historicalPullBars
    performance[key] = {
    rendererTaskMS: compareMetric(beforeMetrics.rendererTaskMS, afterMetrics.rendererTaskMS, 'rendererTaskMS'),
    rendererScriptMS: compareMetric(beforeMetrics.rendererScriptMS, afterMetrics.rendererScriptMS, 'rendererScriptMS'),
    rendererFrameGapP95MS: compareMetric(beforeMetrics.rafGapMS.p95, afterMetrics.rafGapMS.p95, 'rendererFrameGapP95MS'),
      fullHistoryTransferredBars: {
        before: beforePushBars + beforePullBars,
        after: afterPushBars + afterPullBars,
        passed: afterPushBars + afterPullBars <= beforePushBars + beforePullBars,
        pushBars: { before: beforePushBars, after: afterPushBars },
        pullBars: { before: beforePullBars, after: afterPullBars },
      },
  }
}

const beforeCommitP95 = percentile(beforeInputs.map(input => input.inputToSVGCommitMS), .95)
const afterCommitP95 = percentile(afterInputs.map(input => input.inputToSVGCommitMS), .95)
const beforePaintP95 = percentile(beforeInputs.map(input => input.inputToNextPaintMS), .95)
const afterPaintP95 = percentile(afterInputs.map(input => input.inputToNextPaintMS), .95)
const beforeIPC = beforeInputs.reduce((sum, input) => sum + input.selectionIPC, 0)
const afterIPC = afterInputs.reduce((sum, input) => sum + input.selectionIPC, 0)
performance.instrumentNavigation = {
  inputToSVGCommitP95MS: compareMetric(beforeCommitP95, afterCommitP95, 'inputToSVGCommitP95MS'),
  inputToNextPaintP95MS: compareMetric(beforePaintP95, afterPaintP95, 'inputToNextPaintP95MS'),
  maximumInputToSVGCommitMS: { before: Math.max(...beforeInputs.map(input => input.inputToSVGCommitMS)), after: Math.max(...afterInputs.map(input => input.inputToSVGCommitMS)),
    passed: Math.max(...afterInputs.map(input => input.inputToSVGCommitMS)) <= 50 },
  selectionIPC: { before: beforeIPC, after: afterIPC, maximumPerSelection: Math.max(...afterInputs.map(input => input.selectionIPC)),
    passed: afterIPC <= beforeIPC && Math.max(...afterInputs.map(input => input.selectionIPC)) <= 2 },
}

let traffic
if (values['before-traffic']) {
  const [beforeEvidence, afterEvidence] = await Promise.all([json(values['before-traffic']), json(values['after-traffic'])])
  const before = networkSummary(beforeEvidence, 'Before traffic evidence')
  const after = networkSummary(afterEvidence, 'After traffic evidence')
  assert.equal(before.revision, baselineRevision, 'Before traffic evidence must come from the installed baseline revision.')
  assert.ok(before.durationSeconds * 0.8 <= after.durationSeconds && after.durationSeconds <= before.durationSeconds * 1.2,
    'Before and after traffic samples must have similar bounded durations.')
  const withinSamplingNoise = (beforeRate, afterRate) => afterRate <= beforeRate * 1.1
  traffic = {
    measurement: 'bounded read-only application byte sample; rates are descriptive and are not transport or billing byte estimates',
    before, after,
    publicPayloadReduced: after.publicMessagePayloadBytesPerSecond < before.publicMessagePayloadBytesPerSecond,
    httpPayloadReduced: after.httpResponseBodyBytesPerSecond < before.httpResponseBodyBytesPerSecond,
    totalPayloadWithinTenPercentNoise: withinSamplingNoise(before.totalPayloadBytesPerSecond, after.totalPayloadBytesPerSecond),
    httpPayloadWithinTenPercentNoise: withinSamplingNoise(before.httpResponseBodyBytesPerSecond, after.httpResponseBodyBytesPerSecond),
    subscriptionPlanDidNotGrow: (before.marketChannels == null || after.marketChannels == null || after.marketChannels <= before.marketChannels)
      && (before.publicSockets == null || after.publicSockets == null || after.publicSockets <= before.publicSockets),
  }
}

const failures = []
for (const [key, result] of Object.entries(performance)) for (const [metric, value] of Object.entries(result)) {
  if (value && typeof value === 'object' && 'passed' in value && !value.passed) failures.push(`${key}.${metric}`)
}
if (traffic) for (const key of ['totalPayloadWithinTenPercentNoise', 'httpPayloadWithinTenPercentNoise', 'subscriptionPlanDidNotGrow']) {
  if (!traffic[key]) failures.push(`traffic.${key}`)
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: { networkRequestsInitiated: false, rendererPresentation: 'hidden, unfocused, protected offscreen Electron',
    interactionBudgets: 'One animation frame to commit; at most two local selection IPC requests; output oracle preserved.' },
  artifacts: Object.fromEntries(['before-navigation', 'after-navigation', 'before-chart', 'after-chart', 'before-traffic', 'after-traffic']
    .filter(option => values[option]).map(option => [option, resolve(values[option])])),
  fixture: { candidates: beforeNavigation.fixture.candidates, timeframes: beforeNavigation.fixture.timeframes,
    navigationInputs: beforeInputs.length, chartScenarios: [...beforeCharts.scenarios.keys()] },
  noiseTolerances: noise,
  performance,
  traffic: traffic ?? { status: 'not-compared', reason: 'Pass paired bounded traffic evidence with --before-traffic and --after-traffic.' },
  correctness: { beforeNavigationViolations: beforeNavigation.violations.length, afterNavigationViolations: afterNavigation.violations.length,
    beforeChartColdBoundaryViolations: beforeCharts.cold.violations.length, afterChartColdBoundaryViolations: afterCharts.cold.violations.length,
    allChartScenariosPreserveCanonicalOutput: true, missingValuesRemainExplicit: true },
  outcome: failures.length ? 'failed' : 'passed', failures,
}

if (values.output) {
  const outputPath = resolve(values.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
