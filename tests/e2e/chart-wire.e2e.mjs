import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('chart requests and publications cross Electron as wire strings and retain the desktop API', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chart-wire-e2e-'))
  const electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: directory } })
  t.after(async () => { await electron.close(); await rm(directory, { recursive: true, force: true }) })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
  await electron.evaluate(({ ipcMain, BrowserWindow }) => {
    const original = ipcMain._invokeHandlers.get('radar:request'), contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send
    const probe = globalThis.__wireProbe = { requests: [], notifications: [], malformed: false }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value, context) => {
      if (probe.malformed && value.chartLocal) return 'invalid chart wire'
      const result = await original(event, value, context)
      const command = ['chartWindow', 'chartLocal', 'chartHistory', 'chartUniverse'].find(key => value[key])
      if (command) probe.requests.push({ command, type: typeof result, traceId: context?.traceId, parentId: context?.parentId })
      return result
    })
    contents.send = function (channel, ...args) {
      if (channel === 'radar:chart-prepared') probe.notifications.push({ type: typeof args[0], traceId: args[1]?.traceId, parentId: args[1]?.parentId })
      return send.call(this, channel, ...args)
    }
  })
  const instId = 'WIRE-USDT-SWAP', step = 300_000, through = Math.floor(Date.now() / step) * step - step
  const candles = Array.from({ length: 250 }, (_, index) => ({ instrument: instId, timeframe: '5m', timestamp: through - (249 - index) * step,
    open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 1_000, confirmed: true }))
  await request({ e2e: { action: 'seedCandles', candles } })
  const window = await request({ chartWindow: { instId, timeframe: '5m', historyBars: 96 } })
  assert.equal(window.instId, instId)
  assert.equal(window.timeframe, '5m')
  assert.ok(Array.isArray(window.bars))
  for (const value of [{ chartLocal: { instId, timeframe: '5m' } }, { chartHistory: { instId, timeframe: '5m', endHour: through } }, { chartUniverse: {} }]) {
    const result = await request(value)
    assert.ok(result === null || typeof result === 'object')
  }
  await assert.rejects(() => request({ chartLocal: { instId, timeframe: '5m', extra: true } }), /Invalid desktop bridge request/)
  const raw = await electron.evaluate(() => globalThis.__wireProbe.requests)
  for (const command of ['chartWindow', 'chartLocal', 'chartHistory', 'chartUniverse']) assert.ok(raw.some(value => value.command === command))
  assert.ok(raw.every(value => value.type === 'string' && value.traceId && value.parentId), 'The real handler must return primitives and retain request lineage.')

  await page.evaluate(() => {
    window.__wireNotifications = []
    window.addEventListener('radar-chart-prepared', event => {
      const frame = event.detail
      if (frame?.instId !== 'WIRE-FIXTURE') return
      window.__wireNotifications.push({ type: frame.type ?? 'full', generation: frame.generation, revision: frame.revision,
        sourceVersions: frame.sourceVersions, status: frame.oiStatus, close: frame.bars?.[0]?.close,
        undefinedOwn: Object.hasOwn(frame, 'liveBar') && frame.liveBar === undefined,
        badIndicator: Number.isNaN(frame.bars?.[0]?.roc), negativeZero: Object.is(frame.bars?.[0]?.rsi6, -0),
        livePrice: frame.type === 'live' ? frame.liveBar.close : null })
    })
  })
  await electron.evaluate(async ({ BrowserWindow }) => {
    const { encodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const full = { instId: 'WIRE-FIXTURE', timeframe: '5m', generation: 4, revision: 7, endHour: 100,
      bars: [{ hour: 100, close: 123, roc: NaN, rsi6: -0 }], liveBar: undefined,
      sourceVersions: { price: 2, oi: 3, taker: 4 }, oiStatus: { state: 'error', from: 1, through: 100, error: 'retry', retryAt: 200 } }
    const correction = { ...full, revision: 8, bars: [{ ...full.bars[0], close: 124 }] }
    const live = { type: 'live', instId: full.instId, timeframe: full.timeframe, generation: 4, revision: 9,
      endHour: 100, liveBar: { close: 125 }, sourceVersions: { price: 3, oi: 3, taker: 4 } }
    for (const frame of [full, correction, live]) contents.send('radar:chart-prepared', encodeChartWire(frame))
  })
  await page.waitForFunction(() => window.__wireNotifications.length === 3)
  const notifications = await page.evaluate(() => window.__wireNotifications)
  assert.deepEqual(notifications.map(value => [value.type, value.generation, value.revision]), [['full', 4, 7], ['full', 4, 8], ['live', 4, 9]])
  assert.deepEqual(notifications.slice(0, 2).map(value => value.close), [123, 124])
  assert.ok(notifications.slice(0, 2).every(value => value.undefinedOwn && value.badIndicator && value.negativeZero))
  assert.deepEqual(notifications[0].status, { state: 'error', from: 1, through: 100, error: 'retry', retryAt: 200 })
  assert.deepEqual(notifications[2].sourceVersions, { price: 3, oi: 3, taker: 4 })
  assert.equal(notifications[2].livePrice, 125)
  const sent = await electron.evaluate(() => globalThis.__wireProbe.notifications)
  assert.ok(sent.every(value => value.type === 'string'))
  assert.ok(sent.some(value => value.traceId && value.parentId), 'Real chart notifications must retain operation lineage.')

  await electron.evaluate(() => { globalThis.__wireProbe.malformed = true })
  await assert.rejects(() => request({ chartLocal: { instId, timeframe: '5m' } }))
  await electron.evaluate(() => { globalThis.__wireProbe.malformed = false })
  const security = await electron.evaluate(({ BrowserWindow }) => {
    const { contextIsolation, nodeIntegration, sandbox } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { contextIsolation, nodeIntegration, sandbox }
  })
  assert.deepEqual(security, { contextIsolation: true, nodeIntegration: false, sandbox: true })
  assert.deepEqual(await page.evaluate(() => [typeof window.radarDesktop.request, typeof window.require, typeof window.process, typeof window.ipcRenderer]),
    ['function', 'undefined', 'undefined', 'undefined'])
  const attempts = await electron.evaluate(async ({ BrowserWindow }, rendererURL) => {
    const preload = `${process.cwd()}/electron/preload.cjs`
    const attacker = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    try {
      const results = []
      for (const url of ['data:text/html,<title>Untrusted</title>', rendererURL]) {
        await attacker.loadURL(url)
        results.push(await attacker.webContents.executeJavaScript(`(async () => {
          let transport
          window.dispatchEvent(new CustomEvent('radar-desktop-connect', { detail: value => { transport = value } }))
          const desktop = window.radarDesktop ?? transport
          try { await desktop.request({ preferences: { action: 'read' } }); return 'accepted' }
          catch (error) { return error.message }
        })()`))
      }
      return results
    } finally { attacker.destroy() }
  }, page.url())
  assert.ok(attempts.every(value => /restricted to the application main frame/i.test(value)))
})
