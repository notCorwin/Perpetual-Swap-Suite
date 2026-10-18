import type { Worker } from 'node:worker_threads'
import type { CandleRecord, MarketStore } from './market-store.js'
import type { HistoryPriority, HistoryTimeframe } from './history-sync.js'
import type { Bar, PreparedChartResponse } from '../../src/chart-data.ts'

export type PreparedPriceSourceResult = { rows?: CandleRecord[]; floor?: number | null }
export type PreparedLatestSourceResult = PreparedPriceSourceResult & { live?: CandleRecord | null }
/** All source methods resolve after their confirmed records have been durably committed. */
export type PreparedChartHistory = {
  ensurePrices(instId: string, timeframe: HistoryTimeframe, from: number, through: number, priority: HistoryPriority): Promise<PreparedPriceSourceResult | void>
  ensureStatistics(instId: string, timeframe: HistoryTimeframe, from: number, through: number, priority: HistoryPriority): Promise<{ rows?: CandleRecord[] } | void>
  latest(instId: string, timeframe: HistoryTimeframe, priority: HistoryPriority): Promise<PreparedLatestSourceResult | void>
}
export class PreparedChartPipeline {
  constructor(options: {
    store: MarketStore
    history: PreparedChartHistory
    normalize(row: CandleRecord): CandleRecord
    revision(instId: string): number
    instrument(instId: string): { listTime?: string | number } | undefined
    /** Acknowledged current candle subscription; persisted coverage is checked separately. */
    streaming?(instId: string, timeframe: HistoryTimeframe): boolean
  })
  prepare(instId: string, timeframe: HistoryTimeframe, targetEnd?: number, historyBars?: number): Promise<PreparedChartResponse>
  local(instId: string, timeframe: HistoryTimeframe, options?: { priority?: HistoryPriority }): Promise<PreparedChartResponse | null>
  /** Bounded local price projection. Missing sources and exact indicators repair independently. */
  localHistory(instId: string, timeframe: HistoryTimeframe, targetEnd?: number): Promise<PreparedChartResponse | null>
  projectSeries(instId: string, timeframe: HistoryTimeframe): Promise<{ end: number | null; bars: Bar[] }>
  /** Bounded canonical tail plus the untruncated BOLL expansion run for list metrics. */
  projectListSeries(instId: string, timeframe: HistoryTimeframe): Promise<{ end: number | null; bars: Bar[]; bollExpansion: { hours: number; complete: boolean } | null }>
  /** Set renderer priorities and return all cached native frames for its contracts. */
  setUniverse(instIds: string[], timeframe: HistoryTimeframe, focusInstId?: string): { frames: PreparedChartResponse[] }
  /** Lightweight collector membership; this never restores or prepares candidate charts. */
  setRealtimeSubscriptions(subscriptions: { instId: string; timeframe: HistoryTimeframe }[]): void
  /** Reassess actual source deadlines after connection or subscription changes. */
  sourceStateChanged(): void
  subscribe(listener: (frame: PreparedChartResponse) => void): () => void
  observe(rows: CandleRecord[], previous: Map<number, CandleRecord>): void
  /** Forming candles only change in-memory projections; confirmed writes use observe. */
  setLive(instId: string, timeframe: HistoryTimeframe, candle: CandleRecord | null, context?: { receivedAt?: number }): Promise<PreparedChartResponse | null>
  /** Call after a durable range replacement to reject all prior calculations and snapshots. */
  invalidate(instId: string, timeframe: HistoryTimeframe): void
  observeStatistics(instId: string, timeframe: HistoryTimeframe, from: number, through: number): Promise<void>
  /** First pool worker, exposed for worker isolation diagnostics. */
  readonly worker: Worker | null
  dispose(): Promise<void>
}
