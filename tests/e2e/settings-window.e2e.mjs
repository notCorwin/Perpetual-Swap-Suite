import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const root = fileURLToPath(new URL('../..', import.meta.url))
let electron, main, settings, userData
const menuAction = () => electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-settings').click())
const nativeWindowCount = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const closeSettings = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle().includes('Settings'))?.close())
// Observe the renderer's response to the native close handshake. Waiting for
// the event-loop turn after the reply ensures the main-process decision ran.
const observeGuard = () => electron.evaluate(({ ipcMain }) => {
  globalThis.__settingsGuardReply = new Promise(resolve => ipcMain.once('radar:settings-close-state', (_event, value) => setImmediate(() => resolve(value))))
})
const guardResult = () => electron.evaluate(() => globalThis.__settingsGuardReply)


before(async () => {
  userData = await mkdtemp(join(tmpdir(), 'perp-settings-window-'))
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root, env: {
    ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined,
    PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
    PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_USER_DATA: userData,
  } })
  main = await electron.firstWindow()
  await main.waitForLoadState('domcontentloaded')
})

after(async () => {
  if (settings && !settings.isClosed()) await settings.evaluate(() => window.radarDesktop.setSettingsCloseGuard({ dirty: false, busy: false })).catch(() => {})
  await electron?.close()
  if (userData) await rm(userData, { recursive: true, force: true })
})

test('Settings menu opens one independent background window and changes update the main workspace', async () => {
  const menu = await electron.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('open-settings')
    return { label: item?.label, accelerator: item?.accelerator }
  })
  assert.equal(menu.label, 'Settings…')
  assert.equal(menu.accelerator, 'CmdOrCtrl+,')
  assert.equal(await main.getByRole('link', { name: 'Settings', exact: true }).count(), 0)

  const opened = electron.waitForEvent('window')
  await menuAction()
  settings = await opened
  await settings.locator('[data-layout="settings-workspace"]').waitFor()
  const bollSwitch = settings.getByRole('switch', { name: 'Bollinger price labels' })
  await bollSwitch.waitFor({ state: 'visible' })
  await settings.waitForFunction(() => {
    const el = document.querySelector('[role="switch"]')
    return Boolean(el && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('data-disabled'))
  })
  assert.equal(await settings.locator('#settings-section-title').evaluate(element => element === document.activeElement), false,
    'Opening settings must not move focus to the section heading.')
  for (const name of ['Liquidity filters', 'Market data', 'Workspace']) {
    const link = settings.getByRole('link', { name, exact: true })
    await link.focus()
    await settings.keyboard.press('Enter')
    await settings.getByRole('heading', { name, exact: true, level: 2 }).waitFor()
    assert.equal(await link.evaluate(element => element === document.activeElement), true,
      'Keyboard navigation must keep focus on the category link.')
    assert.equal(await link.getAttribute('aria-current'), 'page')
  }
  assert.equal(await nativeWindowCount(), 2)
  const native = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  assert.ok(native.every(window => !window.visible && !window.focused && !window.focusable), 'Test windows must stay hidden and not steal focus.')

  await menuAction()
  await menuAction()
  assert.equal(await nativeWindowCount(), 2, 'Repeated menu commands should reuse the same settings window.')
  assert.equal(await main.locator('[data-market-list]').count(), 1, 'The main workspace remains mounted while settings are open.')
  const beforeChecked = (await bollSwitch.getAttribute('aria-checked')) === 'true'
  await bollSwitch.click()
  await settings.getByRole('button', { name: 'Save settings' }).click()
  await settings.getByText('Settings saved.').waitFor()
  assert.equal((await main.evaluate(() => window.radarDesktop.request({ preferences: { action: 'read' } }))).showBollingerPriceLabels, !beforeChecked)
})

