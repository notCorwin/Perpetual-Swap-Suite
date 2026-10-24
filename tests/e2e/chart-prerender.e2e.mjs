import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('listed charts have committed SVGs before first selection and retain them through updates and resize', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-prerender-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartTimeframe: '15m' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const violations = [], pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => {
      const probe = window.__prerenderProbe = { violations: [], nodes: new Map() }
      const inspect = () => {
        for (const row of document.querySelectorAll('[data-market-index]')) {
          const instId = row.getAttribute('aria-label').slice(5, -6)
          const timeframe = document.querySelector('[aria-label="Chart timeframe"] [aria-pressed="true"]')?.textContent?.toLowerCase()
          const svg = [...document.querySelectorAll('svg[data-prepared-chart-inst]')].find(svg =>
            svg.dataset.preparedChartInst === instId && svg.dataset.preparedChartTimeframe.toLowerCase() === timeframe)
          if (!svg?.isConnected || !svg.querySelector('[data-chart-indicator="ema"][d]') || !(svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0)) {
            probe.violations.push(`${instId}/${timeframe} became selectable without a completed SVG`)
          }
          if (svg && !probe.nodes.has(`${timeframe}:${instId}`)) probe.nodes.set(`${timeframe}:${instId}`, svg)
        }
      }
      const observer = new MutationObserver(inspect)
      observer.observe(document, { subtree: true, childList: true, attributes: true })
      probe.stop = () => observer.disconnect()
      inspect()
    })
    const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    const waitForPool = async timeframe => page.waitForFunction(({ ids, timeframe }) => {
      const table = document.querySelector('[data-total-market-count]')
      return Number(table?.dataset.totalMarketCount) === ids.length && ids.every(id =>
        [...document.querySelectorAll('svg[data-prepared-chart-inst]')].some(svg => svg.dataset.preparedChartInst === id
          && svg.dataset.preparedChartTimeframe === timeframe && svg.querySelector('[data-chart-indicator="ema"]')?.getAttribute('d')))
    }, { ids: fixture.instIds, timeframe }, { timeout: 40_000 }).catch(async error => {
      console.error(JSON.stringify(await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'preparedDiagnostics' }))))
      console.error(JSON.stringify(await page.evaluate(() => ({ table: document.querySelector('[data-total-market-count]')?.outerHTML.slice(0, 300),
        plots: [...document.querySelectorAll('svg[data-prepared-chart-inst]')].map(svg => ({ ...svg.dataset })),
        status: document.querySelector('[data-chart-status]')?.textContent }))))
      throw error
    })
    await waitForPool('15m')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    const target = fixture.instIds.find(id => id !== fixture.instIds[0])
    await page.evaluate(({ id }) => {
      const svg = [...document.querySelectorAll('svg[data-prepared-chart-inst]')].find(svg => svg.dataset.preparedChartInst === id)
      window.__prerenderTarget = { svg, paths: [...svg.querySelectorAll('path')], width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height }
    }, { id: target })
    await page.locator(`[aria-label="View ${target} chart"]`).click()
    await page.waitForFunction(id => document.querySelector('svg[data-rendered-inst]')?.dataset.renderedInst === id, target)
    assert.equal(await page.evaluate(() => {
      const { svg, paths } = window.__prerenderTarget
      return document.querySelector('svg[data-rendered-inst]') === svg && paths.every((path, index) => svg.querySelectorAll('path')[index] === path)
    }), true, 'The first selection must reveal the already mounted SVG and paths.')

    // A previously unselected candidate receives a durable price correction.
    const background = fixture.instIds[0]
    const rows = await page.evaluate(({ instrument, timestamp }) => window.radarDesktop.request({ e2e: {
      action: 'readCandles', instrument, timeframe: '15m', from: timestamp, through: timestamp,
    } }), { instrument: background, timestamp: fixture.end })
    const fields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed', 'baseVolume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion']
    const correction = { ...Object.fromEntries(fields.map(key => [key, rows[0][key]])), close: rows[0].close + 1, high: rows[0].high + 2 }
    const previousPath = await page.evaluate(id => {
      const svg = [...document.querySelectorAll('svg[data-prepared-chart-inst]')].find(svg => svg.dataset.preparedChartInst === id)
      window.__backgroundSVG = svg
      return svg.querySelector('[data-chart-indicator="ema"]').getAttribute('d')
    }, background)
    await electron.evaluate((_electron, candle) => globalThis.__marketBackend.probe({ action: 'persistCandles', candles: [candle] }), correction)
    await page.waitForFunction(previous => window.__backgroundSVG.isConnected
      && window.__backgroundSVG.querySelector('[data-chart-indicator="ema"]').getAttribute('d') !== previous, previousPath)
    await waitForPool('15m')

    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 700))
    await page.waitForFunction(() => window.__prerenderTarget.svg.viewBox.baseVal.height !== window.__prerenderTarget.height)
    assert.equal(await page.evaluate(() => document.querySelector('svg[data-rendered-inst]') === window.__prerenderTarget.svg), true,
      'Resizing must update the existing surface.')
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1h$/i }).click()
    await waitForPool('1H')
    violations.push(...await page.evaluate(() => { window.__prerenderProbe.stop(); return window.__prerenderProbe.violations }))
    assert.deepEqual(violations, [])
    assert.deepEqual(pageErrors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
