import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { HistorySync } from '../electron/services/history-sync.js'
import type { HistoryRange, HistoryRecord, HistorySourceQuery, HistoryTask, HistorySyncOptions } from '../electron/services/history-sync.js'
import type { CandleRecord } from '../electron/services/market-store.js'

const step = 300_000, base = Date.UTC(2026, 9, 1)
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m' as const, source: 'candles', from: base, through: base + 2 * step }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 4000
  while (!condition()) { assert.ok(performance.now() < deadline, 'History planner did not make progress.'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
const rows = (request: HistorySourceQuery): CandleRecord[] => {
  const interval = { '5m': step, '15m': 900_000, '1H': 3_600_000 }[request.timeframe]
  return Array.from({ length: (request.through - request.from) / interval + 1 }, (_, index) => ({
    instrument: request.instrument, timeframe: request.timeframe, timestamp: request.from + index * interval,
    open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 1, quoteVolume: 100, confirmed: true,
  }))
}
class MemoryMetadata {
  tasks = new Map<string, HistoryTask>()
  writes = 0
  putSyncTask(task: HistoryTask) { this.writes++; this.tasks.set(task.id, structuredClone(task)) }
  putSyncTasks(tasks: HistoryTask[]) { for (const task of tasks) this.putSyncTask(task) }
  getSyncTask(id: string) { return structuredClone(this.tasks.get(id) ?? null) }
  listSyncTasks() { return [...this.tasks.values()].map(value => structuredClone(value)) }
  deleteSyncTask(id: string) { return this.tasks.delete(id) }
  deleteSyncTasks(ids: string[]) { for (const id of ids) this.deleteSyncTask(id) }
}
class MemoryStore {
  values = new Map<string, HistoryRecord>()
  version = 0
  key(value: { instrument: string; timeframe: string; timestamp: number; source?: string }) { return `${value.instrument}:${value.timeframe}:${value.source ?? 'candles'}:${value.timestamp}` }
  async appendCandles(records: CandleRecord[]) { return this.appendSource(records, 'candles') }
  async appendSource(records: HistoryRecord[], source: string) { for (const row of records) this.values.set(this.key({ ...row, source }), row); this.version++; return records.length }
  coverageVersion() { return this.version }
  async missingCandleRanges(request: HistoryRange & { instrument: string; timeframe: string; source: string; intervalMS: number }) {
    const result: HistoryRange[] = []
    let first: number | null = null
    for (let timestamp = request.from; timestamp <= request.through; timestamp += request.intervalMS) {
      if (!this.values.has(this.key({ ...request, timestamp }))) first ??= timestamp
      else if (first !== null) { result.push({ from: first, through: timestamp - request.intervalMS }); first = null }
    }
    if (first !== null) result.push({ from: first, through: request.through })
    return result
  }
}
const fixture = (options: Partial<HistorySyncOptions> = {}) => {
  const metadata = new MemoryMetadata(), store = new MemoryStore(), requests: HistorySourceQuery[] = []
  const sync = new HistorySync({ metadata, store, sources: { candles: { fetchGap: request => { requests.push(request); return rows(request) } } },
    minRequestIntervalMS: 0, retryBaseMS: 1, maxRetryDelayMS: 4, ...options })
  return { sync, metadata, store, requests }
}

test('validates source identities, ranges, priorities and scheduling limits', async t => {
  assert.throws(() => new HistorySync({} as HistorySyncOptions), /metadata/)
  for (const options of [{ maxConcurrentTasks: 0 }, { maxConcurrentPerSource: 0 }, { maxAttempts: 0 }, { maxRetainedTerminalTasks: 0 }]) assert.throws(() => fixture(options), /at least/)
  const { sync } = fixture(); t.after(() => sync.close())
  await assert.rejects(sync.enqueue({ ...query, from: base + 1 }), /grid/)
  await assert.rejects(sync.enqueue({ ...query, source: 'unknown' }), /unavailable/)
  await assert.rejects(sync.enqueue({ ...query, priority: 'urgent' as 'foreground' }), /priority/)
})

test('overlapping and adjacent consumers share one canonical API page without persisted execution rows', async t => {
  const { sync, requests, metadata } = fixture(); t.after(() => sync.close())
  const consumers = await Promise.all([
    sync.enqueue({ ...query, from: base, through: base + 99 * step, priority: 'foreground' }),
    sync.enqueue({ ...query, from: base + 50 * step, through: base + 149 * step, priority: 'foreground' }),
    sync.enqueue({ ...query, from: base + 150 * step, through: base + 199 * step, priority: 'foreground' }),
  ])
  assert.equal(new Set(consumers.map(task => task.id)).size, 3, 'Every cancellation owns only its own consumer.')
  const results = await Promise.all(consumers.map(task => sync.waitFor(task.id)))
  assert.ok(results.every(task => task.status === 'completed'))
  assert.equal(requests.length, 1)
  assert.deepEqual({ from: requests[0].from, through: requests[0].through }, { from: base, through: base + 199 * step })
  assert.equal(metadata.tasks.size, 0)
  assert.equal(metadata.writes, 0)
})

test('API pages are bounded, coverage is shared and overlapping arrivals do not duplicate in-flight work', async t => {
  const gate = deferred(), started: HistorySourceQuery[] = []
  const { sync } = fixture({ sources: { candles: { fetchGap: async request => { started.push(request); if (started.length === 1) await gate.promise; return rows(request) } } } })
  t.after(() => sync.close())
  const first = await sync.enqueue({ ...query, through: base + 599 * step, priority: 'foreground' })
  await waitFor(() => started.length === 1)
  const overlap = await sync.enqueue({ ...query, from: base + 400 * step, through: base + 599 * step, priority: 'foreground' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(started.length, 1)
  gate.resolve(); await Promise.all([sync.waitFor(first.id), sync.waitFor(overlap.id)])
  assert.equal(started.length, 2)
  const fetched = started.flatMap(request => rows(request).map(row => row.timestamp))
  assert.equal(fetched.length, 600)
  assert.equal(new Set(fetched).size, fetched.length)
  assert.ok(started.every(request => (request.through - request.from) / step + 1 <= 300))
})

test('cancelling one consumer leaves another consumer and the shared fetch active', async t => {
  const gate = deferred(); let activeSignal: AbortSignal | undefined
  const { sync, store } = fixture({ sources: { candles: { fetchGap: async request => { activeSignal = request.signal; await gate.promise; return rows(request) } } } })
  t.after(() => sync.close())
  const first = await sync.enqueue({ ...query, priority: 'foreground' }), second = await sync.enqueue({ ...query, priority: 'foreground' })
  await waitFor(() => Boolean(activeSignal))
  await sync.cancel(first.id)
  assert.equal(activeSignal?.aborted, false)
  assert.equal((await sync.waitFor(first.id)).status, 'cancelled')
  gate.resolve()
  assert.equal((await sync.waitFor(second.id)).status, 'completed')
  assert.equal(store.values.size, 3)
})

test('cancellation during an accepted durable write cannot undo facts or revive the consumer', async t => {
  const gate = deferred(), entered = deferred(), store = new MemoryStore()
  const { sync } = fixture({ store, write: async (records, task) => { entered.resolve(); await gate.promise; await store.appendSource(records, task.source) } })
  t.after(() => sync.close())
  const task = await sync.enqueue({ ...query, priority: 'foreground' })
  await entered.promise; await sync.cancel(task.id); gate.resolve(); await sync.whenIdle()
  assert.equal(store.values.size, 3)
  assert.equal(sync.getTask(task.id)?.status, 'cancelled')
})

test('the final cancelled consumer aborts its fetch and removes execution demand', async t => {
  let signal: AbortSignal | undefined
  const { sync, metadata } = fixture({ sources: { candles: { fetchGap: request => new Promise((_resolve, reject) => { signal = request.signal; request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) }) } } })
  t.after(() => sync.close())
  const task = await sync.enqueue(query); await waitFor(() => Boolean(signal)); await sync.cancel(task.id); await sync.whenIdle()
  assert.equal(signal?.aborted, true)
  assert.equal(metadata.tasks.size, 0)
})

test('restart discards obsolete viewport checkpoints and restores only canonical rolling intentions', async t => {
  const metadata = new MemoryMetadata(), gate = deferred()
  const { sync } = fixture({ metadata, sources: { candles: { fetchGap: async request => { await gate.promise; request.signal.throwIfAborted(); return rows(request) } } } })
  const target = await sync.enqueueTarget({ ...query, historyDays: 1, warmupCandles: 200, asOf: base + 2 * 86400000 })
  const ephemeral = await sync.enqueue({ ...query, priority: 'foreground' })
  // Simulate an execution checkpoint left by an older build.
  metadata.tasks.set(ephemeral.id, ephemeral)
  metadata.tasks.set('obsolete-foreground-history', { ...ephemeral, id: 'obsolete-foreground-history', purpose: 'history', priority: 'foreground' })
  metadata.tasks.set('obsolete-statistics-warmup', { ...ephemeral, id: 'obsolete-statistics-warmup', purpose: 'warmup', source: 'oi', priority: 'background' })
  const closing = sync.close(); gate.resolve(); await closing
  const requests: HistorySourceQuery[] = []
  const restored = fixture({ metadata, now: () => base + 3 * 86400000, sources: { candles: { fetchGap: request => { requests.push(request); return rows(request) } } } }).sync
  t.after(() => restored.close()); await restored.start(); await restored.whenIdle()
  assert.equal(metadata.tasks.size, 2)
  assert.equal(restored.getTask(ephemeral.id), null)
  assert.ok([...metadata.tasks.values()].every(task => task.purpose !== 'requested' && task.priority === 'background' && task.status === 'queued' && task.cursor === null))
  const history = restored.getTask(target.history.id)!
  assert.equal(history.through, base + 3 * 86400000 - step)
  assert.equal(history.through - history.from, 86400000 - step)
  const warmup = restored.getTask(target.warmup!.id)!
  assert.equal(warmup.through, history.from - step)
  const stamps = requests.flatMap(request => rows(request).map(row => row.timestamp))
  assert.equal(new Set(stamps).size, stamps.length, 'History and adjacent warmup share their page coverage.')
})

test('rolling intentions advance in place and statistics never create indicator warmup tasks', async t => {
  const metadata = new MemoryMetadata(), store = new MemoryStore()
  const { sync } = fixture({ metadata, store, sources: { candles: { fetchGap: rows }, oi: { fetchGap: rows }, taker: { fetchGap: rows } }, write: (records, task) => store.appendSource(records, task.source) })
  t.after(() => sync.close())
  for (let index = 0; index < 5; index++) for (const source of ['candles', 'oi', 'taker']) await sync.enqueueTarget({ ...query, source, historyDays: 1, asOf: base + 86400000 + index * step, warmupCandles: 200 })
  await sync.whenIdle()
  assert.equal(metadata.tasks.size, 4)
  assert.equal([...metadata.tasks.values()].filter(task => task.purpose === 'warmup').length, 1)
})

test('interactive work has a reserved source slot while a maintenance page remains blocked', async t => {
  const gate = deferred(), started: string[] = []
  const { sync } = fixture({ maxConcurrentTasks: 2, maxConcurrentPerSource: 2,
    sources: { candles: { fetchGap: async request => { started.push(request.instrument); if (request.instrument === 'MAINT-USDT-SWAP') await gate.promise; return rows(request) } } } })
  t.after(() => sync.close())
  const background = await sync.enqueue({ ...query, instrument: 'MAINT-USDT-SWAP', priority: 'background' })
  await waitFor(() => started.length === 1)
  const interactive = await sync.enqueue({ ...query, instrument: 'FOCUS-USDT-SWAP', priority: 'foreground' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  assert.equal(sync.getTask(background.id)?.status, 'running')
  gate.resolve(); await sync.waitFor(background.id)
})

test('a disjoint interactive range preempts a blocked background page for the same series', async t => {
  const started: HistorySourceQuery[] = []
  const { sync } = fixture({ sources: { candles: { fetchGap: request => {
    started.push(request)
    if (request.priority === 'background' && started.length === 1) return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
    return rows(request)
  } } } })
  t.after(() => sync.close())
  const background = await sync.enqueue({ ...query, through: base + 999 * step, priority: 'background' })
  await waitFor(() => started.length === 1)
  const interactive = await sync.enqueue({ ...query, through: base + 2 * step, priority: 'foreground' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  assert.equal(started[0].signal.aborted, true)
  assert.equal(started[1].priority, 'foreground')
  await sync.waitFor(background.id)
})

test('maintenance receives a page during a continuous interactive backlog', async t => {
  const started: string[] = []
  const { sync } = fixture({ maxConcurrentTasks: 1, maxConcurrentPerSource: 1,
    sources: { candles: { pageSize: 1, fetchGap: request => { started.push(request.instrument); return rows(request) } } } })
  t.after(() => sync.close())
  const tasks = await Promise.all([
    sync.enqueue({ ...query, instrument: 'MAINT-USDT-SWAP', priority: 'background' }),
    ...Array.from({ length: 30 }, (_, index) => sync.enqueue({ ...query, instrument: `I${index}-USDT-SWAP`, priority: 'foreground' })),
  ])
  await Promise.all(tasks.map(task => sync.waitFor(task.id)))
  assert.ok(started.indexOf('MAINT-USDT-SWAP') <= 8, JSON.stringify(started.slice(0, 12)))
})

test('independent sources start without waiting for a blocked price lane', async t => {
  const gate = deferred(), started = new Set<string>(), store = new MemoryStore()
  const source = (name: string) => ({ fetchGap: async (request: HistorySourceQuery) => { started.add(name); if (name === 'candles') await gate.promise; return rows(request) } })
  const { sync } = fixture({ store, sources: { candles: source('candles'), oi: source('oi'), taker: source('taker') }, write: (records, task) => store.appendSource(records, task.source) })
  t.after(() => sync.close())
  const consumers = await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...query, source, priority: 'foreground' })))
  await waitFor(() => started.size === 3)
  assert.equal((await sync.waitFor(consumers[1].id)).status, 'completed')
  assert.equal((await sync.waitFor(consumers[2].id)).status, 'completed')
  gate.resolve(); await sync.waitFor(consumers[0].id)
})

test('unavailable requires explicit source evidence and an empty page pauses instead of inventing coverage', async t => {
  const empty = fixture({ maxAttempts: 2, sources: { candles: { fetchGap: () => [] } } }); t.after(() => empty.sync.close())
  const task = await empty.sync.enqueue(query), result = await empty.sync.waitFor(task.id)
  assert.equal(result.status, 'paused'); assert.match(result.lastError!, /no persisted coverage progress/)
  assert.deepEqual(result.unavailableRanges, [])
  const bounded = fixture({ sources: { candles: { inspect: () => ({ availableFrom: query.through + step, reason: 'Explicit source boundary.' }), fetchGap: () => { throw Error('Unavailable range must not fetch') } } } }); t.after(() => bounded.sync.close())
  const unavailable = await bounded.sync.enqueue(query)
  assert.equal((await bounded.sync.waitFor(unavailable.id)).status, 'unavailable')
})

test('durable goals survive a transient outage after their shared requested consumer exhausts its budget', async t => {
  let attempts = 0
  const { sync, metadata } = fixture({ maxAttempts: 2, sources: { candles: { fetchGap: request => { if (++attempts <= 3) throw new Error('Temporary source outage.'); return rows(request) } } } })
  t.after(() => sync.close())
  const goal = await sync.enqueue({ ...query, purpose: 'history' }), consumer = await sync.enqueue({ ...query, priority: 'foreground' })
  const requested = await sync.waitFor(consumer.id)
  assert.equal(requested.status, 'paused'); assert.equal(requested.attempts, 2)
  const completed = await sync.waitFor(goal.id)
  assert.equal(completed.status, 'completed'); assert.equal(attempts, 4)
  assert.equal(metadata.tasks.get(goal.id)?.status, 'queued', 'Only the durable desired range survives restart, without transient failure state.')
})

test('delisting during target admission cannot resurrect its warmup or history intention', async t => {
  const { sync, metadata } = fixture()
  t.after(() => sync.close())
  await sync.start()
  const target = sync.enqueueTarget({ ...query, historyDays: 1, asOf: base + 86400000 })
  const retired = assert.rejects(target, { name: 'AbortError' })
  await sync.removeTargets([query.instrument]); await retired
  assert.equal(metadata.tasks.size, 0)
  assert.deepEqual(sync.listTasks(), [])
})

test('default market scale retains bounded intentions rather than accumulating page checkpoints', async t => {
  const metadata = new MemoryMetadata(), store = new MemoryStore(), gate = deferred()
  const fetchGap = async (request: HistorySourceQuery) => { await gate.promise; request.signal.throwIfAborted(); return rows(request) }
  const { sync } = fixture({ metadata, store, sources: { candles: { fetchGap }, oi: { fetchGap }, taker: { fetchGap } }, write: (records, task) => store.appendSource(records, task.source) })
  t.after(() => sync.close())
  const asOf = base + 32 * 86400000
  await Promise.all(Array.from({ length: 287 }, (_, index) => Promise.all((['5m', '15m', '1H'] as const).flatMap(timeframe => ['candles', 'oi', 'taker'].map(source => sync.enqueueTarget({ instrument: `T${index}-USDT-SWAP`, timeframe, source, historyDays: 30, asOf }))))))
  assert.equal(metadata.tasks.size, 287 * 12)
  const writes = metadata.writes
  await Promise.all(Array.from({ length: 1000 }, () => sync.enqueue({ ...query, priority: 'foreground' })))
  assert.equal(metadata.writes, writes, 'Viewport demand never adds SQLite coordination rows.')
  const closing = sync.close(); gate.resolve(); await closing
})

test('completed rolling goals revalidate only an expired empty observation at its own deadline', async t => {
  const last = base + 299 * step, calls: HistorySourceQuery[] = [], reads: HistoryRange[] = [], metadata = new MemoryMetadata()
  let expiresAt = 0, revision = 0
  const sync = new HistorySync({ metadata, sources: { oi: { fetchGap: request => { calls.push(request); return [{ instrument: request.instrument, timeframe: request.timeframe, timestamp: last, oi: null }] } } },
    store: {
      async missingCandleRanges(request) { reads.push({ from: request.from, through: request.through }); return request.from <= last && request.through >= last && expiresAt <= Date.now() ? [{ from: last, through: last }] : [] },
      coverageVersion: () => revision,
      coverageChanges: () => ({ revision, ranges: [{ from: last, through: last }] }),
      coverageLeases: request => request.from <= last && request.through >= last && expiresAt > Date.now() ? [{ from: last, through: last, expiresAt }] : [],
    },
    write() { expiresAt = Date.now() + 50; revision++ },
  })
  t.after(() => sync.close())
  const goal = await sync.enqueue({ ...query, through: last, source: 'oi', purpose: 'history' })
  await sync.waitFor(goal.id)
  const initialReads = reads.length, intentWrites = metadata.writes
  await waitFor(() => calls.length >= 2)
  await sync.pause(goal.id)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.from === last && call.through === last), 'A lease deadline cannot refetch numeric history beside the expired empty slot.')
  assert.ok(reads.slice(initialReads).every(read => read.from === last && read.through === last), 'Only the expired source slot needs another coverage read.')
  assert.equal(metadata.writes, intentWrites + 1, 'Only the explicit pause persists; page execution and lease wakes do not checkpoint.')
})

for (const stop of ['pause', 'cancel', 'remove', 'close'] as const) test(`${stop} retires a canonical goal's empty-observation wake`, async t => {
  let expiresAt = 0, calls = 0
  const sync = new HistorySync({ metadata: new MemoryMetadata(), sources: { oi: { fetchGap: request => { calls++; return [{ instrument: request.instrument, timeframe: request.timeframe, timestamp: base, oi: null }] } } },
    store: {
      async missingCandleRanges() { return expiresAt > Date.now() ? [] : [{ from: base, through: base }] },
      coverageLeases: () => expiresAt > Date.now() ? [{ from: base, through: base, expiresAt }] : [],
    }, write() { expiresAt = Date.now() + 50 },
  })
  t.after(() => sync.close())
  const goal = await sync.enqueue({ ...query, through: base, source: 'oi', purpose: 'history' })
  await sync.waitFor(goal.id)
  if (stop === 'remove') await sync.removeTargets([query.instrument])
  else if (stop === 'close') await sync.close()
  else await sync[stop](goal.id)
  await new Promise(resolve => setTimeout(resolve, 75))
  assert.equal(calls, 1)
})
