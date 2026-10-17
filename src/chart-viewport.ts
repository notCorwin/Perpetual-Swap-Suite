const hour = 3_600_000

export type ChartViewportRun = { firstEnd: number; lastEnd: number }

function lowerBound<T extends { hour: number }>(bars: readonly T[], hour: number) {
  let low = 0, high = bars.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (bars[middle].hour < hour) low = middle + 1
    else high = middle
  }
  return low
}

function sortedUniqueHours<T extends { hour: number }>(bars: readonly T[]) {
  let ordered = true
  for (let index = 1; index < bars.length; index += 1) {
    if (!Number.isFinite(bars[index - 1].hour) || bars[index].hour <= bars[index - 1].hour) { ordered = false; break }
  }
  if (ordered && (bars.length === 0 || Number.isFinite(bars[0].hour))) return bars.map(bar => bar.hour)
  return [...new Set(bars.map(bar => bar.hour).filter(Number.isFinite))].sort((left, right) => left - right)
}

// A viewport run is built only when cached data changes. Scrolling then picks
// an already-known complete 96-candle span instead of sorting every cached
// timestamp on every animation frame.
export function chartViewportRuns<T extends { hour: number }>(bars: readonly T[], intervalMS = hour): ChartViewportRun[] {
  const hours = sortedUniqueHours(bars)
  const runs: ChartViewportRun[] = []
  let start = 0
  const addRun = (end: number) => {
    if (end - start < 96) return
    runs.push({ firstEnd: hours[start + 95], lastEnd: hours[end - 1] })
  }
  for (let index = 1; index <= hours.length; index += 1) {
    if (index < hours.length && hours[index] === hours[index - 1] + intervalMS) continue
    addRun(index)
    start = index
  }
  return runs
}

export function renderableChartEndFromRuns(runs: readonly ChartViewportRun[], requestedEnd: number, intervalMS = hour): number | null {
  let closest: number | null = null
  for (const run of runs) {
    const offset = Math.max(0, Math.min(Math.round((requestedEnd - run.firstEnd) / intervalMS), Math.round((run.lastEnd - run.firstEnd) / intervalMS)))
    const candidate = run.firstEnd + offset * intervalMS
    if (closest === null || Math.abs(candidate - requestedEnd) < Math.abs(closest - requestedEnd)
      || Math.abs(candidate - requestedEnd) === Math.abs(closest - requestedEnd) && candidate > closest) closest = candidate
  }
  return closest
}

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

export function visibleChartBars<T extends { hour: number }>(bars: T[], endHour: number, intervalMS = hour, visibleCandles = 96): T[] {
  const firstHour = endHour - (visibleCandles - 1) * intervalMS
  const start = lowerBound(bars, firstHour)
  const end = lowerBound(bars, endHour + 1)
  return bars.slice(start, end)
}

export function hasCompleteChartWindow<T extends { hour: number }>(bars: T[], endHour: number, visibleCandles = 96, intervalMS = hour): boolean {
  if (!Number.isFinite(endHour)) return false
  const firstHour = endHour - (visibleCandles - 1) * intervalMS
  const start = lowerBound(bars, firstHour)
  for (let index = 0; index < visibleCandles; index += 1) {
    if (bars[start + index]?.hour !== firstHour + index * intervalMS) return false
  }
  return true
}

// A chart may only paint a contiguous 96-candle window. A partial overlap is
// still missing data, not a valid fallback; otherwise scrolling over a gap
// looks like a stuttering chart and prevents the repair state from being seen.
export function renderableChartEnd<T extends { hour: number }>(bars: T[], requestedEnd: number, intervalMS = hour): number | null {
  return renderableChartEndFromRuns(chartViewportRuns(bars, intervalMS), requestedEnd, intervalMS)
}

export function completeIndicatorSeries<T extends Record<string, unknown>>(bars: T[], key: string, visibleCandles = 96): boolean {
  return bars.length >= visibleCandles && bars.every(bar => typeof bar[key] === 'number' && Number.isFinite(bar[key]))
}

const requiredIndicatorSeries = ['vwap', 'ema', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24']

// A complete 96-bar viewport can still have invalid indicators when the raw
// warm-up range to its left has a gap. Treat those null series as unfinished
// history so the renderer asks the service to repair the source data.
export function chartIndicatorsNeedLoad<T extends { hour: number } & Record<string, unknown>>(bars: T[], endHour: number, visibleCandles = 96, intervalMS = hour): boolean {
  const visible = visibleChartBars(bars, endHour, intervalMS, visibleCandles)
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
  const visible = visibleChartBars(bars, endHour, intervalMS, visibleHours)
  return !hasCompleteChartWindow(visible, endHour, visibleHours, intervalMS) || visible.some(bar => bar.confirmed
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
