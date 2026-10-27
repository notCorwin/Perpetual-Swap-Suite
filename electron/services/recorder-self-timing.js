import process from 'node:process'
import { threadId } from 'node:worker_threads'

// Recorder work cannot record itself as journal operations without recursion.
// Measure bulk synchronous stages only; admission of each record stays untouched.
export function createRecorderSelfTiming({ now = () => performance.now(), timeOrigin = performance.timeOrigin,
  cpuTime = process.threadCpuUsage ? () => { const value = process.threadCpuUsage(); return (value.user + value.system) / 1000 } : undefined } = {}) {
  const stages = Object.create(null), slowSamples = [], slowThresholdMS = 8, sampleLimit = 32
  let droppedSlowSamples = 0
  return {
    measure(stage, operation) {
      const started = now(), initialCPU = cpuTime?.()
      let status = 'ok'
      try { return operation() }
      catch (error) { status = 'error'; throw error }
      finally {
        const ended = now(), finalCPU = cpuTime?.(), durationMS = ended - started
        const cpuTimeMS = Number.isFinite(initialCPU) && Number.isFinite(finalCPU) ? Math.max(0, finalCPU - initialCPU) : undefined
        const total = stages[stage] ??= { count: 0, failed: 0, totalMS: 0, maxMS: 0, cpuMeasuredCount: 0, totalCPUTimeMS: 0 }
        total.count++; total.failed += Number(status === 'error'); total.totalMS += durationMS; total.maxMS = Math.max(total.maxMS, durationMS)
        if (cpuTimeMS !== undefined) { total.cpuMeasuredCount++; total.totalCPUTimeMS += cpuTimeMS }
        if (durationMS >= slowThresholdMS) {
          if (slowSamples.length === sampleLimit) { slowSamples.shift(); droppedSlowSamples++ }
          slowSamples.push({ stage, startedAt: timeOrigin + started,
            endedAt: timeOrigin + ended, durationMS, ...(cpuTimeMS === undefined ? {} : { cpuTimeMS }), status })
        }
      }
    },
    snapshot() {
      return { clock: 'performance.timeOrigin + performance.now', cpuClock: cpuTime ? 'process.threadCpuUsage' : null,
        collector: { processId: process.pid, threadId },
        measurement: 'Inclusive synchronous bulk-stage wall/thread CPU; asynchronous write and fdatasync waits are excluded.',
        publication: 'Completed synchronous bulk stages; a health publication excludes its own still-running cost.',
        slowThresholdMS, sampleLimit, sampleRetention: 'latest', droppedSlowSamples,
        stages: Object.fromEntries(Object.entries(stages).map(([stage, total]) => [stage, { ...total }])),
        slowSamples: slowSamples.map(sample => ({ ...sample })) }
    },
  }
}
