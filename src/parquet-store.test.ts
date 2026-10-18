import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

test('DuckDB writes partitioned Parquet candles and queries their range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    await store.appendCandles([
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_100_000, open: 100, high: 110, low: 95, close: 105, volume: 42, confirmed: true },
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_400_000, open: 105, high: 115, low: 100, close: 110, volume: 43, confirmed: true },
    ])
    const rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: 1_700_000_100_000, through: 1_700_000_100_000 })
    assert.deepEqual(rows.map(row => ({ timestamp: row.timestamp, close: row.close, confirmed: row.confirmed })), [{ timestamp: 1_700_000_100_000, close: 105, confirmed: true }])
    const timeframes = await readdir(join(root, 'candles'))
    assert.deepEqual(timeframes, ['timeframe=5m'])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('foreground store work cuts ahead of queued background reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    let releaseHold: (() => void) | undefined
    const holdGate = new Promise<void>(resolve => { releaseHold = resolve })
    const order: string[] = []
    const hold = store.enqueue(async () => { await holdGate; order.push('hold') })
    store.enqueue(async () => { order.push('background-1') })
    store.enqueue(async () => { order.push('background-2') })
    const foreground = store.enqueue(async () => { order.push('foreground') }, 'foreground')
    releaseHold?.()
    await Promise.all([hold, foreground])
    await store.enqueue(async () => undefined)
    assert.deepEqual(order, ['hold', 'foreground', 'background-1', 'background-2'])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('immutable appends retain bounded parts with newest values winning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    const first = 1_700_000_100_000, second = first + 300_000, third = first + 600_000
    const candle = (timestamp: number, close: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: Math.max(111, close), low: 95, close, volume: 1, confirmed: true })
    await store.appendCandles([candle(first, 105), candle(second, 110)])
    let coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.equal(coverage.count, 2)
    // A statistics patch overwrites the first timestamp and adds a third.
    await store.appendCandles([candle(first, 106), candle(third, 111)])
    coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.equal(coverage.count, 3, 'Every write invalidates the cached coverage scan.')
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2023-11-14')
    const parts = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    assert.equal(parts.length, 2, 'An append publishes only incoming rows without rewriting the prior part.')
    assert.equal(store.getWriteMetrics().bytesRead, 0)
    const rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: third })
    assert.deepEqual(rows.map(row => row.close), [106, 110, 111])
    const missing = await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: third })
    assert.deepEqual(missing, [], 'A complete window reports no gaps across versioned parts.')
    const fourth = third + 600_000
    await store.appendCandles([candle(fourth, 112)])
    const holes = await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: fourth })
    assert.deepEqual(holes, [{ from: third + 300_000, through: third + 300_000 }])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

const dayStart = Date.UTC(2024, 0, 1), step = 300_000
const row = (index: number, close = 100 + index / 3) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: dayStart + index * step, open: close - 1, high: close + 2, low: close - 2, close, volume: index + 1, baseVolume: index + 1, quoteVolume: close * (index + 1), confirmed: true })
const dayQuery = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: dayStart, through: dayStart + 287 * step }

