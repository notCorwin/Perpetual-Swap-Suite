import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

const fiveMinutes = 300_000
const record = (timestamp: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, confirmed: true })

test('coverage invalidation reports only durable mutation ranges and resets after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-coverage-version-'))
  let store = await MarketStore.open(root)
  const base = Date.UTC(2024, 0, 1)
  try {
    assert.deepEqual(store.candleChangesSince('BTC-USDT-SWAP', '5m', 0), { revision: 0, ranges: [] })
    await store.appendCandles([record(base), record(base + fiveMinutes)])
    assert.deepEqual(store.candleChangesSince('BTC-USDT-SWAP', '5m', 0), {
      revision: 1, ranges: [{ from: base, through: base + fiveMinutes }],
    })
    await store.replaceCandles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base }, [])
    assert.deepEqual(store.candleChangesSince('BTC-USDT-SWAP', '5m', 1), { revision: 2, ranges: [{ from: base, through: base }] })
    assert.deepEqual(store.candleChangesSince('BTC-USDT-SWAP', '5m', 2), { revision: 2, ranges: [] })
    await store.close(); store = await MarketStore.open(root)
    assert.deepEqual(store.candleChangesSince('BTC-USDT-SWAP', '5m', 2), { revision: 0, ranges: null })
    assert.equal((await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' })).length, 1)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('missingCandleRanges reports only contiguous gaps inside the requested 5m range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const base = Date.UTC(2024, 0, 1)
    await store.appendCandles(Array.from({ length: 10 }, (_, index) => index).filter(index => ![2, 4, 5].includes(index)).map(index => record(base + index * fiveMinutes)))
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base, through: base + 9 * fiveMinutes }), [
      { from: base + 2 * fiveMinutes, through: base + 2 * fiveMinutes },
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base + 3 * fiveMinutes, through: base + 6 * fiveMinutes }), [
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('candles normalize numeric statistics from heterogeneous Parquet parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const timestamp = Date.UTC(2024, 0, 1)
    // The first part omits optional statistics, just like a raw/derived write
    // before direct OI/Taker hydration. A later part supplies them.
    await store.appendCandles([record(timestamp)])
    await store.appendCandles([{ ...record(timestamp), oi: 1_000, buy: 200, sell: 100 }])
    const [candle] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: timestamp, through: timestamp })
    assert.equal(candle.oi, 1_000)
    assert.equal(candle.buy, 200)
    assert.equal(candle.sell, 100)
    assert.equal(typeof candle.oi, 'number')
    assert.equal(typeof candle.buy, 'number')
    assert.equal(typeof candle.sell, 'number')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('close drains work already admitted to the DuckDB lane and rejects new work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const internal: any = store
  try {
    const admitted = internal.enqueue(async () => { await gate; return 'done' })
    const closing = store.close()
    await assert.rejects(() => internal.enqueue(async () => 'late'), /MarketStore is closed/)
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(closed, false)
    release?.()
    assert.equal(await admitted, 'done')
    await closing
    assert.equal(closed, true)
  } finally { release?.(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('the write boundary rejects a whole batch before persisting invalid observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-ingestion-'))
  const store = await MarketStore.open(root)
  const base = Date.UTC(2024, 0, 1)
  try {
    for (const patch of [
      { confirmed: false }, { confirmed: 'true' }, { timestamp: base + 1 }, { timeframe: '1m' },
      { high: 98 }, { low: 102 }, { close: 0 }, { open: Infinity }, { volume: -1 },
      { baseVolume: -1 }, { quoteVolume: NaN }, { oi: '10' },
    ]) {
      await assert.rejects(store.appendCandles([record(base), { ...record(base + fiveMinutes), ...patch } as any]))
      assert.deepEqual(await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' }), [])
    }
    await store.appendCandles([{ ...record(base), baseVolume: null }])
    const [saved] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' })
    assert.equal(saved.baseVolume, null, 'Missing base volume must never be reconstructed from quote amount and price.')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('same-batch revisions are deterministic and explicit Parquet units survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-schema-'))
  let store = await MarketStore.open(root)
  const base = Date.UTC(2024, 0, 1)
  try {
    await store.appendCandles([{ ...record(base), baseVolume: 2 }, { ...record(base), close: 101, baseVolume: 3 }])
    await store.close(); store = await MarketStore.open(root)
    const [saved] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' })
    assert.equal(saved.close, 101)
    assert.equal(saved.baseVolume, 3)
    const internal: any = store
    const types = await store.enqueue(async () => {
      const files = await internal.parquetFiles('BTC-USDT-SWAP', '5m')
      return (await internal.connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${files[0]}', hive_partitioning=false)`)).getRowObjectsJS()
    })
    assert.equal(types.find((column: any) => column.column_name === 'timestamp').column_type, 'BIGINT')
    assert.equal(types.find((column: any) => column.column_name === 'baseVolume').column_type, 'DOUBLE')
    assert.equal(types.find((column: any) => column.column_name === 'confirmed').column_type, 'BOOLEAN')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('legacy Parquet without base volume remains readable with a typed null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-legacy-'))
  const store = await MarketStore.open(root), internal: any = store
  const base = Date.UTC(2024, 0, 1)
  try {
    await store.appendCandles([record(base)])
    const files = await internal.parquetFiles('BTC-USDT-SWAP', '5m')
    const legacy = join(internal.partition('BTC-USDT-SWAP', '5m', base), 'legacy.parquet')
    await store.enqueue(() => internal.connection.run(`COPY (SELECT * EXCLUDE(baseVolume) FROM read_parquet('${files[0]}', hive_partitioning=false)) TO '${legacy}' (FORMAT PARQUET)`))
    await rm(files[0])
    assert.equal((await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' }))[0].baseVolume, null)
    assert.equal((await store.inspectCandles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base })).issues[0].reason, 'missing-base-volume')
    await store.appendCandles([{ ...record(base + fiveMinutes), baseVolume: 5 }])
    assert.deepEqual((await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m' })).map(row => row.baseVolume), [null, 5])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('audit reports physical duplicates, invalid values, off-grid records and real gaps separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-inspection-'))
  const store = await MarketStore.open(root), internal: any = store
  const base = Date.UTC(2024, 0, 1), query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 2 * fiveMinutes }
  try {
    await store.appendCandles([{ ...record(base), baseVolume: 1 }])
    const [file] = await internal.parquetFiles(query.instrument, query.timeframe)
    const bad = join(internal.partition(query.instrument, query.timeframe, base), 'bad.parquet')
    await store.enqueue(() => internal.connection.run(`COPY (
      SELECT * REPLACE(false AS confirmed, -1::DOUBLE AS volume, 90::DOUBLE AS high) FROM read_parquet('${file}',hive_partitioning=false)
      UNION ALL SELECT * REPLACE(${base + fiveMinutes + 1}::BIGINT AS timestamp) FROM read_parquet('${file}',hive_partitioning=false)
    ) TO '${bad}' (FORMAT PARQUET)`))
    const report = await store.inspectCandles(query)
    assert.equal(report.checkedRows, 3)
    assert.deepEqual(new Set(report.issues.map(issue => issue.reason)), new Set(['duplicate', 'unconfirmed', 'negative-volume', 'invalid-ohlc', 'invalid-grid', 'gap']))
    assert.deepEqual(report.missingRanges, [{ from: base + fiveMinutes, through: base + 2 * fiveMinutes }])
    await store.replaceCandles(query, [0, 1, 2].map(index => ({ ...record(base + index * fiveMinutes), baseVolume: 1 })))
    assert.deepEqual((await store.inspectCandles(query)).issues, [])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('corrupt files report their exact partition and require a full-day repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-corruption-'))
  const store = await MarketStore.open(root), internal: any = store
  const { writeFile } = await import('node:fs/promises')
  const base = Date.UTC(2024, 0, 1), through = base + 86_400_000 - fiveMinutes
  try {
    await store.appendCandles([{ ...record(base), baseVolume: 1 }])
    const [file] = await internal.parquetFiles('BTC-USDT-SWAP', '5m')
    await writeFile(file, 'broken parquet')
    const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base }
    const report = await store.inspectCandles(query)
    assert.deepEqual(report.issues.map(({ reason, from, through }) => ({ reason, from, through })), [{ reason: 'corrupt-file', from: base, through }])
    assert.deepEqual(report.missingRanges, [], 'Unreadable records must not become fabricated gap reports.')
    await assert.rejects(store.replaceCandles(query, [{ ...record(base), baseVolume: 1 }]))
    await store.replaceCandles({ ...query, through }, Array.from({ length: 288 }, (_, index) => ({ ...record(base + index * fiveMinutes), baseVolume: 1 })))
    assert.deepEqual((await store.inspectCandles({ ...query, through })).issues, [])
    assert.equal(store.getWriteMetrics().partitions, 2)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('missing data is empty while filesystem failures propagate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-io-'))
  const store = await MarketStore.open(root)
  const { mkdir, writeFile } = await import('node:fs/promises')
  try {
    assert.deepEqual(await store.candles({ instrument: 'ABSENT', timeframe: '5m' }), [])
    await mkdir(join(root, 'candles', 'timeframe=5m'), { recursive: true })
    await writeFile(join(root, 'candles', 'timeframe=5m', 'instrument=FAILED'), 'not a directory')
    await assert.rejects(store.candles({ instrument: 'FAILED', timeframe: '5m' }), { code: 'ENOTDIR' })
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('read boundaries reject lossy timestamp and confirmation casts and mismatched partition identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-read-contract-'))
  const store = await MarketStore.open(root), internal: any = store
  const base = Date.UTC(2024, 0, 1), query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base }
  try {
    await store.appendCandles([{ ...record(base), baseVolume: 1 }])
    const [original] = await internal.parquetFiles(query.instrument, query.timeframe)
    const damaged = join(internal.partition(query.instrument, query.timeframe, base), 'damaged.parquet')
    await store.enqueue(() => internal.connection.run(`COPY (SELECT * REPLACE(${base}.4::DOUBLE AS timestamp, 2::INTEGER AS confirmed) FROM read_parquet('${original}',hive_partitioning=false)) TO '${damaged}' (FORMAT PARQUET)`))
    await rm(original)
    await assert.rejects(store.candles(query), /schema/)
    const findings = (await store.inspectCandles({ ...query, through: base + fiveMinutes })).issues
    assert.deepEqual(findings[0], { ...query, source: 'candles', through: base + 86_400_000 - fiveMinutes, reason: 'invalid-schema', repairable: true, file: damaged, detail: 'Invalid persisted candle timestamp or confirmation schema. Run a data audit.' })
    assert.equal(findings.some(issue => issue.reason === 'invalid-grid'), true)
    assert.equal(findings.some(issue => issue.reason === 'unconfirmed'), true)
    await store.replaceCandles({ ...query, through: base + 86_400_000 - fiveMinutes }, [{ ...record(base), baseVolume: 1 }])
    const [repaired] = await internal.parquetFiles(query.instrument, query.timeframe)
    await store.enqueue(() => internal.connection.run(`COPY (SELECT * REPLACE('ETH-USDT-SWAP' AS instrument) FROM read_parquet('${repaired}',hive_partitioning=false)) TO '${damaged}' (FORMAT PARQUET)`))
    await rm(repaired)
    await assert.rejects(store.candles(query), /partition/)
    assert.equal((await store.inspectCandles(query)).issues.some(issue => issue.reason === 'invalid-partition'), true)
    await store.replaceCandles({ ...query, through: base + 86_400_000 - fiveMinutes }, [{ ...record(base), baseVolume: 1 }])
    const [validFile] = await internal.parquetFiles(query.instrument, query.timeframe)
    await store.enqueue(() => internal.connection.run(`COPY (SELECT * REPLACE(timestamp::DOUBLE AS timestamp) FROM read_parquet('${validFile}',hive_partitioning=false)) TO '${damaged}' (FORMAT PARQUET)`))
    await rm(validFile)
    await assert.rejects(store.candles(query), /schema/)
    const schemaIssue = (await store.inspectCandles(query)).issues[0]
    assert.equal(schemaIssue.reason, 'invalid-schema', 'An incompatible physical schema must never produce a clean audit.')
    await store.replaceCandles(schemaIssue, [{ ...record(base), baseVolume: 1 }])
    assert.equal((await store.candles(query))[0].timestamp, base)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
