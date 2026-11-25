import { projectIndicatorCandle } from './indicators.js'
import { completePriceCandle } from './market-records.js'
import {
  VISIBLE, LIVE_TURN_MS, LIVE_TURN_FRAMES, FORMULA_VERSION, indicatorFields, TIMEFRAMES,
  intervalFor, seriesKey, numeric, abortable, freshQuote, sameLiveIndicatorInput,
  sourceFresh, liveStatisticsDeadline, sourceState, bar, sameStatus,
} from './prepared-chart-helpers.js'

export const preparedChartProjectionMethods = {
  objectBytes(value) {
    const known = this.objectSizes.get(value)
    if (known !== undefined) return known
    const bytes = JSON.stringify(value).length * 2
    this.objectSizes.set(value, bytes)
    return bytes
  },

  updateMemory(state) {
    const cached = new Set()
    for (const value of state.barCaches?.values() ?? []) for (const bar of value.bars) cached.add(bar)
    for (const value of state.historyBarsCache?.bars ?? []) cached.add(value)
    for (const value of state.projectedBars?.values() ?? []) cached.add(value.bar)
    let bytes = 0, deadline = Infinity
    for (const row of state.rows.values()) {
      bytes += this.objectBytes(row)
      const oi = !numeric(row.oi) ? Number(row.statisticsOIExpiresAt) : 0
      const taker = !numeric(row.buy) || !numeric(row.sell) ? Number(row.statisticsTakerExpiresAt) : 0
      if (oi > Date.now()) deadline = Math.min(deadline, oi)
      if (taker > Date.now()) deadline = Math.min(deadline, taker)
    }
    for (const value of state.indicators.values()) bytes += this.objectBytes(value)
    for (const value of cached) bytes += this.objectBytes(value)
    state.byteSize = bytes
    state.statisticsDeadline = deadline
  },

  trim() {
    if (!this.presentationActive) return
    let bytes = [...this.series.values()].reduce((sum, state) => sum + (state.byteSize ?? 0), 0)
    for (const [key, state] of this.series) {
      if (this.series.size <= this.maxSeries && bytes <= this.maxBytes) break
      if (state.active || this.focusFor(key)) continue
      this.series.delete(key); if (!this.liveStates.has(key)) this.priceJournal.delete(key); bytes -= state.byteSize ?? 0
      for (const [attemptKey, attempt] of this.sourceAttempts) if (attempt.seriesKey === key && !this.universe.has(key)) this.sourceAttempts.delete(attemptKey)
    }
    for (const [attemptKey, attempt] of this.sourceAttempts) {
      if (!this.series.has(attempt.seriesKey) && !this.universe.has(attempt.seriesKey) && !this.focusFor(attempt.seriesKey)) {
        this.sourceAttempts.delete(attemptKey)
      }
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
      if (this.focusFor(key) || this.universe.has(key)) continue
      projected -= snapshotBytes(value); this.snapshots.delete(key)
    }
    for (const [key, state] of this.liveStates) {
      if (!this.realtimeKeys.has(key) && !this.universe.has(key) && !this.series.has(key) && !this.focusFor(key) && !state.active) {
        projected -= (state.byteSize ?? 0) + 4096
        this.liveStates.delete(key); this.priceJournal.delete(key)
        continue
      }
      if (projected <= this.maxProjectionBytes) continue
      if (this.focusFor(key) || this.universe.has(key) || state.active || this.series.get(key)?.active) continue
      projected -= state.byteSize ?? 0
      state.rows.clear(); this.sourceRowsChanged(state); state.indicators.clear(); state.barCaches?.clear(); state.projectedBars?.clear(); state.historyBarsCache = null; state.liveProjection = null; state.byteSize = 0
      state.indicatorFailures?.clear()
      // Quotes and fixed-size recursive checkpoints remain available on ticks.
    }
  },

  setPresentationActive(active) {
    if (typeof active !== 'boolean') throw new TypeError('Presentation activity must be a boolean.')
    if (this.closed || active === this.presentationActive) return
    this.presentationActive = active
    this.presentationEpoch += 1
    if (!active) {
      if (this.candidateTimer !== null) clearTimeout(this.candidateTimer)
      this.candidateTimer = null; this.candidateTimerAt = Infinity; this.candidateQueue = []
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
      this.refreshTimer = null; this.repairDeadlines.clear()
      if (this.livePublicationTimer !== null) clearImmediate(this.livePublicationTimer)
      this.livePublicationTimer = null
      for (const pending of this.livePublications.values()) pending.resolve(null)
      this.livePublications.clear()
      this.cancelPendingFocusRead('idle'); this.cancelFocusWaits('idle')
      for (const entry of this.focusReads) { entry.obsolete = true; this.cancelFocusReadWaiters(entry, 'idle') }
      // These consumers belong exclusively to chart preparation. HistorySync
      // retains independently owned continuity, audit and download consumers.
      this.reconcileSourceJobs()
      for (const id of this.calculationQueue.splice(0)) {
        const pending = this.calculations.get(id)
        if (pending) { this.calculations.delete(id); pending.reject(new Error('Chart preparation paused.')) }
      }
      return
    }
    // Restart admission; the local hydration barrier publishes retained inputs
    // once the selected chart's durable basis is consistent.
    for (const demand of this.universe.values()) this.queueCandidate(demand, true)
    for (const focus of this.focuses.values()) {
      const state = this.series.get(focus.key)
      if (state) this.seed(state, 'foreground', focus)
      const epoch = this.presentationEpoch
      focus.task = Promise.resolve().then(() => this.prepareFocus(focus, epoch))
      void focus.task.catch(() => {}).finally(() => this.scheduleRefresh())
    }
    this.scheduleCandidates(); this.scheduleRefresh()
  },

  refreshPresentationFrames() {
    const keys = new Set([...this.snapshots.keys(), ...this.universe.keys(), ...[...this.focuses.values()].map(focus => focus.key)])
    for (const key of keys) {
      const state = this.series.get(key) ?? this.liveStates.get(key)
      if (state?.loaded) this.publish(state)
    }
  },

  async preparePresentationResume() {
    if (this.closed || !this.presentationActive) return
    const epoch = this.presentationEpoch
    const keys = new Set([...this.snapshots.keys(), ...[...this.focuses.values()].map(focus => focus.key)])
    const wanted = () => !this.closed && this.presentationActive && this.presentationEpoch === epoch
    await Promise.all([...keys].map(async key => {
      const state = this.series.get(key) ?? this.liveStates.get(key)
      if (!state || state.loaded) return
      const live = this.liveStates.get(key)
      const reads = [this.read(state, state.historyEnd ?? undefined, state.historyEnd == null ? this.tailBars(state.key) : this.historyReadBars(state.key), 'foreground', { wanted })]
      if (state.historyEnd != null && live && live !== state && !live.loaded) reads.push(this.read(live, undefined, this.tailBars(state.key), 'foreground', { wanted }))
      await Promise.all(reads)
    }))
    if (wanted()) {
      for (const focus of this.focuses.values()) {
        const state = this.series.get(focus.key)
        // A correction may have invalidated recursive indicator history while
        // asleep. Do not announce a ready selected view until its local replay
        // (including a restarted input generation) has settled.
        if (state) await this.focusSeed(state, focus)
        while (wanted() && state && (state.calculation || this.liveSeeds.get(state.key))) {
          await (state.calculation ?? this.liveSeeds.get(state.key))
        }
      }
      if (wanted()) this.refreshPresentationFrames()
    }
  },

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
  },

  // Renderer hydration observes backend-owned membership without admitting work.
  residentFrames() {
    return { frames: [...this.universe.keys()].flatMap(key => this.cached(key) ?? []) }
  },

  currentDemand(demand) { return this.currentFocus(demand) || !this.closed && demand != null && this.universe.get(demand.key) === demand },
  sourceDemand(demand) { return this.presentationActive && this.currentDemand(demand) && (this.currentFocus(demand) || this.acquire(demand.instId, demand.timeframe)) },
  stateDemand(state) { return this.liveStates.get(state.key) === state && this.universe.get(state.key) || (this.focusFor(state.key) ?? this.universe.get(state.key)) },
  candidateVersion(demand) {
    const state = this.liveStates.get(demand.key)
    return `${Math.floor(Date.now() / intervalFor(demand.timeframe))}:${this.sourceEpoch}:${state?.generation}:${state?.priceVersion}:${state?.oiVersion}:${state?.takerVersion}:${this.store.candleRevision?.(demand.instId, demand.timeframe)}`
  },

  queueCandidate(demand, force = false) {
    if (!this.presentationActive || !this.currentDemand(demand)) return
    if (this.candidateTasks.has(demand)) { if (force) demand.refreshRequested = true; return }
    if (this.candidateQueue.includes(demand)) return
    if (!force && demand.preparedVersion === this.candidateVersion(demand)) return
    this.candidateQueue.push(demand)
    queueMicrotask(() => this.drainCandidates())
  },

  drainCandidates() {
    if (this.closed || !this.presentationActive) return
    while (this.candidateTasks.size < this.candidateLimit && this.candidateQueue.length) {
      const demand = this.candidateQueue.shift()
      if (!this.currentDemand(demand)) continue
      const task = Promise.resolve().then(async () => {
        const epoch = this.presentationEpoch
        const wanted = () => this.presentationActive && this.presentationEpoch === epoch && this.currentDemand(demand)
        const wait = operation => abortable(operation, demand.controller.signal)
        demand.controller.signal.throwIfAborted()
        if (!wanted()) return
        const state = this.liveState(demand.instId, demand.timeframe)
        state.active += 1
        try {
          // A removed candidate can still share its admitted durable read with
          // a new owner; only an idle transition retires this admission.
          const admission = () => this.presentationActive && this.presentationEpoch === epoch && !this.closed
          if (!state.loaded || !state.rows.has(state.latestHour)) await wait(() => this.job(`local:${state.key}`, () => this.read(state, undefined, this.tailBars(state.key), 'chartWarm', { wanted: admission })))
          if (!wanted()) return
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
            if (!wanted()) return
            await wait(() => this.seed(state, 'chartWarm', demand))
          }
          if (!wanted()) return
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
  },

  scheduleCandidates() {
    if (this.closed || !this.presentationActive || !this.universe.size) {
      if (this.candidateTimer !== null) clearTimeout(this.candidateTimer)
      this.candidateTimer = null; this.candidateTimerAt = Infinity
      return
    }
    const now = Date.now()
    let deadline = Infinity
    const retries = new Map()
    for (const attempt of this.sourceAttempts.values()) if (attempt.retryAt > now)
      retries.set(attempt.seriesKey, Math.min(retries.get(attempt.seriesKey) ?? Infinity, attempt.retryAt))
    for (const demand of this.universe.values()) {
      const step = intervalFor(demand.timeframe), state = this.liveStates.get(demand.key)
      let at = Math.min((Math.floor(now / step) + 1) * step + 1000,
        state?.statisticsDeadline > now ? state.statisticsDeadline : Infinity, retries.get(demand.key) ?? Infinity)
      demand.refreshAt = at; deadline = Math.min(deadline, at)
      deadline = Math.min(deadline, liveStatisticsDeadline(state, now))
      const frame = this.cached(demand.key)
      if (frame?.realtimeState === 'live' && frame.priceObservedAt != null) deadline = Math.min(deadline, frame.priceObservedAt + 30_000)
    }
    if (this.candidateTimer === null || deadline !== this.candidateTimerAt) this.armCandidateTimer(deadline)
  },

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
        const frame = this.cached(demand.key)
        const statisticsExpired = frame?.liveBar && state?.live && (frame.liveBar.oiObserved && !sourceFresh(state.live, 1)
          || frame.liveBar.takerObserved && !sourceFresh(state.live, 2))
        if (state && (statisticsExpired || frame?.realtimeState === 'live' && frame.priceObservedAt + 30_000 <= Date.now())) this.publish(state)
        if (demand.refreshAt <= Date.now()) this.queueCandidate(demand, true)
      }
      this.scheduleCandidates()
    }, Math.max(1, deadline - Date.now()))
    this.candidateTimer.unref?.()
  },

  scheduleLiveExpiry(state) {
    if (this.closed || !this.presentationActive || !this.universe.has(state.key)) return
    const frame = this.cached(state.key)
    const deadline = Math.min(frame?.realtimeState === 'live' ? frame.priceObservedAt + 30_000 : Infinity, liveStatisticsDeadline(state, Date.now()))
    if (deadline < this.candidateTimerAt) this.armCandidateTimer(deadline)
  },

  projectedEntry(state, row) {
    const indicator = state.indicators.get(row.timestamp), oiFresh = sourceFresh(row, 1), takerFresh = sourceFresh(row, 2)
    state.projectedBars ??= new Map()
    const cached = state.projectedBars.get(row.timestamp)
    if (cached?.row === row && cached.indicator === indicator && cached.oiFresh === oiFresh && cached.takerFresh === takerFresh) return cached
    const entry = { row, indicator, oiFresh, takerFresh, token: ++this.nextProjection, bar: Object.freeze(bar(row, indicator, oiFresh, takerFresh)) }
    state.projectedBars.set(row.timestamp, entry)
    return entry
  },

  projectedLive(state, row, core) {
    // Both resident views publish the same quote. Keep one bounded projection
    // with the live resident, and separate its price math from statistic data.
    const owner = this.liveStates.get(state.key) ?? state
    const basis = core && core.lastTimestamp + state.intervalMS === row.timestamp ? core : null
    const previous = owner.liveProjection
    // Confirmed cores only mutate by appending a strictly later timestamp;
    // corrections replace or invalidate the core instead.
    const sameBasis = previous && previous.basis === basis && previous.timestamp === basis?.lastTimestamp
    const sameInputs = sameBasis && sameLiveIndicatorInput(previous.row, row)
    const calculated = sameInputs ? previous.calculated : basis ? projectIndicatorCandle(basis, row) : undefined
    const oiFresh = sourceFresh(row, 1), takerFresh = sourceFresh(row, 2)
    if (sameInputs && previous.row === row && previous.oiFresh === oiFresh && previous.takerFresh === takerFresh) return previous.bar
    const value = bar(row, calculated, oiFresh, takerFresh)
    if (calculated) value.quoteVolume = row.quoteVolume ?? null
    Object.freeze(value)
    owner.liveProjection = { row, basis, timestamp: basis?.lastTimestamp, calculated, oiFresh, takerFresh, bar: value }
    return value
  },

  projectBars(state, rows, projection, end) {
    state.projectedBars ??= new Map()
    const values = rows.map(row => this.projectedEntry(state, row))
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
  },

  frame(state, end = state.latestHour, historical = false) {
    const windowBars = this.visibleBars(state.key)
    const latest = this.liveStates.get(state.key)
    if (end === state.latestHour && !state.rows.has(end) && latest !== state && latest?.rows.has(end)) return this.frame(latest, end, historical)
    let rows
    if (end === null) rows = [...state.rows.values()].sort((a, b) => a.timestamp - b.timestamp)
    else {
      // Resident candles are admitted on the native interval grid. A viewport
      // therefore needs only its bounded viewport keyed lookups, independent of reserve size.
      rows = []
      const step = state.intervalMS, first = Math.ceil((end - (windowBars - 1) * step) / step) * step
      const last = Math.floor(end / step) * step
      for (let index = 0; index < windowBars; index += 1) {
        const timestamp = first + index * step
        if (timestamp > last) break
        const row = state.rows.get(timestamp)
        if (row) rows.push(row)
      }
    }
    state.barCaches ??= new Map()
    const bars = this.projectBars(state, rows, 'viewport', end)
    const live = state.live && (end === state.latestHour || end === null) ? state.live : null
    const core = latest?.indicatorState?.lastTimestamp === state.latestHour ? latest.indicatorState : state.indicatorState
    const liveBar = live ? this.projectedLive(state, live, core) : undefined
    const realtime = freshQuote(live?.timestamp, state.observedAt, state.intervalMS) && this.streaming(state.instId, state.timeframe)
    const expectedEnd = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const first = Math.max(0, (end ?? expectedEnd) - (windowBars - 1) * state.intervalMS, state.floor ?? 0)
    const complete = end !== null && rows.length === (end - first) / state.intervalMS + 1
      && rows.every((row, index) => row.timestamp === first + index * state.intervalMS && completePriceCandle(row))
    const availability = !bars.length && !liveBar ? 'loading' : !complete ? 'partial'
      : !historical && end < expectedEnd ? 'stale' : 'ready'
    const priceStatus = this.sourceStatus(state, 'candles', first, end ?? expectedEnd, availability)
    const indicatorStatus = this.indicatorStatus(state, bars, first, end ?? expectedEnd)
    return { instId: state.instId, timeframe: state.timeframe, intervalMS: state.intervalMS, windowBars, endHour: end,
      latestEnd: state.latestHour, oldestHour: state.floor, historyExhausted: state.floor !== null && (rows[0]?.timestamp ?? Infinity) <= state.floor,
      generation: state.generation, revision: this.nextRevision = Math.max(this.nextRevision + 1, this.revision(state.instId)), bars,
      priceState: priceStatus.state, priceStatus, priceAsOf: live?.timestamp ?? rows.at(-1)?.timestamp ?? null,
      priceObservedAt: state.observedAt, realtimeState: realtime ? 'live' : 'stale',
      sourceVersions: { price: state.priceVersion, oi: state.oiVersion ?? 0, taker: state.takerVersion ?? 0 },
      ...this.statisticsStatus(state, rows, first, end ?? expectedEnd),
      indicatorState: indicatorStatus.state, indicatorStatus,
      liveBar, error: priceStatus.error ?? '' }
  },

  sourceStatus(state, source, from, through, availability) {
    let status = { state: availability, from, through }
    if (!['ready', 'unavailable'].includes(availability)) {
      const attempts = this.sourceAttempts.group(state.key, source)
      let failure
      if (attempts) {
        const pending = this.pendingSourceRanges(state, source, from, through)
        for (const attempt of attempts.entries.values()) if ((!failure || attempt.failedAt > failure.failedAt)
          && pending.some(range => attempt.from <= range.through && attempt.through >= range.from)) failure = attempt
      }
      if (failure) status = { ...status, state: 'error', error: failure.error, retryAt: failure.retryAt }
      else if (source !== 'candles' && typeof this.history.ensureStatistics !== 'function') status = { ...status, state: 'unavailable', reason: 'unsupported' }
    } else if (availability === 'unavailable' && source !== 'candles') status.reason = 'not-published'
    return this.cachedStatus(state, source, status)
  },

  cachedStatus(state, source, status) {
    state.statusCache ??= new Map()
    const { through } = status
    const key = `${source}:${through}`, previous = state.statusCache.get(key)
    if (sameStatus(previous, status)) status = previous
    state.statusCache.delete(key); state.statusCache.set(key, status)
    while (state.statusCache.size > 12) state.statusCache.delete(state.statusCache.keys().next().value)
    return status
  },

  indicatorInputVersion(state) {
    return `${FORMULA_VERSION}:${state.generation}:${state.priceVersion}:${this.priceJournal.get(state.key)?.at(-1)?.revision ?? 0}`
  },

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
  },

  statisticsStatus(state, rows, from, through) {
    const result = {}
    for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
      const complete = through !== null && rows.length === (through - from) / state.intervalMS + 1
      const status = this.sourceStatus(state, source, from, through, complete ? sourceState(rows, bit) : 'loading')
      result[`${source}State`] = status.state
      result[`${source}Status`] = status
    }
    return result
  },

  demandPriority(state, from, through, focus = this.focusFor(state.key)) {
    const candidate = this.universe.get(state.key) === focus, selected = candidate ? this.focusFor(state.key) : focus
    const end = selected?.end ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    if (selected?.key === state.key && from <= end && through >= end - (this.visibleBars(state.key) - 1) * state.intervalMS) return 'interactive'
    return candidate ? 'chartWarm' : 'prefetch'
  },

  samePublishedFrame(left, right) {
    if (!left || left.bars !== right.bars) return false
    const fields = ['windowBars', 'instId', 'timeframe', 'intervalMS', 'endHour', 'latestEnd', 'oldestHour', 'historyExhausted', 'generation',
      'priceState', 'priceStatus', 'priceAsOf', 'priceObservedAt', 'realtimeState', 'sourceVersions',
      'oiState', 'oiStatus', 'takerState', 'takerStatus', 'indicatorState', 'indicatorStatus', 'error']
    // Frame fields are owned JSON data; unchanged identities need no encoding.
    return fields.every(field => Object.is(left[field], right[field]) || JSON.stringify(left[field]) === JSON.stringify(right[field]))
      && (Object.is(left.liveBar, right.liveBar) || JSON.stringify(left.liveBar) === JSON.stringify(right.liveBar))
  },

  samePublishedHistory(left, right) {
    if (!left || left.bars !== right.bars) return false
    const fields = ['windowBars', 'instId', 'timeframe', 'intervalMS', 'latestEnd', 'oldestHour', 'historyExhausted', 'generation', 'priceState',
      'sourceVersions', 'oiState', 'takerState', 'indicatorState', 'error']
    const content = status => {
      if (!status) return status
      if (!['ready', 'unavailable'].includes(status.state)) return status
      const { from: _from, through: _through, ...value } = status
      return value
    }
    return fields.every(field => JSON.stringify(left[field]) === JSON.stringify(right[field]))
      && ['priceStatus', 'oiStatus', 'takerStatus', 'indicatorStatus'].every(field => JSON.stringify(content(left[field])) === JSON.stringify(content(right[field])))
  },

  publish(state) {
    if (!this.presentationActive) return this.cached(state.key)
    // A source/repair publication can satisfy a queued live projection too.
    // Do not let an obsolete resident state consume another generation's work.
    const current = this.series.get(state.key) === state || this.liveStates.get(state.key) === state
    const pending = current ? this.livePublications.get(state.key) : null
    if (pending) {
      this.livePublications.delete(state.key)
      if (!this.livePublications.size && this.livePublicationTimer !== null) {
        clearImmediate(this.livePublicationTimer); this.livePublicationTimer = null
      }
    }
    const project = () => {
      const frame = this.publishFrame(state)
      if (pending) {
        const live = this.liveStates.get(state.key)
        if (this.focusFor(state.key)) this.scheduleRefresh()
        if (live) this.scheduleLiveExpiry(live)
        pending.resolve(frame)
      }
      return frame
    }
    try { return project() } catch (error) {
      pending?.reject(error)
      throw error
    }
  },

  publishFrame(state) {
    // Collector/list-metric residency alone still never materializes a chart.
    if (!state.chartRequested && !this.focusFor(state.key) && !this.universe.has(state.key) && !this.snapshots.has(state.key)) return null
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
  },

  queueLivePublication(key) {
    let pending = this.livePublications.get(key)
    if (!pending) {
      let resolve, reject
      const promise = new Promise((done, fail) => { resolve = done; reject = fail })
      pending = { promise, resolve, reject }
      this.livePublications.set(key, pending)
    }
    this.scheduleLivePublications()
    return pending.promise
  },

  scheduleLivePublications() {
    if (this.closed || !this.presentationActive || this.livePublicationTimer !== null || !this.livePublications.size) return
    this.livePublicationTimer = setImmediate(() => {
      this.livePublicationTimer = null
      const deadline = performance.now() + LIVE_TURN_MS
      let count = 0
      while (!this.closed && this.livePublications.size && count < LIVE_TURN_FRAMES && (count === 0 || performance.now() < deadline)) {
        const [key, pending] = this.livePublications.entries().next().value
        const state = this.series.get(key) ?? this.liveStates.get(key)
        if (!state) { this.livePublications.delete(key); pending.resolve(null) }
        else {
          // publish settles the shared promise; a failed series must not stop
          // unrelated series from making progress in subsequent turns.
          try { this.publish(state) } catch { /* The admitted callers receive the failure. */ }
        }
        count += 1
      }
      this.scheduleLivePublications()
    })
  },

  historyFrame(state, end) {
    const frame = this.frame(state, end, true)
    // Cursor movement changes frame metadata, not the projection of resident rows.
    const previousKey = state.historyBarsCache?.key
    frame.bars = this.projectBars(state, [...state.rows.values()].sort((a, b) => a.timestamp - b.timestamp), 'history')
    frame.historyExhausted = state.floor !== null && (frame.bars[0]?.hour ?? Infinity) <= state.floor
    if (state.historyBarsCache?.key !== previousKey) this.updateMemory(state)
    return frame
  },
}
