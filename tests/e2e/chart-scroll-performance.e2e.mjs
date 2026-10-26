import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import {
  installRequestProbe, measureLatencyCoveredPrefetch, measureMissingWindow, offscreenChartWindow, openChart, readRequestProbe, removeRequestProbe, resetRequestProbe,
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

test('sub-candle wheel frames move continuously while axes stay fixed and native bursts coalesce', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const timeframe = '15m', interval = fixture.series[timeframe].intervalMS
  await installRequestProbe(electron, fixture.instId)
  try {
    await openChart(page, fixture, timeframe)
    await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true })
    await wheelBurst(page, { deltaY: 120 })
    const startEnd = fixture.end - 10 * interval
    await waitForRendered(page, fixture, timeframe, startEnd)
    const read = () => page.locator(`svg[data-rendered-inst="${fixture.instId}"]`).evaluate(svg => ({
      end: Number(svg.dataset.renderedEnd),
      offset: Number(svg.querySelector('[data-chart-wheel-content]').dataset.chartWheelOffset),
      hud: [...svg.querySelectorAll('[data-chart-price-tick], [data-chart-panel-header]')].map(element => {
        const rect = element.getBoundingClientRect()
        return [rect.x, rect.y, rect.width, rect.height]
      }),
    }))
    const initial = await read(), offsets = []
    for (let frame = 0; frame < 3; frame += 1) {
      await wheelBurst(page, { deltaY: 3 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const current = await read()
      assert.equal(current.end, startEnd, 'Fractional input must not advance a whole candle prematurely.')
      assert.deepEqual(current.hud, initial.hud, 'Axis ticks and legends must stay fixed during sub-candle translation.')
      assert.ok(current.offset > (offsets.at(-1) ?? 0), `Every 3 px input frame must visibly advance chart content: ${JSON.stringify({ current, offsets })}`)
      offsets.push(current.offset)
    }
    await mkdir(join(root, '.build'), { recursive: true })
    await page.locator('[data-chart-plot]').screenshot({ path: join(root, '.build/chart-scroll-fractional.png') })
    const plotBounds = await page.locator(`svg[data-rendered-inst="${fixture.instId}"]`).boundingBox()
    assert.ok(plotBounds)
    await page.mouse.move(plotBounds.x + .5, plotBounds.y + 50)
    await page.mouse.down()
    await page.waitForFunction(hour => Number(document.querySelector('[data-chart-inspected-hour]')?.dataset.chartInspectedHour) === hour,
      startEnd - 96 * interval)
    await page.locator(`svg[data-rendered-inst="${fixture.instId}"]`).dispatchEvent('keydown', { key: 'ArrowLeft', altKey: true })
    assert.equal(Number(await page.locator('[data-chart-inspected-hour]').getAttribute('data-chart-inspected-hour')), startEnd - 96 * interval,
      'RSI navigation outward from the exposed left neighbour must stop instead of wrapping to the rightmost crossing.')
    await page.mouse.up()
    await wheelBurst(page, { deltaY: 3 })
    await waitForRendered(page, fixture, timeframe, startEnd - interval)
    assert.equal((await read()).offset, 0, 'Exactly 12 px must consume one candle with no residual displacement.')

    await waitForRequestQuiescence()
    await resetRequestProbe(electron)
    await wheelBurst(page, { eventsPerFrame: 32, deltaY: 3 })
    await waitForRendered(page, fixture, timeframe, startEnd - 9 * interval)
    await waitForRequestQuiescence()
    const probe = await readRequestProbe(electron)
    assert.equal(probe.focusCalls.length, 1, '32 events in one animation frame must produce one backend navigation intent.')
    assert.equal(probe.traffic.fullHistoryPushes, 0)
  } finally {
    await removeRequestProbe(electron)
  }
})

