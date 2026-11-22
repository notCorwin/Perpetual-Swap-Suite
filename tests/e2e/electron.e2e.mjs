import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { measureNativeWindowControls } from '../helpers/native-window-controls.mjs'
import { assertScrollResponsiveness } from '../../scripts/chart-acceptance-metrics.mjs'
import { assertCompleteChartViewport, assertCompletePaints, assertWorkspaceLayout, finishPaintProbe, installRequestProbe, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForLocalHistory, waitForRendered, wheelBurst, withPaintProbe } from '../../scripts/chart-acceptance.mjs'


const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-radar-e2e-'))
let electron
let page
const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
const electronEnvironment = (liveRefresh = false) => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
  PERPETUAL_SWAP_E2E: '1',
  PERPETUAL_SWAP_E2E_LIVE_REFRESH: liveRefresh ? '1' : '0',
  PERPETUAL_SWAP_USER_DATA: userData,
})
const launchElectron = async (liveRefresh = false) => {
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root, env: electronEnvironment(liveRefresh) })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}
const waitFor = async (read, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for the expected Electron response.')
}

// Prepared snapshots reach the controller through local hits, universe hits,
// pushed publications, and demand reads. Exercise the same payload at every
// ingress so these geometry tests do not depend on a particular cache miss.
const installPreparedTransform = async options => electron.evaluate(async ({ ipcMain, BrowserWindow }, options) => {
  const { encodeChartWire, decodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
  const original = ipcMain._invokeHandlers.get('radar:request')
  const contents = BrowserWindow.getAllWindows()[0].webContents
  const originalSend = contents.send
  const probe = { original, contents, originalSend, calls: 0, confirmed: new Map() }
  const transform = response => {
    if (response?.instId !== options.instId || options.timeframe && response.timeframe !== options.timeframe) return response
    if (options.mode === 'partial' && Array.isArray(response.bars)) return {
      ...response, oldestHour: options.end - 11 * options.intervalMS, historyExhausted: true, revision: 900_000,
      bars: response.bars.filter(bar => bar.hour >= options.end - 11 * options.intervalMS && bar.hour <= options.end).map(bar => ({ ...bar, statisticsSources: 0, statisticsObserved: false, oiObserved: false, takerObserved: false, oi: null, buy: null, sell: null })),
      priceState: 'partial', oiState: 'loading', takerState: 'loading', error: '',
    }
    if (options.mode === 'warmup' && Array.isArray(response.bars)) return { ...response, bars: response.bars.map(bar => ({
      ...bar,
      rsi6: bar.hour <= options.warmupThrough ? null : bar.rsi6,
      rsi12: bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.rsi12,
      atrPercent: bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.atrPercent,
      bbw: bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.bbw,
    })) }
    const lastConfirmed = response.bars?.find(bar => bar.hour === response.endHour)
    if (lastConfirmed) probe.confirmed.set(`${response.instId}:${response.timeframe}`, lastConfirmed)
    if (options.mode === 'live' && (response.type === 'live' || response.endHour === response.latestEnd)) {
      const last = lastConfirmed ?? probe.confirmed.get(`${response.instId}:${response.timeframe}`)
      if (!last) return response
      const intervalMS = response.intervalMS ?? ({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })[response.timeframe]
      const { oi = null, buy = null, sell = null } = options.liveStatistics ?? {}
      const oiObserved = Number.isFinite(oi), takerObserved = Number.isFinite(buy) && Number.isFinite(sell)
      return { ...response, liveBar: {
        ...last, hour: response.endHour + intervalMS,
        open: options.livePrice * .999, high: options.livePrice * 1.001, low: options.livePrice * .998, close: options.livePrice,
        confirmed: false, statisticsSources: Number(oiObserved) | (Number(takerObserved) << 1),
        statisticsObserved: oiObserved && takerObserved, oiObserved, takerObserved, oi, buy, sell,
      } }
    }
    return response
  }
  ipcMain.removeHandler('radar:request')
  ipcMain.handle('radar:request', async (event, value, context) => {
    if (value.chartWindow?.instId === options.instId) probe.calls += 1
    const wire = await original(event, value, context)
    if (!(value.chartUniverse || value.chartLocal || value.chartHistory || value.chartWindow)) return wire
    const response = decodeChartWire(wire)
    const result = value.chartUniverse ? { ...response, frames: response.frames.map(transform) } : transform(response)
    return result === response ? wire : encodeChartWire(result)
  })
  contents.send = function (channel, ...args) {
    if (channel === 'radar:chart-prepared') {
      const frame = decodeChartWire(args[0]), result = transform(frame)
      if (result !== frame) args[0] = encodeChartWire(result)
    }
    return originalSend.call(this, channel, ...args)
  }
  globalThis.__preparedTransform = probe
}, options)

const removePreparedTransform = async () => electron.evaluate(({ ipcMain }) => {
  const probe = globalThis.__preparedTransform
  ipcMain.removeHandler('radar:request')
  ipcMain.handle('radar:request', probe.original)
  probe.contents.send = probe.originalSend
  delete globalThis.__preparedTransform
})

before(async () => {
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartDisplayMode: 'indicators',
    notificationsEnabled: true, backgroundMonitoringEnabled: true, monitoringPaused: true,
    filterLibraryPreferencesJSON: '{"favorites":["emaTrend"]}',
  }))
  await launchElectron()
})
after(async () => { await electron?.close(); await rm(userData, { recursive: true, force: true }) })

test('window position and size survive an immediate restart', async () => {
  const initial = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const expected = await electron.evaluate(({ BrowserWindow, screen }) => {
    const target = BrowserWindow.getAllWindows()[0]
    const area = screen.getPrimaryDisplay().workArea
    target.setBounds({ x: area.x + 20, y: area.y + 20, width: 1250, height: 700 })
    return target.getNormalBounds()
  })
  await electron.close()
  await launchElectron()
  const restored = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  assert.deepEqual(restored, expected)
  await electron.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), initial)
})

test('desktop window loads the React workspace with a restricted renderer', async () => {
  if (process.env.PERPETUAL_SWAP_TEST_UI !== 'foreground') {
    const native = await electron.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), alwaysOnTop: window.isAlwaysOnTop(),
        dockVisible: process.platform === 'darwin' ? app.dock.isVisible() : false }
    })
    assert.deepEqual(native, { visible: false, focused: false, focusable: false, alwaysOnTop: false, dockVisible: false }, 'Background tests must not show a native window, stay on top, or acquire desktop focus.')
  }
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  await page.locator('#root').waitFor({ state: 'attached' })
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.radarDesktop.request), 'function')
  assert.equal(await page.evaluate(() => window.radarDesktop.nativeWindowControls), process.platform === 'darwin')
  assert.equal(await page.evaluate(() => typeof window.webkit?.messageHandlers?.radar), 'undefined')
})

test('native traffic lights align with the renderer toolbar after window resizing', { skip: process.platform !== 'darwin' }, async () => {
  const previous = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const measurements = []
  try {
    for (const width of [1_000, 1_600, 2_000]) {
      const actualWidth = await electron.evaluate(({ BrowserWindow }, width) => {
        const target = BrowserWindow.getAllWindows()[0]
        target.setContentSize(width, 1_000)
        return target.getContentSize()[0]
      }, width)
      await page.waitForFunction(width => innerWidth === width, actualWidth)
      await assertWorkspaceLayout(page)
      const native = await measureNativeWindowControls(electron)
      const row = await page.locator('[data-layout=market-workspace] > div > [data-window-drag-region]').boundingBox()
      const title = await page.locator('[data-chart-title]').boundingBox().catch(() => null)
      for (const [name, button] of Object.entries(native.buttons)) {
        assert.ok(button && !button.hidden && !button.hiddenOrHasHiddenAncestor, `${name} must be an enabled native control.`)
        assert.ok(Math.abs(button.y + button.height / 2 - (row.y + row.height / 2)) <= .5, `${name} must actually align with the toolbar: ${JSON.stringify({ native, row })}`)
        if (title) assert.ok(button.x + button.width < title.x, `${name} must not cover the chart title.`)
      }
      measurements.push({ width: actualWidth, row, title, native })
    }
    await writeFile(join(root, '.build', 'native-topbar-geometry.json'), `${JSON.stringify(measurements, null, 2)}\n`)
  } finally {
    await electron.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), previous)
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, previous)
    await assertWorkspaceLayout(page)
  }
})

