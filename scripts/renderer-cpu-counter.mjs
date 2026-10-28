import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const units = Object.freeze({
  Timestamp: 'Chromium monotonic wall-clock seconds',
  ThreadTime: 'renderer main-thread CPU seconds',
  ProcessTime: 'renderer whole-process CPU seconds',
  TaskDuration: 'renderer main-thread CPU seconds (threadTicks)',
  ScriptDuration: 'renderer main-thread CPU seconds (threadTicks)',
  LayoutDuration: 'renderer main-thread CPU seconds (threadTicks)',
  RecalcStyleDuration: 'renderer main-thread CPU seconds (threadTicks)',
  DevToolsCommandDuration: 'renderer main-thread CPU seconds (threadTicks)',
  V8CompileDuration: 'renderer main-thread CPU seconds (threadTicks)',
  TaskOtherDuration: 'renderer main-thread CPU seconds (threadTicks)',
  JSHeapUsedSize: 'bytes',
  JSHeapTotalSize: 'bytes',
})

// console.timeStamp(prefix + JSON.stringify({ at, timeOrigin, phase, index }))
// samples cumulative counters at the marker, without a sampled CPU profiler.
export async function startRendererCPUCounter(page, { label = 'chart', capacity = 8_192, directory } = {}) {
  if (typeof label !== 'string' || !Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('Invalid renderer CPU counter options.')
  const id = randomUUID(), markerPrefix = `renderer-cpu:${id}:`, samples = [], captureErrors = []
  const artifact = join(resolve(directory ?? process.env.PERPETUAL_SWAP_PROCESS_WITNESS_DIRECTORY ?? '.build/process-witness'),
    `renderer-cpu-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 120)}-${id}.json`)
  let session, stopped, previous, origin, active = true, totalSamples = 0, droppedSamples = 0, droppedCaptureErrors = 0
  const failed = (stage, error) => {
    if (captureErrors.length < 32) captureErrors.push({ stage, message: String(error?.message ?? error) })
    else droppedCaptureErrors++
  }
  const record = event => {
    if (!active || typeof event.title !== 'string' || !event.title.startsWith(markerPrefix)) return
    try {
      const marker = JSON.parse(event.title.slice(markerPrefix.length))
      if (!Number.isFinite(marker.at) || marker.at < 0 || !Number.isFinite(marker.timeOrigin) || marker.timeOrigin < 0
        || !Number.isSafeInteger(marker.index) || marker.index < 0 || typeof marker.phase !== 'string' || !marker.phase || marker.phase.length > 32) {
        throw new Error('A CPU marker has invalid renderer clock metadata.')
      }
      if (!Array.isArray(event.metrics)) throw new Error('A CPU marker has no Chromium counters.')
      const metrics = Object.fromEntries(event.metrics.filter(metric => Object.hasOwn(units, metric.name)
        && Number.isFinite(metric.value) && metric.value >= 0).map(metric => [metric.name, metric.value]))
      if (!Number.isFinite(metrics.ThreadTime) || !Number.isFinite(metrics.Timestamp)) {
        failed('metrics', 'A CPU marker lacks finite ThreadTime or Timestamp evidence.')
      }
      if (origin === undefined) origin = marker.timeOrigin
      if (marker.timeOrigin !== origin || previous && marker.at < previous.at
        || previous && Number.isFinite(metrics.Timestamp) && metrics.Timestamp < previous.metrics.Timestamp
        || previous && Number.isFinite(metrics.ThreadTime) && metrics.ThreadTime < previous.metrics.ThreadTime) {
        failed('clock', 'Renderer CPU evidence changed clock origin or reversed a cumulative clock.')
      }
      if (marker.index !== (previous ? previous.index + 1 : 0)) {
        failed('sequence', 'Renderer CPU marker indices have a gap, duplicate or reversal.')
      }
      const sample = { at: marker.at, timeOrigin: marker.timeOrigin, phase: marker.phase, index: marker.index, metrics }
      samples.push(sample); previous = sample
      totalSamples++
      if (samples.length > capacity) { samples.shift(); droppedSamples++ }
    } catch (error) { failed('marker', error) }
  }
  const stop = () => stopped ??= (async () => {
    if (session) {
      try { await session.send('Performance.disable') }
      catch (error) { failed('disable', error) }
      finally {
        try { await session.detach() }
        catch (error) { failed('detach', error) }
        finally { active = false; session.off('Performance.metrics', record) }
      }
    } else active = false
    if (!totalSamples) failed('markers', 'No matching renderer CPU markers were captured.')
    const retained = samples.map(sample => Object.freeze({ ...sample, metrics: Object.freeze({ ...sample.metrics }) }))
    const report = Object.freeze({ schemaVersion: 1, label, artifact, timeDomain: 'threadTicks',
      measurement: 'Cumulative Chromium counters at explicit renderer markers; ThreadTime measures main-thread CPU, not elapsed waiting. No sampled CPU profiler or tracing domain is enabled.',
      units, capacity, sampleRetention: 'latest', totalSamples, sampleCount: retained.length, droppedSamples,
      complete: captureErrors.length === 0 && droppedCaptureErrors === 0 && droppedSamples === 0,
      captureErrors: Object.freeze(captureErrors.map(error => Object.freeze({ ...error }))), droppedCaptureErrors,
      samples: Object.freeze(retained) })
    try {
      await mkdir(dirname(artifact), { recursive: true })
      await writeFile(artifact, `${JSON.stringify(report)}\n`)
    } catch (error) { error.rendererCPUCounter = report; throw error }
    return report
  })()
  try {
    session = await page.context().newCDPSession(page)
    session.on('Performance.metrics', record)
    await session.send('Performance.enable', { timeDomain: 'threadTicks' })
  } catch (error) { failed('enable', error) }
  return { markerPrefix, stop }
}
