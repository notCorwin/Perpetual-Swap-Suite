import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertCompletePaints, assertIndicatorLegends, assertWorkspaceLayout, finishPaintProbe, installRequestProbe, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, separateSourceMaintenance, startPaintProbe, waitForRendered, wheelBurst } from '../../scripts/chart-acceptance.mjs'


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
const installPreparedTransform = async options => electron.evaluate(({ ipcMain, BrowserWindow }, options) => {
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
      rsi6: bar.hour >= options.first && bar.hour <= options.warmupThrough ? null : bar.rsi6,
      rsi12: bar.hour >= options.first && bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.rsi12,
      atrPercent: bar.hour >= options.first && bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.atrPercent,
      bbw: bar.hour >= options.first && bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.bbw,
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
  ipcMain.handle('radar:request', async (event, value) => {
    if (value.chartWindow?.instId === options.instId) probe.calls += 1
    const response = await original(event, value)
    return value.chartUniverse ? { ...response, frames: response.frames.map(transform) }
      : value.chartLocal || value.chartHistory || value.chartWindow ? transform(response) : response
  })
  contents.send = function (channel, ...args) {
    if (channel === 'radar:chart-prepared') args[0] = transform(args[0])
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
  await writeFile(join(userData, 'settings.json'), JSON.stringify({
    notificationsEnabled: true, backgroundMonitoringEnabled: true, monitoringPaused: true,
    filterLibraryPreferencesJSON: '{"favorites":["emaTrend"]}',
  }))
  await launchElectron()
})
after(async () => { await electron?.close(); await rm(userData, { recursive: true, force: true }) })

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
  assert.equal(await page.evaluate(() => typeof window.webkit?.messageHandlers?.radar), 'undefined')
})

test('custom title bar controls reach the owning native window without showing it', async () => {
  // Intercept only native window mutations: exercise production UI, preload,
  // request validation, and sender ownership without exposing a test window.
  await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const names = ['close', 'minimize', 'maximize', 'unmaximize', 'isMaximized']
    const originals = new Map(names.map(name => [name, window[name]]))
    const probe = globalThis.__windowControlProbe = { window, originals, calls: [], maximized: false }
    window.isMaximized = () => probe.maximized
    window.close = () => { probe.calls.push('close') }
    window.minimize = () => { probe.calls.push('minimize') }
    window.maximize = () => { probe.calls.push('maximize'); probe.maximized = true }
    window.unmaximize = () => { probe.calls.push('unmaximize'); probe.maximized = false }
  })
  try {
    const titlebar = page.getByRole('banner', { name: 'Window title bar' })
    await titlebar.waitFor()
    assert.equal(await titlebar.evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'drag')
    for (const name of ['Close window', 'Minimize window', 'Zoom window']) {
      assert.equal(await titlebar.getByRole('button', { name, exact: true }).evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
    }
    await titlebar.getByRole('button', { name: 'Minimize window', exact: true }).click()
    const zoom = titlebar.getByRole('button', { name: 'Zoom window', exact: true })
    await zoom.click()
    await zoom.focus()
    await page.keyboard.press('Enter')
    await titlebar.getByRole('button', { name: 'Close window', exact: true }).click()
    await waitFor(() => electron.evaluate(() => globalThis.__windowControlProbe.calls.length === 4))
    assert.deepEqual(await electron.evaluate(() => globalThis.__windowControlProbe.calls), ['minimize', 'maximize', 'unmaximize', 'close'])
    const settings = titlebar.getByRole('link', { name: 'Settings', exact: true })
    assert.equal(await settings.evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
    await settings.click()
    await page.getByRole('main', { name: 'Settings', exact: true }).waitFor()
    assert.equal(await titlebar.isVisible(), true, 'Window controls must remain available in settings.')
    await page.getByRole('link', { name: 'Back to markets', exact: true }).click()
    assert.equal(await electron.evaluate(() => globalThis.__windowControlProbe.window.isVisible()), false)
  } finally {
    await electron.evaluate(() => {
      const probe = globalThis.__windowControlProbe
      for (const [name, original] of probe.originals) probe.window[name] = original
      delete globalThis.__windowControlProbe
    })
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
  const first = await request({ snapshot: { timeframe: '5m', sinceRevision: -1 } })
  assert.ok(first.serviceSession)
  const same = await request({ snapshot: { timeframe: '5m', sinceRevision: first.revision, serviceSession: first.serviceSession } })
  assert.equal(same.unchanged, true)
  assert.equal('rows' in same, false)
  const fresh = await request({ snapshot: { timeframe: '5m', sinceRevision: same.revision, serviceSession: 'previous-collector' } })
  assert.ok(Array.isArray(fresh.rows))
})

test('Radar has no Research or Strategy workspace or desktop operations', async () => {
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Research|Strategy|Signals|Rules|Universe/ }).count(), 0)
  assert.equal(await page.locator('[data-mode-switch]').count(), 0)
  const previous = await request({ snapshot: { timeframe: '5m', sinceRevision: -1 } })
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
  const current = await request({ snapshot: { timeframe: '5m', sinceRevision: -1 } })
  assert.equal(current.timeframe, previous.timeframe)
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

