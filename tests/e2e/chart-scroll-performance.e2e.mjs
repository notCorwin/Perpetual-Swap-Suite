import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import {
  assertCompleteChartViewport, installRequestProbe, measureLatencyCoveredPrefetch, measureMissingWindow, measureOffscreenColdBoundary, offscreenChartWindow, openChart, readRequestProbe, removeRequestProbe, resetRequestProbe,
  separateSourceMaintenance, waitForLocalHistory, waitForRendered, wheelBurst,
} from '../../scripts/chart-acceptance.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
let userData, electron, page
const request = value => page.evaluate(value => window.radarDesktop.request(value), value)

async function waitForRequestQuiescence(timeoutMS = 5_000) {
  const deadline = Date.now() + timeoutMS
  let previous = '', stable = 0
  while (Date.now() < deadline) {
    const probe = await readRequestProbe(electron)
    const signature = [probe.active, probe.traffic.preparedPushes, probe.historyResponses.length, probe.focusCalls.length].join(':')
    stable = signature === previous && probe.active === 0 ? stable + 1 : 0
    if (stable >= 3) return
    previous = signature
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Chart IPC and prepared-frame delivery did not settle.')
}

test('cold boundary witnesses prepared target history and validates its selected ready RAF', { timeout: 60_000 }, async context => {
  const report = await measureOffscreenColdBoundary(electron, page)
  context.diagnostic(`Cold boundary witness: ${JSON.stringify({ timing: report.coldTiming, preparedTarget: report.preparedTarget,
    approach: report.approachLatency, approachAcknowledgment: report.approachAcknowledgment,
    sourcePhaseRAF: report.sourcePhaseRAF, targetPhaseRAF: report.targetPhaseRAF })}`)
  assert.equal(report.preparedTarget.targetEnd, report.targetEnd)
  assert.ok(report.preparedTarget.historyBars > 96)
  assert.equal(report.coldTiming.preparedBeforeFinalInput, true, 'The witness must precede target demand.')
  assert.equal(report.preparedTarget.sourceCompletedAt, report.coldTiming.timestamps.nearestCompletedAt)
  assert.equal(report.observedFieldOracle.priceBars, report.observedFieldOracle.expectedBars)
  assert.equal(report.observedFieldOracle.indicatorBars, report.observedFieldOracle.expectedBars)
  assert.equal(report.inputBursts.length, 2)
  assert.equal(report.approachLatency.milestone, 'rendered-window')
  assert.match(report.approachLatency.meaning, /no 100 ms content deadline/)
  assert.equal(report.approachAcknowledgment.milestone, 'requested-cursor')
  assert.equal(report.approachAcknowledgment.unaccountedInputs.length, 0)
  assert.equal(report.approachAcknowledgment.lastCommit.end, report.approachAcknowledgment.intents.at(-1).target)
  assert.ok(Number.isFinite(report.approachAcknowledgment.lastCommit.rafSampledAt))
  assert.ok(report.observationSamples.length > 0)
  assert.ok(report.observationSamples.every(sample => Number.isFinite(sample.at) && typeof sample.frame === 'boolean'))
  for (const phase of [report.sourcePhaseRAF, report.targetPhaseRAF]) {
    assert.ok(phase.samples.length > 0)
    assert.ok(phase.samples.every(sample => [sample.at, sample.rafTimestamp, sample.previousRafTimestamp, sample.gapMS].every(Number.isFinite)))
  }
})

before(async () => {
  userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-e2e-'))
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ monitoringPaused: true, backgroundMonitoringEnabled: false }))
  electron = await _electron.launch({ args: [root], cwd: root, env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    PERPETUAL_SWAP_E2E: '1',
    PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
    PERPETUAL_SWAP_USER_DATA: userData,
  } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await offscreenChartWindow(electron)
})

after(async () => {
  await electron?.close()
  if (userData) await rm(userData, { recursive: true, force: true })
})

