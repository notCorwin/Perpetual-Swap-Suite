import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PreparedChartPipeline } from './prepared-chart-service.js'
import { MetadataStore, DEFAULT_PREFERENCES, validatePreferences } from './metadata-store.js'
import { CHART_PRIMARY_TIMEFRAME } from './preferences.js'
import { MarketHistory } from './market-history.js'
import { HistoryDownload } from './history-download.js'
import { createLiquidityEvaluator } from './liquidity.js'
import { RealtimeMarket } from './realtime-market.js'
import { RealtimePublicMarket } from './realtime-public-market.js'
import { LiveStatistics } from './live-statistics.js'
import { MarketOpenInterest } from './market-open-interest.js'
import { MarketBook } from './market-book.js'
import { CandleDerivations } from './candle-derivations.js'
import { DeadlineIndex } from './deadline-index.js'
import {
  CHART_TIMEFRAMES, liquidityConfigKeys, liquidityConfigKey,
  TICKER_BOOTSTRAP_MS, REQUEST_TIMEOUT, closedBoundary, emptyAudit,
  timeframeMilliseconds, normalizedStatistics, candle,
} from './market-helpers.js'
import { createRequestLanes, okxHttpMethods } from './okx-http-client.js'
import { marketCatalogMethods } from './market-catalog.js'
import { marketSubscriptionMethods } from './market-subscriptions.js'
import { marketDeadlineMethods } from './market-deadlines.js'
import { marketQualificationMethods } from './market-qualification.js'

