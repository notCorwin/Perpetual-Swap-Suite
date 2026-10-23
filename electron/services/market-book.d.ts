export type BookValue = {
  readonly bids: readonly (readonly unknown[])[]
  readonly asks: readonly (readonly unknown[])[]
  readonly [key: string]: unknown
}
export type BookObservation = {
  readonly value: BookValue
  readonly observedAt: number
  readonly expiresAt: number
  readonly [key: string]: unknown
}
export type BookGet = (path: string, parameters: Record<string, string>, signal: AbortSignal, priority: string) => Promise<unknown>

export class MarketBook {
  constructor(get: BookGet, now?: () => number)
  /** Fresh supplied memory bypasses REST without changing its original timestamps. */
  observe(instId: string, signal?: AbortSignal, priority?: string, currentObservation?: BookObservation | null): Promise<BookObservation>
  /** Clears the cache and rejects active waiters; call for metadata/delist/WS replacement. */
  invalidate(instId: string): void
  /** Rejects all active and future callers. Idempotent. */
  dispose(): void
}
