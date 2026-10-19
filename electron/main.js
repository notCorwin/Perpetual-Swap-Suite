import { app, BrowserWindow, clipboard, contentTracing, ipcMain, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDesktopRequest } from './desktop-contract.js'
import { createDesktopSecurity } from './desktop-security.js'
import { initializeOperationRecording, closeOperationRecording } from './services/operation-runtime.js'
import { startGraphicsRecording } from './services/operation-graphics.js'
import { beginOperation, measureOperation, recordOperation } from './services/operations.js'
import { MarketBackend } from './services/market-backend.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL || undefined
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
// Chromium initializes its profile during ready. Isolate both locations first.
if (process.env.PERPETUAL_SWAP_USER_DATA) {
  const userData = process.env.PERPETUAL_SWAP_USER_DATA
  const sessionData = join(userData, 'Session')
  mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', sessionData)
}
if (!process.env.PERPETUAL_SWAP_OPERATION_DIR) {
  process.env.PERPETUAL_SWAP_OPERATION_DIR = join(app.getPath('userData'), 'Operations', `${Date.now()}-${process.pid}`)
}
const operationRecording = initializeOperationRecording({ label: 'electron-main' })
let stopGraphicsRecording
const security = createDesktopSecurity({ rendererURL, rendererFile: join(root, 'dist', 'index.html') })
const e2eLiveRefresh = testMode && process.env.PERPETUAL_SWAP_E2E_LIVE_REFRESH === '1'
let window
let backend
const gatewayRequests = new Map()
let shuttingDown = false
let shutdownComplete = false
let startupTask = Promise.resolve()


function sendGateway(event, detail) {
  if (!shuttingDown && !event.sender.isDestroyed()) event.sender.send('radar:gateway-stream', detail)
}

async function gatewayFetch(event, { id, body }) {
  if (gatewayRequests.has(id)) throw new Error('A Gateway request with this ID is already running.')
  const controller = new AbortController()
  let operation, receivedBytes = 0, httpStatus
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const owner = event.sender
  const abort = () => controller.abort()
  const navigation = details => { if (details.isMainFrame && !details.isSameDocument) abort() }
  owner.once('destroyed', abort)
  owner.on('did-start-navigation', navigation)
  gatewayRequests.set(id, { controller, finished })
  const release = () => {
    owner.removeListener('destroyed', abort)
    owner.removeListener('did-start-navigation', navigation)
    gatewayRequests.delete(id)
    finish()
  }
  try {
    const apiKey = await backend.credentials()
    controller.signal.throwIfAborted()
    if (!apiKey) throw new Error('Save an AI Gateway API key in Configure analysis before starting analysis.')
    operation = beginOperation({ category: 'network', name: 'gateway.stream', resource: 'https://ai-gateway.vercel.sh/v1/chat/completions', attributes: { method: 'POST', sentBytes: Buffer.byteLength(body) } })
    const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body, signal: controller.signal,
    })
    httpStatus = response.status
    if (response.body) {
      void (async () => {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            receivedBytes += value.byteLength
            sendGateway(event, { id, type: 'data', base64: Buffer.from(value).toString('base64') })
          }
          operation.end({ status: response.ok ? 'ok' : 'error', attributes: { receivedBytes, httpStatus } })
          sendGateway(event, { id, type: 'end' })
        } catch (error) {
          operation.end({ status: controller.signal.aborted ? 'cancelled' : 'error', attributes: { receivedBytes, httpStatus, errorName: error.name } })
          if (!controller.signal.aborted) sendGateway(event, { id, type: 'error', message: error instanceof Error ? error.message : 'Gateway stream interrupted.' })
        } finally { reader.releaseLock(); release() }
      })()
    } else { operation.end({ status: response.ok ? 'ok' : 'error', attributes: { receivedBytes, httpStatus } }); release() }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()) }
  } catch (error) { operation?.end({ status: controller.signal.aborted ? 'cancelled' : 'error', attributes: { receivedBytes, errorName: error.name } }); release(); throw error }
}

