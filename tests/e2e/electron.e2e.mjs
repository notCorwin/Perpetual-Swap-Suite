import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertCompletePaints, assertWorkspaceLayout, finishPaintProbe, installRequestProbe, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, startPaintProbe, waitForRendered, wheelBurst } from '../../scripts/chart-acceptance.mjs'

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
  const probe = { original, contents, originalSend, calls: 0 }
  const transform = response => {
    if (response?.instId !== options.instId || options.timeframe && response.timeframe !== options.timeframe) return response
    if (options.mode === 'terminal') return {
      ...response, endHour: null, latestEnd: null, oldestHour: options.end - 11 * options.intervalMS,
      historyExhausted: true, revision: 900_000, bars: [],
      oiState: 'unavailable', takerState: 'unavailable', indicatorState: 'unavailable', error: '',
      unavailable: { reason: 'insufficient-history', availableCandles: 12, requiredCandles: 96, retryAt: Date.now() + 60_000 },
    }
    if (options.mode === 'warmup') return { ...response, bars: response.bars.map(bar => ({
      ...bar,
      rsi6: bar.hour >= options.first && bar.hour <= options.warmupThrough ? null : bar.rsi6,
      rsi12: bar.hour >= options.first && bar.hour <= options.warmupThrough || bar.hour === options.interiorGap ? null : bar.rsi12,
    })) }
    if (options.mode === 'live' && response.endHour === response.latestEnd) {
      const last = response.bars.find(bar => bar.hour === response.endHour)
      return { ...response, liveBar: {
        ...last, hour: response.endHour + response.intervalMS,
        open: options.livePrice * .999, high: options.livePrice * 1.001, low: options.livePrice * .998, close: options.livePrice,
        confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null,
      } }
    }
    return response
  }
  ipcMain.removeHandler('radar:request')
  ipcMain.handle('radar:request', async (event, value) => {
    if (value.chartWindow?.instId === options.instId) probe.calls += 1
    const response = await original(event, value)
    return value.chartUniverse ? { ...response, frames: response.frames.map(transform) }
      : value.chartLocal || value.chartWindow ? transform(response) : response
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
  assert.equal(await page.title(), 'Perpetual Swap Radar')
  await page.locator('#root').waitFor({ state: 'attached' })
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.radarDesktop.request), 'function')
  assert.equal(await page.evaluate(() => typeof window.webkit?.messageHandlers?.radar), 'undefined')
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

test('completed candles round-trip through the Electron-owned Parquet store', async () => {
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

  // Reload so React obtains the row through exactly the same polling path as
  // an app user, then inspect the rendered table instead of the IPC object.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 10_000 })
  const cells = market.locator('td')
  assert.equal(await cells.count(), 3)
  assert.match((await cells.nth(0).textContent()) ?? '', /USDT/)
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
  await page.locator('[data-market-list]').getByText(/^Verifying \d+\/\d+$/).waitFor()

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
      const prepared = await request({ chartWindow: { instId: fixture.instId, timeframe, endHour: fixture.end } })
      const expected = new Map(fixture.series[timeframe].bars.map(bar => [bar.hour, bar]))
      const visible = prepared.bars.filter(bar => bar.hour >= fixture.end - 95 * fixture.series[timeframe].intervalMS && bar.hour <= fixture.end)
      assert.equal(visible.length, 96)
      for (const bar of visible) {
        const oracle = expected.get(bar.hour)
        for (const field of ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'oi', 'buy', 'sell']) {
          assert.ok(Number.isFinite(bar[field]), `${timeframe} ${bar.hour} ${field} must be initialized.`)
          assert.ok(Math.abs(bar[field] - oracle[field]) <= Math.max(1, Math.abs(oracle[field])) * 1e-10,
            `${timeframe} ${bar.hour} ${field} changed from its canonical initialization.`)
        }
        assert.equal(bar.statisticsObserved, true)
      }
    }
    const requests = await readRequestProbe(electron)
    assert.deepEqual(requests.sourceRequests.filter(call => call.path !== '/market/candles'), [], 'Complete durable periods must not be downloaded again; latest two-candle refreshes remain independent.')
  } finally { await removeRequestProbe(electron) }
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

