import type { MarketStore } from './market-store.js'
import type { NativeMarketRow } from '../../src/rule-engine.ts'
export class MarketService {
  constructor(store: MarketStore, criteria?: () => { hourlyVolumeStabilityEnabled: boolean }, fetcher?: typeof fetch, autoRefresh?: boolean, options?: { requestTimeout?: number })
  [key: string]: any
  invalidate(): void
  restoreCatalog(): Promise<boolean>
  refresh(): Promise<void>
  listRowsFor(timeframe: '5m' | '15m' | '1H'): NativeMarketRow[]
  bars(instrument: string, timeframe: '5m' | '15m' | '1H', targetEnd?: number, options?: { hydrate?: boolean; repair?: boolean; statistics?: boolean; foreground?: boolean; focusToken?: number }): Promise<any>
  isHistoryExhausted(instrument: string): boolean
  isActiveChartViewport(instrument: string, timeframe: '5m' | '15m' | '1H', targetEnd?: number): boolean
  focusChart(instrument: string, token: number): boolean
  dispose(): Promise<void>
  snapshot(timeframe?: '5m' | '15m' | '1H'): Promise<{ rows: NativeMarketRow[]; revision: number; error: string; loading: boolean; updatedAt: number | null; timeframe: '5m' | '15m' | '1H'; catalogSource: 'none' | 'cache' | 'live'; listProgress: { total: number; completed: number; pending: number; retrying: number; unavailable: number } }>
}
