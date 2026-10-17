import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')

test('Electron host keeps Radar, prepared charts, and analysis isolated behind the desktop bridge', () => {
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /ipcMain\.handle\('radar:request'/)
  assert.match(main, /gatewayFetch\(event, request\.gatewayFetch\)/)
  assert.match(main, /marketService\.prepareChartWindow\(instId, timeframe, endHour\)/)
  assert.match(preload, /ipcRenderer\.on\('radar:chart-prepared'/)
  assert.match(preload, /ipcRenderer\.on\('radar:gateway-stream'/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('radarDesktop'/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('webkit'/)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^\n]+ipcRenderer/)
})
