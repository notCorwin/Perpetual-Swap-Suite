import { statisticsMask } from './statistics-state.js'
import { completePriceCandle } from './market-records.js'
import {
  VISIBLE, CHUNK, HISTORY, HISTORY_AHEAD, INDICATOR_WARMUP,
  LEGACY_FORMULA_VERSION, FORMULA_VERSION, statisticsFields,
  intervalFor, assertCandleGrid, seriesKey, numeric, abortable,
  samePrice, sameRecord, immutableRecord, sourceFresh, liveStatisticsDeadline,
  priorityRank, changedSource, mergeStatistics, sharedIndicatorState, appendConfirmed,
} from './prepared-chart-helpers.js'

export const preparedChartSourceMethods = {
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
      const displayedFrom = Math.max(0, state.latestHour - (this.visibleBars(state.key) - 1) * step, state.floor ?? 0)
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
      await this.read(state, cursor, cursor === undefined ? this.tailBars(state.key) : this.historyReadBars(state.key), job.priority)
      signal.throwIfAborted()
      this.prefetchStatistics(state)
      this.seed(state, this.currentFocus(focus) ? 'foreground' : 'chartWarm', this.currentFocus(focus) ? undefined : focus); this.publish(state)
      const rows = result?.rows ? new Map(result.rows.map(row => [row.timestamp, row])) : state.rows
      for (let hour = priceFrom; hour <= end; hour += step) if (!completePriceCandle(rows.get(hour))) return false
      return true
    }, { state, source: 'candles', from: priceFrom, through: end, reserve, priority, demand: focus })
    task?.catch(() => {})
    return task
  },

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
  },

  prefetchStatistics(state, focus = this.focusFor(state.key)) {
    if (!this.currentFocus(focus) || focus.key !== state.key) return
    // Durable prices already admit this bounded navigation reserve. Its OI
    // and Taker coverage must advance without waiting for a price cache miss.
    for (const reserve of this.statisticsRanges(state)) this.refreshStatistics(state, reserve.from, reserve.through, 'prefetch', reserve, focus)
  },

  refreshStatistics(state, from, through, priority, reserve, demand = this.stateDemand(state)) {
    if (!this.sourceDemand(demand) || typeof this.history.ensureStatistics !== 'function') return
    const { instId, timeframe, intervalMS: step } = state
    for (const [source, bit] of [['oi', 1], ['taker', 2]]) {
      // Skipping an active range also means sharing its lifetime. Otherwise a
      // focus change can cancel the edge repair a candidate just reused.
      for (const job of this.sourceTasks.group(state.key, source)?.entries.values() ?? []) if (job.from <= through && job.through >= from) {
        if (demand) job.demands.add(demand)
        job.reserve ??= reserve
        this.promoteSourceJob(job, priority)
      }
      for (const bounds of this.pendingSourceRanges(state, source, from, through)) {
        this.sourceJob(`${source}:${state.key}:${bounds.from}:${bounds.through}`, async (signal, job) => {
          const field = source === 'oi' ? 'oiVersion' : 'takerVersion'
          const resident = [this.series.get(state.key), this.liveStates.get(state.key)]
            .map(current => current && { current, generation: current.generation, version: current[field], rows: new Map(current.rows) })
          const result = await this.history.ensureStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, signal, source)
          signal.throwIfAborted()
          // The projection can predate a newer notification. Re-read only if
          // this source changed, then fence changes during that read per slot.
          const current = [this.series.get(state.key), this.liveStates.get(state.key)]
          const unchanged = resident.every((entry, index) => entry ? current[index] === entry.current
            && entry.generation === entry.current.generation && entry.version === entry.current[field] : !current[index]
              || [...current[index].rows].every(([hour, row]) => {
                const previous = resident.find(value => value?.rows.has(hour))?.rows.get(hour)
                return previous ? !changedSource(previous, row, bit) : !(statisticsMask(row) & bit)
              }))
          await this.observeStatistics(instId, timeframe, bounds.from, bounds.through, job.priority, unchanged ? result?.rows : undefined, source)
          signal.throwIfAborted()
          for (let hour = bounds.from; hour <= bounds.through; hour += step) { const row = state.rows.get(hour); if (row && !sourceFresh(row, bit)) return false }
          return true
        }, { state, source, ...bounds, reserve, priority, demand })?.catch(() => {})
      }
    }
  },

  indicatorDemand(state, focus = this.stateDemand(state)) {
    if (!this.sourceDemand(focus) || focus.key !== state.key || typeof this.history.ensurePrices !== 'function') return null
    const expectedEnd = Math.floor(Date.now() / state.intervalMS) * state.intervalMS - state.intervalMS
    const end = focus.end ?? (this.universe.get(state.key) === focus ? state.latestHour ?? expectedEnd : expectedEnd)
    const floor = state.floor ?? 0, first = Math.max(0, end - ((focus.windowBars ?? VISIBLE) - 1) * state.intervalMS, floor)
    let from = Infinity, through = -Infinity
    for (let hour = first; hour <= end; hour += state.intervalMS) {
      const calculated = state.indicators.get(hour)
      if (!calculated) continue
      if (!numeric(calculated.ema) && hour >= floor + INDICATOR_WARMUP * state.intervalMS) {
        from = Math.min(from, hour - INDICATOR_WARMUP * state.intervalMS); through = hour
      }
    }
    return from < Infinity ? { from, through } : null
  },

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
      await this.read(state, cursor, cursor === undefined ? this.tailBars(state.key) : this.historyReadBars(state.key), job.priority)
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
  },

  promoteSourceJob(job, priority) {
    if (priorityRank(priority) <= priorityRank(job.priority)) return
    job.priority = priority
    this.drainWarmSources()
    const [instId, timeframe] = [job.state.instId, job.state.timeframe]
    this.history.promoteSource?.(instId, timeframe, job.source, job.from, job.through, priority)?.catch?.(() => {})
  },

  sourceRetryAt(state, source, from, through) {
    const attempts = this.sourceAttempts.group(state.key, source)
    if (!attempts) return 0
    const pending = this.pendingSourceRanges(state, source, from, through)
    let retryAt = 0
    for (const attempt of attempts.entries.values()) if (pending.some(range => attempt.from <= range.through && attempt.through >= range.from)
      && numeric(attempt.retryAt)) retryAt = Math.max(retryAt, attempt.retryAt)
    return retryAt > Date.now() ? retryAt : 0
  },

  sourceInputVersion(state, source) { return source === 'candles' ? state.priceVersion : source === 'oi' ? state.oiVersion : state.takerVersion },

  sourceBlocked(state, source, from, through) {
    const attempts = this.sourceAttempts.group(state.key, source)
    if (!attempts) return false
    const pending = this.pendingSourceRanges(state, source, from, through)
    const now = Date.now()
    for (const attempt of attempts.entries.values()) if (pending.some(range => attempt.from <= range.through && attempt.through >= range.from)
      && (numeric(attempt.retryAt) && attempt.retryAt > now
        || attempt.retryAt === undefined && (attempt.demands ? attempt.demands.some(demand => this.currentDemand(demand)) : this.currentFocus(attempt.focus))
          && attempt.sourceEpoch === this.sourceEpoch && attempt.inputVersion === this.sourceInputVersion(state, source))) return true
    return false
  },

  sourceRowsChanged(state, from, through = from, source) {
    const cache = state.pendingRangeCache
    if (!cache) return
    if (from === undefined) { cache.clear(); return }
    for (const [key, value] of cache) if ((!source || value.source === source)
      && value.from <= through && value.through >= from) cache.delete(key)
  },

  pendingSourceRanges(state, source, from, through) {
    const group = this.sourceTasks.group(state.key, source), version = group?.version ?? 0
    const key = `${source}:${from}:${through}`, now = Date.now()
    const cache = state.pendingRangeCache ??= new Map(), cached = cache.get(key)
    if (cached && cached.rows === state.rows && cached.group === group && cached.version === version
      && now >= cached.computedAt && now < cached.validUntil) return cached.ranges
    // Sort active coverage once per membership revision, independently of the
    // requested window. Resident mutations clear this bounded cache; expiring
    // unpublished statistics invalidate at their earliest relevant deadline.
    const jobs = group ? group.sorted ??= [...group.entries.values()].sort((left, right) => left.from - right.from) : []
    const ranges = []
    let index = 0, coveredThrough = -Infinity, validUntil = Infinity
    for (let hour = from; hour <= through; hour += state.intervalMS) {
      while (index < jobs.length && jobs[index].from <= hour) {
        const job = jobs[index++]
        if (job.through >= hour) coveredThrough = Math.max(coveredThrough, job.through)
      }
      const row = state.rows.get(hour)
      if (row && source !== 'candles') {
        const missing = source === 'oi' ? !numeric(row.oi) : !numeric(row.buy) || !numeric(row.sell)
        const expiry = Number(row[source === 'oi' ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'])
        if (missing && expiry > now) validUntil = Math.min(validUntil, expiry)
      }
      if ((source === 'candles' ? completePriceCandle(row) : sourceFresh(row, source === 'oi' ? 1 : 2))
        || coveredThrough >= hour) continue
      const previous = ranges.at(-1)
      if (previous?.through + state.intervalMS === hour) previous.through = hour
      else ranges.push({ from: hour, through: hour })
    }
    // Callers consume ranges as immutable plans; no caller may edit a cached
    // plan and thereby change another consumer's acquisition boundaries.
    for (const range of ranges) Object.freeze(range)
    Object.freeze(ranges)
    cache.delete(key); cache.set(key, { rows: state.rows, source, from, through, group, version, computedAt: now, validUntil, ranges })
    let spans = [...cache.values()].reduce((sum, entry) => sum + entry.ranges.length, 0)
    while (cache.size > 12 || spans > 256) {
      const oldest = cache.keys().next().value
      spans -= cache.get(oldest).ranges.length; cache.delete(oldest)
    }
    return ranges
  },

  // Each optional provider has its own bounded lane; a slow statistic cannot
  // consume the slots that make another candidate's prices/indicators ready.
  drainWarmSources() {
    this.warmSourceQueue = this.warmSourceQueue.filter(job => !job.controller.signal.aborted)
    if (!this.presentationActive) return
    for (const job of [...this.warmSourceQueue]) {
      const active = this.warmSourceActive.get(job.source) ?? 0
      if (job.priority === 'chartWarm' && active >= this.candidateLimit) continue
      this.warmSourceQueue.splice(this.warmSourceQueue.indexOf(job), 1)
      this.warmSourceActive.set(job.source, active + 1)
      job.admitted = true; job.admit()
    }
  },

  sourceJob(key, operation, { state, source, from, through, reserve, priority = 'interactive', demand = this.focusFor(state.key) }) {
    const existing = this.sourceTasks.get(key) ?? [...this.sourceTasks.group(state.key, source)?.entries.values() ?? []]
      .find(job => job.from <= from && job.through >= through)
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
        if (job.priority === 'chartWarm') await abortable(() => new Promise(resolve => {
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
  },

  scheduleRefresh() {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.closed || !this.presentationActive || !this.focus) { this.repairDeadlines.clear(); return }
    const now = Date.now(), deadlines = [], repairDeadlines = new Map()
    for (const focus of this.focuses.values()) {
      const state = this.series.get(focus.key)
      if (!state) continue
      const step = state.intervalMS, boundary = Math.floor(now / step) * step
      const end = focus.end ?? boundary - step, from = Math.max(0, end - (this.visibleBars(state.key) - 1) * step, state.floor ?? 0)
      let deadline = Math.min(boundary + step + 1000, liveStatisticsDeadline(state, now)), missingPrices = false
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
        statisticsRanges.push({ from: Math.max(0, state.latestHour - (this.visibleBars(state.key) - 1) * step, state.floor ?? 0), through: state.latestHour })
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
        const active = [...this.sourceTasks.group(state.key, 'candles')?.entries.values() ?? []]
          .some(job => job.from <= indicators.from && job.through >= indicators.through)
        if (!active) repair('candles', indicators.from, indicators.through)
      }
      if (this.cached(state.key)?.realtimeState === 'live' && state.observedAt !== null) deadline = Math.min(deadline, state.observedAt + 30_000)
      deadlines.push({ focus, state, deadline })
    }
    this.repairDeadlines = repairDeadlines
    if (!deadlines.length) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      for (const { focus, state, deadline } of deadlines) {
        if (!this.currentFocus(focus) || deadline > Date.now()) continue
        if (state.statisticsDeadline <= Date.now()) { state.freshnessVersion = (state.freshnessVersion ?? 0) + 1; state.statisticsDeadline = Infinity }
        this.publish(state) // Expired quote/empty-observation leases change status only.
        this.refreshObservations(state, focus.end, focus.windowBars ?? VISIBLE, focus.windowBars ?? VISIBLE, focus)
        this.prefetchStatistics(state, focus)
      }
      this.scheduleRefresh()
    }, Math.max(1, Math.min(...deadlines.map(entry => entry.deadline)) - now))
    this.refreshTimer.unref?.()
  },

  reconcileCanonical(state, rows) {
    let changedFrom = Infinity
    for (const current of new Set([state, this.series.get(state.key), this.liveStates.get(state.key)].filter(Boolean))) {
      let changed = false
      for (const row of rows) {
        const previous = current.rows.get(row.timestamp), value = this.normalize(row)
        if (!previous || samePrice(previous, value)) continue
        current.rows.set(row.timestamp, immutableRecord(mergeStatistics(previous, value)))
        this.sourceRowsChanged(current, row.timestamp)
        changedFrom = Math.min(changedFrom, row.timestamp); changed = true
      }
      if (changed) { current.priceVersion += 1; current.sourceVersion += 1 }
    }
    if (changedFrom === Infinity) return false
    this.invalidateDerived(state, changedFrom)
    this.publish(state)
    return true
  },

  async refreshChangedCanonical(state, version) {
    if (this.closed || state.priceVersion !== version) return
    // SQLite may have committed a correction before its observer message is
    // delivered. No calculated state can be certified by that later revision.
    state.priceVersion += 1; state.sourceVersion += 1
    this.invalidateDerived(state, -Infinity)
    await this.read(state, state.historyEnd ?? undefined, state.historyEnd == null ? this.tailBars(state.key) : this.historyReadBars(state.key))
    const live = this.liveStates.get(state.key)
    if (live?.rows.size) await this.read(live, undefined, this.tailBars(state.key))
    this.publish(state)
  },

  unchangedPrefix(state, before, after, end) {
    const first = /^sqlite:(\d+):(\d+)$/.exec(before), last = /^sqlite:(\d+):(\d+)$/.exec(after)
    if (!first || !last || first[1] !== last[1]) return false
    const from = Number(first[2]), through = Number(last[2])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || through <= from || through - from > 256) return false
    const changes = (this.priceJournal.get(state.key) ?? []).filter(change => change.revision > from && change.revision <= through)
    return changes.length === through - from && changes.every((change, index) => change.revision === from + index + 1 && change.from > end)
  },

  seed(state, priority = 'background', demand) {
    if (this.closed || !this.presentationActive || !state.rows.size && !this.liveStates.get(state.key)?.rows.size) return Promise.resolve()
    const epoch = this.presentationEpoch
    const focusOwned = this.currentFocus(demand)
    const owner = () => {
      if (this.closed || !this.presentationActive || this.presentationEpoch !== epoch) return null
      if (!demand) return { demand: undefined, priority }
      if (focusOwned) {
        return this.focusFor(state.key) ? { demand: this.focusFor(state.key), priority: 'foreground' } : null
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
      const viewport = resident.filter(hour => hour >= end - (this.visibleBars(state.key) - 1) * state.intervalMS && hour <= end)
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
        let checkpoint = await this.store.readIndicatorCheckpoint?.({ instrument: state.instId, timeframe: state.timeframe, before: first - state.intervalMS, formulaVersion: FORMULA_VERSION }, priority)
        if (!await currentBasis()) return
        if (!checkpoint) {
          checkpoint = await this.store.readIndicatorCheckpoint?.({ instrument: state.instId, timeframe: state.timeframe, before: first - state.intervalMS, formulaVersion: LEGACY_FORMULA_VERSION }, priority)
          if (!await currentBasis()) return
        }
        let calculated = checkpoint?.state ? { ...checkpoint.state } : null, cursor = checkpoint ? checkpoint.timestamp + state.intervalMS : 0, progressed = false
        if (calculated) delete calculated.volumes
        while (stillNeeded() && cursor <= end) {
          failedFrom = cursor
          const rows = await this.store.candles({ instrument: state.instId, timeframe: state.timeframe, from: cursor, through: end, limit: CHUNK, order: 'asc' }, priority)
          if (!stillNeeded()) return
          if (!rows.length) break
          failedFrom = rows[0].timestamp
          const result = await this.calculate(rows, state.intervalMS, this.focusFor(state.key) ? 'foreground' : priority, calculated)
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
            current.indicatorState = sharedIndicatorState(calculated); current.bollExpansion = calculated.bollExpansion
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
      if (!stillNeeded() || admittedInput !== inputVersion()) { restart = !this.closed; return }
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
  },

  observe(rows, previous) {
    for (const row of rows) assertCandleGrid(row.timestamp, intervalFor(row.timeframe))
    for (const [key, batch] of Map.groupBy(rows, row => seriesKey(row.instrument, row.timeframe))) {
      const state = this.series.get(key), live = this.liveStates.get(key)
      const consumers = [state, live].filter(Boolean)
      if (!consumers.length) continue
      const ordered = batch.length > 1 ? batch.toSorted((a, b) => a.timestamp - b.timestamp) : batch
      const confirmedAppends = new WeakMap()
      let changedFrom = Infinity
      for (const current of consumers) {
        for (const row of ordered) {
          const priorRow = previous.get(`${key}:${row.timestamp}`) ?? (() => {
            const candidate = previous.get(row.timestamp)
            return candidate && (candidate.instrument === undefined || candidate.instrument === row.instrument) && (candidate.timeframe === undefined || candidate.timeframe === row.timeframe) ? candidate : undefined
          })()
          const changed = !samePrice(priorRow, row)
          if (changed) {
            current.priceVersion += 1
            if (row.timestamp <= (current.latestHour ?? -Infinity) || current.indicatorState && row.timestamp <= current.indicatorState.lastTimestamp) changedFrom = Math.min(changedFrom, row.timestamp)
            else if (current.indicatorState && current.indicatorState.lastTimestamp + current.intervalMS === row.timestamp) {
              const previous = current.indicatorState
              let appended = confirmedAppends.get(previous)
              if (!appended || appended.row !== row) {
                appended = { ...appendConfirmed(previous, row), row }
                confirmedAppends.set(previous, appended)
              }
              const { state: successor, value } = appended
              current.indicatorState = successor
              current.bollExpansion = current.indicatorState.bollExpansion
              if (value) {
                current.indicators.set(value.hour, value)
                current.indicatorVersion = (current.indicatorVersion ?? 0) + 1
              }
            }
          }
          if (changedSource(priorRow, row, 1)) current.oiVersion = (current.oiVersion ?? 0) + 1
          if (changedSource(priorRow, row, 2)) current.takerVersion = (current.takerVersion ?? 0) + 1
          const prior = current.rows.get(row.timestamp), value = mergeStatistics(prior, this.normalize(row))
          if (!sameRecord(prior, value)) { current.rows.set(row.timestamp, immutableRecord(value)); current.sourceVersion += 1; this.sourceRowsChanged(current, row.timestamp) }
          current.latestHour = Math.max(current.latestHour ?? -Infinity, row.timestamp)
          if (current.live?.timestamp <= row.timestamp) current.live = null
        }
        const rowLimit = current === live ? this.tailBars(current.key) : this.focusFor(current.key) ? this.historyResidentBars(current.key) : HISTORY
        this.retainRows(current, rowLimit)
        this.updateMemory(current)
      }
      if (live && !live.live) live.liveProjection = null
      if (changedFrom < Infinity) this.invalidateDerived(state ?? live, changedFrom)
      if (state) {
        this.publish(state); this.seed(state, this.focusFor(key) ? 'foreground' : 'background')
        this.prefetchStatistics(state); this.scheduleRefresh()
      }
      else if (live && this.universe.has(key)) {
        this.publish(live)
        this.queueCandidate(this.universe.get(key))
      }
    }
  },

  async observeStatistics(instId, timeframe, from, through, priority, inputRows, source) {
    const key = seriesKey(instId, timeframe), state = this.series.get(key), live = this.liveStates.get(key)
    const admitted = [state, live].filter(Boolean).map(current => ({ current,
      rows: new Map([...current.rows].filter(([hour]) => hour >= from && hour <= through)) })).filter(value => value.rows.size)
    if (!admitted.length) return
    priority ??= this.demandPriority(state ?? live, from, through) === 'interactive' ? 'interactive' : 'background'
    const hours = admitted.flatMap(value => [...value.rows.keys()])
    // Acquisition already returns its committed projection. Both chart and live
    // residency reuse those same rows, or share one bounded SQLite read.
    const minHour = Math.min(...hours), maxHour = Math.max(...hours), intervalMS = intervalFor(timeframe)
    const span = Math.max(HISTORY, Math.floor((maxHour - minHour) / intervalMS) + 1)
    const rows = inputRows ?? await this.store.candles({ instrument: instId, timeframe, from: minHour, through: maxHour, limit: span, order: 'asc' }, priority)
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
        if (!sameRecord(previous, value)) { current.rows.set(row.timestamp, immutableRecord(value)); observationsChanged = true; this.sourceRowsChanged(current, row.timestamp, row.timestamp, source) }
      }
      if (observationsChanged) { current.sourceVersion += 1; changed = true; this.updateMemory(current) }
    }
    if (changed && state) this.publish(state)
    else if (changed && live && this.universe.has(key)) this.publish(live)
  },

  invalidate(instId, timeframe) {
    const key = seriesKey(instId, timeframe), state = this.series.get(key), live = this.liveStates.get(key)
    for (const entry of this.focusReads) if (entry.state.key === key) entry.obsolete = true
    const generation = ++this.nextGeneration
    for (const current of new Set([state, live].filter(Boolean))) {
      current.priceVersion += 1; current.generation = generation; current.indicatorState = null; current.indicators.clear(); current.loaded = false; current.historyRange = null; current.rows.clear(); current.latestHour = null
      this.sourceRowsChanged(current)
      current.indicatorFailures?.clear()
      current.barCaches?.clear(); current.projectedBars?.clear(); current.historyBarsCache = null; current.liveProjection = null
      current.publishedHistoryFrame = null
    }
    if (this.presentationActive) this.snapshots.delete(key)
    for (const focus of [...this.focuses.values()]) if (focus.key === key) {
      this.replaceFocus({ instId, timeframe, endHour: focus.end, windowBars: focus.windowBars }, focus.id, focus.slot)
    }
    const demand = this.universe.get(key)
    if (demand) this.queueCandidate(demand, true)
  },

  setLive(instId, timeframe, candle, context = {}) {
    try {
      const observedAt = typeof context === 'number' ? context : context.receivedAt ?? Date.now()
      if (this.closed) return Promise.resolve(null)
      if (!intervalFor(timeframe) || candle && (candle.confirmed || candle.instrument !== instId || candle.timeframe !== timeframe)) throw new Error('Invalid forming candle.')
      const live = this.liveState(instId, timeframe), state = this.series.get(live.key)
      if (candle && live.live && (candle.timestamp < live.live.timestamp || candle.timestamp === live.live.timestamp && candle.volume < live.live.volume))
        return this.livePublications.get(live.key)?.promise ?? Promise.resolve(this.cached(live.key))
      const sameCandle = candle == null ? live.live == null
        : live.live && Object.keys(candle).length === Object.keys(live.live).length
          && Object.keys(candle).every(key => Object.hasOwn(live.live, key) && Object.is(candle[key], live.live[key]))
      const unchanged = observedAt === live.observedAt && sameCandle
      if (unchanged && this.livePublications.has(live.key)) return this.livePublications.get(live.key).promise
      // With no pending projection, status/lease work may still be due even
      // for an identical raw fact. A new observation can renew the lease while
      // retaining the same owned price input and indicator projection.
      const admitted = sameCandle ? live.live : candle ? immutableRecord(candle) : null
      if (!admitted) live.liveProjection = null
      for (const current of [live, state].filter(Boolean)) { current.live = admitted; current.observedAt = observedAt }
      if (!this.presentationActive) return Promise.resolve(null)
      if (!state && !this.universe.has(live.key)) return Promise.resolve(null)
      // Collector-only residency cannot materialize a chart.
      const current = state ?? live
      if (!current.chartRequested && !this.focusFor(current.key) && !this.universe.has(current.key) && !this.snapshots.has(current.key)) return Promise.resolve(null)
      if (!this.focusFor(current.key)) return this.queueLivePublication(current.key)
      // Focused data remains visible immediately, including when selection has
      // promoted a quote that was already queued for this series.
      const pending = this.livePublications.has(current.key), frame = this.publish(current)
      if (!pending) { this.scheduleRefresh(); this.scheduleLiveExpiry(live) }
      return Promise.resolve(frame)
    } catch (error) { return Promise.reject(error) }
  },
}
