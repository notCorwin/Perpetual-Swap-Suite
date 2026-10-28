import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertWorkspaceLayout, selectTimeframe } from '../../scripts/chart-acceptance.mjs'

const root = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'perp-workspace-e2e-'))
let electron, page

before(async () => {
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Stub only the desktop boundary. These renderer checks remain independent
  // of source downloads, persistence workers, and any configured AI service.
  await electron.evaluate(({ ipcMain, BrowserWindow }) => {
    const preferences = { chartTimeframe: '15m', rankingLookback: 15, historyDays: 30, liquidity: {
      spread: { enabled: true, maxPercent: .05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: true, maxPercent: .1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
      openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 },
    } }
    const rows = [['BETA', -3], ['ZETA', 3], ['ALPHA', 1], ['NULL', null]].map(([symbol, rankingChange]) => ({
      instId: `${symbol}-USDT-SWAP`, price: 100, lastPrice: 100, rankingChange, rankingAsOf: 1_800_000_000_000,
      turnover24hUSDT: 50_000_000,
    }))
    const state = globalThis.__workspaceFixture = { preferences, analysisSettings: { model: 'fixture/vision', hasAPIKey: false }, rows, initialRows: rows, requests: [], coldTimeframes: [], revision: 1, loading: false, error: '', realtimeState: 'live', updatedAt: 1_800_000_000_000, catalogSource: 'live', catalogProgress: undefined, failNextSave: false, failSnapshots: 0, staleNextSnapshot: false, staleReplies: 0, chartGeneration: 1, bollMode: 'standard', holdNextSnapshot: false, releaseSnapshot: null, snapshotActive: 0, snapshotMaximum: 0,
      holdAuditAction: null, releaseAudit: null, heldAuditReply: null,
      holdDownloadAction: null, releaseDownload: null, heldDownloadReply: null,
      historyDownload: { schemaVersion: 2, phase: 'idle', startedAt: null, updatedAt: null, finishedAt: null,
        contracts: { completed: 0, total: 0 }, streams: { completed: 0, total: 0 },
        progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 },
        active: [], failures: [], error: '', revision: 0, serviceSession: 'download-fixture' },
      audit: { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '', revision: 0, serviceSession: 'audit-fixture' } }
    state.notify = () => {
      state.rows = [...state.rows].sort((left, right) => (right.rankingChange == null ? -1 : Math.abs(right.rankingChange))
        - (left.rankingChange == null ? -1 : Math.abs(left.rankingChange)) || left.instId.localeCompare(right.instId, 'en'))
      BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
    }
    state.publishAudit = values => {
      state.audit = { ...state.audit, ...structuredClone(values), revision: state.audit.revision + 1 }
      const report = structuredClone(state.audit)
      BrowserWindow.getAllWindows()[0].webContents.send('radar:audit-changed', report)
      return report
    }
    state.publishDownload = values => {
      state.historyDownload = { ...state.historyDownload, ...structuredClone(values), revision: state.historyDownload.revision + 1 }
      const report = structuredClone(state.historyDownload)
      BrowserWindow.getAllWindows()[0].webContents.send('radar:history-download-changed', report)
      return report
    }
    const prepared = ({ instId, timeframe }) => {
      if (state.chartOverride?.instId === instId && state.chartOverride.timeframe === timeframe) return structuredClone(state.chartOverride)
      const intervalMS = timeframe === '1H' ? 3_600_000 : timeframe === '15m' ? 900_000 : 300_000
      const endHour = Math.floor(Date.UTC(2026, 9, 18) / intervalMS) * intervalMS
      const bars = Array.from({ length: 96 }, (_, index) => {
        const close = state.bollMode === 'constant' ? 100 : 100 + index * .01
        return { hour: endHour - (95 - index) * intervalMS, open: close + (index % 2 ? -.05 : .05), high: close + .2, low: close - .2, close,
          confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
          ema: close, vwap: close - .02, bollUpper: state.bollMode === 'constant' ? 100 : close + .5,
          bollMiddle: state.bollMode === 'constant' ? 100 : close, bollLower: state.bollMode === 'negative' ? -1 : state.bollMode === 'constant' ? 100 : close - .5,
          roc: .5, maroc: .25, rsi6: 50, rsi12: 55, rsi24: 60, atrPercent: .4 / close * 100, bbw: state.bollMode === 'constant' ? 0 : state.bollMode === 'negative' ? (close + 1.5) / close * 100 : 1 / close * 100, oi: 1_000_000 + index, buy: 12_000, sell: 10_000 }
      })
      return { instId, timeframe, intervalMS, endHour, latestEnd: endHour, oldestHour: bars[0].hour, historyExhausted: true,
        generation: state.chartGeneration, revision: state.chartGeneration, bars, oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '' }
    }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (_event, value) => {
      state.requests.push(value)
      if (value.preferences) {
        if (value.preferences.action === 'update') {
          if (state.failNextSave) { state.failNextSave = false; throw new Error('The preferences could not be saved.') }
          state.preferences = { ...state.preferences, ...value.preferences.values }
          state.revision += 1
        }
        return state.preferences
      }
      if (value.snapshot) {
        if (state.failSnapshots > 0) { state.failSnapshots--; throw new Error('Snapshot temporarily unavailable.') }
        const stale = state.staleNextSnapshot
        state.staleNextSnapshot = false
        if (stale) state.staleReplies += 1
        const snapshot = { rows: stale ? [] : state.rows, turnoverOrder: [...state.rows].sort((a, b) => (b.turnover24hUSDT ?? -1) - (a.turnover24hUSDT ?? -1) || a.instId.localeCompare(b.instId, 'en')).map(row => row.instId), revision: state.revision - (stale ? 1 : 0), serviceSession: 'renderer-fixture',
          realtimeState: state.realtimeState, updatedAt: state.updatedAt,
          catalogSource: state.catalogSource, catalogProgress: state.catalogProgress, error: state.error, loading: state.loading }
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
      if (value.chartUniverse) return { frames: state.rows.flatMap(({ instId }) => ['5m', '15m', '1H']
        .filter(timeframe => !state.coldTimeframes.includes(timeframe)).map(timeframe => prepared({ instId, timeframe }))) }
      if (value.chartFocus) return { ok: true }
      if (value.chartLocal || value.chartHistory) {
        const query = value.chartLocal ?? value.chartHistory
        return state.coldTimeframes.includes(query.timeframe) ? null : prepared(query)
      }
      if (value.chartWindow) return state.coldTimeframes.includes(value.chartWindow.timeframe)
        ? { ...prepared(value.chartWindow), bars: [], priceState: 'loading', indicatorState: 'loading', oiState: 'loading', takerState: 'loading' }
        : prepared(value.chartWindow)
      if (value.captureChart) return { ok: true }
      if (value.analysisSettings) {
        if (value.analysisSettings.action === 'save') state.analysisSettings = {
          model: value.analysisSettings.model, hasAPIKey: Boolean(value.analysisSettings.apiKey) || state.analysisSettings.hasAPIKey,
        }
        if (value.analysisSettings.action === 'removeKey') state.analysisSettings.hasAPIKey = false
        return { ...state.analysisSettings }
      }
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
    })
  })
  await page.setViewportSize({ width: Number(process.env.PERPETUAL_SWAP_UI_INITIAL_WIDTH ?? 800), height: Number(process.env.PERPETUAL_SWAP_UI_INITIAL_HEIGHT ?? 572) })
  // Install before mounting so renderer timers and performance.now() share one clock.
  await page.clock.install()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await mkdir(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, { recursive: true })
})
afterEach(async context => {
  if (!page) return
  if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `checkpoint-${context.name.slice(0, 35).replace(/[^a-z0-9]/gi, '-')}.png`) })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  if (await settingsPage().isVisible()) {
    const discard = settingsPage().getByRole('button', { name: 'Discard changes', exact: true })
    if (await discard.isVisible() && await discard.isEnabled()) await discard.click()
    const acceptDiscard = dialog => void dialog.accept()
    page.on('dialog', acceptDiscard)
    try { await backToMarkets() }
    finally { page.off('dialog', acceptDiscard) }
  }
})
after(async () => {
  try {
    if (page && process.env.PERPETUAL_SWAP_SETTINGS_SCREENSHOTS) {
      const directory = process.env.PERPETUAL_SWAP_SETTINGS_SCREENSHOTS
      await mkdir(directory, { recursive: true })
      await page.setViewportSize({ width: 1_600, height: 1_000 })
      await openSettings()
      for (const [category, file] of [['Workspace', 'workspace'], ['Liquidity filters', 'liquidity'], ['Market data', 'data'], ['AI analysis', 'analysis']]) {
        await chooseSettingsCategory(category)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.screenshot({ path: join(directory, `settings-page-${file}.png`) })
      }
    }
  } finally { await electron?.close(); await rm(userData, { recursive: true, force: true }) }
})

