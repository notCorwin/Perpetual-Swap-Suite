import { CANDLE_INTERVALS } from './market-records.js'

// Age belongs to each native slot, never the end of the page containing it.
// Even repeatedly empty old history is retried: this policy infers no retention
// boundary and never converts an empty response into permanent coverage.
export const STATISTICS_ABSENCE_POLICY = Object.freeze({
  recentPeriods: 2,
  recentLeaseMS: 60_000,
  historicalLeaseMS: 6 * 3_600_000,
  maximumLeaseMS: 24 * 3_600_000,
})

/** absenceAttempts includes the successful empty observation being recorded. */
export function statisticsAbsenceExpiryAt(timeframe, timestamp, observedAt = Date.now(), absenceAttempts = 1) {
  const step = Object.hasOwn(CANDLE_INTERVALS, timeframe) ? CANDLE_INTERVALS[timeframe] : undefined
  if (!step || !Number.isSafeInteger(timestamp) || timestamp < 0
    || !Number.isSafeInteger(observedAt) || observedAt < 0
    || !Number.isSafeInteger(absenceAttempts) || absenceAttempts < 1) throw new TypeError('Invalid statistics absence observation.')
  const policy = STATISTICS_ABSENCE_POLICY
  const duration = timestamp >= observedAt - policy.recentPeriods * step ? policy.recentLeaseMS
    : Math.min(policy.maximumLeaseMS, policy.historicalLeaseMS * 2 ** (absenceAttempts - 1))
  return Math.min(Number.MAX_SAFE_INTEGER, observedAt + duration)
}