test('clipboard, screenshot capture, analysis settings, and safe gateway cancellation work', async () => {
  assert.deepEqual(await request({ copyText: 'Perpetual Swap Suite E2E' }), { ok: true })
  const image = await request({ captureChart: { x: 0, y: 0, width: 80, height: 60, output: 'png' } })
  assert.match(image.imageDataURL, /^data:image\/png;base64,/)
  assert.ok(image.width > 0 && image.height > 0)
  assert.deepEqual(await request({ analysisSettings: { action: 'save', model: 'test-model', apiKey: 'test-key' } }), { model: 'test-model', hasAPIKey: true })
  assert.deepEqual(await request({ analysisSettings: { action: 'read' } }), { model: 'test-model', hasAPIKey: true })
  assert.equal('analysis' in await request({ snapshot: { timeframe: '5m', sinceRevision: -1 } }), false)
  assert.deepEqual(await request({ analysisSettings: { action: 'removeKey' } }), { model: 'test-model', hasAPIKey: false })
  await assert.rejects(() => request({ gatewayFetch: { id: 'missing-key', body: '{}' } }), /Save an AI Gateway API key/)
  assert.deepEqual(await request({ cancelGatewayFetch: 'no-such-request' }), { ok: true })
  const initial = await request({ snapshot: { timeframe: '5m', sinceRevision: -1 } })
  assert.equal(initial.error, '')
  assert.deepEqual(initial.rows, [])
})

test('cached catalog projection retains statistics while the list shows contract, price, and independent ranking change', async () => {
  const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
  assert.equal(fixture.timeframe, '1H')

  // This is the renderer's ordinary radar request.  The fixture only writes
  // source/statistics cache rows and catalog context; it never injects a
  // ready-made market row.
  const projected = await waitFor(async () => {
    const snapshot = await request({ snapshot: { timeframe: fixture.timeframe, sinceRevision: -1 } })
    const row = snapshot.rows?.find(value => value.instId === fixture.instId)
    return row && row.oiChange !== null && row.takerRatio !== null && row.rsi6 !== null && row.ema200Signal !== null ? row : null
  })
  assert.notEqual(projected.oiChange, null)
  assert.notEqual(projected.takerRatio, null)
  assert.notEqual(projected.rsi6, null)
  assert.notEqual(projected.ema200Signal, null)

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
  assert.match((await cells.nth(2).textContent()) ?? '', /[↑↓→▲▼↔+−-].*%|—/)
  assert.deepEqual(await page.locator('[data-market-list] th').allTextContents(), ['Contract', 'Price', '15m change'])
  await page.locator('[data-chart-panel]').waitFor({ state: 'visible' })
  await selectTimeframe(page, fixture.timeframe)
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
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
  const snapshot = await request({ snapshot: { timeframe: '1H', sinceRevision: -1 } })
  assert.equal(snapshot.catalogSource, 'cache')
  assert.equal(snapshot.loading, true, 'The delayed production-style discovery must still be running.')
  await page.locator('[data-market-list]').getByText('Refreshing', { exact: true }).waitFor()

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
      const prepared = await waitFor(async () => {
        const frame = await request({ chartWindow: { instId: fixture.instId, timeframe, endHour: fixture.end } })
        return frame.indicatorState !== 'loading' ? frame : null
      })
      const expected = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
      const visible = prepared.bars.filter(bar => bar.hour >= fixture.end - 95 * fixture.series[timeframe].intervalMS && bar.hour <= fixture.end)
      assert.equal(visible.length, 96)
      for (const bar of visible) {
        const oracle = expected.get(bar.hour)
        for (const field of ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']) {
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

test('ATR% and BBW share the panel between RSI and OI with independent fitted scales without axis coordinates, colored titles and exact candle inspection', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 1_600, height: 1_000 })
  await openChart(page, fixture)
  const legendValue = label => page.locator(`svg[data-rendered-inst] [data-chart-legend="${label}"]`).evaluate(line => line.parentElement.querySelectorAll('text')[1].textContent)
  try {
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.bars.every(bar => Number.isFinite(bar.atrPercent) && Number.isFinite(bar.bbw)))
      const reading = await assertIndicatorLegends(page, { requireFittedVolatility: true })
      const visible = fixture.series[timeframe].bars.slice(-96)
      const curvePoints = field => reading.legends.find(legend => legend.field === field).curve.match(/[ML][^ML]+/g).map(command => command.slice(1).trim().split(/\s+/).map(Number))
      const visibleRanges = []
      for (const field of ['atrPercent', 'bbw']) {
        const values = visible.map(bar => bar[field]), minimum = Math.min(...values), maximum = Math.max(...values)
        const points = curvePoints(field), ys = points.map(([, y]) => y), curveTop = Math.min(...ys), curveBottom = Math.max(...ys)
        assert.ok(minimum > 0 && maximum > minimum, `${field} fixture must expose a varied positive range to catch a forced zero baseline.`)
        const fittedMinimum = minimum - (reading.volatilityPanel.bottom - curveBottom) / (curveBottom - curveTop) * (maximum - minimum)
        assert.ok(fittedMinimum > 0, `${field} must fit its positive visible range instead of anchoring the hidden scale to zero.`)
        visibleRanges.push([minimum, maximum])
        assert.equal(points.length, visible.length + 1)
        for (const [index, bar] of visible.entries()) {
          const expectedY = curveBottom - (bar[field] - minimum) / (maximum - minimum) * (curveBottom - curveTop)
          assert.ok(Math.abs(points[index + 1][1] - expectedY) <= .101,
            `${timeframe} ${field} candle ${bar.hour} must follow its own visible native value range.`)
        }
      }
      assert.notDeepEqual(visibleRanges[0], visibleRanges[1], 'The fixture must expose different ATR% and BBW domains, so a shared scale cannot pass both fitted-height checks.')
      assert.deepEqual(curvePoints('atrPercent').map(([x]) => x), curvePoints('bbw').map(([x]) => x), 'Independent fitted scales must preserve candle time alignment.')
      const expected = fixture.series[timeframe].bars.at(-1)
      assert.equal(await legendValue('ATR%(14)'), `${expected.atrPercent.toFixed(2)}%`)
      assert.equal(await legendValue('BBW(20,2)'), `${expected.bbw.toFixed(2)}%`)
      const target = await page.locator('svg[data-rendered-inst]').evaluate(svg => {
        const commands = svg.querySelector('[data-chart-indicator="atrPercent"]').getAttribute('d').match(/[ML][^ML]+/g)
        if (commands.length !== 97) throw new Error('The mature ATR% curve must cover all 96 candles and its left-edge extension.')
        const [x, y] = commands[39].slice(1).trim().split(/\s+/).map(Number)
        const rect = svg.getBoundingClientRect(), view = svg.viewBox.baseVal
        return { x: rect.x + x / view.width * rect.width, y: rect.y + y / view.height * rect.height,
          hour: Number(svg.dataset.renderedStart) + 38 * ({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })[svg.dataset.renderedTimeframe] }
      })
      const inspected = fixture.series[timeframe].bars.find(bar => bar.hour === target.hour)
      assert.ok(inspected)
      await page.mouse.move(target.x, target.y)
      await page.mouse.down()
      await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      assert.equal(await legendValue('ATR%(14)'), `${inspected.atrPercent.toFixed(2)}%`, 'ATR% inspection must read the selected native candle.')
      assert.equal(await legendValue('BBW(20,2)'), `${inspected.bbw.toFixed(2)}%`, 'BBW inspection must read the same selected native candle.')
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      assert.equal(await legendValue('ATR%(14)'), `${expected.atrPercent.toFixed(2)}%`)
      assert.equal(await legendValue('BBW(20,2)'), `${expected.bbw.toFixed(2)}%`)
    }
  } finally {
    await page.mouse.up()
    await page.setViewportSize(originalViewport)
  }
})

