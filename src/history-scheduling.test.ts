import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySync } from '../electron/services/history-sync.js'
import { MarketStore } from '../electron/services/market-store.js'
import type { HistoryTask } from '../electron/services/history-sync.js'

test('every queued foreground history request precedes background history and warmup pages', { timeout: 5_000 }, async () => {
  const saved = new Map<string, HistoryTask>(), covered = new Set<string>(), calls: string[] = []
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const sync = new HistorySync({
    metadata: {
      putSyncTask(task) { saved.set(task.id, structuredClone(task)); return task },
      getSyncTask(id) { return saved.get(id) ?? null },
      listSyncTasks() { return [...saved.values()] },
      deleteSyncTask(id) { return saved.delete(id) },
    },
    store: { async missingCandleRanges(query) { return covered.has(query.instrument) ? [] : [{ from: query.from, through: query.through }] } },
    write(rows) { rows.forEach(row => covered.add(row.instrument)) },
    minRequestIntervalMS: 0,
    sources: { candles: { async fetchGap(query) {
      calls.push(query.instrument)
      if (calls.length === 1) { started(); await gate }
      return [{ instrument: query.instrument, timeframe: query.timeframe, timestamp: query.from,
        open: 100, high: 101, low: 99, close: 100, volume: 1, confirmed: true }]
    } } },
  })
  const query = { instrument: 'FIRST', timeframe: '5m' as const, source: 'candles', from: 0, through: 0 }
  try {
    await sync.enqueue({ ...query, priority: 'foreground' })
    await entered
    await sync.enqueue({ ...query, instrument: 'HISTORY', purpose: 'history' })
    await sync.enqueue({ ...query, instrument: 'WARMUP', purpose: 'warmup' })
    for (let index = 0; index < 24; index += 1) await sync.enqueue({ ...query, instrument: `LIVE-${index}`, priority: 'foreground' })
    release()
    await sync.whenIdle()
    assert.deepEqual(calls, ['FIRST', ...Array.from({ length: 24 }, (_, index) => `LIVE-${index}`), 'HISTORY', 'WARMUP'],
      'Background downloads must wait for all foreground pages, including requests beyond the former burst limit.')
    assert.equal(covered.size, 27)
    assert.ok(sync.listTasks().every(task => task.status === 'completed'))
  } finally { release(); await sync.close() }
})

test('foreground storage runs after the active durable job and before every queued background job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-storage-priority-'))
  const store = await MarketStore.open(root), calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const first = store.enqueue(async () => { calls.push('active-write:start'); await gate; calls.push('active-write:end') })
    const background = store.enqueue(() => { calls.push('history-write') })
    const checkpoint = store.enqueue(() => { calls.push('history-checkpoint') })
    const foreground = Array.from({ length: 24 }, (_, index) => store.enqueue(() => { calls.push(`read-${index}`) }, 'foreground'))
    assert.deepEqual(calls, ['active-write:start'], 'Foreground admission must not interrupt an active durable operation.')
    release()
    await Promise.all([first, background, checkpoint, ...foreground])
    assert.deepEqual(calls, ['active-write:start', 'active-write:end', ...Array.from({ length: 24 }, (_, index) => `read-${index}`), 'history-write', 'history-checkpoint'],
      'Every foreground job must precede queued background work while preserving each priority group’s arrival order.')
  } finally { release(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
