import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertWorkspaceLayout, selectTimeframe, captureChartViewport, chartViewportHours, chartViewportX, assertChartViewport, assertCompleteChartViewport } from '../../scripts/chart-acceptance.mjs'

const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-workspace-e2e-'))
let electron, page, settingsWindow

before(async () => {
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  if (process.env.PERPETUAL_SWAP_E2E_FAST_FAILURE) page.setDefaultTimeout(2_000)
  await page.waitForLoadState('domcontentloaded')
  // Stub only the desktop boundary. These renderer checks remain independent
  // of source downloads, persistence workers, and any configured AI service.
  await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const { encodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
    const preferences = { chartDisplayMode: 'multi', showBollingerPriceLabels: false, rankingLookback: 15, historyDays: 30, liquidity: {
      spread: { enabled: true, maxPercent: .05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: true, maxPercent: .1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
      openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 },
    } }
    const rows = [['BETA', -3], ['ZETA', 3], ['ALPHA', 1], ['NULL', null]].map(([symbol, rankingChange]) => ({
      instId: `${symbol}-USDT-SWAP`, tickSz: null, price: 100, lastPrice: 100, rankingChange, rankingAsOf: 1_800_000_000_000,
      turnover24hUSDT: 50_000_000,
    }))
    const state = globalThis.__workspaceFixture = { preferences, rows, initialRows: rows, requests: [], coldTimeframes: [], revision: 1, loading: false, error: '', realtimeState: 'live', updatedAt: 1_800_000_000_000, catalogSource: 'live', catalogProgress: undefined, failNextSave: false, failSnapshots: 0, staleNextSnapshot: false, staleReplies: 0, chartGeneration: 1, bollMode: 'standard', holdNextSnapshot: false, releaseSnapshot: null, snapshotActive: 0, snapshotMaximum: 0,
      holdAuditAction: null, releaseAudit: null, heldAuditReply: null,
      holdDownloadAction: null, releaseDownload: null, heldDownloadReply: null,
      historyDownload: { schemaVersion: 2, phase: 'idle', startedAt: null, updatedAt: null, finishedAt: null,
        contracts: { completed: 0, total: 0 }, streams: { completed: 0, total: 0 },
        progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 },
        active: [], failures: [], error: '', revision: 0, serviceSession: 'download-fixture' },
      audit: { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '', revision: 0, serviceSession: 'audit-fixture' } }
    state.sendChart = frame => BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', encodeChartWire(frame))
    state.notify = () => {
      state.rows = [...state.rows].sort((left, right) => (right.rankingChange == null ? -1 : Math.abs(right.rankingChange))
        - (left.rankingChange == null ? -1 : Math.abs(left.rankingChange)) || left.instId.localeCompare(right.instId, 'en'))
      BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    }
    state.publishAudit = values => {
      state.audit = { ...state.audit, ...structuredClone(values), revision: state.audit.revision + 1 }
      const report = structuredClone(state.audit)
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('radar:audit-changed', report)
      return report
    }
    state.publishDownload = values => {
      state.historyDownload = { ...state.historyDownload, ...structuredClone(values), revision: state.historyDownload.revision + 1 }
      const report = structuredClone(state.historyDownload)
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('radar:history-download-changed', report)
      return report
    }
    state.viewportBars = {}
    const prepared = ({ instId, timeframe, windowBars = state.viewportBars[`${timeframe}:${instId}`] ?? 96 }) => {
      if (state.chartOverride?.instId === instId && state.chartOverride.timeframe === timeframe) return structuredClone(state.chartOverride)
      const intervalMS = timeframe === '1H' ? 3_600_000 : timeframe === '15m' ? 900_000 : 300_000
      const endHour = Math.floor(Date.UTC(2026, 9, 18) / intervalMS) * intervalMS
      const bars = Array.from({ length: windowBars }, (_, index) => {
        const close = state.bollMode === 'constant' ? 100 : 100 + index * .01
        return { hour: endHour - (windowBars - 1 - index) * intervalMS, open: close + (index % 2 ? -.05 : .05), high: close + .2, low: close - .2, close,
          confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
          ema: close, bollUpper: state.bollMode === 'constant' ? 100 : close + .5,
          bollMiddle: state.bollMode === 'constant' ? 100 : close, bollLower: state.bollMode === 'negative' ? -1 : state.bollMode === 'constant' ? 100 : close - .5,
          roc: .5, maroc: .25, rsi6: 50, rsi12: 55, rsi24: 60, atrPercent: .4 / close * 100, bbw: state.bollMode === 'constant' ? 0 : state.bollMode === 'negative' ? (close + 1.5) / close * 100 : 1 / close * 100, oi: 1_000_000 + index, buy: 12_000, sell: 10_000 }
      })
      return { instId, timeframe, windowBars, intervalMS, endHour, latestEnd: endHour, oldestHour: bars[0].hour, historyExhausted: true,
        generation: state.chartGeneration, revision: state.chartGeneration, bars, oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '' }
    }
    ipcMain.removeHandler('radar:request')
    state.request = async (_event, value) => {
      state.requests.push(value)
      if (value.statusLog) return { ok: true }
      if (value.preferences) {
        if (value.preferences.action === 'update') {
          if (state.failNextSave) { state.failNextSave = false; throw new Error('The preferences could not be saved.') }
          state.preferences = { ...state.preferences, ...value.preferences.values }
          state.revision += 1
          for (const window of BrowserWindow.getAllWindows()) window.webContents.send('radar:preferences-changed', state.preferences)
        }
        return state.preferences
      }
      if (value.snapshot) {
        if (state.failSnapshots > 0) { state.failSnapshots--; throw new Error('Snapshot temporarily unavailable.') }
        const stale = state.staleNextSnapshot
        state.staleNextSnapshot = false
        if (stale) state.staleReplies += 1
        const snapshot = state.marketSnapshot(stale)
        state.snapshotActive += 1
        state.snapshotMaximum = Math.max(state.snapshotMaximum, state.snapshotActive)
        try {
          if (state.holdNextSnapshot) {
            state.holdNextSnapshot = false
            await new Promise(resolve => { state.releaseSnapshot = resolve })
            state.releaseSnapshot = null
          }
          return snapshot
        } finally { state.snapshotActive -= 1 }
      }
      if (value.chartUniverse) return { frames: state.preparedFrames() }
      if (value.chartFocus) {
        const target = value.chartFocus.target
        if (target) {
          state.viewportBars[`${target.timeframe}:${target.instId}`] = target.windowBars ?? 96
          if (!state.coldTimeframes.includes(target.timeframe)) state.sendChart(prepared(target))
        }
        return { ok: true }
      }
      if (value.chartLocal || value.chartHistory) {
        const query = value.chartLocal ?? value.chartHistory
        return state.coldTimeframes.includes(query.timeframe) ? null : prepared(query)
      }
      if (value.screenshot) {
        if (state.holdCapture) { state.holdCapture = false; await new Promise(resolve => { state.releaseCapture = resolve }); state.releaseCapture = null }
        if (state.failScreenshot) { state.failScreenshot = false; throw new Error('clipboard unavailable') }
        return { ok: true }
      }
      if (value.copyImage) return { ok: true }
      if (value.historyDownload) {
        const action = value.historyDownload.action
        if (action === 'start') state.publishDownload({ id: 'download-1', phase: 'running', startedAt: 1_800_000_000_000, updatedAt: 1_800_000_001_000, finishedAt: null,
          contracts: { completed: 0, total: 2 }, streams: { completed: 1, total: 18 },
          progress: { checked: 100, total: 1_000, available: 90, empty: 0, unavailable: 10, failed: 0, reused: 80, pending: 900 }, failures: [], error: '',
          active: [{ instrument: 'BETA-USDT-SWAP', timeframe: '15m', source: 'oi', from: 1_799_990_100_000, through: 1_799_991_000_000,
            status: 'retrying', attempts: 2, nextAttemptAt: 1_800_000_005_000, error: 'Temporary source limit.' }] })
        if (action === 'cancel') state.publishDownload({ phase: 'cancelled', active: [], finishedAt: 1_800_000_010_000 })
        const report = structuredClone(state.historyDownload)
        if (state.holdDownloadAction === action) {
          state.holdDownloadAction = null; state.heldDownloadReply = report
          await new Promise(resolve => { state.releaseDownload = resolve })
          state.releaseDownload = null
        }
        return report
      }
      if (value.dataAudit) {
        const action = value.dataAudit.action
        if (action === 'start') state.publishAudit({ id: 'audit-1', phase: 'running', progress: { completed: 1, total: 3 }, issues: [], error: '' })
        if (action === 'cancel') state.publishAudit({ phase: 'cancelled', issues: [{ instrument: 'BETA-USDT-SWAP', timeframe: '5m', from: 1_800_000_000_000, through: 1_800_000_300_000, reason: 'Missing completed candle', repairable: true }] })
        if (action === 'repair') state.publishAudit({ phase: 'completed', progress: { completed: 3, total: 3 }, issues: [] })
        const report = structuredClone(state.audit)
        if (state.holdAuditAction === action) {
          state.holdAuditAction = null; state.heldAuditReply = report
          await new Promise(resolve => { state.releaseAudit = resolve })
          state.releaseAudit = null
        }
        return report
      }
      throw new Error(`Unsupported renderer fixture operation: ${Object.keys(value).join(', ')}`)
    }
    state.marketSnapshot = stale => ({ rows: stale ? [] : state.rows, turnoverOrder: [...state.rows].sort((a, b) => (b.turnover24hUSDT ?? -1) - (a.turnover24hUSDT ?? -1) || a.instId.localeCompare(b.instId, 'en')).map(row => row.instId), revision: state.revision - (stale ? 1 : 0), serviceSession: 'renderer-fixture',
      realtimeState: state.realtimeState, updatedAt: state.updatedAt,
      catalogSource: state.catalogSource, catalogProgress: state.catalogProgress, error: state.error, loading: state.loading })
    state.preparedFrames = () => state.rows.flatMap(({ instId }) => ['5m', '15m', '1H']
      .filter(timeframe => !state.coldTimeframes.includes(timeframe)).map(timeframe => prepared({ instId, timeframe })))
    // Resume barriers must use the same fixture as ordinary desktop requests.
    // Fence any in-flight real-backend restore before replacing its boundary.
    await globalThis.__presentationTest.setActive(false)
    globalThis.__marketBackend.presentation = async (active, epoch) => active ? {
      market: state.marketSnapshot(false), frames: state.preparedFrames(), preferences: state.preferences,
      audit: structuredClone(state.audit), download: structuredClone(state.historyDownload),
    } : { epoch }
    await globalThis.__presentationTest.setActive(true)
    ipcMain.handle('radar:request', async (event, value) => {
      const result = await state.request(event, value)
      return value.chartUniverse || value.chartLocal || value.chartHistory ? encodeChartWire(result) : result
    })
  })
  await page.setViewportSize({ width: Number(process.env.PERPETUAL_SWAP_UI_INITIAL_WIDTH ?? 800), height: Number(process.env.PERPETUAL_SWAP_UI_INITIAL_HEIGHT ?? 572) })
  // Observe capture replies at the renderer boundary without changing the
  // production bridge or the returned values used by the application.
  await page.addInitScript(() => {
    window.__captureReplies = 0
    const define = Object.defineProperty
    Object.defineProperty = function (target, key, descriptor) {
      if (target === window && key === 'radarDesktop') {
        Object.defineProperty = define
        const original = descriptor.value
        descriptor.value = Object.freeze({ ...original, request: (...args) => {
          const reply = original.request(...args)
          if (!args[0]?.screenshot) return reply
          return reply.then(value => { window.__captureReplies++; return value }, error => { window.__captureReplies++; throw error })
        } })
      }
      return define(target, key, descriptor)
    }
  })
  // Install before mounting so renderer timers and performance.now() share one clock.
  await page.clock.install()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
  if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await mkdir(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, { recursive: true })
})
afterEach(async context => {
  if (!page) return
  if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `checkpoint-${context.name.slice(0, 35).replace(/[^a-z0-9]/gi, '-')}.png`) })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  if (settingsWindow && !settingsWindow.isClosed()) {
    const discard = settingsPage().getByRole('button', { name: 'Discard changes', exact: true })
    if (await discard.isVisible() && await discard.isEnabled()) await discard.click()
    await backToMarkets()
  }
})
after(async () => {
  try {
    if (page && process.env.PERPETUAL_SWAP_SETTINGS_SCREENSHOTS) {
      const directory = process.env.PERPETUAL_SWAP_SETTINGS_SCREENSHOTS
      await mkdir(directory, { recursive: true })
      await page.setViewportSize({ width: 1_600, height: 1_000 })
      await openSettings()
      for (const [category, file] of [['Workspace', 'workspace'], ['Liquidity filters', 'liquidity'], ['Market data', 'data']]) {
        await chooseSettingsCategory(category)
        await settingsWindow.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await settingsWindow.screenshot({ path: join(directory, `settings-page-${file}.png`) })
      }
    }
  } finally { await electron?.close(); await rm(userData, { recursive: true, force: true }) }
})

const selected = () => page.locator('[data-market-index][aria-selected="true"]')

