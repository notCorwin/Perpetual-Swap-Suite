import type { RealtimeMarketState, WebSocketFactory } from './realtime-market.js'

export const OKX_PUBLIC_WEBSOCKET_URL: 'wss://ws.okx.com/ws/v5/public'
export const PUBLIC_MARKET_CONTRACTS_PER_CONNECTION: 25
export type PublicMarketChannel = 'tickers' | 'open-interest' | 'books' | 'trades'
export type PublicMarketRawRecord = Record<string, string | number>
export type PublicInstrumentRecord = Record<string, unknown>
export type PublicMarketSubscription = { instId: string; channel: PublicMarketChannel } | { channel: 'instruments'; instType: 'SWAP' }
export type PublicMarketBook = { bids: string[][]; asks: string[][]; ts: string; seqId: number }
export type PublicMarketEventContext = { signal: AbortSignal; receivedAt: number }
export type RealtimePublicMarketTelemetry = {
  receivedEvents: number
  tickerEvents: number
  openInterestEvents: number
  bookEvents: number
  tradeEvents: number
  ignoredEvents: number
  rejectedEvents: number
  reconnects: number
  pendingEvents: number
  lastReceivedAt: number | null
}
export type RealtimePublicMarketOptions = {
  /** Enables the global SWAP instruments stream, retained when the universe is empty. */
  onInstruments?: (raw: PublicInstrumentRecord[], context: PublicMarketEventContext) => void | Promise<void>
  /** Fires after each matching instruments ack; bootstrap work does not block events. */
  onInstrumentsReady?: (context: PublicMarketEventContext) => void | Promise<void>
  /** Fires when the control socket retires, even before its acknowledgement. */
  onInstrumentsDisconnect?: (context: PublicMarketEventContext) => void | Promise<void>
  onTicker: (instId: string, raw: PublicMarketRawRecord, context: PublicMarketEventContext) => void | Promise<void>
  onOpenInterest: (instId: string, raw: PublicMarketRawRecord, context: PublicMarketEventContext) => void | Promise<void>
  /** Full 400-level book, reconstructed from native snapshots and updates. */
  onBook: (instId: string, book: PublicMarketBook, context: PublicMarketEventContext) => void | Promise<void>
  onTrades: (instId: string, raw: PublicMarketRawRecord[], context: PublicMarketEventContext) => void | Promise<void>
  onSubscribed?: (instId: string, channel: PublicMarketChannel, context: PublicMarketEventContext) => void | Promise<void>
  /** Called only for the contracts on the retired socket; its signal is aborted. */
  onDisconnect?: (instIds: string[], context: { signal: AbortSignal }) => void | Promise<void>
  /** New-connection events wait until this recovery callback completes. */
  onReconnect?: (instIds: string[], context: { signal: AbortSignal }) => void | Promise<void>
  onState?: (state: RealtimeMarketState) => void | Promise<void>
  webSocketFactory?: WebSocketFactory
  url?: string
  logger?: Pick<Console, 'error'>
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => unknown
  clearTimeout?: (handle: unknown) => void
  random?: () => number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  reconnectJitter?: number
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
  connectTimeoutMs?: number
  subscriptionTimeoutMs?: number
  closeTimeoutMs?: number
}
export class RealtimePublicMarket {
  constructor(options: RealtimePublicMarketOptions)
  readonly instruments: Set<string>
  readonly subscriptions: Map<string, PublicMarketSubscription>
  /** Subscribes every instrument to tickers, open-interest, books, and trades. */
  setSubscriptions(instIds: string[]): void
  start(): void
  getState(): RealtimeMarketState
  getTelemetry(): RealtimePublicMarketTelemetry
  whenIdle(): Promise<void>
  /** Irreversible idempotent shutdown; drains accepted callbacks and decoding. */
  close(): Promise<void>
}
