const { app, BrowserWindow } = require('electron')
const url = new URL(process.env.RADAR_COMPARE_URL)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('A loopback comparison URL is required.')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.setPath('userData', process.env.RADAR_COMPARE_ELECTRON_PROFILE)
app.whenReady().then(async () => {
  app.setActivationPolicy('accessory')
  const window = new BrowserWindow({ width: Number(process.env.RADAR_COMPARE_WIDTH ?? 1440), height: Number(process.env.RADAR_COMPARE_HEIGHT ?? 900),
    show: false, focusable: false, frame: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.setIgnoreMouseEvents(true)
  // Set the native level below normal application windows before showing it.
  // The API name is misleading here: normal - 1 is explicitly not floating.
  window.setAlwaysOnTop(true, 'normal', -1)
  window.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== url.origin) event.preventDefault() })
  await window.loadURL(url.href)
  window.showInactive()
  if (window.isFocused() || window.isFocusable()) throw new Error('Comparison window must never take focus.')
  console.log(JSON.stringify({ ready: true, pid: process.pid, rendererPid: window.webContents.getOSProcessId(), focused: window.isFocused(), visible: window.isVisible(), size: window.getContentSize() }))
})
process.on('SIGTERM', () => app.quit())
app.on('window-all-closed', () => app.quit())
