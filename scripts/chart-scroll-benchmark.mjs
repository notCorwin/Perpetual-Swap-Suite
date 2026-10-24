import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { assertCompletePaints, finishPaintProbe, foregroundPaintWindow, installRequestProbe, measureLatencyCoveredPrefetch, measureNativeColdBoundary, measurePaintLatency, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForLocalHistory, waitForRendered, wheelBurst } from './chart-acceptance.mjs'

requireForegroundTests()

const root = new URL('..', import.meta.url).pathname

async function withBenchmarkApp(run) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-'))
  let electron
  try {
    electron = await _electron.launch({
      args: ['.'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData },
    })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
    return await run(electron, page, fixture)
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
}

const performanceReport = await withBenchmarkApp(async (electron, page, fixture) => {
  const timeframes = []
  let sourceRequests = []
  const foreground = await foregroundPaintWindow(electron, page)
  try {
    await installRequestProbe(electron, fixture.instId)
    await openChart(page, fixture)
    const warmedHistory = new Map()
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      warmedHistory.set(timeframe, await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true }))
    }
    await electron.evaluate(async () => {
      globalThis.__chartRequestProbe.holdHistorical = true
      globalThis.__chartRequestProbe.holdLocal = true
      await globalThis.__marketBackend.probe({ action: 'sourceHold', hold: true })
    })
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      const residentHistoryBars = warmedHistory.get(timeframe)
      const beforeScrolling = await readRequestProbe(electron)
      await startPaintProbe(page, fixture)
      const intervalMS = fixture.series[timeframe].intervalMS
      const phases = []
      let distance = 0
      const sweep = async (name, options, candles) => {
        assert.ok(distance + candles <= residentHistoryBars - 96, 'A warm phase must stay within complete resident viewports.')
        const startingDistance = distance
        const inputs = await wheelBurst(page, options)
        distance += candles
        const end = fixture.end - distance * intervalMS
        await waitForRendered(page, fixture, timeframe, end)
        const observation = await measurePaintLatency(page, { inputs, targets: inputs.map((_, index) => fixture.end - (startingDistance + candles / inputs.length * (index + 1)) * intervalMS) })
        assert.ok(observation.latestInputToPaintMS < 100, `Warm ${timeframe} ${name} took ${observation.latestInputToPaintMS} ms from latest input to its first paint opportunity.`)
        phases.push({
          name, frames: options.frames ?? 1, eventsPerFrame: options.eventsPerFrame ?? 1,
          candles, end, ...observation,
        })
      }
      await sweep('resident', { frames: 18, eventsPerFrame: 3, deltaY: 12 }, 54)
      await sweep('high-velocity', { frames: 12, eventsPerFrame: 32, deltaY: 24 }, 768)
      await sweep('reversal', { frames: 6, eventsPerFrame: 32, deltaY: -24 }, -384)
      await sweep('one-frame-600-candle-jump', { deltaY: 7_200 }, 600)
      await sweep('horizontal-reversal', { deltaX: 2_400, deltaY: 0 }, -200)
      await sweep('line-mode', { deltaY: -9, deltaMode: 1 }, -12)
      const paint = await finishPaintProbe(page)
      assertCompletePaints(paint)
      assert.equal(paint.pendingFrames, 0, 'Resident navigation must never wait for held disk deliveries.')
      const requests = await readRequestProbe(electron)
      const scrollingRequests = requests.calls.slice(beforeScrolling.calls.length)
      const historicalRequests = scrollingRequests.filter(call => Number.isFinite(call.endHour))
      const scrollingSourceRequests = requests.sourceRequests.slice(beforeScrolling.sourceCalls)
      const sources = separateSourceMaintenance(scrollingSourceRequests, fixture)
      assert.ok(historicalRequests.every(call => call.kind === 'history'), 'Resident navigation may issue only observational history reads.')
      assert.equal(requests.legacyWindowCalls, 0)
      assert.deepEqual(sources.historical, [], `Warm scrolling must not download fixture history: ${JSON.stringify(sources.historical)}`)
      assert.ok(requests.maxHistoricalActive <= 2, 'Resident targets must stay independent of the held disk deliveries lane.')
      timeframes.push({
        timeframe, phases, ...paint, commits: paint.commits.length,
        preparedRequests: historicalRequests.length,
        stalledSpeculativePreparation: requests.held,
        heldLatestRefreshRequests: scrollingRequests.length - historicalRequests.length,
        localHistoryReads: requests.historyCalls.filter(call => call.timeframe === timeframe).length,
        transferredHistoryBars: requests.historyResponses.filter(response => response.timeframe === timeframe).reduce((total, response) => total + response.bars, 0),
        residentHistoryBars,
        maxConcurrentRequests: requests.maxActive,
        sourceRequests: scrollingSourceRequests,
        currentMaintenanceRequests: sources.currentMaintenance,
        repeatedSourceDownloads: sources.historical.length,
      })
    }
    sourceRequests = (await readRequestProbe(electron)).sourceRequests
  } finally {
    try { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
    finally { await foreground.restore() }
  }
  return { foregroundWindow: foreground.native, environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence, nativePeriods: fixture.timeframes, persistedPeriodsPerTimeframe: fixture.periods,
    sourceRequests, currentMaintenanceRequests: separateSourceMaintenance(sourceRequests, fixture).currentMaintenance, timeframes }
})