test('cold fixture disposal isolates held source work from the next fixture', { timeout: 60_000 }, async () => {
  const probe = value => electron.evaluate((_, input) => globalThis.__marketBackend.probe(input), value)
  const backendRequest = value => electron.evaluate((_, input) => globalThis.__marketBackend.request(input), value)
  const install = timeframe => probe({ action: 'coldBoundaryInstall', timeframe, scenario: 'full-missing-window', sourceDelayMS: 1800 })
  const heldRequests = async fixture => {
    await backendRequest({ chartFocus: { id: `isolation-${fixture.instId}`, target: {
      instId: fixture.instId, timeframe: fixture.timeframe, endHour: fixture.targetEnd,
    } } })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const snapshot = await probe({ action: 'coldBoundaryRead' })
      const held = snapshot.requests.filter(item => item.held && item.completedAt === null && item.failedAt === null)
      if (held.length) return held
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`No optional or reserve source was held for ${fixture.instId}.`)
  }
  const assertRetired = async fixture => {
    const [prepared, history] = await Promise.all([probe({ action: 'preparedDiagnostics' }), probe({ action: 'diagnostics' })])
    assert.notEqual(prepared.focus?.instId, fixture.instId)
    assert.equal(prepared.catalog.includes(fixture.instId), false)
    assert.equal(prepared.listRemovals.includes(fixture.instId), false)
    assert.equal(prepared.series.some(item => item.key.startsWith(`${fixture.instId}:`)), false)
    assert.equal(prepared.sources.some(item => item.key.startsWith(`${fixture.instId}:`)), false)
    assert.equal(prepared.tasks.some(key => key.startsWith(`${fixture.instId}:`)), false)
    assert.equal(prepared.queue.some(key => key.startsWith(`${fixture.instId}:`)), false)
    assert.equal(history.activeHistory.some(item => item.instrument === fixture.instId), false)
    assert.equal(history.tasks.some(item => item.instrument === fixture.instId), false)
  }
  const readRanges = async (fixture, held) => Promise.all(held.map(item => backendRequest({ e2e: {
    action: item.source === 'candles' ? 'readCandles' : 'readStatistics', instrument: fixture.instId,
    timeframe: fixture.timeframe, from: item.from, through: item.through,
  } })))
  await offscreenChartWindow(electron)
  try {
    const first = await install('15m'), firstHeld = await heldRequests(first)
    const [removed, next] = await electron.evaluate(async () => Promise.all([
      globalThis.__marketBackend.probe({ action: 'coldBoundaryRemove' }),
      globalThis.__marketBackend.probe({ action: 'coldBoundaryInstall', timeframe: '1H', scenario: 'full-missing-window', sourceDelayMS: 1800 }),
    ]))
    assert.equal(removed.disposed.active, 0)
    assert.equal(removed.disposed.pending, 0)
    for (const item of removed.disposed.requests.filter(item => item.held)) {
      assert.equal(item.completedAt, null)
      assert.ok(Number.isFinite(item.failedAt), 'Held requests must be cancelled instead of released into a source write.')
    }
    await assertRetired(first)
    const firstAfterRemoval = await readRanges(first, firstHeld)
    assert.ok(firstAfterRemoval.every(rows => rows.length === 0), 'The held ranges must still be absent after disposal.')
    const durableTail = await backendRequest({ e2e: { action: 'readCandles', instrument: first.instId,
      timeframe: first.timeframe, from: first.end, through: first.end } })
    assert.equal(durableTail.length, 1, 'Disposal must retain previously committed fixture facts.')
    const nextHeld = await heldRequests(next)
    // Installation itself must await the prior fixture even without an explicit remove.
    await install('5m')
    await assertRetired(next)
    const nextAfterRemoval = await readRanges(next, nextHeld)
    assert.ok(nextAfterRemoval.every(rows => rows.length === 0), 'Replacement must not release the old held ranges.')
    await new Promise(resolve => setTimeout(resolve, 2200))
    assert.deepEqual(await readRanges(first, firstHeld), firstAfterRemoval)
    assert.deepEqual(await readRanges(next, nextHeld), nextAfterRemoval)
    await assertRetired(first)
    await assertRetired(next)
    await offscreenChartWindow(electron)
  } finally { await probe({ action: 'coldBoundaryRemove' }) }
})

