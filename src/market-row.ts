import type { OpportunityResult } from "./market-opportunity.ts"
import type { BreakResult } from "./market-breaks.ts"
import type { BandWidthExpansion, LogBBAboveBand } from "./market-logbb.ts"
import type { PercentageValue } from "./market-percent.ts"
import type { EMA200Signal } from "./market-sort.ts"

export type MarketRow = {
  instId: string
  turnover24hUSDT: number | null
  ema200Signal: EMA200Signal | null
  price: number | null
  lastPrice?: number | null
  priceChange: PercentageValue
  currentLow: number | null
  currentHigh: number | null
  buy: number | null
  sell: number | null
  takerRatio: number | null
  oiChange: PercentageValue
  highBreakout: BreakResult
  lowBreakdown: BreakResult
  highBreakout96: BreakResult
  lowBreakdown96: BreakResult
  roc: PercentageValue
  maroc: PercentageValue
  rsi6: number | null
  rsi12: number | null
  rsi24: number | null
  logBBAboveBand: LogBBAboveBand | null
  logBBExpansion: BandWidthExpansion | null
  rocChange: PercentageValue
  marocChange: PercentageValue
}

export type NativeMarketRow = MarketRow & { opportunity: OpportunityResult }
