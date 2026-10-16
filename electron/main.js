import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChartFocus } from './services/chart-focus.js'
import { MarketStore } from './services/market-store.js'
import { MarketService } from './services/market-service.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
const FIVE_MINUTES = 300_000
const HOUR = 3_600_000
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let window
let marketStore
let marketService
const gatewayRequests = new Map()
const chartFocus = new ChartFocus()
let shuttingDown = false
let shutdownComplete = false

// Electron E2E tests must never depend on OKX availability or mutate the
// fixture while the renderer is asserting a loading/partial-data state.
const offlineE2EFetch = async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => ({ code: '0', data: [] }),
})

const defaults = {
  windowBlurRadius: 64,
  floatingBlurRadius: 64,
  frostedBackgroundEnabled: true,
  frostedBackgroundOpacity: 0.3,
  backgroundMonitoringEnabled: false,
  notificationsEnabled: false,
  monitoringPaused: false,
  hourlyVolumeStabilityEnabled: false,
}
let settingsCache = { ...defaults }

async function settings() {
  try { settingsCache = { ...defaults, ...JSON.parse(await readFile(settingsFile(), 'utf8')) } }
  catch { settingsCache = { ...defaults } }
  return settingsCache
}

async function saveSettings(value) {
  const next = { ...(await settings()), ...value }
  settingsCache = next
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

function focusChart(instId, session, token) {
  const accepted = chartFocus.focus(instId, session, token)
  if (accepted.ok) marketService?.focusChart(instId, accepted.sequence)
  return accepted
}

function focusLegacyChart(instId) {
  const accepted = chartFocus.focusLegacy(instId)
  if (accepted.ok) marketService?.focusChart(instId, accepted.sequence)
  return accepted
}

function preferences(saved) {
  try { return saved.filterLibraryPreferencesJSON ? JSON.parse(saved.filterLibraryPreferencesJSON) : { favorites: [], recent: [], layout: 'sentences' } }
  catch { return { favorites: [], recent: [], layout: 'sentences' } }
}

async function snapshot() {
  const saved = await settings(), market = marketService?.snapshot() ?? { rows: [], revision: 0, error: 'Loading OKX market data…', loading: true }
  return {
    ...saved, rows: market.rows, updatedAt: market.rows.length ? Date.now() : null, error: market.error, revision: market.revision,
    filterMetricsCatalog: [], filterFunctions: [], filterFunctionCatalog: [],
    filterLibraryPreferences: preferences(saved), notificationAuthorization: 'unavailable',
    notificationError: '', backgroundMonitoringError: '', launchAtLogin: 'unavailable', launchAtLoginError: '',
  }
}

function headersFor(response) { return Object.fromEntries(response.headers.entries()) }

async function gatewayFetch(event, value) {
  const { id, body } = value
  if (typeof id !== 'string' || typeof body !== 'string') throw new Error('Invalid Gateway request.')
  const controller = new AbortController(); gatewayRequests.set(id, controller)
  try {
    const saved = await settings()
    const apiKey = saved.analysis?.apiKey
    if (!apiKey) throw new Error('Save an AI Gateway API key in Configure analysis before starting analysis.')
    const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body, signal: controller.signal })
    if (!response.body) return { status: response.status, headers: headersFor(response) }
    void (async () => {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break
          event.sender.send('radar:gateway-stream', { id, type: 'data', base64: Buffer.from(chunk).toString('base64') })
        }
        event.sender.send('radar:gateway-stream', { id, type: 'end' })
      } catch (error) {
        if (!controller.signal.aborted) event.sender.send('radar:gateway-stream', { id, type: 'error', message: error instanceof Error ? error.message : 'Gateway stream interrupted.' })
      } finally { gatewayRequests.delete(id) }
    })()
    return { status: response.status, headers: headersFor(response) }
  } catch (error) { gatewayRequests.delete(id); throw error }
}

