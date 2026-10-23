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
  tasks = new Map<string, unknown>()
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
  await entered.promise
  let stopped = false, settled = false
  const result = sync.waitFor(task.id).then(value => { settled = true; return value })
  const cancellation = sync.cancel(task.id).then(value => { stopped = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  assert.equal(settled, false)
  let lateSettled = false
  const lateResult = sync.waitFor(task.id).then(value => { lateSettled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lateSettled, false, 'A new waiter must also wait for the stopped write checkpoint.')
  assert.equal(store.values.size, 0)
  gate.resolve()
  const [cancelled, waited] = await Promise.all([cancellation, result])
  await sync.whenIdle()
  assert.equal(store.values.size, 3)
  assert.deepEqual([cancelled.status, cancelled.coveredRecords, cancelled.writtenRecords, cancelled.localRecords], ['cancelled', 3, 3, 0])
  assert.deepEqual(waited, cancelled)
  assert.deepEqual(await lateResult, cancelled)
  assert.deepEqual(sync.getTask(task.id), cancelled)
})

test('the final cancelled consumer aborts its fetch and removes execution demand', async t => {
  let signal: AbortSignal | undefined
  const { sync, metadata } = fixture({ sources: { candles: { fetchGap: request => new Promise((_resolve, reject) => { signal = request.signal; request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) }) } } })
  t.after(() => sync.close())
  const task = await sync.enqueue(query); await waitFor(() => Boolean(signal)); await sync.cancel(task.id); await sync.whenIdle()
  assert.equal(signal?.aborted, true)
  assert.equal(metadata.tasks.size, 0)
})

