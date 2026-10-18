import type { CandleRecord, CandleRange, MarketStore, StorePriority } from './market-store.js'
import type { HistorySync, HistoryTask, HistorySyncOptions } from './history-sync.js'
import type { DataAudit, AuditMetadata } from './data-audit.js'

type MaybePromise<T> = T | Promise<T>
type Timeframe = '5m' | '15m' | '1H'
type Instrument = { instId: string; listTime?: number | string; [key: string]: unknown }
export type MarketHistoryOptions = {
  store: Pick<MarketStore, 'candles' | 'coverage' | 'inspectCandles'> & Partial<Pick<MarketStore, 'candleRevision' | 'candleChangesSince'>>
  metadata: HistorySyncOptions['metadata'] & AuditMetadata
  get(path: string, parameters: Record<string, string | number>, signal: AbortSignal, priority: StorePriority): Promise<unknown[][]>
  // Raw API JSON is checked by the adapter before reaching durable storage.
  parseCandle(instrument: string, timeframe: string, value: unknown[]): CandleRecord | null
  persistCandles(instrument: string, rows: CandleRecord[], options: { priority: StorePriority }): MaybePromise<unknown>
  persistStatistics(instrument: Instrument, timeframe: string, end: number, source: number, values: (number | null)[][],
    range: CandleRange & { intervalMS: number }, priority: StorePriority): MaybePromise<unknown>
  instrument?(instId: string): Instrument | undefined
  /** Owner serializes replacement, statistics preservation and invalidation with every candle mutation. */
  replaceCandles(range: CandleRange & { instrument: string; timeframe: string }, rows: CandleRecord[], priority: StorePriority): MaybePromise<unknown>
  onProgress?(task: HistoryTask): MaybePromise<void>
  onLive?(instId: string, timeframe: string, row: CandleRecord): MaybePromise<unknown>
  now?(): number
}
export class MarketHistory {
  constructor(options: MarketHistoryOptions)
  readonly ready: Promise<this>
  readonly sync: HistorySync
  readonly audit: DataAudit
  ensurePrices(instId: string, timeframe: Timeframe, from: number, through: number, priority?: StorePriority, signal?: AbortSignal): Promise<{ rows: CandleRecord[]; floor?: number }>
  /** Numeric observations remain reusable; direct empty observations revalidate only their expired native-period ranges. */
  ensureStatistics(instId: string, timeframe: Timeframe, from: number, through: number, priority?: StorePriority, signal?: AbortSignal): Promise<{ rows: CandleRecord[] }>
  latest(instId: string, timeframe: Timeframe, priority?: StorePriority): Promise<{ live: CandleRecord | null; floor?: number }>
  target(instId: string, options?: { historyDays?: number; asOf?: number }): Promise<Array<{ history: HistoryTask; warmup: HistoryTask | null }>>
  close(): Promise<void>
}
