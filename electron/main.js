import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, screen, session, shell } from 'electron'
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
import { MarketBackend } from './services/market-backend.js'
import { backgroundWindowLaunch, windowToolbarLayout } from './window-layout.js'
import { restoreWindowBounds, saveWindowBounds } from './window-state.js'
import { PresentationLifecycle } from './services/presentation-lifecycle.js'
import { createStatusLog } from './services/status-log.js'

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
const statusLog = createStatusLog(join(app.getPath('userData'), 'Logs', 'market-status.jsonl'))
const security = createDesktopSecurity({ rendererURL, rendererFile: join(root, 'dist', 'index.html') })
const e2eLiveRefresh = testMode && process.env.PERPETUAL_SWAP_E2E_LIVE_REFRESH === '1'
let window
let settingsWindow
let settingsOpening
let settingsCloseGuard = { dirty: false, busy: false }
let latestPreferences
let backend
const desktopRequests = new Set()
let shuttingDown = false
let shutdownComplete = false
let startupTask = Promise.resolve()
let stopTestOwner = () => {}
let testOwnerExitTimer
let presentation
const windowNotifications = new Set()
function publishPresentation(update) {
  const value = update.snapshot ? { ...update, snapshot: encodeChartWire({ ...update.snapshot, preferences: latestPreferences ?? update.snapshot.preferences }) } : update
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('radar:presentation', value)
  if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.webContents.isDestroyed()) {
    const { snapshot: _snapshot, ...state } = update
    settingsWindow.webContents.send('radar:presentation', state)
  }
}

function assertApplicationSender(event) {
  if (security.isTrustedSender(event, window) || security.isTrustedSender(event, settingsWindow)) return
  throw new Error('Desktop requests are restricted to application windows.')
}

function assertSettingsSender(event) { security.assertTrustedSender(event, settingsWindow) }

function sendNotification(sender, channel, detail) {
  if (!presentation?.getState().active) return
  const epoch = presentation.getState().epoch
  sender.send(channel, channel === 'radar:chart-prepared' ? encodeChartWire(detail) : detail, epoch)
}

async function copyImage(image) {
  if (image.isEmpty()) throw new Error('Invalid chart image.')
  const png = image.toPNG()
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
}

async function handleRequest(event, payload) {
  assertApplicationSender(event)
  const request = parseDesktopRequest(payload, { allowE2E: testMode })
  if (security.isTrustedSender(event, settingsWindow) && !request.preferences && !request.dataAudit && !request.historyDownload) throw new Error('This request is unavailable in settings.')
  if (shuttingDown) throw new Error('The application is closing.')
  const displayRead = Boolean(request.snapshot || request.chartLocal || request.chartHistory || request.chartUniverse)
  const epoch = presentation.getState().epoch
  const assertPresentation = () => {
    if (displayRead && (!presentation.getState().active || epoch !== presentation.getState().epoch)) {
      throw Object.assign(new Error('The interface became idle or changed while its view was being read.'), { name: 'AbortError' })
    }
  }
  assertPresentation()
  const execute = async () => {
  if ('statusLog' in request) { await statusLog.write(request.statusLog); return { ok: true } }
  if ('copyText' in request) { await clipboard.writeText(request.copyText); return { ok: true } }
  if ('copyImage' in request) {
    const image = nativeImage.createFromDataURL(request.copyImage)
    await copyImage(image); return { ok: true }
  }
  if (request.screenshot) {
    const image = await event.sender.capturePage()
    await copyImage(image)
    return { ok: true }
  }
  if (request.captureChart) {
    const { x, y, width, height, output } = request.captureChart
    const image = await event.sender.capturePage({ x: Math.floor(x), y: Math.floor(y), width: Math.ceil(x + width) - Math.floor(x), height: Math.ceil(y + height) - Math.floor(y) })
    if (output === 'png') return { imageDataURL: `data:image/png;base64,${image.toPNG().toString('base64')}`, ...image.getSize() }
    await copyImage(image)
    return { ok: true }
  }
  const response = await backend.request(request)
  assertPresentation()
  if (request.preferences?.action === 'update') {
    latestPreferences = response
    // Preference commits are control state, not presentation data. Deliver them
    // even while a window is idle or an activation snapshot is being prepared.
    for (const target of [window, settingsWindow]) if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('radar:preferences-changed', response)
  }
  if (request.e2e?.action === 'smokeStatus') {
    const build = await readFile(join(process.resourcesPath, 'build-revision.json'), 'utf8').then(JSON.parse).catch(() => null)
    return { ...response, revision: build?.revision ?? null }
  }
  return request.chartLocal || request.chartHistory || request.chartUniverse ? encodeChartWire(response) : response
  }
  const task = execute()
  desktopRequests.add(task)
  task.then(() => desktopRequests.delete(task), () => desktopRequests.delete(task))
  return task
}

