import { availableParallelism } from 'node:os'
import { VISIBLE, TAIL, intervalFor, seriesKey, sharedIndicatorState, SourceRegistry } from './prepared-chart-helpers.js'
import { preparedChartWorkerMethods } from './prepared-chart-workers.js'
import { preparedChartProjectionMethods } from './prepared-chart-projection.js'
import { preparedChartFocusMethods } from './prepared-chart-focus.js'
import { preparedChartSourceMethods } from './prepared-chart-sources.js'

/** Price publication, statistic observations and exact indicator work have independent lifetimes. */
export class PreparedChartPipeline {
  constructor({ store, history, normalize, revision, instrument, streaming = () => false, acquire = () => true, onFocus = () => {} }) {
    Object.assign(this, { store, history, normalize, revision, instrument, streaming, acquire, onFocus })
    this.series = new Map(); this.liveStates = new Map(); this.snapshots = new Map(); this.universe = new Map()
    this.realtimeKeys = new Set(); this.listeners = new Set(); this.tasks = new Map(); this.localTasks = new Map()
    this.liveSeeds = new Map(); this.maxSeries = 12; this.maxBytes = 32 * 1024 * 1024
    this.maxProjectionBytes = 64 * 1024 * 1024; this.objectSizes = new WeakMap()
    this.resolvedIndicatorStatuses = new WeakMap()
    this.nextGeneration = 0; this.nextRevision = 0; this.nextCalculation = 0
    this.nextProjection = 0
    this.workers = []; this.calculations = new Map(); this.calculationQueue = []
    // Market ingress, liquidity, renderer and the OS share the same CPU. Do
    // not let the indicator pool consume every remaining execution slot.
    this.workerLimit = Math.max(1, Math.min(4, availableParallelism() - 3))
    this.candidateLimit = Math.min(4, this.workerLimit)
    this.candidateQueue = []; this.candidateTasks = new Map(); this.candidateTimer = null; this.candidateTimerAt = Infinity
    this.warmSourceQueue = []; this.warmSourceActive = new Map()
    this.sourceAttempts = new SourceRegistry(); this.sourceTasks = new SourceRegistry()
    this.sourceEpoch = 0
    this.presentationActive = true; this.presentationEpoch = 0
    this.focuses = new Map(); this.explicitFocus = false
    this.focusReads = new Set(); this.pendingFocusReads = new Map()
    this.focusWaits = new Map()
    this.livePublications = new Map(); this.livePublicationTimer = null
    this.priceJournal = new Map()
    this.unsubscribeStore = store.subscribe?.(change => {
      const key = seriesKey(change.instrument, change.timeframe)
      if (!this.series.has(key) && !this.liveStates.has(key) || change.priceFrom === null || !Number.isSafeInteger(change.priceRevision)) return
      const journal = this.priceJournal.get(key) ?? []
      journal.push({ revision: change.priceRevision, from: change.priceFrom })
      if (journal.length > 256) journal.shift()
      this.priceJournal.set(key, journal)
    })
    this.closed = false; this.disposeTask = null; this.requestedIDs = new Set(); this.refreshTimer = null
    this.repairDeadlines = new Map()
  }

