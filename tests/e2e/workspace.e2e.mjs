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
    const rows = [['NULL', null], ['ZETA', 3], ['BETA', -3], ['ALPHA', 1]].map(([symbol, rankingChange]) => ({
      instId: `${symbol}-USDT-SWAP`, price: 100, lastPrice: 100, rankingChange, rankingAsOf: 1_800_000_000_000,
      turnover24hUSDT: 50_000_000,
    }))
    const state = globalThis.__workspaceFixture = { preferences, rows, initialRows: rows, requests: [], revision: 1, loading: false, error: '', catalogSource: 'live', catalogProgress: undefined, failNextSave: false, failSnapshots: 0, staleNextSnapshot: false, staleReplies: 0, chartGeneration: 1, bollMode: 'standard', holdNextSnapshot: false, releaseSnapshot: null, snapshotActive: 0, snapshotMaximum: 0,
      holdAuditAction: null, releaseAudit: null, heldAuditReply: null,
      holdDownloadAction: null, releaseDownload: null, heldDownloadReply: null,
      historyDownload: { phase: 'idle', startedAt: null, updatedAt: null, finishedAt: null,
        contracts: { completed: 0, total: 0 }, streams: { completed: 0, total: 0 },
        progress: { completed: 0, total: 0, available: 0, unavailable: 0, reused: 0, pending: 0 },
        active: [], failures: [], error: '', revision: 0, serviceSession: 'download-fixture' },
      audit: { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '', revision: 0, serviceSession: 'audit-fixture' } }
    state.notify = () => BrowserWindow.getAllWindows()[0].webContents.send('radar:market-changed')
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
        const snapshot = { rows: stale ? [] : state.rows, revision: state.revision - (stale ? 1 : 0), serviceSession: 'renderer-fixture',
          timeframe: value.snapshot.timeframe, realtimeState: 'Connected', updatedAt: 1_800_000_000_000,
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
      if (value.chartUniverse) return { frames: value.chartUniverse.instIds.map(instId => prepared({ instId, timeframe: value.chartUniverse.timeframe })) }
      if (value.chartLocal) return prepared(value.chartLocal)
      if (value.chartWindow) return prepared(value.chartWindow)
      if (value.captureChart) return { ok: true }
      if (value.analysisSettings) return { model: '', hasAPIKey: false }
      if (value.historyDownload) {
        const action = value.historyDownload.action
        if (action === 'start') state.publishDownload({ id: 'download-1', phase: 'running', startedAt: 1_800_000_000_000, updatedAt: 1_800_000_001_000, finishedAt: null,
          contracts: { completed: 0, total: 2 }, streams: { completed: 1, total: 18 },
          progress: { completed: 100, total: 1_000, available: 90, unavailable: 10, reused: 80, pending: 900 }, failures: [], error: '',
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
})
after(async () => { await electron?.close(); await rm(userData, { recursive: true, force: true }) })

const selected = () => page.locator('[data-market-index][aria-selected="true"]')
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
    const dialog = element.closest('[role=dialog]'), form = element.closest('form'), d = dialog?.getBoundingClientRect()
    return { acceptsPointer: target === element || element.contains(target), target: target?.tagName, role: target?.getAttribute('role'), x: rect.x, y: rect.y, width: rect.width, height: rect.height, dialog: d ? { x: d.x, y: d.y, width: d.width, height: d.height, clientWidth: dialog.clientWidth, offsetWidth: dialog.offsetWidth, scrollWidth: dialog.scrollWidth, scrollTop: dialog.scrollTop, gutter: getComputedStyle(dialog).scrollbarGutter, formWidth: form?.getBoundingClientRect().width } : null }
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

test('a prepared idle chart makes no periodic window requests and accepts a pushed forming candle', async () => {
  const chart = page.locator('[data-chart-inst="BETA-USDT-SWAP"]')
  await page.waitForFunction(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.dataset.chartLoading === 'false')
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow).length), before, 'A successfully prepared chart must stay idle until an event or actual retry deadline.')
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
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow).length), before, 'A pushed forming candle must update the prepared chart without a window request.')
  const liveUpdate = await page.evaluate(() => {
    const snapshot = document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]').__chartSnapshot
    globalThis.__completedSubscriptionBars = snapshot.bars
    return { type: 'live', instId: snapshot.instId, timeframe: snapshot.timeframe, generation: 2, revision: 2,
      endHour: snapshot.endHour, liveBar: { ...snapshot.liveBar, high: 136, close: 135 } }
  })
  const reads = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.chartWindow || value.chartLocal || value.chartHistory).length)
  assert.equal('bars' in liveUpdate, false, 'A forming update must not transfer completed candles.')
  await electron.evaluate(({ BrowserWindow }, update) => BrowserWindow.getAllWindows()[0].webContents.send('radar:chart-prepared', update), liveUpdate)
  await page.waitForFunction(() => document.querySelector('[data-chart-inst="BETA-USDT-SWAP"]')?.__chartSnapshot.liveBar?.close === 135)
  assert.match(await chart.locator('[aria-live="off"]').textContent(), /Close\s+135/)
  assert.match(await chart.locator('[data-chart-price-label-value]').textContent(), /^135 /)
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
          statisticsObserved: observed, oiObserved: observed, takerObserved: observed, indicatorsObserved: observed }]
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
        await publish({ oiState: value, takerState: value, indicatorState: value === 'loading' ? 'loading' : 'ready' })
        await status.getByText(value === 'loading' ? 'Loading OI history…' : 'OKX 15m OI history is incomplete for this range', { exact: true }).waitFor()
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
        const close = await page.locator('[data-chart-inst] [aria-live="off"] > div:last-child span[title]').getAttribute('title')
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

