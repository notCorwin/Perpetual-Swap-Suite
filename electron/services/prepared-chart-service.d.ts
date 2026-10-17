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
  })
  prepare(instId: string, timeframe: HistoryTimeframe, targetEnd?: number): Promise<PreparedChartResponse>
  local(instId: string, timeframe: HistoryTimeframe, options?: { force?: boolean; priority?: HistoryPriority }): Promise<PreparedChartResponse | null>
  /** Fully prepared durable navigation history; never queues an HTTP request. */
  localHistory(instId: string, timeframe: HistoryTimeframe, targetEnd?: number): Promise<PreparedChartResponse | null>
  projectSeries(instId: string, timeframe: HistoryTimeframe): Promise<{ end: number | null; bars: Bar[] }>
  setUniverse(instIds: string[], timeframe: HistoryTimeframe, focusInstId?: string): { frames: PreparedChartResponse[] }
  subscribe(listener: (frame: PreparedChartResponse) => void): () => void
  observe(rows: CandleRecord[], previous: Map<number, CandleRecord>): void
  /** Forming candles only change in-memory projections; confirmed writes use observe. */
  setLive(instId: string, timeframe: HistoryTimeframe, candle: CandleRecord | null): Promise<PreparedChartResponse | null>
  /** Call after a durable range replacement to reject all prior calculations and snapshots. */
  invalidate(instId: string, timeframe: HistoryTimeframe): void
  dispose(): Promise<void>
}