test('contract header remains distinct from an adjacent selected row', async () => {
  try {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      const styles = await page.locator('[data-market-list]').evaluate(list => {
        const header = list.querySelector('thead')
        const heading = header.querySelector('th')
        const row = list.querySelector('[data-market-index][aria-selected="true"]')
        const cell = row.querySelector('td')
        const lastHeading = header.querySelector('th:last-child')
        const lastCell = row.querySelector('td:last-child')
        return {
          headerBackground: getComputedStyle(header).backgroundColor,
          selectedBackground: getComputedStyle(row).backgroundColor,
          headerColor: getComputedStyle(heading).color,
          rowColor: getComputedStyle(cell).color,
          leftPadding: [getComputedStyle(heading).paddingLeft, getComputedStyle(cell).paddingLeft],
          rightPadding: [getComputedStyle(lastHeading).paddingRight, getComputedStyle(lastCell).paddingRight],
        }
      })
      assert.notEqual(styles.headerBackground, styles.selectedBackground, `${colorScheme}: header and selected row must not merge`)
      assert.notEqual(styles.headerColor, styles.rowColor, `${colorScheme}: headings must be visually distinct from values`)
      assert.deepEqual(styles.leftPadding, ['12px', '12px'])
      assert.deepEqual(styles.rightPadding, ['12px', '12px'])
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.locator('[data-market-list]').screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `contract-list-${colorScheme}.png`) })
    }
  } finally { await page.emulateMedia({ colorScheme: null }) }
})
const waitForMarketStatus = status => waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.some(value => value.statusLog?.status === expected), status.startsWith('Verifying ') ? 'Verifying' : status.startsWith('Updating ') ? 'Updating' : status)
const settingsPage = () => settingsWindow.getByRole('main', { name: 'Settings', exact: true })
const chooseSettingsCategory = async category => {
  const settings = settingsPage()
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('link', { name: category, exact: true }).click()
  await settings.getByRole('heading', { name: category, exact: true, level: 2 }).waitFor()
}
const openSettings = async (category = 'Workspace') => {
  if (!settingsWindow || settingsWindow.isClosed()) {
    const opened = electron.waitForEvent('window')
    await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-settings').click())
    settingsWindow = await opened
    if (process.env.PERPETUAL_SWAP_E2E_FAST_FAILURE) settingsWindow.setDefaultTimeout(2_000)
  }
  let settings = settingsPage()
  await settings.waitFor({ state: 'visible' })
  await chooseSettingsCategory(category)
  return settings
}
const backToMarkets = async () => {
  if (!settingsWindow || settingsWindow.isClosed()) return
  const closed = settingsWindow.waitForEvent('close')
  await settingsWindow.evaluate(() => window.radarDesktop.closeSettingsWindow())
  await closed
  await page.locator('[data-market-list]').waitFor({ state: 'visible' })
}
const candleTarget = async (position, fixture) => {
  const viewport = await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).evaluate(captureChartViewport)
  const available = new Set([...fixture.bars, ...(fixture.liveBar ? [fixture.liveBar] : [])].map(bar => bar.hour))
  viewport.expectedHours = chartViewportHours(viewport).filter(hour => available.has(hour))
  assert.deepEqual(viewport.bars.map(bar => bar.hour), viewport.expectedHours)
  const clip = await page.locator('[data-acceptance-target] svg[data-rendered-inst] clipPath[id$="-content"] rect').evaluate(rect => ({
    left: Number(rect.getAttribute('x')), width: Number(rect.getAttribute('width')),
  }))
  const fullHours = viewport.expectedHours.filter(hour => {
    const center = chartViewportX(viewport, hour)
    return center - viewport.barWidth / 2 >= clip.left - .01 && center + viewport.barWidth / 2 <= clip.left + clip.width + .01
  })
  assert.ok(fullHours.length > 2, 'Pointer fixtures must contain fully visible candle bodies.')
  const hour = position === 'first' ? fullHours[0] : position === 'middle' ? fullHours[Math.floor(fullHours.length / 2)]
    : position === 'previous' ? fullHours.at(-2) : fullHours.at(-1)
  const target = await page.locator('[data-acceptance-target] svg[data-rendered-inst]').evaluate((svg, x) => {
    const point = svg.createSVGPoint()
    point.x = x; point.y = svg.viewBox.baseVal.height * .1
    const screen = point.matrixTransform(svg.getScreenCTM())
    return { x: screen.x, y: screen.y }
  }, chartViewportX(viewport, hour))
  const expected = [...fixture.bars, ...(fixture.liveBar ? [fixture.liveBar] : [])].find(bar => bar.hour === hour)
  assert.ok(expected, 'The drawn candle must have an independent desktop-fixture observation.')
  return { ...target, hour, close: expected.close }
}
const clickByRect = async locator => {
  await locator.scrollIntoViewIfNeeded()
  const bounds = await locator.boundingBox()
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, 'The control must have a rendered pointer target.')
  const hitTest = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect(), target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { acceptsPointer: target === element || element.contains(target), target: target?.tagName, role: target?.getAttribute('role'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  assert.equal(hitTest.acceptsPointer, true, `The control must receive pointer input at its drawn center: ${JSON.stringify(hitTest)}`)
  const target = await locator.boundingBox()
  await settingsWindow.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
}

test('default selection uses absolute completed-candle change with nulls last and stable contract ties', async () => {
  const rankingHeader = page.getByRole('columnheader', { name: /15m change.*By magnitude/ })
  assert.equal(await rankingHeader.getAttribute('aria-sort'), 'other')
  assert.deepEqual(await page.locator('[data-market-index]').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label'))), [
    'View BETA-USDT-SWAP chart', 'View ZETA-USDT-SWAP chart', 'View ALPHA-USDT-SWAP chart', 'View NULL-USDT-SWAP chart',
  ])
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
  assert.deepEqual(await page.locator('[data-chart-inst="BETA-USDT-SWAP"]').evaluateAll(charts => charts.map(chart => chart.querySelector('svg[data-rendered-timeframe]')?.dataset.renderedTimeframe)), ['1H', '15m', '5m'])
  const changes = await page.locator('[data-market-index] td:last-child').allTextContents()
  assert.equal(changes[0].trim(), '-3.00%')
  assert.equal(changes[1].trim(), '+3.00%')
  assert.equal(changes[3].trim(), '—')
  const changesRendered = await page.locator('[data-market-change]').evaluateAll(labels => labels.map(label => ({
    direction: label.dataset.marketChange, background: getComputedStyle(label).backgroundColor,
    foreground: getComputedStyle(label).color, accessible: label.getAttribute('aria-label'),
    fits: label.scrollWidth <= label.clientWidth, tag: label.tagName,
    radius: getComputedStyle(label).borderRadius,
    paddingLeft: parseFloat(getComputedStyle(label).paddingLeft),
    paddingRight: parseFloat(getComputedStyle(label).paddingRight),
  })))
  assert.deepEqual(changesRendered.map(label => label.direction), ['down', 'up', 'up', 'unavailable'])
  assert.equal(changesRendered[0].background, 'rgba(0, 0, 0, 0)')
  assert.equal(changesRendered[1].background, 'rgba(0, 0, 0, 0)')
  assert.equal(changesRendered[0].foreground, 'rgb(223, 72, 76)')
  assert.equal(changesRendered[1].foreground, 'rgb(68, 151, 130)')
  assert.match(changesRendered[0].accessible, /down/)
  assert.match(changesRendered[1].accessible, /up/)
  assert.match(changesRendered[3].accessible, /unavailable/)
  assert.ok(changesRendered.every(label => label.fits), 'Change values must fit their cells.')
  assert.ok(changesRendered.every(label => label.tag === 'TD' && label.radius === '0px' && label.paddingLeft > 0 && label.paddingRight > 0),
    'Change values must retain the table cell spacing.')
  await assertWorkspaceLayout(page)
})

test('market change values preserve direction and fit at minimum window width', async () => {
  const publish = rows => electron.evaluate((_electron, rows) => {
    const state = globalThis.__workspaceFixture
    state.rows = rows; state.revision += 1; state.notify()
  }, rows)
  const initialRows = await electron.evaluate(() => globalThis.__workspaceFixture.initialRows)
  const originalSize = page.viewportSize()
  try {
    await page.setViewportSize({ width: 1200, height: 640 })
    await publish(initialRows.map(row => ({ ...row, rankingChange: row.instId.startsWith('BETA-') ? -.001 : row.instId.startsWith('ZETA-') ? .001 : row.instId.startsWith('ALPHA-') ? 0 : null })))
    const beta = page.locator('[aria-label="View BETA-USDT-SWAP chart"] [data-market-change]')
    const zeta = page.locator('[aria-label="View ZETA-USDT-SWAP chart"] [data-market-change]')
    const alpha = page.locator('[aria-label="View ALPHA-USDT-SWAP chart"] [data-market-change]')
    const missing = page.locator('[aria-label="View NULL-USDT-SWAP chart"] [data-market-change]')
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] [data-market-change]')?.textContent === '-0.00%')
    assert.equal(await beta.textContent(), '-0.00%')
    assert.equal(await zeta.textContent(), '+0.00%')
    assert.equal(await alpha.textContent(), '0.00%')
    assert.equal(await alpha.getAttribute('data-market-change'), 'flat')
    assert.equal(await missing.getAttribute('data-market-change'), 'unavailable')
    assert.equal(await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').getAttribute('aria-selected'), 'true')
    assert.ok(await page.locator('[data-market-change]').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth)))
  } finally {
    await publish(initialRows)
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] [data-market-change]')?.textContent === '-3.00%')
    if (originalSize) await page.setViewportSize(originalSize)
  }
})

test('market arrow shortcuts survive contract clicks, toolbar focus and repeated chart switches', async () => {
  const expectMarket = async (key, symbol) => {
    await page.keyboard.press(key)
    await page.locator(`[data-timeframe-panel="1H"] svg[data-rendered-inst="${symbol}-USDT-SWAP"]`).waitFor({ state: 'visible', timeout: 2_000 })
    assert.equal(await selected().getAttribute('aria-label'), `View ${symbol}-USDT-SWAP chart`)
    assert.equal(await page.locator('[data-timeframe-panel="1H"] [data-chart-plot]').evaluate(plot => document.activeElement === plot), true,
      'Chart navigation must retain focus on the current chart surface.')
  }
  try {
    await page.getByRole('row', { name: 'View ZETA-USDT-SWAP chart', exact: true }).click()
    await expectMarket('ArrowDown', 'ALPHA')
    await expectMarket('ArrowUp', 'ZETA')
    await page.locator('[data-timeframe-panel="15m"] [data-chart-plot]').focus()
    await expectMarket('ArrowRight', 'ALPHA')
    await page.getByRole('button', { name: 'Screenshot', exact: true }).focus()
    await expectMarket('ArrowLeft', 'BETA')
    await expectMarket('ArrowUp', 'NULL')
    await expectMarket('ArrowDown', 'BETA')
    await page.getByRole('button', { name: 'Screenshot', exact: true }).click()
    await expectMarket('ArrowDown', 'ZETA')
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    await expectMarket('ArrowDown', 'ALPHA')
  } finally {
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
  }
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
    'DOM focus regressions must be exercised without acquiring macOS window focus.')
})

test('chart and settings retain their keyboard behavior', async () => {
  try {
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
    await page.locator('[data-timeframe-panel="1H"] svg[data-rendered-inst]').click({ position: { x: 50, y: 50 } })
    assert.equal(await page.locator('[data-timeframe-panel="1H"] [data-chart-plot]').evaluate(plot => document.activeElement === plot), true,
      'A chart click must explicitly transfer DOM focus after preventing pointer defaults for inspection.')
    await page.keyboard.press('ArrowDown')
    await page.locator('[data-timeframe-panel="1H"] svg[data-rendered-inst="ZETA-USDT-SWAP"]').waitFor({ state: 'visible', timeout: 2_000 })
    for (const key of ['Shift+ArrowDown', 'Control+ArrowDown', 'Meta+ArrowDown', 'Alt+ArrowDown']) await page.keyboard.press(key)
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart')
    await page.locator('[data-timeframe-panel="1H"] [data-chart-plot]').dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true })
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart')
    const settings = await openSettings()
    const lookback = settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)', exact: true })
    await lookback.focus()
    await settingsWindow.keyboard.press('ArrowUp')
    assert.equal(await lookback.inputValue(), '16')
    assert.equal(await page.locator('[data-timeframe-panel="1H"] [data-chart-inst]').getAttribute('data-chart-inst'), 'ZETA-USDT-SWAP')
    await settings.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await backToMarkets()
    await page.keyboard.press('ArrowDown')
    await page.locator('[data-timeframe-panel="1H"] svg[data-rendered-inst="ALPHA-USDT-SWAP"]').waitFor({ state: 'visible', timeout: 2_000 })
  } finally {
    if (settingsWindow && !settingsWindow.isClosed()) {
      const discard = settingsPage().getByRole('button', { name: 'Discard changes', exact: true })
      if (await discard.isEnabled()) await discard.click()
      await backToMarkets()
    }
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
  }
})

test('the existing chart toolbar provides window dragging while its controls remain interactive', async () => {
  const toolbar = page.locator('[data-chart-panel] [data-chart-toolbar]')
  await assertWorkspaceLayout(page)
  assert.equal(await toolbar.evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'drag')
  for (const name of ['Screenshot']) {
    assert.equal(await toolbar.getByRole('button', { name, exact: true }).evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
  }
  assert.equal(await toolbar.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).count(), 1)
  const sidebar = page.getByRole('complementary', { name: 'Contract list' })
  assert.equal(await sidebar.isVisible(), true)
  assert.equal(await toolbar.getByRole('link', { name: 'Settings', exact: true }).count(), 0)
  const settings = await openSettings()
  assert.equal(await page.locator('[data-market-list]').isVisible(), true)
  assert.equal(await settings.getByRole('heading', { name: 'Settings', level: 1, exact: true }).count(), 1)
  await backToMarkets()
})

