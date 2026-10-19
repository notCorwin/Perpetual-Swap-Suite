import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { recordOperation } from './operations.js'

// SVG rendering is submitted to Chromium, not to application GPU kernels.
// Process samples expose contention/memory; only native trace events can expose
// driver/compositor tasks. Neither metric is presented as hardware GPU time.
export async function startGraphicsRecording(app, contentTracing, directory) {
  const sample = () => {
    for (const process of app.getAppMetrics().filter(value => value.type === 'GPU')) {
      recordOperation({ category: 'gpu', name: 'gpu.process-sample', startedAt: Date.now(), durationMS: 0, status: 'ok',
        attributes: { measurement: 'process-sample', cpuPercent: process.cpu.percentCPUUsage,
          residentKB: process.memory.workingSetSize, processId: process.pid } })
    }
  }
  sample()
  const timer = setInterval(sample, 5000); timer.unref()
  const id = `${process.pid}-${randomUUID()}`
  const status = { schemaVersion: 1, enabled: process.env.PERPETUAL_SWAP_GPU_TRACE === '1',
    measurement: 'Chromium GPU/compositor events; hardware timing depends on platform support',
    complete: false, bufferUsage: null, features: app.getGPUFeatureStatus() }
  const statusPath = join(directory, `chromium-${id}.status.json`)
  if (status.enabled) {
    try { await contentTracing.startRecording({ included_categories: ['gpu', 'viz', 'cc', 'disabled-by-default-gpu.service'],
      recording_mode: 'record-until-full', trace_buffer_size_in_kb: 32768, enable_argument_filter: true }) }
    catch (error) { status.error = error.name; status.enabled = false }
  }
  await writeFile(statusPath, JSON.stringify(status, null, 2), { mode: 0o600 })
  return async () => {
    clearInterval(timer); sample()
    if (status.enabled) {
      try {
        status.bufferUsage = await contentTracing.getTraceBufferUsage()
        status.file = await contentTracing.stopRecording(join(directory, `chromium-${id}.trace.json`))
        status.complete = status.bufferUsage.percentage < 1
      } catch (error) { status.error = error.name }
    }
    await writeFile(statusPath, JSON.stringify(status, null, 2), { mode: 0o600 })
  }
}
