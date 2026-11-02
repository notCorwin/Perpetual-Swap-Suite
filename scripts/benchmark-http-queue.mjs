import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketService } from '../electron/services/market-service.js'
import { MarketStore } from '../electron/services/market-store.js'

// Run through the background sandbox with node --expose-gc. Each trial makes
// the same 1,000 admissions from an equally populated, fully eligible queue.
const labels = ['background', 'prefetch', 'statistics', 'foreground', 'interactive']
const rank = { background: 0, prefetch: 1, statistics: 2, foreground: 3, interactive: 4 }
const root = await mkdtemp(join(tmpdir(), 'perp-http-queue-benchmark-')), store = await MarketStore.open(root)
const service = new MarketService(store, undefined, fetch, false)
await service.ready
for (const n of [1_000, 10_000, 100_000]) {
  const now = Date.now(), count = Math.min(1_000, n)
  const values = Array.from({ length: n }, (_, i) => ({ id: i, priority: labels[i % labels.length], enqueuedAt: now - i % 20_000 }))
  const measure = operation => { global.gc?.(); const heap = process.memoryUsage().heapUsed, start = performance.now(); const result = operation(); return { ms: +(performance.now() - start).toFixed(2), heapDelta: process.memoryUsage().heapUsed - heap, result } }
  const previous = measure(() => {
    const requests = values.slice(), ids = []
    for (let turn = 1; turn <= count; turn++) {
      let best = 0
      const score = value => rank[value.priority] + Math.min(5, (now - value.enqueuedAt) / 5_000)
      for (let i = 0; i < requests.length; i++) if (score(requests[i]) > score(requests[best])) best = i
      if (turn % 8 === 0) { const background = requests.findIndex(value => rank[value.priority] <= 1); if (background >= 0) best = background }
      ids.push(requests.splice(best, 1)[0].id)
    }
    return ids
  })
  const lane = { nextAt: 0, rateLimitedUntil: 0 }, queue = service.requestLane('market').queue
  const indexed = measure(() => {
    for (const value of values) queue.add({ ...value, bucket: lane })
    const ids = []
    for (let turn = 1; turn <= count; turn++) {
      let next = queue.pick(true, now, false)
      if (turn % 8 === 0) next = queue.pick(true, now, true) ?? next
      ids.push(next.id); queue.delete(next)
    }
    return ids
  })
  assert.deepEqual(indexed.result, previous.result)
  console.log(JSON.stringify({ n, admissions: count, beforeMs: previous.ms, afterMs: indexed.ms, beforeHeapDelta: previous.heapDelta, afterHeapDelta: indexed.heapDelta, note: 'after includes index construction; heap deltas are not peak memory' }))
  queue.clear()
}
await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