test('preferences persist through the single desktop entry point and survive a process restart', async () => {
  const initial = await request({ preferences: { action: 'read' } })
  assert.equal(initial.chartTimeframe, '15m')
  assert.equal(initial.rankingLookback, 15)
  assert.equal(initial.historyDays, 30)
  assert.equal(initial.liquidity.volumeStability.enabled, false)
  const values = { rankingLookback: 30, historyDays: 45, liquidity: {
    ...initial.liquidity, spread: { enabled: false, maxPercent: .04 },
    volumeStability: { enabled: true, maxRatio: 2.5 },
  } }
  const saved = await request({ preferences: { action: 'update', values } })
  assert.equal(saved.rankingLookback, 30)
  assert.equal(saved.historyDays, 45)
  assert.deepEqual(saved.liquidity.spread, values.liquidity.spread)
  await electron.close()
  await launchElectron()
  assert.deepEqual(await request({ preferences: { action: 'read' } }), saved)
  await request({ preferences: { action: 'update', values: initial } })
})

test('snapshot IPC returns compact unchanged responses and refreshes rows for another collector session', async () => {
  const first = await request({ snapshot: { sinceRevision: -1 } })
  assert.ok(first.serviceSession)
  const same = await request({ snapshot: { sinceRevision: first.revision, serviceSession: first.serviceSession } })
  assert.equal(same.unchanged, true)
  assert.equal('rows' in same, false)
  const fresh = await request({ snapshot: { sinceRevision: same.revision, serviceSession: 'previous-collector' } })
  assert.ok(Array.isArray(fresh.rows))
})

test('Radar has no Research or Strategy workspace or desktop operations', async () => {
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Research|Strategy|Signals|Rules|Universe/ }).count(), 0)
  assert.equal(await page.locator('[data-mode-switch]').count(), 0)
  const previous = await request({ snapshot: { sinceRevision: -1 } })
  for (const value of [
    { suite: { mode: 'radar', action: 'evaluate', timeframe: '5m' } },
    { research: { action: 'list' } },
    { foregroundWorkspace: 'research' },
    { compileMarketFilters: { filtersJSON: '{}' } },
    { previewMarketFilters: { filtersJSON: '{}', token: 'retired' } },
    { explainMarketFilters: { instId: 'BTC-USDT-SWAP', filtersJSON: '{}', token: 'retired' } },
    { filterLibraryPreferencesJSON: '{}' },
    { notificationsEnabled: true },
    { backgroundMonitoringEnabled: true },
    { monitoringPaused: true },
    { windowBlurRadius: 99, notificationsEnabled: true },
    { previewWindowBlur: 20 },
    { windowTint: '#ffffff' },
    { rocPeriod: 9, marocPeriod: 9, timeframe: '5m', sinceRevision: -1 },
  ]) await assert.rejects(() => request(value), /Invalid desktop bridge request/)
  const current = await request({ snapshot: { sinceRevision: -1 } })
  assert.deepEqual(current.rows, previous.rows)
  assert.equal('timeframe' in current, false)
  for (const key of ['filterMetricsCatalog', 'filterFunctions', 'filterFunctionCatalog', 'filterLibraryPreferences',
    'notificationsEnabled', 'notificationAuthorization', 'notificationError', 'backgroundMonitoringEnabled',
    'backgroundMonitoringError', 'monitoringPaused', 'launchAtLogin', 'launchAtLoginError']) {
    assert.equal(key in current, false, `The retired ${key} setting must not appear in Radar snapshots.`)
  }
})

test('completed candles round-trip through the Electron-owned SQLite store', async () => {
  const timestamp = Date.UTC(2024, 9, 16, 12, 0)
  const seed = await request({ e2e: { action: 'seedCandles', candles: [{ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 112, low: 99, close: 108, volume: 1234, confirmed: true }] } })
  assert.equal(seed.written, 1)
  const candles = await request({ e2e: { action: 'readCandles', instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: timestamp, through: timestamp } })
  assert.deepEqual(candles.map(candle => [candle.timestamp, candle.close, candle.confirmed]), [[timestamp, 108, true]])
})

test('clipboard requests commit text and PNG pixels before acknowledging success', async () => {
  await electron.evaluate(async ({ clipboard, ClipboardItem }) => {
    // Materialize the lazy OS clipboard payloads before replacing them.
    globalThis.__savedClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))),
    )))
  })
  const readImage = () => electron.evaluate(async ({ clipboard, nativeImage }) => {
    const item = (await clipboard.read()).find(item => item.types.includes('image/png'))
    if (!item) return null
    const image = nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()))
    return { ...image.getSize(), pixels: image.toBitmap().toString('base64') }
  })
  try {
    assert.deepEqual(await request({ copyText: 'Perpetual Swap Suite E2E' }), { ok: true })
    assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), 'Perpetual Swap Suite E2E')
    const fixture = await electron.evaluate(({ nativeImage }) => {
      const image = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255]), { width: 2, height: 1 })
      return { url: image.toDataURL(), width: 2, height: 1, pixels: image.toBitmap().toString('base64') }
    })
    assert.deepEqual(await request({ copyImage: fixture.url }), { ok: true })
    assert.deepEqual(await readImage(), { width: fixture.width, height: fixture.height, pixels: fixture.pixels })
    await assert.rejects(() => request({ copyImage: 'data:image/png;base64,aW52YWxpZA==' }), /Invalid chart image/)
    assert.deepEqual(await readImage(), { width: fixture.width, height: fixture.height, pixels: fixture.pixels })
    const rect = { x: 0, y: 0, width: 80, height: 60 }
    const image = await request({ captureChart: { ...rect, output: 'png' } })
    assert.match(image.imageDataURL, /^data:image\/png;base64,/)
    assert.ok(image.width > 0 && image.height > 0)
    assert.deepEqual(await request({ captureChart: rect }), { ok: true })
    const captured = await readImage()
    assert.ok(captured)
    assert.deepEqual([captured.width, captured.height], [image.width, image.height])
  } finally {
    await electron.evaluate(async ({ clipboard }) => {
      if (globalThis.__savedClipboard.length) await clipboard.write(globalThis.__savedClipboard)
      else clipboard.clear()
      delete globalThis.__savedClipboard
    })
  }
})

test('canonical catalog rows show contract, live price, and ranking independently of chart preparation', async () => {
  const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
  assert.equal(fixture.timeframe, '1H')

  // This is the renderer's ordinary radar request.  The fixture only writes
  // source/statistics cache rows and catalog context; it never injects a
  // ready-made market row.
  const snapshot = await request({ snapshot: { sinceRevision: -1 } })
  const row = snapshot.rows.find(value => value.instId === fixture.instId)
  assert.ok(row)
  assert.ok(Number.isFinite(row.lastPrice))
  assert.equal('timeframe' in snapshot, false)
  assert.equal('listProgress' in snapshot, false)

  // Reload so React obtains the row through the same initial snapshot read as
  // an app user, then inspect the rendered table instead of the IPC object.
  await request({ preferences: { action: 'update', values: { chartTimeframe: fixture.timeframe } } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 10_000 })
  const cells = market.locator('td')
  assert.equal(await cells.count(), 3)
  assert.equal((await cells.nth(0).textContent())?.trim(), fixture.instId.replace(/-USDT-SWAP$/, ''))
  assert.equal(await cells.nth(0).getAttribute('title'), fixture.instId)
  assert.doesNotMatch((await cells.nth(1).textContent()) ?? '', /—/)
  assert.match((await cells.nth(2).textContent())?.trim() ?? '', /^(?:[+-]?\d+\.\d{2}%|—)$/)
  assert.deepEqual(await page.locator('[data-market-list] th').allTextContents(), ['Contract', 'Price', '15m change'])
  await page.locator('[data-chart-panel]').waitFor({ state: 'visible' })
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).first().waitFor({ state: 'visible' })
  assert.equal(await page.locator(`[data-chart-inst="${fixture.instId}"]`).count(), 3)
})

test('a restarted desktop restores cached catalog readings before a live scan completes', async () => {
  // Seed inside this test so it remains valid under --test-name-pattern. Then
  // recreate the entire Electron process to cover the production startup path,
  // rather than a renderer reload against an already-warm main process.
  const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
  await request({ preferences: { action: 'update', values: { chartTimeframe: fixture.timeframe } } })
  await electron.close()
  await launchElectron(true)

  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 10_000 })
  const cells = market.locator('td')
  assert.equal(await cells.count(), 3)
  assert.doesNotMatch((await cells.nth(1).textContent()) ?? '', /—/)
  const snapshot = await request({ snapshot: { sinceRevision: -1 } })
  assert.equal(snapshot.catalogSource, 'cache')
  assert.equal(snapshot.loading, true, 'The delayed production-style discovery must still be running.')
  assert.equal(await page.locator('[data-market-list]').getByText('Refreshing', { exact: true }).count(), 0, 'Background discovery must not flash a status while cached contracts are visible.')

  // Do not let the deliberately delayed discovery leak into the following
  // fixture: restore a deterministic test-mode process after this assertion.
  await electron.close()
  await launchElectron()
})

