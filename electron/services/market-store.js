import { DuckDBInstance } from '@duckdb/node-api'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const quote = value => `'${String(value).replaceAll("'", "''")}'`
const safeSegment = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._=-]*$/.test(value)) throw new TypeError('Invalid Parquet partition key.')
  return value
}
export const CANDLE_INTERVALS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })
const dayMS = 86_400_000
const maxPartitionParts = 8
const maxSchemaEntries = 512
const maxFilesystemReads = 8
const schema = Object.freeze({
  instrument: 'VARCHAR', timeframe: 'VARCHAR', timestamp: 'BIGINT',
  open: 'DOUBLE', high: 'DOUBLE', low: 'DOUBLE', close: 'DOUBLE',
  volume: 'DOUBLE', baseVolume: 'DOUBLE', quoteVolume: 'DOUBLE',
  confirmed: 'BOOLEAN', oi: 'DOUBLE', buy: 'DOUBLE', sell: 'DOUBLE',
  statisticsVersion: 'INTEGER', statisticsOIExpiresAt: 'BIGINT', statisticsTakerExpiresAt: 'BIGINT', writtenAt: 'BIGINT',
})
const optionalNonnegative = ['baseVolume', 'quoteVolume', 'oi', 'buy', 'sell']
const optionalInteger = ['statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt', 'writtenAt']
const number = value => typeof value === 'bigint' ? Number(value) : value
const normalizeCandleRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, number(value)]))
const validateQuery = ({ instrument, timeframe, from = 0, through = Date.now() }) => {
  safeSegment(instrument)
  if (!Object.hasOwn(CANDLE_INTERVALS, timeframe)) throw new TypeError('Unsupported candle timeframe.')
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(through) || through < from) throw new TypeError('Invalid candle range.')
  return { instrument, timeframe, from, through }
}
/** Validate source observations without inventing missing units or confirmation. */
export function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') throw new TypeError('Invalid candle record.')
  safeSegment(candle.instrument)
  const interval = CANDLE_INTERVALS[candle.timeframe]
  if (!interval) throw new TypeError('Unsupported candle timeframe.')
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp < 0 || candle.timestamp % interval !== 0) throw new TypeError('Candle timestamp must lie on its timeframe grid.')
  if (candle.confirmed !== true) throw new TypeError('Only confirmed candles may be persisted.')
  if (['open', 'high', 'low', 'close'].some(field => typeof candle[field] !== 'number' || !Number.isFinite(candle[field]) || candle[field] <= 0)
    || candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) throw new TypeError('Invalid candle OHLC values.')
  if (typeof candle.volume !== 'number' || !Number.isFinite(candle.volume) || candle.volume < 0
    || optionalNonnegative.some(field => candle[field] != null && (typeof candle[field] !== 'number' || !Number.isFinite(candle[field]) || candle[field] < 0))) throw new TypeError('Candle quantities must be finite and nonnegative.')
  if (optionalInteger.some(field => candle[field] != null && (!Number.isSafeInteger(candle[field]) || candle[field] < 0))
    || candle.statisticsVersion > 2_147_483_647) throw new TypeError('Invalid candle statistics metadata.')
  return candle
}
const storedCandle = (candle, writtenAt) => Object.fromEntries(Object.keys(schema).map(field => [field, field === 'writtenAt' ? writtenAt : candle[field] ?? null]))
const sqlSchema = Object.entries(schema).map(([field, type]) => `${quote(field)}: ${quote(type)}`).join(', ')
const canonicalProjection = Object.entries(schema).map(([field, type]) => `CAST("${field}" AS ${type}) AS "${field}"`).join(', ')
const isMissing = error => error?.code === 'ENOENT'
const partVersion = file => {
  const match = /^(base|delta)-(\d+)-[A-Za-z0-9-]+\.parquet$/.exec(basename(file))
  const generation = Number(match?.[2])
  return match && Number.isSafeInteger(generation) && generation > 0 ? { kind: match[1], generation } : null
}
// The newest base is an atomic visibility boundary. Files from its generation
// or earlier are already included (or intentionally deleted by a repair), so
// interrupted cleanup can never resurrect a row or introduce duplicates.
// A base owns the complete day. Unversioned input is included until the first
// base; afterward only newer managed deltas belong to the dataset. Other
// files are obsolete/orphan artifacts rather than additional observations.
const activePartitionParts = files => {
  const base = Math.max(0, ...files.map(file => { const version = partVersion(file); return version?.kind === 'base' ? version.generation : 0 }))
  return files.filter(file => {
    const version = partVersion(file)
    if (!version) return base === 0
    return version.kind === 'base' ? version.generation === base : version.generation > base
  })
}
function validatePhysicalSchema(columns) {
  const types = new Map(columns.map(column => [column.column_name, column.column_type]))
  for (const field of ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'confirmed']) {
    if (!types.has(field)) throw new TypeError(`Persisted candle schema is missing ${field}. Run a data audit.`)
  }
  // SQL rounds fractional values when casting to BIGINT, and numeric 2
  // becomes BOOLEAN true. Physical schemas must not permit those coercions.
  if (!/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT))$/.test(types.get('timestamp'))
    || types.get('confirmed') !== 'BOOLEAN') throw new TypeError('Invalid persisted candle timestamp or confirmation schema. Run a data audit.')
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    if (!/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL\(\d+,\d+\))$/.test(types.get(field))) throw new TypeError(`Invalid persisted candle ${field} schema. Run a data audit.`)
  }
}
const missingRanges = (stamps, from, through, interval) => {
  const present = new Set(stamps), ranges = []
  let start = null
  for (let stamp = from; stamp <= through; stamp += interval) {
    if (!present.has(stamp)) { start ??= stamp; continue }
    if (start !== null) { ranges.push({ from: start, through: stamp - interval }); start = null }
  }
  if (start !== null) ranges.push({ from: start, through })
  return ranges
}

