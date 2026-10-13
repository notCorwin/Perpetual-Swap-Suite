import type { BreakResult } from "./market-breaks.ts"
import type { BandWidthExpansion, LogBBAboveBand } from "./market-logbb.ts"
import type { PercentageValue } from "./market-percent.ts"
import type { EMA200Signal } from "./market-sort.ts"

export type MarketFilterMetrics = {
  liveOpen: number | null
  liveClose: number | null
  ema200: number | null
  previousEMA200: number | null
  vwap14: number | null
  bbUpper: number | null
  bbMiddle: number | null
  bbLower: number | null
  priorHigh48: number | null
  priorLow48: number | null
  priorHigh96: number | null
  priorLow96: number | null
  oiUSD: number | null
  spreadPercent: number | null
  liveVolumeUSDT: number | null
}

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
  filterMetrics: MarketFilterMetrics
}
