import { app, BrowserWindow, clipboard, ClipboardItem, contentTracing, ipcMain, nativeImage, net, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseDesktopRequest } from './desktop-contract.js'
import { encodeChartWire } from './chart-wire.js'
import { createDesktopSecurity } from './desktop-security.js'
import { assertBackgroundTestLaunch, testPresentation, testWindowOptions } from './test-presentation.js'
import { startTestOwnerWatchdog } from './test-owner.js'
import { initializeOperationRecording, closeOperationRecording, closeExternalOperationSource } from './services/operation-runtime.js'
import { graphicsRecordingRequested, startGraphicsRecording } from './services/operation-graphics.js'
import { beginOperation, measureOperation, recordOperation, runWithOperationContext, withOperationSuppressed } from './services/operations.js'
import { createRendererOperationReceiver } from './services/renderer-operations.js'
import { createOperationSession, enforceOperationRetention } from './services/operation-retention.js'
import { operationRecordingRequested } from './services/operation-policy.js'
import { installElectronOperationHooks } from './services/operation-hooks.js'
import { MarketBackend } from './services/market-backend.js'
import { windowToolbarLayout } from './window-layout.js'
import { PresentationLifecycle } from './services/presentation-lifecycle.js'
import { PresentationDelivery } from './services/presentation-delivery.js'

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
const recordGraphics = graphicsRecordingRequested()
const operationSessionRoot = join(app.getPath('userData'), 'Operations')
const operationSession = operationRecordingRequested() && !process.env.PERPETUAL_SWAP_OPERATION_DIR
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
const rendererOperations = operationRecording ? createRendererOperationReceiver() : undefined
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
let presentation
const windowNotifications = new Set()
const presentationDelivery = new PresentationDelivery({
  getState: () => presentation?.getState(),
  notify: sendNotification,
  isClosing: () => shuttingDown,
})

function publishPresentation(update) {
  if (!window || window.isDestroyed()) return
  presentationDelivery.publish(window.webContents, update)
}

function sendNotification(sender, channel, detail) {
  if (!presentation?.getState().active) return
  const epoch = presentation.getState().epoch
  if (!operationRecording) return sender.send(channel, channel === 'radar:chart-prepared' ? encodeChartWire(detail) : detail, undefined, epoch)
  const operation = beginOperation({ category: 'ipc', name: 'desktop.notification.send', resource: channel })
  try { operation.run(() => sender.send(channel, channel === 'radar:chart-prepared' ? encodeChartWire(detail) : detail, operation.context, epoch)) }
  finally { operation.end() }
}

function drainRendererOperations(target) {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return Promise.resolve()
  const sender = target.webContents
  if (!rendererOperations?.sourcesFor(sender.id).length) return Promise.resolve()
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
  const forget = () => { presentationDelivery.discard(id); abort() }
  const navigation = details => { if (details.isMainFrame && !details.isSameDocument) abort() }
  owner.once('destroyed', forget)
  owner.on('did-start-navigation', navigation)
  gatewayRequests.set(id, { controller, finished })
  const release = () => {
    owner.removeListener('destroyed', forget)
    owner.removeListener('did-start-navigation', navigation)
    gatewayRequests.delete(id)
    finish()
  }
  try {
    const apiKey = await backend.credentials()
    controller.signal.throwIfAborted()
    if (!apiKey) throw new Error('Save an AI Gateway API key in Configure analysis before starting analysis.')
    if (operationRecording) operation = beginOperation({ category: 'ipc', name: 'gateway.stream', resource: 'https://ai-gateway.vercel.sh/v1/chat/completions', attributes: { method: 'POST', sentBytes: Buffer.byteLength(body) } })
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
            presentationDelivery.chunk(owner, id, value)
          }
          operation?.end({ status: response.ok ? 'ok' : 'error', attributes: { receivedBytes, httpStatus } })
          presentationDelivery.terminal(owner, { id, type: 'end' })
        } catch (error) {
          operation?.end({ status: controller.signal.aborted ? 'cancelled' : 'error', attributes: { receivedBytes, httpStatus, errorName: error.name } })
          if (!controller.signal.aborted) presentationDelivery.terminal(owner, { id, type: 'error', message: error instanceof Error ? error.message : 'Gateway stream interrupted.' })
        } finally { reader.releaseLock(); release() }
      })()
    } else { operation?.end({ status: response.ok ? 'ok' : 'error', attributes: { receivedBytes, httpStatus } }); release() }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()) }
  } catch (error) { operation?.end({ status: controller.signal.aborted ? 'cancelled' : 'error', attributes: { receivedBytes, errorName: error.name } }); release(); throw error }
}

