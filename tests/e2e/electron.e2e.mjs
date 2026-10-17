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

test('a status-only chart poll retains bars in the renderer while reporting real repair state', async () => {
  const fixture = await request({ e2e: { action: 'seedPartialStatisticsChart' } })
  const full = await request({ chartInstId: fixture.instId, timeframe: fixture.timeframe, chartEndHour: fixture.end })
  assert.ok(full.bars.length > 0, 'The ordinary chart request must provide the canonical bar snapshot.')

  const status = await request({ chartInstId: fixture.instId, timeframe: fixture.timeframe, chartEndHour: fixture.end, chartStatusOnly: true })
  assert.deepEqual(status.bars, [], 'A progress poll must not serialize the chart series again.')
  assert.equal(status.statusAuthoritative, true)
  // The fixture has an intentionally missing indicator warm-up range. A
  // status-only response must report its real repair state, not replace it
  // with a false `ready` value while the renderer is still waiting.
  assert.notEqual(status.candleState, 'ready')
  assert.ok(['loading', 'retrying', 'unavailable', 'ready'].includes(status.statisticsState))
})

test('historical statistics recover when a newer cache preview overtakes their in-flight response', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const targetEnd = fixture.end - 12 * fixture.intervalMS

  // Reorder real native-chart replies at the IPC boundary. The initial reply
  // represents candles loaded before statistics arrived; a newer cache-only
  // preview then overtakes the first historical foreground read. Its older
  // range cannot hydrate the visible window, so rejecting the foreground
  // response must leave a retry scheduled even if React already rendered.
  await electron.evaluate(({ ipcMain }, { instId, targetEnd }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const race = {
      original, historicalRequests: 0, previewDelivered: false, staleDelivered: false,
      foregroundStarted: null, releaseForeground: null,
    }
    const foregroundStarted = new Promise(resolve => { race.foregroundStarted = resolve })
    const foregroundRelease = new Promise(resolve => { race.releaseForeground = resolve })
    const pending = (response, revision) => ({
      ...response, revision,
      bars: response.bars.map(bar => ({ ...bar, oi: null, buy: null, sell: null, statisticsSources: 0, statisticsObserved: false })),
      statisticsState: 'loading', oiState: 'loading', takerState: 'loading',
    })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartInstId !== instId) return original(event, value)
      if (value.preview && Number.isFinite(value.chartEndHour)) {
        await foregroundStarted
        const response = await original(event, value)
        race.previewDelivered = true
        return pending(response, 100_001)
      }
      if (!value.preview && value.chartEndHour === targetEnd) {
        race.historicalRequests += 1
        const response = await original(event, value)
        if (race.historicalRequests === 1) {
          race.foregroundStarted()
          await foregroundRelease
          race.staleDelivered = true
          return pending(response, 100_000)
        }
        return { ...response, revision: 100_001 }
      }
      const response = await original(event, value)
      return response.bars ? pending(response, 100_000) : response
    })
    globalThis.__chartStatisticsRace = race
  }, { instId: fixture.instId, targetEnd })

  try {
    const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
    await market.waitFor({ state: 'visible', timeout: 10_000 })
    await market.click()
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await chart.waitFor({ state: 'visible' })
    await page.waitForFunction(({ instId, end }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(end)
        && chart.getAttribute('data-chart-oi-samples') === '0'
    }, fixture)

    await chart.locator('[data-chart-plot]').dispatchEvent('wheel', { deltaY: 144 })
    await page.waitForFunction(({ instId, end, intervalMS, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(targetEnd)
        && Number(chart.getAttribute('data-chart-cache-start')) <= end - 900 * intervalMS
    }, { ...fixture, targetEnd })

    // The preview has now committed to React while the statistics request is
    // still in flight. Releasing its obsolete reply reproduces the lost-wake
    // condition without relying on timing or OKX/network availability.
    await electron.evaluate(() => globalThis.__chartStatisticsRace.releaseForeground())
    await page.waitForFunction(({ instId, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(targetEnd)
        && chart.getAttribute('data-chart-statistics-state') === 'ready'
        && chart.getAttribute('data-chart-oi-samples') === '96'
        && chart.getAttribute('data-chart-taker-samples') === '96'
        && chart.getAttribute('data-chart-loading') === 'false'
    }, { instId: fixture.instId, targetEnd }, { timeout: 5_000 })
    const race = await electron.evaluate(() => {
      const race = globalThis.__chartStatisticsRace
      return { historicalRequests: race.historicalRequests, previewDelivered: race.previewDelivered, staleDelivered: race.staleDelivered }
    })
    assert.equal(race.previewDelivered, true)
    assert.equal(race.staleDelivered, true)
    assert.ok(race.historicalRequests >= 2, 'The obsolete reply must trigger another foreground read.')
    assert.equal(await chart.locator('[data-chart-oi="complete"]').count(), 1)
    assert.equal(await chart.locator('[data-chart-taker="complete"]').count(), 1)
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      const race = globalThis.__chartStatisticsRace
      race.releaseForeground()
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', race.original)
      delete globalThis.__chartStatisticsRace
    })
  }
})

