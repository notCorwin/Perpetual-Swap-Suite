import type { SnapshotVersion } from './snapshot-order.ts'

export function mergeChartBars<T extends { hour: number; confirmed: boolean }>(live: (SnapshotVersion & { bars: T[] }) | null, history: (SnapshotVersion & { bars: T[] }) | null): T[] {
  if (live?.serviceSession && history?.serviceSession && live.serviceSession !== history.serviceSession) return live.bars
  const [older, newer] = (live?.revision ?? -1) >= (history?.revision ?? -1) ? [history, live] : [live, history]
  const bars = new Map<number, T>()
  for (const source of [older, newer]) for (const bar of source?.bars ?? []) {
    if (bars.get(bar.hour)?.confirmed && !bar.confirmed) continue
    bars.set(bar.hour, bar)
  }
  return [...bars.values()].sort((a, b) => a.hour - b.hour)
}
