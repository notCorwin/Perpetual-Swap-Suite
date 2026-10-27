#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { summarizeLatencySamples } from './chart-acceptance-metrics.mjs'
import {
  installRequestProbe, measureOffscreenColdBoundary, offscreenChartWindow, openChart, readRequestProbe,
  removeRequestProbe, resetRequestProbe, separateSourceMaintenance, selectTimeframe,
  waitForLocalHistory, waitForRendered,
} from './chart-acceptance.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({
  options: { 'app-root': { type: 'string' }, output: { type: 'string' } },
  allowPositionals: false,
})

if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_TEST_UI !== 'background') {
  throw new Error('Run this measurement through scripts/test-sandbox.mjs command --desktop so Electron stays in its protected hidden offscreen window.')
}

async function appEntryFor(appRoot) {
  const selected = resolve(appRoot)
  const info = await stat(selected).catch(() => null)
  if (!info) throw new Error(`App root does not exist: ${selected}`)
  if (info.isFile() && extname(selected) === '.asar') return { selected, entry: selected, cwd: dirname(selected) }
  if (!info.isDirectory()) throw new Error(`App root must be a project directory, .asar file, or .app bundle: ${selected}`)
  if (selected.endsWith('.app')) {
    const resources = join(selected, 'Contents', 'Resources')
    const archive = join(resources, 'app.asar')
    const unpacked = join(resources, 'app')
    if (await stat(archive).then(value => value.isFile()).catch(() => false)) return { selected, entry: archive, cwd: resources }
    if (await stat(unpacked).then(value => value.isDirectory()).catch(() => false)) return { selected, entry: unpacked, cwd: resources }
    throw new Error(`The app bundle has no Electron app.asar or Resources/app directory: ${selected}`)
  }
  if (!await stat(join(selected, 'package.json')).then(value => value.isFile()).catch(() => false)) {
    throw new Error(`App root must contain package.json: ${selected}`)
  }
  return { selected, entry: selected, cwd: selected }
}

function percentiles(values) {
  const summary = summarizeLatencySamples(values)
  const rounded = value => value === null ? null : Number(value.toFixed(3))
  return { sampleCount: summary.sampleCount, p50: rounded(summary.p50MS), p95: rounded(summary.p95MS),
    p95SampleMinimum: summary.p95SampleMinimum, p99: rounded(summary.p99MS), p99SampleMinimum: summary.p99SampleMinimum,
    max: rounded(summary.maxMS) }
}

function assertOracle(fixture, timeframe, rendered, expectedEnd) {
  assert.equal(rendered.instId, fixture.instId)
  assert.equal(rendered.timeframe, timeframe)
  assert.equal(rendered.endHour, expectedEnd)
  assert.equal(rendered.bars.length, 96)
  const oracle = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
  const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower',
    'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
  const intervalMS = fixture.series[timeframe].intervalMS
  for (const [index, bar] of rendered.bars.entries()) {
    assert.equal(bar.hour, expectedEnd - (95 - index) * intervalMS, `${timeframe} bars must fill the exact contiguous target window.`)
    const expected = oracle.get(bar.hour)
    assert.ok(expected, `No fixture bar exists for ${timeframe} ${bar.hour}.`)
    for (const field of fields) {
      const actual = bar[field], wanted = expected[field]
      if (wanted === null) assert.equal(actual, null, `${timeframe} ${bar.hour} ${field} must remain missing.`)
      else assert.ok(typeof actual === 'number' && Number.isFinite(actual)
        && Math.abs(actual - wanted) <= Math.max(1, Math.abs(wanted)) * 1e-10,
      `${timeframe} ${bar.hour} ${field}: expected ${wanted}, got ${actual}.`)
    }
  }
  return { matchedBars: rendered.bars.length, matchedFieldsPerBar: fields.length }
}

