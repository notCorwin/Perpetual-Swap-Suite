export type ChartRequestKind = 'history' | 'statistics'
export type ChartViewportGeneration = { cacheKey: string; end: number; focusToken: number }

// A viewport end is not sufficient identity for an in-flight request. The
// user can leave and return to the same end before its earlier IPC reply
// arrives; the second foreground generation must be able to start immediately.
export function chartRequestKey(kind: ChartRequestKind, cacheKey: string, end: number, session: number, focusToken: number) {
  return `${kind}:${cacheKey}:${end}:${session}:${focusToken}`
}

// React may re-run an effect after the same viewport receives merged bars.
// That cleanup is not a navigation. Only the viewport's foreground generation
// decides whether an in-flight IPC response is stale.
export function isCurrentChartViewportGeneration(current: ChartViewportGeneration | null, expected: ChartViewportGeneration) {
  return current !== null && current.cacheKey === expected.cacheKey && current.end === expected.end && current.focusToken === expected.focusToken
}

export function retainViewportTimers<T>(timers: Map<string, T>, activeKey: string | null, cancel: (timer: T) => void, onDrop?: (key: string) => void) {
  for (const [key, timer] of timers) {
    if (key === activeKey) continue
    cancel(timer)
    timers.delete(key)
    onDrop?.(key)
  }
}
