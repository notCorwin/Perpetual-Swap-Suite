import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { encodeOperationJournal, operationJournalSuffix } from '../../electron/services/operation-journal.js'
import { inspectGraphicsTrace } from '../../electron/services/graphics-trace.js'
import { operationReportHasFailures, summarizeOperations } from '../../scripts/operation-report.mjs'

const epoch = 1700000000000, sessionId = 'graphics-report-session', main = 'application-main'
const policy = { policy: 'require-accelerated', provider: 'chromium' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOwAAAABJRU5ErkJggg==', 'base64')
const json = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`)
const ordinary = { category: 'cpu', name: 'fixture.application-work', startedAt: epoch, durationMS: 2, status: 'ok', attributes: {} }

async function journalFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'graphics-report-'))
  // Match the real GPU scenario: nested operation sources and sibling captures.
  const directory = join(root, 'operations', 'native-gpu-chart')
  await mkdir(directory, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  const healthFile = executionId => join(directory, `${executionId}.health.json`)
  const participantFile = executionId => join(directory, `participant-${executionId}.participant.json`)
  async function recording(executionId, role, records = [ordinary], parentExecutionId) {
    const lifecycle = records.flatMap((record, index) => {
      const event = { schemaVersion: 2, ...record, id: `${executionId}:${index + 1}`, traceId: `${executionId}:trace`, sessionId, executionId }
      return [{ ...event, phase: 'start', sequence: index * 2 + 1, durationMS: 0, status: 'running' },
        { ...event, phase: 'end', sequence: index * 2 + 2 }]
    })
    const raw = Buffer.from(lifecycle.map(event => JSON.stringify(event)).join('\n') + '\n'), stored = encodeOperationJournal(raw)
    await writeFile(join(directory, `${executionId}${operationJournalSuffix}`), stored)
    await json(healthFile(executionId), { schemaVersion: 2, executionId, sessionId, participantId: `participant-${executionId}`, role,
      recorded: lifecycle.length, recordedOperations: records.length, persisted: lifecycle.length, durableRecords: lifecycle.length,
      failed: 0, pending: 0, sourceFailures: 0, omittedRecords: 0, activeOperations: 0, closed: true,
      journalBytes: stored.length, uncompressedBytes: raw.length, enabledHooks: ['fixture'], hookCapabilities: [] })
    await json(participantFile(executionId), { schemaVersion: 2, id: `participant-${executionId}`, executionId, role,
      status: 'ready', registeredAt: epoch, ...(parentExecutionId ? { parentExecutionId } : {}) })
  }
  return { root, directory, recording, healthFile, participantFile }
}

async function graphicsFixture(t, { gpuPids = [42] } = {}) {
  const fixture = await journalFixture(t), { root, directory, recording } = fixture
  const artifacts = join(root, 'gpu', 'chart-captures')
  await mkdir(artifacts, { recursive: true })
  const traceFile = join(directory, 'chromium-application.trace.json')
  const source = { traceEvents: [...gpuPids.map(pid => ({ ph: 'M', pid, tid: 0, name: 'process_name', args: { name: 'GPU Process' } })),
    ...['gpu', 'viz', 'disabled-by-default-gpu.service'].map((cat, index) => ({ ph: 'X', pid: 42, tid: 1, cat,
      name: 'SkiaRenderer::FinishDrawingFrame', ts: 100 + index * 10, dur: [2000, 3000, 5000][index] }))],
    metadata: { 'clock-domain': 'MAC_MACH_ABSOLUTE_TIME' } }
  const raw = `${JSON.stringify(source)}\n`, digest = createHash('sha256').update(raw).digest('hex'), native = []
  await writeFile(traceFile, raw)
  const trace = await inspectGraphicsTrace(source, { observedAt: epoch, sha256: digest, onTask: event => native.push(event) })
  trace.bytes = Buffer.byteLength(raw)
  const status = { schemaVersion: 2, executionId: main, sessionId, requested: true, enabled: true, complete: true,
    file: basename(traceFile), bufferUsage: { percentage: .1 }, trace,
    system: { probe: { state: 'ready' }, hardwareAccelerationEnabled: true, devicesKnown: true,
      features: { gpu_compositing: 'enabled', rasterization: 'enabled' }, renderer: 'ANGLE Metal Renderer: Apple M3',
      devices: [{ active: true, vendorId: 4203, deviceId: 0 }] } }
  const statusFile = join(directory, 'chromium-application.status.json'), decisionFile = join(directory, 'graphics-check-application.status.json')
  const captures = Array.from({ length: 3 }, (_, index) => join(artifacts, `chart-${index}.png`))
  for (const capture of captures) await writeFile(capture, png)
  const decision = { schemaVersion: 1, kind: 'graphics-check', ...policy, status: 'passed',
    evidence: { executionId: main, sessionId, statusFile: basename(statusFile), nativeOperationCount: native.length,
      captureFiles: captures.map(file => relative(directory, file)) } }
  const save = async () => { await json(statusFile, status); await json(decisionFile, decision) }
  const writeMain = records => recording(main, 'electron-main', [...records, { ...ordinary, durationMS: 7 }])
  await writeMain(native)
  for (const [executionId, role, parent] of [['application-backend', 'market-backend', main], ['application-renderer', 'renderer', main],
    ['application-reader', 'market-reader', 'application-backend'], ['application-writer', 'market-writer', 'application-backend'],
    ['application-prepared', 'prepared-chart', 'application-backend']]) await recording(executionId, role, [ordinary], parent)
  await save()
  return { ...fixture, native, digest, status, statusFile, traceFile, decision, decisionFile, captures, save, writeMain,
    report: options => summarizeOperations(root, { graphics: policy, ...options }) }
}

async function metalFixture(t) {
  const fixture = await graphicsFixture(t, { gpuPids: [42, 43] })
  const records = [[42, 1, 1000, 10], [42, 2, 0, 0], [43, 1, 2000, 20]].map(([processId, sequence, nativeTimestampUS, nativeDurationUS]) => ({
    category: 'gpu', name: 'gpu.metal-command-buffer', startedAt: epoch, durationMS: 0, status: 'ok', attributes: {
      source: 'native', measurement: 'device-clock', clockDomain: 'METAL_HOST_MONOTONIC', nativeEventName: 'MTLCommandBuffer',
      nativeTimestampUS, nativeDurationUS, nativeEventId: `metal:${processId}:${sequence}`, processId, sequence, nativeStatus: 4,
      ...(nativeTimestampUS === 0 ? { reason: 'native-timing-unavailable' } : {}) } }))
  const timing = { count: 2, firstTimestampUS: 1000, lastTimestampUS: 2020, minDurationUS: 10, maxDurationUS: 20 }
  const dataFile = join(fixture.root, 'gpu', 'metal-raw-report.json'), data = `${JSON.stringify({ samples: records })}\n`
  await writeFile(dataFile, data)
  const metal = { schemaVersion: 1, kind: 'metal-capability', executionId: main, sessionId,
    provider: 'metal-command-buffer', source: 'native', measurement: 'device-clock', clock: 'metal-host-monotonic-seconds',
    capability: { supported: true, loaded: true, enabled: true, complete: true }, actualGpuPids: [42, 43], issues: [], timing,
    stats: { successfulDeviceTimings: 2, completions: 3, pending: 0, nativeErrors: 0, unavailableTimingBuffers: 1 },
    processes: [42, 43].map((pid, index) => ({ pid, loaded: true, enabled: true, closed: true, limited: false, pending: 0, nativeErrors: 0, issues: [],
      timing: { count: 1, firstTimestampUS: 1000 + index * 1000, lastTimestampUS: 1010 + index * 1010, minDurationUS: 10 + index * 10, maxDurationUS: 10 + index * 10 } })),
    dataFile: relative(fixture.directory, dataFile), dataSha256: createHash('sha256').update(data).digest('hex') }
  const metalFile = join(fixture.directory, 'metal-application.status.json'), graphics = { policy: 'require-hardware-timing', provider: 'metal' }
  Object.assign(fixture.decision, graphics)
  Object.assign(fixture.decision.evidence, { metalStatusFile: basename(metalFile), metalOperationCount: records.length })
  const save = async () => { await fixture.save(); await json(metalFile, metal) }
  const writeMain = values => fixture.writeMain([...fixture.native, ...values])
  await writeMain(records); await save()
  return { ...fixture, records, metal, save, writeMain, report: () => fixture.report({ graphics }) }
}

const rejected = report => assert.equal(operationReportHasFailures(report), true, JSON.stringify(report.diagnostics))
const rejectedGraphics = (report, detail) => {
  rejected(report)
  assert.ok(report.diagnostics.graphicsCoverageFailures > 0, JSON.stringify(report.diagnostics))
  if (detail) assert.ok(report.diagnostics.examples.some(example => example.kind === 'graphicsCoverageFailures' && detail.test(example.detail ?? '')),
    `Expected ${detail}: ${JSON.stringify(report.diagnostics.examples)}`)
}

test('complete nested application evidence passes after artifact relocation and native time remains separate from wall spans', async t => {
  const fixture = await graphicsFixture(t), relocated = `${fixture.root}-relocated`
  await rename(fixture.root, relocated)
  t.after(() => rm(relocated, { recursive: true, force: true }))
  const report = await summarizeOperations(relocated, { graphics: policy })
  assert.equal(operationReportHasFailures(report), false, JSON.stringify(report.diagnostics))
  assert.equal(report.coverage.actualRoles.length, 6)
  assert.equal(report.totals.totalMS, 17)
  assert.equal(report.categories.find(value => value.category === 'gpu').totalMS, 0)
  assert.deepEqual(report.nativeTiming.map(({ measurement, clockDomain, count, totalMS }) => ({ measurement, clockDomain, count, totalMS })),
    [{ measurement: 'service-clock', clockDomain: 'MAC_MACH_ABSOLUTE_TIME', count: 3, totalMS: 10 }])
  assert.equal(report.graphics.checks[0].validatedCapabilities.nativeServiceTasks, true)
})

test('auto policy only skips confirmed unsupported hardware; missing, unknown and failed probes cannot pass', async t => {
  for (const [name, system, expected] of [
    ['unknown fields', { probe: { state: 'ready' } }, false],
    ['unknown feature status', { probe: { state: 'ready' }, hardwareAccelerationEnabled: true, devicesKnown: false, devices: [], features: { gpu_compositing: 'unknown', rasterization: 'unknown' } }, false],
    ['failed probe', { probe: { state: 'failed', reason: 'driver-query-failed' }, hardwareAccelerationEnabled: false }, false],
    ['confirmed software', { probe: { state: 'ready' }, hardwareAccelerationEnabled: false, devicesKnown: true, devices: [], renderer: 'SwiftShader', features: { gpu_compositing: 'disabled_software', rasterization: 'disabled_software' } }, true],
  ]) await t.test(name, async t => {
    const fixture = await graphicsFixture(t)
    fixture.status.system = system; fixture.status.enabled = false; fixture.status.complete = false
    fixture.decision.policy = 'auto'; fixture.decision.status = 'unsupported'
    await fixture.save()
    const report = await fixture.report({ graphics: { ...policy, policy: 'auto' } })
    if (expected) assert.equal(operationReportHasFailures(report), false, JSON.stringify(report.diagnostics))
    else rejectedGraphics(report, /Unverified unsupported/)
  })
})

test('strict policy cannot downgrade an unavailable GPU into a successful skip', async t => {
  const fixture = await graphicsFixture(t)
  fixture.status.system.hardwareAccelerationEnabled = false
  fixture.decision.status = 'unsupported'
  await fixture.save(); rejectedGraphics(await fixture.report(), /Unverified unsupported/)
})

test('graphics cannot borrow a healthy application role from another execution tree', async t => {
  const fixture = await graphicsFixture(t)
  await fixture.recording('unrelated-main', 'electron-main')
  await fixture.recording('application-prepared', 'prepared-chart', [ordinary], 'unrelated-main')
  const report = await fixture.report()
  assert.ok(report.coverage.actualRoles.includes('prepared-chart'), 'The role exists globally, but belongs to another application.')
  assert.equal(report.diagnostics.missingRequiredRoles, 0)
  rejectedGraphics(report, /every required application participant/)
})

test('graphics cannot borrow native observation counts from another main execution', async t => {
  const fixture = await graphicsFixture(t)
  await fixture.writeMain([])
  await fixture.recording('unrelated-main', 'electron-main', fixture.native)
  const report = await fixture.report()
  assert.equal(report.operations.find(value => value.name === 'gpu.native-task').count, 3)
  rejectedGraphics(report, /absent from the owning journal/)
})

test('duplicate native identities, foreign digests and wrong clocks fail even with matching operation totals', async t => {
  for (const [name, mutate] of [
    ['duplicate identity', records => { records[1].attributes.nativeEventId = records[0].attributes.nativeEventId }],
    ['foreign trace digest', records => { for (const record of records) record.attributes.nativeEventId = record.attributes.nativeEventId.replace(/^[a-f0-9]{64}/, 'b'.repeat(64)) }],
    ['foreign native clock', records => { records[0].attributes.clockDomain = 'OTHER_MONOTONIC_CLOCK' }],
  ]) await t.test(name, async t => {
    const fixture = await graphicsFixture(t), records = structuredClone(fixture.native)
    mutate(records); await fixture.writeMain(records)
    const report = await fixture.report()
    assert.equal(report.operations.find(value => value.name === 'gpu.native-task').count, 3)
    rejectedGraphics(report, name === 'duplicate identity' ? /duplicated native event identity/ : /identity or clock differs/)
  })
})

test('trace/task count discrepancies and changed raw evidence cannot be certified by a cached capability', async t => {
  for (const [name, mutate] of [
    ['missing imported task', async fixture => fixture.writeMain(fixture.native.slice(1))],
    ['incorrect cached count', async fixture => { fixture.status.trace.completedTasks++; await fixture.save() }],
    ['changed raw trace', async fixture => { await writeFile(fixture.traceFile, '{}\n') }],
  ]) await t.test(name, async t => {
    const fixture = await graphicsFixture(t)
    await mutate(fixture); rejectedGraphics(await fixture.report(), name === 'changed raw trace' ? /trace differs from its cached digest/ : /absent from the owning journal/)
  })
})

test('capture evidence must contain three distinct PNG images with valid dimensions', async t => {
  for (const [name, mutate] of [
    ['text file', async fixture => writeFile(fixture.captures[0], 'this is not a chart image')],
    ['zero width', async fixture => { const invalid = Buffer.from(png); invalid.writeUInt32BE(0, 16); await writeFile(fixture.captures[0], invalid) }],
    ['repeated capture', async fixture => { fixture.decision.evidence.captureFiles.fill(fixture.decision.evidence.captureFiles[0]); await fixture.save() }],
  ]) await t.test(name, async t => {
    const fixture = await graphicsFixture(t)
    await mutate(fixture); rejectedGraphics(await fixture.report(), /chart capture file is absent/)
  })
})

test('graphics evidence rejects absolute paths, directory escapes and symlinks outside its run', async t => {
  for (const mode of ['absolute', 'parent-escape', 'symlink-escape']) await t.test(mode, async t => {
    const fixture = await graphicsFixture(t)
    if (mode === 'absolute') fixture.decision.evidence.statusFile = fixture.statusFile
    else {
      const external = join(fixture.root, '..', `outside-${basename(fixture.root)}.png`)
      await writeFile(external, png); t.after(() => rm(external, { force: true }))
      let file = external
      if (mode === 'symlink-escape') { file = join(fixture.root, 'gpu', 'outside.png'); await symlink(external, file) }
      fixture.decision.evidence.captureFiles[0] = relative(fixture.directory, file)
    }
    await fixture.save(); rejectedGraphics(await fixture.report(), mode === 'absolute' ? /unsafe graphics capability evidence/ : /chart capture file is absent/)
  })
})

test('damaged recorder counters and native metadata fail closed instead of becoming zero work', async t => {
  for (const [field, value] of [['failed', 'corrupt'], ['sourceFailures', null], ['omittedRecords', -1], ['activeOperations', .5],
    ['recordedOperations', null], ['closed', 'true'], ['durableRecords', '2'], ['sourceFailures', undefined]]) await t.test(`${field}=${value}`, async t => {
    const fixture = await graphicsFixture(t), file = fixture.healthFile(main), health = JSON.parse(await readFile(file, 'utf8'))
    health[field] = value; await json(file, health)
    const report = await fixture.report()
    assert.ok(report.diagnostics.malformed > 0)
    rejected(report)
  })
  for (const [field, value] of [['schemaVersion', 99], ['complete', 'true']]) await t.test(`native ${field}`, async t => {
    const fixture = await graphicsFixture(t)
    fixture.status[field] = value; await fixture.save()
    const report = await fixture.report()
    assert.ok(report.diagnostics.malformed > 0)
    rejected(report)
  })
})

test('native completion observations cannot masquerade as epoch wall spans', async t => {
  const fixture = await graphicsFixture(t), records = structuredClone(fixture.native)
  records[0].durationMS = 5000
  await fixture.writeMain(records)
  const report = await fixture.report()
  assert.ok(report.diagnostics.malformed > 0)
  assert.equal(report.categories.find(value => value.category === 'gpu').totalMS, 0)
  rejected(report)
})

test('native-clock cardinality limits fail explicitly rather than silently omitting timing totals', async t => {
  const fixture = await journalFixture(t)
  const records = Array.from({ length: 33 }, (_, index) => ({ category: 'gpu', name: 'gpu.native-task', startedAt: epoch, durationMS: 0, status: 'ok',
    attributes: { source: 'native', measurement: 'service-clock', clockDomain: `NATIVE_CLOCK_${index}`, nativeTimestampUS: index,
      nativeDurationUS: 1000, nativeEventId: `${'a'.repeat(64)}:${index}`, processId: 42 } }))
  await fixture.recording(main, 'electron-main', records)
  const report = await summarizeOperations(fixture.root)
  assert.equal(report.nativeTiming.length, 32)
  assert.ok(report.diagnostics.nativeTimingLimitReached > 0)
  rejected(report)
})

test('strict Metal evidence cross-checks positive device timestamps per GPU PID while retaining unavailable zero timings', async t => {
  const fixture = await metalFixture(t), report = await fixture.report()
  assert.equal(operationReportHasFailures(report), false, JSON.stringify(report.diagnostics))
  assert.equal(report.graphics.checks[0].validatedCapabilities.hardwareTiming, true)
  const device = report.nativeTiming.find(value => value.clockDomain === 'METAL_HOST_MONOTONIC')
  assert.equal(device.count, 3); assert.equal(device.zeroTimings, 1); assert.equal(device.errors, 0)
  assert.equal(device.totalMS, .03)
})

test('Metal timing summaries cannot invent positive work or borrow another GPU process range', async t => {
  for (const [name, mutate] of [
    ['invented positive count', async fixture => { fixture.metal.stats.successfulDeviceTimings++; fixture.metal.timing.count++; fixture.metal.processes[0].timing.count++; await fixture.save() }],
    ['wrong aggregate range', async fixture => { fixture.metal.timing.firstTimestampUS++; await fixture.save() }],
    ['wrong aggregate duration', async fixture => { fixture.metal.timing.maxDurationUS++; await fixture.save() }],
    ['swapped process ranges', async fixture => { [fixture.metal.processes[0].timing, fixture.metal.processes[1].timing] = [fixture.metal.processes[1].timing, fixture.metal.processes[0].timing]; await fixture.save() }],
    ['journal positive became unavailable', async fixture => { const records = structuredClone(fixture.records); records[0].attributes.nativeTimestampUS = 0; records[0].attributes.nativeDurationUS = 0; await fixture.writeMain(records) }],
    ['journal positive became an error', async fixture => { const records = structuredClone(fixture.records); records[0].status = 'error'; await fixture.writeMain(records) }],
    ['journal changed device duration', async fixture => { const records = structuredClone(fixture.records); records[0].attributes.nativeDurationUS++; await fixture.writeMain(records) }],
    ['zero-timing native failure', async fixture => { const records = structuredClone(fixture.records); records[1].status = 'error'; records[1].attributes.nativeStatus = 5; await fixture.writeMain(records) }],
    ['wrong native status', async fixture => { const records = structuredClone(fixture.records); records[1].attributes.nativeStatus = 5; await fixture.writeMain(records) }],
  ]) await t.test(name, async t => {
    const fixture = await metalFixture(t)
    await mutate(fixture)
    rejectedGraphics(await fixture.report(), name.includes('native') ? /native error count differs/ : /timing summary differs/)
  })
})

test('Metal service-clock observations cannot stand in for command-buffer device timestamps', async t => {
  const fixture = await metalFixture(t), records = structuredClone(fixture.records)
  records[0].attributes.measurement = 'service-clock'
  await fixture.writeMain(records)
  rejectedGraphics(await fixture.report(), /validated device-clock command buffer/)
})

test('Metal per-process timing state is bounded and overflow cannot become an incomplete successful aggregate', async t => {
  const fixture = await journalFixture(t)
  const records = Array.from({ length: 33 }, (_, index) => ({ category: 'gpu', name: 'gpu.metal-command-buffer', startedAt: epoch, durationMS: 0, status: 'ok',
    attributes: { source: 'native', measurement: 'device-clock', clockDomain: 'METAL_HOST_MONOTONIC', nativeTimestampUS: 1000, nativeDurationUS: 10,
      nativeEventId: `metal:${index + 1}:1`, processId: index + 1, sequence: 1 } }))
  await fixture.recording(main, 'electron-main', records)
  const report = await summarizeOperations(fixture.root)
  assert.ok(report.diagnostics.nativeTimingLimitReached > 0)
  rejected(report)
})
