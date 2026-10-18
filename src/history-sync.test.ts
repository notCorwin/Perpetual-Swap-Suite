import { test } from 'node:test'
import { createHash } from 'node:crypto'
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
const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('History gate did not open.')), 3_000) })]) }
  finally { clearTimeout(timer) }
}
class MemoryMetadata {
  writes = 0
  tasks = new Map<string, HistoryTask>()
  putSyncTask(task: HistoryTask) { this.writes++; this.tasks.set(task.id, structuredClone(task)); return structuredClone(task) }
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
class VersionedMemoryStore extends MemoryStore {
  revision = 0
  changes: { revision: number; from: number; through: number }[] = []
  coverageVersion() { return this.revision }
  coverageChanges(_query: HistoryRange, revision: number) {
    return { revision: this.revision, ranges: revision < (this.changes[0]?.revision ?? 1) - 1 ? null : this.changes.filter(change => change.revision > revision).map(({ from, through }) => ({ from, through })) }
  }
  changed(from: number, through = from) {
    this.changes.push({ revision: ++this.revision, from, through })
    if (this.changes.length > 256) this.changes.shift()
  }
  override async appendCandles(values: CandleRecord[]) {
    const result = await super.appendCandles(values)
    if (values.length) this.changed(Math.min(...values.map(row => row.timestamp)), Math.max(...values.map(row => row.timestamp)))
    return result
  }
}
const sourceStorage = () => {
  const stores = new Map<string, MemoryStore>()
  const forSource = (source: string) => {
    if (!stores.has(source)) stores.set(source, new MemoryStore())
    return stores.get(source)!
  }
  return {
    stores,
    store: { missingCandleRanges(query: CoverageQuery) { return forSource(query.source).missingCandleRanges(query) } },
    write(values: CandleRecord[], task: HistoryTask) { return forSource(task.source).appendCandles(values) },
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
  assert.throws(() => create({ maxConcurrentTasks: 0 }), /maxConcurrentTasks/)
  assert.throws(() => create({ maxConcurrentTasks: 1.5 }), /maxConcurrentTasks/)
  assert.throws(() => create({ retryBaseMS: 10, maxRetryDelayMS: 5 }), /maxRetryDelayMS/)
  assert.throws(() => create({ minRequestIntervalMS: 2 ** 32 }), /2147483647/)
  assert.throws(() => create({ maxRetainedTerminalTasks: 0 }), /maxRetainedTerminalTasks/)
  assert.throws(() => create({ maxRetainedTerminalTasks: 1.5 }), /maxRetainedTerminalTasks/)
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

test('contained and overlapping requests keep exact task identities and fetch only remaining persisted gaps', async () => {
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
    const contained = await sync.enqueue({ ...request, from: base + intervalMS })
    const overlap = await sync.enqueue({ ...request, from: base + intervalMS, through: base + 4 * intervalMS })
    assert.notEqual(contained.id, first.id)
    assert.equal((await sync.enqueue({ ...request, from: base + intervalMS })).id, contained.id)
    release.resolve()
    await sync.whenIdle()
    assert.equal(sync.getTask(overlap.id)?.status, 'completed')
    assert.equal(sync.getTask(contained.id)?.status, 'completed')
    assert.deepEqual(queries.map(({ from, through }) => ({ from, through })), [
      { from: base, through: base + 2 * intervalMS },
      { from: base + 3 * intervalMS, through: base + 4 * intervalMS },
    ])
  } finally { release.resolve(); await sync.close() }
})

test('an exact background page completes independently of its still-queued containing history target', async () => {
  const entered = deferred(), release = deferred(), resumed = deferred(), resumeHistory = deferred()
  const queries: HistorySourceQuery[] = [], published: number[] = []
  const store = new MemoryStore()
  const { sync } = create({ store, maxConcurrentTasks: 3,
    async write(values) { published.push(...values.map(value => value.timestamp)); await store.appendCandles(values) },
    sources: { candles: { async fetchGap(query) {
      queries.push(query)
      if (queries.length === 1) {
        entered.resolve(); await release.promise
        return { records: [candle(query.from)], cursor: 'history-next-page' }
      }
      if (queries.length > 2) { resumed.resolve(); await resumeHistory.promise }
      return records(query)
    } } },
  })
  try {
    const history = await sync.enqueue({ ...request, through: base + 5 * intervalMS, purpose: 'history' })
    await within(entered.promise)
    const page = await sync.enqueue({ ...request, from: base + 2 * intervalMS, through: base + 3 * intervalMS })
    assert.notEqual(page.id, history.id)
    assert.equal(sync.getTask(history.id)?.status, 'running')
    release.resolve()
    assert.equal((await within(sync.waitFor(page.id))).status, 'completed')
    assert.notEqual(sync.getTask(history.id)?.status, 'completed')
    assert.deepEqual(queries.slice(0, 2).map(({ from, through, priority }) => ({ from, through, priority })), [
      { from: base, through: base + 5 * intervalMS, priority: 'background' },
      { from: base + 2 * intervalMS, through: base + 3 * intervalMS, priority: 'background' },
    ])
    await within(resumed.promise)
    resumeHistory.resolve()
    assert.equal((await within(sync.waitFor(history.id))).status, 'completed')
    assert.equal(published.length, 6)
    assert.equal(new Set(published).size, 6)
  } finally { release.resolve(); resumeHistory.resolve(); await sync.close() }
})

test('a foreground window completes before its containing background target and the background rechecks shared coverage', async () => {
  const entered = deferred(), release = deferred(), nextPage = deferred<HistorySourceQuery>(), resumeBackground = deferred()
  const queries: HistorySourceQuery[] = [], published: number[] = []
  const store = new MemoryStore()
  const { sync } = create({ store,
    async write(values) { published.push(...values.map(value => value.timestamp)); await store.appendCandles(values) },
    sources: { candles: { async fetchGap(query) {
      queries.push(query)
      if (queries.length === 1) {
        entered.resolve()
        await release.promise
        return { records: [candle(query.from)], cursor: 'background-next' }
      }
      if (queries.length === 2) nextPage.resolve(query)
      if (query.priority === 'background') await resumeBackground.promise
      return records(query)
    } } },
  })
  try {
    const background = await sync.enqueue({ ...request, through: base + 5 * intervalMS, purpose: 'history' })
    await entered.promise
    const foreground = await sync.enqueue({ ...request, from: base + 2 * intervalMS, through: base + 3 * intervalMS, priority: 'foreground' })
    assert.notEqual(foreground.id, background.id)
    assert.equal(sync.getTask(background.id)?.priority, 'background')
    assert.equal((await sync.enqueue({ ...foreground, priority: 'foreground' })).id, foreground.id)
    release.resolve()
    assert.equal((await nextPage.promise).priority, 'foreground')
    assert.equal((await sync.waitFor(foreground.id)).status, 'completed')
    assert.notEqual(sync.getTask(background.id)?.status, 'completed')
    resumeBackground.resolve()
    assert.equal((await sync.waitFor(background.id)).status, 'completed')
    assert.deepEqual(queries.map(({ from, through, priority, cursor }) => ({ from, through, priority, cursor })), [
      { from: base, through: base + 5 * intervalMS, priority: 'background', cursor: null },
      { from: base + 2 * intervalMS, through: base + 3 * intervalMS, priority: 'foreground', cursor: null },
      { from: base + intervalMS, through: base + intervalMS, priority: 'background', cursor: null },
      { from: base + 4 * intervalMS, through: base + 5 * intervalMS, priority: 'background', cursor: null },
    ])
    assert.equal(published.length, 6)
    assert.equal(new Set(published).size, 6)
  } finally { release.resolve(); resumeBackground.resolve(); await sync.close() }
})

test('foreground work takes the next source call when it arrives during background inspection', async () => {
  const entered = deferred(), release = deferred()
  const calls: string[] = []
  const { sync } = create({ sources: { candles: {
    async inspect(query) {
      calls.push(`inspect:${query.priority}`)
      if (query.priority === 'background') { entered.resolve(); await release.promise }
      return {}
    },
    fetchGap(query) { calls.push(`fetch:${query.priority}`); return records(query) },
  } } })
  try {
    const background = await sync.enqueue({ ...request, through: base + 5 * intervalMS })
    await entered.promise
    const foreground = await sync.enqueue({ ...request, from: base + 2 * intervalMS, through: base + 3 * intervalMS, priority: 'foreground' })
    release.resolve()
    assert.equal((await sync.waitFor(foreground.id)).status, 'completed')
    await sync.whenIdle()
    assert.deepEqual(calls, ['inspect:background', 'inspect:foreground', 'fetch:foreground', 'fetch:background', 'fetch:background'])
    assert.equal(sync.getTask(background.id)?.attempts, 0)
    assert.equal(sync.getTask(background.id)?.lastError, null)
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

test('three sources overlap their HTTP pages while each source admits only one task', async () => {
  const storage = sourceStorage(), entered = deferred(), release = deferred()
  const counts = new Map<string, number>(), active = new Set<string>()
  let simultaneous = 0, peak = 0
  const { sync } = create({ ...storage, maxConcurrentTasks: 3,
    sources: Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { async fetchGap(query: HistorySourceQuery) {
      assert.equal(active.has(source), false, `${source} has overlapping tasks`)
      active.add(source)
      counts.set(source, (counts.get(source) ?? 0) + 1)
      simultaneous += 1
      peak = Math.max(peak, simultaneous)
      try {
        if (counts.get(source) === 1) {
          if (simultaneous === 3) entered.resolve()
          await release.promise
        }
        return records(query)
      } finally { active.delete(source); simultaneous -= 1 }
    } } ])),
  })
  try {
    await Promise.all(['candles', 'oi', 'taker'].flatMap(source => ['FIRST', 'SECOND'].map(instrument => sync.enqueue({ ...request, source, instrument }))))
    await within(entered.promise)
    assert.equal(peak, 3)
    assert.deepEqual([...counts.values()], [1, 1, 1])
    release.resolve()
    await within(sync.whenIdle())
    assert.deepEqual([...counts.values()], [2, 2, 2])
    assert.ok(sync.listTasks().every(task => task.status === 'completed'))
    assert.ok([...storage.stores.values()].every(store => store.rows.size === 6))
  } finally { release.resolve(); await sync.close() }
})

test('the pool enforces a configured bound smaller than the number of ready sources', async () => {
  const entered = deferred(), release = deferred(), storage = sourceStorage()
  let active = 0, peak = 0, calls = 0
  const { sync } = create({ ...storage, maxConcurrentTasks: 2,
    sources: Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { async fetchGap(query: HistorySourceQuery) {
      active += 1; calls += 1; peak = Math.max(peak, active)
      if (calls === 2) entered.resolve()
      try { await release.promise; return records(query) }
      finally { active -= 1 }
    } }])),
  })
  try {
    await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await within(entered.promise)
    assert.equal(calls, 2)
    release.resolve()
    await within(sync.whenIdle())
    assert.equal(calls, 3)
    assert.equal(peak, 2)
  } finally { release.resolve(); await sync.close() }
})

