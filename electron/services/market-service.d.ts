import type { MarketStore } from './market-store.js'
import type { NativeMarketRow } from '../../src/rule-engine.ts'
import type { PreparedChartResponse } from '../../src/chart-data.ts'
export type { PreparedChartBar } from '../../src/chart-data.ts'
export type PreparedChartWindow = PreparedChartResponse
export class MarketService {
  constructor(store: MarketStore, criteria?: () => { hourlyVolumeStabilityEnabled: boolean }, fetcher?: typeof fetch, autoRefresh?: boolean, options?: { requestTimeout?: number })
  [key: string]: any
  invalidate(): void
  restoreCatalog(): Promise<boolean>
  refresh(): Promise<void>
  listRowsFor(timeframe: '5m' | '15m' | '1H'): NativeMarketRow[]
  prepareChartWindow(instId: string, timeframe: '5m' | '15m' | '1H', end?: number): Promise<PreparedChartWindow>
  dispose(): Promise<void>
  snapshot(timeframe?: '5m' | '15m' | '1H'): Promise<{ rows: NativeMarketRow[]; revision: number; error: string; loading: boolean; updatedAt: number | null; timeframe: '5m' | '15m' | '1H'; catalogSource: 'none' | 'cache' | 'live'; listProgress: { total: number; completed: number; pending: number; retrying: number; unavailable: number } }>
}
