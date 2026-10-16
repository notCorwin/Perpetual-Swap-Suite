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

export function hasCompleteChartWindow<T extends { hour: number }>(bars: T[], endHour: number, visibleCandles = 96, intervalMS = hour): boolean {
  if (!Number.isFinite(endHour)) return false
  const hours = new Set(bars.map(bar => bar.hour))
  for (let index = 0; index < visibleCandles; index += 1) {
    if (!hours.has(endHour - index * intervalMS)) return false
  }
  return true
}

// A chart may only paint a contiguous 96-candle window. A partial overlap is
// still missing data, not a valid fallback; otherwise scrolling over a gap
// looks like a stuttering chart and prevents the repair state from being seen.
export function renderableChartEnd<T extends { hour: number }>(bars: T[], requestedEnd: number, intervalMS = hour): number | null {
  const hours = [...new Set(bars.map(bar => bar.hour).filter(Number.isFinite))].sort((left, right) => left - right)
  let closest: number | null = null, runStart = 0
  const consider = (first: number, last: number) => {
    if (last - first + 1 < 96) return
    const firstEnd = hours[first + 95]
    const offset = Math.max(0, Math.min(last - first - 95, Math.round((requestedEnd - firstEnd) / intervalMS)))
    const candidate = firstEnd + offset * intervalMS
    if (closest === null || Math.abs(candidate - requestedEnd) < Math.abs(closest - requestedEnd)
      || Math.abs(candidate - requestedEnd) === Math.abs(closest - requestedEnd) && candidate > closest) closest = candidate
  }
  for (let index = 1; index <= hours.length; index += 1) {
    if (index < hours.length && hours[index] === hours[index - 1] + intervalMS) continue
    consider(runStart, index - 1)
    runStart = index
  }
  return closest
}

export function completeIndicatorSeries<T extends Record<string, unknown>>(bars: T[], key: string, visibleCandles = 96): boolean {
  return bars.length >= visibleCandles && bars.every(bar => typeof bar[key] === 'number' && Number.isFinite(bar[key]))
}

const requiredIndicatorSeries = ['vwap', 'ema', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']

// A complete 96-bar viewport can still have invalid indicators when the raw
// warm-up range to its left has a gap. Treat those null series as unfinished
// history so the renderer asks the service to repair the source data.
export function chartIndicatorsNeedLoad<T extends { hour: number } & Record<string, unknown>>(bars: T[], endHour: number, visibleCandles = 96, intervalMS = hour): boolean {
  const visible = visibleChartBars(bars, endHour, intervalMS)
  return !hasCompleteChartWindow(visible, endHour, visibleCandles, intervalMS)
    || requiredIndicatorSeries.some(key => !completeIndicatorSeries(visible, key, visibleCandles))
}

export function chartHistoryNeedsLoad(endHour: number, oldestCachedHour: number, visibleHours = 96, prefetchHours = 48, intervalMS = hour): boolean {
  if (!Number.isFinite(oldestCachedHour)) return true
  return endHour - (visibleHours - 1) * intervalMS <= oldestCachedHour + prefetchHours * intervalMS
}

export function chartScrollFloor(oldestCachedHour: number, oldestAvailableHour: number | null, visibleHours = 96, intervalMS = hour): number {
  if (oldestAvailableHour !== null) return oldestAvailableHour + (visibleHours - 1) * intervalMS
  // Until the next history block arrives, never request an end that cannot
  // paint a complete visible window. The separate history prefetch threshold
  // still starts loading 48 candles before this boundary.
  return Number.isFinite(oldestCachedHour) ? oldestCachedHour + (visibleHours - 1) * intervalMS : 0
}

export function chartStatsNeedLoad<T extends { hour: number; confirmed: boolean; oi: number | null; buy: number | null; sell: number | null }>(bars: T[], endHour: number, visibleHours = 96, intervalMS = hour): boolean {
  const firstHour = endHour - (visibleHours - 1) * intervalMS
  return bars.some(bar => bar.confirmed && bar.hour >= firstHour && bar.hour <= endHour
    && (bar.oi === null || bar.buy === null || bar.sell === null))
}

// Source-candle repairs include indicator warm-up history to the left of the
// visible chart. Statistics are independent direct timeframe values, so a
// warm-up repair must not hold up OI/Taker once this 96-candle window is whole.
export function chartStatisticsRequestable<T extends { hour: number; confirmed: boolean; oi: number | null; buy: number | null; sell: number | null }>(bars: T[], requestedEnd: number | null, renderedEnd: number | null, visibleHours = 96, intervalMS = hour): boolean {
  return requestedEnd !== null && renderedEnd === requestedEnd
    && hasCompleteChartWindow(bars, requestedEnd, visibleHours, intervalMS)
    && chartStatsNeedLoad(bars, requestedEnd, visibleHours, intervalMS)
}
