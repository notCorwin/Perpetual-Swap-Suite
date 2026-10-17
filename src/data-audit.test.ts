import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataAudit } from '../electron/services/data-audit.js'
import type { AuditFinding, AuditInspection, AuditJob, AuditTarget } from '../electron/services/data-audit.js'
import { MetadataStore } from '../electron/services/metadata-store.js'
import { MarketStore } from '../electron/services/market-store.js'

const interval = 300_000
const day = 86_400_000
const target = (from = 0, through = 5 * interval): AuditTarget => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from, through })
const finding = (reason: string, from: number, through = from, repairable = true): AuditFinding => ({ ...target(from, through), source: 'candles', reason, repairable })
const inspected = (issues: AuditFinding[] = [], checkedRows = 1): AuditInspection => ({ issues, checkedRows, files: 1, missingRanges: [] })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
class MemoryMetadata {
  records = new Map<string, AuditJob>()
  saveAudit(job: AuditJob) { this.records.set(job.id, structuredClone(job)); return structuredClone(job) }
  listAudits() { return [...this.records.values()].map(job => structuredClone(job)) }
}

test('audit runs on the background lane, reports exact defect ranges, and returns detached reports', async () => {
  const metadata = new MemoryMetadata()
  const calls: AuditTarget[] = []
  const reasons = ['invalid-grid', 'invalid-ohlc', 'negative-volume', 'unconfirmed', 'duplicate', 'corrupt-file', 'missing-base-volume']
  const issues = reasons.map((reason, index) => ({ ...finding(reason, index === 0 ? 1 : index * interval, undefined, reason !== 'missing-base-volume'), file: 'part.parquet' }))
  const audit = new DataAudit({
    metadata,
    store: { inspectCandles: async (query, priority) => { assert.equal(priority, 'background'); calls.push(query); return inspected(issues, 8) } },
  })
  try {
    const started = audit.start({ id: 'all-defects', targets: [target(0, 8 * interval)] })
    assert.equal(started.status, 'queued')
    assert.equal(calls.length, 0)
    started.targets[0].instrument = 'mutated'
    await audit.whenIdle()
    const report = audit.get('all-defects')!
    assert.equal(report.status, 'completed')
    assert.equal(report.checkedRows, 8)
    assert.deepEqual(report.issues.map(issue => issue.reason), reasons)
    assert.equal(report.issues[0].from, 1)
    assert.equal(report.summary.open, 7)
    assert.equal(report.targets[0].instrument, 'BTC-USDT-SWAP')
    report.issues.length = 0
    assert.equal(audit.status('all-defects')!.issues.length, 7)
    assert.equal(audit.list().length, 1)
  } finally { await audit.close() }
})

test('audit fills explicit inspector gaps and persists each completed daily chunk', async () => {
  const metadata = new MemoryMetadata()
  const calls: AuditTarget[] = []
  const audit = new DataAudit({ metadata, inspect: async query => {
    calls.push(query)
    return { ...inspected([], 2), missingRanges: [{ from: query.from, through: query.from }] }
  } })
  try {
    const job = audit.start({ targets: [target(0, 2 * day + interval)] })
    await audit.whenIdle()
    assert.deepEqual(calls.map(query => [query.from, query.through]), [[0, day - 1], [day, 2 * day - 1], [2 * day, 2 * day + interval]])
    const report = audit.get(job.id)!
    assert.equal(report.checkedRows, 6)
    assert.equal(report.cursor.targetIndex, 1)
    assert.equal(report.cursor.nextFrom, null)
    assert.deepEqual(report.issues.map(issue => [issue.reason, issue.from]), [['gap', 0], ['gap', day], ['gap', 2 * day]])
  } finally { await audit.close() }
})