test('the 1600 design workspace keeps both panels and chart selection when search hides the selected row', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    for (const width of [1_600, 1_120, 1_920]) {
      await page.setViewportSize({ width, height: 1_000 })
      await page.waitForFunction(width => Math.abs(Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) - width / 1_600) < 1e-5, width)
      await assertWorkspaceLayout(page)
    }
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('NO-MATCHING-CONTRACT')
    assert.equal(await page.locator('[data-market-list] [aria-label^="View "]').count(), 0)
    assert.equal(await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst'), fixture.instId, 'Search must preserve the selected chart even if the contract is hidden.')
    await assertWorkspaceLayout(page)
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).waitFor({ state: 'visible' })
    assert.equal(await page.locator(`[aria-label="View ${fixture.instId} chart"]`).getAttribute('aria-selected'), 'true')
  } finally {
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
    if (originalViewport) await page.setViewportSize(originalViewport)
  }
})

test('the paint probe catches changed indicator geometry without a new snapshot and retains the violation', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  let report
  try {
    const observation = await page.evaluate(async instId => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      const snapshot = chart.__chartSnapshot
      const path = chart.querySelector('svg[data-rendered-inst] [data-chart-indicator="rsi12"]')
      const original = path.getAttribute('d')
      const initiallyValid = window.__chartPaintProbe.errors.length === 0
      try {
        path.setAttribute('d', 'M0,0')
        // Mutation observers run before the next task, with the same rendered
        // data. Further frames then exercise the unchanged corrupted path.
        await Promise.resolve()
        const detected = window.__chartPaintProbe.errors.find(error => /rsi12 SVG has 1 points/.test(error))
        const sameSnapshot = chart.__chartSnapshot === snapshot
        for (let frame = 0; frame < 3; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve))
        return {
          initiallyValid, detected, sameSnapshot,
          sameCorruptedGeometry: path.getAttribute('d') === 'M0,0',
          retained: window.__chartPaintProbe.errors.includes(detected),
        }
      } finally { path.setAttribute('d', original) }
    }, fixture.instId)
    await page.evaluate(async () => { for (let frame = 0; frame < 2; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    report = await finishPaintProbe(page)
    assert.equal(observation.initiallyValid, true)
    assert.equal(observation.sameSnapshot, true, 'The corrupted curve must be checked without a data publication.')
    assert.match(observation.detected ?? '', /rsi12 SVG has 1 points/)
    assert.equal(observation.sameCorruptedGeometry, true)
    assert.equal(observation.retained, true, 'Repeated unchanged geometry must retain the detected violation.')
    assert.ok(report.violations.includes(observation.detected), 'Restoring valid geometry must not erase an earlier incorrect paint.')
  } finally { if (!report) await finishPaintProbe(page) }

})

