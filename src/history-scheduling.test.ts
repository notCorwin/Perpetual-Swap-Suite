import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { HistorySync } from '../electron/services/history-sync.js'

// Scheduling is a domain policy. Storage worker scheduling is exercised through
// actual SQLite reads/writes in market-store tests, without exposing a generic queue.
test('maintenance is bounded while continuity and interactive work retain independent source capacity', async t => {
  const covered = new Set<string>(), calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sync = new HistorySync({
    metadata: { listSyncTasks() { return [] }, deleteSyncTask() {} },
    store: { async missingCandleRanges(query) { return covered.has(`${query.source}:${query.instrument}`) ? [] : [{ from: query.from, through: query.through }] } },
    write(records, task) { for (const row of records) covered.add(`${task.source}:${row.instrument}`) },
    maxConcurrentTasks: 3, maxConcurrentPerSource: { candles: 2, oi: 1 },
    sources: Object.fromEntries(['candles', 'oi'].map(source => [source, { async fetchGap(query: { instrument: string; timeframe: '5m' | '15m' | '1H'; from: number }) {
      calls.push(`${source}:${query.instrument}`)
      if (query.instrument === 'MAINT') await gate
      return [{ instrument: query.instrument, timeframe: query.timeframe, timestamp: query.from, open: 100, high: 101, low: 99, close: 100, volume: 1, confirmed: true }]
    } }])),
  })
  t.after(async () => { release(); await sync.close() })
  const query = { instrument: 'MAINT', timeframe: '5m' as const, source: 'candles', from: 0, through: 0 }
  const maintenance = await sync.enqueue({ ...query, priority: 'background' })
  const focus = await sync.enqueue({ ...query, instrument: 'FOCUS', priority: 'interactive' })
  const continuity = await sync.enqueue({ ...query, instrument: 'OI', source: 'oi', priority: 'continuity' })
  assert.equal((await sync.waitFor(focus.id)).status, 'completed')
  assert.equal((await sync.waitFor(continuity.id)).status, 'completed')
  assert.ok(calls.includes('candles:FOCUS') && calls.includes('oi:OI'))
  release(); assert.equal((await sync.waitFor(maintenance.id)).status, 'completed')
})