test('cancel aborts the current operation and resume retries only its uncommitted chunk', async () => {
  const metadata = new MemoryMetadata()
  const entered = deferred<AbortSignal>()
  const gate = deferred<AuditInspection>()
  const calls: number[] = []
  const audit = new DataAudit({ metadata, inspect: async (query, { signal }) => {
    calls.push(query.from)
    if (calls.length === 1) { entered.resolve(signal); return gate.promise }
    return inspected([], 3)
  } })
  try {
    const { id } = audit.start({ targets: [target()] })
    const signal = await entered.promise
    assert.equal(audit.cancel(id).status, 'cancelled')
    assert.equal(signal.aborted, true)
    gate.resolve(inspected([finding('gap', 0)], 99))
    await audit.whenIdle()
    assert.equal(audit.get(id)!.checkedRows, 0)
    assert.equal(audit.get(id)!.issues.length, 0)
    audit.resume(id)
    await audit.whenIdle()
    assert.deepEqual(calls, [0, 0])
    assert.equal(audit.get(id)!.checkedRows, 3)
    assert.equal(audit.get(id)!.status, 'completed')
  } finally { gate.resolve(inspected()); await audit.close() }
})

test('durable SQLite cursor resumes after shutdown without rechecking completed partitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-audit-'))
  let metadata = await MetadataStore.open(root)
  const entered = deferred<void>()
  const gate = deferred<AuditInspection>()
  const calls: number[] = []
  let audit = new DataAudit({ metadata, inspect: async query => {
    calls.push(query.from)
    if (query.from === day) { entered.resolve(); return gate.promise }
    return inspected([finding('invalid-grid', 1)], 3)
  } })
  try {
    const { id } = audit.start({ targets: [target(0, 2 * day - interval)] })
    await entered.promise
    const closing = audit.close()
    gate.resolve(inspected([], 100))
    await closing
    assert.equal(audit.get(id)!.status, 'queued')
    assert.equal(audit.get(id)!.cursor.nextFrom, day)
    metadata.close()
    metadata = await MetadataStore.open(root)
    audit = new DataAudit({ metadata, inspect: async query => { calls.push(query.from); return inspected([], 4) } })
    await audit.whenIdle()
    const report = audit.get(id)!
    assert.deepEqual(calls, [0, day, day])
    assert.equal(report.checkedRows, 7)
    assert.equal(report.issues[0].from, 1)
    assert.equal(report.status, 'completed')
  } finally { gate.resolve(inspected()); await audit.close(); metadata.close(); await rm(root, { recursive: true, force: true }) }
})

test('repair fetches only reported anomalies and verification narrows remaining ranges and discovers new defects', async () => {
  const metadata = new MemoryMetadata()
  let current = [finding('gap', 0, 2 * interval), finding('missing-base-volume', 3 * interval, undefined, false), finding('invalid-ohlc', 4 * interval)]
  const repairs: Array<[string, number, number]> = []
  const inspections: Array<[number, number]> = []
  const audit = new DataAudit({ metadata,
    inspect: async query => { inspections.push([query.from, query.through]); return inspected(current.filter(issue => issue.from >= query.from && issue.through <= query.through)) },
    repair: async issue => {
      repairs.push([issue.reason, issue.from, issue.through])
      if (issue.reason === 'gap') current = current.map(row => row.reason === 'gap' ? finding('gap', 2 * interval) : row)
      if (issue.reason === 'invalid-ohlc') current = current.map(row => row.reason === 'invalid-ohlc' ? finding('negative-volume', 4 * interval) : row)
    },
  })
  try {
    const { id } = audit.start({ targets: [target()] })
    await audit.whenIdle()
    audit.repair(id)
    await audit.whenIdle()
    const report = audit.get(id)!
    assert.deepEqual(repairs, [['gap', 0, 2 * interval], ['invalid-ohlc', 4 * interval, 4 * interval]])
    assert.deepEqual(inspections.slice(1), [[0, 2 * interval], [4 * interval, 4 * interval]])
    assert.equal(report.status, 'completed')
    assert.equal(report.phase, 'verify')
    assert.deepEqual(report.issues.filter(issue => issue.status === 'open').map(issue => [issue.reason, issue.from, issue.through]), [
      ['gap', 2 * interval, 2 * interval], ['missing-base-volume', 3 * interval, 3 * interval], ['negative-volume', 4 * interval, 4 * interval],
    ])
    assert.deepEqual(report.issues.find(issue => issue.reason === 'gap')!.originalRange, { from: 0, through: 2 * interval })
    assert.equal(report.issues.find(issue => issue.reason === 'invalid-ohlc')!.status, 'resolved')
    assert.deepEqual(report.summary, { open: 3, resolved: 1, repairFailed: 0 })
  } finally { await audit.close() }
})