const delayedHistory = await withBenchmarkApp(async (electron, page, fixture) => {
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
    }
    await startPaintProbe(page, fixture)
    const started = Date.now()
    await wheelBurst(page, { deltaY: 14_400 })
    while (!(await readRequestProbe(electron)).held) {
      assert.ok(Date.now() - started < 10_000, 'The chart did not start the old durable history read.')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await wheelBurst(page, { frames: 4, eventsPerFrame: 32, deltaY: 12 })
    await wheelBurst(page, { frames: 2, eventsPerFrame: 32, deltaY: -12 })
    const expectedEnd = fixture.end - 1_264 * fixture.intervalMS
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - started))))
    const heldRequests = await readRequestProbe(electron)
    assert.equal(heldRequests.heldSettled, false, 'The latest cursor must finish before the older disk reply is released.')
    assert.ok(heldRequests.maxHistoricalActive <= 2 && heldRequests.maxLocalActive <= 2, 'Navigation must bound each pure read lane independently of backend focus demand.')
    assert.equal(heldRequests.legacyWindowCalls, 0)
    const heldEnd = Number(await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-end'))
    assert.equal(heldEnd, expectedEnd)
    const beforeRelease = await page.evaluate(() => window.__chartPaintProbe.commits.length)
    await releaseRequestProbe(electron)
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    await page.evaluate(async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    const paint = await finishPaintProbe(page)
    assertCompletePaints(paint)
    assert.ok(paint.commits.slice(beforeRelease).every(commit => commit.end === expectedEnd && commit.timeframe === fixture.timeframe), 'Releasing the old disk reply must never repaint its obsolete cursor.')
    const requests = await readRequestProbe(electron)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    assert.deepEqual(sources.historical, [], `Pure history reads unexpectedly downloaded fixture data: ${JSON.stringify(sources.historical)}`)
    return {
      heldForMS: Date.now() - started, heldEnd, expectedEnd, latestIntentPreserved: true,
      ...paint, commits: paint.commits.length,
      historyReads: requests.historyCalls.length, maxConcurrentHistoryReads: requests.maxHistoricalActive,
      transferredHistoryBars: requests.transferredHistoryBars,
      sourceRequests: requests.sourceRequests, currentMaintenanceRequests: sources.currentMaintenance,
      repeatedSourceDownloads: sources.historical.length,
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

const latencyCoveredPrefetch = await withBenchmarkApp(measureLatencyCoveredPrefetch)
const nativeColdBoundary = await withBenchmarkApp((electron, page) => measureNativeColdBoundary(electron, page))

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'real-electron-bulk-history-svg-frame-correctness-and-input-to-paint-opportunity',
  performance: performanceReport,
  delayedHistory,
  latencyCoveredPrefetch,
  nativeColdBoundary,
}, null, 2))
