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
  const store = new MemoryStore(), requests: HistorySourceQuery[] = []
  const sync = new HistorySync({ store, sources: { candles: { fetchGap: request => { requests.push(request); return rows(request) } } },
    minRequestIntervalMS: 0, retryBaseMS: 1, maxRetryDelayMS: 4, ...options })
  return { sync, store, requests }
}

test('validates source identities, ranges, priorities and scheduling limits', async t => {
  assert.throws(() => new HistorySync({} as HistorySyncOptions), /store/)
  for (const options of [{ maxConcurrentTasks: 0 }, { maxConcurrentPerSource: 0 }, { maxAttempts: 0 }, { maxRetainedTerminalTasks: 0 }]) assert.throws(() => fixture(options), /at least/)
  const { sync } = fixture(); t.after(() => sync.close())
  await assert.rejects(sync.enqueue({ ...query, from: base + 1 }), /grid/)
  await assert.rejects(sync.enqueue({ ...query, source: 'unknown' }), /unavailable/)
  await assert.rejects(sync.enqueue({ ...query, priority: 'urgent' as 'foreground' }), /priority/)
})

test('held consumers report local coverage without fetching and recheck after release', async t => {
  const { sync, store, requests } = fixture(); t.after(() => sync.close())
  const read = store.missingCandleRanges.bind(store)
  let reads = 0
  store.missingCandleRanges = async request => { reads++; return read(request) }
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }).slice(0, 2))
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 2)
  assert.equal(sync.getTask(held.id)?.localRecords, 2)
  assert.equal(requests.length, 0)
  const heldReads = reads
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 0, 'A held consumer does not repeatedly admit source work.')
  assert.equal(reads, heldReads, 'A held consumer does not repeatedly scan local history.')
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  assert.equal(sync.release(held.id), true)
  const complete = await sync.waitFor(held.id)
  assert.equal(complete.status, 'completed')
  assert.equal(complete.coveredRecords, 3)
  assert.equal(complete.localRecords, 1, 'A deleted local slot downloaded again is not counted as reuse.')
  assert.deepEqual(requests.map(value => [value.from, value.through]), [[base + 2 * step, base + 2 * step], [base, base]])
})

test('held progress refreshes coalesced dirty ranges without source requests or full-window rescans', async t => {
  const store = new MemoryStore(), append = store.appendSource.bind(store), read = store.missingCandleRanges.bind(store)
  const changes: { revision: number; from: number; through: number }[] = [], reads: HistoryRange[] = []
  store.appendSource = async (records, source) => {
    const result = await append(records, source)
    if (records.length) changes.push({ revision: store.version, from: Math.min(...records.map(value => value.timestamp)), through: Math.max(...records.map(value => value.timestamp)) })
    return result
  }
  store.missingCandleRanges = async request => { reads.push({ from: request.from, through: request.through }); return read(request) }
  ;(store as any).coverageChanges = (_query: unknown, revision: number) => ({ revision: store.version,
    ranges: changes.filter(value => value.revision > revision).map(({ from, through }) => ({ from, through })) })
  let inspections = 0, requests = 0
  const { sync } = fixture({ store, sources: { candles: { inspect: () => { inspections++; return {} }, fetchGap: () => { requests++; return [] } } } })
  t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, through: base + 99 * step, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  for (let batch = 0; batch < 2; batch++) {
    const first = batch * 3, values = rows({ ...query, from: base + first * step, through: base + (first + 2) * step,
      priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })
    await store.appendCandles(values)
    for (const value of values) sync.invalidate({ ...query, from: value.timestamp, through: value.timestamp })
    await waitFor(() => sync.getTask(held.id)?.status === 'waiting' && sync.getTask(held.id)?.coveredRecords === first + 3)
  }
  assert.deepEqual(reads.map(value => (value.through - value.from) / step + 1), [100, 3, 3])
  assert.equal(inspections, 3, 'Each burst coalesces into one local recheck.')
  assert.equal(requests, 0)
  assert.equal(sync.getTask(held.id)?.localRecords, 6)
  await sync.cancel(held.id)
})

test('a second invalidation in the same shared run refreshes a previously rechecked hold', async t => {
  const gate = deferred(), entered = deferred(), store = new MemoryStore()
  let calls = 0
  const { sync } = fixture({ store, sources: { candles: { fetchGap: async request => {
    calls++; entered.resolve(); await gate.promise; return rows(request)
  } } } })
  t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  // Both the interactive task and this recheck must enter the same run.
  sync.invalidate(query)
  await entered.promise
  assert.equal(sync.getTask(held.id)?.status, 'waiting')
  gate.resolve()
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting' && sync.getTask(held.id)?.coveredRecords === 3)
  assert.equal(sync.getTask(held.id)?.localRecords, 0)
  assert.equal(calls, 1)
  await sync.cancel(held.id)
})

