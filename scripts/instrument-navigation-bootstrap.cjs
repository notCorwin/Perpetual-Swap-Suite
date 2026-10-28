const { app, BrowserWindow, ipcMain, session } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { startupNavigationProbe } = require('./instrument-navigation-acceptance.mjs')
const { encodeChartWire, decodeChartWire } = require('../electron/chart-wire.js')

// Loaded with Electron's -r before the unchanged production entry point. Its
// session preload measures the first document rather than a renderer reload.
const userData = process.env.PERPETUAL_SWAP_USER_DATA
if (!userData || process.env.PERPETUAL_SWAP_E2E !== '1') throw new Error('Cold-start measurement needs an isolated E2E profile.')
mkdirSync(join(userData, 'Session'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'Session'))
const preload = join(userData, 'navigation-probe.cjs')
writeFileSync(preload, `require('electron').contextBridge.executeInMainWorld({ func: ${startupNavigationProbe.toString()} })`)

const handle = ipcMain.handle.bind(ipcMain)
const probe = globalThis.__navigationStartupRequests = { requests: [], rendererFrames: new Set() }
ipcMain.handle = (channel, handler) => handle(channel, channel !== 'radar:request' ? handler : async (event, value, context) => {
  const kind = ['chartUniverse', 'chartFocus', 'chartLocal', 'chartWindow', 'chartHistory'].find(kind => value[kind])
  if (kind) probe.requests.push({ kind, ...(kind === 'chartFocus' ? value[kind].target : value[kind]), at: Date.now() })
  const result = await handler(event, value, context)
  // The first-document probe observes the renderer's existing prepared-frame
  // event. Forward the canonical universe response through that same ingress
  // so readiness means the UI received it, while chart geometry stays lazy.
  if (kind === 'chartUniverse') for (const frame of decodeChartWire(result).frames ?? []) {
    if (frame.bars?.length === 96 && frame.indicatorState === 'ready'
      && ['ready', 'stale'].includes(frame.priceState) && ['ready', 'unavailable'].includes(frame.oiState)
      && ['ready', 'unavailable'].includes(frame.takerState)) {
      const key = `${frame.timeframe}:${frame.instId}`
      if (probe.rendererFrames.has(key)) continue
      BrowserWindow.getAllWindows()[0]?.webContents.send('radar:chart-prepared', encodeChartWire(frame))
      probe.rendererFrames.add(key)
    }
  }
  return result
})

void app.whenReady().then(() => session.defaultSession.registerPreloadScript({ type: 'frame', filePath: preload }))
