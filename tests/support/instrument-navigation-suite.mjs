import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { summarizeLatencySamples } from '../../scripts/chart-acceptance-metrics.mjs'
import { startRendererDiagnostics } from '../../scripts/renderer-diagnostics.mjs'
import {
  assertNavigationFrames, exerciseInstrumentNavigation, finishNavigationFrameProbe, installNavigationProbe,
  measureNavigation, persistNavigationCatalog, removeNavigationProbe, selectionRequests,
  startNavigationFrameProbe, startupNavigationReport,
} from '../../scripts/instrument-navigation-acceptance.mjs'

export function registerInstrumentNavigationTests({ presentation, prepareWindow }) {
  assert.ok(presentation === 'offscreen' || presentation === 'foreground')
  assert.equal(typeof prepareWindow, 'function')

  const root = fileURLToPath(new URL('../..', import.meta.url))
  const userData = mkdtemp(join(tmpdir(), `perp-instrument-navigation-${presentation}-`))
  let electron, page, fixture, presentationState

  const launch = async (restart = false) => {
    electron = await _electron.launch({
      args: restart ? ['-r', './scripts/instrument-navigation-bootstrap.cjs', '.'] : ['.'],
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: await userData },
    })
    page = await electron.firstWindow()
    if (presentation === 'foreground') presentationState = await prepareWindow(electron, page)
    await page.waitForLoadState('domcontentloaded')
    if (presentation === 'offscreen') presentationState = await prepareWindow(electron, page)
  }

  before(async () => {
    await launch()
    await installNavigationProbe(electron, { omitUniverseInstId: 'BTC-USDT-SWAP' })
    fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    assert.equal(fixture.instIds.length, 16, 'The navigation scenario must cover all sixteen native contracts.')
    assert.equal(fixture.timeframes.length, 3, 'The navigation scenario must cover all three native timeframes.')
  })

  after(async () => {
    try {
      await presentationState?.restore?.()
      if (electron) {
        await removeNavigationProbe(electron)
        await electron.close()
      }
    } finally {
      await rm(await userData, { recursive: true, force: true })
    }
  })

  test('an unprepared selection acknowledges input before all sixteen prepared contracts switch by the next frame', { timeout: 120_000 }, async context => {
    if (process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS) context.after(await startRendererDiagnostics(electron, page,
      join(process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS, 'initial-navigation'),
      { cpuProfile: process.env.PERPETUAL_SWAP_RENDERER_TRACE_ONLY !== '1' }))
    context.diagnostic(`Presentation: ${JSON.stringify({ native: presentationState?.native, environment: presentationState?.environment, idleFrameCadence: presentationState?.idleFrameCadence })}`)
    const report = await exerciseInstrumentNavigation(electron, page, fixture, { presentation, unpreparedInstId: 'BTC-USDT-SWAP' })
    assert.equal(report.unpreparedSelection.rendererFrameAvailableBeforeInput, false)
    assert.equal(report.unpreparedSelection.hydratedFromLocalHistory, true)
    assert.equal(report.phases.length, 3)
    assert.equal(report.initialPreparation.readyFrameCount, fixture.instIds.length * 3)
    assert.equal(report.phases.every(phase => phase.distinctContracts === 16 && phase.rendererFrames.readyCount === 16), true)
    assert.equal(report.heldHistory.lateWrongInstrumentCommits, 0)
    assert.deepEqual(report.violations, [])
    const inputs = report.phases.flatMap(phase => [phase.firstVisit, phase.mouseSwitch, phase.rapid, ...phase.keyboard,
      ...(phase.timeframeSwitch ? [phase.timeframeSwitch] : [])])
    assert.ok(inputs.every(input => Number.isFinite(input.rendererTimeOrigin) && input.inputAt <= input.commitAt
      && input.commitAt <= input.rafSampleAt && ['click', 'keydown'].includes(input.inputType)),
    'Every measured selection must retain ordered input, SVG commit and RAF timestamps from its renderer document.')
    const svg = summarizeLatencySamples(inputs.map(input => input.inputToSVGCommitMS))
    const raf = summarizeLatencySamples(inputs.map(input => input.inputToNextRafSampleMS))
    context.diagnostic(`Navigation timing (${JSON.stringify(report.timingScope)}): ${JSON.stringify({ initialPreparation: report.initialPreparation, inputs: inputs.length,
      svgP50MS: svg.p50MS, svgP95MS: svg.p95MS, svgMaxMS: svg.maxMS,
      nextRafSampleP95MS: raf.p95MS, nextRafSampleMaxMS: raf.maxMS, percentileMinimum: svg.p95SampleMinimum,
      maximumFramesToCommit: Math.max(...inputs.map(input => input.framesToCommit)),
      selectionIPC: inputs.reduce((sum, input) => sum + input.selectionIPC, 0) })}`)
  })

  test('a real process restart reports renderer frame arrival separately and measures navigation across every contract and period', { timeout: 120_000 }, async context => {
    assert.equal(await persistNavigationCatalog(electron, page), fixture.instIds.length)
    await removeNavigationProbe(electron)
    presentationState = null
    await electron.close()
    electron = null
    const launchedAt = Date.now()
    await launch(true)
    if (presentation === 'foreground') {
      assert.deepEqual(presentationState.native, { visible: true, focused: true, minimized: false },
        'The restart probe must be armed only after native foreground focus is verified.')
      assert.equal(presentationState.environment.offscreen, false, 'The restart probe must use the native compositor renderer.')
    }
    const startup = await startupNavigationReport(page, launchedAt, fixture, { presentation })
    const requests = await electron.evaluate(() => globalThis.__navigationStartupRequests.requests)
    const selectedRequests = selectionRequests({ requests }).filter(request => request.instId === startup.instId
      && request.at >= startup.inputEpoch - 1 && request.at <= startup.commitEpoch + 1)
    context.diagnostic(`Cold process restart: ${JSON.stringify({ ...startup, selectionIPC: selectedRequests.length,
      native: presentationState?.native, environment: presentationState?.environment, idleFrameCadence: presentationState?.idleFrameCadence })}`)
    assert.ok(selectedRequests.length <= 2, 'A prepared startup selection uses only bounded local reads.')
    assert.ok(startup.rendererFrameWaitMS >= 0, 'List availability and canonical renderer frame arrival must be timed separately.')
    assert.ok(startup.rendererFramesBeforeInput.includes(`${startup.timeframe}:${startup.instId}`), 'Startup selection must wait until the renderer receives its canonical full frame.')
    assert.deepEqual(startup.violations, [], 'Every startup SVG must retain the exact persisted prices and canonical indicators.')
    assert.ok(startup.inputPresentation && startup.armedAt <= startup.inputPresentation.inputAt,
      'The startup input must occur after the report arms the prepared-chart probe.')
    assert.equal(startup.inputPresentation.armedAt, startup.armedAt)
    if (presentation === 'foreground') {
      assert.equal(startup.inputPresentation.documentVisibility, 'visible', 'The startup input must occur in a visible document.')
      assert.equal(startup.inputPresentation.documentFocused, true, 'The startup input must occur while the document has focus.')
    }
    assert.ok(startup.framesToCommit <= 1, `The warm startup selection needed ${startup.framesToCommit} frames: ${JSON.stringify(startup)}`)
    if (presentation === 'foreground') assert.ok(startup.inputToSVGCommitMS <= 50,
      `The warm startup selection blocked native foreground input for ${startup.inputToSVGCommitMS} ms: ${JSON.stringify(startup)}`)
    await installNavigationProbe(electron)
    if (process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS) context.after(await startRendererDiagnostics(electron, page,
      join(process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS, 'restart-navigation'),
      { cpuProfile: process.env.PERPETUAL_SWAP_RENDERER_TRACE_ONLY !== '1' }))
    const report = await exerciseInstrumentNavigation(electron, page, fixture, { holdHistory: false, presentation })
    assert.equal(report.phases.length, 3)
    assert.equal(report.initialPreparation.readyFrameCount, fixture.instIds.length * 3)
    assert.equal(report.phases.every(phase => phase.rendererFrames.readyCount === fixture.instIds.length), true)
    assert.deepEqual(report.violations, [])
    context.diagnostic(`Restart navigation timing (${JSON.stringify(report.timingScope)}): ${JSON.stringify(report.phases.map(phase => ({ timeframe: phase.timeframe,
      firstVisit: phase.firstVisit, timeframeSwitch: phase.timeframeSwitch, rapid: phase.rapid,
      maximumKeyboardMS: Math.max(...phase.keyboard.map(input => input.inputToSVGCommitMS)) })))}`)
  })

  test('the prepared navigation verifier rejects fixture-known statistics marked unobserved', async () => {
    await startNavigationFrameProbe(page, fixture)
    await page.evaluate(async () => {
      const chart = document.querySelector('[data-chart-inst]'), original = chart.__chartSnapshot
      const descriptor = Object.getOwnPropertyDescriptor(chart, '__chartSnapshot')
      try {
        const missing = { ...original, oiState: 'unavailable', takerState: 'unavailable',
          bars: original.bars.map(bar => ({ ...bar, oi: null, buy: null, sell: null,
            oiObserved: false, takerObserved: false, statisticsObserved: false, statisticsSources: 0 })) }
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: missing })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      } finally { Object.defineProperty(chart, '__chartSnapshot', descriptor) }
    })
    const report = await finishNavigationFrameProbe(page)
    assert.ok(report.violations.some(value => /Fixture-known OI observation disappeared/.test(value)))
    assert.ok(report.violations.some(value => /Fixture-known Taker observation disappeared/.test(value)))
    assert.throws(() => assertNavigationFrames(report), error => error.code === 'ERR_ASSERTION'
      && error.message.includes('"capture":') && error.message.includes('"validation":'),
    'A correctness failure must retain capture and deferred validation cost diagnostics.')
  })

  test('a market selected in the same task as a timeframe switch immediately uses the requested period', async context => {
    context.diagnostic(`Presentation: ${JSON.stringify({ native: presentationState?.native, environment: presentationState?.environment, idleFrameCadence: presentationState?.idleFrameCadence })}`)
    const current = await page.locator('svg[data-rendered-inst]').evaluate(svg => ({ instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe }))
    const timeframe = fixture.timeframes.find(value => value !== current.timeframe)
    const instId = fixture.instIds.find(value => value !== current.instId)
    const activeSVG = await page.locator('svg[data-rendered-inst]').elementHandle()
    await startNavigationFrameProbe(page, fixture)
    try {
      const result = await measureNavigation(page, () => page.evaluate(({ instId, timeframe }) => {
        const button = [...document.querySelectorAll('[aria-label="Chart timeframe"] button')].find(button => button.textContent.trim() === timeframe)
        const row = document.querySelector(`[aria-label="View ${instId} chart"]`)
        if (!button || !row) throw new Error('The prepared interleaving targets must be mounted.')
        button.click()
        row.click()
      }, { instId, timeframe }), { expectedInstId: instId, timeframe })
      assert.ok(result.framesToCommit <= 1)
      if (presentation === 'foreground') assert.ok(result.inputToSVGCommitMS <= 50,
        `The interleaved native foreground selection blocked input for ${result.inputToSVGCommitMS} ms: ${JSON.stringify(result)}`)
      context.diagnostic(`Interleaved selection timing (${presentation}): ${JSON.stringify(result)}`)
      const visible = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => ({ instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe })))
      assert.deepEqual(visible, [{ instId, timeframe }])
      assert.equal(await activeSVG.evaluate(svg => svg.isConnected && svg === document.querySelector('svg[data-rendered-inst]')), true,
        'An interleaved market and timeframe switch must reuse the current SVG surface.')
      assert.equal(await page.locator('svg[data-prepared-chart-inst]').count(), 1,
        'Only the current SVG surface may remain mounted after an interleaved switch.')
    } finally {
      await activeSVG.dispose()
      assertNavigationFrames(await finishNavigationFrameProbe(page))
    }
  })
}