const selected = () => page.locator('[data-market-index][aria-selected="true"]')
const waitForMarketStatus = status => page.waitForFunction(status => document.querySelector('[data-market-status]')?.textContent.trim() === status, status)
const settingsPage = () => page.getByRole('main', { name: 'Settings', exact: true })
const chooseSettingsCategory = async category => {
  const settings = settingsPage()
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('link', { name: category, exact: true }).click()
  await settings.getByRole('heading', { name: category, exact: true, level: 2 }).waitFor()
}
const openSettings = async (category = 'Workspace') => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const settings = settingsPage()
  await settings.waitFor({ state: 'visible' })
  await chooseSettingsCategory(category)
  return settings
}
const backToMarkets = async () => {
  await settingsPage().getByRole('link', { name: 'Back to markets', exact: true }).click()
  await settingsPage().waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: 'Search contracts' }).waitFor({ state: 'visible' })
}
const emaCandleTarget = async (slot, fixture) => {
  const target = await page.locator('svg[data-rendered-inst]').evaluate((svg, { slot, intervalMS }) => {
    const commands = svg.querySelector('[data-chart-indicator="ema"]').getAttribute('d').match(/[ML][^ML]+/g)
    if (commands.length !== 97) throw new Error('The fixture must draw 96 EMA samples and their leading left-edge extension.')
    const x = Number.parseFloat(commands[slot + 1].slice(1))
    const rect = svg.getBoundingClientRect()
    return { x: rect.x + x / svg.viewBox.baseVal.width * rect.width, y: rect.y + rect.height * .1,
      hour: Number(svg.dataset.renderedStart) + slot * intervalMS }
  }, { slot, intervalMS: fixture.intervalMS })
  const expected = [...fixture.bars, ...(fixture.liveBar ? [fixture.liveBar] : [])].find(bar => bar.hour === target.hour)
  assert.ok(expected, 'The drawn candle must have an independent desktop-fixture observation.')
  return { ...target, close: expected.close }
}
const clickByRect = async locator => {
  await locator.scrollIntoViewIfNeeded()
  const bounds = await locator.boundingBox()
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, 'The control must have a rendered pointer target.')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  const hitTest = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect(), target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { acceptsPointer: target === element || element.contains(target), target: target?.tagName, role: target?.getAttribute('role'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  assert.equal(hitTest.acceptsPointer, true, `The control must receive pointer input at its drawn center: ${JSON.stringify(hitTest)}`)
  const target = await locator.boundingBox()
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
}

test('default selection uses absolute completed-candle change with nulls last and stable contract ties', async () => {
  assert.deepEqual(await page.locator('[data-market-index]').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label'))), [
    'View BETA-USDT-SWAP chart', 'View ZETA-USDT-SWAP chart', 'View ALPHA-USDT-SWAP chart', 'View NULL-USDT-SWAP chart',
  ])
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
  await page.locator('[data-chart-inst="BETA-USDT-SWAP"]').waitFor()
  assert.equal(await page.locator('[aria-label="Chart timeframe"] button[aria-pressed="true"]').textContent(), '15m')
  const changes = await page.locator('[data-market-index] td:last-child').allTextContents()
  assert.match(changes[0], /↓.*-3\.00%/)
  assert.match(changes[1], /↑.*\+3\.00%/)
  assert.equal(changes[3].trim(), '—')
  await assertWorkspaceLayout(page)
})

test('market arrow shortcuts survive contract clicks, toolbar focus and repeated chart switches', async () => {
  const expectMarket = async (key, symbol) => {
    await page.keyboard.press(key)
    await page.locator(`svg[data-rendered-inst="${symbol}-USDT-SWAP"]`).waitFor({ state: 'visible', timeout: 2_000 })
    assert.equal(await selected().getAttribute('aria-label'), `View ${symbol}-USDT-SWAP chart`)
    assert.equal(await page.locator('[data-chart-plot]').evaluate(plot => document.activeElement === plot), true,
      'Chart navigation must retain focus on the current chart surface.')
  }
  try {
    await page.getByRole('row', { name: 'View ZETA-USDT-SWAP chart', exact: true }).click()
    await expectMarket('ArrowDown', 'ALPHA')
    await expectMarket('ArrowUp', 'ZETA')
    await page.getByRole('button', { name: '15m', exact: true }).click()
    await expectMarket('ArrowRight', 'ALPHA')
    assert.equal(await page.locator('[aria-label="Chart timeframe"] [aria-pressed="true"]').textContent(), '15m')
    await page.getByRole('button', { name: 'Analyze Short', exact: true }).focus()
    await expectMarket('ArrowLeft', 'BETA')
    await expectMarket('ArrowUp', 'NULL')
    await expectMarket('ArrowDown', 'BETA')
    await page.getByRole('button', { name: 'Copy chart', exact: true }).click()
    await expectMarket('ArrowDown', 'ZETA')
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
    await expectMarket('ArrowDown', 'ALPHA')
  } finally {
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
  }
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
    'DOM focus regressions must be exercised without acquiring macOS window focus.')
})

test('clicking the chart releases search focus while editing and settings keep their arrow keys', async () => {
  const search = page.getByRole('textbox', { name: 'Search contracts' })
  try {
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
    await search.fill('BETA')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await search.evaluate(input => input.selectionStart), 3)
    assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
    await search.fill('')
    await page.locator('svg[data-rendered-inst]').click({ position: { x: 50, y: 50 } })
    assert.equal(await page.locator('[data-chart-plot]').evaluate(plot => document.activeElement === plot), true,
      'A chart click must explicitly transfer DOM focus after preventing pointer defaults for inspection.')
    await page.keyboard.press('ArrowDown')
    await page.locator('svg[data-rendered-inst="ZETA-USDT-SWAP"]').waitFor({ state: 'visible', timeout: 2_000 })
    for (const key of ['Shift+ArrowDown', 'Control+ArrowDown', 'Meta+ArrowDown', 'Alt+ArrowDown']) await page.keyboard.press(key)
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart')
    await page.locator('[data-chart-plot]').dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true })
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart')
    const settings = await openSettings()
    const lookback = settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)', exact: true })
    await lookback.focus()
    await page.keyboard.press('ArrowUp')
    assert.equal(await lookback.inputValue(), '16')
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'ZETA-USDT-SWAP')
    await settings.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await backToMarkets()
    await page.keyboard.press('ArrowDown')
    await page.locator('svg[data-rendered-inst="ALPHA-USDT-SWAP"]').waitFor({ state: 'visible', timeout: 2_000 })
  } finally {
    if (await settingsPage().isVisible()) {
      const discard = settingsPage().getByRole('button', { name: 'Discard changes', exact: true })
      if (await discard.isEnabled()) await discard.click()
      await backToMarkets()
    }
    await search.fill('')
    await page.getByRole('row', { name: 'View BETA-USDT-SWAP chart', exact: true }).click()
  }
})