async function waitForPipelineQuiescence(electron, timeoutMS = 5_000) {
  const deadline = Date.now() + timeoutMS
  let previous = '', stable = 0
  while (Date.now() < deadline) {
    const probe = await readRequestProbe(electron)
    const signature = [probe.active, probe.traffic.preparedPushes, probe.historyResponses.length, probe.focusCalls.length].join(':')
    stable = signature === previous && probe.active === 0 ? stable + 1 : 0
    if (stable >= 3) return
    previous = signature
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('Chart requests and prepared-frame pushes did not settle before measurement.')
}

async function readPerformanceMetrics(cdp) {
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
  assert.ok(Number.isFinite(metrics.TaskDuration), 'Chromium must expose renderer TaskDuration for this measurement.')
  return metrics
}

async function runGestureSequence(page, commands) {
  return page.evaluate(async commands => {
    const plot = document.querySelector('[data-chart-plot]')
    if (!(plot instanceof HTMLElement)) throw new Error('The chart plot is unavailable.')
    const gaps = [], startedAt = performance.now()
    let previous = null
    for (const command of commands) {
      for (let frame = 0; frame < command.frames; frame += 1) {
        const timestamp = await new Promise(resolveFrame => requestAnimationFrame(resolveFrame))
        if (previous !== null) gaps.push(timestamp - previous)
        previous = timestamp
        for (let event = 0; event < command.eventsPerFrame; event += 1) {
          plot.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: command.deltaY,
          }))
        }
      }
    }
    return { durationMS: performance.now() - startedAt, frameGapsMS: gaps }
  }, commands)
}