test('active stats pages can await a later candle dependency despite another source having queued foreground work', async () => {
  const storage = sourceStorage(), statsEntered = deferred(), addDependencies = deferred(), candleEntered = deferred()
  let statsCalls = 0, statsFinished = 0, candleCalls = 0
  let sync!: HistorySync
  const dependency = { ...request, from: base + intervalMS, through: base + intervalMS }
  const stats = { async fetchGap(query: HistorySourceQuery) {
    if (query.instrument === request.instrument) {
      statsCalls += 1
      if (statsCalls === 2) statsEntered.resolve()
      await addDependencies.promise
      const task = await sync.enqueue(dependency)
      assert.equal((await sync.waitFor(task.id)).status, 'completed')
      statsFinished += 1
    }
    return records(query)
  } }
  sync = create({ ...storage, maxConcurrentTasks: 3, sources: { oi: stats, taker: stats, candles: { fetchGap(query) {
    candleCalls += 1
    assert.equal(statsFinished, 0)
    assert.deepEqual({ from: query.from, through: query.through }, { from: dependency.from, through: dependency.through })
    candleEntered.resolve()
    return records(query)
  } } } }).sync
  try {
    const tasks = await Promise.all(['oi', 'taker'].map(source => sync.enqueue({ ...request, source, priority: 'foreground' })))
    await within(statsEntered.promise)
    await sync.enqueue({ ...request, source: 'oi', instrument: 'NEXT-USDT-SWAP', priority: 'foreground' })
    addDependencies.resolve()
    await within(candleEntered.promise)
    assert.ok((await within(Promise.all(tasks.map(task => sync.waitFor(task.id))))).every(task => task.status === 'completed'))
    await within(sync.whenIdle())
    assert.equal(candleCalls, 1)
    assert.equal(statsFinished, 2)
  } finally { addDependencies.resolve(); await sync.close() }
})