async function seedPartialStatisticsChart() {
  const instId = 'BTC-USDT-SWAP'
  const timeframe = '1H'
  const end = Date.UTC(2024, 11, 16, 12, 0)
  const warmupHours = 199
  const visibleBars = 96
  const partialSamples = 8
  const sourceStart = end - (visibleBars - 1 + warmupHours) * HOUR
  const source = []
  for (let timestamp = sourceStart; timestamp <= end + HOUR - FIVE_MINUTES; timestamp += FIVE_MINUTES) {
    const index = (timestamp - sourceStart) / FIVE_MINUTES
    const base = 100 + index * 0.01
    source.push({
      instrument: instId, timeframe: '5m', timestamp,
      open: base, high: base + 1, low: base - 1, close: base + 0.25,
      volume: 10, quoteVolume: 1_000, confirmed: true,
    })
  }
  const statistics = Array.from({ length: visibleBars }, (_, index) => {
    const sourceHour = warmupHours + index
    const base = 100 + sourceHour * 0.12
    const available = index >= visibleBars - partialSamples
    return {
      instrument: instId, timeframe, timestamp: end - (visibleBars - 1 - index) * HOUR,
      open: base, high: base + 1.11, low: base - 1, close: base + 0.36,
      volume: 120, quoteVolume: 12_000,
      oi: available ? 1_000_000 + index * 1_000 : null,
      buy: available ? 100_000 + index * 100 : null,
      sell: available ? 80_000 + index * 100 : null,
      statisticsVersion: available ? 1 : null,
      confirmed: true,
    }
  })
  await marketStore.appendCandles(source)
  await marketStore.appendCandles(statistics)
  marketService.instruments.set(instId, { instId })
  // The source fixture is already complete; keep the latest-candle fetcher
  // out of this test so no live response can replace its deliberate gaps.
  marketService.lastCandleHydration.set(instId, Date.now())
  marketService.rows = [{
    instId, turnover24hUSDT: 40_000_000, ema200Signal: null,
    price: 135, lastPrice: 135, priceChange: 0, currentLow: 99, currentHigh: 136,
    buy: null, sell: null, takerRatio: null, oiChange: null,
    highBreakout: { status: 'none' }, lowBreakdown: { status: 'none' }, highBreakout96: { status: 'none' }, lowBreakdown96: { status: 'none' },
    roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null,
    logBBAboveBand: null, logBBExpansion: null, rocChange: null, marocChange: null,
    filterMetrics: {
      liveOpen: null, liveClose: null, ema200: null, previousEMA200: null, vwap14: null,
      bbUpper: null, bbMiddle: null, bbLower: null, priorHigh48: null, priorLow48: null,
      priorHigh96: null, priorLow96: null, oiUSD: null, spreadPercent: null, liveVolumeUSDT: null,
    },
    opportunity: { direction: null, setup: null, status: 'Incomplete', score: null, components: null, reasons: [] },
  }]
  marketService.error = ''
  marketService.lastRefreshAt = Date.now()
  marketService.markChartDataChanged()
  return { instId, timeframe, end, start: end - (visibleBars - 1) * HOUR, visibleBars, oiSamples: partialSamples, takerSamples: partialSamples }
}

function unsupported(request) {
  const operation = Object.keys(request).find(key => !['copyText', 'captureChart', 'analysisSettings', 'windowTintRGB', 'previewWindowBlur'].includes(key)) ?? 'request'
  throw new Error(`Electron data service does not yet implement “${operation}”. Configure the DuckDB/Parquet service before using market data.`)
}

