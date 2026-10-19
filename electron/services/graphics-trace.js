import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

export const graphicsTraceLimits = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxEvents: 250_000, maxActive: 4096, batchSize: 256, maxNames: 64 })
const enabled = value => typeof value === 'string' && /^enabled(?:_|$)/.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const timestamp = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const sourceCategory = value => {
  if (typeof value !== 'string' || value.length > 1024) return undefined
  const groups = value.split(',')
  return ['disabled-by-default-gpu.device', 'disabled-by-default-gpu.service', 'gpu', 'viz'].find(group => groups.includes(group))
}
const scalarID = value => typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value)
const asyncKey = event => {
  const global = event.id2?.global, local = event.id2?.local, id = event.id
  const scope = typeof event.scope === 'string' && /^[\w.-]{0,40}$/.test(event.scope) ? event.scope : ''
  if (scalarID(global)) return `global:${event.cat}:${scope}:${global}`
  if (scalarID(local)) return `local:${event.pid}:${event.cat}:${scope}:${local}`
  if (scalarID(id)) return `legacy:${event.pid}:${event.cat}:${scope}:${id}`
}
function nativeName(value) {
  if (typeof value !== 'string' || value.length > 1024) return 'other-native-task'
  const lambda = value.match(/^auto (?:viz::|cc::)?((?:Skia|Gpu|GPU|CommandBuffer|Scheduler|Display|Tile)[A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)?)/)
  if (lambda) return lambda[1].slice(0, 160)
  const name = value.replace(/-0x[0-9a-f]+/gi, '').replace(/\([^)]*\)$/, '')
  return /^(?:Skia|Gpu|GPU|CommandBuffer|Scheduler|Display|Graphics|Surface|SyncToken|SharedImage|Tile|Dawn|Raster|Renderer|RenderThread|Image|Buffer|Layer|Overlay|Swap|Wait|CALayer|Output|Texture|Copy|Transfer|Vulkan|GL|Gr|Draw|Frame|Flush|Submit|Begin|End|Receive|Compositor|Viz)[A-Za-z0-9_.:-]{0,145}$/.test(name)
    ? name.slice(0, 160) : 'other-native-task'
}
const totals = () => ({ count: 0, timedCount: 0, totalUS: 0, maxUS: 0 })
const add = (aggregate, duration) => { aggregate.count++; if (duration > 0) aggregate.timedCount++; aggregate.totalUS += duration; aggregate.maxUS = Math.max(aggregate.maxUS, duration) }

/** Read once with a hard byte bound, including files that grow after stat. */
export async function readGraphicsTrace(file, { maxBytes = graphicsTraceLimits.maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > graphicsTraceLimits.maxBytes) throw new RangeError('Invalid native trace byte limit.')
  const chunks = [], digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file, { highWaterMark: Math.min(maxBytes + 1, 64 * 1024) })) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new RangeError('Native graphics trace exceeds its byte limit.')
    chunks.push(chunk); digest.update(chunk)
  }
  return { trace: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')), bytes, sha256: digest.digest('hex') }
}

/**
 * Chrome JSON ts/dur are microseconds on the trace clock. No epoch conversion is
 * inferred. Each imported operation is an instantaneous completion observation;
 * its native timing stays in explicit native attributes, outside wall spans.
 * Event arguments, native async IDs, arbitrary names, and command lines never
 * enter the journal/cache. Exact source data remains in the raw trace file.
 */