/**
 * DuckDB is the query engine only. Durable market observations are partitioned
 * Parquet files, so they can be inspected, copied, and queried without a
 * proprietary database file.
 */
export class MarketStore {
  static async open(root) {
    await mkdir(root, { recursive: true })
    const instance = await DuckDBInstance.create(':memory:')
    try { return new MarketStore(root, await instance.connect(), instance) }
    catch (error) { instance.closeSync(); throw error }
  }

  constructor(root, connection, instance) {
    this.root = root
    this.connection = connection
    this.instance = instance
    this.queue = []
    this.draining = false
    this.lastWrittenAt = 0
    this.closed = false
    this.closeTask = null
    this.coverages = new Map()
    this.revisions = new Map()
    this.mutations = new Map()
    this.watermarks = new Map()
    this.chartSnapshotWrites = new Map()
    this.parquetSchemas = new Map()
    this.writeMetrics = { partitions: 0, rowsSubmitted: 0, bytesRead: 0, bytesWritten: 0, durationMS: 0 }
  }

  // DuckDB connections are not a concurrent query coordinator. Keep every
  // query and write on this connection in one ordered lane, and close only
  // after that lane has drained. Foreground work (the focused chart) cuts in
  // front of all queued background work. An active write completes before
  // the next job starts; background work keeps arrival order among itself.
  enqueue(operation, priority = 'background') {
    if (this.closed) return Promise.reject(new Error('MarketStore is closed.'))
    return new Promise((resolve, reject) => {
      const job = { operation, priority, resolve, reject }
      if (priority === 'foreground') {
        const firstBackground = this.queue.findIndex(queued => queued.priority !== 'foreground')
        if (firstBackground < 0) this.queue.push(job)
        else this.queue.splice(firstBackground, 0, job)
      } else this.queue.push(job)
      void this.drain()
    })
  }

