export type Preferences = {
  chartDisplayMode: 'multi' | 'indicators'
  showBollingerPriceLabels: boolean
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
  chartDisplayMode?: 'multi' | 'indicators'
  showBollingerPriceLabels?: boolean
  rankingLookback?: number
  historyDays?: number
  liquidity?: { [Rule in keyof Preferences['liquidity']]?: Partial<Preferences['liquidity'][Rule]> }
}
export const CHART_PRIMARY_TIMEFRAME: '1H'
export const DEFAULT_PREFERENCES: Readonly<Preferences>
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
export type PreferenceSnapshot = Immutable<Preferences>
export function validatePreferences(value: unknown): PreferenceSnapshot
export function validatePreferenceFields(value: unknown, partial?: boolean): void
