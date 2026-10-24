import type { Worker } from 'node:worker_threads'
import type { CandleRecord, MarketStore } from './market-store.js'
import type { HistoryPriority, HistoryTimeframe } from './history-sync.js'
import type { PreparedChartResponse } from '../../src/chart-data.ts'

export type PreparedPriceSourceResult = { rows?: CandleRecord[]; floor?: number | null }
export type PreparedLatestSourceResult = PreparedPriceSourceResult
/** All source methods resolve after their confirmed records have been durably committed. */
export type PreparedChartHistory = {
  ensurePrices(instId: string, timeframe: HistoryTimeframe, from: number, through: number, priority: HistoryPriority, signal?: AbortSignal): Promise<PreparedPriceSourceResult | void>
  ensureStatistics(instId: string, timeframe: HistoryTimeframe, from: number, through: number, priority: HistoryPriority, signal?: AbortSignal, source?: 'oi' | 'taker'): Promise<{ rows?: CandleRecord[] } | void>
  promoteSource?(instId: string, timeframe: HistoryTimeframe, source: 'candles' | 'oi' | 'taker', from: number, through: number, priority: HistoryPriority): Promise<unknown> | void
  /** Owns guarded publication of its forming source observation. */
  latest(instId: string, timeframe: HistoryTimeframe, priority: HistoryPriority, signal?: AbortSignal): Promise<PreparedLatestSourceResult | void>
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
  /** Declare viewport demand and immediately own its hydration, repair, priority and bounded reserve. */
  setFocus(target: { instId: string; timeframe: HistoryTimeframe; endHour?: number } | null, id?: string): void
  prepare(instId: string, timeframe: HistoryTimeframe, targetEnd?: number, historyBars?: number, options?: { focusId?: string }): Promise<PreparedChartResponse>
  /** Pure latest durable read; never starts calculation, changes focus, or schedules source work. */
  local(instId: string, timeframe: HistoryTimeframe, options?: { priority?: HistoryPriority }): Promise<PreparedChartResponse | null>
  /** Pure bounded durable read. Never changes focus or schedules source work. */
  localHistory(instId: string, timeframe: HistoryTimeframe, targetEnd?: number): Promise<PreparedChartResponse | null>
  /** Backend catalog membership owns every supported timeframe, with bounded independent preparation. */
  setUniverse(instIds: string[]): void
  /** Pure renderer hydration of cached frames; never admits work or changes membership. */
  residentFrames(): { frames: PreparedChartResponse[] }
  /** Lightweight collector membership; this never restores or prepares candidate charts. */
  setRealtimeSubscriptions(subscriptions: { instId: string; timeframe: HistoryTimeframe }[]): void
  /** Reassess actual source deadlines after connection or subscription changes. */
  sourceStateChanged(): void
  /** Includes range/input-version indicator failures and their recovery lifecycle. */
  subscribe(listener: (frame: PreparedChartResponse) => void): () => void
  observe(rows: CandleRecord[], previous: Map<number, CandleRecord>): void
  /** Forming candles only change in-memory projections; confirmed writes use observe. */
  setLive(instId: string, timeframe: HistoryTimeframe, candle: CandleRecord | null, context?: { receivedAt?: number }): Promise<PreparedChartResponse | null>
  /** Call after a durable range replacement to reject all prior calculations and snapshots. */
  invalidate(instId: string, timeframe: HistoryTimeframe): void
  observeStatistics(instId: string, timeframe: HistoryTimeframe, from: number, through: number, priority?: HistoryPriority, inputRows?: CandleRecord[], source?: 'oi' | 'taker'): Promise<void>
  /** First pool worker, exposed for worker isolation diagnostics. */
  readonly worker: Worker | null
  dispose(): Promise<void>
}