  async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()
        try { job.resolve(await job.operation()) } catch (error) { job.reject(error) }
      }
    } finally { this.draining = false }
  }

  partition(instrument, timeframe, timestamp) {
    const date = new Date(timestamp).toISOString().slice(0, 10)
    return join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`, `date=${date}`)
  }

  async partitionFiles(directory) {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.parquet')).map(entry => join(directory, entry.name)).sort()
    } catch (error) { if (isMissing(error)) return []; throw error }
  }

  async parquetFiles(instrument, timeframe, from, through) {
    const directory = join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`)
    let dates
    try { dates = await readdir(directory, { withFileTypes: true }) } catch (error) { if (isMissing(error)) return []; throw error }
    const firstDate = Number.isFinite(from) ? new Date(from).toISOString().slice(0, 10) : null
    const lastDate = Number.isFinite(through) ? new Date(through).toISOString().slice(0, 10) : null
    const partitions = dates.filter(entry => entry.isDirectory() && /^date=\d{4}-\d{2}-\d{2}$/.test(entry.name)
      && (!firstDate || entry.name.slice(5) >= firstDate) && (!lastDate || entry.name.slice(5) <= lastDate))
      .sort((a, b) => a.name.localeCompare(b.name))
    const files = new Array(partitions.length)
    let next = 0
    // Directory reads are independent; SQL and partition publication remain
    // on the single DuckDB lane. Retain chronological order regardless of
    // which filesystem read finishes first.
    await Promise.all(Array.from({ length: Math.min(maxFilesystemReads, partitions.length) }, async () => {
      for (let index = next++; index < partitions.length; index = next++) {
        // An empty partition left by an interrupted first write is absence,
        // whereas permissions and device errors must reach the caller.
        files[index] = activePartitionParts(await this.partitionFiles(join(directory, partitions[index].name)))
      }
    }))
    return files.flat()
  }

  schemaKey(files) {
    const hash = createHash('sha256')
    for (const file of [...files].sort()) hash.update(file).update('\0')
    return hash.digest('hex')
  }

  rememberParquetSchema(files, projection) {
    const key = this.schemaKey(files)
    this.parquetSchemas.delete(key)
    this.parquetSchemas.set(key, projection)
    if (this.parquetSchemas.size > maxSchemaEntries) this.parquetSchemas.delete(this.parquetSchemas.keys().next().value)
  }

  async parquetRelation(files) {
    const relation = `read_parquet([${files.map(quote).join(', ')}], union_by_name = true, hive_partitioning = false)`, key = this.schemaKey(files)
    // App-published names are immutable. Imported/unmanaged files can change
    // in place, so their physical types must be inspected on every read.
    const immutable = files.every(file => partVersion(file) || /^part-\d+-\d+-[a-f0-9]+\.parquet$/.test(basename(file)))
    let projection = immutable ? this.parquetSchemas.get(key) : undefined
    if (projection) {
      this.parquetSchemas.delete(key)
      this.parquetSchemas.set(key, projection)
    } else {
      const columns = (await this.connection.runAndReadAll(`DESCRIBE SELECT * FROM ${relation}`)).getRowObjectsJS()
      const existing = new Set(columns.map(column => column.column_name))
      validatePhysicalSchema(columns)
      projection = Object.entries(schema).map(([field, type]) => `${existing.has(field) ? `CAST("${field}" AS ${type})` : `NULL::${type}`} AS "${field}"`).join(', ')
      if (immutable) this.rememberParquetSchema(files, projection)
    }
    // Explicit casts happen at the storage boundary. Old files may omit base
    // volume; that is a typed NULL, never quote volume divided by a price.
    return `(SELECT ${projection} FROM ${relation})`
  }

  async publishPartition(directory, rows, { replaceFrom, replaceThrough, timeframe = rows[0]?.timeframe } = {}) {
    await mkdir(directory, { recursive: true })
    const allParts = await this.partitionFiles(directory), parts = activePartitionParts(allParts)
    const startedAt = performance.now(), interval = CANDLE_INTERVALS[timeframe], repairing = replaceFrom != null
    const compact = repairing || parts.length + 1 >= maxPartitionParts
    const dayStart = Date.parse(`${directory.slice(-10)}T00:00:00Z`)
    // A corrupt file can only be discarded when its entire UTC day is
    // explicitly replaced. Partial repairs always preserve other rows.
    const fullDay = repairing && replaceFrom <= dayStart && replaceThrough >= dayStart + dayMS - interval
    let generation = Math.max(Date.now(), this.lastWrittenAt + 1, ...allParts.map(file => (partVersion(file)?.generation ?? 0) + 1))
    let previousRelation = null
    let previousBytes = 0
    if (parts.length && !fullDay && (compact || !parts.some(file => partVersion(file)))) {
      previousRelation = await this.parquetRelation(parts)
      for (const file of parts) previousBytes += (await stat(file)).size
      // Existing unversioned Parquet is migrated on its first write. Reserve
      // a revision after its durable watermark even after a clock rollback.
      if (!parts.some(file => partVersion(file))) {
        const watermarks = (await this.connection.runAndReadAll(`SELECT MAX(COALESCE(writtenAt, 0)) AS watermark FROM ${previousRelation}`)).getRowObjectsJS()
        generation = Math.max(generation, Number(watermarks[0]?.watermark ?? 0) + 1)
      }
    }
    this.lastWrittenAt = generation
    for (const row of rows) row.writtenAt = generation
    const nonce = `${process.pid}-${Math.random().toString(16).slice(2)}`
    const source = join(directory, `.${generation}-${nonce}.json`), target = join(directory, `${compact ? 'base' : 'delta'}-${generation}-${nonce}.parquet`), temporary = `${target}.tmp`
    await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
    try {
      const incoming = `SELECT * FROM read_json(${quote(source)}, columns = {${sqlSchema}}, format = 'array')`
      let previous = ''
      if (compact && parts.length && !fullDay) previous = `SELECT * FROM ${previousRelation}${!repairing ? '' : ` WHERE timestamp < ${replaceFrom} OR timestamp >= ${replaceThrough + interval}`} UNION ALL BY NAME `
      await this.connection.run(`COPY (SELECT * FROM (${previous}${incoming})
        QUALIFY ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) = 1
        ORDER BY timestamp) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
      await rename(temporary, target)
      this.rememberParquetSchema([target], canonicalProjection)
      // Publishing the base already removed old files from the logical
      // dataset. Cleanup is space reclamation, never a visibility operation.
      if (compact) await Promise.all(allParts.map(part => rm(part, { force: true })))
      const bytesWritten = (await stat(target)).size
      this.writeMetrics = { partitions: this.writeMetrics.partitions + 1, rowsSubmitted: this.writeMetrics.rowsSubmitted + rows.length,
        bytesRead: this.writeMetrics.bytesRead + previousBytes, bytesWritten: this.writeMetrics.bytesWritten + bytesWritten,
        durationMS: this.writeMetrics.durationMS + performance.now() - startedAt }
    } finally { await rm(source, { force: true }); await rm(temporary, { force: true }) }
  }

  invalidate(instrument, timeframe, range = null) {
    const key = `${instrument}:${timeframe}`
    const revision = this.candleRevision(instrument, timeframe) + 1
    this.revisions.set(key, revision)
    const mutations = this.mutations.get(key) ?? []
    mutations.push({ revision, range })
    if (mutations.length > 256) mutations.shift()
    this.mutations.set(key, mutations)
    this.coverages.delete(key)
    this.watermarks.delete(key)
  }

  getWriteMetrics() { return { ...this.writeMetrics } }

  // Process-local invalidation token. Recovery always verifies Parquet anew.
  candleRevision(instrument, timeframe) { return this.revisions.get(`${instrument}:${timeframe}`) ?? 0 }

  candleChangesSince(instrument, timeframe, previousRevision) {
    const revision = this.candleRevision(instrument, timeframe)
    if (previousRevision === revision) return { revision, ranges: [] }
    const changes = this.mutations.get(`${instrument}:${timeframe}`) ?? []
    if (!Number.isSafeInteger(previousRevision) || previousRevision < 0 || previousRevision > revision
      || !changes.length || previousRevision < changes[0].revision - 1) return { revision, ranges: null }
    const ranges = changes.filter(change => change.revision > previousRevision).map(change => change.range)
    if (ranges.some(range => range === null)) return { revision, ranges: null }
    const merged = []
    for (const range of ranges.sort((a, b) => a.from - b.from)) {
      const last = merged.at(-1)
      if (last && range.from <= last.through) last.through = Math.max(last.through, range.through)
      else merged.push({ ...range })
    }
    return { revision, ranges: merged }
  }

  async appendCandles(candles, priority = 'background') {
    if (!Array.isArray(candles)) throw new TypeError('Candles must be an array.')
    if (!candles.length) return 0
    candles.forEach(validateCandle)
    const records = [...new Map(candles.map(candle => [`${candle.instrument}:${candle.timeframe}:${candle.timestamp}`, storedCandle(candle, null)])).values()]
    return this.enqueue(async () => {
      const batches = Map.groupBy(records, candle => this.partition(candle.instrument, candle.timeframe, candle.timestamp))
      try { for (const [directory, rows] of batches) await this.publishPartition(directory, rows) }
      finally {
        for (const rows of Map.groupBy(records, row => `${row.instrument}:${row.timeframe}`).values()) {
          this.invalidate(rows[0].instrument, rows[0].timeframe,
            { from: Math.min(...rows.map(row => row.timestamp)), through: Math.max(...rows.map(row => row.timestamp)) })
        }
      }
      return records.length
    }, priority)
  }

  async replaceCandles(query, candles, priority = 'background') {
    const { instrument, timeframe, from, through } = validateQuery(query)
    const interval = CANDLE_INTERVALS[timeframe]
    if (from % interval || through % interval || !Array.isArray(candles)) throw new TypeError('Repair range must lie on the candle grid.')
    candles.forEach(candle => {
      validateCandle(candle)
      if (candle.instrument !== instrument || candle.timeframe !== timeframe || candle.timestamp < from || candle.timestamp > through) throw new TypeError('Replacement candle lies outside its repair range.')
    })
    const records = [...new Map(candles.map(candle => [`${candle.instrument}:${candle.timeframe}:${candle.timestamp}`, storedCandle(candle, null)])).values()]
    return this.enqueue(async () => {
      try {
        for (let day = Math.floor(from / dayMS) * dayMS; day <= through; day += dayMS) {
          await this.publishPartition(this.partition(instrument, timeframe, day), records.filter(row => row.timestamp >= day && row.timestamp < day + dayMS), { replaceFrom: from, replaceThrough: through, timeframe })
        }
      } finally { this.invalidate(instrument, timeframe, { from, through }) }
      return records.length
    }, priority)
  }

  async candles(query, priority = 'background') {
    const { instrument, timeframe, from, through } = validateQuery(query)
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe, from, through)
      if (!files.length) return []
      const relation = await this.parquetRelation(files)
      const result = await this.connection.runAndReadAll(`SELECT * FROM ${relation} WHERE timestamp >= ${from} AND timestamp <= ${through}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) = 1 ORDER BY timestamp`)
      const rows = result.getRowObjectsJS().map(normalizeCandleRow)
      rows.forEach(candle => {
        validateCandle(candle)
        if (candle.instrument !== instrument || candle.timeframe !== timeframe) throw new TypeError('Persisted candle does not match its partition. Run a data audit.')
      })
      return rows
    }, priority)
  }

  async candleWatermark(instrument, timeframe, priority = 'background') {
    const key = `${instrument}:${timeframe}`
    return this.enqueue(async () => {
      if (this.watermarks.has(key)) return this.watermarks.get(key)
      const files = await this.parquetFiles(instrument, timeframe)
      // Cache identity belongs to the committed file set, not the wall clock.
      // A full repair can discard undecodable old files without reading their
      // row watermarks, and clock rollback must never revive an old snapshot.
      const watermark = this.schemaKey(files)
      this.watermarks.set(key, watermark)
      return watermark
    }, priority)
  }

  chartSnapshotFile(instrument, timeframe) {
    return join(this.root, 'prepared-charts', safeSegment(timeframe), `${safeSegment(instrument)}.json`)
  }

  async readChartSnapshot(instrument, timeframe) {
    try { return JSON.parse(await readFile(this.chartSnapshotFile(instrument, timeframe), 'utf8')) }
    catch (error) { if (isMissing(error) || error instanceof SyntaxError) return null; throw error }
  }

  writeChartSnapshot(instrument, timeframe, snapshot) {
    const key = `${instrument}:${timeframe}`, previous = this.chartSnapshotWrites.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      const directory = join(this.root, 'prepared-charts', safeSegment(timeframe))
      await mkdir(directory, { recursive: true })
      const target = this.chartSnapshotFile(instrument, timeframe)
      const temporary = `${target}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }) }
    }).finally(() => { if (this.chartSnapshotWrites.get(key) === task) this.chartSnapshotWrites.delete(key) })
    this.chartSnapshotWrites.set(key, task)
    return task
  }

  // Gap detection only needs timestamp presence. Reading the timestamp
  // column alone keeps the frequent repair checks from decompressing every
  // candle field.
  async candleTimestamps(query, priority = 'background') {
    const { instrument, timeframe, from, through } = validateQuery(query)
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe, from, through)
      if (!files.length) return []
      const relation = await this.parquetRelation(files)
      const result = await this.connection.runAndReadAll(`SELECT DISTINCT timestamp FROM ${relation} WHERE confirmed = true AND timestamp >= ${from} AND timestamp <= ${through} ORDER BY timestamp`)
      return result.getRowObjectsJS().map(row => Number(row.timestamp))
    }, priority)
  }

  async coverage(instrument, timeframe, priority = 'background') {
    validateQuery({ instrument, timeframe })
    const key = `${instrument}:${timeframe}`
    return this.enqueue(async () => {
      if (this.coverages.has(key)) return { ...this.coverages.get(key) }
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return { count: 0, first: null, last: null }
      const relation = await this.parquetRelation(files)
      const result = await this.connection.runAndReadAll(`SELECT COUNT(DISTINCT timestamp) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM ${relation} WHERE confirmed = true`)
      const row = result.getRowObjectsJS()[0]
      const coverage = { count: Number(row.count), first: row.first == null ? null : Number(row.first), last: row.last == null ? null : Number(row.last) }
      this.coverages.set(key, coverage)
      return { ...coverage }
    }, priority)
  }

  async missingCandleRanges({ instrument, timeframe = '5m', from, through, intervalMS = CANDLE_INTERVALS[timeframe] }, priority = 'background') {
    validateQuery({ instrument, timeframe, from, through })
    if (intervalMS !== CANDLE_INTERVALS[timeframe]) throw new TypeError('Candle interval must match timeframe.')
    const first = Math.ceil(from / intervalMS) * intervalMS, last = Math.floor(through / intervalMS) * intervalMS
    if (first > last) return []
    const stamps = await this.candleTimestamps({ instrument, timeframe, from: first, through: last }, priority)
    return missingRanges(stamps, first, last, intervalMS)
  }

  async inspectCandles(query, priority = 'background') {
    const { instrument, timeframe, from, through } = validateQuery(query), interval = CANDLE_INTERVALS[timeframe]
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe, from, through), issues = [], present = new Set(), seen = new Map(), latest = new Map(), corruptDays = []
      let checkedRows = 0
      const issue = (reason, first, last, file, detail) => issues.push({ instrument, timeframe, source: 'candles', from: first, through: last, reason, repairable: true, ...(file ? { file } : {}), ...(detail ? { detail } : {}) })
      for (const file of files) {
        const fileStamps = new Set()
        const date = file.match(/date=(\d{4}-\d{2}-\d{2})/)?.[1], start = Date.parse(`${date}T00:00:00Z`), end = start + dayMS - interval
        // Filesystem failures are operational errors, never a clean audit.
        await stat(file)
        let rows, columns
        try {
          const relation = `read_parquet(${quote(file)}, hive_partitioning = false)`
          columns = (await this.connection.runAndReadAll(`DESCRIBE SELECT * FROM ${relation}`)).getRowObjectsJS()
          rows = (await this.connection.runAndReadAll(`SELECT * FROM ${relation}`)).getRowObjectsJS().map(normalizeCandleRow)
        }
        catch (error) {
          if (!/Invalid Input|Invalid Error|Conversion Error|Serialization Error|corrupt|parquet.*(?:magic|footer|metadata)|(?:magic|footer).*parquet/i.test(String(error?.message))) throw error
          issue('corrupt-file', start, end, file, 'The Parquet partition cannot be decoded.')
          corruptDays.push({ from: start, through: end }); continue
        }
        // A readable but incompatible physical schema requires republishing
        // the whole file before strict reads or partial merges can succeed.
        // Report it first so repair replaces the partition before row defects.
        try { validatePhysicalSchema(columns) }
        catch (error) { issue('invalid-schema', start, end, file, error.message) }
        for (const row of rows) {
          const stamp = row.timestamp
          const knownStamp = typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= start && stamp < start + dayMS
          if (knownStamp && (stamp < Math.floor(from / interval) * interval || stamp >= Math.floor(through / interval) * interval + interval)) continue
          checkedRows++
          const validStamp = knownStamp && Number.isSafeInteger(stamp)
          const first = knownStamp ? Math.floor(stamp / interval) * interval : start
          const last = knownStamp ? first : end
          if (!validStamp || stamp % interval !== 0) issue('invalid-grid', first, last, file)
          if (row.instrument !== instrument || row.timeframe !== timeframe) issue('invalid-partition', first, last, file)
          if (row.confirmed !== true) issue('unconfirmed', first, last, file)
          if (['open', 'high', 'low', 'close'].some(field => typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0)
            || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)) issue('invalid-ohlc', first, last, file)
          if (typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0
            || optionalNonnegative.some(field => row[field] != null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0))) issue('negative-volume', first, last, file)
          if (optionalInteger.some(field => row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0))
            || row.statisticsVersion > 2_147_483_647) issue('invalid-metadata', first, last, file)
          const revision = Number.isSafeInteger(row.writtenAt) && row.writtenAt >= 0 ? row.writtenAt : 0
          const current = latest.get(stamp)
          if (!current || revision >= current.revision) latest.set(stamp, { row, first, last, file, revision })
          if (validStamp && stamp % interval === 0) {
            const revisions = seen.get(stamp) ?? new Set()
            // Separate files can legitimately revise the same candle. A part
            // is unique by timestamp; equal cross-part revisions are ambiguous.
            if (fileStamps.has(stamp) || revisions.has(revision)) issue('duplicate', stamp, stamp, file)
            fileStamps.add(stamp)
            revisions.add(revision)
            seen.set(stamp, revisions)
            // Invalid values at a real timestamp are their own anomalies,
            // rather than a second, misleading report of missing candles.
            present.add(stamp)
          }
        }
      }
      // Optional units may be absent before a later hydration. Audit the
      // currently visible observation instead of refetching superseded rows.
      for (const { row, first, last, file } of latest.values()) {
        if (row.baseVolume == null) issue('missing-base-volume', first, last, file, 'Base-asset volume is unavailable; refetch the source observation.')
      }
      // Corrupt days already have an explicit full-partition report. Their
      // unknowable contents must not be reported again as invented gaps.
      const first = Math.ceil(from / interval) * interval, last = Math.floor(through / interval) * interval
      const gaps = []
      let cursor = first
      for (const corrupt of corruptDays.sort((a, b) => a.from - b.from)) {
        if (corrupt.through < cursor || corrupt.from > last) continue
        gaps.push(...missingRanges(present, cursor, Math.min(last, corrupt.from - interval), interval))
        cursor = Math.max(cursor, corrupt.through + interval)
      }
      gaps.push(...missingRanges(present, cursor, last, interval))
      for (const range of gaps) issue('gap', range.from, range.through)
      return { issues, checkedRows, files: files.length, missingRanges: gaps }
    }, priority)
  }

  async close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = (async () => {
      // A late background repair must finish before the connection closes,
      // exactly as the old promise-chain lane guaranteed.
      while (this.draining || this.queue.length) await new Promise(resolve => setImmediate(resolve))
      await Promise.allSettled([...this.chartSnapshotWrites.values()])
      this.connection.closeSync()
      this.instance?.closeSync()
    })()
    return this.closeTask
  }
}