test('live statistics retry a failed full snapshot after a status-only completion', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await electron.evaluate(({ ipcMain }, { instId }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const race = { original, initialPoll: false, statusReplies: 0, fullFailures: 0, recoveredReads: 0 }
    const pending = response => ({
      ...response, revision: 200_000,
      bars: response.bars.map(bar => ({ ...bar, oi: null, buy: null, sell: null, statisticsSources: 0, statisticsObserved: false })),
      statisticsState: 'loading', oiState: 'loading', takerState: 'loading',
    })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartInstId !== instId || value.preview || value.chartEndHour !== undefined) return original(event, value)
      if (value.loadChart) return pending(await original(event, value))
      if (value.sinceRevision !== undefined) {
        const first = !race.initialPoll
        race.initialPoll = true
        const response = await original(event, value)
        if (first) return pending(response)
        race.statusReplies += 1
        return {
          ...response, bars: [], revision: 200_001,
          statisticsState: 'ready', oiState: 'ready', takerState: 'ready', statusAuthoritative: true,
        }
      }
      // Source completion has reached the status transport, but has not yet
      // reached the renderer's bars. One transient full-read failure must not
      // make the next poll claim that those newer bars were materialized.
      if (race.statusReplies && !race.fullFailures) {
        race.fullFailures += 1
        throw new Error('Transient full chart snapshot failure')
      }
      const response = await original(event, value)
      race.recoveredReads += 1
      return { ...response, revision: 200_001 }
    })
    globalThis.__liveChartStatisticsRace = race
  }, fixture)

  try {
    const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
    await market.waitFor({ state: 'visible', timeout: 10_000 })
    await market.click()
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await chart.waitFor({ state: 'visible' })
    await page.waitForFunction(({ instId, end }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(end)
        && chart.getAttribute('data-chart-statistics-state') === 'ready'
        && chart.getAttribute('data-chart-oi-samples') === '96'
        && chart.getAttribute('data-chart-taker-samples') === '96'
        && chart.getAttribute('data-chart-loading') === 'false'
    }, fixture, { timeout: 5_000 })
    const race = await electron.evaluate(() => {
      const race = globalThis.__liveChartStatisticsRace
      return { statusReplies: race.statusReplies, fullFailures: race.fullFailures, recoveredReads: race.recoveredReads }
    })
    assert.equal(race.fullFailures, 1)
    assert.ok(race.statusReplies >= 2, 'The renderer must poll again after the failed full read.')
    assert.ok(race.recoveredReads >= 1, 'A later full read must materialize the completed statistics.')
    assert.equal(await chart.locator('[data-chart-oi="complete"]').count(), 1)
    assert.equal(await chart.locator('[data-chart-taker="complete"]').count(), 1)
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      const race = globalThis.__liveChartStatisticsRace
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', race.original)
      delete globalThis.__liveChartStatisticsRace
    })
  }
})

