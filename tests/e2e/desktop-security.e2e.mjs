import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { once } from 'node:events'

const root = fileURLToPath(new URL('../..', import.meta.url))
let userData, electron, page
const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
const environment = (directory, testMode) => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
  ELECTRON_RENDERER_URL: undefined,
  PERPETUAL_SWAP_E2E: testMode ? '1' : '0',
  PERPETUAL_SWAP_TEST_UI: process.env.PERPETUAL_SWAP_TEST_UI ?? 'background',
  PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
  PERPETUAL_SWAP_USER_DATA: directory,
})
const launch = directory => _electron.launch({
  args: ['.', '--headless', '--disable-gpu'], cwd: root, env: environment(directory, true),
})

before(async () => {
  userData = await mkdtemp(join(tmpdir(), 'perp-desktop-security-'))
  electron = await launch(userData)
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})
async function closeAndRemove(running, directory) {
  const child = running?.process()
  let timer
  let shutdownError
  try {
    if (running) await Promise.race([running.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Desktop shutdown timed out.')), 20_000)
    })])
  } catch (error) { shutdownError = error }
  finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  }
  if (shutdownError) throw shutdownError
}
after(() => closeAndRemove(electron, userData))

test('the real renderer exposes one bridge while Electron and Node capabilities remain isolated', async () => {
  const capabilities = await page.evaluate(() => ({
    bridge: typeof window.radarDesktop?.request,
    legacyBridge: typeof window.webkit?.messageHandlers?.radar,
    require: typeof window.require,
    process: typeof window.process,
    ipcRenderer: typeof window.ipcRenderer,
  }))
  assert.deepEqual(capabilities, { bridge: 'function', legacyBridge: 'undefined', require: 'undefined', process: 'undefined', ipcRenderer: 'undefined' })
  const preferences = await electron.evaluate(({ BrowserWindow }) => {
    const { contextIsolation, nodeIntegration, sandbox } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { contextIsolation, nodeIntegration, sandbox }
  })
  assert.deepEqual(preferences, { contextIsolation: true, nodeIntegration: false, sandbox: true })
  assert.equal(typeof (await request({ preferences: { action: 'read' } })).rankingLookback, 'number')
})

test('mixed and malformed commands reject the entire mutation without partial side effects', async () => {
  const previous = await request({ preferences: { action: 'read' } })
  const rankingLookback = previous.rankingLookback + 5
  const invalid = [
    null,
    [],
    {},
    { preferences: { action: 'update', values: { rankingLookback } }, analysisSettings: { action: 'save', model: 'invalid-operation', apiKey: 'must-not-be-saved' } },
    { preferences: { action: 'update', values: { rankingLookback, historyDays: 0 } } },
    { preferences: { action: 'update', values: { rankingLookback, chartTimeframe: '1m' } } },
    { preferences: { action: 'update', values: { rankingLookback, analysis: { apiKey: 'must-not-be-saved' } } } },
    { analysisSettings: { action: 'save', model: 42, apiKey: 'must-not-be-saved' } },
    { captureChart: { x: 0, y: 0, width: -1, height: 60, output: 'png' } },
    { copyText: null },
  ]
  for (const value of invalid) {
    await assert.rejects(() => request(value), /Invalid desktop bridge request/i)
    assert.deepEqual(await request({ preferences: { action: 'read' } }), previous, 'A rejected command must not partially change preferences.')
  }
})

test('an untrusted renderer cannot use the real IPC channel even when supplied with the application preload', async () => {
  const previous = await request({ preferences: { action: 'read' } })
  const attempts = await electron.evaluate(async ({ BrowserWindow }, { preload, rendererURL, rankingLookback }) => {
    const attacker = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    try {
      const results = []
      // An otherwise trusted URL must not authorize a different webContents.
      for (const url of ['data:text/html,<title>Untrusted renderer</title>', rendererURL]) {
        await attacker.loadURL(url)
        results.push(await attacker.webContents.executeJavaScript(`(async () => {
          let transport
          if (!window.radarDesktop) window.radarDesktopBootstrap.connect(value => { transport = value })
          const desktop = window.radarDesktop ?? transport
          const exposed = typeof desktop?.request === 'function'
          if (!exposed) return { exposed }
          try {
            await desktop.request({ preferences: { action: 'update', values: { rankingLookback: ${rankingLookback} } } })
            return { exposed, accepted: true }
          } catch (error) { return { exposed, accepted: false, error: error.message } }
        })()`))
      }
      return results
    } finally { attacker.destroy() }
  }, { preload: join(root, 'electron', 'preload.cjs'), rendererURL: page.url(), rankingLookback: previous.rankingLookback + 5 })
  assert.equal(attempts.length, 2)
  for (const attempt of attempts) {
    assert.equal(attempt.exposed, true, 'The attacker must reach the IPC bridge for this to exercise the host boundary.')
    assert.equal(attempt.accepted, false)
    assert.match(attempt.error, /restricted to application windows/i)
  }
  assert.deepEqual(await request({ preferences: { action: 'read' } }), previous)
})

test('settings window cannot request a screenshot', async () => {
  const opened = electron.waitForEvent('window')
  await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-settings').click())
  const settings = await opened
  try {
    await settings.waitForLoadState('domcontentloaded')
    await assert.rejects(() => settings.evaluate(() => window.radarDesktop.request({ screenshot: {} })), /unavailable in settings/i)
  } finally {
    await settings.evaluate(() => window.radarDesktop.closeSettingsWindow())
  }
})

test('fixture operations are rejected by a separately launched production-mode app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-production-security-'))
  let production
  t.after(() => closeAndRemove(production, directory))
  production = await _electron.launch({
    args: ['.', '--headless', '--disable-gpu'], cwd: root, env: environment(directory, false),
  })
  const productionPage = await production.firstWindow()
  await productionPage.waitForLoadState('domcontentloaded')
  if (process.env.PERPETUAL_SWAP_TEST_UI !== 'foreground') {
    const native = await production.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() }
    })
    assert.deepEqual(native, { visible: false, focused: false, focusable: false }, 'Production security checks must stay hidden without enabling fixture mode.')
  }
  const productionRequest = value => productionPage.evaluate(value => window.radarDesktop.request(value), value)
  const previous = await productionRequest({ preferences: { action: 'read' } })
  for (const action of ['settings', 'smokeStatus', 'seedCachedListProjection']) {
    await assert.rejects(() => productionRequest({ e2e: { action } }), /unavailable outside tests/i)
  }
  assert.deepEqual(await productionRequest({ preferences: { action: 'read' } }), previous)
})