test('a healthy idle market list makes no periodic snapshot requests', async () => {
  await page.waitForFunction(() => document.querySelectorAll('[data-market-index]').length === 4)
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length)
  await new Promise(resolve => setTimeout(resolve, 2_250))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before,
    'Successful market reads must wait for a notification, action, or visibility change.')
})

test('snapshot failures retry with bounded backoff and stop scheduling after recovery', async () => {
  try {
    await page.evaluate(() => {
      const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window)
      const pending = new Map(), delays = []
      let next = 1_000_000_000
      // Advance only the snapshot error deadlines. Other UI clocks and native
      // event delivery keep running normally throughout this Electron test.
      window.setTimeout = (handler, delay, ...args) => {
        if (typeof handler !== 'function' || ![4_000, 8_000, 16_000, 30_000].includes(delay)) return timeout(handler, delay, ...args)
        const id = ++next
        delays.push(delay); pending.set(id, () => handler(...args))
        return id
      }
      window.clearTimeout = id => { pending.delete(id); clear(id) }
      globalThis.__snapshotRetryClock = { delays, pending, runNext() {
        const [id, run] = pending.entries().next().value ?? []
        if (!run) throw new Error('No snapshot retry deadline was scheduled.')
        pending.delete(id); run()
      }, restore() { window.setTimeout = timeout; window.clearTimeout = clear; pending.clear() } }
    })
    const before = await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      const before = state.requests.filter(value => value.snapshot).length
      state.failSnapshots = 5
      state.rows = state.rows.map(row => row.instId === 'BETA-USDT-SWAP' ? { ...row, lastPrice: 204 } : row)
      state.revision += 1; state.notify()
      return before
    })
    const delays = [4_000, 8_000, 16_000, 30_000, 30_000]
    for (let index = 0; index < delays.length; index++) {
      await page.waitForFunction(index => globalThis.__snapshotRetryClock.delays.length === index + 1 && globalThis.__snapshotRetryClock.pending.size === 1, index)
      assert.deepEqual(await page.evaluate(() => globalThis.__snapshotRetryClock.delays), delays.slice(0, index + 1))
      assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + index + 1,
        'A failed request must wait for its single retry deadline.')
      await page.evaluate(() => globalThis.__snapshotRetryClock.runNext())
    }
    await page.waitForFunction(() => document.querySelector('[aria-label="View BETA-USDT-SWAP chart"] td:nth-child(2)')?.textContent === '204')
    await page.getByRole('alert').filter({ hasText: 'Snapshot temporarily unavailable.' }).waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => globalThis.__snapshotRetryClock.pending.size), 0)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length), before + 6)
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.failSnapshots = 1; state.notify() })
    await page.waitForFunction(() => globalThis.__snapshotRetryClock.delays.length === 6)
    assert.equal(await page.evaluate(() => globalThis.__snapshotRetryClock.delays.at(-1)), 4_000, 'Recovery resets the error backoff.')
    await page.evaluate(() => globalThis.__snapshotRetryClock.runNext())
    await page.getByRole('alert').filter({ hasText: 'Snapshot temporarily unavailable.' }).waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => globalThis.__snapshotRetryClock.pending.size), 0)
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

