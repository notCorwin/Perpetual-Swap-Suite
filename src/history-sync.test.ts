import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySync } from '../electron/services/history-sync.js'
import type { HistoryRange, HistorySourceQuery, HistoryTask, HistorySyncOptions } from '../electron/services/history-sync.js'
import { MarketStore } from '../electron/services/market-store.js'
import type { CandleRecord } from '../electron/services/market-store.js'
import { MetadataStore } from '../electron/services/metadata-store.js'

const intervalMS = 300_000
const base = Date.UTC(2024, 0, 1)
const request = { instrument: 'BTC-USDT-SWAP', timeframe: '5m' as const, source: 'candles', from: base, through: base + 2 * intervalMS }
const candle = (timestamp: number, instrument = request.instrument, timeframe = request.timeframe): CandleRecord => ({ instrument, timeframe, timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 0.01, quoteVolume: 1, confirmed: true })
const records = (query: HistorySourceQuery) => {
  const step = { '5m': intervalMS, '15m': 900_000, '1H': 3_600_000 }[query.timeframe]
  return Array.from({ length: (query.through - query.from) / step + 1 }, (_, index) => candle(query.from + index * step, query.instrument, query.timeframe as '5m'))
}
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(fulfill => { resolve = fulfill })
  return { promise, resolve }
}
class MemoryMetadata {
  tasks = new Map<string, HistoryTask>()
  putSyncTask(task: HistoryTask) { this.tasks.set(task.id, structuredClone(task)); return structuredClone(task) }
  getSyncTask(id: string) { return structuredClone(this.tasks.get(id) ?? null) }
  listSyncTasks() { return [...this.tasks.values()].map(value => structuredClone(value)) }
  deleteSyncTask(id: string) { return this.tasks.delete(id) }
}
type CoverageQuery = HistoryRange & { instrument: string; timeframe: string; source: string; intervalMS: number }
class MemoryStore {
  rows = new Map<string, CandleRecord>()
  queries: CoverageQuery[] = []
  async appendCandles(values: CandleRecord[]) {
    values.forEach(value => this.rows.set(`${value.instrument}:${value.timeframe}:${value.timestamp}`, structuredClone(value)))
    return values.length
  }
  async missingCandleRanges(query: CoverageQuery): Promise<HistoryRange[]> {
    this.queries.push(structuredClone(query))
    const result: HistoryRange[] = []
    let first: number | null = null
    for (let timestamp = query.from; timestamp <= query.through; timestamp += query.intervalMS) {
      if (!this.rows.has(`${query.instrument}:${query.timeframe}:${timestamp}`)) first ??= timestamp
      else if (first !== null) { result.push({ from: first, through: timestamp - query.intervalMS }); first = null }
    }
    if (first !== null) result.push({ from: first, through: query.through })
    return result
  }
}
const create = (options: Partial<HistorySyncOptions> = {}) => {
  const metadata = new MemoryMetadata(), store = new MemoryStore()
  const sync = new HistorySync({ metadata, store, sources: { candles: { fetchGap: records } }, minRequestIntervalMS: 0, retryBaseMS: 1, maxRetryDelayMS: 4, ...options })
  return { sync, metadata, store }
}

test('history requests reject invalid grids, sources, priorities, and constructor limits', async () => {
  assert.throws(() => new HistorySync({} as HistorySyncOptions), /metadata/)
  assert.throws(() => create({ maxAttempts: 0 }), /maxAttempts/)
  assert.throws(() => create({ retryBaseMS: 10, maxRetryDelayMS: 5 }), /maxRetryDelayMS/)
  assert.throws(() => create({ minRequestIntervalMS: 2 ** 32 }), /2147483647/)
  const { sync } = create()
  try {
    await assert.rejects(sync.enqueue({ ...request, from: base + 1 }), /grid/)
    await assert.rejects(sync.enqueue({ ...request, through: base - intervalMS }), /ordered/)
    await assert.rejects(sync.enqueue({ ...request, source: 'missing' }), /unavailable/)
    await assert.rejects(sync.enqueue({ ...request, timeframe: '1m' as '5m' }), /timeframe/)
    await assert.rejects(sync.enqueue({ ...request, priority: 'urgent' as 'foreground' }), /priority/)
    await assert.rejects(sync.enqueueTarget({ ...request, historyDays: 0 }), /historyDays/)
    await assert.rejects(sync.resume('unknown'), /Unknown history task/)
    assert.equal(sync.listTasks().length, 0)
  } finally { await sync.close() }
  await assert.rejects(sync.enqueue(request), /closed/)
})

