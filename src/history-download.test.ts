import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { HistoryDownload, emptyHistoryDownload, type HistoryDownloadReport } from '../electron/services/history-download.js'
import { HistorySync, type HistoryRange, type HistoryRecord, type HistorySource, type HistorySourceQuery, type HistoryTimeframe } from '../electron/services/history-sync.js'

const base = Date.UTC(2026, 9, 1), hour = 3_600_000
const intervals: Record<HistoryTimeframe, number> = { '5m': 300_000, '15m': 900_000, '1H': hour }
const instrument = { instId: 'BTC-USDT-SWAP', listTime: base + hour }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 4000
  while (!condition()) { assert.ok(performance.now() < deadline, 'History download did not make progress.'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
const records = (request: HistorySourceQuery): HistoryRecord[] => {
  const step = intervals[request.timeframe]
  return Array.from({ length: (request.through - request.from) / step + 1 }, (_, index) => {
    const common = { instrument: request.instrument, timeframe: request.timeframe, timestamp: request.from + index * step }
    if (request.source === 'oi') return { ...common, oi: 50 }
    if (request.source === 'taker') return { ...common, buy: 30, sell: 20 }
    return { ...common, open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 1, quoteVolume: 100, confirmed: true }
  })
}
const numeric = (record: HistoryRecord, source: string) => source === 'candles' ? 'confirmed' in record && record.confirmed
  : source === 'oi' ? typeof record.oi === 'number' : typeof record.buy === 'number' && typeof record.sell === 'number'
class MemoryMetadata {
  tasks = new Map<string, unknown>()
  report: HistoryDownloadReport | null = null
  getHistoryDownload() { return structuredClone(this.report) }
  saveHistoryDownload(report: HistoryDownloadReport) { this.report = structuredClone(report) }
  listSyncTasks() { return [...this.tasks.values()].map(value => structuredClone(value)) }
  deleteSyncTask(id: string) { this.tasks.delete(id) }
  deleteSyncTasks(ids: string[]) { for (const id of ids) this.tasks.delete(id) }
}
class SourceStore {
  values = new Map<string, { record: HistoryRecord; expiresAt: number }>()
  revision = 0
  beforeAppend?: () => Promise<void>
  now: () => number
  constructor(now: () => number) { this.now = now }
  key(query: { instrument: string; timeframe: string; source: string; timestamp: number }) { return JSON.stringify([query.instrument, query.timeframe, query.source, query.timestamp]) }
  async append(rows: HistoryRecord[], source: string) {
    await this.beforeAppend?.()
    for (const record of rows) this.values.set(this.key({ ...record, source }), { record, expiresAt: this.now() + 60_000 })
    this.revision++
  }
  coverageVersion() { return this.revision }
  async missingCandleRanges(query: HistoryRange & { instrument: string; timeframe: string; source: string; intervalMS: number }) {
    const gaps: HistoryRange[] = []
    let from: number | null = null
    for (let timestamp = query.from; timestamp <= query.through; timestamp += query.intervalMS) {
      const value = this.values.get(this.key({ ...query, timestamp }))
      if (!value || !numeric(value.record, query.source) && value.expiresAt <= this.now()) from ??= timestamp
      else if (from !== null) { gaps.push({ from, through: timestamp - query.intervalMS }); from = null }
    }
    if (from !== null) gaps.push({ from, through: query.through })
    return gaps
  }
  coverageLeases(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }) {
    const result = []
    for (let timestamp = query.from; timestamp <= query.through; timestamp += intervals[query.timeframe]) {
      const value = this.values.get(this.key({ ...query, timestamp }))
      if (value && !numeric(value.record, query.source) && value.expiresAt > this.now()) result.push({ from: timestamp, through: timestamp, expiresAt: value.expiresAt })
    }
    return result
  }
}
const fixture = (t: TestContext, options: { now?: () => number; metadata?: MemoryMetadata; fetchGap?: HistorySource['fetchGap']; inspect?: HistorySource['inspect']; pageSize?: number; chunkSlots?: number; concurrency?: number } = {}) => {
  const now = options.now ?? (() => base + 2 * hour), metadata = options.metadata ?? new MemoryMetadata(), store = new SourceStore(now)
  const calls: HistorySourceQuery[] = [], reports: HistoryDownloadReport[] = []
  let download: HistoryDownload
  const source: HistorySource = { pageSize: options.pageSize, inspect: options.inspect, fetchGap: request => { calls.push(request); return options.fetchGap?.(request) ?? records(request) } }
  const sync = new HistorySync({ metadata, store, sources: { candles: source, oi: source, taker: source },
    write: (rows, task) => store.append(rows, task.source), maxAttempts: 1, onProgress: task => download?.observe(task), now })
  download = new HistoryDownload({ sync, metadata, now, chunkSlots: options.chunkSlots ?? 2400, concurrency: options.concurrency ?? 4, onChange: report => { reports.push(report) } })
  t.after(async () => { await download.close(); await sync.close() })
  return { download, sync, store, metadata, calls, reports }
}
const finished = async (download: HistoryDownload) => { await waitFor(() => download.snapshot().phase !== 'running'); return download.snapshot() }

test('a manual download freezes listing-aligned completed ranges for every native source and ignores duplicate starts', async t => {
  let clock = base + 3 * hour + 123_000
  const gate = deferred()
  const f = fixture(t, { now: () => clock, chunkSlots: 7, fetchGap: async request => { await gate.promise; return records(request) } })
  t.after(() => gate.resolve())
  const selected = { ...instrument, listTime: base + 13_000 }
  const started = f.download.start([selected, selected])
  await waitFor(() => f.calls.length > 0)
  clock += hour
  const duplicate = f.download.start([{ instId: 'ETH-USDT-SWAP', listTime: base }])
  assert.equal(duplicate.id, started.id)
  assert.equal(duplicate.progress.total, started.progress.total)
  assert.equal(duplicate.contracts.total, 1)
  gate.resolve()
  const complete = await finished(f.download)
  assert.equal(complete.phase, 'completed')
  assert.equal(complete.progress.total, started.progress.total)
  assert.deepEqual(complete.contracts, { completed: 1, total: 1 })
  assert.deepEqual(complete.streams, { completed: 9, total: 9 })
  let expectedTotal = 0
  for (const [timeframe, step] of Object.entries(intervals)) for (const source of ['candles', 'oi', 'taker']) {
    const from = Math.ceil(selected.listTime / step) * step, through = Math.floor(started.startedAt! / step) * step - step
    const calls = f.calls.filter(call => call.timeframe === timeframe && call.source === source)
    const timestamps = calls.flatMap(call => records(call).map(record => record.timestamp)).sort((a, b) => a - b)
    assert.deepEqual(timestamps, Array.from({ length: (through - from) / step + 1 }, (_, index) => from + index * step))
    expectedTotal += timestamps.length
  }
  assert.equal(started.progress.total, expectedTotal)
  assert.equal(complete.progress.available, expectedTotal)
  assert.equal(complete.progress.pending, 0)
  assert.ok(f.calls.every(call => call.instrument === selected.instId && (call.through - call.from) / intervals[call.timeframe] + 1 <= 7))
})

test('saved numeric coverage is reused across an entire manual download without provider requests', async t => {
  const f = fixture(t)
  for (const [timeframe, step] of Object.entries(intervals)) for (const source of ['candles', 'oi', 'taker']) {
    await f.store.append(records({ instrument: instrument.instId, timeframe, source, from: instrument.listTime, through: base + 2 * hour - step } as HistorySourceQuery), source)
  }
  const started = f.download.start([instrument])
  const complete = await finished(f.download)
  assert.equal(complete.phase, 'completed')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(complete.progress, { completed: started.progress.total, total: started.progress.total, available: started.progress.total, unavailable: 0, reused: started.progress.total, pending: 0 })
  assert.deepEqual(f.metadata.report, complete)
})

test('progress advances only after durable partial pages and accounts for source-unavailable slots without false data', async t => {
  const writing = deferred(), commit = deferred(), secondPage = deferred()
  let candleCalls = 0, writes = 0
  const f = fixture(t, { concurrency: 1, pageSize: 3, chunkSlots: 20,
    inspect: request => request.source === 'taker' && request.timeframe === '15m'
      ? { unavailable: [{ from: instrument.listTime, through: instrument.listTime + intervals['15m'], reason: 'Explicit source history boundary.' }] } : {},
    fetchGap: async request => {
      const rows = records(request)
      if (request.source === 'candles' && request.timeframe === '5m') {
        if (++candleCalls === 1) return rows.slice(0, 2)
        if (candleCalls === 2) await secondPage.promise
      }
      return request.source === 'oi' && request.timeframe === '5m' ? rows.map(record => ({ ...record, oi: null })) : rows
    },
  })
  t.after(() => { commit.resolve(); secondPage.resolve() })
  await f.store.append(records({ instrument: instrument.instId, timeframe: '5m', source: 'candles', from: instrument.listTime, through: instrument.listTime + intervals['5m'] } as HistorySourceQuery), 'candles')
  f.store.beforeAppend = async () => { if (++writes === 1) { writing.resolve(); await commit.promise } }
  const started = f.download.start([instrument])
  await writing.promise
  assert.equal(f.download.snapshot().progress.available, 2, 'Received source rows are not durable progress.')
  assert.equal(f.download.snapshot().progress.reused, 2)
  commit.resolve()
  await waitFor(() => candleCalls === 2)
  const partial = f.download.snapshot()
  assert.equal(partial.progress.available, 4)
  assert.equal(partial.progress.completed, 4)
  assert.equal(partial.progress.total, started.progress.total)
  secondPage.resolve()
  const complete = await finished(f.download)
  assert.equal(complete.phase, 'completed')
  assert.deepEqual(complete.progress, { completed: 51, total: 51, available: 37, unavailable: 14, reused: 2, pending: 0 })
  assert.equal(complete.failures.length, 0)
})

test('cancellation aborts finite source demand and keeps unverified slots pending', async t => {
  const f = fixture(t, { fetchGap: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }) })
  const started = f.download.start([instrument])
  await waitFor(() => f.calls.length > 0)
  const stopped = await f.download.cancel()
  await f.sync.whenIdle()
  assert.equal(stopped.phase, 'cancelled')
  assert.deepEqual(stopped.progress, { completed: 0, total: started.progress.total, available: 0, unavailable: 0, reused: 0, pending: started.progress.total })
  assert.deepEqual(stopped.active, [])
  assert.ok(f.calls.every(call => call.signal.aborted))
  const calls = f.calls.length
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.calls.length, calls)
})