test('a foreground upgrade materializes only its part of a larger progress-only gap', async t => {
  const store = new MemoryStore(), read = store.missingCandleRanges.bind(store)
  const reads: { from: number; through: number; materialize: boolean }[] = []
  let derivable = false, requests = 0
  ;(store as any).missingCandleRanges = async (request: HistoryRange, _priority: unknown, options: { materialize: boolean }) => {
    reads.push({ from: request.from, through: request.through, materialize: options.materialize })
    if (derivable && options.materialize) {
      derivable = false
      await store.appendCandles(rows({ ...query, ...request, priority: 'interactive', getPriority: () => 'interactive', cursor: null, signal: new AbortController().signal }))
    }
    return read(request as any)
  }
  const { sync } = fixture({ store, sources: { candles: { fetchGap: () => { requests++; throw new Error('A derivable parent needs no source request.') } } } }); t.after(() => sync.close())
  const bounds = { ...query, through: base + 2399 * step }
  const held = await sync.enqueue({ ...bounds, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const before = reads.length
  derivable = true
  sync.invalidate(bounds)
  await waitFor(() => reads.length > before && sync.getTask(held.id)?.status === 'waiting')
  assert.deepEqual(reads.at(-1), { from: base, through: base + 2399 * step, materialize: false })
  const interactive = await sync.enqueue({ ...query, through: base, priority: 'interactive' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  assert.deepEqual(reads[before + 1], { from: base, through: base, materialize: true })
  assert.ok(reads.slice(before + 1).filter(value => value.materialize).every(value => value.from === base && value.through === base))
  assert.equal(requests, 0)
  await sync.cancel(held.id)
})

test('a newly held consumer receives full initial materialization even beside a dirty existing hold', async t => {
  const store = new MemoryStore(), read = store.missingCandleRanges.bind(store)
  const modes: boolean[] = []
  ;(store as any).missingCandleRanges = async (request: HistoryRange, _priority: unknown, options: { materialize: boolean }) => {
    modes.push(options.materialize)
    return read(request as any)
  }
  const { sync } = fixture({ store }); t.after(() => sync.close())
  const first = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(first.id)?.status === 'waiting')
  const before = modes.length
  sync.invalidate(query)
  const second = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(first.id)?.status === 'waiting' && sync.getTask(second.id)?.status === 'waiting')
  assert.deepEqual(modes.slice(before), [true])
  await Promise.all([sync.cancel(first.id), sync.cancel(second.id)])
})

test('dirty coverage for one held window does not alter another held window', async t => {
  const store = new MemoryStore(), read = store.missingCandleRanges.bind(store), reads: HistoryRange[] = []
  store.missingCandleRanges = async request => { reads.push({ from: request.from, through: request.through }); return read(request) }
  const { sync } = fixture({ store }); t.after(() => sync.close())
  const first = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  const second = await sync.enqueue({ ...query, from: base + 10 * step, through: base + 12 * step, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(first.id)?.status === 'waiting' && sync.getTask(second.id)?.status === 'waiting')
  const before = reads.length
  await store.appendCandles(rows({ ...query, from: base, through: base, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  sync.invalidate({ ...query, from: base, through: base })
  await waitFor(() => sync.getTask(first.id)?.status === 'waiting' && sync.getTask(first.id)?.coveredRecords === 1)
  assert.equal(sync.getTask(second.id)?.status, 'waiting')
  assert.equal(sync.getTask(second.id)?.coveredRecords, 0)
  assert.ok(reads.slice(before).every(value => value.through < base + 10 * step))
  await Promise.all([sync.cancel(first.id), sync.cancel(second.id)])
})

test('a held shared snapshot remembers changes outside its own demand without waking', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), reads: HistoryRange[] = []
  const append = store.appendSource.bind(store), changes: { revision: number; from: number; through: number }[] = []
  store.appendSource = async (records, source) => {
    const result = await append(records, source)
    if (records.length) changes.push({ revision: store.version, from: Math.min(...records.map(row => row.timestamp)), through: Math.max(...records.map(row => row.timestamp)) })
    return result
  }
  ;(store as any).coverageChanges = (_query: unknown, revision: number) => ({ revision: store.version,
    ranges: changes.filter(value => value.revision > revision).map(({ from, through }) => ({ from, through })) })
  store.missingCandleRanges = async request => { reads.push({ from: request.from, through: request.through }); return original(request) }
  const { sync, requests } = fixture({ store }); t.after(() => sync.close())
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const [first, second] = await Promise.all([
    sync.enqueue({ ...query, through: base + step, priority: 'background' }, { hold: true }),
    sync.enqueue({ ...query, from: base + step, priority: 'background' }, { hold: true }),
  ])
  await waitFor(() => sync.getTask(first.id)?.status === 'waiting' && sync.getTask(second.id)?.status === 'waiting')
  const snapshot = (sync as any).heldCoverage.get(first.id)
  assert.deepEqual([snapshot.from, snapshot.through], [base, base + 2 * step])
  await sync.cancel(second.id)
  const countBefore = reads.length
  // A seed or repair changes slot 2 without a durable store revision. The
  // first hold doesn't need it, but its larger shared snapshot still does.
  store.values.delete(store.key({ ...query, timestamp: base + 2 * step }))
  sync.invalidate({ ...query, from: base + 2 * step, through: base + 2 * step })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sync.getTask(first.id)?.status, 'waiting')
  assert.equal(reads.length, countBefore, 'An out-of-demand mutation does not wake the hold.')
  const snapshotDirty = (sync as any).heldCoverage.get(first.id).dirty
  store.values.delete(store.key({ ...query, timestamp: base }))
  sync.invalidate({ ...query, from: base, through: base })
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  const result = await sync.waitFor(interactive.id)
  assert.equal(result.status, 'completed')
  assert.equal(result.coveredRecords, 3)
  assert.deepEqual(requests.map(request => [request.from, request.through]).sort((a, b) => a[0] - b[0]), [[base, base], [base + 2 * step, base + 2 * step]])
  assert.ok(store.values.has(store.key({ ...query, timestamp: base + 2 * step })))
  assert.deepEqual(snapshotDirty, [{ from: base + 2 * step, through: base + 2 * step }])
  await sync.cancel(first.id)
})

test('a price mutation during a held coverage read cannot be lost', async t => {
  const store = new MemoryStore(), read = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let reads = 0
  store.missingCandleRanges = async request => {
    const snapshot = await read(request)
    if (++reads === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  const { sync, requests } = fixture({ store }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await entered.promise
  await store.appendCandles(rows({ ...query, from: base, through: base, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  sync.invalidate({ ...query, from: base, through: base }); gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 1)
  assert.equal(sync.getTask(held.id)?.localRecords, 1)
  assert.ok(reads >= 2)
  assert.equal(requests.length, 0)
  await sync.cancel(held.id)
})

test('overlapping invalidations during a large read recheck only their verified slots', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  const reads: HistoryRange[] = [], changes: { revision: number; from: number; through: number }[] = []
  store.missingCandleRanges = async request => {
    reads.push({ from: request.from, through: request.through })
    const snapshot = await original(request)
    if (reads.length === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = (_query: unknown, revision: number) => ({ revision: store.version,
    ranges: changes.filter(value => value.revision > revision).map(({ from, through }) => ({ from, through })) })
  const { sync, requests } = fixture({ store }); t.after(() => { gate.resolve(); return sync.close() })
  const bounds = { ...query, through: base + 2399 * step }
  const held = await sync.enqueue(bounds, { hold: true }); await entered.promise
  const updated = [37, 42].map(index => rows({ ...query, from: base + index * step, through: base + index * step,
    priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })[0])
  // Model a seed/repair invalidation and an independent durable write. Their
  // evidence must be unioned even though neither journal contains both slots.
  store.values.set(store.key(updated[0]), updated[0])
  await store.appendCandles([updated[1]])
  changes.push({ revision: store.version, from: updated[1].timestamp, through: updated[1].timestamp })
  sync.invalidate({ ...query, from: updated[0].timestamp, through: updated[0].timestamp })
  gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 2)
  assert.deepEqual(reads, [{ from: bounds.from, through: bounds.through }, ...updated.map(row => ({ from: row.timestamp, through: row.timestamp }))])
  assert.equal(requests.length, 0)
  await sync.cancel(held.id)
})

test('explicit invalidation tracks seed or repair changes even without a store revision', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  const reads: HistoryRange[] = []
  store.missingCandleRanges = async request => {
    reads.push({ from: request.from, through: request.through })
    const snapshot = await original(request)
    if (reads.length === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  const { sync } = fixture({ store }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue(query, { hold: true }); await entered.promise
  const row = rows({ ...query, from: base + step, through: base + step, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })[0]
  store.values.set(store.key(row), row)
  sync.invalidate({ ...query, from: row.timestamp, through: row.timestamp }); gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 1)
  assert.deepEqual(reads, [{ from: base, through: base + 2 * step }, { from: base + step, through: base + step }])
  await sync.cancel(held.id)
})

for (const mode of ['truncated', 'unaligned', 'unknown-source', 'unknown-version'] as const) test(`${mode} invalidation during coverage read falls back to a full recheck`, async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  const reads: HistoryRange[] = []
  store.missingCandleRanges = async request => {
    reads.push({ from: request.from, through: request.through })
    const snapshot = await original(request)
    if (reads.length === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  if (mode === 'unknown-version') (store as any).coverageChanges = () => ({ revision: store.version, ranges: null })
  const { sync } = fixture({ store }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue(query, { hold: true }); await entered.promise
  const row = rows({ ...query, from: base + step, through: base + step, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })[0]
  if (mode === 'unknown-version') await store.appendCandles([row])
  else store.values.set(store.key(row), row)
  if (mode === 'truncated') for (let index = 0; index < 257; index++) sync.invalidate({ ...query, from: base + step, through: base + step })
  if (mode === 'unaligned') sync.invalidate({ ...query, from: base + 1, through: base + step })
  if (mode === 'unknown-source') sync.invalidate({ ...query, source: 'unknown' })
  gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 1)
  assert.deepEqual(reads, [{ from: base, through: base + 2 * step }, { from: base, through: base + 2 * step }])
  await sync.cancel(held.id)
})

test('unrelated invalidations during a coverage read do not cause a reread', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let reads = 0
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    if (++reads === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  const { sync } = fixture({ store }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue(query, { hold: true }); await entered.promise
  sync.invalidate({ ...query, from: base + 10 * step, through: base + 10 * step }); gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(reads, 1)
  await sync.cancel(held.id)
})

test('a different valid source does not invalidate this source coverage', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let reads = 0
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    if (++reads === 1) { entered.resolve(); await gate.promise }
    return snapshot
  }
  const { sync } = fixture({ store, sources: { candles: { fetchGap: () => [] }, oi: { fetchGap: () => [] } } })
  t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue(query, { hold: true }); await entered.promise
  sync.invalidate({ ...query, source: 'oi' }); gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(reads, 1)
  await sync.cancel(held.id)
})

test('unknown identity invalidates reads already awaiting their first version', async t => {
  const entered = deferred(), gate = deferred(), reads: HistoryRange[] = []
  let versions = 0
  const store = {
    async coverageVersion() { if (++versions === 1) { entered.resolve(); await gate.promise }; return 0 },
    async missingCandleRanges(request: HistoryRange) { reads.push({ from: request.from, through: request.through }); return [] },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const pending = sync.missing(query, 'background'); await entered.promise
  assert.equal(sync.groups.size, 0, 'The source group has not yet been created.')
  sync.invalidate({ ...query, source: 'unknown' }); gate.resolve()
  await pending
  assert.deepEqual(reads, [{ from: base, through: base + 2 * step }, { from: base, through: base + 2 * step }])
  assert.equal(sync.coverageInvalidations.size, 0)
})

test('a second change while awaiting version evidence forces a safe recheck', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store)
  const entered = deferred(), firstGate = deferred(), evidenceEntered = deferred(), evidenceGate = deferred(), reads: HistoryRange[] = []
  store.missingCandleRanges = async request => {
    reads.push({ from: request.from, through: request.through })
    const snapshot = await original(request)
    if (reads.length === 1) { entered.resolve(); await firstGate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = async (_query: unknown, revision: number) => {
    if (revision === 0 && store.version === 1) { evidenceEntered.resolve(); await evidenceGate.promise; return { revision: 1, ranges: [{ from: base, through: base }] } }
    return { revision: store.version, ranges: [{ from: base, through: base + step }] }
  }
  const { sync } = fixture({ store }); t.after(() => { firstGate.resolve(); evidenceGate.resolve(); return sync.close() })
  const held = await sync.enqueue(query, { hold: true }); await entered.promise
  const values = rows({ ...query, from: base, through: base + step, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })
  await store.appendCandles([values[0]]); firstGate.resolve(); await evidenceEntered.promise
  await store.appendCandles([values[1]])
  sync.invalidate({ ...query, from: values[1].timestamp, through: values[1].timestamp }); evidenceGate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 2)
  assert.deepEqual(reads[1], { from: base, through: base + 2 * step })
  await sync.cancel(held.id)
})

test('coverage invalidation journals are globally bounded and retired after reads settle', async t => {
  const entered = deferred(), gate = deferred(), reads = new Map<string, HistoryRange[]>()
  const store = {
    coverageVersion: () => 0,
    async missingCandleRanges(request: HistoryRange & { instrument: string }) {
      const portions = reads.get(request.instrument) ?? []
      portions.push({ from: request.from, through: request.through }); reads.set(request.instrument, portions)
      if (portions.length === 1) { if (reads.size === 129) entered.resolve(); await gate.promise }
      return []
    },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const inputs = Array.from({ length: 129 }, (_, index) => ({ ...query, instrument: `S${index}` }))
  const tasks = inputs.map(input => sync.missing(input, 'background'))
  await entered.promise
  for (const input of inputs) sync.invalidate({ ...input, from: base + step, through: base + step })
  assert.equal(sync.coverageInvalidations.size, 128)
  gate.resolve(); await Promise.all(tasks)
  assert.deepEqual(reads.get('S0')?.[1], { from: base + step, through: base + step })
  assert.deepEqual(reads.get('S128')?.[1], { from: base, through: base + 2 * step }, 'Missing journal evidence forces full coverage.')
  assert.equal(sync.coverageReaders.size, 0)
  assert.equal(sync.coverageEpochs.size, 0)
  assert.equal(sync.coverageInvalidations.size, 0)
})

test('sustained invalidation retries stay within one reader and a bounded journal', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store)
  const key = JSON.stringify([query.instrument, query.timeframe, query.source]), limit = 2500
  const { sync } = fixture({ store }), internal = sync as any
  t.after(() => sync.close())
  let reads = 0, maxReaders = 0, maxJournal = 0
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    reads++
    if (reads <= limit) {
      if (reads === limit) {
        const value = rows({ ...query, from: base + step, through: base + step, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })[0]
        store.values.set(store.key(value), value)
      }
      sync.invalidate({ ...query, from: base + step, through: base + step })
      maxReaders = Math.max(maxReaders, internal.coverageReaders.get(key) ?? 0)
      maxJournal = Math.max(maxJournal, internal.coverageInvalidations.get(key)?.length ?? 0)
    }
    return snapshot
  }
  assert.deepEqual(await internal.missing(query, 'background'), [{ from: base, through: base }, { from: base + 2 * step, through: base + 2 * step }])
  assert.equal(reads, limit + 1)
  assert.equal(maxReaders, 1)
  assert.ok(maxJournal <= 256)
  assert.equal(internal.coverageReaders.size, 0)
  assert.equal(internal.coverageEpochs.size, 0)
  assert.equal(internal.coverageInvalidations.size, 0)
})

test('a failed iterative coverage recheck releases its reader and journal', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), { sync } = fixture({ store }), internal = sync as any
  t.after(() => sync.close())
  let reads = 0
  store.missingCandleRanges = async request => {
    if (++reads === 30) throw new Error('Injected local read failure.')
    const snapshot = await original(request)
    if (reads < 30) sync.invalidate({ ...query, from: base + step, through: base + step })
    return snapshot
  }
  await assert.rejects(internal.missing(query, 'background'), /Injected local read failure/)
  assert.equal(internal.coverageReaders.size, 0)
  assert.equal(internal.coverageEpochs.size, 0)
  assert.equal(internal.coverageInvalidations.size, 0)
  assert.deepEqual(await internal.missing(query, 'background'), [{ from: base, through: base + 2 * step }])
})

test('an exhausted checkpoint retains but rechecks a newer shared coverage snapshot', async t => {
  const entered = deferred(), gate = deferred()
  let reads = 0
  const store = {
    coverageVersion: () => 0,
    async missingCandleRanges() {
      if (++reads === 1) { entered.resolve(); await gate.promise }
      return []
    },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const stale = sync.missing(query, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await entered.promise
  sync.invalidate({ ...query, from: base, through: base })
  const fresh = await sync.missing(query, 'foreground', undefined, { returnCoverage: true })
  const key = JSON.stringify([query.instrument, query.timeframe, query.source])
  assert.equal(sync.coverageChecks.get(key), fresh.coverage)
  gate.resolve()
  assert.equal(await stale, null)
  assert.equal(sync.coverageChecks.get(key), fresh.coverage, 'A different consumer’s snapshot is not evicted.')
  assert.deepEqual(fresh.coverage.dirty, [{ from: query.from, through: query.through }], 'Its generation is conservatively rechecked.')
})

test('an exhausted checkpoint marks its unchanged shared snapshot dirty for version-only changes', async t => {
  const entered = deferred(), gate = deferred()
  let reads = 0, version = 0
  const store = {
    coverageVersion: () => version,
    coverageChanges: () => ({ revision: version, ranges: [{ from: base, through: base }, { from: base + 2 * step, through: base + 2 * step }] }),
    async missingCandleRanges() {
      if (++reads === 2) { entered.resolve(); await gate.promise }
      return []
    },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const initial = await sync.missing(query, 'background', undefined, { returnCoverage: true })
  const pinned = { ...initial.coverage, through: base + step, dirty: [{ from: base, through: base }] }
  const stale = sync.missing({ ...query, through: base + step }, 'background', pinned, { maxAttempts: 1, returnCoverage: true })
  await entered.promise
  version++
  gate.resolve()
  assert.equal(await stale, null)
  const key = JSON.stringify([query.instrument, query.timeframe, query.source])
  assert.equal(sync.coverageChecks.get(key), initial.coverage)
  assert.deepEqual(initial.coverage.dirty, [{ from: base, through: base + 2 * step }],
    'The larger shared snapshot must be rechecked before reuse.')
})

test('unknown checkpoint evidence dirties all of a larger shared snapshot', async t => {
  const entered = deferred(), gate = deferred()
  let reads = 0, version = 0
  const store = {
    coverageVersion: () => version,
    coverageChanges: () => ({ revision: version, ranges: null }),
    async missingCandleRanges() {
      if (++reads === 2) { entered.resolve(); await gate.promise }
      return []
    },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const initial = await sync.missing(query, 'background', undefined, { returnCoverage: true })
  const pinned = { ...initial.coverage, through: base + step, dirty: [{ from: base, through: base }] }
  const stale = sync.missing({ ...query, through: base + step }, 'background', pinned, { maxAttempts: 1, returnCoverage: true })
  await entered.promise
  version++
  gate.resolve()
  assert.equal(await stale, null)
  assert.deepEqual(initial.coverage.dirty, [{ from: base, through: base + 2 * step }])
})

for (const mode of ['version-after', 'version-before', 'epoch-after'] as const) test(`an exhausted checkpoint rechecks shared data with ${mode} evidence`, async t => {
  const entered = deferred(), gate = deferred()
  let reads = 0, version = 0
  const store = {
    coverageVersion: () => version,
    coverageChanges: () => ({ revision: version, ranges: [{ from: base, through: base }] }),
    async missingCandleRanges() {
      if (++reads === 1) { entered.resolve(); await gate.promise }
      return []
    },
  }
  const sync = new HistorySync({ store, write: async () => {}, sources: { candles: { fetchGap: () => [] } } }) as any
  t.after(() => { gate.resolve(); return sync.close() })
  const stale = sync.missing(query, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await entered.promise
  if (mode === 'version-before') version++
  const shared = await sync.missing(query, 'foreground', undefined, { returnCoverage: true })
  if (mode === 'version-after') version++
  if (mode === 'epoch-after') sync.invalidate({ ...query, from: base, through: base })
  gate.resolve()
  assert.equal(await stale, null)
  const key = JSON.stringify([query.instrument, query.timeframe, query.source])
  assert.equal(sync.coverageChecks.get(key), shared.coverage)
  assert.deepEqual(shared.coverage.dirty, [{ from: query.from, through: query.through }])
  const next = await sync.enqueue(query)
  assert.equal(next.inspected, false, 'A dirty snapshot cannot provide optimistic progress to a new consumer.')
  await sync.cancel(next.id)
})

test('a checkpoint dirtied during source inspection cannot complete from its stale snapshot', async t => {
  const store = new MemoryStore(), inspectEntered = deferred(), inspectGate = deferred(), versionEntered = deferred(), versionGate = deferred()
  const originalVersion = store.coverageVersion.bind(store)
  let suspendVersion = false
  ;(store as any).coverageVersion = async () => {
    const snapshot = originalVersion()
    if (suspendVersion) { suspendVersion = false; versionEntered.resolve(); await versionGate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = () => ({ revision: store.version, ranges: [{ from: base, through: base }] })
  let inspections = 0
  const { sync, requests } = fixture({ store, sources: { candles: {
    inspect: async () => { if (++inspections === 1) { inspectEntered.resolve(); await inspectGate.promise }; return {} },
    fetchGap: request => { requests.push(request); return rows(request) },
  } } })
  t.after(() => { inspectGate.resolve(); versionGate.resolve(); return sync.close() })
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const task = await sync.enqueue(query); await inspectEntered.promise
  suspendVersion = true
  const checkpoint = (sync as any).missing(query, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await versionEntered.promise
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  versionGate.resolve()
  assert.equal(await checkpoint, null)
  inspectGate.resolve()
  const completed = await sync.waitFor(task.id)
  assert.equal(completed.status, 'completed')
  assert.deepEqual(requests.map(request => [request.from, request.through]), [[base, base]])
  assert.ok(store.values.has(store.key({ ...query, timestamp: base })))
})

test('a checkpoint dirtied after a write recheck cannot complete from that stale snapshot', async t => {
  const store = new MemoryStore(), postEntered = deferred(), postGate = deferred(), versionEntered = deferred(), versionGate = deferred()
  const originalVersion = store.coverageVersion.bind(store)
  let suspendVersion = false, written = false, postHeld = false
  ;(store as any).coverageVersion = async () => {
    const snapshot = originalVersion()
    if (suspendVersion) { suspendVersion = false; versionEntered.resolve(); await versionGate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = () => ({ revision: store.version, ranges: [{ from: base, through: base }] })
  const { sync, requests } = fixture({ store, write: async (values, task) => { await store.appendSource(values, task.source); written = true } })
  const originalMissing = (sync as any).missing.bind(sync)
  ;(sync as any).missing = async (...args: any[]) => {
    const result = await originalMissing(...args)
    if (written && !postHeld) { postHeld = true; postEntered.resolve(); await postGate.promise }
    return result
  }
  t.after(() => { postGate.resolve(); versionGate.resolve(); return sync.close() })
  const task = await sync.enqueue(query); await postEntered.promise
  suspendVersion = true
  const checkpoint = originalMissing(query, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await versionEntered.promise
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  versionGate.resolve()
  assert.equal(await checkpoint, null)
  postGate.resolve()
  const completed = await sync.waitFor(task.id)
  assert.equal(completed.status, 'completed')
  assert.deepEqual(requests.map(request => [request.from, request.through]), [[base, base + 2 * step], [base, base]])
  assert.ok(store.values.has(store.key({ ...query, timestamp: base })))
})

for (const globalCache of ['disjoint', 'absent'] as const) test(`an unknown checkpoint invalidates active inspection with ${globalCache} shared coverage`, async t => {
  const store = new MemoryStore(), inspectEntered = deferred(), inspectGate = deferred(), versionEntered = deferred(), versionGate = deferred()
  const originalVersion = store.coverageVersion.bind(store)
  let suspendVersion = false, inspections = 0
  ;(store as any).coverageVersion = async () => {
    const snapshot = originalVersion()
    if (suspendVersion) { suspendVersion = false; versionEntered.resolve(); await versionGate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = () => ({ revision: store.version, ranges: [{ from: base, through: base + 10 * step }] })
  const { sync, requests } = fixture({ store, sources: { candles: {
    inspect: async () => { if (++inspections === 1) { inspectEntered.resolve(); await inspectGate.promise }; return {} },
    fetchGap: request => { requests.push(request); return rows(request) },
  } } })
  t.after(() => { inspectGate.resolve(); versionGate.resolve(); return sync.close() })
  const other = { ...query, from: base + 10 * step, through: base + 10 * step }
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const task = await sync.enqueue(query); await inspectEntered.promise
  const internal = sync as any, key = JSON.stringify([query.instrument, query.timeframe, query.source])
  await internal.missing(other, 'background')
  assert.deepEqual([internal.coverageChecks.get(key).from, internal.coverageChecks.get(key).through], [other.from, other.through])
  suspendVersion = true
  const checkpoint = internal.missing(other, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await versionEntered.promise
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  if (globalCache === 'absent') internal.coverageChecks.delete(key)
  versionGate.resolve(); assert.equal(await checkpoint, null)
  inspectGate.resolve()
  assert.equal((await sync.waitFor(task.id)).status, 'completed')
  assert.deepEqual(requests.map(request => [request.from, request.through]), [[base, base]])
  assert.ok(store.values.has(store.key({ ...query, timestamp: base })))
})

test('an unknown checkpoint rechecks held coverage beyond the shared cache range', async t => {
  const store = new MemoryStore(), versionEntered = deferred(), versionGate = deferred(), originalVersion = store.coverageVersion.bind(store)
  let suspendVersion = false
  ;(store as any).coverageVersion = async () => {
    const snapshot = originalVersion()
    if (suspendVersion) { suspendVersion = false; versionEntered.resolve(); await versionGate.promise }
    return snapshot
  }
  ;(store as any).coverageChanges = () => ({ revision: store.version, ranges: [{ from: base, through: base + 10 * step }] })
  const { sync, requests } = fixture({ store }); t.after(() => { versionGate.resolve(); return sync.close() })
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const held = await sync.enqueue(query, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.coveredRecords, 3)
  const other = { ...query, from: base + 10 * step, through: base + 10 * step }, internal = sync as any
  await internal.missing(other, 'background')
  suspendVersion = true
  const checkpoint = internal.missing(other, 'background', undefined, { maxAttempts: 1, returnCoverage: true })
  await versionEntered.promise
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  versionGate.resolve(); assert.equal(await checkpoint, null)
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting' && sync.getTask(held.id)?.coveredRecords === 2)
  assert.deepEqual(sync.getTask(held.id)?.remaining, [{ from: base, through: base }])
  assert.equal(requests.length, 0)
  await sync.cancel(held.id)
})

test('releasing during suspended inspection cannot complete from stale local coverage', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore(), requests: HistorySourceQuery[] = []
  let inspections = 0
  const { sync } = fixture({ store, sources: { candles: {
    inspect: async () => { if (++inspections === 1) { entered.resolve(); await gate.promise }; return {} },
    fetchGap: request => { requests.push(request); return rows(request) },
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await entered.promise
  store.values.delete(store.key({ ...query, timestamp: base })); store.version++
  assert.equal(sync.release(held.id), true)
  gate.resolve()
  const complete = await sync.waitFor(held.id)
  assert.equal(complete.status, 'completed')
  assert.equal(complete.coveredRecords, 3)
  assert.deepEqual(requests.map(value => [value.from, value.through]), [[base, base]])
  assert.ok(inspections >= 2, 'Release must force fresh local inspection before completion.')
})

test('unrelated writes to the same series do not repeatedly restart an inspected range', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  let inspections = 0
  const { sync } = fixture({ store, sources: { candles: {
    inspect: async () => { inspections++; entered.resolve(); await gate.promise; return {} },
    fetchGap: request => rows(request),
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  await store.appendCandles(rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }))
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await entered.promise
  for (let index = 0; index < 100; index++) sync.invalidate({ ...query, from: base + 100 * step, through: base + 100 * step })
  gate.resolve()
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(inspections, 1, 'Unrelated invalidations cannot starve an already inspected range.')
  await sync.cancel(held.id)
})

test('a disjoint interactive inspection cannot complete a released hold from stale shared coverage', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore(), requests: HistorySourceQuery[] = []
  const later = base + 100 * step
  const { sync } = fixture({ store, sources: { candles: {
    inspect: async request => { if (request.from === base) { entered.resolve(); await gate.promise }; return {} },
    fetchGap: request => { requests.push(request); return rows(request) },
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  const template = rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })
  await store.appendCandles([template[0], { ...template[0], timestamp: later }])
  const held = await sync.enqueue({ ...query, from: later, through: later, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, from: base, through: base, priority: 'interactive' })
  await entered.promise
  store.values.delete(store.key({ ...query, timestamp: later })); store.version++
  assert.equal(sync.release(held.id), true)
  gate.resolve()
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  const completed = await sync.waitFor(held.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.localRecords, 0)
  assert.deepEqual(requests.map(value => [value.from, value.through]), [[later, later]])
})

test('a distant interactive consumer cannot expand a held archive read across the intervening history', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), spans: number[] = []
  store.missingCandleRanges = async request => {
    const span = (request.through - request.from) / request.intervalMS + 1
    spans.push(span)
    assert.ok(span <= 3, `Unexpected unbounded coverage read of ${span} slots.`)
    return original(request)
  }
  const { sync } = fixture({ store }); t.after(() => sync.close())
  const distant = base + 365 * 24 * 12 * step
  const held = await sync.enqueue({ ...query, from: distant, through: distant + 2 * step, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  assert.ok(spans.length >= 2)
  assert.equal((await sync.cancel(held.id)).status, 'cancelled')
})

test('overlapping held and interactive windows retain the bounded coverage read size', async t => {
  const spans: number[] = []
  const store = { async missingCandleRanges(request: HistoryRange & { intervalMS: number }) {
    spans.push((request.through - request.from) / request.intervalMS + 1)
    return []
  } }
  const sync = new HistorySync({ store, sources: { candles: { fetchGap: () => { throw new Error('All slots are local.') } } }, write: async () => {} })
  t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, from: base + 2399 * step, through: base + 4798 * step, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, from: base, through: base + 2399 * step, priority: 'interactive' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  assert.ok(spans.every(value => value <= 2400), `Coverage reads were not bounded: ${spans}`)
  await sync.cancel(held.id)
})

test('disjoint ready consumers each complete using their own bounded coverage snapshot', async t => {
  const { sync, requests } = fixture(); t.after(() => sync.close())
  const later = base + 365 * 24 * 12 * step
  const [first, second] = await Promise.all([
    sync.enqueue({ ...query, priority: 'foreground' }),
    sync.enqueue({ ...query, from: later, through: later + 2 * step, priority: 'foreground' }),
  ])
  const results = await Promise.all([sync.waitFor(first.id), sync.waitFor(second.id)])
  assert.ok(results.every(value => value.status === 'completed' && value.coveredRecords === 3))
  assert.equal(requests.length, 2)
  assert.ok(requests.every(value => value.through - value.from <= 2 * step))
})

test('an interactive consumer bypasses a hold and its failure does not fail the held consumer', async t => {
  let failed = true, calls = 0
  const { sync } = fixture({ maxAttempts: 1, sources: { candles: { fetchGap: request => {
    calls++
    if (failed) throw new Error('Interactive source unavailable.')
    return rows(request)
  } } } }); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  assert.equal((await sync.waitFor(interactive.id)).status, 'paused')
  assert.equal(sync.getTask(held.id)?.status, 'waiting')
  assert.equal(sync.getTask(held.id)?.attempts, 0)
  failed = false
  assert.equal(sync.release(held.id), true)
  assert.equal((await sync.waitFor(held.id)).status, 'completed')
  assert.equal(calls, 2)
})

test('a held consumer can be cancelled independently without occupying source capacity', async t => {
  const { sync, requests } = fixture(); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal((await sync.cancel(held.id)).status, 'cancelled')
  assert.equal(sync.release(held.id), false)
  const normal = await sync.enqueue({ ...query, priority: 'foreground' })
  assert.equal((await sync.waitFor(normal.id)).status, 'completed')
  assert.equal(requests.length, 1)
})

test('held reuse excludes shared and repeated downloads while counting later local materialization', async t => {
  const { sync, store, requests } = fixture(); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  for (let iteration = 0; iteration < 2; iteration++) {
    if (iteration) { store.values.delete(store.key({ ...query, timestamp: base })); store.version++; sync.invalidate({ ...query, from: base, through: base }) }
    const interactive = await sync.enqueue({ ...query, from: base, through: base, priority: 'interactive' })
    assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  }
  const materialized = rows({ ...query, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal }).slice(1)
  await store.appendCandles(materialized)
  sync.invalidate({ ...query, from: base + step, through: base + 2 * step })
  assert.equal(sync.release(held.id), true)
  const complete = await sync.waitFor(held.id)
  assert.equal(complete.status, 'completed')
  assert.equal(complete.coveredRecords, 3)
  assert.equal(complete.localRecords, 2, 'Only the locally materialized slots count as reused.')
  assert.equal(requests.length, 2, 'Repeated downloads of the same slot are recorded once for reuse accounting.')
})

test('held coverage counts neither empty leases nor explicit unavailable slots as local numeric reuse', async t => {
  const store = {
    async missingCandleRanges() { return [{ from: base + 2 * step, through: base + 2 * step }] },
    coverageLeases() { return [{ from: base + step, through: base + step, expiresAt: base + 60_000 }] },
  }
  const sync = new HistorySync({ store, now: () => base, sources: { oi: {
    inspect: () => ({ unavailable: [{ from: base + 2 * step, through: base + 2 * step, reason: 'Not offered.' }] }),
    fetchGap: () => { throw new Error('Known coverage cannot require a source fetch.') },
  } }, write: async () => {} }); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, source: 'oi', priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.deepEqual([sync.getTask(held.id)?.coveredRecords, sync.getTask(held.id)?.emptyRecords,
    sync.getTask(held.id)?.unavailableRecords, sync.getTask(held.id)?.localRecords], [1, 1, 1, 1])
  sync.release(held.id)
  const complete = await sync.waitFor(held.id)
  assert.deepEqual([complete.status, complete.coveredRecords, complete.emptyRecords, complete.unavailableRecords, complete.localRecords], ['unavailable', 1, 1, 1, 1])
})

test('an unavailable gap next to an empty lease remains distinct through hold and release', async t => {
  let calls = 0
  const store = {
    async missingCandleRanges() { return [{ from: base, through: base }] },
    coverageLeases() { return [{ from: base + step, through: base + step, expiresAt: base + 60_000 }] },
  }
  const sync = new HistorySync({ store, now: () => base, sources: { oi: {
    inspect: () => ({ unavailable: [{ from: base, through: base, reason: 'Not offered.' }] }),
    fetchGap: () => { calls++; return [] },
  } }, write: async () => {} }); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, through: base + step, source: 'oi', priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.deepEqual(sync.getTask(held.id)?.remaining, [{ from: base, through: base }])
  assert.equal(sync.release(held.id), true)
  const result = await sync.waitFor(held.id)
  assert.deepEqual([result.status, result.coveredRecords, result.emptyRecords, result.unavailableRecords, result.localRecords], ['unavailable', 0, 1, 1, 0])
  assert.deepEqual(result.remaining, [{ from: base, through: base }])
  assert.equal(calls, 0)
})

test('release rechecks source availability rather than retaining an obsolete held boundary', async t => {
  let unavailable = true, calls = 0
  const { sync } = fixture({ sources: { candles: {
    inspect: () => unavailable ? { unavailable: [{ ...query, reason: 'Before current listing.' }] } : {},
    fetchGap: request => { calls++; return rows(request) },
  } } }); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.unavailableRecords, 3)
  unavailable = false
  sync.release(held.id)
  const completed = await sync.waitFor(held.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.coveredRecords, 3)
  assert.equal(completed.unavailableRecords, 0)
  assert.equal(calls, 1)
})

test('a held dirty-range refresh rechecks changed source availability without fetching', async t => {
  let unavailable = true, calls = 0, inspections = 0
  const { sync } = fixture({ sources: { candles: {
    inspect: () => { inspections++; return unavailable ? { unavailable: [{ ...query, reason: 'Previous boundary.' }] } : {} },
    fetchGap: () => { calls++; return [] },
  } } }); t.after(() => sync.close())
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.getTask(held.id)?.unavailableRecords, 3)
  unavailable = false
  for (let index = 0; index < 3; index++) sync.invalidate({ ...query, from: base + index * step, through: base + index * step })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting' && sync.getTask(held.id)?.unavailableRecords === 0)
  assert.equal(inspections, 2, 'The invalidation burst is checked once.')
  assert.equal(calls, 0)
  await sync.cancel(held.id)
})

test('a released hold does not inherit another consumer’s obsolete in-flight unavailable proof', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  let unavailable = true, calls = 0
  const { sync } = fixture({ store, sources: { candles: {
    inspect: () => unavailable ? { unavailable: [{ from: base, through: base, reason: 'Previously unavailable.' }] } : {},
    fetchGap: async request => {
      if (++calls === 1) { entered.resolve(); await gate.promise }
      return rows(request)
    },
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  await entered.promise
  unavailable = false
  assert.equal(sync.release(held.id), true)
  gate.resolve()
  await sync.waitFor(interactive.id)
  const completed = await sync.waitFor(held.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.coveredRecords, 3)
  assert.equal(completed.unavailableRecords, 0)
  assert.equal(calls, 2, 'The newly available slot is acquired after the old shared page.')
})

test('an empty recheck is not mistaken for progress because of an obsolete shared unavailable proof', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  let unavailable = true, calls = 0
  const { sync } = fixture({ store, maxAttempts: 1, sources: { candles: {
    inspect: () => unavailable ? { unavailable: [{ from: base, through: base, reason: 'Previously unavailable.' }] } : {},
    fetchGap: async request => {
      if (++calls === 1) { entered.resolve(); await gate.promise; return rows(request) }
      return []
    },
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  await entered.promise
  unavailable = false; sync.release(held.id); gate.resolve()
  await sync.waitFor(interactive.id)
  const paused = await sync.waitFor(held.id)
  assert.equal(paused.status, 'paused')
  assert.match(paused.lastError!, /no persisted coverage progress/)
  assert.equal(calls, 2)
})

test('a released multi-page hold keeps its proof isolated until completion', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  let unavailable = true, calls = 0
  const extended = { ...query, through: base + 3 * step }
  const { sync } = fixture({ store, sources: { candles: {
    pageSize: 1,
    inspect: () => unavailable ? { unavailable: [{ from: base, through: base, reason: 'Previously unavailable.' }] } : {},
    fetchGap: async request => { if (++calls === 1) { entered.resolve(); await gate.promise }; return rows(request) },
  } } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...extended, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...extended, priority: 'interactive' })
  await entered.promise
  unavailable = false; sync.release(held.id); gate.resolve()
  const [previous, completed] = await Promise.all([sync.waitFor(interactive.id), sync.waitFor(held.id)])
  assert.equal(previous.status, 'unavailable', 'The other consumer retains its prior explicit source evidence.')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.coveredRecords, 4)
  assert.equal(completed.unavailableRecords, 0)
  assert.equal(calls, 4, 'The released hold must acquire the formerly unavailable slot on a later page.')
})

for (const stage of ['fetch', 'write'] as const) test(`a held consumer joining an in-flight ${stage} does not count its shared download as reuse`, async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  const { sync } = fixture({ store, sources: { candles: { fetchGap: async request => {
    if (stage === 'fetch') { entered.resolve(); await gate.promise }
    return rows(request)
  } } }, write: async (values, task) => {
    if (stage === 'write') { entered.resolve(); await gate.promise }
    await store.appendSource(values, task.source)
  } }); t.after(() => { gate.resolve(); return sync.close() })
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  await entered.promise
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  gate.resolve()
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  assert.equal(sync.release(held.id), true)
  const complete = await sync.waitFor(held.id)
  assert.equal(complete.coveredRecords, 3)
  assert.equal(complete.localRecords, 0, 'The same shared source download is not reclassified as local data.')
})

for (const stage of ['fetch', 'write'] as const) test(`held progress refresh survives a shared ${stage} in flight`, async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  const { sync } = fixture({ store, sources: { candles: { fetchGap: async request => {
    if (stage === 'fetch') { entered.resolve(); await gate.promise }
    return rows(request)
  } } }, write: async (values, task) => {
    if (stage === 'write') { entered.resolve(); await gate.promise }
    await store.appendSource(values, task.source)
  } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, from: base, through: base, priority: 'interactive' })
  await entered.promise
  const local = rows({ ...query, from: base + step, through: base + step, priority: 'background', getPriority: () => 'background', cursor: null, signal: new AbortController().signal })
  await store.appendCandles(local); sync.invalidate({ ...query, from: base + step, through: base + step })
  gate.resolve(); await sync.waitFor(interactive.id)
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting' && sync.getTask(held.id)?.coveredRecords === 2)
  assert.equal(sync.getTask(held.id)?.localRecords, 1)
  await sync.cancel(held.id)
})

test('cancelling a held consumer during a shared admitted write keeps downloaded slots out of reuse', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  const { sync } = fixture({ store, write: async (values, task) => {
    entered.resolve(); await gate.promise; await store.appendSource(values, task.source)
  } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
  await entered.promise
  const stopped = sync.cancel(held.id)
  gate.resolve()
  const cancelled = await stopped
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.coveredRecords, 3)
  assert.equal(cancelled.localRecords, 0)
  assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
})

test('closing during an accepted shared write preserves the cancelled hold checkpoint', async t => {
  const entered = deferred(), gate = deferred(), store = new MemoryStore()
  const { sync } = fixture({ store, write: async (values, task) => {
    entered.resolve(); await gate.promise; await store.appendSource(values, task.source)
  } }); t.after(() => { gate.resolve(); return sync.close() })
  const held = await sync.enqueue({ ...query, priority: 'background' }, { hold: true })
  await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
  await sync.enqueue({ ...query, priority: 'interactive' })
  await entered.promise
  const stopped = sync.cancel(held.id)
  await waitFor(() => sync.getTask(held.id)?.status === 'cancelled')
  const closing = sync.close()
  gate.resolve()
  const cancelled = await stopped
  await closing
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.coveredRecords, 3)
  assert.equal(cancelled.localRecords, 0)
})

test('overlapping and adjacent consumers share one canonical API page without persisted execution rows', async t => {
  const { sync, requests } = fixture(); t.after(() => sync.close())
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

for (const shared of [false, true]) test(`accepted write cancellation stays bounded under permanent invalidation (shared=${shared})`, async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let written = false, changing = true, reads = 0, fetches = 0, sourceSignal: AbortSignal | undefined
  const { sync } = fixture({ store, sources: { candles: { fetchGap: request => { fetches++; sourceSignal = request.signal; return rows(request) } } },
    write: async (records, task) => { entered.resolve(); await gate.promise; await store.appendSource(records, task.source); written = true } })
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    if (written && changing) { reads++; sync.invalidate({ ...query, from: base, through: base }); await new Promise(resolve => setImmediate(resolve)) }
    return snapshot
  }
  t.after(async () => { changing = false; gate.resolve(); await sync.close() })
  const first = await sync.enqueue(query), second = shared ? await sync.enqueue(query) : null
  await entered.promise
  let settled = false
  const stopped = sync.cancel(first.id).then(result => { settled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'Cancellation must wait for the admitted write.')
  if (shared) assert.equal(sourceSignal?.aborted, false, 'Cancelling one consumer cannot abort shared work.')
  assert.equal(store.values.size, 0)
  gate.resolve()
  let timer: ReturnType<typeof setTimeout>
  const result = await Promise.race([stopped, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000) })])
  clearTimeout(timer!)
  assert.ok(result, 'Cancellation must not wait for permanently changing coverage.')
  assert.equal(store.values.size, 3, 'The acknowledged write remains durable.')
  assert.deepEqual([result.status, result.writtenRecords, result.coveredRecords, result.emptyRecords, result.unavailableRecords, result.localRecords],
    ['cancelled', 3, 0, 0, 0, 0])
  assert.deepEqual(result.remaining, [{ from: query.from, through: query.through }])
  assert.ok(reads > 0)
  changing = false
  if (second) assert.equal((await sync.waitFor(second.id)).status, 'completed')
  await sync.whenIdle()
  assert.equal(fetches, 1)
  assert.equal((sync as any).coverageReaders.size, 0)
  assert.equal((sync as any).coverageInvalidations.size, 0)
})

test('close joins an accepted write but does not wait for permanently changing coverage', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let written = false, changing = true
  const { sync } = fixture({ store, write: async (records, task) => { entered.resolve(); await gate.promise; await store.appendSource(records, task.source); written = true } })
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    if (written && changing) { sync.invalidate({ ...query, from: base, through: base }); await new Promise(resolve => setImmediate(resolve)) }
    return snapshot
  }
  t.after(async () => { changing = false; gate.resolve(); await sync.close() })
  await sync.enqueue(query); await entered.promise
  let closed = false
  const closing = sync.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false, 'Close must join an admitted write.')
  gate.resolve()
  let timer: ReturnType<typeof setTimeout>
  const complete = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) })])
  clearTimeout(timer!)
  assert.equal(complete, true)
  assert.equal(store.values.size, 3)
  assert.equal((sync as any).active.size, 0)
  assert.equal((sync as any).coverageReaders.size, 0)
})

test('a failed accepted write still settles cancellation without inventing coverage', async t => {
  const store = new MemoryStore(), entered = deferred(), gate = deferred()
  const { sync } = fixture({ store, write: async () => { entered.resolve(); await gate.promise; throw new Error('Injected write failure.') } })
  t.after(() => { gate.resolve(); return sync.close() })
  const task = await sync.enqueue(query); await entered.promise
  const stopping = sync.cancel(task.id); gate.resolve()
  const result = await stopping
  assert.deepEqual([result.status, result.writtenRecords, result.coveredRecords, result.emptyRecords, result.unavailableRecords], ['cancelled', 0, 0, 0, 0])
  assert.equal(store.values.size, 0)
  await sync.whenIdle()
})

test('a failed post-write checkpoint retains the durable count without claiming coverage', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let written = false
  const { sync } = fixture({ store, write: async (records, task) => { entered.resolve(); await gate.promise; await store.appendSource(records, task.source); written = true } })
  store.missingCandleRanges = async request => {
    if (written) throw new Error('Injected checkpoint failure.')
    return original(request)
  }
  t.after(() => { gate.resolve(); return sync.close() })
  const task = await sync.enqueue(query); await entered.promise
  const stopping = sync.cancel(task.id); gate.resolve()
  await assert.rejects(stopping, /Injected checkpoint failure/)
  await sync.whenIdle()
  const result = sync.getTask(task.id)!
  assert.deepEqual([result.status, result.writtenRecords, result.coveredRecords, result.emptyRecords, result.unavailableRecords], ['cancelled', 3, 0, 0, 0])
  assert.deepEqual(result.remaining, [{ from: query.from, through: query.through }])
  assert.equal(store.values.size, 3)
  assert.equal((sync as any).coverageReaders.size, 0)
})

for (const action of ['cancel', 'close'] as const) test(`${action} stops a coverage read under continuous invalidation`, async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred()
  const { sync } = fixture({ store }), internal = sync as any
  let reads = 0, changing = true
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    reads++; entered.resolve()
    if (changing) {
      sync.invalidate({ ...query, from: base, through: base })
      await new Promise(resolve => setImmediate(resolve))
    }
    return snapshot
  }
  t.after(async () => { changing = false; await sync.close() })
  const task = await sync.enqueue(query); await entered.promise
  const stopping = action === 'cancel' ? sync.cancel(task.id).then(() => sync.whenIdle()) : sync.close()
  let timer: ReturnType<typeof setTimeout>
  const stopped = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) })])
  clearTimeout(timer!)
  if (!stopped) changing = false
  assert.equal(stopped, true, `${action} must not wait for invalidations to stop.`)
  const stoppedAt = reads
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, stoppedAt)
  assert.equal(internal.active.size, 0)
  assert.equal(internal.coverageReaders.size, 0)
  assert.equal(internal.coverageInvalidations.size, 0)
})

test('cancelling one shared consumer preserves another through continuously changing coverage', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred()
  const { sync } = fixture({ store })
  let reads = 0, changing = true
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    reads++; entered.resolve()
    if (changing) {
      sync.invalidate({ ...query, from: base, through: base })
      await new Promise(resolve => setImmediate(resolve))
    }
    return snapshot
  }
  t.after(async () => { changing = false; await sync.close() })
  const [first, second] = await Promise.all([sync.enqueue(query), sync.enqueue(query)])
  await entered.promise
  assert.equal((await sync.cancel(first.id)).status, 'cancelled')
  await waitFor(() => reads >= 3)
  changing = false
  assert.equal((await sync.waitFor(second.id)).status, 'completed')
  assert.equal(store.values.size, 3)
  await sync.whenIdle()
})

test('a cancelled accepted write still retries its durable checkpoint during invalidation', async t => {
  const store = new MemoryStore(), original = store.missingCandleRanges.bind(store), entered = deferred(), gate = deferred()
  let written = false, checkpointReads = 0
  const { sync } = fixture({ store, write: async (records, task) => {
    entered.resolve(); await gate.promise; await store.appendSource(records, task.source); written = true
  } })
  store.missingCandleRanges = async request => {
    const snapshot = await original(request)
    if (written && checkpointReads++ < 4) {
      sync.invalidate({ ...query, from: base, through: base })
      await new Promise(resolve => setImmediate(resolve))
    }
    return snapshot
  }
  t.after(() => { gate.resolve(); return sync.close() })
  const task = await sync.enqueue(query); await entered.promise
  let stopped = false
  const cancelled = sync.cancel(task.id).then(value => { stopped = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'An accepted write still owns its durable completion.')
  gate.resolve()
  const result = await cancelled
  assert.deepEqual([result.status, result.coveredRecords, result.writtenRecords], ['cancelled', 3, 3])
  assert.equal(store.values.size, 3)
  assert.ok(checkpointReads >= 5, 'Transient invalidations are rechecked before reporting coverage.')
  await sync.whenIdle()
  assert.equal((sync as any).coverageReaders.size, 0)
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
  const { sync } = fixture({ sources: { candles: { fetchGap: request => new Promise((_resolve, reject) => { signal = request.signal; request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) }) } } })
  t.after(() => sync.close())
  const task = await sync.enqueue(query); await waitFor(() => Boolean(signal)); await sync.cancel(task.id); await sync.whenIdle()
  assert.equal(signal?.aborted, true)
})

test('startup needs no metadata and admits no source demand', async t => {
  const { sync, requests } = fixture()
  t.after(() => sync.close())
  assert.equal(await sync.start(), sync)
  await sync.whenIdle()
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
  const { sync } = fixture({ maxAttempts: 2, sources: { candles: { fetchGap: request => { attempts++; if (failed) throw new Error('Temporary source outage.'); return rows(request) } } } })
  t.after(() => sync.close())
  const manual = await sync.enqueue(query), consumer = await sync.enqueue({ ...query, priority: 'foreground' })
  const stopped = await Promise.all([sync.waitFor(manual.id), sync.waitFor(consumer.id)])
  assert.ok(stopped.every(task => task.status === 'paused' && task.attempts === 2))
  await sync.whenIdle()
  assert.equal(attempts, 2)
  failed = false
  await sync.resume(manual.id)
  assert.equal((await sync.waitFor(manual.id)).status, 'completed')
  assert.equal(attempts, 3)
  assert.equal(sync.getTask(consumer.id)?.status, 'paused')
})

test('delisting during admission cannot resurrect a finite consumer', async t => {
  const { sync } = fixture()
  t.after(() => sync.close())
  await sync.start()
  const admission = sync.enqueue(query)
  const retired = assert.rejects(admission, { name: 'AbortError' })
  await sync.removeTargets([query.instrument]); await retired
  assert.deepEqual(sync.listTasks(), [])
})

test('completed consumer handles stay bounded while durable coverage is reused', async t => {
  const { sync, requests } = fixture({ maxRetainedTerminalTasks: 4 })
  t.after(() => sync.close())
  for (let index = 0; index < 20; index++) {
    const task = await sync.enqueue(query)
    await sync.waitFor(task.id); await sync.whenIdle()
  }
  assert.equal(sync.listTasks().length, 4)
  assert.equal(requests.length, 1)
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
  const sync = new HistorySync({ now: () => clock,
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
