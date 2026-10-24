import { closeOperationRecording } from './operation-runtime.js'
import { openRecordedDatabase } from './recorded-database.js'
import { getOperationContext, measureOperation, recordOperation, runWithOperationContext } from './operations.js'
import { createWorkerRequest, onOperationMessage } from './worker-operations.js'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { CANDLE_INTERVALS, validateCandle } from './market-records.js'
import { statisticsVersionFor, validTakerVolumes } from './statistics-state.js'

const DAY = 86_400_000, quote = value => `'${String(value).replaceAll("'", "''")}'`
const [root, databasePath] = process.argv.slice(2)
if (!root || !databasePath || !process.send) throw new Error('Market archive import requires its database path and parent IPC channel.')
const manifest = openRecordedDatabase(DatabaseSync, databasePath, { readOnly: true }, 'migration-manifest')
manifest.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;')
const saved = manifest.prepare('SELECT fingerprint,status FROM migration_partitions WHERE path=?')
const countRange = manifest.prepare('SELECT COUNT(*) AS count FROM candles WHERE series_id=(SELECT id FROM series WHERE instrument=? AND timeframe=?) AND timestamp>=? AND timestamp<=?')
const fields = { instrument: 'VARCHAR', timeframe: 'VARCHAR', timestamp: 'BIGINT', open: 'DOUBLE', high: 'DOUBLE', low: 'DOUBLE', close: 'DOUBLE', volume: 'DOUBLE', baseVolume: 'DOUBLE', quoteVolume: 'DOUBLE', confirmed: 'BOOLEAN', oi: 'DOUBLE', buy: 'DOUBLE', sell: 'DOUBLE', statisticsVersion: 'INTEGER', statisticsOIExpiresAt: 'BIGINT', statisticsTakerExpiresAt: 'BIGINT', writtenAt: 'BIGINT' }
const partVersion = file => { const match = /^(base|delta)-(\d+)-[A-Za-z0-9-]+\.parquet$/.exec(basename(file)); return match ? { kind: match[1], generation: Number(match[2]) } : null }
const activeParts = files => { const base = Math.max(0, ...files.map(file => { const version = partVersion(file); return version?.kind === 'base' ? version.generation : 0 })); return files.filter(file => { const version = partVersion(file); return !version ? base === 0 : version.kind === 'base' ? version.generation === base : version.generation > base }) }
const directories = async path => { try { return (await readdir(path, { withFileTypes: true })).filter(value => value.isDirectory()).map(value => value.name).sort() } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
let engine, connection, sequence = 0, draining = false, complete = false, stopping = false, released = false
const queue = [], acknowledgments = new Map(), pendingImports = new Map()
const readyConnection = async () => {
  if (!connection) {
    const { DuckDBInstance } = await import('@duckdb/node-api')
    engine = await measureOperation({ category: 'database', name: 'duckdb.open' }, () => DuckDBInstance.create(':memory:'))
    try {
      connection = await measureOperation({ category: 'database', name: 'duckdb.connect' }, () => engine.connect())
      await measureOperation({ category: 'database', name: 'duckdb.configure' }, () => connection.run('SET errors_as_json=true'))
    } catch (error) { connection?.closeSync(); engine.closeSync(); connection = null; engine = null; throw error }
  }
  return connection
}
const post = message => { if (process.connected) process.send(message, () => {}) }
const send = payload => new Promise((resolve, reject) => {
  if (!process.connected) { reject(new Error('Market archive parent disconnected.')); return }
  const id = ++sequence
  const request = createWorkerRequest('market-migration-parent', 'commit', resolve, reject)
  acknowledgments.set(id, request)
  request.dispatch(process, { ...payload, sequence: id }, error => {
    if (error) { acknowledgments.delete(id); request.reject(error) }
  })
})

class SourceIssue extends Error {
  constructor(reason, message) { super(message); this.reason = reason }
}

// DuckDB also reports engine/resource/I/O failures through Error. Only explicit
// content-decoding errors establish that the retained source is corrupt.
const readSource = async (db, name, sql) => {
  try { return (await measureOperation({ category: 'database', name }, () => db.runAndReadAll(sql))).getRowObjectsJS() }
  catch (error) {
    let detail
    try { detail = JSON.parse(error.message) } catch { throw error }
    if (detail.exception_type === 'Conversion') throw new SourceIssue('invalid-schema', detail.exception_message)
    if (['Invalid Input', 'IO', 'Serialization'].includes(detail.exception_type)
      && /^(?:no magic bytes found|file ['"].*['"] too small to be a parquet file|(?:expected )?parquet magic bytes|failed to (?:parse|deserialize) (?:the )?(?:parquet|thrift|footer)|(?:invalid|corrupt|malformed) (?:parquet|thrift|file footer))/i.test(detail.exception_message)) {
      throw new SourceIssue('corrupt-file', detail.exception_message)
    }
    throw error
  }
}

const importStatistics = row => {
  const version = row.statisticsVersion ?? 0
  if ((version & ~3) === 8) return row
  // Old 1 meant both sources; old 4 could lease ranges without observing them.
  // Preserve their numeric downloads, but never import speculative null leases.
  const prior = version === 1 ? 3 : (version & ~3) === 4 ? version & 3 : 0
  const sources = (prior & 1 && typeof row.oi === 'number' && Number.isFinite(row.oi) && row.oi >= 0 ? 1 : 0)
    | (prior & 2 && validTakerVolumes(row) ? 2 : 0)
  return { ...row, statisticsVersion: statisticsVersionFor(sources), statisticsOIExpiresAt: null, statisticsTakerExpiresAt: null }
}

const commitPartition = async (payload, priority) => {
  // Reuse validated rows if only the SQLite/IPC commit failed. The caller
  // checks the source fingerprint before reusing this process-local stage.
  pendingImports.set(payload.partition.path, payload)
  await send({ import: payload, priority })
  pendingImports.delete(payload.partition.path)
  // A foreground request can recover a failed background commit immediately.
  // Its successful acknowledgment makes the scheduled retry obsolete.
  for (let index = retryPartitions.length - 1; index >= 0; index--) if (retryPartitions[index].path === payload.partition.path) retryPartitions.splice(index, 1)
  if (!retryPartitions.length) { retryAt = 0; clearTimeout(retryTimer); retryTimer = null }
}

async function importPartition(path, instrument, timeframe, priority, tolerateIssues) {
  const previous = saved.get(path)
  // A committed partition has already crossed its authority boundary. A
  // retained original changing later cannot revise validated SQLite facts.
  if (previous?.status === 'completed') return
  const entries = await readdir(path, { withFileTypes: true })
  const files = activeParts(entries.filter(value => value.isFile() && value.name.endsWith('.parquet')).map(value => join(path, value.name)).sort())
  const hash = createHash('sha256')
  for (const file of files) { const value = await stat(file); hash.update(file).update(String(value.size)).update(String(value.mtimeMs)) }
  const fingerprint = hash.digest('hex')
  if (previous?.fingerprint === fingerprint) {
    if (previous.status === 'failed' && !tolerateIssues) throw new Error(`A legacy market partition requires a data audit: ${path}`)
    return
  }
  const from = Date.parse(`${path.slice(-10)}T00:00:00Z`), through = from + DAY - CANDLE_INTERVALS[timeframe]
  const pending = pendingImports.get(path)
  if (pending?.partition.fingerprint === fingerprint) {
    if (!stopping) await commitPartition(pending, priority)
    return
  }
  pendingImports.delete(path)
  // Engine startup and the parent transaction are operational boundaries, not
  // source validation. Neither may persist a corrupt-file marker on failure.
  const db = files.length ? await readyConnection() : null
  let rows = []
  try {
    if (files.length) {
      const relation = `read_parquet([${files.map(quote).join(',')}],union_by_name=true,hive_partitioning=false)`
      const columns = await readSource(db, 'duckdb.describe', `DESCRIBE SELECT * FROM ${relation}`), types = new Map(columns.map(column => [column.column_name, column.column_type]))
      for (const field of ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed']) if (!types.has(field)) throw new SourceIssue('invalid-schema', `Legacy market schema is missing ${field}.`)
      if (!/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT))$/.test(types.get('timestamp')) || types.get('confirmed') !== 'BOOLEAN') throw new SourceIssue('invalid-schema', 'Invalid legacy timestamp or confirmation schema.')
      for (const field of ['open', 'high', 'low', 'close', 'volume']) if (!/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL\(\d+,\d+\))$/.test(types.get(field))) throw new SourceIssue('invalid-schema', `Invalid legacy ${field} schema.`)
      const projection = Object.entries(fields).map(([field, type]) => `${types.has(field) ? `CAST("${field}" AS ${type})` : `NULL::${type}`} AS "${field}"`).join(',')
      const projected = `(SELECT ${projection} FROM ${relation})`
      const duplicate = (await readSource(db, 'duckdb.duplicates', `SELECT timestamp FROM ${projected} GROUP BY timestamp,COALESCE(writtenAt,0) HAVING COUNT(*)>1 LIMIT 1`))[0]
      if (duplicate) throw new SourceIssue('duplicate', 'Ambiguous equal-revision legacy candle observations.')
      rows = (await readSource(db, 'duckdb.read', `SELECT * FROM ${projected} QUALIFY ROW_NUMBER() OVER(PARTITION BY timestamp ORDER BY COALESCE(writtenAt,0) DESC)=1 ORDER BY timestamp`))
        .map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field, typeof value === 'bigint' ? Number(value) : value])))
      for (const row of rows) {
        try { validateCandle(row) }
        catch (error) { if (error instanceof TypeError) throw new SourceIssue('invalid-schema', error.message); throw error }
        if (row.instrument !== instrument || row.timeframe !== timeframe || row.timestamp < from || row.timestamp > through) throw new SourceIssue('invalid-schema', 'A legacy market candle does not match its partition.')
      }
      rows = rows.map(importStatistics)
    }
  } catch (error) {
    if (stopping) return
    if (!(error instanceof SourceIssue)) throw error
    await send({ failure: { path, fingerprint, instrument, timeframe, from, through, reason: error.reason, detail: error.message } })
    if (!tolerateIssues) throw error
    return
  }
  if (!stopping) await commitPartition({ rows, partition: { path, fingerprint } }, priority)
}

