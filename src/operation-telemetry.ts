import { attachOperationJournalSink, beginOperation, configureOperationContext, recordOperation, runWithOperationContext,
  type OperationJournalEvent, type OperationSpan } from '../electron/services/operations.js'
import { MAX_OPERATION_BATCH_SIZE } from '../electron/services/operation-limits.js'
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
  onStop?: (callback: () => Promise<void>) => () => void
}

const FLUSH_THRESHOLD = 128, FLUSH_MS = 250, MAX_PENDING = 8_192

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
    window.addEventListener('radar-operations-flush', flush)
    return () => window.removeEventListener('radar-operations-flush', flush)
  },
  onStop: callback => {
    const stop = () => { void callback().catch(() => {}) }
    window.addEventListener('pagehide', stop)
    return () => window.removeEventListener('pagehide', stop)
  },
}): Promise<() => Promise<void>> {
  const pending: OperationJournalEvent[] = [], observers: PerformanceObserver[] = []
  const requests = new Map<string, OperationSpan>()
  let timer: number | undefined, flushing: Promise<void> | undefined, batch: OperationBatch | undefined
  let finalFlushing: Promise<void> | undefined, finalBatches: OperationBatch[] | undefined
  let reportingFailure: Promise<void> | undefined
  let stopped = false, failedSource = false, omitted = 0, reportedOmitted = 0, nextBatch = 0
  let source: OperationSourceIdentity | undefined
  let unsubscribe = () => {}, removeFlush = () => {}, removeStop = () => {}
  const schedule = () => {
    if (!stopped && !failedSource && timer === undefined) timer = host.schedule(() => { timer = undefined; void flush().catch(schedule) }, FLUSH_MS)
  }
  const createBatch = (events: OperationJournalEvent[]): OperationBatch => ({ executionId: events[0].executionId,
    batchId: `${events[0].executionId}:batch:${++nextBatch}`, firstSequence: events[0].sequence, events })
  const acknowledge = (sent: OperationBatch, acknowledgment: OperationAcknowledgment) => {
    const lastSequence = sent.events.at(-1)!.sequence
    if (acknowledgment.batchId !== sent.batchId || acknowledgment.lastSequence !== lastSequence) throw new Error('Operation journal acknowledgment does not match the retained batch.')
    // A terminal handoff may replay a batch that is already waiting for its ACK.
    // Either ACK can arrive first; removing by source sequence keeps both idempotent.
    let count = 0
    while (count < pending.length && pending[count].sequence <= lastSequence) count++
    pending.splice(0, count)
    if (batch?.batchId === sent.batchId) batch = undefined
  }
  const reportOmissions = (): Promise<void> => {
    if (reportingFailure) return reportingFailure
    if (omitted <= reportedOmitted) return Promise.resolve()
    const count = omitted
    try {
      // Send a cumulative high-water mark so an ACK lost during navigation can
      // replay the same report without counting its omissions a second time.
      reportingFailure = host.reportFailure({ executionId: source?.executionId ?? 'renderer', reason: 'renderer-buffer-exhausted', omitted: count })
        .then(() => { reportedOmitted = Math.max(reportedOmitted, count) }).finally(() => { reportingFailure = undefined })
      return reportingFailure
    } catch (error) { return Promise.reject(error) }
  }
  const assertComplete = async () => {
    if (!failedSource) return
    while (omitted > reportedOmitted) await reportOmissions()
    throw new Error('Renderer operation recording is incomplete because its retained queue was exhausted.')
  }
  const flushFinal = (): Promise<void> => {
    if (finalFlushing) return finalFlushing
    if (!finalBatches) {
      finalBatches = batch ? [batch] : []
      const offset = batch?.events.length ?? 0
      for (let index = offset; index < pending.length; index += MAX_OPERATION_BATCH_SIZE) {
        finalBatches.push(createBatch(pending.slice(index, index + MAX_OPERATION_BATCH_SIZE)))
      }
    }
    finalBatches = finalBatches.filter(value => pending.some(event => event.sequence === value.firstSequence))
    // Submit every retained batch synchronously, including an immutable replay of
    // the in-flight batch. A destroyed document cannot resume after awaiting its
    // ACK. The main receiver owns ordered admission, replay deduplication and fsync.
    const deliveries = finalBatches.map(sent => {
      try { return host.recordOperations(sent).then(ack => acknowledge(sent, ack)) }
      catch (error) { return Promise.reject(error) }
    })
    // Failure evidence must also leave the document before any ACK is awaited.
    // A paired retained prefix alone cannot reveal records omitted after it.
    finalFlushing = Promise.allSettled([...deliveries, assertComplete()]).then(results => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }).finally(() => { finalFlushing = undefined })
    return finalFlushing
  }
  const flush = (): Promise<void> => {
    if (timer !== undefined) host.cancel(timer)
    timer = undefined
    if (stopped) return flushFinal()
    if (flushing) return flushing
    flushing = (async () => {
      while (pending.length && !stopped) {
        const sent = batch ??= createBatch(pending.slice(0, MAX_OPERATION_BATCH_SIZE))
        acknowledge(sent, await host.recordOperations(sent))
      }
      await assertComplete()
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
    unsubscribe(); removeFlush(); removeStop()
    return flush()
  }
  const hooks: OperationBridgeHooks = {
    beginRequest(command) {
      if (stopped) throw Object.assign(new Error('The renderer document is detached.'), { name: 'AbortError' })
      const operation = beginOperation({ category: 'ipc', name: 'desktop.request', resource: command })
      const id = operation.context.parentId ?? `unrecorded:${requests.size}`
      requests.set(id, operation)
      return { id, context: operation.context }
    },
    endRequest(id, status) { requests.get(id)?.end({ status }); requests.delete(id) },
    receive(channel, detail, context, decode) {
      if (stopped) return
      runWithOperationContext(context, () => {
        const operation = beginOperation({ category: 'ipc', name: 'desktop.notification.receive', resource: channel })
        try {
          operation.run(() => window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), { detail: decode ? decode(detail) : detail })))
          operation.end()
        } catch (error) {
          operation.end({ status: 'error', attributes: { errorName: error instanceof Error ? error.name : 'Error' } })
          throw error
        }
      })
    },
    flush: detachRequests,
  }
  source = await host.initialize?.(hooks)
  if (source) configureOperationContext(source)
  unsubscribe = attachOperationJournalSink(event => {
    if (failedSource || pending.length >= MAX_PENDING) { failedSource = true; omitted++; return }
    pending.push(event)
    if (!stopped && pending.length >= FLUSH_THRESHOLD) void flush().catch(schedule)
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
  removeStop = host.onStop?.(detachRequests) ?? (() => {})
  return async () => { await detachRequests() }
}
