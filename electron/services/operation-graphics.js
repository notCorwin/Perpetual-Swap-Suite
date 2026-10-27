import { open, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { recordOperation, withOperationSuppressed } from './operations.js'
import { flushOperationRecording, initializeOperationRecording } from './operation-runtime.js'
import { graphicsCapabilities, graphicsSystemSnapshot, inspectGraphicsTrace, readGraphicsTrace } from './graphics-trace.js'

// Process CPU/RSS samples, service-thread clocks, and hardware device clocks are
// separate measurements. Native timestamps never become guessed epoch spans.
export async function startGraphicsRecording(app, contentTracing, directory,
  { maxDurationMS = 30_000, maxBufferKB = 8192, probeTimeoutMS = 2000, record = recordOperation, flush = flushOperationRecording,
    identity = initializeOperationRecording() } = {}) {
  if (!Number.isSafeInteger(maxDurationMS) || maxDurationMS < 1 || maxDurationMS > 120_000) throw new RangeError('Invalid graphics trace duration limit.')
  if (!Number.isSafeInteger(maxBufferKB) || maxBufferKB < 256 || maxBufferKB > 8192) throw new RangeError('Invalid graphics trace buffer limit.')
  if (!Number.isSafeInteger(probeTimeoutMS) || probeTimeoutMS < 1 || probeTimeoutMS > 10_000) throw new RangeError('Invalid graphics information timeout.')
  const sample = () => {
    for (const process of app.getAppMetrics().filter(value => value.type === 'GPU')) {
      record({ category: 'gpu', name: 'gpu.process-sample', startedAt: Date.now(), durationMS: 0, status: 'ok',
        attributes: { measurement: 'process-sample', cpuPercent: process.cpu.percentCPUUsage,
          residentKB: process.memory.workingSetSize, processId: process.pid } })
    }
  }
  sample()
  const sampleTimer = setInterval(sample, 5000); sampleTimer.unref()
  const id = `${process.pid}-${randomUUID()}`, statusPath = join(directory, `chromium-${id}.status.json`)
  const requested = process.env.PERPETUAL_SWAP_GPU_TRACE === '1'
  const status = { schemaVersion: 2, sessionId: identity?.sessionId ?? null, executionId: identity?.executionId ?? null,
    requested, enabled: false, complete: false, measurement: 'Native task completion observations; service and device clocks remain separate from epoch wall spans.',
    limits: { maxDurationMS, maxBufferKB }, bufferUsage: null, captureLimitReached: false,
    system: graphicsSystemSnapshot(app) }
  let statusWrite = Promise.resolve()
  const save = () => {
    const contents = JSON.stringify({ ...status, ...(status.file ? { file: basename(status.file) } : {}) }, null, 2)
    statusWrite = statusWrite.then(() => withOperationSuppressed(async () => {
      const temporary = `${statusPath}.${randomUUID()}.tmp`
      let file
      try {
        file = await open(temporary, 'wx', 0o600)
        await file.writeFile(contents); await file.sync(); await file.close(); file = null
        await rename(temporary, statusPath)
      } finally {
        await file?.close()
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    }))
    return statusWrite
  }
  const probe = async () => {
    let timer
    try {
      const information = await Promise.race([Promise.resolve().then(() => app.getGPUInfo('complete')),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('GPU information timed out.'), { name: 'GpuInfoTimeout' })), probeTimeoutMS) })])
      if (!information || !Array.isArray(information.gpuDevice)) throw Object.assign(new Error('GPU information has no device inventory.'), { name: 'GpuInfoInvalid' })
      status.system = graphicsSystemSnapshot(app, information, { state: 'ready' })
    } catch (error) {
      status.system = graphicsSystemSnapshot(app, undefined, { state: 'error', reason: error.name })
      status.systemError = error.name
    } finally { clearTimeout(timer) }
    status.features = status.system.features
  }
  let durationTimer, capture, stopped
  const finishCapture = reason => capture ??= (async () => {
    clearTimeout(durationTimer)
    status.captureLimitReached = reason === 'duration-limit'
    if (status.enabled) {
      try {
        status.bufferUsage = await contentTracing.getTraceBufferUsage()
        status.file = await contentTracing.stopRecording(join(directory, `chromium-${id}.trace.json`))
        const source = await withOperationSuppressed(() => readGraphicsTrace(status.file))
        status.trace = await inspectGraphicsTrace(source.trace, { sha256: source.sha256, onTask: record,
          flush: () => flush({ durable: false }) })
        status.trace.bytes = source.bytes
        await flush()
        const percentage = status.bufferUsage?.percentage
        status.complete = !status.captureLimitReached && Number.isFinite(percentage) && percentage >= 0 && percentage < 1
          && status.trace.diagnostics.invalidEvents === 0 && status.trace.diagnostics.mismatchedEnds === 0
          && status.trace.diagnostics.producerDataLoss === 0
      } catch (error) { status.error = error.name; status.complete = false }
    }
    // Even trace-disabled runs expose a bounded, honest device/driver snapshot.
    await probe()
    status.capabilities = graphicsCapabilities(status)
    await save()
    return status
  })()
  if (requested) {
    try {
      await contentTracing.startRecording({ included_categories: ['gpu', 'viz', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.device'],
        recording_mode: 'record-until-full', trace_buffer_size_in_kb: maxBufferKB, enable_argument_filter: true })
      status.enabled = true
      durationTimer = setTimeout(() => { void finishCapture('duration-limit').catch(error => console.error('Graphics recording failed:', error.name)) }, maxDurationMS)
      durationTimer.unref()
    } catch (error) { status.error = error.name }
  }
  status.capabilities = graphicsCapabilities(status)
  try { await save() } catch (error) { clearInterval(sampleTimer); clearTimeout(durationTimer); throw error }
  return () => stopped ??= (async () => {
    clearInterval(sampleTimer); sample()
    return finishCapture('shutdown')
  })()
}