test('eighteen background history and warmup admissions finish with exact page dependencies and no duplicate downloads', async () => {
  const storage = sourceStorage(), downloaded = new Set<string>(), active = new Set<string>()
  let statsCalls = 0, sync!: HistorySync
  const sources = Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { async fetchGap(query: HistorySourceQuery) {
    assert.equal(active.has(source), false)
    active.add(source)
    try {
      const page = { ...query, from: Math.max(query.from, query.through - 99 * intervalMS) }
      if (source !== 'candles') {
        statsCalls += 1
        // Model the bounded HTTP response arriving before its price merge.
        await Promise.resolve()
        const dependency = await sync.enqueue({ ...page, source: 'candles', priority: query.priority })
        assert.deepEqual({ from: dependency.from, through: dependency.through }, { from: page.from, through: page.through })
        assert.equal((await sync.waitFor(dependency.id)).status, 'completed')
      }
      const values = records(page)
      for (const value of values) {
        const id = `${source}:${query.instrument}:${value.timestamp}`
        assert.equal(downloaded.has(id), false, `duplicate download: ${id}`)
        downloaded.add(id)
      }
      return values
    } finally { active.delete(source) }
  } }]))
  sync = create({ ...storage, sources, maxConcurrentTasks: 3 }).sync
  try {
    const targets = await Promise.all(['BTC', 'ETH', 'SOL'].flatMap(instrument => ['candles', 'oi', 'taker'].map(source => sync.enqueueTarget({
      instrument: `${instrument}-USDT-SWAP`, source, timeframe: '5m', historyDays: 1, warmupCandles: 2, asOf: base + 60 * 86_400_000,
    }))))
    const admitted = targets.flatMap(({ history, warmup }) => [history, warmup!])
    assert.equal(new Set(admitted.map(task => task.id)).size, 18)
    await within(sync.whenIdle())
    assert.ok(admitted.every(task => sync.getTask(task.id)?.status === 'completed'))
    assert.equal(statsCalls, 24)
    assert.equal(downloaded.size, 3 * 3 * (288 + 2))
  } finally { await sync.close() }
})

test('equal-priority targets rotate after each page and foreground work still takes the next page', async () => {
  let now = base
  const entered = deferred(), release = deferred(), calls: string[] = []
  const { sync } = create({ now: () => now++, maxConcurrentTasks: 3, sources: { candles: { async fetchGap(query) {
    calls.push(query.instrument)
    if (calls.length === 1) { entered.resolve(); await release.promise }
    return [candle(query.from, query.instrument)]
  } } } })
  try {
    await sync.enqueue({ ...request, instrument: 'OLDER-USDT-SWAP', purpose: 'history' })
    await within(entered.promise)
    await sync.enqueue({ ...request, instrument: 'NEWER-USDT-SWAP', purpose: 'history' })
    await sync.enqueue({ ...request, instrument: 'FOREGROUND-USDT-SWAP', through: base, priority: 'foreground' })
    release.resolve()
    await within(sync.whenIdle())
    assert.deepEqual(calls, ['OLDER-USDT-SWAP', 'FOREGROUND-USDT-SWAP', 'NEWER-USDT-SWAP', 'OLDER-USDT-SWAP', 'NEWER-USDT-SWAP', 'OLDER-USDT-SWAP', 'NEWER-USDT-SWAP'])
  } finally { release.resolve(); await sync.close() }
})

test('cancel and close drain every accepted concurrent write before restart rechecks durable coverage', async () => {
  const storage = sourceStorage(), metadata = new MemoryMetadata(), entered = deferred()
  const releases = new Map(['candles', 'oi', 'taker'].map(source => [source, deferred()]))
  const published = new Map(['candles', 'oi', 'taker'].map(source => [source, deferred()]))
  let writes = 0, fetches = 0, closed = false, idle = false
  const sources = Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { fetchGap(query: HistorySourceQuery) { fetches += 1; return { records: records(query), cursor: 'do-not-checkpoint' } } }]))
  let sync = create({ ...storage, metadata, sources, maxConcurrentTasks: 3,
    async write(values, task) {
      writes += 1
      if (writes === 3) entered.resolve()
      await releases.get(task.source)!.promise
      await storage.write(values, task)
      published.get(task.source)!.resolve()
    },
  }).sync
  try {
    const tasks = await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await within(entered.promise)
    const idleResult = sync.whenIdle().then(() => { idle = true; return null }, error => error)
    await sync.cancel(tasks[1].id)
    const closing = sync.close()
    assert.equal(sync.close(), closing)
    const closedResult = closing.then(() => { closed = true })
    releases.get('candles')!.resolve()
    await within(published.get('candles')!.promise)
    assert.equal(closed, false)
    assert.equal(idle, false)
    releases.get('oi')!.resolve()
    await within(published.get('oi')!.promise)
    assert.equal(closed, false)
    releases.get('taker')!.resolve()
    await within(closedResult)
    assert.match((await idleResult).message, /closed/)
    assert.deepEqual(tasks.map(task => metadata.getSyncTask(task.id)?.status), ['queued', 'cancelled', 'queued'])
    assert.ok(tasks.every(task => metadata.getSyncTask(task.id)?.cursor === null))
    assert.equal([...storage.stores.values()].reduce((count, store) => count + store.rows.size, 0), 9)
    sync = create({ ...storage, metadata, sources, maxConcurrentTasks: 3 }).sync
    await sync.start()
    for (const task of tasks) {
      await sync.enqueue(task)
      assert.equal((await sync.waitFor(task.id)).status, 'completed')
    }
    await sync.whenIdle()
    assert.equal(fetches, 3)
  } finally { releases.forEach(gate => gate.resolve()); await sync.close() }
})

