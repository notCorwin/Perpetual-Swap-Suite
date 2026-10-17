import type { RadarTimeframe } from './timeframe.ts'

export type Preferences = {
  chartTimeframe: RadarTimeframe
  rankingLookback: number
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
export const DEFAULT_PREFERENCES: Preferences = {
  chartTimeframe: '15m', rankingLookback: 15, historyDays: 30,
  liquidity: {
    spread: { enabled: true, maxPercent: 0.05 },
    depth: { enabled: true, minUSDT: 100_000 },
    slippage: { enabled: true, maxPercent: 0.10, notionalUSDT: 100_000 },
    volume24h: { enabled: true, minUSDT: 30_000_000 },
    openInterest: { enabled: true, minUSDT: 5_000_000 },
    volumeStability: { enabled: false, maxRatio: 2 },
  },
}
export type LiquidityKey = keyof Preferences['liquidity']
export const LIQUIDITY_FIELDS: { key: LiquidityKey; label: string; description: string; parameter: 'maxPercent' | 'minUSDT' | 'maxRatio'; parameterLabel: string }[] = [
  { key: 'spread', label: 'Bid-ask spread', description: 'Spread must be below the limit.', parameter: 'maxPercent', parameterLabel: 'Maximum spread (%)' },
  { key: 'depth', label: 'Order book depth', description: 'Both sides must exceed the minimum.', parameter: 'minUSDT', parameterLabel: 'Minimum depth per side (USDT)' },
  { key: 'slippage', label: 'Slippage', description: 'Estimated slippage must be below the limit for the specified trade size.', parameter: 'maxPercent', parameterLabel: 'Maximum slippage (%)' },
  { key: 'volume24h', label: '24h trading volume', description: 'Quote trading volume must exceed the minimum.', parameter: 'minUSDT', parameterLabel: 'Minimum 24h volume (USDT)' },
  { key: 'openInterest', label: 'Open interest', description: 'USDT notional open interest must exceed the minimum.', parameter: 'minUSDT', parameterLabel: 'Minimum open interest (USDT)' },
  { key: 'volumeStability', label: 'Volume stability', description: 'Maximum / minimum volume across 24 completed hourly intervals must be below the limit.', parameter: 'maxRatio', parameterLabel: 'Maximum hourly volume ratio' },
]
export type PreferencesDraft = {
  chartTimeframe: RadarTimeframe
  rankingLookback: string
  historyDays: string
  liquidity: Record<LiquidityKey, { enabled: boolean; threshold: string }>
  slippageNotional: string
}
export function preferencesDraft(value: Preferences): PreferencesDraft {
  return {
    chartTimeframe: value.chartTimeframe, rankingLookback: String(value.rankingLookback), historyDays: String(value.historyDays),
    liquidity: Object.fromEntries(LIQUIDITY_FIELDS.map(field => [field.key, { enabled: value.liquidity[field.key].enabled, threshold: String((value.liquidity[field.key] as unknown as Record<string, number>)[field.parameter]) }])) as PreferencesDraft['liquidity'],
    slippageNotional: String(value.liquidity.slippage.notionalUSDT),
  }
}
export function validatePreferencesDraft(draft: PreferencesDraft): { values?: Preferences; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const number = (key: string, raw: string, minimum: number, integer = false) => {
    const value = raw.trim() ? Number(raw) : NaN
    if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) errors[key] = `Enter ${integer ? 'a whole number' : 'a number'} of at least ${minimum}.`
    return value
  }
  const rankingLookback = number('rankingLookback', draft.rankingLookback, 5, true)
  if (Number.isFinite(rankingLookback) && rankingLookback % 5 !== 0) errors.rankingLookback = 'Use a multiple of 5 minutes.'
  const historyDays = number('historyDays', draft.historyDays, 1, true)
  const liquidity = Object.fromEntries(LIQUIDITY_FIELDS.map(field => [field.key, {
    enabled: draft.liquidity[field.key].enabled,
    [field.parameter]: number(field.key, draft.liquidity[field.key].threshold, field.parameter === 'minUSDT' ? 0 : Number.MIN_VALUE),
  }])) as Preferences['liquidity']
  // An inactive condition retains valid parameters so it can be enabled later.
  for (const field of LIQUIDITY_FIELDS) if (errors[field.key] && field.parameter !== 'minUSDT') errors[field.key] = 'Enter a number greater than 0.'
  liquidity.slippage.notionalUSDT = number('slippageNotional', draft.slippageNotional, Number.MIN_VALUE)
  if (errors.slippageNotional) errors.slippageNotional = 'Enter a trade size greater than 0.'
  return { values: Object.keys(errors).length ? undefined : { chartTimeframe: draft.chartTimeframe, rankingLookback, historyDays, liquidity }, errors }
}
