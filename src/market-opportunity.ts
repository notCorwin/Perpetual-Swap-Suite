import type { BreakResult } from "./market-breaks.ts"
import { logBBBandRank, type BandWidthExpansion, type LogBBAboveBand } from "./market-logbb.ts"
import { finitePercentage, type PercentageValue } from "./market-percent.ts"
import type { EMA200Signal } from "./market-sort.ts"

export type OpportunityDirection = "Long" | "Short"
export type OpportunitySetup = "Startup" | "Pullback"
export type OpportunityStatus = "Candidate" | "Watch" | "Overheated" | "Incomplete"

export type OpportunityInput = {
  ema200Signal: EMA200Signal | null
  priceChange: PercentageValue
  roc: PercentageValue
  maroc: PercentageValue
  rsi6: number | null
  rsi12: number | null
  rsi24: number | null
  takerRatio: number | null
  oiChange: PercentageValue
  logBBAboveBand: LogBBAboveBand | null
  logBBExpansion: BandWidthExpansion | null
  highBreakout: BreakResult
  lowBreakdown: BreakResult
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

export const OPPORTUNITY_DESCRIPTION = "Live 1h opportunity ranking: Candidate, Watch, Overheated, then Incomplete. Long and Short use the same directional rules. Scores may change before the hour closes. Open a score for its setup, scoring breakdown and reasons."

export const opportunityStatusRank: Record<OpportunityStatus, number> = {
  Candidate: 3, Watch: 2, Overheated: 1, Incomplete: 0,
}

function finiteInRange(value: number | null, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null
}

function cappedBonus(value: number | null, maximum: number): number {
  return value === null ? 0 : 10 * Math.min(1, Math.max(0, value / maximum))
}

export function evaluateMarketOpportunity(input: OpportunityInput): OpportunityResult {
  const direction = input.ema200Signal === "Long" || input.ema200Signal === "Short" ? input.ema200Signal : null
  const price = finitePercentage(input.priceChange)
  const roc = finitePercentage(input.roc)
  const maroc = finitePercentage(input.maroc)
  const rsi6 = finiteInRange(input.rsi6, 0, 100)
  const rsi12 = finiteInRange(input.rsi12, 0, 100)
  const rsi24 = finiteInRange(input.rsi24, 0, 100)
  const band = input.logBBAboveBand == null ? undefined : logBBBandRank[input.logBBAboveBand]
  const expansion = input.logBBExpansion
  const validExpansion = expansion != null && Number.isSafeInteger(expansion.hours) && expansion.hours >= 0 && typeof expansion.complete === "boolean" ? expansion : null
  const taker = finiteInRange(input.takerRatio, -100, 100)
  const oi = finitePercentage(input.oiChange)
  const missing: string[] = []
  if (direction === null && input.ema200Signal !== "Unsure") missing.push("EMA200 is unavailable or invalid.")
  for (const [label, value] of [["Price change", price], ["ROC", roc], ["MAROC", maroc], ["RSI6", rsi6], ["RSI12", rsi12], ["RSI24", rsi24]] as const) {
    if (value === null) missing.push(`${label} is unavailable or invalid.`)
  }
  if (typeof band !== "number") missing.push("Log BB position is unavailable or invalid.")
  if (validExpansion === null) missing.push("Log BB expansion is unavailable or invalid.")
  const optionalReasons: string[] = []
  if (taker === null) optionalReasons.push("Taker imbalance is unavailable or invalid; its participation bonus is zero.")
  if (oi === null) optionalReasons.push("OI change is unavailable or non-finite; its participation bonus is zero.")
  if (missing.length || price === null || roc === null || maroc === null || rsi6 === null || rsi12 === null || rsi24 === null || typeof band !== "number" || validExpansion === null) {
    return { direction, setup: null, status: "Incomplete", score: null, components: null, reasons: [...missing, ...optionalReasons] }
  }
  if (direction === null) {
    return {
      direction: null, setup: null, status: "Watch", score: 0,
      components: { trend: 0, entry: 0, participation: 0, timing: 0, penalty: 0 },
      reasons: ["The live candle body crosses or touches EMA200; direction is unclear.", ...optionalReasons],
    }
  }

  const sign = direction === "Long" ? 1 : -1
  const directionalPrice = sign * price, directionalROC = sign * roc, directionalMAROC = sign * maroc
  const directionalTaker = taker === null ? null : sign * taker
  const fast = direction === "Long" ? rsi6 : 100 - rsi6
  const medium = direction === "Long" ? rsi12 : 100 - rsi12
  const slow = direction === "Long" ? rsi24 : 100 - rsi24
  const position = direction === "Long" ? band : 3 - band
  const { hours, complete } = validExpansion
  const priceConfirms = directionalPrice > 0
  const takerConfirms = directionalTaker !== null && directionalTaker > 0
  const startup = slow > 50 && directionalROC >= directionalMAROC && directionalMAROC > 0 &&
    fast >= 50 && fast < 75 && medium >= 50 && medium < 70 && fast > medium && position >= 2 &&
    complete && hours >= 1 && hours <= 3 && (priceConfirms || takerConfirms)
  const pullback = slow > 50 && directionalMAROC > 0 && fast >= 40 && fast <= 60 &&
    medium >= 45 && medium <= 65 && fast <= medium && (position === 1 || position === 2) &&
    priceConfirms && takerConfirms
  const setup = startup ? "Startup" : pullback ? "Pullback" : null
  const reasons = [`The live candle body is ${direction === "Long" ? "above" : "below"} EMA200.`]
  if (directionalROC > 0) reasons.push("ROC supports the direction.")
  if (directionalMAROC > 0) reasons.push("MAROC supports the direction.")
  if (slow > 50) reasons.push("RSI24 supports the direction.")
  if (setup === "Startup") reasons.push("Startup: strengthening momentum with a complete 1–3h expansion.")
  else if (setup === "Pullback") reasons.push("Pullback: RSI cooling inside Log BB with price and taker confirmation.")
  else reasons.push("No Startup or Pullback setup matches the live readings.")
  if (priceConfirms && takerConfirms) reasons.push("Price and taker flow both confirm the direction.")
  else if (priceConfirms || takerConfirms) reasons.push(`Only ${priceConfirms ? "price" : "taker flow"} confirms the direction.`)
  else reasons.push("Neither price nor taker flow confirms the direction.")
  if (taker !== null) reasons.push(takerConfirms ? "Same-direction taker participation adds up to 10 points, capped at 20%." : "Taker flow adds no participation bonus.")
  if (oi !== null) reasons.push(oi > 0 ? "Rising OI value adds up to 10 points, capped at 5%; it does not determine direction." : "Flat or falling OI value adds no participation bonus.")
  reasons.push(...optionalReasons)

  const event = direction === "Long" ? input.highBreakout : input.lowBreakdown
  let breakBonus = 0
  if (event?.status === "event" && Number.isSafeInteger(event.hoursAgo) && event.hoursAgo >= 0) {
    breakBonus = event.hoursAgo <= 3 ? 10 : event.hoursAgo <= 12 ? 5 : 0
    if (breakBonus) reasons.push(`${direction === "Long" ? "High breakout" : "Low breakdown"} ${event.hoursAgo}h ago supports entry timing.`)
  } else if (event?.status === "loading" || event?.status === "insufficient-history") {
    reasons.push("Same-direction break history is incomplete; no break timing bonus.")
  }
  let expansionBonus = 0
  if (complete) {
    if (setup === "Pullback") expansionBonus = hours <= 2 ? 10 : hours <= 5 ? 5 : 0
    else expansionBonus = hours >= 1 && hours <= 3 ? 10 : hours >= 4 && hours <= 6 ? 5 : 0
    if (expansionBonus) reasons.push(`A complete ${hours}h expansion supports ${setup === "Pullback" ? "pullback" : "early-entry"} timing.`)
  } else reasons.push(`Expansion is a lower bound (≥ ${hours}h); no expansion timing bonus.`)

  let penalty = 0
  if (fast >= 70) {
    penalty += 10
    reasons.push(`RSI6 ${direction === "Long" ? "≥ 70" : "≤ 30"}: fast momentum is stretched (−10).`)
  }
  if (medium >= 65) {
    penalty += 10
    reasons.push(`RSI12 ${direction === "Long" ? "≥ 65" : "≤ 35"}: medium momentum is stretched (−10).`)
  }
  if (position === 3) {
    penalty += 10
    reasons.push(`Price is ${direction === "Long" ? "above the upper" : "at or below the lower"} Log BB band (−10).`)
  }
  if (hours >= 4) {
    penalty += 10
    reasons.push(`Expansion has lasted ${complete ? "" : "at least "}${hours}h (−10).`)
  }
  const extremeRSI = fast >= 80 && medium >= 70
  const stretchedBand = position === 3 && fast >= 75
  const extendedBand = position === 3 && hours >= 6 && medium >= 65
  const overheated = extremeRSI || stretchedBand || extendedBand
  if (extremeRSI) reasons.push("RSI6 and RSI12 are extreme together: Overheated.")
  if (stretchedBand) reasons.push("An outer-band reading combines with extreme RSI6: Overheated.")
  if (extendedBand) reasons.push("Outer-band price, extended expansion and elevated RSI12 combine: Overheated.")

  const components: OpportunityComponents = {
    trend: 15 + (directionalROC > 0 ? 5 : 0) + (directionalMAROC > 0 ? 5 : 0) + (slow > 50 ? 5 : 0),
    entry: (setup === null ? 0 : 20) + (priceConfirms && takerConfirms ? 10 : priceConfirms || takerConfirms ? 5 : 0),
    participation: cappedBonus(directionalTaker, 20) + cappedBonus(oi, 5),
    timing: breakBonus + expansionBonus,
    penalty,
  }
  const score = Math.round(Math.max(0, Math.min(100, components.trend + components.entry + components.participation + components.timing - penalty)))
  const status = overheated ? "Overheated" : setup !== null && score >= 65 ? "Candidate" : "Watch"
  if (!overheated && setup !== null && score < 65) reasons.push("The entry setup is below the 65-point Candidate threshold.")
  return { direction, setup, status, score, components, reasons }
}
