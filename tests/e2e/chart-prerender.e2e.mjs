import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('qualified rows stay stable while charts are cold and prepared SVGs survive selection, updates and resize', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-prerender-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartTimeframe: '15m' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    // Withhold chart delivery before the first fixture frame can be ingested.
    // Backend qualification, automatic preparation and explicit focus continue.
    await electron.evaluate(({ ipcMain, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const original = ipcMain._invokeHandlers.get('radar:request'), originalSend = contents.send
      const gate = globalThis.__prerenderGate = { original, originalSend, contents, held: true, suppressedReads: 0, suppressedPushes: 0, event: null }
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', async (event, value) => {
        gate.event = event
        const response = await original(event, value)
        if (!gate.held) return response
        if (value.chartUniverse) { gate.suppressedReads += 1; return { ...response, frames: [] } }
        if (value.chartLocal || value.chartHistory || value.chartWindow) { gate.suppressedReads += 1; return null }
        return response
      })
      contents.send = function (channel, ...args) {
        if (gate.held && channel === 'radar:chart-prepared') { gate.suppressedPushes += 1; return }
        return originalSend.call(this, channel, ...args)
      }
      gate.release = async () => {
        gate.held = false
        const { frames } = await original(gate.event, { chartUniverse: {} })
        for (const frame of frames) originalSend.call(contents, 'radar:chart-prepared', frame)
      }
    })
    const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    const canonical = await page.evaluate(() => window.radarDesktop.request({ snapshot: { sinceRevision: -1 } }))
    const canonicalIds = canonical.rows.map(row => row.instId)
    assert.deepEqual([...canonicalIds].sort(), [...fixture.instIds].sort())
    await page.waitForFunction(ids => {
      const table = document.querySelector('[data-total-market-count]')
      const rows = [...document.querySelectorAll('[data-market-index]')]
      return Number(table?.dataset.totalMarketCount) === ids.length && Number(table?.dataset.marketCount) === ids.length
        && rows.length > 1 && rows.every(row => row.getAttribute('aria-label') === `View ${ids[Number(row.dataset.marketIndex)]} chart`)
        && rows.some(row => row.getAttribute('aria-selected') === 'true')
    }, canonicalIds)
    await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); await new Promise(resolve => requestAnimationFrame(resolve)) })
    const initial = await page.evaluate(() => {
      const list = document.querySelector('[data-market-list]'), table = list.querySelector('[data-total-market-count]')
      const id = row => row.getAttribute('aria-label').slice(5, -6)
      const nodes = [...list.querySelectorAll('[data-market-index]')]
      const probe = window.__prerenderProbe = { nodes, ids: nodes.map(id), count: table.dataset.marketCount,
        total: table.dataset.totalMarketCount, selected: id(nodes.find(row => row.getAttribute('aria-selected') === 'true')), violations: [], inspections: 0 }
      const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
      const inspect = (records = []) => {
        probe.inspections += 1
        const rows = [...list.querySelectorAll('[data-market-index]')]
        if (rows.length !== nodes.length || rows.some((row, index) => row !== nodes[index] || id(row) !== probe.ids[index])) fail('Chart readiness changed row identity, count or order.')
        if (table.dataset.marketCount !== probe.count || table.dataset.totalMarketCount !== probe.total) fail('Chart readiness changed the qualified list count.')
        const selected = rows.filter(row => row.getAttribute('aria-selected') === 'true').map(id)
        if (selected.length !== 1 || selected[0] !== probe.selected) fail('Chart readiness changed the selected contract.')
        if (records.some(record => [...record.removedNodes].some(removed => nodes.some(row => removed === row || removed.contains(row))))) fail('A stable qualified row was detached and reinserted.')
      }
      const observer = new MutationObserver(inspect)
      observer.observe(list, { subtree: true, childList: true, attributes: true })
      probe.inspect = inspect
      probe.stop = () => { inspect(observer.takeRecords()); observer.disconnect(); return { violations: probe.violations, inspections: probe.inspections } }
      inspect()
      return { ids: probe.ids, selected: probe.selected }
    })
    const coldTarget = initial.ids.find(id => id !== initial.selected)
    assert.ok(coldTarget)
    assert.equal(await page.evaluate(() => document.querySelectorAll('svg[data-prepared-chart-inst]').length), 0,
      'Qualified rows must be present while every renderer chart is still missing.')
    await page.locator(`[aria-label="View ${coldTarget} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await page.waitForFunction(id => document.querySelector('[data-market-index][aria-selected="true"]')?.getAttribute('aria-label') === `View ${id} chart`, coldTarget)
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1h$/i }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Chart timeframe"] [aria-pressed="true"]')?.textContent?.toLowerCase() === '1h')
    assert.equal(await page.evaluate(() => { window.__prerenderProbe.inspect(); return document.querySelectorAll('svg[data-prepared-chart-inst]').length }), 0,
      'Changing a cold chart period must leave the qualified list available before any SVG exists.')
    const cold = await electron.evaluate(() => ({ reads: globalThis.__prerenderGate.suppressedReads, pushes: globalThis.__prerenderGate.suppressedPushes }))
    assert.ok(cold.reads + cold.pushes > 0, 'The cold-readiness gate must actually withhold chart delivery.')
    const waitForPool = async timeframe => page.waitForFunction(({ ids, timeframe }) => {
      const table = document.querySelector('[data-total-market-count]')
      return Number(table?.dataset.totalMarketCount) === ids.length && ids.every(id =>
        [...document.querySelectorAll('svg[data-prepared-chart-inst]')].some(svg => svg.dataset.preparedChartInst === id
          && svg.dataset.preparedChartTimeframe === timeframe && svg.dataset.preparedChartReady === 'true'
          && svg.querySelector('[data-chart-indicator="ema"]')?.getAttribute('d') && svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0))
    }, { ids: fixture.instIds, timeframe }, { timeout: 40_000 }).catch(async error => {
      console.error(JSON.stringify(await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'preparedDiagnostics' }))))
      console.error(JSON.stringify(await page.evaluate(() => ({ table: document.querySelector('[data-total-market-count]')?.outerHTML.slice(0, 300),
        plots: [...document.querySelectorAll('svg[data-prepared-chart-inst]')].map(svg => ({ ...svg.dataset })),
        status: document.querySelector('[data-chart-status]')?.textContent }))))
      throw error
    })
    await electron.evaluate(() => globalThis.__prerenderGate.release())
    await waitForPool('1H')
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^15m$/i }).click()
    await waitForPool('15m')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    const target = initial.ids.find(id => id !== coldTarget)
    await page.evaluate(({ id }) => {
      const svg = [...document.querySelectorAll('svg[data-prepared-chart-inst]')].find(svg => svg.dataset.preparedChartInst === id && svg.dataset.preparedChartTimeframe === '15m')
      window.__prerenderTarget = { svg, paths: [...svg.querySelectorAll('path')], width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height }
    }, { id: target })
    await page.locator(`[aria-label="View ${target} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await page.waitForFunction(id => document.querySelector('svg[data-rendered-inst]')?.dataset.renderedInst === id, target)
    assert.equal(await page.evaluate(() => {
      const { svg, paths } = window.__prerenderTarget
      return document.querySelector('svg[data-rendered-inst]') === svg && paths.every((path, index) => svg.querySelectorAll('path')[index] === path)
    }), true, 'The first selection must reveal the already mounted SVG and paths.')

    // An unselected candidate receives a durable price correction.
    const background = coldTarget
    const rows = await page.evaluate(({ instrument, timestamp }) => window.radarDesktop.request({ e2e: {
      action: 'readCandles', instrument, timeframe: '15m', from: timestamp, through: timestamp,
    } }), { instrument: background, timestamp: fixture.end })
    const fields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed', 'baseVolume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion']
    const correction = { ...Object.fromEntries(fields.map(key => [key, rows[0][key]])), close: rows[0].close + 1, high: rows[0].high + 2 }
    const previousPath = await page.evaluate(id => {
      const svg = [...document.querySelectorAll('svg[data-prepared-chart-inst]')].find(svg => svg.dataset.preparedChartInst === id)
      window.__backgroundSVG = svg
      window.__backgroundEMA = svg.querySelector('[data-chart-indicator="ema"]')
      return window.__backgroundEMA.getAttribute('d')
    }, background)
    await electron.evaluate((_electron, candle) => globalThis.__marketBackend.probe({ action: 'persistCandles', candles: [candle] }), correction)
    await page.waitForFunction(previous => window.__backgroundSVG.isConnected
      && window.__backgroundSVG.querySelector('[data-chart-indicator="ema"]').getAttribute('d') !== previous, previousPath)
    assert.equal(await page.evaluate(() => window.__backgroundSVG.querySelector('[data-chart-indicator="ema"]') === window.__backgroundEMA), true,
      'A durable correction must update the existing indicator path.')
    await waitForPool('15m')

    // Resizing may legitimately change virtualization; the fixed-viewport list
    // identity assertion covers cold readiness, preparation and corrections.
    const stability = await page.evaluate(() => window.__prerenderProbe.stop())
    assert.ok(stability.inspections > 1)
    assert.deepEqual(stability.violations, [])

    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 700))
    await page.waitForFunction(() => window.__prerenderTarget.svg.viewBox.baseVal.height !== window.__prerenderTarget.height)
    assert.equal(await page.evaluate(() => document.querySelector('svg[data-rendered-inst]') === window.__prerenderTarget.svg), true,
      'Resizing must update the existing surface.')
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1h$/i }).click()
    await waitForPool('1H')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    assert.deepEqual(pageErrors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
