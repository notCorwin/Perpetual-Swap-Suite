import { performance } from 'node:perf_hooks'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
// Run via: node scripts/test-sandbox.mjs command -- node --expose-gc scripts/benchmark-chart-ranges.mjs
// Synthetic scaling uses more resident rows than production permits.
const p = new PreparedChartPipeline({ store: {}, history: {}, normalize: x => x, revision: () => 0, instrument: () => null })
for (const n of [1_000, 10_000, 100_000]) {
  // All jobs miss the requested range; both implementations must report one gap.
  const count = Math.floor(n / 50), state = { key: 'bench', intervalMS: 1, rows: new Map() }
  const jobs = Array.from({ length: count }, (_, i) => ({ seriesKey: 'bench', source: 'candles', from: 2 * n + i, through: 2 * n + i }))
  p.sourceTasks = new Map(jobs.map((job, i) => [i, job]))
  const old = () => {
    const ranges = []
    for (let hour = 0; hour < n; hour++) {
      if (jobs.some(job => job.from <= hour && job.through >= hour)) continue
      const previous = ranges.at(-1)
      if (previous?.through + 1 === hour) previous.through = hour
      else ranges.push({ from: hour, through: hour })
    }
    return ranges
  }
  const run = fn => { global.gc?.(); const memory = process.memoryUsage().heapUsed, start = performance.now(), result = fn(); return { ms: +(performance.now() - start).toFixed(2), heapDelta: process.memoryUsage().heapUsed - memory, result } }
  const before = run(old), after = run(() => p.pendingSourceRanges(state, 'candles', 0, n - 1))
  if (JSON.stringify(before.result) !== JSON.stringify(after.result)) throw new Error('Results differ')
  console.log(JSON.stringify({ n, jobs: count, beforeMs: before.ms, afterMs: after.ms, beforeHeapDelta: before.heapDelta, afterHeapDelta: after.heapDelta }))
}
p.sourceTasks.clear(); await p.dispose()
