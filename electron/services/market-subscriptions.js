import { CHART_PRIMARY_TIMEFRAME } from './preferences.js'
import { eligibleInstrument } from './liquidity.js'
import { validTakerVolumes, STATISTICS_OI } from './statistics-state.js'
import { DeadlineIndex } from './deadline-index.js'
import {
  FIVE_MINUTES, CHART_TIMEFRAMES, LIQUIDITY_SOURCE_CRITERIA, TICKER_BOOTSTRAP_MS,
  CANDLE_DELIVERY_MS, LIST_REMOVAL_DELAY_MS, liquidityConfigKey, closedBoundary,
  abortable, number, timeframeMilliseconds, priceRecord,
} from './market-helpers.js'

export const marketSubscriptionMethods = {
  pendingCandleCommit(instrument, timeframe, timestamp) {
    const sourceStamp = timestamp + timeframeMilliseconds(timeframe) - FIVE_MINUTES
    const progress = this.realtime?.getProgress(instrument, '5m')
    return progress?.committing && progress.confirmedThrough >= sourceStamp && (progress.committedThrough ?? -Infinity) < sourceStamp
  },

  finishCandleWait(wait, persisted, error) {
    if (!wait || this.candleWaits.get(wait.key) !== wait) return
    this.candleWaits.delete(wait.key)
    if (error) wait.reject(error)
    else wait.resolve(persisted)
    this.scheduleMarketDeadline()
  },

  checkCandleWaits() {
    const now = Date.now()
    for (const wait of this.candleWaits.values()) {
      if (this.pendingCandleCommit(wait.instrument, wait.timeframe, wait.timestamp)) {
        // The delivery deadline cannot create a competing REST write while
        // an accepted confirmation is already committing locally.
        if (wait.deadline <= now) wait.deadline = Infinity
      } else if (!this.realtime?.isSubscribed(wait.instrument, '5m') || wait.deliveryDeadline <= now) this.finishCandleWait(wait, false)
    }
    this.scheduleMarketDeadline()
  },

  scheduleCandleWaitCheck() {
    if (this.closing || !this.candleWaits.size || this.candleWaitImmediate) return
    // Realtime releases a failed pending confirmation in its promise finally,
    // after publishing the error state. Check after that event's microtasks.
    this.candleWaitImmediate = setImmediate(() => { this.candleWaitImmediate = null; this.checkCandleWaits() })
    this.candleWaitImmediate.unref?.()
  },

  async awaitRealtimeCandle({ instrument, timeframe, from, through, signal, priority = 'continuity' }) {
    signal?.throwIfAborted()
    if (this.closing || from !== through || through !== closedBoundary(timeframe) - timeframeMilliseconds(timeframe)) return false
    const deadline = through + timeframeMilliseconds(timeframe) + CANDLE_DELIVERY_MS
    const sourceStamp = through + timeframeMilliseconds(timeframe) - FIVE_MINUTES
    const progress = this.realtime?.getProgress(instrument, '5m')
    const pending = this.pendingCandleCommit(instrument, timeframe, through)
    if (!pending && !(progress?.committedThrough >= sourceStamp) && (!this.realtime?.isSubscribed(instrument, '5m') || Date.now() >= deadline)) return false
    const key = `${instrument}:${timeframe}:${through}`
    let wait = this.candleWaits.get(key)
    if (!wait) {
      let resolve, reject
      const promise = new Promise((done, fail) => { resolve = done; reject = fail })
      wait = { key, instrument, timeframe, timestamp: through, deliveryDeadline: deadline, deadline: pending && Date.now() >= deadline ? Infinity : deadline, promise, resolve, reject, consumers: 0 }
      this.candleWaits.set(key, wait)
      // Register first, then inspect durable facts so a confirmation committing
      // between admission and this read cannot leave its consumer waiting.
      const registered = wait
      this.track(this.store.candles({ instrument, timeframe, from, through }, priority).then(rows => {
        const present = rows.some(row => row.timestamp === through && row.confirmed === true
          && Number.isFinite(row.baseVolume) && row.baseVolume >= 0 && Number.isFinite(row.quoteVolume) && row.quoteVolume >= 0)
        if (present) this.finishCandleWait(registered, true)
        else if (progress?.committedThrough >= sourceStamp) this.finishCandleWait(registered, false)
        else this.checkCandleWaits()
      }).catch(error => this.finishCandleWait(registered, false, error)))
      this.scheduleMarketDeadline()
    }
    wait.consumers += 1
    try { return await abortable(wait.promise, signal) }
    finally { if (--wait.consumers === 0) this.finishCandleWait(wait, false) }
  },

  enqueueCandleMutation(instrument, operation) {
    const previous = this.candleMutations.get(instrument) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    this.candleMutations.set(instrument, task)
    return task.finally(() => {
      if (this.candleMutations.get(instrument) === task) this.candleMutations.delete(instrument)
    })
  },

  async appendChangedCandlesLocked(candles, priority = 'background', canWrite) {
    if (!candles.length) return []
    const originals = new Map(candles.map(row => [row.timestamp, row]))
    const guard = canWrite && Object.assign(row => canWrite(originals.get(row.timestamp)), { lifetime: canWrite.lifetime })
    const result = await this.store.appendCandlesWithReceipt(candles.map(priceRecord), priority, { canWrite: guard })
    if (result.rows.length) this.preparedCharts.observe(result.rows, new Map(result.previous.map(row => [row.timestamp, row])))
    return result.rows
  },

  async persistCandles(instrument, candles, { priority = 'foreground', canWrite } = {}) {
    const confirmed = candles.filter(value => value.confirmed)
    await this.ready
    if (this.disposed || !confirmed.length) return false
    const result = await this.enqueueCandleMutation(instrument, async () => {
      if (this.disposed) return false
      const changed = []
      for (const rows of Map.groupBy(confirmed, row => row.timeframe).values()) {
        const eligible = canWrite ? rows.filter(canWrite) : rows
        if (eligible.length) changed.push(...await this.appendChangedCandlesLocked(eligible, priority, canWrite))
      }
      if (!changed.length) return false
      this.invalidateLiquidityHistory(instrument, changed)
      this.markChartDataChanged(instrument)
      for (const timeframe of new Set(changed.map(row => row.timeframe))) this.scheduleQualification(instrument, timeframe)
      const base = changed.filter(row => row.timeframe === '5m')
      if (base.length) {
        this.candleDerivations.correct(instrument, base)
        const first = Math.min(...base.map(row => row.timestamp)), last = Math.max(...base.map(row => row.timestamp))
        this.history?.sync?.invalidate({ instrument, timeframe: '5m', source: 'candles', from: first, through: last })
        for (const timeframe of ['15m', '1H']) {
          const step = timeframeMilliseconds(timeframe), from = Math.floor(first / step) * step
          const through = Math.min(Math.floor(last / step) * step, closedBoundary(timeframe) - step)
          if (from <= through) await this.materializePricesLocked({ instrument, timeframe, from, through, invalidateIncomplete: true }, priority)
        }
      }
      return true
    })
    // Writer recovery also belongs to an in-flight attempt that has rejected
    // but has not observed that rejection yet. Signal outside the mutation lock.
    if (result) this.realtime.retryPendingConfirmations()
    return result
  },

  materializePrices(range, priority = 'background') {
    return this.enqueueCandleMutation(range.instrument, () => this.materializePricesLocked(range, priority))
  },

  async materializePricesLocked(range, priority) {
    if (this.disposed || range.timeframe === '5m') return { changed: 0, complete: 0, invalidated: 0 }
    const { rows, previous, ...result } = await this.store.aggregateCandlesWithReceipt(range, priority)
    if (!result.changed) return result
    if (result.invalidated) this.preparedCharts.invalidate(range.instrument, range.timeframe)
    else this.preparedCharts.observe(rows, new Map(previous.map(row => [row.timestamp, row])))
    this.invalidateLiquidityHistory(range.instrument, result.invalidated ? null : rows, range.timeframe)
    this.markChartDataChanged(range.instrument)
    this.scheduleQualification(range.instrument, range.timeframe)
    this.history.sync.invalidate({ ...range, source: 'candles' })
    return result
  },

  async confirmPriceCandle(row, context = {}) {
    const generation = context.sourceEpoch ?? this.instrumentGenerations.get(row.instrument) ?? 0
    const current = () => generation === (this.instrumentGenerations.get(row.instrument) ?? 0) && !this.instrumentRetirements.has(row.instrument)
    if (!current()) return
    this.track(this.candleDerivations.observe(row, { receivedAt: Date.now() }))
    try { await this.persistCandles(row.instrument, [row], { canWrite: this.history.lifetimeGuard(row.instrument, current) }) }
    catch (error) { if (current()) throw error; return }
    finally { this.scheduleCandleWaitCheck() }
    if (!current()) return
    for (const timeframe of CHART_TIMEFRAMES) {
      const step = timeframeMilliseconds(timeframe), end = row.timestamp + FIVE_MINUTES
      if (end % step) continue
      const stamp = end - step
      const confirmed = timeframe === '5m' ? row : (await this.store.candles({ instrument: row.instrument, timeframe, from: stamp, through: stamp }, 'continuity'))[0]
      if (!current()) return
      this.finishCandleWait(this.candleWaits.get(`${row.instrument}:${timeframe}:${stamp}`), Boolean(confirmed))
      if (confirmed && this.statisticsDemand(row.instrument)) this.track(this.confirmStatistics(confirmed))
      const live = this.liveCandles.get(`${row.instrument}:${timeframe}`)
      if (!live || live.timestamp <= stamp) this.track(Promise.resolve(this.setLive(row.instrument, timeframe, null)))
    }
  },

  confirmStatistics(row) {
    const key = `${row.instrument}:${row.timeframe}:${row.timestamp}`
    const previous = this.statisticsTasks.get(key)
    if (previous) { previous.row = row; previous.version++; return previous.task }
    const entry = { row, version: 0, task: null }
    entry.task = Promise.resolve().then(async () => {
      try {
        do {
          const version = entry.version, current = entry.row
          try {
            const calculate = () => this.liveStatistics.enrich({ ...current, buy: null, sell: null, oi: null })
            let calculated = calculate()
            if (!validTakerVolumes(calculated) && this.publicRealtime.started && this.liveStatistics.canFinalize(current)
              && this.publicRealtime.subscriptions.has(`trades:${row.instrument}`)) {
              // The final trade and candle can arrive on different sockets.
              await new Promise(resolve => setTimeout(resolve, 250))
              calculated = calculate()
            }
            if (this.closing || !this.statisticsDemand(row.instrument)) return
            if (validTakerVolumes(calculated)) {
              const changed = await this.store.appendStatistics({ instrument: current.instrument, timeframe: current.timeframe,
                source: 'taker', from: current.timestamp, through: current.timestamp,
                values: [[current.timestamp, calculated.sell, calculated.buy]], priceVolume: current.volume,
                observedAt: Date.now(), preserveExistingSource: true }, 'continuity')
              if (changed) {
                this.markChartDataChanged(current.instrument)
                await this.preparedCharts.observeStatistics(current.instrument, current.timeframe, current.timestamp, current.timestamp, 'continuity', undefined, 'taker')
              }
            }
            // OI remains an independently observed stock quantity.
            if (this.statisticsAcquisitionDemand(current.instrument, current.timeframe)) {
              await this.history.ensureStatisticsCoverage(current.instrument, current.timeframe, current.timestamp, current.timestamp, 'continuity', this.shutdownController.signal)
            }
          } catch (error) {
            if (entry.version === version) throw error
          }
          if (entry.version === version) return
        } while (!this.closing)
      } finally {
        if (this.statisticsTasks.get(key) === entry) this.statisticsTasks.delete(key)
      }
    })
    this.statisticsTasks.set(key, entry)
    return entry.task
  },

  async replaceCandles(range, candles, priority = 'foreground', { canWrite } = {}) {
    await this.ready
    return this.enqueueCandleMutation(range.instrument, async () => {
      if (this.disposed) throw new Error('Market service is closed.')
      if (canWrite && !candles.every(canWrite)) throw Object.assign(new Error('Price history changed during repair; retrying the source observation.'), { code: 'HISTORY_SOURCE_CHANGED' })
      // Statistics belong to their own sources. Replacing prices must never
      // replay an earlier read over a newer independent statistic commit.
      const originals = new Map(candles.map(row => [row.timestamp, row]))
      const guard = canWrite && Object.assign(row => canWrite(originals.get(row.timestamp)), { lifetime: canWrite.lifetime })
      await this.store.replaceCandles(range, candles.map(priceRecord), priority, { canWrite: guard })
      this.onHistoryReplaced(range.instrument, range.timeframe)
      if (range.timeframe === '5m') this.candleDerivations.correct(range.instrument, candles, range)
      if (range.timeframe === '5m') for (const timeframe of ['15m', '1H']) {
        const step = timeframeMilliseconds(timeframe), from = Math.floor(range.from / step) * step
        const through = Math.min(Math.floor(range.through / step) * step, closedBoundary(timeframe) - step)
        if (from <= through) await this.materializePricesLocked({ instrument: range.instrument, timeframe, from, through, invalidateIncomplete: true }, priority)
      }
    })
  },

  markChartDataChanged(instrument) {
    const instId = typeof instrument === 'string' ? instrument : instrument?.instId
    if (instId) this.dataRevisions.set(instId, this.dataRevision(instId) + 1)
  },

  dataRevision(instId) { return this.dataRevisions.get(instId) ?? 0 },

  statisticsPageRange(timeframe, end) {
    const intervalMS = timeframeMilliseconds(timeframe)
    return { from: end - 99 * intervalMS, through: end, intervalMS }
  },

  async persistStatisticsSource(instrument, timeframe, end, source, values, signal, priority = 'statistics', preserveExistingSource = false, { range } = {}) {
    await this.ready
    if (this.disposed || signal?.aborted) return false
    const page = range ?? this.statisticsPageRange(timeframe, end)
    const changed = await this.store.appendStatistics({ instrument: instrument.instId, timeframe,
      source: source === STATISTICS_OI ? 'oi' : 'taker', from: page.from, through: page.through,
      values: values.map(value => value.map(number)), observedAt: Date.now(), preserveExistingSource }, priority)
    if (changed) this.markChartDataChanged(instrument.instId)
    return changed > 0
  },

  ensureListHourPrefix(instId) {
    if (this.closing || this.disposed || !this.listedUniverse.has(instId)) return
    const base = this.liveCandleSources.get(`${instId}:5m`), hour = closedBoundary('1H')
    if (!base || base.timestamp !== closedBoundary('5m') || !this.realtime?.isSubscribed(instId, '5m')
      || this.liveCandles.get(`${instId}:1H`)?.timestamp === hour) return
    if (this.listPrefixAttempts.get(instId) === base.timestamp) return
    this.listPrefixAttempts.set(instId, base.timestamp)
    this.track(this.latestChartPrice(instId, '1H', 'background').catch(() => {}))
  },

  scheduleListQuoteExpiry() {
    if (this.listQuoteTimer || this.closing || this.disposed) return
    const now = Date.now()
    let next = Infinity
    for (const instId of this.listedUniverse) {
      for (const timeframe of CHART_TIMEFRAMES) {
        const observedAt = this.liveReceivedAt.get(`${instId}:${timeframe}`)
        if (observedAt != null && observedAt + 30_000 > now) next = Math.min(next, observedAt + 30_000)
      }
    }
    if (!Number.isFinite(next)) return
    this.listQuoteTimer = setTimeout(() => {
      this.listQuoteTimer = null
      this.touchList()
      this.scheduleListQuoteExpiry()
    }, Math.max(1, next - now))
    this.listQuoteTimer.unref?.()
  },

  setLive(instId, timeframe, row, { receivedAt } = {}) {
    if (this.disposed) return
    const key = `${instId}:${timeframe}`, current = this.liveCandles.get(key), previousReceivedAt = this.liveReceivedAt.get(key)
    // REST initialization can resolve after a newer stream event. Same-volume
    // price corrections remain valid; older timestamps/cumulative volume do not.
    if (row && current && (row.timestamp < current.timestamp || row.timestamp === current.timestamp && row.volume < current.volume)) return Promise.resolve(null)
    // A source revision also fences equal-volume price corrections and clears.
    // Re-enriching this exact source with live statistics is not a new price.
    if (!row || this.liveCandleSources.get(key) !== row) this.liveSourceRevisions.set(key, (this.liveSourceRevisions.get(key) ?? 0) + 1)
    if (row) {
      this.liveReceivedAt.set(key, receivedAt ?? this.liveReceivedAt.get(key) ?? Date.now())
      this.liveCandleSources.set(key, row)
      row = this.liveStatistics.enrich(row)
      this.liveCandles.set(key, row)
    } else {
      this.liveCandleSources.delete(key)
      this.liveCandles.delete(key)
    }
    if (CHART_TIMEFRAMES.includes(timeframe) && this.listedUniverse.has(instId)) {
      if (!current || !row || current.timestamp !== row.timestamp || current.open !== row.open || current.close !== row.close
        || previousReceivedAt == null || Date.now() - previousReceivedAt >= 30_000) this.touchList()
      this.scheduleListQuoteExpiry()
    }
    // Collection covers the exchange universe. Only visible/cached charts need
    // indicator projections; an undisplayed contract must not seed a chart on every tick.
    const chartKey = `${instId}:${timeframe}`
    if (!this.preparedCharts.realtimeKeys.has(chartKey) && !this.preparedCharts.series.has(chartKey) && !this.preparedCharts.snapshots.has(chartKey)) return
    return this.preparedCharts.setLive(instId, timeframe, row, { receivedAt: this.liveReceivedAt.get(key) })
  },

  scheduleLiveStatistics(instId) {
    if (this.closing || this.disposed) return
    this.liveStatisticsQueue.add(instId)
    if (this.liveStatisticsTimer) return
    this.liveStatisticsTimer = setTimeout(() => {
      this.liveStatisticsTimer = null
      const ids = [...this.liveStatisticsQueue]; this.liveStatisticsQueue.clear()
      for (const id of ids) for (const timeframe of CHART_TIMEFRAMES) {
        const row = this.liveCandleSources.get(`${id}:${timeframe}`)
        if (row) this.track(this.setLive(id, timeframe, row))
      }
    }, 100)
    this.liveStatisticsTimer.unref?.()
  },

  onHistoryProgress(task) {
    if (this.disposed) return
    this.historyDownload?.observe(task)
  },

  onHistoryReplaced(instId, timeframe) {
    this.invalidateLiquidityHistory(instId, null, timeframe)
    this.markChartDataChanged(instId)
    this.preparedCharts.invalidate(instId, timeframe)
    this.scheduleQualification(instId, timeframe)
  },

  updateSubscriptions() {
    if (!this.realtime) return
    this.subscriptionDirty.clear()
    const subscriptions = new Map()
    const ids = this.candidateIDs ?? new Set([...this.instruments.values()].filter(eligibleInstrument).map(value => value.instId))
    // Every contract remains live. Larger periods share the same five-minute
    // source and its bounded local prefixes, not another wire subscription.
    for (const instId of ids) subscriptions.set(`${instId}:5m`, { instId, timeframe: '5m' })
    const collectorChanged = this.realtime.subscriptions.size !== subscriptions.size
      || [...subscriptions.values()].some(({ instId, timeframe }) => !this.realtime.subscriptions.has(`${timeframe}:${instId}`))
    const derivedSubscriptions = [...ids].flatMap(instId => CHART_TIMEFRAMES.map(timeframe => ({ instId, timeframe })))
    if (this.preparedCharts.realtimeKeys.size !== derivedSubscriptions.length || derivedSubscriptions.some(value => !this.preparedCharts.realtimeKeys.has(`${value.instId}:${value.timeframe}`))) {
      this.preparedCharts.setRealtimeSubscriptions(derivedSubscriptions)
    }
    if (collectorChanged) this.realtime.setSubscriptions([...subscriptions.values()])
    const config = this.prefs().liquidity, configKey = liquidityConfigKey(config), now = Date.now()
    const books = new Set(), trades = new Set(), openInterest = new Set(), proofDeadlines = []
    const prerequisites = Object.entries(LIQUIDITY_SOURCE_CRITERIA).filter(([source]) => source !== 'book')
      .flatMap(([source, criteria]) => criteria.filter(key => config[key].enabled).map(key => ({ key, source })))
    for (const instId of ids) {
      const record = this.catalogChecks.get(instId)
      const evidence = { deadline: Infinity }
      // Reuse the already calculated cheap assessments. A failed book must
      // remain observed so it can recover; only independent prerequisites gate it.
      const possible = prerequisites.every(({ key, source }) => record?.configKey === configKey
        && record.result.checks?.some(check => check.key === key && check.status === 'verified')
        && this.qualificationObservation(record.observations ?? {}, source, instId, configKey, now, evidence))
      const priorSample = this.bookSamples.get(instId)
      const liveBookRecovered = priorSample && this.publicRealtime?.subscriptions.has(`books:${instId}`)
        && ['depth', 'slippage'].every(key => !config[key].enabled || record?.result?.checks?.some(check => check.key === key && check.status === 'verified'))
      if (priorSample && (priorSample.configKey !== configKey || !possible || this.statisticsDemand(instId) || liveBookRecovered)) {
        this.bookSamples.delete(instId)
        this.sourceError?.(`${instId}:book`, null)
      }
      const interval = this.autoRefresh && possible && !this.statisticsDemand(instId) && !this.bookSamples.has(instId) ? this.bookSampleInterval(record, config) : null
      if (interval !== null) this.bookSamples.set(instId, { configKey, next: now + interval, pending: false })
      const sampling = this.bookSamples.has(instId)
      if (config.depth.enabled || config.slippage.enabled) {
        if (possible && !sampling) { books.add(instId); this.bookRetirements.delete(instId); if (Number.isSafeInteger(evidence.deadline)) proofDeadlines.push([instId, evidence.deadline]) }
        else if (this.publicSubscriptionDemand?.books.has(instId)) {
          const retireAt = this.bookRetirements.get(instId) ?? now + LIST_REMOVAL_DELAY_MS
          if (retireAt > now) { books.add(instId); this.bookRetirements.set(instId, retireAt); if (Number.isSafeInteger(retireAt) && retireAt >= 0) proofDeadlines.push([instId, retireAt]) }
          else this.bookRetirements.delete(instId)
        }
      } else this.bookRetirements.delete(instId)
      if (this.statisticsDemand(instId)) trades.add(instId)
      if (config.openInterest.enabled || this.statisticsDemand(instId)) openInterest.add(instId)
    }
    for (const id of this.bookSamples.keys()) if (!ids.has(id) || !(config.depth.enabled || config.slippage.enabled)) {
      this.bookSamples.delete(id)
      this.sourceError?.(`${id}:book`, null)
    }
    this.scheduleBookSamples()
    this.subscriptionDeadlines = new DeadlineIndex(proofDeadlines)
    const previous = this.publicSubscriptionDemand
    const same = (left, right) => left && left.size === right.size && [...right].every(id => left.has(id))
    if (this.publicRealtime && (!previous || !same(previous.books, books) || !same(previous.trades, trades) || !same(previous.openInterest, openInterest)
      || this.publicRealtime.instruments.size !== ids.size || [...ids].some(id => !this.publicRealtime.instruments.has(id)))) {
      for (const instId of books) if (!previous?.books.has(instId)) this.nativeBookDeadlines.set(instId, now + TICKER_BOOTSTRAP_MS)
      this.publicRealtime.setSubscriptions([...ids], { books, trades, openInterest })
      this.publicSubscriptionDemand = { books, trades, openInterest }
    }
    if (collectorChanged && !this.closing) this.preparedCharts.sourceStateChanged()
    this.scheduleMarketDeadline()
    this.subscriptionState = this.subscriptionSignature(now, configKey)
  },

  subscriptionSignature(now, configKey) {
    const connection = this.realtime?.connection
    return { now, configKey, boundary: closedBoundary('5m', now), ids: this.candidateIDs, idCount: this.candidateIDs?.size,
      checks: this.catalogChecks, checkCount: this.catalogChecks.size, universe: this.listedUniverse, focus: this.preparedCharts.focus,
      realtime: this.realtime, connection, connectionOpened: connection?.opened, connectionRetired: connection?.retired,
      socketState: connection?.socket?.readyState, realtimeSubscriptions: this.realtime?.subscriptions,
      realtimeCount: this.realtime?.subscriptions.size, realtimeKeys: this.preparedCharts.realtimeKeys,
      publicRealtime: this.publicRealtime, publicInstruments: this.publicRealtime?.instruments, publicSubscriptions: this.publicRealtime?.subscriptions,
      demand: this.publicSubscriptionDemand, assessments: this.historicalAssessments }
  },

  updateDirtySubscriptions() {
    const now = Date.now(), config = this.prefs().liquidity, configKey = liquidityConfigKey(config), state = this.subscriptionState
    if ([...this.subscriptionDirty].some(id => this.bookSamples.has(id) || this.bookSampleInterval(this.catalogChecks.get(id), config) !== null)) return this.updateSubscriptions()
    const current = this.subscriptionSignature(now, configKey)
    if (!state || !this.candidateIDs || !this.publicSubscriptionDemand || !this.publicRealtime
      || !this.marketDeadlineTimer || this.marketDeadlineAt === null || this.marketDeadlineAt <= now || now < state.now
      || (this.subscriptionDeadlines.peek()?.deadline ?? Infinity) <= now
      || Object.keys(current).some(key => key !== 'now' && current[key] !== state[key])) return this.updateSubscriptions()
    const prerequisites = Object.entries(LIQUIDITY_SOURCE_CRITERIA).filter(([source]) => source !== 'book')
      .flatMap(([source, criteria]) => criteria.filter(key => config[key].enabled).map(key => ({ key, source })))
    const retire = [], restore = [], proofDeadlines = []
    for (const instId of this.subscriptionDirty) {
      if (!this.candidateIDs.has(instId)) return this.updateSubscriptions()
      const record = this.catalogChecks.get(instId), previousBook = this.publicSubscriptionDemand.books.has(instId)
      const evidence = { deadline: Infinity }
      const possible = prerequisites.every(({ key, source }) => record?.configKey === configKey
        && record.result.checks?.some(check => check.key === key && check.status === 'verified')
        && this.qualificationObservation(record.observations ?? {}, source, instId, configKey, now, evidence))
      const retirement = this.bookRetirements.get(instId)
      let book = false
      if (config.depth.enabled || config.slippage.enabled) {
        if (possible) { book = true; if (retirement !== undefined) restore.push(instId) }
        else if (previousBook) {
          const deadline = retirement ?? now + LIST_REMOVAL_DELAY_MS
          if (deadline > now) { book = true; evidence.deadline = deadline; if (retirement === undefined) retire.push([instId, deadline]) }
          else restore.push(instId)
        }
      } else if (retirement !== undefined) restore.push(instId)
      const statistics = this.statisticsDemand(instId)
      if (book !== previousBook || statistics !== this.publicSubscriptionDemand.trades.has(instId)
        || (config.openInterest.enabled || statistics) !== this.publicSubscriptionDemand.openInterest.has(instId)) return this.updateSubscriptions()
      proofDeadlines.push([instId, book && Number.isSafeInteger(evidence.deadline) && evidence.deadline >= 0 ? evidence.deadline : undefined])
    }
    this.subscriptionDirty.clear()
    for (const id of restore) this.bookRetirements.delete(id)
    for (const [id, deadline] of retire) this.bookRetirements.set(id, deadline)
    for (const [id, deadline] of proofDeadlines) {
      if (deadline === undefined) this.subscriptionDeadlines.delete(id)
      else this.subscriptionDeadlines.set(id, deadline)
    }
    this.subscriptionState = current
    if (retire.length || restore.length) this.scheduleMarketDeadline()
  },

  scheduleSubscriptions(instIds) {
    if (this.closing || this.disposed) return
    if (instIds) for (const id of instIds) this.subscriptionDirty.add(id)
    else this.subscriptionFullPending = true
    if (this.subscriptionImmediate) return
    this.subscriptionImmediate = setImmediate(() => {
      this.subscriptionImmediate = null
      const full = this.subscriptionFullPending; this.subscriptionFullPending = false
      if (full) this.updateSubscriptions(); else this.updateDirtySubscriptions()
    })
    this.subscriptionImmediate.unref?.()
  },

  statisticsDemand(instId) {
    return this.listedUniverse.has(instId) || this.preparedCharts.focus?.instId === instId
  },

  statisticsAcquisitionDemand(instId, timeframe) {
    return this.listedUniverse.has(instId) && timeframe === CHART_PRIMARY_TIMEFRAME
      || Boolean(this.preparedCharts.focusFor(`${instId}:${timeframe}`))
  },

  priceStreaming(instId, timeframe) {
    return Boolean(this.realtime?.isSubscribed(instId, '5m')
      && (timeframe === '5m' || this.derivedLivePrices.has(this.liveCandleSources.get(`${instId}:${timeframe}`))))
  },

  latestChartPrice(instId, timeframe, priority = 'foreground', signal) {
    if (this.closing || this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const base = this.liveCandleSources.get(`${instId}:5m`), step = timeframeMilliseconds(timeframe)
    const from = base && Math.floor(base.timestamp / step) * step
    const listedAt = number(this.instruments.get(instId)?.listTime)
    if (timeframe === '5m' || !this.realtime.isSubscribed(instId, '5m')
      || !base || base.timestamp !== closedBoundary('5m') || listedAt !== null && listedAt > from) {
      return this.history.latest(instId, timeframe, priority)
    }
    const key = `${instId}:${timeframe}`
    if (this.livePrefixTasks.has(key)) return abortable(this.livePrefixTasks.get(key), signal)
    const generation = this.instrumentGenerations.get(instId) ?? 0
    const task = Promise.resolve().then(async () => {
      // A demanded coarse live candle needs at most eleven closed fine bars.
      // Reuse durable coverage before acquiring only that missing prefix.
      const through = base.timestamp - FIVE_MINUTES
      const rows = from <= through
        ? (await this.history.ensurePrices(instId, '5m', from, through, priority, this.shutdownController.signal)).rows : []
      if (this.closing || (this.instrumentGenerations.get(instId) ?? 0) !== generation) return {}
      const current = this.liveCandleSources.get(`${instId}:5m`)
      if (current) {
        this.track(this.candleDerivations.observe(current, { receivedAt: this.liveReceivedAt.get(`${instId}:5m`) }))
        this.candleDerivations.correct(instId, rows)
      }
      return {}
    }).finally(() => { if (this.livePrefixTasks.get(key) === task) this.livePrefixTasks.delete(key) })
    this.livePrefixTasks.set(key, task)
    return abortable(task, signal)
  },

  async reconcileRealtime(subscriptions, { signal } = {}) {
    await this.ready
    // HistorySync bounds source concurrency and request lanes enforce rates.
    // Admit every independent series before waiting for network recovery.
    const results = await Promise.allSettled(subscriptions.map(async ({ instId, timeframe }) => {
      if (this.closing || signal?.aborted) return
      const step = timeframeMilliseconds(timeframe), through = closedBoundary(timeframe) - step
      const coverage = await this.store.coverage(instId, timeframe, 'background')
      const from = Math.max(0, coverage.last === null ? through - step : Math.min(through, coverage.last + step))
      await this.history.ensurePriceCoverage(instId, timeframe, from, through, 'continuity', signal)
      // Prepared charts own bounded statistics demand for their visible ranges.
      // A collector reconnect must not download statistics for its whole gap.
    }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  },

  prepareChartWindow(instId, timeframe, end, historyBars = 96) {
    if (this.closing || this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.ready.then(() => this.preparedCharts.prepare(instId, timeframe, end, historyBars))
    this.barTasks.add(task)
    return task.finally(() => this.barTasks.delete(task))
  },

  subscribePreparedCharts(listener) { return this.preparedCharts.subscribe(listener) },
}