test('close releases stats waiting for queued or writing candle dependencies before joining workers', async () => {
  for (const maxConcurrentTasks of [2, 3]) {
    const storage = sourceStorage(), metadata = new MemoryMetadata()
    const waiting = deferred(), writing = deferred(), releaseWrite = deferred(), cleanup = deferred()
    let dependencies = 0, rejected = 0, writes = 0, closed = false
    let sync!: HistorySync
    const stats = { async fetchGap(query: HistorySourceQuery) {
      const dependency = await sync.enqueue({ ...request, through: base })
      const completion = sync.waitFor(dependency.id)
      await Promise.resolve()
      dependencies += 1
      if (dependencies === 2) waiting.resolve()
      try { await Promise.race([completion, cleanup.promise]) }
      catch (error) { rejected += 1; throw error }
      return records(query)
    } }
    sync = create({ ...storage, metadata, maxConcurrentTasks, sources: { oi: stats, taker: stats, candles: { fetchGap: records } },
      async write(values, task) { writes += 1; writing.resolve(); await releaseWrite.promise; return storage.write(values, task) },
    }).sync
    try {
      await Promise.all(['oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
      await within(waiting.promise)
      if (maxConcurrentTasks === 3) await within(writing.promise)
      const closing = sync.close().then(() => { closed = true })
      if (maxConcurrentTasks === 3) {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(closed, false)
      }
      releaseWrite.resolve()
      await within(closing)
      assert.equal(rejected, 2)
      assert.equal(writes, maxConcurrentTasks === 3 ? 1 : 0)
      assert.ok(metadata.listSyncTasks().every(task => task.status === 'queued'))
    } finally { cleanup.resolve(); releaseWrite.resolve(); await sync.close() }
  }
})

test('source admission delays cannot shorten the next start interval or serialize HTTP completion', async () => {
  let now = 1_000
  const { sync } = create({ now: () => now, minRequestIntervalMS: 20 })
  const starts: number[] = [], release = deferred()
  const signal = new AbortController().signal
  const lane = sync as any
  lane.delay = async (milliseconds: number) => { now += milliseconds }
  try {
    const first = lane.callSource(() => { now += 7; starts.push(now); return release.promise }, signal, { priority: 'foreground' })
    await lane.callSource(() => { starts.push(now); return {} }, signal, { priority: 'foreground' })
    assert.deepEqual(starts, [1_007, 1_027], 'Pacing must start from the actual invocation, including time spent admitting the source.')
    release.resolve()
    await first
  } finally { release.resolve(); await sync.close() }
})

test('concurrent inspections and HTTP fetches share the global request-start interval without awaiting HTTP completion', async () => {
  const storage = sourceStorage(), entered = deferred(), release = deferred(), calls: number[] = []
  let fetches = 0
  const { sync } = create({ ...storage, maxConcurrentTasks: 3, minRequestIntervalMS: 20,
    sources: Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, {
      inspect() { calls.push(Date.now()); return {} },
      async fetchGap(query: HistorySourceQuery) {
        calls.push(Date.now()); fetches += 1
        if (fetches === 3) entered.resolve()
        await release.promise
        return records(query)
      },
    }])),
  })
  try {
    await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await within(entered.promise)
    assert.equal(calls.length, 6)
    assert.ok(calls.slice(1).every((time, index) => time - calls[index] >= 19), `source starts: ${calls.join(', ')}`)
    release.resolve()
    await within(sync.whenIdle())
  } finally { release.resolve(); await sync.close() }
})

test('a retry on a free source wakes while another source is still fetching', async () => {
  const storage = sourceStorage(), entered = deferred(), retried = deferred(), release = deferred()
  let attempts = 0
  const { sync } = create({ ...storage, maxConcurrentTasks: 2, retryBaseMS: 10, maxRetryDelayMS: 10, sources: {
    candles: { async fetchGap(query) { entered.resolve(); await release.promise; return records(query) } },
    oi: { fetchGap(query) { attempts += 1; if (attempts === 1) throw new Error('Retry this page.'); retried.resolve(); return records(query) } },
  } })
  try {
    await sync.enqueue(request)
    await within(entered.promise)
    const oi = await sync.enqueue({ ...request, source: 'oi' })
    await within(retried.promise)
    assert.equal((await sync.waitFor(oi.id)).status, 'completed')
    assert.equal(sync.listTasks().find(task => task.source === 'candles')?.status, 'running')
    release.resolve()
    await within(sync.whenIdle())
  } finally { release.resolve(); await sync.close() }
})

test('result eviction protects all concurrent cancelled writers and registered waiters', async () => {
  const storage = sourceStorage(), entered = deferred(), release = deferred(), metadata = new MemoryMetadata()
  let writes = 0
  const { sync } = create({ ...storage, metadata, maxConcurrentTasks: 3, maxRetainedTerminalTasks: 1,
    async write(values, task) { writes += 1; if (writes === 3) entered.resolve(); await release.promise; return storage.write(values, task) },
    sources: Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, { fetchGap: records }])),
  })
  try {
    const tasks = await Promise.all(['candles', 'oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await within(entered.promise)
    const results = tasks.map(task => sync.waitFor(task.id))
    await Promise.all(tasks.map(task => sync.cancel(task.id)))
    for (let index = 0; index < 4; index += 1) {
      const task = await sync.enqueue({ ...request, instrument: `EXPIRED${index}-USDT-SWAP` })
      await sync.cancel(task.id)
    }
    assert.ok((await Promise.all(results)).every(task => task.status === 'cancelled'))
    assert.ok(tasks.every(task => sync.getTask(task.id)?.status === 'cancelled' && metadata.getSyncTask(task.id)?.status === 'cancelled'))
    release.resolve()
    await within(sync.whenIdle())
    assert.equal(sync.listTasks().length, 1)
    assert.equal(metadata.listSyncTasks().length, 1)
    assert.ok([...storage.stores.values()].every(store => store.rows.size === 3))
  } finally { release.resolve(); await sync.close() }
})

