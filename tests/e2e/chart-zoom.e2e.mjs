import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'
import { openChart, waitForTargetSnapshot } from '../../scripts/chart-acceptance.mjs'

test('trackpad pinch zooms the cached chart around the pointer and keeps wheel history navigation', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-zoom-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartDisplayMode: 'indicators', chartTimeframe: '15m' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    await page.waitForFunction(() => document.querySelector('[data-chart-inst][data-chart-loading="false"] svg[data-rendered-inst]'))
    const initial = await page.locator('[data-chart-inst]').evaluate(chart => ({
      visible: Number(chart.dataset.chartVisibleBars), prepared: Number(chart.dataset.chartTargetBars),
      rendered: Number(chart.dataset.chartRenderedBars),
    }))
    assert.ok(initial.visible >= 50 && initial.visible <= 250, 'Default candles use a readable density.')
    assert.ok(initial.visible < initial.prepared, 'Display density is independent from coarse history demand.')
    assert.equal(initial.rendered, Math.floor(initial.visible), 'The default viewport projects the recent candles without gaps.')
    const input = async (deltaY, ctrlKey = true, deltaX = 0) => page.locator('[data-chart-plot]').evaluate((plot, options) => {
      const rect = plot.getBoundingClientRect()
      const event = new WheelEvent('wheel', { ...options, bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.4 })
      plot.dispatchEvent(event)
      return event.defaultPrevented
    }, { deltaY, ctrlKey, deltaX })
    const state = () => page.locator('[data-chart-inst]').evaluate(chart => {
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const rect = chart.querySelector('[data-chart-plot]').getBoundingClientRect()
      const width = svg.viewBox.baseVal.width
      const anchor = rect.width * 0.4 * width / rect.width / Number(svg.dataset.chartPlotRight)
      const start = Number(svg.dataset.chartDomainStart), end = Number(svg.dataset.chartDomainEnd)
      return { spacing: Number(chart.dataset.chartBarSpacing), body: Number(svg.dataset.chartBarWidth), count: Number(chart.dataset.chartVisibleBars), end: Number(chart.dataset.chartCompletedEnd), domainEnd: end,
        timeAtPointer: start + (end - start) * anchor }
    })
    const resize = async width => {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.dataset.chartLoading === 'false')
      return state()
    }
    const narrow = await resize(1200)
    const wide = await resize(1600)
    assert.equal(wide.spacing, narrow.spacing)
    assert.equal(wide.body, narrow.body)
    assert.equal(wide.domainEnd, narrow.domainEnd)
    assert.ok(wide.count > narrow.count, 'Widening reveals history rather than stretching candles.')
    const wider = await resize(1601)
    assert.equal(wider.spacing, wide.spacing)
    assert.equal(wider.body, wide.body)
    assert.ok(wider.count > wide.count && wider.count - wide.count < 1, 'Single-pixel resize has no density bucket jump.')
    // Start away from the live boundary, where both zoom directions have room.
    await input(720, false)
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.dataset.chartLoading === 'false')
    const before = await state()
    assert.equal(await input(-20), true, 'Native nonpassive handler prevents Chromium page zoom.')
    await page.waitForFunction(count => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) < count, before.count)
    const zoomed = await state()
    assert.ok(zoomed.count < before.count)
    assert.ok(Math.abs(zoomed.timeAtPointer - before.timeAtPointer) < 900_000, `Pointer anchor: ${JSON.stringify({ before, zoomed })}`)
    const zoomResize = await resize(1800)
    assert.equal(zoomResize.spacing, zoomed.spacing, 'Resize preserves the selected pinch spacing.')
    assert.equal(zoomResize.body, zoomed.body)
    assert.equal(zoomResize.domainEnd, zoomed.domainEnd, 'Resize preserves a historical fractional endpoint.')
    await resize(1601)
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1)
    await input(24, false, 48)
    await page.waitForFunction(end => Number(document.querySelector('[data-chart-inst]').dataset.chartCompletedEnd) > end, zoomed.end)
    const panned = await state()
    assert.equal(panned.spacing, zoomed.spacing, 'Two-finger scrolling preserves zoom.')
    // Pinching leaves a fractional endpoint; reaching latest must release it.
    await input(-100_000, false)
    await page.waitForFunction(() => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart.__chartSnapshot
      const latest = snapshot?.liveBar?.hour ?? snapshot?.endHour
      return Number(chart.querySelector('svg[data-rendered-inst]')?.dataset.chartDomainEnd) === latest
        && Number(chart.dataset.chartEnd) === latest
    })
    assert.equal((await state()).spacing, zoomed.spacing, 'Returning to latest preserves candle spacing.')
    await input(-1, false)
    await input(1, false)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-wheel-content]').dataset.chartWheelOffset) > 0)
    assert.equal((await state()).spacing, zoomed.spacing, 'Reversing from the latest edge responds immediately without changing zoom.')
    await input(10)
    await page.waitForFunction(count => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) > count, zoomed.count)
    assert.ok((await state()).count > zoomed.count)
    // All events in one renderer task must combine before the first paint.
    const burstBefore = await state()
    await page.locator('[data-chart-plot]').evaluate(plot => {
      const rect = plot.getBoundingClientRect()
      for (let index = 0; index < 32; index++) plot.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -1, ctrlKey: true, clientX: rect.left + rect.width * 0.4, bubbles: true, cancelable: true,
      }))
    })
    await page.waitForFunction(spacing => Math.abs(Number(document.querySelector('[data-chart-bar-spacing]').dataset.chartBarSpacing) - spacing) < 1e-8, burstBefore.spacing * Math.exp(0.32))
    await input(-10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-bar-spacing]').dataset.chartBarSpacing) === 100)
    const minimum = await state()
    await input(-10000)
    assert.equal((await state()).domainEnd, minimum.domainEnd, 'Saturating zoom cannot accumulate hidden navigation.')
    await input(1)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-bar-spacing]').dataset.chartBarSpacing) < 100)
    await input(10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-bar-spacing]').dataset.chartBarSpacing) === 4)
    const maximum = await state()
    const ultraWide = await resize(2400)
    assert.equal(ultraWide.spacing, maximum.spacing)
    assert.equal(ultraWide.body, maximum.body)
    assert.ok(ultraWide.count > 288, 'A widened zoomed-out chart can use more than the former cache maximum.')
    assert.equal(ultraWide.domainEnd, maximum.domainEnd)
    await input(-1)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-bar-spacing]').dataset.chartBarSpacing) > 4)

    // Queue a trailing gesture then switch the series before its frame flushes.
    await page.locator('[data-chart-plot]').evaluate(plot => {
      const event = () => plot.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, ctrlKey: true, bubbles: true, cancelable: true }))
      event()
      queueMicrotask(() => {
        event()
        const buttons = [...document.querySelectorAll('[aria-label="Chart timeframe"] button')]
        buttons.find(button => button.textContent.toLowerCase() === '1h').click()
      })
    })
    await page.waitForFunction(() => document.querySelector('svg[data-rendered-timeframe="1H"]') && document.querySelector('[data-chart-inst]').dataset.chartLoading === 'false')
    const switched = await state()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await state(), switched, 'A previous timeframe cannot consume a queued pinch after selection changes.')
    const fixture = await page.locator('[data-chart-inst]').evaluate(chart => ({
      instId: chart.dataset.chartInst, timeframe: '1H', end: chart.__chartSnapshot.endHour,
    }))
    await openChart(page, fixture)
    await waitForTargetSnapshot(page, fixture, fixture.timeframe, fixture.end)
    const oracle = await page.locator('[data-chart-inst]').evaluate(chart => ({
      rendered: chart.__chartRenderedBars.length, visible: Number(chart.dataset.chartVisibleBars),
      prepared: Number(chart.dataset.chartTargetBars), cached: chart.__chartSnapshot.bars.length,
    }))
    assert.equal(Math.floor(oracle.visible), 96, 'Fixed timing/oracle fixtures explicitly select a 96-candle display.')
    assert.equal(oracle.rendered, 96, 'The oracle uses the actual projected candle input.')
    assert.ok(oracle.prepared > oracle.visible && oracle.cached >= oracle.visible, 'The prepared cache may retain additional candles.')
    assert.deepEqual(errors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