test('sub-candle wheel input moves all three synchronized timelines continuously', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const timeframe = '15m', interval = fixture.series[timeframe].intervalMS
  await installRequestProbe(electron, fixture.instId)
  try {
    await openChart(page, fixture, timeframe)
    const read = () => page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => ({
      timeframe: chart.__chartSnapshot?.timeframe,
      end: Number(chart.dataset.chartTimeEnd),
      spacing: Number(chart.dataset.chartBarSpacing),
      requestedEnd: Number(chart.dataset.chartRequestedEnd),
      renderedEnd: Number(chart.querySelector('svg[data-rendered-inst]')?.dataset.renderedEnd),
    })))
    const waitForEnd = async expected => page.waitForFunction(expected => {
      const charts = [...document.querySelectorAll('[data-chart-inst]')]
      return charts.length === 3 && charts.every(chart => Math.abs(Number(chart.dataset.chartTimeEnd) - expected) < 2)
    }, expected, { timeout: 20_000 })
    const initial = await read(), spacing = initial[1].spacing
    assert.deepEqual(initial.map(chart => chart.timeframe), ['1H', '15m', '5m'])
    assert.ok(Number.isFinite(spacing) && spacing > 0)
    // Enter history before measuring fractional motion, including the initial
    // shared edge beyond the latest completed 15m candle.
    await wheelBurst(page, { deltaY: spacing * 10 })
    await waitForEnd(initial[1].end - 10 * interval)
    const historical = await read()
    await waitForRendered(page, fixture, timeframe, Math.floor(historical[1].end / interval) * interval)
    for (let frame = 1; frame <= 3; frame += 1) {
      await wheelBurst(page, { deltaY: 3 })
      const expected = historical[1].end - frame * 3 / spacing * interval
      await waitForEnd(expected)
      const charts = await read()
      assert.ok(charts.every(chart => Math.abs(chart.spacing - spacing) < .001), 'Panning must not change candle width.')
      assert.ok(charts.every(chart => Math.abs(chart.end - expected) < 2), 'All charts must share the same moving edge.')
    }
    await waitForRequestQuiescence()
    await resetRequestProbe(electron)
    const beforeBurst = await read()
    await wheelBurst(page, { eventsPerFrame: 32, deltaY: 3 })
    const burstEnd = beforeBurst[1].end - 96 / spacing * interval
    await waitForEnd(burstEnd)
    await waitForRendered(page, fixture, timeframe, Math.floor(burstEnd / interval) * interval)
    await waitForRequestQuiescence()
    const probe = await readRequestProbe(electron)
    for (const frame of ['1H', '15m', '5m']) {
      const calls = probe.focusCalls.filter(call => call.slot === frame)
      assert.ok(calls.length <= 1, `One wheel burst must coalesce navigation for ${frame}: ${calls.length}`)
      if (calls.length) assert.equal(calls[0].target.endHour, Math.floor(burstEnd / fixture.series[frame].intervalMS) * fixture.series[frame].intervalMS)
    }
    assert.ok(probe.focusCalls.some(call => call.slot === timeframe), 'The measured chart must send its final historical target.')
  } finally {
    await removeRequestProbe(electron)
  }
})

