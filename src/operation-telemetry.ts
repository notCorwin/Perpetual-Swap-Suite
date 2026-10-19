import { attachOperationSink, recordOperation, type OperationEvent } from '../electron/services/operations.js'

type TelemetryHost = {
  recordOperations: (events: OperationEvent[]) => void
  timeOrigin: number
  Observer?: typeof PerformanceObserver
  schedule: (callback: () => void, delay: number) => number
  cancel: (handle: number) => void
  onFlush: (callback: () => void) => () => void
}

const BATCH_SIZE = 128
const FLUSH_MS = 250
const MAX_PENDING = 4_096

/** Renderer diagnostics share the operation journal without one IPC per span. */
export function initializeOperationTelemetry(host: TelemetryHost = {
  recordOperations: events => window.radarDesktop.recordOperations(events),
  timeOrigin: performance.timeOrigin,
  Observer: globalThis.PerformanceObserver,
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: handle => window.clearTimeout(handle),
  onFlush: callback => {
    window.addEventListener('pagehide', callback)
    window.addEventListener('radar-operations-flush', callback)
    return () => { window.removeEventListener('pagehide', callback); window.removeEventListener('radar-operations-flush', callback) }
  },
}): () => void {
  const pending: OperationEvent[] = []
  const observers: PerformanceObserver[] = []
  let timer: number | undefined
  let stopped = false
  let transportBlocked = false
  let overflow: OperationEvent | undefined
  const schedule = () => { if (!stopped && timer === undefined) timer = host.schedule(flush, FLUSH_MS) }
  const flush = () => {
    if (timer !== undefined) host.cancel(timer)
    timer = undefined
    transportBlocked = false
    while (pending.length) {
      const events = pending.slice(0, BATCH_SIZE)
      try { host.recordOperations(events) }
      catch { transportBlocked = true; schedule(); return }
      pending.splice(0, events.length)
      if (overflow && events.includes(overflow)) overflow = undefined
    }
  }
  const unsubscribe = attachOperationSink(event => {
    if (pending.length < MAX_PENDING - 1) pending.push(event)
    else if (!overflow) {
      // A disconnected renderer cannot keep an unbounded diagnostic queue.
      // Preserve an explicit accounting record for every omitted operation.
      overflow = { ...event, name: 'diagnostics.renderer.overflow', resource: 'renderer', durationMS: 0, cpuTimeMS: undefined, status: 'error',
        attributes: { incomplete: true, count: 1, reason: 'transport-backpressure', measurement: 'omitted-operations' } }
      pending.push(overflow)
    } else overflow.attributes!.count = Number(overflow.attributes!.count) + 1
    if (pending.length >= BATCH_SIZE && !transportBlocked) flush()
    else schedule()
  })
  // Browser entries report observed elapsed time, including scheduling/rendering;
  // they do not expose GPU execution time or process CPU consumption.
  const recordEntries = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const frame = entry as PerformanceEntry & { blockingDuration?: number; renderStart?: number }
      recordOperation({ category: 'cpu', name: `renderer.${entry.entryType}`, status: 'ok',
        startedAt: host.timeOrigin + entry.startTime, durationMS: entry.duration,
        attributes: {
          durationSource: 'browser-performance-entry', measurement: 'observed-wall',
          ...(Number.isFinite(frame.blockingDuration) ? { blockingDurationMS: frame.blockingDuration! } : {}),
          ...(Number.isFinite(frame.renderStart) && frame.renderStart! > 0
            ? { renderDurationMS: Math.max(0, entry.startTime + entry.duration - frame.renderStart!) } : {}),
        } })
    }
  }
  const observe = (type: 'longtask' | 'long-animation-frame') => {
    if (!host.Observer?.supportedEntryTypes.includes(type)) return
    try {
      const observer = new host.Observer(list => recordEntries(list.getEntries()))
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch { /* Chromium versions expose different optional entry types. */ }
  }
  observe('longtask')
  observe('long-animation-frame')
  const flushObserved = () => { for (const observer of observers) recordEntries(observer.takeRecords()); flush() }
  const removeFlush = host.onFlush(flushObserved)
  return () => {
    stopped = true
    flushObserved()
    unsubscribe()
    for (const observer of observers) observer.disconnect()
    removeFlush()
    flush()
  }
}
