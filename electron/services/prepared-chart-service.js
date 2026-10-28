import { createOperationWorker, createWorkerRequest } from './worker-operations.js'
import { availableParallelism } from 'node:os'
import { statisticsMask, statisticsVersionFor } from './statistics-state.js'
import { appendIndicatorCandle, projectIndicatorCandle } from './indicators.js'
import { hookOperationMethods, measureOperation, recordOperation } from './operations.js'
import { stopOperationWorker } from './operation-worker.js'
import { completePriceCandle } from './market-records.js'

const VISIBLE = 96, TAIL = 128, CHUNK = 1024, HISTORY = 1536, HISTORY_AHEAD = 256, HISTORY_PAGE = 300
// 192 remaining candles after 1.5 s of two-candle input at 120 Hz.
const HISTORY_RUNWAY = 192 + 2 * 120 * 1.5 + 2 // Include the two-candle gesture that crosses the threshold.
// One 1536-row read plus overlap is retained around the active cursor. The
// directional allocation leaves at least 768 slots on the opposite side so
// a reversal can start another read before its viewport reaches the edge.
const HISTORY_RESIDENT = 2304, HISTORY_BALANCE = 768
const HISTORY_SHARE_DISTANCE = 512
const INDICATOR_WARMUP = 199 // EMA200 is the longest initial seed.
// Formula versions identify the complete recursive state and verified producer.
// Older checkpoints do not contain ATR14's Wilder accumulator and SMA seed.
const FORMULA_VERSION = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-wilder-atr14-percent-bbw20-2-v5'
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
const priceFields = ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
const TIMEFRAMES = ['5m', '15m', '1H']
const intervalFor = timeframe => ({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })[timeframe]
const seriesKey = (instId, timeframe) => `${instId}:${timeframe}`
const numeric = value => typeof value === 'number' && Number.isFinite(value)
const abortable = (operation, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    Promise.resolve(operation()).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  } catch (error) { signal.removeEventListener('abort', abort); reject(error) }
})
const freshQuote = (timestamp, observedAt, intervalMS, now = Date.now()) => timestamp === Math.floor(now / intervalMS) * intervalMS
  && observedAt != null && now - observedAt < 30_000
const samePrice = (left, right) => left && priceFields.every(field => Object.is(left[field], right[field]))
const sameRecord = (left, right) => left === right || Boolean(left && right && JSON.stringify(left) === JSON.stringify(right))
// Cached projections use row/indicator identity. Own and freeze every resident
// record so no producer can mutate an admitted input behind that cache key.
const immutableRecord = value => Object.isFrozen(value) ? value : Object.freeze({ ...value })
const sourceFresh = (row, bit) => Boolean(statisticsMask(row) & bit) && (bit === 1 ? numeric(row.oi) || Number(row.statisticsOIExpiresAt) > Date.now() : numeric(row.buy) && numeric(row.sell) || Number(row.statisticsTakerExpiresAt) > Date.now())
const priorityRank = priority => ({ interactive: 5, foreground: 4, prepared: 4, repair: 4, continuity: 3, statistics: 2, prefetch: 1, chartWarm: 1, background: 0 })[priority] ?? 0
const sourceState = (rows, bit) => rows.length && rows.every(row => sourceFresh(row, bit))
  ? rows.every(row => bit === 1 ? numeric(row.oi) : numeric(row.buy) && numeric(row.sell)) ? 'ready' : 'unavailable' : 'loading'
const changedSource = (left, right, bit) => !left || (statisticsMask(left) & bit) !== (statisticsMask(right) & bit)
  || (bit === 1 ? ['oi', 'statisticsOIExpiresAt'] : ['buy', 'sell', 'statisticsTakerExpiresAt']).some(field => !Object.is(left[field], right[field]))
const statisticsFields = ['oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt']
// Price records and either statistic family have independent write lifetimes.
// An unobserved family is not an instruction to erase an existing observation.
const mergeStatistics = (previous, incoming, allowed = 3) => {
  const value = { ...incoming }, priorMask = statisticsMask(previous), incomingMask = statisticsMask(incoming)
  let sources = 0
  for (const bit of [1, 2]) {
    const accept = !previous || Boolean(allowed & bit) && Boolean(incomingMask & bit)
    const source = accept ? incoming : previous
    if ((accept ? incomingMask : priorMask) & bit) sources |= bit
    for (const field of bit === 1 ? ['oi', 'statisticsOIExpiresAt'] : ['buy', 'sell', 'statisticsTakerExpiresAt']) value[field] = source?.[field] ?? null
  }
  value.statisticsVersion = statisticsVersionFor(sources)
  return value
}
const blankIndicators = Object.fromEntries(indicatorFields.map(field => [field, null]))
const bar = (row, calculated) => ({ ...blankIndicators, ...calculated,
  hour: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, confirmed: Boolean(row.confirmed),
  priceComplete: completePriceCandle(row),
  oi: numeric(row.oi) ? row.oi : null, buy: numeric(row.buy) ? row.buy : null, sell: numeric(row.sell) ? row.sell : null,
  statisticsSources: statisticsMask(row), statisticsObserved: sourceFresh(row, 1) && sourceFresh(row, 2),
  oiObserved: sourceFresh(row, 1), takerObserved: sourceFresh(row, 2),
  indicatorsObserved: Boolean(calculated),
  oiUnavailableReason: sourceFresh(row, 1) && !numeric(row.oi) ? 'not-published' : undefined,
  takerUnavailableReason: sourceFresh(row, 2) && (!numeric(row.buy) || !numeric(row.sell)) ? 'not-published' : undefined,
})