test('cold and warm chart periods preserve list nodes, order, count, and selection without reloading market rows', async () => {
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.coldTimeframes = ['1H']
      state.preferences.chartTimeframe = '15m'
    })
    // A new document discards previously received 1H frames, so this switch is
    // genuinely cold even when earlier tests have visited every native period.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[aria-label="View ZETA-USDT-SWAP chart"]').click()
    await page.locator('svg[data-rendered-inst="ZETA-USDT-SWAP"][data-rendered-timeframe="15m"]').waitFor({ state: 'visible' })
    const snapshotCount = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-market-index]')]
      const probe = window.__timeframeListProbe = { rows, order: rows.map(row => row.getAttribute('aria-label')), violations: [] }
      const inspect = () => {
        const current = [...document.querySelectorAll('[data-market-index]')]
        if (current.length !== rows.length || current.some((row, index) => row !== rows[index]
          || row.getAttribute('aria-label') !== probe.order[index])
          || document.querySelector('[data-total-market-count]')?.dataset.totalMarketCount !== '4'
          || document.querySelector('[data-market-index][aria-selected="true"]')?.getAttribute('aria-label') !== 'View ZETA-USDT-SWAP chart') {
          if (probe.violations.length < 10) probe.violations.push(current.map(row => row.getAttribute('aria-label')))
        }
      }
      const observer = new MutationObserver(inspect)
      observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true })
      probe.stop = () => { inspect(); observer.disconnect(); return probe.violations }
    })
    await selectTimeframe(page, '1H')
    await waitForAuditFixture(() => globalThis.__workspaceFixture.preferences.chartTimeframe === '1H')
    await waitForAuditFixture(() => globalThis.__workspaceFixture.requests.some(value => value.chartFocus?.target?.timeframe === '1H'))
    assert.equal(await page.locator('svg[data-prepared-chart-timeframe="1H"]').count(), 0, 'The current surface must remain on 15m until the 1H frame is selected.')
    assert.equal(await selected().getAttribute('aria-label'), 'View ZETA-USDT-SWAP chart')

    // Backend preparation completes through pushes, independently of any new
    // list snapshot or renderer-supplied universe membership.
    await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.coldTimeframes = []; state.chartGeneration += 1
      for (const { instId } of state.rows) {
        const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId, timeframe: '1H' } })
        BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
      }
    })
    await page.locator('svg[data-rendered-inst="ZETA-USDT-SWAP"][data-rendered-timeframe="1H"]').waitFor({ state: 'visible' })
    for (const timeframe of ['5m', '15m', '1H']) {
      await selectTimeframe(page, timeframe)
      await waitForAuditFixture((_electron, timeframe) => globalThis.__workspaceFixture.preferences.chartTimeframe === timeframe, timeframe)
      await page.locator(`svg[data-rendered-inst="ZETA-USDT-SWAP"][data-rendered-timeframe="${timeframe}"]`).waitFor({ state: 'visible' })
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await page.evaluate(() => window.__timeframeListProbe.stop()), [], 'Chart readiness and timeframe saves must never replace, remove, or reorder market rows.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), snapshotCount, 'Saving only chartTimeframe must not request another market snapshot.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartUniverse).every(value => Object.keys(value.chartUniverse).length === 0)), true, 'Universe reads must never carry membership, timeframe, or focus writes.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).every(value => !('timeframe' in value.snapshot))), true)
  } finally {
    await page.evaluate(() => { window.__timeframeListProbe?.stop(); delete window.__timeframeListProbe })
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.coldTimeframes = []; state.preferences.chartTimeframe = '15m'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"][data-rendered-timeframe="15m"]').waitFor({ state: 'visible' })
  }
})

