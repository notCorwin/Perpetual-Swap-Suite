import type { RealtimeMarketState, WebSocketFactory } from './realtime-market.js'

export const OKX_PUBLIC_WEBSOCKET_URL: 'wss://ws.okx.com/ws/v5/public'
export const PUBLIC_MARKET_CONTRACTS_PER_CONNECTION: 25
export type PublicMarketChannel = 'tickers' | 'open-interest' | 'books' | 'trades'
export type PublicMarketRawRecord = Record<string, string | number>
export type PublicInstrumentRecord = Record<string, unknown>
export type PublicMarketSubscription = { instId: string; channel: PublicMarketChannel } | { channel: 'instruments'; instType: 'SWAP' }
export type PublicMarketChannelDemand = {
  /** Defaults to true. Disable when neither depth nor slippage needs books. */
  books?: boolean
}
export type PublicMarketBook = { bids: (readonly string[])[]; asks: (readonly string[])[]; ts: string; seqId: number }
export type PublicMarketEventContext = {
  /** Socket lifetime, or the individual subscription lifetime for books/tickers. */
  signal: AbortSignal
  receivedAt: number
  /** Subscription proof captured before callback queuing. */
  acknowledged?: boolean
}
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
  /** Full 400-level snapshot with immutable levels shared across unchanged prices. */
  onBook: (instId: string, book: PublicMarketBook, context: PublicMarketEventContext) => void | Promise<void>
  onTrades: (instId: string, raw: PublicMarketRawRecord[], context: PublicMarketEventContext) => void | Promise<void>
  onSubscribed?: (instId: string, channel: PublicMarketChannel, context: PublicMarketEventContext) => void | Promise<void>
  /** Synchronous invalidation on removal or book recovery; that book's signal is then aborted. */
  onUnsubscribed?: (instId: string, channel: PublicMarketChannel, context: PublicMarketEventContext) => void | Promise<void>
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
  /** Initial transport reconnect and single-book recovery delay (default 1s). */
  reconnectBaseMs?: number
  /** Maximum retry delay and healthy-book backoff reset interval (default 30s). */
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
  /** Always retains tickers, open-interest, and trades; books follow demand. */
  setSubscriptions(instIds: string[], demand?: PublicMarketChannelDemand): void
  start(): void
  getState(): RealtimeMarketState
  /** Replace only this native subscription; respects shared control limits. */
  recoverSubscription(instId: string, channel: PublicMarketChannel): boolean
  getTelemetry(): RealtimePublicMarketTelemetry
  whenIdle(): Promise<void>
  /** Irreversible idempotent shutdown; drains accepted callbacks and decoding. */
  close(): Promise<void>
}