test('a prepared idle chart makes no periodic window requests and accepts a pushed forming candle', async () => {
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')
  await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.dataset.chartLoading === 'false')
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length), before, 'A successfully prepared chart must not poll local or provider windows.')
  await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const state = globalThis.__workspaceFixture
    state.chartGeneration += 1
    const frame = await globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    const last = frame.bars.at(-1)
    frame.liveBar = { ...last, hour: frame.endHour + frame.intervalMS, open: 133, high: 134, low: 132, close: 133,
      confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null }
    globalThis.__workspaceFixture.sendChart(frame)
  })
  await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close === 133)
  const priceLabel = chart.locator('[data-chart-price-label]')
  await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-price-label]')?.getAttribute('data-chart-price-direction') === 'flat')
  assert.equal(await priceLabel.locator('[data-chart-price-label-background]').getAttribute('fill'), 'var(--chart-annotation)')
  assert.equal(await priceLabel.locator('[data-chart-price-label-value]').getAttribute('fill'), 'var(--foreground)')
  await assertCompleteChartViewport(page, 'BETA-USDT-SWAP', { fullSlots: null })
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length), before + 1, 'Only the fixture read may be added; the pushed candle must not trigger another renderer read.')
  const liveUpdate = await page.evaluate(() => {
    const snapshot = document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]').__chartSnapshot
    globalThis.__completedSubscriptionBars = snapshot.bars
    return { type: 'live', instId: snapshot.instId, timeframe: snapshot.timeframe, generation: snapshot.generation, revision: snapshot.generation + 1,
      endHour: snapshot.endHour, liveBar: { ...snapshot.liveBar, high: 136, close: 135 } }
  })
  const reads = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length)
  assert.equal('bars' in liveUpdate, false, 'A forming update must not transfer completed candles.')
  await electron.evaluate(({ BrowserWindow }, update) => globalThis.__workspaceFixture.sendChart(update), liveUpdate)
  await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close === 135)
  assert.match(await chart.locator('[aria-live="off"]').textContent(), /Close\s+135/)
  assert.match(await chart.locator('svg[data-rendered-inst] [data-chart-price-label-value]').textContent(), /^\+1\.50%$/)
  assert.equal(await priceLabel.getAttribute('data-chart-price-direction'), 'up')
  assert.equal(await priceLabel.locator('[data-chart-price-label-background]').getAttribute('fill'), 'var(--positive)')
  assert.equal(await priceLabel.locator('[data-chart-price-label-value]').getAttribute('fill'), 'var(--change-label-foreground)')
  assert.equal(await priceLabel.locator('[data-chart-countdown]').getAttribute('fill'), 'var(--change-label-foreground)')
  const ticks = await chart.evaluate(chart => {
    const background = chart.querySelector('[data-chart-price-label-background]').getBoundingClientRect()
    const priceX = chart.querySelector('[data-chart-price-label-value]').getAttribute('x')
    return [...chart.querySelectorAll('[data-chart-price-tick]')].map(tick => {
      const line = tick.querySelector('line')
      const text = tick.querySelector('text')
      if (!text) return null
      const rect = text.getBoundingClientRect()
      return { y: Number(text.getAttribute('y')), lineY: Number(line.getAttribute('y1')), x: text.getAttribute('x'), priceX,
        overlaps: rect.left < background.right && rect.right > background.left && rect.top < background.bottom && rect.bottom > background.top }
    }).filter(Boolean)
  })
  assert.ok(ticks.length > 0 && ticks.every(tick => tick.y === tick.lineY && tick.x === tick.priceX), 'Price ticks stay on their grid lines and the normal axis.')
  assert.ok(ticks.some(tick => tick.overlaps), 'A tick beneath the price tag remains in its normal axis position.')
  assert.equal(await page.evaluate(() => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]').__chartSnapshot.bars === globalThis.__completedSubscriptionBars), true)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length), reads, 'Live-only subscriptions must reuse the completed frame without a follow-up read.')
  await electron.evaluate(({ BrowserWindow }, update) => globalThis.__workspaceFixture.sendChart({ ...update, revision: update.revision + 1, liveBar: { ...update.liveBar, close: 132 } }), liveUpdate)
  await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-price-label]')?.getAttribute('data-chart-price-direction') === 'down')
  assert.equal(await priceLabel.locator('[data-chart-price-label-background]').getAttribute('fill'), 'var(--negative)')
  assert.match(await priceLabel.locator('title').textContent(), /down/)
  // Put the live line exactly on a displayed tick, rather than relying on a
  // coincidental overlap. The price tag should naturally cover the axis tick.
  const alignedClose = await chart.evaluate(chart => {
    const line = chart.querySelector('[data-chart-live-price]')
    const lineY = Number(line.getAttribute('y1'))
    const ticks = [...chart.querySelectorAll('[data-chart-price-tick] text')].map(text => ({
      y: Number(text.getAttribute('y')), value: parseFloat(text.textContent.replaceAll(',', '')),
    })).sort((a, b) => a.y - b.y)
    const first = ticks[0], last = ticks.at(-1)
    const lineValue = first.value + (lineY - first.y) * (last.value - first.value) / (last.y - first.y)
    const closest = ticks.reduce((best, tick) => Math.abs(tick.y - lineY) < Math.abs(best.y - lineY) ? tick : best)
    return chart.__chartSnapshot.liveBar.close * (1 + closest.value / 100) / (1 + lineValue / 100)
  })
  await electron.evaluate(({ BrowserWindow }, { update, close }) => globalThis.__workspaceFixture.sendChart({
    ...update, revision: update.revision + 2,
    liveBar: { ...update.liveBar, close, high: Math.max(update.liveBar.high, close), low: Math.min(update.liveBar.low, close) },
  }), { update: liveUpdate, close: alignedClose })
  await page.waitForFunction(close => Math.abs(document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close - close) < 1e-7, alignedClose)
  const aligned = await chart.evaluate(chart => {
    const line = chart.querySelector('[data-chart-live-price]')
    const tick = [...chart.querySelectorAll('[data-chart-price-tick-label]')].find(text =>
      Math.abs(Number(text.getAttribute('y')) - Number(line.getAttribute('y1'))) < .1)
    const background = chart.querySelector('[data-chart-price-label-background]')
    return { exists: Boolean(tick && background), tickBeforeBackground: Boolean(tick && background && (tick.compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING)) }
  })
  assert.ok(aligned.exists && aligned.tickBeforeBackground, 'The price tag must paint over a coincident tick without moving or hiding it.')
})

test('contract precision updates pad current quotes while preserving historical and indicator digits', async () => {
  await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: true } } }))
  await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').click()
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')
  const close = chart.locator('[data-chart-ohlc="close"] span[title]')
  const waitForLabel = expected => page.waitForFunction(expected => document.querySelector('[data-acceptance-target] [data-chart-price-label-value]')?.textContent === expected, expected)
  try {
    const frame = await electron.evaluate(async () => {
      const state = globalThis.__workspaceFixture
      state.precisionRows = state.rows
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, tickSz: '0.0001000', lastPrice: 100.12 } : row)
      state.revision += 1; state.notify()
      state.chartGeneration += 1
      const frame = await state.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      Object.assign(frame.bars.at(-1), { open: 100.1, high: 101, low: 99, close: 100.123456789 })
      frame.liveBar = { ...frame.bars.at(-1), hour: frame.endHour + frame.intervalMS, open: 100.1, high: 101, low: 99, close: 100.12,
        bollUpper: 100.123456789, confirmed: false }
      state.sendChart(frame)
      return frame
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '100.1200')
    await waitForLabel('+0.02%')
    assert.equal(await close.textContent(), '100.1200')
    await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-boll-label="bollUpper"]')?.getAttribute('data-chart-boll-price') === '100.123456789')
    assert.equal(await chart.locator('[data-chart-boll-label="bollUpper"] text').textContent(), '+0.02%', 'Indicator change uses the forming candle open and its plotted value.')
    const baseline = await page.evaluate(() => {
      const chart = document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')
      globalThis.__precisionBars = chart.__chartSnapshot.bars
      globalThis.__precisionLive = chart.__chartSnapshot.liveBar
      return chart.querySelector('[data-chart-price-label-background]').getBoundingClientRect().width
    })
    const reads = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, tickSz: '1e-8' } : row)
      state.revision += 1; state.notify()
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '100.12000000')
    await waitForLabel('+0.02%')
    assert.equal(await close.textContent(), '100.12000000')
    const layout = await chart.evaluate(chart => {
      const label = chart.querySelector('[data-chart-price-label-value]').getBoundingClientRect()
      const background = chart.querySelector('[data-chart-price-label-background]').getBoundingClientRect()
      return { fits: label.right <= background.right + 1, width: background.width,
        sameInputs: chart.__chartSnapshot.bars === globalThis.__precisionBars && chart.__chartSnapshot.liveBar === globalThis.__precisionLive,
        historicalClose: chart.__chartSnapshot.bars.at(-1).close, bollUpper: chart.__chartSnapshot.liveBar.bollUpper }
    })
    assert.ok(layout.fits && layout.width === baseline, 'Price precision must not alter the percentage label gutter.')
    assert.equal(layout.sameInputs, true, 'A precision-only update must reuse source bars and calculated values.')
    assert.equal(layout.historicalClose, 100.123456789)
    assert.equal(layout.bollUpper, 100.123456789)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartLocal || value.chartHistory).length), reads, 'Precision updates must not request chart data again.')
    const target = await candleTarget('previous', frame)
    await page.mouse.move(target.x, target.y)
    await page.mouse.down()
    await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-ohlc="close"] span[title]')?.textContent === '100.123456789')
    await page.mouse.up()
    await waitForLabel('+0.02%')
  } finally {
    await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: false } } }))
    await page.mouse.up()
    const generation = await electron.evaluate(async () => {
      const state = globalThis.__workspaceFixture
      state.rows = state.precisionRows ?? state.rows
      delete state.precisionRows
      state.revision += 1; state.notify()
      state.chartGeneration += 1
      const frame = await state.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      state.sendChart(frame)
      return frame.generation
    })
    await page.waitForFunction(generation => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.generation === generation, generation)
    await page.evaluate(() => { delete globalThis.__precisionBars; delete globalThis.__precisionLive })
  }
})

test('chart source updates stay outside the plot without resizing its viewport at scaled and design widths', async () => {
  await selectTimeframe(page, '15m')
  const previousSize = page.viewportSize()
  const publish = async status => {
    const generation = await electron.evaluate(async ({ ipcMain, BrowserWindow }, status) => {
      const state = globalThis.__workspaceFixture
      state.chartGeneration += 1
      const frame = await globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      if (status.oiState !== 'ready') {
        const observed = status.oiState === 'unavailable'
        frame.endHour += frame.intervalMS
        frame.latestEnd = frame.endHour
        frame.bars = [...frame.bars.slice(1), { ...frame.bars.at(-1), hour: frame.endHour,
          oi: null, buy: null, sell: null, statisticsSources: observed ? 3 : 0,
          statisticsObserved: observed, oiObserved: observed, takerObserved: observed, indicatorsObserved: true }]
      }
      Object.assign(frame, status)
      globalThis.__workspaceFixture.sendChart(frame)
      return frame.generation
    }, status)
    await page.waitForFunction(generation => document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.generation === generation, generation)
  }
  const geometry = () => page.locator('[data-acceptance-target] [data-chart-plot]').boundingBox()
  try {
    for (const size of [{ width: 800, height: 572 }, { width: 1600, height: 1000 }]) {
      await page.setViewportSize(size)
      await page.waitForFunction(size => { const r = document.querySelector('[data-layout="market-workspace"]').getBoundingClientRect(); return r.width === size.width && r.height === size.height }, size)
      await publish({ oiState: 'ready', takerState: 'ready', indicatorState: 'ready' })
      const baseline = await geometry()
      for (const value of ['loading', 'unavailable']) {
        await publish({ oiState: 'ready', takerState: 'ready', indicatorState: value })
        const current = await geometry()
        assert.deepEqual([current.x, current.y, current.width, current.height], [baseline.x, baseline.y, baseline.width, baseline.height], 'Source state changes must preserve the plotted viewport.')
        assert.equal(await page.locator('[data-acceptance-target] [data-chart-plot] [role="status"]').count(), 0, 'Source messages must never cover candles.')
      }
    }
  } finally {
    await publish({ oiState: 'ready', takerState: 'ready', indicatorState: 'ready' })
    await page.setViewportSize(previousSize)
  }
})

test('pointer inspection selects the first fully visible, middle, and latest candle before and after a forming candle shifts the window', async () => {
  await selectTimeframe(page, '15m')
  // Freeze the advancing live time axis while sampling candle coordinates and
  // sending pointer input. Timers still run; only the wall-clock value is fixed.
  await page.evaluate(() => {
    const now = Date.now()
    window.__inspectionOriginalNow = Date.now
    Date.now = () => now
  })
  const publish = forming => electron.evaluate(async ({ ipcMain, BrowserWindow }, forming) => {
    const state = globalThis.__workspaceFixture
    state.chartGeneration += 1
    const frame = await globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    if (forming) frame.liveBar = { ...frame.bars.at(-1), hour: frame.endHour + frame.intervalMS,
      open: 133, high: 138, low: 132, close: 137, confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null }
    globalThis.__workspaceFixture.sendChart(frame)
    return frame
  }, forming)
  const waitForFrame = frame => page.waitForFunction(({ generation, end }) => {
    const chart = document.querySelector('[data-acceptance-target] [data-chart-inst="BETA-USDT-SWAP"]')
    return chart?.__chartSnapshot.generation === generation && Number(chart.dataset.chartEnd) === end
  }, { generation: frame.generation, end: frame.liveBar?.hour ?? frame.endHour })
  try {
    for (const forming of [false, true]) {
      const frame = await publish(forming)
      await waitForFrame(frame)
      // Wait for geometry and the DOM's hit surface to commit together.
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
      for (const slot of ['first', 'middle', 'last']) {
        const target = await candleTarget(slot, frame)
        const fixtureBar = [...frame.bars, ...(frame.liveBar ? [frame.liveBar] : [])].find(bar => bar.hour === target.hour)
        assert.equal(target.close, fixtureBar.close)
        await page.mouse.move(target.x, target.y)
        await page.mouse.down()
        await page.waitForFunction(hour => Number(document.querySelector('[data-acceptance-target] [data-chart-inspected-hour]')?.dataset.chartInspectedHour) === hour, target.hour)
        const close = await page.locator('[data-acceptance-target] [data-chart-ohlc="close"] span[title]').getAttribute('title')
        assert.equal(Number(close), target.close, `${forming ? 'The forming' : 'The completed-only'} window must inspect its drawn candle at slot ${slot}.`)
        await page.mouse.up()
        await page.waitForFunction(() => !document.querySelector('[data-acceptance-target] [data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      }
    }
  } finally {
    await page.mouse.up()
    try { await waitForFrame(await publish(false)) }
    finally { await page.evaluate(() => { Date.now = window.__inspectionOriginalNow; delete window.__inspectionOriginalNow }) }
  }
})

test('a healthy idle market list makes no periodic snapshot requests', async () => {
  await page.waitForFunction(() => document.querySelectorAll('[data-market-index]').length === 4)
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before,
    'Successful market reads must wait for a notification or action.')
})

test('snapshot failures wait for a new notification and resume immediately on recovery', async () => {
  try {
    await page.evaluate(() => {
      const timeout = window.setTimeout.bind(window)
      const delays = []
      window.setTimeout = (handler, delay, ...args) => {
        if ([4_000, 8_000, 16_000, 30_000].includes(delay)) delays.push(delay)
        return timeout(handler, delay, ...args)
      }
      globalThis.__snapshotRetryClock = { delays, restore() { window.setTimeout = timeout } }
    })
    const before = await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      const before = state.requests.filter(value => value.snapshot).length
      state.failSnapshots = 1
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 204 } : row)
      state.revision += 1; state.notify()
      return before
    })
    const error = page.locator('[data-market-status] p').filter({ hasText: 'Market: Market data is unavailable. Check the connection and data service.' })
    await error.waitFor({ state: 'visible' })
    assert.doesNotMatch(await page.locator('[data-market-status]').textContent(), /Snapshot temporarily unavailable/)
    assert.deepEqual(await page.evaluate(() => globalThis.__snapshotRetryClock.delays), [])
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + 1)
    await electron.evaluate(() => globalThis.__workspaceFixture.notify())
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '204')
    await page.clock.fastForward(7_100)
    await error.waitFor({ state: 'hidden' })
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + 2)
    assert.deepEqual(await page.evaluate(() => globalThis.__snapshotRetryClock.delays), [])
  } finally {
    await page.evaluate(() => { globalThis.__snapshotRetryClock?.restore(); delete globalThis.__snapshotRetryClock })
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.failSnapshots = 0; state.rows = state.initialRows; state.revision += 1; state.notify() })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '100')
  }
})