test('a failed stream leaves its missing slots pending while independent streams finish', async t => {
  const f = fixture(t, { fetchGap: request => request.source === 'candles' && request.timeframe === '5m' ? [] : records(request) })
  f.download.start([instrument])
  const complete = await finished(f.download)
  assert.equal(complete.phase, 'failed')
  assert.equal(complete.failures.length, 1)
  assert.match(complete.failures[0].error, /no persisted coverage progress/)
  assert.deepEqual(complete.progress, { completed: 39, total: 51, available: 39, unavailable: 0, reused: 0, pending: 12 })
  assert.deepEqual(complete.streams, { completed: 8, total: 9 })
  assert.deepEqual(complete.contracts, { completed: 0, total: 1 })
})

test('restoring an interrupted report or old rolling goals never starts a download', async t => {
  const metadata = new MemoryMetadata()
  metadata.report = { ...emptyHistoryDownload(), id: 'interrupted', phase: 'running', startedAt: base, progress: { completed: 2, total: 20, available: 2, unavailable: 0, reused: 2, pending: 18 } }
  metadata.tasks.set('legacy', { id: 'legacy', ...instrument, purpose: 'history', priority: 'background' })
  const f = fixture(t, { metadata })
  await f.sync.start(); await f.sync.whenIdle()
  const restored = f.download.snapshot()
  assert.equal(restored.phase, 'cancelled')
  assert.equal(restored.id, 'interrupted')
  assert.equal(restored.progress.pending, 18)
  assert.match(restored.error, /Start a new download/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.sync.listTasks(), [])
  assert.equal(metadata.tasks.size, 0)
  assert.deepEqual(metadata.report, restored)
})

