import process from 'node:process'
import { threadId } from 'node:worker_threads'

// Recorder work cannot record itself as journal operations without recursion.
// Admission of each record stays untouched. Asynchronous waits never include
// thread CPU, because unrelated event-loop work can run before they finish.
export function createRecorderSelfTiming({ now = () => performance.now(), timeOrigin = performance.timeOrigin,
  cpuTime = process.threadCpuUsage ? () => { const value = process.threadCpuUsage(); return (value.user + value.system) / 1000 } : undefined } = {}) {
  const stages = Object.create(null), slowSamples = [], slowThresholdMS = 8, sampleLimit = 32
  let droppedSlowSamples = 0
  const record = (stage, started, ended, status, cpuTimeMS) => {
    const durationMS = ended - started
    const total = stages[stage] ??= { count: 0, failed: 0, totalMS: 0, maxMS: 0, cpuMeasuredCount: 0, totalCPUTimeMS: 0 }
    total.count++; total.failed += Number(status === 'error'); total.totalMS += durationMS; total.maxMS = Math.max(total.maxMS, durationMS)
    if (cpuTimeMS !== undefined) { total.cpuMeasuredCount++; total.totalCPUTimeMS += cpuTimeMS }
    if (durationMS >= slowThresholdMS) {
      if (slowSamples.length === sampleLimit) { slowSamples.shift(); droppedSlowSamples++ }
      slowSamples.push({ stage, startedAt: timeOrigin + started,
        endedAt: timeOrigin + ended, durationMS, ...(cpuTimeMS === undefined ? {} : { cpuTimeMS }), status })
    }
  }
  return {
    measure(stage, operation) {
      const started = now(), initialCPU = cpuTime?.()
      let status = 'ok'
      try { return operation() }
      catch (error) { status = 'error'; throw error }
      finally {
        const ended = now(), finalCPU = cpuTime?.()
        const cpuTimeMS = Number.isFinite(initialCPU) && Number.isFinite(finalCPU) ? Math.max(0, finalCPU - initialCPU) : undefined
        record(stage, started, ended, status, cpuTimeMS)
      }
    },
    startWait(stage) {
      const started = now()
      let finished = false
      return (status = 'ok') => {
        if (finished) return
        finished = true
        record(stage, started, now(), status, undefined)
      }
    },
    snapshot() {
      return { clock: 'performance.timeOrigin + performance.now', cpuClock: cpuTime ? 'process.threadCpuUsage' : null,
        collector: { processId: process.pid, threadId },
        measurement: 'Inclusive synchronous bulk-stage wall/thread CPU; asynchronous waits record wall time without thread CPU.',
        publication: 'Completed bulk stages; a health publication excludes its own still-running cost.',
        slowThresholdMS, sampleLimit, sampleRetention: 'latest', droppedSlowSamples,
        stages: Object.fromEntries(Object.entries(stages).map(([stage, total]) => [stage, { ...total }])),
        slowSamples: slowSamples.map(sample => ({ ...sample })) }
    },
  }
}