test('market notifications refresh immediately and coalesce changes arriving during one snapshot request', async () => {
  try {
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.holdNextSnapshot = true
      state.snapshotMaximum = state.snapshotActive
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 201 } : row)
      state.revision += 1
      BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    })
    const deadline = Date.now() + 1_000
    while (!(await electron.evaluate(() => Boolean(globalThis.__workspaceFixture.releaseSnapshot)))) {
      assert.ok(Date.now() < deadline, 'A market notification must request a snapshot without waiting for a timer.')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const blockedCount = await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 202 } : row)
      state.revision += 1
      for (let index = 0; index < 20; index += 1) BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
      return state.requests.filter(value => value.snapshot).length
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), blockedCount, 'Notifications during a request must coalesce rather than start concurrent snapshots.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseSnapshot() })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '202', null, { timeout: 1_000 })
    assert.deepEqual(await electron.evaluate(() => ({ maximum: globalThis.__workspaceFixture.snapshotMaximum, count: globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length })), { maximum: 1, count: blockedCount + 1 }, 'Queued changes need exactly one immediate follow-up snapshot.')
  } finally {
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.holdNextSnapshot = false
      state.releaseSnapshot?.()
      state.rows = state.initialRows
      state.revision += 1
      BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '100')
  }
})

test('market notifications continue refreshing while the workspace is hidden', async () => {
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 203 } : row)
      state.revision += 1
      for (let index = 0; index < 20; index += 1) BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '203', null, { timeout: 1_000 })
  } finally {
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')) })
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.rows = state.initialRows
      state.revision += 1
      BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '100')
  }
})

test('screenshot preserves the current interface and remains responsive during capture', async () => {
  await electron.evaluate(() => { globalThis.__workspaceFixture.holdCapture = true })
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.screenshot).length)
  try {
    const button = page.getByRole('button', { name: 'Screenshot', exact: true })
    const appearance = await button.evaluate(node => ({ border: getComputedStyle(node).borderWidth, font: getComputedStyle(node).fontSize, background: getComputedStyle(node).backgroundColor, icon: getComputedStyle(node.querySelector('svg')).width }))
    assert.deepEqual([appearance.border, appearance.font, appearance.icon], ['0px', '14px', '16px'])
    await button.hover()
    await page.waitForFunction(previous => getComputedStyle(document.querySelector('[data-screenshot-button]')).backgroundColor !== previous, appearance.background)
    await button.click()
    await waitForAuditFixture(() => typeof globalThis.__workspaceFixture.releaseCapture === 'function')
    assert.equal(await page.getByRole('button', { name: 'Screenshot', exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: 'Screenshot', exact: true }).textContent(), 'Screenshot', 'Starting capture must not change the visible interface.')
    assert.equal(await page.locator('[data-screenshot-shutter]').count(), 0, 'The shutter must not appear before capture completes.')
    assert.equal(await page.locator('[data-market-list]').isVisible(), true)
    for (let index = 0; index < 4; index++) await page.getByRole('button', { name: 'Screenshot', exact: true }).click()
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.screenshot).length), before + 1, 'Repeated requests wait for the first capture.')
    await page.getByRole('row', { name: 'View ZETA-USDT-SWAP chart', exact: true }).click()
    await electron.evaluate(() => globalThis.__workspaceFixture.releaseCapture())
    await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('Screenshot copied to clipboard')))
    await electron.evaluate((_electron, target) => { globalThis.__workspaceFixture.captureTarget = target }, before + 2)
    await waitForAuditFixture(() => globalThis.__workspaceFixture.requests.filter(value => value.screenshot).length === globalThis.__workspaceFixture.captureTarget)
    await electron.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)))
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.screenshot).length), before + 2, 'Repeated requests coalesce to one pending capture.')
    assert.equal(await page.getByRole('button', { name: 'Screenshot', exact: true }).textContent(), 'Screenshot', 'The button label remains unchanged after capture.')
    const confirmation = page.locator('[data-screenshot-success]')
    await confirmation.waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-screenshot-shutter]').count(), 1, 'The shutter appears after capture.')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await page.locator('[data-screenshot-shutter]').isVisible(), false, 'Reduced motion suppresses the shutter flash.')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.clock.fastForward(250)
    await page.waitForFunction(() => !document.querySelector('[data-screenshot-shutter]'))
    assert.equal(await confirmation.isVisible(), true, 'The confirmation remains visible after the shutter.')
    await page.clock.fastForward(800)
    await confirmation.waitFor({ state: 'hidden' })
    await electron.evaluate(() => { globalThis.__workspaceFixture.failScreenshot = true })
    await page.getByRole('button', { name: 'Screenshot', exact: true }).click()
    const failures = page.locator('[data-market-status] p').filter({ hasText: 'Could not copy the screenshot' })
    await failures.first().waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.failScreenshot = true })
    await page.getByRole('button', { name: 'Screenshot', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-market-status] p')].filter(node => node.textContent.includes('Could not copy the screenshot')).length === 2)
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdCapture = false; state.releaseCapture?.() })
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
  }
})

test('selection persists while six width/DPR combinations share page, pointer, and capture coordinates', async () => {
  await selectTimeframe(page, '15m')
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const client = await page.context().newCDPSession(page)
  const fixture = await electron.evaluate(({ ipcMain }) => globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } }))
  try {
    for (const deviceScaleFactor of [1, 2]) for (const width of [1_200, 1_600, 2_000]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1_000, deviceScaleFactor, mobile: false })
      await page.waitForFunction(({ width, deviceScaleFactor }) => innerWidth === width && devicePixelRatio === deviceScaleFactor && Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === 1, { width, deviceScaleFactor })
      await assertWorkspaceLayout(page)
      await page.waitForFunction(() => {
        const chart = document.querySelector('[data-chart-inst]')
        return chart?.dataset.chartLoading === 'false' && Number(chart.dataset.chartRenderedBars) > 0
      })
      const currentFixture = await electron.evaluate(() => globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } }))
      const target = await candleTarget('middle', currentFixture)
      await page.mouse.move(target.x, target.y)
      await page.mouse.down()
      await page.waitForFunction(() => document.querySelector('[data-acceptance-target] [data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      const hoveredClose = await page.locator('[data-acceptance-target] [data-chart-ohlc="close"] span[title]').getAttribute('title')
      assert.equal(Number(hoveredClose), target.close, 'Screen-space pointer input must inspect the candle drawn beneath it at every UI scale and DPR.')
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('[data-acceptance-target] [data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      assert.equal(await page.locator('[data-shared-chart-title]').textContent(), fixture.instId.replace(/-SWAP$/, ''), 'Copied chart bounds must include the contract and displayed timeframe.')
      await page.getByRole('button', { name: 'Screenshot', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Screenshot copied to clipboard' }).waitFor()
      const request = await electron.evaluate(() => globalThis.__workspaceFixture.requests.findLast(value => value.screenshot))
      assert.deepEqual(request, { screenshot: {} }, 'Screenshot captures the entire renderer without a crop, independent of DPR.')
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `workspace-${width}-dpr${deviceScaleFactor}.png`) })
      const settings = await openSettings()
      const ranking = settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' })
      await ranking.click()
      assert.equal(await ranking.evaluate(element => element === document.activeElement), true, 'Settings controls must accept pointer coordinates in their own window.')
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await settingsWindow.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `settings-${width}-dpr${deviceScaleFactor}.png`) })
      await backToMarkets()
    }
    assert.equal(await page.locator('[data-acceptance-target] [data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    assert.equal(await page.getByRole('textbox', { name: 'Search contracts' }).count(), 0)
  } finally {
    await page.mouse.up()
    await page.keyboard.press('Escape')
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
    await client.send('Emulation.clearDeviceMetricsOverride')
    await client.detach()
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height })
    await page.setViewportSize(viewport)
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height && Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === 1, viewport)
  }
})

test('settings is a separate grouped page with keyboard navigation and a retained market workspace', async () => {
  const before = {
    charts: await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => [chart.dataset.chartInst, chart.querySelector('svg[data-rendered-timeframe]')?.dataset.renderedTimeframe])),
  }
  const settings = await openSettings()
  await settings.getByRole('heading', { name: 'Settings', level: 1, exact: true }).waitFor()
  assert.equal(await page.locator('[data-market-list]').isVisible(), true)
  const categories = settings.getByRole('navigation', { name: 'Settings categories' })
  assert.deepEqual(await categories.getByRole('link').allTextContents(), ['Workspace', 'Liquidity filters', 'Market data'])
  assert.equal(await categories.getByRole('link', { name: 'Workspace', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).count(), 0)
  await categories.getByRole('link', { name: 'Market data', exact: true }).focus()
  await settingsWindow.keyboard.press('Enter')
  await settings.getByRole('heading', { name: 'Market data', level: 2, exact: true }).waitFor()
  assert.equal(await categories.getByRole('link', { name: 'Market data', exact: true }).getAttribute('aria-current'), 'page')
  await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).waitFor()
  await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Start audit', exact: true }).waitFor()
  await settingsWindow.goBack()
  await settings.getByRole('heading', { name: 'Workspace', level: 2, exact: true }).waitFor()
  await settingsWindow.keyboard.press('Escape')
  assert.equal(await settings.isVisible(), true, 'Escape must not dismiss the settings window.')
  await backToMarkets()
  assert.deepEqual(await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => [chart.dataset.chartInst, chart.querySelector('svg[data-rendered-timeframe]')?.dataset.renderedTimeframe])), before.charts)
})

test('retired chart timeframe and price scale controls are absent from settings', async () => {
  const settings = await openSettings()
  assert.equal(await settings.getByRole('combobox', { name: 'Chart timeframe' }).count(), 0)
  assert.equal(await settings.getByRole('combobox', { name: 'Price scale' }).count(), 0)
  assert.equal(await settings.getByRole('spinbutton', { name: 'Fixed height per 1% (px)' }).count(), 0)
  await backToMarkets()
})

test('Bollinger price labels are off by default and update all charts when saved', async () => {
  const settings = await openSettings()
  const toggle = settings.getByRole('switch', { name: 'Bollinger price labels', exact: true })
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-boll-label]').count(), 0)
  const lineCount = await page.locator('svg[data-rendered-inst] [data-chart-indicator="bollUpper"]').count()
  const priceCount = await page.locator('svg[data-rendered-inst] [data-chart-price-label]').count()
  assert.equal(lineCount, 3)
  assert.ok(priceCount > 0)
  try {
    await clickByRect(toggle)
    await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
    await settingsWindow.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('svg[data-rendered-inst]')].length === 3 && [...document.querySelectorAll('svg[data-rendered-inst]')].every(svg => svg.querySelectorAll('[data-chart-boll-label]').length > 0))
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.showBollingerPriceLabels), true)
    assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-indicator="bollUpper"]').count(), lineCount)
    assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-price-label]').count(), priceCount)
    await backToMarkets()
    const reopened = await openSettings()
    assert.equal(await reopened.getByRole('switch', { name: 'Bollinger price labels', exact: true }).getAttribute('aria-checked'), 'true')
    await clickByRect(reopened.getByRole('switch', { name: 'Bollinger price labels', exact: true }))
    await reopened.getByRole('button', { name: 'Save settings', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('svg[data-rendered-inst] [data-chart-boll-label]').length === 0)
  } finally {
    await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: false } } }))
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
  }
})

test('preference drafts survive category changes and validation returns to the first invalid group', async () => {
  const updatesBefore = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length)
  const settings = await openSettings()
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('7')
  await chooseSettingsCategory('Liquidity filters')
  assert.equal(await settings.getByRole('switch').count(), 6)
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).count(), 0)
  const spread = settings.getByRole('switch', { name: 'Bid-ask spread', exact: true })
  await clickByRect(spread)
  assert.equal(await spread.getAttribute('aria-checked'), 'false')
  const stability = settings.getByRole('switch', { name: 'Volume stability', exact: true })
  await clickByRect(stability)
  assert.equal(await stability.getAttribute('aria-checked'), 'true')
  await settings.getByRole('spinbutton', { name: 'Maximum hourly volume ratio', exact: true }).fill('2.5')
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settings.getByRole('heading', { name: 'Workspace', level: 2, exact: true }).waitFor()
  await settings.getByText('Use a multiple of 5 minutes.', { exact: true }).waitFor()
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue(), '7')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).evaluate(element => element === document.activeElement), true)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length), updatesBefore)
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('30')
  await chooseSettingsCategory('Liquidity filters')
  assert.equal(await spread.getAttribute('aria-checked'), 'false')
  assert.equal(await stability.getAttribute('aria-checked'), 'true')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Maximum hourly volume ratio', exact: true }).inputValue(), '2.5')
  await electron.evaluate(() => { globalThis.__workspaceFixture.failNextSave = true })
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Could not save settings.' }).waitFor()
  assert.equal(await settings.isVisible(), true)
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor()
  assert.equal(await settings.isVisible(), true, 'Saving preferences must keep the settings page open.')
  const preferences = await electron.evaluate(() => globalThis.__workspaceFixture.preferences)
  assert.equal(preferences.rankingLookback, 30)
  assert.equal(preferences.liquidity.spread.enabled, false)
  assert.deepEqual(preferences.liquidity.volumeStability, { enabled: true, maxRatio: 2.5 })
  await backToMarkets()
  await page.getByRole('columnheader', { name: '30m change By magnitude', exact: true }).waitFor()
  assert.deepEqual(await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => chart.querySelector('svg[data-rendered-timeframe]')?.dataset.renderedTimeframe)), ['1H', '15m', '5m'])
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.rankingLookback), 30)
})

