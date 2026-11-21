import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('trackpad pinch zooms the cached chart around the pointer and keeps wheel history navigation', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-zoom-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartDisplayMode: 'multi' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    await page.waitForFunction(() => document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst][data-chart-loading="false"] svg[data-rendered-inst]'))
    const initial = await page.locator('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst]').evaluate(chart => ({
      visible: Number(chart.dataset.chartVisibleBars), prepared: Number(chart.dataset.chartTargetBars),
      rendered: Number(chart.dataset.chartRenderedBars),
    }))
    assert.ok(initial.visible >= 50 && initial.visible <= 250, 'Default candles use a readable density.')
    assert.ok(initial.visible < initial.prepared, 'Display density is independent from coarse history demand.')
    const input = async (deltaY, ctrlKey = true, deltaX = 0) => page.locator('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-plot]').evaluate((plot, options) => {
      const rect = plot.getBoundingClientRect()
      const event = new WheelEvent('wheel', { ...options, bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.4 })
      plot.dispatchEvent(event)
      return event.defaultPrevented
    }, { deltaY, ctrlKey, deltaX })
    const state = () => page.locator('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst]').evaluate(chart => {
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const rect = chart.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-plot]').getBoundingClientRect()
      const width = svg.viewBox.baseVal.width
      const anchor = rect.width * 0.4 * width / rect.width / Number(svg.dataset.chartPlotRight)
      const start = Number(svg.dataset.chartDomainStart), end = Number(svg.dataset.chartDomainEnd)
      return { spacing: Number(chart.dataset.chartBarSpacing), body: Number(svg.dataset.chartBarWidth), count: Number(chart.dataset.chartVisibleBars), end: Number(chart.dataset.chartCompletedEnd), domainEnd: end,
        timeAtPointer: start + (end - start) * anchor }
    })
    const resize = async width => {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.waitForFunction(() => document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst]')?.dataset.chartLoading === 'false')
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
    await page.waitForFunction(() => document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst]')?.dataset.chartLoading === 'false')
    const before = await state()
    assert.equal(await input(-20), true, 'Native nonpassive handler prevents Chromium page zoom.')
    await page.waitForFunction(count => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-visible-bars]').dataset.chartVisibleBars) < count, before.count)
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
    await page.waitForFunction(end => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-inst]').dataset.chartCompletedEnd) > end, zoomed.end)
    const panned = await state()
    assert.equal(panned.spacing, zoomed.spacing, 'Two-finger scrolling preserves zoom.')
    await input(10)
    await page.waitForFunction(count => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-visible-bars]').dataset.chartVisibleBars) > count, zoomed.count)
    assert.ok((await state()).count > zoomed.count)
    // All events in one renderer task must combine before the first paint.
    const burstBefore = await state()
    await page.locator('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-plot]').evaluate(plot => {
      const rect = plot.getBoundingClientRect()
      for (let index = 0; index < 32; index++) plot.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -1, ctrlKey: true, clientX: rect.left + rect.width * 0.4, bubbles: true, cancelable: true,
      }))
    })
    await page.waitForFunction(spacing => Math.abs(Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-bar-spacing]').dataset.chartBarSpacing) - spacing) < 1e-8, burstBefore.spacing * Math.exp(0.32))
    await input(-10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-bar-spacing]').dataset.chartBarSpacing) === 100)
    const minimum = await state()
    await input(-10000)
    assert.equal((await state()).domainEnd, minimum.domainEnd, 'Saturating zoom cannot accumulate hidden navigation.')
    await input(1)
    await page.waitForFunction(() => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-bar-spacing]').dataset.chartBarSpacing) < 100)
    await input(10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-bar-spacing]').dataset.chartBarSpacing) === 4)
    const maximum = await state()
    const ultraWide = await resize(2400)
    assert.equal(ultraWide.spacing, maximum.spacing)
    assert.equal(ultraWide.body, maximum.body)
    assert.ok(ultraWide.count > 288, 'A widened zoomed-out chart can use more than the former cache maximum.')
    assert.equal(ultraWide.domainEnd, maximum.domainEnd)
    await input(-1)
    await page.waitForFunction(() => Number(document.querySelector('[data-multi-timeframe-charts] > :nth-child(2) [data-chart-bar-spacing]').dataset.chartBarSpacing) > 4)

    // Every timeframe remains present after zooming and navigation.
    assert.deepEqual(await page.locator('[data-multi-timeframe-charts] svg[data-rendered-timeframe]').evaluateAll(nodes => nodes.map(node => node.dataset.renderedTimeframe)), ['1H', '15m', '5m'])
    assert.deepEqual(errors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