test('prepared native chart pages preserve canonical indicator values across every timeframe', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installRequestProbe(electron, fixture.instId)
  try {
    for (const timeframe of fixture.timeframes) {
      const focusId = `canonical-oracle:${timeframe}`
      await request({ chartFocus: { id: focusId, target: { instId: fixture.instId, timeframe, endHour: fixture.end } } })
      const prepared = await request({ chartWindow: { instId: fixture.instId, timeframe, endHour: fixture.end, focusId } })
      assert.notEqual(prepared.indicatorState, 'loading', 'The matching focus owns and completes canonical preparation.')
      const expected = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
      const visible = prepared.bars.filter(bar => bar.hour >= fixture.end - 95 * fixture.series[timeframe].intervalMS && bar.hour <= fixture.end)
      assert.equal(visible.length, 96)
      for (const bar of visible) {
        const oracle = expected.get(bar.hour)
        for (const field of ['open', 'high', 'low', 'close', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']) {
          assert.ok(Number.isFinite(bar[field]), `${timeframe} ${bar.hour} ${field} must be initialized.`)
          assert.ok(Math.abs(bar[field] - oracle[field]) <= Math.max(1, Math.abs(oracle[field])) * 1e-10,
            `${timeframe} ${bar.hour} ${field} changed from its canonical initialization.`)
        }
        assert.equal(bar.statisticsObserved, true)
      }
    }
    const requests = await readRequestProbe(electron)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    assert.deepEqual([...sources.historical, ...sources.historicalExtensions], [],
      'Complete durable chart periods must not be downloaded again. Bounded current-window repairs wholly beyond this fixture are independent.')
  } finally { await removeRequestProbe(electron) }
})

test('the 1600 design workspace keeps both panels and chart selection', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    for (const width of [1_600, 1_120, 1_920]) {
      await page.setViewportSize({ width, height: 1_000 })
      await page.waitForFunction(width => innerWidth === width, width)
      await assertWorkspaceLayout(page)
    }
    assert.equal(await page.getByRole('textbox', { name: 'Search contracts' }).count(), 0)
    await assertWorkspaceLayout(page)
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).waitFor({ state: 'visible' })
    assert.equal(await page.locator(`[aria-label="View ${fixture.instId} chart"]`).getAttribute('aria-selected'), 'true')
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport)
  }
})

test('paint initialization failure disconnects acquired observers and releases its owner', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await page.evaluate(() => {
    const mutation = new Set(), performance = new Set()
    const observeMutation = MutationObserver.prototype.observe, disconnectMutation = MutationObserver.prototype.disconnect
    const observePerformance = PerformanceObserver.prototype.observe, disconnectPerformance = PerformanceObserver.prototype.disconnect
    MutationObserver.prototype.observe = function (target, options) {
      const result = observeMutation.call(this, target, options)
      if (target.matches?.('[data-chart-inst]')) { mutation.add(this); throw new Error('Injected paint initialization failure.') }
      return result
    }
    MutationObserver.prototype.disconnect = function () { mutation.delete(this); return disconnectMutation.call(this) }
    PerformanceObserver.prototype.observe = function (options) {
      const result = observePerformance.call(this, options)
      if (['longtask', 'long-animation-frame'].includes(options.type)) performance.add(this)
      return result
    }
    PerformanceObserver.prototype.disconnect = function () { performance.delete(this); return disconnectPerformance.call(this) }
    window.__paintInitializationFault = {
      pending: () => mutation.size + performance.size,
      restore() {
        for (const observer of mutation) disconnectMutation.call(observer)
        for (const observer of performance) disconnectPerformance.call(observer)
        MutationObserver.prototype.observe = observeMutation; MutationObserver.prototype.disconnect = disconnectMutation
        PerformanceObserver.prototype.observe = observePerformance; PerformanceObserver.prototype.disconnect = disconnectPerformance
        delete window.__paintInitializationFault
      },
    }
  })
  try {
    await assert.rejects(startPaintProbe(page, fixture), /Injected paint initialization failure/)
    assert.equal(await page.evaluate(() => window.__paintInitializationFault.pending()), 0, 'Partially initialized capture must release every acquired observer.')
    assert.equal(await page.evaluate(() => Object.hasOwn(window, '__chartPaintProbe')), false)
  } finally { await page.evaluate(() => window.__paintInitializationFault.restore()) }
  const paint = await withPaintProbe(page, fixture, {}, () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))))
  assertCompletePaints(paint)
})

test('a failed measured paint scope retains failures and releases the next capture', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  for (const mode of ['latency', 'validation', 'finalization', 'finalization-and-cleanup']) {
    let primary
    let failure
    await assert.rejects(withPaintProbe(page, fixture, {}, async () => {
      await page.evaluate(async mode => {
        for (let frame = 0; frame < 2; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
        if (mode === 'validation') window.__chartPaintProbe.errors.push('Injected retained paint violation.')
        if (mode.startsWith('finalization')) window.__chartPaintProbe.capturePending = () => { throw new Error('Injected final capture failure.') }
        if (mode === 'finalization-and-cleanup') {
          const observer = window.__chartPaintProbe.observer, disconnect = observer.disconnect.bind(observer)
          let first = true
          observer.disconnect = () => { disconnect(); if (first) { first = false; throw new Error('Injected observer cleanup failure.') } }
        }
      }, mode)
      try { assertScrollResponsiveness({ intentLatenciesMS: [268], unaccountedInputs: [], maxFrameGapMS: 250.034 }) }
      catch (error) { primary = error; throw error }
    }), error => {
      failure = error
      assert.match(error.message, /Scroll intent exceeded 100 ms: 268 ms/)
      if (mode === 'latency') assert.equal(error.cause, primary)
      else {
        assert.ok(error.cause instanceof AggregateError)
        assert.equal(error.cause.errors[0], primary, 'The measured-phase failure must remain the primary cause.')
        assert.match(error.message, mode === 'validation' ? /Injected retained paint violation/ : /Injected final capture failure/)
        if (mode === 'finalization-and-cleanup') assert.match(error.message, /Injected observer cleanup failure/)
      }
      if (!mode.startsWith('finalization')) {
        assert.ok(error.paintPhaseData.frames > 0)
        if (mode === 'validation') assert.ok(error.paintPhaseData.violations.includes('Injected retained paint violation.'))
        else assert.deepEqual(error.paintPhaseData.violations, [])
        assert.ok(error.paintPhaseData.frameSamples.length > 0)
      } else assert.equal(error.paintPhaseData, null)
      return true
    })
    assert.equal(await page.evaluate(() => Boolean(window.__chartPaintProbe?.active)), false,
      'A failed measured phase or final capture must leave no active RAF/observer owner.')
    assert.equal(await page.evaluate(() => Object.hasOwn(window, '__chartPaintProbe')), false,
      'A stopped failed capture must release its retained bars and SVG evidence.')
    const retained = JSON.stringify(failure.paintPhaseData)
    const next = await withPaintProbe(page, fixture, {}, () => page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
    }))
    assertCompletePaints(next)
    assert.equal(JSON.stringify(failure.paintPhaseData), retained, 'The next capture must not overwrite the failed phase evidence.')
  }
})