test('the existing chart toolbar provides window dragging while its controls remain interactive', async () => {
  const toolbar = page.locator('[data-chart-toolbar]')
  await assertWorkspaceLayout(page)
  assert.equal(await toolbar.evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'drag')
  for (const name of ['5m', '15m', '1h', 'Copy chart', 'Analyze Long', 'Analyze Short']) {
    assert.equal(await toolbar.getByRole('button', { name, exact: true }).evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
  }
  assert.equal(await toolbar.getByRole('heading').count(), 0, 'The toolbar must retain the original chart actions and status without an application title.')
  const sidebar = page.getByRole('complementary', { name: 'Contract list' })
  assert.equal(await sidebar.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).isVisible(), true)
  await selectTimeframe(page, '5m')
  await page.locator('svg[data-rendered-timeframe="5m"]').waitFor()
  await toolbar.getByRole('button', { name: '15m', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.locator('svg[data-rendered-timeframe="15m"]').waitFor()
  await toolbar.getByRole('button', { name: 'Copy chart', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Chart copied to clipboard' }).waitFor()
  const settingsLink = sidebar.getByRole('link', { name: 'Settings', exact: true })
  assert.equal(await settingsLink.evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
  await settingsLink.click()
  const settings = settingsPage()
  await settings.waitFor({ state: 'visible' })
  assert.equal(await settings.locator('header').evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'drag')
  if (process.platform === 'darwin') {
    const heading = await settings.getByRole('heading', { name: 'Settings', exact: true }).boundingBox()
    assert.ok(heading.x >= 72, 'Settings must reserve native traffic light space as well.')
  }
  assert.equal(await settings.getByRole('link', { name: 'Back to markets', exact: true }).evaluate(element => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag')
  await backToMarkets()
})

test('a prepared idle chart makes no periodic window requests and accepts a pushed forming candle', async () => {
  const chart = page.locator('[data-chart-inst="BETA-USDT-SWAP"]')
  await page.waitForFunction(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.dataset.chartLoading === 'false')
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length), before, 'A successfully prepared chart must not poll local or provider windows.')
  await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const state = globalThis.__workspaceFixture
    state.chartGeneration += 1
    const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    const last = frame.bars.at(-1)
    frame.liveBar = { ...last, hour: frame.endHour + frame.intervalMS, open: 133, high: 134, low: 132, close: 133,
      confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null }
    BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
  })
  await page.waitForFunction(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close === 133)
  assert.equal(Number(await chart.getAttribute('data-chart-rendered-bars')), 96)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length), before + 1, 'Only the fixture read may be added; the pushed candle must not trigger another renderer read.')
  const liveUpdate = await page.evaluate(() => {
    const snapshot = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]').__chartSnapshot
    globalThis.__completedSubscriptionBars = snapshot.bars
    return { type: 'live', instId: snapshot.instId, timeframe: snapshot.timeframe, generation: snapshot.generation, revision: snapshot.generation + 1,
      endHour: snapshot.endHour, liveBar: { ...snapshot.liveBar, high: 136, close: 135 } }
  })
  const reads = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length)
  assert.equal('bars' in liveUpdate, false, 'A forming update must not transfer completed candles.')
  await electron.evaluate(({ BrowserWindow }, update) => BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', update), liveUpdate)
  await page.waitForFunction(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close === 135)
  assert.match(await chart.locator('[aria-live="off"]').textContent(), /Close\s+135/)
  assert.match(await chart.locator('svg[data-rendered-inst] [data-chart-price-label-value]').textContent(), /^135 /)
  assert.equal(await page.evaluate(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]').__chartSnapshot.bars === globalThis.__completedSubscriptionBars), true)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length), reads, 'Live-only subscriptions must reuse the completed frame without a follow-up read.')
})

test('chart source updates stay outside the plot without resizing its viewport at scaled and design widths', async () => {
  const previousSize = page.viewportSize()
  const publish = async status => {
    const generation = await electron.evaluate(async ({ ipcMain, BrowserWindow }, status) => {
      const state = globalThis.__workspaceFixture
      state.chartGeneration += 1
      const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
      if (status.oiState !== 'ready') {
        const observed = status.oiState === 'unavailable'
        frame.endHour += frame.intervalMS
        frame.latestEnd = frame.endHour
        frame.bars = [...frame.bars.slice(1), { ...frame.bars.at(-1), hour: frame.endHour,
          oi: null, buy: null, sell: null, statisticsSources: observed ? 3 : 0,
          statisticsObserved: observed, oiObserved: observed, takerObserved: observed, indicatorsObserved: true }]
      }
      Object.assign(frame, status)
      BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
      return frame.generation
    }, status)
    await page.waitForFunction(generation => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.generation === generation, generation)
  }
  const geometry = () => page.locator('[data-chart-inst="BETA-USDT-SWAP"]').evaluate(chart => {
    const status = chart.querySelector('[data-chart-status]'), plot = chart.querySelector('[data-chart-plot]')
    const row = status.getBoundingClientRect(), area = plot.getBoundingClientRect()
    return { rowBottom: row.bottom, plotTop: area.top, width: area.width, height: area.height,
      plotStatuses: plot.querySelectorAll('[role="status"]').length, statusInsidePlot: plot.contains(status) }
  })
  try {
    for (const size of [{ width: 800, height: 572 }, { width: 1600, height: 1000 }]) {
      await page.setViewportSize(size)
      await page.waitForFunction(width => Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === width / 1600, size.width)
      await publish({ oiState: 'ready', takerState: 'ready', indicatorState: 'ready' })
      const status = page.locator('[data-chart-status]')
      await page.waitForFunction(() => {
        const chart = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')
        return chart?.dataset.chartOiState === 'ready' && chart.dataset.chartTakerState === 'ready'
      })
      const baseline = await geometry()
      for (const value of ['loading', 'unavailable']) {
        // Statistics arrive independently of already calculated price curves.
        // An uncalculated navigation frame intentionally retains the old plot.
        await publish({ oiState: value, takerState: value, indicatorState: 'ready' })
        await status.getByText(value === 'loading' ? 'Loading OI history…' : 'OI is not published for part of this range', { exact: true }).waitFor()
        const current = await geometry()
        assert.equal(current.statusInsidePlot, false)
        assert.equal(current.plotStatuses, 0, 'Source messages must never cover candles or indicators.')
        assert.ok(current.rowBottom <= current.plotTop, 'Status feedback must occupy its own space above the plot.')
        assert.deepEqual([current.plotTop, current.width, current.height], [baseline.plotTop, baseline.width, baseline.height], 'Source state changes must preserve the plotted viewport.')
        assert.match(await status.locator('p').getAttribute('title'), /OI.*[Tt]aker/, 'The full source summary must remain available when visually truncated.')
      }
    }
  } finally {
    await publish({ oiState: 'ready', takerState: 'ready', indicatorState: 'ready' })
    await page.setViewportSize(previousSize)
  }
})

test('pointer inspection selects the drawn first, middle, and latest candle before and after a forming candle shifts the window', async () => {
  await selectTimeframe(page, '15m')
  const publish = forming => electron.evaluate(async ({ ipcMain, BrowserWindow }, forming) => {
    const state = globalThis.__workspaceFixture
    state.chartGeneration += 1
    const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    if (forming) frame.liveBar = { ...frame.bars.at(-1), hour: frame.endHour + frame.intervalMS,
      open: 133, high: 138, low: 132, close: 137, confirmed: false, statisticsObserved: false, oi: null, buy: null, sell: null }
    BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
    return frame
  }, forming)
  const waitForFrame = frame => page.waitForFunction(({ generation, end }) => {
    const chart = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')
    return chart?.__chartSnapshot.generation === generation && Number(chart.dataset.chartEnd) === end
  }, { generation: frame.generation, end: frame.liveBar?.hour ?? frame.endHour })
  try {
    for (const forming of [false, true]) {
      const frame = await publish(forming)
      await waitForFrame(frame)
      for (const slot of [0, 24, 95]) {
        const target = await emaCandleTarget(slot, frame)
        const fixtureIndex = slot + Number(forming)
        assert.equal(target.hour, frame.bars[0].hour + fixtureIndex * frame.intervalMS)
        assert.equal(target.close, fixtureIndex === 96 ? 137 : 100 + fixtureIndex * .01)
        await page.mouse.move(target.x, target.y)
        await page.mouse.down()
        await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
        const close = await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')
        assert.equal(Number(close), target.close, `${forming ? 'The forming' : 'The completed-only'} window must inspect its drawn candle at slot ${slot}.`)
        await page.mouse.up()
        await page.waitForFunction(() => !document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      }
    }
  } finally {
    await page.mouse.up()
    await waitForFrame(await publish(false))
  }
})

test('RSI crossings retain a flat panel and expose the sampled candle and time at scaled widths in both themes', async () => {
  await selectTimeframe(page, '15m')
  const originalSize = page.viewportSize()
  const publish = custom => electron.evaluate(async ({ ipcMain, BrowserWindow }, custom) => {
    const state = globalThis.__workspaceFixture
    state.chartGeneration += 1
    const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
    if (custom) frame.bars = frame.bars.map((bar, index) => ({ ...bar,
      rsi6: index === 20 ? 29 : index === 21 ? 31 : index === 40 ? 69 : index === 41 ? 71 : 50,
      rsi12: index === 60 ? 71 : index === 61 ? 69 : 55,
      rsi24: index === 80 ? 29 : index === 81 ? 31 : 60,
    }))
    BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
    return frame
  }, custom)
  const frame = await publish(true)
  await page.waitForFunction(generation => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.generation === generation, frame.generation)
  try {
    for (const colorScheme of ['dark', 'light']) for (const width of [800, 1600]) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: width === 800 ? 572 : 1000 })
      const svg = page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]')
      const markerPoint = async () => {
        const handle = await page.waitForFunction(({ hour, width }) => {
          const svg = document.querySelector('svg[data-rendered-inst="BETA-USDT-SWAP"]')
          const scale = Number(document.querySelector('[data-ui-scale]')?.dataset.uiScale)
          if (!svg || !scale) return false
          const rect = svg.getBoundingClientRect(), bounds = svg.viewBox.baseVal
          if (Math.abs(rect.right - width) >= .5 || Math.abs(rect.width - bounds.width * scale) >= .5 || Math.abs(rect.height - bounds.height * scale) >= .5) return false
          const marker = svg.querySelector(`[data-chart-rsi-crossing="rsi6"][data-chart-rsi-hour="${hour}"]`)
          if (!marker) return false
          const [, x, y] = marker.getAttribute('d').match(/^M([\d.-]+) ([\d.-]+)/)
          const point = svg.createSVGPoint(), matrix = svg.getScreenCTM()
          if (!matrix) return false
          point.x = Number(x); point.y = Number(y)
          const center = point.matrixTransform(matrix)
          point.x -= 3; point.y += 4.5
          const corner = point.matrixTransform(matrix)
          return { x: center.x, y: center.y, cornerX: corner.x, cornerY: corner.y }
        }, { hour: frame.bars[21].hour, width })
        try { return await handle.jsonValue() } finally { await handle.dispose() }
      }
      const point = await markerPoint()
      assert.equal(await svg.locator('[data-chart-rsi-threshold]').count(), 3)
      assert.equal(await svg.locator('[data-chart-rsi-tick="30"], [data-chart-rsi-tick="70"]').count(), 2)
      const appearance = await svg.evaluate(svg => ({ font: getComputedStyle(svg).fontFamily,
        retiredFill: getComputedStyle(document.documentElement).getPropertyValue('--chart-rsi-area').trim(),
        seriesWidth: getComputedStyle(svg.querySelector('[data-chart-indicator="rsi6"]')).strokeWidth }))
      assert.match(appearance.font, /monospace/)
      assert.equal(appearance.retiredFill, '')
      assert.equal(appearance.seriesWidth, '1px')
      for (const field of ['rsi6', 'rsi12', 'rsi24']) assert.ok(await svg.locator(`[data-chart-rsi-crossing="${field}"]`).count() > 0)
      const marker = svg.locator(`[data-chart-rsi-crossing="rsi6"][data-chart-rsi-hour="${frame.bars[21].hour}"]`)
      assert.equal(await marker.getAttribute('data-chart-rsi-direction'), 'up')
      assert.equal(await marker.getAttribute('data-chart-rsi-levels'), '30')
      await page.mouse.move(point.x, point.y)
      await page.waitForFunction(hour => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes(
        new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(hour)), frame.bars[21].hour)
      assert.equal(Number(await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')), frame.bars[21].close)
      assert.match(await svg.locator('[data-chart-panel-header="rsi"]').textContent(), /31\.0 ↑30/)
      const corner = await markerPoint()
      await page.mouse.move(corner.cornerX, corner.cornerY)
      assert.equal(Number(await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')), frame.bars[21].close, 'Hovering a triangle corner must inspect that triangle\'s candle.')
      assert.equal(await svg.locator('[data-chart-inspected-time]').count(), 1)
      const labelBounds = await svg.locator('[data-chart-inspected-time] rect').evaluate(rect => ({ x: Number(rect.getAttribute('x')), end: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')),
        right: Number(rect.ownerSVGElement.querySelector('[data-chart-rsi-threshold]').getAttribute('x2')) }))
      assert.ok(labelBounds.x >= 0 && labelBounds.end <= labelBounds.right)
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `rsi-${colorScheme}-${width}.png`) })
      await svg.focus()
      await page.keyboard.press('Alt+ArrowLeft')
      assert.equal(Number(await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')), frame.bars[20].close)
      await page.keyboard.press('Alt+ArrowRight')
      assert.equal(Number(await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')), frame.bars[21].close)
      await page.keyboard.press('Escape')
      assert.equal(await svg.locator('[data-chart-inspected-time]').count(), 0)
    }
  } finally {
    await publish(false)
    await page.emulateMedia({ colorScheme: null })
    await page.setViewportSize(originalSize)
  }
})

test('a healthy idle market list makes no periodic snapshot requests', async () => {
  await page.waitForFunction(() => document.querySelectorAll('[data-market-index]').length === 4)
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before,
    'Successful market reads must wait for a notification, action, or visibility change.')
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
    const error = page.locator('[data-market-status][role="alert"][title*="Snapshot temporarily unavailable."]')
    await error.waitFor({ state: 'visible' })
    assert.deepEqual(await page.evaluate(() => globalThis.__snapshotRetryClock.delays), [])
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + 1)
    await electron.evaluate(() => globalThis.__workspaceFixture.notify())
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '204')
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

test('market notifications wait while hidden and refresh immediately when the workspace becomes visible', async () => {
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const before = await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 203 } : row)
      state.revision += 1
      for (let index = 0; index < 20; index += 1) BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
      return state.requests.filter(value => value.snapshot).length
    })
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)))
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before, 'Hidden notifications cannot start snapshot requests.')
    await page.evaluate(() => {
      delete document.visibilityState
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '203', null, { timeout: 1_000 })
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + 1, 'Visibility resumes one coalesced refresh immediately.')
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