test('cached reserve scrolling keeps one final intent and the canonical 96-bar indicator frame', async () => {
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
    const highSpeedBars = 12 * 32 * 2
    const jumpBars = Math.max(600, residentHistoryBars - 96 + 64 - highSpeedBars)
    const reversalBars = 6 * 16 * 2
    await wheelBurst(page, { frames: 12, eventsPerFrame: 32, deltaY: 24 })
    await wheelBurst(page, { deltaY: jumpBars * 12 })
    await wheelBurst(page, { frames: 6, eventsPerFrame: 16, deltaY: -24 })

    const distance = highSpeedBars + jumpBars - reversalBars
    const peakDistance = highSpeedBars + jumpBars
    const reserveBoundary = residentHistoryBars - 96
    const newlyExposedBars = Math.max(0, peakDistance - reserveBoundary)
    assert.ok(newlyExposedBars > 0, 'The second phase must enter history beyond the resident reserve.')
    const expectedEnd = fixture.end - distance * fixture.series[timeframe].intervalMS
    await waitForRendered(page, fixture, timeframe, expectedEnd)
    await waitForRequestQuiescence()
    const rendered = await page.locator(`[data-chart-inst="${fixture.instId}"]`).evaluate(chart => {
      const snapshot = chart.__chartSnapshot
      return { instId: snapshot?.instId, timeframe: snapshot?.timeframe, endHour: snapshot?.endHour,
        loading: chart.dataset.chartLoading,
        bars: (chart.__chartRenderedBars ?? snapshot?.bars ?? []).map(bar => ({
          hour: bar.hour, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          vwap: bar.vwap, ema: bar.ema, bollUpper: bar.bollUpper, bollMiddle: bar.bollMiddle, bollLower: bar.bollLower,
          roc: bar.roc, maroc: bar.maroc, rsi6: bar.rsi6, rsi12: bar.rsi12, rsi24: bar.rsi24,
          atrPercent: bar.atrPercent, bbw: bar.bbw, oi: bar.oi, buy: bar.buy, sell: bar.sell,
        })) }
    })
    const probe = await readRequestProbe(electron)

    assert.equal(rendered.instId, fixture.instId)
    assert.equal(rendered.timeframe, timeframe)
    assert.equal(rendered.endHour, expectedEnd, 'The latest reversed wheel target must win.')
    assert.equal(rendered.loading, 'false')
    assert.equal(rendered.bars.length, 96)
    assert.ok(probe.focusCalls.length > 0, 'Wheel navigation must retain the real backend focus path.')
    assert.equal(probe.focusCalls.findLast(call => call.target?.instId === fixture.instId)?.target.endHour, expectedEnd)
    const overlap = probe.traffic.uniqueOrUnchangedOverlap[timeframe]
    const observedNewBars = overlap?.newBars ?? 0
    const changedBars = overlap?.changedBars ?? 0
    const dataDrivenPushBudget = Math.ceil(Math.max(newlyExposedBars, observedNewBars) / 96) + Math.ceil(changedBars / 96)
    assert.ok(probe.traffic.fullHistoryPushes <= dataDrivenPushBudget,
      `Boundary deliveries must scale with newly exposed and changed 96-bar windows (${dataDrivenPushBudget}): ${JSON.stringify({ traffic: probe.traffic, newlyExposedBars, observedNewBars, changedBars })}`)
    assert.equal(probe.traffic.duplicateFullHistorySignatures, 0,
      `The backend must not repeat a full-history payload with the same version and range: ${JSON.stringify(probe.traffic)}`)
    if (probe.traffic.fullHistoryPushes > 1) assert.equal(overlap?.firstAndLastPayloadIdentical, false,
      'Separate boundary updates must carry new or changed facts, not repeat an identical full-history payload.')
    assert.deepEqual(separateSourceMaintenance(probe.sourceRequests, fixture).historical, [],
      'Cached chart movement must not download historical market data.')

    const oracle = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
    const intervalMS = fixture.series[timeframe].intervalMS
    const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower',
      'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    for (const [index, bar] of rendered.bars.entries()) {
      assert.equal(bar.hour, expectedEnd - (95 - index) * intervalMS, 'The selected frame must contain 96 contiguous candle slots.')
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
  const fixture = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'seedChartScrollBenchmark', instId: 'PREFETCH-USDT-SWAP' }))
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
  await writeFile(join(root, '.build/chart-prefetch-latency.json'), `${JSON.stringify(report, null, 2)}\n`)
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
