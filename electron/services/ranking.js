import { signedRelativeChange } from './market-metrics.js'

const FIVE_MINUTES_MS = 300_000

const unavailable = () => ({ rankingChange: null, rankingAsOf: null })

/**
 * Rank from confirmed native 5m candles, whose timestamps are opening times in
 * epoch milliseconds. The close boundary at or immediately before asOf is the
 * current endpoint; no forming candle or chart timeframe participates.
 */
export function rankingFromCandles(candles, lookbackMinutes, asOf) {
  if (!Array.isArray(candles)
    || !Number.isSafeInteger(lookbackMinutes) || lookbackMinutes <= 0 || lookbackMinutes % 5 !== 0
    || !Number.isSafeInteger(asOf) || asOf < 0) return unavailable()

  const lookbackMS = lookbackMinutes * 60_000
  if (!Number.isSafeInteger(lookbackMS)) return unavailable()

  const rankingAsOf = Math.floor(asOf / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
  const latestOpen = rankingAsOf - FIVE_MINUTES_MS
  const baselineOpen = latestOpen - lookbackMS
  const requiredCount = lookbackMinutes / 5 + 1
  if (baselineOpen < 0 || requiredCount > candles.length) return unavailable()

  const path = new Map()
  let instrument
  for (const candle of candles) {
    if (candle === null || typeof candle !== 'object' || Array.isArray(candle)
      || !Number.isSafeInteger(candle.timestamp)) return unavailable()
    if (candle.timestamp < baselineOpen || candle.timestamp > latestOpen) continue
    if (candle.timestamp % FIVE_MINUTES_MS !== 0 || candle.timeframe !== '5m'
      || candle.confirmed !== true || typeof candle.close !== 'number' || !Number.isFinite(candle.close)
      || path.has(candle.timestamp)) return unavailable()
    if (candle.instrument !== undefined) {
      if (typeof candle.instrument !== 'string' || candle.instrument.length === 0
        || (instrument !== undefined && instrument !== candle.instrument)) return unavailable()
      instrument = candle.instrument
    }
    path.set(candle.timestamp, candle.close)
  }

  // Validate the complete path, not just endpoints that could straddle a gap.
  for (let timestamp = baselineOpen; timestamp <= latestOpen; timestamp += FIVE_MINUTES_MS) {
    if (!path.has(timestamp)) return unavailable()
  }

  const baseline = path.get(baselineOpen)
  if (baseline === 0) return unavailable()
  const current = path.get(latestOpen)
  const rankingChange = signedRelativeChange(current, baseline)
  return Number.isFinite(rankingChange) ? { rankingChange, rankingAsOf } : unavailable()
}

/** Absolute signed change descending, unavailable values last, then fixed ID. */
export function compareRanking(left, right) {
  const leftKnown = typeof left.rankingChange === 'number' && Number.isFinite(left.rankingChange)
  const rightKnown = typeof right.rankingChange === 'number' && Number.isFinite(right.rankingChange)
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
  if (leftKnown) {
    const difference = Math.abs(right.rankingChange) - Math.abs(left.rankingChange)
    if (difference !== 0) return difference
  }
  return left.instId < right.instId ? -1 : left.instId > right.instId ? 1 : 0
}
