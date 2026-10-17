export type CandleRecord = {
  instrument: string
  timeframe: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  confirmed: boolean
  [key: string]: unknown
}
export type CatalogSnapshot = { schemaVersion: number; liquidityPolicyVersion: number; criteriaKey: string; savedAt: number; entries: unknown[] }
export type StorePriority = 'foreground' | 'background'
export class MarketStore {
  static open(root: string): Promise<MarketStore>
  enqueue<T>(operation: () => T | Promise<T>, priority?: StorePriority): Promise<T>
  appendCandles(candles: CandleRecord[], priority?: StorePriority): Promise<number>
  compactLegacyParts(): Promise<void>
  candles(query: { instrument: string; timeframe: string; from?: number; through?: number }, priority?: StorePriority): Promise<CandleRecord[]>
  candleTimestamps(query: { instrument: string; timeframe: string; from?: number; through?: number }, priority?: StorePriority): Promise<number[]>
  coverage(instrument: string, timeframe: string, priority?: StorePriority): Promise<{ count: number; first: number | null; last: number | null }>
  missingCandleRanges(query: { instrument: string; timeframe?: string; from: number; through: number; intervalMS?: number }, priority?: StorePriority): Promise<Array<{ from: number; through: number }>>
  writeCatalogSnapshot(snapshot: CatalogSnapshot): Promise<void>
  readCatalogSnapshot(): Promise<CatalogSnapshot | null>
  close(): Promise<void>
}
