import type { SnapshotVersion } from './snapshot-order.ts'

const OI_SOURCE = 0b001
const TAKER_SOURCE = 0b010
const COMPLETE_SOURCES = OI_SOURCE | TAKER_SOURCE

const statisticsSources = (bar: object) => {
  const value = bar as { statisticsSources?: unknown; statisticsObserved?: boolean }
  const sources = Number(value.statisticsSources)
  if (Number.isInteger(sources) && sources >= 0) return sources & COMPLETE_SOURCES
  return value.statisticsObserved === true ? COMPLETE_SOURCES : 0
}

export function mergeChartBars<T extends { hour: number; confirmed: boolean }>(live: (SnapshotVersion & { bars: T[] }) | null, history: (SnapshotVersion & { bars: T[] }) | null): T[] {
  if (live?.serviceSession && history?.serviceSession && live.serviceSession !== history.serviceSession) return live.bars
  const [older, newer] = (live?.revision ?? -1) >= (history?.revision ?? -1) ? [history, live] : [live, history]
  const bars = new Map<number, T>()
  for (const source of [older, newer]) for (const bar of source?.bars ?? []) {
    const previous = bars.get(bar.hour)
    if (previous?.confirmed && !bar.confirmed) continue
    if (!previous) { bars.set(bar.hour, bar); continue }
    // Historical responses carry a wide candle buffer but hydrate statistics
    // only around their viewport. A later adjacent response must not erase OI
    // or taker values already loaded for an overlapping hour with nulls.
    const merged: Record<string, unknown> = { ...previous, ...bar }
    const incomingSources = statisticsSources(bar)
    const previousSources = statisticsSources(previous)
    for (const [key, source] of [["oi", OI_SOURCE], ["buy", TAKER_SOURCE], ["sell", TAKER_SOURCE]] as const) {
      // Source ownership is independent. A known OI terminal-null must erase
      // a stale OI value even while Taker is still pending; conversely an
      // unfetched Taker response must not erase a previously loaded value.
      if (!(incomingSources & source) && key in previous && (bar as T & Record<string, unknown>)[key] === null) merged[key] = (previous as T & Record<string, unknown>)[key]
    }
    const mergedSources = incomingSources | previousSources
    const carriesStatistics = 'statisticsSources' in (bar as object) || 'statisticsObserved' in (bar as object)
      || 'statisticsSources' in (previous as object) || 'statisticsObserved' in (previous as object)
    if (carriesStatistics) {
      merged.statisticsSources = mergedSources
      merged.statisticsObserved = mergedSources === COMPLETE_SOURCES
    }
    bars.set(bar.hour, merged as T)
  }
  return [...bars.values()].sort((a, b) => a.hour - b.hour)
}
