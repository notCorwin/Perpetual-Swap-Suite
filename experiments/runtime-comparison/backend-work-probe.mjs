// Separate diagnostic only. Never load this observer in energy comparisons.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { threadId } from 'node:worker_threads'

if (process.env.RADAR_BACKEND_WORK_PROBE && /\/(server\.mjs|market-backend-worker\.js)$/.test(process.argv[1] ?? '')) {
  const root = resolve(dirname(process.argv[1]), '../..')
  const { PreparedChartPipeline } = await import(`${root}/electron/services/prepared-chart-service.js`)
  const { withOperationSuppressed } = await import(`${root}/electron/services/operations.js`)
  const counts = {}, originalClone = globalThis.structuredClone
  let live = false
  globalThis.structuredClone = function (...args) {
    const key = live ? 'live.structuredClone' : 'startup.structuredClone'
    counts[key] = (counts[key] ?? 0) + 1
    return originalClone(...args)
  }
  const save = () => withOperationSuppressed(() => {
    mkdirSync(process.env.RADAR_BACKEND_WORK_PROBE, { recursive: true })
    writeFileSync(join(process.env.RADAR_BACKEND_WORK_PROBE, `${process.pid}-${threadId}.json`), JSON.stringify({ threadId, counts }))
  })
  for (const name of ['pendingSourceRanges', 'sourceStatus', 'cachedStatus', 'frame', 'state', 'syncLive', 'publishFrame', 'setLive', 'dispose']) {
    const original = PreparedChartPipeline.prototype[name]
    PreparedChartPipeline.prototype[name] = function (...args) {
      if (name === 'dispose') save()
      if (name === 'setLive') live = true
      const key = `${live ? 'live' : 'startup'}.${name}`
      const entry = counts[key] ??= { calls: 0, wallMS: 0, rowLookups: 0 }
      entry.calls++
      const rows = name === 'pendingSourceRanges' ? args[0]?.rows : undefined
      const get = rows?.get, ownGet = rows && Object.getOwnPropertyDescriptor(rows, 'get')
      if (rows) rows.get = function (...keys) { entry.rowLookups++; return get.apply(this, keys) }
      const start = performance.now()
      try { return original.apply(this, args) }
      finally {
        entry.wallMS += performance.now() - start
        if (rows) { if (ownGet) Object.defineProperty(rows, 'get', ownGet); else delete rows.get }
      }
    }
  }
  process.on('exit', save)
}
