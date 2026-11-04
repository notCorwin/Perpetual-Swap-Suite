#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

// Compare only the writer implementation: both variants use the same current
// MarketStore facade and unchanged helpers, with separate SQLite databases.
const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { variant: { type: 'string' }, output: { type: 'string' } } })
if (!['baseline', 'candidate'].includes(values.variant)) throw new Error('--variant baseline|candidate is required')
const serviceDir = join(root, 'electron/services'), workerPath = join(serviceDir, 'market-store-worker.js')
const currentWorker = await readFile(workerPath, 'utf8')
const oldWorker = execFileSync('git', ['show', 'HEAD:electron/services/market-store-worker.js'], { cwd: root, encoding: 'utf8' })
const facade = await readFile(join(serviceDir, 'market-store.js'), 'utf8')
const helperNames = ['operation-runtime.js', 'worker-operations.js', 'recorded-database.js', 'market-records.js', 'statistics-state.js', 'statistics-coverage.js', 'candle-aggregation.js', 'operations.js']
const inputNames = ['scripts/benchmark-aggregate-worker.mjs', 'electron/services/market-store.js', 'electron/services/market-store-worker.js', ...helperNames.map(name => `electron/services/${name}`)]
const digest = value => createHash('sha256').update(value).digest('hex')
const fingerprint = async () => {
  const hash = createHash('sha256')
  for (const name of inputNames) { hash.update(name); hash.update(await readFile(join(root, name))) }
  return hash.digest('hex')
}
const inputHash = await fingerprint(), rootDir = await mkdtemp(join(tmpdir(), 'perp-aggregate-worker-')), codeDir = join(rootDir, 'code')
const relocate = source => helperNames.reduce((text, name) => text.replaceAll(`'./${name}'`, JSON.stringify(pathToFileURL(join(serviceDir, name)).href)), source)
let store, database
try {
  await mkdir(codeDir)
  await writeFile(join(codeDir, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(codeDir, 'market-store.js'), relocate(facade))
  await writeFile(join(codeDir, 'market-store-worker.js'), relocate(values.variant === 'baseline' ? oldWorker : currentWorker))
  const { MarketStore } = await import(pathToFileURL(join(codeDir, 'market-store.js')).href)
  store = await MarketStore.open(rootDir)
  database = new DatabaseSync(join(rootDir, 'market.sqlite'))
  const instrument = 'BENCH-USDT-SWAP', base = Date.UTC(2024, 0, 1), fine = 300_000, step = 900_000
  const row = (index, revision = 0) => ({ instrument, timeframe: '5m', timestamp: base + index * fine,
    open: 100 + index % 10 + revision, high: 120 + index % 10 + revision, low: 90 + index % 10 + revision,
    close: 101 + index % 10 + revision, volume: 1, baseVolume: 2, quoteVolume: 3, confirmed: true })
  const range = { instrument, timeframe: '15m', from: base, through: base + 2999 * step, invalidateIncomplete: true }
  database.exec(`CREATE TABLE update_count(n INTEGER NOT NULL);
    CREATE TRIGGER count_parent_updates AFTER UPDATE OF candle_count ON series
    WHEN NEW.instrument='${instrument}' AND NEW.timeframe='15m' BEGIN INSERT INTO update_count VALUES(1); END;`)
  const updates = () => Number(database.prepare('SELECT count(*) AS count FROM update_count').get().count)
  // write timestamps are wall-clock facts and intentionally differ between
  // separate runs; all exported price/statistic fields remain in the digest.
  const snapshot = async () => ({ rows: (await store.candles(range)).map(({ writtenAt, ...row }) => row),
    coverage: await store.coverage(instrument, '15m') })
  const stage = async () => {
    const before = updates(), cpu = process.cpuUsage(), start = performance.now()
    const result = await store.aggregateCandles(range)
    const wallMS = performance.now() - start, elapsedCPU = process.cpuUsage(cpu)
    return { result, wallMS, processCPUms: (elapsedCPU.user + elapsedCPU.system) / 1000, metadataUpdates: updates() - before }
  }
  await store.appendCandles(Array.from({ length: 7200 }, (_, index) => row(index)))
  const insert = await stage()
  assert.deepEqual(insert.result, { changed: 2400, complete: 2400, invalidated: 0 })
  const afterInsert = await snapshot()
  assert.deepEqual(afterInsert.coverage, { count: 2400, first: base, last: base + 2399 * step })
  await store.replaceCandles({ instrument, timeframe: '5m', from: base, through: base + 1799 * fine }, [])
  await store.appendCandles([...Array.from({ length: 1800 }, (_, index) => row(1800 + index, 1)),
    ...Array.from({ length: 1800 }, (_, index) => row(7200 + index))])
  const mixed = await stage()
  assert.deepEqual(mixed.result, { changed: 1800, complete: 2400, invalidated: 600 })
  const afterMixed = await snapshot()
  assert.deepEqual(afterMixed.coverage, { count: 2400, first: base + 600 * step, last: base + 2999 * step })
  const repeat = await stage()
  assert.deepEqual(repeat.result, { changed: 0, complete: 2400, invalidated: 0 })
  assert.deepEqual(await snapshot(), afterMixed)
  await store.appendCandles([row(600 * 3, 2), row(1800 * 3, 2)])
  const beforeRollback = await snapshot(), revision = store.candleRevision(instrument, '15m'), beforeUpdates = updates()
  database.exec(`CREATE TRIGGER reject_parent BEFORE UPDATE ON candles
    WHEN NEW.timestamp=${base + 1800 * step} AND NEW.series_id=(SELECT id FROM series WHERE instrument='${instrument}' AND timeframe='15m')
    BEGIN SELECT RAISE(ABORT, 'injected aggregate failure'); END;`)
  await assert.rejects(store.aggregateCandles(range), /injected aggregate failure/)
  assert.deepEqual(await snapshot(), beforeRollback)
  assert.equal(store.candleRevision(instrument, '15m'), revision)
  assert.equal(updates(), beforeUpdates)
  if (await fingerprint() !== inputHash) throw new Error('Benchmark inputs changed; discard result.')
  const result = { variant: values.variant, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    inputHash, workerSHA256: { baseline: digest(oldWorker), candidate: digest(currentWorker) },
    insert, mixed, repeat, rollback: 'verified: rows, metadata, revision and trigger updates unchanged',
    snapshots: { insert: digest(JSON.stringify(afterInsert)), mixed: digest(JSON.stringify(afterMixed)) },
    measurement: 'CPU is process-wide including worker threads and sandbox instrumentation. Each aggregate uses FULL synchronous SQLite; metadata counts use a transactional SQLite trigger. Same current facade and helpers; only worker differs.' }
  if (values.output) await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
} finally {
  database?.close(); await store?.close(); await rm(rootDir, { recursive: true, force: true })
}