test('small revisions write only incoming rows and compact at eight active parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-deltas-'))
  const store = await MarketStore.open(root), internal: any = store
  try {
    await store.appendCandles(Array.from({ length: 288 }, (_, index) => row(index)))
    let compactionReads = 0
    for (let revision = 1; revision <= 30; revision += 1) {
      const before = store.getWriteMetrics(), filesBefore = await internal.parquetFiles(dayQuery.instrument, dayQuery.timeframe)
      await store.appendCandles([row(100, 500 + revision)])
      const after = store.getWriteMetrics(), files = await internal.parquetFiles(dayQuery.instrument, dayQuery.timeframe)
      assert.ok(files.length < 8, 'Reaching eight parts must publish one compacted base.')
      if (filesBefore.length === 7) {
        compactionReads += 1
        assert.equal(files.length, 1)
        assert.ok(after.bytesRead > before.bytesRead)
      } else {
        assert.equal(after.bytesRead, before.bytesRead, 'A normal append must not read existing history.')
        const newest = files.find((file: string) => !filesBefore.includes(file))
        const count = await store.enqueue(async () => (await internal.connection.runAndReadAll(`SELECT COUNT(*) AS count FROM read_parquet('${newest}', hive_partitioning=false)`)).getRowObjectsJS()[0].count)
        assert.equal(Number(count), 1, 'A delta stores one incoming candle rather than a full-day rewrite.')
      }
      const rows = await store.candles(dayQuery)
      assert.equal(rows.length, 288)
      assert.equal(rows[100].close, 500 + revision)
      assert.deepEqual((await store.inspectCandles(dayQuery)).issues, [])
    }
    assert.equal(compactionReads, 4, 'Thirty small revisions should read history four times instead of thirty.')
    const directory = internal.partition(dayQuery.instrument, dayQuery.timeframe, dayStart)
    assert.ok((await readdir(directory)).filter(name => name.endsWith('.parquet')).length < 8)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('published base generations hide pre-compaction files left by an interrupted cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-base-recovery-'))
  let store = await MarketStore.open(root)
  const internal: any = store
  try {
    await store.appendCandles([row(0), row(1)])
    await store.appendCandles([row(0, 250)])
    const oldFiles = await internal.parquetFiles(dayQuery.instrument, dayQuery.timeframe)
    const oldParts = await Promise.all(oldFiles.map(async (file: string) => ({ file, bytes: await readFile(file) })))
    const before = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    await store.replaceCandles({ ...dayQuery, through: dayStart }, [])
    const deletion = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    assert.notEqual(deletion, before, 'A deletion must change the durable watermark even when no incoming candle exists.')
    // Recreate precisely the files a process kill after base publication but
    // before cleanup would leave. They must be invisible, even after restart.
    await Promise.all(oldParts.map(({ file, bytes }) => writeFile(file, bytes)))
    await store.close(); store = await MarketStore.open(root)
    assert.deepEqual((await store.candles(dayQuery)).map(candle => candle.timestamp), [dayStart + step])
    const report = await store.inspectCandles({ ...dayQuery, through: dayStart + step })
    assert.deepEqual(report.issues.map(issue => issue.reason), ['gap'])
    assert.equal(await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe), deletion)
    const retained = await (store as any).parquetFiles(dayQuery.instrument, dayQuery.timeframe)
    const retainedParts = await Promise.all(retained.map(async (file: string) => ({ file, bytes: await readFile(file) })))
    await store.replaceCandles(dayQuery, [])
    const emptyWatermark = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    await Promise.all([...oldParts, ...retainedParts].map(({ file, bytes }) => writeFile(file, bytes)))
    await store.close(); store = await MarketStore.open(root)
    assert.deepEqual(await store.candles(dayQuery), [], 'An empty repair base must hide old bases and old deltas.')
    assert.equal(await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe), emptyWatermark)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('restart after a clock rollback still publishes the newest candle revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-revision-restart-'))
  let store = await MarketStore.open(root)
  const realNow = Date.now
  try {
    const future = realNow() + 1_000_000
    Date.now = () => future
    await store.appendCandles([row(0)])
    const before = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    // A base introduces a cutoff as well as a row revision. A new process
    // must reserve after it rather than trusting a regressed wall clock.
    await store.replaceCandles({ ...dayQuery, through: dayStart }, [row(0, 250)])
    await store.close(); store = await MarketStore.open(root)
    Date.now = () => future - 10_000
    await store.appendCandles([row(0, 500)])
    assert.equal((await store.candles(dayQuery))[0].close, 500)
    assert.notEqual(await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe), before)
    await store.close(); store = await MarketStore.open(root)
    assert.equal((await store.candles(dayQuery))[0].close, 500)
  } finally { Date.now = realNow; await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a full legacy repair cannot reuse a stale snapshot identity after clock rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-legacy-repair-clock-'))
  let store = await MarketStore.open(root)
  const realNow = Date.now
  try {
    const clock = realNow() + 1_000_000
    Date.now = () => clock
    await store.appendCandles([row(0)])
    const internal: any = store, [original] = await internal.parquetFiles(dayQuery.instrument, dayQuery.timeframe)
    const legacy = join(internal.partition(dayQuery.instrument, dayQuery.timeframe, dayStart), `part-1-${clock}-abc.parquet`)
    await writeFile(legacy, await readFile(original)); await rm(original)
    const before = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    await store.writeChartSnapshot(dayQuery.instrument, dayQuery.timeframe, { watermark: before, frame: { oldPrice: 100 } })
    Date.now = () => clock + 10_000
    await store.close(); store = await MarketStore.open(root)
    Date.now = () => clock
    await store.replaceCandles(dayQuery, [row(0, 500)])
    assert.equal((await store.candles(dayQuery))[0].writtenAt, clock, 'The replacement can legitimately reuse an old numeric row watermark.')
    const repaired = await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe)
    assert.notEqual(repaired, before, 'Committed file identity must change even when numeric row watermarks collide.')
    await store.close(); store = await MarketStore.open(root)
    assert.equal(await store.candleWatermark(dayQuery.instrument, dayQuery.timeframe), repaired)
    const snapshot = await store.readChartSnapshot(dayQuery.instrument, dayQuery.timeframe) as { watermark: string }
    assert.notEqual(snapshot.watermark, repaired, 'Snapshot restore must reject pre-repair data on restart.')
    assert.equal((await store.candles(dayQuery))[0].close, 500)
  } finally { Date.now = realNow; await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('stable immutable file sets reuse schema inspection while audits always examine physical files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-schema-cache-'))
  let store = await MarketStore.open(root)
  try {
    await store.appendCandles([row(0)])
    await store.appendCandles([row(1)])
    await store.close(); store = await MarketStore.open(root)
    const connection = (store as any).connection, read = connection.runAndReadAll.bind(connection)
    let describes = 0
    connection.runAndReadAll = (sql: string) => { if (sql.startsWith('DESCRIBE')) describes += 1; return read(sql) }
    for (let index = 0; index < 5; index += 1) {
      await store.candles(dayQuery)
      await store.candleTimestamps(dayQuery)
    }
    assert.equal(describes, 1, 'Repeated reads of the same immutable file set must not redescribe Parquet.')
    assert.deepEqual((await store.inspectCandles({ ...dayQuery, through: dayStart + step })).issues, [])
    assert.equal(describes, 3, 'Manual audits must inspect each physical schema independently of the read cache.')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