test('high velocity wheel bursts and reversals present only complete correct charts in 5m, 15m, and 1h', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  for (const timeframe of fixture.timeframes) {
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, fixture, timeframe)
    await startPaintProbe(page, fixture)
    const intervalMS = fixture.series[timeframe].intervalMS
    await wheelBurst(page, { frames: 6, eventsPerFrame: 32, deltaY: 36 })
    await wheelBurst(page, { frames: 3, eventsPerFrame: 32, deltaY: -36 })
    const expectedEnd = fixture.end - 288 * intervalMS
    await waitForRendered(page, fixture, timeframe, expectedEnd)
    await wheelBurst(page, { deltaY: 14_400 })
    await waitForRendered(page, fixture, timeframe, expectedEnd - 1_200 * intervalMS)
    assertCompletePaints(await finishPaintProbe(page))
  }
})

test('a held history read keeps the last complete paint and coalesces every later wheel event into the latest target', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  await startPaintProbe(page, fixture)
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
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
    assert.deepEqual(requests.sourceRequests.filter(call => call.path !== '/market/candles'), [], 'Scrolling must reuse durable history, independently of latest-candle refresh timing.')
    assert.ok(requests.calls.length <= 12, `Coalesced history work unexpectedly issued ${requests.calls.length} requests.`)
    assert.ok(!report.commits.some(commit => commit.end === fixture.end - 1_200 * fixture.intervalMS), 'The obsolete held target was presented after a newer input.')
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

test('a late history response cannot overwrite a more recently selected timeframe', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await openChart(page, fixture)
  for (const timeframe of fixture.timeframes) {
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, fixture, timeframe)
  }
  await startPaintProbe(page, fixture)
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  try {
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
    assert.deepEqual(requests.sourceRequests.filter(call => call.path !== '/market/candles'), [], 'A fully local timeframe switch must reuse historical candles and statistics. Periodic latest two-candle refreshes are independent.')
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
    await startPaintProbe(page, fixture)
    const overlay = await page.evaluate(() => {
      const chart = document.querySelector('[data-chart-inst]')
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      const horizontalBorders = [...svg.querySelectorAll(':scope > line')].filter(line =>
        line.getAttribute('stroke') === 'var(--border)' && line.y1.baseVal.value === line.y2.baseVal.value
        && line.x1.baseVal.value !== line.x2.baseVal.value)
      const line = svg.querySelector('[data-chart-live-price]')
      return {
        bars: snapshot.bars.length, allConfirmed: snapshot.bars.every(bar => bar.confirmed),
        liveConfirmed: snapshot.liveBar?.confirmed, liveHour: snapshot.liveBar?.hour,
        lineY: Number(line?.getAttribute('y1')),
        expectedY: (Number(horizontalBorders[0].getAttribute('y1')) + Number(horizontalBorders[1].getAttribute('y1'))) / 2,
        countdown: svg.querySelector('[data-chart-countdown]')?.textContent,
      }
    })
    assert.equal(overlay.bars, 96)
    assert.equal(overlay.allConfirmed, true)
    assert.equal(overlay.liveConfirmed, false)
    assert.equal(overlay.liveHour, fixture.end + fixture.intervalMS)
    assert.ok(Math.abs(overlay.lineY - overlay.expectedY) < 1e-6, `The live price line must use its logarithmic price coordinate: ${JSON.stringify(overlay)}`)
    assert.match(overlay.countdown ?? '', /^\d{2}:\d{2}$/)
    await wheelBurst(page, { deltaY: 12 })
    await waitForRendered(page, fixture, fixture.timeframe, fixture.end - fixture.intervalMS)
    assert.equal(await page.locator('[data-chart-countdown]').count(), 0, 'Historical charts must not display a live countdown.')
    assert.equal(await page.evaluate(() => document.querySelector('[data-chart-inst]').__chartSnapshot.liveBar), undefined)
    assertCompletePaints(await finishPaintProbe(page))
  } finally {
    await removePreparedTransform()
  }
})