/** Owns market observations and projections; HistorySync owns every historical source task. */
export class MarketService {
  constructor(store, preferences = () => DEFAULT_PREFERENCES, fetcher = fetch, autoRefresh = true, { metadata, requestTimeout = REQUEST_TIMEOUT, webSocketFactory, onStatusChange, onConnectionDiagnostic } = {}) {
    this.onStatusChange = onStatusChange
    this.onConnectionDiagnostic = onConnectionDiagnostic
    if (typeof preferences !== 'function') throw new TypeError('A full Preferences callback is required.')
    this.store = store
    this.preferences = preferences
    validatePreferences(preferences())
    this.fetcher = fetcher
    this.autoRefresh = autoRefresh
    this.metadata = metadata
    this.ownsMetadata = !metadata
    this.webSocketFactory = webSocketFactory
    this.requestTimeout = Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : REQUEST_TIMEOUT
    this.catalog = new Map()
    // Eligibility expires immediately. Only the published list has an exit delay;
    // these process-local entries never renew or persist qualification evidence.
    this.listRemovals = new Map()
    this.listedUniverse = new Set()
    this.catalogPublications = new Map()
    this.catalogPublicationTask = null
    this.catalogChecks = new Map()
    this.renewalTargets = new Map()
    this.candidateTasks = new Map()
    this.candidateAcquisitions = new Map()
    this.pendingCandidates = new Map()
    this.refreshAdmission = null
    this.catalogControllers = new Set()
    this.qualificationReads = new Set()
    this.qualificationReadQueue = []
    this.historicalSourceReads = new Map()
    this.historicalWindows = new Map()
    this.historicalInputs = new WeakMap()
    this.historicalAssessments = new WeakMap()
    this.historicalValidations = new WeakSet()
    this.candidateIDs = null
    this.tickerCache = null
    this.tickerTask = null
    this.tickerSubscriptions = new Map()
    this.tickerNativeObservations = new WeakMap()
    this.tickerRecoveries = new Map()
    this.tickerFaults = new Map()
    this.sourceErrors = new Map()
    this.handledSourceErrors = new WeakSet()
    this.errorOwner = null
    this.openInterest = new MarketOpenInterest((...args) => this.get(...args))
    this.books = new MarketBook((...args) => this.get(...args))
    this.bookGenerations = new Map()
    this.nativeBookDeadlines = new Map()
    this.bookRetirements = new Map()
    this.bookSamples = new Map()
    this.bookSampleTimer = null
    this.qualificationQueue = new Set()
    this.qualificationImmediate = null
    this.marketDeadlineTimer = null
    this.marketDeadlineAt = null
    this.marketDeadlines = new Map()
    this.marketDeadlineIndex = new DeadlineIndex()
    this.marketRemovalIndex = new DeadlineIndex()
    this.marketDeadlineState = null
    this.marketDeadlineDirty = new Map()
    this.marketDeadlineRevision = 0
    this.marketBoundary = closedBoundary('5m')
    this.processingMarketDeadline = false
    this.renewing = null
    this.instruments = new Map()
    this.instrumentGenerations = new Map()
    this.instrumentRetirements = new Map()
    this.instrumentDefinitions = new Map()
    this.instrumentSnapshotReady = false
    this.instrumentSnapshotObservedAt = 0
    this.instrumentSubscriptionWaiters = new Set()
    this.instrumentDeltas = new Map()
    this.instrumentEventVersion = 0
    this.instrumentStream = null
    this.instrumentRetryTimer = null
    this.instrumentObservations = new Map()
    this.instrumentTask = null
    this.observations = new Map()
    this.liquidityHistoryRevisions = new Map()
    this.evaluateLiquidity = createLiquidityEvaluator()
    this.listUpdatedAt = null
    this.canonicalList = null
    this.canonicalOrdering = null
    this.dataRevisions = new Map()
    this.publicSubscriptionDemand = null
    this.subscriptionImmediate = null
    this.subscriptionDirty = new Set()
    this.subscriptionFullPending = false
    this.subscriptionState = null
    this.subscriptionDeadlines = new DeadlineIndex()
    this.statisticsTasks = new Map()
    this.liveCandles = new Map()
    this.listPrefixAttempts = new Map()
    this.listQuoteTimer = null
    this.liveCandleSources = new Map()
    this.derivedLivePrices = new WeakSet()
    this.livePrefixTasks = new Map()
    this.liveReceivedAt = new Map()
    this.liveSourceRevisions = new Map()
    this.sourceRecoveries = new Map()
    this.liveStatistics = new LiveStatistics()
    this.streamQualifications = new Set()
    this.streamQualificationTimer = null
    this.streamEvaluations = new Map()
    this.streamLiquidity = null
    this.liveStatisticsQueue = new Set()
    this.liveStatisticsTimer = null
    this.candleWaits = new Map()
    this.candleWaitImmediate = null
    this.candleMutations = new Map()
    this.barTasks = new Set()
    this.backgroundTasks = new Set()
    this.backgroundTaskSources = new WeakMap()
    this.requestLanes = createRequestLanes()
    this.activeRequests = new Set()
    this.abortControllers = new Set()
    this.shutdownController = new AbortController()
    this.revision = 0
    this.presentationActive = true
    this.marketListeners = new Set()
    this.marketPublicationTimer = null
    this.serviceSession = randomUUID()
    this.auditListeners = new Set()
    this.auditRevision = 0
    this.downloadListeners = new Set()
    this.downloadRevision = 0
    this.auditReport = { ...emptyAudit(), revision: 0, serviceSession: this.serviceSession }
    this.catalogRevision = 0
    this.catalogSource = 'none'
    this.catalogUpdatedAt = null
    this.refreshing = null
    this.lastRefreshAt = 0
    this.refreshStartedAt = 0
    this.error = ''
    this.closing = false
    this.disposed = false
    this.disposeTask = null
    this.latestAuditID = null
    // The proxy admits no historical work until durable metadata has opened.
    const history = Object.fromEntries(['ensurePrices', 'ensureStatistics', 'latest', 'promoteSource'].map(method => [method, async (...args) => {
      await this.ready
      const result = await (method === 'latest' ? this.latestChartPrice(...args) : this.history[method](...args))
      if (method === 'promoteSource') this.wakeRequestQueues()
      return result
    }]))
    this.preparedCharts = new PreparedChartPipeline({ store, history, normalize: normalizedStatistics, revision: instId => this.dataRevision(instId), instrument: instId => this.instruments.get(instId),
      streaming: (instId, timeframe) => this.priceStreaming(instId, timeframe),
      acquire: (_instId, timeframe) => timeframe === CHART_PRIMARY_TIMEFRAME,
      onFocus: () => this.scheduleSubscriptions() })
    this.candleDerivations = new CandleDerivations({ store,
      onLive: (instId, timeframe, row, context) => {
        if (row) this.derivedLivePrices.add(row)
        return this.track(this.setLive(instId, timeframe, row, context))
      } })
    this.ready = this.initialize()
  }

  prefs() {
    const preferences = validatePreferences(this.preferences())
    const config = preferences.liquidity
    if (!liquidityConfigKeys.has(config)) liquidityConfigKeys.set(config, JSON.stringify(config))
    return preferences
  }

  catalogCriteriaKey() { return liquidityConfigKey(this.prefs().liquidity) }
  catalogEntry(instId) { return this.catalog.get(instId) }

