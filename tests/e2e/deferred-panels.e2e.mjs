import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

for (const panel of ['settings', 'analysis']) test(`a missing ${panel} chunk leaves the market workspace usable`, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-deferred-panel-'))
  let electron
  try {
    electron = await _electron.launch({ args: ['.', '--disable-gpu'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.locator('[data-market-status-row]').waitFor()
    await electron.evaluate(({ BrowserWindow }, chunk) => {
      BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url.includes(chunk) }))
    }, panel === 'settings' ? '/WorkspaceSettings-' : '/ChartAnalysisPanel-')
    if (panel === 'settings') await page.getByRole('link', { name: 'Settings', exact: true }).click()
    else {
      await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
      await page.getByRole('button', { name: 'Indicators', exact: true }).click()
      await page.getByRole('button', { name: 'Analyze Long', exact: true }).click()
    }
    const region = page.getByRole('region', { name: panel === 'settings' ? 'Settings' : 'Chart analysis', exact: true })
    await region.getByRole('alert').waitFor({ timeout: 10_000 })
    assert.match(await region.textContent(), /could not load.*Restart the app/)
    await region.getByRole('button', { name: panel === 'settings' ? 'Close settings' : 'Close chart analysis', exact: true }).click()
    await region.waitFor({ state: 'detached' })
    await page.locator('[data-market-status-row]').waitFor()
    assert.equal(await page.locator('[data-chart-panel]').count(), 1)
  } finally {
    try { await electron?.close() } finally { await rm(userData, { recursive: true, force: true }) }
  }
})