test('concurrent foreground and background requests share one durable task and completed history is not downloaded again', async () => {
  let fetches = 0
  const { sync, metadata, store } = create({ sources: { candles: { fetchGap(query) { fetches += 1; return records(query) } } } })
  try {
    const [background, foreground] = await Promise.all([sync.enqueue(request), sync.enqueue({ ...request, priority: 'foreground' })])
    assert.equal(background.id, foreground.id)
    assert.equal(sync.listTasks().length, 1)
    assert.equal(sync.getTask(background.id)?.priority, 'foreground')
    const result = await sync.waitFor(background.id)
    assert.equal(result.status, 'completed')
    assert.equal(store.rows.size, 3)
    assert.equal(metadata.getSyncTask(result.id)?.status, 'completed')
    assert.equal(fetches, 1)
    await sync.enqueue(request)
    await sync.whenIdle()
    assert.equal(fetches, 1)
    result.remaining.push({ from: 0, through: 0 })
    assert.deepEqual(sync.getTask(result.id)?.remaining, [])
    assert.ok(store.queries.every(query => query.intervalMS === intervalMS && query.source === 'candles'))
  } finally { await sync.close() }
})

test('containing requests share a task and partial overlaps fetch only the remaining persisted gap', async () => {
  const entered = deferred(), release = deferred()
  const queries: HistorySourceQuery[] = []
  const { sync } = create({ sources: { candles: { async fetchGap(query) {
    queries.push(query)
    if (queries.length === 1) { entered.resolve(); await release.promise }
    return records(query)
  } } } })
  try {
    const first = await sync.enqueue(request)
    await entered.promise
    const contained = await sync.enqueue({ ...request, from: base + intervalMS, priority: 'foreground' })
    const overlap = await sync.enqueue({ ...request, from: base + intervalMS, through: base + 4 * intervalMS })
    assert.equal(contained.id, first.id)
    release.resolve()
    await sync.whenIdle()
    assert.equal(sync.getTask(overlap.id)?.status, 'completed')
    assert.deepEqual(queries.map(({ from, through }) => ({ from, through })), [
      { from: base, through: base + 2 * intervalMS },
      { from: base + 3 * intervalMS, through: base + 4 * intervalMS },
    ])
  } finally { release.resolve(); await sync.close() }
})

test('restart resumes a saved pagination cursor against persisted missing ranges', async () => {
  const metadata = new MemoryMetadata(), store = new MemoryStore(), secondPage = deferred()
  let requests = 0
  const first = create({ metadata, store, sources: { candles: { async fetchGap(query) {
    requests += 1
    if (requests === 1) return { records: [candle(query.through)], cursor: 'page-2' }
    secondPage.resolve()
    return new Promise<CandleRecord[]>((_, reject) => query.signal.addEventListener('abort', () => reject(query.signal.reason), { once: true }))
  } } } }).sync
  const task = await first.enqueue(request)
  await secondPage.promise
  await first.close()
  assert.equal(metadata.getSyncTask(task.id)?.status, 'queued')
  assert.equal(metadata.getSyncTask(task.id)?.cursor, 'page-2')
  const queries: HistorySourceQuery[] = []
  const restarted = create({ metadata, store, sources: { candles: { fetchGap(query) { queries.push(query); return records(query) } } } }).sync
  try {
    await restarted.start()
    const result = await restarted.waitFor(task.id)
    assert.equal(result.status, 'completed')
    assert.equal(queries.length, 1)
    assert.equal(queries[0].cursor, 'page-2')
    assert.equal(queries[0].through, base + intervalMS)
    assert.equal(store.rows.size, 3)
  } finally { await restarted.close() }
})

test('pagination cursors are never reused across disjoint missing ranges', async () => {
  const store = new MemoryStore(), queries: HistorySourceQuery[] = []
  await store.appendCandles([candle(base + intervalMS)])
  const { sync } = create({ store, sources: { candles: { fetchGap(query) { queries.push(query); return { records: records(query), cursor: 'previous-gap' } } } } })
  try {
    await sync.enqueue(request)
    await sync.whenIdle()
    assert.equal(queries.length, 2)
    assert.equal(queries[1].from, base + 2 * intervalMS)
    assert.equal(queries[1].cursor, null)
  } finally { await sync.close() }
})

test('an interrupted running checkpoint is recovered without refetching already published Parquet data', async () => {
  const metadata = new MemoryMetadata(), store = new MemoryStore()
  let fetches = 0
  const options = { metadata, store, sources: { candles: { fetchGap(query: HistorySourceQuery) { fetches += 1; return records(query) } } } }
  const first = create(options).sync
  const task = await first.enqueue(request)
  await first.whenIdle()
  await first.close()
  metadata.putSyncTask({ ...metadata.getSyncTask(task.id)!, status: 'running', remaining: [{ from: request.from, through: request.through }] })
  const restarted = create(options).sync
  try {
    await restarted.start()
    assert.equal((await restarted.waitFor(task.id)).status, 'completed')
    assert.equal(fetches, 1)
  } finally { await restarted.close() }
})

