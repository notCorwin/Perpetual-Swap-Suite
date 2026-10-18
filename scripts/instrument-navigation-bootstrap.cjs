const { app, ipcMain, session } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { startupNavigationProbe } = require('./instrument-navigation-acceptance.mjs')

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
const probe = globalThis.__navigationStartupRequests = { requests: [], ready: new Set() }
ipcMain.handle = (channel, handler) => handle(channel, channel !== 'radar:request' ? handler : async (event, value) => {
  const kind = ['chartUniverse', 'chartLocal', 'chartWindow', 'chartHistory'].find(kind => value[kind])
  if (kind) probe.requests.push({ kind, ...value[kind], at: Date.now() })
  const result = await handler(event, value)
  if (kind === 'chartUniverse') for (const frame of result.frames ?? []) if (frame.bars?.length >= 96) probe.ready.add(`${frame.timeframe}:${frame.instId}`)
  return result
})

void app.whenReady().then(() => session.defaultSession.registerPreloadScript({ type: 'frame', filePath: preload }))
