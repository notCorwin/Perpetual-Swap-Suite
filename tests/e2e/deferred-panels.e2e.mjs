import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

test('a missing settings chunk leaves the market workspace usable', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-deferred-panel-'))
  let electron
  try {
    electron = await _electron.launch({ args: ['.', '--disable-gpu'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.locator('[data-market-list]').waitFor()
    await electron.evaluate(({ BrowserWindow }, chunk) => {
      BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url.includes(chunk) }))
    }, '/SettingsWindow-')
    const settingsOpened = electron.waitForEvent('window')
    await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-settings').click())
    const settingsPage = await settingsOpened
    const region = settingsPage.getByRole('alert')
    await region.waitFor({ timeout: 10_000 })
    assert.match(await region.textContent(), /could not load.*Restart the app/)
    const closed = settingsPage.waitForEvent('close')
    await region.getByRole('button', { name: 'Close settings', exact: true }).click()
    await closed
    await page.locator('[data-market-list]').waitFor()
    assert.equal(await page.locator('[data-chart-panel]').count(), 1)
  } finally {
    try { await electron?.close() } finally { await rm(userData, { recursive: true, force: true }) }
  }
})