test('older source gaps explain the OKX retention limit without plotting false zero Taker volume', async () => {
  const fixture = await request({ e2e: { action: 'seedHistoricalStatisticsBoundary' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click()
  const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
  await page.waitForFunction(({ instId, end }) => {
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    return chart?.getAttribute('data-chart-end') === String(end)
      && chart.getAttribute('data-chart-oi-state') === 'unavailable'
      && chart.getAttribute('data-chart-taker-state') === 'unavailable'
      && chart.getAttribute('data-chart-oi-samples') === '0'
      && chart.getAttribute('data-chart-taker-samples') === '0'
      && chart.getAttribute('data-chart-loading') === 'false'
  }, fixture)
  assert.equal(await chart.getByText('OKX 1h OI history is limited to 60 days', { exact: true }).count(), 1)
  assert.equal(await chart.getByText('OKX 1h Taker history is limited to 60 days', { exact: true }).count(), 1)
  assert.equal(await chart.locator('[data-chart-taker="empty"]').count(), 1)
})

test('an unrelated preview revision cannot strand an interior statistics gap while both sources report loading', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const targetEnd = fixture.end - 12 * fixture.intervalMS
  await electron.evaluate(({ ipcMain }, { instId, targetEnd, intervalMS }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const race = { original, fullReads: 0, statusReads: 0, revision: 300_000, releasePreview: null }
    const previewRelease = new Promise(resolve => { race.releasePreview = resolve })
    const partial = response => ({
      ...response, revision: 300_000,
      bars: response.bars.map(bar => bar.hour >= targetEnd - 35 * intervalMS && bar.hour <= targetEnd - 26 * intervalMS
        ? { ...bar, oi: null, buy: null, sell: null, statisticsSources: 0, statisticsObserved: false } : bar),
      statisticsState: 'loading', oiState: 'loading', takerState: 'loading',
    })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartInstId !== instId) return original(event, value)
      if (value.preview && value.chartEndHour !== undefined) {
        await previewRelease
        // This genuine older chart range ends before the visible window.
        // It advances the series revision without materializing that window.
        return { ...await original(event, value), revision: 300_001 }
      }
      const response = await original(event, value)
      if (!response.bars || value.preview) return response
      if (value.chartEndHour === targetEnd) {
        if (value.chartStatusOnly) {
          race.statusReads += 1
          return { ...response, bars: [], revision: race.revision, statisticsState: 'loading', oiState: 'loading', takerState: 'loading' }
        }
        race.fullReads += 1
        return race.fullReads === 1 ? partial(response) : { ...response, revision: race.revision }
      }
      return partial(response)
    })
    globalThis.__partialChartStatisticsRace = race
  }, { ...fixture, targetEnd })

  try {
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click()
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await page.waitForFunction(({ instId, end }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(end) && chart.getAttribute('data-chart-oi-samples') === '86'
    }, fixture)
    await chart.locator('[data-chart-plot]').dispatchEvent('wheel', { deltaY: 144 })
    await page.waitForFunction(({ instId, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-statistics-end') === String(targetEnd)
        && chart.getAttribute('data-chart-oi-samples') === '86'
        && chart.getAttribute('data-chart-taker-samples') === '86'
        && chart.getAttribute('data-chart-oi-state') === 'loading'
        && chart.getAttribute('data-chart-taker-state') === 'loading'
    }, { ...fixture, targetEnd })
    await electron.evaluate(() => globalThis.__partialChartStatisticsRace.releasePreview())
    await page.waitForFunction(({ instId, end, intervalMS }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return Number(chart?.getAttribute('data-chart-cache-start')) <= end - 900 * intervalMS
    }, fixture)
    // Only publish the newer progress revision after React has accepted the
    // distant preview. Both source statuses deliberately remain Loading;
    // the window's materialization revision must itself trigger a full read.
    await electron.evaluate(() => { globalThis.__partialChartStatisticsRace.revision = 300_001 })
    await page.waitForFunction(({ instId, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(targetEnd)
        && chart.getAttribute('data-chart-oi-samples') === '96'
        && chart.getAttribute('data-chart-taker-samples') === '96'
        && chart.getAttribute('data-chart-statistics-state') === 'ready'
        && chart.getAttribute('data-chart-loading') === 'false'
    }, { ...fixture, targetEnd }, { timeout: 5_000 })
    const race = await electron.evaluate(() => {
      const race = globalThis.__partialChartStatisticsRace
      return { fullReads: race.fullReads, statusReads: race.statusReads }
    })
    assert.ok(race.statusReads > 0)
    assert.equal(race.fullReads, 2, 'One new active-window revision requires one materialized read.')
    assert.equal(await chart.locator('[data-chart-oi="complete"]').count(), 1)
    assert.equal(await chart.locator('[data-chart-taker="complete"]').count(), 1)
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      const race = globalThis.__partialChartStatisticsRace
      race.releasePreview()
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', race.original)
      delete globalThis.__partialChartStatisticsRace
    })
  }
})

