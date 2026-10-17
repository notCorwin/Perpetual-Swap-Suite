/** Normalized candle; timestamp is the opening time in epoch milliseconds. */
export type RankingCandle = {
  timestamp: number
  timeframe: string
  confirmed: boolean
  close: number
  /** When supplied, every candle in the required path must use the same ID. */
  instrument?: string
}

export type RankingResult = {
  /** Signed Relative Change in percent, or null when the full path is invalid. */
  rankingChange: number | null
  /** Completed close boundary in epoch milliseconds, or null when unavailable. */
  rankingAsOf: number | null
}

/**
 * Requires confirmed native '5m' candles from baseline through current close,
 * including every intermediate interval exactly once. lookbackMinutes must be
 * a positive multiple of 5; asOf is epoch milliseconds. The current candle opens
 * at floor(asOf / 300000) * 300000 - 300000. Records outside the required path
 * do not contribute, but every record must have a valid numeric timestamp.
 * Zero baselines and non-finite results are unavailable. Inputs are not mutated.
 */
export function rankingFromCandles(candles: readonly RankingCandle[], lookbackMinutes: number, asOf: number): RankingResult

export type RankedInstrument = { instId: string; rankingChange: number | null }

/** Absolute change descending; unavailable last; ties use code-point ID order. */
export function compareRanking(left: RankedInstrument, right: RankedInstrument): number