test('search preserves selection while six width/DPR combinations share portal, pointer, and capture coordinates', async () => {
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
      const hoveredClose = await page.locator('[data-chart-inst] [aria-live="off"] > div:last-child span[title]').getAttribute('title')
      assert.equal(Number(hoveredClose), target.close, 'Screen-space pointer input must inspect the candle drawn beneath it at every UI scale and DPR.')
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('[data-chart-inst] [aria-live="off"] p')?.textContent.includes('Selected'))
      const captureBounds = await page.locator('[data-chart-inst]').boundingBox()
      await page.getByRole('button', { name: 'Copy chart', exact: true }).click()
      await page.getByRole('status').filter({ hasText: 'Chart copied to clipboard' }).waitFor()
      const request = await electron.evaluate(() => globalThis.__workspaceFixture.requests.findLast(value => value.captureChart).captureChart)
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(request[key] - captureBounds[key]) < 1, `Capture ${key} must use the drawn CSS-pixel bounds, independent of DPR.`)
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `workspace-${width}-dpr${deviceScaleFactor}.png`) })
      const settings = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox()
      await page.mouse.click(settings.x + settings.width / 2, settings.y + settings.height / 2)
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]'), scale = Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale)
        const rect = dialog?.getBoundingClientRect()
        return rect && Math.abs(rect.width / dialog.offsetWidth - scale) < .01 && Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 2
      })
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1_001, 'Scaled portal content must stay within the viewport.')
      const ranking = dialog.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' })
      const input = await ranking.boundingBox()
      await page.mouse.click(input.x + input.width / 2, input.y + input.height / 2)
      assert.equal(await ranking.evaluate(element => element === document.activeElement), true, 'Portaled controls must accept screen-space pointer coordinates.')
      if (process.env.PERPETUAL_SWAP_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.PERPETUAL_SWAP_UI_SCREENSHOTS, `settings-${width}-dpr${deviceScaleFactor}.png`) })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
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
    await page.getByRole('textbox', { name: 'Search contracts' }).fill('')
    await client.send('Emulation.clearDeviceMetricsOverride')
    await client.detach()
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height })
    await page.setViewportSize(viewport)
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height && Number(document.querySelector('[data-layout="market-workspace"]')?.dataset.uiScale) === width / 1_600, viewport)
  }
})

test('independent liquidity controls show validation and save failures before persisting a corrected preference set', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog && Math.abs(dialog.getBoundingClientRect().width / dialog.offsetWidth - Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale)) < .01
  })
  assert.equal(await dialog.getByRole('switch').count(), 6)
  await dialog.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('7')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await dialog.getByText('Use a multiple of 5 minutes.', { exact: true }).waitFor()
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.preferences?.action === 'update').length), 0)
  await dialog.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('30')
  const spread = dialog.getByRole('switch', { name: 'Bid-ask spread', exact: true })
  await clickByRect(spread)
  assert.equal(await spread.getAttribute('aria-checked'), 'false')
  const stability = dialog.getByRole('switch', { name: 'Volume stability', exact: true })
  await clickByRect(stability)
  assert.equal(await stability.getAttribute('aria-checked'), 'true')
  await dialog.getByRole('spinbutton', { name: 'Maximum hourly volume ratio', exact: true }).fill('2.5')
  await electron.evaluate(() => { globalThis.__workspaceFixture.failNextSave = true })
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'The preferences could not be saved.' }).waitFor()
  assert.equal(await dialog.isVisible(), true)
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const preferences = await electron.evaluate(() => globalThis.__workspaceFixture.preferences)
  assert.equal(preferences.rankingLookback, 30)
  assert.equal(preferences.liquidity.spread.enabled, false)
  assert.deepEqual(preferences.liquidity.volumeStability, { enabled: true, maxRatio: 2.5 })
  await page.getByRole('columnheader', { name: '30m change', exact: true }).waitFor()
  await selectTimeframe(page, '5m')
  await page.waitForFunction(() => document.querySelector('[aria-label="Chart timeframe"] button[aria-pressed="true"]')?.textContent === '5m')
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.preferences.rankingLookback), 30, 'Chart timeframe must not change the independent ranking window.')
})