test('cached reserve scrolling keeps one final intent and the complete canonical indicator viewport', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installRequestProbe(electron, fixture.instId)
  try {
    const timeframe = '15m'
    await openChart(page, fixture, timeframe)
    const residentHistoryBars = await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true })
    await waitForRendered(page, fixture, timeframe)
    assert.ok(residentHistoryBars > 96 + 45, 'The first phase must remain fully inside the resident history reserve.')
    await waitForRequestQuiescence()

    // Pure-resident 90-frame reversal matches the original causal sequence.
    await resetRequestProbe(electron)
    await wheelBurst(page, { frames: 45, deltaY: 12 })
    await wheelBurst(page, { frames: 45, deltaY: -12 })
    await waitForRendered(page, fixture, timeframe)
    await waitForRequestQuiescence()
    const residentProbe = await readRequestProbe(electron)
    assert.equal(residentProbe.traffic.fullHistoryPushes, 0,
      `A fully resident reversal must not produce a large history delivery: ${JSON.stringify(residentProbe.traffic)}`)
    assert.ok(residentProbe.focusCalls.length > 0, 'Resident wheel navigation must retain the real backend focus path.')
    assert.deepEqual(separateSourceMaintenance(residentProbe.sourceRequests, fixture).historical, [])

    // Reset after resident work so boundary deliveries have their own budget.
    await resetRequestProbe(electron)
    const geometry = await page.locator('[data-acceptance-target] [data-chart-inst]').evaluate(chart => ({
      edge: Number(chart.dataset.chartTimeEnd), spacing: Number(chart.dataset.chartBarSpacing),
    }))
    const highSpeedBars = 12 * 32 * 24 / geometry.spacing
    const jumpBars = Math.max(600, residentHistoryBars - 96 + 64 - highSpeedBars)
    const reversalBars = 6 * 16 * 24 / geometry.spacing
    await wheelBurst(page, { frames: 12, eventsPerFrame: 32, deltaY: 24 })
    await wheelBurst(page, { deltaY: jumpBars * geometry.spacing })
    await wheelBurst(page, { frames: 6, eventsPerFrame: 16, deltaY: -24 })

    const distance = highSpeedBars + jumpBars - reversalBars
    const peakDistance = highSpeedBars + jumpBars
    const reserveBoundary = residentHistoryBars - 96
    const newlyExposedBars = Math.max(0, peakDistance - reserveBoundary)
    assert.ok(newlyExposedBars > 0, 'The second phase must enter history beyond the resident reserve.')
    const expectedEnd = Math.floor((geometry.edge - distance * fixture.series[timeframe].intervalMS) / fixture.series[timeframe].intervalMS) * fixture.series[timeframe].intervalMS
    await waitForRendered(page, fixture, timeframe, expectedEnd)
    await waitForRequestQuiescence()
    const rendered = await assertCompleteChartViewport(page, fixture.instId, { endHour: expectedEnd })
    const loading = await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).getAttribute('data-chart-loading')
    const probe = await readRequestProbe(electron)

    assert.equal(rendered.instId, fixture.instId)
    assert.equal(rendered.timeframe, timeframe)
    assert.equal(rendered.endHour, expectedEnd, 'The latest reversed wheel target must win.')
    assert.equal(loading, 'false')
    assert.equal(rendered.bars.length, rendered.expectedHours.length)
    assert.ok(probe.focusCalls.length > 0, 'Wheel navigation must retain the real backend focus path.')
    assert.equal(probe.focusCalls.findLast(call => call.target?.instId === fixture.instId && call.slot === timeframe)?.target.endHour, expectedEnd)
    const overlap = probe.traffic.uniqueOrUnchangedOverlap[timeframe]
    const observedNewBars = overlap?.newBars ?? 0
    const changedBars = overlap?.changedBars ?? 0
    const dataDrivenPushBudget = Math.ceil(Math.max(newlyExposedBars, observedNewBars) / 96) + Math.ceil(changedBars / 96)
    assert.ok((overlap?.fullHistoryPushes ?? 0) <= dataDrivenPushBudget,
      `Boundary deliveries must scale with newly exposed and changed 96-bar windows (${dataDrivenPushBudget}): ${JSON.stringify({ traffic: probe.traffic, newlyExposedBars, observedNewBars, changedBars })}`)
    assert.equal(probe.traffic.duplicateFullHistorySignatures, 0,
      `The backend must not repeat a full-history payload with the same version and range: ${JSON.stringify(probe.traffic)}`)
    if ((overlap?.fullHistoryPushes ?? 0) > 1) assert.equal(overlap?.firstAndLastPayloadIdentical, false,
      'Separate boundary updates must carry new or changed facts, not repeat an identical full-history payload.')
    assert.deepEqual(separateSourceMaintenance(probe.sourceRequests, fixture).historical, [],
      'Cached chart movement must not download historical market data.')

    const oracle = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
    const fields = ['open', 'high', 'low', 'close', 'ema', 'bollUpper', 'bollMiddle', 'bollLower',
      'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    for (const [index, bar] of rendered.bars.entries()) {
      assert.equal(bar.hour, rendered.expectedHours[index], 'The selected frame must contain every native slot in its visible geometric domain.')
      const expected = oracle.get(bar.hour)
      assert.ok(expected, `Unexpected ${timeframe} bar ${bar.hour}.`)
      for (const field of fields) {
        const actual = bar[field], wanted = expected[field]
        if (wanted === null) assert.equal(actual, null, `${field} must remain missing at ${bar.hour}.`)
        else assert.ok(typeof actual === 'number' && Number.isFinite(actual)
          && Math.abs(actual - wanted) <= Math.max(1, Math.abs(wanted)) * 1e-10,
        `${timeframe} ${bar.hour} ${field}: expected ${wanted}, got ${actual}.`)
      }
    }
    assert.ok(residentHistoryBars > 96)
  } finally {
    await removeRequestProbe(electron)
  }
})

test('real resident reserve covers delayed history delivery before continuous input crosses its boundary', { timeout: 90_000 }, async context => {
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-USDT-SWAP', stablePriceLabels: true }))
  const report = await measureLatencyCoveredPrefetch(electron, page, fixture, { offscreen: true })
  assert.equal(report.crossedInitialBoundary, true)
  assert.ok(report.observedHistoryDeliveryMS >= 1500)
  assert.ok(report.runwayAtRequest >= 192)
  assert.equal(report.pendingFrames, 0)
  assert.equal(report.repeatedSourceDownloads, 0)
  context.diagnostic(JSON.stringify({ initialHistoryBars: report.initialHistoryBars, scrolledCandles: report.scrolledCandles,
    runwayAtRequest: report.runwayAtRequest, observedHistoryDeliveryMS: report.observedHistoryDeliveryMS,
    minimumBars: report.minimumBars, pendingFrames: report.pendingFrames, latestInputToRafSampleMS: report.latestInputToRafSampleMS,
    nativePaintMeasured: report.nativePaintMeasured }))
  if (process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR) await writeFile(join(process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR, 'chart-prefetch-latency.json'), `${JSON.stringify(report, null, 2)}\n`)
})

