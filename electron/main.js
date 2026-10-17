import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChartFocus } from './services/chart-focus.js'
import { seedCachedListProjection, seedChartScrollBenchmark } from './e2e-fixtures.js'
import { MarketStore } from './services/market-store.js'
import { MarketService } from './services/market-service.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
const e2eLiveRefresh = testMode && process.env.PERPETUAL_SWAP_E2E_LIVE_REFRESH === '1'
const e2ePreviewDelayMS = testMode
  ? Math.min(30_000, Math.max(0, Number(process.env.PERPETUAL_SWAP_E2E_PREVIEW_DELAY_MS) || 0))
  : 0
const FIVE_MINUTES = 300_000
const HOUR = 3_600_000
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let window
let marketStore
let marketService
let lastSnapshotTimeframe = '1H'
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

// This test-only fetcher keeps discovery in flight long enough to assert the
// real startup ordering: cache restoration must render before an online scan
// settles. It is deliberately opt-in so ordinary deterministic E2E fixtures
// remain isolated from background network activity.
const delayedOfflineE2EFetch = async (_input, init = {}) => {
  const signal = init.signal
  await new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('The request was aborted.', 'AbortError')); return }
    const timer = setTimeout(resolve, 10_000)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('The request was aborted.', 'AbortError'))
    }, { once: true })
  })
  return offlineE2EFetch()
}

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

async function snapshot(timeframe) {
  const frame = ['5m', '15m', '1H'].includes(timeframe) ? timeframe : lastSnapshotTimeframe
  lastSnapshotTimeframe = frame
  const saved = await settings()
  const market = marketService ? await marketService.snapshot(frame) : { rows: [], revision: 0, error: 'Loading OKX market data…', loading: true, updatedAt: null, listProgress: { total: 0, completed: 0, pending: 0, retrying: 0, unavailable: 0 }, timeframe: frame, catalogSource: 'none' }
  return {
    ...saved, rows: market.rows, updatedAt: market.updatedAt, error: market.error, revision: market.revision, timeframe: market.timeframe,
    listProgress: market.listProgress, loading: market.loading, catalogSource: market.catalogSource,
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
  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }
  const ticker = { instId, last: '135', open24h: '130', low24h: '99', high24h: '136', bidPx: '134.99', askPx: '135', volCcy24h: '300000' }
  const result = { eligible: true, turnover: 40_000_000, oiUSD: 6_000_000, spread: 0.01 }
  marketService.replaceCatalog([{ instrument, ticker, result, change24h: 3.8 }])
  // The source fixture is already complete; keep the latest-candle fetcher
  // out of this test so no live response can replace its deliberate gaps.
  marketService.lastCandleHydration.set(instId, Date.now())
  await marketService.ensureListTimeframe(timeframe)
  await marketService.projectListEntry(instId, timeframe)
  marketService.error = ''
  marketService.lastRefreshAt = Date.now()
  marketService.markChartDataChanged(instId)
  return { instId, timeframe, end, start: end - (visibleBars - 1) * HOUR, visibleBars, oiSamples: partialSamples, takerSamples: partialSamples }
}

function unsupported(request) {
  const operation = Object.keys(request).find(key => !['copyText', 'captureChart', 'analysisSettings', 'windowTintRGB', 'previewWindowBlur'].includes(key)) ?? 'request'
  throw new Error(`Electron data service does not yet implement “${operation}”. Configure the DuckDB/Parquet service before using market data.`)
}

function chartStatisticsStatusResponse(instId, timeframe, end) {
  return {
    // ChartSeriesStore treats an empty authoritative response as a status
    // update and retains the already-rendered bars. This keeps 80ms source
    // progress polling off the DuckDB/indicator/IPC hot path.
    bars: [], error: '', revision: marketService.dataRevision(instId), timeframe,
    ...marketService.chartCandleStatus(instId, timeframe, end),
    ...marketService.chartStatisticsStatus(instId, timeframe, end),
    statusAuthoritative: true,
  }
}