test('rolling history and warmup keep stable identities and only verify newly exposed tails', async () => {
  let now = base + 60 * 86_400_000
  const metadata = new MemoryMetadata(), store = new VersionedMemoryStore()
  const queries: CoverageQuery[] = []
  store.missingCandleRanges = async query => { queries.push(query); return [] }
  let sync = create({ metadata, store, now: () => now }).sync
  let first!: { history: HistoryTask; warmup: HistoryTask | null }
  try {
    for (let index = 0; index < 128; index += 1) {
      const target = await sync.enqueueTarget({ instrument: request.instrument, timeframe: '5m', source: 'candles', historyDays: 1, asOf: now, warmupCandles: 200 })
      first ??= target
      assert.equal(target.history.id, first.history.id)
      assert.equal(target.warmup!.id, first.warmup!.id)
      await sync.whenIdle()
      assert.equal(sync.listTasks().length, 2)
      assert.equal(metadata.listSyncTasks().length, 2)
      now += intervalMS
    }
    assert.equal(queries.filter(query => query.through > query.from).length, 2, 'Only the initial history and warmup windows need full checks.')
    assert.equal(queries.length, 2 + 2 * 127)
    assert.equal(sync.getTask(first.history.id)?.through, now - 2 * intervalMS)
    await sync.close()
    sync = create({ metadata, store, now: () => now }).sync
    await sync.start()
    assert.equal(sync.listTasks().length, 2)
    const before = queries.length
    const target = sync.getTask(first.history.id)!
    await sync.enqueue(target)
    assert.equal(queries.length, before + 1, 'A new process validates the persisted window again.')
  } finally { await sync.close() }
})

test('result retention preserves active and queued work and delivers registered waiters before expiry', async () => {
  let now = base
  const entered = deferred(), release = deferred()
  const { sync, metadata } = create({ now: () => now++, maxRetainedTerminalTasks: 1,
    sources: { candles: { async fetchGap(query) {
      if (query.instrument === 'ACTIVE-USDT-SWAP') { entered.resolve(); await release.promise }
      return records(query)
    } } },
  })
  try {
    const active = await sync.enqueue({ ...request, instrument: 'ACTIVE-USDT-SWAP' })
    const activeResult = sync.waitFor(active.id)
    await entered.promise
    const queued = await sync.enqueue({ ...request, instrument: 'QUEUED-USDT-SWAP' })
    const queuedResult = sync.waitFor(queued.id)
    const cancelled = await sync.enqueue({ ...request, instrument: 'CANCELLED-USDT-SWAP' })
    const cancelledResult = sync.waitFor(cancelled.id)
    await sync.cancel(cancelled.id)
    for (let index = 0; index < 4; index += 1) {
      const task = await sync.enqueue({ ...request, instrument: `EXPIRED${index}-USDT-SWAP` })
      await sync.cancel(task.id)
    }
    assert.equal((await cancelledResult).status, 'cancelled')
    assert.equal(sync.getTask(cancelled.id), null)
    assert.equal(sync.getTask(active.id)?.status, 'running')
    assert.equal(sync.getTask(queued.id)?.status, 'queued')
    assert.equal(metadata.getSyncTask(active.id)?.status, 'running')
    assert.equal(metadata.getSyncTask(queued.id)?.status, 'queued')
    release.resolve()
    assert.equal((await activeResult).status, 'completed')
    assert.equal((await queuedResult).status, 'completed')
    await sync.whenIdle()
    assert.equal(sync.listTasks().length, 1)
    assert.equal(metadata.listSyncTasks().length, 1)
    assert.equal(sync.getTask(queued.id)?.status, 'completed')
  } finally { release.resolve(); await sync.close() }
})

