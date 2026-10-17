import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketHistory } from '../electron/services/market-history.js'
import { MarketStore } from '../electron/services/market-store.js'
import { MetadataStore } from '../electron/services/metadata-store.js'
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
  async replaceCandles(query: Query, rows: CandleRecord[]) {
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
  listing?: number; onLive?: (instrument: string, timeframe: string, row: CandleRecord) => void; onReplace?: () => void } = {}) => {
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
  }
  const get: Get = (path, parameters, signal, priority) => {
    calls.push({ path, parameters, priority })
    return (options.get ?? source)(path, parameters, signal, priority)
  }
  const persistStatistics = async (instrument: { instId: string }, timeframe: string, _end: number, bit: number, observations: (number | null)[][], range: CandleRange) => {
    const byTimestamp = new Map(observations.map(row => [row[0], row]))
    const rows = await store.candles({ instrument: instrument.instId, timeframe, ...range })
    const patched = rows.map(row => {
      const value = byTimestamp.get(row.timestamp), prior = row.statisticsVersion === 1 ? 3 : Number(row.statisticsVersion ?? 0) & 3
      const next: CandleRecord = { ...row, statisticsVersion: 4 | prior | bit }
      if (bit === 1) { next.oi = value?.[1] ?? null; next.statisticsOIExpiresAt = next.oi === null ? now() + 60_000 : null }
      else {
        const valid = value?.[1] !== null && value?.[2] !== null && Number(value?.[1]) + Number(value?.[2]) > 0
        next.sell = valid ? value![1] : null; next.buy = valid ? value![2] : null
        next.statisticsTakerExpiresAt = valid ? null : now() + 60_000
      }
      return next
    })
    await store.appendCandles(patched)
  }
  const history = new MarketHistory({ store, metadata, get, parseCandle, persistStatistics,
    persistCandles: (_instrument: string, rows: CandleRecord[]) => store.appendCandles(rows),
    instrument: () => ({ instId, listTime: options.listing }), onLive: options.onLive, onReplace: options.onReplace, now })
  return { history, store, metadata, calls }
}

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

test('statistics use direct contract sources, 100-period cursors, and retain unavailable older observations without HTTP', async () => {
  const now = base + 1_500 * interval, through = now - interval, from = through - 1_499 * interval
  const { history, store, calls } = setup({ now: () => now })
  try {
    await store.appendCandles(Array.from({ length: 1_500 }, (_, index) => candle(from + index * interval)))
    const { rows } = await history.ensureStatistics(instId, '5m', from, through)
    assert.equal(rows.length, 1_500)
    assert.equal(rows[0].oi, null)
    assert.equal(rows[0].buy, null)
    assert.equal(rows.at(-1)!.oi, 50)
    assert.equal(rows.at(-1)!.buy, 30)
    assert.equal(rows.at(-1)!.sell, 20)
    assert.ok(calls.every(call => call.path.includes('/rubik/stat/')))
    assert.ok(calls.every(call => call.parameters.limit === 100))
    assert.ok(calls.filter(call => call.path.includes('taker')).every(call => call.parameters.unit === 1))
    assert.ok(calls.every(call => Number(call.parameters.end) > through - 1_440 * interval))
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

test('REST initialization uses two rows, leaves forming data in memory, and fills reconnect gaps through source tasks', async () => {
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
    assert.deepEqual((await store.candles({ instrument: instId, timeframe: '5m' })).map(row => row.timestamp), [base, base + interval, base + 2 * interval, base + 3 * interval])
    assert.equal(calls[0].parameters.limit, 2)
    assert.equal(calls.filter(call => call.path === '/market/history-candles').length, 1)
    assert.equal(calls[1].parameters.limit, 2)
    assert.ok(history.sync.listTasks().some((task: HistoryTask) => task.source === 'candles' && task.status === 'completed'))
  } finally { await history.close() }
})

test('background targets include all timeframes plus 199 warmup bars and return before source completion', async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const { history } = setup({ now: () => base + 40 * day, get: async (_path, _parameters, signal) => {
    started()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const targets = await history.target(instId, { historyDays: 30, asOf: base + 40 * day })
    assert.equal(targets.length, 3)
    for (const { history: task, warmup } of targets) {
      assert.ok(warmup)
      const step = intervals[task.timeframe]
      assert.equal(task.through - task.from + step, 30 * day)
      assert.equal(warmup.through - warmup.from + step, 199 * step)
      assert.equal(warmup.through, task.from - step)
    }
    await entered
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
