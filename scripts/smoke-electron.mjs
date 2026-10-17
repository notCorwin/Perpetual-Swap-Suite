import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { once } from 'node:events'
import { inspectApp } from './electron-delivery.mjs'

async function deadline(work, label, milliseconds = 60_000) {
  let timer
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

export async function smokeElectron({ app, revision, report: reportPath }) {
  assert.match(revision ?? '', /^[0-9a-f]{40}$/i, 'Smoke requires the full expected Git revision.')
  const artifact = await inspectApp(app, revision)
  const userData = await mkdtemp(join(tmpdir(), 'perpetual-swap-package-smoke-'))
  const report = { app: artifact.app, revision, dirty: artifact.metadata.dirty, checks: [], startedAt: new Date().toISOString() }
  let electron
  let page
  const errors = []
  const request = value => deadline(page.evaluate(value => window.radarDesktop.request(value), value), 'Desktop request')
  const close = async () => {
    const running = electron
    if (!running) return
    try {
      await deadline(running.close(), 'Normal app shutdown', 20_000)
      assert.equal(running.process().exitCode, 0, 'The app must exit normally.')
    } catch (error) {
      const child = running.process()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await deadline(exited, 'Forced app shutdown', 10_000)
      }
      throw error
    } finally { electron = undefined }
  }
  const launch = async () => {
    electron = await _electron.launch({
      executablePath: artifact.executable,
      args: ['--disable-gpu', `--user-data-dir=${userData}`],
      timeout: 45_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_RENDERER_URL: undefined,
        PERPETUAL_SWAP_E2E: '1',
        PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
        PERPETUAL_SWAP_USER_DATA: userData,
      },
    })
    page = await electron.firstWindow({ timeout: 30_000 })
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.locator('#root').waitFor({ state: 'attached' })
    await page.waitForFunction(() => Boolean(document.querySelector('#root')?.children.length))
    const renderer = await page.evaluate(() => ({
      bridge: typeof window.radarDesktop?.request,
      node: typeof window.require,
      electron: typeof window.process,
      url: location.href,
    }))
    assert.equal(renderer.bridge, 'function', 'The packaged preload must expose the desktop bridge.')
    assert.equal(renderer.node, 'undefined', 'The renderer must not expose require.')
    assert.equal(renderer.electron, 'undefined', 'The renderer must not expose process.')
    assert.ok(renderer.url.startsWith('file://') && renderer.url.includes('/app.asar/dist/index.html'), 'The app must load the packaged renderer.')
    const window = await electron.evaluate(({ BrowserWindow, app: desktopApp }) => {
      const windows = BrowserWindow.getAllWindows()
      const preferences = windows[0]?.webContents.getLastWebPreferences()
      return {
        count: windows.length, executable: process.execPath, packaged: desktopApp.isPackaged,
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
        sandbox: preferences?.sandbox,
      }
    })
    assert.equal(window.count, 1)
    assert.equal(window.packaged, true)
    assert.equal(window.executable, artifact.executable, 'Smoke must launch the candidate executable.')
    assert.equal(window.contextIsolation, true)
    assert.equal(window.nodeIntegration, false)
    assert.equal(window.sandbox, true)
    const status = await request({ e2e: { action: 'smokeStatus' } })
    assert.equal(status.revision, revision, 'The running main process must report the packaged build revision.')
    assert.equal(resolve(status.userData), resolve(userData), 'Smoke must use only its isolated user data.')
    return status
  }
  try {
    await launch()
    report.checks.push('packaged executable, revision, window, preload isolation')
    const fixture = await request({ e2e: { action: 'seedChartScrollBenchmark' } })
    assert.equal(typeof fixture.instId, 'string')
    assert.ok(Number.isSafeInteger(fixture.end))
    const readCandles = async () => {
      const rows = await request({ e2e: {
        action: 'readCandles', instrument: fixture.instId,
        timeframe: fixture.timeframe, from: fixture.end, through: fixture.end,
      } })
      assert.equal(rows.length, 1)
      const expected = fixture.series[fixture.timeframe].bars.at(-1)
      assert.equal(rows[0].timestamp, fixture.end)
      assert.equal(rows[0].close, expected.close)
      assert.equal(rows[0].confirmed, true)
      return rows[0]
    }
    const saved = await readCandles()
    const files = await readdir(userData, { recursive: true })
    assert.ok(files.some(file => file.endsWith('.parquet')), 'The durable fixture must create Parquet files.')
    report.checks.push('DuckDB writes and reads durable Parquet')
    const prepared = await request({ chartWindow: { instId: fixture.instId, timeframe: fixture.timeframe, endHour: fixture.end } })
    assert.ok(prepared.bars.length >= 96, 'The packaged worker must prepare a complete chart.')
    const latest = prepared.bars.find(bar => bar.hour === fixture.end)
    assert.ok(latest)
    assert.equal(latest.close, saved.close)
    assert.ok(Number.isFinite(latest.ema), 'Worker indicator calculations must be initialized.')
    const status = await request({ e2e: { action: 'smokeStatus' } })
    assert.ok(Number.isSafeInteger(status.preparedWorkerThreadId) && status.preparedWorkerThreadId > 0, 'Chart preparation must run in the packaged worker.')
    report.checks.push('packaged chart worker and initialized indicators')
    await close()
    report.checks.push('normal exit')
    await launch()
    assert.deepEqual(await readCandles(), saved, 'Completed candles must survive process restart.')
    await close()
    assert.deepEqual(errors, [], 'The packaged renderer must not raise page errors.')
    report.checks.push('restart, revision, and persistent history')
    report.ok = true
    return report
  } catch (error) {
    report.ok = false
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    try { await close() } finally {
      await rm(userData, { recursive: true, force: true })
      report.finishedAt = new Date().toISOString()
      if (reportPath) {
        await mkdir(dirname(resolve(reportPath)), { recursive: true })
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    app: { type: 'string' }, revision: { type: 'string' }, report: { type: 'string' },
  } })
  if (!values.app || !values.revision) throw new Error('Usage: node scripts/smoke-electron.mjs --app PATH --revision SHA [--report PATH]')
  console.log(JSON.stringify(await smokeElectron(values), null, 2))
}
