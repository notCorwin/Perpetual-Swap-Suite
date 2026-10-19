import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { installApp, quitInstalledApp, run } from './electron-delivery.mjs'
import { smokeElectron } from './smoke-electron.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const execute = promisify(execFile)
if (process.platform !== 'darwin') throw new Error('macOS is required to install the desktop app.')
if (process.argv.length > 2) throw new Error('Usage: node scripts/deliver-electron.mjs')

async function launchUserApp(appPath) {
  // Unlike fixture smoke, this is an ordinary production launch. It never seeds
  // or removes user data. Keep the old app until this profile also opens.
  let electron
  let timer
  try {
    electron = await _electron.launch({ executablePath: join(appPath, 'Contents/MacOS/Perpetual Swap Suite'),
      args: ['--disable-gpu'], timeout: 45_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined,
        PERPETUAL_SWAP_E2E: '0', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: undefined,
        PERPETUAL_SWAP_TEST_UI: 'background' } })
    const page = await electron.firstWindow({ timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('[data-layout="market-workspace"]'))
    const preferences = await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'read' } }))
    assert.ok(['5m', '15m', '1H'].includes(preferences.chartTimeframe), 'The normal user profile must initialize its settings.')
  } finally {
    const child = electron?.process()
    try {
      if (electron) await Promise.race([electron.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Normal user-profile shutdown timed out.')), 20_000)
      })])
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    if (child) assert.equal(child.exitCode, 0, 'The production profile must quit normally.')
  }
  // Verify a Finder launch with the normal data profile, without presenting a
  // window or activating the app. Verification processes exit afterwards.
  await run('open', ['-g', '-n', '-a', appPath, '--env', 'ELECTRON_RUN_AS_NODE=',
    '--env', 'ELECTRON_RENDERER_URL=', '--env', 'PERPETUAL_SWAP_E2E=0', '--env', 'PERPETUAL_SWAP_USER_DATA=',
    '--env', 'PERPETUAL_SWAP_TEST_UI=background'])
  const executable = join(appPath, 'Contents/MacOS/Perpetual Swap Suite')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { stdout } = await execute('ps', ['-axww', '-o', 'comm='])
    if (stdout.split('\n').some(command => command.trim() === executable)) {
      await quitInstalledApp(appPath)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The installed app did not restart.')
}

await run('bash', ['scripts/package-electron.sh'], { cwd: root })
const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const candidate = join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app')
const destination = '/Applications/Perpetual Swap Suite.app'
const report = await installApp({
  candidate, destination, revision,
  beforeReplace: quitInstalledApp,
  smoke: async (app, expected) => {
    const reportPath = join(root, '.build', app === candidate ? 'package-smoke.json' : 'installed-smoke.json')
    const report = await smokeElectron({ app, revision: expected, report: reportPath })
    if (app === destination) {
      try {
        await launchUserApp(app)
        report.checks.push('production user profile, normal exit, and background Finder restart')
        report.finishedAt = new Date().toISOString()
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      } catch (error) {
        await quitInstalledApp(app)
        report.ok = false
        report.error = error instanceof Error ? error.message : String(error)
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
        throw error
      }
    }
    return report
  },
})
console.log(JSON.stringify({ installed: destination, ...report }, null, 2))
