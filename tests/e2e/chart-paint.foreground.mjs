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
import { foregroundPaintWindow, measureLatencyCoveredPrefetch, measureMissingWindow, measureNativeColdBoundary } from '../../scripts/chart-acceptance.mjs'
import { measureResidentScroll } from '../../scripts/chart-resident-scenario.mjs'

requireForegroundTests()

// Foreground paint tests own their process. Hiding a previously shown native
// window can suspend its animation frames, so functional tests use another app.
const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-chart-paint-e2e-'))
let electron, page, stopDiagnostics, stopWitness

before(async () => {
  await writeFile(join(userData, 'settings.json'), JSON.stringify({
    rankingLookback: 15, historyDays: 30,
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
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', stablePriceLabels: true }))
  await measureResidentScroll(electron, page, fixture, {
    requireBurstBudget: true,
    diagnostic: report => context.diagnostic(JSON.stringify(report)),
    phases: [
      { name: 'high velocity', frames: 6, eventsPerFrame: 32, deltaY: 36, candles: 576 },
      { name: 'reversal', frames: 3, eventsPerFrame: 32, deltaY: -36, candles: -288 },
      { name: '600-candle jump inside the bounded reserve', deltaY: 7_200, candles: 600 },
    ],
  })
})

test('backend history reserve covers 1500 ms of delivery latency before the cold boundary during continuous wheel input', { timeout: 90_000 }, async () => {
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-USDT-SWAP', stablePriceLabels: true }))
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
