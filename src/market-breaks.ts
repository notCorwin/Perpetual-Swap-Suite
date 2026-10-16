export type BreakEvent = {
  status: "event"
  hour: number
  hoursAgo: number
  priorHour: number
  priorAgeHours: number
  priorPrice: number
  live: boolean
}

export type BreakResult = BreakEvent | { status: "none" | "insufficient-history" | "loading" }
export type BreakDirection = "high" | "low"

export const BREAK_DESCRIPTION = "Shows the latest break among the current candle and the previous 47 candles. Each candle must strictly exceed the high or fall below the low of its preceding 48 completed candles. Prior age is measured in candles at the break, using the most recent occurrence of a tied extreme."

const timeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 })

export function formatBreakTime(result: BreakResult, timeframe: RadarTimeframe = '1H'): string {
  if (result.status === "loading") return "Loading"
  return result.status === "event" ? result.live ? "Live" : timeframe === '1H' ? `${result.hoursAgo}h ago` : `${result.hoursAgo} × ${timeframeLabel(timeframe)} ago` : "—"
}

export function formatBreakPriorAge(result: BreakResult, timeframe: RadarTimeframe = '1H'): string {
  return result.status === "event" ? timeframe === '1H' ? `${result.priorAgeHours}h old` : `${result.priorAgeHours} × ${timeframeLabel(timeframe)} old` : "—"
}

export function describeBreak(result: BreakResult, direction: BreakDirection, timeframe: RadarTimeframe = '1H'): string {
  const label = direction === "high" ? "High breakout" : "Low breakdown"
  const extreme = direction === "high" ? "high" : "low"
  if (timeframe === '1H') switch (result.status) {
    case "none": return `No ${direction === "high" ? "breakout" : "breakdown"} in the last 48h`
    case "insufficient-history": return `${label}: insufficient history. At least 48 completed hourly candles since listing are required.`
    case "loading": return `${label}: loading hourly candles. Waiting for complete, confirmed history to identify the latest break.`
    case "event": return `${label} during ${timeFormatter.format(result.hour)} – ${timeFormatter.format(result.hour + timeframeMilliseconds(timeframe))}. Previous 48h ${extreme}: ${priceFormatter.format(result.priorPrice)}, formed during the hour starting ${timeFormatter.format(result.priorHour)}; ${result.priorAgeHours}h old at the break.${result.live ? " Current candle is live." : ""}`
  }
  switch (result.status) {
    case "none": return `No ${direction === "high" ? "breakout" : "breakdown"} in the last 48 candles`
    case "insufficient-history": return `${label}: insufficient history. At least 48 completed ${timeframeLabel(timeframe)} candles since listing are required.`
    case "loading": return `${label}: loading ${timeframeLabel(timeframe)} candles. Waiting for complete, confirmed history to identify the latest break.`
    case "event": return `${label} during ${timeFormatter.format(result.hour)} – ${timeFormatter.format(result.hour + timeframeMilliseconds(timeframe))}. Previous 48-candle ${extreme}: ${priceFormatter.format(result.priorPrice)}, formed in the candle starting ${timeFormatter.format(result.priorHour)}; ${result.priorAgeHours} candles old at the break.${result.live ? " Current candle is live." : ""}`
  }
}
import { timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'