export async function inspectGraphicsTrace(trace, { onTask = () => {}, flush = async () => {}, observedAt = Date.now(),
  sha256 = 'unhashed', maxEvents = graphicsTraceLimits.maxEvents, maxActive = graphicsTraceLimits.maxActive } = {}) {
  if (!Array.isArray(trace?.traceEvents)) throw new TypeError('Native graphics trace has no event array.')
  if (!integer(maxEvents) || maxEvents < 1 || maxEvents > graphicsTraceLimits.maxEvents || trace.traceEvents.length > maxEvents) throw new RangeError('Native graphics trace exceeds its event limit.')
  if (!integer(maxActive) || maxActive < 1 || maxActive > graphicsTraceLimits.maxActive) throw new RangeError('Invalid native trace active-event limit.')
  if (!timestamp(observedAt)) throw new TypeError('Invalid native trace observation timestamp.')
  if (!/^(?:[a-f0-9]{64}|unhashed)$/.test(sha256)) throw new TypeError('Invalid native trace digest.')
  const domain = trace.metadata?.['clock-domain']
  const clockDomain = typeof domain === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(domain) ? domain : 'unknown'
  const summary = { schemaVersion: 1, eventCount: trace.traceEvents.length, sha256, clockDomain,
    completedTasks: 0, service: totals(), device: totals(), gpuProcessTasks: 0, gpuProcessVizTasks: 0,
    gpuProcessServiceTasks: 0, deviceGpuTimedCount: 0, relevantGpuTasks: 0, gpuProcessIds: [], nativeNames: [], nameOverflow: 0,
    diagnostics: { invalidEvents: 0, unmatchedBegins: 0, unmatchedEnds: 0, mismatchedEnds: 0, disjointEvents: 0, producerDataLoss: 0, parserWarnings: 0 } }
  const gpuPids = new Set(), names = new Map(), stacks = new Map()
  const stats = trace.metadata?.trace_processor_stats
  if (stats && typeof stats === 'object') {
    for (const key of ['traced_chunks_discarded', 'traced_patches_discarded', 'traced_final_flush_failed', 'traced_flushes_failed', 'trace_writer_packet_loss']) {
      if (Number.isFinite(stats[key]) && stats[key] > 0) summary.diagnostics.producerDataLoss += stats[key]
    }
    for (const buffer of Array.isArray(stats.traced_buf) ? stats.traced_buf.slice(0, 32) : []) {
      for (const key of ['bytes_overwritten', 'chunks_discarded', 'chunks_overwritten', 'data_loss_chunk_corrupted', 'data_loss_orphan_continuation',
        'data_loss_overwrite', 'data_loss_read_gap', 'data_loss_reassembly_broken_chain', 'data_loss_reassembly_gap', 'data_loss_smb_full',
        'data_loss_writer_abort', 'incremental_sequences_dropped', 'sequence_packet_loss', 'trace_writer_packet_loss']) {
        if (Number.isFinite(buffer?.[key]) && buffer[key] > 0) summary.diagnostics.producerDataLoss += buffer[key]
      }
    }
    for (const key of ['track_event_parser_errors', 'track_event_tokenizer_errors']) if (Number.isFinite(stats[key]) && stats[key] > 0) summary.diagnostics.parserWarnings += stats[key]
  }
  for (const event of trace.traceEvents) if (event?.ph === 'M' && event.name === 'process_name' && event.args?.name === 'GPU Process' && integer(event.pid)) {
    if (gpuPids.size >= 64 && !gpuPids.has(event.pid)) throw new RangeError('Native trace exceeds its GPU process limit.')
    gpuPids.add(event.pid)
  }
  summary.gpuProcessIds = [...gpuPids]
  let active = 0, sinceFlush = 0
  const push = (key, value) => {
    if (++active > maxActive) throw new RangeError('Native graphics trace exceeds its active-event limit.')
    const stack = stacks.get(key) ?? []; stack.push(value); stacks.set(key, stack)
  }
  const pop = key => {
    const stack = stacks.get(key)
    if (!stack?.length) return undefined
    const value = stack.pop(); active--
    if (!stack.length) stacks.delete(key)
    return value
  }
  const emit = (event, duration, index) => {
    const category = sourceCategory(event.cat)
    if (!category) return
    if (!integer(event.pid) || !integer(event.tid) || !timestamp(event.ts) || !timestamp(duration)) { summary.diagnostics.invalidEvents++; return }
    const device = category === 'disabled-by-default-gpu.device', disjoint = device && String(event.name).startsWith('DisjointEvent')
    if (disjoint) summary.diagnostics.disjointEvents++
    const measurement = device ? 'device-clock' : 'service-clock', name = nativeName(event.name)
    if (!disjoint) add(device ? summary.device : summary.service, duration)
    summary.completedTasks++
    if (gpuPids.has(event.pid)) {
      if (category === 'gpu') summary.gpuProcessTasks++
      if (category === 'viz') summary.gpuProcessVizTasks++
      if (category === 'disabled-by-default-gpu.service') summary.gpuProcessServiceTasks++
      if (device && !disjoint && duration > 0) summary.deviceGpuTimedCount++
      if (/^(?:SkiaRenderer|SkiaOutputSurfaceImplOnGpu|GpuRasterBuffer|CommandBufferStub::PerformWork)/.test(name)) summary.relevantGpuTasks++
    }
    if (names.has(name)) names.get(name).count++
    else if (names.size < graphicsTraceLimits.maxNames) names.set(name, { name, count: 1 })
    else summary.nameOverflow++
    onTask({ category: 'gpu', name: 'gpu.native-task', resource: 'chromium-graphics', startedAt: observedAt,
      durationMS: 0, status: disjoint ? 'error' : 'ok', attributes: { source: 'native', measurement,
        nativeEventName: name, nativeCategory: category, nativeEventId: `${sha256}:${index}`, nativeTimestampUS: event.ts,
        nativeDurationUS: duration, clockDomain, processId: event.pid, threadId: event.tid,
        ...(disjoint ? { reason: 'gpu-clock-disjoint' } : {}) } })
    sinceFlush++
  }
  for (let index = 0; index < trace.traceEvents.length; index++) {
    const event = trace.traceEvents[index]
    if (!event || typeof event !== 'object' || Array.isArray(event)) { summary.diagnostics.invalidEvents++; continue }
    const category = sourceCategory(event.cat)
    if (event.ph === 'X') { if (category) emit(event, event.dur, index) }
    else if (event.ph === 'B') {
      if (!integer(event.pid) || !integer(event.tid) || !timestamp(event.ts)) { if (category) summary.diagnostics.invalidEvents++; continue }
      // All synchronous B/E slices affect nesting, including unselected domains.
      push(`thread:${event.pid}:${event.tid}`, { event, index, category })
    } else if (event.ph === 'E') {
      if (!integer(event.pid) || !integer(event.tid) || !timestamp(event.ts)) {
        if (category || stacks.has(`thread:${event.pid}:${event.tid}`)) summary.diagnostics.invalidEvents++
        continue
      }
      const begin = pop(`thread:${event.pid}:${event.tid}`)
      if (!begin) { if (category) summary.diagnostics.unmatchedEnds++; continue }
      if (event.name !== undefined && event.name !== '' && event.name !== begin.event.name) { if (category || begin.category) summary.diagnostics.mismatchedEnds++; continue }
      if (begin.category) emit(begin.event, event.ts - begin.event.ts, begin.index)
    } else if (['b', 'e', 'S', 'F'].includes(event.ph) && category) {
      const key = asyncKey(event)
      if (!key || !integer(event.pid) || !integer(event.tid) || !timestamp(event.ts)) { summary.diagnostics.invalidEvents++; continue }
      if (event.ph === 'b' || event.ph === 'S') push(`async:${key}`, { event, index, category })
      else {
        const begin = pop(`async:${key}`)
        if (!begin) { summary.diagnostics.unmatchedEnds++; continue }
        if (event.name !== undefined && event.name !== '' && event.name !== begin.event.name) { summary.diagnostics.mismatchedEnds++; continue }
        emit(begin.event, event.ts - begin.event.ts, begin.index)
      }
    }
    if (sinceFlush >= graphicsTraceLimits.batchSize) { await flush(); sinceFlush = 0 }
  }
  for (const stack of stacks.values()) for (const value of stack) if (value.category) summary.diagnostics.unmatchedBegins++
  if (sinceFlush) await flush()
  summary.nativeNames = [...names.values()]
  return summary
}