test('transient failures back off on the shared request lane and complete without a permanent failed task', async () => {
  const calls: number[] = [], retryDeadlines: number[] = []
  const { sync } = create({ minRequestIntervalMS: 20, retryBaseMS: 2, maxRetryDelayMS: 8,
    onProgress(task) { if (task.status === 'retry') retryDeadlines.push(task.nextAttemptAt!) },
    sources: { candles: { fetchGap(query) {
      calls.push(Date.now())
      if (calls.length < 3) throw new Error('Temporarily unavailable.')
      return records(query)
    } } },
  })
  try {
    const task = await sync.enqueue(request)
    const result = await sync.waitFor(task.id)
    assert.equal(result.status, 'completed')
    assert.equal(result.attempts, 0)
    assert.equal(calls.length, 3)
    assert.equal(retryDeadlines.length, 2)
    assert.ok(calls[1] - calls[0] >= 18)
    assert.ok(calls[2] - calls[1] >= 18)
  } finally { await sync.close() }
})

test('empty pages have bounded retries, retain real gaps, and can be resumed', async () => {
  let ready = false, fetches = 0
  const { sync } = create({ maxAttempts: 2, sources: { candles: { fetchGap(query) { fetches += 1; return ready ? records(query) : [] } } } })
  try {
    const task = await sync.enqueue(request)
    const paused = await sync.waitFor(task.id)
    await sync.whenIdle()
    assert.equal(paused.status, 'paused')
    assert.equal(fetches, 2)
    assert.match(paused.lastError!, /no persisted coverage progress/)
    assert.deepEqual(paused.unavailableRanges, [])
    assert.deepEqual(paused.remaining, [{ from: base, through: base + 2 * intervalMS }])
    ready = true
    await sync.resume(task.id)
    assert.equal((await sync.waitFor(task.id)).status, 'completed')
    assert.equal(fetches, 3)
  } finally { await sync.close() }
})

test('pause aborts an active request, cancellation suppresses queued work, and foreground work runs next', async () => {
  const entered = deferred(), calls: string[] = []
  let block = true
  const { sync } = create({ sources: { candles: { async fetchGap(query) {
    calls.push(query.instrument)
    if (query.instrument === 'BLOCK-USDT-SWAP' && block) {
      block = false
      entered.resolve()
      return new Promise<CandleRecord[]>((_, reject) => query.signal.addEventListener('abort', () => reject(query.signal.reason), { once: true }))
    }
    return records(query)
  } } } })
  try {
    const blocked = await sync.enqueue({ ...request, instrument: 'BLOCK-USDT-SWAP' })
    await entered.promise
    const background = await sync.enqueue({ ...request, instrument: 'BACKGROUND-USDT-SWAP' })
    const foreground = await sync.enqueue({ ...request, instrument: 'FOREGROUND-USDT-SWAP', priority: 'foreground' })
    await sync.pause(blocked.id)
    await sync.cancel(background.id)
    await sync.whenIdle()
    assert.deepEqual(calls, ['BLOCK-USDT-SWAP', 'FOREGROUND-USDT-SWAP'])
    assert.equal(sync.getTask(blocked.id)?.status, 'paused')
    assert.equal(sync.getTask(background.id)?.status, 'cancelled')
    assert.equal(sync.getTask(foreground.id)?.status, 'completed')
    await sync.resume(blocked.id)
    assert.equal((await sync.waitFor(blocked.id)).status, 'completed')
  } finally { await sync.close() }
})

test('explicit source boundaries remain accurately unavailable and an explicit resume rechecks them', async () => {
  let listedLater = true, fetches = 0, inspections = 0
  const { sync } = create({ sources: { candles: {
    inspect() { inspections += 1; return listedLater ? { availableFrom: base + intervalMS, reason: 'The instrument was listed later.' } : {} },
    fetchGap(query) { fetches += 1; return records(query) },
  } } })
  try {
    const task = await sync.enqueue(request)
    const unavailable = await sync.waitFor(task.id)
    assert.equal(unavailable.status, 'unavailable')
    assert.deepEqual(unavailable.remaining, [{ from: base, through: base }])
    assert.deepEqual(unavailable.unavailableRanges, [{ from: base, through: base, reason: 'The instrument was listed later.' }])
    await sync.enqueue(request)
    await sync.whenIdle()
    assert.equal(fetches, 1)
    listedLater = false
    await sync.resume(task.id)
    assert.equal((await sync.waitFor(task.id)).status, 'completed')
    assert.equal(inspections, 2)
    assert.equal(fetches, 2)
  } finally { await sync.close() }
})