test('discarding changes resets all preference groups without saving', async () => {
  const settings = await openSettings()
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length)
  const originalRanking = await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue()
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('60')
  await chooseSettingsCategory('Market data')
  await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).fill('120')
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click()
  assert.equal(await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).inputValue(), '30')
  await chooseSettingsCategory('Workspace')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue(), originalRanking)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length), before)
  await backToMarkets()
})

test('settings validation returns to Market data for a fractional audit lookback entered before changing groups', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length)
  const settings = await openSettings('Market data')
  const lookback = settings.getByRole('spinbutton', { name: 'Data audit lookback (days)', exact: true })
  await lookback.fill('1.5')
  await chooseSettingsCategory('Workspace')
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settings.getByRole('heading', { name: 'Market data', level: 2, exact: true }).waitFor()
  await settings.getByText('Enter a whole number of at least 1.', { exact: true }).waitFor()
  assert.equal(await lookback.inputValue(), '1.5')
  assert.equal(await lookback.getAttribute('aria-invalid'), 'true')
  assert.equal(await lookback.evaluate(element => element === document.activeElement), true, 'Validation must reveal and focus an invalid input in another category.')
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length), before)
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click()
  assert.equal(await lookback.inputValue(), '30')
  await backToMarkets()
})

test('leaving settings confirms before discarding an unsaved preference draft', async () => {
  const settings = await openSettings()
  const ranking = settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' })
  const savedRanking = await ranking.inputValue()
  await ranking.fill('60')
  await electron.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0 })
  await settingsWindow.evaluate(() => window.radarDesktop.closeSettingsWindow())
  assert.equal(settingsWindow.isClosed(), false)
  assert.equal(await ranking.inputValue(), '60')
  await electron.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  await backToMarkets()
  const reopened = await openSettings()
  assert.equal(await reopened.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue(), savedRanking)
  assert.equal(String(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.rankingLookback)), savedRanking)
  await backToMarkets()
})

test('saving only the ranking lookback keeps the chosen chart and qualified market state', async () => {
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
  const settings = await openSettings()
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('45')
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor()
  await backToMarkets()
  await page.getByRole('columnheader', { name: '45m change By magnitude', exact: true }).waitFor()
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
  assert.deepEqual(await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => [chart.dataset.chartInst, chart.querySelector('svg[data-rendered-timeframe]')?.dataset.renderedTimeframe])), [['BETA-USDT-SWAP', '1H'], ['BETA-USDT-SWAP', '15m'], ['BETA-USDT-SWAP', '5m']])
  assert.equal(await page.locator('[data-market-index]').count(), 4, 'Saving the ranking window must preserve the qualified universe.')
})

const waitForAuditFixture = async (predicate, argument) => {
  const deadline = Date.now() + 2_000
  while (!(await electron.evaluate(predicate, argument))) {
    assert.ok(Date.now() < deadline, 'The audit fixture did not receive its expected request.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('audit checkpoints push progress and actions without idle status polling, and reopening reads once', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length)
  await openSettings('Market data')
  let settings = settingsPage()
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('button', { name: 'Start audit', exact: true }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 1)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1)
  await settings.getByRole('button', { name: 'Start audit', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Audit running · 1 / 3' }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ progress: { completed: 2, total: 3 } }) })
  await settingsWindow.getByRole('status').filter({ hasText: 'Audit running · 2 / 3' }).waitFor()
  await chooseSettingsCategory('Workspace')
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ progress: { completed: 3, total: 3 } }) })
  await chooseSettingsCategory('Market data')
  await settingsWindow.getByRole('status').filter({ hasText: 'Audit running · 3 / 3' }).waitFor()
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1, 'Changing settings groups must reuse the status subscription and its latest checkpoint.')
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ phase: 'validating' }) })
  await settingsWindow.getByRole('status').filter({ hasText: 'Validating recent changes. Results are provisional.' }).waitFor()
  assert.equal(await settings.getByRole('progressbar', { name: 'Data audit progress' }).count(), 0, 'Validation has no bounded progress and must not appear complete.')
  assert.equal(await settings.getByRole('button', { name: 'Start audit', exact: true }).isDisabled(), true)
  assert.equal(await settings.getByRole('button', { name: 'Repair issues', exact: true }).isDisabled(), true)
  assert.equal(await settings.getByRole('button', { name: 'Cancel audit', exact: true }).isEnabled(), true)
  await settings.getByRole('button', { name: 'Cancel audit', exact: true }).click()
  await settings.getByRole('list', { name: 'Data audit issues' }).getByText('Missing completed candle · Repairable', { exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Repair issues', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
  assert.equal(await settings.getByRole('list', { name: 'Data audit issues' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1, 'A successful audit settings page must wait for checkpoints rather than poll.')
  const actions = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit).map(value => value.dataAudit.action))
  assert.deepEqual(actions.filter(action => action !== 'status'), ['start', 'cancel', 'repair'])
  await backToMarkets()
  settings = await openSettings('Market data')
  await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 2)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 2, 'Reopening performs one fresh status read.')
  await backToMarkets()
})

test('new audit pushes win over held initial and action replies across page reopen', async () => {
  let settings
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })
      state.holdAuditAction = 'status'
    })
    settings = await openSettings('Market data')
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'running', progress: { completed: 2, total: 3 } })
      state.publishAudit({ phase: 'completed', progress: { completed: 7, total: 7 } })
    })
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'idle', 'The held initial reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
    const beforeReopen = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length)
    await backToMarkets()
    settings = await openSettings('Market data')
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
    await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, beforeReopen + 1)
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdAuditAction = 'start' })
    await settings.getByRole('button', { name: 'Start audit', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit running · 1 / 3' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ phase: 'completed', progress: { completed: 3, total: 3 } }) })
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit running · 3 / 3' }).waitFor()
    assert.equal(await settings.getByRole('button', { name: 'Start audit', exact: true }).isDisabled(), true, 'A push must not release an action that is still in flight.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'running', 'The held action reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await settings.getByRole('button', { name: 'Start audit', exact: true }).waitFor({ state: 'visible' })
    await settingsWindow.waitForFunction(() => ![...document.querySelectorAll('main[aria-label="Settings"] button')].find(button => button.textContent === 'Start audit')?.disabled)
    await settingsWindow.getByRole('status').filter({ hasText: 'Audit complete.' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdAuditAction = null; state.releaseAudit?.() })
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
  }
})

test('manual history downloads show exact pushed progress and retry details, continue after leaving settings, and cancel without polling', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length)
  await openSettings('Market data')
  let settings = settingsPage()
  await settingsWindow.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Download all qualified history')?.disabled)
  await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Downloading history · 10.0%' }).waitFor()
  const details = settings.locator('[aria-label="History download details"]')
  assert.equal(await details.isVisible(), false)
  await settings.getByText('100 / 1,000 source timestamps checked', { exact: true }).waitFor()
  await settings.getByText('Download details and coverage', { exact: true }).click()
  await details.getByText('100 / 1,000', { exact: true }).waitFor()
  await details.getByText('1 / 18', { exact: true }).waitFor()
  const active = settings.getByRole('list', { name: 'Active history downloads' })
  await active.getByText('BETA-USDT-SWAP · 15m · oi', { exact: true }).waitFor()
  await active.getByText(/retrying · Consecutive failures: 2 · Next retry:/).waitFor()
  await active.getByText('Request failed. Check the data service.', { exact: true }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { checked: 999_999, total: 1_000_000, available: 900_000, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 1 },
  }) })
  await settingsWindow.getByRole('status').filter({ hasText: 'Downloading history · 99.9%' }).waitFor()
  await details.getByText('999,999 / 1,000,000', { exact: true }).waitFor()
  await details.getByText('99,999', { exact: true }).waitFor()
  await details.getByText('300,000', { exact: true }).waitFor()
  await backToMarkets()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { checked: 1_000_000, total: 1_000_000, available: 900_001, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 0 },
  }) })
  settings = await openSettings('Market data')
  await settingsWindow.getByRole('status').filter({ hasText: 'Downloading history · 100.0%' }).waitFor()
  await settings.getByRole('button', { name: 'Cancel download', exact: true }).click()
  await settingsWindow.getByRole('status').filter({ hasText: 'Download cancelled' }).waitFor()
  assert.equal(await settings.getByRole('list', { name: 'Active history downloads' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length), before + 2)
  assert.deepEqual(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload && value.historyDownload.action !== 'status').map(value => value.historyDownload.action)), ['start', 'cancel'])
  await backToMarkets()
})

test('new download pushes win over held replies and completion distinguishes unavailable data', async () => {
  let settings
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishDownload({ phase: 'idle', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 }, error: '' })
      state.holdDownloadAction = 'status'
    })
    settings = await openSettings('Market data')
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { checked: 1_000_000, total: 1_000_000, available: 900_001, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await settingsWindow.getByRole('status').filter({ hasText: 'Completed with verified unavailable data' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await settingsWindow.getByRole('status').filter({ hasText: 'Completed with verified unavailable data' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdDownloadAction = 'start' })
    await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { checked: 1_000, total: 1_000, available: 1_000, empty: 0, unavailable: 0, failed: 0, reused: 80, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await settings.getByText('1,000 / 1,000 source timestamps checked', { exact: true }).waitFor()
    assert.equal(await settings.getByRole('button', { name: /Download all qualified history/ }).isDisabled(), true)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldDownloadReply.phase), 'running')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await settingsWindow.waitForFunction(() => ![...document.querySelectorAll('main[aria-label="Settings"] button')].find(button => button.textContent === 'Download all qualified history')?.disabled)
    await settingsWindow.getByRole('status').filter({ hasText: 'Download complete' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdDownloadAction = null; state.releaseDownload?.() })
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
  }
})

test('ranking changes keep the chosen chart while long lists retain keyboard access', async () => {
  await electron.evaluate(() => {
    const state = globalThis.__workspaceFixture
    state.rows = state.rows.map(row => row.instId === 'ZETA-USDT-SWAP' ? { ...row, rankingChange: 4 } : row)
    state.revision += 1
    state.notify()
  })
  await page.waitForFunction(() => document.querySelector('[data-market-index="0"]')?.getAttribute('aria-label') === 'View ZETA-USDT-SWAP chart')
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart', 'A ranking reorder must preserve the chosen contract.')
  await electron.evaluate(() => {
    const state = globalThis.__workspaceFixture
    state.rows = [...state.rows, ...Array.from({ length: 96 }, (_, index) => ({
      instId: `AUX${String(index).padStart(3, '0')}-USDT-SWAP`, price: 10, lastPrice: 10, rankingChange: 0, rankingAsOf: 1_800_000_000_000, turnover24hUSDT: 50_000_000,
    }))]
    state.revision += 1
    state.notify()
  })
  await page.waitForFunction(() => document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count') === '100')
  const headerBefore = await page.locator('[data-market-list] thead').boundingBox()
  await page.locator('[data-market-index="0"]').focus()
  await page.keyboard.press('End')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View NULL-USDT-SWAP chart')
  assert.equal(await page.locator('[data-market-scroll]').evaluate(element => element.scrollTop > 0), true)
  const headerAfter = await page.locator('[data-market-list] thead').boundingBox()
  assert.ok(Math.abs(headerAfter.y - headerBefore.y) < 2, `The column header must stay visible while the contract pane scrolls: ${JSON.stringify({ headerBefore, headerAfter })}`)
  assert.equal(await page.evaluate(() => scrollY), 0)
  await page.keyboard.press('Home')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View ZETA-USDT-SWAP chart')
  await page.keyboard.press('End')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View NULL-USDT-SWAP chart')
  assert.equal(await page.locator('[data-chart-inst]').first().getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
  await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.rows = state.initialRows; state.revision += 1; state.notify() })
  await page.waitForFunction(() => document.querySelector('[aria-label="View ZETA-USDT-SWAP chart"] td:last-child')?.textContent.includes('+3.00%'))
  await page.waitForFunction(() => document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count') === '4')
})

test('constant Bollinger bands stay finite and negative lower bands retain the relative price scale', async () => {
  await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: true } } }))
  const publishMode = async mode => {
    await electron.evaluate((_electron, mode) => { const state = globalThis.__workspaceFixture; state.bollMode = mode; state.chartGeneration += 1 }, mode)
    await page.evaluate(async () => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const frame = await window.radarDesktop.request({ chartLocal: { instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe } })
      window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
    })
  }
  try {
    await publishMode('constant')
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]').__chartSnapshot?.bars.every(bar => bar.bollUpper === 100 && bar.bollLower === 100))
    assert.ok(await page.locator('svg[data-rendered-inst]').first().locator('[data-chart-price-tick]').count() > 0)
    const svg = page.locator('svg[data-rendered-inst]').first()
    await page.waitForFunction(() => document.querySelector('svg[data-rendered-inst]')?.querySelectorAll('[data-chart-boll-label]').length === 3)
    const labels = await svg.evaluate(node => {
      const groups = [...node.querySelectorAll('[data-chart-boll-label], [data-chart-price-label]')]
      return groups.map(group => ({
        kind: group.getAttribute('data-chart-boll-label') ?? 'price',
        text: group.querySelector('text')?.textContent,
        countdown: group.querySelectorAll('[data-chart-countdown]').length,
        ...(() => { const { top, bottom } = group.querySelector('rect').getBoundingClientRect(); return { top, bottom } })(),
      }))
    })
    assert.deepEqual(labels.filter(label => label.kind !== 'price').map(label => label.text), ['+0.05%', '+0.05%', '+0.05%'])
    assert.ok(labels.filter(label => label.kind !== 'price').every(label => label.countdown === 0))
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      assert.ok(labels[i].bottom <= labels[j].top || labels[j].bottom <= labels[i].top, `${labels[i].kind} overlaps ${labels[j].kind}`)
    }
    await publishMode('negative')
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]').__chartSnapshot?.bars.every(bar => bar.bollLower === -1))
    const paths = await page.locator('svg[data-rendered-inst] path[d]').evaluateAll(paths => paths.map(path => path.getAttribute('d')))
    assert.doesNotMatch(paths.join(' '), /NaN|Infinity|undefined/)
    assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-boll-band]').first().evaluate(path => path.getAttribute('d').length > 0), true)
  } finally { await publishMode('standard'); await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: false } } })) }
})

