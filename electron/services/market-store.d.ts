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
export type StorePriority = 'foreground' | 'background'
export type CandleQuery = { instrument: string; timeframe: string; from?: number; through?: number }
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
  enqueue<T>(operation: () => T | Promise<T>, priority?: StorePriority): Promise<T>
  appendCandles(candles: CandleRecord[], priority?: StorePriority): Promise<number>
  /** Replace the inclusive grid range, including malformed records within each covered bar. */
  replaceCandles(query: CandleQuery & CandleRange, candles: CandleRecord[], priority?: StorePriority): Promise<number>
  inspectCandles(query: CandleQuery & CandleRange, priority?: StorePriority): Promise<CandleInspection>
  getWriteMetrics(): { partitions: number; rowsSubmitted: number; bytesRead: number; bytesWritten: number; durationMS: number }
  candleRevision(instrument: string, timeframe: string): number
  candleChangesSince(instrument: string, timeframe: string, revision: number): { revision: number; ranges: CandleRange[] | null }
  candles(query: { instrument: string; timeframe: string; from?: number; through?: number }, priority?: StorePriority): Promise<CandleRecord[]>
  candleWatermark(instrument: string, timeframe: string, priority?: StorePriority): Promise<string>
  readChartSnapshot(instrument: string, timeframe: string): Promise<unknown>
  writeChartSnapshot(instrument: string, timeframe: string, snapshot: unknown): Promise<void>
  candleTimestamps(query: { instrument: string; timeframe: string; from?: number; through?: number }, priority?: StorePriority): Promise<number[]>
  coverage(instrument: string, timeframe: string, priority?: StorePriority): Promise<{ count: number; first: number | null; last: number | null }>
  missingCandleRanges(query: { instrument: string; timeframe?: string; from: number; through: number; intervalMS?: number }, priority?: StorePriority): Promise<Array<{ from: number; through: number }>>
  close(): Promise<void>
}
