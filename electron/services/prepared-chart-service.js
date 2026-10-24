import { createOperationWorker, createWorkerRequest } from './worker-operations.js'
import { availableParallelism } from 'node:os'
import { statisticsMask, statisticsVersionFor } from './statistics-state.js'
import { appendIndicatorCandle, projectIndicatorCandle } from './indicators.js'
import { hookOperationMethods, measureOperation } from './operations.js'
import { stopOperationWorker } from './operation-worker.js'
import { completePriceCandle } from './market-records.js'

const VISIBLE = 96, TAIL = 128, CHUNK = 1024, HISTORY = 1536, HISTORY_AHEAD = 256, HISTORY_PAGE = 300
const INDICATOR_WARMUP = 199 // EMA200 is the longest initial seed.
// Formula versions identify the complete recursive state and verified producer.
// Older checkpoints do not contain ATR14's Wilder accumulator and SMA seed.
const FORMULA_VERSION = 'native-exact-chunks-ema200-wilder-rsi6-12-24-boll20-2-base-vwap14-roc9-maroc9-wilder-atr14-percent-bbw20-2-v5'
const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
const priceFields = ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
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
  constructor({ store, history, normalize, revision, instrument, streaming = () => false }) {
    Object.assign(this, { store, history, normalize, revision, instrument, streaming })
    this.series = new Map(); this.liveStates = new Map(); this.snapshots = new Map(); this.universe = new Map()
    this.realtimeKeys = new Set(); this.listeners = new Set(); this.tasks = new Map(); this.localTasks = new Map()
    this.liveSeeds = new Map(); this.maxSeries = 12; this.maxBytes = 32 * 1024 * 1024
    this.maxProjectionBytes = 64 * 1024 * 1024; this.objectSizes = new WeakMap()
    this.nextGeneration = 0; this.nextRevision = 0; this.nextCalculation = 0
    this.workers = []; this.calculations = new Map(); this.calculationQueue = []
    this.workerLimit = Math.max(1, Math.min(8, availableParallelism() - 2))
    this.sourceAttempts = new Map(); this.sourceTasks = new Map()
    this.sourceEpoch = 0
    this.focus = null; this.explicitFocus = false
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
      const live = this.liveStates.get(key)
      state = { key, instId, timeframe, intervalMS: intervalFor(timeframe), rows: new Map(), indicators: new Map(),
        generation: live?.generation || ++this.nextGeneration, sourceVersion: live?.sourceVersion ?? 0, priceVersion: live?.priceVersion ?? 0, oiVersion: live?.oiVersion ?? 0, takerVersion: live?.takerVersion ?? 0,
        indicatorFailures: new Map(live?.indicatorFailures ?? []),
        indicatorState: live?.indicatorState ? structuredClone(live.indicatorState) : null, live: live?.live ?? null, observedAt: live?.observedAt ?? null,
        floor: live?.floor ?? null, active: 0, latestHour: live?.latestHour ?? null, historyEnd: null, loaded: false, calculation: null }
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
        latestHour: null, floor: null }
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
    const cached = [...(state.barCaches?.values() ?? [])].flatMap(value => value.bars)
    state.byteSize = [...state.rows.values(), ...state.indicators.values(), ...cached, ...(state.historyBarsCache?.bars ?? [])].reduce((sum, value) => sum + this.objectBytes(value), 0)
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
      for (const [attemptKey, attempt] of this.sourceAttempts) if (attempt.seriesKey === key) this.sourceAttempts.delete(attemptKey)
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
      if (key === this.focusKey) continue
      projected -= snapshotBytes(value); this.snapshots.delete(key)
    }
    for (const [key, state] of this.liveStates) {
      if (projected <= this.maxProjectionBytes) break
      if (key === this.focusKey || this.series.get(key)?.active) continue
      projected -= state.byteSize ?? 0
      state.rows.clear(); state.indicators.clear(); state.barCaches?.clear(); state.historyBarsCache = null; state.byteSize = 0
      state.indicatorFailures?.clear()
      // Quotes and fixed-size recursive checkpoints remain available on ticks.
    }
  }

  get worker() { return this.workers[0]?.worker ?? null }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(frame) { if (!this.closed) for (const listener of this.listeners) { try { listener(frame) } catch { /* A renderer cannot stop collection. */ } } }
  cached(key) { return this.snapshots.get(key)?.frame ?? null }
  latest(state) { return state.latestHour ?? null }

  setUniverse(instIds, timeframe, focusInstId) {
    if (!intervalFor(timeframe)) throw new Error('Unsupported chart timeframe.')
    this.requestedIDs = new Set(instIds)
    this.universe = new Map(instIds.flatMap(instId => ['5m', '15m', '1H'].map(timeframe => [seriesKey(instId, timeframe), { instId, timeframe }])))
    if (focusInstId && !this.explicitFocus && this.focusKey !== seriesKey(focusInstId, timeframe)) this.setFocus({ instId: focusInstId, timeframe })
    this.trim()
    // Each selected series restores independently. No universe-wide startup barrier.
    return { frames: [...this.snapshots.values()].map(value => value.frame).filter(frame => this.requestedIDs.has(frame.instId)) }
  }

  /** Focus owns source demand, never the durable facts or an admitted local read. */
  setFocus(target, id) {
    const key = target ? seriesKey(target.instId, target.timeframe) : null
    if (target && (!intervalFor(target.timeframe) || target.endHour !== undefined && !Number.isFinite(target.endHour))) throw new Error('Invalid chart target.')
    if (id !== undefined) this.explicitFocus = true
    if (key === this.focus?.key && target?.endHour === this.focus?.end && id === this.focus?.id) return
    this.focus = target ? { key, end: target.endHour, id } : null
    this.focusKey = key
    const state = this.series.get(key)
    if (state) state.historyEnd = target.endHour ?? null
    const end = target && (target.endHour ?? Math.floor(Date.now() / intervalFor(target.timeframe)) * intervalFor(target.timeframe) - intervalFor(target.timeframe))
    const from = target && end - (VISIBLE - 1) * intervalFor(target.timeframe)
    for (const [sourceKey, job] of this.sourceTasks) {
      // A nearby cursor can still use an admitted viewport/reserve page. Keep
      // that consumer attached so HistorySync need not abort and refetch it.
      if (job.seriesKey === key && (job.from <= end && job.through >= from
        || job.reserve && end >= job.reserve.from && end <= job.reserve.through)) {
        if (job.from <= end && job.through >= from) this.promoteSourceJob(job, 'interactive')
        continue
      }
      this.sourceTasks.delete(sourceKey)
      if (this.tasks.get(sourceKey) === job.task) this.tasks.delete(sourceKey)
      job.controller.abort()
    }
    this.scheduleRefresh()
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
  }

  frame(state, end = state.latestHour, historical = false) {
    const latest = this.liveStates.get(state.key)
    if (end === state.latestHour && !state.rows.has(end) && latest !== state && latest?.rows.has(end)) return this.frame(latest, end, historical)
    const rows = [...state.rows.values()].filter(row => end === null || row.timestamp <= end && row.timestamp >= end - (VISIBLE - 1) * state.intervalMS).sort((a, b) => a.timestamp - b.timestamp)
    const cacheKey = `${end}:${state.sourceVersion}:${state.indicatorVersion ?? 0}:${state.generation}:${sourceState(rows, 1)}:${sourceState(rows, 2)}`
    state.barCaches ??= new Map()
    const cached = state.barCaches.get(end)
    const bars = cached?.key === cacheKey ? cached.bars : measureOperation({ category: 'cpu', name: 'chart.project', resource: state.instId,
      attributes: { candles: rows.length, intervalMS: state.intervalMS, projection: 'viewport' } }, () => rows.map(row => bar(row, state.indicators.get(row.timestamp))))
    state.barCaches.delete(end); state.barCaches.set(end, { key: cacheKey, bars })
    while (state.barCaches.size > 4) state.barCaches.delete(state.barCaches.keys().next().value)
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
    if (previous && JSON.stringify(previous) === JSON.stringify(status)) status = previous
    state.statusCache.delete(key); state.statusCache.set(key, status)
    while (state.statusCache.size > 12) state.statusCache.delete(state.statusCache.keys().next().value)
    return status
  }

  indicatorInputVersion(state) {
    return `${FORMULA_VERSION}:${state.generation}:${state.priceVersion}:${this.priceJournal.get(state.key)?.at(-1)?.revision ?? 0}`
  }

  indicatorStatus(state, bars, from, through) {
    const inputVersion = this.indicatorInputVersion(state)
    let status = { state: 'loading', from, through, inputVersion }
    if (bars.length && bars.every(value => value.indicatorsObserved)) {
      status.state = bars.every(value => indicatorFields.every(field => numeric(value[field]))) ? 'ready' : 'unavailable'
      if (status.state === 'unavailable') status.reason = bars.some(value => value.ema === null) ? 'insufficient-history' : 'undefined-value'
    } else {
      const failure = bars.filter(value => !value.indicatorsObserved).map(value => state.indicatorFailures?.get(value.hour))
        .find(value => value?.inputVersion === inputVersion)
      if (failure) status = { ...failure, from, through, state: 'error' }
    }
    return this.cachedStatus(state, 'indicator', status)
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
    const end = focus?.end ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    return focus?.key === state.key && from <= end && through >= end - (VISIBLE - 1) * state.intervalMS ? 'interactive' : 'prefetch'
  }

  publish(state) {
    // Collection and list-indicator residency do not constitute chart demand.
    // Retain their latest raw candles; materialize a frame when a chart opens.
    if (!state.chartRequested && state.key !== this.focusKey && !this.snapshots.has(state.key)) return null
    const frame = this.frame(state), previous = this.snapshots.get(state.key)
    this.snapshots.set(state.key, { valid: true, frame })
    if (previous?.frame.bars !== frame.bars) { this.updateMemory(state); this.trim() }
    this.emit(frame)
    if (state.historyEnd !== null && state.historyEnd !== undefined && state.historyEnd !== frame.endHour) {
      const key = this.historyKey(state, state.historyEnd)
      if (key !== state.publishedHistoryKey || state.publishedHistoryStatus !== state.statusVersion) {
        this.emit(this.historyFrame(state, state.historyEnd)); state.publishedHistoryKey = key; state.publishedHistoryStatus = state.statusVersion
      }
    }
    return frame
  }

  historyKey(state, end) { return `${end}:${state.sourceVersion}:${state.indicatorVersion ?? 0}:${state.generation}:${state.freshnessVersion ?? 0}` }

  historyFrame(state, end) {
    const frame = this.frame(state, end, true)
    // A bounded navigation reserve, not a transfer of the full canonical history.
    const key = this.historyKey(state, end)
    if (state.historyBarsCache?.key !== key) {
      state.historyBarsCache = { key, bars: measureOperation({ category: 'cpu', name: 'chart.project', resource: state.instId,
        attributes: { candles: state.rows.size, intervalMS: state.intervalMS, projection: 'history' } },
      () => [...state.rows.values()].sort((a, b) => a.timestamp - b.timestamp).map(row => bar(row, state.indicators.get(row.timestamp)))) }
      this.updateMemory(state)
    }
    frame.bars = state.historyBarsCache.bars
    return frame
  }

  async read(state, end, limit = TAIL, priority = 'foreground') {
    // A bounded local query belongs to its admitted state until both rows and
    // coverage arrive. Concurrent selections cannot evict it during SQLite IPC.
    state.active = (state.active ?? 0) + 1
    try { await this.readRows(state, end, limit, priority) }
    finally { state.active -= 1 }
  }

  async readRows(state, end, limit, priority) {
    const ceiling = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const through = end === undefined || end === null ? ceiling : Math.min(end + HISTORY_AHEAD * state.intervalMS, ceiling)
    const from = end === undefined || end === null ? undefined : Math.max(0, end - (limit - HISTORY_AHEAD - 1) * state.intervalMS)
    const admittedPrice = state.priceVersion, admittedOI = state.oiVersion, admittedTaker = state.takerVersion
    const residentRevision = this.store.candleRevision?.(state.instId, state.timeframe)
    const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from, through, limit, order: 'desc' }, priority)
    if (this.closed) return
    if (admittedPrice !== state.priceVersion || residentRevision !== this.store.candleRevision?.(state.instId, state.timeframe)) return this.readRows(state, end, limit, priority)
    const residentFirst = Math.min(...state.rows.keys()), residentLast = Math.max(...state.rows.keys())
    let pricesChanged = false, observationsChanged = false, changedFrom = Infinity, oiChanged = false, takerChanged = false
    for (const row of rows) if (row.confirmed) {
      const previous = state.rows.get(row.timestamp), value = mergeStatistics(previous, this.normalize(row), (admittedOI === state.oiVersion ? 1 : 0) | (admittedTaker === state.takerVersion ? 2 : 0))
      // A committed hole repair may precede its observer. It changes the
      // recursive input prefix just like a correction of an existing candle.
      // Ordinary reserve expansion lies outside the retained interval.
      if (previous ? !samePrice(previous, value) : row.timestamp > residentFirst && row.timestamp < residentLast) {
        pricesChanged = true; changedFrom = Math.min(changedFrom, row.timestamp)
      }
      if (JSON.stringify(previous) !== JSON.stringify(value)) observationsChanged = true
      if (changedSource(previous, value, 1)) oiChanged = true
      if (changedSource(previous, value, 2)) takerChanged = true
      state.rows.set(row.timestamp, value)
    }
    if (pricesChanged) state.priceVersion += 1
    if (observationsChanged) state.sourceVersion += 1
    if (oiChanged) state.oiVersion = (state.oiVersion ?? 0) + 1
    if (takerChanged) state.takerVersion = (state.takerVersion ?? 0) + 1
    if (pricesChanged) this.invalidateDerived(state, changedFrom)
    this.retainRows(state, this.liveStates.get(state.key) === state ? TAIL : HISTORY)
    const coverage = await this.store.coverage(state.instId, state.timeframe, priority)
    state.latestHour = coverage.last === null ? state.latestHour : Math.max(state.latestHour ?? -Infinity, coverage.last)
    const listing = Number(this.instrument(state.instId)?.listTime)
    state.floor = Number.isFinite(listing) && listing > 0 ? Math.ceil(listing / state.intervalMS) * state.intervalMS : null
    state.loaded = true
    if (limit === HISTORY) {
      const hours = rows.filter(row => row.confirmed && state.rows.has(row.timestamp)).map(row => row.timestamp)
      // Admission follows the returned facts, including an implicit latest
      // query. An obsolete subpage cannot certify another active viewport.
      if (hours.includes(state.historyEnd)) state.historyRange = { from: Math.min(...hours), through: Math.max(...hours),
        revision: residentRevision === this.store.candleRevision?.(state.instId, state.timeframe) ? residentRevision : null }
    }
    this.updateMemory(state)
    const live = this.liveStates.get(state.key)
    if (live?.live) { state.live = live.live; state.observedAt = live.observedAt }
    this.syncLive(state)
  }

  retainRows(state, limit) {
    if (!state.rows.size) { this.pruneSourceAttempts(state); return }
    const historical = state.historyEnd !== null && state.historyEnd !== undefined
    const anchor = historical ? state.historyEnd : Math.max(...state.rows.keys()), ahead = historical ? HISTORY_AHEAD : 0
    const first = anchor - (limit - ahead - 1) * state.intervalMS, last = anchor + ahead * state.intervalMS
    // Acquisition can advance its reserve beyond the selected viewport. Keep
    // those at most 96 selected facts too, so focus maintenance does not keep
    // re-reading an already durable window merely because prefetch evicted it.
    const selected = state.key === this.focus?.key && limit !== TAIL
      ? this.focus.end ?? state.latestHour : null
    const selectedFrom = selected === null ? null : selected - (VISIBLE - 1) * state.intervalMS
    for (const hour of state.rows.keys()) if ((hour < first || hour > last)
      && (selected === null || hour < selectedFrom || hour > selected)) { state.rows.delete(hour); state.indicators.delete(hour) }
    for (const hour of state.indicatorFailures?.keys() ?? []) if (!state.rows.has(hour)) state.indicatorFailures.delete(hour)
    this.pruneSourceAttempts(state)
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
    // Historical reserves cannot replace the separately retained latest tail.
    for (const [hour, row] of state.rows) if (hour >= state.latestHour - (TAIL - 1) * state.intervalMS) {
      const previous = live.rows.get(hour)
      if (previous && !samePrice(previous, row)) live.indicators.delete(hour)
      live.rows.set(hour, row)
      if (state.indicators.has(hour)) live.indicators.set(hour, state.indicators.get(hour))
      const failure = state.indicatorFailures?.get(hour)
      if (failure) { live.indicatorFailures ??= new Map(); live.indicatorFailures.set(hour, failure) }
    }
    for (const hour of live.rows.keys()) if (hour < state.latestHour - (TAIL - 1) * state.intervalMS) { live.rows.delete(hour); live.indicators.delete(hour) }
    for (const hour of live.indicatorFailures?.keys() ?? []) if (!live.rows.has(hour)) live.indicatorFailures.delete(hour)
    if (state.indicatorState && (!live.indicatorState || state.indicatorState.lastTimestamp > live.indicatorState.lastTimestamp)) live.indicatorState = structuredClone(state.indicatorState)
    live.latestHour = state.latestHour; live.floor = state.floor; live.generation = state.generation
    for (const field of ['sourceVersion', 'priceVersion', 'oiVersion', 'takerVersion', 'indicatorVersion']) live[field] = Math.max(live[field] ?? 0, state[field] ?? 0)
    live.bollExpansion = live.indicatorState?.bollExpansion ?? null
    this.updateMemory(live)
    return live
  }

  async local(instId, timeframe, { priority = 'foreground', focusId, focus = priority === 'foreground' ? this.requestFocus(instId, timeframe, undefined, focusId) : null } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    if (!intervalFor(timeframe)) throw new Error('Unsupported chart timeframe.')
    const key = seriesKey(instId, timeframe)
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    if (this.currentFocus(focus)) {
      state.historyRequest = (state.historyRequest ?? 0) + 1
      state.historyEnd = null
    }
    if (!state.loaded || !state.rows.has(state.latestHour)) await this.job(`local:${key}`, () => this.read(state, undefined, TAIL, this.currentFocus(focus) ? 'interactive' : priority))
    this.seed(state, priority)
    const frame = this.publish(state)
    this.refreshObservations(state, undefined, VISIBLE, VISIBLE, focus)
    this.scheduleRefresh()
    return frame.bars.length || frame.liveBar ? frame : null
  }

  async localHistory(instId, timeframe, targetEnd, { focusId, focus = this.requestFocus(instId, timeframe, targetEnd, focusId), reserve } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    const request = this.currentFocus(focus) ? state.historyRequest = (state.historyRequest ?? 0) + 1 : null
    if (request !== null) state.historyEnd = targetEnd ?? state.latestHour
    const end = targetEnd ?? state.latestHour
    const from = Math.max(0, end - (VISIBLE - 1) * state.intervalMS, state.floor ?? 0)
    // The local mutation counter also fences a commit whose normal observer
    // has not arrived yet. Reuse never certifies an older durable observation.
    // A latest tail is only 128 rows. A bulk admission belongs to the actual
    // returned interval; a previous deep-history read cannot certify that tail.
    const admitted = state.historyRange
    let resident = Boolean(state.loaded && admitted && end !== null && from >= admitted.from && end <= admitted.through
      && admitted.revision === this.store.candleRevision?.(instId, timeframe))
    for (let hour = from; resident && hour <= end; hour += state.intervalMS) resident = completePriceCandle(state.rows.get(hour))
    if (!resident) await this.job(`history:${state.key}:${targetEnd ?? 'latest'}`, () => this.read(state, targetEnd, HISTORY, this.demandPriority(state, from, end, focus)))
    if (this.currentFocus(focus) && request === state.historyRequest) state.historyEnd = targetEnd ?? state.latestHour
    this.seed(state, 'foreground')
    this.refreshObservations(state, targetEnd, VISIBLE, targetEnd === undefined ? VISIBLE : HISTORY_PAGE, focus, reserve)
    this.prefetchStatistics(state, focus)
    const currentEnd = targetEnd ?? state.latestHour
    const frame = this.historyFrame(state, currentEnd)
    if (request === state.historyRequest) { state.publishedHistoryKey = this.historyKey(state, currentEnd); state.publishedHistoryStatus = state.statusVersion }
    return frame.bars.length || frame.liveBar ? frame : null
  }

  async prepare(instId, timeframe, targetEnd, historyBars = VISIBLE, { focusId } = {}) {
    if (!intervalFor(timeframe) || targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart target.')
    const focus = this.requestFocus(instId, timeframe, targetEnd, focusId)
    const reserveBars = Math.max(HISTORY_PAGE, Math.min(HISTORY - HISTORY_AHEAD, historyBars))
    const reserve = targetEnd === undefined ? undefined : { from: targetEnd - (reserveBars - 1) * intervalFor(timeframe), through: targetEnd }
    let frame = targetEnd === undefined ? await this.local(instId, timeframe, { focus }) : await this.localHistory(instId, timeframe, targetEnd, { focus, reserve })
    const state = this.state(instId, timeframe)
    state.active += 1
    const current = () => this.currentFocus(focus)
    try {
      if (!current()) return targetEnd === undefined ? frame ?? this.frame(state) : this.historyFrame(state, targetEnd)
      const prices = this.refreshObservations(state, targetEnd, VISIBLE, targetEnd === undefined ? VISIBLE : HISTORY_PAGE, focus, reserve)
      if (targetEnd !== undefined) {
        // One native page makes the nearest viewport usable, including the
        // recursive indicators' warmup. Publish it before downloading farther
        // reserve pages; the renderer can advance while this request continues.
        await prices?.catch(error => { if (current()) throw error })
        if (!current()) return this.historyFrame(state, targetEnd)
        await this.seed(state, 'foreground')
        while (current() && state.calculation) await state.calculation
        if (!current()) return this.historyFrame(state, targetEnd)
        this.publish(state)
        for (let loaded = HISTORY_PAGE; current() && loaded < reserveBars; loaded += HISTORY_PAGE) {
          const through = targetEnd - loaded * state.intervalMS
          if (through < Math.max(0, state.floor ?? 0)) break
          await this.refreshObservations(state, through, Math.min(HISTORY_PAGE, reserveBars - loaded), undefined, focus, reserve)?.catch(error => { if (current()) throw error })
          if (!current()) break
          await this.seed(state, 'foreground')
          while (current() && state.calculation) await state.calculation
          if (!current()) break
          this.publish(state)
        }
        frame = this.historyFrame(state, targetEnd)
      } else if (!frame?.bars.length && !frame?.liveBar && prices) {
        await prices.catch(error => { if (current()) throw error })
        frame = this.frame(state)
      }
      return frame ?? this.frame(state)
    } finally {
      state.active -= 1
      this.trim()
    }
  }

  refreshObservations(state, targetEnd, historyBars = VISIBLE, priceBars = historyBars, focus = this.focus, reserve) {
    if (!this.currentFocus(focus) || focus.key !== state.key) return null
    this.refreshIndicators(state, focus)
    const { instId, timeframe, intervalMS: step } = state
    const end = targetEnd ?? Math.floor(Date.now() / step) * step - step
    const from = Math.max(0, end - (historyBars - 1) * step, state.floor ?? 0)
    const priceFrom = Math.max(0, end - (priceBars - 1) * step, state.floor ?? 0)
    const priority = this.demandPriority(state, from, end, focus)
    let pricesMissing = false
    for (let hour = priceFrom; hour <= end; hour += step) if (!completePriceCandle(state.rows.get(hour))) { pricesMissing = true; break }
    this.refreshStatistics(state, from, end, priority, reserve)
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
      this.seed(state, 'foreground'); this.publish(state)
      const rows = result?.rows ? new Map(result.rows.map(row => [row.timestamp, row])) : state.rows
      for (let hour = priceFrom; hour <= end; hour += step) if (!completePriceCandle(rows.get(hour))) return false
      return true
    }, { state, source: 'candles', from: priceFrom, through: end, reserve, priority })
    task?.catch(() => {})
    return task
  }

  statisticsRange(state) {
    if (state.historyEnd == null) return null
    const first = Math.max(0, state.floor ?? 0, state.historyEnd - (HISTORY - HISTORY_AHEAD - 1) * state.intervalMS)
    const last = Math.min(state.historyEnd + HISTORY_AHEAD * state.intervalMS,
      Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS)
    const hours = [...state.rows.keys()].filter(hour => hour >= first && hour <= last)
    return hours.length ? { from: Math.min(...hours), through: Math.max(...hours) } : null
  }

  prefetchStatistics(state, focus = this.focus) {
    if (!this.currentFocus(focus) || focus.key !== state.key) return
    const reserve = this.statisticsRange(state)
    // Durable prices already admit this bounded navigation reserve. Its OI
    // and Taker coverage must advance without waiting for a price cache miss.
    if (reserve) this.refreshStatistics(state, reserve.from, reserve.through, 'prefetch', reserve)
  }

  refreshStatistics(state, from, through, priority, reserve) {
    if (typeof this.history.ensureStatistics !== 'function') return
    const { instId, timeframe, intervalMS: step } = state
    for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
      for (const bounds of this.pendingSourceRanges(state, source, from, through)) {
        this.sourceJob(`${source}:${state.key}:${bounds.from}:${bounds.through}`, async (signal, job) => {
          const result = await this.history.ensureStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, signal, source)
          signal.throwIfAborted()
          await this.observeStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, result?.rows, source)
          signal.throwIfAborted()
          for (let hour = bounds.from; hour <= bounds.through; hour += step) { const row = state.rows.get(hour); if (row && !sourceFresh(row, bit)) return false }
          return true
        }, { state, source, ...bounds, reserve, priority })?.catch(() => {})
      }
    }
  }

  indicatorDemand(state, focus = this.focus) {
    if (!this.currentFocus(focus) || focus.key !== state.key || typeof this.history.ensurePrices !== 'function') return null
    const end = focus.end ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
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

  refreshIndicators(state, focus = this.focus) {
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
      this.seed(state, 'foreground'); this.publish(state)
      return complete
    }, { state, source: 'candles', from, through, priority: 'interactive' })
    task?.catch(() => {})
    return task
  }

  promoteSourceJob(job, priority) {
    if (priorityRank(priority) <= priorityRank(job.priority)) return
    job.priority = priority
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
      && attempt.retryAt === undefined && attempt.focus === this.focus && attempt.sourceEpoch === this.sourceEpoch
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

  sourceJob(key, operation, { state, source, from, through, reserve, priority = 'interactive' }) {
    const existing = this.sourceTasks.get(key) ?? [...this.sourceTasks.values()].find(job => job.seriesKey === state.key && job.source === source && job.from <= from && job.through >= through)
    if (existing) { existing.reserve ??= reserve; this.promoteSourceJob(existing, priority); return existing.task }
    if (this.sourceBlocked(state, source, from, through)) return null
    const controller = new AbortController(), signal = controller.signal
    const job = { controller, state, source, seriesKey: state.key, from, through, reserve, priority, task: null }
    const failed = error => {
      const now = Date.now()
      this.sourceAttempts.set(key, { seriesKey: state.key, source, from, through, failedAt: now,
        focus: this.focus, sourceEpoch: this.sourceEpoch, inputVersion: this.sourceInputVersion(state, source),
        error: error?.message || `${source === 'oi' ? 'Open interest' : source === 'taker' ? 'Taker' : 'Price'} history is incomplete for this range.`,
        ...(Number.isFinite(error?.retryAt) && error.retryAt > now ? { retryAt: error.retryAt } : {}) })
    }
    const task = Promise.resolve().then(async () => {
      try {
        const result = await abortable(() => operation(signal, job), signal)
        signal.throwIfAborted()
        if (result === false) failed()
        else this.sourceAttempts.delete(key)
        return result
      } catch (error) {
        if (!signal.aborted) failed(error)
        throw error
      } finally {
        if (this.sourceTasks.get(key) === job) this.sourceTasks.delete(key)
        if (this.tasks.get(key) === task) this.tasks.delete(key)
        if (!this.closed) {
          state.statusVersion = (state.statusVersion ?? 0) + 1
          if (!signal.aborted) this.publish(state)
          setImmediate(() => this.scheduleRefresh()).unref?.()
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
    const statistics = this.statisticsRange(state)
    const statisticsRanges = [{ from, through: end }, ...(statistics ? [statistics] : [])]
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
    for (const current of new Set([state, this.liveStates.get(state.key)].filter(Boolean))) {
      let changed = false
      for (const row of rows) {
        const previous = current.rows.get(row.timestamp), value = this.normalize(row)
        if (!previous || samePrice(previous, value)) continue
        current.rows.set(row.timestamp, mergeStatistics(previous, value))
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

  seed(state, priority = 'background') {
    if (this.closed || !state.rows.size && !this.liveStates.get(state.key)?.rows.size) return Promise.resolve()
    if (state.calculation) return state.calculation
    const live = this.syncLive(state)
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
    for (const current of [state, live]) for (const [hour, failure] of current.indicatorFailures ?? []) {
      if (failure.inputVersion !== inputVersion()) current.indicatorFailures.delete(hour)
    }
    state.active += 1
    let restart = false, failedDemand = initialDemand, failedFrom = 0, admittedInput = inputVersion(), workerRecovery = false
    const task = (async () => {
      while (!this.closed) {
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
        while (!this.closed && cursor <= end) {
          failedFrom = cursor
          const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from: cursor, through: end, limit: CHUNK, order: 'asc' }, priority)
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
          for (const value of result.bars) for (const current of [state, live]) if (current.rows.has(value.hour)) {
            current.indicators.set(value.hour, value); changed = true; progressed = true
          }
          for (const current of [state, live]) if (!current.indicatorState || calculated.lastTimestamp > current.indicatorState.lastTimestamp) {
            current.indicatorState = structuredClone(calculated); current.bollExpansion = calculated.bollExpansion
          }
          if (changed) {
            state.indicatorVersion = (state.indicatorVersion ?? 0) + 1
            live.indicatorVersion = state.indicatorVersion
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
      for (const current of [state, live]) {
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
      if (!this.closed && workerRecovery) for (const current of [state, live]) for (const [hour, failure] of current.indicatorFailures ?? []) {
        if (failure.retryOn === 'worker-recovery' && failure.inputVersion === admittedInput) current.indicatorFailures.delete(hour)
      }
      if (!this.closed && (restart || workerRecovery)) { this.publish(state); this.seed(state, priority) }
      if (!this.closed) { this.refreshIndicators(state); this.scheduleRefresh() }
    })
    state.calculation = task; this.liveSeeds.set(state.key, task)
    this.publish(state)
    return task
  }

  async projectSeries(instId, timeframe) {
    const state = this.state(instId, timeframe)
    if (!state.loaded) await this.read(state, undefined, TAIL, 'background')
    const live = this.liveState(instId, timeframe)
    if (state.latestHour !== null && !state.rows.has(state.latestHour) && !live.rows.has(state.latestHour)) await this.read(live, undefined, TAIL, 'background')
    await this.seed(state)
    const current = live.rows.has(state.latestHour) ? live : state
    return { end: state.latestHour, bars: [...current.rows.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-TAIL).map(row => bar(row, current.indicators.get(row.timestamp))) }
  }
  async projectListSeries(instId, timeframe) {
    const live = this.liveStates.get(seriesKey(instId, timeframe))
    if (live?.indicatorState && live.indicatorState.lastTimestamp === live.latestHour && live.rows.size && [...live.rows.keys()].every(hour => live.indicators.has(hour))) return { end: live.latestHour, bars: [...live.rows.values()].sort((a, b) => a.timestamp - b.timestamp).map(row => bar(row, live.indicators.get(row.timestamp))), bollExpansion: live.bollExpansion ?? null }
    const projected = await this.projectSeries(instId, timeframe)
    return { ...projected, bollExpansion: this.liveStates.get(seriesKey(instId, timeframe))?.bollExpansion ?? null }
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
              if (value) current.indicators.set(value.hour, { ...value, indicatorsObserved: true })
            }
          }
          if (changedSource(previous.get(row.timestamp), row, 1)) current.oiVersion = (current.oiVersion ?? 0) + 1
          if (changedSource(previous.get(row.timestamp), row, 2)) current.takerVersion = (current.takerVersion ?? 0) + 1
          current.rows.set(row.timestamp, mergeStatistics(current.rows.get(row.timestamp), this.normalize(row))); current.latestHour = Math.max(current.latestHour ?? -Infinity, row.timestamp)
          current.sourceVersion += 1
          if (current.live?.timestamp <= row.timestamp) current.live = null
        }
        const rowLimit = current === live ? TAIL : HISTORY
        this.retainRows(current, rowLimit)
        this.updateMemory(current)
      }
      if (changedFrom < Infinity) this.invalidateDerived(state ?? live, changedFrom)
      if (state) {
        this.publish(state); this.seed(state, key === this.focusKey ? 'foreground' : 'background')
      }
      else if (live && this.universe.has(key)) this.publish(live)
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
    for (const { current, rows: prior } of admitted) {
      for (const row of rows) if (current.rows.has(row.timestamp) && prior.has(row.timestamp)) {
        const previous = current.rows.get(row.timestamp), normalized = this.normalize(row)
        // A newer observation fences only that slot and source. It cannot
        // discard the unrelated observations in an admitted history page.
        const allowed = ((changedSource(prior.get(row.timestamp), previous, 1) ? 0 : 1)
          | (changedSource(prior.get(row.timestamp), previous, 2) ? 0 : 2)) & (source === 'oi' ? 1 : source === 'taker' ? 2 : 3)
        const value = mergeStatistics(previous, { ...previous, ...Object.fromEntries(statisticsFields.map(field => [field, normalized[field]])) }, allowed)
        if (changedSource(previous, value, 1)) current.oiVersion = (current.oiVersion ?? 0) + 1
        if (changedSource(previous, value, 2)) current.takerVersion = (current.takerVersion ?? 0) + 1
        current.rows.set(row.timestamp, value)
      }
      current.sourceVersion += 1
      this.updateMemory(current)
    }
    if (state) this.publish(state)
    else if (live && this.universe.has(key)) this.publish(live)
  }

  invalidate(instId, timeframe) {
    const state = this.series.get(seriesKey(instId, timeframe)), live = this.liveStates.get(seriesKey(instId, timeframe))
    for (const current of [state, live].filter(Boolean)) {
      current.priceVersion += 1; current.generation = ++this.nextGeneration; current.indicatorState = null; current.indicators.clear(); current.loaded = false; current.historyRange = null; current.rows.clear(); current.latestHour = null
      current.indicatorFailures?.clear()
    }
    this.snapshots.delete(seriesKey(instId, timeframe))
    const focus = this.focus?.key === state?.key ? this.focus : null
    if (state) (state.historyEnd != null ? this.localHistory(instId, timeframe, state.historyEnd, { focus }) : this.local(instId, timeframe, { focus })).catch(() => {})
  }

  async setLive(instId, timeframe, candle, context = {}) {
    const observedAt = typeof context === 'number' ? context : context.receivedAt ?? Date.now()
    if (this.closed) return null
    if (!intervalFor(timeframe) || candle && (candle.confirmed || candle.instrument !== instId || candle.timeframe !== timeframe)) throw new Error('Invalid forming candle.')
    const live = this.liveState(instId, timeframe), state = this.series.get(live.key)
    if (candle && live.live && (candle.timestamp < live.live.timestamp || candle.timestamp === live.live.timestamp && candle.volume < live.live.volume)) return this.cached(live.key)
    for (const current of [live, state].filter(Boolean)) { current.live = candle; current.observedAt = observedAt }
    // A current price can publish before any historical seed has been restored.
    if (state) { const frame = this.publish(state); this.scheduleRefresh(); return frame }
    if (this.universe.has(live.key)) return this.publish(live)
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
          for (const current of this.series.values()) if (current.key !== key && [...current.indicatorFailures?.values() ?? []].some(value => value.retryOn === 'worker-recovery')) {
            for (const target of [current, this.liveStates.get(current.key)].filter(Boolean)) for (const [hour, failure] of target.indicatorFailures ?? []) {
              if (failure.retryOn === 'worker-recovery') target.indicatorFailures.delete(hour)
            }
            setImmediate(() => { if (!this.closed) this.seed(current) }).unref?.()
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
    for (const job of this.sourceTasks.values()) job.controller.abort()
    this.unsubscribeStore?.(); this.priceJournal.clear()
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    for (const pending of this.calculations.values()) pending.reject(new Error('Prepared chart data service is closed.'))
    this.calculations.clear(); this.calculationQueue = []
    const workers = this.workers
    this.workers = []
    this.disposeTask = (async () => {
      await Promise.allSettled(workers.map(slot => stopOperationWorker(slot.worker, 'prepared-chart')))
      await Promise.allSettled([...this.tasks.values(), ...this.liveSeeds.values()])
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
