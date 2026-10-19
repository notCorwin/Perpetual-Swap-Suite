import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { graphicsAccelerationSupport, graphicsCapabilities, graphicsRequirementFailures, readGraphicsTrace } from '../../electron/services/graphics-trace.js'
import { isOperationJournal, readOperationJournal } from '../../electron/services/operation-journal.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const policy = process.env.PERPETUAL_SWAP_GPU_POLICY || 'auto'
const provider = process.env.PERPETUAL_SWAP_GPU_PROVIDER || 'chromium'
const roles = ['electron-main', 'renderer', 'market-backend', 'market-reader', 'market-writer', 'prepared-chart']
function timing(samples) {
  const positive = samples.filter(sample => sample.status === 'ok' && sample.gpuStartTime > 0 && sample.gpuEndTime > sample.gpuStartTime)
  return { count: positive.length, firstTimestampUS: positive.length ? Math.min(...positive.map(sample => sample.gpuStartTime * 1e6)) : null,
    // Use the exact numeric units written to the journal, avoiding independent
    // seconds-to-microseconds rounding of the end timestamp.
    lastTimestampUS: positive.length ? Math.max(...positive.map(sample => sample.gpuStartTime * 1e6 + sample.durationMS * 1000)) : null,
    minDurationUS: positive.length ? Math.min(...positive.map(sample => sample.durationMS * 1000)) : null,
    maxDurationUS: positive.length ? Math.max(...positive.map(sample => sample.durationMS * 1000)) : null }
}