  touchList() {
    this.canonicalList = null
    this.revision += 1
    this.onStatusChange?.()
    if (!this.presentationActive || !this.marketListeners.size || this.marketPublicationTimer || this.closing) return
    // Coalesce a batch of market changes into one renderer wakeup.
    this.marketPublicationTimer = setTimeout(() => {
      this.marketPublicationTimer = null
      for (const listener of this.marketListeners) { try { listener() } catch { /* A disconnected renderer cannot stop collection. */ } }
    }, 16)
    this.marketPublicationTimer.unref?.()
  }

  subscribeMarket(listener) {
    this.marketListeners.add(listener)
    return () => this.marketListeners.delete(listener)
  }

  setPresentationActive(active) {
    if (typeof active !== 'boolean') throw new TypeError('Presentation activity must be a boolean.')
    if (this.presentationActive === active) return
    this.presentationActive = active
    if (!active && this.marketPublicationTimer !== null) {
      clearTimeout(this.marketPublicationTimer); this.marketPublicationTimer = null
    }
    this.preparedCharts.setPresentationActive(active)
  }

  preparePresentationResume() { return this.preparedCharts.preparePresentationResume() }

  async initialize() {
    this.metadata ??= await MetadataStore.open(join(this.store.root, 'Metadata'))
    this.history = new MarketHistory({
      store: this.store, metadata: this.metadata,
      get: (path, parameters, signal, priority, options) => this.get(path, parameters, signal, priority, options),
      awaitRealtimeCandle: query => this.awaitRealtimeCandle(query),
      parseCandle: candle,
      persistCandles: (instId, rows, options) => this.persistCandles(instId, rows, typeof options === 'string' ? { priority: options } : options),
      persistStatistics: (instrument, timeframe, end, source, values, range, priority) => this.persistStatisticsSource(instrument, timeframe, end, source, values, this.shutdownController.signal, priority, false, { range }),
      instrument: instId => this.instruments.get(instId),
      liveRevision: (instId, timeframe) => this.liveSourceRevisions.get(`${instId}:${timeframe}`) ?? 0,
      onLive: (instId, timeframe, row) => this.setLive(instId, timeframe, row),
      replaceCandles: (range, rows, priority, options) => this.replaceCandles(range, rows, priority, options),
      derivePrices: (range, priority) => this.materializePrices(range, priority),
      onProgress: task => this.onHistoryProgress(task),
      onAuditCheckpoint: job => this.onAuditCheckpoint(job),
    })
    await this.history.ready
    this.historyDownload = new HistoryDownload({ sync: this.history.sync, metadata: this.metadata,
      onChange: report => this.publishHistoryDownload(report) })
    this.publishHistoryDownload(this.historyDownload.snapshot())
    const audits = this.history.audit.list().sort((a, b) => b.updatedAt - a.updatedAt)
    this.latestAuditID = audits[0]?.id ?? null
    if (audits.length) this.publishAudit(this.auditSnapshot(audits[0]))
    this.readCatalog()
    this.realtime = new RealtimeMarket({
      onDiagnostic: this.onConnectionDiagnostic,
      parseCandle: candle,
      onState: state => {
        this.scheduleCandleWaitCheck()
        if (this.realtimeStatus !== state.status) {
          this.subscriptionState = null
          this.realtimeStatus = state.status; this.touchList()
          if (!this.closing) this.preparedCharts.sourceStateChanged()
          this.scheduleMarketDeadline()
        }
      },
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      onSubscribed: ({ instId }) => {
        this.markMarketDeadlineDirty(instId)
        const record = this.catalog.get(instId)
        if (record) this.rememberHistoricalAssessment(record)
      },
      onForming: (row, context) => {
        this.track(this.candleDerivations.observe(row, context).then(() => this.ensureListHourPrefix(row.instrument)))
        // The source has admitted its raw fact synchronously. Background chart
        // publication has a separate completion and must not hold the next
        // same-series socket event or its selected higher-timeframe derivative.
        this.track(this.setLive(row.instrument, row.timeframe, row, context))
      },
      sourceEpoch: instId => this.instrumentGenerations.get(instId) ?? 0,
      onConfirmed: (row, context) => this.confirmPriceCandle(row, context),
      onReconnect: (subscriptions, context) => this.reconcileRealtime(subscriptions, context),
    })
    this.realtimeStatus = this.realtime.getState().status
    this.publicRealtime = new RealtimePublicMarket({
      onDiagnostic: this.onConnectionDiagnostic,
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      ...(this.autoRefresh ? {
        onInstruments: (records, context) => this.receiveInstruments(records, context),
        onInstrumentsReady: context => this.synchronizeInstruments(context),
        onInstrumentsDisconnect: context => this.instrumentStreamDisconnected(context),
      } : {}),
      onSubscribed: (instId, channel, context) => {
        if (channel === 'trades') this.liveStatistics.start(instId, context.receivedAt)
        if (channel === 'tickers') this.tickerSubscribed(instId, context)
        if (channel === 'books') this.nativeBookDeadlines.set(instId, context.receivedAt + TICKER_BOOTSTRAP_MS)
      },
      onUnsubscribed: (instId, channel, context) => {
        if (channel === 'tickers') this.tickerDisconnected([instId], context)
        if (channel === 'books') this.bookUnsubscribed(instId)
        if (channel === 'open-interest') {
          const observations = this.observations.get(instId)
          if (observations?.openInterest?.source === 'websocket') { this.markMarketDeadlineDirty(instId); delete observations.openInterest }
          this.liveStatistics.clearInterest(instId)
          this.scheduleLiveStatistics(instId)
        }
        if (channel === 'trades') {
          this.liveStatistics.disconnect([instId], context.receivedAt)
          this.scheduleLiveStatistics(instId)
        }
      },
      onState: state => {
        if (this.publicRealtimeStatus !== state.status) { this.publicRealtimeStatus = state.status; this.touchList() }
      },
      onDisconnect: (ids, context) => {
        this.tickerDisconnected(ids, context)
        for (const instId of ids) this.bookUnsubscribed(instId)
        this.liveStatistics.disconnect(ids, Date.now())
        for (const instId of ids) this.scheduleLiveStatistics(instId)
      },
      onTicker: (instId, value, context) => this.receivePublicObservation(instId, 'ticker', value, context),
      onBook: (instId, value, context) => this.receivePublicObservation(instId, 'book', value, context),
      onOpenInterest: (instId, value, context) => {
        if (!this.candidateIDs?.has(instId)) return
        this.liveStatistics.openInterest(instId, value, context.receivedAt)
        this.scheduleLiveStatistics(instId)
        this.receivePublicObservation(instId, 'openInterest', value, context)
      },
      onTrades: (instId, values, context) => {
        if (!this.candidateIDs?.has(instId)) return
        this.liveStatistics.trades(instId, values, context.receivedAt)
        this.scheduleLiveStatistics(instId)
      },
    })
    this.updateSubscriptions()
    if (this.autoRefresh && !this.closing) {
      this.realtime.start(); this.publicRealtime.start()
      this.track(this.refresh())
    }
    this.scheduleMarketDeadline()
    return this
  }