async function measureCachedScenario(electron, page, cdp, fixture, timeframe, {
  name, commands, expectedEnd, peakDistanceBars, finalDistanceBars, residentHistoryBars,
}) {
  await waitForPipelineQuiescence(electron)
  await resetRequestProbe(electron)
  const before = await readPerformanceMetrics(cdp)
  const observation = await runGestureSequence(page, commands)
  await waitForRendered(page, fixture, timeframe, expectedEnd)
  await waitForPipelineQuiescence(electron)
  const after = await readPerformanceMetrics(cdp)
  const probe = await readRequestProbe(electron)
  const rendered = await page.locator(`[data-chart-inst="${fixture.instId}"]`).evaluate(chart => {
    const snapshot = chart.__chartSnapshot
    return { instId: snapshot?.instId, timeframe: snapshot?.timeframe, endHour: snapshot?.endHour,
      loading: chart.dataset.chartLoading, bars: (chart.__chartRenderedBars ?? snapshot?.bars ?? []).map(bar => ({
        hour: bar.hour, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        vwap: bar.vwap, ema: bar.ema, bollUpper: bar.bollUpper, bollMiddle: bar.bollMiddle, bollLower: bar.bollLower,
        roc: bar.roc, maroc: bar.maroc, rsi6: bar.rsi6, rsi12: bar.rsi12, rsi24: bar.rsi24,
        atrPercent: bar.atrPercent, bbw: bar.bbw, oi: bar.oi, buy: bar.buy, sell: bar.sell,
      })) }
  })
  assert.equal(rendered.loading, 'false')
  const oracle = assertOracle(fixture, timeframe, rendered, expectedEnd)
  const lastFocus = probe.focusCalls.findLast(call => call.target?.instId === fixture.instId)
  assert.ok(lastFocus?.target, `${timeframe} ${name} must keep the full backend focus path.`)
  if (expectedEnd === fixture.end) assert.ok(lastFocus.target.endHour == null || lastFocus.target.endHour === expectedEnd)
  else assert.equal(lastFocus.target.endHour, expectedEnd, `${timeframe} ${name} must keep the latest wheel target.`)
  const overlap = probe.traffic.uniqueOrUnchangedOverlap[timeframe] ?? { firstBars: 0, lastBars: 0, sharedBars: 0, byteIdenticalBars: 0 }
  const sourceBreakdown = separateSourceMaintenance(probe.sourceRequests, fixture)
  assert.deepEqual(sourceBreakdown.historical, [], `${timeframe} cached scrolling must not fetch historical source pages.`)
  const newlyExposedBars = Math.max(0, peakDistanceBars - (residentHistoryBars - 96))
  const observedNewBars = overlap.newBars ?? 0, changedBars = overlap.changedBars ?? 0
  const dataDrivenPushBudget = Math.ceil(Math.max(newlyExposedBars, observedNewBars) / 96) + Math.ceil(changedBars / 96)
  return {
    name,
    cache: { residentHistoryBars, reserveBoundaryBars: residentHistoryBars - 96,
      peakDistanceBars, finalDistanceBars, crossedReserveBoundary: peakDistanceBars > residentHistoryBars - 96 },
    gestures: commands.map(({ name: gesture, frames, eventsPerFrame, deltaY }) => ({ name: gesture, frames, eventsPerFrame, deltaY })),
    expectedEnd, finalEnd: rendered.endHour, latestIntentPreserved: lastFocus.target.endHour == null
      ? expectedEnd === fixture.end : lastFocus.target.endHour === expectedEnd,
    oracle,
    deliveryBudget: { newlyExposedBars, observedNewBars, changedBars, allowedFullHistoryPushes: dataDrivenPushBudget,
      observedFullHistoryPushes: probe.traffic.fullHistoryPushes,
      withinBudget: probe.traffic.fullHistoryPushes <= dataDrivenPushBudget,
      duplicateFullHistorySignatures: probe.traffic.duplicateFullHistorySignatures,
      firstAndLastPayloadIdentical: overlap.firstAndLastPayloadIdentical ?? false },
    offscreenObservation: { durationMS: Number(observation.durationMS.toFixed(3)), rafGapMS: percentiles(observation.frameGapsMS),
      rendererTaskMS: Number(((after.TaskDuration - before.TaskDuration) * 1000).toFixed(3)),
      rendererScriptMS: Number(((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(3)), nativePaintMeasured: false },
    fullPipeline: {
      focusCalls: probe.focusCalls.length,
      historicalPulls: probe.historyCalls.length,
      historicalPullBars: probe.historyResponses.reduce((total, response) => total + response.bars, 0),
      fullHistoryPushes: probe.traffic.fullHistoryPushes,
      totalBars: probe.traffic.totalBars,
      fullHistoryPushBars: probe.traffic.fullHistoryPushBars,
      duplicateFullHistorySignatures: probe.traffic.duplicateFullHistorySignatures,
      uniqueOrUnchangedOverlap: { ...overlap,
        unchangedPercentOfShared: overlap.sharedBars ? Number((overlap.byteIdenticalBars / overlap.sharedBars * 100).toFixed(2)) : null },
      historicalSourceRequests: sourceBreakdown.historical.length,
      repeatedSourceDownloads: sourceBreakdown.historicalExtensions.length,
    },
  }
}

const app = await appEntryFor(values['app-root'] ?? projectRoot)
const reportPath = resolve(values.output ?? join(projectRoot, '.build/chart-scroll-performance.json'))
const partialPath = `${reportPath}.partial`
await mkdir(dirname(reportPath), { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-performance-'))
let electron, probeInstalled = false
let currentFixture
const timeframes = ['5m', '15m', '1H']
const progress = { status: 'running', appRoot: app.selected, appEntry: app.entry, reportPath, stage: 'startup', dataReadyCached: [], coldAcquisition: null }
const persistProgress = () => writeFile(partialPath, `${JSON.stringify(progress, null, 2)}\n`)
const announce = async stage => {
  progress.stage = stage
  console.log(`[chart-scroll] ${stage}`)
  await persistProgress()
}

try {
  await announce('launching protected hidden Electron')
  electron = await _electron.launch({ args: [app.entry], cwd: app.cwd, env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    PERPETUAL_SWAP_E2E: '1',
    PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
    PERPETUAL_SWAP_USER_DATA: userData,
  } })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const native = await offscreenChartWindow(electron)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
  currentFixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  progress.fixture = { instId: currentFixture.instId, timeframes, periods: currentFixture.periods, end: currentFixture.end }
  await announce(`seeded offline fixture ${currentFixture.instId}`)
  await installRequestProbe(electron, currentFixture.instId)
  probeInstalled = true
  await openChart(page, currentFixture, '1H')

  const residentHistoryBars = {}
  for (const timeframe of timeframes) {
    await announce(`warming fully calculated ${timeframe} history`)
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, currentFixture, timeframe)
    residentHistoryBars[timeframe] = await waitForLocalHistory(electron, page, currentFixture, timeframe, { requireIndicators: true })
    await waitForRendered(page, currentFixture, timeframe)
  }

  const cachedTrials = []
  for (const timeframe of timeframes) {
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, currentFixture, timeframe)
    await waitForPipelineQuiescence(electron)

    const highSpeedBars = 12 * 32 * 2
    const jumpBars = Math.max(600, residentHistoryBars[timeframe] - 96 + 64 - highSpeedBars)
    const reversalBars = 6 * 16 * 2
    const reserveCommands = [
      { name: 'high-speed', frames: 12, eventsPerFrame: 32, deltaY: 24 },
      { name: 'reserve-boundary-jump', frames: 1, eventsPerFrame: 1, deltaY: jumpBars * 12 },
      { name: 'latest-intent-reversal', frames: 6, eventsPerFrame: 16, deltaY: -24 },
    ]
    const expectedDistance = highSpeedBars + jumpBars - reversalBars
    const peakBars = highSpeedBars + jumpBars
    assert.ok(peakBars > residentHistoryBars[timeframe] - 96,
      `${timeframe} gesture sequence must cross the resident reserve boundary.`)
    const intervalMS = currentFixture.series[timeframe].intervalMS
    const steadyCommands = [
      { name: '90-step-scroll-out', frames: 45, eventsPerFrame: 1, deltaY: 12 },
      { name: '90-step-reversal', frames: 45, eventsPerFrame: 1, deltaY: -12 },
    ]
    assert.ok(45 < residentHistoryBars[timeframe] - 96,
      `${timeframe} 90-step comparison must stay fully inside the resident reserve.`)
    const trial = { timeframe, residentHistoryBars: residentHistoryBars[timeframe], scenarios: {} }
    progress.dataReadyCached.push(trial)
    await announce(`measuring ${timeframe} pure-resident 90-step reversal`)
    const steady90 = await measureCachedScenario(electron, page, cdp, currentFixture, timeframe, {
      name: 'cached-90-step', commands: steadyCommands, expectedEnd: currentFixture.end,
      peakDistanceBars: 45, finalDistanceBars: 0, residentHistoryBars: residentHistoryBars[timeframe],
    })
    trial.scenarios.cached90Step = steady90
    console.log(`[chart-scroll] ${timeframe} pure-resident focus=${steady90.fullPipeline.focusCalls} fullHistoryPushes=${steady90.fullPipeline.fullHistoryPushes}`)
    await persistProgress()
    await announce(`measuring ${timeframe} cross-boundary high-speed reversal`)
    const reserveTraversal = await measureCachedScenario(electron, page, cdp, currentFixture, timeframe, {
      name: 'reserve-boundary-high-speed-reversal', commands: reserveCommands,
      expectedEnd: currentFixture.end - expectedDistance * intervalMS, peakDistanceBars: peakBars,
      finalDistanceBars: expectedDistance, residentHistoryBars: residentHistoryBars[timeframe],
    })
    trial.scenarios.reserveTraversal = reserveTraversal
    cachedTrials.push(trial)
    console.log(`[chart-scroll] ${timeframe} reserve-crossing focus=${reserveTraversal.fullPipeline.focusCalls} fullHistoryPushes=${reserveTraversal.fullPipeline.fullHistoryPushes} budget=${reserveTraversal.deliveryBudget.allowedFullHistoryPushes}`)
    await persistProgress()
  }

  await removeRequestProbe(electron)
  probeInstalled = false
  await announce('measuring cold native-history acquisition boundary')
  const coldBoundary = await measureOffscreenColdBoundary(electron, page, { timeframe: '15m' })
  progress.coldAcquisition = { boundary: coldBoundary }
  await persistProgress()

  const report = {
    generatedAt: new Date().toISOString(),
    appRoot: app.selected,
    appEntry: app.entry,
    fixture: { instId: currentFixture.instId, timeframes, periods: currentFixture.periods, end: currentFixture.end },
    presentation: { ...native, type: 'protected hidden offscreen Electron',
      measurements: 'Full backend focus and prepared-frame delivery, renderer TaskDuration, and renderer RAF gaps. Native compositor paint is not measured.' },
    movement: { crossesResidentReserveBoundary: true,
      finalDistanceBars: Object.fromEntries(cachedTrials.map(trial => [trial.timeframe, trial.scenarios.reserveTraversal.cache.finalDistanceBars])),
      peakDistanceBars: Object.fromEntries(cachedTrials.map(trial => [trial.timeframe, trial.scenarios.reserveTraversal.cache.peakDistanceBars])) },
    dataReadyCached: { trials: cachedTrials },
    coldAcquisition: { boundary: coldBoundary },
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  progress.status = 'complete'
  progress.stage = 'complete'
  progress.completedAt = new Date().toISOString()
  await rm(partialPath, { force: true })
  console.log(JSON.stringify({ report: reportPath, appRoot: app.selected, dataReadyCached: cachedTrials.map(trial => ({
    timeframe: trial.timeframe, scenarios: Object.fromEntries(Object.entries(trial.scenarios).map(([name, scenario]) => [name,
      { fullPipeline: scenario.fullPipeline, offscreenObservation: scenario.offscreenObservation }])),
  })), coldAcquisition: { timeframe: coldBoundary.timeframe, nativeSourceRequests: coldBoundary.nativeSourceRequests,
    nearestSourceCandles: coldBoundary.nearestSourceCandles, rendererTaskMS: coldBoundary.offscreenObservation.rendererTaskMS,
    nativePaintMeasured: false } }, null, 2))
} catch (error) {
  progress.status = 'failed'
  progress.error = error instanceof Error ? error.stack ?? error.message : String(error)
  await persistProgress().catch(() => {})
  console.error(`[chart-scroll] failed during ${progress.stage}; partial results: ${partialPath}`)
  throw error
} finally {
  if (probeInstalled) await removeRequestProbe(electron).catch(() => {})
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
}
