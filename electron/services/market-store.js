import { DuckDBInstance } from '@duckdb/node-api'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const quote = value => `'${String(value).replaceAll("'", "''")}'`
const safeSegment = value => {
  const result = String(value).replaceAll(/[^A-Za-z0-9._=-]/g, '_')
  if (!result || result === '.' || result === '..') throw new Error('Invalid Parquet partition key.')
  return result
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
  }

  partition(instrument, timeframe, timestamp) {
    const date = new Date(timestamp).toISOString().slice(0, 10)
    return join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`, `date=${date}`)
  }

  async appendCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return 0
    const writtenAt = Date.now()
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
        await writeFile(source, JSON.stringify(rows), { mode: 0o600 })
        try {
          await this.connection.run(`COPY (SELECT * FROM read_json_auto(${quote(source)})) TO ${quote(target)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
        } finally { await rm(source, { force: true }) }
      }
      return candles.length
    }
    const result = this.pending.then(write, write)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  async candles({ instrument, timeframe, from = 0, through = Date.now() }) {
    const directory = join(this.root, 'candles', `timeframe=${safeSegment(timeframe)}`, `instrument=${safeSegment(instrument)}`)
    let dates
    try { dates = await readdir(directory, { withFileTypes: true }) } catch { return [] }
    const files = dates.filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name, '*.parquet'))
    if (!files.length) return []
    const list = `[${files.map(quote).join(', ')}]`
    const result = await this.connection.runAndReadAll(`SELECT * EXCLUDE (row_rank) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt, 0) DESC) AS row_rank FROM read_parquet(${list}, union_by_name = true) WHERE timestamp >= ${Number(from)} AND timestamp <= ${Number(through)}) WHERE row_rank = 1 ORDER BY timestamp`)
    return result.getRowObjectsJS().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])))
  }

  async coverage(instrument, timeframe) {
    const candles = await this.candles({ instrument, timeframe, from: 0, through: Date.now() })
    return { count: candles.length, first: candles[0]?.timestamp ?? null, last: candles.at(-1)?.timestamp ?? null }
  }

  async close() { this.connection.closeSync() }
}