test('list and three rounded chart panels occupy their requested positions', async () => {
  await assertWorkspaceLayout(page)
  const panels = page.locator('[data-timeframe-panel]')
  assert.deepEqual(await panels.evaluateAll(nodes => nodes.map(node => node.dataset.timeframePanel)), ['1H', '15m', '5m'])
  assert.equal(await page.locator('[data-market-list]').isVisible(), true)
  const previous = page.viewportSize()
  try {
    await page.setViewportSize({ width: 1200, height: 640 })
    await assertWorkspaceLayout(page)
    const list = page.locator('[data-market-list]')
    assert.ok((await page.locator('[data-market-panel]').boundingBox()).width >= 280, 'The list keeps a readable minimum width.')
    assert.equal(await list.locator('th').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth)), true, 'All list headers fit at minimum window width.')
  } finally { if (previous) await page.setViewportSize(previous) }
})

test('market failures show a temporary, nonblocking notification and log transitions', async () => {
  const publish = values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values); state.revision += 1; state.notify()
  }, values)
  const toast = page.locator('[data-market-status]')
  const market = toast.getByText(/Market:.*Market data is unavailable/)
  const list = page.locator('[data-market-list]')
  try {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', realtimeState: 'live', catalogSource: 'live', catalogProgress: undefined })
    await page.clock.fastForward(7_100)
    const baseline = await list.boundingBox()
    assert.equal(await page.locator('[data-market-status-row]').count(), 0)
    const initial = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.statusLog).length)
    await publish({ error: 'Internal failure: do not expose this raw exception', realtimeState: 'disconnected' })
    await market.waitFor({ state: 'visible' })
    assert.doesNotMatch(await toast.textContent(), /Internal failure/)
    const box = await toast.boundingBox(), viewport = page.viewportSize()
    assert.ok(box.x < viewport.width / 2 && box.y + box.height > viewport.height / 2, 'The notification appears in the lower left.')
    assert.equal(await toast.evaluate(node => getComputedStyle(node).pointerEvents), 'none')
    assert.deepEqual(await list.boundingBox(), baseline, 'The floating notification does not resize the list.')
    await waitForAuditFixture((_electron, count) => globalThis.__workspaceFixture.requests.filter(value => value.statusLog).length > count, initial)
    const logged = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.statusLog).at(-1).statusLog)
    assert.match(logged.cause, /Internal failure/)
    assert.ok(logged.issues.some(issue => issue.includes('Market data is unavailable')))
    await page.clock.fastForward(7_100)
    await market.waitFor({ state: 'hidden' })
    await publish({ error: 'Internal failure: do not expose this raw exception', realtimeState: 'disconnected' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await market.count(), 0, 'An unchanged failure is not repeatedly shown.')
    await publish({ error: '', realtimeState: 'live' })
    await waitForAuditFixture(() => globalThis.__workspaceFixture.requests.filter(value => value.statusLog).at(-1)?.statusLog.cause === '')
    await publish({ error: 'Internal failure: do not expose this raw exception', realtimeState: 'disconnected' })
    await market.waitFor({ state: 'visible' })
  } finally {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', realtimeState: 'live', catalogSource: 'live', catalogProgress: undefined })
    await page.clock.fastForward(7_100)
  }
})

test('a chart price freshness warning appears while settings are open', async () => {
  await page.waitForFunction(() => document.querySelector('svg[data-rendered-timeframe="15m"]')?.closest('[data-chart-inst]')?.__chartSnapshot)
  try {
    await page.clock.fastForward(7_100)
    const now = await page.evaluate(() => Date.now())
    await electron.evaluate(async (_electron, now) => {
      const state = globalThis.__workspaceFixture
      const frame = await state.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      state.chartOverride = { ...frame, generation: frame.generation + 100, revision: frame.revision + 1, realtimeState: 'live', priceObservedAt: now }
      state.sendChart(state.chartOverride)
    }, now)
    await openSettings()
    await page.clock.fastForward(31_000)
    const status = page.locator('[data-market-status] [data-chart-shared-status-item="15m"]')
    await status.getByText(/Cached price/).waitFor({ state: 'visible' })
    await page.clock.fastForward(7_100)
    await status.waitFor({ state: 'hidden' })
  } finally {
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
    await electron.evaluate(() => { delete globalThis.__workspaceFixture.chartOverride })
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
})

test('background failures produce short notifications without exposing backend details', async () => {
  const toast = page.locator('[data-market-status]')
  try {
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'failed', error: 'Raw backend detail' }) })
    await toast.getByText(/History download:.*Download failed/).waitFor({ state: 'visible' })
    assert.doesNotMatch(await toast.textContent(), /Raw backend detail/)
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ phase: 'failed', error: 'Sensitive backend diagnostic' }) })
    await toast.getByText(/Data audit:.*Audit failed/).waitFor({ state: 'visible' })
    assert.doesNotMatch(await toast.textContent(), /Sensitive backend diagnostic/)
    await page.clock.fastForward(7_100)
    await toast.waitFor({ state: 'hidden' })
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
  }
})

test('simultaneous notification errors take priority over warnings', async () => {
  try {
    await page.clock.fastForward(7_100)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: 'market diagnostic', realtimeState: 'disconnected' })
      state.revision += 1; state.notify()
      state.publishAudit({ phase: 'failed', error: 'audit diagnostic' })
      state.publishDownload({ phase: 'failed', error: 'download diagnostic' })
    })
    const toast = page.locator('[data-market-status]')
    await toast.getByText(/Market:.*Market data is unavailable/).waitFor({ state: 'visible' })
    await toast.getByText(/Data audit:.*Audit failed/).waitFor({ state: 'visible' })
    await toast.getByText(/History download:.*Download failed/).waitFor({ state: 'visible' })
    assert.ok(await toast.locator('p').count() <= 3, 'The notification has a bounded number of lines.')
    const panels = await toast.locator('p').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, border: getComputedStyle(node).borderTopWidth }
    }))
    assert.equal(panels.length, 3)
    assert.ok(panels.every(panel => parseFloat(panel.border) > 0), 'Each notification has its own panel.')
    assert.ok(panels.every((panel, index) => index === 0 || panel.top > panels[index - 1].bottom), 'Panels are separated vertically.')
    assert.doesNotMatch(await toast.textContent(), /diagnostic/)
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: '', realtimeState: 'live' }); state.revision += 1; state.notify()
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
    await page.clock.fastForward(7_100)
  }
})

test('notification panels expire independently when failures arrive at different times', async () => {
  const toast = page.locator('[data-market-status]')
  const audit = toast.getByText(/Data audit:.*Audit failed/)
  const download = toast.getByText(/History download:.*Download failed/)
  try {
    await page.clock.fastForward(7_100)
    await electron.evaluate(() => globalThis.__workspaceFixture.publishAudit({ phase: 'failed', error: 'audit diagnostic' }))
    await audit.waitFor({ state: 'visible' })
    await page.clock.fastForward(4_000)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'failed', error: 'download diagnostic' })
    })
    await download.waitFor({ state: 'visible' })
    assert.equal(await audit.isVisible(), true, 'A recovered issue remains visible for its full lifetime.')
    await page.clock.fastForward(3_100)
    await audit.waitFor({ state: 'hidden' })
    assert.equal(await download.isVisible(), true, 'A newer panel retains its own seven-second lifetime.')
    await page.clock.fastForward(4_000)
    await download.waitFor({ state: 'hidden' })
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
    await page.clock.fastForward(7_100)
  }
})

test('queued notification panels appear after the visible panels expire', async () => {
  const toast = page.locator('[data-market-status]')
  try {
    await page.clock.fastForward(7_100)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: 'market diagnostic', realtimeState: 'live' })
      state.revision += 1; state.notify()
      state.publishAudit({ phase: 'failed', error: 'audit diagnostic' })
      state.publishDownload({ phase: 'failed', error: 'download diagnostic' })
    })
    await toast.getByText(/Market:.*Market data is unavailable/).waitFor({ state: 'visible' })
    await toast.getByText(/Data audit:.*Audit failed/).waitFor({ state: 'visible' })
    await toast.getByText(/History download:.*Download failed/).waitFor({ state: 'visible' })
    await page.clock.fastForward(4_000)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.realtimeState = 'disconnected'; state.revision += 1; state.notify()
    })
    await waitForAuditFixture(() => globalThis.__workspaceFixture.requests.some(value => value.statusLog?.issues?.some(issue => issue.includes('Some live market data is disconnected'))))
    assert.equal(await toast.getByText(/Market:.*Some live market data is disconnected/).count(), 0, 'The fourth issue waits for a free panel.')
    await page.clock.fastForward(3_100)
    await toast.getByText(/Market:.*Some live market data is disconnected/).waitFor({ state: 'visible' })
    await page.clock.fastForward(7_100)
    await toast.waitFor({ state: 'hidden' })
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: '', realtimeState: 'live' }); state.revision += 1; state.notify()
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
    await page.clock.fastForward(7_100)
  }
})

test('recovered market connections clear queued and visible notifications', async () => {
  const toast = page.locator('[data-market-status]')
  const connection = toast.getByText(/Market:.*Some live market data is disconnected/)
  try {
    await page.clock.fastForward(7_100)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: 'market diagnostic', realtimeState: 'live' }); state.revision++; state.notify()
      state.publishAudit({ phase: 'failed', error: 'audit diagnostic' })
      state.publishDownload({ phase: 'failed', error: 'download diagnostic' })
    })
    await toast.getByText(/History download:.*Download failed/).waitFor({ state: 'visible' })
    const start = await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      const count = state.requests.length
      state.realtimeState = 'disconnected'; state.revision++; state.notify()
      return count
    })
    await waitForAuditFixture(count => globalThis.__workspaceFixture.requests.slice(count).some(value => value.statusLog?.realtime === 'disconnected'), start)
    assert.equal(await connection.count(), 0)
    const recovery = await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      const count = state.requests.length
      state.realtimeState = 'live'; state.revision++; state.notify()
      return count
    })
    await waitForAuditFixture(count => globalThis.__workspaceFixture.requests.slice(count).some(value => value.statusLog?.realtime === 'live'), recovery)
    await page.clock.fastForward(7_100)
    assert.equal(await connection.count(), 0, 'A recovered connection must not surface after the queue advances.')
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.realtimeState = 'disconnected'; state.revision++; state.notify()
    })
    await connection.waitFor({ state: 'visible' })
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.realtimeState = 'live'; state.revision++; state.notify()
    })
    await connection.waitFor({ state: 'hidden' })
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { error: '', realtimeState: 'live' }); state.revision++; state.notify()
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
    await page.clock.fastForward(7_100)
  }
})

test('a repeated failure after recovery receives a new full notification lifetime', async () => {
  const toast = page.locator('[data-market-status]')
  const audit = toast.getByText(/Data audit:.*Audit failed/)
  try {
    await page.clock.fastForward(7_100)
    await electron.evaluate(() => globalThis.__workspaceFixture.publishAudit({ phase: 'failed', error: 'audit diagnostic' }))
    await audit.waitFor({ state: 'visible' })
    await page.clock.fastForward(4_000)
    await electron.evaluate(() => globalThis.__workspaceFixture.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] }))
    await waitForAuditFixture(() => !globalThis.__workspaceFixture.requests.filter(value => value.statusLog).at(-1)?.statusLog.issues.some(issue => issue.includes('Audit failed')))
    await electron.evaluate(() => globalThis.__workspaceFixture.publishAudit({ phase: 'failed', error: 'audit diagnostic' }))
    await waitForAuditFixture(() => globalThis.__workspaceFixture.requests.filter(value => value.statusLog).at(-1)?.statusLog.issues.some(issue => issue.includes('Audit failed')))
    await page.clock.fastForward(3_100)
    assert.equal(await audit.isVisible(), true, 'A repeated failure is not dismissed by the previous instance timer.')
    await page.clock.fastForward(4_000)
    await audit.waitFor({ state: 'hidden' })
  } finally {
    await electron.evaluate(() => globalThis.__workspaceFixture.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] }))
    await page.clock.fastForward(7_100)
  }
})

test('new session job updates win over delayed initial settings responses', async () => {
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.holdAuditAction = 'status'; state.holdDownloadAction = 'status'
    })
    const settings = await openSettings('Market data')
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit && globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ serviceSession: 'new-audit-session', revision: 0, phase: 'running', progress: { completed: 2, total: 5 }, error: '', issues: [] })
      state.publishDownload({ serviceSession: 'new-download-session', revision: 0, phase: 'running', error: '', progress: { checked: 25, total: 100, available: 25, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 75 } })
    })
    await page.waitForFunction(() => !document.querySelector('[data-market-status]')?.textContent.includes('Downloading history'))
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.releaseAudit(); state.releaseDownload() })
    await waitForAuditFixture(() => !globalThis.__workspaceFixture.releaseAudit && !globalThis.__workspaceFixture.releaseDownload)
    await settings.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await settings.getByRole('progressbar', { name: 'Data audit progress' }).getAttribute('aria-valuenow'), '40')
    assert.equal(await settings.getByRole('progressbar', { name: 'History download progress' }).getAttribute('aria-valuenow'), '25')
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.holdAuditAction = null; state.holdDownloadAction = null
      state.releaseAudit?.(); state.releaseDownload?.()
      state.publishAudit({ phase: 'idle', error: '', progress: { completed: 0, total: 0 }, issues: [] })
      state.publishDownload({ phase: 'idle', error: '', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 } })
    })
    if (settingsWindow && !settingsWindow.isClosed()) await backToMarkets()
  }
})

