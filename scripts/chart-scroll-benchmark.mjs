import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertCompletePaints, finishPaintProbe, installRequestProbe, measureLatencyCoveredPrefetch, measurePaintLatency, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForLocalHistory, waitForRendered, wheelBurst } from './chart-acceptance.mjs'

const root = new URL('..', import.meta.url).pathname

async function withBenchmarkApp(run) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-'))
  let electron
  try {
    electron = await _electron.launch({
      args: ['.', '--headless', '--disable-gpu'], cwd: root,
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
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      const residentHistoryBars = await waitForLocalHistory(electron, page, fixture, timeframe)
      await electron.evaluate(async () => { globalThis.__chartRequestProbe.holdLatest = true; await globalThis.__marketBackend.probe({ action: 'sourceHold', hold: true }) })
      const beforeScrolling = await readRequestProbe(electron)
      await startPaintProbe(page, fixture)
      const intervalMS = fixture.series[timeframe].intervalMS
      const phases = []
      let distance = 0
      const sweep = async (name, options, candles) => {
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
      await sweep('one-frame-1200-candle-jump', { deltaY: 14_400 }, 1_200)
      await sweep('horizontal-reversal', { deltaX: 2_400, deltaY: 0 }, -200)
      await sweep('line-mode', { deltaY: -9, deltaMode: 1 }, -12)
      const paint = await finishPaintProbe(page)
      assertCompletePaints(paint)
      assert.equal(paint.pendingFrames, 0, 'Resident navigation must never wait for stalled speculative preparation.')
      const requests = await readRequestProbe(electron)
      const scrollingRequests = requests.calls.slice(beforeScrolling.calls.length)
      const historicalRequests = scrollingRequests.filter(call => Number.isFinite(call.endHour))
      const scrollingSourceRequests = requests.sourceRequests.slice(beforeScrolling.sourceCalls)
      const sources = separateSourceMaintenance(scrollingSourceRequests, fixture)
      assert.ok(historicalRequests.every(call => call.historyBars > 96), `Resident targets must only issue bulk speculative preparation: ${JSON.stringify(historicalRequests)}`)
      assert.deepEqual(sources.historical, [], `Warm scrolling must not download fixture history: ${JSON.stringify(sources.historical)}`)
      assert.ok(requests.maxHistoricalActive <= 1, 'Resident targets must stay independent of the stalled speculative preparation lane.')
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
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
  return { nativePeriods: fixture.timeframes, persistedPeriodsPerTimeframe: fixture.periods,
    sourceRequests, currentMaintenanceRequests: separateSourceMaintenance(sourceRequests, fixture).currentMaintenance, timeframes }
})

const delayedHistory = await withBenchmarkApp(async (electron, page, fixture) => {
  // This case intentionally disables the durable bulk lane before mounting
  // React. Otherwise a 1200-candle jump is correctly an immediate local hit.
  await installRequestProbe(electron, fixture.instId, { disableLocalHistory: true, initialHistoryBars: 1_000, capHistoricalWindows: true })
  try {
    await openChart(page, fixture)
    // Prime native latest snapshots before measuring the fallback path.
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
    }
    await removeRequestProbe(electron)
    await installRequestProbe(electron, fixture.instId, { holdHistorical: true, disableLocalHistory: true })
    await startPaintProbe(page, fixture)
    const started = Date.now()
    await wheelBurst(page, { deltaY: 14_400 })
    while (!(await readRequestProbe(electron)).held) {
      assert.ok(Date.now() - started < 10_000, 'The chart did not request its uncached target.')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await wheelBurst(page, { frames: 4, eventsPerFrame: 32, deltaY: 12 })
    await wheelBurst(page, { frames: 2, eventsPerFrame: 32, deltaY: -12 })
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - started))))
    const expectedEnd = fixture.end - 1_264 * fixture.intervalMS
    const heldEnd = Number(await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-end'))
    assert.equal(heldEnd, fixture.end, 'An incomplete target must never replace the last correct paint.')
    const heldRequests = await readRequestProbe(electron)
    assert.equal(heldRequests.calls.length, heldRequests.callsAtHold, `A held request must not accumulate an IPC backlog: ${JSON.stringify(heldRequests.calls)}`)
    await releaseRequestProbe(electron)
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    await selectTimeframe(page, '5m')
    await selectTimeframe(page, '15m')
    await selectTimeframe(page, '1H')
    await waitForRendered(page, fixture)
    const paint = await finishPaintProbe(page)
    assertCompletePaints(paint)
    const requests = await readRequestProbe(electron)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    assert.deepEqual(sources.historical, [], `Prepared timeframe switches unexpectedly downloaded fixture history: ${JSON.stringify(sources.historical)}`)
    assert.ok(!paint.commits.some(commit => commit.end === fixture.end - 1_200 * fixture.intervalMS), 'An obsolete held target was drawn after newer input.')
    return {
      heldForMS: 1_500, heldEnd, expectedEnd, latestIntentPreserved: true,
      ...paint, commits: paint.commits.length,
      preparedRequests: requests.calls.length, maxConcurrentRequests: requests.maxActive,
      localHistoryReads: requests.historyCalls.length, transferredHistoryBars: requests.transferredHistoryBars,
      sourceRequests: requests.sourceRequests, currentMaintenanceRequests: sources.currentMaintenance,
      repeatedSourceDownloads: sources.historical.length,
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

const latencyCoveredPrefetch = await withBenchmarkApp(measureLatencyCoveredPrefetch)

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'real-electron-bulk-history-svg-frame-correctness-and-input-to-paint-opportunity',
  performance: performanceReport,
  delayedHistory,
  latencyCoveredPrefetch,
}, null, 2))
