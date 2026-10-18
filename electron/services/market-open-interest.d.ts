export type OpenInterestObservation = {
  value: { instId: string; oiUsd: string | number; [key: string]: unknown }
  observedAt: number
  expiresAt: number
}
export type OpenInterestGet = (path: string, parameters: Record<string, string>, signal: AbortSignal, priority: string) => Promise<unknown>

export class MarketOpenInterest {
  constructor(get: OpenInterestGet, now?: () => number)
  observe(signal?: AbortSignal, priority?: string, force?: boolean): Promise<Map<string, OpenInterestObservation>>
}