test('a rejected old snapshot preserves notifications and backend exclusions remove rows immediately', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
  try {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.staleNextSnapshot = true; state.notify() })
    await waitForAuditFixture(() => globalThis.__workspaceFixture.staleReplies > 0)
    assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart', 'An old empty snapshot cannot clear selection.')
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.rows = state.rows.filter(row => row.instId !== 'BETA-USDT-SWAP')
      state.loading = true; state.revision += 1; state.notify()
    })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View ZETA-USDT-SWAP chart"]').waitFor()
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '3')
    assert.equal(await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').count(), 0)
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.rows = []; state.loading = false; state.revision += 1; state.notify() })
    await page.locator('[data-market-list]').getByText('No qualified contracts', { exact: true }).waitFor()
    await page.locator('[data-timeframe-panel]').first().getByText('No qualified contracts', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0')
    assert.equal(await page.locator('[data-chart-inst]').count(), 0)
    const snapshots = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length)
    await page.clock.fastForward(31_000)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), snapshots, 'The renderer must not poll or defer backend membership changes.')
    await assertWorkspaceLayout(page)
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.rows = state.initialRows; state.loading = false; state.revision += 1; state.notify() })
    await page.locator('[data-market-index][aria-label="View BETA-USDT-SWAP chart"]').click()
  }
})

test('empty snapshots distinguish startup, verification failures, confirmed exclusions, and recovery', async () => {
  const publish = async values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values)
    state.revision += 1
    state.notify()
  }, values)
  const assertEmpty = async title => {
    await page.locator('[data-market-list]').getByText(title, { exact: true }).waitFor()
    await page.locator('[data-timeframe-panel]').first().getByText(title, { exact: true }).waitFor()
    assert.equal(await page.locator('[data-chart-inst]').count(), 0)
    if (title !== 'No qualified contracts') assert.equal(await page.getByText('No qualified contracts', { exact: true }).count(), 0, 'An unverified empty response must not claim that all contracts failed the filters.')
  }
  try {
    await publish({ rows: [], loading: true, error: '', catalogSource: 'none', catalogProgress: undefined })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await assertEmpty('Loading contracts')
    // A full initial snapshot is not proof that qualification has finished.
    await waitForMarketStatus('Refreshing')
    await publish({ catalogSource: 'live', catalogProgress: { total: 4, completed: 2, verified: 0, failed: 1, unknown: 1, pending: 2 } })
    await assertEmpty('Verifying contracts')
    await page.locator('[data-market-list]').getByText('Checking enabled conditions: 2 / 4 contracts completed.', { exact: true }).waitFor()
    await publish({ catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 4 } })
    await assertEmpty('Updating market data')
    await waitForMarketStatus('Updating 4 contracts')
    await publish({ catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 2 } })
    await waitForMarketStatus('Updating 2 contracts')
    await publish({ loading: false, error: 'Order book data is unavailable. Qualification could not be verified.', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 } })
    await assertEmpty('Market verification unavailable')
    const marketError = page.locator('[data-market-status] p').filter({ hasText: 'Market: Market data is unavailable. Check the connection and data service.' })
    await marketError.waitFor({ state: 'visible' })
    assert.doesNotMatch(await page.locator('[data-market-status]').textContent(), /Order book data is unavailable/)
    await publish({ error: '' })
    await page.clock.fastForward(7_100)
    await marketError.waitFor({ state: 'hidden' })
    await assertEmpty('Market verification unavailable')
    await publish({ catalogSource: 'none', catalogProgress: undefined })
    await waitForMarketStatus('Waiting')
    await assertEmpty('Market verification unavailable')
    await publish({ loading: true, catalogSource: 'live', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 4, unknown: 0, pending: 0 } })
    await assertEmpty('No qualified contracts')
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending: 0 } })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-chart-inst="BETA-USDT-SWAP"]').length === 3)
    assert.equal(await page.getByText('No qualified contracts', { exact: true }).count(), 0)
  } finally {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', catalogSource: 'live', catalogProgress: undefined })
    await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  }
})


test('completed unknown qualification does not report pending acquisition during unrelated background work', async () => {
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.rows = []
      state.loading = true
      state.error = ''
      state.catalogSource = 'live'
      state.catalogProgress = { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 }
      state.revision += 1
      state.notify()
    })
    await waitForMarketStatus('Incomplete')
    await page.waitForFunction(() => document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count') === '0')
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'The renderer displays the backend membership immediately.')
    await page.locator('[data-market-list]').getByText('Market verification unavailable', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-market-list]').getByText(/^Updating \d+ contracts$/).count(), 0, 'Completed but unproven observations are not pending acquisition.')
    assert.equal(await page.getByText('Updating market data', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Verifying contracts', { exact: true }).count(), 0)
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      Object.assign(state, { rows: state.initialRows, loading: false, error: '', catalogSource: 'live', catalogProgress: undefined })
      state.revision += 1
      state.notify()
    })
    await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  }
})

test('temporary qualification gaps preserve the current chart and interaction until exclusions are confirmed', async () => {
  const publish = async values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values)
    state.revision += 1
    state.notify()
  }, values)
  const assertRetained = async title => {
    await page.locator('[data-market-list]').getByText(title, { exact: true }).waitFor()
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'The renderer must use the backend membership immediately.')
    assert.equal(await page.locator('[data-chart-inst]').first().getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    assert.equal(await page.evaluate(() => globalThis.__continuityChart === document.querySelector('[data-chart-inst]') && globalThis.__continuitySVG === document.querySelector('svg[data-rendered-inst]')), true, 'A temporary verification gap must preserve the existing chart surface.')
    assert.match(await page.locator('[data-chart-inst] [aria-live="off"] p').first().textContent(), /Selected/, 'The ongoing candle inspection must survive verification gaps.')
    assert.equal(await page.getByText('No qualified contracts', { exact: true }).count(), 0)
  }
  try {
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
    await page.evaluate(() => {
      globalThis.__continuityChart = document.querySelector('[data-chart-inst]')
      globalThis.__continuitySVG = document.querySelector('svg[data-rendered-inst]')
    })
    const bounds = await page.locator('svg[data-rendered-inst]').first().boundingBox()
    await page.mouse.move(bounds.x + bounds.width * .4, bounds.y + bounds.height * .1)
    await page.mouse.down()
    await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
    await publish({ rows: [], loading: true, error: '', catalogSource: 'live', catalogProgress: { total: 4, completed: 0, verified: 0, failed: 0, unknown: 0, pending: 4 } })
    await waitForMarketStatus('Verifying 0/4')
    await page.waitForFunction(() => document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count') === '0')
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'A verification gap may empty backend membership without discarding the current chart.')
    assert.equal(await page.locator('[data-chart-inst]').first().getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    await assertRetained('Verifying contracts')
    await publish({ loading: false, error: 'Order book observations are temporarily unavailable.', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 } })
    await assertRetained('Market verification unavailable')
    await publish({ error: '', catalogSource: 'none', catalogProgress: undefined })
    await waitForMarketStatus('Waiting')
    await assertRetained('Market verification unavailable')
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), catalogSource: 'live', catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending: 0 } })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
    assert.equal(await page.evaluate(() => globalThis.__continuityChart === document.querySelector('[data-chart-inst]') && globalThis.__continuitySVG === document.querySelector('svg[data-rendered-inst]')), true, 'Recovery of the selected contract must not remount the chart.')
    assert.match(await page.locator('[data-chart-inst] [aria-live="off"] p').first().textContent(), /Selected/)
    await page.mouse.up()
    await publish({ rows: [], loading: true, catalogProgress: { total: 4, completed: 4, verified: 0, failed: 4, unknown: 0, pending: 0 } })
    await waitForMarketStatus('Refreshing')
    await page.locator('[data-market-list]').getByText('No qualified contracts', { exact: true }).waitFor()
    await page.locator('[data-timeframe-panel]').first().getByText('No qualified contracts', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-chart-inst]').count(), 0, 'A confirmed complete exclusion must clear the chart.')
  } finally {
    await page.mouse.up()
    await page.evaluate(() => { delete globalThis.__continuityChart; delete globalThis.__continuitySVG })
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', catalogSource: 'live', catalogProgress: undefined })
    await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  }
})

test('backend readmission updates membership without restoring a previously excluded selection', async () => {
  const publish = async values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values); state.revision += 1; state.notify()
  }, values)
  try {
    await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').click()
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows.filter(row => row.instId !== 'BETA-USDT-SWAP')), loading: false })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View ZETA-USDT-SWAP chart"]').waitFor()
    assert.equal(await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').count(), 0)
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 147, rankingChange: -7 } : row)) })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '147')
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart', 'Readmission must preserve the current user selection.')
    assert.equal(await page.locator('[data-market-index="0"]').getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '4')
  } finally {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', catalogSource: 'live', catalogProgress: undefined })
    await page.locator('[aria-label="View BETA-USDT-SWAP chart"]').click()
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
  }
})

test('missing recent candles remain visible with repair status until the complete chart is restored', async () => {
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-timeframe-panel="15m"] [data-chart-inst="BETA-USDT-SWAP"]'), status = page.locator('[data-chart-shared-status-item="15m"]')
  const publish = phase => electron.evaluate(async ({ ipcMain, BrowserWindow }, phase) => {
    const state = globalThis.__workspaceFixture
    if (!state.integrityBaseline) {
      state.chartGeneration += 1
      state.integrityBaseline = await globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    }
    const frame = structuredClone(state.integrityBaseline), step = frame.intervalMS
    frame.revision += { sparse: 1, stale: 2, repaired: 3 }[phase]
    frame.priceState = 'ready'
    frame.liveBar = { ...frame.bars.at(-1), hour: frame.endHour + 73 * step,
      open: 133, high: 134, low: 132, close: 133, confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null }
    if (phase === 'sparse') frame.bars.splice(40, 1)
    if (phase === 'repaired') {
      frame.bars = frame.bars.map(bar => ({ ...bar, hour: bar.hour + 72 * step }))
      frame.endHour += 72 * step
      frame.latestEnd = frame.endHour
    }
    state.chartOverride = frame
    globalThis.__workspaceFixture.sendChart(frame)
    return { generation: frame.generation, endHour: frame.endHour, liveHour: frame.liveBar.hour, hours: [...frame.bars.map(bar => bar.hour), frame.liveBar.hour] }
  }, phase)
  const waitForFrame = frame => page.waitForFunction(({ generation, endHour, liveHour }) => {
    const chart = document.querySelector('[data-timeframe-panel="15m"] [data-chart-inst="BETA-USDT-SWAP"]'), snapshot = chart?.__chartSnapshot
    return snapshot?.generation === generation && snapshot.liveBar?.hour === liveHour
      && snapshot.endHour === endHour && snapshot.priceState === 'ready'
  }, frame)
  try {
    for (const [phase, expected, message] of [
      ['sparse', 'partial', 'Repairing missing price history…'],
      ['stale', 'stale', 'Recent price history is stale; repairing…'],
    ]) {
      const frame = await publish(phase)
      await page.waitForFunction(({ generation, state }) => {
        const chart = document.querySelector('[data-timeframe-panel="15m"] [data-chart-inst="BETA-USDT-SWAP"]')
        return chart?.__chartSnapshot.generation === generation && chart.dataset.chartCandleState === state
      }, { generation: frame.generation, state: expected })
      await status.getByText(message, { exact: false }).waitFor({ state: 'visible' })
      assert.doesNotMatch(await status.textContent(), /Chart ready/)
      assert.equal(await chart.getAttribute('data-chart-incomplete'), 'true')
      assert.equal(await chart.locator('svg[data-rendered-inst]').isVisible(), true, 'Actual prices remain visible while missing slots repair.')
      const viewport = await chart.evaluate(captureChartViewport)
      const available = new Set(frame.hours)
      assert.deepEqual(viewport.bars.map(bar => bar.hour), chartViewportHours(viewport).filter(hour => available.has(hour)),
        'While history is incomplete, draw exactly the source candles intersecting the viewport without inventing missing prices.')
      assert.equal((await chart.evaluate(node => node.__chartSnapshot.liveBar?.hour)), frame.liveHour, 'The live candle stays available even when the synchronized viewport is historical.')
      assert.match(await chart.locator('svg[data-rendered-inst] [data-chart-price-label-value]').textContent(), /^[+-]?\d+\.\d+%$/, 'The visible price label remains well formed across the historical gap.')
    }
    await waitForFrame(await publish('repaired'))
    await page.clock.fastForward(7_100)
    await page.waitForFunction(() => !document.querySelector('[data-chart-shared-status-item="15m"]')?.textContent.includes('repairing'))
    assert.equal(await chart.getAttribute('data-chart-candle-state'), 'ready')
    assert.equal(await chart.getAttribute('data-chart-incomplete'), 'false')
    await page.clock.fastForward(7_100)
    assert.equal(await status.count(), 0)
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      delete state.chartOverride
      delete state.integrityBaseline
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
  }
})