test('the paint probe accepts an unchanged complete frame after deferred validation', async context => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  let report
  try {
    assert.equal(await page.evaluate(() => Object.values(window.__chartPaintProbe.series).some(entry => 'bars' in entry)), false,
      'Oracle bar archives must stay outside the renderer during input and RAF capture.')
    await page.evaluate(async () => { for (let frame = 0; frame < 3; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    report = await finishPaintProbe(page)
    assertCompletePaints(report)
    assert.equal(report.deferredValidationSamples, report.probeCaptureSamples)
    assert.equal(report.quality.length, report.commits.length)
    assert.equal(report.oracleTransfer.phase, 'after capture stopped')
    assert.equal(report.oracleTransfer.fixtureBars, Object.values(fixture.series).reduce((sum, entry) => sum + entry.bars.length, 0))
    assert.ok(report.oracleTransfer.transferredBars > 0 && report.oracleTransfer.transferredBars <= 192)
    assert.ok(report.oracleTransfer.transferredBars < report.oracleTransfer.fixtureBars)
    context.diagnostic(`Deferred oracle transfer: ${JSON.stringify(report.oracleTransfer)}`)
    assert.equal(report.rendererCPU.sampleCount, report.frames + 2, 'Every captured RAF needs a CPU witness between the start and stop markers.')
    context.diagnostic(`Renderer CPU capture: ${JSON.stringify({ samples: report.rendererCPU.sampleCount, markerCostMS: report.cpuMarkerCostMS })}`)
  } finally { if (!report) await finishPaintProbe(page) }
})

test('the paint probe selects the first ready target RAF and retains its mutable data', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await page.waitForFunction(instId => {
    const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), bars = chart?.__chartRenderedBars ?? chart?.__chartSnapshot?.bars
    const fields = ['bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
    return bars?.length >= 96 && bars.length <= 98 && bars.every(bar => bar.indicatorsObserved && fields.every(field => Number.isFinite(bar[field])))
  }, fixture.instId)
  await startPaintProbe(page, fixture, { indicatorValidation: 'deferred-canonical' })
  let report
  try {
    const sample = await page.evaluate(async instId => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), probe = window.__chartPaintProbe
      const originalSnapshot = chart.__chartSnapshot, originalBars = chart.__chartRenderedBars
      const bars = (originalBars ?? originalSnapshot.bars).map(bar => ({ ...bar }))
      const snapshot = { ...originalSnapshot, bars, priceState: 'ready', indicatorState: 'loading', priceStatus: { ...originalSnapshot.priceStatus } }
      const expectedClose = bars[0].close, expectedEMA = bars[0].ema, expectedStatus = snapshot.priceStatus.state
      const afterAt = performance.now()
      try {
        bars[0].ema = null; bars[0].indicatorsObserved = false
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: snapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: bars })
        chart.setAttribute('data-probe-paint-marker', 'not ready')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const incompleteRAF = probe.observations.find(observation => observation.frame && observation.at >= afterAt && observation.bars?.[0].ema === null)
        bars[0].ema = expectedEMA; bars[0].indicatorsObserved = true
        const priceComplete = bars[0].priceComplete
        bars[0].priceComplete = false
        chart.setAttribute('data-probe-paint-marker', 'incomplete price')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const incompletePriceRAF = probe.observations.find(observation => observation.frame && observation.at >= afterAt && observation.bars?.[0].priceComplete === false)
        bars[0].priceComplete = priceComplete
        chart.setAttribute('data-probe-paint-marker', 'ready')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const readyRAF = probe.observations.find(observation => observation.frame && observation.at >= afterAt && observation.bars?.[0].ema === expectedEMA && observation.bars[0].priceComplete !== false)
        bars[0].close += 100; snapshot.indicatorState = 'ready'; snapshot.priceStatus.state = 'error'
        chart.setAttribute('data-probe-paint-marker', 'mutated after ready')
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return { afterAt, incompleteAt: incompleteRAF?.at, incompletePriceAt: incompletePriceRAF?.at, readyAt: readyRAF?.at, expectedClose, expectedEMA, expectedStatus,
          observationsHaveEntryAndFrame: probe.observations.every(observation => Number.isFinite(observation.at) && typeof observation.frame === 'boolean') }
      } finally {
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: originalSnapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: originalBars })
        chart.removeAttribute('data-probe-paint-marker')
        await Promise.resolve()
      }
    }, fixture.instId)
    report = await finishPaintProbe(page, { readyTarget: { instId: fixture.instId, timeframe: fixture.timeframe,
      endHour: fixture.end, intervalMS: fixture.intervalMS, afterAt: sample.afterAt }, includeRequestCommits: true, includeTimingEvidence: true })
    assert.equal(sample.observationsHaveEntryAndFrame, true)
    assert.ok(Number.isFinite(sample.incompleteAt) && sample.readyAt > sample.incompleteAt)
    assert.ok(Number.isFinite(sample.incompletePriceAt) && sample.readyAt > sample.incompletePriceAt)
    assert.equal(report.readyFrame.at, sample.readyAt, 'An earlier incomplete RAF must not be selected.')
    assert.equal(report.readyFrame.frame, true)
    assert.equal(report.readyFrame.bars[0].close, sample.expectedClose, 'Later mutation must not alter the selected ready bars.')
    assert.equal(report.readyFrame.bars[0].ema, sample.expectedEMA)
    assert.equal(report.readyFrame.snapshot.indicatorState, 'loading', 'Complete observed values determine readiness even before aggregate status catches up.')
    assert.equal(report.readyFrame.snapshot.priceStatus.state, sample.expectedStatus, 'Later mutation must not alter the selected snapshot.')
    assert.ok(report.requestCommits.some(commit => commit.instId === fixture.instId && commit.timeframe === fixture.timeframe
      && commit.end === fixture.end && Number.isFinite(commit.rafSampledAt)))
    assert.equal(report.captureTimings.length, report.probeCaptureSamples)
    assert.ok(report.captureTimings.every(sample => Number.isFinite(sample.at) && Number.isFinite(sample.durationMS)))
  } finally { if (!report) await finishPaintProbe(page) }
})

test('DOM capture retains shared SVG evidence when curves, clips and bars change', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  let report
  try {
    const evidence = await page.evaluate(async instId => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), probe = window.__chartPaintProbe
      const svg = chart.querySelector('svg[data-rendered-inst]'), path = svg.querySelector('[data-chart-boll-band]')
      const clipOwner = svg.querySelector('[data-chart-wheel-content]').parentElement
      const reference = clipOwner.getAttribute('clip-path')
      const clipId = reference.slice(reference.indexOf('#') + 1, reference.indexOf(')'))
      const clip = svg.querySelector(`[id="${CSS.escape(clipId)}"] rect`)
      const pathValue = path.getAttribute('d'), clipValue = clip.getAttribute('width')
      const originalSnapshot = chart.__chartSnapshot, originalBars = chart.__chartRenderedBars
      const bars = (originalBars ?? originalSnapshot.bars).map(bar => ({ ...bar }))
      const snapshot = { ...originalSnapshot, bars }
      let sharedSVG = false, changedBarsSameSVG = false, invalidEvidence
      try {
        probe.phase = 'first invalid curve'
        path.setAttribute('d', 'M0,0 L1,1 L1,2 L0,2 Z')
        await Promise.resolve()
        const invalidSVG = probe.observations.at(-1).surface.svg
        invalidEvidence = invalidSVG
        await new Promise(resolve => requestAnimationFrame(resolve))
        probe.phase = 'repeated invalid curve'
        await new Promise(resolve => requestAnimationFrame(resolve))
        sharedSVG = probe.observations.at(-1).surface.svg === invalidSVG
        probe.phase = 'changed clip'
        clip.setAttribute('width', '0')
        await Promise.resolve()
        await new Promise(resolve => requestAnimationFrame(resolve))
        probe.phase = 'no clip'
        clipOwner.setAttribute('clip-path', 'none')
        await Promise.resolve()
        await new Promise(resolve => requestAnimationFrame(resolve))
        clipOwner.setAttribute('clip-path', reference); clip.setAttribute('width', clipValue); path.setAttribute('d', pathValue)
        await Promise.resolve()
        const restoredSVG = probe.observations.at(-1).surface.svg
        bars[0].bollUpper = null
        probe.phase = 'changed bars'
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: snapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: bars })
        chart.setAttribute('data-probe-paint-marker', 'changed bars')
        await Promise.resolve()
        changedBarsSameSVG = probe.observations.at(-1).surface.svg === restoredSVG
        await new Promise(resolve => requestAnimationFrame(resolve))
      } finally {
        path.setAttribute('d', pathValue); clip.setAttribute('width', clipValue); clipOwner.setAttribute('clip-path', reference)
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: originalSnapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: originalBars })
        chart.removeAttribute('data-probe-paint-marker')
        await Promise.resolve()
      }
      // Keep the DOM-to-evidence boundary here; the numerical/error matrix
      // runs against these record fields in chart-paint-validation.test.mjs.
      const mappings = [
        [svg, 'data-rendered-start', 'svg', 'start'], [svg, 'data-rendered-timeframe', 'svg', 'timeframe'],
        [svg, 'aria-label', 'svg', 'label'], [chart, 'data-chart-rendered-bars', 'chart', 'renderedBars'],
        [chart, 'data-chart-completed-end', 'chart', 'completedEnd'], [chart, 'data-chart-candle-state', 'chart', 'candleState'],
        [chart, 'data-chart-oi-samples', 'chart', 'oiSamples'],
        [chart, 'data-chart-indicator-input', 'chart', 'indicatorInput'],
      ]
      const mappingFailures = []
      for (const [node, attribute, owner, field] of mappings) {
        const original = node.getAttribute(attribute)
        try {
          node.setAttribute(attribute, 'probe-invalid')
          await Promise.resolve()
          if (probe.observations.at(-1).surface[owner][field] !== 'probe-invalid') mappingFailures.push(attribute)
          if (chart.__chartSnapshot !== originalSnapshot) mappingFailures.push('Snapshot changed during DOM-only capture.')
        } finally {
          if (original === null) node.removeAttribute(attribute)
          else node.setAttribute(attribute, original)
          await Promise.resolve()
        }
      }
      return { sharedSVG, changedBarsSameSVG, mappingFailures, observations: probe.observations.length, errorsBeforeFinish: probe.errors.length,
        retainedCorruption: probe.observations.some(observation => observation.surface.svg === invalidEvidence && observation.surface.svg.curves.some(curve => curve.includes('M0 0 L1 1'))) }
    }, fixture.instId)
    report = await finishPaintProbe(page)
    assert.equal(evidence.sharedSVG, true, 'Repeated RAFs must use the same captured SVG record.')
    assert.equal(evidence.changedBarsSameSVG, true, 'Changing bar evidence must not require a new SVG record.')
    assert.equal(evidence.retainedCorruption, true, 'Repairing a DOM path must preserve its captured corruption.')
    assert.deepEqual(evidence.mappingFailures, [], 'DOM-only metadata changes must reach captured evidence without a new snapshot.')
    assert.equal(evidence.errorsBeforeFinish, 0, 'Geometry validation must wait until capture stops.')
    for (const phase of ['first invalid curve', 'repeated invalid curve', 'changed clip', 'no clip', 'changed bars']) {
      assert.ok(report.violations.some(error => error.startsWith(`${phase}:`) && / SVG has /.test(error)), phase)
    }
    assert.ok(report.deferredValidationSamples >= evidence.observations)
    assert.equal(report.deferredValidationSamples + report.failedCaptureSamples, report.probeCaptureSamples)
  } finally { if (!report) await finishPaintProbe(page) }
})