test('missing listing metadata is reported without inventing an epoch-based all-history request', async t => {
  const f = fixture(t)
  f.download.start([{ instId: instrument.instId }])
  const report = await finished(f.download)
  assert.equal(report.phase, 'failed')
  assert.equal(report.failures.length, 1)
  assert.match(report.failures[0].error, /valid listing time/)
  assert.equal(f.calls.length, 0)
  assert.equal(report.contracts.completed, 0)
})


test('cancellation waits for an admitted durable page and checkpoints its final verified coverage', async t => {
  const writing = deferred(), commit = deferred()
  const f = fixture(t, { concurrency: 1 })
  t.after(() => commit.resolve())
  f.store.beforeAppend = async () => { writing.resolve(); await commit.promise }
  const started = f.download.start([instrument])
  await writing.promise
  let stopped = false
  const cancellation = f.download.cancel().then(report => { stopped = true; return report })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'Cancellation must include an admitted mutation in its final checkpoint.')
  assert.equal(f.store.values.size, 0)
  assert.equal(f.download.snapshot().progress.completed, 0)
  commit.resolve()
  const report = await cancellation
  await f.sync.whenIdle()
  assert.equal(report.phase, 'cancelled')
  assert.equal(f.calls.length, 1, 'Draining the admitted write cannot start another source request.')
  assert.equal(f.store.values.size, 12)
  assert.deepEqual(report.progress, { completed: 12, total: started.progress.total, available: 12, unavailable: 0, reused: 0, pending: started.progress.total - 12 })
  assert.deepEqual(report.active, [])
  assert.deepEqual(f.metadata.report, report)
})