test('startup deletes legacy archive goals and checkpoints without fetching or restoring demand', async t => {
  const metadata = new MemoryMetadata()
  for (const [id, purpose, status] of [['legacy-history', 'history', 'queued'], ['legacy-warmup', 'warmup', 'completed'], ['legacy-consumer', 'requested', 'running'], ['legacy-paused', 'history', 'paused']]) {
    metadata.tasks.set(id, { ...query, id, purpose, status, priority: 'background' })
  }
  const { sync, requests } = fixture({ metadata })
  t.after(() => sync.close())
  await sync.start(); await sync.whenIdle()
  assert.equal(metadata.tasks.size, 0)
  assert.equal(metadata.writes, 0)
  assert.deepEqual(sync.listTasks(), [])
  assert.deepEqual(requests, [])
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

test('shared background pages follow live chart priority without promoting the larger archive or duplicating work', async t => {
  const gate = deferred(), started: HistorySourceQuery[] = []
  const { sync } = fixture({ sources: { candles: { fetchGap: async request => {
    started.push(request)
    if (started.length === 1) await gate.promise
    return rows(request)
  } } } })
  t.after(() => { gate.resolve(); return sync.close() })
  const archive = await sync.enqueue({ ...query, through: base + 599 * step, priority: 'background' })
  await waitFor(() => started.length === 1)
  const page = started[0], transportPriority = page.getPriority
  assert.equal(transportPriority(), 'background')
  const bounds = { ...query, from: base + 400 * step, through: base + 499 * step }
  const chart = await sync.enqueue({ ...bounds, priority: 'prefetch' })
  assert.equal(sync.promote(bounds, 'interactive'), 1)
  assert.equal(sync.getTask(archive.id)?.priority, 'background', 'A chart promotion cannot raise unrelated archive pages.')
  assert.equal(sync.getTask(chart.id)?.priority, 'interactive')
  assert.equal(transportPriority(), 'interactive')
  assert.equal(page.priority, 'background', 'The dispatch snapshot remains stable; transport queues use getPriority for live demand.')
  assert.equal(page.signal.aborted, false, 'A useful shared page keeps its transport request.')
  assert.equal(started.length, 1)
  gate.resolve()
  const complete = await sync.waitFor(chart.id)
  assert.deepEqual([complete.coveredRecords, complete.localRecords], [100, 0], 'Joining a fetch cannot count its later result as reused data.')
  await sync.waitFor(archive.id)
  assert.equal(started.length, 2)
  assert.ok(started.every(request => request.getPriority() === 'background'), 'Once chart demand finishes, later archive work remains background.')
})

test('an interactive arrival promotes an already queued shared fetch and its cancellation restores background priority', async t => {
  const gate = deferred(), started: HistorySourceQuery[] = []
  const { sync } = fixture({ sources: { candles: { fetchGap: async request => { started.push(request); await gate.promise; return rows(request) } } } })
  t.after(() => { gate.resolve(); return sync.close() })
  const background = await sync.enqueue(query)
  await waitFor(() => started.length === 1)
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  assert.equal(started[0].getPriority(), 'interactive')
  await sync.cancel(interactive.id)
  assert.equal(started[0].getPriority(), 'background')
  assert.equal(started[0].signal.aborted, false)
  gate.resolve()
  assert.equal((await sync.waitFor(background.id)).status, 'completed')
  assert.equal(started.length, 1)
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
  assert.deepEqual([result.coveredRecords, result.emptyRecords, result.unavailableRecords], [0, 0, 0])
  assert.deepEqual(empty.sync.progressFor([query.instrument], query.timeframe), { retrying: 0, unavailable: 0 })
  const bounded = fixture({ sources: { candles: { inspect: () => ({ availableFrom: query.through + step, reason: 'Explicit source boundary.' }), fetchGap: () => { throw Error('Unavailable range must not fetch') } } } }); t.after(() => bounded.sync.close())
  const unavailable = await bounded.sync.enqueue(query)
  assert.equal((await bounded.sync.waitFor(unavailable.id)).status, 'unavailable')
})

test('fail-fast callers receive the first source failure and server cooldown while shared background waiters survive', async t => {
  let calls = 0, clock = base
  const { sync, store } = fixture({ now: () => clock, sources: { candles: { fetchGap: request => {
    if (++calls === 1) throw Object.assign(new Error('Source rate limit.'), { retryAfter: 60_000, retryAt: base + 90_000 })
    return rows(request)
  } } } })
  t.after(() => sync.close())
  const background = await sync.enqueue(query), interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  let settled = false
  const normal = sync.waitFor(background.id).then(result => { settled = true; return result })
  await assert.rejects(sync.waitFor(interactive.id, { failFast: true }), error => {
    assert.equal((error as Error).message, 'Source rate limit.')
    assert.equal((error as Error & { retryAt: number }).retryAt, base + 90_000)
    return true
  })
  await assert.rejects(sync.waitFor(interactive.id, { failFast: true }), { message: 'Source rate limit.', retryAt: base + 90_000 })
  assert.equal(sync.getTask(background.id)?.status, 'retry')
  assert.equal(sync.getTask(background.id)?.nextAttemptAt, base + 90_000)
  assert.equal(settled, false)
  assert.equal(store.values.size, 0, 'A source error cannot write empty observations.')
  assert.equal(sync.getTask(background.id)?.unavailableRecords, 0)
  await sync.cancel(interactive.id)
  assert.equal(settled, false, 'Cancelling the failed chart consumer preserves the background waiter.')
  clock += 90_000
  await sync.resume(background.id)
  assert.equal((await normal).status, 'completed')
  assert.equal(calls, 2)
})

test('Retry-After alone extends first-error retry reporting beyond exponential backoff', async t => {
  const { sync } = fixture({ now: () => base, sources: { candles: { fetchGap: () => { throw Object.assign(new Error('Cooldown.'), { retryAfter: 60_000 }) } } } })
  t.after(() => sync.close())
  const task = await sync.enqueue(query)
  await assert.rejects(sync.waitFor(task.id, { failFast: true }), { message: 'Cooldown.', retryAt: base + 60_000 })
  assert.equal(sync.getTask(task.id)?.nextAttemptAt, base + 60_000)
  await sync.cancel(task.id)
})

test('all finite consumers pause at their failure budget and recover only after an explicit resume', async t => {
  let attempts = 0, failed = true
  const { sync, metadata } = fixture({ maxAttempts: 2, sources: { candles: { fetchGap: request => { attempts++; if (failed) throw new Error('Temporary source outage.'); return rows(request) } } } })
  t.after(() => sync.close())
  const manual = await sync.enqueue(query), consumer = await sync.enqueue({ ...query, priority: 'foreground' })
  const stopped = await Promise.all([sync.waitFor(manual.id), sync.waitFor(consumer.id)])
  assert.ok(stopped.every(task => task.status === 'paused' && task.attempts === 2))
  await sync.whenIdle()
  assert.equal(attempts, 2)
  assert.equal(metadata.tasks.size, 0)
  assert.equal(metadata.writes, 0)
  failed = false
  await sync.resume(manual.id)
  assert.equal((await sync.waitFor(manual.id)).status, 'completed')
  assert.equal(attempts, 3)
  assert.equal(sync.getTask(consumer.id)?.status, 'paused')
})

test('delisting during admission cannot resurrect a finite consumer', async t => {
  const { sync, metadata } = fixture()
  t.after(() => sync.close())
  await sync.start()
  const admission = sync.enqueue(query)
  const retired = assert.rejects(admission, { name: 'AbortError' })
  await sync.removeTargets([query.instrument]); await retired
  assert.equal(metadata.tasks.size, 0)
  assert.deepEqual(sync.listTasks(), [])
})

test('completed consumer handles stay bounded while durable coverage is reused', async t => {
  const { sync, requests, metadata } = fixture({ maxRetainedTerminalTasks: 4 })
  t.after(() => sync.close())
  for (let index = 0; index < 20; index++) {
    const task = await sync.enqueue(query)
    await sync.waitFor(task.id); await sync.whenIdle()
  }
  assert.equal(sync.listTasks().length, 4)
  assert.equal(requests.length, 1)
  assert.equal(metadata.tasks.size, 0)
  assert.equal(metadata.writes, 0)
})

test('durable progress separates numeric history, leased emptiness, and overlapping explicit unavailability', async t => {
  const store = new MemoryStore(), snapshots: HistoryTask[] = []
  const last = base + 9 * step, expiresAt = Date.now() + 60_000
  await store.appendCandles(rows({ ...query, through: base + 2 * step } as HistorySourceQuery))
  const { sync } = fixture({ store: {
    missingCandleRanges: request => store.missingCandleRanges(request),
    coverageVersion: () => store.version,
    coverageLeases: request => request.from <= base + 2 * step && request.through >= base + step
      ? [{ from: Math.max(request.from, base + step), through: Math.min(request.through, base + 2 * step), expiresAt },
        { from: Math.max(request.from, base + step), through: Math.min(request.through, base + 2 * step), expiresAt }] : [],
  }, sources: { candles: {
    inspect: () => ({ unavailable: [{ from: base + step, through: base + 5 * step, reason: 'Explicit bounded source evidence.' },
      { from: base + 4 * step, through: base + 5 * step, reason: 'Overlapping bounded evidence.' }] }),
    fetchGap: rows,
  } }, write: records => store.appendCandles(records as CandleRecord[]), onProgress: task => { snapshots.push(task) } })
  t.after(() => sync.close())
  const task = await sync.enqueue({ ...query, through: last })
  const completed = await sync.waitFor(task.id)
  const initial = snapshots.find(value => value.inspected)!
  assert.deepEqual([initial.coveredRecords, initial.emptyRecords, initial.unavailableRecords, initial.localRecords], [1, 0, 5, 1])
  assert.deepEqual([completed.coveredRecords, completed.emptyRecords, completed.unavailableRecords, completed.localRecords], [5, 0, 5, 1])
  assert.equal(completed.status, 'unavailable')
  assert.equal(completed.writtenRecords, 4)
})

test('completed finite consumers never restart at lease expiry and explicit requests revalidate only the expired slots', async t => {
  const last = base + 299 * step, calls: HistorySourceQuery[] = [], reads: HistoryRange[] = []
  let clock = Date.now(), expiresAt = 0, revision = 0
  const sync = new HistorySync({ metadata: new MemoryMetadata(), now: () => clock,
    sources: { oi: { fetchGap: request => { calls.push(request); return [{ instrument: request.instrument, timeframe: request.timeframe, timestamp: last, oi: null }] } } },
    store: {
      async missingCandleRanges(request) { reads.push({ from: request.from, through: request.through }); return request.from <= last && request.through >= last && expiresAt <= clock ? [{ from: last, through: last }] : [] },
      coverageVersion: () => revision,
      coverageChanges: () => ({ revision, ranges: [{ from: last, through: last }] }),
      coverageLeases: request => request.from <= last && request.through >= last && expiresAt > clock ? [{ from: last, through: last, expiresAt }] : [],
    },
    write() { expiresAt = clock + 10; revision++ },
  })
  t.after(() => sync.close())
  const task = await sync.enqueue({ ...query, through: last, source: 'oi' })
  const first = await sync.waitFor(task.id); await sync.whenIdle()
  assert.deepEqual([first.coveredRecords, first.emptyRecords, first.unavailableRecords, first.localRecords], [299, 1, 0, 299])
  clock += 20
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(calls.length, 1, 'Expiry cannot restart a completed consumer.')
  const initialReads = reads.length
  const repeated = await sync.enqueue({ ...query, through: last, source: 'oi' })
  await sync.waitFor(repeated.id)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.from === last && call.through === last))
  assert.ok(reads.slice(initialReads).every(read => read.from === last && read.through === last), 'Explicit revalidation must reuse every numeric source slot.')
})