async function handleRequest(event, request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid desktop bridge request.')
  if ('e2e' in request) {
    if (!testMode) throw new Error('The E2E desktop API is unavailable outside tests.')
    if (request.e2e.action === 'seedCandles') return { written: await marketStore.appendCandles(request.e2e.candles ?? []) }
    if (request.e2e.action === 'seedPartialStatisticsChart') return seedPartialStatisticsChart()
    if (request.e2e.action === 'settings') return settings()
    throw new Error('Unknown E2E desktop action.')
  }
  if ('suite' in request) {
    return { profiles: [], selectedID: '', confirmed: [], provisional: [], rows: [], revision: 0, timeframe: request.suite.timeframe }
  }
  if ('research' in request) return { studies: [], job: null, ok: true }
  if ('foregroundWorkspace' in request) return { ok: true }
  if ('rocPeriod' in request) return snapshot()
  if ('compileMarketFilters' in request) {
    const source = request.compileMarketFilters
    const configJSON = source.filtersJSON ?? source.previousJSON ?? ''
    return { diagnostics: configJSON ? [] : ['A rule configuration is required.'], configJSON, expressions: {}, units: {}, requiredHours: 0 }
  }
  if ('previewMarketFilters' in request) return { ...(await snapshot()), filterToken: request.previewMarketFilters.token, filterResults: {}, historyProgress: { pending: 0, completed: 0, error: '' } }
  if ('explainMarketFilters' in request) return { instId: request.explainMarketFilters.instId, filterToken: request.explainMarketFilters.token, revision: 0, trace: null }
  if ('chartSession' in request) return { session: chartFocus.beginSession() }
  if ('chartFocus' in request) return { ok: focusChart(request.chartFocus?.instId, request.chartFocus?.session, request.chartFocus?.token).ok }
  if ('chartInstId' in request) {
    const timeframe = request.timeframe ?? '1H'
    let focused = { ok: false, sequence: undefined }
    if (!request.preview) {
      if (Number.isSafeInteger(request.chartFocusSession) && Number.isSafeInteger(request.chartFocusToken)) {
        focused = focusChart(request.chartInstId, request.chartFocusSession, request.chartFocusToken)
      } else {
        focused = focusLegacyChart(request.chartInstId)
      }
    }
    // A newer wheel position already owns this renderer session. Do not let a
    // late IPC message add cache-only DuckDB work ahead of the visible window.
    if (!request.preview && !focused.ok) return { unchanged: true, error: '', revision: marketService.revision }
    if (request.chartEndHour === undefined && request.sinceRevision === marketService.revision && marketService.isActiveChartViewport(request.chartInstId, timeframe, undefined)) {
      return { unchanged: true, error: '', revision: marketService.revision }
    }
    // Neighbor previews may read the local cache, but must never enqueue
    // hydration, gap repair, or OI/Taker work ahead of the visible chart.
    const chart = await marketService.bars(request.chartInstId, timeframe, request.chartEndHour, focused.ok ? { foreground: true, focusToken: focused.sequence } : { hydrate: false, repair: false, statistics: false })
    if (chart.stale) return { unchanged: true, error: '', revision: marketService.revision }
    const { bars } = chart
    const intervalMS = timeframe === '5m' ? 300_000 : timeframe === '15m' ? 900_000 : 3_600_000
    const oldestHour = bars[0]?.hour ?? null, latestHour = bars.at(-1)?.hour ?? null
    const minimumEnd = oldestHour === null ? null : Math.min(latestHour ?? oldestHour, oldestHour + 95 * intervalMS)
    const requestedEnd = request.chartEndHour
    const hasFixedHistoryBoundary = chart.candleState === 'exhausted' || marketService.isHistoryExhausted(request.chartInstId)
    const endHour = requestedEnd === undefined || minimumEnd === null || latestHour === null
      ? undefined
      : hasFixedHistoryBoundary ? Math.max(minimumEnd, Math.min(latestHour, requestedEnd)) : requestedEnd
    return {
      bars, error: '', revision: chart.revision ?? marketService.revision, timeframe, oldestHour,
      endHour, historyExhausted: requestedEnd !== undefined && minimumEnd !== null && requestedEnd <= minimumEnd && hasFixedHistoryBoundary,
      candleState: chart.candleState, missingCandleRanges: chart.missingCandleRanges, candleRetryAt: chart.candleRetryAt,
      statisticsState: chart.statisticsState, statisticsRetryAt: chart.statisticsRetryAt,
    }
  }
  if ('gatewayFetch' in request) return gatewayFetch(event, request.gatewayFetch)
  if ('cancelGatewayFetch' in request) { gatewayRequests.get(request.cancelGatewayFetch)?.abort(); return { ok: true } }
  if ('copyText' in request) { clipboard.writeText(String(request.copyText)); return { ok: true } }
  if ('captureChart' in request) {
    const { x, y, width, height, output } = request.captureChart
    const image = await event.sender.capturePage({ x, y, width, height })
    if (output === 'png') return { imageDataURL: `data:image/png;base64,${image.toPNG().toString('base64')}`, width: image.getSize().width, height: image.getSize().height }
    clipboard.writeImage(image); return { ok: true }
  }
  if ('analysisSettings' in request) {
    const current = await settings()
    const action = request.analysisSettings
    if (action.action === 'save') {
      await saveSettings({ analysis: { model: action.model, apiKey: action.apiKey } })
      return { model: action.model, hasAPIKey: Boolean(action.apiKey) }
    }
    if (action.action === 'removeKey') {
      await saveSettings({ analysis: { model: current.analysis?.model ?? '', apiKey: '' } })
      return { model: current.analysis?.model ?? '', hasAPIKey: false }
    }
    return { model: current.analysis?.model ?? '', hasAPIKey: Boolean(current.analysis?.apiKey) }
  }
  if ('windowTintRGB' in request || 'previewWindowBlur' in request) return { ok: true }
  const keys = Object.keys(request)
  if (keys.some(key => key in defaults || key === 'filterLibraryPreferencesJSON')) {
    await saveSettings(request)
    if ('hourlyVolumeStabilityEnabled' in request) marketService?.invalidate()
    return snapshot()
  }
  return unsupported(request)
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 400, minHeight: 300,
    title: 'Perpetual Swap Suite',
    backgroundColor: '#101114',
    show: !testMode,
    webPreferences: { preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (rendererURL) await window.loadURL(rendererURL)
  else await window.loadFile(join(root, 'dist', 'index.html'))
  window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(async () => {
  if (process.env.PERPETUAL_SWAP_USER_DATA) app.setPath('userData', process.env.PERPETUAL_SWAP_USER_DATA)
  marketStore = await MarketStore.open(join(app.getPath('userData'), 'MarketData'))
  marketService = new MarketService(
    marketStore,
    () => ({ hourlyVolumeStabilityEnabled: settingsCache.hourlyVolumeStabilityEnabled }),
    testMode ? offlineE2EFetch : fetch,
    !testMode,
  )
  ipcMain.handle('radar:request', handleRequest)
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})
app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  ipcMain.removeHandler('radar:request')
  void (async () => {
    try {
      await marketService?.dispose()
      await marketStore?.close()
    } finally {
      shutdownComplete = true
      app.quit()
    }
  })()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
