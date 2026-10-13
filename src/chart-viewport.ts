const hour = 3_600_000
export const RADAR_CHART_HOURS = 96
export const RADAR_STRATEGY_BACKTEST_HOURS = 48

export function livePriceTag(live: { hour: number; open: number; close: number }, endHour: number, now: number) {
  return {
    price: live.close,
    rising: live.close >= live.open,
    inViewport: live.hour <= endHour,
    secondsLeft: now > 0 ? Math.max(0, Math.floor((live.hour + hour - now) / 1000)) : 0,
  }
}

// null means the right edge follows the latest candle.
export function scrollChartEnd(endHour: number | null, latestHour: number, steps: number, oldestCachedHour = 0, windowHours = RADAR_CHART_HOURS): number | null {
  const earliestEnd = Math.min(latestHour, oldestCachedHour + (windowHours - 1) * hour)
  const next = Math.max(earliestEnd, Math.min(latestHour, (endHour ?? latestHour) + steps * hour))
  return next >= latestHour ? null : next
}

export function visibleChartBars<T extends { hour: number }>(bars: T[], endHour: number, windowHours = RADAR_CHART_HOURS): T[] {
  const firstHour = endHour - (windowHours - 1) * hour
  return bars.filter(bar => bar.hour >= firstHour && bar.hour <= endHour)
}

export function latestEvaluatedHour<T extends { hour: number; confirmed: boolean }>(bars: T[]): number | null {
  return bars.findLast(bar => bar.confirmed)?.hour ?? null
}