  track(promise) {
    const source = Promise.resolve(promise), existing = this.backgroundTaskSources.get(source)
    if (existing) return existing
    const task = source.catch(() => undefined).finally(() => {
      this.backgroundTasks.delete(task); this.backgroundTaskSources.delete(source)
    })
    this.backgroundTaskSources.set(source, task)
    this.backgroundTasks.add(task)
    return task
  }

  async reconfigure(previousPreferences) {
    await this.ready
    const current = this.prefs(), previous = validatePreferences(previousPreferences)
    const liquidityChanged = liquidityConfigKey(previous.liquidity) !== liquidityConfigKey(current.liquidity)
    if (!liquidityChanged) return
    this.historicalAssessments = new WeakMap()
    this.historicalValidations = new WeakSet()
    this.refreshController?.abort()
    this.renewalController?.abort()
    for (const controller of this.catalogControllers) controller.abort()
    this.catalogChecks.clear(); this.renewalTargets.clear()
    this.verifyCatalog()
    this.updateSubscriptions()
    this.scheduleMarketDeadline()
    this.lastRefreshAt = 0
    const configKey = liquidityConfigKey(current.liquidity)
    if (this.autoRefresh) this.track(Promise.allSettled([this.refreshing, this.renewing].filter(Boolean)).then(() => {
      if (!this.closing && !this.disposed && this.catalogCriteriaKey() === configKey) return this.refresh({ reuse: true })
    }))
    this.touchList()
    this.scheduleMarketDeadline()
  }