test('failed repair stays unresolved, successful ranges are verified, and retries remain explicit', async () => {
  const metadata = new MemoryMetadata()
  let current = [finding('gap', 0), finding('invalid-ohlc', 2 * interval)]
  const audit = new DataAudit({ metadata,
    inspect: async query => inspected(current.filter(issue => issue.from >= query.from && issue.through <= query.through)),
    repair: async issue => {
      if (issue.reason === 'gap') throw new Error('Source unavailable')
      current = current.filter(row => row.reason !== issue.reason)
    },
  })
  try {
    const { id } = audit.start({ targets: [target()] })
    await audit.whenIdle()
    audit.repair(id)
    await audit.whenIdle()
    const report = audit.get(id)!
    assert.equal(report.status, 'completed')
    assert.equal(report.repairIndex, 2)
    assert.equal(report.verifyIndex, 2)
    assert.equal(report.issues.find(issue => issue.reason === 'gap')!.repairError, 'Source unavailable')
    assert.deepEqual(report.summary, { open: 1, resolved: 1, repairFailed: 1 })
  } finally { await audit.close() }
})

test('cancelled repair resumes its durable repair cursor and then verifies', async () => {
  const metadata = new MemoryMetadata()
  const entered = deferred<AbortSignal>()
  const gate = deferred<void>()
  let current = [finding('gap', 0), finding('gap', 2 * interval)]
  const repaired: number[] = []
  const audit = new DataAudit({ metadata,
    inspect: async query => inspected(current.filter(issue => issue.from >= query.from && issue.through <= query.through)),
    repair: async (issue, { signal }) => {
      repaired.push(issue.from)
      if (repaired.length === 2) { entered.resolve(signal); await gate.promise; if (signal.aborted) return }
      current = current.filter(row => row.from !== issue.from)
    },
  })
  try {
    const { id } = audit.start({ targets: [target()] })
    await audit.whenIdle()
    audit.repair(id)
    const signal = await entered.promise
    audit.cancel(id)
    assert.equal(signal.aborted, true)
    gate.resolve()
    await audit.whenIdle()
    assert.equal(audit.get(id)!.repairIndex, 1)
    audit.resume(id)
    await audit.whenIdle()
    assert.deepEqual(repaired, [0, 2 * interval, 2 * interval])
    assert.deepEqual(audit.get(id)!.summary, { open: 0, resolved: 2, repairFailed: 0 })
  } finally { gate.resolve(); await audit.close() }
})

test('verification failures preserve their cursor and resume without repeating completed repairs', async () => {
  const metadata = new MemoryMetadata()
  let initial = true
  let failVerification = true
  let repairs = 0
  const calls: number[] = []
  const audit = new DataAudit({ metadata,
    inspect: async query => {
      calls.push(query.from)
      if (initial) { initial = false; return inspected([finding('gap', 0), finding('gap', 2 * interval)]) }
      if (query.from === 2 * interval && failVerification) throw new Error('Disk read failed')
      return inspected([])
    },
    repair: async () => { repairs += 1 },
  })
  try {
    const { id } = audit.start({ targets: [target()] })
    await audit.whenIdle()
    audit.repair(id)
    await audit.whenIdle()
    assert.equal(audit.get(id)!.status, 'failed')
    assert.equal(audit.get(id)!.phase, 'verify')
    assert.equal(audit.get(id)!.verifyIndex, 1)
    assert.equal(audit.get(id)!.error, 'Disk read failed')
    failVerification = false
    audit.resume(id)
    await audit.whenIdle()
    assert.equal(repairs, 2)
    assert.deepEqual(calls, [0, 0, 2 * interval, 2 * interval])
    assert.equal(audit.get(id)!.summary.open, 0)
  } finally { await audit.close() }
})

test('audit rejects invalid requests and never fabricates a repair without an injected source', async () => {
  const metadata = new MemoryMetadata()
  const audit = new DataAudit({ metadata, inspect: async () => inspected([finding('missing-base-volume', 0)]) })
  assert.throws(() => audit.start({ targets: [] }), /at least one target/)
  assert.throws(() => audit.start({ targets: [target(-1)] }), /ordered/)
  assert.throws(() => audit.start({ targets: [{ ...target(), timeframe: '1m' as '5m' }] }), /timeframe/)
  try {
    const { id } = audit.start({ id: 'valid', targets: [target()] })
    assert.throws(() => audit.start({ id, targets: [target()] }), /already exists/)
    await audit.whenIdle()
    assert.throws(() => audit.repair(id), /repair callback is required/)
    assert.equal(audit.get(id)!.issues[0].status, 'open')
  } finally { await audit.close() }
  assert.throws(() => audit.start({ targets: [target()] }), /closed/)
})

