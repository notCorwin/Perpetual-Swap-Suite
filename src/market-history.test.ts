import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketHistory } from '../electron/services/market-history.js'
import { MarketStore } from '../electron/services/market-store.js'
import { MetadataStore } from '../electron/services/metadata-store.js'
import { statisticsMask } from '../electron/services/statistics-state.js'
import type { CandleRecord, CandleQuery, CandleRange } from '../electron/services/market-store.js'
import type { HistoryTask } from '../electron/services/history-sync.js'
import type { AuditJob } from '../electron/services/data-audit.js'

const interval = 300_000
const day = 86_400_000
const base = Date.UTC(2026, 8, 1)
const instId = 'BTC-USDT-SWAP'
const intervals: Record<string, number> = { '5m': interval, '15m': 900_000, '1H': 3_600_000 }
const candle = (timestamp: number, timeframe = '5m'): CandleRecord => ({ instrument: instId, timeframe, timestamp,
  open: 100, high: 101, low: 99, close: 100, volume: 10, baseVolume: 0.1, quoteVolume: 10, confirmed: true })
const values = (row: CandleRecord) => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), String(row.volume), String(row.baseVolume), String(row.quoteVolume), row.confirmed ? '1' : '0']
const parseCandle = (instrument: string, timeframe: string, value: unknown[]) => ({ instrument, timeframe, timestamp: Number(value[0]),
  open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]), volume: Number(value[5]),
  baseVolume: Number(value[6]), quoteVolume: Number(value[7]), confirmed: value[8] === '1' })
