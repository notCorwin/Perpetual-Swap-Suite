import type { CandleRecord } from './market-store.js'
import type { RadarTimeframe } from '../../src/timeframe.ts'

export const OKX_BUSINESS_WEBSOCKET_URL: 'wss://ws.okx.com/ws/v5/business'
export type RealtimeSubscription = { instId: string; timeframe: RadarTimeframe }
export type RealtimeMarketState = {
  status: 'connecting' | 'live' | 'reconnecting' | 'disconnected'
  /** Local receive time of the last successfully published candle event. */
  updatedAt: number | null
  error: string
}
export type RealtimeMarketTelemetry = {
  receivedEvents: number
  formingEvents: number
  confirmedEvents: number
  ignoredEvents: number
  rejectedEvents: number
  reconnects: number
  pendingEvents: number
  lastReceivedAt: number | null
  /** Receive-to-callback-start latency, including per-series queue time. */
  lastDispatchLatencyMs: number | null
  maxDispatchLatencyMs: number
  /** Receive-to-callback-completion latency, including durable writes. */
  lastCallbackLatencyMs: number | null
  maxCallbackLatencyMs: number
}
export interface RealtimeWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, callback: EventListener): void
  removeEventListener(type: string, callback: EventListener): void
}
export type WebSocketFactory = (url: string) => RealtimeWebSocket
export type RealtimeEventContext = { signal: AbortSignal; receivedAt: number }
export type RealtimeMarketOptions<Candle extends CandleRecord = CandleRecord> = {
  parseCandle: (instId: string, timeframe: RadarTimeframe, raw: string[]) => Candle | null
  /** Memory projection only. Same-volume OHLC corrections follow receive order. */
  onForming: (candle: Candle, context: RealtimeEventContext) => void | Promise<void>
  /** Must resolve after durable ingestion/publication. Close drains, rather than aborts, accepted writes. */
  onConfirmed: (candle: Candle, context: RealtimeEventContext) => void | Promise<void>
  /** Repairs gaps alongside live delivery; failures retry without closing a healthy socket.
   * Must coordinate durable mutations with onConfirmed. Close aborts and drains repairs.
   */
  onReconnect: (subscriptions: RealtimeSubscription[], context: { signal: AbortSignal }) => void | Promise<void>
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
  /** Bounded recent-revision deduplication. Durable ingestion must be idempotent. */
  confirmationCacheSize?: number
}
export class RealtimeMarket<Candle extends CandleRecord = CandleRecord> {
  constructor(options: RealtimeMarketOptions<Candle>)
  setSubscriptions(subscriptions: RealtimeSubscription[]): void
  start(): void
  getState(): RealtimeMarketState
  getTelemetry(): RealtimeMarketTelemetry
  getForming(instId: string, timeframe: RadarTimeframe): Candle | null
  /** Drains accepted decoding, recovery and consumer callbacks; does not close. */
  whenIdle(): Promise<void>
  /** Irreversible, idempotent shutdown barrier; aborts recovery and drains writes. */
  close(): Promise<void>
}