test('a prefetch validation failure retains complete timing and delivery evidence', { timeout: 90_000 }, async context => {
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-EVIDENCE-USDT-SWAP', stablePriceLabels: true }))
  // Inject paint and delivery-report failures only after the real 768-input
  // phase and deferred probe have completed; the workload is unchanged.
  const failingPage = new Proxy(page, { get(target, key) {
    const value = target[key]
    if (key === 'evaluate') return async (...args) => {
      const result = await value.apply(target, args)
      if (args[1]?.includeTimingEvidence && Array.isArray(result?.violations)) result.violations.push('Injected deferred paint validation failure.')
      return result
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const failingElectron = new Proxy(electron, { get(target, key) {
    const value = target[key]
    if (key === 'evaluate') return async (...args) => {
      const result = await value.apply(target, args)
      const completed = result?.extensions?.find(record => Number.isFinite(record.completedAt))
      if (completed) completed.completedAt += 60_000
      return result
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(measureLatencyCoveredPrefetch(failingElectron, failingPage, fixture, { offscreen: true }), error => {
    const marker = '\nPrefetch phase data: '
    const position = error.message.lastIndexOf(marker)
    assert.ok(position >= 0, 'The failure must include the phase evidence.')
    const evidence = JSON.parse(error.message.slice(position + marker.length))
    assert.ok(Number.isFinite(evidence.rendererTimeOrigin))
    assert.equal(evidence.inputs.length, 768)
    assert.equal(evidence.latency.intents.length, 768)
    assert.ok(evidence.latency.intents.every(intent => Number.isFinite(intent.inputAt)
      && Number.isFinite(intent.commitAt) && Number.isFinite(intent.rafSampledAt)))
    assert.ok(evidence.paint.violations.includes('Injected deferred paint validation failure.'))
    assert.ok(evidence.paint.frames > 0 && evidence.paint.paints > 0)
    assert.ok(evidence.paint.frameSamples.length > 0 && evidence.paint.captureTimings.length > 0)
    assert.ok(evidence.paint.captureTimings.every(sample => Number.isFinite(sample.at) && Number.isFinite(sample.durationMS)))
    assert.ok(evidence.requests.extensions.length > 0)
    assert.ok(Number.isFinite(evidence.runway.runwayAtRequest))
    assert.deepEqual(evidence.sources.historical, [])
    assert.equal(evidence.checks.find(check => check.name === 'complete paints').passed, false)
    const delivery = evidence.checks.find(check => check.name === 'delivery before crossing')
    assert.equal(delivery?.passed, false, 'An independent delivery failure must survive the injected paint failure.')
    assert.match(delivery.message, /reach the renderer before the first viewport crosses/)
    assert.equal(evidence.checks.find(check => check.name === 'persisted sources').passed, true)
    context.diagnostic(`Injected prefetch failure checks: ${JSON.stringify(evidence.checks)}`)
    return true
  })
})

test('a completely absent 96-candle viewport stays truthful through delayed acquisition, continuing input, and reversal', { timeout: 45_000 }, async context => {
  const report = await measureMissingWindow(electron, page)
  assert.equal(report.pendingInputAcknowledgment.milestone, 'requested-cursor')
  assert.equal(report.pendingInputAcknowledgment.unaccountedInputs.length, 0)
  assert.equal(report.initiallyMissingCandles, 96)
  assert.equal(report.initiallyPresentCandles, 0)
  assert.equal(report.latestIntentPreserved, true)
  assert.equal(report.exactInputAccounting.allIntentsAccounted, true)
  assert.ok(report.exactInputAccounting.intents > 1)
  assert.equal(report.nativePaintMeasured, false)
  context.diagnostic(JSON.stringify(report))
})

test('a delayed failure on a completely absent viewport remains an explicit pending chart error', { timeout: 45_000 }, async context => {
  const report = await measureMissingWindow(electron, page, { failSource: true })
  assert.equal(report.pendingInputAcknowledgment.milestone, 'requested-cursor')
  assert.equal(report.pendingInputAcknowledgment.unaccountedInputs.length, 0)
  assert.equal(report.initiallyMissingCandles, 96)
  assert.equal(report.initiallyPresentCandles, 0)
  assert.equal(report.failedSourceDidNotClaimCompletion, true)
  assert.equal(report.latestIntentPreserved, true)
  assert.match(report.sourceFailure, /configured cold-window source failure/i)
  assert.equal(report.nativePaintMeasured, false)
  context.diagnostic(JSON.stringify(report))
})
