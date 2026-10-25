import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const comparisonScript = join(root, 'scripts/traffic-optimization-comparison.mjs')
const installedBaseline = '/Applications/Perpetual Swap Suite.app'
const baselineRevision = 'ab9cb551bd00252abf370a324fe17d1eeacd6db1'

function navigationReport(appRoot) {
  const input = { inputToSVGCommitMS: 3, inputToNextPaintMS: 17, framesToCommit: 1, selectionIPC: 1, violations: [] }
  return {
    mode: 'electron-native-instrument-navigation-input-to-svg-and-next-paint',
    metadata: { runtime: { network: 'sandbox network disabled; seeded offline fixture',
      native: { visible: false, focused: false, minimized: false, offscreen: true },
      presentation: 'background-only-offscreen', electronVersion: '44.9.0', sourceFingerprint: 'fixed-test-runtime' },
      targetBuild: { revision: baselineRevision, dirty: appRoot !== installedBaseline,
        provenance: appRoot === installedBaseline ? 'installed build' : 'working-tree checkout' } },
    appRoot,
    fixture: { candidates: 16, timeframes: ['5m', '15m', '1H'], periodsPerNativeSeries: 1280 },
    violations: [], minimumBars: 96,
    phases: [{ timeframe: '1H', rendererFrames: { readyCount: 16 }, distinctContracts: 16,
      firstVisit: input, mouseSwitch: input, rapid: input, keyboard: [input] }],
  }
}

function chartReport({ appRoot = installedBaseline, rendererTaskMS = 100, rendererScriptMS = 40, frameGapMS = 16.7,
  pushes = 96, pulls = 192, fullHistoryByScenario = {} } = {}) {
  const scenario = (timeframe, name) => {
    const evidence = fullHistoryByScenario[`${timeframe}/${name}`] ?? { pushes, pulls }
    return ({
    oracle: { matchedBars: 96, matchedFieldsPerBar: 19 },
    deliveryBudget: { withinBudget: true },
    fullPipeline: { duplicateFullHistorySignatures: 0, historicalSourceRequests: 0, repeatedSourceDownloads: 0,
      fullHistoryPushBars: evidence.pushes, historicalPullBars: evidence.pulls },
    offscreenObservation: { rendererTaskMS, rendererScriptMS, rafGapMS: { p95: frameGapMS }, nativePaintMeasured: false },
  })
  }
  return {
    appRoot,
    presentation: { visible: false, focused: false, offscreen: true, headless: false, disableGPU: false,
      type: 'protected hidden offscreen Electron',
      measurements: 'Full backend focus and prepared-frame delivery, renderer TaskDuration, and renderer RAF gaps. Native compositor paint is not measured.' },
    fixture: { instId: 'SOL-USDT-SWAP', timeframes: ['5m', '15m', '1H'], periods: 3072, end: 1760702400000 },
    movement: { crossesResidentReserveBoundary: true },
    dataReadyCached: { trials: ['5m', '15m', '1H'].map(timeframe => ({ timeframe,
      scenarios: { cached90Step: scenario(timeframe, 'cached90Step'), reserveTraversal: scenario(timeframe, 'reserveTraversal') } })) },
    coldAcquisition: { boundary: { violations: [], observedFieldOracle: { checksCanonicalValues: true, unobservedFieldsRemainNull: true } } },
  }
}

function trafficEvidence({ publicBytes = 100_000, httpBytes = 20_000, marketChannels = 100 } = {}) {
  return { revision: baselineRevision, computedDefaultSubscriptions: { marketChannels, publicSockets: 2 }, recentSample: {
    durationSeconds: 20, publicMessagePayloadBytes: publicBytes, businessMessagePayloadBytes: 10_000,
    httpResponseBodyBytes: httpBytes, publicMessageCount: 250, publicSharePercent: 90,
  } }
}