test('a fatal scheduler shutdown preserves earlier durable pages and clears consumer state before a subsequent start', async t => {
  let pages = 0
  const f = fixture(t, { concurrency: 1, pageSize: 3, fetchGap: request => {
    if (++pages === 1) return records(request)
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  } })
  const started = f.download.start([instrument])
  await waitFor(() => pages === 2)
  assert.equal(f.store.values.size, 3)
  assert.equal(f.download.snapshot().progress.available, 3)
  await f.sync.close()
  const failed = await finished(f.download)
  assert.equal(failed.phase, 'failed')
  assert.match(failed.failures[0].error, /closed/)
  assert.deepEqual(failed.progress, { completed: 3, total: started.progress.total, available: 3, unavailable: 0, reused: 0, pending: started.progress.total - 3 })
  assert.deepEqual(failed.active, [])
  assert.deepEqual(f.metadata.report, failed)
  const restarted = f.download.start([instrument])
  assert.notEqual(restarted.id, started.id)
  assert.equal(restarted.progress.completed, 0)
  assert.deepEqual(restarted.active, [])
  const stopped = await finished(f.download)
  assert.equal(stopped.phase, 'failed', 'A closed source owner cannot acquire new history.')
  assert.deepEqual(stopped.progress, { completed: 0, total: started.progress.total, available: 0, unavailable: 0, reused: 0, pending: started.progress.total })
  assert.deepEqual(stopped.active, [])
  assert.equal(pages, 2)
  assert.equal(failed.progress.available, 3, 'A new request cannot mutate the saved prior result.')
})

test('an asynchronous checkpoint save failure stops acquisition and produces a failed report without an uncaught timer error', async t => {
  const metadata = new MemoryMetadata(), save = metadata.saveHistoryDownload.bind(metadata)
  let saves = 0
  metadata.saveHistoryDownload = report => {
    if (++saves > 1) throw new Error('Metadata disk is full.')
    save(report)
  }
  const f = fixture(t, { metadata, concurrency: 1, fetchGap: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }) })
  const started = f.download.start([instrument])
  await waitFor(() => f.calls.length === 1)
  await waitFor(() => f.download.snapshot().finishedAt !== null)
  await f.sync.whenIdle()
  const failed = f.download.snapshot()
  assert.equal(failed.phase, 'failed')
  assert.match(failed.error, /Could not save download progress: Metadata disk is full/)
  assert.deepEqual(failed.active, [])
  assert.equal(failed.progress.pending, started.progress.total)
  assert.equal(failed.progress.completed, 0)
  assert.equal(f.calls.length, 1, 'A failed checkpoint must stop later source admission.')
  assert.equal(f.calls[0].signal.aborted, true)
  assert.ok(saves >= 2)
  assert.equal(f.store.values.size, 0)
})