test('the paint probe validates mutable wrong and incomplete bars after they are restored', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  let report
  try {
    const observation = await page.evaluate(async instId => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), probe = window.__chartPaintProbe
      const originalSnapshot = chart.__chartSnapshot, originalBars = chart.__chartRenderedBars
      const bars = (originalBars ?? originalSnapshot.bars).map(bar => ({ ...bar }))
      const index = bars.findIndex(bar => bar.confirmed)
      if (index < 0) throw new Error('The fixture needs a confirmed candle.')
      const originalClose = bars[index].close, hour = bars[index].hour, removed = bars.splice(95)
      bars[index].close += Math.max(1, Math.abs(originalClose)) * .01
      const snapshot = { ...originalSnapshot, bars, priceStatus: { state: 'ready', from: 1, through: 2 } }
      try {
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: snapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: bars })
        chart.setAttribute('data-probe-paint-marker', 'wrong and incomplete')
        await Promise.resolve()
        const bad = probe.observations.at(-1), wrongClose = bars[index].close
        await new Promise(resolve => requestAnimationFrame(resolve))
        const sharedBars = probe.observations.at(-1).bars === bad.bars
        snapshot.oiState = 'loading'
        snapshot.priceStatus.state = 'error'
        chart.setAttribute('data-probe-paint-marker', 'changed mutable snapshot')
        await Promise.resolve()
        const changed = probe.observations.at(-1)
        snapshot.oiState = originalSnapshot.oiState
        snapshot.priceStatus.state = 'ready'
        bars[index].close = originalClose
        bars.push(...removed)
        chart.setAttribute('data-probe-paint-marker', 'restored in place')
        await Promise.resolve()
        return { hour, wrongClose, retainedClose: bad.bars[index].close, retainedLength: bad.bars.length, sharedBars,
          retainedOldStatus: bad.snapshot.priceStatus.state, retainedChangedStatus: changed.snapshot.priceStatus.state, retainedChangedOI: changed.snapshot.oiState,
          sameMutableSnapshot: chart.__chartSnapshot === snapshot, errorsBeforeFinish: probe.errors.length }
      } finally {
        Object.defineProperty(chart, '__chartSnapshot', { configurable: true, value: originalSnapshot })
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: originalBars })
        chart.removeAttribute('data-probe-paint-marker')
        await Promise.resolve()
      }
    }, fixture.instId)
    report = await finishPaintProbe(page)
    assert.equal(observation.sameMutableSnapshot, true)
    assert.equal(observation.sharedBars, true)
    assert.equal(observation.retainedClose, observation.wrongClose, 'A mutable bar must retain its captured value after restoration.')
    assert.equal(observation.retainedLength, 95, 'A mutable array must retain its captured length after restoration.')
    assert.equal(observation.retainedOldStatus, 'ready')
    assert.equal(observation.retainedChangedStatus, 'error')
    assert.equal(observation.retainedChangedOI, 'loading')
    assert.equal(observation.errorsBeforeFinish, 0)
    assert.equal(report.minimumBars, 95)
    assert.ok(report.violations.some(error => /Rendered 95 bars for/.test(error)))
    assert.ok(report.violations.some(error => error.includes(`${observation.hour} close: expected`) && error.includes(`got ${observation.wrongClose}`)))
    assert.ok(report.violations.includes('Published source states disagree with the snapshot.'))
    assert.equal(report.deferredValidationSamples, report.probeCaptureSamples)
  } finally { if (!report) await finishPaintProbe(page) }
})

test('the paint probe reports capture failures without dropping observations', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  let report
  try {
    const capturedFailure = await page.evaluate(async instId => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), probe = window.__chartPaintProbe
      const descriptor = Object.getOwnPropertyDescriptor(chart, '__chartRenderedBars')
      const bars = [...(chart.__chartRenderedBars ?? chart.__chartSnapshot.bars)]
      const broken = { ...bars[0] }
      Object.defineProperty(broken, 'close', { enumerable: true, get() { throw new Error('synthetic capture failure') } })
      bars[0] = broken
      try {
        Object.defineProperty(chart, '__chartRenderedBars', { configurable: true, value: bars })
        chart.setAttribute('data-probe-paint-marker', 'capture failure')
        await Promise.resolve()
        return probe.observations.at(-1).captureFailure === true
      } finally {
        if (descriptor) Object.defineProperty(chart, '__chartRenderedBars', descriptor)
        else delete chart.__chartRenderedBars
        chart.removeAttribute('data-probe-paint-marker')
        await Promise.resolve()
      }
    }, fixture.instId)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    report = await finishPaintProbe(page)
    assert.equal(capturedFailure, true)
    assert.ok(report.violations.some(error => error.includes('Paint capture failed: synthetic capture failure')))
    assert.ok(report.failedCaptureSamples > 0)
    assert.equal(report.deferredValidationSamples + report.failedCaptureSamples, report.probeCaptureSamples)
    assert.ok(report.frames > 0, 'Capture failure must not stop subsequent frame accounting.')
  } finally { if (!report) await finishPaintProbe(page) }
})

