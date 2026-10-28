import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { requireForegroundTests } from '../../electron/test-presentation.js'
import { startRendererDiagnostics } from '../../scripts/renderer-diagnostics.mjs'
import { startProcessWitness } from '../support/process-witness.mjs'
import { finishAcceptanceResources } from '../support/acceptance-resources.mjs'
import { assertCompletePaints, foregroundPaintWindow, installRequestProbe, measureLatencyCoveredPrefetch, measureMissingWindow, measureNativeColdBoundary, measureChartIntentLatency, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, waitForLocalHistory, waitForRendered, wheelBurst, withPaintProbe } from '../../scripts/chart-acceptance.mjs'

requireForegroundTests()

// Foreground paint tests own their process. Hiding a previously shown native
// window can suspend its animation frames, so functional tests use another app.
const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-chart-paint-e2e-'))
let electron, page, stopDiagnostics, stopWitness

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
beforeEach(async context => {
  if (process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS) stopDiagnostics = await startRendererDiagnostics(electron, page,
    join(process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS, 'chart-paint', context.name.replace(/[^a-z0-9]+/gi, '-')),
    { cpuProfile: process.env.PERPETUAL_SWAP_RENDERER_TRACE_ONLY !== '1' })
  stopWitness = await startProcessWitness(electron, `chart-${context.name}`)
})
afterEach(async () => {
  const stop = stopDiagnostics, witness = stopWitness
  stopDiagnostics = undefined; stopWitness = undefined
  await finishAcceptanceResources([witness, stop])
})
after(async () => {
  await finishAcceptanceResources([
    () => electron?.close(),
    () => rm(userData, { recursive: true, force: true }),
  ])
})

test('bulk-warmed history updates every renderer target within 100 ms during scroll, reversal, and jumps', { timeout: 90_000 }, async context => {
  const foreground = await foregroundPaintWindow(electron, page)
  context.after(async () => {
    await foreground.restore()
    const restored = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    assert.equal(restored, foreground.previous.visible, 'The latency test must restore the native window visibility.')
  })
  context.diagnostic(`Native foreground timing window: ${JSON.stringify({ before: foreground.previous, during: foreground.native, environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence })}`)
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark' }))
  // Complete the initial durable hydration before holding subsequent disk
  // deliveries and source maintenance. Resident navigation uses transferred
  // data independently of either backend preparation or the two read lanes.
  await installRequestProbe(electron, fixture.instId)
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
      globalThis.__chartRequestProbe.holdHistorical = true
      globalThis.__chartRequestProbe.holdLocal = true
      await globalThis.__marketBackend.probe({ action: 'sourceHold', hold: true })
    })
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      const residentHistoryBars = warmedHistory.get(timeframe)
      const before = await readRequestProbe(electron)
      const paint = await withPaintProbe(page, fixture, { requireMatureData: true, requireWarmStatistics: true }, async () => {
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
          const latency = await measureChartIntentLatency(page, { inputs, targets })
          context.diagnostic(JSON.stringify({ timeframe, phase: phase.name, ...latency }))
          assert.ok(latency.maxInputToRafSampleMS < 100, `${timeframe} ${phase.name} had an intent take ${latency.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target. ${JSON.stringify(latency)}`)
          assert.ok(latency.latestBurstStartToRafSampleMS < 100, `${timeframe} ${phase.name} took ${latency.latestBurstStartToRafSampleMS} ms from the first wheel input in the latest burst to its renderer RAF sample. ${JSON.stringify(latency)}`)
        }
      })
      assertCompletePaints(paint)
      assert.equal(paint.pendingFrames, 0, 'Resident navigation must never wait for the held disk deliveries.')
      const after = await readRequestProbe(electron)
      const historicalRequests = after.calls.slice(before.calls.length).filter(call => Number.isFinite(call.endHour))
      assert.ok(historicalRequests.every(call => call.kind === 'history'), 'Resident navigation may issue only observational history reads.')
      assert.equal(after.legacyWindowCalls, 0)
      const sources = separateSourceMaintenance(after.sourceRequests.slice(before.sourceCalls), fixture)
      assert.deepEqual(sources.historical, [], `A warmed ${timeframe} scroll attempted a historical download: ${JSON.stringify(sources.historical)}`)
      assert.ok(after.maxHistoricalActive <= 2, 'Resident targets must never queue foreground work behind the held disk deliveries.')
      assert.ok(after.transferredHistoryBars >= residentHistoryBars, 'The fixture must exercise a bulk durable-history transfer.')
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('backend history reserve covers 1500 ms of delivery latency before the cold boundary during continuous wheel input', { timeout: 90_000 }, async () => {
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-USDT-SWAP' }))
  await measureLatencyCoveredPrefetch(electron, page, fixture)
})

test('a never-downloaded native price page reaches an SVG snapshot before reserve and optional statistics finish', async context => {
  const report = await measureNativeColdBoundary(electron, page)
  context.diagnostic(`Native cold boundary: ${JSON.stringify(report)}`)
})

for (const failSource of [false, true]) test(`a completely absent viewport keeps foreground input responsive through delayed source ${failSource ? 'failure' : 'success'}`, { timeout: 60_000 }, async context => {
  const report = await measureMissingWindow(electron, page, { offscreen: false, failSource })
  assert.equal(report.initiallyPresentCandles, 0)
  assert.equal(report.initiallyMissingCandles, 96)
  assert.equal(report.foregroundRafObservationMeasured, true)
  assert.equal(report.pendingInputAcknowledgment.milestone, 'requested-cursor')
  assert.equal(report.pendingInputAcknowledgment.unaccountedInputs.length, 0)
  assert.equal(report.failedSourceDidNotClaimCompletion, failSource)
  context.diagnostic(JSON.stringify({ scenario: report.scenario, sourceFailure: report.sourceFailure,
    inputBudgetMS: report.inputBudgetMS, maxInputAcknowledgmentMS: report.pendingInputAcknowledgment.maxInputToRafSampleMS,
    maxFrameGapMS: report.maxFrameGapMS, dataAvailability: report.dataAvailability,
    timingScope: report.timingScope, sourceRequests: report.sourceRequests, observedFieldOracle: report.observedFieldOracle }))
})
