import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { once } from 'node:events'
import { DuckDBInstance } from '@duckdb/node-api'
import { inspectApp } from './electron-delivery.mjs'
import { backgroundTestEnvironment, prepareBackgroundApp } from './electron-test-runtime.mjs'
import { assertIndicatorLegends, openChart } from './chart-acceptance.mjs'

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
  const prepared = await prepareBackgroundApp({ sourceApp: artifact.app, executableName: 'Perpetual Swap Suite' })
  const userData = await mkdtemp(join(tmpdir(), 'perpetual-swap-package-smoke-'))
  const report = { app: artifact.app, revision, dirty: artifact.metadata.dirty, checks: [], startedAt: new Date().toISOString(),
    verification: { kind: 'background-replica', sourceApp: artifact.app, sourceExecutable: artifact.executable,
      sourceFingerprint: prepared.sourceFingerprint, testedApp: prepared.app, testedExecutable: prepared.executable,
      containerChanges: ['LSBackgroundOnly=true', 'LSUIElement=false', 'test bundle identifiers', 'ad-hoc signature'],
      renderer: 'offscreen', productionAppLaunched: false, nativeVisiblePaint: false } }
  let electron
  let page
  const errors = []
  const request = value => deadline(page.evaluate(value => window.radarDesktop.request(value), value), 'Desktop request')
  const legacy = { instrument: 'LEGACY-USDT-SWAP', timeframe: '5m', timestamp: Date.UTC(2024, 0, 1), expiresAt: Date.UTC(2024, 0, 2) }
  const legacyDirectory = join(userData, 'MarketData', 'candles', 'timeframe=5m', 'instrument=LEGACY-USDT-SWAP', 'date=2024-01-01')
  const legacyFile = join(legacyDirectory, 'base-200-smoke.parquet')
  const close = async () => {
    const running = electron
    if (!running) return
    const child = running.process()
    try {
      await deadline(running.close(), 'Normal app shutdown', 20_000)
      assert.equal(child.exitCode, 0, 'The app must exit normally.')
    } catch (error) {
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
      executablePath: prepared.executable,
      args: ['--disable-gpu', `--user-data-dir=${userData}`],
      timeout: 45_000,
      env: backgroundTestEnvironment(prepared, {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_RENDERER_URL: undefined,
        PERPETUAL_SWAP_E2E: '1',
        PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0',
        PERPETUAL_SWAP_USER_DATA: userData,
      }),
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
        offscreen: windows[0]?.webContents.isOffscreen(), visible: windows[0]?.isVisible(),
        focused: windows[0]?.isFocused(), focusable: windows[0]?.isFocusable(),
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
        sandbox: preferences?.sandbox,
      }
    })
    assert.equal(window.count, 1)
    assert.equal(window.packaged, true)
    assert.equal(window.executable, prepared.executable, 'Smoke must launch only the guarded packaged replica.')
    assert.equal(window.offscreen, true, 'Packaged smoke must keep its real renderer offscreen.')
    assert.equal(window.visible, false)
    assert.equal(window.focused, false)
    assert.equal(window.focusable, false)
    assert.equal(window.contextIsolation, true)
    assert.equal(window.nodeIntegration, false)
    assert.equal(window.sandbox, true)
    const status = await request({ e2e: { action: 'smokeStatus' } })
    assert.equal(status.revision, revision, 'The running main process must report the packaged build revision.')
    assert.equal(resolve(status.userData), resolve(userData), 'Smoke must use only its isolated user data.')
    assert.ok(status.backendThreadId > 0, 'Market coordination must run outside Electron main.')
    return status
  }
  try {
    // Build the previous format in the Node smoke controller. The candidate
    // must import it through its own packaged Electron-as-Node child process.
    await mkdir(legacyDirectory, { recursive: true })
    const legacyEngine = await DuckDBInstance.create(':memory:'), legacyDB = await legacyEngine.connect()
    try {
      const destination = `'${legacyFile.replaceAll("'", "''")}'`
      await legacyDB.run(`COPY(SELECT 'LEGACY-USDT-SWAP'::VARCHAR AS instrument, '5m'::VARCHAR AS timeframe,
        ${legacy.timestamp}::BIGINT AS timestamp, 100::DOUBLE AS open, 103::DOUBLE AS high, 99::DOUBLE AS low, 102::DOUBLE AS close,
        20::DOUBLE AS volume, 0.2::DOUBLE AS baseVolume, 20.4::DOUBLE AS quoteVolume, true AS confirmed,
        1234::DOUBLE AS oi, 8::DOUBLE AS buy, 12::DOUBLE AS sell, 1::INTEGER AS statisticsVersion,
        ${legacy.expiresAt}::BIGINT AS statisticsOIExpiresAt, ${legacy.expiresAt}::BIGINT AS statisticsTakerExpiresAt,
        ${legacy.timestamp + 300_000}::BIGINT AS writtenAt
        UNION ALL SELECT 'LEGACY-USDT-SWAP'::VARCHAR, '5m'::VARCHAR, ${legacy.timestamp + 300_000}::BIGINT,
        100::DOUBLE, 103::DOUBLE, 99::DOUBLE, 102::DOUBLE, 20::DOUBLE, 0.2::DOUBLE, 20.4::DOUBLE, true,
        NULL::DOUBLE, NULL::DOUBLE, NULL::DOUBLE, 11::INTEGER, ${legacy.expiresAt}::BIGINT, ${legacy.expiresAt}::BIGINT,
        ${legacy.timestamp + 600_000}::BIGINT) TO ${destination} (FORMAT PARQUET)`)
    } finally { legacyDB.closeSync(); legacyEngine.closeSync() }
    await launch()
    report.checks.push('guarded packaged replica: executable, revision, offscreen window, preload isolation')
    const readLegacy = async () => {
      const rows = await request({ e2e: { action: 'readCandles', instrument: legacy.instrument,
        timeframe: legacy.timeframe, from: legacy.timestamp, through: legacy.timestamp + 300_000 } })
      assert.equal(rows.length, 2, 'The packaged native importer must return numeric facts and unavailable-source evidence.')
      for (const [index, row] of rows.entries()) {
        for (const [field, expected] of Object.entries({ timestamp: legacy.timestamp + index * 300_000, open: 100, high: 103, low: 99, close: 102,
          volume: 20, baseVolume: 0.2, quoteVolume: 20.4, confirmed: true })) assert.equal(row[field], expected, `Imported ${field} must preserve its original value and unit.`)
        assert.ok(Math.abs(row.quoteVolume / row.baseVolume - row.close) < 1e-12)
      }
      const [numeric, unavailable] = rows
      for (const [field, expected] of Object.entries({ oi: 1234, buy: 8, sell: 12, statisticsVersion: 11,
        statisticsOIExpiresAt: null, statisticsTakerExpiresAt: null })) assert.equal(numeric[field], expected, `Numeric ${field} must follow the canonical non-expiring facts contract.`)
      assert.equal(numeric.buy + numeric.sell, numeric.volume)
      for (const [field, expected] of Object.entries({ oi: null, buy: null, sell: null, statisticsVersion: 11,
        statisticsOIExpiresAt: legacy.expiresAt, statisticsTakerExpiresAt: legacy.expiresAt })) assert.equal(unavailable[field], expected, `Unavailable ${field} must preserve its original expired observation proof.`)
      return rows
    }
    const importedLegacy = await readLegacy()
    report.checks.push('packaged Electron-as-Node native import: OHLC, contract/base/quote units and original statistics proof')
    const streamingLiquidity = await deadline(electron.evaluate(async ({ app: desktopApp }) => {
      const { join: joinPath } = process.getBuiltinModule('node:path')
      const { pathToFileURL, fileURLToPath } = process.getBuiltinModule('node:url')
      const requireModule = process.getBuiltinModule('node:module').createRequire(joinPath(desktopApp.getAppPath(), 'package.json'))
      const serviceURL = pathToFileURL(joinPath(desktopApp.getAppPath(), 'electron/services/stream-liquidity.js')).href
      const preferencesURL = pathToFileURL(joinPath(desktopApp.getAppPath(), 'electron/services/preferences.js')).href
      const { StreamLiquidityEvaluator } = requireModule(fileURLToPath(serviceURL))
      const { DEFAULT_PREFERENCES } = requireModule(fileURLToPath(preferencesURL))
      const config = structuredClone(DEFAULT_PREFERENCES.liquidity)
      for (const [key, criterion] of Object.entries(config)) criterion.enabled = key === 'depth' || key === 'slippage'
      const evaluator = new StreamLiquidityEvaluator()
      try {
        const result = await evaluator.evaluate({
          instrument: {
            instId: 'BTC-USDT-SWAP', instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear',
            state: 'live', ruleType: 'normal', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC',
          },
          ticker: { last: '100', bidPx: '99.99', askPx: '100' },
          book: { bids: [['99.99', '1000000']], asks: [['100', '1000000']] },
          config,
        })
        return { serviceURL, threadId: evaluator.worker?.threadId, result }
      } finally { await evaluator.close() }
    }), 'Packaged streaming liquidity worker', 20_000)
    assert.ok(streamingLiquidity.serviceURL.includes('/app.asar/electron/services/stream-liquidity.js'), 'Streaming liquidity must load from the candidate app archive.')
    assert.ok(Number.isSafeInteger(streamingLiquidity.threadId) && streamingLiquidity.threadId > 0, 'Streaming liquidity must execute in a packaged worker thread.')
    assert.equal(streamingLiquidity.result.eligible, true)
    assert.equal(streamingLiquidity.result.status, 'verified')
    assert.equal(streamingLiquidity.result.depthBid, 999_900, 'Contract sizes must convert to USDT depth using the explicit contract value.')
    assert.equal(streamingLiquidity.result.depthAsk, 1_000_000)
    assert.equal(streamingLiquidity.result.bidSlippage, 0)
    assert.equal(streamingLiquidity.result.askSlippage, 0)
    assert.deepEqual(streamingLiquidity.result.checks.filter(check => ['depth', 'slippage'].includes(check.key)).map(check => check.status), ['verified', 'verified'])
    report.checks.push('packaged streaming liquidity worker')
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
    assert.ok(files.some(file => file.endsWith('market.sqlite')), 'The durable fixture must create the canonical SQLite database.')
    report.checks.push('SQLite WAL writes and reads in dedicated workers')
    await openChart(page, fixture)
    const prepared = await request({ chartHistory: { instId: fixture.instId, timeframe: fixture.timeframe, endHour: fixture.end } })
    assert.ok(prepared.bars.length >= 96, 'The packaged worker must prepare a complete chart.')
    const latest = prepared.bars.find(bar => bar.hour === fixture.end)
    assert.ok(latest)
    assert.equal(latest.close, saved.close)
    assert.ok(Number.isFinite(latest.ema), 'Worker indicator calculations must be initialized.')
    assert.ok(Number.isFinite(latest.atrPercent), 'The packaged worker must initialize ATR%.')
    assert.ok(Number.isFinite(latest.bbw), 'The packaged worker must initialize BBW.')
    await assertIndicatorLegends(page)
    report.checks.push('packaged ATR% and BBW worker values and shared renderer panel')
    const status = await request({ e2e: { action: 'smokeStatus' } })
    assert.ok(Number.isSafeInteger(status.preparedWorkerThreadId) && status.preparedWorkerThreadId > 0, 'Chart preparation must run in the packaged worker.')
    report.checks.push('packaged chart worker and initialized indicators')
    await close()
    report.checks.push('normal exit')
    await writeFile(legacyFile, 'Retained recovery source intentionally invalidated after durable import.')
    await launch()
    assert.deepEqual(await readCandles(), saved, 'Completed candles must survive process restart.')
    assert.deepEqual(await readLegacy(), importedLegacy, 'Restart must reuse SQLite facts without rereading the retained archive.')
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
