import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedCachedListProjection, seedChartScrollBenchmark, seedHistoricalStatisticsBoundary, seedInstrumentNavigationBenchmark } from './e2e-fixtures.js'
import { MarketStore } from './services/market-store.js'
import { MarketService } from './services/market-service.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
if (process.env.PERPETUAL_SWAP_USER_DATA) {
  const userData = process.env.PERPETUAL_SWAP_USER_DATA
  const sessionData = join(userData, 'Session')
  mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', sessionData)
}
const e2eLiveRefresh = testMode && process.env.PERPETUAL_SWAP_E2E_LIVE_REFRESH === '1'
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let window
let marketStore
let marketService
let lastSnapshotTimeframe = '1H'
const gatewayRequests = new Map()
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

async function snapshot(timeframe) {
  const frame = ['5m', '15m', '1H'].includes(timeframe) ? timeframe : lastSnapshotTimeframe
  lastSnapshotTimeframe = frame
  const saved = await settings()
  const market = marketService ? await marketService.snapshot(frame) : { rows: [], revision: 0, error: 'Loading OKX market data…', loading: true, updatedAt: null, listProgress: { total: 0, completed: 0, pending: 0, retrying: 0, unavailable: 0 }, timeframe: frame, catalogSource: 'none' }
  return {
    ...Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key]])),
    rows: market.rows, updatedAt: market.updatedAt, error: market.error, revision: market.revision, timeframe: market.timeframe,
    listProgress: market.listProgress, loading: market.loading, catalogSource: market.catalogSource,
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

function unsupported(request) {
  const operation = Object.keys(request).find(key => !['copyText', 'captureChart', 'analysisSettings', 'windowTintRGB', 'previewWindowBlur'].includes(key)) ?? 'request'
  throw new Error(`Unsupported desktop bridge operation “${operation}”.`)
}

async function handleRequest(event, request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid desktop bridge request.')
  if ('e2e' in request) {
    if (!testMode) throw new Error('The E2E desktop API is unavailable outside tests.')
    if (request.e2e.action === 'smokeStatus') {
      const build = await readFile(join(process.resourcesPath, 'build-revision.json'), 'utf8').then(JSON.parse).catch(() => null)
      return { revision: build?.revision ?? null, userData: app.getPath('userData'), preparedWorkerThreadId: marketService?.preparedCharts.worker?.threadId ?? null }
    }
    if (request.e2e.action === 'seedCandles') return { written: await marketStore.appendCandles(request.e2e.candles ?? []) }
    if (request.e2e.action === 'readCandles') {
      const { instrument, timeframe, from, through } = request.e2e
      return marketStore.candles({ instrument, timeframe, from, through })
    }
    if (request.e2e.action === 'seedCachedListProjection') return seedCachedListProjection(marketStore, marketService)
    if (request.e2e.action === 'seedChartScrollBenchmark') return seedChartScrollBenchmark(marketStore, marketService)
    if (request.e2e.action === 'seedHistoricalStatisticsBoundary') return seedHistoricalStatisticsBoundary(marketStore, marketService)
    if (request.e2e.action === 'seedInstrumentNavigationBenchmark') return seedInstrumentNavigationBenchmark(marketStore, marketService)
    if (request.e2e.action === 'settings') return settings()
    throw new Error('Unknown E2E desktop action.')
  }
  if ('rocPeriod' in request) return snapshot(request.timeframe)
  if ('chartWindow' in request) {
    const { instId, timeframe, endHour } = request.chartWindow ?? {}
    if (typeof instId !== 'string' || !['5m', '15m', '1H'].includes(timeframe)
      || endHour !== undefined && !Number.isSafeInteger(endHour)) throw new Error('Invalid chart window request.')
    return marketService.prepareChartWindow(instId, timeframe, endHour)
  }
  if ('chartLocal' in request) {
    const { instId, timeframe } = request.chartLocal ?? {}
    if (typeof instId !== 'string' || !['5m', '15m', '1H'].includes(timeframe)) throw new Error('Invalid local chart request.')
    return marketService.localChartWindow(instId, timeframe)
  }
  if ('chartUniverse' in request) {
    const { instIds, timeframe, focusInstId } = request.chartUniverse ?? {}
    if (!Array.isArray(instIds) || instIds.length > 1_000 || instIds.some(id => typeof id !== 'string')
      || !['5m', '15m', '1H'].includes(timeframe)
      || focusInstId !== undefined && typeof focusInstId !== 'string') throw new Error('Invalid chart navigation universe.')
    return marketService.setChartUniverse(instIds, timeframe, focusInstId)
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
  if (keys.length && keys.every(key => Object.hasOwn(defaults, key))) {
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
  marketService.subscribePreparedCharts(frame => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('radar:chart-prepared', frame)
  })
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