type Query = CandleQuery & CandleRange
class MemoryStore {
  rows = new Map<string, CandleRecord>()
  replacements: Query[] = []
  async candles(query: CandleQuery) { return [...this.rows.values()].filter(row => row.instrument === query.instrument && row.timeframe === query.timeframe
    && row.timestamp >= (query.from ?? 0) && row.timestamp <= (query.through ?? Infinity)).sort((a, b) => a.timestamp - b.timestamp).map(row => structuredClone(row)) }
  async appendCandles(rows: CandleRecord[]) { for (const row of rows) this.rows.set(`${row.timeframe}:${row.timestamp}`, structuredClone(row)); return rows.length }
  async replaceCandles(query: Query, rows: CandleRecord[], _priority?: string) {
    this.replacements.push(query)
    for (const row of await this.candles(query)) this.rows.delete(`${row.timeframe}:${row.timestamp}`)
    return this.appendCandles(rows)
  }
  async coverage(instrument: string, timeframe: string) {
    const rows = await this.candles({ instrument, timeframe })
    return { count: rows.length, first: rows[0]?.timestamp ?? null, last: rows.at(-1)?.timestamp ?? null }
  }
  async inspectCandles(_query: Query) { return { issues: [], checkedRows: 0, files: 0, missingRanges: [] } }
}
class VersionedMemoryStore extends MemoryStore {
  revisions = new Map<string, number>()
  changes = new Map<string, { revision: number; from: number; through: number }[]>()
  queries: CandleQuery[] = []
  candleRevision(instrument: string, timeframe: string) { return this.revisions.get(`${instrument}:${timeframe}`) ?? 0 }
  candleChangesSince(instrument: string, timeframe: string, revision: number) {
    const changes = this.changes.get(`${instrument}:${timeframe}`) ?? []
    return { revision: this.candleRevision(instrument, timeframe), ranges: revision < (changes[0]?.revision ?? 1) - 1 ? null : changes.filter(change => change.revision > revision).map(({ from, through }) => ({ from, through })) }
  }
  override async candles(query: CandleQuery) { this.queries.push(structuredClone(query)); return super.candles(query) }
  override async appendCandles(rows: CandleRecord[]) {
    const result = await super.appendCandles(rows)
    const batches = new Map<string, CandleRecord[]>()
    for (const row of rows) {
      const key = `${row.instrument}:${row.timeframe}`
      const batch = batches.get(key) ?? []
      batch.push(row); batches.set(key, batch)
    }
    for (const [key, values] of batches) {
      const revision = this.candleRevision(values[0].instrument, values[0].timeframe) + 1
      this.revisions.set(key, revision)
      const changes = this.changes.get(key) ?? []
      changes.push({ revision, from: Math.min(...values.map(row => row.timestamp)), through: Math.max(...values.map(row => row.timestamp)) })
      if (changes.length > 256) changes.shift()
      this.changes.set(key, changes)
    }
    return result
  }
}
class MemoryMetadata {
  tasks = new Map<string, HistoryTask>()
  audits = new Map<string, AuditJob>()
  putSyncTask(task: HistoryTask) { this.tasks.set(task.id, structuredClone(task)); return task }
  getSyncTask(id: string) { return this.tasks.get(id) ?? null }
  listSyncTasks() { return [...this.tasks.values()].map(task => structuredClone(task)) }
  deleteSyncTask(id: string) { return this.tasks.delete(id) }
  saveAudit(job: AuditJob) { this.audits.set(job.id, structuredClone(job)); return job }
  listAudits() { return [...this.audits.values()].map(job => structuredClone(job)) }
}
type Parameters = Record<string, number | string>
type Get = (path: string, parameters: Parameters, signal: AbortSignal, priority: string) => Promise<unknown[][]>
const setup = (options: { store?: MemoryStore | MarketStore; metadata?: MemoryMetadata | MetadataStore; get?: Get; now?: () => number;
  listing?: number; onLive?: (instrument: string, timeframe: string, row: CandleRecord) => void; onReplace?: () => void; onAuditCheckpoint?: (job: AuditJob) => void | Promise<void> } = {}) => {
  const store = options.store ?? new MemoryStore(), metadata = options.metadata ?? new MemoryMetadata()
  const now = options.now ?? (() => base + day)
  const calls: { path: string; parameters: Parameters; priority: string }[] = []
  const source: Get = async (path, parameters) => {
    const step = intervals[String(parameters.bar ?? parameters.period)]
    if (path === '/market/history-candles') {
      const through = Number(parameters.after) - step
      return Array.from({ length: Number(parameters.limit) }, (_, index) => values(candle(through - index * step, String(parameters.bar))))
    }
    const through = Number(parameters.end) - step
    return Array.from({ length: Number(parameters.limit) }, (_, index) => path.includes('open-interest')
      ? [String(through - index * step), '50'] : [String(through - index * step), '20', '30'])
      .filter(row => Number(row[0]) > Number(parameters.begin) && Number(row[0]) < Number(parameters.end))
  }
  const get: Get = (path, parameters, signal, priority) => {
    calls.push({ path, parameters, priority })
    return (options.get ?? source)(path, parameters, signal, priority)
  }
  // Model the production owner's serialized read/merge/write boundary, since
  // independent source HTTP responses can now reach storage concurrently.
  let mutation = Promise.resolve<unknown>(undefined)
  const mutate = (operation: () => Promise<unknown>) => {
    const task = mutation.then(operation)
    mutation = task.catch(() => undefined)
    return task
  }
  const persistStatistics = (instrument: { instId: string }, timeframe: string, _end: number, bit: number, observations: (number | null)[][], range: CandleRange) => mutate(async () => {
    const byTimestamp = new Map(observations.map(row => [row[0], row]))
    const rows = await store.candles({ instrument: instrument.instId, timeframe, ...range })
    const patched = rows.map(row => {
      const value = byTimestamp.get(row.timestamp), prior = statisticsMask(row)
      const next: CandleRecord = { ...row, statisticsVersion: 8 | prior | bit }
      if (bit === 1) { next.oi = value?.[1] ?? null; next.statisticsOIExpiresAt = next.oi === null ? now() + 60_000 : null }
      else {
        const valid = value?.[1] !== null && value?.[2] !== null && Number(value?.[1]) + Number(value?.[2]) > 0
        next.sell = valid ? value![1] : null; next.buy = valid ? value![2] : null
        next.statisticsTakerExpiresAt = valid ? null : now() + 60_000
      }
      return next
    })
    await store.appendCandles(patched)
  })
  const history = new MarketHistory({ store, metadata, get, parseCandle, persistStatistics,
    persistCandles: (instrument: string, rows: CandleRecord[]) => mutate(async () => {
      const prior = new Map((await store.candles({ instrument, timeframe: rows[0].timeframe })).map(row => [row.timestamp, row]))
      await store.appendCandles(rows.map(row => ({ ...prior.get(row.timestamp), ...row })))
    }),
    replaceCandles: async (range, rows, priority) => { await store.replaceCandles(range, rows, priority); options.onReplace?.() },
    instrument: () => ({ instId, listTime: options.listing }), onLive: options.onLive, onAuditCheckpoint: options.onAuditCheckpoint, now })
  return { history, store, metadata, calls }
}

