import { app, BrowserWindow, clipboard, contentTracing, ipcMain, net, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseDesktopRequest } from './desktop-contract.js'
import { createDesktopSecurity } from './desktop-security.js'
import { assertBackgroundTestLaunch, testPresentation, testWindowOptions } from './test-presentation.js'
import { startTestOwnerWatchdog } from './test-owner.js'
import { initializeOperationRecording, closeOperationRecording, closeExternalOperationSource } from './services/operation-runtime.js'
import { startGraphicsRecording } from './services/operation-graphics.js'
import { beginOperation, measureOperation, recordOperation, runWithOperationContext, withOperationSuppressed } from './services/operations.js'
import { createRendererOperationReceiver } from './services/renderer-operations.js'
import { createOperationSession, enforceOperationRetention } from './services/operation-retention.js'
import { installElectronOperationHooks } from './services/operation-hooks.js'
import { MarketBackend } from './services/market-backend.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const rendererURL = process.env.ELECTRON_RENDERER_URL || undefined
const testMode = process.env.PERPETUAL_SWAP_E2E === '1'
const testLaunchParentPID = process.ppid
const backgroundTests = testPresentation() === 'background'
if (backgroundTests) assertBackgroundTestLaunch()
if (backgroundTests && process.platform === 'darwin') app.setActivationPolicy('prohibited')
// Chromium initializes its profile during ready. Isolate both locations first.
if (process.env.PERPETUAL_SWAP_USER_DATA) {
  const userData = process.env.PERPETUAL_SWAP_USER_DATA
  const sessionData = join(userData, 'Session')
  mkdirSync(sessionData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', sessionData)
}
const operationSessionRoot = join(app.getPath('userData'), 'Operations')
const operationSession = !process.env.PERPETUAL_SWAP_OPERATION_DIR
  ? await withOperationSuppressed(() => createOperationSession({ root: operationSessionRoot })) : undefined
if (operationSession) process.env.PERPETUAL_SWAP_OPERATION_DIR = operationSession.directory
let retentionTask = Promise.resolve()
const maintainOperationRetention = () => {
  if (!operationSession) return retentionTask
  retentionTask = retentionTask.catch(() => {}).then(() => withOperationSuppressed(async () => {
    await operationSession.heartbeat()
    return enforceOperationRetention(operationSessionRoot)
  })).catch(error => { console.error('Operation retention failed:', error.message) })
  return retentionTask
}
await maintainOperationRetention()
const operationRecording = initializeOperationRecording({ label: 'electron-main' })
const retentionTimer = operationSession ? setInterval(maintainOperationRetention, 60_000) : undefined
retentionTimer?.unref()
const rendererOperations = createRendererOperationReceiver()
let stopGraphicsRecording
const security = createDesktopSecurity({ rendererURL, rendererFile: join(root, 'dist', 'index.html') })
const e2eLiveRefresh = testMode && process.env.PERPETUAL_SWAP_E2E_LIVE_REFRESH === '1'
let window
let backend
const gatewayRequests = new Map()
const desktopRequests = new Set()
let shuttingDown = false
let shutdownComplete = false
let startupTask = Promise.resolve()
let stopTestOwner = () => {}
let testOwnerExitTimer


function sendGateway(event, detail) {
  if (!shuttingDown && !event.sender.isDestroyed()) sendNotification(event.sender, 'radar:gateway-stream', detail)
}

function sendNotification(sender, channel, detail) {
  const operation = beginOperation({ category: 'ipc', name: 'desktop.notification.send', resource: channel })
  try { operation.run(() => sender.send(channel, detail, operation.context)) }
  finally { operation.end() }
}

function drainRendererOperations(target) {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return Promise.resolve()
  const sender = target.webContents
  if (!rendererOperations.sourcesFor(sender.id).length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const finish = error => {
      clearTimeout(timer); ipcMain.off('radar:operations-drained', acknowledged)
      if (error) { rendererOperations.markIncomplete(sender.id, error.message); reject(error) }
      else resolve()
    }
    const acknowledged = (event, value) => {
      try { security.assertTrustedSender(event, target) } catch { return }
      if (value?.id === id) finish(value.ok ? undefined : new Error('Renderer operation drain failed.'))
    }
    const timer = setTimeout(() => finish(new Error('Renderer operation drain timed out.')), 5_000)
    ipcMain.on('radar:operations-drained', acknowledged)
    sender.send('radar:operations-drain', { id })
  })
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
    operation = beginOperation({ category: 'ipc', name: 'gateway.stream', resource: 'https://ai-gateway.vercel.sh/v1/chat/completions', attributes: { method: 'POST', sentBytes: Buffer.byteLength(body) } })
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

async function handleRequest(event, payload, context) {
  security.assertTrustedSender(event, window)
  const request = parseDesktopRequest(payload, { allowE2E: testMode })
  if (shuttingDown) throw new Error('The application is closing.')
  const task = runWithOperationContext(context, () => measureOperation({ category: 'ipc', name: 'desktop.request.execute', resource: Object.keys(request)[0] }, async () => {
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
  }))
  desktopRequests.add(task)
  task.then(() => desktopRequests.delete(task), () => desktopRequests.delete(task))
  return task
}

async function createWindow() {
  if (shuttingDown || window && !window.isDestroyed()) return
  window = new BrowserWindow({
    ...testWindowOptions(backgroundTests),
    frame: false,
    width: 1600, height: 1000, minWidth: 400, minHeight: 300,
    title: 'Perpetual Swap Suite', backgroundColor: '#101114', show: !testMode && !backgroundTests,
    webPreferences: { ...testWindowOptions(backgroundTests).webPreferences,
      preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.on('will-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-redirect', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-frame-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererOperations.markIncomplete(window.webContents.id, `renderer-${details.reason}`)
    recordOperation({ category: 'cpu', name: 'renderer.interrupted', startedAt: Date.now(), durationMS: 0, status: 'error',
      attributes: { incomplete: true, execution: 'renderer', reason: details.reason } })
  })
  let allowClose = false, closing = false
  const target = window
  target.on('close', event => {
    if (allowClose || shuttingDown) return
    event.preventDefault()
    if (closing) return
    closing = true
    void drainRendererOperations(target).catch(error => console.error('Renderer operation shutdown failed:', error)).then(async () => {
      for (const executionId of rendererOperations.sourcesFor(target.webContents.id)) await closeExternalOperationSource(executionId)
    }).catch(error => console.error('Renderer operation source close failed:', error)).finally(() => { allowClose = true; if (!target.isDestroyed()) target.close() })
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
    if (!shuttingDown && window && !window.isDestroyed() && !window.webContents.isDestroyed()) sendNotification(window.webContents, channel, value)
  }
  backend.on('chart', frame => send('radar:chart-prepared', frame))
  backend.on('market', () => send('radar:market-changed'))
  backend.on('audit', report => send('radar:audit-changed', report))
  backend.on('history-download', report => send('radar:history-download-changed', report))
  backend.on('failure', error => { console.error('Market backend failed:', error); send('radar:market-changed') })
  ipcMain.handle('radar:request', handleRequest)
  ipcMain.handle('radar:operations-initialize', (event, value) => {
    security.assertTrustedSender(event, window)
    return rendererOperations.initialize(event.sender.id, value?.nonce)
  })
  ipcMain.handle('radar:operations', (event, batch) => {
    security.assertTrustedSender(event, window)
    return rendererOperations.receive(event.sender.id, batch)
  })
  ipcMain.handle('radar:operations-failure', (event, value) => {
    security.assertTrustedSender(event, window)
    rendererOperations.fail(event.sender.id, value)
  })
  // Windows and input become available while data restores in its own worker.
  await createWindow()
}

app.whenReady().then(() => {
  if (operationRecording) {
    installElectronOperationHooks({ app, net, session })
    void operationRecording.flush().catch(error => console.error('Operation hook checkpoint failed:', error.message))
  }
  if (testMode || process.env.PERPETUAL_SWAP_SANDBOX === '1' || process.env.PERPETUAL_SWAP_TEST_UI !== undefined) {
    stopTestOwner = startTestOwnerWatchdog({ parentPID: testLaunchParentPID, onOwnerLost: () => {
      app.quit()
      testOwnerExitTimer = setTimeout(() => app.exit(1), 10_000)
      testOwnerExitTimer.unref()
    } })
  }
  if (!shuttingDown) startupTask = startDesktop()
  return startupTask
}).catch(error => { console.error('Desktop startup failed:', error); app.quit() })
app.once('will-quit', () => { stopTestOwner(); clearTimeout(testOwnerExitTimer) })
app.on('activate', () => {
  if (!backgroundTests && app.isReady() && !shuttingDown && BrowserWindow.getAllWindows().length === 0) void startupTask.then(createWindow).catch(error => console.error('Could not open application window:', error))
})
app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  ipcMain.removeHandler('radar:request')
  void (async () => {
    let recordingComplete = false
    try {
      for (const { controller } of gatewayRequests.values()) controller.abort()
      await Promise.allSettled([...gatewayRequests.values()].map(value => value.finished))
      await startupTask.catch(error => console.error('Desktop startup did not complete:', error))
      try { await backend?.dispose() }
      catch (error) { console.error('Market backend shutdown failed:', error) }
      await Promise.allSettled([...desktopRequests])
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        await drainRendererOperations(window).catch(error => console.error('Renderer operation shutdown failed:', error))
      }
      await stopGraphicsRecording?.()
      await closeOperationRecording()
      recordingComplete = true
    } catch (error) { console.error('Desktop shutdown failed:', error) }
    finally {
      clearInterval(retentionTimer)
      if (operationSession) {
        try {
          await retentionTask
          await withOperationSuppressed(async () => {
            await operationSession.close({ complete: recordingComplete })
            await enforceOperationRetention(operationSessionRoot)
          })
        } catch (error) { console.error('Operation session did not close cleanly:', error.message) }
      }
      shutdownComplete = true; app.quit()
    }
  })()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
