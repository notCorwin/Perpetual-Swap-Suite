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
    assert.ok(initial.visible >= 64 && initial.visible <= 192, 'Default candles use a readable density.')
    assert.ok(initial.visible < initial.prepared, 'Display density is independent from coarse history demand.')
    assert.equal(initial.rendered, initial.visible, 'The default viewport projects the recent candles without gaps.')
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
      return { count: Number(chart.dataset.chartVisibleBars), end: Number(chart.dataset.chartCompletedEnd), domainEnd: end,
        timeAtPointer: start + (end - start) * anchor }
    })
    // Start away from the live boundary, where both zoom directions have room.
    await input(720, false)
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.dataset.chartLoading === 'false')
    const before = await state()
    assert.equal(await input(-20), true, 'Native nonpassive handler prevents Chromium page zoom.')
    await page.waitForFunction(count => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) < count, before.count)
    const zoomed = await state()
    assert.ok(zoomed.count < before.count)
    assert.ok(Math.abs(zoomed.timeAtPointer - before.timeAtPointer) < 900_000, `Pointer anchor: ${JSON.stringify({ before, zoomed })}`)
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1)
    await input(24, false, 48)
    await page.waitForFunction(end => Number(document.querySelector('[data-chart-inst]').dataset.chartCompletedEnd) > end, zoomed.end)
    const panned = await state()
    assert.equal(panned.count, zoomed.count, 'Two-finger scrolling preserves zoom.')
    // Pinching leaves a fractional endpoint; reaching latest must release it.
    await input(-100_000, false)
    await page.waitForFunction(() => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart.__chartSnapshot
      const latest = snapshot?.liveBar?.hour ?? snapshot?.endHour
      return Number(chart.querySelector('svg[data-rendered-inst]')?.dataset.chartDomainEnd) === latest
        && Number(chart.dataset.chartEnd) === latest
    })
    assert.equal((await state()).count, zoomed.count, 'Returning to latest preserves candle spacing.')
    await input(-1, false)
    await input(1, false)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-wheel-content]').dataset.chartWheelOffset) > 0)
    assert.equal((await state()).count, zoomed.count, 'Reversing from the latest edge responds immediately without changing zoom.')
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
    await page.waitForFunction(count => Math.abs(Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) - count) < 1e-8, burstBefore.count * Math.exp(-0.32))
    await input(-10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) === 12)
    const minimum = await state()
    await input(-10000)
    assert.equal((await state()).domainEnd, minimum.domainEnd, 'Saturating zoom cannot accumulate hidden navigation.')
    await input(1)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) > 12)
    await input(10000)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) === 288)
    await input(-1)
    await page.waitForFunction(() => Number(document.querySelector('[data-chart-visible-bars]').dataset.chartVisibleBars) < 288)

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
    assert.deepEqual(errors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