test('settings refresh preferences and job status after the application resumes', async () => {
  await settings.getByRole('link', { name: 'Market data' }).click()
  await settings.getByRole('button', { name: 'Download all qualified history' }).waitFor()
  await settings.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Download all qualified history') && !button.disabled))
  await electron.evaluate(({ ipcMain, BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('Settings'))
    const originalSend = target.webContents.send
    target.webContents.send = function(channel, ...args) {
      if (channel !== 'radar:history-download-changed' && channel !== 'radar:audit-changed') return originalSend.call(this, channel, ...args)
    }
    const original = ipcMain._invokeHandlers.get('radar:request')
    globalThis.__settingsStatusFixture = { original, target, originalSend, phase: 0, reads: { audit: 0, download: 0 } }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, request, ...rest) => {
      const result = await original(event, request, ...rest)
      const fixture = globalThis.__settingsStatusFixture
      if (request.dataAudit?.action === 'status') {
        fixture.reads.audit++
        return { ...result, revision: 1_000_000 + fixture.phase,
          phase: 'running', error: '', issues: [], progress: { completed: fixture.phase ? 4 : 1, total: 9 } }
      }
      if (request.historyDownload?.action === 'status') {
        fixture.reads.download++
        return { ...result, revision: 1_000_000 + fixture.phase,
          phase: 'running', error: '', progress: { ...result.progress, checked: fixture.phase ? 5 : 1, total: 10 } }
      }
      return result
    })
  })
  try {
    const before = await electron.evaluate(() => ({ ...globalThis.__settingsStatusFixture.reads }))
    await electron.evaluate(() => globalThis.__presentationTest.setActive(false))
    await electron.evaluate(() => { globalThis.__settingsStatusFixture.phase = 1 })
    const previous = await main.evaluate(() => window.radarDesktop.request({ preferences: { action: 'read' } }))
    const next = !previous.showBollingerPriceLabels
    await main.evaluate(value => window.radarDesktop.request({ preferences: { action: 'update', values: { showBollingerPriceLabels: value } } }), next)
    await electron.evaluate(() => globalThis.__presentationTest.setActive(true))
    await settings.getByText('Audit running · 4 / 9').waitFor()
    await settings.getByText('Downloading history · 50.0%').waitFor({ timeout: 4_000 }).catch(async error => { throw new Error(`${error.message}\nFixture: ${JSON.stringify(await electron.evaluate(() => globalThis.__settingsStatusFixture.reads))}\nBody: ${await settings.locator('body').innerText()}`) })
    const after = await electron.evaluate(() => ({ ...globalThis.__settingsStatusFixture.reads }))
    assert.ok(after.audit > before.audit && after.download > before.download, 'Both job statuses must be reread on activation.')
    await settings.getByRole('link', { name: 'Workspace', exact: true }).click()
    await settings.waitForFunction(value => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === String(value), next)
  } finally {
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('radar:request')
      globalThis.__settingsStatusFixture.target.webContents.send = globalThis.__settingsStatusFixture.originalSend
      ipcMain.handle('radar:request', globalThis.__settingsStatusFixture.original)
      delete globalThis.__settingsStatusFixture
    })
  }
})

test('native close and quit protect unsaved and busy settings', async () => {
  const bollSwitch = settings.getByRole('switch', { name: 'Bollinger price labels' })
  const beforeChecked = (await bollSwitch.getAttribute('aria-checked')) === 'true'
  await electron.evaluate(({ dialog }) => { globalThis.__settingsDialogs = 0; dialog.showMessageBoxSync = () => { globalThis.__settingsDialogs++; return 0 } })
  await bollSwitch.click()
  // Close immediately after typing, without waiting for a status render.
  await observeGuard()
  await closeSettings()
  assert.equal((await guardResult()).dirty, true)
  assert.equal(await electron.evaluate(() => globalThis.__settingsDialogs), 1)
  assert.equal(await nativeWindowCount(), 2, 'Keep Editing must cancel the native close immediately after an edit.')
  await settings.getByText('Unsaved changes').waitFor()
  await observeGuard()
  await electron.evaluate(({ app }) => app.quit())
  assert.equal((await guardResult()).dirty, true)
  assert.equal(await electron.evaluate(() => globalThis.__settingsDialogs), 2)
  assert.equal(await nativeWindowCount(), 2, 'Keep Editing must cancel application quit.')

  await settings.evaluate(() => window.radarDesktop.setSettingsCloseGuard({ dirty: false, busy: true }))
  await observeGuard()
  await closeSettings()
  assert.equal((await guardResult()).busy, true)
  assert.equal(await nativeWindowCount(), 2, 'An in-progress save must prevent closing.')
  await observeGuard()
  await electron.evaluate(({ app }) => app.quit())
  assert.equal((await guardResult()).busy, true)
  assert.equal(await nativeWindowCount(), 2, 'An in-progress save must prevent application quit.')
  await settings.evaluate(() => window.radarDesktop.setSettingsCloseGuard({ dirty: true, busy: false }))
  await electron.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  const closed = settings.waitForEvent('close')
  await closeSettings()
  await closed
  assert.equal(await nativeWindowCount(), 1)
  const reopened = electron.waitForEvent('window')
  await menuAction()
  settings = await reopened
  await settings.locator('[data-layout="settings-workspace"]').waitFor()
  await settings.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-disabled') !== 'true')
  assert.equal((await settings.getByRole('switch', { name: 'Bollinger price labels' }).getAttribute('aria-checked')) === 'true', beforeChecked, 'Discarded changes must not be persisted on reopening.')
})


test('settings can be opened when the main window is closed', { skip: process.platform !== 'darwin' }, async () => {
  const closed = main.waitForEvent('close')
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getTitle().includes('Settings'))?.close())
  await closed
  assert.equal(await nativeWindowCount(), 1)
  const settingsClosed = settings.waitForEvent('close')
  await closeSettings()
  await settingsClosed
  assert.equal(await nativeWindowCount(), 0)
  const opened = electron.waitForEvent('window')
  await menuAction()
  settings = await opened
  await settings.locator('[data-layout="settings-workspace"]').waitFor()
  assert.equal(await nativeWindowCount(), 1)
})