test('saving only the ranking lookback keeps the current qualified rows and chart mounted', async () => {
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  await page.evaluate(() => { globalThis.__rankingChart = document.querySelector('[data-chart-inst]') })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('spinbutton', { name: 'Ranking lookback (minutes)' }).fill('45')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('columnheader', { name: '45m change', exact: true }).waitFor()
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart')
  assert.equal(await page.evaluate(() => globalThis.__rankingChart === document.querySelector('[data-chart-inst]')), true, 'Changing the ranking window must not clear the qualified universe and remount its chart.')
  await page.evaluate(() => { delete globalThis.__rankingChart })
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('status').filter({ hasText: 'idle · 0 / 0' }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 1)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1)
  await dialog.getByRole('button', { name: 'Start audit', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'running · 1 / 3' }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ progress: { completed: 2, total: 3 } }) })
  await dialog.getByRole('status').filter({ hasText: 'running · 2 / 3' }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel audit', exact: true }).click()
  await dialog.getByRole('list', { name: 'Data audit issues' }).getByText('Missing completed candle · Repairable', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Repair issues', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  assert.equal(await dialog.getByRole('list', { name: 'Data audit issues' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 1, 'A successful audit dialog must wait for checkpoints rather than poll.')
  const actions = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit).map(value => value.dataAudit.action))
  assert.deepEqual(actions.filter(action => action !== 'status'), ['start', 'cancel', 'repair'])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, before + 2)
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length), before + 2, 'Reopening performs one fresh status read.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('new audit pushes win over held initial and action replies across dialog reopen', async () => {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })
      state.holdAuditAction = 'status'
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishAudit({ phase: 'running', progress: { completed: 2, total: 3 } })
      state.publishAudit({ phase: 'completed', progress: { completed: 7, total: 7 } })
    })
    await dialog.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'idle', 'The held initial reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await dialog.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    const beforeReopen = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await dialog.getByRole('status').filter({ hasText: 'completed · 7 / 7' }).waitFor()
    await waitForAuditFixture((_electron, expected) => globalThis.__workspaceFixture.requests.filter(value => value.dataAudit?.action === 'status').length === expected, beforeReopen + 1)
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdAuditAction = 'start' })
    await dialog.getByRole('button', { name: 'Start audit', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseAudit))
    await dialog.getByRole('status').filter({ hasText: 'running · 1 / 3' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishAudit({ phase: 'completed', progress: { completed: 3, total: 3 } }) })
    await dialog.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Start audit', exact: true }).isDisabled(), true, 'A push must not release an action that is still in flight.')
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldAuditReply.phase), 'running', 'The held action reply must remain its detached older report.')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseAudit() })
    await dialog.getByRole('button', { name: 'Start audit', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Start audit')?.disabled)
    await dialog.getByRole('status').filter({ hasText: 'completed · 3 / 3' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdAuditAction = null; state.releaseAudit?.() })
    await page.keyboard.press('Escape')
  }
})