test('history forwards detached durable audit checkpoints without adding source requests', async () => {
  const metadata = new MemoryMetadata(), reports: AuditJob[] = []
  const { history, calls } = setup({ metadata, onAuditCheckpoint: job => {
    assert.deepEqual(job, metadata.audits.get(job.id))
    reports.push(structuredClone(job))
    job.cursor.targetIndex = 99
  } })
  try {
    await history.ready
    const { id } = history.audit.start({ targets: [{ instrument: instId, timeframe: '5m', from: base, through: base }] })
    await history.audit.whenIdle()
    assert.equal(reports[0].status, 'queued')
    assert.equal(reports.at(-1)?.status, 'completed')
    assert.deepEqual(reports.at(-1), history.audit.get(id))
    assert.equal(history.audit.get(id)?.cursor.targetIndex, 1)
    assert.deepEqual(calls, [])
  } finally { await history.close() }
})

test('durable price coverage is reused and missing base volume refetches only its exact slot', async () => {
  const { history, store, calls } = setup()
  try {
    await store.appendCandles([candle(base), { ...candle(base + interval), baseVolume: null }, candle(base + 2 * interval)])
    const result = await history.ensurePrices(instId, '5m', base, base + 2 * interval)
    assert.equal(result.rows.length, 3)
    assert.equal(result.rows[1].baseVolume, 0.1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].parameters.after, base + 2 * interval)
    assert.equal(calls[0].parameters.limit, 1)
    await history.ensurePrices(instId, '5m', base, base + 2 * interval)
    assert.equal(calls.length, 1)
  } finally { await history.close() }
})

test('bounded statistics pages query both sources beyond 1440 periods and reuse their durable observations', async () => {
  const now = base + 1_500 * interval, through = now - interval, from = through - 1_499 * interval
  const { history, store, calls } = setup({ now: () => now })
  try {
    await store.appendCandles(Array.from({ length: 1_500 }, (_, index) => candle(from + index * interval)))
    const { rows } = await history.ensureStatistics(instId, '5m', from, through)
    assert.equal(rows.length, 1_500)
    assert.equal(rows[0].oi, 50)
    assert.equal(rows[0].buy, 30)
    assert.equal(rows.at(-1)!.oi, 50)
    assert.equal(rows.at(-1)!.buy, 30)
    assert.equal(rows.at(-1)!.sell, 20)
    assert.ok(calls.every(call => call.path.includes('/rubik/stat/')))
    assert.ok(calls.every(call => call.parameters.limit === 100))
    assert.ok(calls.filter(call => call.path.includes('taker')).every(call => call.parameters.unit === 1))
    for (const endpoint of ['open-interest', 'taker']) {
      const pages = calls.filter(call => call.path.includes(endpoint)).map(call => call.parameters).sort((a, b) => Number(a.begin) - Number(b.begin))
      assert.equal(pages.length, 15)
      assert.equal(Number(pages[0].begin), from - interval)
      assert.equal(Number(pages.at(-1)!.end), through + interval)
      for (let index = 0; index < pages.length; index += 1) {
        assert.equal(Number(pages[index].end) - Number(pages[index].begin), 101 * interval)
        if (index) assert.equal(Number(pages[index].begin), Number(pages[index - 1].end) - interval, 'Exclusive API bounds produce adjacent non-overlapping closed pages.')
      }
    }
    const count = calls.length
    await history.ensureStatistics(instId, '5m', from, through)
    assert.equal(calls.length, count)
  } finally { await history.close() }
})

