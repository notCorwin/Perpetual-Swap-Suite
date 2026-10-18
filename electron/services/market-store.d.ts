export type CandleRecord = {
  instrument: string
  timeframe: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** Base-asset amount. Legacy observations without this unit remain null. */
  baseVolume?: number | null
  quoteVolume?: number | null
  oi?: number | null
  buy?: number | null
  sell?: number | null
  confirmed: boolean
  [key: string]: unknown
}
export type StorePriority = 'interactive' | 'foreground' | 'prepared' | 'repair' | 'continuity' | 'statistics' | 'prefetch' | 'chartWarm' | 'background'
export type CandleQuery = { instrument: string; timeframe: string; from?: number; through?: number; limit?: number; order?: 'asc' | 'desc' }
export type StatisticsRecord = {
  instrument: string; timeframe: string; timestamp: number; oi: number | null; buy: number | null; sell: number | null
  statisticsVersion: number; statisticsOIExpiresAt: number | null; statisticsTakerExpiresAt: number | null
}
export type StatisticsPage = CandleQuery & CandleRange & { source: 'oi' | 'taker'; values: Array<Array<number | null>>; expiresAt?: number | null; preserveExistingSource?: boolean }
export type IndicatorCheckpoint = { timestamp: number; state: any; formulaVersion: string; sourceRevision: string | number; bollExpansion?: unknown }
export type CandleRange = { from: number; through: number }
export type CandleAuditIssue = CandleRange & {
  instrument: string
  timeframe: string
  source: 'candles'
  reason: 'gap' | 'invalid-grid' | 'invalid-partition' | 'invalid-schema' | 'unconfirmed' | 'invalid-ohlc' | 'negative-volume' | 'missing-base-volume' | 'invalid-metadata' | 'duplicate' | 'corrupt-file'
  repairable: boolean
  file?: string
  detail?: string
}
export type CandleInspection = { issues: CandleAuditIssue[]; checkedRows: number; files: number; missingRanges: CandleRange[] }
export const CANDLE_INTERVALS: Readonly<{ '5m': 300000; '15m': 900000; '1H': 3600000 }>
export function validateCandle<T extends CandleRecord>(candle: T): T
export class MarketStore {
  static open(root: string): Promise<MarketStore>
  root: string
  path: string
  workerThreadIds: { writer: number; readers: number[] }
  subscribe(listener: (change: { instrument: string; timeframe: string; from: number; through: number; priceFrom: number | null; priceThrough: number | null; revision: number; priceRevision: number; imported: boolean }) => void): () => void
  appendCandles(candles: CandleRecord[], priority?: StorePriority): Promise<number>
  appendStatistics(page: StatisticsPage, priority?: StorePriority): Promise<number>
  statistics(query: CandleQuery & { source?: 'oi' | 'taker' }, priority?: StorePriority): Promise<StatisticsRecord[]>
  readStatistics(query: CandleQuery & { source?: 'oi' | 'taker' }, priority?: StorePriority): Promise<StatisticsRecord[]>
  statisticsMissingRanges(query: CandleQuery & CandleRange & { source: 'oi' | 'taker' }, priority?: StorePriority): Promise<CandleRange[]>
  /** Replace the inclusive grid range, including malformed records within each covered bar. */
  replaceCandles(query: CandleQuery & CandleRange, candles: CandleRecord[], priority?: StorePriority): Promise<number>
  inspectCandles(query: CandleQuery & CandleRange, priority?: StorePriority): Promise<CandleInspection>
  getWriteMetrics(): { partitions: number; rowsSubmitted: number; bytesRead: number; bytesWritten: number; durationMS: number }
  getDiagnostics(): { workerThreadIds: { writer: number; readers: number[] }; reads: Record<string, number>; writes: Record<string, number>; migrationComplete: boolean; migrationProcessId: number | null }
  candleRevision(instrument: string, timeframe: string): number
  candleChangesSince(instrument: string, timeframe: string, revision: number): { revision: number; ranges: CandleRange[] | null }
  candles(query: CandleQuery, priority?: StorePriority): Promise<CandleRecord[]>
  candleWatermark(instrument: string, timeframe: string, priority?: StorePriority): Promise<string>
  priceWatermark(instrument: string, timeframe: string, priority?: StorePriority): Promise<string>
  readIndicatorCheckpoint(query: CandleQuery & { before: number; formulaVersion: string }, priority?: StorePriority): Promise<IndicatorCheckpoint | null>
  writeIndicatorCheckpoint(query: CandleQuery & IndicatorCheckpoint, priority?: StorePriority): Promise<boolean>
  invalidateIndicatorCheckpoints(query: CandleQuery & { from: number }, priority?: StorePriority): Promise<void>
  integrityCheck(): Promise<string[]>
  migrationStatus(): Promise<{ complete: boolean; completedPartitions: number; failedPartitions: number; importedRows: number; issues: Array<{ path: string; instrument: string; timeframe: string; from: number; through: number; reason: string; detail: string }>; error: string }>
  candleTimestamps(query: { instrument: string; timeframe: string; from?: number; through?: number }, priority?: StorePriority): Promise<number[]>
  coverage(instrument: string, timeframe: string, priority?: StorePriority): Promise<{ count: number; first: number | null; last: number | null }>
  missingCandleRanges(query: { instrument: string; timeframe?: string; from: number; through: number; intervalMS?: number }, priority?: StorePriority): Promise<Array<{ from: number; through: number }>>
  close(): Promise<void>
}