test('known RSI segments remain visible through indicator warm-up and internal missing samples', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  const first = fixture.end - 95 * fixture.intervalMS
  const warmupThrough = first + 5 * fixture.intervalMS
  const interiorGap = first + 50 * fixture.intervalMS
  fixture.series[fixture.timeframe].bars = fixture.series[fixture.timeframe].bars.map(bar => ({
    ...bar,
    rsi6: bar.hour >= first && bar.hour <= warmupThrough ? null : bar.rsi6,
    rsi12: bar.hour >= first && bar.hour <= warmupThrough || bar.hour === interiorGap ? null : bar.rsi12,
  }))
  await installPreparedTransform({ mode: 'warmup', instId: fixture.instId, timeframe: fixture.timeframe, first, warmupThrough, interiorGap })
  try {
    await openChart(page, fixture)
    await startPaintProbe(page, fixture)
    const paths = await page.evaluate(() => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const path = key => svg.querySelector(`[data-chart-indicator="${key}"]`)?.getAttribute('d') ?? ''
      const rsi6 = path('rsi6'), rsi12 = path('rsi12'), rsi24 = path('rsi24')
      const rsi6Label = [...svg.querySelectorAll('text')].find(node => node.textContent === 'RSI(6)')
      const commands = value => value.match(/[ML][^ML]+/g) ?? []
      const x = command => Number.parseFloat(command.slice(1))
      return {
        rsi6, rsi12, rsi6Legend: rsi6Label?.parentElement?.querySelectorAll('text')[1]?.textContent,
        rsi6Points: commands(rsi6).length, rsi12Points: commands(rsi12).length,
        rsi6Segments: (rsi6.match(/M/g) ?? []).length, rsi12Segments: (rsi12.match(/M/g) ?? []).length,
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
    assert.doesNotMatch(paths.rsi6 + paths.rsi12, /NaN|Infinity|undefined/)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    assertCompletePaints(await finishPaintProbe(page))
  } finally {
    await removePreparedTransform()
  }
})

test('a newly listed contract with fewer than 96 completed candles explains the limit and stops retrying', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await installPreparedTransform({ mode: 'terminal', instId: fixture.instId, end: fixture.end, intervalMS: fixture.intervalMS })
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click({ timeout: 15_000 })
    await selectTimeframe(page, fixture.timeframe)
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await chart.getByText('SOL-USDT has 12 completed 1h candles. A complete chart requires 96.', { exact: true }).waitFor()
    assert.equal(await chart.getAttribute('data-chart-loading'), 'false')
    assert.equal(await chart.locator('svg[data-rendered-inst]').count(), 0)
    assert.equal(await chart.locator('[data-slot="spinner"]').count(), 0)
    const callsAtTerminal = await electron.evaluate(() => globalThis.__preparedTransform.calls)
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1_100)))
    assert.equal(await electron.evaluate(() => globalThis.__preparedTransform.calls), callsAtTerminal, 'Known insufficient history must not become a retry loop after selecting the native timeframe.')
  } finally {
    await removePreparedTransform()
  }
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
  assert.equal(await chart.locator('[data-chart-taker="empty"]').count(), 1)
  assert.equal(await chart.getByText('OKX 1h OI history is incomplete for this range', { exact: true }).count(), 1)
  assert.equal(await chart.getByText('OKX 1h Taker history is incomplete for this range', { exact: true }).count(), 1)
  assertCompletePaints(await finishPaintProbe(page))
})
