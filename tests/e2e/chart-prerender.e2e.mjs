import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('qualified rows stay stable while one SVG surface handles canonical frames, corrections and resize', { timeout: 90_000 }, async () => {
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
    // This keeps list behavior observable without allowing a chart surface.
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
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1h$/i }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Chart timeframe"] [aria-pressed="true"]')?.textContent?.toLowerCase() === '1h')
    assert.equal(await page.evaluate(() => { window.__prerenderProbe.inspect(); return document.querySelectorAll('svg[data-prepared-chart-inst]').length }), 0,
      'Changing the current period while data delivery is held must leave the qualified list available before an SVG exists.')
    const cold = await electron.evaluate(() => ({ reads: globalThis.__prerenderGate.suppressedReads, pushes: globalThis.__prerenderGate.suppressedPushes }))
    assert.ok(cold.reads + cold.pushes > 0, 'The cold-readiness gate must actually withhold chart delivery.')
    await electron.evaluate(() => globalThis.__prerenderGate.release())
    await page.waitForFunction(({ ids, timeframes }) => {
      const ready = window.__prerenderProbe.canonicalFrames
      return ids.every(id => timeframes.every(timeframe => ready.has(`${timeframe}:${id}`)))
    }, { ids: fixture.instIds, timeframes: fixture.timeframes }, { timeout: 40_000 })
    await page.waitForFunction(id => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      return svg?.dataset.renderedInst === id && svg.dataset.renderedTimeframe === '1H'
        && svg.closest('[data-chart-inst]')?.dataset.chartLoading === 'false'
    }, coldTarget)
    assert.deepEqual(await page.evaluate(() => ({ rendered: document.querySelectorAll('svg[data-rendered-inst]').length,
      prepared: document.querySelectorAll('svg[data-prepared-chart-inst]').length })), { rendered: 1, prepared: 1 },
    'Receiving the complete renderer universe must retain only the currently selected SVG surface.')
    const sharedSurface = await page.locator('svg[data-rendered-inst]').elementHandle()
    await page.evaluate(() => {
      window.__sharedSurface = document.querySelector('svg[data-rendered-inst]')
      window.__sharedEMA = window.__sharedSurface.querySelector('[data-chart-indicator="ema"]')
    })
    const assertSharedSurface = async phase => {
      assert.equal(await page.locator('svg[data-rendered-inst]').count(), 1, `${phase} must leave exactly one active SVG.`)
      assert.equal(await page.locator('svg[data-prepared-chart-inst]').count(), 1, `${phase} must expose exactly one current SVG surface.`)
      assert.equal(await sharedSurface.evaluate(svg => svg.isConnected && svg === document.querySelector('svg[data-rendered-inst]')), true,
        `${phase} must reuse the original SVG node.`)
    }
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^15m$/i }).click()
    await page.waitForFunction(id => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      return svg?.dataset.renderedInst === id && svg.dataset.renderedTimeframe === '15m'
        && svg.closest('[data-chart-inst]')?.dataset.chartLoading === 'false'
    }, coldTarget)
    await assertSharedSurface('Timeframe switch')
    const backgroundBeforeCorrection = await page.evaluate(() => {
      const bar = document.querySelector('[data-chart-inst]').__chartSnapshot.bars.at(-1)
      return { close: bar.close, ema: bar.ema,
        path: document.querySelector('svg[data-rendered-inst] [data-chart-indicator="ema"]').getAttribute('d') }
    })
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    const target = initial.ids.find(id => id !== coldTarget)
    await page.locator(`[aria-label="View ${target} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await page.waitForFunction(id => document.querySelector('svg[data-rendered-inst]')?.dataset.renderedInst === id
      && document.querySelector('[data-chart-inst]')?.dataset.chartLoading === 'false', target)
    await assertSharedSurface('Contract switch')

    // An unselected candidate receives a durable price correction.
    const background = coldTarget
    const rows = await page.evaluate(({ instrument, timestamp }) => window.radarDesktop.request({ e2e: {
      action: 'readCandles', instrument, timeframe: '15m', from: timestamp, through: timestamp,
    } }), { instrument: background, timestamp: fixture.end })
    const fields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed', 'baseVolume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion']
    const correction = { ...Object.fromEntries(fields.map(key => [key, rows[0][key]])), close: rows[0].close + 1, high: rows[0].high + 2 }
    const beforeCorrection = await page.evaluate(() => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const chart = document.querySelector('[data-chart-inst]')
      window.__surfaceBeforeCorrection = svg
      window.__snapshotBeforeCorrection = chart.__chartSnapshot
      window.__emaBeforeCorrection = svg.querySelector('[data-chart-indicator="ema"]')
      return { instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe,
        ema: svg.querySelector('[data-chart-indicator="ema"]')?.getAttribute('d') }
    })
    assert.equal(beforeCorrection.instId, target)
    await page.evaluate(({ instId, hour, close }) => {
      window.__prerenderProbe.expectedCorrection = { instId, timeframe: '15m', hour, close }
    }, { instId: background, hour: fixture.end, close: correction.close })
    await electron.evaluate((_electron, candle) => globalThis.__marketBackend.probe({ action: 'persistCandles', candles: [candle] }), correction)
    await page.waitForFunction(() => window.__prerenderProbe.correctionReceived, null, { timeout: 20_000 })
    assert.deepEqual(await page.evaluate(() => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const chart = document.querySelector('[data-chart-inst]')
      return { instId: svg?.dataset.renderedInst, timeframe: svg?.dataset.renderedTimeframe,
        count: document.querySelectorAll('svg[data-rendered-inst]').length,
        ema: svg?.querySelector('[data-chart-indicator="ema"]')?.getAttribute('d'),
        sameSurface: svg === window.__surfaceBeforeCorrection,
        sameSnapshot: chart.__chartSnapshot === window.__snapshotBeforeCorrection,
        sameEMAPath: svg?.querySelector('[data-chart-indicator="ema"]') === window.__emaBeforeCorrection }
    }), { ...beforeCorrection, count: 1, sameSurface: true, sameSnapshot: true, sameEMAPath: true },
    'A durable correction for an unselected contract must leave the current chart untouched.')

    await page.locator(`[aria-label="View ${background} chart"]`).evaluate(row => {
      window.__prerenderProbe.selected = row.getAttribute('aria-label').slice(5, -6)
      row.click()
    })
    await page.waitForFunction(({ instId, hour, close }) => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
      return snapshot?.instId === instId && snapshot.timeframe === '15m'
        && snapshot.bars.some(bar => bar.hour === hour && bar.close === close)
        && chart.dataset.chartLoading === 'false'
    }, { instId: background, hour: fixture.end, close: correction.close })
    const expectedEMA = backgroundBeforeCorrection.ema + 2 / 201 * (correction.close - backgroundBeforeCorrection.close)
    assert.equal(await page.evaluate(({ previousPath, hour, close, expectedEMA }) => {
      const svg = document.querySelector('svg[data-rendered-inst]'), chart = document.querySelector('[data-chart-inst]')
      const ema = svg?.querySelector('[data-chart-indicator="ema"]')
      return svg === window.__sharedSurface && ema === window.__sharedEMA
        && ema?.getAttribute('d') !== previousPath && chart.__chartSnapshot.bars.some(bar => bar.hour === hour && bar.close === close
          && Math.abs(bar.ema - expectedEMA) < 1e-10)
    }, { previousPath: backgroundBeforeCorrection.path, hour: fixture.end, close: correction.close, expectedEMA }), true,
    'Selecting the corrected contract must immediately redraw its indicator on the existing SVG and EMA path nodes.')
    await assertSharedSurface('Corrected contract switch')

    // A selected contract consumes a canonical live update and selection in one
    // turn. The current SVG node must show that frame at the next animation frame.
    const liveTarget = target
    const liveFrame = await electron.evaluate(async (_electron, instId) => {
      const gate = globalThis.__prerenderGate
      const { frames } = await gate.original(gate.event, { chartUniverse: {} })
      const frame = frames.find(value => value.instId === instId && value.timeframe === '15m')
      // Isolate the synthetic input from real backend publications. A newer
      // authoritative frame is allowed to supersede it after this measurement.
      gate.held = true
      return frame
    }, liveTarget)
    let liveSelection
    try { liveSelection = await page.evaluate(({ instId, frame }) => {
      const last = frame.bars.at(-1), price = last.close + 7
      window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: {
        type: 'live', instId, timeframe: frame.timeframe, generation: frame.generation, revision: frame.revision + 1,
        endHour: frame.endHour, liveBar: { ...last, hour: frame.endHour + frame.intervalMS,
          open: price, high: price, low: price, close: price, confirmed: false },
      } }))
      window.__prerenderProbe.selected = instId
      document.querySelector(`[aria-label="View ${instId} chart"]`).click()
      return new Promise(resolve => requestAnimationFrame(() => {
        const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
        const svg = chart?.querySelector('svg[data-rendered-inst]')
        const labelPrice = Number(svg?.querySelector('[data-chart-price-label-value]')?.textContent.split(/\s/)[0].replaceAll(',', ''))
        resolve({ price, currentInst: snapshot?.instId, livePrice: snapshot?.liveBar?.close, labelPrice,
          currentAtNextFrame: snapshot?.instId === instId && snapshot.liveBar?.close === price
          && snapshot.bars.length === 96 && snapshot.bars.every(bar => bar.confirmed)
          && svg === window.__sharedSurface && Math.abs(labelPrice - price) < 1e-5 })
      }))
    }, { instId: liveTarget, frame: liveFrame }) }
    finally { await electron.evaluate(() => globalThis.__prerenderGate.release()) }
    assert.equal(liveSelection.currentAtNextFrame, true,
      `The current SVG must show the selected contract live price by the next frame: ${JSON.stringify(liveSelection)}`)
    // Later authoritative backend frames may supersede this injected price;
    // the assertion above inspects the complete SVG in the measured frame.

    // Resizing may change list virtualization, but the chart keeps one surface.
    const stability = await page.evaluate(() => window.__prerenderProbe.stop())
    assert.ok(stability.inspections > 1)
    assert.deepEqual(stability.violations, [])

    const previousHeight = await sharedSurface.evaluate(svg => svg.viewBox.baseVal.height)
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 700))
    await page.waitForFunction(height => window.__sharedSurface.viewBox.baseVal.height !== height, previousHeight)
    assert.equal(await page.evaluate(() => document.querySelector('svg[data-rendered-inst]') === window.__sharedSurface), true,
      'Resizing must update the existing surface.')
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1h$/i }).click()
    await page.waitForFunction(() => document.querySelector('svg[data-rendered-inst]')?.dataset.renderedTimeframe === '1H')
    await assertSharedSurface('Final timeframe switch')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'The acceptance app must never take macOS window focus.')
    assert.deepEqual(pageErrors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