async function compare(directory, { beforeChart, afterChart, beforeTraffic, afterTraffic } = {}) {
  const paths = {
    beforeNavigation: join(directory, 'before-navigation.json'), afterNavigation: join(directory, 'after-navigation.json'),
    beforeChart: join(directory, 'before-chart.json'), afterChart: join(directory, 'after-chart.json'),
    beforeTraffic: join(directory, 'before-traffic.json'), afterTraffic: join(directory, 'after-traffic.json'),
  }
  const files = [
    [paths.beforeNavigation, navigationReport(installedBaseline)], [paths.afterNavigation, navigationReport(root)],
    [paths.beforeChart, beforeChart ?? chartReport()], [paths.afterChart, afterChart ?? chartReport({ appRoot: root })],
  ]
  if (beforeTraffic && afterTraffic) files.push([paths.beforeTraffic, beforeTraffic], [paths.afterTraffic, afterTraffic])
  await Promise.all(files.map(([path, data]) => writeFile(path, `${JSON.stringify(data)}\n`)))
  const args = [comparisonScript, '--before-navigation', paths.beforeNavigation, '--after-navigation', paths.afterNavigation,
    '--before-chart', paths.beforeChart, '--after-chart', paths.afterChart]
  if (beforeTraffic && afterTraffic) args.push('--before-traffic', paths.beforeTraffic, '--after-traffic', paths.afterTraffic)
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  assert.ok(result.stdout, `Comparison did not produce a report: ${result.stderr}`)
  const report = JSON.parse(result.stdout)
  return { ...result, report }
}

test('traffic comparison accepts matching offline evidence and reports lower sampled traffic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-optimization-comparison-'))
  try {
    const result = await compare(directory, { beforeTraffic: trafficEvidence(), afterTraffic: trafficEvidence({ publicBytes: 90_000, httpBytes: 10_000, marketChannels: 80 }) })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.report.outcome, 'passed')
    assert.equal(result.report.traffic.publicPayloadReduced, true)
    assert.equal(result.report.traffic.httpPayloadReduced, true)
    assert.equal(result.report.traffic.subscriptionPlanDidNotGrow, true)
    assert.equal(result.report.correctness.missingValuesRemainExplicit, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('traffic comparison flags renderer cost growth beyond its declared noise allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-optimization-regression-'))
  try {
    const result = await compare(directory, { afterChart: chartReport({ appRoot: root, rendererTaskMS: 140 }) })
    assert.equal(result.status, 1)
    assert.equal(result.report.outcome, 'failed')
    assert.ok(result.report.failures.includes('5m/cached90Step.rendererTaskMS'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('chart comparison allows full-history bars to shift between push and pull when the total is unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-optimization-history-split-'))
  try {
    const result = await compare(directory, {
      beforeChart: chartReport({ fullHistoryByScenario: { '15m/reserveTraversal': { pushes: 6_144, pulls: 7_680 } } }),
      afterChart: chartReport({ appRoot: root, fullHistoryByScenario: { '15m/reserveTraversal': { pushes: 7_680, pulls: 6_144 } } }),
    })
    assert.equal(result.status, 0, result.stderr)
    const transfer = result.report.performance['15m/reserveTraversal'].fullHistoryTransferredBars
    assert.deepEqual(transfer, { before: 13_824, after: 13_824, passed: true,
      pushBars: { before: 6_144, after: 7_680 }, pullBars: { before: 7_680, after: 6_144 } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('chart comparison rejects growth in combined full-history push and pull bars', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-optimization-history-growth-'))
  try {
    const result = await compare(directory, {
      beforeChart: chartReport({ fullHistoryByScenario: { '15m/reserveTraversal': { pushes: 6_144, pulls: 7_680 } } }),
      afterChart: chartReport({ appRoot: root, fullHistoryByScenario: { '15m/reserveTraversal': { pushes: 7_681, pulls: 6_144 } } }),
    })
    assert.equal(result.status, 1)
    assert.equal(result.report.outcome, 'failed')
    assert.deepEqual(result.report.failures, ['15m/reserveTraversal.fullHistoryTransferredBars'])
    assert.deepEqual(result.report.performance['15m/reserveTraversal'].fullHistoryTransferredBars, {
      before: 13_824, after: 13_825, passed: false,
      pushBars: { before: 6_144, after: 7_681 }, pullBars: { before: 7_680, after: 6_144 },
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