test('paused history survives rolling-result eviction and restart until explicitly resumed', async () => {
  let now = base + 60 * 86_400_000, block = true, covered = false
  const entered = deferred(), metadata = new MemoryMetadata()
  const pausedInstrument = 'PAUSED-USDT-SWAP'
  const options: Partial<HistorySyncOptions> = { metadata, now: () => now, maxRetainedTerminalTasks: 2,
    store: { async missingCandleRanges(query) {
      return query.instrument === pausedInstrument && !covered ? [{ from: query.from, through: query.through }] : []
    } },
    write(_rows, task) { if (task.instrument === pausedInstrument) covered = true },
    sources: { candles: { async fetchGap(query) {
      if (block) {
        entered.resolve()
        return new Promise<CandleRecord[]>((_, reject) => query.signal.addEventListener('abort', () => reject(query.signal.reason), { once: true }))
      }
      return records(query)
    } } },
  }
  let sync = create(options).sync
  try {
    const paused = await sync.enqueue({ ...request, instrument: pausedInstrument })
    await entered.promise
    await sync.pause(paused.id)
    await sync.whenIdle()
    block = false
    for (let index = 0; index < 128; index += 1) {
      now += intervalMS
      const { history } = await sync.enqueueTarget({ instrument: request.instrument, timeframe: '5m', source: 'candles', asOf: now, warmupCandles: 0 })
      await sync.waitFor(history.id)
      await sync.whenIdle()
    }
    assert.equal(sync.getTask(paused.id)?.status, 'paused')
    assert.equal(metadata.getSyncTask(paused.id)?.status, 'paused')
    assert.equal(sync.listTasks().length, 2)
    await sync.close()
    sync = create(options).sync
    await sync.start()
    assert.equal(sync.getTask(paused.id)?.status, 'paused')
    assert.equal(metadata.getSyncTask(paused.id)?.status, 'paused')
    await sync.resume(paused.id)
    assert.equal((await sync.waitFor(paused.id)).status, 'completed')
    assert.equal(covered, true)
    await sync.whenIdle()
    assert.equal(sync.listTasks().length, 2)
    assert.equal(metadata.listSyncTasks().length, 2)
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
  let sync = new HistorySync({ metadata, store, sources, minRequestIntervalMS: 0, maxRetainedTerminalTasks: 1 })
  try {
    const task = await sync.enqueue(request)
    assert.equal((await sync.waitFor(task.id)).status, 'completed')
    const later = await sync.enqueue({ ...request, from: request.through + intervalMS, through: request.through + intervalMS })
    assert.equal((await sync.waitFor(later.id)).status, 'completed')
    await sync.whenIdle()
    assert.equal(metadata.getSyncTask(task.id), null)
    await sync.close()
    await store.close()
    metadata.close()
    metadata = await MetadataStore.open(root)
    store = await MarketStore.open(root)
    sync = new HistorySync({ metadata, store, sources, minRequestIntervalMS: 0, maxRetainedTerminalTasks: 1 })
    await sync.start()
    assert.equal(sync.getTask(task.id), null)
    assert.equal(sync.getTask(later.id)?.status, 'completed')
    await sync.enqueue(request)
    await sync.whenIdle()
    assert.equal(sync.getTask(task.id)?.status, 'completed')
    assert.equal(fetches, 2)
    assert.equal((await store.candles(request)).length, 3)
  } finally { await sync.close(); await store.close(); metadata.close(); await rm(root, { recursive: true, force: true }) }
})

test('verified completion performs no new coverage reads, checkpoints, or progress events until storage changes', async () => {
  const store = new VersionedMemoryStore(), metadata = new MemoryMetadata()
  let progress = 0, fetches = 0
  const { sync } = create({ store, metadata, onProgress() { progress++ }, sources: { candles: { fetchGap(query) { fetches++; return records(query) } } } })
  try {
    const task = await sync.enqueue(request)
    await sync.waitFor(task.id); await sync.whenIdle()
    const before = { reads: store.queries.length, writes: metadata.writes, progress }
    for (let index = 0; index < 20; index++) await sync.enqueue(request)
    await sync.whenIdle()
    assert.deepEqual({ reads: store.queries.length, writes: metadata.writes, progress }, before)
    store.rows.delete(`${request.instrument}:${request.timeframe}:${base + intervalMS}`)
    store.changed(base + intervalMS)
    await sync.enqueue(request); await sync.whenIdle()
    assert.equal(fetches, 2)
    assert.ok(store.queries.slice(before.reads).every(query => query.from === base + intervalMS && query.through === base + intervalMS))
    assert.equal(store.rows.size, 3)
  } finally { await sync.close() }
})

test('pagination verifies one initial window and durable page ranges instead of rescanning the full target', async () => {
  const store = new VersionedMemoryStore()
  const pages: HistoryRange[] = []
  const { sync } = create({ store, sources: { candles: { fetchGap(query) {
    const page = { ...query, from: Math.max(query.from, query.through - 99 * intervalMS) }
    pages.push(page)
    return records(page)
  } } } })
  try {
    const target = { ...request, through: base + 999 * intervalMS }
    const task = await sync.enqueue(target)
    await sync.waitFor(task.id); await sync.whenIdle()
    assert.equal(pages.length, 10)
    assert.equal(store.queries.filter(query => query.through - query.from === 999 * intervalMS).length, 1)
    assert.ok(store.queries.slice(1).every(query => query.through - query.from <= 99 * intervalMS))
    assert.equal(store.rows.size, 1_000)
  } finally { await sync.close() }
})

test('a rolling window can move while a page is active and cancellation survives subsequent target updates', async () => {
  const store = new VersionedMemoryStore(), entered = deferred(), release = deferred()
  let calls = 0
  const { sync } = create({ store, sources: { candles: { async fetchGap(query) {
    if (++calls === 1) { entered.resolve(); await release.promise }
    return records(query)
  } } } })
  const target = { instrument: request.instrument, timeframe: request.timeframe, source: request.source, historyDays: 1, warmupCandles: 0, asOf: base + 60 * 86_400_000 }
  try {
    const first = (await sync.enqueueTarget(target)).history
    await within(entered.promise)
    const latest = (await sync.enqueueTarget({ ...target, asOf: target.asOf + 128 * intervalMS })).history
    assert.equal(latest.id, first.id)
    assert.equal(sync.listTasks().length, 1)
    release.resolve()
    const result = await within(sync.waitFor(first.id))
    assert.equal(result.through, latest.through)
    assert.equal(result.status, 'completed')
    assert.equal(calls, 2)
    await sync.cancel(first.id)
    const stopped = (await sync.enqueueTarget({ ...target, asOf: target.asOf + 129 * intervalMS })).history
    assert.equal(stopped.status, 'cancelled')
    await sync.whenIdle()
    assert.equal(calls, 2)
    await sync.resume(first.id)
    assert.equal((await sync.waitFor(first.id)).status, 'completed')
    assert.equal(calls, 3)
  } finally { release.resolve(); await sync.close() }
})

test('startup collapses old rolling checkpoints to the latest window and preserves exact foreground requests', async () => {
  const metadata = new MemoryMetadata()
  const seed = create({ metadata }).sync
  const exact = await seed.enqueue({ ...request, priority: 'foreground' })
  await seed.waitFor(exact.id); await seed.close()
  const template = metadata.getSyncTask(exact.id)!
  for (const purpose of ['history', 'warmup'] as const) for (let index = 0; index < 100; index++) {
    const from = base + index * intervalMS, through = from + 2 * intervalMS
    const id = createHash('sha256').update(JSON.stringify([request.instrument, request.timeframe, request.source, from, through])).digest('hex')
    // The old format could not have two purposes at the same exact range.
    const shifted = purpose === 'warmup' ? 100 * intervalMS : 0
    const bounds = { from: from + shifted, through: through + shifted }
    const oldID = shifted ? createHash('sha256').update(JSON.stringify([request.instrument, request.timeframe, request.source, bounds.from, bounds.through])).digest('hex') : id
    metadata.putSyncTask({ ...template, ...bounds, id: oldID, purpose, priority: 'background', status: 'queued', createdAt: base + index, updatedAt: base + index, remaining: [bounds] })
  }
  // Keep the independent requested checkpoint at another range.
  const requested = { ...template, instrument: 'FOREGROUND-USDT-SWAP' }
  requested.id = createHash('sha256').update(JSON.stringify([requested.instrument, requested.timeframe, requested.source, requested.from, requested.through])).digest('hex')
  metadata.putSyncTask(requested)
  const { sync } = create({ metadata, store: { async missingCandleRanges() { return [] } }, write() {} })
  try {
    await sync.start(); await sync.whenIdle()
    assert.equal(sync.listTasks().length, 3)
    assert.equal(metadata.listSyncTasks().length, 3)
    assert.equal(sync.listTasks().find(task => task.purpose === 'history')?.from, base + 99 * intervalMS)
    assert.equal(sync.listTasks().find(task => task.purpose === 'warmup')?.from, base + 199 * intervalMS)
    assert.equal(sync.getTask(requested.id)?.priority, 'foreground')
    assert.ok(sync.listTasks().filter(task => task.purpose !== 'requested').every(task => task.id.startsWith('target-')))
  } finally { await sync.close() }
})

class BatchMemoryMetadata extends MemoryMetadata {
  batches: HistoryTask[][] = []
  deleted: string[][] = []
  beforeCommit?: (tasks: HistoryTask[]) => Promise<void> | void
  async putSyncTasks(tasks: HistoryTask[]) {
    const snapshots = structuredClone(tasks)
    this.batches.push(snapshots)
    await this.beforeCommit?.(snapshots)
    snapshots.forEach(task => super.putSyncTask(task))
  }
  deleteSyncTasks(ids: string[]) { this.deleted.push([...ids]); ids.forEach(id => this.deleteSyncTask(id)) }
}

test('simultaneous checkpoints use one batch and enqueue/close wait for its durable commit', async () => {
  const metadata = new BatchMemoryMetadata(), entered = deferred(), release = deferred()
  const { sync } = create({ metadata })
  await sync.start()
  metadata.batches.length = 0
  metadata.beforeCommit = async () => { entered.resolve(); await release.promise }
  let admitted = false, closed = false
  const admission = Promise.all(['BTC', 'ETH', 'SOL'].map(instrument => sync.enqueue({ ...request, instrument }))).then(tasks => { admitted = true; return tasks })
  try {
    await within(entered.promise)
    assert.equal(metadata.batches.length, 1)
    assert.equal(metadata.batches[0].length, 3)
    assert.equal(metadata.tasks.size, 0)
    assert.equal(admitted, false)
    const closing = sync.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release.resolve()
    const tasks = await within(admission)
    await within(closing)
    assert.ok(tasks.every(task => metadata.getSyncTask(task.id)?.status === 'queued'))
    assert.equal(admitted, true)
  } finally { release.resolve(); await sync.close() }
})

test('coalesced checkpoints publish the latest state once and resolve all durable waiters', async () => {
  const metadata = new BatchMemoryMetadata(), progress: string[] = []
  const { sync } = create({ metadata, onProgress(task) { progress.push(task.status) } })
  try {
    const task = await sync.enqueue(request)
    await sync.waitFor(task.id); await sync.whenIdle()
    metadata.batches.length = 0; progress.length = 0
    const mutable = (sync as any).tasks.get(task.id) as HistoryTask
    mutable.status = 'paused'
    const first = (sync as any).save(mutable)
    mutable.status = 'cancelled'
    const last = (sync as any).save(mutable)
    await Promise.all([first, last])
    assert.equal(metadata.batches.length, 1)
    assert.deepEqual(metadata.batches[0].map(task => task.status), ['cancelled'])
    assert.equal(metadata.getSyncTask(task.id)?.status, 'cancelled')
    assert.deepEqual(progress, ['cancelled'])
  } finally { await sync.close() }
})

test('a failed completion batch rejects waiters and restart recovers already durable pages without downloading again', async () => {
  const metadata = new BatchMemoryMetadata(), store = new VersionedMemoryStore()
  let fetches = 0, failCommit = true
  metadata.beforeCommit = tasks => { if (failCommit && tasks.some(task => task.status === 'completed')) throw new Error('Checkpoint transaction failed.') }
  const options = { metadata, store, sources: { candles: { fetchGap(query: HistorySourceQuery) { fetches++; return records(query) } } } }
  let sync = create(options).sync
  try {
    const task = await sync.enqueue(request)
    await assert.rejects(within(sync.waitFor(task.id)), /Checkpoint transaction failed/)
    await sync.close()
    assert.equal(store.rows.size, 3)
    assert.equal(metadata.getSyncTask(task.id)?.status, 'running')
    failCommit = false
    sync = create(options).sync
    await sync.start()
    assert.equal((await within(sync.waitFor(task.id))).status, 'completed')
    assert.equal(fetches, 1)
  } finally { await sync.close() }
})

test('progress counts unique instruments from the status index and updates across cancellation, pruning, and restart', async () => {
  const metadata = new BatchMemoryMetadata()
  const options = { metadata, maxRetainedTerminalTasks: 2, store: { async missingCandleRanges() { return [] } }, write() {},
    sources: { candles: { fetchGap: records }, oi: { fetchGap: records }, taker: { fetchGap: records } } }
  let sync = create(options).sync
  try {
    const tasks = await Promise.all(['oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await sync.whenIdle()
    await Promise.all(tasks.map(task => sync.pause(task.id)))
    assert.deepEqual(sync.progressFor([request.instrument, request.instrument], '5m'), { retrying: 0, unavailable: 1 })
    assert.deepEqual(sync.progressFor(['OTHER'], '5m'), { retrying: 0, unavailable: 0 })
    assert.deepEqual(sync.progressFor([request.instrument], '1H'), { retrying: 0, unavailable: 0 })
    await sync.close()
    sync = create(options).sync
    await sync.start()
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 1 })
    ;(sync as any).maxRetainedTerminalTasks = 1
    await sync.cancel(tasks[0].id)
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 1 })
    await sync.cancel(tasks[1].id)
    await sync.whenIdle()
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 0 })
    assert.equal(sync.listTasks().length, 1)
    assert.ok(metadata.deleted.some(ids => ids.length > 0))
    const map = (sync as any).tasks as Map<string, HistoryTask>
    const values = map.values
    map.values = () => { throw new Error('Progress must not scan task payloads.') }
    try { assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 0 }) }
    finally { map.values = values }
  } finally { await sync.close() }
})