test('mature local indicators and statistics stay drawn from the first scroll through prefetch, push and scroll end', async context => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const indicatorFields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
  await installRequestProbe(electron, fixture.instId)
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
      // Establish a complete canonical starting frame. The regression concerns
      // losing mature data during navigation, not first-time indicator seeding.
      await page.waitForFunction(({ timeframe, fields }) => {
        const snapshot = document.querySelector('[data-chart-inst]')?.__chartSnapshot
        return snapshot?.timeframe === timeframe && snapshot.bars.length === 96
          && snapshot.bars.every(bar => [...fields, 'oi', 'buy', 'sell'].every(field => Number.isFinite(bar[field])))
      }, { timeframe, fields: indicatorFields }, { timeout: 20_000 })
      await startPaintProbe(page, fixture, { requireMatureData: true })
      const phase = value => page.evaluate(value => { window.__chartPaintProbe.phase = value }, value)
      const settle = () => page.evaluate(async () => { for (let frame = 0; frame < 12; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
      const intervalMS = fixture.series[timeframe].intervalMS
      await phase('first wheel and local history admission')
      await wheelBurst(page, { deltaY: 7_200 })
      await waitForRendered(page, fixture, timeframe, fixture.end - 600 * intervalMS)
      await waitFor(async () => (await readRequestProbe(electron)).historyResponses.some(response => response.timeframe === timeframe && response.bars > 96))
      await phase('continuous scrolling and speculative prefetch')
      await wheelBurst(page, { frames: 6, eventsPerFrame: 32, deltaY: 36 })
      await waitForRendered(page, fixture, timeframe, fixture.end - 1_176 * intervalMS)
      await wheelBurst(page, { deltaY: 7_200 })
      const historicalEnd = fixture.end - 1_776 * intervalMS
      await waitForRendered(page, fixture, timeframe, historicalEnd)
      await phase('scroll end and asynchronous completions')
      await settle()
      await phase('ordinary latest push while viewing history')
      // Forward an actual backend local frame through the ordinary event
      // ingress. Its contents are unchanged; only delivery timing is controlled.
      await electron.evaluate(async ({ BrowserWindow }, { instId, timeframe }) => {
        const frame = await globalThis.__marketBackend.request({ chartLocal: { instId, timeframe } })
        if (!frame) throw new Error('The active backend must retain its latest local frame.')
        BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
      }, { instId: fixture.instId, timeframe })
      await settle()
      assert.equal(Number(await page.locator('[data-chart-inst]').getAttribute('data-chart-completed-end')), historicalEnd, 'A latest publication must preserve the historical viewport.')
      await phase('reverse to latest and stop')
      await wheelBurst(page, { deltaY: -1_776 * 12 })
      await waitForRendered(page, fixture, timeframe)
      await settle()
      const paint = await finishPaintProbe(page)
      const incomplete = paint.quality.filter(frame => frame.indicators !== 96 || frame.oi !== 96 || frame.taker !== 96)
      if (incomplete.length) context.diagnostic(`Incomplete local paints: ${JSON.stringify({ timeframe, frames: incomplete })}`)
      assertCompletePaints(paint)
      assert.ok(paint.commits.some(commit => commit.end === historicalEnd), 'The probe must inspect the deep historical viewport.')
      assert.equal(incomplete.length, 0,
        `${timeframe} lost a mature indicator or source panel during navigation: ${JSON.stringify(paint.quality)}`)
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

for (const mode of ['gap', 'prepend']) test(`first historical acquisition keeps every calculated curve and source panel while ${mode === 'gap' ? 'later gaps fill' : 'an earlier prefix changes the exact recursive seed'}`, async context => {
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  const fixture = await probe({ action: 'acquisitionInstall', timeframe: '15m', mode })
  const fields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
  const desired = fixture.series[fixture.timeframe].bars.filter(bar => bar.hour >= fixture.targetEnd - 95 * fixture.intervalMS && bar.hour <= fixture.targetEnd)
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
      const snapshot = document.querySelector('[data-chart-inst]')?.__chartSnapshot
      return snapshot?.endHour === targetEnd && snapshot.bars.length === 96
        && snapshot.bars.every(bar => fields.every(field => Number.isFinite(bar[field])))
    }, { targetEnd: fixture.targetEnd, fields }, { timeout: 20_000 })
    const firstEMA = await page.evaluate(() => document.querySelector('[data-chart-inst]').__chartSnapshot.bars.at(-1).ema)
    if (mode === 'prepend') assert.ok(Math.abs(firstEMA - desired.at(-1).ema) > 1e-6,
      'The absent earlier prefix must actually change the recursive result, so retaining a stale curve cannot pass this test.')
    await startPaintProbe(page, fixture, { requireMatureData: true, verifyIndicatorValues: mode === 'gap' })
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
    // The prefix variant must adopt the new correct numbers without ever
    // clearing its already visible curves or independent statistic panels.
    await page.waitForFunction(({ desired, fields }) => {
      const bars = document.querySelector('[data-chart-inst]')?.__chartSnapshot?.bars
      return bars?.length === desired.length && bars.every((bar, index) => bar.hour === desired[index].hour
        && fields.every(field => Number.isFinite(bar[field]) && Math.abs(bar[field] - desired[index][field]) <= Math.max(1, Math.abs(desired[index][field])) * 1e-10))
    }, { desired, fields }, { timeout: 20_000 })
    await settle()
    const paint = await finishPaintProbe(page)
    context.diagnostic(`First acquisition ${mode}: ${JSON.stringify({ sourceCounts, paints: paint.paints, quality: paint.quality })}`)
    assertCompletePaints(paint)
    assert.ok(paint.quality.every(frame => frame.indicators === 96 && frame.oi === 96 && frame.taker === 96),
      'Every mature curve and statistic panel must remain visible through native page ingestion, even when the canonical generation changes.')
  } finally {
    await page.evaluate(() => { const probe = window.__chartPaintProbe; if (probe) { probe.active = false; cancelAnimationFrame(probe.raf); probe.observer.disconnect(); delete window.__chartPaintProbe } })
  }
})

test('a held history read keeps the last complete paint and coalesces every later wheel event into the latest target', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installRequestProbe(electron, fixture.instId, { disableLocalHistory: true, initialHistoryBars: 1_000, capHistoricalWindows: true })
  try {
    await openChart(page, fixture)
    await removeRequestProbe(electron)
    await installRequestProbe(electron, fixture.instId, { holdHistorical: true, disableLocalHistory: true })
    await startPaintProbe(page, fixture)
    await wheelBurst(page, { deltaY: 14_400 })
    await waitFor(async () => (await readRequestProbe(electron)).held)
    await wheelBurst(page, { frames: 4, eventsPerFrame: 32, deltaY: 12 })
    await wheelBurst(page, { frames: 2, eventsPerFrame: 32, deltaY: -12 })
    const expectedEnd = fixture.end - 1_264 * fixture.intervalMS
    await page.waitForFunction(({ instId, expectedEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return Number(chart?.getAttribute('data-chart-requested-end')) === expectedEnd
        && chart.getAttribute('data-chart-loading') === 'true'
    }, { instId: fixture.instId, expectedEnd })
    const held = await readRequestProbe(electron)
    assert.equal(held.active, 1)
    assert.equal(held.maxActive, 1, 'Wheel events may not create a parallel request storm.')
    assert.equal(held.calls.length, held.callsAtHold, `No additional read may cross IPC while history is held: ${JSON.stringify(held.calls)}`)
    const svg = page.locator(`svg[data-rendered-inst="${fixture.instId}"]`)
    assert.equal(Number(await svg.getAttribute('data-rendered-end')), fixture.end)
    assert.match(await page.locator(`[data-chart-inst="${fixture.instId}"]`).textContent(), /Preparing/)
    await releaseRequestProbe(electron)
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    await page.evaluate(async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    const report = await finishPaintProbe(page)
    assertCompletePaints(report)
    assert.equal(report.commits.at(-1).end, expectedEnd)
    const requests = await readRequestProbe(electron)
    assert.equal(requests.maxActive, 1)
    assert.deepEqual(separateSourceMaintenance(requests.sourceRequests, fixture).historical, [], 'Scrolling must reuse durable history, independently of bounded current-window repairs beyond the fixture.')
    assert.ok(requests.calls.length <= 12, `Coalesced history work unexpectedly issued ${requests.calls.length} requests.`)
    assert.ok(!report.commits.some(commit => commit.end === fixture.end - 1_200 * fixture.intervalMS), 'The obsolete held target was presented after a newer input.')
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('a late history response cannot overwrite a more recently selected timeframe', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installRequestProbe(electron, fixture.instId, { disableLocalHistory: true, initialHistoryBars: 1_000, capHistoricalWindows: true })
  try {
    await openChart(page, fixture)
    for (const timeframe of fixture.timeframes) {
      await selectTimeframe(page, timeframe)
      await waitForRendered(page, fixture, timeframe)
    }
    await removeRequestProbe(electron)
    await installRequestProbe(electron, fixture.instId, { holdHistorical: true, disableLocalHistory: true })
    await startPaintProbe(page, fixture)
    await wheelBurst(page, { deltaY: 14_400 })
    await waitFor(async () => (await readRequestProbe(electron)).held)
    await selectTimeframe(page, '5m')
    await selectTimeframe(page, '15m')
    await releaseRequestProbe(electron)
    await waitForRendered(page, fixture, '15m')
    await page.evaluate(async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    const report = await finishPaintProbe(page)
    assertCompletePaints(report)
    assert.equal(report.commits.at(-1).timeframe, '15m')
    const final15m = report.commits.findIndex(commit => commit.timeframe === '15m')
    assert.ok(final15m >= 0)
    assert.ok(report.commits.slice(final15m).every(commit => commit.timeframe === '15m'), 'An older timeframe repainted after the selected chart was ready.')
    const requests = await readRequestProbe(electron)
    assert.deepEqual(separateSourceMaintenance(requests.sourceRequests, fixture).historical, [], 'A fully local timeframe switch must reuse historical candles and statistics. Bounded current-window repairs beyond the fixture are independent.')
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('the live price overlay follows its actual price without changing the 96 completed candles', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const visible = fixture.series[fixture.timeframe].bars.slice(-96)
  const prices = visible.flatMap(bar => ['low', 'high', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower'].map(field => bar[field]))
  // A geometric midpoint must land at the center of a logarithmic price axis,
  // including symmetric axis padding. This expectation does not reuse Plot.
  const livePrice = Math.sqrt(Math.min(...prices) * Math.max(...prices))
  await installPreparedTransform({ mode: 'live', instId: fixture.instId, livePrice })
  try {
    await openChart(page, fixture)
    await page.waitForFunction(() => Boolean(document.querySelector('[data-chart-inst]')?.__chartSnapshot?.liveBar))
    await startPaintProbe(page, fixture)
    const overlay = await page.evaluate(() => {
      const chart = document.querySelector('[data-chart-inst]')
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      const horizontalBorders = [...svg.querySelectorAll(':scope > line')].filter(line =>
        line.getAttribute('stroke') === 'var(--border)' && line.y1.baseVal.value === line.y2.baseVal.value
        && line.x1.baseVal.value !== line.x2.baseVal.value)
      const line = svg.querySelector('[data-chart-live-price]')
      const label = svg.querySelector('[data-chart-price-label-value]')
      const tick = svg.querySelector('[data-chart-price-tick] text')
      const countdown = svg.querySelector('[data-chart-countdown]')
      const labelBounds = label.getBBox()
      return {
        bars: snapshot.bars.length, allConfirmed: snapshot.bars.every(bar => bar.confirmed),
        liveConfirmed: snapshot.liveBar?.confirmed, liveHour: snapshot.liveBar?.hour,
        lineY: Number(line?.getAttribute('y1')),
        expectedY: (Number(horizontalBorders[0].getAttribute('y1')) + Number(horizontalBorders[1].getAttribute('y1'))) / 2,
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
    assert.equal(overlay.bars, 96)
    assert.equal(overlay.allConfirmed, true)
    assert.equal(overlay.liveConfirmed, false)
    assert.equal(overlay.liveHour, fixture.end + fixture.intervalMS)
    assert.ok(Math.abs(overlay.lineY - overlay.expectedY) < 1e-6, `The live price line must use its logarithmic price coordinate: ${JSON.stringify(overlay)}`)
    assert.match(overlay.countdown ?? '', /^\d{2}:\d{2}$/)
    assert.equal(overlay.labelX, overlay.tickX, 'The price value must share the axis tick alignment.')
    assert.equal(overlay.labelY, overlay.lineY, 'Countdown placement must not shift the price anchor.')
    assert.equal(overlay.backgroundX, overlay.lineEndX, 'The price highlight must meet the plot axis.')
    assert.ok(overlay.labelBounds[0] >= 0 && overlay.labelBounds[1] <= overlay.svgWidth, 'The complete price value must fit inside the SVG.')
    assert.equal(overlay.labelFont, overlay.tickFont)
    assert.equal(overlay.countdownFont, overlay.labelFont, 'Price and countdown must use the same font size.')
    assert.ok(Math.abs(Math.abs(overlay.countdownY - overlay.labelY) - parseFloat(overlay.labelFont)) < 1e-6, 'The two lines must use single line spacing.')
    assert.equal(overlay.countdownFill, overlay.tickFill, 'The countdown must use the muted axis text color.')
    assert.notEqual(overlay.countdownFill, overlay.labelFill)
    await wheelBurst(page, { deltaY: 12 })
    await waitForRendered(page, fixture, fixture.timeframe, fixture.end - fixture.intervalMS)
    assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-countdown]').count(), 0, 'Historical charts must not display a live countdown.')
    assert.equal(await page.evaluate(() => document.querySelector('[data-chart-inst]').__chartSnapshot.liveBar), undefined)
    assertCompletePaints(await finishPaintProbe(page))
  } finally {
    await removePreparedTransform()
  }
})

test('latest OI and Taker legends retain their last observed values after scrolling and inspect missing live values exactly', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const completed = fixture.series[fixture.timeframe].bars.at(-1)
  const compact = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5, notation: 'compact' })
  const readLegends = () => page.evaluate(() => {
    const svg = document.querySelector('svg[data-rendered-inst]')
    return Object.fromEntries(['OI (Contracts)', '↑ Taker Buy (Contracts)', '↓ Taker Sell (Contracts)'].map(label => {
      const line = [...svg.querySelectorAll('[data-chart-legend]')].find(node => node.getAttribute('data-chart-legend') === label)
      const group = line.parentElement
      const context = group.querySelector('[data-chart-legend-source-context]')
      return [label, {
        value: group.querySelectorAll('text')[1].childNodes[0]?.textContent,
        sourceHour: Number(group.getAttribute('data-chart-legend-source-hour')),
        context: context?.textContent ?? '',
        contextFill: context ? getComputedStyle(context).fill : null,
        mutedFill: getComputedStyle(document.querySelector('[data-chart-status]')).color,
      }]
    }))
  })
  const labels = ['OI (Contracts)', '↑ Taker Buy (Contracts)', '↓ Taker Sell (Contracts)']
  const assertLatest = async (liveStatistics = {}) => {
    const legends = await readLegends()
    const takerLive = Number.isFinite(liveStatistics.buy) && Number.isFinite(liveStatistics.sell)
    for (const [index, key] of ['oi', 'buy', 'sell'].entries()) {
      const current = index === 0 ? Number.isFinite(liveStatistics.oi) : takerLive
      const reading = legends[labels[index]]
      assert.equal(reading.value, compact.format(current ? liveStatistics[key] : completed[key]))
      assert.equal(reading.sourceHour, fixture.end + (current ? fixture.intervalMS : 0))
      if (current) assert.equal(reading.context, '', 'A current observation needs no older-source timestamp.')
      else {
        assert.match(reading.context, /as of [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}/)
        assert.equal(reading.contextFill, reading.mutedFill, 'Older observations must show their timestamp in the muted text color.')
      }
    }
  }
  await installPreparedTransform({ mode: 'live', instId: fixture.instId, livePrice: completed.close })
  try {
    await openChart(page, fixture)
    await assertLatest()
    await wheelBurst(page, { deltaY: 12 })
    await waitForRendered(page, fixture, fixture.timeframe, fixture.end - fixture.intervalMS)
    const historical = await readLegends()
    for (const label of labels) {
      assert.equal(historical[label].sourceHour, fixture.end - fixture.intervalMS)
      assert.equal(historical[label].context, '')
      assert.notEqual(historical[label].value, 'Unavailable')
    }
    await wheelBurst(page, { deltaY: -12 })
    await waitForRendered(page, fixture)
    await assertLatest()
    const bounds = await page.locator('svg[data-rendered-inst]').boundingBox()
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height * .1)
    await page.mouse.down()
    await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
    const inspected = await readLegends()
    for (const label of labels) {
      assert.equal(inspected[label].value, 'Unavailable', 'Inspection must show the missing value at the selected candle.')
      assert.equal(inspected[label].context, '')
    }
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
    await assertLatest()
  } finally {
    await page.mouse.up()
    await removePreparedTransform()
  }
  // The two source families advance independently; genuine zero observations
  // must supersede older nonzero values without acquiring an older timestamp.
  for (const liveStatistics of [{ oi: 0 }, { buy: 0, sell: 0 }]) {
    await installPreparedTransform({ mode: 'live', instId: fixture.instId, livePrice: completed.close, liveStatistics })
    try {
      await openChart(page, fixture)
      await assertLatest(liveStatistics)
    } finally { await removePreparedTransform() }
  }
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
        const svg = document.querySelector('svg[data-rendered-inst]')
        const borders = [...svg.querySelectorAll(':scope > line')].filter(line =>
          line.getAttribute('stroke') === 'var(--border)' && line.y1.baseVal.value === line.y2.baseVal.value
          && line.x1.baseVal.value !== line.x2.baseVal.value)
        const bounds = selector => {
          const box = svg.querySelector(selector).getBBox()
          return [box.y, box.y + box.height]
        }
        return {
          panel: borders.slice(0, 2).map(line => Number(line.getAttribute('y1'))),
          livePrice: document.querySelector('[data-chart-inst]').__chartSnapshot.liveBar?.close,
          lineY: Number(svg.querySelector('[data-chart-live-price]').getAttribute('y1')),
          labelY: Number(svg.querySelector('[data-chart-price-label-value]').getAttribute('y')),
          label: bounds('[data-chart-price-label-value]'), background: bounds('[data-chart-price-label-background]'),
          countdown: bounds('[data-chart-countdown]'),
          countdownY: Number(svg.querySelector('[data-chart-countdown]').getAttribute('y')),
          fontSize: parseFloat(getComputedStyle(svg.querySelector('[data-chart-price-label-value]')).fontSize),
        }
      })
      assert.equal(geometry.livePrice, livePrice)
      assert.equal(geometry.labelY, geometry.lineY)
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

test('known RSI, ATR% and BBW segments remain visible through indicator warm-up and internal missing samples', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const first = fixture.end - 95 * fixture.intervalMS
  const warmupThrough = first + 5 * fixture.intervalMS
  const interiorGap = first + 50 * fixture.intervalMS
  fixture.series[fixture.timeframe].bars = fixture.series[fixture.timeframe].bars.map(bar => ({
    ...bar,
    rsi6: bar.hour >= first && bar.hour <= warmupThrough ? null : bar.rsi6,
    rsi12: bar.hour >= first && bar.hour <= warmupThrough || bar.hour === interiorGap ? null : bar.rsi12,
    atrPercent: bar.hour >= first && bar.hour <= warmupThrough || bar.hour === interiorGap ? null : bar.atrPercent,
    bbw: bar.hour >= first && bar.hour <= warmupThrough || bar.hour === interiorGap ? null : bar.bbw,
  }))
  await installPreparedTransform({ mode: 'warmup', instId: fixture.instId, timeframe: fixture.timeframe, first, warmupThrough, interiorGap })
  try {
    await openChart(page, fixture)
    await startPaintProbe(page, fixture)
    const paths = await page.evaluate(() => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const path = key => svg.querySelector(`[data-chart-indicator="${key}"]`)?.getAttribute('d') ?? ''
      const rsi6 = path('rsi6'), rsi12 = path('rsi12'), rsi24 = path('rsi24'), atrPercent = path('atrPercent'), bbw = path('bbw')
      const rsi6Label = [...svg.querySelectorAll('text')].find(node => node.textContent === 'RSI(6)')
      const commands = value => value.match(/[ML][^ML]+/g) ?? []
      const x = command => Number.parseFloat(command.slice(1))
      return {
        rsi6, rsi12, atrPercent, bbw, rsi6Legend: rsi6Label?.parentElement?.querySelectorAll('text')[1]?.textContent,
        rsi6Points: commands(rsi6).length, rsi12Points: commands(rsi12).length,
        rsi6Segments: (rsi6.match(/M/g) ?? []).length, rsi12Segments: (rsi12.match(/M/g) ?? []).length,
        atrPoints: commands(atrPercent).length, bbwPoints: commands(bbw).length,
        atrSegments: (atrPercent.match(/M/g) ?? []).length, bbwSegments: (bbw.match(/M/g) ?? []).length,
        firstKnownX: commands(rsi6).length ? x(commands(rsi6)[0]) : null,
        expectedFirstKnownX: commands(rsi24).length >= 8 ? x(commands(rsi24)[7]) : null,
      }
    })
    assert.ok(paths.rsi6.length > 0, 'Six initial nulls must not hide the following 90 known RSI values.')
    assert.equal(paths.rsi6Points, 90)
    assert.equal(paths.rsi6Segments, 1)
    assert.equal(paths.rsi6Legend, fixture.series[fixture.timeframe].bars.at(-1).rsi6.toFixed(1), 'The latest known RSI reading must remain visible in its legend.')
    assert.equal(paths.firstKnownX, paths.expectedFirstKnownX, 'The known curve must begin at candle 7 rather than extend over warm-up samples.')
    assert.equal(paths.rsi12Points, 89)
    assert.equal(paths.rsi12Segments, 2, 'The curve must start a new segment after an interior missing sample.')
    assert.equal(paths.atrPoints, 89)
    assert.equal(paths.bbwPoints, 89)
    assert.equal(paths.atrSegments, 2, 'ATR% must preserve known segments around a missing native candle.')
    assert.equal(paths.bbwSegments, 2, 'BBW must preserve known segments around a missing native candle.')
    assert.doesNotMatch(paths.rsi6 + paths.rsi12 + paths.atrPercent + paths.bbw, /NaN|Infinity|undefined/)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    assertCompletePaints(await finishPaintProbe(page))
  } finally {
    await removePreparedTransform()
  }
})

test('a short listing remains usable while waiting for its chart to qualify for list admission', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installPreparedTransform({ mode: 'partial', instId: fixture.instId, end: fixture.end, intervalMS: fixture.intervalMS })
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
    assert.equal(await page.locator(`[aria-label="View ${fixture.instId} chart"]`).count(), 0,
      'Unknown statistic panels keep the candidate out of the ready chart list.')
    await selectTimeframe(page, fixture.timeframe)
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.dataset.chartRenderedBars === '12')
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
  const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
  assert.equal(await chart.getAttribute('data-chart-oi-state'), 'unavailable')
  assert.equal(await chart.getAttribute('data-chart-taker-state'), 'unavailable')
  assert.equal(await chart.getAttribute('data-chart-oi-samples'), '0')
  assert.equal(await chart.getAttribute('data-chart-taker-samples'), '0')
  assert.equal(await chart.locator('svg[data-rendered-inst] [data-chart-taker="empty"]').count(), 1)
  const status = chart.locator('[data-chart-status]')
  assert.equal(await status.getByText('OI is not published for part of this range', { exact: true }).count(), 1)
  assert.equal(await status.getByText('Taker is not published for part of this range', { exact: true }).count(), 1)
  assertCompletePaints(await finishPaintProbe(page))
})
