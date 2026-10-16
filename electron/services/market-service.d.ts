import type { MarketStore } from './market-store.js'
import type { NativeMarketRow } from '../../src/rule-engine.ts'
export class MarketService {
  constructor(store: MarketStore, criteria?: () => { hourlyVolumeStabilityEnabled: boolean }, fetcher?: typeof fetch)
  invalidate(): void
  refresh(): Promise<void>
  snapshot(): { rows: NativeMarketRow[]; revision: number; error: string; loading: boolean }
}