test('retry progress counts a shared instrument once and clears when the tasks stop retrying', async () => {
  const retried = deferred(), metadata = new BatchMemoryMetadata()
  let retries = 0
  const { sync } = create({ metadata, maxConcurrentTasks: 2, retryBaseMS: 10_000, maxRetryDelayMS: 10_000,
    sources: { oi: { fetchGap() { throw new Error('Offline.') } }, taker: { fetchGap() { throw new Error('Offline.') } } },
    onProgress(task) { if (task.status === 'retry' && ++retries === 2) retried.resolve() },
  })
  try {
    const tasks = await Promise.all(['oi', 'taker'].map(source => sync.enqueue({ ...request, source })))
    await within(retried.promise)
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 1, unavailable: 0 })
    await Promise.all(tasks.map(task => sync.cancel(task.id)))
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 0 })
  } finally { await sync.close() }
})

test('a rolling target becomes completed when its unavailable listing range leaves the requested window', async () => {
  const store = new VersionedMemoryStore()
  const { sync } = create({ store, sources: { candles: {
    inspect() { return { availableFrom: base + intervalMS, reason: 'Before listing.' } }, fetchGap: records,
  } } })
  try {
    const first = await sync.enqueue({ ...request, purpose: 'history' })
    assert.equal((await sync.waitFor(first.id)).status, 'unavailable')
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 1 })
    await store.appendCandles([candle(base + 3 * intervalMS)])
    const rolled = await sync.enqueue({ ...request, purpose: 'history', from: base + intervalMS, through: base + 3 * intervalMS })
    assert.equal(rolled.id, first.id)
    assert.equal(rolled.status, 'completed')
    assert.deepEqual(sync.progressFor([request.instrument], '5m'), { retrying: 0, unavailable: 0 })
  } finally { await sync.close() }
})