const backgroundLaunch = backgroundWindowLaunch(process.argv, testMode, backgroundTests)

async function openSettings() {
  if (settingsOpening) return settingsOpening
  settingsOpening = (async () => {
    await startupTask
    if (shuttingDown) return
    if (!settingsWindow || settingsWindow.isDestroyed()) await createSettingsWindow()
    const target = settingsWindow
    if (!target || target.isDestroyed()) return
    if (!backgroundTests) {
      if (target.isMinimized()) target.restore()
      target.show(); target.focus()
    }
  })().finally(() => { settingsOpening = undefined })
  return settingsOpening
}

function canCloseSettings() {
  if (settingsCloseGuard.busy) return false
  if (!settingsCloseGuard.dirty) return true
  return dialog.showMessageBoxSync(settingsWindow, { type: 'warning', buttons: ['Keep Editing', 'Discard Changes'], defaultId: 0, cancelId: 0,
    message: 'Discard your unsaved settings changes?', detail: 'Your changes have not been saved.' }) === 1
}

function querySettingsCloseGuard(target) {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return Promise.resolve()
  return new Promise(resolve => {
    const id = randomUUID()
    const finish = value => {
      clearTimeout(timer); ipcMain.off('radar:settings-close-state', reply)
      if (settingsWindow === target && value && typeof value.dirty === 'boolean' && typeof value.busy === 'boolean') settingsCloseGuard = { dirty: value.dirty, busy: value.busy }
      resolve()
    }
    const reply = (event, value) => {
      if (!security.isTrustedSender(event, target) || value?.id !== id) return
      finish(value)
    }
    const timer = setTimeout(() => finish({ dirty: true, busy: settingsCloseGuard.busy }), 1000)
    ipcMain.on('radar:settings-close-state', reply)
    target.webContents.send('radar:settings-query-close', { id })
  })
}

async function createSettingsWindow() {
  settingsCloseGuard = { dirty: false, busy: false }
  const target = settingsWindow = new BrowserWindow({
    ...testWindowOptions(backgroundTests), width: 1000, height: 720, minWidth: 800, minHeight: 560,
    title: 'Settings — Perpetual Swap Suite', backgroundColor: '#101114', show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: windowToolbarLayout(1600, true).buttonsPosition } : {}),
    webPreferences: { ...testWindowOptions(backgroundTests).webPreferences,
      additionalArguments: ['--perpetual-swap-settings-window',
        ...(!presentation.getState().active ? ['--perpetual-swap-presentation-idle'] : [])],
      preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  subscribeWindowNotifications(target, true)
  let allowClose = false, closing = false
  target.on('close', event => {
    if (allowClose || shuttingDown) return
    event.preventDefault()
    if (closing) return
    closing = true
    void querySettingsCloseGuard(target).then(() => {
      if (target.isDestroyed() || !canCloseSettings()) { closing = false; return }
      allowClose = true
      if (!target.isDestroyed()) target.close()
    }).catch(error => { closing = false; console.error('Settings close check failed:', error) })
  })
  target.once('closed', () => { if (settingsWindow === target) settingsWindow = undefined; settingsCloseGuard = { dirty: false, busy: false } })
  target.webContents.on('render-process-gone', (_event, details) => {
    console.error('Settings renderer process exited:', details.reason)
    settingsCloseGuard = { dirty: false, busy: false }
    if (!shuttingDown && !testMode && details.reason !== 'clean-exit' && !target.isDestroyed()) target.destroy()
  })
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) target.webContents.on(name, event => { if (!security.isAllowedNavigation(event.url)) event.preventDefault() })
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (security.isAllowedExternalURL(url)) void shell.openExternal(url).catch(error => console.error('Could not open external link:', error))
    return { action: 'deny' }
  })
  try {
    if (rendererURL) await target.loadURL(rendererURL)
    else await target.loadFile(join(root, 'dist', 'index.html'))
  } catch (error) { if (!target.isDestroyed()) target.destroy(); throw error }
}

