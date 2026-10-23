export const STATISTICS_ABSENCE_POLICY: Readonly<{
  recentPeriods: 2
  recentLeaseMS: number
  historicalLeaseMS: number
  maximumLeaseMS: number
}>
/** Per-slot absence expiry. Attempts includes the current successful empty observation. */
export function statisticsAbsenceExpiryAt(timeframe: string, timestamp: number, observedAt?: number, absenceAttempts?: number): number
