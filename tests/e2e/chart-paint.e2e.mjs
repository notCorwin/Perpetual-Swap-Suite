import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertCompletePaints, finishPaintProbe, foregroundPaintWindow, installRequestProbe, measureLatencyCoveredPrefetch, measureNativeColdBoundary, measurePaintLatency, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForLocalHistory, waitForRendered, wheelBurst } from '../../scripts/chart-acceptance.mjs'

// Foreground paint tests own their process. Hiding a previously shown native
// window can suspend its animation frames, so functional tests use another app.
const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-chart-paint-e2e-'))
let electron, page
const request = value => page.evaluate(value => window.radarDesktop.request(value), value)

before(async () => {
  await writeFile(join(userData, 'settings.json'), JSON.stringify({
    chartTimeframe: '15m', rankingLookback: 15, historyDays: 30,
    notificationsEnabled: true, backgroundMonitoringEnabled: true, monitoringPaused: true,
  }))
  electron = await _electron.launch({ args: ['.'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1',
      PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})
after(async () => {
  try { await electron?.close() }
  finally { await rm(userData, { recursive: true, force: true }) }
})

test('bulk-warmed history scrolls, reverses, and jumps within 100 ms while speculative preparation is stalled in every native timeframe', { timeout: 90_000 }, async context => {
  const foreground = await foregroundPaintWindow(electron, page)
  context.after(async () => {
    await foreground.restore()
    const restored = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    assert.equal(restored, foreground.previous.visible, 'The latency test must restore the native window visibility.')
  })
  context.diagnostic(`Native paint window: ${JSON.stringify({ before: foreground.previous, during: foreground.native, environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence })}`)
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  // Adaptive speculative preparation is held indefinitely. Source reads are
  // also stalled after warming, so navigation must stay independent of both
  // lanes and use the already transferred durable series.
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
    await openChart(page, fixture)
    const warmedHistory = new Map()
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      warmedHistory.set(timeframe, await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true }))
    }
    context.diagnostic(`Resident history before stalls: ${JSON.stringify(Object.fromEntries(warmedHistory))}`)
    await electron.evaluate(async () => {
      globalThis.__chartRequestProbe.holdLatest = true
      await globalThis.__marketBackend.probe({ action: 'sourceHold', hold: true })
    })
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      const residentHistoryBars = warmedHistory.get(timeframe)
      const before = await readRequestProbe(electron)
      await startPaintProbe(page, fixture)
      const intervalMS = fixture.series[timeframe].intervalMS
      let distance = 0
      for (const phase of [
        { name: 'high velocity', frames: 6, eventsPerFrame: 32, deltaY: 36, candles: 576 },
        { name: 'reversal', frames: 3, eventsPerFrame: 32, deltaY: -36, candles: -288 },
        { name: '600-candle jump inside the bounded reserve', deltaY: 7_200, candles: 600 },
      ]) {
        const inputs = await wheelBurst(page, phase)
        const targets = inputs.map((_, index) => fixture.end - (distance + phase.candles / inputs.length * (index + 1)) * intervalMS)
        distance += phase.candles
        await waitForRendered(page, fixture, timeframe, targets.at(-1))
        const latency = await measurePaintLatency(page, { inputs, targets })
        context.diagnostic(JSON.stringify({ timeframe, phase: phase.name, ...latency }))
        assert.ok(latency.latestInputToPaintMS < 100, `${timeframe} ${phase.name} took ${latency.latestInputToPaintMS} ms from the latest wheel input to its first paint opportunity. ${JSON.stringify(latency)}`)
        assert.ok(latency.latestBurstStartToPaintMS < 100, `${timeframe} ${phase.name} took ${latency.latestBurstStartToPaintMS} ms from the first wheel input in the latest burst to its first paint opportunity. ${JSON.stringify(latency)}`)
      }
      const paint = await finishPaintProbe(page)
      assertCompletePaints(paint)
      assert.equal(paint.pendingFrames, 0, 'Resident navigation must never wait for the stalled speculative preparation.')
      const after = await readRequestProbe(electron)
      const historicalRequests = after.calls.slice(before.calls.length).filter(call => Number.isFinite(call.endHour))
      assert.ok(historicalRequests.every(call => call.historyBars > 96), `Resident ${timeframe} targets must only issue bulk speculative preparation: ${JSON.stringify(historicalRequests)}`)
      const sources = separateSourceMaintenance(after.sourceRequests.slice(before.sourceCalls), fixture)
      assert.deepEqual(sources.historical, [], `A warmed ${timeframe} scroll attempted a historical download: ${JSON.stringify(sources.historical)}`)
      assert.ok(after.maxHistoricalActive <= 1, 'Resident targets must never queue foreground work behind the stalled speculative preparation.')
      assert.ok(after.transferredHistoryBars >= residentHistoryBars, 'The fixture must exercise a bulk durable-history transfer.')
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('historical prefetch covers 1500 ms of network latency before the cold boundary during continuous wheel input', { timeout: 90_000 }, async () => {
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-USDT-SWAP' }))
  await measureLatencyCoveredPrefetch(electron, page, fixture)
})

test('a never-downloaded native price page paints before the farther reserve and optional statistics finish', async context => {
  const report = await measureNativeColdBoundary(electron, page)
  context.diagnostic(`Native cold boundary: ${JSON.stringify(report)}`)
})