test('manual history downloads show exact pushed progress and retry details, continue across settings close, and cancel without polling', async () => {
  const before = await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('status').filter({ hasText: 'Ready to download · 0.0%' }).waitFor()
  await dialog.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'Downloading history · 10.0%' }).waitFor()
  const details = dialog.locator('[aria-label="History download details"]')
  await details.getByText('100 / 1,000', { exact: true }).waitFor()
  await details.getByText('1 / 18', { exact: true }).waitFor()
  const active = dialog.getByRole('list', { name: 'Active history downloads' })
  await active.getByText('BETA-USDT-SWAP · 15m · oi', { exact: true }).waitFor()
  await active.getByText(/retrying · Consecutive failures: 2 · Next retry:/).waitFor()
  await active.getByText('Temporary source limit.', { exact: true }).waitFor()
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { completed: 999_999, total: 1_000_000, available: 900_000, unavailable: 99_999, reused: 300_000, pending: 1 },
  }) })
  await dialog.getByRole('status').filter({ hasText: 'Downloading history · 99.9%' }).waitFor()
  await details.getByText('999,999 / 1,000,000', { exact: true }).waitFor()
  await details.getByText('99,999', { exact: true }).waitFor()
  await details.getByText('300,000', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({
    progress: { completed: 1_000_000, total: 1_000_000, available: 900_001, unavailable: 99_999, reused: 300_000, pending: 0 },
  }) })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'Downloading history · 100.0%' }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel download', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: 'Download cancelled · 100.0%' }).waitFor()
  assert.equal(await dialog.getByRole('list', { name: 'Active history downloads' }).count(), 0)
  await new Promise(resolve => setTimeout(resolve, 1_750))
  assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload?.action === 'status').length), before + 2)
  assert.deepEqual(await electron.evaluate(() => globalThis.__workspaceFixture.requests.filter(value => value.historyDownload && value.historyDownload.action !== 'status').map(value => value.historyDownload.action)), ['start', 'cancel'])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('new download pushes win over held replies and completion distinguishes unavailable data', async () => {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  try {
    await electron.evaluate(() => {
      const state = globalThis.__workspaceFixture
      state.publishDownload({ phase: 'idle', progress: { completed: 0, total: 0, available: 0, unavailable: 0, reused: 0, pending: 0 }, error: '' })
      state.holdDownloadAction = 'status'
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { completed: 1_000_000, total: 1_000_000, available: 900_001, unavailable: 99_999, reused: 300_000, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await dialog.getByRole('status').filter({ hasText: 'Completed with unavailable data · 100.0%' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await dialog.getByRole('status').filter({ hasText: 'Completed with unavailable data · 100.0%' }).waitFor()
    await electron.evaluate(() => { globalThis.__workspaceFixture.holdDownloadAction = 'start' })
    await dialog.getByRole('button', { name: 'Download all qualified history', exact: true }).click()
    await waitForAuditFixture(() => Boolean(globalThis.__workspaceFixture.releaseDownload))
    await electron.evaluate(() => { globalThis.__workspaceFixture.publishDownload({ phase: 'completed',
      progress: { completed: 1_000, total: 1_000, available: 1_000, unavailable: 0, reused: 80, pending: 0 },
      contracts: { completed: 2, total: 2 }, streams: { completed: 18, total: 18 }, active: [],
    }) })
    await dialog.getByRole('status').filter({ hasText: 'Download complete · 100.0%' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: /Download all qualified history/ }).isDisabled(), true)
    assert.equal(await electron.evaluate(() => globalThis.__workspaceFixture.heldDownloadReply.phase), 'running')
    await electron.evaluate(() => { globalThis.__workspaceFixture.releaseDownload() })
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Download all qualified history')?.disabled)
    await dialog.getByRole('status').filter({ hasText: 'Download complete · 100.0%' }).waitFor()
  } finally {
    await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.holdDownloadAction = null; state.releaseDownload?.() })
    await page.keyboard.press('Escape')
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
    await page.locator('[data-chart-price-scale="linear"]').getByText('Linear scale · BOLL includes zero or negative values', { exact: false }).waitFor()
    const paths = await page.locator('svg[data-rendered-inst] path[d]').evaluateAll(paths => paths.map(path => path.getAttribute('d')))
    assert.doesNotMatch(paths.join(' '), /NaN|Infinity|undefined/)
    assert.equal(await page.locator('[data-chart-indicator="bollLower"]').evaluate(path => path.getAttribute('d').length > 0), true)
  } finally { await publishMode('standard') }
})

test('a rejected old snapshot preserves notification delivery and qualification changes select the next contract or the empty state', async () => {
  await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.staleNextSnapshot = true; state.notify() })
  const deadline = Date.now() + 10_000
  while (!(await electron.evaluate(() => globalThis.__workspaceFixture.staleReplies))) {
    assert.ok(Date.now() < deadline, 'The renderer did not read the notified stale snapshot.')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(await selected().getAttribute('aria-label'), 'View BETA-USDT-SWAP chart', 'An old empty snapshot cannot clear the current selection.')
  const requestsAtStaleReply = await electron.evaluate(() => {
    const state = globalThis.__workspaceFixture
    state.rows = state.rows.filter(row => row.instId !== 'BETA-USDT-SWAP')
    state.revision += 1
    state.notify()
    return state.requests.filter(value => value.snapshot).length
  })
  await page.locator('[data-market-index][aria-selected="true"][aria-label="View ZETA-USDT-SWAP chart"]').waitFor()
  assert.ok(await electron.evaluate((_electron, count) => globalThis.__workspaceFixture.requests.filter(value => value.snapshot).length > count, requestsAtStaleReply), 'Rejecting one stale snapshot must not stop subsequent notifications.')
  await page.locator('[data-chart-inst="ZETA-USDT-SWAP"]').waitFor()
  await electron.evaluate(() => { const state = globalThis.__workspaceFixture; state.rows = []; state.revision += 1; state.notify() })
  await page.locator('[data-market-list]').getByText('No qualified contracts', { exact: true }).waitFor()
  await page.locator('[data-chart-panel]').getByText('No qualified contracts', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-chart-inst]').count(), 0)
  await assertWorkspaceLayout(page)
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
    await page.waitForFunction(() => document.querySelector('[data-market-list] [data-slot="badge"]')?.textContent.includes('Refreshing'))
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
    await page.getByRole('alert').filter({ hasText: 'Order book data is unavailable.' }).waitFor()
    await publish({ error: '' })
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    await assertEmpty('Market verification unavailable')
    await publish({ catalogSource: 'none', catalogProgress: undefined })
    await page.waitForFunction(() => document.querySelector('[data-market-list] [data-slot="badge"]')?.textContent.includes('Waiting'))
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
  const assertRetained = async (title, status) => {
    await page.locator('[data-market-list]').getByText(title, { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: status }).waitFor()
    assert.equal(await page.locator('[data-total-market-count]').getAttribute('data-total-market-count'), '0', 'The qualified list must remain empty while qualification is unknown.')
    assert.equal(await page.locator('[data-chart-inst]').getAttribute('data-chart-inst'), 'BETA-USDT-SWAP')
    assert.deepEqual(await electron.evaluate(() => globalThis.__workspaceFixture.requests.findLast(value => value.chartUniverse)?.chartUniverse.instIds), ['BETA-USDT-SWAP'], 'The retained chart must keep its realtime and prepared-data subscription.')
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
    await assertRetained('Verifying contracts', 'Rechecking qualification · Current chart remains available')
    await publish({ loading: false, error: 'Order book observations are temporarily unavailable.', catalogProgress: { total: 4, completed: 4, verified: 0, failed: 0, unknown: 4, pending: 0 } })
    await assertRetained('Market verification unavailable', 'Qualification data unavailable · Current chart remains available')
    await publish({ error: '', catalogSource: 'none', catalogProgress: undefined })
    await page.waitForFunction(() => document.querySelector('[data-market-list] [data-slot="badge"]')?.textContent.includes('Waiting'))
    await assertRetained('Market verification unavailable', 'Qualification data unavailable · Current chart remains available')
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), catalogSource: 'live', catalogProgress: { total: 4, completed: 4, verified: 4, failed: 0, unknown: 0, pending: 0 } })
    await page.locator('[data-market-index][aria-selected="true"][aria-label="View BETA-USDT-SWAP chart"]').waitFor()
    assert.equal(await page.evaluate(() => globalThis.__continuityChart === document.querySelector('[data-chart-inst]') && globalThis.__continuitySVG === document.querySelector('svg[data-rendered-inst]')), true, 'Recovery of the selected contract must not remount the chart.')
    assert.match(await page.locator('[data-chart-inst] [aria-live="off"] p').textContent(), /Selected/)
    await page.mouse.up()
    await publish({ rows: [], loading: true, catalogProgress: { total: 4, completed: 4, verified: 0, failed: 4, unknown: 0, pending: 0 } })
    await page.locator('[data-chart-panel]').getByText('No qualified contracts', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-chart-inst]').count(), 0, 'A confirmed complete exclusion must clear the chart.')
    assert.deepEqual(await electron.evaluate(() => globalThis.__workspaceFixture.requests.findLast(value => value.chartUniverse)?.chartUniverse.instIds), [], 'Confirmed exclusions must remove the retained chart subscription.')
  } finally {
    await page.mouse.up()
    await page.evaluate(() => { delete globalThis.__continuityChart; delete globalThis.__continuitySVG })
    await publish({ rows: await electron.evaluate(() => globalThis.__workspaceFixture.initialRows), loading: false, error: '', catalogSource: 'live', catalogProgress: undefined })
    await page.locator('[data-market-index]').first().waitFor({ state: 'visible' })
  }
})
