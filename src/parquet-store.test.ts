import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { MarketStore } from '../electron/services/market-store.js'

const base = Date.UTC(2024, 0, 1), step = 300_000
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + step }
const row = (index: number, close = 100) => ({ instrument: query.instrument, timeframe: query.timeframe, timestamp: base + index * step,
  open: 100, high: Math.max(close, 101), low: 99, close, volume: 1, baseVolume: 2, quoteVolume: 200,
  oi: 1_000, sell: 20, buy: 30, statisticsVersion: 1, confirmed: true, writtenAt: 100 + index })
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const legacy = async (root: string, name: string, values: any[]) => {
  const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01')
  await mkdir(directory, { recursive: true })
  const source = join(root, 'input.json'), path = join(directory, name), engine = await DuckDBInstance.create(':memory:'), db = await engine.connect()
  try {
    await writeFile(source, JSON.stringify(values))
    const columns = `instrument:'VARCHAR',timeframe:'VARCHAR',timestamp:'BIGINT',open:'DOUBLE',high:'DOUBLE',low:'DOUBLE',close:'DOUBLE',volume:'DOUBLE',baseVolume:'DOUBLE',quoteVolume:'DOUBLE',oi:'DOUBLE',sell:'DOUBLE',buy:'DOUBLE',statisticsVersion:'INTEGER',confirmed:'BOOLEAN',writtenAt:'BIGINT'`
    await db.run(`COPY(SELECT * FROM read_json(${quote(source)},columns={${columns}},format='array')) TO ${quote(path)} (FORMAT PARQUET)`)
    return path
  } finally { db.closeSync(); engine.closeSync(); await rm(source, { force: true }) }
}

test('legacy Parquet is imported read-only with newest base visibility and durable resumability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-legacy-import-'))
  let store: MarketStore | undefined
  try {
    await legacy(root, 'delta-100-old.parquet', [row(0, 150), row(1)])
    const active = await legacy(root, 'base-200-current.parquet', [{ ...row(1, 110), writtenAt: 200 }])
    const original = await readFile(active)
    store = await MarketStore.open(root)
    const rows = await store.candles(query)
    assert.deepEqual(rows.map(value => value.timestamp), [base + step], 'An obsolete delta cannot resurrect a row deleted by a repair base.')
    assert.equal(rows[0].close, 110); assert.equal(rows[0].oi, 1_000)
    assert.deepEqual(await readFile(active), original)
    const watermark = await store.candleWatermark(query.instrument, query.timeframe)
    await store.close(); store = await MarketStore.open(root)
    assert.equal((await store.candles(query))[0].close, 110)
    assert.equal(await store.candleWatermark(query.instrument, query.timeframe), watermark)
    assert.equal((await readdir(join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01'))).length, 2)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})
test('old imports cannot overwrite newly collected prices or source statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-live-'))
  let store: MarketStore | undefined
  try {
    await legacy(root, 'base-10000000000000-old.parquet', [{ ...row(0), writtenAt: 10_000_000_000_000 }])
    store = await MarketStore.open(root)
    await store.appendCandles([{ ...row(0, 250), oi: undefined, buy: undefined, sell: undefined, statisticsVersion: undefined }])
    await store.appendStatistics({ ...query, through: base, source: 'oi', values: [[base, 5_000]], expiresAt: null })
    const [value] = await store.candles(query)
    assert.equal(value.close, 250); assert.equal(value.oi, 5_000)
    assert.equal(value.sell, 20, 'An imported independent source can fill a newly collected price.')
    await store.replaceCandles({ ...query, through: base }, [])
    await store.close(); store = await MarketStore.open(root)
    assert.deepEqual(await store.candles(query), [], 'Source files retained on disk do not resurrect deleted SQLite facts.')
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('expired absence is not renewed during import and SQLite becomes the sole source after cutover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-audit-'))
  let store: MarketStore | undefined
  try {
    const file = await legacy(root, 'base-200-data.parquet', [{ ...row(0), oi: null, buy: null, sell: null, statisticsVersion: 11 }])
    store = await MarketStore.open(root)
    const observations = await store.statistics(query)
    assert.equal(observations[0].oi, null)
    assert.equal(observations[0].statisticsOIExpiresAt, null)
    assert.deepEqual(await store.statisticsMissingRanges({ ...query, through: base, source: 'oi' }), [{ from: base, through: base }])
    await store.close(); await writeFile(file, 'broken parquet'); store = await MarketStore.open(root)
    assert.equal((await store.candles(query))[0].close, 100, 'Retained Parquet becomes an immutable recovery artifact after import.')
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('an unreadable legacy partition is recorded for audit and can be repaired in SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-corrupt-'))
  let store: MarketStore | undefined
  try {
    const file = await legacy(root, 'base-200-data.parquet', [row(0)])
    await writeFile(file, 'broken parquet')
    store = await MarketStore.open(root)
    const issues = (await store.inspectCandles(query)).issues
    assert.ok(issues.some(issue => issue.reason === 'corrupt-file'))
    await store.replaceCandles({ ...query, through: base + 287 * step }, [row(0), row(1)])
    assert.ok(!(await store.inspectCandles(query)).issues.some(issue => issue.reason === 'corrupt-file'))
    assert.equal((await store.candles(query)).length, 2)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('bounded latest reads and metadata never wait for unrelated legacy partitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-latest-'))
  let store: MarketStore | undefined
  try {
    const corrupt = await legacy(root, 'base-100-old.parquet', [row(0)])
    const recent = await legacy(root, 'base-200-recent.parquet', [row(288)])
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-02')
    await mkdir(directory)
    await rename(recent, join(directory, 'base-200-recent.parquet'))
    await writeFile(corrupt, 'broken parquet')
    store = await MarketStore.open(root)
    await store.coverage(query.instrument, query.timeframe)
    await store.priceWatermark(query.instrument, query.timeframe)
    const latest = await store.candles({ instrument: query.instrument, timeframe: query.timeframe, limit: 1, order: 'desc' }, 'interactive')
    assert.equal(latest[0].timestamp, base + 86_400_000)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('ambiguous equal-revision legacy rows are retained for audit rather than chosen arbitrarily', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-duplicate-'))
  let store: MarketStore | undefined
  try {
    await legacy(root, 'base-200-first.parquet', [row(0)])
    await legacy(root, 'delta-201-conflict.parquet', [row(0, 150)])
    store = await MarketStore.open(root)
    assert.ok((await store.inspectCandles(query)).issues.some(issue => issue.reason === 'duplicate'))
    assert.equal((await readdir(join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01'))).length, 2)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('an operational import failure cannot certify cutover or erase its retryable source', { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-permission-'))
  const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP')
  let store: MarketStore | undefined
  try {
    await legacy(root, 'base-200-first.parquet', [row(0)])
    await chmod(directory, 0)
    store = await MarketStore.open(root)
    await assert.rejects(store.candles(query), /EACCES|permission/i)
    assert.equal((await store.migrationStatus()).complete, false)
    await chmod(directory, 0o700)
    assert.equal((await store.candles(query))[0].close, 100)
  } finally { await chmod(directory, 0o700).catch(() => {}); await store?.close(); await rm(root, { recursive: true, force: true }) }
})