const appendConfirmed = (state, candle) => {
  const previousHour = state.lastTimestamp, previousWidth = state.previousBandWidth ?? null
  const value = appendIndicatorCandle(state, candle)
  if (!value) return null
  const width = value.bbw
  state.bollExpansion = width === null ? null : previousWidth === null || previousHour + state.intervalMS !== candle.timestamp
    ? { hours: 0, complete: false } : width <= previousWidth ? { hours: 0, complete: true }
      : { hours: (state.bollExpansion?.hours ?? 0) + 1, complete: state.bollExpansion?.complete ?? false }
  state.previousBandWidth = width
  return value
}

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
    this.sourceAttempts = new Map(); this.sourceTasks = new Map()
    this.sourceEpoch = 0
    this.focus = null; this.explicitFocus = false
    this.focusReads = new Set(); this.pendingFocusRead = null
    this.focusWaits = new Map()
    this.priceJournal = new Map()
    this.unsubscribeStore = store.subscribe?.(change => {
      const key = seriesKey(change.instrument, change.timeframe)
      if (!this.series.has(key) || change.priceFrom === null || !Number.isSafeInteger(change.priceRevision)) return
      const journal = this.priceJournal.get(key) ?? []
      journal.push({ revision: change.priceRevision, from: change.priceFrom })
      if (journal.length > 256) journal.shift()
      this.priceJournal.set(key, journal)
    })
    this.closed = false; this.disposeTask = null; this.focusKey = null; this.requestedIDs = new Set(); this.refreshTimer = null
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
        indicatorState: live?.indicatorState ? structuredClone(live.indicatorState) : null, live: live?.live ?? null, observedAt: live?.observedAt ?? null,
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

  objectBytes(value) {
    const known = this.objectSizes.get(value)
    if (known !== undefined) return known
    const bytes = JSON.stringify(value).length * 2
    this.objectSizes.set(value, bytes)
    return bytes
  }

  updateMemory(state) {
    const cached = new Set([...(state.barCaches?.values() ?? [])].flatMap(value => value.bars))
    for (const value of state.historyBarsCache?.bars ?? []) cached.add(value)
    for (const value of state.projectedBars?.values() ?? []) cached.add(value.bar)
    state.byteSize = [...state.rows.values(), ...state.indicators.values(), ...cached].reduce((sum, value) => sum + this.objectBytes(value), 0)
    state.statisticsDeadline = Math.min(Infinity, ...[...state.rows.values()].flatMap(row => [
      !numeric(row.oi) ? Number(row.statisticsOIExpiresAt) : 0,
      !numeric(row.buy) || !numeric(row.sell) ? Number(row.statisticsTakerExpiresAt) : 0,
    ].filter(value => value > Date.now())))
  }

  trim() {
    let bytes = [...this.series.values()].reduce((sum, state) => sum + (state.byteSize ?? 0), 0)
    for (const [key, state] of this.series) {
      if (this.series.size <= this.maxSeries && bytes <= this.maxBytes) break
      if (state.active || key === this.focusKey) continue
      this.series.delete(key); this.priceJournal.delete(key); bytes -= state.byteSize ?? 0
      for (const [attemptKey, attempt] of this.sourceAttempts) if (attempt.seriesKey === key && !this.universe.has(key)) this.sourceAttempts.delete(attemptKey)
    }
    for (const [key] of this.snapshots) if (!this.universe.has(key) && !this.series.has(key)) this.snapshots.delete(key)
    const snapshotBytes = value => {
      const bars = value.frame.bars
      let size = this.objectSizes.get(bars)
      if (size === undefined) { size = bars.reduce((sum, bar) => sum + this.objectBytes(bar), 0); this.objectSizes.set(bars, size) }
      return size
    }
    let projected = [...this.snapshots.values()].reduce((sum, value) => sum + snapshotBytes(value), 0)
      + [...this.liveStates.values()].reduce((sum, state) => sum + (state.byteSize ?? 0) + 4096, 0)
    for (const [key, value] of this.snapshots) {
      if (projected <= this.maxProjectionBytes) break
      if (key === this.focusKey || this.universe.has(key)) continue
      projected -= snapshotBytes(value); this.snapshots.delete(key)
    }
    for (const [key, state] of this.liveStates) {
      if (projected <= this.maxProjectionBytes) break
      if (key === this.focusKey || this.universe.has(key) || state.active || this.series.get(key)?.active) continue
      projected -= state.byteSize ?? 0
      state.rows.clear(); state.indicators.clear(); state.barCaches?.clear(); state.projectedBars?.clear(); state.historyBarsCache = null; state.byteSize = 0
      state.indicatorFailures?.clear()
      // Quotes and fixed-size recursive checkpoints remain available on ticks.
    }
  }

  get worker() { return this.workers[0]?.worker ?? null }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(frame) { if (!this.closed) for (const listener of this.listeners) { try { listener(frame) } catch { /* A renderer cannot stop collection. */ } } }
  cached(key) { return this.snapshots.get(key)?.frame ?? null }
  latest(state) { return state.latestHour ?? null }

  setUniverse(instIds) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    this.requestedIDs = new Set(instIds.filter(Boolean))
    const previous = this.universe
    this.universe = new Map([...this.requestedIDs].flatMap(instId => TIMEFRAMES.map(timeframe => {
      const key = seriesKey(instId, timeframe)
      return [key, previous.get(key) ?? { key, instId, timeframe, controller: new AbortController() }]
    })))
    for (const [key, demand] of previous) if (!this.universe.has(key)) demand.controller.abort()
    this.reconcileSourceJobs()
    this.candidateQueue = this.candidateQueue.filter(demand => this.currentDemand(demand))
    for (const demand of this.universe.values()) this.queueCandidate(demand)
    this.trim()
    this.scheduleCandidates()
  }

  // Renderer hydration observes backend-owned membership without admitting work.
  residentFrames() {
    return { frames: [...this.universe.keys()].flatMap(key => this.cached(key) ?? []) }
  }

  currentDemand(demand) { return this.currentFocus(demand) || !this.closed && demand != null && this.universe.get(demand.key) === demand }
  sourceDemand(demand) { return this.currentDemand(demand) && (this.currentFocus(demand) || this.acquire(demand.instId, demand.timeframe)) }
  stateDemand(state) { return this.liveStates.get(state.key) === state && this.universe.get(state.key) || (this.focus?.key === state.key ? this.focus : this.universe.get(state.key)) }
  candidateVersion(demand) {
    const state = this.liveStates.get(demand.key)
    return `${Math.floor(Date.now() / intervalFor(demand.timeframe))}:${this.sourceEpoch}:${state?.generation}:${state?.priceVersion}:${state?.oiVersion}:${state?.takerVersion}:${this.store.candleRevision?.(demand.instId, demand.timeframe)}`
  }

  queueCandidate(demand, force = false) {
    if (!this.currentDemand(demand)) return
    if (this.candidateTasks.has(demand)) { if (force) demand.refreshRequested = true; return }
    if (this.candidateQueue.includes(demand)) return
    if (!force && demand.preparedVersion === this.candidateVersion(demand)) return
    this.candidateQueue.push(demand)
    queueMicrotask(() => this.drainCandidates())
  }

  drainCandidates() {
    if (this.closed) return
    while (this.candidateTasks.size < this.candidateLimit && this.candidateQueue.length) {
      const demand = this.candidateQueue.shift()
      if (!this.currentDemand(demand)) continue
      const task = Promise.resolve().then(async () => {
        const wait = operation => abortable(operation, demand.controller.signal)
        demand.controller.signal.throwIfAborted()
        const state = this.liveState(demand.instId, demand.timeframe)
        state.active += 1
        try {
          if (!state.loaded || !state.rows.has(state.latestHour)) await wait(() => this.job(`local:${state.key}`, () => this.read(state, undefined, TAIL, 'chartWarm')))
          if (!this.currentDemand(demand)) return
          this.publish(state)
          // Statistics have separate source lanes and never hold the candle
          // or exact-indicator admission queue behind an optional endpoint.
          const prices = this.refreshObservations(state, undefined, VISIBLE, VISIBLE, demand)
          await wait(() => this.seed(state, 'chartWarm', demand))
          // Already durable charts must not queue behind current-price repair.
          // That independent bounded lane publishes its new facts when ready.
          // A genuinely cold chart first needs a native price page to replay.
          if (!state.rows.size && prices) {
            await wait(() => prices.catch(() => {}))
            if (!this.currentDemand(demand)) return
            await wait(() => this.seed(state, 'chartWarm', demand))
          }
          if (!this.currentDemand(demand)) return
          this.refreshIndicators(state, demand)
          this.publish(state)
          demand.preparedVersion = this.candidateVersion(demand)
        } finally { state.active -= 1; this.trim() }
      }).catch(() => {}).finally(() => {
        if (this.candidateTasks.get(demand) === task) this.candidateTasks.delete(demand)
        if (demand.refreshRequested) { demand.refreshRequested = false; this.queueCandidate(demand, true) }
        this.drainCandidates(); this.scheduleCandidates()
      })
      this.candidateTasks.set(demand, task)
    }
  }

  scheduleCandidates() {
    if (this.candidateTimer !== null) clearTimeout(this.candidateTimer)
    this.candidateTimer = null
    this.candidateTimerAt = Infinity
    if (this.closed || !this.universe.size) return
    const now = Date.now()
    let deadline = Infinity
    for (const demand of this.universe.values()) {
      const step = intervalFor(demand.timeframe), state = this.liveStates.get(demand.key)
      let at = Math.min((Math.floor(now / step) + 1) * step + 1000,
        state?.statisticsDeadline > now ? state.statisticsDeadline : Infinity)
      for (const attempt of this.sourceAttempts.values()) if (attempt.seriesKey === demand.key && attempt.retryAt > now) at = Math.min(at, attempt.retryAt)
      demand.refreshAt = at; deadline = Math.min(deadline, at)
      if (this.cached(demand.key)?.realtimeState === 'live' && state?.observedAt != null) deadline = Math.min(deadline, state.observedAt + 30_000)
    }
    this.armCandidateTimer(deadline)
  }

  armCandidateTimer(deadline) {
    if (this.candidateTimer !== null) clearTimeout(this.candidateTimer)
    this.candidateTimerAt = deadline
    this.candidateTimer = setTimeout(() => {
      this.candidateTimer = null
      this.candidateTimerAt = Infinity
      for (const demand of this.universe.values()) {
        const state = this.liveStates.get(demand.key)
        // A quote lease is metadata, not a preparation task. It must expire
        // even while every core preparation slot awaits a slow provider.
        if (this.cached(demand.key)?.realtimeState === 'live' && state?.observedAt + 30_000 <= Date.now()) this.publish(state)
        if (demand.refreshAt <= Date.now()) this.queueCandidate(demand, true)
      }
      this.scheduleCandidates()
    }, Math.max(1, deadline - Date.now()))
    this.candidateTimer.unref?.()
  }

  scheduleQuoteExpiry(state) {
    if (this.closed || !this.universe.has(state.key) || this.cached(state.key)?.realtimeState !== 'live') return
    const deadline = state.observedAt + 30_000
    if (deadline < this.candidateTimerAt) this.armCandidateTimer(deadline)
  }

  /** Focus owns source demand, never the durable facts or an admitted local read. */
  setFocus(target, id) {
    const key = target ? seriesKey(target.instId, target.timeframe) : null
    if (target && (!intervalFor(target.timeframe) || target.endHour !== undefined && !Number.isFinite(target.endHour))) throw new Error('Invalid chart target.')
    if (id !== undefined) this.explicitFocus = true
    if (key === this.focus?.key && target?.endHour === this.focus?.end && id === this.focus?.id) return
    this.replaceFocus(target, id)
  }

  // An invalidated input generation needs a new preparation identity while
  // preserving the renderer's ownership token and selected cursor.
  replaceFocus(target, id) {
    const key = target ? seriesKey(target.instId, target.timeframe) : null
    const previous = this.focus
    const previousEnd = previous?.key === key ? previous.end ?? this.series.get(key)?.latestHour : null
    const direction = target?.endHour !== undefined && previousEnd != null ? Math.sign(target.endHour - previousEnd) : 0
    this.cancelPendingFocusRead('superseded')
    this.cancelFocusWaits('superseded')
    for (const entry of this.focusReads) {
      this.cancelFocusReadWaiters(entry, 'superseded')
      if (!this.focusReadRelevant(entry, target)) entry.obsolete = true
    }
    this.focus = target ? { key, instId: target.instId, timeframe: target.timeframe, end: target.endHour, id,
      direction: direction || (previous?.key === key ? previous.direction : 0) } : null
    this.focusKey = key
    const state = target ? this.state(target.instId, target.timeframe) : null
    if (state) state.historyEnd = target.endHour ?? null
    const candidate = this.universe.get(key), queued = this.candidateQueue.indexOf(candidate)
    if (queued > 0) { this.candidateQueue.splice(queued, 1); this.candidateQueue.unshift(candidate) }
    this.reconcileSourceJobs()
    if (this.focus) {
      const focus = this.focus
      focus.task = Promise.resolve().then(() => this.prepareFocus(focus))
      // The command acknowledges intent immediately; lifecycle notifications
      // and backend retry deadlines report independently owned source work.
      void focus.task.catch(() => {}).finally(() => this.scheduleRefresh())
    }
    this.scheduleRefresh()
    this.onFocus(this.focus)
  }

  reconcileSourceJobs() {
    const key = this.focus?.key, step = intervalFor(this.focus?.timeframe)
    const end = this.focus && (this.focus.end ?? Math.floor(Date.now() / step) * step - step)
    const from = end - (VISIBLE - 1) * step
    for (const [sourceKey, job] of this.sourceTasks) {
      job.demands = new Set([...(job.demands ?? [])].filter(demand => this.sourceDemand(demand)))
      const candidate = this.universe.get(job.seriesKey), candidateStep = job.state.intervalMS
      const candidateEnd = Math.floor(Date.now() / candidateStep) * candidateStep - candidateStep
      const displayedEnd = this.liveStates.get(job.seriesKey)?.latestHour ?? candidateEnd
      if (candidate && this.sourceDemand(candidate) && [candidateEnd, displayedEnd].some(end => job.from <= end
        && job.through >= end - (VISIBLE - 1 + (job.source === 'candles' ? INDICATOR_WARMUP : 0)) * candidateStep)) job.demands.add(candidate)
      // A nearby cursor can still use an admitted viewport/reserve page. Keep
      // that consumer attached so HistorySync need not abort and refetch it.
      if (job.seriesKey === key && (job.from <= end && job.through >= from
        || job.reserve && end >= job.reserve.from && end <= job.reserve.through)) {
        if (job.from <= end && job.through >= from) this.promoteSourceJob(job, 'interactive')
        job.demands.add(this.focus)
        continue
      }
      if (job.demands.size) continue
      this.sourceTasks.delete(sourceKey)
      if (this.tasks.get(sourceKey) === job.task) this.tasks.delete(sourceKey)
      job.controller.abort()
    }
    this.drainWarmSources()
  }

  requestFocus(instId, timeframe, end, focusId) {
    const key = seriesKey(instId, timeframe)
    if (focusId !== undefined || this.explicitFocus) return this.focus?.key === key && this.focus.id === focusId ? this.focus : null
    this.setFocus({ instId, timeframe, endHour: end })
    return this.focus
  }

  currentFocus(focus) { return !this.closed && focus !== null && focus === this.focus }
  sourceStateChanged() {
    this.sourceEpoch += 1
    this.reconcileSourceJobs()
    // Source continuity changes the quote lease, not the cached calculation.
    // Publish status immediately even when a quiet series sends no next tick.
    for (const [key, snapshot] of this.snapshots) {
      const { frame } = snapshot
      const realtimeState = freshQuote(frame.liveBar?.hour, frame.priceObservedAt, frame.intervalMS)
        && this.streaming(frame.instId, frame.timeframe) ? 'live' : 'stale'
      if (realtimeState === frame.realtimeState) continue
      const next = { ...frame, realtimeState,
        revision: this.nextRevision = Math.max(this.nextRevision + 1, this.revision(frame.instId)) }
      this.snapshots.set(key, { ...snapshot, frame: next })
      this.emit(next)
    }
    this.scheduleRefresh()
    for (const demand of this.universe.values()) this.queueCandidate(demand, true)
  }

  projectedEntry(state, row) {
    const indicator = state.indicators.get(row.timestamp), oiFresh = sourceFresh(row, 1), takerFresh = sourceFresh(row, 2)
    state.projectedBars ??= new Map()
    const cached = state.projectedBars.get(row.timestamp)
    if (cached?.row === row && cached.indicator === indicator && cached.oiFresh === oiFresh && cached.takerFresh === takerFresh) return cached
    const entry = { row, indicator, oiFresh, takerFresh, token: ++this.nextProjection, bar: Object.freeze(bar(row, indicator)) }
    state.projectedBars.set(row.timestamp, entry)
    return entry
  }

  projectBars(state, rows, projection, end) {
    state.projectedBars ??= new Map()
    const misses = rows.reduce((count, row) => {
      const cached = state.projectedBars.get(row.timestamp)
      return count + Number(!(cached?.row === row && cached.indicator === state.indicators.get(row.timestamp)
        && cached.oiFresh === sourceFresh(row, 1) && cached.takerFresh === sourceFresh(row, 2)))
    }, 0)
    const entries = () => rows.map(row => this.projectedEntry(state, row))
    const values = misses ? measureOperation({ category: 'cpu', name: 'chart.project', resource: state.instId,
      attributes: { candles: misses, intervalMS: state.intervalMS, projection } }, entries) : entries()
    const key = values.map(value => value.token).join(',')
    const previous = projection === 'history' ? state.historyBarsCache : state.barCaches.get(end)
    if (previous?.key === key) return previous.bars
    const bars = Object.freeze(values.map(value => value.bar))
    // Only arrays created here are eligible for reuse; callers may also pass
    // arbitrary arrays to indicatorStatus, even if those arrays are frozen.
    this.resolvedIndicatorStatuses.set(bars, null)
    if (projection === 'history') state.historyBarsCache = { key, bars }
    else {
      state.barCaches.set(end, { key, bars })
      while (state.barCaches.size > 4) state.barCaches.delete(state.barCaches.keys().next().value)
    }
    return bars
  }

  frame(state, end = state.latestHour, historical = false) {
    const latest = this.liveStates.get(state.key)
    if (end === state.latestHour && !state.rows.has(end) && latest !== state && latest?.rows.has(end)) return this.frame(latest, end, historical)
    const rows = [...state.rows.values()].filter(row => end === null || row.timestamp <= end && row.timestamp >= end - (VISIBLE - 1) * state.intervalMS).sort((a, b) => a.timestamp - b.timestamp)
    state.barCaches ??= new Map()
    const bars = this.projectBars(state, rows, 'viewport', end)
    const live = state.live && (end === state.latestHour || end === null) ? state.live : null
    const core = latest?.indicatorState?.lastTimestamp === state.latestHour ? latest.indicatorState : state.indicatorState
    const liveBar = live ? bar(live, core?.lastTimestamp + state.intervalMS === live.timestamp ? projectIndicatorCandle(core, live) : undefined) : undefined
    const realtime = freshQuote(live?.timestamp, state.observedAt, state.intervalMS) && this.streaming(state.instId, state.timeframe)
    const expectedEnd = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const first = Math.max(0, (end ?? expectedEnd) - (VISIBLE - 1) * state.intervalMS, state.floor ?? 0)
    const complete = end !== null && rows.length === (end - first) / state.intervalMS + 1
      && rows.every((row, index) => row.timestamp === first + index * state.intervalMS && completePriceCandle(row))
    const availability = !bars.length && !liveBar ? 'loading' : !complete ? 'partial'
      : !historical && end < expectedEnd ? 'stale' : 'ready'
    const priceStatus = this.sourceStatus(state, 'candles', first, end ?? expectedEnd, availability)
    const indicatorStatus = this.indicatorStatus(state, bars, first, end ?? expectedEnd)
    return { instId: state.instId, timeframe: state.timeframe, intervalMS: state.intervalMS, endHour: end,
      latestEnd: state.latestHour, oldestHour: state.floor, historyExhausted: state.floor !== null && (rows[0]?.timestamp ?? Infinity) <= state.floor,
      generation: state.generation, revision: this.nextRevision = Math.max(this.nextRevision + 1, this.revision(state.instId)), bars,
      priceState: priceStatus.state, priceStatus, priceAsOf: live?.timestamp ?? rows.at(-1)?.timestamp ?? null,
      priceObservedAt: state.observedAt, realtimeState: realtime ? 'live' : 'stale',
      sourceVersions: { price: state.priceVersion, oi: state.oiVersion ?? 0, taker: state.takerVersion ?? 0 },
      ...this.statisticsStatus(state, rows, first, end ?? expectedEnd),
      indicatorState: indicatorStatus.state, indicatorStatus,
      liveBar, error: priceStatus.error ?? '' }
  }

  sourceStatus(state, source, from, through, availability) {
    let status = { state: availability, from, through }
    if (!['ready', 'unavailable'].includes(availability)) {
      const pending = this.pendingSourceRanges(state, source, from, through)
      const failure = [...this.sourceAttempts.values()].filter(attempt => attempt.seriesKey === state.key && attempt.source === source
        && pending.some(range => attempt.from <= range.through && attempt.through >= range.from))
        .sort((left, right) => right.failedAt - left.failedAt)[0]
      if (failure) status = { ...status, state: 'error', error: failure.error, retryAt: failure.retryAt }
      else if (source !== 'candles' && typeof this.history.ensureStatistics !== 'function') status = { ...status, state: 'unavailable', reason: 'unsupported' }
    } else if (availability === 'unavailable' && source !== 'candles') status.reason = 'not-published'
    return this.cachedStatus(state, source, status)
  }

  cachedStatus(state, source, status) {
    state.statusCache ??= new Map()
    const { through } = status
    const key = `${source}:${through}`, previous = state.statusCache.get(key)
    if (previous && (previous === status || JSON.stringify(previous) === JSON.stringify(status))) status = previous
    state.statusCache.delete(key); state.statusCache.set(key, status)
    while (state.statusCache.size > 12) state.statusCache.delete(state.statusCache.keys().next().value)
    return status
  }

  indicatorInputVersion(state) {
    return `${FORMULA_VERSION}:${state.generation}:${state.priceVersion}:${this.priceJournal.get(state.key)?.at(-1)?.revision ?? 0}`
  }

  indicatorStatus(state, bars, from, through) {
    const inputVersion = this.indicatorInputVersion(state)
    const cached = this.resolvedIndicatorStatuses.get(bars)
    if (cached && cached.from === from && cached.through === through && cached.inputVersion === inputVersion) {
      return this.cachedStatus(state, 'indicator', cached.status)
    }
    let status = { state: 'loading', from, through, inputVersion }
    if (bars.length && bars.every(value => value.indicatorsObserved)) {
      status.state = bars.every(value => indicatorFields.every(field => numeric(value[field]))) ? 'ready' : 'unavailable'
      if (status.state === 'unavailable') status.reason = bars.some(value => value.ema === null) ? 'insufficient-history' : 'undefined-value'
    } else {
      const failure = bars.filter(value => !value.indicatorsObserved).map(value => state.indicatorFailures?.get(value.hour))
        .find(value => value?.inputVersion === inputVersion)
      if (failure) status = { ...failure, from, through, state: 'error' }
    }
    status = this.cachedStatus(state, 'indicator', status)
    // Loading and error states depend on mutable failure/retry lifecycles.
    // Resolved states depend only on these immutable bars, bounds and basis.
    if ((status.state === 'ready' || status.state === 'unavailable') && cached !== undefined) {
      this.resolvedIndicatorStatuses.set(bars, { from, through, inputVersion, status: Object.freeze(status) })
    }
    return status
  }

  statisticsStatus(state, rows, from, through) {
    const result = {}
    for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
      const complete = through !== null && rows.length === (through - from) / state.intervalMS + 1
      const status = this.sourceStatus(state, source, from, through, complete ? sourceState(rows, bit) : 'loading')
      result[`${source}State`] = status.state
      result[`${source}Status`] = status
    }
    return result
  }

  demandPriority(state, from, through, focus = this.focus) {
    const candidate = this.universe.get(state.key) === focus, selected = candidate ? this.focus : focus
    const end = selected?.end ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    if (selected?.key === state.key && from <= end && through >= end - (VISIBLE - 1) * state.intervalMS) return 'interactive'
    return candidate ? 'chartWarm' : 'prefetch'
  }

  samePublishedFrame(left, right) {
    if (!left || left.bars !== right.bars) return false
    const fields = ['instId', 'timeframe', 'intervalMS', 'endHour', 'latestEnd', 'oldestHour', 'historyExhausted', 'generation',
      'priceState', 'priceStatus', 'priceAsOf', 'priceObservedAt', 'realtimeState', 'sourceVersions',
      'oiState', 'oiStatus', 'takerState', 'takerStatus', 'indicatorState', 'indicatorStatus', 'error']
    return fields.every(field => JSON.stringify(left[field]) === JSON.stringify(right[field]))
      && JSON.stringify(left.liveBar) === JSON.stringify(right.liveBar)
  }

  samePublishedHistory(left, right) {
    if (!left || left.bars !== right.bars) return false
    const fields = ['instId', 'timeframe', 'intervalMS', 'latestEnd', 'oldestHour', 'historyExhausted', 'generation', 'priceState',
      'sourceVersions', 'oiState', 'takerState', 'indicatorState', 'error']
    const content = status => {
      if (!status) return status
      if (!['ready', 'unavailable'].includes(status.state)) return status
      const { from: _from, through: _through, ...value } = status
      return value
    }
    return fields.every(field => JSON.stringify(left[field]) === JSON.stringify(right[field]))
      && ['priceStatus', 'oiStatus', 'takerStatus', 'indicatorStatus'].every(field => JSON.stringify(content(left[field])) === JSON.stringify(content(right[field])))
  }

  publish(state) {
    // Collector/list-metric residency alone still never materializes a chart.
    if (!state.chartRequested && state.key !== this.focusKey && !this.universe.has(state.key) && !this.snapshots.has(state.key)) return null
    const built = this.frame(state), previous = this.snapshots.get(state.key)
    const frame = previous && this.samePublishedFrame(previous.frame, built) ? previous.frame : built
    if (frame !== previous?.frame) {
      this.snapshots.set(state.key, { valid: true, frame })
      if (previous?.frame.bars !== frame.bars) { this.updateMemory(state); this.trim() }
      this.emit(frame)
    }
    if (state.historyEnd !== null && state.historyEnd !== undefined && state.historyEnd !== frame.endHour) {
      const history = this.historyFrame(state, state.historyEnd)
      if (!this.samePublishedHistory(state.publishedHistoryFrame, history)) {
        // If only status/range metadata changed, the selected viewport is
        // sufficient. Keep large resident-history transfers for changed bars.
        const update = state.publishedHistoryFrame?.bars === history.bars
          ? { ...this.frame(state, state.historyEnd, true), historyExhausted: history.historyExhausted } : history
        this.emit(update); state.publishedHistoryFrame = history
      }
    }
    return frame
  }

  historyFrame(state, end) {
    const frame = this.frame(state, end, true)
    // Cursor movement changes frame metadata, not the projection of resident rows.
    const previousKey = state.historyBarsCache?.key
    frame.bars = this.projectBars(state, [...state.rows.values()].sort((a, b) => a.timestamp - b.timestamp), 'history')
    frame.historyExhausted = state.floor !== null && (frame.bars[0]?.hour ?? Infinity) <= state.floor
    if (state.historyBarsCache?.key !== previousKey) this.updateMemory(state)
    return frame
  }

  async read(state, end, limit = TAIL, priority = 'foreground', options = {}) {
    // A bounded local query belongs to its admitted state until both rows and
    // coverage arrive. Concurrent selections cannot evict it during SQLite IPC.
    state.active = (state.active ?? 0) + 1
    try { return await this.readRows(state, end, limit, priority, options) }
    finally { state.active -= 1 }
  }

  async readRows(state, end, limit, priority, options = {}) {
    const ceiling = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const ahead = options.ahead ?? HISTORY_AHEAD
    const through = end === undefined || end === null ? ceiling : Math.min(end + ahead * state.intervalMS, ceiling)
    const from = end === undefined || end === null ? undefined : Math.max(0, end - (limit - ahead - 1) * state.intervalMS)
    const admittedPrice = state.priceVersion, admittedRows = new Map(state.rows)
    const residentRevision = this.store.candleRevision?.(state.instId, state.timeframe)
    const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from, through, limit, order: 'desc' }, priority)
    if (this.closed || options.wanted && !options.wanted()) return false
    if (admittedPrice !== state.priceVersion || residentRevision !== this.store.candleRevision?.(state.instId, state.timeframe)) return this.readRows(state, end, limit, priority, options)
    const residentFirst = Math.min(...state.rows.keys()), residentLast = Math.max(...state.rows.keys())
    let pricesChanged = false, observationsChanged = false, changedFrom = Infinity, oiChanged = false, takerChanged = false
    for (const row of rows) if (row.confirmed) {
      const previous = state.rows.get(row.timestamp), prior = admittedRows.get(row.timestamp)
      // Concurrent statistics fence their own slot and source. A newer value
      // elsewhere cannot discard fresh observations at the viewport edge.
      const allowed = (!previous || !changedSource(prior, previous, 1) ? 1 : 0) | (!previous || !changedSource(prior, previous, 2) ? 2 : 0)
      const value = mergeStatistics(previous, this.normalize(row), allowed)
      // A committed hole repair may precede its observer. It changes the
      // recursive input prefix just like a correction of an existing candle.
      // Ordinary reserve expansion lies outside the retained interval.
      if (previous ? !samePrice(previous, value) : row.timestamp > residentFirst && row.timestamp < residentLast) {
        pricesChanged = true; changedFrom = Math.min(changedFrom, row.timestamp)
      }
      const unchanged = sameRecord(previous, value)
      if (!unchanged) observationsChanged = true
      if (changedSource(previous, value, 1)) oiChanged = true
      if (changedSource(previous, value, 2)) takerChanged = true
      state.rows.set(row.timestamp, immutableRecord(unchanged ? previous : value))
    }
    if (pricesChanged) state.priceVersion += 1
    if (observationsChanged) state.sourceVersion += 1
    if (oiChanged) state.oiVersion = (state.oiVersion ?? 0) + 1
    if (takerChanged) state.takerVersion = (state.takerVersion ?? 0) + 1
    if (pricesChanged) this.invalidateDerived(state, changedFrom)
    const retained = this.retainRows(state, this.liveStates.get(state.key) === state ? TAIL : this.focus?.key === state.key ? HISTORY_RESIDENT : HISTORY, end)
    const inspectedPriceVersion = state.priceVersion
    const inspectedRetentionVersion = state.retentionVersion ?? 0
    this.updateMemory(state)
    const coverage = await this.store.coverage(state.instId, state.timeframe, priority)
    if (this.closed || options.wanted && !options.wanted()) return false
    state.latestHour = coverage.last === null ? state.latestHour : Math.max(state.latestHour ?? -Infinity, coverage.last)
    const listing = Number(this.instrument(state.instId)?.listTime)
    state.floor = Number.isFinite(listing) && listing > 0 ? Math.ceil(listing / state.intervalMS) * state.intervalMS : null
    state.loaded = true
    if (limit === HISTORY) {
      // A local read proves which durable interval was inspected even when it
      // contains holes. Keep that proof separate from the rows actually found:
      // missing source data must not trigger another identical read on every
      // cursor move, and a revision change must invalidate the proof.
      const currentRetention = state.retainedRange
      if (retained && currentRetention && inspectedRetentionVersion === (state.retentionVersion ?? 0)) {
        const retainedFrom = Math.max(retained.from, currentRetention.from), retainedThrough = Math.min(retained.through, currentRetention.through)
        // An unbounded descending query only inspects its complete prefix when
        // it exhausts the ledger. A full SQL limit says nothing about older rows.
        const inspectedFrom = from ?? (rows.length < limit ? 0 : Math.min(...rows.map(row => row.timestamp)))
        let first = Math.max(inspectedFrom, retainedFrom), last = Math.min(through, retainedThrough)
        const prior = state.historyReadRange
        if (prior && prior.revision === residentRevision && prior.priceVersion === inspectedPriceVersion
          && prior.from <= last + state.intervalMS && prior.through >= first - state.intervalMS) {
          first = Math.max(retainedFrom, Math.min(first, prior.from))
          last = Math.min(retainedThrough, Math.max(last, prior.through))
        }
        state.historyReadRange = first <= last ? { from: first, through: last, revision: residentRevision, priceVersion: inspectedPriceVersion } : null
      }
      const hours = rows.filter(row => row.confirmed && state.rows.has(row.timestamp)).map(row => row.timestamp)
      // Combine same-revision admission only inside the retained facts. A late
      // overlapping query cannot narrow the current reserve's local proof.
      if (hours.length) {
        const revision = residentRevision === this.store.candleRevision?.(state.instId, state.timeframe) ? residentRevision : null
        let from = Math.min(...hours), through = Math.max(...hours)
        if (state.historyRange && state.historyRange.revision === revision && revision !== null) {
          from = Math.max(Math.min(...state.rows.keys()), Math.min(from, state.historyRange.from))
          through = Math.min(Math.max(...state.rows.keys()), Math.max(through, state.historyRange.through))
        }
        state.historyRange = { from, through, revision }
      }
    }
    const live = this.liveStates.get(state.key)
    if (live?.live) { state.live = live.live; state.observedAt = live.observedAt }
    this.syncLive(state)
    return true
  }

  retainRows(state, limit, cursor = state.historyEnd) {
    if (!state.rows.size) { state.retainedRange = null; state.historyReadRange = null; this.pruneSourceAttempts(state); return null }
    // Current navigation owns the whole reserve, even when an older query or
    // a latest-tail hydration finishes after focus has moved.
    if (limit !== TAIL && state.key === this.focus?.key) cursor = this.focus.end
    const historical = cursor !== null && cursor !== undefined
    const anchor = historical ? cursor : Math.max(...state.rows.keys())
    const ahead = historical ? limit === HISTORY_RESIDENT && this.focus?.key === state.key
      ? this.focus.direction > 0 ? limit - HISTORY_BALANCE : HISTORY_BALANCE : HISTORY_AHEAD : 0
    const first = anchor - (limit - ahead - 1) * state.intervalMS, last = anchor + ahead * state.intervalMS
    let evicted = false
    for (const hour of state.rows.keys()) if (hour < first || hour > last) {
      state.rows.delete(hour); state.indicators.delete(hour); state.projectedBars?.delete(hour)
      evicted = true
    }
    // A cursor may leave and return while coverage is pending. Matching final
    // bounds cannot restore facts discarded by an intermediate retention pass.
    if (evicted) state.retentionVersion = (state.retentionVersion ?? 0) + 1
    state.retainedRange = { from: first, through: last }
    if (state.historyReadRange) {
      const from = Math.max(first, state.historyReadRange.from), through = Math.min(last, state.historyReadRange.through)
      state.historyReadRange = from <= through ? { ...state.historyReadRange, from, through } : null
    }
    for (const hour of state.indicatorFailures?.keys() ?? []) if (!state.rows.has(hour)) state.indicatorFailures.delete(hour)
    this.pruneSourceAttempts(state)
    return state.retainedRange
  }

  pruneSourceAttempts(state) {
    // The latest tail cannot retire errors owned by a resident historical
    // reserve of the same series. Both share one bounded source lifetime.
    if (this.series.get(state.key) !== state) return
    const hours = [...state.rows.keys(), ...(this.liveStates.get(state.key)?.rows.keys() ?? [])]
    const selected = this.focus?.key === state.key ? this.focus.end ?? state.latestHour ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS : null
    const from = selected === null ? null : selected - (VISIBLE - 1) * state.intervalMS
    for (const [key, attempt] of this.sourceAttempts) if (attempt.seriesKey === state.key
      && !hours.some(hour => hour >= attempt.from && hour <= attempt.through)
      && !(selected !== null && attempt.from <= selected && attempt.through >= from)) this.sourceAttempts.delete(key)
  }

  invalidateDerived(state, from) {
    const generation = ++this.nextGeneration
    for (const current of new Set([state, this.series.get(state.key), this.liveStates.get(state.key)].filter(Boolean))) {
      current.generation = generation
      if ((current.indicatorState?.lastTimestamp ?? -Infinity) >= from) current.indicatorState = null
      for (const hour of current.indicators.keys()) if (hour >= from) current.indicators.delete(hour)
      current.indicatorFailures?.clear()
      current.indicatorVersion = (current.indicatorVersion ?? 0) + 1
    }
  }

  syncLive(state) {
    const live = this.liveState(state.instId, state.timeframe)
    if (live === state) return live
    if (state.generation < live.generation) {
      state.generation = live.generation
      state.indicators.clear(); state.indicatorState = null; state.indicatorFailures?.clear()
    }
    // Historical reserves cannot replace the separately retained latest tail.
    for (const [hour, row] of state.rows) if (hour >= state.latestHour - (TAIL - 1) * state.intervalMS) {
      const previous = live.rows.get(hour)
      if (previous && !samePrice(previous, row)) live.indicators.delete(hour)
      live.rows.set(hour, row)
      if (state.indicators.has(hour)) live.indicators.set(hour, state.indicators.get(hour))
      const failure = state.indicatorFailures?.get(hour)
      if (failure) { live.indicatorFailures ??= new Map(); live.indicatorFailures.set(hour, failure) }
    }
    for (const hour of live.rows.keys()) if (hour < state.latestHour - (TAIL - 1) * state.intervalMS) {
      live.rows.delete(hour); live.indicators.delete(hour); live.projectedBars?.delete(hour)
    }
    for (const hour of live.indicatorFailures?.keys() ?? []) if (!live.rows.has(hour)) live.indicatorFailures.delete(hour)
    if (state.indicatorState && (!live.indicatorState || state.indicatorState.lastTimestamp > live.indicatorState.lastTimestamp)) live.indicatorState = structuredClone(state.indicatorState)
    live.latestHour = state.latestHour; live.floor = state.floor; live.generation = state.generation
    live.loaded ||= state.loaded
    for (const field of ['sourceVersion', 'priceVersion', 'oiVersion', 'takerVersion', 'indicatorVersion']) live[field] = Math.max(live[field] ?? 0, state[field] ?? 0)
    live.bollExpansion = live.indicatorState?.bollExpansion ?? null
    this.updateMemory(live)
    return live
  }

  async local(instId, timeframe, { priority = 'foreground' } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    if (!intervalFor(timeframe)) throw new Error('Unsupported chart timeframe.')
    const key = seriesKey(instId, timeframe)
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    if (!state.loaded || !state.rows.has(state.latestHour)) {
      await this.job(`local:${key}`, () => this.read(state, undefined, TAIL, priority))
      // A concurrent candidate may own this coalesced SQLite read. Its compact
      // facts also admit the selected chart without another disk query.
      const live = this.liveStates.get(key)
      if (live !== state && live?.loaded && (!state.loaded || !state.rows.has(state.latestHour))) {
        for (const [hour, row] of live.rows) { state.rows.set(hour, row); if (live.indicators.has(hour)) state.indicators.set(hour, live.indicators.get(hour)) }
        for (const field of ['latestHour', 'floor', 'generation', 'sourceVersion', 'priceVersion', 'oiVersion', 'takerVersion', 'indicatorVersion', 'loaded']) state[field] = live[field]
        state.barCaches = new Map(live.barCaches ?? [])
        state.projectedBars = new Map(live.projectedBars ?? [])
        if (live.indicatorState) state.indicatorState = structuredClone(live.indicatorState)
        this.updateMemory(state)
      }
    }
    const frame = this.publish(state)
    return frame.bars.length || frame.liveBar ? frame : null
  }

  // Explicit focus reads share two actual SQLite lanes. At most one waiting
  // demand exists, and replacing focus retires it before it can enter IO.
  // Independent read-only callers do not participate in this ownership.
  cancelPendingFocusRead(reason) {
    const entry = this.pendingFocusRead
    if (!entry) return
    this.pendingFocusRead = null
    this.recordFocusCancellation(entry, reason, 'chart.history.admission')
    this.cancelFocusReadWaiters(entry)
    entry.resolveDone()
  }

  recordFocusCancellation(entry, reason, name) {
    recordOperation({ category: 'cpu', name, resource: entry.state.instId, status: 'cancelled',
      startedAt: Date.now(), durationMS: 0, attributes: { reason } })
  }

  cancelFocusReadWaiters(entry, reason) {
    for (const waiter of entry.waiters.values()) {
      if (reason) this.recordFocusCancellation(entry, reason, 'chart.history.consumer')
      waiter.resolve(false)
    }
    entry.waiters.clear()
  }

  focusReadWaiter(entry, focus) {
    let waiter = entry.waiters.get(focus)
    if (!waiter) {
      waiter = {}
      waiter.task = new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
      entry.waiters.set(focus, waiter)
    }
    return waiter.task
  }

  // Focuses may change many times while one source or indicator replay is
  // held. One observer per underlying task owns removable focus waiters.
  cancelFocusWaits(reason) {
    for (const group of this.focusWaits.values()) {
      for (const waiter of group.waiters.values()) {
        recordOperation({ category: 'cpu', name: 'chart.focus.consumer', resource: group.instId,
          status: 'cancelled', startedAt: Date.now(), durationMS: 0, attributes: { reason } })
        waiter.resolve(false)
      }
      group.waiters.clear()
    }
  }

  waitForFocus(focus, task) {
    if (!this.currentFocus(focus)) return Promise.resolve(false)
    if (!task) return Promise.resolve(true)
    let group = this.focusWaits.get(task)
    if (!group) {
      group = { instId: focus.instId, waiters: new Map() }
      this.focusWaits.set(task, group)
      const finish = (succeeded, error) => {
        if (this.focusWaits.get(task) === group) this.focusWaits.delete(task)
        for (const waiter of group.waiters.values()) succeeded ? waiter.resolve(true) : waiter.reject(error)
        group.waiters.clear()
      }
      task.then(() => finish(true), error => finish(false, error))
    }
    let waiter = group.waiters.get(focus)
    if (!waiter) {
      waiter = {}
      waiter.task = new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
      group.waiters.set(focus, waiter)
    }
    return waiter.task
  }

  focusSeed(state, focus) {
    const running = state.calculation ?? this.liveSeeds.get(state.key)
    if (!running) return this.seed(state, 'foreground', focus)
    if (state.focusSeed?.running === running) return state.focusSeed.task
    // A prior candidate or input generation may finish without covering the
    // selected reserve. Recheck once for the current owner, not once per move.
    const entry = { running }
    entry.task = running.then(() => {
      const current = this.focus
      if (!this.closed && current?.key === state.key && this.series.get(state.key) === state) return this.seed(state, 'foreground', current)
    })
    state.focusSeed = entry
    entry.task.then(() => { if (state.focusSeed === entry) state.focusSeed = null }, () => { if (state.focusSeed === entry) state.focusSeed = null })
    return entry.task
  }

  focusReadRelevant(entry, target) {
    if (entry.obsolete || !target || seriesKey(target.instId, target.timeframe) !== entry.state.key) return false
    const end = target.endHour ?? entry.state.latestHour, step = entry.state.intervalMS
    if (end == null || Math.abs(entry.end - end) > HISTORY_SHARE_DISTANCE * step) return false
    const first = Math.max(0, end - (VISIBLE - 1) * step, entry.state.floor ?? 0)
    return entry.from <= first && entry.through >= end
  }

  focusHistoryRead(state, focus, ahead, end = focus.end) {
    if (!this.currentFocus(focus) || end === undefined || end === null) return Promise.resolve(false)
    const step = state.intervalMS
    const shared = [...this.focusReads].find(entry => entry.state === state && this.focusReadRelevant(entry, { ...focus, endHour: end }))
    if (shared) return this.focusReadWaiter(shared, focus)
    const pending = this.pendingFocusRead
    if (pending?.focus === focus && pending.state === state && this.focusReadRelevant(pending, { ...focus, endHour: end })) return this.focusReadWaiter(pending, focus)
    if (this.pendingFocusRead) this.cancelPendingFocusRead('replaced')
    const entry = { state, focus, end, ahead, from: Math.max(0, end - (HISTORY - ahead - 1) * step),
      through: end + ahead * step, waiters: new Map() }
    entry.done = new Promise(resolve => { entry.resolveDone = resolve })
    const waiter = this.focusReadWaiter(entry, focus)
    if (this.focusReads.size < 2) this.startFocusRead(entry)
    else this.pendingFocusRead = entry
    return waiter
  }

  startFocusRead(entry) {
    this.focusReads.add(entry)
    const wanted = () => {
      const focus = this.focus
      return !this.closed && this.series.get(entry.state.key) === entry.state && focus != null
        && this.focusReadRelevant(entry, { ...focus, endHour: focus.end })
    }
    const task = Promise.resolve().then(async () => {
      if (!wanted()) {
        this.recordFocusCancellation(entry, this.closed ? 'closed' : 'superseded', 'chart.history.admission')
        return false
      }
      const admitted = await this.read(entry.state, entry.end, HISTORY, 'foreground', { ahead: entry.ahead, wanted })
      if (!admitted) this.recordFocusCancellation(entry, this.closed ? 'closed' : 'superseded', 'chart.history.admission')
      if (admitted && wanted()) this.focusSeed(entry.state, this.focus)
      return admitted
    })
    const finish = (succeeded, value) => {
      this.focusReads.delete(entry)
      try { if (!this.closed) this.trim() }
      catch (cleanup) {
        value = succeeded ? cleanup : new AggregateError([value, cleanup], `${value?.message ?? value}\n${cleanup.message}`, { cause: value })
        succeeded = false
      }
      for (const waiter of entry.waiters.values()) succeeded ? waiter.resolve(value) : waiter.reject(value)
      entry.waiters.clear(); entry.resolveDone()
      const next = this.pendingFocusRead
      if (next) {
        this.pendingFocusRead = null
        if (this.currentFocus(next.focus)) this.startFocusRead(next)
        else {
          this.recordFocusCancellation(next, this.closed ? 'closed' : 'superseded', 'chart.history.admission')
          this.cancelFocusReadWaiters(next); next.resolveDone()
        }
      }
    }
    task.then(value => finish(true, value), error => finish(false, error))
  }

  async localHistory(instId, timeframe, targetEnd, { focusId } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    if (!intervalFor(timeframe) || targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart target.')
    const selected = this.focus
    if (focusId !== undefined && (selected?.key !== seriesKey(instId, timeframe) || selected.id !== focusId
      || selected.end !== targetEnd && !(selected.end === undefined && targetEnd === this.series.get(selected.key)?.latestHour))) return null
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    const end = targetEnd ?? state.latestHour
    const from = Math.max(0, end - (VISIBLE - 1) * state.intervalMS, state.floor ?? 0)
    const admitted = state.historyRange
    let resident = Boolean(state.loaded && admitted && end !== null && from >= admitted.from && end <= admitted.through
      && admitted.revision === this.store.candleRevision?.(instId, timeframe))
    for (let hour = from; resident && hour <= end; hour += state.intervalMS) resident = completePriceCandle(state.rows.get(hour))
    if (!resident) {
      if (focusId === undefined) await this.job(`history:${state.key}:${targetEnd ?? 'latest'}`, () => this.read(state, targetEnd, HISTORY, 'foreground'))
      else {
        const focus = this.focus
        if (end === null || end === undefined) return null
        const ahead = this.initialHistoryAhead(end, state.intervalMS)
        if (!await this.focusHistoryRead(state, focus, ahead, end) || !this.currentFocus(focus)) return null
      }
    }
    if (focusId !== undefined && this.focus?.id !== focusId) return null
    const frame = this.historyFrame(state, targetEnd ?? state.latestHour)
    return frame.bars.length || frame.liveBar ? frame : null
  }

  async prepare(instId, timeframe, targetEnd, _historyBars = VISIBLE, { focusId } = {}) {
    if (!intervalFor(timeframe) || targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart target.')
    const focus = this.requestFocus(instId, timeframe, targetEnd, focusId)
    if (focusId !== undefined && (!focus || focus.end !== targetEnd)) return null
    if (focus) {
      await focus.task
      if (!this.currentFocus(focus)) return null
      const state = this.state(instId, timeframe)
      return targetEnd === undefined ? this.frame(state) : this.historyFrame(state, targetEnd)
    }
    const frame = targetEnd === undefined ? await this.local(instId, timeframe) : await this.localHistory(instId, timeframe, targetEnd)
    const state = this.state(instId, timeframe)
    return frame ?? (targetEnd === undefined ? this.frame(state) : this.historyFrame(state, targetEnd))
  }

  initialHistoryAhead(end, step) {
    const ceiling = Math.floor(Date.now() / step) * step - step
    return Math.min(HISTORY_BALANCE, Math.max(HISTORY_AHEAD, Math.floor((ceiling - end) / step)))
  }

  preparedHistoryReserve(state, end, reserveBars, aheadBars = 0) {
    if (end === undefined || end === null || !state.loaded) return false
    if (state.floor !== null && end < state.floor) return false
    const step = state.intervalMS, first = Math.max(0, end - (reserveBars - 1) * step, state.floor ?? 0)
    const last = Math.min(end + aheadBars * step, state.latestHour ?? end)
    const admitted = state.historyRange
    if (!admitted || admitted.from > first || admitted.through < last
      || admitted.revision !== this.store.candleRevision?.(state.instId, state.timeframe)) return false
    const inputVersion = this.indicatorInputVersion(state), attempts = new Map()
    for (const attempt of this.sourceAttempts.values()) if (attempt.seriesKey === state.key) {
      const entries = attempts.get(attempt.source) ?? []
      entries.push(attempt); attempts.set(attempt.source, entries)
    }
    for (let hour = first; hour <= last; hour += step) {
      const row = state.rows.get(hour)
      if (!completePriceCandle(row)) return false
      const failure = state.indicatorFailures?.get(hour)
      const terminalIndicatorFailure = failure?.inputVersion === inputVersion && failure.from <= hour && failure.through >= hour
      if (!state.indicators.has(hour) && !terminalIndicatorFailure) return false
      if (typeof this.history.ensureStatistics === 'function') for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
        if (sourceFresh(row, bit)) continue
        const blocked = (attempts.get(source) ?? []).some(attempt => attempt.from <= hour && attempt.through >= hour
          && (numeric(attempt.retryAt) && attempt.retryAt > Date.now()
            || attempt.sourceEpoch === this.sourceEpoch && attempt.inputVersion === this.sourceInputVersion(state, source)
              && (attempt.demands ? attempt.demands.some(demand => this.currentDemand(demand)) : attempt.focus === this.focus)))
        if (!blocked) return false
      }
    }
    return true
  }

  async prepareFocus(focus) {
    if (!this.currentFocus(focus)) return null
    const { instId, timeframe, end: targetEnd } = focus
    // The backend owns a fixed navigation reserve. Wheel cadence and renderer
    // prepare retries cannot change acquisition, cancellation, or retry policy.
    const reserveBars = HISTORY - HISTORY_AHEAD
    const reserve = targetEnd === undefined ? undefined : { from: targetEnd - (reserveBars - 1) * intervalFor(timeframe), through: targetEnd }
    const resident = this.series.get(seriesKey(instId, timeframe))
    if (resident) resident.chartRequested = true
    // Keep enough prepared runway to cover a delayed history transfer while
    // amortizing each local admission across many cursor moves.
    if (resident && this.preparedHistoryReserve(resident, targetEnd, VISIBLE + HISTORY_RUNWAY, HISTORY_RUNWAY)) {
      const first = targetEnd - (VISIBLE - 1) * resident.intervalMS
      const failureVisible = [...resident.indicatorFailures.keys()].some(hour => hour >= first && hour <= targetEnd)
        || [...this.sourceAttempts.values()].some(attempt => attempt.seriesKey === resident.key
          && attempt.from <= targetEnd && attempt.through >= first)
      if (failureVisible) this.publish(resident)
      return null
    }
    if (resident && targetEnd !== undefined && resident.loaded) {
      const needsReserveRead = () => {
        const step = resident.intervalMS, firstVisible = Math.max(0, targetEnd - (VISIBLE - 1) * step, resident.floor ?? 0)
        const admitted = resident.historyRange, revision = this.store.candleRevision?.(instId, timeframe)
        let visible = Boolean(admitted && firstVisible >= admitted.from && targetEnd <= admitted.through && admitted.revision === revision)
        for (let hour = firstVisible; visible && hour <= targetEnd; hour += step) visible = completePriceCandle(resident.rows.get(hour))
        const firstReserve = Math.max(0, targetEnd - (VISIBLE + HISTORY_RUNWAY - 1) * step, resident.floor ?? 0)
        const lastReserve = Math.min(targetEnd + HISTORY_RUNWAY * step, resident.latestHour ?? targetEnd)
        const read = resident.historyReadRange
        const valid = read && read.revision === revision && read.priceVersion === resident.priceVersion
        const older = !valid || read.from > firstReserve, newer = !valid || read.through < lastReserve
        if (!visible || !older && !newer) return null
        return newer && (!older || focus.direction > 0) ? 'newer' : 'older'
      }
      let side
      while (this.currentFocus(focus) && (side = needsReserveRead())) {
        // An admitted reserve read belongs to the series, not the transient
        // cursor that happened to request it. New cursors share it, and a
        // distant missing viewport can still take its independent read lane.
        await this.focusHistoryRead(resident, focus, side === 'newer' ? HISTORY - HISTORY_AHEAD - 1 : HISTORY_AHEAD)
      }
      if (!this.currentFocus(focus)) return null
    }
    let frame
    if (targetEnd === undefined) frame = await this.local(instId, timeframe)
    else {
      const state = this.state(instId, timeframe)
      const end = targetEnd, first = Math.max(0, end - (VISIBLE - 1) * state.intervalMS, state.floor ?? 0)
      const admitted = state.historyRange
      let visible = Boolean(state.loaded && admitted && admitted.from <= first && admitted.through >= end
        && admitted.revision === this.store.candleRevision?.(instId, timeframe))
      for (let hour = first; visible && hour <= end; hour += state.intervalMS) visible = completePriceCandle(state.rows.get(hour))
      const missing = !visible, initialAhead = this.initialHistoryAhead(end, state.intervalMS)
      if (missing) await this.focusHistoryRead(state, focus, initialAhead)
      if (!this.currentFocus(focus)) return null
      // Before asking the source for the older reserve, inspect its durable
      // rows too. A balanced initial read cannot certify the whole older page.
      const read = state.historyReadRange, revision = this.store.candleRevision?.(instId, timeframe)
      const reserveFirst = Math.max(0, end - (reserveBars - 1) * state.intervalMS, state.floor ?? 0, state.retainedRange?.from ?? 0)
      if (missing && initialAhead > HISTORY_AHEAD && (!read || read.revision !== revision
        || read.priceVersion !== state.priceVersion || read.from > reserveFirst)) {
        await this.focusHistoryRead(state, focus, HISTORY_AHEAD)
        if (!this.currentFocus(focus)) return null
      }
      frame = this.historyFrame(state, end)
    }
    const state = this.state(instId, timeframe)
    state.active += 1
    const current = () => this.currentFocus(focus)
    try {
      if (!current()) return targetEnd === undefined ? frame ?? this.frame(state) : this.historyFrame(state, targetEnd)
      const prices = this.refreshObservations(state, targetEnd, VISIBLE, targetEnd === undefined ? VISIBLE : HISTORY_PAGE, focus, reserve)
      this.focusSeed(state, focus)
      this.prefetchStatistics(state, focus)
      if (targetEnd !== undefined) {
        if (!await this.waitForFocus(focus, prices)) return null
        if (!await this.waitForFocus(focus, this.focusSeed(state, focus))) return null
        while (current() && state.calculation) if (!await this.waitForFocus(focus, state.calculation)) return null
        if (!current()) return null
        this.publish(state)
        const inspected = state.historyReadRange
        const inspectedFirst = inspected && inspected.revision === this.store.candleRevision?.(instId, timeframe)
          && inspected.priceVersion === state.priceVersion ? inspected.from : 0
        const retainedBars = state.retainedRange ? Math.max(VISIBLE, Math.floor((targetEnd - Math.max(state.retainedRange.from, inspectedFirst)) / state.intervalMS) + 1) : reserveBars
        const sourceReserveBars = Math.min(reserveBars, retainedBars)
        for (let loaded = HISTORY_PAGE; current() && loaded < sourceReserveBars; loaded += HISTORY_PAGE) {
          const through = targetEnd - loaded * state.intervalMS
          if (through < Math.max(0, state.floor ?? 0)) break
          if (!await this.waitForFocus(focus, this.refreshObservations(state, through, Math.min(HISTORY_PAGE, sourceReserveBars - loaded), undefined, focus, reserve))) return null
          if (!current()) break
          if (!await this.waitForFocus(focus, this.focusSeed(state, focus))) return null
          while (current() && state.calculation) if (!await this.waitForFocus(focus, state.calculation)) return null
          if (!current()) break
          this.publish(state)
        }
        frame = this.historyFrame(state, targetEnd)
      } else if (!frame?.bars.length && !frame?.liveBar && prices) {
        if (!await this.waitForFocus(focus, prices)) return null
        frame = this.frame(state)
      }
      return frame ?? this.frame(state)
    } finally {
      state.active -= 1
      this.trim()
    }
  }

  refreshObservations(state, targetEnd, historyBars = VISIBLE, priceBars = historyBars, focus = this.stateDemand(state), reserve) {
    if (!this.sourceDemand(focus) || focus.key !== state.key) return null
    this.refreshIndicators(state, focus)
    const { instId, timeframe, intervalMS: step } = state
    const end = targetEnd ?? Math.floor(Date.now() / step) * step - step
    const from = Math.max(0, end - (historyBars - 1) * step, state.floor ?? 0)
    const priceFrom = Math.max(0, end - (priceBars - 1) * step, state.floor ?? 0)
    const priority = this.demandPriority(state, from, end, focus)
    let pricesMissing = false
    for (let hour = priceFrom; hour <= end; hour += step) if (!completePriceCandle(state.rows.get(hour))) { pricesMissing = true; break }
    this.refreshStatistics(state, from, end, priority, reserve, focus)
    // Latest prices can trail the clock while their independent repair runs.
    // Keep every actually displayed slot in demand, including the older edge
    // that has already left the clock-aligned acquisition window.
    if (targetEnd === undefined && state.latestHour !== null && state.latestHour !== end) {
      const displayedFrom = Math.max(0, state.latestHour - (VISIBLE - 1) * step, state.floor ?? 0)
      this.refreshStatistics(state, displayedFrom, state.latestHour, priority, reserve, focus)
    }
    if (!pricesMissing || !this.history.ensurePrices && !this.history.latest) return null
    const task = this.sourceJob(`prices:${state.key}:${priceFrom}:${end}`, async (signal, job) => {
      // A latest observation proves only that candle. The durable planner owns
      // every missing slot in this window, including outages between two ticks.
      const result = typeof this.history.ensurePrices === 'function'
        ? await this.history.ensurePrices(instId, timeframe, priceFrom, end, job.priority, signal)
        : await this.history.latest(instId, timeframe, job.priority, signal)
      signal.throwIfAborted()
      // Acquisition pages are source work. Their completion refreshes the
      // active navigation reserve, never admits an obsolete subpage instead.
      const cursor = state.historyEnd ?? undefined
      await this.read(state, cursor, cursor === undefined ? TAIL : HISTORY, job.priority)
      signal.throwIfAborted()
      this.prefetchStatistics(state)
      this.seed(state, this.currentFocus(focus) ? 'foreground' : 'chartWarm', this.currentFocus(focus) ? undefined : focus); this.publish(state)
      const rows = result?.rows ? new Map(result.rows.map(row => [row.timestamp, row])) : state.rows
      for (let hour = priceFrom; hour <= end; hour += step) if (!completePriceCandle(rows.get(hour))) return false
      return true
    }, { state, source: 'candles', from: priceFrom, through: end, reserve, priority, demand: focus })
    task?.catch(() => {})
    return task
  }

  statisticsRanges(state) {
    if (state.historyEnd == null) return []
    const first = Math.max(0, state.floor ?? 0, state.retainedRange?.from ?? state.historyEnd - (HISTORY - HISTORY_AHEAD - 1) * state.intervalMS)
    const last = Math.min(state.retainedRange?.through ?? state.historyEnd + HISTORY_AHEAD * state.intervalMS,
      Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS)
    const hours = [...state.rows.keys()].filter(hour => hour >= first && hour <= last).sort((left, right) => left - right)
    const ranges = []
    for (const hour of hours) {
      const previous = ranges.at(-1)
      if (previous?.through + state.intervalMS === hour) previous.through = hour
      else ranges.push({ from: hour, through: hour })
    }
    return ranges
  }

  prefetchStatistics(state, focus = this.focus) {
    if (!this.currentFocus(focus) || focus.key !== state.key) return
    // Durable prices already admit this bounded navigation reserve. Its OI
    // and Taker coverage must advance without waiting for a price cache miss.
    for (const reserve of this.statisticsRanges(state)) this.refreshStatistics(state, reserve.from, reserve.through, 'prefetch', reserve, focus)
  }

  refreshStatistics(state, from, through, priority, reserve, demand = this.stateDemand(state)) {
    if (!this.sourceDemand(demand) || typeof this.history.ensureStatistics !== 'function') return
    const { instId, timeframe, intervalMS: step } = state
    for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
      // Skipping an active range also means sharing its lifetime. Otherwise a
      // focus change can cancel the edge repair a candidate just reused.
      for (const job of this.sourceTasks.values()) if (job.seriesKey === state.key && job.source === source && job.from <= through && job.through >= from) {
        if (demand) job.demands.add(demand)
        job.reserve ??= reserve
        this.promoteSourceJob(job, priority)
      }
      for (const bounds of this.pendingSourceRanges(state, source, from, through)) {
        this.sourceJob(`${source}:${state.key}:${bounds.from}:${bounds.through}`, async (signal, job) => {
          const result = await this.history.ensureStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, signal, source)
          signal.throwIfAborted()
          await this.observeStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, result?.rows, source)
          signal.throwIfAborted()
          for (let hour = bounds.from; hour <= bounds.through; hour += step) { const row = state.rows.get(hour); if (row && !sourceFresh(row, bit)) return false }
          return true
        }, { state, source, ...bounds, reserve, priority, demand })?.catch(() => {})
      }
    }
  }

  indicatorDemand(state, focus = this.stateDemand(state)) {
    if (!this.sourceDemand(focus) || focus.key !== state.key || typeof this.history.ensurePrices !== 'function') return null
    const expectedEnd = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const end = focus.end ?? (this.universe.get(state.key) === focus ? state.latestHour ?? expectedEnd : expectedEnd)
    const floor = state.floor ?? 0, first = Math.max(0, end - (VISIBLE - 1) * state.intervalMS, floor)
    let from = Infinity, through = -Infinity
    for (let hour = first; hour <= end; hour += state.intervalMS) {
      const calculated = state.indicators.get(hour)
      if (!calculated) continue
      if (!numeric(calculated.ema) && hour >= floor + INDICATOR_WARMUP * state.intervalMS) {
        from = Math.min(from, hour - INDICATOR_WARMUP * state.intervalMS); through = hour
      }
      // VWAP can lack offscreen native volumes even when EMA is mature.
      // An observed zero-volume window is mathematically undefined, not a gap.
      if (!numeric(calculated.vwap) && hour >= floor + 13 * state.intervalMS) {
        const start = hour - 13 * state.intervalMS
        for (let stamp = start; stamp <= hour; stamp += state.intervalMS) if (!completePriceCandle(state.rows.get(stamp))) {
          from = Math.min(from, start); through = hour; break
        }
      }
    }
    return from < Infinity ? { from, through } : null
  }

  refreshIndicators(state, focus = this.stateDemand(state)) {
    const demand = this.indicatorDemand(state, focus)
    if (!demand) return null
    const { from, through } = demand
    const task = this.sourceJob(`prices:${state.key}:${from}:${through}`, async (signal, job) => {
      const watermark = () => this.store.priceWatermark?.(state.instId, state.timeframe, job.priority)
        ?? this.store.candleWatermark(state.instId, state.timeframe, job.priority)
      const revision = await watermark(), generation = state.generation
      const result = await this.history.ensurePrices(state.instId, state.timeframe, from, through, job.priority, signal)
      signal.throwIfAborted()
      // A prepend or an offscreen hole repair changes recursive descendants,
      // even when a local tail read cannot see the changed source candle.
      if (revision !== await watermark() && generation === state.generation) this.invalidateDerived(state, from)
      const cursor = state.historyEnd ?? undefined
      await this.read(state, cursor, cursor === undefined ? TAIL : HISTORY, job.priority)
      signal.throwIfAborted()
      const rows = result?.rows ?? await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from, through }, job.priority)
      signal.throwIfAborted()
      const byHour = new Map(rows.map(row => [row.timestamp, row]))
      let complete = true
      for (let hour = from; hour <= through; hour += state.intervalMS) if (!completePriceCandle(byHour.get(hour))) { complete = false; break }
      // A previous consumer may have committed these inputs before cancellation
      // or another generation change. Its cached warmup nulls still need replay.
      if (complete && this.indicatorDemand(state, focus)) this.invalidateDerived(state, from)
      this.seed(state, this.currentFocus(focus) ? 'foreground' : 'chartWarm', this.currentFocus(focus) ? undefined : focus); this.publish(state)
      return complete
    }, { state, source: 'candles', from, through, priority: this.demandPriority(state, from, through, focus), demand: focus })
    task?.catch(() => {})
    return task
  }

  promoteSourceJob(job, priority) {
    if (priorityRank(priority) <= priorityRank(job.priority)) return
    job.priority = priority
    this.drainWarmSources()
    const [instId, timeframe] = [job.state.instId, job.state.timeframe]
    this.history.promoteSource?.(instId, timeframe, job.source, job.from, job.through, priority)?.catch?.(() => {})
  }

  sourceRetryAt(state, source, from, through) {
    if (!this.sourceAttempts.size) return 0
    const pending = this.pendingSourceRanges(state, source, from, through)
    let retryAt = 0
    for (const attempt of this.sourceAttempts.values()) if (attempt.seriesKey === state.key && attempt.source === source
      && pending.some(range => attempt.from <= range.through && attempt.through >= range.from)
      && numeric(attempt.retryAt)) retryAt = Math.max(retryAt, attempt.retryAt)
    return retryAt > Date.now() ? retryAt : 0
  }

  sourceInputVersion(state, source) { return source === 'candles' ? state.priceVersion : source === 'oi' ? state.oiVersion : state.takerVersion }

  sourceBlocked(state, source, from, through) {
    if (this.sourceRetryAt(state, source, from, through)) return true
    const pending = this.pendingSourceRanges(state, source, from, through)
    return [...this.sourceAttempts.values()].some(attempt => attempt.seriesKey === state.key && attempt.source === source
      && attempt.retryAt === undefined && (attempt.demands ? attempt.demands.some(demand => this.currentDemand(demand)) : attempt.focus === this.focus) && attempt.sourceEpoch === this.sourceEpoch
      && attempt.inputVersion === this.sourceInputVersion(state, source)
      && pending.some(range => attempt.from <= range.through && attempt.through >= range.from))
  }

  pendingSourceRanges(state, source, from, through) {
    const jobs = [...this.sourceTasks.values()].filter(job => job.seriesKey === state.key && job.source === source)
    const ranges = []
    for (let hour = from; hour <= through; hour += state.intervalMS) {
      const row = state.rows.get(hour)
      if ((source === 'candles' ? completePriceCandle(row) : sourceFresh(row, source === 'oi' ? 1 : 2))
        || jobs.some(job => job.from <= hour && job.through >= hour)) continue
      const previous = ranges.at(-1)
      if (previous?.through + state.intervalMS === hour) previous.through = hour
      else ranges.push({ from: hour, through: hour })
    }
    return ranges
  }

  // Each optional provider has its own bounded lane; a slow statistic cannot
  // consume the slots that make another candidate's prices/indicators ready.
  drainWarmSources() {
    this.warmSourceQueue = this.warmSourceQueue.filter(job => !job.controller.signal.aborted)
    for (const job of [...this.warmSourceQueue]) {
      const active = this.warmSourceActive.get(job.source) ?? 0
      if (job.priority === 'chartWarm' && active >= this.candidateLimit) continue
      this.warmSourceQueue.splice(this.warmSourceQueue.indexOf(job), 1)
      this.warmSourceActive.set(job.source, active + 1)
      job.admitted = true; job.admit()
    }
  }

  sourceJob(key, operation, { state, source, from, through, reserve, priority = 'interactive', demand = this.focus }) {
    const existing = this.sourceTasks.get(key) ?? [...this.sourceTasks.values()].find(job => job.seriesKey === state.key && job.source === source && job.from <= from && job.through >= through)
    if (existing) { existing.reserve ??= reserve; if (demand) existing.demands.add(demand); this.promoteSourceJob(existing, priority); return existing.task }
    if (this.sourceBlocked(state, source, from, through)) return null
    const controller = new AbortController(), signal = controller.signal
    const job = { controller, state, source, seriesKey: state.key, from, through, reserve, priority, demands: new Set(demand ? [demand] : []), task: null }
    const failed = error => {
      const now = Date.now()
      this.sourceAttempts.set(key, { seriesKey: state.key, source, from, through, failedAt: now,
        focus: this.focus, demands: [...job.demands], sourceEpoch: this.sourceEpoch, inputVersion: this.sourceInputVersion(state, source),
        error: error?.message || `${source === 'oi' ? 'Open interest' : source === 'taker' ? 'Taker' : 'Price'} history is incomplete for this range.`,
        ...(Number.isFinite(error?.retryAt) && error.retryAt > now ? { retryAt: error.retryAt } : {}) })
    }
    const task = Promise.resolve().then(async () => {
      try {
        if (priority === 'chartWarm') await abortable(() => new Promise(resolve => {
          job.admit = resolve; this.warmSourceQueue.push(job); this.drainWarmSources()
        }), signal)
        const result = await abortable(() => operation(signal, job), signal)
        signal.throwIfAborted()
        if (result === false) failed()
        else this.sourceAttempts.delete(key)
        return result
      } catch (error) {
        if (!signal.aborted) failed(error)
        throw error
      } finally {
        if (job.admitted) this.warmSourceActive.set(source, this.warmSourceActive.get(source) - 1)
        this.drainWarmSources()
        if (this.sourceTasks.get(key) === job) this.sourceTasks.delete(key)
        if (this.tasks.get(key) === task) this.tasks.delete(key)
        if (!this.closed) {
          state.statusVersion = (state.statusVersion ?? 0) + 1
          if (!signal.aborted) this.publish(state)
          setImmediate(() => this.scheduleRefresh()).unref?.()
          this.scheduleCandidates()
        }
      }
    })
    job.task = task; this.sourceTasks.set(key, job); this.tasks.set(key, task)
    state.statusVersion = (state.statusVersion ?? 0) + 1
    this.publish(state)
    return task
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.closed || !this.focus) { this.repairDeadlines.clear(); return }
    const focus = this.focus
    const state = this.series.get(this.focusKey)
    if (!state) { this.repairDeadlines.clear(); return }
    const now = Date.now(), step = state.intervalMS, boundary = Math.floor(now / step) * step
    const end = focus.end ?? boundary - step, from = Math.max(0, end - (VISIBLE - 1) * step, state.floor ?? 0)
    let deadline = boundary + step + 1000, missingPrices = false
    const repairDeadlines = new Map()
    const repair = (source, from, through) => {
      const key = `${state.key}:${source}:${from}:${through}`
      // Missing-source demand has an absolute due time. Fresh live quotes may
      // renew their own lease, but cannot debounce historical repair forever.
      const retryAt = this.sourceRetryAt(state, source, from, through)
      if (!retryAt && this.sourceBlocked(state, source, from, through)) return
      const at = retryAt || this.repairDeadlines.get(key) || now + 1000
      repairDeadlines.set(key, at); deadline = Math.min(deadline, at)
    }
    for (let hour = from; hour <= end; hour += step) {
      const row = state.rows.get(hour)
      if (!completePriceCandle(row)) missingPrices = true
    }
    if (missingPrices && (this.history.latest || this.history.ensurePrices)
      && this.pendingSourceRanges(state, 'candles', from, end).length) repair('candles', from, end)
    const statisticsRanges = [{ from, through: end }, ...this.statisticsRanges(state)]
    if (focus.end === undefined && state.latestHour !== null && state.latestHour !== end)
      statisticsRanges.push({ from: Math.max(0, state.latestHour - (VISIBLE - 1) * step, state.floor ?? 0), through: state.latestHour })
    for (const bounds of statisticsRanges) for (let hour = bounds.from; hour <= bounds.through; hour += step) {
      const row = state.rows.get(hour)
      for (const bit of [1, 2]) {
        if (sourceFresh(row, bit) && (bit === 1 ? !numeric(row.oi) : !numeric(row.buy) || !numeric(row.sell))) {
          const expiry = Number(row[bit === 1 ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'])
          if (expiry > now) deadline = Math.min(deadline, expiry)
        }
      }
    }
    if (this.history.ensureStatistics) for (const source of ['oi', 'taker']) {
      for (const bounds of statisticsRanges)
        for (const pending of this.pendingSourceRanges(state, source, bounds.from, bounds.through)) repair(source, pending.from, pending.through)
    }
    const indicators = this.indicatorDemand(state, focus)
    if (indicators) {
      const active = [...this.sourceTasks.values()].some(job => job.seriesKey === state.key && job.source === 'candles'
        && job.from <= indicators.from && job.through >= indicators.through)
      if (!active) repair('candles', indicators.from, indicators.through)
    }
    this.repairDeadlines = repairDeadlines
    if (this.cached(state.key)?.realtimeState === 'live' && state.observedAt !== null) deadline = Math.min(deadline, state.observedAt + 30_000)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.currentFocus(focus)) return
      if (state.statisticsDeadline <= Date.now()) { state.freshnessVersion = (state.freshnessVersion ?? 0) + 1; state.statisticsDeadline = Infinity }
      this.publish(state) // Expired quote/empty-observation leases change status only.
      this.refreshObservations(state, focus.end, VISIBLE, VISIBLE, focus)
      this.prefetchStatistics(state, focus)
      this.scheduleRefresh()
    }, Math.max(1, deadline - now))
    this.refreshTimer.unref?.()
  }

  reconcileCanonical(state, rows) {
    let changedFrom = Infinity
    for (const current of new Set([state, this.series.get(state.key), this.liveStates.get(state.key)].filter(Boolean))) {
      let changed = false
      for (const row of rows) {
        const previous = current.rows.get(row.timestamp), value = this.normalize(row)
        if (!previous || samePrice(previous, value)) continue
        current.rows.set(row.timestamp, immutableRecord(mergeStatistics(previous, value)))
        changedFrom = Math.min(changedFrom, row.timestamp); changed = true
      }
      if (changed) { current.priceVersion += 1; current.sourceVersion += 1 }
    }
    if (changedFrom === Infinity) return false
    this.invalidateDerived(state, changedFrom)
    this.publish(state)
    return true
  }

  async refreshChangedCanonical(state, version) {
    if (this.closed || state.priceVersion !== version) return
    // SQLite may have committed a correction before its observer message is
    // delivered. No calculated state can be certified by that later revision.
    state.priceVersion += 1; state.sourceVersion += 1
    this.invalidateDerived(state, -Infinity)
    await this.read(state, state.historyEnd ?? undefined, state.historyEnd == null ? TAIL : HISTORY)
    const live = this.liveStates.get(state.key)
    if (live?.rows.size) await this.read(live, undefined, TAIL)
    this.publish(state)
  }

  unchangedPrefix(state, before, after, end) {
    const first = /^sqlite:(\d+):(\d+)$/.exec(before), last = /^sqlite:(\d+):(\d+)$/.exec(after)
    if (!first || !last || first[1] !== last[1]) return false
    const from = Number(first[2]), through = Number(last[2])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || through <= from || through - from > 256) return false
    const changes = (this.priceJournal.get(state.key) ?? []).filter(change => change.revision > from && change.revision <= through)
    return changes.length === through - from && changes.every((change, index) => change.revision === from + index + 1 && change.from > end)
  }

  seed(state, priority = 'background', demand) {
    if (this.closed || !state.rows.size && !this.liveStates.get(state.key)?.rows.size) return Promise.resolve()
    const focusOwned = demand != null && demand === this.focus
    const owner = () => {
      if (this.closed) return null
      if (!demand) return { demand: undefined, priority }
      if (focusOwned) {
        return this.focus?.key === state.key ? { demand: this.focus, priority: 'foreground' } : null
      }
      return this.currentDemand(demand) ? { demand, priority } : null
    }
    if (state.calculation) return state.calculation.then(() => {
      const current = owner()
      return current ? this.seed(state, current.priority, current.demand) : undefined
    })
    const shared = this.liveSeeds.get(state.key)
    if (shared) return shared.then(() => {
      const current = owner()
      return current ? this.seed(state, current.priority, current.demand) : undefined
    })
    const stillNeeded = () => owner() !== null
    if (!stillNeeded()) return Promise.resolve()
    const live = this.syncLive(state)
    // Selection can create a resident history state while this replay is in
    // flight. Deliver each native chunk to its current consumers as well.
    const residents = () => [...new Set([state, live, this.series.get(state.key)].filter(Boolean))]
    const inputVersion = () => this.indicatorInputVersion(state)
    const missing = current => [...current.rows.keys()].filter(hour => !current.indicators.has(hour)
      && current.indicatorFailures?.get(hour)?.inputVersion !== inputVersion()).sort((a, b) => a - b)
    const needed = () => {
      const resident = missing(state), end = state.historyEnd ?? state.latestHour
      const viewport = resident.filter(hour => hour >= end - (VISIBLE - 1) * state.intervalMS && hour <= end)
      if (viewport.length) return viewport
      // A correction also rebuilds the live seed, without waiting for a second
      // historical reserve to finish or replacing it with an older replay.
      const tail = missing(live)
      return tail.length ? tail : resident
    }
    const initialDemand = needed()
    if (!initialDemand.length) return Promise.resolve()
    // Replacing a failed input basis starts a new observable lifecycle without
    // discarding separately prepared prices or statistic observations.
    for (const current of residents()) for (const [hour, failure] of current.indicatorFailures ?? []) {
      if (failure.inputVersion !== inputVersion()) current.indicatorFailures.delete(hour)
    }
    state.active += 1
    let restart = false, failedDemand = initialDemand, failedFrom = 0, admittedInput = inputVersion(), workerRecovery = false
    const task = (async () => {
      while (stillNeeded()) {
        const demand = needed()
        if (!demand.length) break
        failedDemand = demand; failedFrom = 0; admittedInput = inputVersion()
        const first = demand[0], end = demand.at(-1)
        let version = state.priceVersion, generation = state.generation
        const watermark = () => this.store.priceWatermark?.(state.instId, state.timeframe, priority) ?? this.store.candleWatermark(state.instId, state.timeframe, priority)
        // Fence the checkpoint lookup as well as the candle chunks. A correction
        // cannot pair an old recursive seed with a newer durable source revision.
        let sourceRevision = await watermark()
        const currentBasis = async () => {
          if (!stillNeeded()) return false
          const current = await watermark()
          if (sourceRevision === current && version === state.priceVersion && generation === state.generation) return true
          // Only a complete durable mutation journal can prove that later facts
          // leave this recursive prefix unchanged. Missing/racing events retain
          // the strict fence used for checkpoint and source correctness.
          if (this.unchangedPrefix(state, sourceRevision, current, end)) {
            sourceRevision = current; version = state.priceVersion; generation = state.generation
            return true
          }
          restart = true
          if (version === state.priceVersion && generation === state.generation) await this.refreshChangedCanonical(state, version)
          return false
        }
        const checkpoint = await this.store.readIndicatorCheckpoint?.({ instrument: state.instId, timeframe: state.timeframe, before: first - state.intervalMS, formulaVersion: FORMULA_VERSION }, priority)
        if (!await currentBasis()) return
        let calculated = checkpoint?.state ?? null, cursor = checkpoint ? checkpoint.timestamp + state.intervalMS : 0, progressed = false
        while (stillNeeded() && cursor <= end) {
          failedFrom = cursor
          const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from: cursor, through: end, limit: CHUNK, order: 'asc' }, priority)
          if (!stillNeeded()) return
          if (!rows.length) break
          failedFrom = rows[0].timestamp
          const result = await this.calculate(rows, state.intervalMS, state.key === this.focusKey ? 'foreground' : priority, calculated)
          if (!await currentBasis()) return
          if (this.reconcileCanonical(state, rows)) { restart = true; return }
          calculated = result.state
          const save = () => this.store.writeIndicatorCheckpoint?.({ instrument: state.instId, timeframe: state.timeframe, timestamp: calculated.lastTimestamp, formulaVersion: FORMULA_VERSION, state: calculated, sourceRevision, bollExpansion: calculated.bollExpansion }, priority)
          if (await save() === false) {
            if (!await currentBasis()) return
            if (await save() === false) { await this.refreshChangedCanonical(state, version); restart = true; return }
          }
          if (!await currentBasis()) return
          let changed = false
          for (const value of result.bars) for (const current of residents()) if (current.rows.has(value.hour)) {
            current.indicators.set(value.hour, immutableRecord(value)); changed = true; progressed = true
          }
          for (const current of residents()) if (!current.indicatorState || calculated.lastTimestamp > current.indicatorState.lastTimestamp) {
            current.indicatorState = structuredClone(calculated); current.bollExpansion = calculated.bollExpansion
          }
          if (changed) {
            const version = Math.max(...residents().map(current => current.indicatorVersion ?? 0)) + 1
            for (const current of residents()) current.indicatorVersion = version
            this.updateMemory(state); this.updateMemory(live); this.publish(state)
          }
          cursor = rows.at(-1).timestamp + state.intervalMS
        }
        // Invalid source rows cannot cause a busy loop. A later actual source
        // update retries them; every calculated warm-up null is still observed.
        if (!progressed) break
      }
    })().catch(error => {
      if (this.closed || admittedInput !== inputVersion()) { restart = !this.closed; return }
      const retryOn = error?.code === 'PREPARED_CHART_WORKER_UNAVAILABLE' || error?.name === 'WorkerExitError' ? 'worker-recovery' : 'input-change'
      const failure = { state: 'error', from: failedFrom, through: Math.max(failedDemand.at(-1), state.latestHour ?? -Infinity), inputVersion: admittedInput,
        error: error?.message || 'Could not calculate indicators.', retryOn }
      for (const current of residents()) {
        current.indicatorFailures ??= new Map()
        for (const hour of current.rows.keys()) if (hour >= failure.from && hour <= failure.through && !current.indicators.has(hour)) current.indicatorFailures.set(hour, failure)
      }
      state.statusVersion = (state.statusVersion ?? 0) + 1
      this.publish(state)
      // One replacement worker may recover an interrupted calculation. A
      // repeatedly crashing input then waits for input or a healthy worker;
      // refresh callbacks cannot spin on the same failure.
      if (retryOn === 'worker-recovery' && state.workerRecoveryInput !== admittedInput) {
        state.workerRecoveryInput = admittedInput; workerRecovery = true
      }
    }).finally(() => {
      state.active -= 1
      if (state.calculation === task) state.calculation = null
      this.liveSeeds.delete(state.key); this.trim()
      if (!this.closed && workerRecovery) {
        let recovered = false
        for (const current of residents()) for (const [hour, failure] of current.indicatorFailures ?? []) {
          if (failure.retryOn === 'worker-recovery' && failure.inputVersion === admittedInput) {
            current.indicatorFailures.delete(hour); recovered = true
          }
        }
        if (recovered) state.statusVersion = (state.statusVersion ?? 0) + 1
      }
      const current = owner()
      if (current && (restart || workerRecovery)) { this.publish(state); this.seed(state, current.priority, current.demand) }
      if (!this.closed) { this.refreshIndicators(state); this.scheduleRefresh() }
    })
    state.calculation = task; this.liveSeeds.set(state.key, task)
    this.publish(state)
    return task
  }

  observe(rows, previous) {
    return measureOperation({ category: 'cpu', name: 'indicators.observe', attributes: { candles: rows.length, execution: 'inline' } }, () => {
    for (const [key, batch] of Map.groupBy(rows, row => seriesKey(row.instrument, row.timeframe))) {
      const state = this.series.get(key), live = this.liveStates.get(key)
      let changedFrom = Infinity
      for (const current of [state, live].filter(Boolean)) {
        for (const row of batch.toSorted((a, b) => a.timestamp - b.timestamp)) {
          const changed = !samePrice(previous.get(row.timestamp), row)
          if (changed) {
            current.priceVersion += 1
            if (row.timestamp <= (current.latestHour ?? -Infinity)) changedFrom = Math.min(changedFrom, row.timestamp)
            else if (current.indicatorState) {
              const value = appendConfirmed(current.indicatorState, row)
              current.bollExpansion = current.indicatorState.bollExpansion
              if (value) current.indicators.set(value.hour, immutableRecord({ ...value, indicatorsObserved: true }))
            }
          }
          if (changedSource(previous.get(row.timestamp), row, 1)) current.oiVersion = (current.oiVersion ?? 0) + 1
          if (changedSource(previous.get(row.timestamp), row, 2)) current.takerVersion = (current.takerVersion ?? 0) + 1
          const prior = current.rows.get(row.timestamp), value = mergeStatistics(prior, this.normalize(row))
          if (!sameRecord(prior, value)) { current.rows.set(row.timestamp, immutableRecord(value)); current.sourceVersion += 1 }
          current.latestHour = Math.max(current.latestHour ?? -Infinity, row.timestamp)
          if (current.live?.timestamp <= row.timestamp) current.live = null
        }
        const rowLimit = current === live ? TAIL : this.focus?.key === current.key ? HISTORY_RESIDENT : HISTORY
        this.retainRows(current, rowLimit)
        this.updateMemory(current)
      }
      if (changedFrom < Infinity) this.invalidateDerived(state ?? live, changedFrom)
      if (state) {
        this.publish(state); this.seed(state, key === this.focusKey ? 'foreground' : 'background')
        this.prefetchStatistics(state); this.scheduleRefresh()
      }
      else if (live && this.universe.has(key)) {
        this.publish(live)
        this.queueCandidate(this.universe.get(key))
      }
    }
    })
  }


  async observeStatistics(instId, timeframe, from, through, priority, inputRows, source) {
    const key = seriesKey(instId, timeframe), state = this.series.get(key), live = this.liveStates.get(key)
    const admitted = [state, live].filter(Boolean).map(current => ({ current,
      rows: new Map([...current.rows].filter(([hour]) => hour >= from && hour <= through)) })).filter(value => value.rows.size)
    if (!admitted.length) return
    priority ??= this.demandPriority(state ?? live, from, through) === 'interactive' ? 'interactive' : 'background'
    const hours = admitted.flatMap(value => [...value.rows.keys()])
    // Acquisition already returns its committed projection. Both chart and live
    // residency reuse those same rows, or share one bounded SQLite read.
    const rows = inputRows ?? await this.store.candles({ instrument: instId, timeframe, from: Math.min(...hours), through: Math.max(...hours), limit: HISTORY, order: 'asc' }, priority)
    let changed = false
    for (const { current, rows: prior } of admitted) {
      let observationsChanged = false
      for (const row of rows) if (current.rows.has(row.timestamp) && prior.has(row.timestamp)) {
        const previous = current.rows.get(row.timestamp), normalized = this.normalize(row)
        // A newer observation fences only that slot and source. It cannot
        // discard the unrelated observations in an admitted history page.
        const allowed = ((changedSource(prior.get(row.timestamp), previous, 1) ? 0 : 1)
          | (changedSource(prior.get(row.timestamp), previous, 2) ? 0 : 2)) & (source === 'oi' ? 1 : source === 'taker' ? 2 : 3)
        const value = mergeStatistics(previous, { ...previous, ...Object.fromEntries(statisticsFields.map(field => [field, normalized[field]])) }, allowed)
        if (changedSource(previous, value, 1)) current.oiVersion = (current.oiVersion ?? 0) + 1
        if (changedSource(previous, value, 2)) current.takerVersion = (current.takerVersion ?? 0) + 1
        if (!sameRecord(previous, value)) { current.rows.set(row.timestamp, immutableRecord(value)); observationsChanged = true }
      }
      if (observationsChanged) { current.sourceVersion += 1; changed = true; this.updateMemory(current) }
    }
    if (changed && state) this.publish(state)
    else if (changed && live && this.universe.has(key)) this.publish(live)
  }

  invalidate(instId, timeframe) {
    const key = seriesKey(instId, timeframe), state = this.series.get(key), live = this.liveStates.get(key)
    for (const entry of this.focusReads) if (entry.state.key === key) entry.obsolete = true
    const generation = ++this.nextGeneration
    for (const current of new Set([state, live].filter(Boolean))) {
      current.priceVersion += 1; current.generation = generation; current.indicatorState = null; current.indicators.clear(); current.loaded = false; current.historyRange = null; current.rows.clear(); current.latestHour = null
      current.indicatorFailures?.clear()
      current.barCaches?.clear(); current.projectedBars?.clear(); current.historyBarsCache = null
      current.publishedHistoryFrame = null
    }
    this.snapshots.delete(key)
    const focus = this.focus?.key === key ? this.focus : null
    if (focus) this.replaceFocus({ instId, timeframe, endHour: focus.end }, focus.id)
    const demand = this.universe.get(key)
    if (demand) this.queueCandidate(demand, true)
  }

  async setLive(instId, timeframe, candle, context = {}) {
    const observedAt = typeof context === 'number' ? context : context.receivedAt ?? Date.now()
    if (this.closed) return null
    if (!intervalFor(timeframe) || candle && (candle.confirmed || candle.instrument !== instId || candle.timeframe !== timeframe)) throw new Error('Invalid forming candle.')
    const live = this.liveState(instId, timeframe), state = this.series.get(live.key)
    if (candle && live.live && (candle.timestamp < live.live.timestamp || candle.timestamp === live.live.timestamp && candle.volume < live.live.volume)) return this.cached(live.key)
    for (const current of [live, state].filter(Boolean)) { current.live = candle; current.observedAt = observedAt }
    // A current price can publish before any historical seed has been restored.
    if (state) { const frame = this.publish(state); this.scheduleRefresh(); this.scheduleQuoteExpiry(live); return frame }
    if (this.universe.has(live.key)) { const frame = this.publish(live); this.scheduleQuoteExpiry(live); return frame }
    return null
  }

  job(key, operation) {
    if (this.tasks.has(key)) return this.tasks.get(key)
    const task = Promise.resolve().then(() => { if (this.closed) throw new Error('Prepared chart data service is closed.'); return operation() }).finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key) })
    this.tasks.set(key, task); return task
  }

  calculate(candles, intervalMS, priority = 'foreground', checkpoint = null) {
    if (this.closed) return Promise.reject(new Error('Prepared chart data service is closed.'))
    const id = ++this.nextCalculation
    return new Promise((resolve, reject) => {
      const operation = createWorkerRequest('prepared-chart', 'calculate', resolve, reject, { priority, inputRows: candles.length })
      this.calculations.set(id, { id, candles, intervalMS, checkpoint, priority, ...operation })
      this.calculationQueue.push(id); this.drainCalculations()
    })
  }
  drainCalculations() {
    if (this.closed) return
    while (this.workers.length < this.workerLimit && this.workers.length < this.calculationQueue.length + this.workers.filter(slot => slot.busy !== null).length) {
      const slot = { worker: createOperationWorker(new URL('./prepared-chart-worker.js', import.meta.url), {}, 'prepared-chart'), busy: null }
      slot.worker.unref()
      slot.worker.on('message', ({ id, bars, state, error }) => {
        const pending = this.calculations.get(id)
        if (!pending) return
        this.calculations.delete(id); slot.busy = null; slot.worker.unref()
        if (error) pending.reject(new Error(error)); else {
          pending.resolve({ bars, state })
          const key = pending.candles[0] && seriesKey(pending.candles[0].instrument, pending.candles[0].timeframe)
          const residents = new Set([...this.series.values(), ...[...this.universe.keys()].map(key => this.liveStates.get(key)).filter(Boolean)])
          for (const current of residents) if (current.key !== key && [...current.indicatorFailures?.values() ?? []].some(value => value.retryOn === 'worker-recovery')) {
            let recovered = false
            for (const target of [current, this.liveStates.get(current.key)].filter(Boolean)) for (const [hour, failure] of target.indicatorFailures ?? []) {
              if (failure.retryOn === 'worker-recovery') { target.indicatorFailures.delete(hour); recovered = true }
            }
            if (recovered) current.statusVersion = (current.statusVersion ?? 0) + 1
            setImmediate(() => { if (!this.closed) this.seed(current, this.universe.has(current.key) ? 'chartWarm' : 'background', this.universe.get(current.key)) }).unref?.()
          }
        }
        this.drainCalculations()
      })
      const failed = error => {
        if (!this.workers.includes(slot)) return
        const pending = this.calculations.get(slot.busy)
        if (pending) { this.calculations.delete(slot.busy); pending.reject(Object.assign(error, { code: 'PREPARED_CHART_WORKER_UNAVAILABLE' })) }
        this.workers = this.workers.filter(value => value !== slot); this.drainCalculations()
      }
      slot.worker.on('error', failed)
      slot.worker.on('exit', code => failed(new Error(`Prepared chart worker exited (${code}).`)))
      this.workers.push(slot)
      slot.worker.unref()
    }
    for (const slot of this.workers) {
      if (slot.busy !== null || !this.calculationQueue.length) continue
      const index = this.calculationQueue.findIndex(id => this.calculations.get(id)?.priority === 'foreground')
      const [id] = this.calculationQueue.splice(index < 0 ? 0 : index, 1), pending = this.calculations.get(id)
      slot.busy = id; slot.worker.ref()
      try { pending.dispatch(slot.worker, { id, candles: pending.candles, intervalMS: pending.intervalMS, checkpoint: pending.checkpoint }) }
      catch (error) {
        this.calculations.delete(id); slot.busy = null; slot.worker.unref(); pending.reject(error)
        queueMicrotask(() => this.drainCalculations())
      }
    }
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask
    this.closed = true
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
      await Promise.allSettled(workers.map(slot => stopOperationWorker(slot.worker, 'prepared-chart')))
      await Promise.allSettled([...this.tasks.values(), ...[...this.focusReads].map(entry => entry.done), ...this.liveSeeds.values(), ...this.candidateTasks.values()])
      this.listeners.clear()
    })()
    return this.disposeTask
  }
}

hookOperationMethods(PreparedChartPipeline.prototype, {
  frame: state => ({ category: 'cpu', name: 'chart.frame', resource: state.instId,
    attributes: { inputRows: state.rows.size, intervalMS: state.intervalMS, generation: state.generation } }),
  reconcileCanonical: (state, rows) => ({ category: 'cpu', name: 'chart.reconcile', resource: state.instId,
    attributes: { inputRows: rows.length, intervalMS: state.intervalMS } }),
})
