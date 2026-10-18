import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySync } from '../electron/services/history-sync.js'
import { MarketStore } from '../electron/services/market-store.js'
import type { HistoryTask } from '../electron/services/history-sync.js'

test('durable history makes progress before a busy foreground universe drains', { timeout: 5_000 }, async () => {
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
    assert.equal(calls[1], 'LIVE-0', 'A newly focused foreground request still goes first.')
    assert.ok(calls.indexOf('HISTORY') <= 8, 'History must publish a page while foreground work remains queued.')
    assert.ok(calls.indexOf('WARMUP') <= 17, 'Background peers both receive bounded turns.')
    assert.equal(covered.size, 27)
    assert.ok(sync.listTasks().every(task => task.status === 'completed'))
  } finally { release(); await sync.close() }
})

test('queued background storage is serviced during continuous foreground reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-storage-fairness-'))
  const store = await MarketStore.open(root), calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const first = store.enqueue(() => gate, 'foreground')
    const background = store.enqueue(() => { calls.push('history-write') })
    const foreground = Array.from({ length: 24 }, (_, index) => store.enqueue(() => { calls.push(`read-${index}`) }, 'foreground'))
    release()
    await Promise.all([first, background, ...foreground])
    assert.equal(calls[0], 'read-0', 'Foreground reads retain their normal preference.')
    assert.ok(calls.indexOf('history-write') < 8, 'Accepted history storage must finish before all foreground reads.')
  } finally { release(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
