import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from 'electron'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let window
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
    webPreferences: { preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (rendererURL) await window.loadURL(rendererURL)
  else await window.loadFile(join(root, 'dist', 'index.html'))
  window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(async () => {
  ipcMain.handle('radar:request', handleRequest)
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
