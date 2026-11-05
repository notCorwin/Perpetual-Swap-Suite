const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const nativeMode = process.env.RADAR_COMPARE_TRANSPORT === 'native'
const url = new URL(process.env.RADAR_COMPARE_URL)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('A loopback comparison URL is required.')
let native
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.setPath('userData', process.env.RADAR_COMPARE_ELECTRON_PROFILE)
app.whenReady().then(async () => {
  if (nativeMode) {
    native = new (require('./native-client.cjs').NativeClient)(process.env.RADAR_COMPARE_SOCKET, process.env.RADAR_COMPARE_NATIVE_TOKEN)
    await native.ready
  }
  app.setActivationPolicy('accessory')
  const window = new BrowserWindow({ width: Number(process.env.RADAR_COMPARE_WIDTH ?? 1440), height: Number(process.env.RADAR_COMPARE_HEIGHT ?? 900),
    show: false, focusable: false, frame: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, ...(native ? { preload: path.join(__dirname, 'native-preload.cjs') } : {}) } })
  if (native) {
    const authorize = event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== url.origin) {
        throw new Error('Native comparison IPC is restricted to the comparison page.')
      }
    }
    ipcMain.handle('comparison-native:request', (event, requestPath, payload) => { authorize(event); return native.request(requestPath, payload) })
    ipcMain.handle('comparison-native:subscribe', event => {
      authorize(event)
      native.subscribe(payload => { if (!window.webContents.isDestroyed()) window.webContents.send('comparison-native:event', payload) })
    })
    ipcMain.handle('comparison-native:close', event => { authorize(event); native.close() })
    window.on('closed', () => native.close())
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.setIgnoreMouseEvents(true)
  // Set the native level below normal application windows before showing it.
  // The API name is misleading here: normal - 1 is explicitly not floating.
  window.setAlwaysOnTop(true, 'normal', -1)
  window.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== url.origin) event.preventDefault() })
  await window.loadURL(url.href)
  window.showInactive()
  if (process.env.RADAR_COMPARE_ENGINE_PROFILE_DIR) {
    const directory = process.env.RADAR_COMPARE_ENGINE_PROFILE_DIR
    const debuggerAPI = window.webContents.debugger
    debuggerAPI.attach('1.3')
    const command = (method, value) => Promise.race([debuggerAPI.sendCommand(method, value), new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), 3000))])
    await command('Profiler.enable')
    await command('Profiler.setSamplingInterval', { interval: 1000 })
    let jobs = Promise.resolve(), traceDone, scenario
    debuggerAPI.on('message', (_event, method, value) => {
      if (method === 'Tracing.tracingComplete') traceDone?.(value.stream)
    })
    window.webContents.on('console-message', detail => {
      if (detail.message.startsWith('RADAR_COMPARE_PROFILE_START:')) jobs = jobs.then(async () => {
        scenario = detail.message.split(':')[1]
        await debuggerAPI.sendCommand('Profiler.start')
        await debuggerAPI.sendCommand('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing', transferMode: 'ReturnAsStream' })
      }).catch(error => console.error(`Engine profile failed: ${error.message}`))
      if (detail.message === 'RADAR_COMPARE_PROFILE_STOP') jobs = jobs.then(async () => {
        const { profile } = await debuggerAPI.sendCommand('Profiler.stop')
        await fs.writeFile(path.join(directory, `${scenario}.cpuprofile`), JSON.stringify(profile))
        const completed = new Promise(resolve => { traceDone = resolve })
        await debuggerAPI.sendCommand('Tracing.end')
        const handle = await completed
        const chunks = []
        for (;;) {
          const part = await debuggerAPI.sendCommand('IO.read', { handle })
          chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data))
          if (part.eof) break
        }
        await debuggerAPI.sendCommand('IO.close', { handle })
        await fs.writeFile(path.join(directory, `${scenario}.trace.json`), Buffer.concat(chunks))
        await fs.writeFile(path.join(directory, `${scenario}.complete.json`), JSON.stringify({ complete: true, samplingIntervalUS: 1000 }))
      }).catch(error => console.error(`Engine profile failed: ${error.message}`))
    })
  }
  if (window.isFocused() || window.isFocusable()) throw new Error('Comparison window must never take focus.')
  console.log(JSON.stringify({ ready: true, pid: process.pid, rendererPid: window.webContents.getOSProcessId(), focused: window.isFocused(), visible: window.isVisible(), size: window.getContentSize() }))
}).catch(error => { console.error(`RADAR_COMPARE event=error message=${error.message}`); native?.close(); app.exit(1) })
process.on('SIGTERM', () => app.quit())
app.on('window-all-closed', () => app.quit())