test('search preserves selection while six width/DPR combinations share page, pointer, and capture coordinates', async () => {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const client = await page.context().newCDPSession(page)
  const fixture = await electron.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } }))
  try {
    for (const deviceScaleFactor of [1, 2]) for (const width of [1_200, 1_600, 2_000]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1_000, deviceScaleFactor, mobile: false })
      await page.waitForFunction(({ width, deviceScaleFactor }) => innerWidth === width && devicePixelRatio === deviceScaleFactor && Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === width / 1_600, { width, deviceScaleFactor })
      await assertWorkspaceLayout(page)
      const target = await emaCandleTarget(24, fixture)
      await page.mouse.move(target.x, target.y)
      await page.mouse.down()
      await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      const hoveredClose = await page.locator('[data-chart-ohlc="close"] span[title]').getAttribute('title')
      assert.equal(Number(hoveredClose), target.close, 'Screen-space pointer input must inspect the candle drawn beneath it at every UI scale and DPR.')
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      const captureBounds = await page.locator('[data-chart-inst]').boundingBox()
      assert.equal(await page.locator('[data-chart-inst] h2').textContent(), `${fixture.instId.replace(/-SWAP$/, '')} · ${fixture.timeframe}`, 'Copied and analyzed chart bounds must include the contract and displayed timeframe.')
      await page.getByRole('button', { name: 'Copy chart', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Chart copied to clipboard' }).waitFor()
      const request = await electron.evaluate(() => globalThis.__workspaceFixture.requests.findLast(value => value.captureChart).captureChart)
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(request[key] - captureBounds[key]) < 1, `Capture ${key} must use the drawn CSS-pixel bounds, independent of DPR.`)
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `workspace-${width}-dpr${deviceScaleFactor}.png`) })
      const settings = await openSettings()
      await page.waitForFunction(() => {
        const settings = document.querySelector('main[aria-label="Settings"]'), scale = Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale)
        return settings && Math.abs(settings.getBoundingClientRect().width / settings.offsetWidth - scale) < .01
      })
      const bounds = await settings.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 1_001, 'The settings page must stay within the scaled viewport.')
      const ranking = settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' })
      const input = await ranking.boundingBox()
      await page.mouse.click(input.x + input.width / 2, input.y + input.height / 2)
      assert.equal(await ranking.evaluate(element => element === document.activeElement), true, 'Settings controls must accept screen-space pointer coordinates.')
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `settings-${width}-dpr${deviceScaleFactor}.png`) })
      await backToMarkets()
    }
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('ALPHA')
    assert.equal(await page.locator('[data-market-index]').count(), 1)
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('NO MATCH')
    assert.equal(await page.locator('[data-market-index]').count(), 0)
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
  } finally {
    await page.mouse.up()
    await page.keyboard.press('Escape')
    if (await settingsPage().isVisible()) await backToMarkets()
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
    await client.send('Emulation.clearDeviceMetricsOverride')
    await client.detach()
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height })
    await page.setViewportSize(viewport)
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height && Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === width / 1_600, viewport)
  }
})

test('settings is a separate grouped page with keyboard navigation and a retained market workspace', async () => {
  await page.getByRole('textbox', { name: 'Search contracts' }).fill('ALPHA')
  const before = {
    contract: await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'),
    timeframe: await page.locator('[aria-label="Chart timeframe"] button[aria-pressed="true"]').textContent(),
  }
  await page.getByRole('link', { name: 'Settings', exact: true }).focus()
  await page.keyboard.press('Enter')
  const settings = settingsPage()
  await settings.getByRole('heading', { name: 'Settings', level: 1, exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0)
  assert.equal(await page.getByRole('textbox', { name: 'Search contracts' }).isVisible(), false)
  const categories = settings.getByRole('navigation', { name: 'Settings categories' })
  assert.deepEqual(await categories.getByRole('link').allTextContents(), ['Workspace', 'Liquidity filters', 'Market data', 'AI analysis'])
  assert.equal(await categories.getByRole('link', { name: 'Workspace', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).count(), 0)
  await categories.getByRole('link', { name: 'Market data', exact: true }).focus()
  await page.keyboard.press('Enter')
  await settings.getByRole('heading', { name: 'Market data', level: 2, exact: true }).waitFor()
  assert.equal(await categories.getByRole('link', { name: 'Market data', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).count(), 0)
  await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).waitFor()
  await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Start audit', exact: true }).waitFor()
  await page.goBack()
  await settings.getByRole('heading', { name: 'Workspace', level: 2, exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await settings.isVisible(), true, 'Escape must not dismiss an independent page.')
  await settings.getByRole('link', { name: 'Back to markets', exact: true }).focus()
  await page.keyboard.press('Enter')
  await settings.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('textbox', { name: 'Search contracts' }).inputValue(), 'ALPHA')
  assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), before.contract)
  assert.equal(await page.locator('[aria-label="Chart timeframe"] button[aria-pressed="true"]').textContent(), before.timeframe)
  await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
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
  await settings.getByRole('alert').filter({ hasText: 'The preferences could not be saved.' }).waitFor()
  assert.equal(await settings.isVisible(), true)
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor()
  assert.equal(await settings.isVisible(), true, 'Saving preferences must keep the settings page open.')
  const preferences = await electron.evaluate(() => globalThis.__workspaceFixture.preferences)
  assert.equal(preferences.rankingLookback, 30)
  assert.equal(preferences.liquidity.spread.enabled, false)
  assert.deepEqual(preferences.liquidity.volumeStability, { enabled: true, maxRatio: 2.5 })
  await backToMarkets()
  await page.getByRole('columnheader', { name: '30m change', exact: true }).waitFor()
  await selectTimeframe(page, '5m')
  await page.waitForFunction(() => document.querySelector('[aria-label="Chart timeframe"] button[aria-pressed="true"]')?.textContent === '5m')
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.rankingLookback), 30, 'Chart timeframe must not change the independent ranking window.')
})

