import { DuckDBInstance } from '@duckdb/node-api'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const quote = value => `'${String(value).replaceAll("'", "''")}'`
const safeSegment = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._=-]*$/.test(value)) throw new TypeError('Invalid Parquet partition key.')
  return value
}
export const CANDLE_INTERVALS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })
const dayMS = 86_400_000
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
const isMissing = error => error?.code === 'ENOENT'
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
    this.watermarks = new Map()
    this.chartSnapshotWrites = new Map()
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

  async parquetFiles(instrument, timeframe, from, through) {
    const directory = join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`)
    let dates
    try { dates = await readdir(directory, { withFileTypes: true }) } catch (error) { if (isMissing(error)) return []; throw error }
    const firstDate = Number.isFinite(from) ? new Date(from).toISOString().slice(0, 10) : null
    const lastDate = Number.isFinite(through) ? new Date(through).toISOString().slice(0, 10) : null
    const files = []
    for (const entry of dates.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !/^date=\d{4}-\d{2}-\d{2}$/.test(entry.name)
        || firstDate && entry.name.slice(5) < firstDate || lastDate && entry.name.slice(5) > lastDate) continue
      const day = join(directory, entry.name)
      // An empty partition left by an interrupted first write is absence,
      // whereas permissions and device errors must reach the caller.
      let parts
      try { parts = await readdir(day, { withFileTypes: true }) } catch (error) { if (isMissing(error)) continue; throw error }
      files.push(...parts.filter(part => part.isFile() && part.name.endsWith('.parquet')).map(part => join(day, part.name)))
    }
    return files
  }

  async parquetRelation(files) {
    const relation = `read_parquet([${files.map(quote).join(', ')}], union_by_name = true, hive_partitioning = false)`
    const columns = (await this.connection.runAndReadAll(`DESCRIBE SELECT * FROM ${relation}`)).getRowObjectsJS()
    const existing = new Set(columns.map(column => column.column_name))
    validatePhysicalSchema(columns)
    const projection = Object.entries(schema).map(([field, type]) => `${existing.has(field) ? `CAST("${field}" AS ${type})` : `NULL::${type}`} AS "${field}"`).join(', ')
    // Explicit casts happen at the storage boundary. Old files may omit base
    // volume; that is a typed NULL, never quote volume divided by a price.
    return `(SELECT ${projection} FROM ${relation})`
  }

  async publishPartition(directory, rows, { replaceFrom, replaceThrough, timeframe = rows[0]?.timeframe } = {}) {
    await mkdir(directory, { recursive: true })
    const parts = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.parquet')).map(entry => join(directory, entry.name))
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const source = join(directory, `.${nonce}.json`), target = join(directory, `part-${nonce}.parquet`), temporary = `${target}.tmp`
    const startedAt = performance.now(), interval = CANDLE_INTERVALS[timeframe]
    let previousBytes = 0
    for (const file of parts) previousBytes += (await stat(file)).size
    await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
    try {
      const incoming = `SELECT * FROM read_json(${quote(source)}, columns = {${sqlSchema}}, format = 'array')`
      let previous = ''
      if (parts.length) {
        const dayStart = Date.parse(`${directory.slice(-10)}T00:00:00Z`)
        // A corrupt file can only be discarded when its entire UTC day is
        // explicitly replaced. Partial repairs always preserve other rows.
        const fullDay = replaceFrom <= dayStart && replaceThrough >= dayStart + dayMS - interval
        if (!fullDay) {
          const relation = await this.parquetRelation(parts)
          previous = `SELECT * FROM ${relation}${replaceFrom == null ? '' : ` WHERE timestamp < ${replaceFrom} OR timestamp >= ${replaceThrough + interval}`} UNION ALL BY NAME `
        }
      }
      await this.connection.run(`COPY (SELECT * FROM (${previous}${incoming})
        QUALIFY ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) = 1
        ORDER BY timestamp) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
      await rename(temporary, target)
      await Promise.all(parts.map(part => rm(part, { force: true })))
      const bytesWritten = (await stat(target)).size
      this.writeMetrics = { partitions: this.writeMetrics.partitions + 1, rowsSubmitted: this.writeMetrics.rowsSubmitted + rows.length,
        bytesRead: this.writeMetrics.bytesRead + previousBytes, bytesWritten: this.writeMetrics.bytesWritten + bytesWritten,
        durationMS: this.writeMetrics.durationMS + performance.now() - startedAt }
    } finally { await rm(source, { force: true }); await rm(temporary, { force: true }) }
  }

  invalidate(instrument, timeframe, writtenAt) {
    const key = `${instrument}:${timeframe}`
    this.coverages.delete(key)
    if (writtenAt == null) this.watermarks.delete(key)
    else if (this.watermarks.has(key)) this.watermarks.set(key, Math.max(this.watermarks.get(key), writtenAt))
  }

  getWriteMetrics() { return { ...this.writeMetrics } }

  async appendCandles(candles, priority = 'background') {
    if (!Array.isArray(candles)) throw new TypeError('Candles must be an array.')
    if (!candles.length) return 0
    candles.forEach(validateCandle)
    const writtenAt = Math.max(Date.now(), this.lastWrittenAt + 1)
    this.lastWrittenAt = writtenAt
    const records = [...new Map(candles.map(candle => [`${candle.instrument}:${candle.timeframe}:${candle.timestamp}`, storedCandle(candle, writtenAt)])).values()]
    return this.enqueue(async () => {
      const batches = Map.groupBy(records, candle => this.partition(candle.instrument, candle.timeframe, candle.timestamp))
      try { for (const [directory, rows] of batches) await this.publishPartition(directory, rows) }
      finally { for (const candle of records) this.invalidate(candle.instrument, candle.timeframe, writtenAt) }
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
    const writtenAt = Math.max(Date.now(), this.lastWrittenAt + 1)
    this.lastWrittenAt = writtenAt
    const records = [...new Map(candles.map(candle => [`${candle.instrument}:${candle.timeframe}:${candle.timestamp}`, storedCandle(candle, writtenAt)])).values()]
    return this.enqueue(async () => {
      try {
        for (let day = Math.floor(from / dayMS) * dayMS; day <= through; day += dayMS) {
          await this.publishPartition(this.partition(instrument, timeframe, day), records.filter(row => row.timestamp >= day && row.timestamp < day + dayMS), { replaceFrom: from, replaceThrough: through, timeframe })
        }
      } finally { this.invalidate(instrument, timeframe) }
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
      let watermark = 0
      if (files.length) {
        const rows = (await this.connection.runAndReadAll(`SELECT MAX(COALESCE(writtenAt, 0)) AS watermark FROM ${await this.parquetRelation(files)}`)).getRowObjectsJS()
        watermark = Number(rows[0]?.watermark ?? 0)
      }
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
      const files = await this.parquetFiles(instrument, timeframe, from, through), issues = [], present = new Set(), seen = new Set(), corruptDays = []
      let checkedRows = 0
      const issue = (reason, first, last, file, detail) => issues.push({ instrument, timeframe, source: 'candles', from: first, through: last, reason, repairable: true, ...(file ? { file } : {}), ...(detail ? { detail } : {}) })
      for (const file of files) {
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
          if (row.baseVolume == null) issue('missing-base-volume', first, last, file, 'Base-asset volume is unavailable; refetch the source observation.')
          if (optionalInteger.some(field => row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0))
            || row.statisticsVersion > 2_147_483_647) issue('invalid-metadata', first, last, file)
          if (validStamp && stamp % interval === 0) {
            if (seen.has(stamp)) issue('duplicate', stamp, stamp, file)
            seen.add(stamp)
            // Invalid values at a real timestamp are their own anomalies,
            // rather than a second, misleading report of missing candles.
            present.add(stamp)
          }
        }
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
