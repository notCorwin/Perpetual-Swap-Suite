import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { _electron } from 'playwright'
import { summarizeOperations } from '../../scripts/operation-report.mjs'
import { isOperationJournal, readOperationJournal } from '../../electron/services/operation-journal.js'

test('Electron persists actual renderer, graphics and database work across worker shutdown', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = process.env.PERPETUAL_SWAP_OPERATION_DIR
    ? join(process.env.PERPETUAL_SWAP_OPERATION_DIR, 'desktop-recording-test') : join(directory, 'operations')
  const electron = await _electron.launch({ args: ['.', '--headless'], cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1',
      PERPETUAL_SWAP_USER_DATA: join(directory, 'user-data'), PERPETUAL_SWAP_OPERATION_DIR: operations,
      PERPETUAL_SWAP_GPU_TRACE: '1' } })
  let closed = false
  t.after(async () => { if (!closed) await electron.close() })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
  const step = 300_000, through = Math.floor(Date.now() / step) * step - step
  const candles = Array.from({ length: 250 }, (_, index) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m',
    timestamp: through - (249 - index) * step, open: 100, high: 102, low: 99, close: 101, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true }))
  await request({ e2e: { action: 'seedCandles', candles } })
  await request({ chartWindow: { instId: 'BTC-USDT-SWAP', timeframe: '5m', historyBars: 96 } })
  const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click()
  await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^1H$/i }).click()
  await page.locator(`svg[data-rendered-inst="${fixture.instId}"][data-rendered-timeframe="1H"]`).waitFor()
  const capture = await request({ captureChart: { x: 0, y: 0, width: 160, height: 100, output: 'png' } })
  assert.ok(capture.imageDataURL.startsWith('data:image/png;base64,'))
  // Exercise the app's normal quit contract so backend, native graphics and
  // journal shutdown finish before inspecting their durable output.
  const exited = new Promise(resolve => electron.once('close', resolve))
  await electron.evaluate(({ app }) => { app.quit() })
  await exited; closed = true
  const report = await summarizeOperations(operations, { requireCategories: ['cpu', 'gpu', 'database', 'io', 'ipc'],
    requireRoles: ['electron-main', 'renderer', 'market-backend', 'market-writer', 'market-reader', 'prepared-chart'] })
  assert.equal(report.diagnostics.malformed, 0)
  assert.equal(report.diagnostics.pendingRecords, 0)
  assert.equal(report.diagnostics.persistenceFailures, 0)
  for (const key of ['sourceFailures', 'sequenceGaps', 'duplicateSequences', 'unclosedOperations', 'unmatchedEnds', 'unclaimedParticipants', 'missingRequiredCategories', 'missingRequiredRoles']) assert.equal(report.diagnostics[key], 0, key)
  for (const name of ['market.append', 'indicators.replay', 'chart.capture', 'chart.encode-png', 'chart.geometry', 'chart.svg.construct', 'desktop.request', 'desktop.request.execute', 'worker.execute']) {
    assert.ok(report.groups.some(group => group.name === name && group.count > 0), `Missing ${name} in durable operation log.`)
  }
  const files = await readdir(operations)
  const health = await Promise.all(files.filter(file => file.endsWith('.health.json')).map(async file => JSON.parse(await readFile(join(operations, file), 'utf8'))))
  assert.ok(health.length >= 4, 'Main/backend/database/compute workers need distinct execution journals.')
  assert.ok(health.every(value => value.closed && value.pending === 0 && value.failed === 0))
  const records = (await Promise.all(files.filter(isOperationJournal).map(async file => {
    const events = []
    const lines = createInterface({ input: readOperationJournal(join(operations, file)), crlfDelay: Infinity })
    for await (const line of lines) if (line) events.push(JSON.parse(line))
    return events
  }))).flat()
  assert.ok(records.length > 0)
  assert.equal(records.length, health.reduce((count, value) => count + value.recorded, 0), 'Every admitted record must survive decoding across all executions.')
  assert.ok(records.every(record => record.schemaVersion === 2 && ['start', 'end'].includes(record.phase)))
  if (process.env.PERPETUAL_SWAP_OPERATION_SCENARIO) assert.ok(records.every(record => record.scenarioId === process.env.PERPETUAL_SWAP_OPERATION_SCENARIO), 'Every execution must retain the sandbox scenario identity.')
  const completed = new Map(records.filter(record => record.phase === 'end').map(record => [record.id, record]))
  assert.ok([...completed.values()].some(record => {
    const parent = completed.get(record.parentId)
    return parent && parent.executionId !== record.executionId && parent.traceId === record.traceId
  }), 'Renderer/main/worker operations must preserve a real causal trace across execution boundaries.')
  const graphics = await Promise.all(files.filter(file => file.endsWith('.status.json')).map(async file => JSON.parse(await readFile(join(operations, file), 'utf8'))))
  assert.equal(graphics.length, 1)
  assert.equal(graphics[0].enabled, true)
  assert.equal(graphics[0].complete, true)
  assert.ok(files.some(file => file.endsWith('.trace.json')))
})