/** Keep only driver and capability fields; extensions, paths and arguments stay out. */
export function graphicsSystemSnapshot(app, information, probe = { state: information ? 'ready' : 'pending' }) {
  const features = app.getGPUFeatureStatus(), aux = information?.auxAttributes ?? {}
  return { probe, hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(), devicesKnown: Array.isArray(information?.gpuDevice),
    features: Object.fromEntries(['gpu_compositing', 'rasterization', 'opengl', 'skia_graphite', 'webgl', 'webgpu'].map(key =>
      [key, typeof features?.[key] === 'string' && /^(enabled|disabled|unavailable)(?:_[a-z_]+)?$/.test(features[key]) ? features[key] : 'unknown'])),
    renderer: typeof aux.glRenderer === 'string' ? aux.glRenderer.slice(0, 240) : '',
    backend: typeof aux.skiaBackendType === 'string' ? aux.skiaBackendType.slice(0, 80) : '',
    displayType: typeof aux.displayType === 'string' ? aux.displayType.slice(0, 80) : '',
    devices: (Array.isArray(information?.gpuDevice) ? information.gpuDevice : []).slice(0, 8).map(device => ({
      active: device.active === true, vendorId: integer(device.vendorId) ? device.vendorId : null,
      deviceId: integer(device.deviceId) ? device.deviceId : null,
      driverVendor: typeof device.driverVendor === 'string' ? device.driverVendor.slice(0, 80) : '',
      driverVersion: typeof device.driverVersion === 'string' ? device.driverVersion.slice(0, 80) : '' })) }
}

const timingSummary = (value, count) => value?.count === count && integer(count) && (count === 0
  ? value.firstTimestampUS === null && value.lastTimestampUS === null && value.minDurationUS === null && value.maxDurationUS === null
  : timestamp(value.firstTimestampUS) && value.firstTimestampUS > 0 && timestamp(value.lastTimestampUS) && value.lastTimestampUS > value.firstTimestampUS
    && timestamp(value.minDurationUS) && value.minDurationUS > 0 && timestamp(value.maxDurationUS) && value.maxDurationUS >= value.minDurationUS)