test('a same-revision loading status periodically reconciles an incomplete visible snapshot', async () => {
  const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const targetEnd = fixture.end - 12 * fixture.intervalMS
  await electron.evaluate(({ ipcMain }, { instId, targetEnd, intervalMS }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const { MarketService } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/services/market-service.js')
    const originalGet = MarketService.prototype.get
    const race = { original, MarketService, originalGet, fullReads: 0, statusReads: 0, sourceCalls: 0, firstReadAt: 0, refreshAfterMS: null }
    MarketService.prototype.get = function (path, parameters, ...rest) {
      if (parameters?.instId === instId && (path.endsWith('/open-interest-history') || path.endsWith('/taker-volume-contract'))) race.sourceCalls += 1
      return originalGet.call(this, path, parameters, ...rest)
    }
    const partial = response => ({
      ...response, revision: 400_000,
      bars: response.bars.map(bar => bar.hour >= targetEnd - 35 * intervalMS && bar.hour <= targetEnd - 26 * intervalMS
        ? { ...bar, oi: null, buy: null, sell: null, statisticsSources: 0, statisticsObserved: false } : bar),
      statisticsState: 'loading', oiState: 'loading', takerState: 'loading',
    })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      const response = await original(event, value)
      if (value.chartInstId !== instId || !response.bars || value.preview) return response
      if (value.chartEndHour === targetEnd) {
        if (value.chartStatusOnly) {
          race.statusReads += 1
          return { ...response, bars: [], revision: 400_000, statisticsState: 'loading', oiState: 'loading', takerState: 'loading' }
        }
        race.fullReads += 1
        if (race.fullReads === 1) {
          race.firstReadAt = Date.now()
          return partial(response)
        }
        race.refreshAfterMS = Date.now() - race.firstReadAt
        return { ...response, revision: 400_000 }
      }
      return partial(response)
    })
    globalThis.__sameRevisionChartRace = race
  }, { ...fixture, targetEnd })

  try {
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click()
    const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
    await page.waitForFunction(({ instId, end }) => document.querySelector(`[data-chart-inst="${instId}"]`)?.getAttribute('data-chart-end') === String(end), fixture)
    await chart.locator('[data-chart-plot]').dispatchEvent('wheel', { deltaY: 144 })
    await page.waitForFunction(({ instId, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-statistics-end') === String(targetEnd)
        && chart.getAttribute('data-chart-oi-samples') === '86'
        && chart.getAttribute('data-chart-taker-samples') === '86'
    }, { ...fixture, targetEnd })
    await page.waitForFunction(({ instId, targetEnd }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      return chart?.getAttribute('data-chart-end') === String(targetEnd)
        && chart.getAttribute('data-chart-oi-samples') === '96'
        && chart.getAttribute('data-chart-taker-samples') === '96'
        && chart.getAttribute('data-chart-statistics-state') === 'ready'
        && chart.getAttribute('data-chart-loading') === 'false'
    }, { ...fixture, targetEnd }, { timeout: 5_000 })
    const race = await electron.evaluate(() => {
      const race = globalThis.__sameRevisionChartRace
      return { fullReads: race.fullReads, statusReads: race.statusReads, sourceCalls: race.sourceCalls, refreshAfterMS: race.refreshAfterMS }
    })
    assert.equal(race.fullReads, 2, 'A partial same-revision snapshot needs one bounded cache reread.')
    assert.ok(race.statusReads > 0)
    assert.equal(race.sourceCalls, 0, 'Reconciling a persisted gap must not download OI/Taker again.')
    assert.ok(race.refreshAfterMS >= 1_000 && race.refreshAfterMS <= 1_500,
      `The snapshot refresh must stay bounded; observed ${race.refreshAfterMS}ms.`)
    assert.equal(await chart.locator('[data-chart-oi="complete"]').count(), 1)
    assert.equal(await chart.locator('[data-chart-taker="complete"]').count(), 1)
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      const race = globalThis.__sameRevisionChartRace
      race.MarketService.prototype.get = race.originalGet
      ipcMain.removeHandler('radar:request')
      ipcMain.handle('radar:request', race.original)
      delete globalThis.__sameRevisionChartRace
    })
  }
})
