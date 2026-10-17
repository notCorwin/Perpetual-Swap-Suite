import { DuckDBInstance } from '@duckdb/node-api'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const quote = value => `'${String(value).replaceAll("'", "''")}'`
const safeSegment = value => {
  const result = String(value).replaceAll(/[^A-Za-z0-9._=-]/g, '_')
  if (!result || result === '.' || result === '..') throw new Error('Invalid Parquet partition key.')
  return result
}
const numericCandleFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion', 'writtenAt']
const normalizeCandleRow = row => {
  const candle = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))
  // Parquet files are append-only and older parts may omit optional fields.
  // DuckDB's union-by-name can then widen numeric columns to VARCHAR. Never
  // leak that storage representation into indicators or chart rendering.
  for (const field of numericCandleFields) {
    const value = candle[field]
    if (typeof value !== 'string' || !value.trim()) continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) candle[field] = parsed
  }
  if (typeof candle.confirmed === 'string') candle.confirmed = candle.confirmed === 'true' || candle.confirmed === '1'
  return candle
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
    return new MarketStore(root, await instance.connect())
  }

  constructor(root, connection) {
    this.root = root
    this.connection = connection
    this.pending = Promise.resolve()
    this.lastWrittenAt = 0
    this.closed = false
    this.closeTask = null
  }

  // DuckDB connections are not a concurrent query coordinator. Keep every
  // query and write on this connection in one ordered lane, and close only
  // after that lane has drained. This also makes a late background repair
  // harmless during application shutdown instead of racing `closeSync()`.
  enqueue(operation) {
    if (this.closed) return Promise.reject(new Error('MarketStore is closed.'))
    const task = this.pending.then(operation)
    this.pending = task.then(() => undefined, () => undefined)
    return task
  }

  partition(instrument, timeframe, timestamp) {
    const date = new Date(timestamp).toISOString().slice(0, 10)
    return join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`, `date=${date}`)
  }

  async parquetFiles(instrument, timeframe) {
    const directory = join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`)
    let dates
    try { dates = await readdir(directory, { withFileTypes: true }) } catch { return [] }
    return dates.filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, '*.parquet'))
  }

  async appendCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return 0
    // Parquet parts are append-only. The latest record wins during reads, so
    // equal timestamps would make two concurrent writes nondeterministic.
    const writtenAt = Math.max(Date.now(), this.lastWrittenAt + 1)
    this.lastWrittenAt = writtenAt
    candles = candles.map(candle => ({ ...candle, writtenAt }))
    for (const candle of candles) {
      if (!Number.isFinite(candle.timestamp) || !candle.instrument || !candle.timeframe) throw new Error('A candle needs instrument, timeframe, and timestamp.')
    }
    const write = async () => {
      const batches = Map.groupBy(candles, candle => this.partition(candle.instrument, candle.timeframe, candle.timestamp))
      for (const [directory, rows] of batches) {
        await mkdir(directory, { recursive: true })
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const source = join(directory, `.${nonce}.json`)
        const target = join(directory, `part-${nonce}.parquet`)
        const temporary = `${target}.tmp`
        await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
        try {
          await this.connection.run(`COPY (SELECT * FROM read_json_auto(${quote(source)})) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
          await rename(temporary, target)
        } finally {
          await rm(source, { force: true })
          await rm(temporary, { force: true })
        }
      }
      return candles.length
    }
    return this.enqueue(write)
  }

  async candles({ instrument, timeframe, from = 0, through = Date.now() }) {
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return []
      const list = `[${files.map(quote).join(', ')}]`
      const result = await this.connection.runAndReadAll(`SELECT * EXCLUDE (row_rank) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true) WHERE timestamp >= ${Number(from)} AND timestamp <= ${Number(through)}) WHERE row_rank = 1 ORDER BY timestamp`)
      return result.getRowObjectsJS().map(normalizeCandleRow)
    })
  }

  async coverage(instrument, timeframe) {
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return { count: 0, first: null, last: null }
      const list = `[${files.map(quote).join(', ')}]`
      const result = await this.connection.runAndReadAll(`SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM (SELECT timestamp, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true)) WHERE row_rank = 1`)
      const row = result.getRowObjectsJS()[0] ?? {}
      const number = value => typeof value === 'bigint' ? Number(value) : Number(value)
      return {
        count: Number.isFinite(number(row.count)) ? number(row.count) : 0,
        first: Number.isFinite(number(row.first)) ? number(row.first) : null,
        last: Number.isFinite(number(row.last)) ? number(row.last) : null,
      }
    })
  }

  async missingCandleRanges({ instrument, timeframe = '5m', from, through, intervalMS = 300_000 }) {
    const first = Math.ceil(Number(from) / intervalMS) * intervalMS
    const last = Math.floor(Number(through) / intervalMS) * intervalMS
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return []
    const rows = await this.candles({ instrument, timeframe, from: first, through: last })
    const present = new Set(rows.map(row => Number(row.timestamp)))
    const ranges = []
    let rangeStart = null
    for (let timestamp = first; timestamp <= last; timestamp += intervalMS) {
      if (!present.has(timestamp)) {
        if (rangeStart === null) rangeStart = timestamp
        continue
      }
      if (rangeStart !== null) {
        ranges.push({ from: rangeStart, through: timestamp - intervalMS })
        rangeStart = null
      }
    }
    if (rangeStart !== null) ranges.push({ from: rangeStart, through: last })
    return ranges
  }

  catalogFile() { return join(this.root, 'catalog.parquet') }

  // The liquid-instrument catalogue is not a second in-memory source of
  // truth. It is a compact Parquet snapshot alongside the candle partitions,
  // so an app restart can render already-verified cached observations before
  // another network-wide liquidity scan finishes. Keep the whole snapshot in
  // one atomic row: partial scans must never look like a complete catalogue.
  async writeCatalogSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.entries)) throw new Error('A catalog snapshot needs entries.')
    const rows = [{
      schemaVersion: Number(snapshot.schemaVersion),
      liquidityPolicyVersion: Number(snapshot.liquidityPolicyVersion),
      criteriaKey: String(snapshot.criteriaKey ?? ''),
      savedAt: Number(snapshot.savedAt),
      entriesJSON: JSON.stringify(snapshot.entries),
    }]
    if (!Number.isSafeInteger(rows[0].schemaVersion) || !Number.isSafeInteger(rows[0].liquidityPolicyVersion) || !rows[0].criteriaKey || !Number.isFinite(rows[0].savedAt)) throw new Error('Invalid catalog snapshot.')
    const write = async () => {
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const source = join(this.root, `.${nonce}.catalog.json`)
      const temporary = join(this.root, `.${nonce}.catalog.parquet`)
      const target = this.catalogFile()
      await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
      try {
        await this.connection.run(`COPY (SELECT * FROM read_json_auto(${quote(source)})) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
        await rename(temporary, target)
      } finally {
        await rm(source, { force: true })
        await rm(temporary, { force: true })
      }
      return undefined
    }
    return this.enqueue(write)
  }

  async readCatalogSnapshot() {
    return this.enqueue(async () => {
      let rows
      try {
        rows = (await this.connection.runAndReadAll(`SELECT * FROM read_parquet(${quote(this.catalogFile())})`)).getRowObjectsJS()
      } catch {
        // A missing or interrupted snapshot must never prevent candle data
        // from opening. The next successful discovery atomically replaces it.
        return null
      }
      if (rows.length !== 1) return null
      const row = rows[0]
      try {
        const snapshot = {
          schemaVersion: Number(row.schemaVersion),
          liquidityPolicyVersion: Number(row.liquidityPolicyVersion),
          criteriaKey: String(row.criteriaKey ?? ''),
          savedAt: Number(row.savedAt),
          entries: JSON.parse(String(row.entriesJSON)),
        }
        return Number.isSafeInteger(snapshot.schemaVersion) && Number.isSafeInteger(snapshot.liquidityPolicyVersion)
          && snapshot.criteriaKey && Number.isFinite(snapshot.savedAt) && Array.isArray(snapshot.entries) ? snapshot : null
      } catch {
        return null
      }
    })
  }

  async close() {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = this.pending.then(() => this.connection.closeSync())
    return this.closeTask
  }
}
