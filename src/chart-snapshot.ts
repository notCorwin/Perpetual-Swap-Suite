import type { SnapshotVersion } from './snapshot-order.ts'

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
    for (const key of ["oi", "buy", "sell"] as const) {
      if (key in previous && (bar as T & Record<string, unknown>)[key] === null) merged[key] = (previous as T & Record<string, unknown>)[key]
    }
    bars.set(bar.hour, merged as T)
  }
  return [...bars.values()].sort((a, b) => a.hour - b.hour)
}
