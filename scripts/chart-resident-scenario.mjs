import assert from 'node:assert/strict'
import { assertCompleteChartViewport, assertCompletePaints, installRequestProbe, measureChartIntentLatency, openChart, readRequestProbe,
  releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, waitForLocalHistory,
  waitForRendered, wheelBurst, withPaintProbe } from './chart-acceptance.mjs'

// Both the CLI report and native foreground gate exercise the same resident
// history boundary. Callers own window presentation and select their workload.
export async function measureResidentScroll(electron, page, fixture, { phases, requireBurstBudget = false, diagnostic = () => {} }) {
  const timeframes = []
  await installRequestProbe(electron, fixture.instId)
  try {
    await openChart(page, fixture)
    const warmedHistory = new Map()
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      warmedHistory.set(timeframe, await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true }))
    }
    diagnostic({ residentHistory: Object.fromEntries(warmedHistory) })
    await electron.evaluate(async () => {
      globalThis.__chartRequestProbe.holdHistorical = true
      globalThis.__chartRequestProbe.holdLocal = true
      await globalThis.__marketBackend.probe({ action: 'sourceHold', hold: true })
    })
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      const residentHistoryBars = warmedHistory.get(timeframe)
      const viewport = await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.end })
      const before = await readRequestProbe(electron)
      const observations = []
      const paint = await withPaintProbe(page, fixture, { requireMatureData: true, requireWarmStatistics: true }, async () => {
        const intervalMS = fixture.series[timeframe].intervalMS
        let distance = 0
        for (const { name, candles, ...options } of phases) {
          assert.ok(distance + candles >= 0 && distance + candles <= residentHistoryBars - viewport.expectedHours.length,
            'A warm phase must stay within complete resident viewports.')
          const inputs = await wheelBurst(page, options)
          const targets = inputs.map((_, index) => fixture.end - (distance + candles / inputs.length * (index + 1)) * intervalMS)
          distance += candles
          await waitForRendered(page, fixture, timeframe, targets.at(-1))
          const latency = await measureChartIntentLatency(page, { inputs, targets })
          diagnostic({ timeframe, phase: name, ...latency })
          assert.ok(latency.maxInputToRafSampleMS < 100,
            `${timeframe} ${name} had an intent take ${latency.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target. ${JSON.stringify(latency)}`)
          if (requireBurstBudget) assert.ok(latency.latestBurstStartToRafSampleMS < 100,
            `${timeframe} ${name} took ${latency.latestBurstStartToRafSampleMS} ms from the first wheel input in the latest burst to its renderer RAF sample. ${JSON.stringify(latency)}`)
          observations.push({ name, frames: options.frames ?? 1, eventsPerFrame: options.eventsPerFrame ?? 1,
            candles, end: targets.at(-1), ...latency })
        }
      })
      assertCompletePaints(paint)
      assert.equal(paint.pendingFrames, 0, 'Resident navigation must never wait for held disk deliveries.')
      const requests = await readRequestProbe(electron)
      const scrollingRequests = requests.calls.slice(before.calls.length)
      const historicalRequests = scrollingRequests.filter(call => Number.isFinite(call.endHour))
      const scrollingSourceRequests = requests.sourceRequests.slice(before.sourceCalls)
      const sources = separateSourceMaintenance(scrollingSourceRequests, fixture)
      assert.ok(historicalRequests.every(call => call.kind === 'history'), 'Resident navigation may issue only observational history reads.')
      assert.equal(requests.legacyWindowCalls, 0)
      assert.deepEqual(sources.historical, [], `Warm scrolling must not download fixture history: ${JSON.stringify(sources.historical)}`)
      assert.ok(requests.maxHistoricalActive <= 2, 'Resident targets must stay independent of the held disk deliveries lane.')
      assert.ok(requests.transferredHistoryBars >= residentHistoryBars, 'The fixture must exercise a bulk durable-history transfer.')
      timeframes.push({
        timeframe, phases: observations, ...paint, commits: paint.commits.length,
        preparedRequests: historicalRequests.length,
        stalledSpeculativePreparation: requests.held,
        heldLatestRefreshRequests: scrollingRequests.length - historicalRequests.length,
        localHistoryReads: requests.historyCalls.filter(call => call.timeframe === timeframe).length,
        transferredHistoryBars: requests.historyResponses.filter(response => response.timeframe === timeframe).reduce((total, response) => total + response.bars, 0),
        residentHistoryBars, maxConcurrentRequests: requests.maxActive,
        sourceRequests: scrollingSourceRequests, currentMaintenanceRequests: sources.currentMaintenance,
        repeatedSourceDownloads: sources.historical.length,
      })
    }
    const sourceRequests = (await readRequestProbe(electron)).sourceRequests
    return { sourceRequests, currentMaintenanceRequests: separateSourceMaintenance(sourceRequests, fixture).currentMaintenance, timeframes }
  } finally {
    try { await releaseRequestProbe(electron) }
    finally { await removeRequestProbe(electron) }
  }
}
