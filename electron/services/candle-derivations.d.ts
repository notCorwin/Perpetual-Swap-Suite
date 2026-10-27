import type { CandleRecord, MarketStore } from './market-store.js'
export class CandleDerivations {
  constructor(options: { store: Pick<MarketStore, 'candles'>; onLive(instId: string, timeframe: string, row: CandleRecord | null, context: { receivedAt?: number }): unknown })
  observe(row: CandleRecord, context?: { receivedAt?: number }): Promise<void>
  correct(instId: string, rows: CandleRecord[], replacement?: { from: number; through: number }): void
  remove(instIds: Iterable<string>): void
  close(): void
}