test('stopping an admitted partial page preserves its new explicit unavailability and shared coverage cache', async t => {
  const gate = deferred(), entered = deferred(), store = new MemoryStore(), reads: HistoryRange[] = []
  const { sync } = fixture({ store: {
    missingCandleRanges: request => { reads.push({ from: request.from, through: request.through }); return store.missingCandleRanges(request) },
    coverageVersion: () => store.version,
    coverageChanges: () => ({ revision: store.version, ranges: [{ from: base, through: base + step }] }),
  }, sources: { candles: { fetchGap: request => ({ records: rows(request).slice(0, 2), unavailable: [{ from: base + 2 * step, through: base + 2 * step, reason: 'Explicit bounded source evidence.' }] }) } },
    write: async (records, task) => { entered.resolve(); await gate.promise; await store.appendSource(records, task.source) },
  })
  t.after(() => { gate.resolve(); return sync.close() })
  const task = await sync.enqueue(query)
  await entered.promise
  const stopped = sync.cancel(task.id)
  await new Promise(resolve => setImmediate(resolve))
  gate.resolve()
  const cancelled = await stopped
  assert.deepEqual([cancelled.status, cancelled.coveredRecords, cancelled.unavailableRecords], ['cancelled', 2, 1])
  assert.deepEqual(reads, [{ from: base, through: base + 2 * step }, { from: base, through: base + step }], 'Cancellation reuses the verified prefix and only rechecks changed durable slots.')
})
