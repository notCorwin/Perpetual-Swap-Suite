import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MarketStore } from './services/market-store.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let window
let marketStore
const gatewayRequests = new Map()

const defaults = {
  windowBlurRadius: 64,
  floatingBlurRadius: 64,
  frostedBackgroundEnabled: true,
  frostedBackgroundOpacity: 0.3,
  backgroundMonitoringEnabled: false,
  notificationsEnabled: false,
  monitoringPaused: false,
  chartMoveLabelsVisible: true,
  chartMoveEfficiencyFactor: 1,
}

async function settings() {
  try { return { ...defaults, ...JSON.parse(await readFile(settingsFile(), 'utf8')) } }
  catch { return { ...defaults } }
}

async function saveSettings(value) {
  const next = { ...(await settings()), ...value }
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
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
  throw new Error(`Electron data service does not yet implement “${operation}”. Configure the DuckDB/Parquet service before using market data.`)
}

async function handleRequest(event, request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid desktop bridge request.')
  if ('e2e' in request) {
    if (!testMode) throw new Error('The E2E desktop API is unavailable outside tests.')
    if (request.e2e.action === 'seedCandles') return { written: await marketStore.appendCandles(request.e2e.candles ?? []) }
    if (request.e2e.action === 'settings') return settings()
    throw new Error('Unknown E2E desktop action.')
  }
  if ('chartInstId' in request) {
    const timeframe = request.timeframe ?? '1H'
    const candles = await marketStore.candles({ instrument: request.chartInstId, timeframe })
    return { bars: candles.map(candle => ({ hour: candle.timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close, confirmed: Boolean(candle.confirmed), vwap: null, ema: null, logBBUpper: null, logBBMiddle: null, logBBLower: null, roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, oi: null, buy: null, sell: null })), error: '', revision: 0, timeframe, historyExhausted: true }
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
    const next = await saveSettings(request)
    return { ...next, rows: [], updatedAt: null, error: '', revision: 0, filterMetricsCatalog: [], filterFunctions: [], filterFunctionCatalog: [], filterLibraryPreferences: { collapsedGroups: [] } }
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
  ipcMain.handle('radar:request', handleRequest)
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})
app.on('before-quit', () => { void marketStore?.close() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
