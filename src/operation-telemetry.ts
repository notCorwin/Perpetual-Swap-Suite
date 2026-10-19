import { attachOperationJournalSink, beginOperation, configureOperationContext, recordOperation, runWithOperationContext,
  type OperationJournalEvent, type OperationSpan } from '../electron/services/operations.js'
import type { OperationAcknowledgment, OperationBatch, OperationBridgeHooks, OperationSourceIdentity } from './desktop-contract.ts'

type TelemetryHost = {
  initialize?: (hooks: OperationBridgeHooks) => Promise<OperationSourceIdentity>
  recordOperations: (batch: OperationBatch) => Promise<OperationAcknowledgment>
  reportFailure: (value: { executionId: string; reason: string; omitted: number }) => Promise<void>
  timeOrigin: number
  Observer?: typeof PerformanceObserver
  schedule: (callback: () => void, delay: number) => number
  cancel: (handle: number) => void
  onFlush: (callback: () => Promise<void>) => () => void
}

const BATCH_SIZE = 128, FLUSH_MS = 250, MAX_PENDING = 8_192

/** Retain each lifecycle record until the main process acknowledges durable storage. */
export async function initializeOperationTelemetry(host: TelemetryHost = {
  initialize: hooks => window.radarDesktop.initializeOperations(hooks),
  recordOperations: batch => window.radarDesktop.recordOperations(batch),
  reportFailure: value => window.radarDesktop.operationSourceFailure(value),
  timeOrigin: performance.timeOrigin,
  Observer: globalThis.PerformanceObserver,
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: handle => window.clearTimeout(handle),
  onFlush: callback => {
    const flush = () => { void callback().catch(() => {}) }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  },
}): Promise<() => Promise<void>> {
  const pending: OperationJournalEvent[] = [], observers: PerformanceObserver[] = []
  const requests = new Map<string, OperationSpan>()
  let timer: number | undefined, flushing: Promise<void> | undefined, batch: OperationBatch | undefined
  let stopped = false, failedSource = false, omitted = 0, reportedOmitted = 0, nextBatch = 0
  let source: OperationSourceIdentity | undefined
  let unsubscribe = () => {}, removeFlush = () => {}
  const schedule = () => {
    if (!stopped && !failedSource && timer === undefined) timer = host.schedule(() => { timer = undefined; void flush().catch(schedule) }, FLUSH_MS)
  }
  const flush = (): Promise<void> => {
    if (timer !== undefined) host.cancel(timer)
    timer = undefined
    if (flushing) return flushing
    flushing = (async () => {
      while (pending.length) {
        if (!batch) {
          const events = pending.slice(0, BATCH_SIZE)
          batch = { executionId: events[0].executionId, batchId: `${events[0].executionId}:batch:${++nextBatch}`,
            firstSequence: events[0].sequence, events }
        }
        const acknowledgment = await host.recordOperations(batch)
        const lastSequence = batch.events.at(-1)!.sequence
        if (acknowledgment.batchId !== batch.batchId || acknowledgment.lastSequence !== lastSequence) throw new Error('Operation journal acknowledgment does not match the retained batch.')
        pending.splice(0, batch.events.length)
        batch = undefined
      }
      if (failedSource) {
        if (omitted > reportedOmitted) {
          const count = omitted
          await host.reportFailure({ executionId: source?.executionId ?? 'renderer', reason: 'renderer-buffer-exhausted', omitted: count - reportedOmitted })
          reportedOmitted = count
        }
        throw new Error('Renderer operation recording is incomplete because its retained queue was exhausted.')
      }
    })().finally(() => { flushing = undefined })
    return flushing
  }
  const recordEntries = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const frame = entry as PerformanceEntry & { blockingDuration?: number; renderStart?: number }
      recordOperation({ category: 'cpu', name: `renderer.${entry.entryType}`, status: 'ok',
        startedAt: host.timeOrigin + entry.startTime, durationMS: entry.duration,
        attributes: { durationSource: 'browser-performance-entry', measurement: 'observed-wall',
          ...(Number.isFinite(frame.blockingDuration) ? { blockingDurationMS: frame.blockingDuration! } : {}),
          ...(Number.isFinite(frame.renderStart) && frame.renderStart! > 0
            ? { renderDurationMS: Math.max(0, entry.startTime + entry.duration - frame.renderStart!) } : {}),
        } })
    }
  }
  const flushObserved = () => { for (const observer of observers) recordEntries(observer.takeRecords()); return flush() }
  const detachRequests = () => {
    stopped = true
    for (const operation of requests.values()) operation.end({ status: 'cancelled', attributes: { reason: 'renderer-detached' } })
    requests.clear()
    for (const observer of observers) { recordEntries(observer.takeRecords()); observer.disconnect() }
    observers.length = 0
    unsubscribe(); removeFlush()
    return flush()
  }
  const hooks: OperationBridgeHooks = {
    beginRequest(command) {
      const operation = beginOperation({ category: 'ipc', name: 'desktop.request', resource: command })
      const id = operation.context.parentId ?? `unrecorded:${requests.size}`
      requests.set(id, operation)
      return { id, context: operation.context }
    },
    endRequest(id, status) { requests.get(id)?.end({ status }); requests.delete(id) },
    receive(channel, detail, context) {
      runWithOperationContext(context, () => {
        const operation = beginOperation({ category: 'ipc', name: 'desktop.notification.receive', resource: channel })
        try { operation.run(() => window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), { detail }))) }
        finally { operation.end() }
      })
    },
    flush: detachRequests,
  }
  source = await host.initialize?.(hooks)
  if (source) configureOperationContext(source)
  unsubscribe = attachOperationJournalSink(event => {
    if (failedSource || pending.length >= MAX_PENDING) { failedSource = true; omitted++; return }
    pending.push(event)
    if (pending.length >= BATCH_SIZE) void flush().catch(schedule)
    else schedule()
  })
  for (const type of ['longtask', 'long-animation-frame']) {
    if (!host.Observer?.supportedEntryTypes.includes(type)) continue
    try {
      const observer = new host.Observer(list => recordEntries(list.getEntries()))
      observer.observe({ type, buffered: true }); observers.push(observer)
    } catch { /* Optional browser entry types differ across Chromium builds. */ }
  }
  removeFlush = host.onFlush(flushObserved)
  return async () => { await detachRequests() }
}