  invalidate() {
    this.historicalAssessments = new WeakMap()
    this.historicalValidations = new WeakSet()
    this.refreshController?.abort()
    this.renewalController?.abort()
    for (const controller of this.catalogControllers) controller.abort()
    this.catalogChecks.clear(); this.renewalTargets.clear()
    this.replaceCatalog([])
    this.lastRefreshAt = 0
    if (this.autoRefresh) this.track(this.refresh())
  }

  publishHistoryDownload(report) {
    this.downloadReport = { ...structuredClone(report), revision: ++this.downloadRevision, serviceSession: this.serviceSession }
    for (const listener of this.downloadListeners) {
      try { Promise.resolve(listener(structuredClone(this.downloadReport))).catch(() => undefined) }
      catch { /* Disconnected renderers cannot stop explicit downloads. */ }
    }
  }

  subscribeHistoryDownload(listener) {
    if (!this.closing) this.downloadListeners.add(listener)
    return () => this.downloadListeners.delete(listener)
  }

  async historyDownloadRequest({ action } = {}) {
    await this.ready
    if (this.closing) throw new Error('Market service is closing.')
    if (action === 'start') {
      const now = Date.now()
      const instruments = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry, now)).map(entry => this.instruments.get(entry.instrumentID) ?? entry.instrument)
      this.historyDownload.start(instruments)
    } else if (action === 'cancel') await this.historyDownload.cancel()
    else if (action !== 'status') throw new TypeError('Unknown history download action.')
    // Assign a new revision to this read so a delayed earlier IPC response
    // cannot overwrite a more recent checkpoint with the same revision.
    this.publishHistoryDownload(this.historyDownload.snapshot())
    return structuredClone(this.downloadReport)
  }

  auditSnapshot(job) {
    if (!job) return emptyAudit()
    const slots = target => Math.floor((target.through - target.from) / timeframeMilliseconds(target.timeframe)) + 1
    const total = job.targets.reduce((sum, target) => sum + slots(target), 0)
    const targetIndex = job.cursor.targetIndex
    const completed = job.phase !== 'inspect' || job.status === 'completed' ? total
      : job.targets.slice(0, targetIndex).reduce((sum, target) => sum + slots(target), 0)
        + (job.targets[targetIndex] ? Math.max(0, Math.floor((job.cursor.nextFrom - job.targets[targetIndex].from) / timeframeMilliseconds(job.targets[targetIndex].timeframe))) : 0)
    return { id: job.id, phase: ['queued', 'running', 'paused'].includes(job.status) ? job.phase === 'stabilize' ? 'validating' : 'running' : job.status,
      progress: { completed: Math.min(total, completed), total },
      issues: job.issues.filter(issue => issue.status === 'open').map(({ instrument, timeframe, from, through, reason, repairable }) => ({ instrument, timeframe, from, through, reason, repairable })), error: job.error ?? '' }
  }

  publishAudit(report) {
    if (this.closing) return
    this.auditReport = { ...structuredClone(report), revision: ++this.auditRevision, serviceSession: this.serviceSession }
    for (const listener of this.auditListeners) {
      try { Promise.resolve(listener(structuredClone(this.auditReport))).catch(() => undefined) }
      catch { /* A disconnected renderer cannot stop an audit. */ }
    }
  }

  onAuditCheckpoint(job) {
    if (job.id === this.latestAuditID) this.publishAudit(this.auditSnapshot(job))
  }

  subscribeAudit(listener) {
    if (!this.closing) this.auditListeners.add(listener)
    return () => this.auditListeners.delete(listener)
  }

  async dataAuditRequest({ action } = {}) {
    await this.ready
    const audit = this.history.audit
    const currentID = this.latestAuditID
    if (action === 'start') {
      const existing = currentID ? audit.get(currentID) : null
      if (existing && ['queued', 'running'].includes(existing.status)) return structuredClone(this.auditReport)
      const preferences = this.prefs(), targets = []
      const auditInstruments = this.catalog.size > 0
        ? [...this.catalog.values()].map(entry => this.instruments.get(entry.instrument.instId) ?? entry.instrument)
        : [...this.instruments.values()]
      for (const instrument of auditInstruments) for (const timeframe of CHART_TIMEFRAMES) {
        const step = timeframeMilliseconds(timeframe), through = closedBoundary(timeframe) - step
        const listedAt = Number(instrument.listTime), horizon = Math.max(0, through - preferences.historyDays * 86_400_000 + step - 200 * step)
        const from = Number.isFinite(listedAt) && listedAt > 0 ? Math.max(horizon, Math.ceil(listedAt / step) * step) : horizon
        if (from <= through) targets.push({ instrument: instrument.instId, timeframe, source: 'candles', from, through })
      }
      if (!targets.length) {
        this.latestAuditID = null
        this.publishAudit({ ...emptyAudit(), phase: 'completed' })
      } else {
        const job = audit.start({ targets }); this.latestAuditID = job.id
        // start saves before selection; later checkpoints arrive through the hook.
        this.publishAudit(this.auditSnapshot(job))
      }
      return structuredClone(this.auditReport)
    }
    if (!['status', 'cancel', 'repair'].includes(action)) throw new TypeError('Unknown data audit action.')
    if (currentID && action === 'cancel') audit.cancel(currentID)
    if (currentID && action === 'repair') audit.repair(currentID)
    return structuredClone(this.auditReport)
  }

  realtimeState() {
    const states = [this.realtime, this.publicRealtime].map(stream => stream?.getState().status ?? 'disconnected')
    if (states.includes('reconnecting')) return 'reconnecting'
    if (states.includes('connecting')) return 'connecting'
    return states.every(state => state === 'live') ? 'live' : 'disconnected'
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask
    this.closing = true
    this.books.dispose()
    if (this.subscriptionImmediate) clearImmediate(this.subscriptionImmediate)
    this.subscriptionImmediate = null
    if (this.candleWaitImmediate) clearImmediate(this.candleWaitImmediate)
    this.candleWaitImmediate = null
    for (const wait of this.candleWaits.values()) this.finishCandleWait(wait, false, new DOMException('Market service is closed.', 'AbortError'))
    for (const recovery of this.sourceRecoveries.values()) this.cancelRequiredRecovery(recovery.key)
    for (const instId of this.tickerRecoveries.keys()) this.cancelTickerRecovery(instId)
    this.tickerSubscriptions.clear()
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    if (this.bookSampleTimer) clearTimeout(this.bookSampleTimer)
    this.bookSamples.clear()
    this.marketDeadlineTimer = null; this.marketDeadlineAt = null; this.marketDeadlineState = null
    this.marketDeadlineIndex.clear(); this.marketRemovalIndex.clear()
    this.subscriptionDeadlines.clear(); this.subscriptionDirty.clear()
    this.marketDeadlineDirty.clear()
    if (this.qualificationImmediate) clearImmediate(this.qualificationImmediate)
    if (this.marketPublicationTimer) clearTimeout(this.marketPublicationTimer)
    if (this.listQuoteTimer) clearTimeout(this.listQuoteTimer)
    if (this.streamQualificationTimer) clearTimeout(this.streamQualificationTimer)
    if (this.liveStatisticsTimer) clearTimeout(this.liveStatisticsTimer)
    this.marketListeners.clear()
    this.auditListeners.clear()
    this.downloadListeners.clear()
    this.qualificationQueue.clear()
    this.disposeTask = (async () => {
      let readyFailed = false
      try { await this.ready } catch { readyFailed = true }
      const failures = []
      const settle = async operations => {
        const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      }
      // A confirmed stream event resolves only after its durable write. Drain it before aborting source work.
      await settle([() => this.realtime?.close(), () => this.publicRealtime?.close()])
      this.candleDerivations?.close()
      await settle([() => this.streamLiquidity?.close()])
      this.disposed = true
      this.refreshController?.abort()
      this.renewalController?.abort()
      for (const controller of this.catalogControllers) controller.abort()
      this.shutdownController.abort()
      for (const controller of this.abortControllers) controller.abort()
      await settle([() => this.historyDownload?.close()])
      await settle([() => this.history?.close()])
      await settle([() => this.preparedCharts?.dispose()])
      await Promise.allSettled([this.refreshing, this.renewing, this.drainRequestQueues(), ...this.candidateTasks.values(), ...this.barTasks, ...this.backgroundTasks, ...this.candleMutations.values(), ...this.livePrefixTasks.values()].filter(Boolean))
      if (this.ownsMetadata) await settle([() => this.metadata?.close()])
      if (!readyFailed && failures.length) throw new AggregateError(failures, `Market service shutdown failed: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
    })()
    return this.disposeTask
  }
}

Object.assign(
  MarketService.prototype,
  okxHttpMethods,
  marketCatalogMethods,
  marketSubscriptionMethods,
  marketDeadlineMethods,
  marketQualificationMethods,
)
