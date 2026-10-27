import { test } from 'node:test'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../electron/services/market-store.js'

const base = Date.UTC(2024, 0, 1), step = 300_000
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + step }
const row = (index: number, close = 100) => ({ instrument: query.instrument, timeframe: query.timeframe, timestamp: base + index * step,
  open: 100, high: Math.max(close, 101), low: 99, close, volume: 1, baseVolume: 2, quoteVolume: 200,
  oi: 1_000, sell: 20, buy: 30, statisticsVersion: 11, confirmed: true, writtenAt: 100 + index })
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const legacy = async (root: string, name: string, values: any[]) => {
  const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-01')
  await mkdir(directory, { recursive: true })
  const source = join(root, 'input.json'), path = join(directory, name), engine = await DuckDBInstance.create(':memory:'), db = await engine.connect()
  try {
    await writeFile(source, JSON.stringify(values))
    const columns = `instrument:'VARCHAR',timeframe:'VARCHAR',timestamp:'BIGINT',open:'DOUBLE',high:'DOUBLE',low:'DOUBLE',close:'DOUBLE',volume:'DOUBLE',baseVolume:'DOUBLE',quoteVolume:'DOUBLE',oi:'DOUBLE',sell:'DOUBLE',buy:'DOUBLE',statisticsVersion:'INTEGER',statisticsOIExpiresAt:'BIGINT',statisticsTakerExpiresAt:'BIGINT',confirmed:'BOOLEAN',writtenAt:'BIGINT'`
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

test('legacy statistics encodings convert once at import while preserving numeric downloads and rechecking speculative absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-statistics-'))
  let store: MarketStore | undefined
  try {
    const lease = { statisticsOIExpiresAt: Date.now() + 60_000, statisticsTakerExpiresAt: Date.now() + 60_000 }
    await legacy(root, 'base-200-statistics.parquet', [
      { ...row(0), statisticsVersion: 1 },
      { ...row(1), ...lease, statisticsVersion: 7, buy: null, sell: null },
      { ...row(2), statisticsVersion: 7 },
      { ...row(3), statisticsVersion: 5 },
      { ...row(4), ...lease, statisticsVersion: 7, buy: 0, sell: 0 },
      { ...row(5), ...lease, statisticsVersion: 1, oi: null, buy: null, sell: null },
      { ...row(6), ...lease, statisticsVersion: 4, oi: null, buy: null, sell: null },
    ])
    const bounds = { ...query, through: base + 6 * step }
    const expected = [[1_000, 30, 20, 11], [1_000, null, null, 9], [1_000, 30, 20, 11],
      [1_000, null, null, 9], [1_000, null, null, 9], [null, null, null, 8], [null, null, null, 8]]
    for (let attempt = 0; attempt < 2; attempt++) {
      store = await MarketStore.open(root)
      const rows = await store.candles(bounds)
      assert.deepEqual(rows.map(value => [value.oi, value.buy, value.sell, value.statisticsVersion]), expected)
      assert.ok(rows.every(value => value.statisticsOIExpiresAt === null && value.statisticsTakerExpiresAt === null))
      assert.deepEqual(await store.statisticsMissingRanges({ ...bounds, source: 'oi' }), [{ from: base + 5 * step, through: base + 6 * step }])
      assert.deepEqual(await store.statisticsMissingRanges({ ...bounds, source: 'taker' }), [{ from: base + step, through: base + step }, { from: base + 3 * step, through: base + 6 * step }])
      await store.close()
    }
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('a valid source remains retryable after a SQLite import commit failure and recovers without a corruption marker', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-commit-failure-'))
  let store: MarketStore | undefined, database: DatabaseSync | undefined
  try {
    const path = await legacy(root, 'base-200-data.parquet', [row(0)])
    const original = await readFile(path)
    store = await MarketStore.open(root)
    database = new DatabaseSync(join(root, 'market.sqlite'))
    database.exec("CREATE TRIGGER fail_import BEFORE INSERT ON candles BEGIN SELECT RAISE(ABORT, 'Injected SQLite import commit failure'); END")
    await assert.rejects(store.candles(query), /Injected SQLite import commit failure/)
    const failed = await store.migrationStatus()
    assert.equal(failed.complete, false)
    assert.equal(failed.failedPartitions, 0)
    assert.deepEqual(failed.issues, [])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM candles').get()!.count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM migration_partitions').get()!.count, 0)
    database.exec('DROP TRIGGER fail_import')
    const importer = (store as any).migration
    const closed = once(importer, 'close')
    importer.ref(); importer.channel?.ref()
    const [value] = await store.candles(query)
    assert.deepEqual([value.close, value.oi, value.buy, value.sell, value.statisticsVersion], [100, 1_000, 30, 20, 11])
    importer.ref(); importer.channel?.ref()
    assert.deepEqual(await closed, [0, null])
    const recovered = await store.migrationStatus()
    assert.equal(recovered.complete, true)
    assert.equal(recovered.completedPartitions, 1)
    assert.equal(recovered.failedPartitions, 0)
    assert.deepEqual(recovered.issues, [])
    assert.deepEqual(await readFile(path), original)
  } finally { database?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('engine startup, scan, and I/O failures stay operational and resume the same valid archive', { timeout: 15_000 }, async () => {
  const operationsURL = new URL('../electron/services/worker-operations.js', import.meta.url).href
  const { createOperationProcess, createWorkerRequest } = await import(operationsURL)
  for (const mode of ['startup', 'scan', 'io']) {
    const root = await mkdtemp(join(tmpdir(), 'perp-import-engine-failure-')), store = await MarketStore.open(root)
    let importer: any, finished: Promise<any> | undefined
    try {
      // Open SQLite before adding the archive so this test owns the importer.
      const internal = store as any
      await internal.migrationReady
      internal.migrationComplete = false
      await legacy(root, 'base-200-data.parquet', [row(0)])
      const gate = join(root, 'engine-unavailable')
      await writeFile(gate, '')
      importer = createOperationProcess(fileURLToPath(new URL('../tests/helpers/market-migration-fault.mjs', import.meta.url)),
        [root, join(root, 'market.sqlite'), mode, gate], { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }, 'market-migration')
      finished = once(importer, 'close')
      let ready!: () => void, sequence = 0
      const initialized = new Promise<void>(resolve => { ready = resolve }), pending = new Map<number, any>()
      importer.on('message', (message: any) => {
        if (message.fixtureReady) ready()
        else if (message.sequence) {
          const writer = (store as any).writer
          const task = message.import ? writer.request('append', [message.import.rows, { importing: true, partition: message.import.partition }])
            : message.failure ? writer.request('migrationFailure', [message.failure]) : writer.request('migrationComplete')
          task.then(() => importer.send({ ack: message.sequence }), (error: Error) => importer.send({ ack: message.sequence, error: error.message }))
        } else if (message.id) { pending.get(message.id)?.resolve(message); pending.delete(message.id) }
      })
      const request = () => new Promise<any>((resolve, reject) => {
        const id = ++sequence, job = createWorkerRequest('market-migration', 'import', resolve, reject)
        pending.set(id, job)
        job.dispatch(importer, { id, query, priority: 'foreground', tolerateIssues: false })
      })
      await initialized
      assert.match((await request()).error, mode === 'startup' ? /engine startup failure/ : mode === 'io' ? /Permission denied/ : /scan engine failure/)
      const failed = await store.migrationStatus()
      assert.equal(failed.complete, false)
      assert.equal(failed.failedPartitions, 0)
      assert.deepEqual(failed.issues, [])
      await rm(gate)
      assert.equal((await request()).error, undefined)
      assert.deepEqual(await finished, [0, null])
      const recovered = await store.migrationStatus()
      assert.equal(recovered.complete, true)
      assert.equal(recovered.completedPartitions, 1)
      assert.deepEqual(recovered.issues, [])
      assert.equal((await store.candles(query))[0].oi, 1_000)
    } finally {
      if (importer?.connected) importer.send({ stop: true })
      await finished
      await store.close(); await rm(root, { recursive: true, force: true })
    }
  }
})

test('one-time native import runs in a separate process, exits normally and is skipped after cutover', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-process-'))
  let store: MarketStore | undefined
  try {
    await legacy(root, 'base-200-data.parquet', [row(0)])
    store = await MarketStore.open(root)
    await (store as any).migrationReady
    const importer = (store as any).migration
    assert.ok(Number.isSafeInteger(importer.pid) && importer.pid !== process.pid)
    const exited = once(importer, 'exit')
    const closed = once(importer, 'close')
    assert.equal((await store.candles(query))[0].close, 100)
    // Reads release the importer's refs once demand is served. This test also
    // awaits its process lifecycle, so retain it until exit and close arrive.
    importer.ref(); importer.channel?.ref()
    assert.deepEqual(await exited, [0, null])
    assert.deepEqual(await closed, [0, null])
    assert.equal(store.getDiagnostics().migrationProcessId, null)
    assert.equal((await store.migrationStatus()).complete, true)
    assert.equal((await store.candles(query))[0].close, 100)
    await store.close(); store = await MarketStore.open(root)
    await (store as any).migrationReady
    assert.equal(store.getDiagnostics().migrationProcessId, null)
    assert.equal((await store.candles(query))[0].close, 100)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('an importer crash rejects pending legacy reads without killing SQLite or losing new facts', { timeout: 15_000 }, async () => {
  if (process.env.PERPETUAL_SWAP_IMPORT_CRASH_FIXTURE !== '1') {
    const operations = await mkdtemp(join(tmpdir(), 'perp-expected-import-crash-'))
    const environment: NodeJS.ProcessEnv = { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: operations, PERPETUAL_SWAP_IMPORT_CRASH_FIXTURE: '1' }
    delete environment.PERPETUAL_SWAP_OPERATION_PARTICIPANT
    delete environment.NODE_TEST_CONTEXT
    try {
      const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../scripts/sandbox-register.mjs', import.meta.url)),
        '--experimental-strip-types', '--test', '--test-name-pattern=^an importer crash', fileURLToPath(import.meta.url)], { env: environment, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.ok(result.stdout.includes('an importer crash rejects pending legacy reads'), result.stdout)
      const moduleURL = new URL('../scripts/operation-report.mjs', import.meta.url).href
      const { summarizeOperations } = await import(moduleURL)
      const report = await summarizeOperations(operations)
      assert.ok(report.diagnostics.unclaimedParticipants + report.diagnostics.unclosedExecutions + report.diagnostics.unclosedOperations > 0,
        'SIGKILL must leave explicit evidence of an unclaimed or interrupted recorder.')
    } finally { await rm(operations, { recursive: true, force: true }) }
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'perp-import-crash-'))
  let store: MarketStore | undefined
  try {
    await legacy(root, 'base-200-data.parquet', [row(0)])
    store = await MarketStore.open(root)
    await (store as any).migrationReady
    const importer = (store as any).migration
    assert.equal(importer.exitCode, null)
    const exited = once(importer, 'exit')
    const read = store.candles(query)
    // The crash may reject through IPC or process exit, with OS-specific errors.
    const rejected = assert.rejects(read, Error)
    assert.equal(importer.kill('SIGKILL'), true)
    await rejected
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    await store.appendCandles([{ ...row(0, 250), oi: undefined, buy: undefined, sell: undefined, statisticsVersion: undefined }])
    assert.equal((await store.coverage(query.instrument, query.timeframe)).count, 1)
    assert.equal((await store.migrationStatus()).complete, false)
    await store.close(); store = await MarketStore.open(root)
    assert.equal((await store.candles(query))[0].close, 250)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})

test('shutdown cancels pending archive reads and drains accepted SQLite import transactions before child exit', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-drain-'))
  let store: MarketStore | undefined, release!: () => void
  try {
    await legacy(root, 'base-200-data.parquet', [row(0)])
    store = await MarketStore.open(root)
    const internal = store as any, request = internal.writer.request.bind(internal.writer)
    let admitted!: () => void
    const accepted = new Promise<void>(resolve => { admitted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    internal.writer.request = (command: string, args: any[], priority: string) => {
      if (command !== 'append' || !args[1]?.importing) return request(command, args, priority)
      admitted()
      return gate.then(() => request(command, args, priority))
    }
    const pendingRead = assert.rejects(store.candles(query), /closed/i)
    await accepted
    let finished = false
    const closing = store.close().then(() => { finished = true })
    await pendingRead
    assert.equal(finished, false)
    release()
    await closing
    store = await MarketStore.open(root)
    assert.equal((await store.candles(query))[0].close, 100)
    assert.deepEqual(await store.integrityCheck(), ['ok'])
  } finally { release?.(); await store?.close(); await rm(root, { recursive: true, force: true }) }
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

test('an admitted read that resumes after shutdown begins rejects without holding close open', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-read-close-'))
  let store: MarketStore | undefined
  let resume!: () => void, releaseCommit!: () => void
  const delayedReady = new Promise<void>(resolve => { resume = resolve })
  const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
  try {
    await legacy(root, 'base-200-data.parquet', [row(0)])
    store = await MarketStore.open(root)
    const internal = store as any
    const request = internal.writer.request.bind(internal.writer)
    let admitted!: () => void
    const accepted = new Promise<void>(resolve => { admitted = resolve })
    internal.writer.request = async (command: string, args: any[] = [], priority?: string) => {
      if (command === 'append' && args[1]?.importing) { admitted(); await commitGate }
      return request(command, args, priority)
    }
    await internal.migrationReady
    const importer = internal.migration
    importer.ref(); importer.channel?.ref()
    await accepted
    const ready = internal.migrationReady
    // Admit the read, then delay its readiness continuation until shutdown has
    // already cleared pending imports. Shutdown itself uses completed startup.
    internal.migrationReady = delayedReady
    const pendingRead = assert.rejects(store.candles(query), /closed/i)
    await new Promise<void>(resolve => setImmediate(resolve))
    internal.migrationReady = ready
    const closing = store.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(internal.closed, true)
    assert.equal(internal.migrationPending.size, 0)
    resume()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(internal.migrationPending.size, 0, 'A resumed read must not enqueue work after the importer was stopped.')
    await pendingRead
    releaseCommit()
    await closing
    assert.equal(internal.operations.size, 0)
  } finally {
    // Also let shutdown finish when the regression assertion detects an
    // incorrectly admitted post-stop request.
    const internal = store as any
    for (const pending of internal?.migrationPending.values() ?? []) pending.reject(new Error('MarketStore is closed.'))
    internal?.migrationPending.clear()
    resume(); releaseCommit()
    await store?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('close drains the active import commit without cutting over the remaining archive', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-import-close-'))
  let store: MarketStore | undefined
  let release!: () => void
  const commitGate = new Promise<void>(resolve => { release = resolve })
  try {
    await legacy(root, 'base-200-first.parquet', [row(0)])
    const second = await legacy(root, 'base-200-second.parquet', [row(288)])
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2024-01-02')
    await mkdir(directory)
    await rename(second, join(directory, 'base-200-second.parquet'))
    store = await MarketStore.open(root)
    const internal = store as any
    // Hold the first imported transaction before acknowledging it to the child,
    // so shutdown deterministically overlaps an accepted partition commit.
    let admitted!: () => void
    const admission = new Promise<void>(resolve => { admitted = resolve })
    const request = internal.writer.request.bind(internal.writer)
    internal.writer.request = async (command: string, args: any[] = [], priority?: string) => {
      if (command === 'append' && args[1]?.importing) { admitted(); await commitGate }
      return request(command, args, priority)
    }
    await internal.migrationReady
    const importer = internal.migration
    assert.ok(Number.isSafeInteger(importer.pid) && importer.pid !== process.pid)
    importer.ref(); importer.channel?.ref()
    await admission
    const closed = once(importer, 'close')
    const pendingRead = assert.rejects(store.candles(query), /closed/i)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(internal.migrationPending.size, 1)
    const closing = store.close()
    assert.equal(store.close(), closing, 'Repeated close joins the same shutdown.')
    await pendingRead
    release()
    await closing
    assert.deepEqual(await closed, [0, null], 'The importer must close native resources and exit naturally.')

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, 'market.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_partitions WHERE status='completed'").get()!.count, 1)
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_partitions WHERE path='__complete__'").get()!.count, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candles').get()!.count, 1)
    } finally { db.close() }
    store = await MarketStore.open(root)
    assert.equal((await store.candles({ ...query, through: base + 288 * step })).length, 2, 'Unfinished partitions remain resumable after shutdown.')
  } finally { release(); await store?.close(); await rm(root, { recursive: true, force: true }) }
})
