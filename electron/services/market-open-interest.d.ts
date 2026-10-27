export type OpenInterestObservation = {
  value: { instId: string; oiUsd: string | number; [key: string]: unknown }
  observedAt: number
  expiresAt: number
}
export type OpenInterestGet = (path: string, parameters: Record<string, string>, signal: AbortSignal, priority: string) => Promise<unknown>

export class MarketOpenInterest {
  constructor(get: OpenInterestGet, now?: () => number)
  /** Shared retry deadline in epoch milliseconds; zero after success. */
  readonly retryAt: number
  /** Fresh snapshots retain their original 90-second lease. Force never bypasses a retry deadline. */
  observe(signal?: AbortSignal, priority?: string, force?: boolean): Promise<Map<string, OpenInterestObservation>>
}
