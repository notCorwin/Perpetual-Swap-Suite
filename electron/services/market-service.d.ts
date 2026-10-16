import type { MarketStore } from './market-store.js'
import type { NativeMarketRow } from '../../src/rule-engine.ts'
export class MarketService {
  constructor(store: MarketStore, criteria?: () => { hourlyVolumeStabilityEnabled: boolean }, fetcher?: typeof fetch)
  invalidate(): void
  refresh(): Promise<void>
  bars(instrument: string, timeframe: '5m' | '15m' | '1H', targetEnd?: number): Promise<unknown[]>
  isHistoryExhausted(instrument: string): boolean
  snapshot(): { rows: NativeMarketRow[]; revision: number; error: string; loading: boolean }
}
