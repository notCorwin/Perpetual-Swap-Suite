import { validChartWindowBars } from '../chart-viewport.js'
import { completePriceCandle } from './market-records.js'
import {
  VISIBLE, TAIL, HISTORY, HISTORY_AHEAD, HISTORY_PAGE, HISTORY_BASE_VISIBLE,
  HISTORY_RUNWAY, HISTORY_RESIDENT, HISTORY_BALANCE, HISTORY_SHARE_DISTANCE, INDICATOR_WARMUP,
  intervalFor, assertCandleGrid, seriesKey, numeric, freshQuote, samePrice, sameRecord,
  immutableRecord, sourceFresh, changedSource, mergeStatistics, sharedIndicatorState,
} from './prepared-chart-helpers.js'

export const preparedChartFocusMethods = {
  /** Focus owns source demand, never the durable facts or an admitted local read. */
  setFocus(target, id, slot = 'primary') {
    if (!['primary', '1H', '15m', '5m'].includes(slot)) throw new Error('Invalid chart slot.')
    const current = this.focuses.get(slot)
    const key = target ? seriesKey(target.instId, target.timeframe) : null
    if (target && (!intervalFor(target.timeframe) || target.endHour !== undefined && !Number.isFinite(target.endHour))) throw new Error('Invalid chart target.')
    if (target?.windowBars !== undefined && !validChartWindowBars(target.windowBars)) throw new Error('Invalid chart window size.')
    if (id !== undefined) this.explicitFocus = true
    if (key === current?.key && target?.endHour === current?.end && (target?.windowBars ?? VISIBLE) === current?.windowBars && id === current?.id) return
    this.replaceFocus(target, id, slot)
  },

  // An invalidated input generation needs a new preparation identity while
  // preserving the renderer's ownership token and selected cursor.
  replaceFocus(target, id, slot = 'primary') {
    const key = target ? seriesKey(target.instId, target.timeframe) : null
    const previous = this.focuses.get(slot)
    const previousEnd = previous?.key === key ? previous.end ?? this.series.get(key)?.latestHour : null
    const direction = target?.endHour !== undefined && previousEnd != null ? Math.sign(target.endHour - previousEnd) : 0
    if (previous) {
      this.cancelPendingFocusRead('superseded', previous)
      this.cancelFocusWaits('superseded', previous)
    }
    for (const entry of this.focusReads) {
      if (!previous) continue
      this.cancelFocusReadWaiters(entry, 'superseded', previous)
      if (entry.focus === previous && !this.focusReadRelevant(entry, target)) entry.obsolete = true
    }
    const owner = target ? { key, slot, instId: target.instId, timeframe: target.timeframe, end: target.endHour, windowBars: target.windowBars ?? VISIBLE, id,
      direction: direction || (previous?.key === key ? previous.direction : 0) } : null
    if (owner) this.focuses.set(slot, owner)
    else this.focuses.delete(slot)
    const state = target ? this.state(target.instId, target.timeframe) : null
    if (state) state.historyEnd = target.endHour ?? null
    // Selection promotes an already admitted quote ahead of background work.
    if (state && this.livePublications.has(key)) this.publish(state)
    if (this.closed || (this.focuses.get(slot) ?? null) !== owner) return
    const candidate = this.universe.get(key), queued = this.candidateQueue.indexOf(candidate)
    if (queued > 0) { this.candidateQueue.splice(queued, 1); this.candidateQueue.unshift(candidate) }
    this.reconcileSourceJobs()
    if (owner && this.presentationActive) {
      const focus = owner
      const epoch = this.presentationEpoch
      focus.task = Promise.resolve().then(() => this.prepareFocus(focus, epoch))
      // The command acknowledges intent immediately; lifecycle notifications
      // and backend retry deadlines report independently owned source work.
      void focus.task.catch(() => {}).finally(() => this.scheduleRefresh())
    }
    this.scheduleRefresh()
    this.onFocus(this.focus)
  },

  reconcileSourceJobs() {
    for (const [sourceKey, job] of this.sourceTasks) {
      job.demands = new Set([...(job.demands ?? [])].filter(demand => this.sourceDemand(demand)))
      const candidate = this.universe.get(job.seriesKey), candidateStep = job.state.intervalMS
      const candidateEnd = Math.floor(Date.now() / candidateStep) * candidateStep - candidateStep
      const displayedEnd = this.liveStates.get(job.seriesKey)?.latestHour ?? candidateEnd
      if (candidate && this.sourceDemand(candidate) && [candidateEnd, displayedEnd].some(end => job.from <= end
        && job.through >= end - (VISIBLE - 1 + (job.source === 'candles' ? INDICATOR_WARMUP : 0)) * candidateStep)) job.demands.add(candidate)
      // A nearby cursor can still use an admitted viewport/reserve page. Keep
      // that consumer attached so HistorySync need not abort and refetch it.
      for (const focus of this.focuses.values()) {
        const step = intervalFor(focus.timeframe), end = focus.end ?? Math.floor(Date.now() / step) * step - step
        const from = end - ((focus.windowBars ?? VISIBLE) - 1) * step
        if (this.sourceDemand(focus) && job.seriesKey === focus.key && (job.from <= end && job.through >= from
          || job.reserve && end >= job.reserve.from && end <= job.reserve.through)) {
          if (job.from <= end && job.through >= from) this.promoteSourceJob(job, 'interactive')
          job.demands.add(focus)
        }
      }
      if (job.demands.size) continue
      this.sourceTasks.delete(sourceKey)
      if (this.tasks.get(sourceKey) === job.task) this.tasks.delete(sourceKey)
      job.controller.abort()
    }
    this.drainWarmSources()
  },

  requestFocus(instId, timeframe, end, focusId) {
    const key = seriesKey(instId, timeframe)
    if (focusId !== undefined || this.explicitFocus) return this.focusById(focusId)?.key === key ? this.focusById(focusId) : null
    this.setFocus({ instId, timeframe, endHour: end })
    return this.focus
  },

  currentFocus(focus) { return !this.closed && focus != null && this.focuses.get(focus.slot ?? 'primary') === focus },

  sourceStateChanged() {
    this.sourceEpoch += 1
    this.reconcileSourceJobs()
    if (!this.presentationActive) return
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
  },

  async read(state, end, limit = TAIL, priority = 'foreground', options = {}) {
    // A bounded local query belongs to its admitted state until both rows and
    // coverage arrive. Concurrent selections cannot evict it during SQLite IPC.
    state.active = (state.active ?? 0) + 1
    try { return await this.readRows(state, end, limit, priority, options) }
    finally { state.active -= 1 }
  },

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
    const inspected = state.historyReadRange
    let fencedRevision = null
    if (residentRevision != null && inspected?.revision === residentRevision && inspected.priceVersion === state.priceVersion
      && rows.some(row => row.confirmed && !state.rows.has(row.timestamp) && row.timestamp > residentFirst && row.timestamp < residentLast
        && (row.timestamp < inspected.from || row.timestamp > inspected.through))
      && typeof this.store.withCandleCommitFence === 'function') {
      // A reader can see a committed write before the writer's revision
      // notification reaches this process. Wait for dispatched writes before
      // trusting the in-memory revision as a proof of unchanged source data.
      fencedRevision = await this.store.withCandleCommitFence(() => this.store.candleRevision(state.instId, state.timeframe))
      if (this.closed || options.wanted && !options.wanted()) return false
      if (admittedPrice !== state.priceVersion || state.historyReadRange !== inspected || fencedRevision !== residentRevision
        || residentRevision !== this.store.candleRevision?.(state.instId, state.timeframe)) return this.readRows(state, end, limit, priority, options)
    }
    for (const row of rows) if (row.confirmed) assertCandleGrid(row.timestamp, state.intervalMS)
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
      // A retained historical reserve and the latest tail may be disjoint.
      // Their min/max timestamps do not prove the interval between them was
      // previously read. At an unchanged durable revision, rows outside the
      // inspected range are ordinary admission, not a repaired source hole.
      const uninspected = !previous && fencedRevision !== null && inspected?.revision === fencedRevision && inspected.priceVersion === state.priceVersion
        && (row.timestamp < inspected.from || row.timestamp > inspected.through)
      if (previous ? !samePrice(previous, value) : !uninspected && row.timestamp > residentFirst && row.timestamp < residentLast) {
        pricesChanged = true; changedFrom = Math.min(changedFrom, row.timestamp)
      }
      const unchanged = sameRecord(previous, value)
      if (!unchanged) observationsChanged = true
      if (changedSource(previous, value, 1)) oiChanged = true
      if (changedSource(previous, value, 2)) takerChanged = true
      state.rows.set(row.timestamp, immutableRecord(unchanged ? previous : value))
      if (!unchanged) this.sourceRowsChanged(state, row.timestamp)
    }
    if (pricesChanged) state.priceVersion += 1
    if (observationsChanged) state.sourceVersion += 1
    if (oiChanged) state.oiVersion = (state.oiVersion ?? 0) + 1
    if (takerChanged) state.takerVersion = (state.takerVersion ?? 0) + 1
    if (pricesChanged) this.invalidateDerived(state, changedFrom)
    const retained = this.retainRows(state, this.liveStates.get(state.key) === state ? this.tailBars(state.key) : this.focusFor(state.key) ? this.historyResidentBars(state.key) : HISTORY, end)
    const inspectedPriceVersion = state.priceVersion
    const inspectedRetentionVersion = state.retentionVersion ?? 0
    const coverageGeneration = state.generation
    this.updateMemory(state)
    const coverage = await this.store.coverage(state.instId, state.timeframe, priority)
    if (this.closed || options.wanted && !options.wanted()) return false
    // Invalidation may clear the rows while coverage is in flight. Neither the
    // old metadata nor its read proof belongs to the replacement generation.
    if (coverageGeneration !== state.generation) return this.readRows(state, end, limit, priority, options)
    state.latestHour = coverage.last === null ? state.latestHour : Math.max(state.latestHour ?? -Infinity, coverage.last)
    const listing = Number(this.instrument(state.instId)?.listTime)
    state.floor = Number.isFinite(listing) && listing > 0 ? Math.ceil(listing / state.intervalMS) * state.intervalMS : null
    state.loaded = true
    if (limit >= HISTORY) {
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
  },

  retainRows(state, limit, cursor = state.historyEnd) {
    if (!state.rows.size) { state.retainedRange = null; state.historyReadRange = null; this.pruneSourceAttempts(state); return null }
    // Current navigation owns the whole reserve, even when an older query or
    // a latest-tail hydration finishes after focus has moved.
    if (limit > this.tailBars(state.key) && this.focusFor(state.key)) cursor = this.focusFor(state.key).end
    const historical = cursor !== null && cursor !== undefined
    const anchor = historical ? cursor : Math.max(...state.rows.keys())
    let ahead = historical ? HISTORY_AHEAD : 0
    const focus = this.focusFor(state.key)
    if (historical && focus && limit === this.historyResidentBars(state.key)) {
      ahead = HISTORY_BALANCE
      if (focus.direction > 0) {
        ahead = Math.min(limit - HISTORY_BALANCE, Math.max(0, limit - this.visibleBars(state.key) - HISTORY_RUNWAY))
      }
    }
    const first = anchor - (limit - ahead - 1) * state.intervalMS, last = anchor + ahead * state.intervalMS
    let evicted = false
    for (const hour of state.rows.keys()) if (hour < first || hour > last) {
      state.rows.delete(hour); state.indicators.delete(hour); state.projectedBars?.delete(hour)
      this.sourceRowsChanged(state, hour)
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
  },

  pruneSourceAttempts(state) {
    // The latest tail cannot retire errors owned by a resident historical
    // reserve of the same series. Both share one bounded source lifetime.
    if (this.series.has(state.key) && this.series.get(state.key) !== state) return
    const attempts = []
    for (const entry of this.sourceAttempts) if (entry[1].seriesKey === state.key) attempts.push(entry)
    if (!attempts.length) return
    const resident = this.series.get(state.key)
    const hours = [...(resident?.rows.keys() ?? []), ...(this.liveStates.get(state.key)?.rows.keys() ?? [])].sort((left, right) => left - right)
    const selected = this.focusFor(state.key) ? this.focusFor(state.key).end ?? state.latestHour ?? Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS : null
    const from = selected === null ? null : selected - (this.visibleBars(state.key) - 1) * state.intervalMS
    for (const [key, attempt] of attempts) {
      let low = 0, high = hours.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (hours[middle] < attempt.from) low = middle + 1
        else high = middle
      }
      if (!(hours[low] >= attempt.from && hours[low] <= attempt.through) && !(selected !== null && attempt.from <= selected && attempt.through >= from)) this.sourceAttempts.delete(key)
    }
  },

  invalidateDerived(state, from) {
    const generation = ++this.nextGeneration
    for (const current of new Set([state, this.series.get(state.key), this.liveStates.get(state.key)].filter(Boolean))) {
      current.generation = generation
      if ((current.indicatorState?.lastTimestamp ?? -Infinity) >= from) current.indicatorState = null
      for (const hour of current.indicators.keys()) if (hour >= from) current.indicators.delete(hour)
      current.indicatorFailures?.clear()
      current.indicatorVersion = (current.indicatorVersion ?? 0) + 1
    }
  },

  syncLive(state) {
    const live = this.liveState(state.instId, state.timeframe)
    if (live === state) return live
    if (state.generation < live.generation) {
      state.generation = live.generation
      state.indicators.clear(); state.indicatorState = null; state.indicatorFailures?.clear()
    }
    const latestHour = state.latestHour === null ? live.latestHour : live.latestHour === null ? state.latestHour : Math.max(live.latestHour, state.latestHour)
    // Historical reserves cannot replace the separately retained latest tail.
    const cutoff = latestHour === null ? -Infinity : latestHour - (this.tailBars(state.key) - 1) * state.intervalMS
    for (const [hour, row] of state.rows) if (hour >= cutoff) {
      const previous = live.rows.get(hour)
      if (previous && !samePrice(previous, row)) live.indicators.delete(hour)
      if (previous !== row) this.sourceRowsChanged(live, hour)
      live.rows.set(hour, row)
      if (state.indicators.has(hour)) live.indicators.set(hour, state.indicators.get(hour))
      const failure = state.indicatorFailures?.get(hour)
      if (failure) { live.indicatorFailures ??= new Map(); live.indicatorFailures.set(hour, failure) }
    }
    if (latestHour !== null) for (const hour of live.rows.keys()) if (hour < cutoff) {
      live.rows.delete(hour); live.indicators.delete(hour); live.projectedBars?.delete(hour)
      this.sourceRowsChanged(live, hour)
    }
    for (const hour of live.indicatorFailures?.keys() ?? []) if (!live.rows.has(hour)) live.indicatorFailures.delete(hour)
    if (state.indicatorState && (!live.indicatorState || state.indicatorState.lastTimestamp > live.indicatorState.lastTimestamp)) live.indicatorState = sharedIndicatorState(state.indicatorState)
    live.latestHour = latestHour; live.floor = state.floor; live.generation = state.generation
    live.loaded ||= state.loaded
    for (const field of ['sourceVersion', 'priceVersion', 'oiVersion', 'takerVersion', 'indicatorVersion']) live[field] = Math.max(live[field] ?? 0, state[field] ?? 0)
    live.bollExpansion = live.indicatorState?.bollExpansion ?? null
    this.updateMemory(live)
    return live
  },

  async local(instId, timeframe, { priority = 'foreground', wanted } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    if (!intervalFor(timeframe)) throw new Error('Unsupported chart timeframe.')
    const key = seriesKey(instId, timeframe)
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    if (!state.loaded || !state.rows.has(state.latestHour) || this.visibleBars(key) > VISIBLE && !state.rows.has(Math.max(state.floor ?? 0, state.latestHour - (this.visibleBars(key) - 1) * state.intervalMS))) {
      await this.job(`local:${key}`, () => this.read(state, undefined, this.tailBars(state.key), priority, { wanted }))
      if (wanted && !wanted()) return null
      // A concurrent candidate may own this coalesced SQLite read. Its compact
      // facts also admit the selected chart without another disk query.
      const live = this.liveStates.get(key)
      if (live !== state && live?.loaded && (!state.loaded || !state.rows.has(state.latestHour))) {
        for (const [hour, row] of live.rows) {
          if (state.rows.get(hour) !== row) this.sourceRowsChanged(state, hour)
          state.rows.set(hour, row); if (live.indicators.has(hour)) state.indicators.set(hour, live.indicators.get(hour))
        }
        for (const field of ['latestHour', 'floor', 'generation', 'sourceVersion', 'priceVersion', 'oiVersion', 'takerVersion', 'indicatorVersion', 'loaded']) state[field] = live[field]
        state.barCaches = new Map(live.barCaches ?? [])
        state.projectedBars = new Map(live.projectedBars ?? [])
        if (live.indicatorState) state.indicatorState = sharedIndicatorState(live.indicatorState)
        this.updateMemory(state)
      }
    }
    // A selected width expansion can share an already admitted narrow candidate
    // read. Inspect its coverage before returning that read as the wide viewport.
    const first = state.latestHour === null ? null : Math.max(state.floor ?? 0, state.latestHour - (this.visibleBars(key) - 1) * state.intervalMS)
    if (this.visibleBars(key) > VISIBLE && first !== null && !state.rows.has(first)) {
      await this.job(`local-wide:${key}:${this.visibleBars(key)}`, () => this.read(state, undefined, this.tailBars(key), priority, { wanted }))
      if (wanted && !wanted()) return null
    }
    const frame = this.publish(state)
    return frame?.bars.length || frame?.liveBar ? frame : null
  },

  // Explicit focus reads share two SQLite lanes and at most one waiting
  // demand per slot. Replacing a slot retires only its obsolete consumers.
  // Independent read-only callers do not participate in this ownership.
  cancelPendingFocusRead(_reason, focus) {
    for (const entry of this.pendingFocusReads.values()) {
      if (focus !== undefined && entry.focus !== focus) continue
      this.pendingFocusReads.delete(entry.focus.slot ?? 'primary')
      this.cancelFocusReadWaiters(entry)
      entry.resolveDone()
    }
  },

  cancelFocusReadWaiters(entry, _reason, focus) {
    for (const [owner, waiter] of entry.waiters) {
      if (focus !== undefined && owner !== focus) continue
      entry.waiters.delete(owner)
      waiter.resolve(false)
    }
  },

  focusReadWaiter(entry, focus) {
    let waiter = entry.waiters.get(focus)
    if (!waiter) {
      waiter = {}
      waiter.task = new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
      entry.waiters.set(focus, waiter)
    }
    return waiter.task
  },

  // Focuses may change many times while one source or indicator replay is
  // held. One observer per underlying task owns removable focus waiters.
  cancelFocusWaits(_reason, focus) {
    for (const group of this.focusWaits.values()) {
      for (const [owner, waiter] of group.waiters) {
        if (focus !== undefined && owner !== focus) continue
        group.waiters.delete(owner)
        waiter.resolve(false)
      }
    }
  },

  waitForFocus(focus, task) {
    if (!this.currentFocus(focus)) return Promise.resolve(false)
    if (!task) return Promise.resolve(true)
    let group = this.focusWaits.get(task)
    if (!group) {
      group = { instId: focus.instId, waiters: new Map() }
      this.focusWaits.set(task, group)
      const finish = (succeeded, error) => {
        if (this.focusWaits.get(task) === group) this.focusWaits.delete(task)
        for (const waiter of group.waiters.values()) {
          if (succeeded) waiter.resolve(true)
          else waiter.reject(error)
        }
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
  },

  focusSeed(state, focus) {
    const running = state.calculation ?? this.liveSeeds.get(state.key)
    if (!running) return this.seed(state, 'foreground', focus)
    if (state.focusSeed?.running === running) return state.focusSeed.task
    // A prior candidate or input generation may finish without covering the
    // selected reserve. Recheck once for the current owner, not once per move.
    const entry = { running }
    entry.task = running.then(() => {
      const current = this.focusFor(state.key)
      if (!this.closed && current?.key === state.key && this.series.get(state.key) === state) return this.seed(state, 'foreground', current)
    })
    state.focusSeed = entry
    entry.task.then(() => { if (state.focusSeed === entry) state.focusSeed = null }, () => { if (state.focusSeed === entry) state.focusSeed = null })
    return entry.task
  },

  focusReadRelevant(entry, target) {
    if (entry.obsolete || !target || seriesKey(target.instId, target.timeframe) !== entry.state.key) return false
    const end = target.endHour ?? entry.state.latestHour, step = entry.state.intervalMS
    if (end == null || Math.abs(entry.end - end) > HISTORY_SHARE_DISTANCE * step) return false
    const first = Math.max(0, end - ((target.windowBars ?? VISIBLE) - 1) * step, entry.state.floor ?? 0)
    return entry.from <= first && entry.through >= end
  },

  focusHistoryRead(state, focus, ahead, end = focus.end) {
    if (!this.presentationActive || !this.currentFocus(focus) || end === undefined || end === null) return Promise.resolve(false)
    const step = state.intervalMS
    const shared = [...this.focusReads].find(entry => entry.state === state && this.focusReadRelevant(entry, { ...focus, endHour: end }))
    if (shared) return this.focusReadWaiter(shared, focus)
    const pending = this.pendingFocusReads.get(focus.slot ?? 'primary')
    if (pending?.focus === focus && pending.state === state && this.focusReadRelevant(pending, { ...focus, endHour: end })) return this.focusReadWaiter(pending, focus)
    if (pending) this.cancelPendingFocusRead('replaced', pending.focus)
    const limit = this.historyReadBars(state.key)
    const entry = { state, focus, end, ahead, limit, epoch: this.presentationEpoch, from: Math.max(0, end - (limit - ahead - 1) * step),
      through: end + ahead * step, waiters: new Map() }
    entry.done = new Promise(resolve => { entry.resolveDone = resolve })
    const waiter = this.focusReadWaiter(entry, focus)
    if (this.focusReads.size < 2) this.startFocusRead(entry)
    else this.pendingFocusReads.set(focus.slot ?? 'primary', entry)
    return waiter
  },

  startFocusRead(entry) {
    this.focusReads.add(entry)
    const wanted = () => {
      const focus = this.focusFor(entry.state.key)
      return !this.closed && this.presentationActive && entry.epoch === this.presentationEpoch && this.series.get(entry.state.key) === entry.state && focus != null
        && this.focusReadRelevant(entry, { ...focus, endHour: focus.end })
    }
    const task = Promise.resolve().then(async () => {
      if (!wanted()) return false
      const admitted = await this.read(entry.state, entry.end, entry.limit, 'foreground', { ahead: entry.ahead, wanted })
      if (admitted && wanted()) this.focusSeed(entry.state, this.focusFor(entry.state.key))
      return admitted
    })
    const finish = (succeeded, value) => {
      this.focusReads.delete(entry)
      try { if (!this.closed) this.trim() }
      catch (cleanup) {
        value = succeeded ? cleanup : new AggregateError([value, cleanup], `${value?.message ?? value}\n${cleanup.message}`, { cause: value })
        succeeded = false
      }
      for (const waiter of entry.waiters.values()) {
        if (succeeded) waiter.resolve(value)
        else waiter.reject(value)
      }
      entry.waiters.clear(); entry.resolveDone()
      const next = this.pendingFocusRead
      if (next) {
        this.pendingFocusReads.delete(next.focus.slot ?? 'primary')
        if (this.presentationActive && next.epoch === this.presentationEpoch && this.currentFocus(next.focus)) this.startFocusRead(next)
        else {
          this.cancelFocusReadWaiters(next); next.resolveDone()
        }
      }
    }
    task.then(value => finish(true, value), error => finish(false, error))
  },

  async localHistory(instId, timeframe, targetEnd, { focusId, windowBars } = {}) {
    if (this.closed) throw new Error('Prepared chart data service is closed.')
    if (!intervalFor(timeframe) || targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart target.')
    const selected = this.focusById(focusId)
    if (focusId !== undefined && (selected?.key !== seriesKey(instId, timeframe) || selected.id !== focusId || windowBars !== undefined && windowBars !== selected.windowBars
      || selected.end !== targetEnd && !(selected.end === undefined && targetEnd === this.series.get(selected.key)?.latestHour))) return null
    const state = this.state(instId, timeframe)
    state.chartRequested = true
    const end = targetEnd ?? state.latestHour
    const from = Math.max(0, end - (this.visibleBars(state.key) - 1) * state.intervalMS, state.floor ?? 0)
    const admitted = state.historyRange
    let resident = Boolean(state.loaded && admitted && end !== null && from >= admitted.from && end <= admitted.through
      && admitted.revision === this.store.candleRevision?.(instId, timeframe))
    for (let hour = from; resident && hour <= end; hour += state.intervalMS) resident = completePriceCandle(state.rows.get(hour))
    if (!resident) {
      if (focusId === undefined) await this.job(`history:${state.key}:${targetEnd ?? 'latest'}`, () => this.read(state, targetEnd, this.historyReadBars(state.key), 'foreground'))
      else {
        const focus = selected
        if (end === null || end === undefined) return null
        const ahead = this.initialHistoryAhead(end, state.intervalMS)
        if (!await this.focusHistoryRead(state, focus, ahead, end) || !this.currentFocus(focus)) return null
      }
    }
    if (!this.presentationActive || focusId !== undefined && !this.currentFocus(selected)) return null
    const frame = this.historyFrame(state, targetEnd ?? state.latestHour)
    return frame.bars.length || frame.liveBar ? frame : null
  },

  async prepare(instId, timeframe, targetEnd, _historyBars = VISIBLE, { focusId } = {}) {
    if (!intervalFor(timeframe) || targetEnd !== undefined && !Number.isFinite(targetEnd)) throw new Error('Invalid chart target.')
    const focus = this.requestFocus(instId, timeframe, targetEnd, focusId)
    if (focusId !== undefined && (!focus || focus.end !== targetEnd)) return null
    if (!this.presentationActive) return this.cached(seriesKey(instId, timeframe))
    if (focus) {
      await focus.task
      if (!this.presentationActive || !this.currentFocus(focus)) return null
      const state = this.state(instId, timeframe)
      return targetEnd === undefined ? this.frame(state) : this.historyFrame(state, targetEnd)
    }
    const frame = targetEnd === undefined ? await this.local(instId, timeframe) : await this.localHistory(instId, timeframe, targetEnd)
    const state = this.state(instId, timeframe)
    return frame ?? (targetEnd === undefined ? this.frame(state) : this.historyFrame(state, targetEnd))
  },

  historyReadBars(key) {
    return this.visibleBars(key) <= HISTORY_BASE_VISIBLE ? HISTORY : Math.max(HISTORY, this.visibleBars(key) + HISTORY_RUNWAY + HISTORY_BALANCE)
  },

  historyResidentBars(key) {
    return Math.max(HISTORY_RESIDENT, this.visibleBars(key) + HISTORY_RUNWAY + HISTORY_BALANCE)
  },

  initialHistoryAhead(end, step) {
    const ceiling = Math.floor(Date.now() / step) * step - step
    return Math.min(HISTORY_BALANCE, Math.max(HISTORY_AHEAD, Math.floor((ceiling - end) / step)))
  },

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
              && (attempt.demands ? attempt.demands.some(demand => this.currentDemand(demand)) : this.currentFocus(attempt.focus))))
        if (!blocked) return false
      }
    }
    return true
  },

  async prepareFocus(focus, epoch = this.presentationEpoch) {
    const admission = () => !this.closed && this.presentationActive && this.presentationEpoch === epoch
    const current = () => admission() && this.currentFocus(focus)
    if (!current()) return null
    const { instId, timeframe, end: targetEnd } = focus
    // The backend owns a fixed navigation reserve. Wheel cadence and renderer
    // prepare retries cannot change acquisition, cancellation, or retry policy.
    const reserveBars = this.historyReadBars(focus.key) - HISTORY_AHEAD
    const reserve = targetEnd === undefined ? undefined : { from: targetEnd - (reserveBars - 1) * intervalFor(timeframe), through: targetEnd }
    const resident = this.series.get(seriesKey(instId, timeframe))
    if (resident) resident.chartRequested = true
    // Keep enough prepared runway to cover a delayed history transfer while
    // amortizing each local admission across many cursor moves.
    if (resident && this.preparedHistoryReserve(resident, targetEnd, (focus.windowBars ?? VISIBLE) + HISTORY_RUNWAY, HISTORY_RUNWAY)) {
      const first = targetEnd - ((focus.windowBars ?? VISIBLE) - 1) * resident.intervalMS
      const failureVisible = [...resident.indicatorFailures.keys()].some(hour => hour >= first && hour <= targetEnd)
        || [...this.sourceAttempts.values()].some(attempt => attempt.seriesKey === resident.key
          && attempt.from <= targetEnd && attempt.through >= first)
      if (failureVisible) this.publish(resident)
      return null
    }
    if (resident && targetEnd !== undefined && resident.loaded) {
      const needsReserveRead = () => {
        const step = resident.intervalMS, firstVisible = Math.max(0, targetEnd - ((focus.windowBars ?? VISIBLE) - 1) * step, resident.floor ?? 0)
        const admitted = resident.historyRange, revision = this.store.candleRevision?.(instId, timeframe)
        let visible = Boolean(admitted && firstVisible >= admitted.from && targetEnd <= admitted.through && admitted.revision === revision)
        for (let hour = firstVisible; visible && hour <= targetEnd; hour += step) visible = completePriceCandle(resident.rows.get(hour))
        const firstReserve = Math.max(0, targetEnd - ((focus.windowBars ?? VISIBLE) + HISTORY_RUNWAY - 1) * step, resident.floor ?? 0)
        const ceiling = Math.floor(Date.now() / step) * step - step
        const lastReserve = Math.min(targetEnd + HISTORY_RUNWAY * step, resident.latestHour ?? targetEnd, ceiling)
        const read = resident.historyReadRange
        const valid = read && read.revision === revision && read.priceVersion === resident.priceVersion
        const older = !valid || read.from > firstReserve, newer = !valid || read.through < lastReserve
        if (!visible || !older && !newer) return null
        return newer && (!older || focus.direction > 0) ? 'newer' : 'older'
      }
      let side
      for (let pass = 0; pass < 2 && current() && (side = needsReserveRead()); pass += 1) {
        // An admitted reserve read belongs to the series, not the transient
        // cursor that happened to request it. New cursors share it, and a
        // distant missing viewport can still take its independent read lane.
        let ahead = HISTORY_AHEAD
        if (side === 'newer') {
          ahead = HISTORY - HISTORY_AHEAD - 1
          if ((focus.windowBars ?? VISIBLE) > HISTORY_BALANCE - HISTORY_RUNWAY) ahead = Math.min(ahead, Math.max(0, this.historyReadBars(focus.key) - (focus.windowBars ?? VISIBLE) - HISTORY_RUNWAY))
        }
        const before = resident.historyReadRange
        const progressed = await this.focusHistoryRead(resident, focus, ahead)
        const after = resident.historyReadRange
        if (progressed === false || before && after && before.from === after.from && before.through === after.through && before.revision === after.revision && before.priceVersion === after.priceVersion) break
      }
      if (!current()) return null
    }
    let frame
    if (targetEnd === undefined) frame = await this.local(instId, timeframe, { wanted: admission })
    else {
      const state = this.state(instId, timeframe)
      const end = targetEnd, first = Math.max(0, end - (this.visibleBars(state.key) - 1) * state.intervalMS, state.floor ?? 0)
      const admitted = state.historyRange
      let visible = Boolean(state.loaded && admitted && admitted.from <= first && admitted.through >= end
        && admitted.revision === this.store.candleRevision?.(instId, timeframe))
      for (let hour = first; visible && hour <= end; hour += state.intervalMS) visible = completePriceCandle(state.rows.get(hour))
      const missing = !visible, initialAhead = this.initialHistoryAhead(end, state.intervalMS)
      if (missing) await this.focusHistoryRead(state, focus, initialAhead)
      if (!current()) return null
      // Before asking the source for the older reserve, inspect its durable
      // rows too. A balanced initial read cannot certify the whole older page.
      const read = state.historyReadRange, revision = this.store.candleRevision?.(instId, timeframe)
      const reserveFirst = Math.max(0, end - (reserveBars - 1) * state.intervalMS, state.floor ?? 0, state.retainedRange?.from ?? 0)
      if (missing && initialAhead > HISTORY_AHEAD && (!read || read.revision !== revision
        || read.priceVersion !== state.priceVersion || read.from > reserveFirst)) {
        await this.focusHistoryRead(state, focus, HISTORY_AHEAD)
        if (!current()) return null
      }
      frame = this.historyFrame(state, end)
    }
    if (!current()) return null
    const state = this.state(instId, timeframe)
    state.active += 1
    try {
      if (!current()) return targetEnd === undefined ? frame ?? this.frame(state) : this.historyFrame(state, targetEnd)
      const prices = this.refreshObservations(state, targetEnd, focus.windowBars ?? VISIBLE, targetEnd === undefined ? focus.windowBars ?? VISIBLE : HISTORY_PAGE, focus, reserve)
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
        const retainedBars = state.retainedRange ? Math.max(focus.windowBars ?? VISIBLE, Math.floor((targetEnd - Math.max(state.retainedRange.from, inspectedFirst)) / state.intervalMS) + 1) : reserveBars
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
  },
}