test('numeric statistics remain reusable while an empty sibling is retried only after its observation lease', async () => {
  let now = base + 10 * interval
  const source: Get = async path => path.includes('open-interest') ? [[String(base), '50']] : []
  const { history, store, calls } = setup({ now: () => now, get: source })
  try {
    await store.appendCandles([candle(base)])
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(calls.length, 2)
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(calls.length, 2)
    now += 60_001
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(calls.filter(call => call.path.includes('open-interest')).length, 1)
    assert.equal(calls.filter(call => call.path.includes('taker')).length, 2)
    const row = (await store.candles({ instrument: instId, timeframe: '5m' }))[0]
    assert.equal(row.oi, 50)
    assert.equal(row.buy, null)
  } finally { await history.close() }
})

test('old inferred null leases are probed again without redownloading a genuine numeric sibling', async () => {
  const now = base + 40 * day
  const { history, store, calls } = setup({ now: () => now })
  try {
    await store.appendCandles([{ ...candle(base), oi: 777, buy: null, sell: null,
      statisticsVersion: 7, statisticsTakerExpiresAt: now + day }])
    const { rows } = await history.ensureStatistics(instId, '5m', base, base)
    assert.deepEqual(calls.map(call => call.path), ['/rubik/stat/taker-volume-contract'])
    assert.deepEqual([rows[0].oi, rows[0].buy, rows[0].sell], [777, 30, 20])
  } finally { await history.close() }
})

test('cold foreground windows request prices, OI and Taker concurrently and merge only after the price page is durable', { timeout: 5_000 }, async () => {
  let allStarted!: () => void, releasePrices!: () => void, releaseStatistics!: () => void
  const entered = new Promise<void>(resolve => { allStarted = resolve })
  const prices = new Promise<void>(resolve => { releasePrices = resolve })
  const statistics = new Promise<void>(resolve => { releaseStatistics = resolve })
  const active = new Set<string>()
  const { history, store } = setup({ get: async (path, parameters) => {
    active.add(path)
    if (active.size === 3) allStarted()
    if (path.includes('/market/')) { await prices; return [values(candle(base))] }
    await statistics
    assert.equal(parameters.begin, base - interval)
    assert.equal(parameters.end, base + interval)
    return path.includes('open-interest') ? [[String(base), '50']] : [[String(base), '20', '30']]
  } })
  let pending: Promise<unknown> | undefined
  try {
    pending = history.ensureStatistics(instId, '5m', base, base)
    await entered
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m' })).length, 0)
    releaseStatistics()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m' })).length, 0, 'Statistics cannot create placeholder price candles.')
    releasePrices()
    await pending
    const [row] = await store.candles({ instrument: instId, timeframe: '5m' })
    assert.deepEqual([row.oi, row.buy, row.sell], [50, 30, 20])
    assert.equal(active.size, 3)
  } finally { releaseStatistics(); releasePrices(); await Promise.allSettled([pending]); await history.close() }
})

test('malformed statistics fail their source instead of acquiring a successful unavailable lease', async () => {
  const { history, store } = setup({ get: async path => path.includes('open-interest')
    ? [[String(base + 1), '50']] : [[String(base), '20', '30']] })
  ;(history.sync as any).maxAttempts = 1
  try {
    await store.appendCandles([candle(base)])
    await assert.rejects(history.ensureStatistics(instId, '5m', base, base), /native period grid/)
    await history.sync.whenIdle()
    const [row] = await store.candles({ instrument: instId, timeframe: '5m' })
    assert.equal(statisticsMask(row) & 1, 0)
    assert.equal(row.statisticsOIExpiresAt ?? null, null)
    assert.equal(row.buy, 30)
  } finally { await history.close() }
})