test('default targets keep 30 days of user history separate from 200 EMA warmup bars on the matching grid', async () => {
  const queries: CoverageQuery[] = []
  const { sync } = create({ store: { async missingCandleRanges(query) { queries.push(query); return [] }, async appendCandles() { return 0 } },
    sources: { candles: { fetchGap() { throw new Error('Complete history must not be fetched.') } } },
  })
  try {
    const hour = 3_600_000, asOf = base + 60 * 86_400_000 + 37_000
    const { history, warmup } = await sync.enqueueTarget({ instrument: request.instrument, timeframe: '1H', source: 'candles', asOf })
    await sync.whenIdle()
    assert.equal(history.purpose, 'history')
    assert.equal((history.through - history.from) / hour + 1, 30 * 24)
    assert.equal(history.through, Math.floor(asOf / hour) * hour - hour)
    assert.equal(warmup?.purpose, 'warmup')
    assert.equal(warmup?.through, history.from - hour)
    assert.equal((warmup!.through - warmup!.from) / hour + 1, 200)
    assert.ok(queries.every(query => query.intervalMS === hour))
  } finally { await sync.close() }
})

test('source-specific coverage never treats existing candle prices as complete OI or taker data', async () => {
  const coverage = new Set<string>(['candles'])
  const fetched: string[] = [], checked: string[] = []
  const { sync } = create({
    store: { async missingCandleRanges(query) { checked.push(query.source); return coverage.has(query.source) ? [] : [{ from: query.from, through: query.through }] } },
    write(_values, task) { coverage.add(task.source) },
    sources: Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { fetchGap(query: HistorySourceQuery) { fetched.push(query.source); return records(query) } }])),
  })
  try {
    await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await sync.whenIdle()
    assert.deepEqual(fetched.sort(), ['oi', 'taker'])
    assert.deepEqual(new Set(checked), new Set(['candles', 'oi', 'taker']))
    assert.ok(sync.listTasks().every(task => task.status === 'completed'))
  } finally { await sync.close() }
})

test('invalid source data and failed durable writes cannot mark missing history completed', async () => {
  let mode = 'unconfirmed', writes = 0
  const store = new MemoryStore()
  const { sync } = create({ store, maxAttempts: 1,
    write(values) { writes += 1; if (mode === 'write-failure') throw new Error('Disk write failed.'); return store.appendCandles(values) },
    onProgress() { throw new Error('An observer cannot break synchronization.') },
    sources: { candles: { fetchGap(query) { return records(query).map(value => ({ ...value, confirmed: mode !== 'unconfirmed' })) } } },
  })
  try {
    const task = await sync.enqueue(request)
    assert.equal((await sync.waitFor(task.id)).status, 'paused')
    assert.equal(writes, 0)
    mode = 'write-failure'
    await sync.resume(task.id)
    assert.match((await sync.waitFor(task.id)).lastError!, /Disk write failed/)
    assert.equal(store.rows.size, 0)
    mode = 'ready'
    await sync.resume(task.id)
    assert.equal((await sync.waitFor(task.id)).status, 'completed')
    assert.equal(store.rows.size, 3)
  } finally { await sync.close() }
})

test('SQLite task checkpoints and Parquet candles survive a real store restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-history-sync-'))
  let metadata = await MetadataStore.open(root), store = await MarketStore.open(root)
  let fetches = 0
  const sources = { candles: { fetchGap(query: HistorySourceQuery) { fetches += 1; return records(query) } } }
  let sync = new HistorySync({ metadata, store, sources, minRequestIntervalMS: 0 })
  try {
    const task = await sync.enqueue(request)
    assert.equal((await sync.waitFor(task.id)).status, 'completed')
    await sync.close()
    await store.close()
    metadata.close()
    metadata = await MetadataStore.open(root)
    store = await MarketStore.open(root)
    sync = new HistorySync({ metadata, store, sources, minRequestIntervalMS: 0 })
    await sync.start()
    await sync.enqueue(request)
    await sync.whenIdle()
    assert.equal(sync.getTask(task.id)?.status, 'completed')
    assert.equal(fetches, 1)
    assert.equal((await store.candles(request)).length, 3)
  } finally { await sync.close(); await store.close(); metadata.close(); await rm(root, { recursive: true, force: true }) }
})