  state(instId, timeframe) {
    const key = seriesKey(instId, timeframe)
    let state = this.series.get(key)
    if (!state) {
      // Both restore paths must share one generation before either local read
      // yields; a later compact admission cannot invent a newer input basis.
      const live = this.liveState(instId, timeframe)
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(live?.rows ?? []), indicators: new Map(live?.indicators ?? []),
        generation: live?.generation || ++this.nextGeneration, sourceVersion: live?.sourceVersion ?? 0, priceVersion: live?.priceVersion ?? 0, oiVersion: live?.oiVersion ?? 0, takerVersion: live?.takerVersion ?? 0,
        indicatorFailures: new Map(live?.indicatorFailures ?? []),
        barCaches: new Map(live?.barCaches ?? []),
        projectedBars: new Map(live?.projectedBars ?? []),
        indicatorState: sharedIndicatorState(live?.indicatorState) ?? null, live: live?.live ?? null, observedAt: live?.observedAt ?? null,
        indicatorVersion: live?.indicatorVersion ?? 0,
        floor: live?.floor ?? null, active: 0, latestHour: live?.latestHour ?? null, historyEnd: null, loaded: live?.loaded ?? false, calculation: null }
    }
    this.series.delete(key); this.series.set(key, state)
    return state
  }

  liveState(instId, timeframe) {
    const key = seriesKey(instId, timeframe)
    let state = this.liveStates.get(key)
    if (!state) {
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), indicators: new Map(),
        generation: ++this.nextGeneration, sourceVersion: 0, priceVersion: 0, oiVersion: 0, takerVersion: 0, indicatorState: null, live: null, observedAt: null,
        latestHour: null, floor: null, active: 0, loaded: false }
      this.liveStates.set(key, state)
    }
    return state
  }

  // Collector membership is deliberately not a request to restore/replay charts.
  setRealtimeSubscriptions(subscriptions) {
    this.realtimeKeys = new Set(subscriptions.map(({ instId, timeframe }) => seriesKey(instId, timeframe)))
    for (const [key] of this.liveStates) if (!this.realtimeKeys.has(key) && !this.universe.has(key) && !this.series.has(key)) this.liveStates.delete(key)
  }

  get worker() { return this.workers[0]?.worker ?? null }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(frame) { if (!this.closed && this.presentationActive) for (const listener of this.listeners) { try { listener(frame) } catch { /* A renderer cannot stop collection. */ } } }
  cached(key) { return this.snapshots.get(key)?.frame ?? null }
  latest(state) { return state.latestHour ?? null }

  get focus() { return this.focuses.get('primary') ?? this.focuses.values().next().value ?? null }
  get focusKey() { return this.focus?.key ?? null }
  get pendingFocusRead() { return this.pendingFocusReads.values().next().value ?? null }

  visibleBars(key) {
    let count = VISIBLE
    for (const focus of this.focuses.values()) if (focus.key === key) count = Math.max(count, focus.windowBars ?? VISIBLE)
    return count
  }

  tailBars(key) { return Math.max(TAIL, this.visibleBars(key) + 32) }
  focusFor(key) { return [...this.focuses.values()].find(focus => focus.key === key) ?? null }
  focusById(id) { return [...this.focuses.values()].find(focus => focus.id === id) ?? null }

  job(key, operation) {
    if (this.tasks.has(key)) return this.tasks.get(key)
    const task = Promise.resolve().then(() => { if (this.closed) throw new Error('Prepared chart data service is closed.'); return operation() }).finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key) })
    this.tasks.set(key, task); return task
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask
    this.closed = true
    if (this.livePublicationTimer !== null) clearImmediate(this.livePublicationTimer)
    this.livePublicationTimer = null
    for (const pending of this.livePublications.values()) pending.resolve(null)
    this.livePublications.clear()
    this.cancelPendingFocusRead('closed')
    this.cancelFocusWaits('closed')
    for (const entry of this.focusReads) this.cancelFocusReadWaiters(entry, 'closed')
    for (const demand of this.universe.values()) demand.controller.abort()
    this.candidateQueue = []
    if (this.candidateTimer !== null) clearTimeout(this.candidateTimer)
    for (const job of this.sourceTasks.values()) job.controller.abort()
    this.unsubscribeStore?.(); this.priceJournal.clear()
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    for (const pending of this.calculations.values()) pending.reject(new Error('Prepared chart data service is closed.'))
    this.calculations.clear(); this.calculationQueue = []
    const workers = this.workers
    this.workers = []
    this.disposeTask = (async () => {
      await Promise.allSettled(workers.map(slot => slot.worker.terminate()))
      await Promise.allSettled([...this.tasks.values(), ...[...this.focusReads].map(entry => entry.done), ...this.liveSeeds.values(), ...this.candidateTasks.values()])
      this.listeners.clear()
    })()
    return this.disposeTask
  }
}

Object.assign(
  PreparedChartPipeline.prototype,
  preparedChartWorkerMethods,
  preparedChartProjectionMethods,
  preparedChartFocusMethods,
  preparedChartSourceMethods,
)