test('prepared resident indicators and statistics stay drawn through rapid scrolling, latest pushes and reversal', async context => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  // Verify the fixture is stable under the production 5m-to-parent derivation.
  // Otherwise a routine aggregation write can invalidate indicators mid-test.
  for (const frame of ['15m', '1H']) {
    const interval = fixture.series[frame].intervalMS
    const hour = fixture.end - 2 * interval
    const parent = fixture.series[frame].bars.find(bar => bar.hour === hour)
    const children = fixture.series['5m'].bars.filter(bar => bar.hour >= hour && bar.hour < hour + interval)
    assert.equal(children.length, interval / fixture.series['5m'].intervalMS)
    assert.deepEqual([parent.open, parent.high, parent.low, parent.close],
      [children[0].open, Math.max(...children.map(bar => bar.high)), Math.min(...children.map(bar => bar.low)), children.at(-1).close])
  }
  const indicatorFields = ['ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
  await installRequestProbe(electron, fixture.instId)
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      // The lower panels occupy half the workspace width. Recalibrate the
      // selected panel after switching, while preserving the 96-slot workload
      // used by the paint probe and the resident-history performance checks.
      for (let attempt = 0; attempt < 12; attempt++) {
        const { span, spacing, scale } = await page.locator('[data-acceptance-target] [data-chart-inst]').evaluate(chart => ({
          span: Number(chart.dataset.chartVisibleBars), spacing: Number(chart.dataset.chartBarSpacing),
          scale: Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale),
        }))
        if (Math.abs(span - 96.5) <= .05) break
        const viewport = page.viewportSize()
        await page.setViewportSize({ ...viewport, width: Math.round(viewport.width + (96.5 - span) * spacing * scale * (timeframe === '1H' ? 1 : 2)) })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      }
      // Other periods may end after this panel's newest confirmed candle. The
      // shared live edge therefore leaves legitimate empty future slots in a
      // shorter-period panel. Warm and measure a complete historical viewport.
      await wheelBurst(page, { deltaY: -100_000 })
      await page.waitForFunction(end => Number(document.querySelector('[data-acceptance-target] [data-chart-inst]')?.dataset.chartTimeEnd) > end, fixture.end)
      const resident = await waitForLocalHistory(electron, page, fixture, timeframe, { requireIndicators: true, stayHistorical: true })
      const intervalMS = fixture.series[timeframe].intervalMS
      const baselineEnd = fixture.end - intervalMS
      await waitForRendered(page, fixture, timeframe, baselineEnd)
      // Establish a complete canonical starting frame. The regression concerns
      // losing mature data during navigation, not first-time indicator seeding.
      await page.waitForFunction(({ timeframe, fields }) => {
        const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]'), snapshot = chart?.__chartSnapshot
        const bars = chart?.__chartRenderedBars ?? snapshot?.bars
        return snapshot?.timeframe === timeframe && bars?.length >= 96 && bars.length <= 98
          && bars.every(bar => [...fields, 'oi', 'buy', 'sell'].every(field => Number.isFinite(bar[field])))
      }, { timeframe, fields: indicatorFields }, { timeout: 20_000 })
      await assertCompleteChartViewport(page, fixture.instId, { endHour: baselineEnd })
      assert.ok(resident >= 96 + 972, 'Every measured target must lie inside the fully calculated resident reserve.')
      await waitForRendered(page, fixture, timeframe, baselineEnd)
      await startPaintProbe(page, fixture, { requireMatureData: true })
      const phase = value => page.evaluate(value => { window.__chartPaintProbe.phase = value }, value)
      const settle = () => page.evaluate(async () => { for (let frame = 0; frame < 12; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
      const pitch = Number(await page.locator('[data-acceptance-target] [data-chart-inst]').getAttribute('data-chart-bar-spacing'))
      await phase('first resident wheel frame')
      await wheelBurst(page, { deltaY: 300 * pitch })
      await waitForRendered(page, fixture, timeframe, baselineEnd - 300 * intervalMS)
      await phase('continuous resident scrolling')
      await wheelBurst(page, { frames: 6, eventsPerFrame: 32, deltaY: 3 * pitch })
      await waitForRendered(page, fixture, timeframe, baselineEnd - 876 * intervalMS)
      await wheelBurst(page, { deltaY: 96 * pitch })
      const historicalEnd = baselineEnd - 972 * intervalMS
      await waitForRendered(page, fixture, timeframe, historicalEnd)
      await phase('scroll end and asynchronous completions')
      await settle()
      await phase('ordinary latest push while viewing history')
      // Forward an actual backend local frame through the ordinary event
      // ingress. Its contents are unchanged; only delivery timing is controlled.
      await electron.evaluate(async ({ BrowserWindow }, { instId, timeframe }) => {
        const { encodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
        const frame = await globalThis.__marketBackend.request({ chartLocal: { instId, timeframe } })
        if (!frame) throw new Error('The active backend must retain its latest local frame.')
        BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', encodeChartWire(frame))
      }, { instId: fixture.instId, timeframe })
      await settle()
      assert.equal(Number(await page.locator('[data-acceptance-target] [data-chart-inst]').getAttribute('data-chart-completed-end')), historicalEnd, 'A latest publication must preserve the historical viewport.')
      await phase('reverse to the baseline and stop')
      await wheelBurst(page, { deltaY: -972 * pitch })
      await waitForRendered(page, fixture, timeframe, baselineEnd)
      await settle()
      const paint = await finishPaintProbe(page)
      const incomplete = paint.quality.filter(frame => frame.indicators !== frame.bars || frame.oi !== frame.bars || frame.taker !== frame.bars)
      if (incomplete.length) context.diagnostic(`Incomplete local paints: ${JSON.stringify({ timeframe, frames: incomplete })}`)
      assertCompletePaints(paint)
      assert.ok(paint.commits.some(commit => commit.end === historicalEnd), 'The probe must inspect the deep historical viewport.')
      assert.equal(incomplete.length, 0,
        `${timeframe} lost a mature indicator or source panel during navigation: ${JSON.stringify(paint.quality)}`)
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

for (const mode of ['gap', 'prepend']) test(`first historical acquisition preserves requested prices and source panels while ${mode === 'gap' ? 'later gaps fill' : 'an earlier prefix rebuilds exact indicators'}`, async context => {
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  const fixture = await probe({ action: 'acquisitionInstall', timeframe: '15m', mode })
  const fields = ['bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
  let desired
  const settle = () => page.evaluate(async () => { for (let frame = 0; frame < 8; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
  try {
    await openChart(page, fixture)
    await wheelBurst(page, { deltaY: (fixture.end - fixture.targetEnd) / fixture.intervalMS * 12 })
    // At this point the requested historical period has never existed locally.
    // Acquire it through real native source-page writers, independently of the
    // latest quote tail, then observe every later page after curves first appear.
    await probe({ action: 'acquisitionStep', source: 'prefix' })
    await waitForRendered(page, fixture, fixture.timeframe, fixture.targetEnd)
    await page.waitForFunction(({ targetEnd, fields }) => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]'), snapshot = chart?.__chartSnapshot
      const bars = chart?.__chartRenderedBars ?? snapshot?.bars
      return snapshot?.endHour === targetEnd && bars?.length >= 96 && bars.length <= 98
        && bars.every(bar => fields.every(field => Number.isFinite(bar[field])))
    }, { targetEnd: fixture.targetEnd, fields }, { timeout: 20_000 })
    const viewport = await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.targetEnd })
    const canonical = new Map(fixture.series[fixture.timeframe].bars.map(bar => [bar.hour, bar]))
    desired = viewport.expectedHours.map(hour => canonical.get(hour))
    assert.ok(desired.every(Boolean), 'The acquired viewport must be covered by canonical source candles.')
    const firstEMA = await page.evaluate(() => document.querySelector('[data-acceptance-target] [data-chart-inst]').__chartSnapshot.bars.at(-1).ema)
    if (mode === 'prepend') assert.ok(Math.abs(firstEMA - desired.at(-1).ema) > 1e-6,
      'The absent earlier prefix must actually change the recursive result, so retaining a stale curve cannot pass this test.')
    await startPaintProbe(page, fixture, { requireMatureData: mode === 'gap', indicatorValidation: mode === 'gap' ? 'fixture' : 'finite' })
    const sourceCounts = { candles: 0, oi: 0, taker: 0 }
    const pageCounts = { candles: 0, oi: 0, taker: 0 }
    const complete = new Set()
    while (complete.size < 3) {
      for (const source of ['candles', 'oi', 'taker']) if (!complete.has(source)) {
        await page.evaluate(phase => { window.__chartPaintProbe.phase = phase }, `${mode}: native ${source} page ${pageCounts[source] + 1}`)
        const response = await probe({ action: 'acquisitionStep', source })
        pageCounts[source] += 1
        sourceCounts[source] += response.count
        if (response.done) complete.add(source)
        await settle()
      }
    }
    // A changed prefix invalidates recursive curves until exact replacements
    // arrive. Prices keep the selected cursor and independent statistics stay.
    await page.waitForFunction(({ desired, fields }) => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]'), bars = chart?.__chartRenderedBars ?? chart?.__chartSnapshot?.bars
      return bars?.length === desired.length && bars.every((bar, index) => bar.hour === desired[index].hour
        && fields.every(field => Number.isFinite(bar[field]) && Math.abs(bar[field] - desired[index][field]) <= Math.max(1, Math.abs(desired[index][field])) * 1e-10))
    }, { desired, fields }, { timeout: 20_000 })
    await settle()
    const paint = await finishPaintProbe(page)
    context.diagnostic(`First acquisition ${mode}: ${JSON.stringify({ sourceCounts, paints: paint.paints, quality: paint.quality })}`)
    assertCompletePaints(paint)
    assert.ok(paint.quality.every(frame => frame.oi === frame.bars && frame.taker === frame.bars && (mode === 'prepend' || frame.indicators === frame.bars)),
      'Independent statistics and unchanged indicator inputs must remain available while a changed recursive prefix rebuilds.')
    assert.ok(paint.commits.every(commit => commit.end === fixture.targetEnd), 'Canonical page writes must not cancel or replace the requested wheel cursor.')
  } finally {
    await page.evaluate(() => { const probe = window.__chartPaintProbe; if (probe) { probe.active = false; cancelAnimationFrame(probe.raf); probe.observer.disconnect(); delete window.__chartPaintProbe } })
  }
})

test('a held old history read leaves backend demand and the latest wheel target independent with two bounded read lanes', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
    await openChart(page, fixture)
    await startPaintProbe(page, fixture)
    await wheelBurst(page, { deltaY: 14_400 })
    await waitFor(async () => (await readRequestProbe(electron)).held)
    const initial = await readRequestProbe(electron)
    assert.equal(initial.heldCall.kind, 'history')
    assert.equal(initial.heldCall.endHour, fixture.end - 1_200 * fixture.intervalMS)
    assert.ok(initial.heldCall.readCompletedAt !== null, 'A real detached durable reply must exist before delivery is held.')
    const forward = await wheelBurst(page, { frames: 4, eventsPerFrame: 32, deltaY: 12 })
    await wheelBurst(page, { frames: 2, eventsPerFrame: 32, deltaY: -12 })
    const expectedEnd = fixture.end - 1_264 * fixture.intervalMS
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    const held = await readRequestProbe(electron)
    assert.equal(held.heldSettled, false, 'The new target must finish while the old disk response remains held.')
    assert.ok(held.maxHistoricalActive <= 2, 'Wheel input must keep history reads inside the two available lanes.')
    assert.ok(held.maxLocalActive <= 2)
    assert.equal(held.legacyWindowCalls, 0, 'The renderer must express demand separately from pure chart reads.')
    assert.equal(held.focusCalls.findLast(call => call.target)?.target.endHour, expectedEnd, 'Held disk delivery cannot block or replace backend viewport demand.')
    assert.ok(held.calls.filter(call => call.kind === 'history').length <= 2 * (forward.length + 3), 'Wheel bursts must coalesce rather than create one read per raw event.')
    const beforeRelease = await page.evaluate(() => window.__chartPaintProbe.commits.length)
    await releaseRequestProbe(electron)
    await waitFor(async () => (await readRequestProbe(electron)).heldSettled)
    await page.evaluate(async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    const report = await finishPaintProbe(page)
    assertCompletePaints(report)
    assert.equal(report.commits.at(-1).end, expectedEnd)
    assert.ok(report.commits.slice(beforeRelease).every(commit => commit.end === expectedEnd && commit.timeframe === fixture.timeframe), 'Late disk data must not repaint an obsolete cursor.')
    const requests = await readRequestProbe(electron)
    assert.ok(requests.maxHistoricalActive <= 2)
    assert.deepEqual(separateSourceMaintenance(requests.sourceRequests, fixture).historical, [], 'Scrolling must reuse durable history independently of bounded current-window maintenance.')
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('the live price overlay follows its actual price without changing the completed candle viewport', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const visible = fixture.series[fixture.timeframe].bars.slice(-96)
  const prices = visible.flatMap(bar => ['low', 'high', 'ema', 'bollUpper', 'bollMiddle', 'bollLower'].map(field => bar[field]))
  // The arithmetic midpoint maps to the midpoint of the linear relative scale.
  const livePrice = (Math.min(...prices) + Math.max(...prices)) / 2
  await installPreparedTransform({ mode: 'live', instId: fixture.instId, livePrice })
  try {
    await openChart(page, fixture, fixture.timeframe, { liveOverlay: true })
    // This case measures the live overlay over a prepared adjacent window.
    // First acquisition may legitimately present its known prices while the
    // missing leading candle loads; cold acquisition is tested separately.
    // Shared time navigation uses the actual pixel pitch and can include a
    // forming candle beyond the completed end. Scroll far enough to leave the
    // live window rather than assuming 12 pixels is exactly one candle.
    const scrollPixels = 4 * Number(await page.locator('[data-acceptance-target] [data-chart-inst]').getAttribute('data-chart-bar-spacing'))
    await wheelBurst(page, { deltaY: scrollPixels })
    const historicalEnd = await (await page.waitForFunction(end => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]')
      const requested = Number(chart?.getAttribute('data-chart-requested-end'))
      return requested && requested < end ? requested : false
    }, fixture.end)).jsonValue()
    await waitForRendered(page, fixture, fixture.timeframe, historicalEnd)
    await page.waitForFunction(({ end, intervalMS }) => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]'), bars = chart?.__chartRenderedBars ?? chart?.__chartSnapshot?.bars
      return bars?.length >= 96 && bars.every((bar, index) =>
        bar.confirmed && bar.hour === end - (bars.length - 1 - index) * intervalMS)
    }, { end: historicalEnd, intervalMS: fixture.intervalMS })
    await assertCompleteChartViewport(page, fixture.instId, { endHour: historicalEnd })
    await wheelBurst(page, { deltaY: -2 * scrollPixels })
    await waitForRendered(page, fixture)
    await page.waitForFunction(() => Boolean(document.querySelector('[data-acceptance-target] [data-chart-inst]')?.__chartSnapshot?.liveBar))
    await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.end, availableThrough: fixture.end + fixture.intervalMS })
    await startPaintProbe(page, fixture)
    const overlay = await page.evaluate(() => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst]')
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      const line = svg.querySelector('[data-chart-live-price]')
      const label = svg.querySelector('[data-chart-price-label-value]')
      const ticks = [...svg.querySelectorAll('[data-chart-price-tick] text')]
      const tick = ticks[0]
      const countdown = svg.querySelector('[data-chart-countdown]')
      const labelBounds = label.getBBox()
      return {
        bars: snapshot.bars.length, allConfirmed: snapshot.bars.every(bar => bar.confirmed),
        liveConfirmed: snapshot.liveBar?.confirmed, liveHour: snapshot.liveBar?.hour,
        lineY: Number(line?.getAttribute('y1')),
        lineCount: svg.querySelectorAll('[data-chart-live-price]').length,
        outlineCount: svg.querySelectorAll('[data-chart-live-price-outline]').length,
        lineDash: line?.getAttribute('stroke-dasharray'),
        lineStroke: line?.getAttribute('stroke'),
        expectedStroke: snapshot.liveBar.close >= snapshot.liveBar.open ? 'var(--positive)' : 'var(--negative)',
        expectedY: (() => { const a = ticks[0], b = ticks.at(-1); const av = parseFloat(a.textContent.replaceAll(',', '')), bv = parseFloat(b.textContent.replaceAll(',', '')); const right = Number(svg.dataset.chartPlotRight), width = Number(svg.dataset.chartBarWidth), end = Number(svg.dataset.chartDomainEnd), pitch = Number(chart.dataset.chartBarSpacing), offset = Number(svg.querySelector('[data-chart-wheel-content]')?.dataset.chartWheelOffset ?? 0); const base = snapshot.bars.find(bar => right - width / 2 + (bar.hour - end) / snapshot.intervalMS * pitch + offset + width / 2 > 0).open; const value = (snapshot.liveBar.close / base - 1) * 100; return Number(a.getAttribute('y')) + (value - av) / (bv - av) * (Number(b.getAttribute('y')) - Number(a.getAttribute('y'))) })(),
        countdown: countdown?.textContent,
        labelX: Number(label.getAttribute('x')), tickX: Number(tick.getAttribute('x')),
        labelY: Number(label.getAttribute('y')),
        backgroundX: Number(svg.querySelector('[data-chart-price-label-background]').getAttribute('x')),
        lineEndX: Number(line.getAttribute('x2')),
        labelBounds: [labelBounds.x, labelBounds.x + labelBounds.width], svgWidth: svg.viewBox.baseVal.width,
        labelFont: getComputedStyle(label).fontSize, tickFont: getComputedStyle(tick).fontSize,
        countdownFont: countdown ? getComputedStyle(countdown).fontSize : null,
        countdownY: Number(countdown?.getAttribute('y')),
        countdownFill: countdown ? getComputedStyle(countdown).fill : null, tickFill: getComputedStyle(tick).fill,
        labelFill: getComputedStyle(label).fill,
      }
    })
    assert.ok(overlay.bars >= 96)
    assert.equal(overlay.allConfirmed, true)
    assert.equal(overlay.liveConfirmed, false)
    assert.equal(overlay.liveHour, fixture.end + fixture.intervalMS)
    assert.equal(overlay.lineCount, 1, 'The latest price uses one line.')
    assert.equal(overlay.outlineCount, 0, 'The price line must not have a contrasting solid line behind it.')
    assert.equal(overlay.lineDash, '4 5')
    assert.equal(overlay.lineStroke, overlay.expectedStroke, 'The price line uses the candle direction color.')
    assert.ok(Math.abs(overlay.lineY - overlay.expectedY) < 2, `The live price line must use its relative price coordinate: ${JSON.stringify(overlay)}`)
    assert.match(overlay.countdown ?? '', /^\d{2}:\d{2}$/)
    assert.equal(overlay.labelX, overlay.tickX, 'The price value must share the axis tick alignment.')
    assert.equal(overlay.labelY, overlay.lineY, 'Countdown placement must not shift the price anchor.')
    assert.equal(overlay.backgroundX, overlay.lineEndX, 'The price highlight must meet the plot axis.')
    assert.ok(overlay.labelBounds[0] >= 0 && overlay.labelBounds[1] <= overlay.svgWidth, 'The complete price value must fit inside the SVG.')
    assert.equal(overlay.labelFont, overlay.tickFont)
    assert.equal(overlay.countdownFont, overlay.labelFont, 'Price and countdown must use the same font size.')
    assert.ok(Math.abs(Math.abs(overlay.countdownY - overlay.labelY) - parseFloat(overlay.labelFont)) < 1e-6, 'The two lines must use single line spacing.')
    assert.equal(overlay.countdownFill, overlay.labelFill, 'The countdown and price must use the same high-contrast foreground on the colored background.')
    await wheelBurst(page, { deltaY: scrollPixels })
    await waitForRendered(page, fixture, fixture.timeframe, historicalEnd)
    assert.equal(await page.locator('[data-acceptance-target] svg[data-rendered-inst] [data-chart-countdown]').count(), 0, 'Historical charts must not display a live countdown.')
    assert.equal(await page.evaluate(() => document.querySelector('[data-acceptance-target] [data-chart-inst]').__chartSnapshot.liveBar), undefined)
    const report = await finishPaintProbe(page)
    assert.ok(report.frames > 0 && report.paints > 0)
    assert.ok(report.minimumBars >= 96)
    assert.deepEqual(report.violations, [])
  } finally {
    await removePreparedTransform()
  }
})