function installApplicationMenu() {
  const settings = { id: 'open-settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => {
    void openSettings().catch(error => console.error('Could not open settings:', error))
  } }
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'Perpetual Swap Suite', submenu: [
      { role: 'about' }, { type: 'separator' }, settings, { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { role: 'fileMenu' },
    ...(process.platform === 'darwin' ? [{ role: 'editMenu' }] : [{ label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
      { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, settings,
    ] }]),
    { role: 'viewMenu' }, { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  if (shuttingDown || window && !window.isDestroyed()) return
  const windowStatePath = join(app.getPath('userData'), 'window-state.json')
  const savedBounds = restoreWindowBounds(windowStatePath, screen.getAllDisplays())
  window = new BrowserWindow({
    ...testWindowOptions(backgroundTests),
    frame: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: windowToolbarLayout(1600, true).buttonsPosition } : {}),
    width: 1600, height: 1000, ...savedBounds, minWidth: 1200, minHeight: 640,
    title: 'Perpetual Swap Suite', backgroundColor: '#101114', show: false,
    webPreferences: { ...testWindowOptions(backgroundTests).webPreferences,
      additionalArguments: [...(!presentation.getState().active ? ['--perpetual-swap-presentation-idle'] : [])],
      preload: join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  if (!testMode && !backgroundTests && !backgroundLaunch) {
    if (!savedBounds) window.maximize()
    window.show()
  }
  if (backgroundLaunch) window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive() })
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
  let rendererRecoveries = 0
  const target = window
  target.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason)
    if (shuttingDown || testMode || details.reason === 'clean-exit' || target.isDestroyed()) return
    if (rendererRecoveries < 2) {
      rendererRecoveries += 1
      void (rendererURL ? target.loadURL(rendererURL) : target.loadFile(join(root, 'dist', 'index.html'))).catch(error => {
        console.error('Could not reload window after renderer exit:', error)
      })
    } else if (!backgroundTests) {
      void dialog.showMessageBox(target, { type: 'error', buttons: ['Reload', 'Quit'], defaultId: 0,
        message: 'The workspace window stopped unexpectedly.', detail: 'Reload the window to restore the market view.' }).then(({ response }) => {
        if (response === 0 && !target.isDestroyed()) {
          rendererRecoveries = 0
          void (rendererURL ? target.loadURL(rendererURL) : target.loadFile(join(root, 'dist', 'index.html')))
        } else app.quit()
      })
    }
  })
  target.on('close', () => { saveWindowBounds(windowStatePath, target) })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (security.isAllowedExternalURL(url)) void shell.openExternal(url).catch(error => console.error('Could not open external link:', error))
    return { action: 'deny' }
  })
  if (rendererURL) await window.loadURL(rendererURL)
  else await window.loadFile(join(root, 'dist', 'index.html'))
}