test('discarding changes resets all preference groups without saving', async () => {
  const settings = await openSettings()
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length)
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('60')
  await chooseSettingsCategory('Market data')
  await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).fill('120')
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click()
  assert.equal(await settings.getByRole('spinbutton', { name: 'Data audit lookback (days)' }).inputValue(), '30')
  await chooseSettingsCategory('Workspace')
  assert.equal(await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue(), '30')
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
  await ranking.fill('60')
  const rejectedDialog = page.waitForEvent('dialog')
  const rejectedNavigation = settings.getByRole('link', { name: 'Back to markets', exact: true }).click()
  const rejected = await rejectedDialog
  assert.equal(rejected.type(), 'confirm')
  await rejected.dismiss()
  await rejectedNavigation
  assert.equal(await settings.isVisible(), true)
  assert.equal(await ranking.inputValue(), '60')
  const acceptedDialog = page.waitForEvent('dialog')
  const acceptedNavigation = settings.getByRole('link', { name: 'Back to markets', exact: true }).click()
  const accepted = await acceptedDialog
  assert.equal(accepted.type(), 'confirm')
  await accepted.accept()
  await acceptedNavigation
  await settings.waitFor({ state: 'hidden' })
  const reopened = await openSettings()
  assert.equal(await reopened.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).inputValue(), '30')
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.rankingLookback), 30)
  await backToMarkets()
})

test('AI configuration is inline and retains its draft and loaded settings across groups', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.analysisSettings?.action === 'read').length)
  const settings = await openSettings('AI analysis')
  const model = settings.getByRole('textbox', { name: 'Model', exact: true })
  await page.waitForFunction(() => document.getElementById('analysis-model')?.value === 'fixture/vision')
  assert.equal(await page.getByRole('dialog').count(), 0)
  const key = settings.getByLabel('Vercel AI Gateway API Key', { exact: true })
  assert.equal(await key.getAttribute('type'), 'password')
  await model.fill('')
  await settings.getByRole('button', { name: 'Save analysis settings', exact: true }).click()
  await settings.getByText('Enter a model ID.', { exact: true }).waitFor()
  assert.equal(await model.getAttribute('aria-invalid'), 'true')
  await model.fill('fixture/vision-v2')
  await key.fill('renderer-fixture-key')
  await chooseSettingsCategory('Workspace')
  await chooseSettingsCategory('AI analysis')
  assert.equal(await model.inputValue(), 'fixture/vision-v2')
  assert.equal(await key.inputValue(), 'renderer-fixture-key')
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.analysisSettings?.action === 'read').length), before + 1)
  const confirmDialog = page.waitForEvent('dialog')
  const attemptedLeave = settings.getByRole('link', { name: 'Back to markets', exact: true }).click()
  const confirm = await confirmDialog
  await confirm.dismiss()
  await attemptedLeave
  assert.equal(await settings.isVisible(), true)
  assert.equal(await key.inputValue(), 'renderer-fixture-key')
  await settings.getByRole('button', { name: 'Save analysis settings', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Analysis settings saved.' }).waitFor()
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.analysisSettings.model), 'fixture/vision-v2')
  assert.equal(await key.inputValue(), '', 'Saving must clear the editable key field.')
  assert.equal(await settings.isVisible(), true)
  await settings.getByRole('button', { name: 'Remove key', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Saved API key removed.' }).waitFor()
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.analysisSettings.hasAPIKey), false)
  await backToMarkets()
})

test('saving only the ranking lookback keeps the chosen chart and qualified market state', async () => {
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  const settings = await openSettings()
  await settings.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('45')
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Settings saved.' }).waitFor()
  await backToMarkets()
  await page.getByRole('columnheader', { name: '45m change', exact: true }).waitFor()
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
  assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
  assert.equal(await page.locator('[aria-label="Chart timeframe"] button[aria-pressed="true"]').textContent(), '5m')
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
  const settings = settingsPage()
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('status').filter({ hasText: 'idle · 0 / 0' }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 1)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1)
  await settings.getByRole('button', { name: 'Start audit', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'running · 1 / 3' }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ progress: { completed: 2, total: 3 } }) })
  await settings.getByRole('status').filter({ hasText: 'running · 2 / 3' }).waitFor()
  await chooseSettingsCategory('Workspace')
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ progress: { completed: 3, total: 3 } }) })
  await chooseSettingsCategory('Market data')
  await settings.getByRole('status').filter({ hasText: 'running · 3 / 3' }).waitFor()
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1, 'Changing settings groups must reuse the status subscription and its latest checkpoint.')
  await settings.getByRole('button', { name: 'Cancel audit', exact: true }).click()
  await settings.getByRole('list', { name: 'Data audit issues' }).getByText('Missing completed candle · Repairable', { exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Repair issues', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  assert.equal(await settings.getByRole('list', { name: 'Data audit issues' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1, 'A successful audit settings page must wait for checkpoints rather than poll.')
  const actions = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit).map(value => value.dataAudit.action))
  assert.deepEqual(actions.filter(action => action !== 'status'), ['start', 'cancel', 'repair'])
  await backToMarkets()
  await settings.waitFor({ state: 'hidden' })
  await openSettings('Market data')
  await settings.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 2)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 2, 'Reopening performs one fresh status read.')
  await backToMarkets()
})

test('new audit pushes win over held initial and action replies across page reopen', async () => {
  const settings = settingsPage()
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })
      state.holdAuditAction = 'status'
    })
    await openSettings('Market data')
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'running', progress: { completed: 2, total: 3 } })
      state.publishAudit({ phase: 'completed', progress: { completed: 7, total: 7 } })
    })
    await settings.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'idle', 'The held initial reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await settings.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    const beforeReopen = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length)
    await backToMarkets()
    await settings.waitFor({ state: 'hidden' })
    await openSettings('Market data')
    await settings.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, beforeReopen + 1)
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdAuditAction = 'start' })
    await settings.getByRole('button', { name: 'Start audit', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await settings.getByRole('status').filter({ hasText: 'running · 1 / 3' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ phase: 'completed', progress: { completed: 3, total: 3 } }) })
    await settings.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
    assert.equal(await settings.getByRole('button', { name: 'Start audit', exact: true }).isDisabled(), true, 'A push must not release an action that is still in flight.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'running', 'The held action reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await settings.getByRole('button', { name: 'Start audit', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => ![...document.querySelectorAll('main[aria-label="Settings"] button')].find(button => button.textContent === 'Start audit')?.disabled)
    await settings.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdAuditAction = null; state.releaseAudit?.() })
    if (await settings.isVisible()) await backToMarkets()
  }
})

