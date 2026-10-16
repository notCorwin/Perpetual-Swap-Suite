const hour = 3_600_000

export function livePriceTag(live: { hour: number; open: number; close: number }, endHour: number, now: number, intervalMS = hour) {
  return {
    price: live.close,
    rising: live.close >= live.open,
    inViewport: live.hour <= endHour,
    secondsLeft: now > 0 ? Math.max(0, Math.floor((live.hour + intervalMS - now) / 1000)) : 0,
  }
}

// null means the right edge follows the latest candle.
export function scrollChartEnd(endHour: number | null, latestHour: number, steps: number, oldestAvailableHour = 0, intervalMS = hour): number | null {
  const earliestEnd = Math.min(latestHour, oldestAvailableHour + 95 * intervalMS)
  const next = Math.max(earliestEnd, Math.min(latestHour, (endHour ?? latestHour) + steps * intervalMS))
  return next >= latestHour ? null : next
}

export function visibleChartBars<T extends { hour: number }>(bars: T[], endHour: number, intervalMS = hour): T[] {
  const firstHour = endHour - 95 * intervalMS
  return bars.filter(bar => bar.hour >= firstHour && bar.hour <= endHour)
}

// A scroll request can target history that is still downloading. Keep drawing
// the nearest complete cached window until the response expands coverage;
// rendering an empty range makes the chart appear to have fallen into limbo.
export function renderableChartEnd<T extends { hour: number }>(bars: T[], requestedEnd: number, intervalMS = hour): number {
  if (!bars.length || visibleChartBars(bars, requestedEnd, intervalMS).length) return requestedEnd
  const oldest = bars[0].hour, latest = bars.at(-1)!.hour
  return Math.min(latest, oldest + 95 * intervalMS)
}

export function chartHistoryNeedsLoad(endHour: number, oldestCachedHour: number, visibleHours = 96, prefetchHours = 48, intervalMS = hour): boolean {
  return endHour - (visibleHours - 1) * intervalMS <= oldestCachedHour + prefetchHours * intervalMS
}

export function chartStatsNeedLoad<T extends { hour: number; confirmed: boolean; oi: number | null; buy: number | null; sell: number | null }>(bars: T[], endHour: number, visibleHours = 96, intervalMS = hour): boolean {
  const firstHour = endHour - (visibleHours - 1) * intervalMS
  return bars.some(bar => bar.confirmed && bar.hour >= firstHour && bar.hour <= endHour
    && (bar.oi === null || bar.buy === null || bar.sell === null))
}