async function copyImage(image) {
  if (image.isEmpty()) throw new Error('Invalid chart image.')
  const png = measureOperation({ category: 'cpu', name: 'chart.encode-png' }, () => image.toPNG())
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
}

async function handleRequest(event, payload, context) {
  security.assertTrustedSender(event, window)
  const request = parseDesktopRequest(payload, { allowE2E: testMode })
  if (shuttingDown) throw new Error('The application is closing.')
  const displayRead = Boolean(request.snapshot || request.chartWindow || request.chartLocal || request.chartHistory || request.chartUniverse)
  const epoch = presentation.getState().epoch
  const assertPresentation = () => {
    if (displayRead && (!presentation.getState().active || epoch !== presentation.getState().epoch)) {
      throw Object.assign(new Error('The interface became idle or changed while its view was being read.'), { name: 'AbortError' })
    }
  }
  assertPresentation()
  const execute = async () => {
  if (request.gatewayFetch) return gatewayFetch(event, request.gatewayFetch)
  if (request.cancelGatewayFetch) { gatewayRequests.get(request.cancelGatewayFetch)?.controller.abort(); presentationDelivery.discard(request.cancelGatewayFetch); return { ok: true } }
  if ('copyText' in request) { await clipboard.writeText(request.copyText); return { ok: true } }
  if ('copyImage' in request) {
    const image = nativeImage.createFromDataURL(request.copyImage)
    await copyImage(image); return { ok: true }
  }
  if (request.captureChart) {
    const { x, y, width, height, output } = request.captureChart
    const image = await measureOperation({ category: 'gpu', name: 'chart.capture', attributes: { measurement: 'submission-wall', width, height } }, () => event.sender.capturePage({ x: Math.floor(x), y: Math.floor(y), width: Math.ceil(x + width) - Math.floor(x), height: Math.ceil(y + height) - Math.floor(y) }))
    if (output === 'png') return { imageDataURL: `data:image/png;base64,${measureOperation({ category: 'cpu', name: 'chart.encode-png' }, () => image.toPNG()).toString('base64')}`, ...image.getSize() }
    await copyImage(image)
    return { ok: true }
  }
  const response = await backend.request(request)
  assertPresentation()
  if (request.e2e?.action === 'smokeStatus') {
    const build = await readFile(join(process.resourcesPath, 'build-revision.json'), 'utf8').then(JSON.parse).catch(() => null)
    return { ...response, revision: build?.revision ?? null }
  }
  return request.chartWindow || request.chartLocal || request.chartHistory || request.chartUniverse ? encodeChartWire(response) : response
  }
  const task = operationRecording
    ? runWithOperationContext(context, () => measureOperation({ category: 'ipc', name: 'desktop.request.execute', resource: Object.keys(request)[0] }, execute))
    : execute()
  desktopRequests.add(task)
  task.then(() => desktopRequests.delete(task), () => desktopRequests.delete(task))
  return task
}

async function createWindow() {
  if (shuttingDown || window && !window.isDestroyed()) return
  window = new BrowserWindow({
    ...testWindowOptions(backgroundTests),
    frame: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: windowToolbarLayout(1600, true).buttonsPosition } : {}),
    width: 1600, height: 1000, minWidth: 1200, minHeight: 640,
    title: 'Perpetual Swap Suite', backgroundColor: '#101114', show: !testMode && !backgroundTests,
    webPreferences: { ...testWindowOptions(backgroundTests).webPreferences,
      additionalArguments: [...(operationRecording ? ['--perpetual-swap-operation-recording'] : []),
        ...(!presentation.getState().active ? ['--perpetual-swap-presentation-idle'] : [])],
      preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  subscribeWindowNotifications(window)
  if (process.platform === 'darwin') {
    const target = window
    const positionButtons = () => {
      const position = windowToolbarLayout(target.getContentSize()[0], true).buttonsPosition
      const current = target.getWindowButtonPosition()
      if (current?.x !== position.x || current?.y !== position.y) target.setWindowButtonPosition(position)
    }
    positionButtons()
    target.on('resize', positionButtons)
    target.on('leave-full-screen', positionButtons)
  }
  window.webContents.on('will-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-redirect', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('will-frame-navigate', event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason)
    rendererOperations?.markIncomplete(window.webContents.id, `renderer-${details.reason}`)
    if (operationRecording) recordOperation({ category: 'cpu', name: 'renderer.interrupted', startedAt: Date.now(), durationMS: 0, status: 'error',
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
      for (const executionId of rendererOperations?.sourcesFor(target.webContents.id) ?? []) await closeExternalOperationSource(executionId)
    }).catch(error => console.error('Renderer operation source close failed:', error)).finally(() => { allowClose = true; if (!target.isDestroyed()) target.close() })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (security.isAllowedExternalURL(url)) void shell.openExternal(url).catch(error => console.error('Could not open external link:', error))
    return { action: 'deny' }
  })
  if (rendererURL) await window.loadURL(rendererURL)
  else await window.loadFile(join(root, 'dist', 'index.html'))
}