test('manual history downloads show exact pushed progress and retry details, continue after leaving settings, and cancel without polling', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length)
  await openSettings('Market data')
  const settings = settingsPage()
  await settings.getByRole('status').filter({ hasText: 'Ready to download · 0.0%' }).waitFor()
  await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Downloading history · 10.0%' }).waitFor()
  const details = settings.locator('[aria-label="History download details"]')
  await details.getByText('100 / 1,000', { exact: true }).waitFor()
  await details.getByText('1 / 18', { exact: true }).waitFor()
  const active = settings.getByRole('list', { name: 'Active history downloads' })
  await active.getByText('BETA-USDT-SWAP · 15m · oi', { exact: true }).waitFor()
  await active.getByText(/retrying · Consecutive failures: 2 · Next retry:/).waitFor()
  await active.getByText('Temporary source limit.', { exact: true }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { checked: 999_999, total: 1_000_000, available: 900_000, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 1 },
  }) })
  await settings.getByRole('status').filter({ hasText: 'Downloading history · 99.9%' }).waitFor()
  await details.getByText('999,999 / 1,000,000', { exact: true }).waitFor()
  await details.getByText('99,999', { exact: true }).waitFor()
  await details.getByText('300,000', { exact: true }).waitFor()
  await backToMarkets()
  await settings.waitFor({ state: 'hidden' })
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { checked: 1_000_000, total: 1_000_000, available: 900_001, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 0 },
  }) })
  await openSettings('Market data')
  await settings.getByRole('status').filter({ hasText: 'Downloading history · 100.0%' }).waitFor()
  await settings.getByRole('button', { name: 'Cancel download', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Download cancelled · 100.0%' }).waitFor()
  assert.equal(await settings.getByRole('list', { name: 'Active history downloads' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length), before + 2)
  assert.deepEqual(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload && value.historyDownload.action !== 'status').map(value => value.historyDownload.action)), ['start', 'cancel'])
  await backToMarkets()
})

test('new download pushes win over held replies and completion distinguishes unavailable data', async () => {
  const settings = settingsPage()
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishDownload({ phase: 'idle', progress: { checked: 0, total: 0, available: 0, empty: 0, unavailable: 0, failed: 0, reused: 0, pending: 0 }, error: '' })
      state.holdDownloadAction = 'status'
    })
    await openSettings('Market data')
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { checked: 1_000_000, total: 1_000_000, available: 900_001, empty: 0, unavailable: 99_999, failed: 0, reused: 300_000, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await settings.getByRole('status').filter({ hasText: 'Completed with verified unavailable data · 100.0%' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await settings.getByRole('status').filter({ hasText: 'Completed with verified unavailable data · 100.0%' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdDownloadAction = 'start' })
    await settings.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { checked: 1_000, total: 1_000, available: 1_000, empty: 0, unavailable: 0, failed: 0, reused: 80, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await settings.getByRole('status').filter({ hasText: 'Download complete · 100.0%' }).waitFor()
    assert.equal(await settings.getByRole('button', { name: /Download all qualified history/ }).isDisabled(), true)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldDownloadReply.phase), 'running')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await page.waitForFunction(() => ![...document.querySelectorAll('main[aria-label="Settings"] button')].find(button => button.textContent === 'Download all qualified history')?.disabled)
    await settings.getByRole('status').filter({ hasText: 'Download complete · 100.0%' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdDownloadAction = null; state.releaseDownload?.() })
    if (await settings.isVisible()) await backToMarkets()
  }
})

test('ranking changes keep the chosen chart while long lists retain keyboard and search access', async () => {
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
  await page.getByRole('textbox', { name: 'Search contracts' }).fill('BETA')
  await page.locator('[data-market-index="0"][aria-label="View BETA-USDT-SWAP chart"]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-market-index]').count(), 1, 'Filtering a scrolled virtual list must reveal its surviving row.')
  assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
  await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
  await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.rows = state.initialRows; state.revision += 1; state.notify() })
  await page.waitForFunction(() => document.querySelector('[aria-label="View ZETA-USDT-SWAP chart"] td:last-child')?.textContent.includes('+3.00%'))
  await page.waitForFunction(() => document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count') === '4')
})

test('constant Bollinger bands stay finite and negative lower bands explicitly switch to a linear price scale', async () => {
  const publishMode = async mode => {
    await electron.evaluate((_electron, mode) => { const state = globalThis.__workspaceFixture; state.bollMode = mode; state.chartGeneration += 1 }, mode)
    await page.evaluate(async () => {
      const svg = document.querySelector('svg[data-rendered-inst]')
      const frame = await window.radarDesktop.request({ chartWindow: { instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe } })
      window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
    })
  }
  try {
    await publishMode('constant')
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]').__chartSnapshot?.bars.every(bar => bar.bollUpper === 100 && bar.bollLower === 100))
    assert.equal(await page.locator('[data-chart-price-scale]').getAttribute('data-chart-price-scale'), 'logarithmic')
    await publishMode('negative')
    await page.locator('[data-chart-price-scale="linear"]').getByText('Linear', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-chart-price-scale="linear"]').getAttribute('title'), 'Linear scale · BOLL includes zero or negative values')
    const paths = await page.locator('svg[data-rendered-inst] path[d]').evaluateAll(paths => paths.map(path => path.getAttribute('d')))
    assert.doesNotMatch(paths.join(' '), /NaN|Infinity|undefined/)
    assert.equal(await page.locator('svg[data-rendered-inst] [data-chart-indicator="bollLower"]').evaluate(path => path.getAttribute('d').length > 0), true)
  } finally { await publishMode('standard') }
})

test('market status changes do not move the contract list', async () => {
  const publish = values => electron.evaluate((_electron, values) => {
    const state = globalThis.__workspaceFixture
    Object.assign(state, values)
    state.revision += 1
    state.notify()
  }, values)
  const positions = async () => page.locator('[data-market-list]').evaluate(list => {
    const header = list.querySelector('thead').getBoundingClientRect()
    const row = list.querySelector('[data-market-index]').getBoundingClientRect()
    return { header: header.top, row: row.top }
  })
  try {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', realtimeState: 'live', catalogSource: 'live', catalogProgress: undefined })
    await page.waitForFunction(() => document.querySelector('[data-market-status]')?.textContent.startsWith('Updated '))
    const baseline = await positions()
    for (const [index, pending] of [1, 4, 0, 3, 0].entries()) {
      const updatedAt = 1_800_000_000_000 + (index + 1) * 60_000
      await publish({ updatedAt, loading: pending > 0, catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending } })
      await page.waitForFunction(updatedAt => document.querySelector('[data-market-status]')?.textContent === `Updated ${new Date(updatedAt).toLocaleTimeString('en-US')}`, updatedAt)
      assert.deepEqual(await positions(), baseline, 'Background acquisition must not move the table.')
    }
    await publish({ loading: false, error: 'Order book data is unavailable.', catalogProgress: undefined })
    await page.locator('[data-market-status][role="alert"][title="Order book data is unavailable."]').waitFor()
    assert.deepEqual(await positions(), baseline, 'An error must not move the table.')
    await publish({ error: '', realtimeState: 'disconnected' })
    await page.waitForFunction(() => document.querySelector('[data-market-status]')?.textContent.toLowerCase().includes('disconnect'))
    assert.deepEqual(await positions(), baseline, 'A connection failure must not move the table.')
    await publish({ realtimeState: 'live' })
    await page.waitForFunction(() => document.querySelector('[data-market-status]')?.textContent.startsWith('Updated '))
    assert.deepEqual(await positions(), baseline, 'Recovery must not move the table.')
  } finally {
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', realtimeState: 'live', catalogSource: 'live', catalogProgress: undefined })
  }
})