// This scenario deliberately retains Electron's native GPU configuration. All
// windows stay hidden; foreground acceptance belongs to hosted macOS Actions.
test('hidden chart rendering validates available native GPU capability and durable source-linked records', { timeout: 45_000 }, async t => {
  assert.ok(['auto', 'require-accelerated', 'require-hardware-timing'].includes(policy))
  assert.ok(['chromium', 'metal'].includes(provider))
  const directory = await mkdtemp(join(tmpdir(), 'native-gpu-chart-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const id = randomUUID(), base = process.env.PERPETUAL_SWAP_OPERATION_DIR ?? join(root, '.build/gpu', id, 'operations')
  const operations = join(base, 'native-gpu-chart'), artifacts = join(dirname(base), 'gpu', id)
  await Promise.all([mkdir(operations, { recursive: true }), mkdir(artifacts, { recursive: true })])
  let metalAPI, metalScope, metalReport, metalStatus, metalStatusFile, electron, closed = false
  t.after(async () => { if (electron && !closed) await electron.close() })
  if (provider === 'metal') {
    metalAPI = await import('../../scripts/gpu/metal-provider.mjs')
    const executable = createRequire(import.meta.url)('electron')
    metalScope = await metalAPI.createMetalDiagnostic({ root: artifacts, executableRoot: dirname(dirname(dirname(executable))), maxBytes: 1024 * 1024, maxRecords: 4096, maxProcesses: 8 })
  }
  const launchedAt = Date.now()
  electron = await _electron.launch({ args: ['.'], cwd: root,
    env: { ...process.env, ...metalScope?.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_TEST_UI: 'background',
      PERPETUAL_SWAP_TEST_OWNER_PID: String(process.pid), PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_ALLOW_NETWORK: '0',
      PERPETUAL_SWAP_GPU_TRACE: '1', PERPETUAL_SWAP_USER_DATA: join(directory, 'user-data'), PERPETUAL_SWAP_OPERATION_DIR: operations } })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const presentation = await electron.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
      headless: app.commandLine.hasSwitch('headless'), disableGPU: app.commandLine.hasSwitch('disable-gpu') }
  })
  assert.deepEqual(presentation, { visible: false, focused: false, focusable: false, headless: false, disableGPU: false })
  const identity = await electron.evaluate((_, path) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
    const recording = require(path).initializeOperationRecording()
    return { executionId: recording.executionId, sessionId: recording.sessionId }
  }, join(root, 'electron/services/operation-runtime.js'))
  const system = await electron.evaluate(async ({ app }, path) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
    const { graphicsSystemSnapshot } = require(path)
    let timer
    try {
      const information = await Promise.race([app.getGPUInfo('complete'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GPU capability probe timed out.')), 2000) })])
      assertInventory(information)
      return graphicsSystemSnapshot(app, information, { state: 'ready' })
    } finally { clearTimeout(timer) }
    function assertInventory(value) { if (!Array.isArray(value?.gpuDevice)) throw new Error('GPU capability inventory is missing.') }
  }, join(root, 'electron/services/graphics-trace.js'))
  const support = graphicsAccelerationSupport({ system })
  assert.notEqual(support.state, 'unknown', JSON.stringify({ support, system }))
  if (support.state === 'unsupported') assert.equal(policy, 'auto', `Strict GPU policy cannot skip: ${support.reason}`)
  const captures = []
  if (support.state === 'available') {
    const request = value => page.evaluate(value => window.radarDesktop.request(value), value)
    const fixture = await request({ e2e: { action: 'seedCachedListProjection' } })
    await page.locator(`[aria-label="View ${fixture.instId} chart"]`).evaluate(element => element.click())
    for (const [index, timeframe] of ['1H', '5m', '1H'].entries()) {
      await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: new RegExp(`^${timeframe}$`, 'i') }).evaluate(element => element.click())
      const svg = page.locator(`svg[data-rendered-inst="${fixture.instId}"][data-rendered-timeframe="${timeframe}"]`)
      await svg.waitFor({ state: 'attached', timeout: 7_000 })
      const chart = await svg.evaluate(svg => {
        const rectangle = svg.getBoundingClientRect()
        return { instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe, end: Number(svg.dataset.renderedEnd), paths: svg.querySelectorAll('path').length,
          rectangle: { x: Math.floor(rectangle.x), y: Math.floor(rectangle.y), width: Math.min(320, Math.floor(rectangle.width)), height: Math.min(200, Math.floor(rectangle.height)) } }
      })
      assert.equal(chart.instId, fixture.instId); assert.equal(chart.timeframe, timeframe)
      assert.ok(chart.paths > 0 && chart.end > 0 && chart.rectangle.width > 0 && chart.rectangle.height > 0)
      const image = await request({ captureChart: { ...chart.rectangle, output: 'png' } })
      assert.ok(image.imageDataURL?.startsWith('data:image/png;base64,'))
      const png = Buffer.from(image.imageDataURL.split(',')[1], 'base64')
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.ok(png.length > 100 && png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0)
      const path = join(artifacts, `selected-chart-${index}-${timeframe}.png`)
      await writeFile(path, png)
      captures.push({ ...chart, path, pngBytes: png.length, bitmapWidth: png.readUInt32BE(16), bitmapHeight: png.readUInt32BE(20) })
    }
    assert.equal(captures[0].end, captures[2].end, 'Warm return preserves the same durable candle boundary.')
  }
  assert.deepEqual(await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused() }
  }), { visible: false, focused: false })
  if (metalScope) {
    const gpuPids = await electron.evaluate(({ app }) => app.getAppMetrics().filter(process => process.type === 'GPU').map(process => process.pid))
    const stopped = await metalAPI.stopMetalDiagnostic({ directory: metalScope.directory, token: metalScope.token, gpuPids, timeoutMS: 5000 })
    assert.equal(stopped.capability.complete, true, JSON.stringify(stopped))
    metalReport = await metalAPI.collectMetalDiagnostic({ directory: metalScope.directory, token: metalScope.token, gpuPids, captureWindows: [], durable: true })
    const dataFile = join(artifacts, 'metal-raw-report.json'), data = `${JSON.stringify(metalReport, null, 2)}\n`
    await writeFile(dataFile, data)
    metalStatus = { schemaVersion: 1, kind: 'metal-capability', ...identity, provider: metalReport.provider, source: metalReport.source,
      measurement: metalReport.measurement, clock: metalReport.clock, capability: metalReport.capability, actualGpuPids: metalReport.actualGpuPids,
      stats: metalReport.stats, issues: metalReport.issues, timing: timing(metalReport.samples),
      processes: metalReport.processes.map(process => ({ ...process, timing: timing(metalReport.samples.filter(sample => sample.pid === process.pid)) })),
      dataFile: relative(operations, dataFile), dataSha256: createHash('sha256').update(data).digest('hex') }
    metalStatusFile = join(operations, `metal-${id}.status.json`)
    await writeFile(metalStatusFile, `${JSON.stringify(metalStatus, null, 2)}\n`)
    const records = metalReport.samples.map(sample => ({ category: 'gpu', name: 'gpu.metal-command-buffer', resource: 'metal-command-buffer',
      startedAt: Date.now(), durationMS: 0, status: sample.status, attributes: { source: 'native', measurement: 'device-clock',
        nativeTimestampUS: sample.gpuStartTime * 1e6, nativeDurationUS: sample.durationMS === null ? 0 : sample.durationMS * 1000,
        nativeEventName: 'MTLCommandBuffer', clockDomain: 'METAL_HOST_MONOTONIC', processId: sample.pid, sequence: sample.sequence,
        nativeStatus: sample.nativeStatus, nativeEventId: `metal:${sample.pid}:${sample.sequence}`,
        ...(sample.durationMS === null ? { reason: 'native-timing-unavailable' } : {}) } }))
    await electron.evaluate(async (_, { operationsPath, runtimePath, records }) => {
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
      const { recordOperation } = require(operationsPath), { flushOperationRecording } = require(runtimePath)
      for (let index = 0; index < records.length; index++) { recordOperation(records[index]); if (index % 256 === 255) await flushOperationRecording({ durable: false }) }
      await flushOperationRecording()
    }, { operationsPath: join(root, 'electron/services/operations.js'), runtimePath: join(root, 'electron/services/operation-runtime.js'), records })
  }
  const exited = new Promise(resolve => electron.once('close', resolve))
  await electron.evaluate(({ app }) => app.quit()); await exited; closed = true
  const files = await readdir(operations), statusFiles = files.filter(file => /^chromium-.*\.status\.json$/.test(file))
  assert.equal(statusFiles.length, 1)
  const statusFile = join(operations, statusFiles[0]), status = JSON.parse(await readFile(statusFile, 'utf8'))
  assert.equal(status.schemaVersion, 2); assert.equal(status.executionId, identity.executionId); assert.equal(status.sessionId, identity.sessionId)
  assert.equal(status.complete, true, JSON.stringify(status))
  assert.ok(status.trace.bytes > 0 && status.trace.bytes <= 32 * 1024 * 1024)
  const source = await readGraphicsTrace(join(operations, status.file))
  assert.equal(source.sha256, status.trace.sha256); assert.equal(source.bytes, status.trace.bytes)
  const capabilities = graphicsCapabilities(status, metalStatus)
  if (support.state === 'available') assert.deepEqual(graphicsRequirementFailures(status, { requireAcceleration: true, requireNativeTasks: true,
    requireHardwareTiming: policy === 'require-hardware-timing' || provider === 'metal' }, metalStatus), [], JSON.stringify({ capabilities, metalStatus }))
  else assert.equal(graphicsAccelerationSupport(status).state, 'unsupported')
  const ids = new Set(), metalIds = new Set(), foundRoles = new Set()
  let observed = 0, observedMetal = 0
  for (const file of files.filter(isOperationJournal)) {
    for await (const line of createInterface({ input: readOperationJournal(join(operations, file)), crlfDelay: Infinity })) {
      if (!line) continue
      const event = JSON.parse(line)
      if (event.phase !== 'end' || event.executionId !== identity.executionId) continue
      if (event.name === 'gpu.native-task') {
        observed++
        assert.equal(event.durationMS, 0, 'Native timestamps cannot become fabricated epoch wall spans.')
        assert.ok(event.startedAt >= launchedAt && event.startedAt <= Date.now())
        assert.equal(event.attributes.source, 'native')
        assert.ok(['service-clock', 'device-clock'].includes(event.attributes.measurement))
        assert.ok(Number.isFinite(event.attributes.nativeTimestampUS) && event.attributes.nativeDurationUS >= 0)
        assert.equal(event.attributes.clockDomain, status.trace.clockDomain)
        const match = new RegExp(`^${source.sha256}:(0|[1-9][0-9]*)$`).exec(event.attributes.nativeEventId)
        assert.ok(match)
        const original = source.trace.traceEvents[Number(match[1])]
        assert.ok(original && ['X', 'B', 'b', 'S'].includes(original.ph))
        assert.equal(event.attributes.nativeTimestampUS, original.ts)
        assert.ok(original.cat.split(',').includes(event.attributes.nativeCategory))
        if (original.ph === 'X') assert.equal(event.attributes.nativeDurationUS, original.dur)
        assert.equal(ids.has(event.attributes.nativeEventId), false); ids.add(event.attributes.nativeEventId)
      } else if (event.name === 'gpu.metal-command-buffer') {
        observedMetal++
        const sample = metalReport.samples.find(sample => event.attributes.nativeEventId === `metal:${sample.pid}:${sample.sequence}`)
        assert.ok(sample); assert.equal(event.durationMS, 0); assert.equal(event.status, sample.status)
        assert.equal(event.attributes.source, 'native'); assert.equal(event.attributes.measurement, 'device-clock')
        assert.equal(event.attributes.clockDomain, 'METAL_HOST_MONOTONIC'); assert.equal(event.attributes.nativeEventName, 'MTLCommandBuffer')
        assert.equal(event.attributes.processId, sample.pid); assert.equal(event.attributes.sequence, sample.sequence)
        assert.equal(event.attributes.nativeTimestampUS, sample.gpuStartTime * 1e6)
        assert.equal(event.attributes.nativeDurationUS, sample.durationMS === null ? 0 : sample.durationMS * 1000)
        assert.equal(event.attributes.nativeStatus, sample.nativeStatus)
        assert.equal(metalIds.has(event.attributes.nativeEventId), false); metalIds.add(event.attributes.nativeEventId)
      }
    }
  }
  assert.equal(observed, status.trace.completedTasks)
  assert.equal(observedMetal, metalReport?.samples.length ?? 0)
  for (const file of files.filter(file => file.endsWith('.health.json'))) {
    const health = JSON.parse(await readFile(join(operations, file), 'utf8'))
    assert.ok(health.closed && health.pending === 0 && health.failed === 0 && health.sourceFailures === 0 && health.omittedRecords === 0)
    foundRoles.add(health.role)
  }
  if (support.state === 'available') for (const role of roles) assert.ok(foundRoles.has(role), `Missing native app role: ${role}`)
  await writeFile(join(artifacts, 'capture-evidence.json'), JSON.stringify({ identity, presentation, captures, capabilities, support }, null, 2))
  const decision = { schemaVersion: 1, kind: 'graphics-check', policy, provider, status: support.state === 'available' ? 'passed' : 'unsupported', capabilities,
    reason: support.reason, evidence: { ...identity, statusFile: relative(operations, statusFile), ...(metalStatusFile ? { metalStatusFile: relative(operations, metalStatusFile) } : {}),
      captureFiles: captures.map(capture => relative(operations, capture.path)), roles: [...foundRoles], nativeOperationCount: observed, metalOperationCount: observedMetal } }
  await writeFile(join(operations, `graphics-check-${id}.status.json`), `${JSON.stringify(decision, null, 2)}\n`)
  if (support.state === 'unsupported') t.skip(`GPU unsupported: ${support.reason}; capability evidence retained.`)
})