test('an inspector I/O failure is a resumable failure, not a gap or a clean report', async () => {
  const metadata = new MemoryMetadata()
  let broken = true
  const audit = new DataAudit({ metadata, inspect: async () => {
    if (broken) throw new Error('EACCES: Parquet file cannot be read')
    return inspected()
  } })
  try {
    const { id } = audit.start({ targets: [target()] })
    await audit.whenIdle()
    assert.equal(audit.get(id)!.status, 'failed')
    assert.equal(audit.get(id)!.cursor.nextFrom, 0)
    assert.equal(audit.get(id)!.issues.length, 0)
    assert.match(audit.get(id)!.error!, /EACCES/)
    broken = false
    audit.resume(id)
    await audit.whenIdle()
    assert.equal(audit.get(id)!.status, 'completed')
  } finally { await audit.close() }
})

test('a partial-day request preserves and repairs the full corrupt Parquet partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-audit-parquet-'))
  const store = await MarketStore.open(root)
  const base = Date.UTC(2024, 0, 1)
  const through = base + day - interval
  const candle = (timestamp: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 1, confirmed: true })
  const repairs: Array<[number, number]> = []
  const audit = new DataAudit({ metadata: new MemoryMetadata(), store, repair: async issue => {
    repairs.push([issue.from, issue.through])
    await store.replaceCandles(issue, Array.from({ length: 288 }, (_, index) => candle(base + index * interval)))
  } })
  try {
    await store.appendCandles([candle(base)])
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01')
    const [file] = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    await writeFile(join(directory, file), 'broken parquet')
    const { id } = audit.start({ targets: [target(base + 12 * 3_600_000, base + 12 * 3_600_000)] })
    await audit.whenIdle()
    assert.equal(audit.get(id)!.status, 'completed')
    assert.deepEqual(audit.get(id)!.issues.map(issue => [issue.reason, issue.from, issue.through]), [['corrupt-file', base, through]])
    audit.repair(id)
    await audit.whenIdle()
    assert.deepEqual(repairs, [[base, through]])
    assert.deepEqual(audit.get(id)!.summary, { open: 0, resolved: 1, repairFailed: 0 })
    assert.equal((await store.candles({ ...target(base, through) })).length, 288)
  } finally { await audit.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('restart rejects corrupt checkpoint cursors instead of silently completing or losing an audit', async () => {
  const metadata = new MemoryMetadata()
  const audit = new DataAudit({ metadata, inspect: async () => inspected() })
  const { id } = audit.start({ targets: [target()] })
  await audit.close()
  const saved = metadata.records.get(id)!
  metadata.saveAudit({ ...saved, cursor: { targetIndex: 2, nextFrom: null } })
  assert.throws(() => new DataAudit({ metadata, inspect: async () => inspected() }), /checkpoint targetIndex/)
  metadata.saveAudit({ ...saved, cursor: { targetIndex: 0, nextFrom: -1 } })
  assert.throws(() => new DataAudit({ metadata, inspect: async () => inspected() }), /checkpoint: nextFrom/)
  metadata.saveAudit({ ...saved, phase: 'repair', repairIndex: 1 })
  assert.throws(() => new DataAudit({ metadata, inspect: async () => inspected() }), /checkpoint repair or verification cursor/)
})

test('off-grid observations preserve the inspector containing-bar repair range', async () => {
  const audit = new DataAudit({ metadata: new MemoryMetadata(), inspect: async () => inspected([finding('invalid-grid', interval)]) })
  try {
    const { id } = audit.start({ targets: [target(interval + 1, interval + 1)] })
    await audit.whenIdle()
    assert.equal(audit.get(id)!.status, 'completed')
    assert.deepEqual(audit.get(id)!.issues.map(issue => [issue.from, issue.through]), [[interval, interval]])
  } finally { await audit.close() }
})