test('an asynchronous inspection cannot mark a newly extended rolling tail unavailable', async () => {
  const store = new VersionedMemoryStore(), entered = deferred(), release = deferred()
  const inspected: HistoryRange[] = [], fetched: HistorySourceQuery[] = []
  const { sync } = create({ store, sources: { candles: {
    async inspect(query) {
      inspected.push({ from: query.from, through: query.through })
      if (inspected.length === 1) { entered.resolve(); await release.promise }
      return { availableThrough: query.through, reason: 'Latest completed source period.' }
    },
    fetchGap(query) { fetched.push(query); return records(query) },
  } } })
  try {
    const first = await sync.enqueue({ ...request, through: base + intervalMS, purpose: 'history' })
    await within(entered.promise)
    const moved = await sync.enqueue({ ...request, from: base + intervalMS, through: base + 2 * intervalMS, purpose: 'history' })
    assert.equal(moved.id, first.id)
    release.resolve()
    const result = await within(sync.waitFor(first.id))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.unavailableRanges, [])
    assert.ok(store.rows.has(`${request.instrument}:5m:${base + 2 * intervalMS}`))
    assert.deepEqual(inspected, [{ from: base, through: base + intervalMS }, { from: base + intervalMS, through: base + 2 * intervalMS }])
    assert.deepEqual(fetched.map(({ from, through }) => ({ from, through })), [{ from: base + intervalMS, through: base + 2 * intervalMS }])
  } finally { release.resolve(); await sync.close() }
})

test('a page from an older rolling generation may persist observations but cannot publish its cursor or unavailable ranges', async () => {
  const store = new VersionedMemoryStore(), entered = deferred(), release = deferred()
  const queries: HistorySourceQuery[] = [], writeBounds: HistoryRange[] = []
  const { sync } = create({ store, async write(values, task) {
    writeBounds.push({ from: task.from, through: task.through })
    await store.appendCandles(values)
  }, sources: { candles: { async fetchGap(query) {
    queries.push(query)
    if (queries.length === 1) {
      entered.resolve(); await release.promise
      return { records: [candle(query.through)], cursor: 'old-target-page', unavailable: [{ from: query.from, through: query.through, reason: 'Old page boundary.' }] }
    }
    return records(query)
  } } } })
  try {
    const first = await sync.enqueue({ ...request, through: base + intervalMS, purpose: 'history' })
    await within(entered.promise)
    await sync.enqueue({ ...request, from: base + intervalMS, through: base + 2 * intervalMS, purpose: 'history' })
    release.resolve()
    const result = await within(sync.waitFor(first.id))
    assert.equal(result.status, 'completed')
    assert.equal(result.attempts, 0)
    assert.deepEqual(result.unavailableRanges, [])
    assert.equal(queries.length, 2)
    assert.equal(queries[1].cursor, null)
    assert.equal(queries[1].from, base + 2 * intervalMS)
    assert.deepEqual(writeBounds[0], { from: base, through: base + intervalMS }, 'The accepted page keeps its original mutation context.')
    assert.ok(store.rows.has(`${request.instrument}:5m:${base + 2 * intervalMS}`))
  } finally { release.resolve(); await sync.close() }
})

test('inspection generation checks also reject an old result after the target moves away and back to identical bounds', async () => {
  const entered = deferred(), release = deferred(), store = new VersionedMemoryStore()
  let inspections = 0
  const { sync } = create({ store, sources: { candles: {
    async inspect(query) {
      if (++inspections === 1) { entered.resolve(); await release.promise; return { availableThrough: base, reason: 'Old observation.' } }
      return { availableThrough: query.through }
    }, fetchGap: records,
  } } })
  try {
    const original = { ...request, through: base + intervalMS, purpose: 'history' as const }
    const task = await sync.enqueue(original)
    await within(entered.promise)
    await sync.enqueue({ ...original, from: base + intervalMS, through: base + 2 * intervalMS })
    await sync.enqueue(original)
    release.resolve()
    const result = await within(sync.waitFor(task.id))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.unavailableRanges, [])
    assert.equal(inspections, 2)
    assert.ok(store.rows.has(`${request.instrument}:5m:${base + intervalMS}`))
  } finally { release.resolve(); await sync.close() }
})
