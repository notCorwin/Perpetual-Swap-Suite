export type ChartTimeframe = '5m' | '15m' | '1H'
export type Preferences = {
  chartTimeframe: ChartTimeframe
  rankingLookback: number
  /** Whole days, from 1 through 3650 inclusive. */
  historyDays: number
  liquidity: {
    spread: { enabled: boolean; maxPercent: number }
    depth: { enabled: boolean; minUSDT: number }
    slippage: { enabled: boolean; maxPercent: number; notionalUSDT: number }
    volume24h: { enabled: boolean; minUSDT: number }
    openInterest: { enabled: boolean; minUSDT: number }
    volumeStability: { enabled: boolean; maxRatio: number }
  }
}
export type PreferencesPatch = {
  chartTimeframe?: ChartTimeframe
  rankingLookback?: number
  historyDays?: number
  liquidity?: { [Rule in keyof Preferences['liquidity']]?: Partial<Preferences['liquidity'][Rule]> }
}
export const DEFAULT_PREFERENCES: Readonly<Preferences>
export function validatePreferences(value: unknown): Preferences
export function validatePreferenceFields(value: unknown, partial?: boolean): void