test('relative price curves remain accurate during fractional scrolling in both directions', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  const pitch = Number(await page.locator('[data-acceptance-target] [data-chart-inst]').getAttribute('data-chart-bar-spacing'))
  await wheelBurst(page, { deltaY: 10 * pitch })
  await waitForRendered(page, fixture, fixture.timeframe, fixture.end - 10 * fixture.intervalMS)
  await startPaintProbe(page, fixture)
  // Shared-time navigation projects fractional motion into the plot geometry,
  // not the legacy wheel-content translation. Measure the displayed edge.
  const readEdge = () => page.evaluate(() => Number(document.querySelector('[data-acceptance-target] [data-chart-inst]')?.dataset.chartTimeEnd))
  const baseline = await readEdge()
  await wheelBurst(page, { deltaY: 6 })
  await page.waitForFunction(previous => Number(document.querySelector('[data-acceptance-target] [data-chart-inst]')?.dataset.chartTimeEnd) < previous, baseline)
  const backward = await readEdge()
  await wheelBurst(page, { deltaY: -3 })
  await page.waitForFunction(previous => {
    const edge = Number(document.querySelector('[data-acceptance-target] [data-chart-inst]')?.dataset.chartTimeEnd)
    return edge > previous
  }, backward)
  const forward = await readEdge()
  assert.ok(backward < forward && forward < baseline, 'Reverse scrolling must move the fractional edge toward its starting position.')
  const report = await finishPaintProbe(page)
  assert.ok(report.frames > 0 && report.paints > 0)
  assert.deepEqual(report.violations, [])
})

