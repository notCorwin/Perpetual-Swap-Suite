import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { assertCompletePaints, finishPaintProbe, foregroundPaintWindow, installRequestProbe, measureLatencyCoveredPrefetch, measureNativeColdBoundary, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForRendered, wheelBurst } from './chart-acceptance.mjs'

import { measureResidentScroll } from './chart-resident-scenario.mjs'

requireForegroundTests()

const root = new URL('..', import.meta.url).pathname

async function withBenchmarkApp(run, { stablePriceLabels = true } = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-'))
  let electron
  try {
    electron = await _electron.launch({
      args: ['.'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData },
    })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const fixture = stablePriceLabels
      ? await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', stablePriceLabels: true }))
      : await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
    return await run(electron, page, fixture)
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
}

const performanceReport = await withBenchmarkApp(async (electron, page, fixture) => {
  const foreground = await foregroundPaintWindow(electron, page)
  try {
    const resident = await measureResidentScroll(electron, page, fixture, { phases: [
      { name: 'resident', frames: 18, eventsPerFrame: 3, deltaY: 12, candles: 54 },
      { name: 'high-velocity', frames: 12, eventsPerFrame: 32, deltaY: 24, candles: 768 },
      { name: 'reversal', frames: 6, eventsPerFrame: 32, deltaY: -24, candles: -384 },
      { name: 'one-frame-600-candle-jump', deltaY: 7_200, candles: 600 },
      { name: 'horizontal-reversal', deltaX: 2_400, deltaY: 0, candles: -200 },
      { name: 'line-mode', deltaY: -9, deltaMode: 1, candles: -12 },
    ] })
    return { foregroundWindow: foreground.native, environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence,
      nativePeriods: fixture.timeframes, persistedPeriodsPerTimeframe: fixture.periods, ...resident }
  } finally { await foreground.restore() }
})

const delayedHistory = await withBenchmarkApp(async (electron, page, fixture) => {
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
    }
    await startPaintProbe(page, fixture, { requireMatureData: true, requireWarmStatistics: true })
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

const latencyCoveredPrefetch = await withBenchmarkApp(measureLatencyCoveredPrefetch, { stablePriceLabels: true })
const nativeColdBoundary = await withBenchmarkApp((electron, page) => measureNativeColdBoundary(electron, page))

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'real-electron-bulk-history-svg-frame-correctness-and-input-to-renderer-raf-sample',
  performance: performanceReport,
  delayedHistory,
  latencyCoveredPrefetch,
  nativeColdBoundary,
}, null, 2))
