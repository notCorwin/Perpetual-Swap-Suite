export type LogBBAboveBand = "upper" | "middle" | "lower" | "below"
export type BandWidthExpansion = { hours: number; complete: boolean }

export const LOG_BB_DESCRIPTION = "The highest Log BB (20) band strictly below the live price. Upper takes precedence over Middle, then Lower. Equal prices do not count as above."
export const BANDWIDTH_EXPANSION_DESCRIPTION = "Consecutive candle-to-candle increases in Band Width ((Upper − Lower) / Middle × 100%), including the current live candle. Flat or shrinking width resets to 0. The live candle can change before it closes. ≥ means older history is needed to establish the start."

export const logBBBandRank: Record<LogBBAboveBand, number> = { upper: 3, middle: 2, lower: 1, below: 0 }

export function formatLiveBand(band: LogBBAboveBand | null): string {
  if (band === null) return "—"
  if (band === "below") return "≤ Lower"
  return `> ${band[0].toUpperCase()}${band.slice(1)}`
}

export function formatBandWidthExpansion(expansion: BandWidthExpansion | null, timeframe: RadarTimeframe = '1H'): string {
  return expansion === null ? "—" : `${expansion.complete ? "" : "≥ "}${expansion.hours}${timeframe === '1H' ? 'h' : ` × ${timeframeLabel(timeframe)}`}`
}
import { timeframeLabel, type RadarTimeframe } from './timeframe.ts'
