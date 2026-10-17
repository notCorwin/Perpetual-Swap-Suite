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
    this.queue = []
    this.draining = false
    this.lastWrittenAt = 0
    this.closed = false
    this.closeTask = null
    this.coverages = new Map()
  }

  // DuckDB connections are not a concurrent query coordinator. Keep every
  // query and write on this connection in one ordered lane, and close only
  // after that lane has drained. Foreground work (the focused chart) cuts in
  // front of queued background reads so bulk list projections and warm-up
  // repairs can never delay a chart load; background work keeps arrival
  // order among itself.
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

  async parquetFiles(instrument, timeframe) {
    const directory = join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`)
    let dates
    try { dates = await readdir(directory, { withFileTypes: true }) } catch { return [] }
    return dates.filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, '*.parquet'))
  }

  // One part per date partition. Rows merge into the partition's existing
  // parts during a single atomic COPY: readers open one file per date, the
  // newest-written observation wins per timestamp, and an interrupted write
  // leaves the previous part intact until the replacement is renamed in.
  async writePartition(directory, rows) {
    await mkdir(directory, { recursive: true })
    const parts = (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && entry.name.endsWith('.parquet'))
      .map(entry => join(directory, entry.name))
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const source = join(directory, `.${nonce}.json`)
    const target = join(directory, `part-${nonce}.parquet`)
    const temporary = `${target}.tmp`
    if (rows.length) await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
    const sources = [
      ...(parts.length ? [`SELECT * FROM read_parquet([${parts.map(quote).join(', ')}], union_by_name = true)`] : []),
      ...(rows.length ? [`SELECT * FROM read_json_auto(${quote(source)})`] : []),
    ]
    if (!sources.length) return
    try {
      await this.connection.run(`COPY (
        SELECT * FROM (${sources.join(' UNION ALL BY NAME ')})
        QUALIFY row_number() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) = 1
        ORDER BY timestamp
      ) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
      await rename(temporary, target)
      await Promise.all(parts.map(part => rm(part, { force: true })))
    } finally {
      if (rows.length) await rm(source, { force: true })
      await rm(temporary, { force: true })
    }
  }

  async appendCandles(candles, priority = 'background') {
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
      for (const [directory, rows] of batches) await this.writePartition(directory, rows)
      // Coverage only changes when rows are written. Invalidate per
      // instrument so unrelated instruments keep serving cached scans.
      for (const candle of candles) this.coverages.delete(`${candle.instrument}:${candle.timeframe}`)
      return candles.length
    }
    return this.enqueue(write, priority)
  }

  // Legacy parts are one per write on now-superseded builds. Merging keeps
  // them only until that date receives another write, and dates that never
  // receive one stay fragmented forever while every continuing read opens the
  // partition's whole pile of files. Fold each fragmented partition back to
  // one part on open; coverage (count/min/max) is preserved because the merge
  // deduplicates by timestamp exactly as reads do.
  async compactLegacyParts() {
    const candles = join(this.root, 'candles')
    for (const frame of await readdir(candles).catch(() => [])) {
      for (const instrument of await readdir(join(candles, frame)).catch(() => [])) {
        const instrumentDirectory = join(candles, frame, instrument)
        for (const date of await readdir(instrumentDirectory).catch(() => [])) {
          const directory = join(instrumentDirectory, date)
          const parts = (await readdir(directory, { withFileTypes: true }).catch(() => []))
            .filter(entry => entry.isFile() && entry.name.endsWith('.parquet'))
          if (parts.length <= 1) continue
          try { await this.enqueue(() => this.writePartition(directory, []), 'background') }
          catch (error) {
            // Quitting in the middle of the sweep is routine; a fold that
            // never happens leaves the existing parts readable.
            if (this.closed) return
            throw error
          }
        }
      }
    }
    return undefined
  }

  async candles({ instrument, timeframe, from = 0, through = Date.now() }, priority = 'background') {
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return []
      const list = `[${files.map(quote).join(', ')}]`
      const result = await this.connection.runAndReadAll(`SELECT * EXCLUDE (row_rank) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true) WHERE timestamp >= ${Number(from)} AND timestamp <= ${Number(through)}) WHERE row_rank = 1 ORDER BY timestamp`)
      return result.getRowObjectsJS().map(normalizeCandleRow)
    }, priority)
  }

  // Gap detection only needs timestamp presence. Reading the timestamp
  // column alone keeps the frequent repair checks from decompressing every
  // candle field.
  async candleTimestamps({ instrument, timeframe, from = 0, through = Date.now() }, priority = 'background') {
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return []
      const list = `[${files.map(quote).join(', ')}]`
      const result = await this.connection.runAndReadAll(`SELECT timestamp FROM (SELECT timestamp, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true) WHERE timestamp >= ${Number(from)} AND timestamp <= ${Number(through)}) WHERE row_rank = 1 ORDER BY timestamp`)
      return result.getRowObjectsJS().map(row => Number(row.timestamp))
    }, priority)
  }

  async coverage(instrument, timeframe, priority = 'background') {
    // Coverage only changes when rows are written, and every write
    // invalidates this cache. Repeat reads around one write — the chart poll,
    // list projection, and statistics paths all ask — reuse one scan.
    const key = `${instrument}:${timeframe}`
    const cached = this.coverages.get(key)
    if (cached) return { ...cached }
    return this.enqueue(async () => {
      const files = await this.parquetFiles(instrument, timeframe)
      if (!files.length) return { count: 0, first: null, last: null }
      const list = `[${files.map(quote).join(', ')}]`
      const result = await this.connection.runAndReadAll(`SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM (SELECT timestamp, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true)) WHERE row_rank = 1`)
      const row = result.getRowObjectsJS()[0] ?? {}
      const number = value => typeof value === 'bigint' ? Number(value) : Number(value)
      const coverage = {
        count: Number.isFinite(number(row.count)) ? number(row.count) : 0,
        first: Number.isFinite(number(row.first)) ? number(row.first) : null,
        last: Number.isFinite(number(row.last)) ? number(row.last) : null,
      }
      this.coverages.set(key, coverage)
      return { ...coverage }
    }, priority)
  }

  async missingCandleRanges({ instrument, timeframe = '5m', from, through, intervalMS = 300_000 }, priority = 'background') {
    const first = Math.ceil(Number(from) / intervalMS) * intervalMS
    const last = Math.floor(Number(through) / intervalMS) * intervalMS
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return []
    const stamps = await this.candleTimestamps({ instrument, timeframe, from: first, through: last }, priority)
    const present = new Set(stamps)
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
    this.closeTask = (async () => {
      // A late background repair must finish before the connection closes,
      // exactly as the old promise-chain lane guaranteed.
      while (this.draining || this.queue.length) await new Promise(resolve => setImmediate(resolve))
      this.connection.closeSync()
    })()
    return this.closeTask
  }
}
