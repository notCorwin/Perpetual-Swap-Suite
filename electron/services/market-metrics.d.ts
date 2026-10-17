export type PercentageValue = number | "Infinity" | "-Infinity" | null
export type OpportunityDirection = "Long" | "Short"
export type OpportunitySetup = "Startup" | "Pullback"
export type OpportunityStatus = "Candidate" | "Watch" | "Overheated" | "Incomplete"

export type OpportunityBreakResult = {
  status: "event"
  hour: number
  hoursAgo: number
  priorHour: number
  priorAgeHours: number
  priorPrice: number
  live: boolean
} | { status: "none" | "insufficient-history" | "loading" }

export type OpportunityInput = {
  ema200Signal: OpportunityDirection | "Unsure" | null
  priceChange: PercentageValue
  roc: PercentageValue
  maroc: PercentageValue
  rsi6: number | null
  rsi12: number | null
  rsi24: number | null
  takerRatio: number | null
  oiChange: PercentageValue
  logBBAboveBand: "upper" | "middle" | "lower" | "below" | null
  logBBExpansion: { hours: number; complete: boolean } | null
  highBreakout: OpportunityBreakResult
  lowBreakdown: OpportunityBreakResult
}

export type OpportunityComponents = {
  trend: number
  entry: number
  participation: number
  timing: number
  penalty: number
}

export type OpportunityResult = {
  direction: OpportunityDirection | null
  setup: OpportunitySetup | null
  status: OpportunityStatus
  score: number | null
  components: OpportunityComponents | null
  reasons: string[]
}

export function signedRelativeChange(current: unknown, previous: unknown): number | null
export function takerImbalance(buy: unknown, sell: unknown): number | null
export function bandwidthExpansion(bars: readonly unknown[]): { hours: number; complete: boolean } | null
export function summarizeMarketBars(source: readonly unknown[]): Record<string, unknown>
export function evaluateMarketOpportunity(input: OpportunityInput): OpportunityResult