test('a rejected old snapshot preserves notifications and backend exclusions remove rows immediately', async () => {
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
    await page.locator('[data-chart-panel]').getByText('No qualified contracts', { exact: true }).waitFor()
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
    await page.locator('[data-chart-panel]').getByText(title, { exact: true }).waitFor()
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
    await page.locator('[data-market-list]').getByText('Updating 4 contracts', { exact: true }).waitFor()
    await publish({ catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 2 } })
    await page.locator('[data-market-list]').getByText('Updating 2 contracts', { exact: true }).waitFor()
    await publish({ loading: false, error: 'Order book data is unavailable. Qualification could not be verified.', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 } })
    await assertEmpty('Market verification unavailable')
    await page.locator('[data-market-status][role="alert"][title^="Order book data is unavailable. Qualification could not be verified."]').waitFor()
    await publish({ error: '' })
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    await assertEmpty('Market verification unavailable')
    await publish({ catalogSource: 'none', catalogProgress: undefined })
    await waitForMarketStatus('Waiting')
    await assertEmpty('Market verification unavailable')
    await publish({ loading: true, catalogSource: 'live', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 4, unknown: 0, pending: 0 } })
    await assertEmpty('No qualified contracts')
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending: 0 } })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
    await page.locator('[data-chart-inst="BETA-USDT-SWAP"]').waitFor()
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
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'The renderer displays the backend membership immediately.')
    await page.locator('[data-market-list]').getByText('Market verification unavailable', { exact: true }).waitFor()
    await page.locator('[data-market-list]').getByText('Incomplete', { exact: true }).waitFor()
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
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    assert.equal(await page.evaluate(() => globalThis.__continuityChart === document.querySelector('[data-chart-inst]') && globalThis.__continuitySVG === document.querySelector('svg[data-rendered-inst]')), true, 'A temporary verification gap must preserve the existing chart surface.')
    assert.match(await page.locator('[data-chart-inst] [aria-live="off"] p').textContent(), /Selected/, 'The ongoing candle inspection must survive verification gaps.')
    assert.equal(await page.getByText('No qualified contracts', { exact: true }).count(), 0)
  }
  try {
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
    await page.evaluate(() => {
      globalThis.__continuityChart = document.querySelector('[data-chart-inst]')
      globalThis.__continuitySVG = document.querySelector('svg[data-rendered-inst]')
    })
    const bounds = await page.locator('svg[data-rendered-inst]').boundingBox()
    await page.mouse.move(bounds.x + bounds.width * .4, bounds.y + bounds.height * .1)
    await page.mouse.down()
    await page.waitForFunction(() => document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
    await publish({ rows: [], loading: true, error: '', catalogSource: 'live', catalogProgress: { total: 4, completed: 0, verified: 0, failed: 0, unknown: 0, pending: 4 } })
    await waitForMarketStatus('Verifying 0/4')
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'A verification gap may empty backend membership without discarding the current chart.')
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    await assertRetained('Verifying contracts')
    await publish({ loading: false, error: 'Order book observations are temporarily unavailable.', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 } })
    await assertRetained('Market verification unavailable')
    await publish({ error: '', catalogSource: 'none', catalogProgress: undefined })
    await waitForMarketStatus('Waiting')
    await assertRetained('Market verification unavailable')
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), catalogSource: 'live', catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending: 0 } })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
    assert.equal(await page.evaluate(() => globalThis.__continuityChart === document.querySelector('[data-chart-inst]') && globalThis.__continuitySVG === document.querySelector('svg[data-rendered-inst]')), true, 'Recovery of the selected contract must not remount the chart.')
    assert.match(await page.locator('[data-chart-inst] [aria-live="off"] p').textContent(), /Selected/)
    await page.mouse.up()
    await publish({ rows: [], loading: true, catalogProgress: { total: 4, completed: 4, verified: 0, failed: 4, unknown: 0, pending: 0 } })
    await waitForMarketStatus('Refreshing')
    await page.locator('[data-market-list]').getByText('No qualified contracts', { exact: true }).waitFor()
    await page.locator('[data-chart-panel]').getByText('No qualified contracts', { exact: true }).waitFor()
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
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  }
})

test('missing recent candles remain visible with repair status until the complete chart is restored', async () => {
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-chart-inst="BETA-USDT-SWAP"]'), status = chart.locator('[data-chart-status]')
  const publish = phase => electron.evaluate(async ({ ipcMain, BrowserWindow }, phase) => {
    const state = globalThis.__workspaceFixture
    if (!state.integrityBaseline) {
      state.chartGeneration += 1
      state.integrityBaseline = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
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
    BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', frame)
    return { generation: frame.generation, endHour: frame.endHour, liveHour: frame.liveBar.hour }
  }, phase)
  const waitForFrame = frame => page.waitForFunction(({ generation, endHour, liveHour }) => {
    const chart = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]'), snapshot = chart?.__chartSnapshot
    return snapshot?.generation === generation && snapshot.liveBar?.hour === liveHour
      && snapshot.endHour === endHour && snapshot.priceState === 'ready' && Number(chart.dataset.chartEnd) === liveHour
  }, frame)
  try {
    for (const [phase, expected, message] of [
      ['sparse', 'partial', 'Repairing missing price history…'],
      ['stale', 'stale', 'Recent price history is stale; repairing…'],
    ]) {
      const frame = await publish(phase)
      await page.waitForFunction(({ generation, state }) => {
        const chart = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')
        return chart?.__chartSnapshot.generation === generation && chart.dataset.chartCandleState === state
      }, { generation: frame.generation, state: expected })
      await status.getByText(message, { exact: true }).waitFor({ state: 'visible' })
      assert.doesNotMatch(await status.textContent(), /Chart ready/)
      assert.equal(await chart.getAttribute('data-chart-incomplete'), 'true')
      assert.equal(await chart.locator('svg[data-rendered-inst]').isVisible(), true, 'Actual prices remain visible while missing slots repair.')
      assert.ok(Number(await chart.getAttribute('data-chart-rendered-bars')) >= 95)
      assert.match(await chart.locator('svg[data-rendered-inst] [data-chart-price-label-value]').textContent(), /^133 /, 'The current forming price remains visible across the historical gap.')
    }
    await waitForFrame(await publish('repaired'))
    await page.waitForFunction(() => !document.querySelector('[data-chart-status]')?.textContent.trim())
    assert.equal(await chart.getAttribute('data-chart-candle-state'), 'ready')
    assert.equal(await chart.getAttribute('data-chart-incomplete'), 'false')
    assert.equal(await chart.getAttribute('data-chart-rendered-bars'), '96')
    assert.doesNotMatch(await status.textContent(), /missing price history|stale; repairing/)
  } finally {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      delete state.chartOverride
      delete state.integrityBaseline
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  }
})

test('failed and unavailable chart sources preserve qualified rows and report distinct status until a pushed recovery', async () => {
  await selectTimeframe(page, '15m')
  const chart = page.locator('[data-chart-inst="BETA-USDT-SWAP"]')
  try {
    await electron.evaluate(async ({ ipcMain }) => {
      const state = globalThis.__workspaceFixture
      state.chartGeneration += 1
      const frame = await ipcMain._invokeHandlers.get('radar:request')(null, { chartLocal: { instId: 'BETA-USDT-SWAP', timeframe: '15m' } })
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
    await chart.locator('[data-chart-status]').getByText(/OI failed: OI endpoint temporarily unavailable.*retry at/).waitFor({ timeout: 5_000 }).catch(async error => {
      const actual = await chart.evaluate(node => ({ status: node.querySelector('[data-chart-status]')?.textContent, dataset: { ...node.dataset },
        snapshot: node.__chartSnapshot && { generation: node.__chartSnapshot.generation, revision: node.__chartSnapshot.revision,
          oiState: node.__chartSnapshot.oiState, oiStatus: node.__chartSnapshot.oiStatus, takerState: node.__chartSnapshot.takerState, takerStatus: node.__chartSnapshot.takerStatus } }))
      throw new Error(`The pushed source failure was not presented: ${JSON.stringify(actual)}`, { cause: error })
    })
    await chart.locator('[data-chart-status]').getByText('Taker is not published for part of this range', { exact: true }).waitFor()
    assert.equal(await chart.getAttribute('data-chart-oi-state'), 'error')
    assert.equal(await chart.getAttribute('data-chart-taker-state'), 'unavailable')
    assert.equal(await chart.getAttribute('data-chart-taker-samples'), '0')
    assert.equal(await chart.locator('svg[data-rendered-inst]').isVisible(), true)
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '4')
    assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
    await electron.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__workspaceFixture
      state.chartOverride = { ...state.sourceBaseline, revision: state.sourceBaseline.revision + 2 }
      BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', state.chartOverride)
    })
    await page.waitForFunction(() => document.querySelector('[data-chart-inst]')?.dataset.chartOiState === 'ready'
      && document.querySelector('[data-chart-inst]')?.dataset.chartTakerState === 'ready')
    assert.doesNotMatch(await chart.locator('[data-chart-status]').textContent(), /failed|not published|retry at/)
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; delete state.chartOverride; delete state.sourceBaseline })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  }
})