function subscribeWindowNotifications(target, settingsOnly = false) {
  const listeners = [
    ['chart', 'radar:chart-prepared'], ['market', 'radar:market-changed'],
    ['audit', 'radar:audit-changed'], ['history-download', 'radar:history-download-changed'],
  ].filter(([name]) => !settingsOnly || name === 'audit' || name === 'history-download').map(([name, channel]) => [name, value => {
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
  target.webContents.once('destroyed', () => {
    detach()
  })
  target.webContents.on('render-process-gone', detach)
  if (!settingsOnly) target.webContents.on('did-start-loading', () => {
    if (presentation.desiredActive) void presentation.setActive(true, { refresh: true })
  })
  attach()
}

async function startDesktop() {
  backend = new MarketBackend({ userData: app.getPath('userData'), testMode, e2eLiveRefresh })
  presentation = new PresentationLifecycle({ active: true,
    pause: epoch => { for (const entry of windowNotifications) entry.detach(); return backend.presentation(false, epoch) },
    resume: async epoch => {
      for (const entry of windowNotifications) entry.attach()
      const snapshot = await backend.presentation(true, epoch)
      if (!snapshot) throw new Error('The presentation snapshot was superseded by a newer activation.')
      return snapshot
    }, publish: publishPresentation })
  if (testMode) globalThis.__presentationTest = {
    setActive: active => presentation.setActive(active), getState: () => presentation.getState(),
  }
  if (testMode) globalThis.__marketBackend = backend
  const send = (channel, value) => {
    if (!shuttingDown && window && !window.isDestroyed() && !window.webContents.isDestroyed()) sendNotification(window.webContents, channel, value)
  }
  backend.on('failure', error => { console.error('Market backend failed:', error); send('radar:market-changed') })
  backend.on('recovered', () => {
    if (presentation?.desiredActive) void presentation.setActive(true, { refresh: true })
    send('radar:market-changed')
  })
  ipcMain.handle('radar:request', handleRequest)
  ipcMain.handle('radar:presentation-state', event => { assertApplicationSender(event); return presentation.getState() })
  ipcMain.on('radar:settings-close-guard', (event, value) => {
    try { assertSettingsSender(event) } catch { return }
    if (typeof value?.dirty === 'boolean' && typeof value?.busy === 'boolean') settingsCloseGuard = { dirty: value.dirty, busy: value.busy }
  })
  ipcMain.handle('radar:settings-close', event => { assertSettingsSender(event); settingsWindow.close() })
  // Windows and input become available while data restores in its own worker.
  await createWindow()
}

app.whenReady().then(() => {
  installApplicationMenu()
  if (!rendererURL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame' && security.isTrustedURL(details.url)) {
        callback({ responseHeaders: { ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"] } })
        return
      }
      callback({ responseHeaders: details.responseHeaders })
    })
  }
  if (testMode || process.env.PERPETUAL_SWAP_TEST_UI !== undefined) {
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
  if (!backgroundTests && app.isReady() && !shuttingDown && (!window || window.isDestroyed())) void startupTask.then(createWindow).catch(error => console.error('Could not open application window:', error))
})
let quitChecking = false
function startShutdown() {
  shuttingDown = true
  ipcMain.removeHandler('radar:request')
  void (async () => {
    try {
      await startupTask.catch(error => console.error('Desktop startup did not complete:', error))
      try { await backend?.dispose() }
      catch (error) { console.error('Market backend shutdown failed:', error) }
      await Promise.allSettled([...desktopRequests])
      await statusLog.flush()
    } catch (error) { console.error('Desktop shutdown failed:', error) }
    finally {
      shutdownComplete = true; app.quit()
    }
  })()
}
app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown || quitChecking) return
  const target = settingsWindow
  if (!target || target.isDestroyed()) { startShutdown(); return }
  quitChecking = true
  void querySettingsCloseGuard(target).then(() => {
    quitChecking = false
    if (settingsWindow === target && !target.isDestroyed() && !canCloseSettings()) return
    startShutdown()
  }).catch(error => { quitChecking = false; console.error('Could not check settings before quitting:', error) })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