async function importQuery(job) {
  const { query, priority, tolerateIssues } = job
  if (!job.dates) {
    job.path = join(root, 'candles', `timeframe=${query.timeframe}`, `instrument=${query.instrument}`)
    const first = query.from > 0 ? new Date(query.from).toISOString().slice(0, 10) : null
    const last = query.through < 8_640_000_000_000_000 ? new Date(query.through).toISOString().slice(0, 10) : null
    job.dates = (await directories(job.path)).filter(date => /^date=\d{4}-\d{2}-\d{2}$/.test(date) && (!first || date.slice(5) >= first) && (!last || date.slice(5) <= last))
    if (query.order === 'desc') job.dates.reverse()
    job.index = 0; job.count = 0
  }
  if (job.index < job.dates.length) {
    const date = job.dates[job.index++], from = Date.parse(`${date.slice(5)}T00:00:00Z`)
    await importPartition(join(job.path, date), query.instrument, query.timeframe, priority, tolerateIssues)
    if (query.limit) job.count += countRange.get(query.instrument, query.timeframe, Math.max(query.from, from), Math.min(query.through, from + DAY - 1)).count
  }
  return job.index >= job.dates.length || query.limit && job.count >= query.limit
}

async function* partitions() {
  const candlesRoot = join(root, 'candles')
  for (const timeframe of Object.keys(CANDLE_INTERVALS)) {
    const frame = join(candlesRoot, `timeframe=${timeframe}`)
    for (const instrumentDirectory of await directories(frame)) {
      if (!instrumentDirectory.startsWith('instrument=')) continue
      const instrument = instrumentDirectory.slice(11), path = join(frame, instrumentDirectory)
      for (const date of await directories(path)) if (/^date=\d{4}-\d{2}-\d{2}$/.test(date)) yield { path: join(path, date), instrument, timeframe }
    }
  }
}
let background = partitions(), retryTimer = null, retryAt = 0
const retryPartitions = []
const retryLater = () => {
  if (retryTimer) return
  retryAt = Date.now() + 5000
  retryTimer = setTimeout(() => { retryTimer = null; void drain() }, 5000)
}
async function drain() {
  if (draining) return
  draining = true
  try {
    while (!stopping) {
      const index = queue.findIndex(job => job.priority === 'foreground'), job = queue.splice(index < 0 ? 0 : index, 1)[0]
      if (job) {
        await runWithOperationContext(job.operationContext, async () => {
          const startedAt = performance.timeOrigin + performance.now()
          recordOperation({ category: 'ipc', name: 'worker.queue', resource: 'market-migration', startedAt: job.queuedAt,
            durationMS: Math.max(0, startedAt - job.queuedAt), status: 'ok', attributes: { priority: job.priority } })
          try {
            if (complete || await importQuery(job)) job.resolve({ id: job.id })
            else { job.queuedAt = performance.timeOrigin + performance.now(); queue.push(job) }
          } catch (error) { job.resolve({ id: job.id, error: error.message }) }
        })
      } else {
        if (retryPartitions.length && retryAt > Date.now()) { retryLater(); break }
        if (retryPartitions.length) {
          const retry = retryPartitions.shift()
          try { await importPartition(retry.path, retry.instrument, retry.timeframe, 'background', true) }
          catch { retryPartitions.push(retry); retryLater(); break }
          continue
        }
        let next
        try { next = await background.next() }
        catch (error) {
          // An operational directory failure is not proof of an empty archive.
          // Restart discovery later, retaining every committed partition marker.
          post({ warning: error.message })
          background = partitions(); retryLater(); break
        }
        if (stopping) break
        if (next.done) {
          if (!complete) {
            await send({ complete: true }); complete = true
          }
          break
        }
        try { await importPartition(next.value.path, next.value.instrument, next.value.timeframe, 'background', true) }
        catch (error) {
          // Source corruption is persisted by importPartition. An error escaping
          // it is operational; it must prevent the global cutover until retried.
          post({ warning: error.message })
          retryPartitions.push(next.value); retryLater()
        }
      }
    }
  } finally {
    draining = false
    if (!stopping && queue.length) void drain()
    else if ((stopping || complete) && acknowledgments.size === 0 && !released) {
      released = true
      clearTimeout(retryTimer)
      connection?.closeSync(); engine?.closeSync(); manifest.close()
      connection = null; engine = null
      // Let async message handlers publish their final execution records first.
      await new Promise(resolve => setImmediate(resolve))
      await closeOperationRecording()
      if (process.connected) process.disconnect()
    }
  }
}
onOperationMessage(process, 'market-migration', message => {
  if (message.ack) {
    const value = acknowledgments.get(message.ack)
    if (value) { acknowledgments.delete(message.ack); message.error ? value.reject(new Error(message.error)) : value.resolve() }
  } else if (message.stop) {
    stopping = true
    for (const job of queue.splice(0)) job.resolve({ id: job.id, error: 'Market archive import stopped.' })
    clearTimeout(retryTimer); setImmediate(() => { void drain() })
  } else if (!stopping && !released) return new Promise(resolve => {
    queue.push({ ...message, resolve, operationContext: getOperationContext(), queuedAt: performance.timeOrigin + performance.now() })
    void drain()
  })
})
process.on('disconnect', () => {
  stopping = true
  for (const job of queue.splice(0)) job.resolve(undefined)
  clearTimeout(retryTimer)
  for (const pending of acknowledgments.values()) pending.reject(new Error('Market archive parent disconnected.'))
  acknowledgments.clear()
  if (!released) void drain()
})
void drain()