async function handleRequest(event, request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid desktop bridge request.')
  if ('e2e' in request) {
    if (!testMode) throw new Error('The E2E desktop API is unavailable outside tests.')
    if (request.e2e.action === 'seedCandles') return { written: await marketStore.appendCandles(request.e2e.candles ?? []) }
    if (request.e2e.action === 'seedCachedListProjection') return seedCachedListProjection(marketStore, marketService)
    if (request.e2e.action === 'seedPartialStatisticsChart') return seedPartialStatisticsChart()
    if (request.e2e.action === 'seedChartScrollBenchmark') return seedChartScrollBenchmark(marketStore, marketService)
    if (request.e2e.action === 'settings') return settings()
    throw new Error('Unknown E2E desktop action.')
  }
  if ('suite' in request) {
    return { profiles: [], selectedID: '', confirmed: [], provisional: [], rows: [], revision: 0, timeframe: request.suite.timeframe }
  }
  if ('research' in request) return { studies: [], job: null, ok: true }
  if ('foregroundWorkspace' in request) return { ok: true }
  if ('rocPeriod' in request) return snapshot(request.timeframe)
  if ('compileMarketFilters' in request) {
    const source = request.compileMarketFilters
    const configJSON = source.filtersJSON ?? source.previousJSON ?? ''
    return { diagnostics: configJSON ? [] : ['A rule configuration is required.'], configJSON, expressions: {}, units: {}, requiredHours: 0 }
  }
  if ('previewMarketFilters' in request) return { ...(await snapshot(request.previewMarketFilters.timeframe)), filterToken: request.previewMarketFilters.token, filterResults: {}, historyProgress: { pending: 0, completed: 0, error: '' } }
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
    // Chart data revisions are per instrument: an unrelated contract's write
    // must not force this chart to refetch.
    if (!request.preview && !focused.ok) return { unchanged: true, error: '', revision: marketService.dataRevision(request.chartInstId) }
    if (!request.preview && request.chartStatusOnly && Number.isFinite(request.chartEndHour)) {
      return chartStatisticsStatusResponse(request.chartInstId, timeframe, request.chartEndHour)
    }
    if (request.chartEndHour === undefined && request.sinceRevision === marketService.dataRevision(request.chartInstId) && marketService.isActiveChartViewport(request.chartInstId, timeframe, undefined)) {
      const activeEnd = marketService.activeChartViewport?.end
      if (Number.isFinite(activeEnd)) return chartStatisticsStatusResponse(request.chartInstId, timeframe, activeEnd)
      return { unchanged: true, error: '', revision: marketService.dataRevision(request.chartInstId) }
    }
    // Neighbor previews may read the local cache, but must never enqueue
    // hydration, gap repair, or OI/Taker work ahead of the visible chart.
    // A history preview is normally satisfied from the local store in a few
    // milliseconds. The scroll regression needs to model a late response.
    // Once the cursor stops at the floor, its foreground catch-up request
    // follows the preview after a debounce, so delay both replies together.
    // This branch is impossible outside the explicit Electron E2E mode.
    if (e2ePreviewDelayMS && request.chartEndHour !== undefined) {
      await new Promise(resolve => setTimeout(resolve, e2ePreviewDelayMS))
    }
    const chart = await marketService.bars(request.chartInstId, timeframe, request.chartEndHour, focused.ok ? { foreground: true, focusToken: focused.sequence } : { hydrate: false, repair: false, statistics: false })
    if (chart.stale) return { unchanged: true, error: '', revision: marketService.dataRevision(request.chartInstId) }
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
      bars, error: '', revision: chart.revision ?? marketService.dataRevision(request.chartInstId), timeframe, oldestHour,
      endHour, historyExhausted: requestedEnd !== undefined && minimumEnd !== null && requestedEnd <= minimumEnd && hasFixedHistoryBoundary,
      candleState: chart.candleState, missingCandleRanges: chart.missingCandleRanges, candleRetryAt: chart.candleRetryAt,
      statisticsState: chart.statisticsState, statisticsRetryAt: chart.statisticsRetryAt, oiState: chart.oiState, takerState: chart.takerState, statisticsEnd: chart.statisticsEnd,
      // Preview reads are cache-only and cannot observe foreground work. The
      // renderer may merge their bars, but must retain its active loading or
      // retry status rather than accept these default-ready fields.
      statusAuthoritative: !request.preview,
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
  // Discovery begins before the renderer's first snapshot, so hydrate the
  // persisted liquidity criteria before it decides which contracts belong in
  // the catalogue.
  await settings()
  marketStore = await MarketStore.open(join(app.getPath('userData'), 'MarketData'))
  marketService = new MarketService(
    marketStore,
    () => ({ hourlyVolumeStabilityEnabled: settingsCache.hourlyVolumeStabilityEnabled }),
    testMode ? e2eLiveRefresh ? delayedOfflineE2EFetch : offlineE2EFetch : fetch,
    !testMode,
  )
  ipcMain.handle('radar:request', handleRequest)
  await marketService.restoreCatalog()
  if (!testMode || e2eLiveRefresh) void marketService.refresh()
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
