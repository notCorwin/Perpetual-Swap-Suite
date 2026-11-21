import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('qualified rows stay stable while three timeframe surfaces load and resize', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-chart-prerender-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartDisplayMode: 'multi' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    // Withhold chart delivery before the first fixture frame can be ingested.
    // This keeps list behavior observable without allowing a chart surface.
    await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const { encodeChartWire, decodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const original = ipcMain._invokeHandlers.get('radar:request'), originalSend = contents.send
      const gate = globalThis.__prerenderGate = { original, originalSend, contents, held: true, suppressedReads: 0, suppressedPushes: 0, event: null }
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', async (event, value, context) => {
        gate.event = event
        const response = await original(event, value, context)
        if (!gate.held) return response
        if (value.chartUniverse) { gate.suppressedReads += 1; return encodeChartWire({ ...decodeChartWire(response), frames: [] }) }
        if (value.chartLocal || value.chartHistory || value.chartWindow) { gate.suppressedReads += 1; return encodeChartWire(null) }
        return response
      })
      contents.send = function (channel, ...args) {
        if (gate.held && channel === 'radar:chart-prepared') { gate.suppressedPushes += 1; return }
        return originalSend.call(this, channel, ...args)
      }
      gate.release = async () => {
        gate.held = false
        const { frames } = decodeChartWire(await original(gate.event, { chartUniverse: {} }))
        for (const frame of frames) originalSend.call(contents, 'radar:chart-prepared', encodeChartWire(frame))
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
        total: table.dataset.totalMarketCount, selected: id(nodes.find(row => row.getAttribute('aria-selected') === 'true')),
        violations: [], inspections: 0, canonicalFrames: new Set(), correctionReceived: false }
      const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
      probe.onPrepared = event => {
        const frame = event.detail
        if (frame?.bars?.length === 96 && frame.indicatorState === 'ready'
          && ['ready', 'stale'].includes(frame.priceState) && ['ready', 'unavailable'].includes(frame.oiState)
          && ['ready', 'unavailable'].includes(frame.takerState)) probe.canonicalFrames.add(`${frame.timeframe}:${frame.instId}`)
        const expected = probe.expectedCorrection
        if (expected && frame?.instId === expected.instId && frame.timeframe === expected.timeframe
          && frame.bars?.some(bar => bar.hour === expected.hour && bar.close === expected.close)) probe.correctionReceived = true
      }
      window.addEventListener('radar-chart-prepared', probe.onPrepared)
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
      probe.stop = () => { inspect(observer.takeRecords()); observer.disconnect(); window.removeEventListener('radar-chart-prepared', probe.onPrepared); return { violations: probe.violations, inspections: probe.inspections } }
      inspect()
      return { ids: probe.ids, selected: probe.selected }
    })
    const coldTarget = initial.ids.find(id => id !== initial.selected)
    assert.ok(coldTarget)
    assert.equal(await page.evaluate(() => document.querySelectorAll('svg[data-prepared-chart-inst]').length), 0,
      'Qualified rows must be present while the current SVG surface is still missing.')
    await page.locator(`[aria-label="View ${coldTarget} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await page.waitForFunction(id => document.querySelector('[data-market-index][aria-selected="true"]')?.getAttribute('aria-label') === `View ${id} chart`, coldTarget)
    assert.equal(await page.evaluate(() => { window.__prerenderProbe.inspect(); return document.querySelectorAll('svg[data-prepared-chart-inst]').length }), 0,
      'The contract list remains usable while chart delivery is held.')
    const cold = await electron.evaluate(() => ({ reads: globalThis.__prerenderGate.suppressedReads, pushes: globalThis.__prerenderGate.suppressedPushes }))
    assert.ok(cold.reads + cold.pushes > 0, 'The cold-readiness gate must actually withhold chart delivery.')
    await electron.evaluate(() => globalThis.__prerenderGate.release())
    const ready = id => page.waitForFunction(id => {
      const charts = [...document.querySelectorAll('[data-multi-timeframe-charts] [data-chart-inst]')]
      return charts.length === 3 && charts.every(chart => chart.dataset.chartLoading === 'false'
        && chart.querySelector('svg[data-rendered-inst]')?.dataset.renderedInst === id)
    }, id, { timeout: 40_000 })
    await ready(coldTarget)
    assert.deepEqual(await page.locator('[data-multi-timeframe-charts] svg[data-rendered-timeframe]').evaluateAll(nodes => nodes.map(node => node.dataset.renderedTimeframe)), ['1H', '15m', '5m'])
    const target = initial.ids.find(id => id !== coldTarget)
    await page.locator(`[aria-label="View ${target} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await ready(target)
    assert.equal(await page.locator('[data-multi-timeframe-charts] svg[data-prepared-chart-inst]').count(), 3)
    const stability = await page.evaluate(() => window.__prerenderProbe.stop())
    assert.ok(stability.inspections > 1)
    assert.deepEqual(stability.violations, [])
    await page.evaluate(() => { window.__resizeSurfaces = [...document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]')] })
    const previousHeight = await page.evaluate(() => window.__resizeSurfaces[1].viewBox.baseVal.height)
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 700))
    await page.waitForFunction(height => window.__resizeSurfaces[1].viewBox.baseVal.height !== height, previousHeight)
    assert.equal(await page.evaluate(() => window.__resizeSurfaces.every((svg, index) => svg === document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]')[index])), true,
      'Resizing updates each existing timeframe surface.')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    assert.deepEqual(pageErrors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