export function graphicsCapabilities(status, metal) {
  const system = status.system, trace = status.trace
  const hardwareAcceleration = system?.probe?.state === 'ready' && system.hardwareAccelerationEnabled === true && enabled(system.features?.gpu_compositing)
    && enabled(system.features?.rasterization) && Boolean(system.devices?.some(device => device.active && device.vendorId > 0))
    && Boolean(system.renderer) && !/swiftshader|llvmpipe|softpipe|software/i.test(system.renderer)
  const nativeTrace = status.enabled === true && status.complete === true && (trace?.completedTasks ?? 0) > 0
  const nativeServiceTasks = nativeTrace && trace.gpuProcessTasks > 0 && trace.gpuProcessVizTasks > 0
    && trace.gpuProcessServiceTasks > 0 && trace.relevantGpuTasks > 0
  // Chromium gpu/viz/service slices are host-thread work. A gpu.device category
  // alone does not establish a trusted timer provider or clock interpretation.
  const pids = metal?.actualGpuPids, processes = metal?.processes, stats = metal?.stats
  const hardwareTiming = Boolean(hardwareAcceleration && nativeTrace && metal?.schemaVersion === 1 && metal.kind === 'metal-capability'
    && typeof status.executionId === 'string' && status.executionId.length > 0 && typeof status.sessionId === 'string' && status.sessionId.length > 0
    && metal.executionId === status.executionId && metal.sessionId === status.sessionId
    && metal.provider === 'metal-command-buffer' && metal.source === 'native' && metal.measurement === 'device-clock'
    && metal.clock === 'metal-host-monotonic-seconds' && metal.capability?.supported === true && metal.capability.complete === true
    && metal.capability.loaded === true && metal.capability.enabled === true
    && Array.isArray(metal.issues) && metal.issues.length === 0 && stats?.nativeErrors === 0 && stats.pending === 0
    && integer(stats.successfulDeviceTimings) && stats.successfulDeviceTimings > 0 && timingSummary(metal.timing, stats.successfulDeviceTimings)
    && Array.isArray(pids) && pids.length > 0 && new Set(pids).size === pids.length && Array.isArray(processes)
    && pids.length === trace.gpuProcessIds?.length
    && pids.every(pid => integer(pid) && trace.gpuProcessIds?.includes(pid) && processes.filter(value => value.pid === pid).length === 1
      && processes.some(value => value.pid === pid && value.loaded === true && value.enabled === true && value.closed === true
        && value.limited === false && value.pending === 0 && value.nativeErrors === 0 && Array.isArray(value.issues) && value.issues.length === 0
        && timingSummary(value.timing, value.timing?.count)))
    && pids.reduce((sum, pid) => sum + processes.find(value => value.pid === pid).timing.count, 0) === metal.timing.count)
  return { hardwareAcceleration, nativeTrace, nativeServiceTasks, hardwareTiming,
    hardwareTimingReason: hardwareTiming ? 'Validated completed Metal command-buffer timestamps were observed for the actual accelerated GPU process.'
      : 'No validated hardware device-clock timing was observed for this rendering backend and capture.' }
}

/** Unknown or failed probes are failures, never evidence that hardware is absent. */
export function graphicsAccelerationSupport(status) {
  const system = status?.system
  if (system?.probe?.state !== 'ready') return { state: 'unknown', reason: system?.probe?.reason ?? 'gpu-information-not-ready' }
  if (graphicsCapabilities(status).hardwareAcceleration) return { state: 'available', reason: 'hardware-acceleration-observed' }
  if (system.hardwareAccelerationEnabled === false) return { state: 'unsupported', reason: 'hardware-acceleration-disabled' }
  if (/swiftshader|llvmpipe|softpipe|software/i.test(system.renderer ?? '')
    || /^(?:disabled|unavailable)_software$/.test(system.features?.gpu_compositing ?? '')
    || /^(?:disabled|unavailable)_software$/.test(system.features?.rasterization ?? '')) return { state: 'unsupported', reason: 'software-rendering-observed' }
  if (system.devicesKnown === true && system.devices?.length === 0) return { state: 'unsupported', reason: 'gpu-device-unavailable' }
  return { state: 'unknown', reason: 'hardware-acceleration-not-established' }
}

export function graphicsRequirementFailures(status, { requireAcceleration = false, requireNativeTasks = false, requireHardwareTiming = false } = {}, metal) {
  const capabilities = graphicsCapabilities(status, metal), failures = []
  if (requireAcceleration && !capabilities.hardwareAcceleration) failures.push('hardware-acceleration-unavailable')
  if (requireNativeTasks && !capabilities.nativeServiceTasks) failures.push('native-gpu-service-tasks-missing')
  if (requireHardwareTiming && !capabilities.hardwareTiming) failures.push('hardware-gpu-timing-unavailable')
  return failures
}
