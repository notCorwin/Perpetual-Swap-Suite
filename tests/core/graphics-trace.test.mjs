import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { graphicsAccelerationSupport, graphicsCapabilities, graphicsRequirementFailures, graphicsSystemSnapshot, inspectGraphicsTrace, readGraphicsTrace } from '../../electron/services/graphics-trace.js'
import { startGraphicsRecording } from '../../electron/services/operation-graphics.js'

const gpu = { auxAttributes: { glRenderer: 'ANGLE Metal Renderer: Apple M3', skiaBackendType: 'GraphiteDawnMetal', displayType: 'ANGLE_METAL', private: 'secret' },
  gpuDevice: [{ active: true, vendorId: 4203, deviceId: 0, driverVendor: 'Apple', driverVersion: '15.8.1', private: 'secret' }] }
const app = { getAppMetrics: () => [], isHardwareAccelerationEnabled: () => true,
  getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled', rasterization: 'enabled', private: 'secret' }), getGPUInfo: async () => gpu }
const meta = { ph: 'M', pid: 10, tid: 0, name: 'process_name', args: { name: 'GPU Process' } }
const event = value => ({ pid: 10, tid: 1, cat: 'gpu', name: 'CommandBufferStub::PerformWork', ts: 10, ...value })
const trace = events => ({ traceEvents: [meta, ...events], metadata: { 'clock-domain': 'MAC_MACH_ABSOLUTE_TIME', command_line: 'secret' } })

test('native X/synchronous nesting/async reusable IDs retain native clocks without inventing epoch spans', async () => {
  const records = []
  const summary = await inspectGraphicsTrace(trace([
    event({ ph: 'X', dur: 5, args: { token: 'secret' } }),
    event({ ph: 'B', ts: 20, name: 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' }),
    event({ ph: 'B', cat: 'ui', ts: 21, name: 'unrelated-private-name' }),
    event({ ph: 'E', cat: 'ui', ts: 22, name: 'unrelated-private-name' }),
    event({ ph: 'E', ts: 28, name: 'SkiaOutputSurfaceImplOnGpu::SwapBuffers' }),
    event({ ph: 'b', cat: 'disabled-by-default-gpu.service', id2: { local: '0x1c' }, ts: 50 }),
    event({ ph: 'e', cat: 'disabled-by-default-gpu.service', id2: { local: '0x1c' }, ts: 55 }),
    event({ ph: 'b', cat: 'disabled-by-default-gpu.service', id2: { local: '0x1c' }, ts: 60 }),
    event({ ph: 'e', cat: 'disabled-by-default-gpu.service', id2: { local: '0x1c' }, ts: 62 }),
    event({ ph: 'X', cat: 'viz', name: 'SkiaRenderer::FinishDrawingFrame', ts: 70, dur: 3 }),
    event({ ph: 'b', cat: 'disabled-by-default-gpu.device', id2: { global: '0xbeef' }, ts: 100 }),
    event({ ph: 'e', cat: 'disabled-by-default-gpu.device', id2: { global: '0xbeef' }, ts: 110, tid: 2 }),
  ]), { onTask: record => records.push(record), observedAt: 12345, sha256: 'a'.repeat(64) })
  assert.equal(summary.completedTasks, 6)
  assert.deepEqual(summary.service, { count: 5, timedCount: 5, totalUS: 23, maxUS: 8 })
  assert.deepEqual(summary.device, { count: 1, timedCount: 1, totalUS: 10, maxUS: 10 })
  assert.equal(summary.gpuProcessServiceTasks, 2)
  assert.ok(records.every(record => record.startedAt === 12345 && record.durationMS === 0 && record.attributes.source === 'native'))
  assert.deepEqual(records.map(record => record.attributes.nativeDurationUS), [5, 8, 5, 2, 3, 10])
  assert.ok(records.every(record => record.attributes.clockDomain === 'MAC_MACH_ABSOLUTE_TIME'))
  assert.equal(records.at(-1).attributes.nativeTimestampUS, 100)
  assert.equal(records.at(-1).attributes.measurement, 'device-clock')
  assert.equal(new Set(records.map(record => record.attributes.nativeEventId)).size, 6)
  assert.ok(!JSON.stringify(records).includes('secret'))
  assert.ok(!JSON.stringify(summary).includes('secret'))
  const status = { enabled: true, complete: true, system: graphicsSystemSnapshot(app, gpu), trace: summary }
  assert.deepEqual(graphicsRequirementFailures(status, { requireAcceleration: true, requireNativeTasks: true }), [])
  assert.deepEqual(graphicsRequirementFailures(status, { requireHardwareTiming: true }), ['hardware-gpu-timing-unavailable'])
})

test('completed CPU/service GPU tasks and a complete file cannot satisfy hardware timing or software acceleration', async () => {
  const summary = await inspectGraphicsTrace(trace([event({ ph: 'X', dur: 500 })]))
  const status = { enabled: true, complete: true, system: graphicsSystemSnapshot(app, gpu), trace: summary }
  assert.equal(graphicsCapabilities(status).nativeTrace, true)
  assert.equal(graphicsCapabilities(status).hardwareTiming, false)
  assert.deepEqual(graphicsRequirementFailures(status, { requireHardwareTiming: true }), ['hardware-gpu-timing-unavailable'])
  status.system = graphicsSystemSnapshot({ ...app, getGPUFeatureStatus: () => ({ gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }) }, gpu)
  assert.deepEqual(graphicsRequirementFailures(status, { requireAcceleration: true }), ['hardware-acceleration-unavailable'])
  status.system = graphicsSystemSnapshot(app, { ...gpu, auxAttributes: { glRenderer: 'ANGLE Google SwiftShader' } })
  assert.equal(graphicsCapabilities(status).hardwareAcceleration, false)
})

test('partial capture slices are reported and never fabricated; malformed/disjoint timers do not become hardware time', async () => {
  const records = []
  const summary = await inspectGraphicsTrace(trace([
    event({ ph: 'B', ts: 1 }), event({ ph: 'E', ts: 2, name: 'different' }),
    event({ ph: 'X', ts: 3, dur: -1 }), event({ ph: 'X', ts: 4, dur: null }),
    event({ ph: 'B', ts: 5 }),
    event({ ph: 'e', cat: 'viz', ts: 9, id: 'orphan' }),
    event({ ph: 'X', cat: 'disabled-by-default-gpu.device', name: 'DisjointEvent-0xabcd', ts: 10, dur: 4 }),
  ]), { onTask: record => records.push(record) })
  assert.equal(summary.completedTasks, 1)
  assert.equal(summary.diagnostics.unmatchedBegins, 1)
  assert.equal(summary.diagnostics.unmatchedEnds, 1)
  assert.equal(summary.diagnostics.mismatchedEnds, 1)
  assert.equal(summary.diagnostics.invalidEvents, 2)
  assert.equal(summary.diagnostics.disjointEvents, 1)
  assert.equal(summary.device.count, 0)
  assert.equal(records[0].status, 'error')
  assert.equal(graphicsCapabilities({ enabled: true, complete: true, trace: summary }).hardwareTiming, false)
})

test('unknown native clock stays explicit and private dynamic labels are redacted', async () => {
  const records = []
  const summary = await inspectGraphicsTrace({ traceEvents: [meta, event({ ph: 'X', dur: 4, name: 'https://private.test/account/secret' })] },
    { onTask: record => records.push(record), observedAt: 900 })
  assert.equal(summary.clockDomain, 'unknown')
  assert.equal(records[0].attributes.nativeTimestampUS, 10)
  assert.equal(records[0].startedAt, 900)
  assert.equal(records[0].attributes.nativeEventName, 'other-native-task')
  assert.ok(!JSON.stringify(records).includes('private.test'))
  const untrusted = await inspectGraphicsTrace({ traceEvents: [meta, event({ ph: 'X', cat: 'disabled-by-default-gpu.device', dur: 100, name: 'ArbitraryTimer' })] })
  assert.deepEqual(graphicsRequirementFailures({ enabled: true, complete: true, system: graphicsSystemSnapshot(app, gpu), trace: untrusted },
    { requireHardwareTiming: true }), ['hardware-gpu-timing-unavailable'])
})

test('strict hardware timing requires accelerated, healthy, same-clock Metal evidence from the actual GPU PID', async () => {
  const summary = await inspectGraphicsTrace(trace([event({ ph: 'X', dur: 5 })]))
  const status = { executionId: 'main', sessionId: 'session', enabled: true, complete: true, system: graphicsSystemSnapshot(app, gpu), trace: summary }
  const positive = { count: 1, firstTimestampUS: 100, lastTimestampUS: 110, minDurationUS: 10, maxDurationUS: 10 }
  const metal = { schemaVersion: 1, executionId: 'main', sessionId: 'session', kind: 'metal-capability', provider: 'metal-command-buffer', source: 'native', measurement: 'device-clock', clock: 'metal-host-monotonic-seconds',
    capability: { supported: true, complete: true, loaded: true, enabled: true }, issues: [], actualGpuPids: [10], stats: { successfulDeviceTimings: 1, pending: 0, nativeErrors: 0 }, timing: positive,
    processes: [{ pid: 10, loaded: true, enabled: true, closed: true, limited: false, pending: 0, nativeErrors: 0, issues: [], timing: positive }] }
  assert.equal(graphicsCapabilities(status, metal).hardwareTiming, true)
  for (const change of [value => { value.clock = 'unknown' }, value => { value.capability.complete = false }, value => { value.actualGpuPids = [11] },
    value => { value.processes[0].closed = false }, value => { value.stats.pending = 1 }, value => { value.stats.nativeErrors = 1 },
    value => { value.timing.minDurationUS = 0 }, value => { value.processes[0].timing.count = 2 }, value => { value.executionId = 'other-main' },
    value => { value.capability.loaded = false }]) {
    const invalid = structuredClone(metal); change(invalid)
    assert.equal(graphicsCapabilities(status, invalid).hardwareTiming, false, JSON.stringify(invalid))
  }
  const software = { ...status, system: graphicsSystemSnapshot({ ...app, getGPUFeatureStatus: () => ({ gpu_compositing: 'disabled_software' }) }, gpu) }
  assert.equal(graphicsCapabilities(software, metal).hardwareTiming, false)
  assert.equal(graphicsCapabilities({ ...status, trace: { ...summary, gpuProcessIds: [10, 11] } }, metal).hardwareTiming, false,
    'A provider subset cannot hide a restarted GPU process from the same trace.')
  assert.equal(graphicsAccelerationSupport(software).state, 'unsupported')
  const unavailable = graphicsSystemSnapshot({ ...app, getGPUFeatureStatus: () => ({ gpu_compositing: 'unavailable_software' }) }, gpu)
  assert.equal(graphicsAccelerationSupport({ system: unavailable }).state, 'unsupported')
  assert.equal(graphicsAccelerationSupport({ system: graphicsSystemSnapshot(app) }).state, 'unknown')
  assert.equal(graphicsAccelerationSupport({ system: graphicsSystemSnapshot(app, { gpuDevice: [] }) }).state, 'unsupported')
})

test('native buffer loss is explicit; event and active-stack bounds fail instead of silently dropping work', async () => {
  const input = trace([event({ ph: 'X', dur: 1 })])
  input.metadata.trace_processor_stats = { traced_buf: [{ bytes_overwritten: 8 }], track_event_parser_errors: 1 }
  const result = await inspectGraphicsTrace(input)
  assert.equal(result.diagnostics.producerDataLoss, 8)
  assert.equal(result.diagnostics.parserWarnings, 1)
  await assert.rejects(inspectGraphicsTrace(input, { maxEvents: 1 }), /event limit/)
  await assert.rejects(inspectGraphicsTrace(trace([event({ ph: 'B' }), event({ ph: 'B', ts: 11 })]), { maxActive: 1 }), /active-event limit/)
})

test('large native task batches drain incrementally and file reads retain a content digest under a hard byte bound', async t => {
  const counts = [], records = []
  await inspectGraphicsTrace(trace(Array.from({ length: 300 }, (_, index) => event({ ph: 'X', dur: 1, ts: index }))),
    { onTask: record => records.push(record), flush: async () => { counts.push(records.length) } })
  assert.deepEqual(counts, [256, 300])
  const directory = await mkdtemp(join(tmpdir(), 'graphics-bound-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'native.json')
  await writeFile(file, JSON.stringify(trace([event({ ph: 'X', dur: 1 })])))
  const source = await readGraphicsTrace(file)
  assert.match(source.sha256, /^[a-f0-9]{64}$/)
  assert.ok(source.bytes > 0)
  await assert.rejects(readGraphicsTrace(file, { maxBytes: 4 }), /byte limit/)
})

test('graphics stop imports each completed task once, flushes before success, and records fresh driver capabilities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graphics-stop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.PERPETUAL_SWAP_GPU_TRACE
  process.env.PERPETUAL_SWAP_GPU_TRACE = '1'
  t.after(() => { if (previous === undefined) delete process.env.PERPETUAL_SWAP_GPU_TRACE; else process.env.PERPETUAL_SWAP_GPU_TRACE = previous })
  const records = [], flushes = []
  let stops = 0
  const tracing = { startRecording: async configuration => assert.equal(configuration.trace_buffer_size_in_kb, 8192),
    getTraceBufferUsage: async () => ({ percentage: .1 }), stopRecording: async path => { stops++; await writeFile(path, JSON.stringify(trace([event({ ph: 'X', dur: 4 })]))); return path } }
  const stop = await startGraphicsRecording(app, tracing, directory, { record: value => records.push(value), flush: async options => flushes.push(options), identity: { sessionId: 'session', executionId: 'main' } })
  const [one, two] = await Promise.all([stop(), stop()])
  assert.equal(one, two)
  assert.equal(stops, 1)
  assert.equal(records.filter(value => value.name === 'gpu.native-task').length, 1)
  assert.ok(flushes.some(value => value?.durable === false))
  assert.equal(flushes.at(-1), undefined)
  const status = JSON.parse(await readFile(join(directory, (await readdir(directory)).find(file => file.endsWith('.status.json'))), 'utf8'))
  assert.equal(status.complete, true)
  assert.equal(status.executionId, 'main'); assert.equal(status.sessionId, 'session')
  assert.ok(!status.file.includes('/'), 'Native source metadata remains portable with its owning status.')
  assert.equal((await readdir(directory)).some(file => file.endsWith('.tmp')), false)
  assert.equal(status.capabilities.hardwareAcceleration, true)
  assert.equal(status.capabilities.hardwareTiming, false)
  assert.equal(status.trace.completedTasks, 1)
  assert.match(status.trace.sha256, /^[a-f0-9]{64}$/)
})

test('trace-disabled runs probe real device capability and timeout stays unknown despite late resolution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graphics-probe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.PERPETUAL_SWAP_GPU_TRACE
  delete process.env.PERPETUAL_SWAP_GPU_TRACE
  t.after(() => { if (previous === undefined) delete process.env.PERPETUAL_SWAP_GPU_TRACE; else process.env.PERPETUAL_SWAP_GPU_TRACE = previous })
  const stop = await startGraphicsRecording(app, {}, directory, { record: () => {}, flush: async () => {} })
  const disabled = await stop()
  assert.equal(disabled.enabled, false); assert.equal(disabled.system.probe.state, 'ready')
  assert.equal(disabled.capabilities.hardwareAcceleration, true)
  let resolve
  const delayed = new Promise(done => { resolve = done })
  const stopDelayed = await startGraphicsRecording({ ...app, getGPUInfo: () => delayed }, {}, directory, { probeTimeoutMS: 5, record: () => {}, flush: async () => {} })
  const timeout = await stopDelayed()
  assert.equal(timeout.system.probe.state, 'error'); assert.equal(timeout.systemError, 'GpuInfoTimeout')
  assert.equal(graphicsAccelerationSupport(timeout).state, 'unknown')
  resolve(gpu); await Promise.resolve()
  assert.equal(timeout.system.probe.state, 'error', 'Late probe completion must not rewrite a timed-out result.')
})

test('duration and buffer limits remain incomplete despite valid native tasks and cannot satisfy strict native coverage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graphics-limit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.PERPETUAL_SWAP_GPU_TRACE
  process.env.PERPETUAL_SWAP_GPU_TRACE = '1'
  t.after(() => { if (previous === undefined) delete process.env.PERPETUAL_SWAP_GPU_TRACE; else process.env.PERPETUAL_SWAP_GPU_TRACE = previous })
  for (const durationLimited of [true, false]) {
    let traceStopped, timeout
    const captured = new Promise((resolve, reject) => { traceStopped = resolve; timeout = setTimeout(() => reject(new Error('Capture limit did not stop recording.')), 500) })
    const tracing = { startRecording: async () => {}, getTraceBufferUsage: async () => ({ percentage: durationLimited ? .1 : 1 }),
      stopRecording: async path => { await writeFile(path, JSON.stringify(trace([event({ ph: 'X', dur: 4 })]))); traceStopped(); return path } }
    const stop = await startGraphicsRecording(app, tracing, directory, { maxDurationMS: durationLimited ? 1 : 30_000, record: () => {}, flush: async () => {} })
    const result = durationLimited ? (await captured, await stop()) : await stop()
    clearTimeout(timeout)
    assert.equal(result.complete, false)
    assert.equal(result.captureLimitReached, durationLimited)
    assert.equal(result.trace.completedTasks, 1)
    assert.deepEqual(graphicsRequirementFailures(result, { requireNativeTasks: true }), ['native-gpu-service-tasks-missing'])
  }
})