test('failed and unavailable chart sources preserve qualified rows and report distinct status until a pushed recovery', async () => {
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-timeframe-panel="15m"] [data-chart-inst="BETA-USDT-SWAP"]')
  try {
    await electron.evaluate(async ({ ipcMain }) => {
      const state = globalThis.__workspaceFixture
      state.chartGeneration += 1
      const frame = await globalThis.__workspaceFixture.request(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      const range = { from: frame.bars[0].hour, through: frame.endHour }
      state.sourceBaseline = structuredClone(frame)
      state.chartOverride = { ...frame, revision: frame.revision + 1, oiState: 'error', takerState: 'unavailable',
        oiStatus: { ...range, state: 'error', error: 'OI endpoint temporarily unavailable', retryAt: Date.now() + 60_000 },
        takerStatus: { ...range, state: 'unavailable', reason: 'not-published' },
        bars: frame.bars.map(bar => ({ ...bar, oi: null, buy: null, sell: null, oiObserved: false, takerObserved: true, statisticsObserved: false, statisticsSources: 2 })) }
    })
    // Begin with no numeric observation for this source range. An already
    // observed value is correctly retained through a later temporary failure.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-timeframe-panel="15m"] [data-chart-inst]')?.dataset.chartOiState === 'error')
    assert.equal(await chart.getAttribute('data-chart-oi-state'), 'error')
    assert.equal(await chart.getAttribute('data-chart-taker-state'), 'unavailable')
    assert.equal(await chart.getAttribute('data-chart-taker-samples'), '0')
    assert.equal(await chart.locator('svg[data-rendered-inst]').isVisible(), true)
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '4')
    assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.chartOverride = { ...state.sourceBaseline, revision: state.sourceBaseline.revision + 2 }
      globalThis.__workspaceFixture.sendChart(state.chartOverride)
    })
    await page.waitForFunction(() => document.querySelector('[data-timeframe-panel="15m"] [data-chart-inst]')?.dataset.chartOiState === 'ready'
      && document.querySelector('[data-timeframe-panel="15m"] [data-chart-inst]')?.dataset.chartTakerState === 'ready')
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; delete state.chartOverride; delete state.sourceBaseline })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').first().waitFor({ state: 'visible' })
  }
})

const completeStackedViewports = async () => {
  const charts = page.locator('[data-chart-inst]')
  const readings = []
  for (let index = 0; index < await charts.count(); index++) {
    const reading = await charts.nth(index).evaluate(captureChartViewport)
    const available = await charts.nth(index).evaluate(node => ({ start: node.__chartSnapshot.bars[0]?.hour, end: node.__chartSnapshot.liveBar?.hour ?? node.__chartSnapshot.bars.at(-1)?.hour }))
    const expectedHours = chartViewportHours(reading).filter(hour => hour <= available.end && hour >= available.start)
    assert.deepEqual(reading.bars.map(bar => bar.hour), expectedHours, 'Every available native candle intersecting the viewport must be drawn.')
    readings.push({ ...reading, expectedHours })
  }
  return readings
}

const waitForWorkspaceSize = async width => {
  await page.waitForFunction(width => innerWidth === width && document.querySelector('[data-layout="market-workspace"]').getBoundingClientRect().width === width
    && [...document.querySelectorAll('[data-chart-workspace]')].every(chart => {
    const svg = chart.querySelector('svg[data-rendered-inst]'), plot = chart.querySelector('[data-chart-plot]')
    return svg && Math.abs(svg.viewBox.baseVal.width - plot.clientWidth) < 1 && Math.abs(svg.viewBox.baseVal.height - plot.clientHeight) < 1
  }), width)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

test('larger windows retain control density while showing more rows and candles in every stacked timeframe', async () => {
  const publish = values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values)
    state.revision += 1
    state.notify()
  }, values)
  const client = await page.context().newCDPSession(page)
  const measure = () => page.evaluate(() => {
    const list = document.querySelector('[data-market-list]'), scroller = list.querySelector('[data-market-scroll]')
    const row = list.querySelector('[data-market-index]'), bounds = row.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
    return { rowHeight: bounds.height, fontSize: getComputedStyle(row).fontSize, listWidth: list.getBoundingClientRect().width,
      visibleRows: [...list.querySelectorAll('[data-market-index]')].filter(row => { const r = row.getBoundingClientRect(); return r.top >= viewport.top && r.bottom <= viewport.bottom }).length,
      candles: [...document.querySelectorAll('[data-chart-rendered-bars]')].map(chart => Number(chart.dataset.chartRenderedBars)) }
  })
  try {
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await publish({ rows: await electron.evaluate(() => {
      const initial = globalThis.__workspaceFixture.initialRows
      return [...initial, ...Array.from({ length: 80 }, (_, index) => ({ ...initial[0], instId: `MARKET${index}-USDT-SWAP`, rankingChange: .01 }))]
    }) })
    await waitForWorkspaceSize(1200)
    const normalViews = await completeStackedViewports()
    const normal = await measure()
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1510, height: 1000, deviceScaleFactor: 1, mobile: false })
    await waitForWorkspaceSize(1510)
    const expandedViews = await completeStackedViewports()
    await assertWorkspaceLayout(page)
    const expanded = await measure()
    assert.equal(expanded.rowHeight, normal.rowHeight)
    assert.equal(expanded.fontSize, normal.fontSize)
    assert.ok(expanded.listWidth >= normal.listWidth && expanded.listWidth <= 420)
    assert.ok(expanded.visibleRows > normal.visibleRows, `${JSON.stringify({ normal, expanded })}`)
    assert.equal(expandedViews.length, 3)
    assert.ok(expandedViews.every((view, index) => view.expectedHours.length > normalViews[index].expectedHours.length))
    assert.deepEqual(expandedViews.map(view => view.barSpacing), normalViews.map(view => view.barSpacing), 'Resizing preserves the chosen candle pitch.')
    const focusCount = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartFocus).length)
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1520, height: 1000, deviceScaleFactor: 1, mobile: false })
    await page.waitForFunction(() => innerWidth === 1520)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartFocus).length), focusCount,
      'Resizing inside a density band must reuse the same data demand.')
    for (const [width, height] of [[1710, 1008], [1600, 1000], [2600, 1300]]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await waitForWorkspaceSize(width)
      const views = await completeStackedViewports()
      assert.ok(views.every(view => view.barSpacing === normalViews[0].barSpacing))
      assert.ok(views.every((view, index) => view.expectedHours.length > normalViews[index].expectedHours.length))
      await assertWorkspaceLayout(page)
      const resized = await measure()
      assert.equal(resized.rowHeight, normal.rowHeight)
      assert.equal(resized.fontSize, normal.fontSize)
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
    await waitForWorkspaceSize(1200)
    assert.deepEqual((await completeStackedViewports()).map(view => view.expectedHours.length), normalViews.map(view => view.expectedHours.length))
  } finally {
    await client.send('Emulation.clearDeviceMetricsOverride')
    await client.detach()
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows) })
  }
})

test('compact workspaces preserve complete market prices and keep overflowing chart actions reachable', async () => {
  const previousSize = page.viewportSize()
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.rows = state.initialRows.map(row => row.instId === 'BETA-USDT-SWAP'
        ? { ...row, lastPrice: .0000012345, tickSz: '0.0000000001' } : row)
      state.revision += 1
      state.notify()
    })
    for (const width of [1000, 1200, 1510, 1710]) {
      await page.setViewportSize({ width, height: 900 })
      await assertWorkspaceLayout(page)
      const price = page.locator('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2) span')
      assert.equal(await price.getAttribute('title'), '0.0000012345')
      assert.equal(await price.textContent(), '0.0000012345')
      assert.equal(await price.evaluate(element => getComputedStyle(element).textOverflow), 'ellipsis')
      assert.equal(await page.getByRole('button', { name: 'Screenshot', exact: true }).isVisible(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    }
  } finally {
    await page.setViewportSize(previousSize)
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.rows = state.initialRows
      state.revision += 1
      state.notify()
    })
  }
})

test('compact density reserves at least eighty-five percent of each stacked chart for price geometry', async () => {
  const previousSize = page.viewportSize(), folder = process.env.PERPETUAL_SWAP_DENSITY_SCREENSHOTS
  const baseline = process.env.PERPETUAL_SWAP_DENSITY_STAGE === 'before'
  try {
    await page.emulateMedia({ colorScheme: 'dark' })
    if (folder) await mkdir(folder, { recursive: true })
    const readings = []
    for (const width of [1200, 1710]) {
      await page.setViewportSize({ width, height: width === 1200 ? 1007 : 1008 })
      await waitForWorkspaceSize(width)
      const viewports = await completeStackedViewports()
      assert.equal(viewports.length, 3)
      const reading = await page.evaluate(() => ({ width: innerWidth,
        sidebar: document.querySelector('[data-market-list]').getBoundingClientRect().width,
        rowHeight: document.querySelector('[data-market-index]').getBoundingClientRect().height,
        fontSize: getComputedStyle(document.querySelector('[data-market-index]')).fontSize,
        charts: [...document.querySelectorAll('[data-chart-workspace]')].map(chart => {
          const svg = chart.querySelector('svg[data-rendered-inst]'), clip = svg.querySelector('clipPath[id$="-price"] rect')
          const height = chart.getBoundingClientRect().height
          const svgBounds = svg.getBoundingClientRect()
          const priceHeight = Number(clip.getAttribute('height')) * svgBounds.height / svg.viewBox.baseVal.height
          const priceAxis = svg.querySelector('[data-chart-price-axis]')
          const axisClip = svg.querySelector(priceAxis.getAttribute('clip-path').slice(4, -1))?.querySelector('rect')
          const axisTop = Number(axisClip?.getAttribute('y')), axisHeight = Number(axisClip?.getAttribute('height'))
          const axisBottom = axisTop + axisHeight
          const panelTop = Number(clip.getAttribute('y')), panelBottom = panelTop + Number(clip.getAttribute('height'))
          const ticks = [...svg.querySelectorAll('[data-chart-price-tick] > text')]
          const tickBounds = ticks.map(tick => {
            const bounds = tick.getBoundingClientRect()
            return { text: tick.textContent, y: Number(tick.getAttribute('y')),
              left: Math.max(0, svgBounds.left - bounds.left), right: Math.max(0, bounds.right - svgBounds.right) }
          })
          return { height, priceHeight, ratio: priceHeight / height, bars: Number(chart.querySelector('[data-chart-inst]').dataset.chartRenderedBars),
            fontSize: getComputedStyle(svg).fontSize, tickBounds, axisTop, axisBottom, panelTop, panelBottom }
        }) }))
      readings.push(reading)
      if (!baseline) {
        assert.ok(reading.sidebar <= Math.max(280, reading.width * .2) + 1)
        assert.ok(reading.rowHeight >= 28 && reading.rowHeight <= 30)
        assert.equal(reading.fontSize, '12px')
        assert.ok(reading.charts.every(chart => chart.ratio >= .85), JSON.stringify(reading))
        assert.ok(reading.charts.every(chart => chart.tickBounds.length > 0 && chart.tickBounds.every(tick => tick.left <= .5 && tick.right <= .5)), JSON.stringify(reading))
        assert.ok(reading.charts.every(chart => Math.abs(chart.axisTop - chart.panelTop) < .01 && Math.abs(chart.axisBottom - chart.panelBottom) < .01
          && chart.tickBounds.some(tick => tick.y < chart.axisTop) && chart.tickBounds.some(tick => tick.y > chart.axisBottom)),
        `Price ticks must extend past and be clipped to both panel edges: ${JSON.stringify(reading)}`)
      }
      if (!baseline) {
        assert.equal(await page.locator('[data-shared-chart-title]').count(), 1)
        assert.equal(await page.locator('[data-shared-chart-legend]').count(), 0)
        assert.equal(await page.locator('[data-chart-panel-header]').count(), 0)
        const chart = page.locator('[data-chart-workspace]').first()
        assert.deepEqual(await page.locator('[data-chart-title]').allTextContents(), ['BETA-USDT'])
        assert.equal(await chart.locator('[data-chart-inspection-readout]').isVisible(), false)
        const descriptions = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => {
          const id = svg.getAttribute('aria-describedby'), readout = document.getElementById(id)
          return { id, exists: !!readout, hidden: readout?.hidden, text: readout?.textContent }
        }))
        assert.equal(new Set(descriptions.map(item => item.id)).size, 3)
        assert.ok(descriptions.every(item => item.exists && item.hidden && /Open.*High.*Low.*Close/.test(item.text)))
        assert.equal(await chart.locator('[data-chart-legend-value]').count(), 0)
        const plot = await chart.locator('[data-chart-plot]').boundingBox()
        await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2)
        await page.mouse.down()
        await chart.locator('[data-chart-inspection-readout]').waitFor({ state: 'visible' })
        assert.deepEqual(await chart.locator('[data-chart-plot]').boundingBox(), plot)
        assert.equal(await chart.locator('[data-chart-legend-value]').count(), 1)
        const expected = await chart.locator('[data-chart-inst]').evaluate(element => {
          const hour = Number(element.querySelector('[data-chart-inspected-hour]').dataset.chartInspectedHour)
          const bar = element.__chartSnapshot.bars.find(bar => bar.hour === hour)
          return { close: bar.close }
        })
        assert.equal(Number(await chart.locator('[data-chart-ohlc="close"] span[title]').textContent()), expected.close)
        assert.equal(await chart.locator('[data-chart-inspection-indicator="VWAP(14)"]').count(), 0)
        await page.mouse.up()
        await chart.locator('[data-chart-inspection-readout]').waitFor({ state: 'hidden' })
      }
      if (folder) {
        await page.screenshot({ path: join(folder, `${baseline ? 'before' : 'after'}-${width}.png`) })
        if (!baseline && width === 1710) {
          await page.emulateMedia({ colorScheme: 'light' })
          await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().map(animation => animation.finished)) })
          await page.screenshot({ path: join(folder, 'after-1710-light.png') })
          await page.emulateMedia({ colorScheme: 'dark' })
        }
      }
    }
    if (process.env.PERPETUAL_SWAP_LIGHT_SCREENSHOT) {
      await page.emulateMedia({ colorScheme: 'light' })
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().map(animation => animation.finished)) })
      const colors = await page.evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        row: getComputedStyle(document.querySelector('[data-market-index="1"] td')).color,
        button: getComputedStyle(document.querySelector('[data-chart-toolbar] button')).color,
      }))
      assert.notEqual(colors.row, colors.background)
      assert.notEqual(colors.button, colors.background)
      console.log('Stable light theme colors:', colors)
      await page.screenshot({ path: process.env.PERPETUAL_SWAP_LIGHT_SCREENSHOT })
    }
    if (!baseline) assert.ok(readings[1].charts[0].bars > readings[0].charts[0].bars)
    if (folder) await import('node:fs/promises').then(({ writeFile }) => writeFile(join(folder, `${baseline ? 'before' : 'after'}-measurements.json`), JSON.stringify(readings, null, 2)))
  } finally {
    await page.setViewportSize(previousSize)
  }
})