test('background statistics persist recent pages while older price history is still blocked', { timeout: 7_000 }, async () => {
  const from = base, through = base + 1_199 * interval
  let releaseOldest!: () => void, statsReady!: () => void
  const oldest = new Promise<void>(resolve => { releaseOldest = resolve })
  const observed = new Promise<void>(resolve => { statsReady = resolve })
  const store = new MemoryStore(), append = store.appendCandles.bind(store)
  store.appendCandles = async rows => {
    const written = await append(rows)
    if (rows.some(row => row.timestamp === through && row.oi === 50 && row.buy === 30)) statsReady()
    return written
  }
  const { history } = setup({ store, now: () => through + interval, get: async (path, parameters) => {
    if (path.includes('/market/')) {
      if (Number(parameters.after) <= from + 300 * interval) await oldest
      return Array.from({ length: Number(parameters.limit) }, (_, index) => values(candle(Number(parameters.after) - (index + 1) * interval)))
    }
    const end = Number(parameters.end), begin = Number(parameters.begin)
    return Array.from({ length: 100 }, (_, index) => path.includes('open-interest')
      ? [String(end - (index + 1) * interval), '50'] : [String(end - (index + 1) * interval), '20', '30'])
      .filter(row => Number(row[0]) > begin)
  } })
  let pending: Promise<unknown> | undefined
  try {
    pending = history.ensureStatistics(instId, '5m', from, through, 'background')
    await observed
    const task = history.sync.listTasks().find(task => task.source === 'candles' && task.from === from && task.through === through)!
    assert.notEqual(task.status, 'completed', 'An observed statistics page cannot wait for the containing multi-day price task.')
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from, through: from })).length, 0)
    releaseOldest()
    await pending
  } finally { releaseOldest(); await Promise.allSettled([pending]); await history.close() }
})

test('REST initialization admits two explicit observations and leaves gap coverage to exact source tasks', async () => {
  const live: CandleRecord[] = []
  const now = base + 4 * interval
  const { history, store, calls } = setup({ now: () => now, onLive: (_instrument, _timeframe, row) => live.push(row),
    get: async (path, parameters) => path === '/market/candles'
      ? [values({ ...candle(now), confirmed: false }), values(candle(now - interval))]
      : Array.from({ length: Number(parameters.limit) }, (_, index) => values(candle(Number(parameters.after) - (index + 1) * interval))) })
  try {
    await store.appendCandles([candle(base)])
    const result = await history.latest(instId, '5m')
    assert.equal(result.live?.timestamp, now)
    assert.equal(live.length, 1)
    assert.deepEqual((await store.candles({ instrument: instId, timeframe: '5m' })).map(row => row.timestamp), [base, base + 3 * interval])
    assert.equal(calls.filter(call => call.path === '/market/history-candles').length, 0)
    await history.ensurePrices(instId, '5m', base + interval, base + 2 * interval)
    assert.deepEqual((await store.candles({ instrument: instId, timeframe: '5m' })).map(row => row.timestamp), [base, base + interval, base + 2 * interval, base + 3 * interval])
    assert.equal(calls[0].parameters.limit, 2)
    assert.equal(calls.filter(call => call.path === '/market/history-candles').length, 1)
    assert.equal(calls[1].parameters.limit, 2)
    assert.ok(history.sync.listTasks().some((task: HistoryTask) => task.source === 'candles' && task.status === 'completed'))
  } finally { await history.close() }
})

test('background statistics promote only their bounded price dependency so their source lanes can finish', async () => {
  const { history } = setup()
  try {
    await history.ensureStatistics(instId, '5m', base, base + 200 * interval, 'background')
    const tasks = history.sync.listTasks()
    const dependencies = tasks.filter(task => task.source === 'candles' && task.priority === 'foreground')
    assert.ok(dependencies.length >= 3)
    assert.ok(dependencies.every(task => (task.through - task.from) / interval < 100))
    assert.ok(tasks.filter(task => task.source !== 'candles').every(task => task.priority === 'background' && task.status === 'completed'))
  } finally { await history.close() }
})

