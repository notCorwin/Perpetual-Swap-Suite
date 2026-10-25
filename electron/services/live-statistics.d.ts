import type { CandleRecord } from './market-store.js'

export type LiveTrade = {
  instId?: string
  tradeId: string
  side: 'buy' | 'sell'
  /** Aggregate contract amount; count must not multiply it. */
  sz: string | number
  ts: string | number
  count?: string | number
}
export type LiveOpenInterest = {
  instId?: string
  /** Contracts, not the base-asset or USDT notional fields. */
  oi: string | number
  ts: string | number
  [key: string]: unknown
}
export class LiveStatistics {
  constructor(options?: { now?: () => number })
  /** Begin uninterrupted trade coverage when subscribe is acknowledged. */
  start(instId: string, receivedAt?: number): void
  /** Forget delisted instruments, including their previous subscription coverage. */
  remove(instIds: string[]): void
  disconnect(instIds: string[], receivedAt?: number): void
  trades(instId: string, rows: LiveTrade[], receivedAt?: number): void
  openInterest(instId: string, observation: LiveOpenInterest, receivedAt?: number): void
  /** Copy a candle and add only trustworthy native-period observations. */
  enrich<T extends CandleRecord>(candle: T, receivedAt?: number): T
  canFinalize(candle: CandleRecord, receivedAt?: number): boolean
}