test('live prices outside the saved domain keep their axis labels inside the price panel', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const visible = fixture.series[fixture.timeframe].bars.slice(-96)
  const extremes = [Math.max(...visible.map(bar => bar.high)) * 10, Math.min(...visible.map(bar => bar.low)) / 10]
  for (const livePrice of extremes) {
    await installPreparedTransform({ mode: 'live', instId: fixture.instId, livePrice })
    try {
      await openChart(page, fixture)
      const geometry = await page.evaluate(() => {
        const svg = document.querySelector('[data-acceptance-target] svg[data-rendered-inst]')
        const bounds = selector => {
          const box = svg.querySelector(selector).getBBox()
          return [box.y, box.y + box.height]
        }
        return {
          panel: [0, Number(svg.querySelector('[data-chart-panel-divider="price"]').getAttribute('y1'))],
          livePrice: document.querySelector('[data-acceptance-target] [data-chart-inst]').__chartSnapshot.liveBar?.close,
          lineY: Number(svg.querySelector('[data-chart-live-price]').getAttribute('y1')),
          labelY: Number(svg.querySelector('[data-chart-price-label-value]').getAttribute('y')),
          label: bounds('[data-chart-price-label-value]'), background: bounds('[data-chart-price-label-background]'),
          countdown: bounds('[data-chart-countdown]'),
          countdownY: Number(svg.querySelector('[data-chart-countdown]').getAttribute('y')),
          fontSize: parseFloat(getComputedStyle(svg.querySelector('[data-chart-price-label-value]')).fontSize),
        }
      })
      assert.equal(geometry.livePrice, livePrice)
      assert.ok(Math.abs(geometry.labelY - geometry.lineY) <= geometry.fontSize / 2 + 3, 'Only shift the price label as far as needed to keep it inside the panel.')
      assert.ok(geometry.lineY >= geometry.panel[0] && geometry.lineY <= geometry.panel[1])
      for (const bounds of [geometry.label, geometry.background, geometry.countdown]) {
        assert.ok(bounds[0] >= geometry.panel[0] && bounds[1] <= geometry.panel[1], `Axis text must stay in the price panel: ${JSON.stringify(geometry)}`)
      }
      for (const bounds of [geometry.label, geometry.countdown]) {
        assert.ok(bounds[0] >= geometry.background[0] && bounds[1] <= geometry.background[1], 'Price and countdown text must share the same background.')
      }
      assert.ok(Math.abs(Math.abs(geometry.countdownY - geometry.labelY) - geometry.fontSize) < 1e-6, 'Single line spacing must be preserved when the countdown changes sides.')
    } finally { await removePreparedTransform() }
  }
})

test('a qualified short listing remains selectable while chart statistics are still loading', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installPreparedTransform({ mode: 'partial', instId: fixture.instId, end: fixture.end, intervalMS: fixture.intervalMS })
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator(`[data-chart-inst="${fixture.instId}"]`).first().waitFor({ state: 'visible' })
    assert.equal(await page.locator(`[aria-label="View ${fixture.instId} chart"]`).count(), 1,
      'Chart statistics cannot revoke backend list membership.')
    await selectTimeframe(page, fixture.timeframe)
    const chart = page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`)
    await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-inst]')?.dataset.chartRenderedBars === '12')
    assert.equal(await chart.getAttribute('data-chart-loading'), 'false')
    assert.equal(await chart.locator('svg[data-rendered-inst]').count(), 1)
    assert.equal(await chart.getAttribute('data-chart-oi-state'), 'loading')
    assert.equal(await chart.getAttribute('data-chart-taker-state'), 'loading')
    assert.equal(await chart.getAttribute('data-chart-incomplete'), 'true')
    assert.match(await chart.locator('[aria-live="off"]').textContent(), /Close/)
  } finally { await removePreparedTransform() }
})

test('historically unavailable statistics remain missing instead of becoming false zero volume', async () => {
  const fixture = await request({ e2e: { action: 'seedHistoricalStatisticsBoundary' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
  const chart = page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`)
  assert.equal(await chart.getAttribute('data-chart-oi-state'), 'unavailable')
  assert.equal(await chart.getAttribute('data-chart-taker-state'), 'unavailable')
  assert.equal(await chart.getAttribute('data-chart-oi-samples'), '0')
  assert.equal(await chart.getAttribute('data-chart-taker-samples'), '0')
  const status = chart.locator('[data-chart-status]')
  assert.equal(await status.getByText('OI is not published for part of this range', { exact: true }).count(), 1)
  assert.equal(await status.getByText('Taker is not published for part of this range', { exact: true }).count(), 1)
  assertCompletePaints(await finishPaintProbe(page))
})