test('background targets immediately admit every source and start three HTTP lanes before price history finishes', { timeout: 5_000 }, async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const active = new Set<string>()
  const { history } = setup({ now: () => base + 40 * day, get: async (path, _parameters, signal) => {
    active.add(path)
    if (active.size === 3) started()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const targets = await history.target(instId, { historyDays: 30, asOf: base + 40 * day })
    assert.equal(targets.length, 9)
    assert.deepEqual(new Set(targets.map(target => target.history.source)), new Set(['candles', 'oi', 'taker']))
    for (const { history: task, warmup } of targets) {
      assert.ok(warmup)
      const step = intervals[task.timeframe]
      assert.equal(task.through - task.from + step, 30 * day)
      assert.equal(warmup.through - warmup.from + step, 200 * step)
      assert.equal(warmup.through, task.from - step)
    }
    await entered
    assert.equal(active.size, 3)
    assert.equal(history.sync.listTasks().filter(task => task.status === 'completed').length, 0)
  } finally { await history.close() }
})

test('aborting a foreground waiter leaves the shared source task able to finish durably', async () => {
  let started!: () => void, release!: (rows: string[][]) => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const response = new Promise<string[][]>(resolve => { release = resolve })
  const { history, store } = setup({ get: async () => { started(); return response } })
  const controller = new AbortController()
  try {
    const pending = history.ensurePrices(instId, '5m', base, base, 'foreground', controller.signal)
    await entered
    controller.abort(new Error('The qualification preferences changed.'))
    await assert.rejects(pending, /preferences changed/)
    assert.equal(history.sync.listTasks()[0].status, 'running')
    release([values(candle(base))])
    await history.sync.whenIdle()
    assert.equal(history.sync.listTasks()[0].status, 'completed')
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m' })).length, 1)
  } finally { release([values(candle(base))]); await history.close() }
})

test('a corrupt current-day partition is fully replaced only after fetching every completed bar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-history-audit-'))
  const store = await MarketStore.open(directory), metadata = await MetadataStore.open(join(directory, 'Metadata'))
  let replacements = 0
  const now = base + 12 * interval
  const { history, calls } = setup({ store, metadata, now: () => now, onReplace: () => { replacements += 1 } })
  try {
    await store.appendCandles(Array.from({ length: 12 }, (_, index) => candle(base + index * interval)))
    const file = (await readdir(directory, { recursive: true })).find(file => file.endsWith('.parquet'))!
    await writeFile(join(directory, file), 'corrupt partition')
    const job = history.audit.start({ targets: [{ instrument: instId, timeframe: '5m', from: base + 5 * interval, through: base + 5 * interval }] })
    await history.audit.whenIdle()
    assert.equal(history.audit.get(job.id)!.issues[0].reason, 'corrupt-file')
    history.audit.repair(job.id)
    await history.audit.whenIdle()
    const report = history.audit.get(job.id)!
    assert.equal(report.status, 'completed')
    assert.equal(report.summary.open, 0)
    assert.equal(replacements, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].parameters.limit, 12)
    assert.equal(calls[0].parameters.after, now)
    const rows = await store.candles({ instrument: instId, timeframe: '5m' })
    assert.equal(rows.length, 12)
    assert.equal(rows[0].timestamp, base)
    assert.equal(rows.at(-1)!.timestamp, now - interval)
  } finally { await history.close(); metadata.close(); await store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('cancelling a repair aborts its source task before replacement and close waits for admitted work', async () => {
  const store = new MemoryStore()
  store.inspectCandles = async query => ({ issues: [{ ...query, source: 'candles', reason: 'corrupt-file', repairable: true }], checkedRows: 0, files: 1, missingRanges: [] }) as never
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  const { history } = setup({ store, get: async (_path, _parameters, signal) => {
    started()
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
  } })
  const job = history.audit.start({ targets: [{ instrument: instId, timeframe: '5m', from: base, through: base }] })
  await history.audit.whenIdle()
  history.audit.repair(job.id)
  await entered
  history.audit.cancel(job.id)
  await history.close()
  assert.equal(aborted, true)
  assert.equal(store.replacements.length, 0)
  assert.equal(history.audit.get(job.id)!.status, 'cancelled')
})

test('an empty latest response with an old complete cache never invents a history target', async () => {
  const now = base + 365 * day
  const { history, store, calls } = setup({ now: () => now, get: async path => {
    if (path === '/market/candles') return []
    throw new Error('Empty latest data cannot prove a missing history range.')
  } })
  ;(history.sync as any).maxAttempts = 1
  try {
    await store.appendCandles(Array.from({ length: 3072 }, (_, index) => candle(base - (3071 - index) * interval)))
    await assert.doesNotReject(history.latest(instId, '5m'))
    assert.deepEqual(calls.map(call => call.path), ['/market/candles'])
    assert.equal(history.sync.listTasks().length, 0)
    assert.equal((await store.coverage(instId, '5m')).last, base)
  } finally { await history.close() }
})

test('REST initialization publishes explicit confirmed close revisions through the source task even when price coverage is complete', async () => {
  const revised = { ...candle(base), open: 199, high: 201, low: 198, close: 200 }
  const { history, store, calls } = setup({ now: () => base + interval, get: async path => {
    assert.equal(path, '/market/candles', 'The returned observation needs no historical redownload.')
    return [values(revised)]
  } })
  try {
    await store.appendCandles([candle(base)])
    await history.latest(instId, '5m')
    const [row] = await store.candles({ instrument: instId, timeframe: '5m' })
    assert.equal(row.close, 200)
    assert.deepEqual(calls.map(call => call.path), ['/market/candles'])
    assert.ok(history.sync.listTasks().some(task => task.source === 'candles' && task.from === base && task.through === base && task.writtenRecords === 1))
  } finally { await history.close() }
})

test('an exact-slot repair commits a concurrent latest revision without retrying their shared source task', async () => {
  const downloaded = { ...candle(base), open: 149, high: 151, low: 148, close: 150 }
  const latestRevision = { ...candle(base), open: 199, high: 201, low: 198, close: 200 }
  let releaseHistory!: () => void, historyReached!: () => void, latestAdmitted!: () => void
  const release = new Promise<void>(resolve => { releaseHistory = resolve })
  const entered = new Promise<void>(resolve => { historyReached = resolve })
  const admitted = new Promise<void>(resolve => { latestAdmitted = resolve })
  const { history, store, calls } = setup({ now: () => base + interval, get: async path => {
    if (path === '/market/candles') return [values(latestRevision)]
    assert.equal(path, '/market/history-candles')
    historyReached()
    await release
    return [values(downloaded)]
  } })
  ;(history.sync as any).maxAttempts = 1
  const enqueue = history.sync.enqueue.bind(history.sync)
  let admitLatest = false, latestTask: HistoryTask | undefined
  history.sync.enqueue = async input => {
    const task = await enqueue(input)
    if (admitLatest) { latestTask = task; latestAdmitted() }
    return task
  }
  let repair: Promise<unknown> | undefined, latest: Promise<unknown> | undefined
  try {
    await store.appendCandles([candle(base)])
    repair = (history as any).repair({ instrument: instId, timeframe: '5m', source: 'candles', from: base, through: base,
      reason: 'invalid-ohlc', repairable: true }, { signal: new AbortController().signal })
    await entered
    admitLatest = true
    latest = history.latest(instId, '5m')
    await admitted
    releaseHistory()
    await assert.doesNotReject(() => Promise.all([repair, latest]))
    await history.sync.whenIdle()
    const [row] = await store.candles({ instrument: instId, timeframe: '5m', from: base, through: base })
    assert.equal(row.close, 200)
    assert.equal((store as MemoryStore).replacements.length, 1)
    assert.deepEqual(calls.map(call => call.path), ['/market/history-candles', '/market/candles'])
    assert.equal(history.sync.listTasks().length, 1)
    assert.equal(history.sync.getTask(latestTask!.id)?.status, 'completed')
    assert.equal(history.sync.getTask(latestTask!.id)?.attempts, 0)
  } finally {
    releaseHistory()
    await Promise.allSettled([repair, latest])
    await history.close()
  }
})


test('versioned completed observations retain numeric siblings and revalidate empty-source leases on expiry', async () => {
  let now = base + 10 * interval
  const store = new VersionedMemoryStore()
  const { history, calls } = setup({ store, now: () => now, get: async path => path.includes('open-interest') ? [[String(base), '50']] : [] })
  try {
    await store.appendCandles([candle(base)])
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(calls.length, 2)
    // First renewal also consumes any sibling mutations from the revision journal.
    await history.ensureStatistics(instId, '5m', base, base)
    store.queries.length = 0
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(store.queries.length, 1, 'Only the caller result needs a read; unchanged coverage is already verified.')
    now += 60_001
    await history.ensureStatistics(instId, '5m', base, base)
    assert.equal(calls.filter(call => call.path.includes('open-interest')).length, 1)
    assert.equal(calls.filter(call => call.path.includes('taker')).length, 2)
  } finally { await history.close() }
})

test('versioned statistics backfill reads each completed page instead of the whole requested window', async () => {
  const now = base + 1_500 * interval, through = now - interval, from = base
  const store = new VersionedMemoryStore()
  const { history } = setup({ store, now: () => now })
  try {
    await store.appendCandles(Array.from({ length: 1_500 }, (_, index) => candle(from + index * interval)))
    store.queries.length = 0
    const { rows } = await history.ensureStatistics(instId, '5m', from, through)
    assert.equal(rows.length, 1_500)
    const full = store.queries.filter(query => query.from === from && query.through === through)
    assert.ok(full.length <= 4, `Expected initial checks plus final result, got ${full.length} full reads.`)
    assert.ok(store.queries.filter(query => query.from !== from || query.through !== through).every(query => Number(query.through) - Number(query.from) <= 99 * interval))
  } finally { await history.close() }
})

test('a thirty-day statistics window revalidates only an expired empty slot and ignores numeric lease metadata', async () => {
  let now = base + 40 * day
  const store = new VersionedMemoryStore(), through = base + (8_640 - 1) * interval, empty = base + 4_000 * interval
  const rows = Array.from({ length: 8_640 }, (_, index) => ({ ...candle(base + index * interval), oi: 50, buy: 30, sell: 20, statisticsVersion: 11 } as CandleRecord))
  rows[4_000] = { ...rows[4_000], buy: null, sell: null, statisticsTakerExpiresAt: now + 10 }
  rows[2] = { ...rows[2], statisticsOIExpiresAt: now + 1 }
  rows[3] = { ...rows[3], statisticsTakerExpiresAt: now + 1 }
  await store.appendCandles(rows)
  const { history, calls } = setup({ store, now: () => now })
  try {
    await history.ensureStatistics(instId, '5m', base, through)
    assert.equal(calls.length, 0)
    store.queries.length = 0
    now += 11
    const result = await history.ensureStatistics(instId, '5m', base, through)
    assert.equal(result.rows.length, 8_640)
    assert.deepEqual(calls.map(call => call.path), ['/rubik/stat/taker-volume-contract'])
    assert.equal(calls[0].parameters.begin, empty - interval)
    assert.equal(calls[0].parameters.end, empty + interval)
    const fullReads = store.queries.filter(query => query.from === base && query.through === through)
    assert.equal(fullReads.length, 1, 'The full requested rows are read only for the caller result, never for lease coverage checks.')
    assert.ok(store.queries.filter(query => query.from !== base || query.through !== through).every(query => query.from === empty && query.through === empty))
    store.queries.length = 0
    now += day
    await history.ensureStatistics(instId, '5m', base, through)
    assert.equal(calls.length, 1, 'Numeric replacements and numeric siblings never acquire empty-observation leases.')
  } finally { await history.close() }
})
