import type { MarketStore } from './market-store.js'
import type { NativeMarketRow } from '../../src/rule-engine.ts'
export class MarketService {
  constructor(store: MarketStore, criteria?: () => { hourlyVolumeStabilityEnabled: boolean }, fetcher?: typeof fetch, autoRefresh?: boolean, options?: { requestTimeout?: number })
  [key: string]: any
  invalidate(): void
  refresh(): Promise<void>
  bars(instrument: string, timeframe: '5m' | '15m' | '1H', targetEnd?: number, options?: { hydrate?: boolean; repair?: boolean; statistics?: boolean; foreground?: boolean; focusToken?: number }): Promise<any>
  isHistoryExhausted(instrument: string): boolean
  isActiveChartViewport(instrument: string, timeframe: '5m' | '15m' | '1H', targetEnd?: number): boolean
  focusChart(instrument: string, token: number): boolean
  dispose(): Promise<void>
  snapshot(): { rows: NativeMarketRow[]; revision: number; error: string; loading: boolean }
}