function subscribeWindowNotifications(target) {
  const listeners = [
    ['chart', 'radar:chart-prepared'], ['market', 'radar:market-changed'],
    ['audit', 'radar:audit-changed'], ['history-download', 'radar:history-download-changed'],
  ].map(([name, channel]) => [name, value => {
    if (!shuttingDown && !target.isDestroyed() && !target.webContents.isDestroyed()) sendNotification(target.webContents, channel, value)
  }])
  let attached = false
  const attach = () => {
    if (attached || !presentation.desiredActive || shuttingDown || target.isDestroyed() || target.webContents.isDestroyed()) return
    attached = true
    for (const [name, listener] of listeners) backend.on(name, listener)
  }
  const detach = () => {
    if (!attached) return
    attached = false
    for (const [name, listener] of listeners) backend.off(name, listener)
  }
  const entry = { attach, detach }
  windowNotifications.add(entry)
  target.once('closed', () => { detach(); windowNotifications.delete(entry) })
  const owner = target.webContents
  target.webContents.once('destroyed', () => {
    detach()
    presentationDelivery.discardOwner(owner)
  })
  target.webContents.on('render-process-gone', detach)
  target.webContents.on('did-start-loading', () => {
    if (presentation.desiredActive) void presentation.setActive(true, { refresh: true })
  })
  attach()
}

async function startDesktop() {
  if (recordGraphics) stopGraphicsRecording = await startGraphicsRecording(app, contentTracing, operationRecording.directory)
  backend = new MarketBackend({ userData: app.getPath('userData'), testMode, e2eLiveRefresh })
  presentation = new PresentationLifecycle({ active: backgroundTests || app.isActive(),
    pause: epoch => { for (const entry of windowNotifications) entry.detach(); return backend.presentation(false, epoch) },
    resume: async epoch => {
      for (const entry of windowNotifications) entry.attach()
      const snapshot = await backend.presentation(true, epoch)
      if (!snapshot) throw new Error('The presentation snapshot was superseded by a newer activation.')
      return snapshot
    }, publish: publishPresentation })
  // Background test bundles are never natively active. Their explicit test
  // entry exercises this same lifecycle without letting launch-time native
  // deactivation race the simulated active workload or take desktop focus.
  if (!backgroundTests) {
    app.on('did-become-active', () => { void presentation.setActive(true) })
    app.on('did-resign-active', () => { void presentation.setActive(false) })
  }
  // Dispatch initial idle without holding window creation behind data restore.
  // App listeners are already installed, so activation during restore gets a
  // newer epoch; reconcile once ready in case native startup changed state.
  if (!presentation.desiredActive) void backend.presentation(false, 0).catch(error => console.error('Could not initialize interface idle:', error))
  void backend.ready.then(() => {
    if (!backgroundTests && !shuttingDown) return presentation.setActive(app.isActive())
  }).catch(error => console.error('Could not reconcile application activation:', error))
  if (testMode) globalThis.__presentationTest = {
    setActive: active => presentation.setActive(active), getState: () => presentation.getState(),
  }
  if (testMode) globalThis.__marketBackend = backend
  const send = (channel, value) => {
    if (!shuttingDown && window && !window.isDestroyed() && !window.webContents.isDestroyed()) sendNotification(window.webContents, channel, value)
  }
  backend.on('failure', error => { console.error('Market backend failed:', error); send('radar:market-changed') })
  ipcMain.handle('radar:request', handleRequest)
  ipcMain.handle('radar:presentation-state', event => { security.assertTrustedSender(event, window); return presentation.getState() })
  if (rendererOperations) {
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
  }
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
