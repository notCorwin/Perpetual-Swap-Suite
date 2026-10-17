import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

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

before(async () => {
  await launchElectron()
})
after(async () => { await electron?.close(); await rm(userData, { recursive: true, force: true }) })

test('desktop window loads the React workspace with a restricted renderer', async () => {
  assert.equal(await page.title(), 'Perpetual Swap Radar')
  await page.locator('#root').waitFor({ state: 'attached' })
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.radarDesktop.request), 'function')
  assert.equal(await page.evaluate(() => typeof window.webkit.messageHandlers.radar.postMessage), 'function')
})

test('preferences persist in the Electron-owned user-data directory', async () => {
  const saved = await request({ windowBlurRadius: 17, floatingBlurRadius: 23, notificationsEnabled: true })
  assert.equal(saved.windowBlurRadius, 17)
  assert.equal(saved.floatingBlurRadius, 23)
  assert.equal(saved.notificationsEnabled, true)
  const disk = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))
  assert.equal(disk.windowBlurRadius, 17)
  assert.equal(disk.notificationsEnabled, true)
})

test('completed candles round-trip through Parquet and chart IPC', async () => {
  const timestamp = Date.UTC(2024, 9, 16, 12, 0)
  const seed = await request({ e2e: { action: 'seedCandles', candles: [{ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 112, low: 99, close: 108, volume: 1234, confirmed: true }] } })
  assert.equal(seed.written, 1)
  const chart = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '5m', loadChart: true })
  assert.equal(chart.timeframe, '5m')
  assert.deepEqual(chart.bars.map(bar => [bar.hour, bar.close, bar.confirmed]), [[timestamp, 108, true]])
  const boundary = await request({ chartInstId: 'BTC-USDT-SWAP', timeframe: '5m', chartEndHour: timestamp - 300_000 })
  assert.equal(boundary.historyExhausted, true)
  assert.equal(boundary.oldestHour, timestamp)
  assert.equal(boundary.endHour, timestamp)
})

test('clipboard, screenshot capture, analysis settings, and safe gateway cancellation work', async () => {
  assert.deepEqual(await request({ copyText: 'Perpetual Swap Suite E2E' }), { ok: true })
  const image = await request({ captureChart: { x: 0, y: 0, width: 80, height: 60, output: 'png' } })
  assert.match(image.imageDataURL, /^data:image\/png;base64,/)
  assert.ok(image.width > 0 && image.height > 0)
  assert.deepEqual(await request({ analysisSettings: { action: 'save', model: 'test-model', apiKey: 'test-key' } }), { model: 'test-model', hasAPIKey: true })
  assert.deepEqual(await request({ analysisSettings: { action: 'read' } }), { model: 'test-model', hasAPIKey: true })
  assert.deepEqual(await request({ analysisSettings: { action: 'removeKey' } }), { model: 'test-model', hasAPIKey: false })
  await assert.rejects(() => request({ gatewayFetch: { id: 'missing-key', body: '{}' } }), /Save an AI Gateway API key/)
  assert.deepEqual(await request({ cancelGatewayFetch: 'no-such-request' }), { ok: true })
  assert.deepEqual(await request({ suite: { mode: 'radar', action: 'evaluate', timeframe: '5m' } }), { profiles: [], selectedID: '', confirmed: [], provisional: [], rows: [], revision: 0, timeframe: '5m' })
  const initial = await request({ rocPeriod: 9, marocPeriod: 9, timeframe: '5m', sinceRevision: -1 })
  assert.equal(initial.error, '')
  assert.deepEqual(initial.rows, [])
})

test('cached catalog projection renders real list OI, taker, and indicator readings', async () => {
  const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
  assert.equal(fixture.timeframe, '1H')

  // This is the renderer's ordinary radar request.  The fixture only writes
  // source/statistics cache rows and catalog context; it never injects a
  // ready-made market row.
  const projected = await waitFor(async () => {
    const snapshot = await request({ rocPeriod: 9, marocPeriod: 9, timeframe: fixture.timeframe, sinceRevision: -1 })
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
  await page.waitForFunction(instId => {
    const row = document.querySelector(`[aria-label="View ${instId} chart"]`)
    const cells = row?.querySelectorAll('td')
    return Boolean(cells && [3, 4, 5, 6].every(index => !cells[index].textContent?.includes('—')))
  }, fixture.instId)

  const cells = market.locator('td')
  const taker = (await cells.nth(3).textContent())?.trim() ?? ''
  const oi = (await cells.nth(4).textContent())?.trim() ?? ''
  const roc = (await cells.nth(5).textContent())?.trim() ?? ''
  const rsi = (await cells.nth(6).textContent())?.trim() ?? ''
  assert.match(taker, /%/)
  assert.match(oi, /%/)
  assert.match(roc, /%/)
  assert.match(rsi, /6\d+\.\d{2}/)
  assert.match(await cells.nth(3).getAttribute('title') ?? '', /^Taker contracts/)
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
  await page.waitForFunction(instId => {
    const row = document.querySelector(`[aria-label="View ${instId} chart"]`)
    const cells = row?.querySelectorAll('td')
    return Boolean(cells && [3, 4, 5, 6].every(index => !cells[index].textContent?.includes('—')))
  }, fixture.instId)

  const cells = market.locator('td')
  assert.match((await cells.nth(3).textContent())?.trim() ?? '', /%/)
  assert.match((await cells.nth(4).textContent())?.trim() ?? '', /%/)
  assert.match((await cells.nth(5).textContent())?.trim() ?? '', /%/)
  assert.match((await cells.nth(6).textContent())?.trim() ?? '', /6\d+\.\d{2}/)
  const snapshot = await request({ rocPeriod: 9, marocPeriod: 9, timeframe: '1H', sinceRevision: -1 })
  assert.equal(snapshot.catalogSource, 'cache')
  assert.equal(snapshot.loading, true, 'The delayed production-style discovery must still be running.')
  await page.waitForFunction(() => document.querySelector('[aria-live="polite"]')?.textContent?.includes('Cached'))

  // Do not let the deliberately delayed discovery leak into the following
  // fixture: restore a deterministic test-mode process after this assertion.
  await electron.close()
  await launchElectron()
})

test('partially cached OI and Taker samples remain visibly plotted while statistics are incomplete', async () => {
  const fixture = await request({ e2e: { action: 'seedPartialStatisticsChart' } })
  assert.equal(fixture.visibleBars, 96)
  assert.equal(fixture.oiSamples, 8)
  assert.equal(fixture.takerSamples, 8)

  // Reload after the test-only main-process fixture is ready so this uses the
  // same market-list selection path a user uses, rather than only chart IPC.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 10_000 })
  await market.click()

  const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
  await chart.waitFor({ state: 'visible' })
  await page.waitForFunction(({ instId, start, end }) => {
    const element = document.querySelector(`[data-chart-inst="${instId}"]`)
    return element?.getAttribute('data-chart-start') === String(start) && element.getAttribute('data-chart-end') === String(end)
  }, fixture)

  const oi = chart.locator('[data-chart-oi="partial"]')
  await oi.waitFor({ state: 'visible' })
  assert.equal(await oi.locator('[data-chart-oi-sample]').count(), fixture.oiSamples)

  const taker = chart.locator('[data-chart-taker="partial"]')
  await taker.waitFor({ state: 'visible' })
  assert.ok((await taker.locator('path').first().getAttribute('d'))?.length)
})