async function handleRequest(event, payload) {
  security.assertTrustedSender(event, window)
  const request = parseDesktopRequest(payload, { allowE2E: testMode })
  if (shuttingDown) throw new Error('The application is closing.')
  if (request.gatewayFetch) return gatewayFetch(event, request.gatewayFetch)
  if (request.cancelGatewayFetch) { gatewayRequests.get(request.cancelGatewayFetch)?.controller.abort(); return { ok: true } }
  if ('copyText' in request) { clipboard.writeText(request.copyText); return { ok: true } }
  if (request.captureChart) {
    const { x, y, width, height, output } = request.captureChart
    const image = await measureOperation({ category: 'gpu', name: 'chart.capture', attributes: { measurement: 'submission-wall', width, height } }, () => event.sender.capturePage({ x: Math.floor(x), y: Math.floor(y), width: Math.ceil(x + width) - Math.floor(x), height: Math.ceil(y + height) - Math.floor(y) }))
    if (output === 'png') return { imageDataURL: `data:image/png;base64,${measureOperation({ category: 'cpu', name: 'chart.encode-png' }, () => image.toPNG()).toString('base64')}`, ...image.getSize() }
    clipboard.writeImage(image)
    return { ok: true }
  }
  const response = await backend.request(request)
  if (request.e2e?.action === 'smokeStatus') {
    const build = await readFile(join(process.resourcesPath, 'build-revision.json'), 'utf8').then(JSON.parse).catch(() => null)
    return { ...response, revision: build?.revision ?? null }
  }
  return response
}

async function createWindow() {
  if (shuttingDown || window && !window.isDestroyed()) return
  window = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 400, minHeight: 300,
    title: 'Perpetual Swap Suite', backgroundColor: '#101114', show: !testMode,
    webPreferences: { preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.on('will-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-redirect', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-frame-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('render-process-gone', (_event, details) => {
    recordOperation({ category: 'cpu', name: 'renderer.interrupted', startedAt: Date.now(), durationMS: 0, status: 'error',
      attributes: { incomplete: true, execution: 'renderer', reason: details.reason } })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (security.isAllowedExternalURL(url)) void shell.openExternal(url).catch(error => console.error('Could not open external link:', error))
    return { action: 'deny' }
  })
  if (rendererURL) await window.loadURL(rendererURL)
  else await window.loadFile(join(root, 'dist', 'index.html'))
}

async function startDesktop() {
  stopGraphicsRecording = await startGraphicsRecording(app, contentTracing, operationRecording.directory)
  backend = new MarketBackend({ userData: app.getPath('userData'), testMode, e2eLiveRefresh })
  if (testMode) globalThis.__marketBackend = backend
  const send = (channel, value) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value)
  }
  backend.on('chart', frame => send('radar:chart-prepared', frame))
  backend.on('market', () => send('radar:market-changed'))
  backend.on('audit', report => send('radar:audit-changed', report))
  backend.on('failure', error => { console.error('Market backend failed:', error); send('radar:market-changed') })
  ipcMain.handle('radar:request', handleRequest)
  ipcMain.on('radar:operations', (event, entries) => {
    try { security.assertTrustedSender(event, window) } catch { return }
    if (!Array.isArray(entries) || entries.length > 128) return
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !['cpu', 'gpu'].includes(entry.category)
        || typeof entry.name !== 'string' || !['renderer.', 'chart.', 'diagnostics.renderer.'].some(prefix => entry.name.startsWith(prefix))) continue
      recordOperation({ ...entry, attributes: { ...entry.attributes, execution: 'renderer' } })
    }
  })
  // Windows and input become available while data restores in its own worker.
  await createWindow()
}

app.whenReady().then(() => {
  if (!shuttingDown) startupTask = startDesktop()
  return startupTask
}).catch(error => { console.error('Desktop startup failed:', error); app.quit() })
app.on('activate', () => {
  if (app.isReady() && !shuttingDown && BrowserWindow.getAllWindows().length === 0) void startupTask.then(createWindow).catch(error => console.error('Could not open application window:', error))
})
app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  ipcMain.removeHandler('radar:request')
  void (async () => {
    try {
      for (const { controller } of gatewayRequests.values()) controller.abort()
      await Promise.allSettled([...gatewayRequests.values()].map(value => value.finished))
      await startupTask.catch(error => console.error('Desktop startup did not complete:', error))
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        await window.webContents.executeJavaScript("window.dispatchEvent(new Event('radar-operations-flush'))").catch(() => {})
      }
      await backend?.dispose()
      await stopGraphicsRecording?.()
      await closeOperationRecording()
    } catch (error) { console.error('Desktop shutdown failed:', error) }
    finally { shutdownComplete = true; app.quit() }
  })()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
