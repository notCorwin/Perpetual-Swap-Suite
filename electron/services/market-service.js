import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { beginOperation, measureOperation } from './operations.js'
import { networkResource } from './network-operations.js'
import { PreparedChartPipeline } from './prepared-chart-service.js'
import { MetadataStore, DEFAULT_PREFERENCES, validatePreferences } from './metadata-store.js'
import { MarketHistory } from './market-history.js'
import { HistoryDownload } from './history-download.js'
import { eligibleInstrument, evaluateLiquidity, createLiquidityEvaluator, quoteTurnover24h } from './liquidity.js'
import { rankingFromCandles, compareRanking } from './ranking.js'
import { RealtimeMarket } from './realtime-market.js'
import { RealtimePublicMarket } from './realtime-public-market.js'
import { LiveStatistics } from './live-statistics.js'
import { StreamLiquidityEvaluator } from './stream-liquidity.js'
import { MarketOpenInterest } from './market-open-interest.js'
import { MarketBook } from './market-book.js'
import { CandleDerivations } from './candle-derivations.js'
import { statisticsMask, statisticsVersionFor, validTakerVolumes, STATISTICS_OI, STATISTICS_TAKER } from './statistics-state.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const FIVE_MINUTES = 300_000
const CHART_TIMEFRAMES = ['5m', '15m', '1H']
const LIQUIDITY_SOURCE_CRITERIA = {
  ticker: ['spread'], book: ['depth', 'slippage'], openInterest: ['openInterest'],
  turnover: ['volume24h'], hourly: ['volumeStability'],
}
const requiredLiquiditySources = config => Object.entries(LIQUIDITY_SOURCE_CRITERIA)
  .filter(([, criteria]) => criteria.some(key => config[key].enabled)).map(([source]) => source)
const OBSERVATION_TTL = 90_000
const TICKER_BOOTSTRAP_MS = 10_000
const CANDLE_DELIVERY_MS = 10_000
const CATALOG_RENEW_INTERVAL = 30_000
const LIST_REMOVAL_DELAY_MS = 30_000
const REQUEST_TIMEOUT = 12_000
const RETRY_DELAYS = [1_000]
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, prefetch: 1, statistics: 2, continuity: 2, foreground: 3, repair: 3, prepared: 3, interactive: 4 }
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, books: 50, instruments: 100, tickers: 100, openInterest: 100, market: 80 })
const instrumentRateLimit = name => name === 'oi' || name === 'taker'
const MAX_HTTP_REQUESTS = 24
const requestLaneFor = path => {
  if (path.includes('/rubik/stat/taker-volume-contract')) return 'taker'
  if (path.includes('/rubik/stat/contracts/open-interest-history')) return 'oi'
  if (path === '/market/books') return 'books'
  if (path === '/public/instruments') return 'instruments'
  if (path === '/market/tickers' || path === '/market/ticker') return 'tickers'
  if (path === '/public/open-interest') return 'openInterest'
  return path.includes('/market/candles') || path.includes('/market/history-candles') ? 'candles' : 'market'
}
const statisticsExpiryField = source => source === STATISTICS_OI ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
const closedBoundary = (timeframe, now = Date.now()) => Math.floor(now / timeframeMilliseconds(timeframe)) * timeframeMilliseconds(timeframe)
const emptyAudit = () => ({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error('The request was aborted.')); return }
  const abort = () => reject(signal?.reason ?? new Error('The request was aborted.'))
  signal?.addEventListener('abort', abort, { once: true })
  Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
})
class RetryAfterError extends Error {
  constructor(path, retryAfter, lane) {
    super(`OKX ${path} is rate limited.`)
    this.retryAfter = retryAfter
    this.lane = lane
  }
}
class RequestTimeoutError extends Error {
  constructor(path, timeout) {
    super(`OKX ${path} timed out after ${Math.ceil(timeout / 1_000)} seconds.`)
    this.name = 'RequestTimeoutError'
  }
}
const retryAfterDelay = value => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(RETRY_DELAYS[0], seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(RETRY_DELAYS[0], timestamp - Date.now()) : undefined
}
const requestPriority = priority => REQUEST_PRIORITY[priority] ?? REQUEST_PRIORITY.foreground
const number = value => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const timeframeMilliseconds = timeframe => timeframe === '5m' ? FIVE_MINUTES : timeframe === '15m' ? 900_000 : 3_600_000
function normalizedStatistics(candle) {
  const sources = statisticsMask(candle)
  const volumes = sources & STATISTICS_TAKER ? validTakerVolumes(candle) : null
  const next = {
    ...candle,
    oi: sources & STATISTICS_OI ? number(candle.oi) : null,
    buy: volumes?.buy ?? null,
    sell: volumes?.sell ?? null,
  }
  // Preserve genuine observations independently. Old inferred nulls and
  // traded-period zero placeholders require a real bounded source request.
  next.statisticsVersion = sources ? statisticsVersionFor(sources) : null
  for (const source of [STATISTICS_OI, STATISTICS_TAKER]) {
    const field = statisticsExpiryField(source)
    const missing = source === STATISTICS_OI ? next.oi === null : next.buy === null || next.sell === null
    // Only persisted source proof can lease an empty observation. A price
    // correction or import must never manufacture a new successful response.
    next[field] = sources & source && missing
      ? number(candle[field]) ?? 0
      : null
  }
  return next
}

function requestURL(path, parameters = {}) {
  const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]))
  return `${OKX_ORIGIN}${path}?${query}`
}

function candle(instrument, timeframe, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe, timestamp, open, high, low, close, volume: number(value[5]), baseVolume: number(value[6]), quoteVolume: number(value[7]), confirmed: value[8] === '1' }
}

const candleFields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
const priceRecord = row => Object.fromEntries(candleFields.map(field => [field, row[field] ?? null]))
const sameCandle = (left, right) => candleFields.every(field => Object.is(left[field] ?? null, right[field] ?? null))

/** Owns market observations and projections; HistorySync owns every historical source task. */
export class MarketService {
  constructor(store, preferences = () => DEFAULT_PREFERENCES, fetcher = fetch, autoRefresh = true, { metadata, requestTimeout = REQUEST_TIMEOUT, webSocketFactory } = {}) {
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
    this.pendingCandidates = new Map()
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
    this.qualificationQueue = new Set()
    this.qualificationImmediate = null
    this.marketDeadlineTimer = null
    this.marketDeadlineAt = null
    this.marketDeadlines = new Map()
    this.marketBoundary = closedBoundary('5m')
    this.processingMarketDeadline = false
    this.renewing = null
    this.instruments = new Map()
    this.instrumentGenerations = new Map()
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
    this.rankings = new Map()
    this.rankingTasks = new Map()
    this.rankingWindows = new Map()
    this.rankingVersions = new Map()
    this.rankingReads = new Map()
    this.rankingRepairs = new Map()
    this.persistedRankings = new Map()
    this.pendingRankings = new Map()
    this.rankingPersistenceImmediate = null
    this.listUpdatedAt = null
    this.canonicalList = null
    this.dataRevisions = new Map()
    this.publicSubscriptionDemand = null
    this.subscriptionImmediate = null
    this.statisticsTasks = new Map()
    this.liveCandles = new Map()
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
    this.requestLanes = new Map(Object.entries(REQUEST_LANE_INTERVALS).map(([name, interval]) => [name, { name, interval, queue: [], task: null, running: false, active: new Map(), buckets: new Map(), wake: null, nextAt: 0, rateLimitedUntil: 0,
      ...(instrumentRateLimit(name) ? { concurrency: 8 } : {}) }]))
    this.activeRequests = new Set()
    this.abortControllers = new Set()
    this.shutdownController = new AbortController()
    this.revision = 0
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
      acquire: (_instId, timeframe) => timeframe === this.preferences().chartTimeframe,
      onFocus: () => this.scheduleSubscriptions() })
    this.candleDerivations = new CandleDerivations({ store,
      onLive: (instId, timeframe, row, context) => {
        if (row) this.derivedLivePrices.add(row)
        return this.track(this.setLive(instId, timeframe, row, context))
      } })
    this.ready = this.initialize()
    this.unsubscribeStore = this.store.subscribe?.(change => {
      if (!change.imported || this.closing) return
      this.markChartDataChanged(change.instrument)
      if (change.priceFrom !== null) {
        this.preparedCharts.invalidate(change.instrument, change.timeframe)
        this.invalidateLiquidityHistory(change.instrument, null, change.timeframe)
        this.scheduleQualification(change.instrument, change.timeframe)
        if (change.timeframe === '5m') { this.invalidateRanking(change.instrument); this.track(this.updateRanking(change.instrument)) }
      } else this.track(this.preparedCharts.observeStatistics(change.instrument, change.timeframe, change.from, change.through))
    })
  }

  prefs() { return validatePreferences(this.preferences()) }
  catalogCriteriaKey() { return JSON.stringify(this.prefs().liquidity) }
  catalogEntry(instId) { return this.catalog.get(instId) }
  touchList() {
    this.canonicalList = null
    this.revision += 1
    if (!this.marketListeners.size || this.marketPublicationTimer || this.closing) return
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
      replaceCandles: (range, rows, priority) => this.replaceCandles(range, rows, priority),
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
      parseCandle: candle,
      onState: state => {
        this.scheduleCandleWaitCheck()
        if (this.realtimeStatus !== state.status) {
          this.realtimeStatus = state.status; this.touchList()
          if (!this.closing) this.preparedCharts.sourceStateChanged()
          this.scheduleMarketDeadline()
        }
      },
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      onSubscribed: ({ instId }) => {
        const record = this.catalog.get(instId)
        if (record) this.rememberHistoricalAssessment(record)
      },
      onForming: (row, context) => {
        this.track(this.candleDerivations.observe(row, context))
        return this.setLive(row.instrument, row.timeframe, row, context)
      },
      onConfirmed: row => this.confirmPriceCandle(row),
      onReconnect: (subscriptions, context) => this.reconcileRealtime(subscriptions, context),
    })
    this.realtimeStatus = this.realtime.getState().status
    this.publicRealtime = new RealtimePublicMarket({
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

  validCatalogEntry(entry, now = Date.now()) {
    return Boolean(entry?.instrument?.instId && entry.ticker && entry.result?.eligible && entry.status === 'verified'
      && entry.configKey === this.catalogCriteriaKey() && Number.isSafeInteger(entry.expiresAt) && this.catalogEntryExpiry(entry, now) > now)
  }

  catalogEntryExpiry(entry, now = Date.now()) {
    if (!entry || entry.expiresAt > now) return entry?.expiresAt ?? 0
    const instId = entry.instrument.instId, observations = entry.observations ?? {}
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted && this.candidateIDs?.has(instId)
    const metadataExpiry = continuousMetadata ? Number.MAX_SAFE_INTEGER : entry.instrumentObservation?.expiresAt ?? 0
    const required = requiredLiquiditySources(this.prefs().liquidity)
    const originalExpiry = Math.min(metadataExpiry, ...required.map(key => this.observationExpiry(observations[key], key, instId)))
    // Only a source's ordinary close can enter rollover. Explicit revocation
    // of an assessment must never be replaced by a longer source lease.
    if (entry.expiresAt !== originalExpiry) return entry.expiresAt
    return Math.min(metadataExpiry, ...required.map(key => this.qualificationExpiry(observations[key], key, instId, entry.configKey, now)))
  }

  readCatalog() {
    const entries = this.metadata.listCatalogEntries()
    for (const entry of entries) {
      // Live metadata continuity belongs to one socket session. A checkpoint
      // can restore only its original bounded REST/metadata observation lease.
      if (entry.instrumentObservation) entry.expiresAt = Math.min(entry.expiresAt, entry.instrumentObservation.expiresAt)
      if (this.prefs().liquidity.spread.enabled) entry.expiresAt = Math.min(entry.expiresAt, entry.observations?.ticker?.expiresAt ?? 0)
      if (entry.instrument?.instId) {
        this.instruments.set(entry.instrument.instId, entry.instrument)
        if (entry.instrumentObservation) this.instrumentObservations.set(entry.instrument.instId, entry.instrumentObservation)
      }
      if (entry.observations) this.observations.set(entry.instrumentID, entry.observations)
      const ranking = entry.lastRanking
      if (ranking?.lookback === this.prefs().rankingLookback && typeof ranking.rankingChange === 'number' && Number.isFinite(ranking.rankingChange)
        && Number.isSafeInteger(ranking.rankingAsOf) && ranking.rankingAsOf >= 0 && ranking.rankingAsOf % FIVE_MINUTES === 0 && ranking.rankingAsOf <= closedBoundary('5m')) {
        this.rankings.set(entry.instrumentID, { lookback: ranking.lookback, rankingChange: ranking.rankingChange, rankingAsOf: ranking.rankingAsOf })
        this.persistedRankings.set(entry.instrumentID, JSON.stringify(ranking))
      }
      if (entry.configKey === this.catalogCriteriaKey()) {
        this.catalogChecks.set(entry.instrumentID, entry)
        if (entry.status === 'verified' || entry.renewalTarget === true) this.renewalTargets.set(entry.instrumentID, entry.instrument)
      }
    }
    const valid = entries.filter(entry => this.validCatalogEntry(entry))
    if (!valid.length) return false
    this.catalogSource = 'cache'
    this.catalogUpdatedAt = Math.max(...valid.map(entry => entry.observedAt))
    this.replaceCatalog(valid)
    return true
  }

  async restoreCatalog() { await this.ready; return this.readCatalog() }

  async persistCatalog(entries, savedAt = Date.now()) {
    await this.ready
    for (const entry of entries) this.metadata.putCatalogEntry(this.catalogRecord(entry, savedAt))
  }

  catalogRecord(entry, timestamp = Date.now()) {
    const configKey = entry.configKey ?? this.catalogCriteriaKey()
    const ranking = this.rankings.get(entry.instrument.instId)
    const lastRanking = ranking?.lookback === this.prefs().rankingLookback && ranking.rankingChange !== null
      ? { lookback: ranking.lookback, rankingChange: ranking.rankingChange, rankingAsOf: ranking.rankingAsOf } : entry.lastRanking
    return { ...entry, instrumentID: entry.instrument.instId, schemaVersion: 1,
      ...(lastRanking ? { lastRanking } : {}),
      status: entry.status ?? (entry.result?.eligible ? 'verified' : 'failed'),
      observedAt: entry.observedAt ?? timestamp, expiresAt: entry.expiresAt ?? timestamp + OBSERVATION_TTL,
      preferencesRevision: entry.preferencesRevision ?? this.metadata?.getSettings().revision ?? 0, configKey }
  }

  replaceCatalog(entries) {
    if (this.disposed) return false
    const previous = this.catalog
    const next = new Map(entries.map(entry => { const record = this.catalogRecord(entry); return [record.instrument.instId, record] }))
    const now = Date.now()
    for (const instId of next.keys()) this.listRemovals.delete(instId)
    for (const [instId, entry] of previous) if (!next.has(instId) && !this.listRemovals.has(instId)) {
      // A late deadline callback must not restart the delay at its arrival time.
      this.bufferListRemoval(entry, now)
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.catalog])
    this.catalog = next
    for (const entry of next.values()) this.instruments.set(entry.instrument.instId, entry.instrument)
    if (changed) { this.catalogRevision += 1; this.touchList() }
    this.updateListedUniverse(now)
    for (const instId of next.keys()) if (!previous.has(instId)) this.track(this.updateRanking(instId, { ensure: true }))
    this.updateSubscriptions()
    this.scheduleMarketDeadline()
    return changed
  }

  pruneCatalog() {
    const valid = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry))
    if (valid.length !== this.catalog.size) this.replaceCatalog(valid)
  }

  bufferListRemoval(entry, now = Date.now(), expiry = entry ? this.catalogEntryExpiry(entry, now) : 0) {
    const removedAt = Math.min(now, expiry)
    if (!entry || removedAt + LIST_REMOVAL_DELAY_MS <= now) return
    const instId = entry.instrument.instId
    if (!this.listRemovals.has(instId)) this.listRemovals.set(instId, { entry, removeAt: removedAt + LIST_REMOVAL_DELAY_MS })
  }

  listedCatalogEntries(now = Date.now()) {
    const entries = new Map()
    for (const [instId, entry] of this.catalog) {
      const expiry = this.catalogEntryExpiry(entry, now)
      // Projection reads can run before the due maintenance callback. Apply the
      // same known expiry without mutating state or admitting background work.
      if (this.validCatalogEntry(entry, now) || expiry <= now && now < expiry + LIST_REMOVAL_DELAY_MS) entries.set(instId, entry)
    }
    for (const [instId, removal] of this.listRemovals) if (!entries.has(instId) && now < removal.removeAt) entries.set(instId, removal.entry)
    return entries
  }

  updateListedUniverse(now = Date.now()) {
    const ids = new Set(this.listedCatalogEntries(now).keys())
    if (ids.size === this.listedUniverse.size && [...ids].every(id => this.listedUniverse.has(id))) return
    this.listedUniverse = ids
    this.preparedCharts.setUniverse([...ids])
  }

  /** Reuse one canonical projection until its market facts or freshness proof change. */
  canonicalMarketList(now = Date.now()) {
    const lookback = this.prefs().rankingLookback, configKey = this.catalogCriteriaKey(), asOf = closedBoundary('5m', now)
    const cached = this.canonicalList
    if (cached?.revision === this.revision && cached.lookback === lookback && cached.configKey === configKey
      && now >= cached.observedAt && now < cached.expiresAt) return cached
    const entries = [...this.listedCatalogEntries(now).values()]
    const qualifiedCount = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry, now)).length
    const rows = measureOperation({ category: 'cpu', name: 'market.list.sort', attributes: { inputRows: entries.length } }, () => entries.map(entry => {
      const instId = entry.instrument.instId, ranking = this.rankings.get(instId)
      const current = ranking?.lookback === lookback && ranking.rankingAsOf === asOf
      const ticker = this.observations.get(instId)?.ticker?.value ?? entry.ticker
      return { instId, lastPrice: number(ticker.last), turnover24hUSDT: number(this.catalogChecks.get(instId)?.result.turnover ?? entry.result.turnover),
        rankingChange: current ? ranking.rankingChange : null, rankingAsOf: current ? ranking.rankingAsOf : null }
    }).sort(compareRanking))
    const turnoverOrder = measureOperation({ category: 'cpu', name: 'market.list.turnover-sort', attributes: { inputRows: rows.length } }, () => [...rows]
      .sort((left, right) => (right.turnover24hUSDT ?? -Infinity) - (left.turnover24hUSDT ?? -Infinity) || (left.instId < right.instId ? -1 : left.instId > right.instId ? 1 : 0))
      .map(row => row.instId))
    const expiries = entries.map(entry => {
      const expiry = this.catalogEntryExpiry(entry, now)
      return this.listRemovals.get(entry.instrument.instId)?.removeAt ?? (expiry > now ? expiry : expiry + LIST_REMOVAL_DELAY_MS)
    })
    this.canonicalList = { revision: this.revision, lookback, configKey, observedAt: now, qualifiedCount,
      current: qualifiedCount === this.catalog.size && [...this.listRemovals.values()].every(removal => removal.removeAt > now),
      expiresAt: Math.min(asOf + FIVE_MINUTES, ...expiries), rows, turnoverOrder }
    return this.canonicalList
  }

  /** Observational read: never admits source, history, or indicator work. */
  listRowsFor(now = Date.now()) { return this.canonicalMarketList(now).rows }

  cacheRankingCandles(instId, candles) {
    const rows = this.rankingWindows.get(instId)?.rows ?? new Map()
    const through = closedBoundary('5m') - FIVE_MINUTES
    const from = Math.max(0, through - Math.max(1_440, this.prefs().rankingLookback) * 60_000)
    let changed = false
    for (const row of candles) {
      if (row.instrument !== instId || row.timeframe !== '5m' || row.confirmed !== true || row.timestamp < from || row.timestamp > through) continue
      const previous = rows.get(row.timestamp)
      if (previous && Object.is(previous.close, row.close)) continue
      rows.set(row.timestamp, { instrument: instId, timeframe: '5m', timestamp: row.timestamp, close: row.close, confirmed: true })
      changed = true
    }
    for (const timestamp of rows.keys()) if (timestamp < from || timestamp > through) { rows.delete(timestamp); changed = true }
    if (changed) {
      this.rankingVersions.set(instId, (this.rankingVersions.get(instId) ?? 0) + 1)
      this.rankingReads.delete(instId)
      this.rankingWindows.set(instId, { rows })
      if (this.catalog.has(instId) || this.listRemovals.has(instId)) this.publishRanking(instId, this.prefs().rankingLookback, closedBoundary('5m'))
    }
  }

  cachedRanking(instId, lookback = this.prefs().rankingLookback, asOf = closedBoundary('5m')) {
    const window = this.rankingWindows.get(instId), version = this.rankingVersions.get(instId) ?? 0
    let result = window?.evaluation
    if (!result || result.version !== version || result.lookback !== lookback || result.asOf !== asOf) {
      result = { version, lookback, asOf, ...rankingFromCandles([...(window?.rows.values() ?? [])], lookback, asOf) }
      if (window) window.evaluation = result
    }
    const previous = this.rankings.get(instId)
    // A saved current-boundary ranking can paint while its local cache warms.
    // It cannot substitute for missing data in a new boundary or changed cache.
    const ranking = !window && result.rankingChange === null && previous?.lookback === lookback && previous.rankingAsOf === asOf
      ? previous : { rankingChange: result.rankingChange, rankingAsOf: result.rankingAsOf, lookback }
    this.rankings.set(instId, ranking)
    return ranking
  }

  publishRanking(instId, lookback, asOf) {
    const previous = this.rankings.get(instId)
    const { rankingChange, rankingAsOf } = this.cachedRanking(instId, lookback, asOf)
    if ((this.catalog.has(instId) || this.listRemovals.has(instId)) && (previous?.lookback !== lookback || !Object.is(previous?.rankingChange, rankingChange) || previous?.rankingAsOf !== rankingAsOf)) {
      this.listUpdatedAt = Date.now()
      this.touchList()
    }
    if (rankingChange !== null) {
      const lastRanking = { lookback, rankingChange, rankingAsOf }, signature = JSON.stringify(lastRanking)
      const current = this.catalog.get(instId)
      if (current) current.lastRanking = lastRanking
      if (this.persistedRankings.get(instId) === signature) this.pendingRankings.delete(instId)
      else {
        this.pendingRankings.set(instId, lastRanking)
        if (!this.rankingPersistenceImmediate && !this.disposed) {
          this.rankingPersistenceImmediate = setImmediate(() => {
            this.rankingPersistenceImmediate = null
            this.track(Promise.resolve().then(() => this.flushRankingPersistence()))
          })
          this.rankingPersistenceImmediate.unref?.()
        }
      }
    }
  }

  flushRankingPersistence() {
    if (this.rankingPersistenceImmediate) clearImmediate(this.rankingPersistenceImmediate)
    this.rankingPersistenceImmediate = null
    if (!this.pendingRankings.size || !this.metadata) return
    const pending = this.pendingRankings
    this.pendingRankings = new Map()
    try {
      // Update only ranking JSON inside one transaction. Qualification may have
      // changed since publication; never replace its current observations.
      const updated = this.metadata.saveCatalogRankings([...pending].map(([instrumentID, ranking]) => ({ instrumentID, ...ranking })))
      for (const instId of updated) this.persistedRankings.set(instId, JSON.stringify(pending.get(instId)))
    } catch (error) {
      for (const [instId, ranking] of pending) if (!this.pendingRankings.has(instId)) this.pendingRankings.set(instId, ranking)
      throw error
    }
  }

  repairRanking(instId, lookback, asOf) {
    const key = `${instId}:${lookback}:${asOf}`
    if (this.rankingRepairs.has(key) || this.closing || this.disposed) return
    const through = asOf - FIVE_MINUTES, from = Math.max(0, through - lookback * 60_000)
    const task = Promise.resolve().then(() => this.history.ensurePrices(instId, '5m', from, through, 'background'))
      .then(() => {
        this.rankingReads.delete(instId)
        return this.updateRanking(instId, { asOf })
      }).finally(() => { if (this.rankingRepairs.get(key) === task) this.rankingRepairs.delete(key) })
    this.rankingRepairs.set(key, task)
    this.track(task)
  }

  async updateRanking(instId, { ensure = false, asOf = closedBoundary('5m') } = {}) {
    if (this.disposed || this.closing || asOf !== closedBoundary('5m')) return
    const lookback = this.prefs().rankingLookback, key = `${instId}:${lookback}:${asOf}`
    this.publishRanking(instId, lookback, asOf)
    const evaluation = this.rankingWindows.get(instId)?.evaluation
    if (evaluation?.rankingChange !== null && evaluation?.rankingChange !== undefined) return
    const version = this.rankingVersions.get(instId) ?? 0, read = this.rankingReads.get(instId)
    if (read?.version === version && read.lookback === lookback && read.asOf === asOf) {
      if (ensure) this.repairRanking(instId, lookback, asOf)
      return
    }
    if (this.rankingTasks.has(key)) return this.rankingTasks.get(key)
    const task = (async () => {
      const through = asOf - FIVE_MINUTES, from = Math.max(0, through - Math.max(1_440, lookback) * 60_000)
      const rows = await this.store.candles({ instrument: instId, timeframe: '5m', from, through }, 'background')
      // A completed write that raced this read owns newer close observations.
      if (this.disposed) return
      if ((this.rankingVersions.get(instId) ?? 0) !== version) {
        this.publishRanking(instId, this.prefs().rankingLookback, closedBoundary('5m'))
        return
      }
      this.cacheRankingCandles(instId, rows)
      this.rankingReads.set(instId, { version: this.rankingVersions.get(instId) ?? 0, lookback, asOf })
      if (this.prefs().rankingLookback !== lookback || asOf !== closedBoundary('5m')) return
      this.publishRanking(instId, lookback, asOf)
      if (this.rankingWindows.get(instId)?.evaluation?.rankingChange == null && (ensure || this.catalog.has(instId))) this.repairRanking(instId, lookback, asOf)
    })().finally(() => { if (this.rankingTasks.get(key) === task) this.rankingTasks.delete(key) })
    this.rankingTasks.set(key, task)
    return task
  }

  track(promise) {
    const task = Promise.resolve(promise).catch(() => undefined).finally(() => this.backgroundTasks.delete(task))
    this.backgroundTasks.add(task)
    return task
  }

  pendingCandleCommit(instrument, timeframe, timestamp) {
    const sourceStamp = timestamp + timeframeMilliseconds(timeframe) - FIVE_MINUTES
    const progress = this.realtime?.getProgress(instrument, '5m')
    return progress?.committing && progress.confirmedThrough >= sourceStamp && (progress.committedThrough ?? -Infinity) < sourceStamp
  }

  finishCandleWait(wait, persisted, error) {
    if (!wait || this.candleWaits.get(wait.key) !== wait) return
    this.candleWaits.delete(wait.key)
    if (error) wait.reject(error)
    else wait.resolve(persisted)
    this.scheduleMarketDeadline()
  }

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
  }

  scheduleCandleWaitCheck() {
    if (this.closing || !this.candleWaits.size || this.candleWaitImmediate) return
    // Realtime releases a failed pending confirmation in its promise finally,
    // after publishing the error state. Check after that event's microtasks.
    this.candleWaitImmediate = setImmediate(() => { this.candleWaitImmediate = null; this.checkCandleWaits() })
    this.candleWaitImmediate.unref?.()
  }

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
  }

  requestLane(name) {
    const lane = this.requestLanes.get(name)
    if (!lane) throw new Error(`Unknown OKX request lane: ${name}`)
    return lane
  }

  requestBucket(lane, parameters) {
    if (!instrumentRateLimit(lane.name)) return lane
    // Both statistics endpoints meter IP + instrument, across all periods.
    const key = String(parameters?.instId ?? '')
    let bucket = lane.buckets.get(key)
    if (!bucket) {
      const now = Date.now()
      for (const [id, value] of lane.buckets) if (!value.pending && Math.max(value.nextAt, value.rateLimitedUntil) <= now) lane.buckets.delete(id)
      bucket = { nextAt: 0, rateLimitedUntil: 0, pending: 0 }
      lane.buckets.set(key, bucket)
    }
    return bucket
  }

  wakeRequestQueues() { for (const lane of this.requestLanes.values()) lane.wake?.() }

  nextQueuedRequest(lane, eligible = () => true) {
    // Reserve service for interactive work while ageing maintenance instead
    // of starving an archive behind an endless stream of closes.
    const now = Date.now()
    const score = request => requestPriority(request.priority) + Math.min(5, (now - (request.enqueuedAt ?? now)) / 5_000)
    const candidates = lane.queue.map((request, index) => ({ request, index })).filter(({ request }) => eligible(request))
    if (!candidates.length) return null
    let next = candidates[0].index
    for (const { request, index } of candidates) if (score(request) > score(lane.queue[next])) next = index
    lane.served = (lane.served ?? 0) + 1
    if (lane.served % 8 === 0) {
      const background = candidates.find(({ request }) => requestPriority(request.priority) <= 1)?.index ?? -1
      if (background >= 0) next = background
    }
    return lane.queue.splice(next, 1)[0]
  }

  cleanupRequest(request) {
    if (request.cleaned) return
    request.cleaned = true
    this.shutdownController.signal.removeEventListener('abort', request.abort)
    request.requestSignal?.removeEventListener('abort', request.abort)
    request.controller.signal.removeEventListener('abort', request.onAbort)
    this.abortControllers.delete(request.controller)
    if (request.bucket !== this.requestLane(request.lane)) request.bucket.pending -= 1
  }

  rejectQueuedRequest(request) {
    const lane = this.requestLane(request.lane)
    const index = lane.queue.indexOf(request)
    if (index < 0) return
    lane.queue.splice(index, 1)
    request.reject(request.controller.signal.reason ?? new Error('The request was aborted.'))
    this.cleanupRequest(request)
    lane.wake?.()
  }

  waitRequestLane(lane, delay) {
    return new Promise(resolve => {
      let timer
      const finish = () => {
        clearTimeout(timer)
        if (lane.wake === finish) lane.wake = null
        resolve()
      }
      lane.wake = finish
      if (delay !== undefined) timer = setTimeout(finish, delay)
    })
  }

  async performRequest(lane, request) {
    const startedAt = performance.now()
    try {
      if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
      const timeout = setTimeout(() => request.controller.abort(new RequestTimeoutError(request.path, this.requestTimeout)), this.requestTimeout)
      timeout.unref?.()
      try {
        const data = await abortable(Promise.resolve().then(async () => {
          // A request can be preempted after its lane delay but before the
          // microtask that starts fetch. Do not let that race create a
          // network call which no active viewport can consume.
          if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
          const url = requestURL(request.path, request.parameters), signal = request.controller.signal
          const operation = beginOperation({ category: 'ipc', name: 'http.request', resource: networkResource(url),
            attributes: { transport: 'http', method: 'GET', path: request.path, lane: lane.name, priority: request.priority, queueMS: Math.max(0, Date.now() - request.enqueuedAt) } })
          const attributes = {}
          let finished = false
          const finish = status => {
            if (finished) return
            finished = true
            operation.end({ status, attributes })
          }
          const abort = () => { attributes.timedOut = signal.reason instanceof RequestTimeoutError; finish(attributes.timedOut ? 'error' : 'cancelled') }
          signal.addEventListener('abort', abort, { once: true })
          try {
            const response = await this.fetcher(url, { headers: { Accept: 'application/json' }, signal })
            attributes.httpStatus = response.status
            const contentLength = response.headers?.get('content-length')
            if (contentLength !== null && contentLength !== undefined && /^\d+$/.test(contentLength) && Number.isSafeInteger(Number(contentLength))) attributes.declaredResponseBytes = Number(contentLength)
            if (signal.aborted) throw signal.reason ?? new Error('The request was aborted.')
            const serverDelay = retryAfterDelay(response.headers?.get('retry-after'))
            if (response.status === 429) {
              // Statistics cooling belongs to this instrument's bucket;
              // unrelated instruments retain their own published allowance.
              request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
              if (!instrumentRateLimit(lane.name)) lane.concurrency = Math.max(2, Math.floor((lane.concurrency ?? 4) / 2))
              throw new RetryAfterError(request.path, serverDelay, lane.name)
            }
            if (!response.ok) {
              const error = new Error(`OKX ${request.path} failed (${response.status}).`)
              if (serverDelay !== undefined) {
                error.retryAfter = serverDelay
                request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + serverDelay)
              }
              throw error
            }
            const payload = await response.json()
            if (signal.aborted) throw signal.reason ?? new Error('The request was aborted.')
            if (String(payload.code) === '50011') {
              request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
              throw new RetryAfterError(request.path, serverDelay, lane.name)
            }
            if (payload.code && payload.code !== '0') throw new Error(`OKX ${request.path}: ${payload.msg || payload.code}`)
            const data = payload.data
            if (!Array.isArray(data)) throw new TypeError(`OKX ${request.path} response needs a data array.`)
            attributes.rows = data.length
            finish('ok')
            return data
          } catch (error) { finish(signal.aborted && !(signal.reason instanceof RequestTimeoutError) ? 'cancelled' : 'error'); throw error }
          finally { signal.removeEventListener('abort', abort) }
        }), request.controller.signal)
        lane.latencyMS = lane.latencyMS === undefined ? performance.now() - startedAt : lane.latencyMS * 0.8 + (performance.now() - startedAt) * 0.2
        lane.completed = (lane.completed ?? 0) + 1
        if (lane.interval > 0) {
          if (!instrumentRateLimit(lane.name)) lane.concurrency = Math.max(2, Math.min(lane.name === 'books' ? 16 : 8, Math.ceil(lane.latencyMS / lane.interval) + 1))
          if (this.history?.sync.maxConcurrentPerSource.has(lane.name)) {
            this.history.sync.maxConcurrentPerSource.set(lane.name, lane.concurrency)
            this.history.sync.maxConcurrentTasks = Math.min(24, [...this.history.sync.maxConcurrentPerSource.values()].reduce((sum, count) => sum + count, 0))
          }
        }
        request.resolve(data)
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) { request.reject(error) }
    finally { this.cleanupRequest(request) }
  }

  async drainRequestLane(name) {
    const lane = this.requestLane(name)
    if (lane.running) return lane.task
    lane.running = true
    const task = (async () => {
      while (lane.queue.length || lane.active.size) {
        const limit = lane.concurrency ?? (name === 'books' ? 16 : 4)
        const maintenanceActive = [...lane.active.values()].filter(request => requestPriority(request.priority) < 3).length
        const globalMaintenance = [...this.activeRequests].filter(request => requestPriority(request.priority) < 3).length
        const capacity = request => requestPriority(request.priority) >= 3
          || maintenanceActive < Math.max(1, limit - 1) && globalMaintenance < MAX_HTTP_REQUESTS - 2
        const now = Date.now()
        const eligible = request => capacity(request) && Math.max(request.bucket.nextAt, request.bucket.rateLimitedUntil) <= now
        const canStart = lane.active.size < limit && this.activeRequests.size < MAX_HTTP_REQUESTS && lane.queue.some(capacity)
        if (!canStart) { await this.waitRequestLane(lane); continue }
        if (!lane.queue.some(eligible)) {
          const delay = Math.min(...lane.queue.filter(capacity).map(request => Math.max(request.bucket.nextAt, request.bucket.rateLimitedUntil) - now))
          await this.waitRequestLane(lane, Math.min(2_147_483_647, Math.max(1, delay))); continue
        }
        // Choose at admission time so newly queued chart/qualification work
        // passes downloads that were waiting for the endpoint's rate budget.
        const request = this.nextQueuedRequest(lane, eligible)
        request.bucket.nextAt = Date.now() + lane.interval
        this.activeRequests.add(request)
        const active = this.performRequest(lane, request).finally(() => {
          lane.active.delete(active)
          this.activeRequests.delete(request)
          this.wakeRequestQueues()
        })
        lane.active.set(active, request)
      }
    })().finally(() => {
      lane.running = false
      if (lane.task === task) lane.task = null
      if (lane.queue.length) void this.drainRequestLane(name)
    })
    lane.task = task
    return task
  }

  drainRequestQueues() {
    return Promise.all([...this.requestLanes.keys()].map(name => this.drainRequestLane(name)))
  }

  get(path, parameters, requestSignal, priority = 'foreground', { getPriority } = {}) {
    if (this.disposed || requestSignal?.aborted) throw new Error('Market service is closed.')
    const lane = requestLaneFor(path)
    // Independent endpoint budgets reserve capacity for chart and Verify
    // requests. At most one download occupies a lane's concurrent slots.
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.shutdownController.signal.addEventListener('abort', abort, { once: true })
    requestSignal?.addEventListener('abort', abort, { once: true })
    this.abortControllers.add(controller)
    let resolveRequest, rejectRequest
    const result = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject })
    const queue = this.requestLane(lane)
    const bucket = this.requestBucket(queue, parameters)
    if (bucket !== queue) bucket.pending += 1
    const request = { path, parameters, requestSignal, get priority() { return getPriority?.() ?? priority }, lane, bucket, controller, abort, enqueuedAt: Date.now(), resolve: resolveRequest, reject: rejectRequest, cleaned: false, onAbort: null }
    request.onAbort = () => this.rejectQueuedRequest(request)
    controller.signal.addEventListener('abort', request.onAbort, { once: true })
    if (controller.signal.aborted) request.onAbort()
    else {
      queue.queue.push(request)
      queue.wake?.()
      void this.drainRequestLane(lane)
    }
    return result
  }


  enqueueCandleMutation(instrument, operation) {
    const previous = this.candleMutations.get(instrument) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    this.candleMutations.set(instrument, task)
    return task.finally(() => {
      if (this.candleMutations.get(instrument) === task) this.candleMutations.delete(instrument)
    })
  }

  async appendChangedCandlesLocked(candles, priority = 'background') {
    if (!candles.length) return []
    const instrument = candles[0].instrument, timeframe = candles[0].timeframe
    const from = Math.min(...candles.map(value => value.timestamp)), through = Math.max(...candles.map(value => value.timestamp))
    const existing = await this.store.candles({ instrument, timeframe, from, through }, priority)
    const byTimestamp = new Map(existing.map(value => [value.timestamp, value]))
    const changed = candles.filter(value => !sameCandle(byTimestamp.get(value.timestamp) ?? {}, value)).map(priceRecord)
    if (changed.length) {
      await this.store.appendCandles(changed, priority)
      const timestamps = new Set(changed.map(row => row.timestamp))
      const committed = (await this.store.candles({ instrument, timeframe, from, through }, priority)).filter(row => timestamps.has(row.timestamp))
      this.preparedCharts.observe(committed, byTimestamp)
      return committed
    }
    return changed
  }

  async persistCandles(instrument, candles, { priority = 'foreground' } = {}) {
    const confirmed = candles.filter(value => value.confirmed)
    await this.ready
    if (this.disposed || !confirmed.length) return false
    const result = await this.enqueueCandleMutation(instrument, async () => {
      if (this.disposed) return false
      const changed = []
      for (const rows of Map.groupBy(confirmed, row => row.timeframe).values()) changed.push(...await this.appendChangedCandlesLocked(rows, priority))
      if (!changed.length) return false
      this.invalidateLiquidityHistory(instrument, changed)
      this.markChartDataChanged(instrument)
      this.cacheRankingCandles(instrument, changed)
      for (const timeframe of new Set(changed.map(row => row.timeframe))) this.scheduleQualification(instrument, timeframe)
      const base = changed.filter(row => row.timeframe === '5m')
      if (base.length) {
        this.candleDerivations.correct(instrument, base)
        const first = Math.min(...base.map(row => row.timestamp)), last = Math.max(...base.map(row => row.timestamp))
        for (const timeframe of ['15m', '1H']) {
          const step = timeframeMilliseconds(timeframe), from = Math.floor(first / step) * step
          const through = Math.min(Math.floor(last / step) * step, closedBoundary(timeframe) - step)
          if (from <= through) await this.materializePricesLocked({ instrument, timeframe, from, through, invalidateIncomplete: true }, priority)
        }
      }
      if (confirmed.some(row => row.timeframe === '5m')) void this.updateRanking(instrument).catch(() => undefined)
      return true
    })
    // Writer recovery also belongs to an in-flight attempt that has rejected
    // but has not observed that rejection yet. Signal outside the mutation lock.
    if (result) this.realtime.retryPendingConfirmations()
    return result
  }

  materializePrices(range, priority = 'background') {
    return this.enqueueCandleMutation(range.instrument, () => this.materializePricesLocked(range, priority))
  }

  async materializePricesLocked(range, priority) {
    if (this.disposed || range.timeframe === '5m') return { changed: 0, complete: 0, invalidated: 0 }
    const previous = await this.store.candles(range, priority)
    const result = await this.store.aggregateCandles(range, priority)
    if (!result.changed) return result
    const rows = await this.store.candles(range, priority)
    if (result.invalidated) this.preparedCharts.invalidate(range.instrument, range.timeframe)
    else this.preparedCharts.observe(rows, new Map(previous.map(row => [row.timestamp, row])))
    this.invalidateLiquidityHistory(range.instrument, result.invalidated ? null : rows, range.timeframe)
    this.markChartDataChanged(range.instrument)
    this.scheduleQualification(range.instrument, range.timeframe)
    this.history.sync.invalidate({ ...range, source: 'candles' })
    return result
  }

  async confirmPriceCandle(row) {
    this.track(this.candleDerivations.observe(row, { receivedAt: Date.now() }))
    try { await this.persistCandles(row.instrument, [row]) }
    finally { this.scheduleCandleWaitCheck() }
    for (const timeframe of CHART_TIMEFRAMES) {
      const step = timeframeMilliseconds(timeframe), end = row.timestamp + FIVE_MINUTES
      if (end % step) continue
      const stamp = end - step
      const confirmed = timeframe === '5m' ? row : (await this.store.candles({ instrument: row.instrument, timeframe, from: stamp, through: stamp }, 'continuity'))[0]
      this.finishCandleWait(this.candleWaits.get(`${row.instrument}:${timeframe}:${stamp}`), Boolean(confirmed))
      if (confirmed && this.statisticsDemand(row.instrument)) this.track(this.confirmStatistics(confirmed))
      const live = this.liveCandles.get(`${row.instrument}:${timeframe}`)
      if (!live || live.timestamp <= stamp) this.track(Promise.resolve(this.setLive(row.instrument, timeframe, null)))
    }
    this.track(this.updateRanking(row.instrument))
  }

  confirmStatistics(row) {
    const key = `${row.instrument}:${row.timeframe}:${row.timestamp}`
    const previous = this.statisticsTasks.get(key)
    if (previous) { previous.row = row; return previous.task }
    const entry = { row, task: null }
    entry.task = Promise.resolve().then(async () => {
      const calculate = () => this.liveStatistics.enrich({ ...entry.row, buy: null, sell: null, oi: null })
      let calculated = calculate()
      if (!validTakerVolumes(calculated) && this.publicRealtime.started && this.liveStatistics.canFinalize(entry.row)
        && this.publicRealtime.subscriptions.has(`trades:${row.instrument}`)) {
        // The final public trade and business candle can arrive on different
        // sockets. A bounded grace period never delays price durability or UI.
        await new Promise(resolve => setTimeout(resolve, 250))
        calculated = calculate()
      }
      if (this.closing || !this.statisticsDemand(row.instrument)) return
      if (validTakerVolumes(calculated)) {
        const current = entry.row
        const changed = await this.store.appendStatistics({ instrument: current.instrument, timeframe: current.timeframe,
          source: 'taker', from: current.timestamp, through: current.timestamp,
          values: [[current.timestamp, calculated.sell, calculated.buy]], priceVolume: current.volume,
          observedAt: Date.now(), preserveExistingSource: true }, 'continuity')
        if (changed) {
          this.markChartDataChanged(current.instrument)
          await this.preparedCharts.observeStatistics(current.instrument, current.timeframe, current.timestamp, current.timestamp, 'continuity', undefined, 'taker')
        }
      }
      // Valid local quantities satisfy coverage. Only missing native sources
      // are acquired; OI remains an independently observed stock quantity.
      const current = entry.row
      if (this.statisticsAcquisitionDemand(current.instrument, current.timeframe)) {
        await this.history.ensureStatistics(current.instrument, current.timeframe, current.timestamp, current.timestamp, 'continuity', this.shutdownController.signal)
      }
    }).finally(() => { if (this.statisticsTasks.get(key) === entry) this.statisticsTasks.delete(key) })
    this.statisticsTasks.set(key, entry)
    return entry.task
  }

  async replaceCandles(range, candles, priority = 'foreground') {
    await this.ready
    return this.enqueueCandleMutation(range.instrument, async () => {
      if (this.disposed) throw new Error('Market service is closed.')
      // Statistics belong to their own sources. Replacing prices must never
      // replay an earlier read over a newer independent statistic commit.
      await this.store.replaceCandles(range, candles.map(priceRecord), priority)
      this.onHistoryReplaced(range.instrument, range.timeframe)
      if (range.timeframe === '5m') this.candleDerivations.correct(range.instrument, candles, range)
      if (range.timeframe === '5m') for (const timeframe of ['15m', '1H']) {
        const step = timeframeMilliseconds(timeframe), from = Math.floor(range.from / step) * step
        const through = Math.min(Math.floor(range.through / step) * step, closedBoundary(timeframe) - step)
        if (from <= through) await this.materializePricesLocked({ instrument: range.instrument, timeframe, from, through, invalidateIncomplete: true }, priority)
      }
    })
  }

  markChartDataChanged(instrument) {
    const instId = typeof instrument === 'string' ? instrument : instrument?.instId
    if (instId) this.dataRevisions.set(instId, this.dataRevision(instId) + 1)
  }

  dataRevision(instId) { return this.dataRevisions.get(instId) ?? 0 }


  statisticsPageRange(timeframe, end) {
    const intervalMS = timeframeMilliseconds(timeframe)
    return { from: end - 99 * intervalMS, through: end, intervalMS }
  }

  async persistStatisticsSource(instrument, timeframe, end, source, values, signal, priority = 'statistics', preserveExistingSource = false, { range } = {}) {
    await this.ready
    if (this.disposed || signal?.aborted) return false
    const page = range ?? this.statisticsPageRange(timeframe, end)
    const changed = await this.store.appendStatistics({ instrument: instrument.instId, timeframe,
      source: source === STATISTICS_OI ? 'oi' : 'taker', from: page.from, through: page.through,
      values: values.map(value => value.map(number)), observedAt: Date.now(), preserveExistingSource }, priority)
    if (changed) this.markChartDataChanged(instrument.instId)
    return changed > 0
  }


  setLive(instId, timeframe, row, { receivedAt } = {}) {
    if (this.disposed) return
    const key = `${instId}:${timeframe}`, current = this.liveCandles.get(key)
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
    // Collection covers the exchange universe. Only visible/cached charts need
    // indicator projections; an undisplayed contract must not seed a chart on every tick.
    const chartKey = `${instId}:${timeframe}`
    if (!this.preparedCharts.realtimeKeys.has(chartKey) && !this.preparedCharts.series.has(chartKey) && !this.preparedCharts.snapshots.has(chartKey)) return
    return this.preparedCharts.setLive(instId, timeframe, row, { receivedAt: this.liveReceivedAt.get(key) })
  }

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
  }

  receivePublicObservation(instId, key, value, { receivedAt = Date.now(), signal, acknowledged } = {}) {
    if (this.closing || this.disposed || signal?.aborted || !this.candidateIDs?.has(instId)) return
    const observations = this.observations.get(instId) ?? {}
    const sourceTimestamp = number(value?.ts)
    const previous = observations[key]
    if (previous?.sourceTimestamp != null && sourceTimestamp != null && sourceTimestamp < previous.sourceTimestamp) return
    if (key === 'ticker' && !(number(value?.last) > 0)) {
      if (this.tickerSubscriptions.get(instId)?.signal === signal) this.tickerFault(instId, new Error(`Invalid native ticker for ${instId}.`))
      return
    }
    if (key === 'openInterest' && (number(value.oiUsd) === null || number(value.oiUsd) < 0)) return
    observations[key] = { value, source: 'websocket', sourceTimestamp, observedAt: receivedAt, expiresAt: receivedAt + OBSERVATION_TTL }
    this.observations.set(instId, observations)
    if (key === 'book') { this.books.invalidate(instId); this.nativeBookDeadlines.delete(instId) }
    this.cancelRequiredRecovery(`${instId}:${key}`)
    if (key === 'ticker') {
      const session = this.tickerSubscriptions.get(instId)
      if (acknowledged !== false && session && session.signal === signal && !signal.aborted && receivedAt >= session.receivedAt && session.subscription === this.publicRealtime.subscriptions.get(`tickers:${instId}`)) {
        if (this.validTicker(value)) {
          session.observation = observations.ticker; session.faulted = false
          this.tickerNativeObservations.set(observations.ticker, { instId, session })
          this.cancelTickerRecovery(instId)
        } else this.tickerFault(instId, new Error(`Invalid native bid/ask for ${instId}.`))
      }
      this.capTickerAssessment(instId)
      this.tickerCache ??= { values: new Map(), observedAt: 0 }
      this.tickerCache.values.set(instId, observations.ticker)
      if (this.validTicker(value)) this.clearTickerFault(instId)
      const entry = this.catalog.get(instId)
      if (entry) entry.ticker = value
      // Publish the current trade price without waiting for qualification or history.
      if (entry || this.listRemovals.has(instId)) { this.listUpdatedAt = receivedAt; this.touchList() }
    }
    this.queueStreamQualification(instId, key)
  }

  validTicker(value) {
    return number(value?.last) > 0 && number(value?.bidPx) > 0 && number(value?.askPx) > 0 && number(value.askPx) >= number(value.bidPx)
  }

  sourceError(source, error) {
    const owned = this.errorOwner && this.error === this.errorOwner.message
    if (error) {
      if (typeof error === 'object') this.handledSourceErrors.add(error)
      this.sourceErrors.set(source, { error, message: error instanceof Error ? error.message : String(error) })
    }
    else this.sourceErrors.delete(source)
    if (error || owned || !this.error) {
      this.errorOwner = [...this.sourceErrors.values()].at(-1) ?? null
      this.error = this.errorOwner?.message ?? ''
    }
    this.touchList()
  }

  clearTickerFault(instId) {
    let changed = this.tickerFaults.delete(instId)
    if (this.tickerFaults.has('*') && this.candidateIDs && [...this.candidateIDs].every(id => this.observationExpiry(this.tickerCache?.values.get(id), 'ticker', id) > Date.now())) changed = this.tickerFaults.delete('*') || changed
    if (!changed) return
    const error = [...this.tickerFaults.values()].at(-1)
    this.sourceError('tickers', error)
  }

  tickerSubscribed(instId, { signal, receivedAt }) {
    const subscription = this.publicRealtime.subscriptions.get(`tickers:${instId}`)
    if (!subscription || signal.aborted || !this.candidateIDs?.has(instId)) return
    this.cancelTickerRecovery(instId)
    this.tickerSubscriptions.set(instId, { signal, receivedAt, subscription, observation: null, faulted: false })
    this.capTickerAssessment(instId)
    this.tickerRecoveries.set(instId, { signal, subscription, retryAt: receivedAt + TICKER_BOOTSTRAP_MS, attempts: 0, task: null, controller: null })
    this.scheduleMarketDeadline()
  }

  tickerDisconnected(ids, { signal }) {
    for (const instId of ids) {
      const session = this.tickerSubscriptions.get(instId)
      if (!session || session.signal !== signal && !session.signal.aborted) continue
      this.tickerSubscriptions.delete(instId)
      this.cancelTickerRecovery(instId)
      this.capTickerAssessment(instId)
      this.queueStreamQualification(instId)
    }
    this.scheduleMarketDeadline()
  }

  capTickerAssessment(instId) {
    if (!this.prefs().liquidity.spread.enabled) return
    const now = Date.now(), assessed = this.catalogChecks.get(instId), published = this.catalog.get(instId)
    let changed = false
    for (const record of new Set([assessed, published])) {
      if (!record?.observations?.ticker) continue
      const expiry = this.observationExpiry(record.observations.ticker, 'ticker', instId)
      if (expiry >= record.expiresAt && expiry > now) continue
      const next = { ...record, expiresAt: Math.min(record.expiresAt, expiry),
        ...(expiry <= now ? { status: 'unknown', result: { ...record.result, eligible: false } } : {}) }
      if (record === assessed) this.catalogChecks.set(instId, next)
      if (record === published) this.catalog.set(instId, next)
      changed = true
    }
    if (changed) {
      // Source proof changes eligibility, never the desired collection universe.
      // In particular an unsubscribe callback must not re-enter subscriptions.
      if (this.catalog.has(instId) && !this.validCatalogEntry(this.catalog.get(instId), now)) {
        this.bufferListRemoval(published, now)
        this.catalog.delete(instId); this.catalogRevision++
        this.updateListedUniverse(now)
      }
      this.touchList()
    }
    this.scheduleMarketDeadline()
  }

  cancelTickerRecovery(instId) {
    const recovery = this.tickerRecoveries.get(instId)
    this.tickerRecoveries.delete(instId)
    recovery?.controller?.abort()
  }

  tickerFault(instId, error) {
    const session = this.tickerSubscriptions.get(instId)
    if (!session || session.signal.aborted) return
    session.faulted = true
    this.tickerFaults.set(instId, error); this.sourceError('tickers', error)
    this.capTickerAssessment(instId)
    if (!this.tickerRecoveries.has(instId)) this.tickerRecoveries.set(instId, { signal: session.signal, subscription: session.subscription, retryAt: Date.now(), attempts: 0, task: null, controller: null })
    this.queueStreamQualification(instId)
    this.scheduleMarketDeadline()
  }

  async repairTicker(instId, recovery, priority = 'foreground') {
    if (recovery.task) return recovery.task
    if (this.closing || recovery.signal.aborted || !this.candidateIDs?.has(instId) || this.tickerRecoveries.get(instId) !== recovery) return
    if (this.publicRealtime.started && this.publicRealtime.subscriptions.has(`tickers:${instId}`)) {
      // A missing or invalid native source is repaired at its subscription.
      // ACK deadlines and the transport control budget own recovery cadence.
      // REST cannot certify that source or turn its failure into polling.
      recovery.retryAt = Infinity
      this.tickerFaults.set(instId, new Error(`Waiting for native ticker recovery for ${instId}.`))
      this.sourceError('tickers', this.tickerFaults.get(instId))
      this.publicRealtime.recoverSubscription(instId, 'tickers')
      return
    }
    const controller = new AbortController()
    recovery.controller = controller
    const signal = AbortSignal.any([recovery.signal, controller.signal, this.shutdownController.signal])
    const task = (async () => {
      try {
        const values = await this.get('/market/ticker', { instId }, signal, priority)
        signal.throwIfAborted()
        if (this.tickerRecoveries.get(instId) !== recovery || recovery.subscription !== this.publicRealtime.subscriptions.get(`tickers:${instId}`)) return
        const value = values?.find(value => value?.instId === instId)
        if (!this.validTicker(value)) throw new Error(`Missing or invalid ticker observation for ${instId}.`)
        const observations = this.observations.get(instId) ?? {}, previous = this.tickerCache?.values.get(instId)
        const timestamp = number(value.ts)
        if (previous?.sourceTimestamp != null && timestamp != null && timestamp < previous.sourceTimestamp) throw new Error(`Ticker recovery returned an older observation for ${instId}.`)
        const observedAt = Date.now(), observation = { value, source: 'rest', sourceTimestamp: timestamp, observedAt, expiresAt: observedAt + OBSERVATION_TTL }
        observations.ticker = observation; this.observations.set(instId, observations)
        this.tickerCache ??= { values: new Map(), observedAt: 0 }
        this.tickerCache.values.set(instId, observation)
        if (this.tickerSubscriptions.get(instId)?.signal === recovery.signal) {
          // HTTP supplies a bounded fallback, not proof that this native
          // channel recovered. Its actual expiry owns the next scoped repair.
          recovery.retryAt = observation.expiresAt; recovery.attempts = 0
        } else this.tickerRecoveries.delete(instId)
        this.clearTickerFault(instId)
        this.queueStreamQualification(instId)
      } catch (error) {
        if (signal.aborted || this.closing || this.tickerRecoveries.get(instId) !== recovery) return
        recovery.attempts++
        recovery.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(recovery.attempts - 1, 5))
        this.tickerFaults.set(instId, error); this.sourceError('tickers', error)
      } finally {
        recovery.task = null; recovery.controller = null
        this.scheduleMarketDeadline()
      }
    })()
    recovery.task = task
    return task
  }

  async tickerObservation(instId, signal, priority) {
    const value = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(value, 'ticker', instId) > Date.now()) return value
    // Active subscriptions own their native bootstrap deadline. One missing
    // contract cannot initiate another whole-universe HTTP snapshot.
    if (this.publicRealtime.started && this.publicRealtime.subscriptions.has(`tickers:${instId}`) && !this.tickerRecoveries.get(instId)?.task) throw new Error(`Waiting for native ticker data for ${instId}.`)
    let recovery = this.tickerRecoveries.get(instId)
    if (!recovery) {
      recovery = { signal: this.tickerSubscriptions.get(instId)?.signal ?? this.shutdownController.signal,
        subscription: this.publicRealtime.subscriptions.get(`tickers:${instId}`), retryAt: Date.now(), attempts: 0, task: null, controller: null }
      this.tickerRecoveries.set(instId, recovery)
    }
    if (recovery.attempts && recovery.retryAt > Date.now()) throw this.tickerFaults.get(instId) ?? new Error(`Ticker recovery is waiting for retry for ${instId}.`)
    await abortable(this.repairTicker(instId, recovery, priority), signal)
    const observation = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(observation, 'ticker', instId) <= Date.now()) throw this.tickerFaults.get(instId) ?? new Error(`Missing ticker observation for ${instId}.`)
    return observation
  }

  queueStreamQualification(instId, source) {
    if (this.closing || this.disposed) return
    if (source && LIQUIDITY_SOURCE_CRITERIA[source]) {
      // Keep collecting the observation and publishing trade prices. Reuse an
      // assessment when this source is absent from its enabled dependencies.
      const config = this.preferences().liquidity, record = this.catalogChecks.get(instId)
      if (record && record.instrument === this.instruments.get(instId) && record.configKey === JSON.stringify(config)
        && LIQUIDITY_SOURCE_CRITERIA[source].every(key => config[key].enabled === false)) return
    }
    this.streamQualifications.add(instId)
    if (this.streamQualificationTimer) return
    this.streamQualificationTimer = setTimeout(() => this.flushStreamQualifications(), 100)
    this.streamQualificationTimer.unref?.()
  }

  flushStreamQualifications() {
    if (this.streamQualificationTimer) clearTimeout(this.streamQualificationTimer)
    this.streamQualificationTimer = null
    const ids = [...this.streamQualifications]; this.streamQualifications.clear()
    if (this.closing || this.disposed) return
    const config = this.prefs().liquidity, configKey = JSON.stringify(config), now = Date.now()
    const records = []
    for (const instId of ids) {
      const instrument = this.instruments.get(instId)
      if (!instrument || !this.candidateIDs?.has(instId)) continue
      const observations = { ...(this.observations.get(instId) ?? {}) }
      const instrumentObservation = this.instrumentObservations.get(instId)
      const input = this.liquidityInput(instrument, config, observations, now)
      if (input.book && (config.depth.enabled || config.slippage.enabled) && this.cheapLiquidity(input).status !== 'failed') {
        // Keep at most one pending calculation per instrument. A new book
        // replaces pending observations instead of growing the worker backlog.
        if (this.streamEvaluations.has(instId)) continue
        this.streamLiquidity ??= new StreamLiquidityEvaluator()
        const capturedSources = Object.entries(LIQUIDITY_SOURCE_CRITERIA).filter(([, criteria]) => criteria.some(key => config[key].enabled)).map(([source]) => source)
        const bookGeneration = this.bookGenerations.get(instId) ?? 0
        const task = this.streamLiquidity.evaluate(input).then(result => {
          if (this.closing || !this.currentCandidate(instrument, configKey, this.shutdownController.signal)
            || this.instrumentObservations.get(instId) !== instrumentObservation) return
          if (capturedSources.includes('book') && (this.bookGenerations.get(instId) ?? 0) !== bookGeneration) return
          const current = this.observations.get(instId) ?? {}, now = Date.now()
          if (config.volume24h.enabled && current.turnover !== observations.turnover
            || config.volumeStability.enabled && current.hourly !== observations.hourly) return
          const currentInput = this.liquidityInput(instrument, config, current, now)
          const expiredSource = capturedSources.some(key => observations[key] && !this.qualificationObservation(observations, key, instId, configKey, now))
          const record = expiredSource || this.cheapLiquidity(currentInput).status === 'failed'
            ? this.observedCandidate(instrument, config, configKey, current, {}, now, this.evaluateLiquidity({ ...currentInput, book: null }))
            : this.observedCandidate(instrument, config, configKey, observations, {}, now, result)
          record.ticker = current.ticker?.value ?? record.ticker
          this.publishStreamRecords([record])
          this.sourceError('liquidity', null)
        }).catch(error => {
          if (!this.closing) this.sourceError('liquidity', new Error(`Live liquidity calculation failed: ${error.message}`))
        }).finally(() => {
          this.streamEvaluations.delete(instId)
          const current = this.observations.get(instId) ?? {}
          if (this.instrumentObservations.get(instId) !== instrumentObservation || capturedSources.some(key => current[key] !== observations[key])) this.queueStreamQualification(instId)
        })
        this.streamEvaluations.set(instId, task)
        this.track(task)
      } else records.push(this.observedCandidate(instrument, config, configKey, observations, {}, now))
    }
    this.publishStreamRecords(records)
    this.scheduleMarketDeadline()
  }

  publishStreamRecords(records) {
    if (!records.length || this.closing || this.disposed) return
    const next = new Map(this.catalog)
    let membershipChanged = false
    for (const record of records) {
      const instrument = record.instrument, instId = instrument.instId
      this.catalogChecks.set(instId, record)
      const existing = this.catalog.has(instId)
      if (record.status === 'verified') {
        this.listRemovals.delete(instId)
        next.set(instId, record); this.renewalTargets.set(instId, instrument)
        membershipChanged ||= !existing
      } else {
        next.delete(instId)
        if (record.status === 'failed') this.renewalTargets.delete(instId)
        membershipChanged ||= existing
      }
      if (record.status !== 'verified') this.recoverRequiredSources(instId)
    }
    this.catalogSource = 'live'; this.catalogUpdatedAt = Date.now()
    // Durable catalog checkpoints belong to discovery/renewal. High-frequency
    // ticks update memory; membership alone controls the prepared-chart universe.
    if (membershipChanged) this.replaceCatalog([...next.values()])
    else this.catalog = next
    this.scheduleSubscriptions()
    this.touchList()
    this.scheduleMarketDeadline()
  }

  onHistoryProgress(task) {
    if (this.disposed) return
    this.historyDownload?.observe(task)
    if (['completed', 'unavailable'].includes(task.status) && task.timeframe === '5m') this.track(this.updateRanking(task.instrument))
  }

  invalidateRanking(instId) {
    this.rankingWindows.delete(instId)
    this.rankingReads.delete(instId)
    this.rankingVersions.set(instId, (this.rankingVersions.get(instId) ?? 0) + 1)
    this.rankings.delete(instId)
    this.pendingRankings.delete(instId)
    this.persistedRankings.delete(instId)
    for (const record of new Set([this.catalog.get(instId), this.catalogChecks.get(instId)])) if (record) delete record.lastRanking
    // A replacement revokes the persisted proof too; a restart must not revive
    // a same-boundary result computed from the superseded source candles.
    const saved = this.metadata?.getCatalogEntry(instId)
    if (saved?.lastRanking) { delete saved.lastRanking; this.metadata.putCatalogEntry(saved) }
    if (this.catalog.has(instId) || this.listRemovals.has(instId)) this.touchList()
  }

  onHistoryReplaced(instId, timeframe) {
    this.invalidateLiquidityHistory(instId, null, timeframe)
    this.markChartDataChanged(instId)
    this.preparedCharts.invalidate(instId, timeframe)
    if (timeframe === '5m') this.invalidateRanking(instId)
    this.scheduleQualification(instId, timeframe)
    if (timeframe === '5m') this.track(this.updateRanking(instId))
  }

  updateSubscriptions() {
    if (!this.realtime) return
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
    const config = this.prefs().liquidity, configKey = JSON.stringify(config), now = Date.now()
    const books = new Set(), trades = new Set()
    const prerequisites = Object.entries(LIQUIDITY_SOURCE_CRITERIA).filter(([source]) => source !== 'book')
      .flatMap(([source, criteria]) => criteria.filter(key => config[key].enabled).map(key => ({ key, source })))
    for (const instId of ids) {
      const record = this.catalogChecks.get(instId)
      // Reuse the already calculated cheap assessments. A failed book must
      // remain observed so it can recover; only independent prerequisites gate it.
      const possible = prerequisites.every(({ key, source }) => record?.configKey === configKey
        && record.result.checks?.some(check => check.key === key && check.status === 'verified')
        && this.qualificationObservation(record.observations ?? {}, source, instId, configKey, now))
      if (config.depth.enabled || config.slippage.enabled) {
        if (possible) { books.add(instId); this.bookRetirements.delete(instId) }
        else if (this.publicSubscriptionDemand?.books.has(instId)) {
          const retireAt = this.bookRetirements.get(instId) ?? now + LIST_REMOVAL_DELAY_MS
          if (retireAt > now) { books.add(instId); this.bookRetirements.set(instId, retireAt) }
          else this.bookRetirements.delete(instId)
        }
      } else this.bookRetirements.delete(instId)
      if (this.statisticsDemand(instId)) trades.add(instId)
    }
    const previous = this.publicSubscriptionDemand
    const same = (left, right) => left && left.size === right.size && [...right].every(id => left.has(id))
    if (this.publicRealtime && (!previous || !same(previous.books, books) || !same(previous.trades, trades)
      || this.publicRealtime.instruments.size !== ids.size || [...ids].some(id => !this.publicRealtime.instruments.has(id)))) {
      for (const instId of books) if (!previous?.books.has(instId)) this.nativeBookDeadlines.set(instId, now + TICKER_BOOTSTRAP_MS)
      this.publicRealtime.setSubscriptions([...ids], { books, trades })
      this.publicSubscriptionDemand = { books, trades }
    }
    if (collectorChanged && !this.closing) this.preparedCharts.sourceStateChanged()
    this.scheduleMarketDeadline()
  }

  scheduleSubscriptions() {
    if (this.closing || this.disposed || this.subscriptionImmediate) return
    this.subscriptionImmediate = setImmediate(() => { this.subscriptionImmediate = null; this.updateSubscriptions() })
    this.subscriptionImmediate.unref?.()
  }

  statisticsDemand(instId) {
    return this.listedUniverse.has(instId) || this.preparedCharts.focus?.instId === instId
  }

  statisticsAcquisitionDemand(instId, timeframe) {
    const focus = this.preparedCharts.focus
    return this.listedUniverse.has(instId) && timeframe === this.preferences().chartTimeframe
      || focus?.instId === instId && focus.timeframe === timeframe
  }

  priceStreaming(instId, timeframe) {
    return Boolean(this.realtime?.isSubscribed(instId, '5m')
      && (timeframe === '5m' || this.derivedLivePrices.has(this.liveCandleSources.get(`${instId}:${timeframe}`))))
  }

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
  }

  async reconcileRealtime(subscriptions, { signal } = {}) {
    await this.ready
    // HistorySync bounds source concurrency and request lanes enforce rates.
    // Admit every independent series before waiting for network recovery.
    const results = await Promise.allSettled(subscriptions.map(async ({ instId, timeframe }) => {
      if (this.closing || signal?.aborted) return
      const step = timeframeMilliseconds(timeframe), through = closedBoundary(timeframe) - step
      const coverage = await this.store.coverage(instId, timeframe, 'background')
      const from = Math.max(0, coverage.last === null ? through - step : Math.min(through, coverage.last + step))
      await this.history.ensurePrices(instId, timeframe, from, through, 'continuity', signal)
      // Prepared charts own bounded statistics demand for their visible ranges.
      // A collector reconnect must not download statistics for its whole gap.
    }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  prepareChartWindow(instId, timeframe, end, historyBars = 96) {
    if (this.closing || this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.ready.then(() => this.preparedCharts.prepare(instId, timeframe, end, historyBars))
    this.barTasks.add(task)
    return task.finally(() => this.barTasks.delete(task))
  }

  async getPreparedCharts() {
    await this.ready
    return this.preparedCharts.residentFrames()
  }

  subscribePreparedCharts(listener) { return this.preparedCharts.subscribe(listener) }
  async localChartWindow(instId, timeframe) { await this.ready; return this.preparedCharts.local(instId, timeframe) }
  localChartHistory(instId, timeframe, end) {
    if (this.closing || this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.ready.then(() => this.preparedCharts.localHistory(instId, timeframe, end))
    this.barTasks.add(task)
    return task.finally(() => this.barTasks.delete(task))
  }

  observationExpiry(observation, key, instId) {
    if (key === 'ticker' && observation?.source === 'websocket') {
      const proof = this.tickerNativeObservations.get(observation), session = proof?.session
      const id = instId ?? proof?.instId
      if (session && id === proof.instId && !session.faulted && !session.signal.aborted && session.observation === observation
        && this.tickerSubscriptions.get(id) === session && this.candidateIDs?.has(id)
        && this.publicRealtime?.subscriptions.get(`tickers:${id}`) === session.subscription) return Number.MAX_SAFE_INTEGER
    }
    return observation?.expiresAt ?? 0
  }

  observation(entry, key, now = Date.now()) {
    const value = entry[key]
    return value && Number.isSafeInteger(value.observedAt) && this.observationExpiry(value, key) > now ? value : null
  }

  rememberHistoricalAssessment(record, now = Date.now(), validated = false) {
    if (record.status !== 'verified' || !record.result.eligible || record.expiresAt <= now
      || !this.currentCandidate(record.instrument, record.configKey, this.shutdownController.signal)) return
    for (const [key, timeframe] of [['turnover', '5m'], ['hourly', '1H']]) {
      const observation = record.observations?.[key]
      if (!observation || observation.value.asOf !== closedBoundary(timeframe, now) || observation.expiresAt <= now) continue
      if (validated) this.historicalValidations.add(observation)
      if (!this.historicalValidations.has(observation) || this.historicalAssessments.has(observation)
        || !this.realtime?.isSubscribed(record.instrumentID, '5m')) continue
      this.historicalAssessments.set(observation, { instId: record.instrumentID, key, configKey: record.configKey,
        instrumentGeneration: this.instrumentGenerations.get(record.instrumentID) ?? 0, connection: this.realtime.connection,
        subscription: this.realtime.subscriptions.get(`5m:${record.instrumentID}`) })
    }
  }

  qualificationExpiry(observation, key, instId, configKey, now = Date.now()) {
    const expiry = this.observationExpiry(observation, key, instId)
    if (expiry > now || !observation || key !== 'turnover' && key !== 'hourly') return expiry
    const proof = this.historicalAssessments.get(observation), timeframe = key === 'turnover' ? '5m' : '1H'
    const boundary = closedBoundary(timeframe, now), deadline = boundary + CANDLE_DELIVERY_MS
    // Runtime authority belongs to the exact validated window and continuous
    // subscription. Neither a checkpoint, reconnect, tick nor refresh renews it.
    return proof?.instId === instId && proof.key === key && proof.configKey === configKey
      && proof.instrumentGeneration === (this.instrumentGenerations.get(instId) ?? 0) && proof.connection === this.realtime?.connection
      && proof.subscription && proof.subscription === this.realtime.subscriptions.get(`5m:${instId}`)
      && this.realtime.isSubscribed(instId, '5m') && observation.expiresAt === boundary
      && observation.value.asOf === boundary - timeframeMilliseconds(timeframe) ? deadline : expiry
  }

  qualificationObservation(observations, key, instId, configKey, now = Date.now()) {
    const observation = observations[key]
    if (!observation || !Number.isSafeInteger(observation.observedAt)
      || this.qualificationExpiry(observation, key, instId, configKey, now) <= now) return null
    if (key === 'turnover' || key === 'hourly') {
      const timeframe = key === 'turnover' ? '5m' : '1H', boundary = closedBoundary(timeframe, now)
      if (observation.value.asOf !== boundary
        && !(observation.value.asOf === boundary - timeframeMilliseconds(timeframe) && observation.expiresAt === boundary)) return null
    }
    return observation
  }

  invalidateLiquidityHistory(instId, rows, timeframe) {
    for (const frame of ['5m', '1H']) if (rows ? rows.some(row => row.timeframe === frame) : timeframe === frame) {
      const key = `${instId}:${frame}`
      this.liquidityHistoryRevisions.set(key, this.liquidityHistoryRevision(instId, frame) + 1)
      const window = this.historicalWindows.get(key)
      if (!rows) this.historicalWindows.delete(key)
      else if (window) {
        for (const row of rows) if (row.timeframe === frame) window.rows.set(row.timestamp, row)
        const step = timeframeMilliseconds(frame), through = closedBoundary(frame) - step
        const from = through - (frame === '5m' ? 288 : 24) * step
        for (const timestamp of window.rows.keys()) if (timestamp < from || timestamp > through) window.rows.delete(timestamp)
        window.revision = this.liquidityHistoryRevision(instId, frame)
        window.storeRevision = this.store.candlePriceRevision(instId, frame)
      }
    }
    const observations = this.observations.get(instId)
    if (!observations) return
    const record = this.catalogChecks.get(instId), published = this.catalog.get(instId)
    const now = Date.now(), publishedExpiry = this.catalogEntryExpiry(published, now)
    const recordObservations = { ...record?.observations }
    let recordChanged = false, recordInvalidated = false, publishedInvalidated = false
    for (const [key, frame, count] of [['turnover', '5m', 288], ['hourly', '1H', 24]]) {
      const step = timeframeMilliseconds(frame)
      for (const observation of new Set([observations[key], record?.observations?.[key], published?.observations?.[key]])) {
        const value = observation?.value
        const inputs = this.historicalInputs.get(observation)
        // A concurrent reader may already have calculated and published the
        // committed quote amounts. Invalidate changed inputs, not that result.
        if (!value || !(rows ? rows.some(row => row.timeframe === frame && row.timestamp >= value.asOf - count * step && row.timestamp < value.asOf
          && (!inputs?.has(row.timestamp) || !Object.is(inputs.get(row.timestamp), row.quoteVolume))) : timeframe === frame)) continue
        this.historicalAssessments.delete(observation)
        this.historicalValidations.delete(observation)
        if (observations[key] === observation) delete observations[key]
        const enabled = this.prefs().liquidity[key === 'turnover' ? 'volume24h' : 'volumeStability'].enabled
        if (record?.observations?.[key] === observation) {
          delete recordObservations[key]; recordChanged = true; recordInvalidated ||= enabled
        }
        if (published?.observations?.[key] === observation) publishedInvalidated ||= enabled
      }
    }
    if (recordChanged && record) {
      if (recordInvalidated) {
        record.status = 'unknown'; record.result = { ...record.result, eligible: false }; record.expiresAt = Math.min(record.expiresAt, now)
      }
      record.observations = recordObservations
      this.metadata.putCatalogEntry(record)
    }
    if (publishedInvalidated) {
      const entry = published
      this.bufferListRemoval(entry, now, publishedExpiry)
      if (entry) { entry.status = 'unknown'; entry.result = { ...entry.result, eligible: false }; entry.expiresAt = Math.min(publishedExpiry, now) }
      this.touchList()
      this.scheduleMarketDeadline()
    }
  }

  liquidityHistoryRevision(instId, timeframe) { return this.liquidityHistoryRevisions.get(`${instId}:${timeframe}`) ?? 0 }

  scheduleQualification(instId, timeframe) {
    if (!this.autoRefresh || this.closing || this.disposed || !this.catalogChecks.has(instId)) return
    const config = this.prefs().liquidity
    if (!config.volume24h.enabled && !config.volumeStability.enabled) return
    if (timeframe && !(timeframe === '5m' && config.volume24h.enabled || timeframe === '1H' && config.volumeStability.enabled)) return
    this.qualificationQueue.add(instId)
    if (this.qualificationImmediate) return
    // Coalesce durable writes, then read committed windows outside their write
    // locks. Every contract is admitted together; none waits for another source.
    this.qualificationImmediate = setImmediate(() => {
      this.qualificationImmediate = null
      const ids = [...this.qualificationQueue]; this.qualificationQueue.clear()
      const config = this.prefs().liquidity, key = JSON.stringify(config)
      this.track(Promise.allSettled(ids.map(id => {
        const instrument = this.instruments.get(id)
        return instrument && this.checkCandidate(instrument, config, key, this.shutdownController.signal, 'foreground', { localOnly: true })
      })))
    })
  }

  scheduleMarketDeadline() {
    if (this.closing || this.disposed || this.processingMarketDeadline) return
    for (const recovery of this.sourceRecoveries.values()) if (!this.requiredRecoveryCurrent(recovery)) this.cancelRequiredRecovery(recovery.key)
    const now = Date.now()
    // A due callback owns the captured deadlines even if another observation
    // arrives before the timer gets its event-loop turn.
    if (this.marketDeadlineTimer && this.marketDeadlineAt <= now) return
    const config = this.prefs().liquidity, configKey = JSON.stringify(config), required = requiredLiquiditySources(config)
    const ids = new Set([...this.catalogChecks.keys(), ...this.catalog.keys()]), deadlines = new Map()
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted
    for (const instId of ids) {
      const entry = this.catalog.get(instId), values = [entry?.expiresAt, this.catalogEntryExpiry(entry, now)]
      if (!continuousMetadata || !this.candidateIDs?.has(instId)) values.push(this.instrumentObservations.get(instId)?.expiresAt)
      const observations = this.observations.get(instId) ?? {}
      const assessed = this.catalogChecks.get(instId)?.observations ?? {}
      for (const key of required) values.push(this.observationExpiry(observations[key], key, instId), this.observationExpiry(assessed[key], key, instId),
        this.qualificationExpiry(observations[key], key, instId, configKey, now), this.qualificationExpiry(assessed[key], key, instId, configKey, now))
      const future = values.filter(value => Number.isSafeInteger(value) && value > now && value < Number.MAX_SAFE_INTEGER)
      if (future.length) deadlines.set(instId, Math.min(...future))
    }
    this.marketDeadlines = deadlines
    const boundary = ids.size ? closedBoundary('5m', now) + FIVE_MINUTES : Infinity
    const tickerRetries = [...this.tickerRecoveries].filter(([id, value]) => this.candidateIDs?.has(id) && !value.signal.aborted && !value.task).map(([, value]) => value.retryAt)
    const sourceRetries = [...this.sourceRecoveries.values()].filter(value => !value.task).map(value => value.retryAt)
    const candleDeadlines = [...this.candleWaits.values()].map(wait => wait.deadline)
    const removalDeadlines = [...this.listRemovals.values()].map(removal => removal.removeAt)
    removalDeadlines.push(...this.bookRetirements.values())
    for (const entry of this.catalog.values()) {
      const expiry = this.catalogEntryExpiry(entry, now)
      if (expiry <= now && expiry + LIST_REMOVAL_DELAY_MS > now) removalDeadlines.push(expiry + LIST_REMOVAL_DELAY_MS)
    }
    const next = Math.min(boundary, ...deadlines.values(), ...tickerRetries, ...sourceRetries, ...candleDeadlines, ...removalDeadlines)
    if (this.marketDeadlineAt === next) return
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    this.marketDeadlineTimer = null
    this.marketDeadlineAt = Number.isFinite(next) ? next : null
    if (this.marketDeadlineAt === null) return
    this.marketDeadlineTimer = setTimeout(() => this.processMarketDeadline(), Math.min(2_147_483_647, Math.max(1, next - now)))
    this.marketDeadlineTimer.unref?.()
  }

  processMarketDeadline() {
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    this.marketDeadlineTimer = null; this.marketDeadlineAt = null
    if (this.closing || this.disposed) return
    this.processingMarketDeadline = true
    try {
      this.checkCandleWaits()
      const now = Date.now(), asOf = closedBoundary('5m', now)
      const due = new Set([...this.marketDeadlines].filter(([, deadline]) => deadline <= now).map(([instId]) => instId))
      if (asOf !== this.marketBoundary) {
        this.marketBoundary = asOf
        this.touchList()
        for (const instId of new Set([...this.catalog.keys(), ...this.listRemovals.keys()])) this.track(this.updateRanking(instId, { asOf }))
        for (const instId of this.catalogChecks.keys()) this.scheduleQualification(instId)
      }
      // A worker can still own an earlier immutable observation. Its published
      // lease expires independently of newer raw source observations.
      this.pruneCatalog()
      let removed = false
      for (const [instId, removal] of this.listRemovals) if (removal.removeAt <= now) { this.listRemovals.delete(instId); removed = true }
      if (removed) { this.touchList(); this.updateListedUniverse(now) }
      for (const instId of due) {
        const record = this.catalogChecks.get(instId)
        if (record && !this.validCatalogEntry(record, now)) this.catalogChecks.set(instId, { ...record, status: 'unknown', result: { ...record.result, eligible: false }, expiresAt: now })
        this.streamQualifications.add(instId)
        this.scheduleQualification(instId)
        this.recoverRequiredSources(instId)
      }
      if (due.size) { this.flushStreamQualifications(); this.touchList() }
      for (const instId of due) {
        const ticker = this.tickerCache?.values.get(instId), session = this.tickerSubscriptions.get(instId)
        if (this.prefs().liquidity.spread.enabled && session && !session.signal.aborted && this.observationExpiry(ticker, 'ticker', instId) <= now && !this.tickerRecoveries.has(instId)) {
          this.tickerRecoveries.set(instId, { signal: session.signal, subscription: session.subscription, retryAt: now, attempts: 0, task: null, controller: null })
        }
      }
      for (const [instId, recovery] of this.tickerRecoveries) if (!recovery.task && recovery.retryAt <= now) this.track(this.repairTicker(instId, recovery))
      for (const recovery of this.sourceRecoveries.values()) if (!recovery.task && recovery.retryAt <= now) this.track(this.repairRequiredSource(recovery))
      if ([...this.bookRetirements.values()].some(deadline => deadline <= now)) this.scheduleSubscriptions()
    } finally {
      this.processingMarketDeadline = false
      this.scheduleMarketDeadline()
    }
  }

  recoverRequiredSources(instId) {
    if (!this.autoRefresh || this.closing || !this.candidateIDs?.has(instId)) return
    const config = this.prefs().liquidity, observations = this.observations.get(instId) ?? {}
    if (this.cheapLiquidity(this.liquidityInput(this.instruments.get(instId), config, observations)).status === 'failed') {
      for (const source of ['book', 'openInterest', 'turnover', 'hourly']) this.cancelRequiredRecovery(`${instId}:${source}`)
      return
    }
    const awaitingInterest = config.openInterest.enabled && !this.observation(observations, 'openInterest')
    const awaitingTicker = config.spread.enabled && !this.observation(observations, 'ticker')
    for (const source of ['book', 'openInterest', 'turnover', 'hourly']) {
      const enabled = source === 'book' ? config.depth.enabled || config.slippage.enabled
        : source === 'openInterest' ? config.openInterest.enabled : source === 'turnover' ? config.volume24h.enabled : config.volumeStability.enabled
      const key = `${instId}:${source}`
      if (source === 'book' && this.publicRealtime?.started && !this.publicRealtime.subscriptions.has(`books:${instId}`)) { this.cancelRequiredRecovery(key); continue }
      // Recovery obeys the same cheap-source gate as discovery. Native ticks
      // arriving while bulk OI is pending cannot fan out historical work.
      if (!enabled || source !== 'openInterest' && (awaitingInterest || awaitingTicker) || this.observation(observations, source)) { this.cancelRequiredRecovery(key); continue }
      if (!this.sourceRecoveries.has(key)) this.sourceRecoveries.set(key, { key, instId, source, attempts: 0,
        retryAt: Math.max(Date.now(), source === 'openInterest' ? this.openInterest.retryAt : source === 'book' && this.publicRealtime?.started ? this.nativeBookDeadlines.get(instId) ?? 0 : 0), task: null, controller: new AbortController() })
    }
    this.scheduleMarketDeadline()
  }

  requiredRecoveryCurrent(recovery) {
    if (!this.candidateIDs?.has(recovery.instId)) return false
    const config = this.prefs().liquidity
    const enabled = recovery.source === 'book' ? config.depth.enabled || config.slippage.enabled
      : recovery.source === 'openInterest' ? config.openInterest.enabled : recovery.source === 'turnover' ? config.volume24h.enabled : config.volumeStability.enabled
    return enabled && !this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)
  }

  cancelRequiredRecovery(key) {
    const recovery = this.sourceRecoveries.get(key)
    if (!recovery) return
    this.sourceRecoveries.delete(key)
    recovery.controller?.abort()
    this.sourceError(key, null)
  }

  async repairRequiredSource(recovery) {
    if (recovery.task || this.closing || this.sourceRecoveries.get(recovery.key) !== recovery) return
    if (!this.requiredRecoveryCurrent(recovery)) { this.cancelRequiredRecovery(recovery.key); return }
    if (recovery.source === 'book' && this.publicRealtime?.started) {
      this.publicRealtime.recoverSubscription(recovery.instId, 'books')
      recovery.retryAt = Date.now() + 30_000
      return
    }
    const requestedAt = Date.now(), signal = AbortSignal.any([this.shutdownController.signal, recovery.controller.signal])
    const task = (async () => {
      try {
        if (recovery.source === 'turnover' || recovery.source === 'hourly') {
          const observations = this.observations.get(recovery.instId) ?? {}
          this.observations.set(recovery.instId, observations)
          await this.observeHistoricalSource(recovery.instId, recovery.source, observations, signal, true,
            () => !this.closing && this.sourceRecoveries.get(recovery.key) === recovery && this.requiredRecoveryCurrent(recovery))
          if (signal.aborted || this.sourceRecoveries.get(recovery.key) !== recovery) return
          if (!this.requiredRecoveryCurrent(recovery) && !this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)) { this.cancelRequiredRecovery(recovery.key); return }
          if (!this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)) throw new Error(`The completed ${recovery.source} range is not available.`)
          this.cancelRequiredRecovery(recovery.key)
          // Source availability is independent of the other qualification
          // criteria, including a known spread rejection or an in-flight check.
          this.queueStreamQualification(recovery.instId)
          return
        }
        const observation = recovery.source === 'book'
          ? await this.bookObservation(recovery.instId, signal, 'continuity')
          : (await this.openInterest.observe(signal, 'continuity')).get(recovery.instId)
        if (!observation) throw new Error(`Missing ${recovery.source} observation for ${recovery.instId}.`)
        if (this.closing || signal.aborted || this.sourceRecoveries.get(recovery.key) !== recovery) return
        const observations = this.observations.get(recovery.instId) ?? {}
        const previous = observations[recovery.source]
        const previousTimestamp = number(previous?.sourceTimestamp ?? previous?.value?.ts)
        const sourceTimestamp = number(observation.sourceTimestamp ?? observation.value?.ts)
        if (previousTimestamp !== null && sourceTimestamp !== null && sourceTimestamp < previousTimestamp) throw new Error(`${recovery.source} recovery returned an older observation for ${recovery.instId}.`)
        if (!previous || previous.observedAt < requestedAt) observations[recovery.source] = { ...observation, sourceTimestamp }
        this.observations.set(recovery.instId, observations)
        this.sourceRecoveries.delete(recovery.key)
        this.sourceError(recovery.key, null)
        this.queueStreamQualification(recovery.instId)
      } catch (error) {
        if (!signal.aborted && this.sourceRecoveries.get(recovery.key) === recovery) {
          recovery.retryAt = Math.max(Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(5, recovery.attempts++)),
            recovery.source === 'openInterest' ? this.openInterest.retryAt : 0)
          this.sourceError(recovery.key, error)
        }
      }
    })().finally(() => { recovery.task = null; this.scheduleMarketDeadline() })
    recovery.task = task
    return task
  }

  async bookObservation(instId, signal, priority) {
    try {
      const observation = await this.books.observe(instId, signal, priority, this.observation(this.observations.get(instId) ?? {}, 'book'))
      return { ...observation, source: observation.source ?? 'rest', sourceTimestamp: number(observation.value.ts) }
    } catch (error) {
      signal.throwIfAborted()
      // A native snapshot can retire an obsolete REST acquisition while its
      // consumers still need the now-current book.
      const current = this.observation(this.observations.get(instId) ?? {}, 'book')
      if (current) return current
      throw error
    }
  }

  bookUnsubscribed(instId) {
    const now = Date.now(), published = this.catalog.get(instId), publishedExpiry = this.catalogEntryExpiry(published, now)
    this.bookGenerations.set(instId, (this.bookGenerations.get(instId) ?? 0) + 1)
    this.books.invalidate(instId)
    this.nativeBookDeadlines.delete(instId)
    const observations = this.observations.get(instId)
    if (observations) delete observations.book
    const { depth, slippage } = this.prefs().liquidity
    if (this.closing || !depth.enabled && !slippage.enabled) return
    const record = this.catalogChecks.get(instId)
    if (record) {
      record.status = 'unknown'; record.expiresAt = Math.min(record.expiresAt, now)
      record.result = { ...record.result, eligible: false }
      record.observations = { ...observations }
    }
    this.bufferListRemoval(published, now, publishedExpiry)
    if (published) { published.status = 'unknown'; published.result = { ...published.result, eligible: false }; published.expiresAt = Math.min(publishedExpiry, now) }
    // Unsubscribe callbacks run inside the transport's membership update.
    // Requalification must not re-enter subscription reconciliation.
    this.queueStreamQualification(instId, 'book')
    this.touchList()
    this.scheduleMarketDeadline()
  }

  acceptObservation(instId, key, observation) {
    const observations = this.observations.get(instId) ?? {}, previous = observations[key]
    const timestamp = number(observation.sourceTimestamp ?? observation.value?.ts)
    const previousTimestamp = number(previous?.sourceTimestamp ?? previous?.value?.ts)
    if (timestamp !== null && previousTimestamp !== null && timestamp < previousTimestamp) throw new Error(`${key} returned an older observation for ${instId}.`)
    if (!previous || previous.observedAt < observation.observedAt || timestamp !== null && previousTimestamp !== null && timestamp > previousTimestamp) observations[key] = { ...observation, sourceTimestamp: timestamp }
    this.observations.set(instId, observations)
    return observations[key]
  }

  liquidityInput(instrument, config, observations, now = Date.now()) {
    const configKey = JSON.stringify(config)
    const fresh = key => this.qualificationObservation(observations, key, instrument.instId, configKey, now)
    const turnover = fresh('turnover')?.value, hourly = fresh('hourly')?.value
    // The hourly validator must use the actual retained window's boundary.
    // Live sources and each historical observation retain their own timestamps.
    const asOf = hourly?.asOf ?? closedBoundary('5m', now)
    return { instrument, ticker: fresh('ticker')?.value ?? null, book: fresh('book')?.value ?? null,
      openInterest: fresh('openInterest')?.value ?? null, hourlyCandles: hourly?.rows ?? [],
      turnover24hUSDT: turnover?.turnover ?? null, asOf, config }
  }

  cheapLiquidity(input) {
    const { config } = input
    return this.evaluateLiquidity({ ...input, book: null, config: { ...config, depth: { ...config.depth, enabled: false }, slippage: { ...config.slippage, enabled: false } } })
  }

  observedCandidate(instrument, config, configKey, observations, errors = {}, now = Date.now(), evaluatedResult) {
    let assessed = observations, input = this.liquidityInput(instrument, config, observations, now)
    if (!evaluatedResult && input.book && (config.depth.enabled || config.slippage.enabled) && this.cheapLiquidity(input).status === 'failed') input.book = null
    let result = evaluatedResult ?? this.evaluateLiquidity(input)
    const required = requiredLiquiditySources(config)
    const historical = required.filter(key => key === 'turnover' || key === 'hourly')
    const historicalPending = historical.some(key => observations[key]?.value.asOf !== closedBoundary(key === 'turnover' ? '5m' : '1H', now))
    const previous = this.catalog.get(instrument.instId)
    const retained = historicalPending && this.validCatalogEntry(previous, now)
      && historical.every(key => this.qualificationObservation(previous.observations, key, instrument.instId, configKey, now))
    if (result.status === 'verified' && retained && historical.some(key => observations[key] !== previous.observations[key])) {
      // Source and derived writes can finish separately at an hourly close. Publish
      // the complete historical tuple together, while still checking fresh
      // live evidence and immediately applying any newly proven failure.
      assessed = { ...observations, ...Object.fromEntries(historical.map(key => [key, previous.observations[key]])) }
      input = this.liquidityInput(instrument, config, assessed, now)
      result = this.evaluateLiquidity(input)
    }
    const fresh = key => this.qualificationObservation(assessed, key, instrument.instId, configKey, now)
    const instrumentObservation = this.instrumentObservations.get(instrument.instId)
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted && this.candidateIDs?.has(instrument.instId)
    const metadataFresh = continuousMetadata || instrumentObservation?.expiresAt > now
    const validObservations = required.map(fresh)
    const complete = metadataFresh && validObservations.every(Boolean) && (!historicalPending || retained)
    const status = !metadataFresh ? 'unknown' : result.status === 'verified' && complete ? 'verified' : result.status === 'failed' ? 'failed' : 'unknown'
    const leases = complete ? [continuousMetadata ? { ...instrumentObservation, expiresAt: Number.MAX_SAFE_INTEGER } : instrumentObservation,
      ...required.map((key, index) => ({ observedAt: validObservations[index].observedAt, expiresAt: this.observationExpiry(validObservations[index], key, instrument.instId) }))] : []
    const record = this.catalogRecord({ instrument, ...(instrumentObservation ? { instrumentObservation } : {}),
      ticker: fresh('ticker')?.value ?? {}, result: { ...result, eligible: status === 'verified' },
      status, configKey, observations: { ...assessed }, observationErrors: errors,
      preferencesRevision: this.catalogChecks.get(instrument.instId)?.preferencesRevision ?? 0,
      renewalTarget: status === 'verified' || status === 'unknown' && this.renewalTargets.has(instrument.instId),
      observedAt: leases.length ? Math.min(...leases.map(value => value.observedAt)) : now,
      expiresAt: status === 'verified' ? Math.min(...leases.map(value => value.expiresAt)) : now }, now)
    this.rememberHistoricalAssessment(record, now, true)
    return record
  }

  // Qualification is a local calculation. Source acquisition can be pending
  // without making a threshold edit wait for the exchange or a history job.
  verifyCatalog() {
    const config = this.prefs().liquidity, configKey = JSON.stringify(config), now = Date.now(), verified = []
    for (const instrument of this.instruments.values()) {
      if (this.candidateIDs && !this.candidateIDs.has(instrument.instId)) continue
      const observations = { ...(this.observations.get(instrument.instId) ?? {}) }
      const ticker = this.tickerCache?.values.get(instrument.instId)
      if (this.observationExpiry(ticker, 'ticker', instrument.instId) > now) observations.ticker = ticker
      const record = this.observedCandidate(instrument, config, configKey, observations, {}, now)
      this.catalogChecks.set(instrument.instId, record)
      if (record.status === 'verified') { verified.push(record); this.renewalTargets.set(instrument.instId, instrument) }
      else if (record.status === 'failed') this.renewalTargets.delete(instrument.instId)
    }
    const checks = [...this.catalogChecks.values()]
    if (checks.some(record => record.status !== 'unknown') && this.catalogSource === 'none') this.catalogSource = 'cache'
    this.replaceCatalog(verified)
    this.touchList()
  }

  async tickerObservations(signal, priority = 'background', force = false) {
    if (this.candidateIDs?.size && [...this.candidateIDs].every(id => {
      const observation = this.tickerCache?.values.get(id)
      return observation?.source === 'websocket' && this.observationExpiry(observation, 'ticker', id) > Date.now()
    })) return this.tickerCache.values
    if (!force && this.tickerCache && Date.now() - this.tickerCache.observedAt < CATALOG_RENEW_INTERVAL) return this.tickerCache.values
    if (this.tickerTask && !this.tickerTask.signal.aborted) return this.tickerTask.task
    const task = this.get('/market/tickers', { instType: 'SWAP' }, signal, priority).then(values => {
      if (!Array.isArray(values) || !values.length) throw new Error('OKX returned no swap tickers.')
      const observedAt = Date.now()
      const observations = new Map(values.map(value => [value.instId, { value, observedAt, expiresAt: observedAt + OBSERVATION_TTL }]))
      for (const [id, observation] of this.tickerCache?.values ?? []) if (observation.source === 'websocket' && this.observationExpiry(observation, 'ticker', id) > observedAt) observations.set(id, observation)
      if (!signal.aborted && !this.disposed) this.tickerCache = { values: observations, observedAt }
      for (const [id, value] of observations) if (this.validTicker(value.value)) this.clearTickerFault(id)
      return observations
    }).catch(error => {
      if (!signal.aborted) {
        if (error && typeof error === 'object') this.handledSourceErrors.add(error)
        for (const id of this.candidateIDs ?? this.instruments.keys()) if (this.observationExpiry(this.tickerCache?.values.get(id), 'ticker', id) <= Date.now()) this.tickerFaults.set(id, error)
        if (!this.candidateIDs && !this.instruments.size) this.tickerFaults.set('*', error)
        if (this.tickerFaults.size) this.sourceError('tickers', error)
      }
      throw error
    }).finally(() => { if (this.tickerTask?.task === task) this.tickerTask = null })
    this.tickerTask = { signal, task }
    return task
  }

  async checkCandidate(instrument, config, configKey, signal, priority = 'foreground', options = {}) {
    const key = `${configKey}:${JSON.stringify(instrument)}:${options.localOnly ? 'local' : 'remote'}`
    if (this.candidateTasks.has(key)) return this.candidateTasks.get(key)
    this.pendingCandidates.set(key, { instId: instrument.instId, configKey })
    this.touchList()
    const task = this.evaluateCandidate(instrument, config, configKey, signal, priority, options)
      .finally(() => {
        if (this.candidateTasks.get(key) === task) {
          this.candidateTasks.delete(key); this.pendingCandidates.delete(key); this.touchList()
        }
      })
    this.candidateTasks.set(key, task)
    return task
  }

  readQualificationCandles(query, signal) {
    return new Promise((resolve, reject) => {
      const request = { query, signal, resolve, reject }
      const abort = () => {
        const index = this.qualificationReadQueue.indexOf(request)
        if (index >= 0) this.qualificationReadQueue.splice(index, 1)
        reject(signal.reason)
      }
      if (signal.aborted) { abort(); return }
      request.abort = abort
      signal.addEventListener('abort', abort, { once: true })
      this.qualificationReadQueue.push(request)
      this.drainQualificationReads()
    })
  }

  drainQualificationReads() {
    // Wake only the next reader, rather than every waiting contract after
    // every completion. Network acquisition never occupies these four slots.
    while (this.qualificationReads.size < 4 && this.qualificationReadQueue.length) {
      const request = this.qualificationReadQueue.shift()
      request.signal.removeEventListener('abort', request.abort)
      const pending = Promise.resolve().then(() => {
        request.signal.throwIfAborted()
        return this.store.candles(request.query, 'foreground')
      }).then(request.resolve, request.reject).finally(() => {
        this.qualificationReads.delete(pending)
        this.drainQualificationReads()
      })
      this.qualificationReads.add(pending)
    }
  }

  async observeHistoricalSource(instId, key, observations, signal, acquire, current) {
    const timeframe = key === 'turnover' ? '5m' : '1H', count = key === 'turnover' ? 288 : 24, step = timeframeMilliseconds(timeframe)
    const calculate = (rows, end, from) => {
      if (key === 'turnover') {
        const turnover = quoteTurnover24h(rows, end)
        if (turnover === null) throw new Error('The completed 24-hour quote-volume range is incomplete.')
        return { turnover }
      }
      if (rows.length !== 24 || rows.some((row, index) => row.timestamp !== from + index * step || !row.confirmed || number(row.quoteVolume) === null)) throw new Error('Incomplete hourly source range.')
      return { rows }
    }
    while (current()) {
      signal.throwIfAborted()
      const end = closedBoundary(timeframe), from = end - count * step, through = end - step
      const cached = this.observation(observations, key)
      if (cached?.value.asOf === end) return cached
      const retained = this.historicalWindows.get(`${instId}:${timeframe}`)
      if (retained?.revision === this.liquidityHistoryRevision(instId, timeframe)
        && retained.storeRevision === this.store.candlePriceRevision(instId, timeframe)) {
        const missing = []
        for (let timestamp = from; timestamp <= through; timestamp += step) if (!retained.rows.has(timestamp)) missing.push(timestamp)
        // An intact rolling window needs only its subscribed final. Do not
        // rescan all historical rows or enqueue a repair just to await it.
        if (missing.length === 1 && missing[0] === through && await this.awaitRealtimeCandle({ instrument: instId, timeframe, from: through, through, signal })) {
          const mutation = this.candleMutations.get(instId)
          if (mutation) await abortable(mutation, signal)
          if (!this.historicalWindows.get(`${instId}:${timeframe}`)?.rows.has(through)) this.historicalWindows.delete(`${instId}:${timeframe}`)
          continue
        }
      }
      let revision = this.liquidityHistoryRevision(instId, timeframe), rows, value
      const read = () => {
        const windowKey = `${instId}:${timeframe}`, window = this.historicalWindows.get(windowKey)
        const storeRevision = this.store.candlePriceRevision(instId, timeframe)
        if (window?.revision === revision && window.storeRevision === storeRevision) {
          const rows = [...window.rows.values()].filter(row => row.timestamp >= from && row.timestamp <= through).sort((a, b) => a.timestamp - b.timestamp)
          try { return Promise.resolve({ rows, value: calculate(rows, end, from) }) }
          catch { /* A missing completed slot still needs durable local/source repair. */ }
        }
        const identity = `${instId}:${key}:${end}:${revision}`
        let task = this.historicalSourceReads.get(identity)
        if (!task) {
          task = this.readQualificationCandles({ instrument: instId, timeframe, from, through }, this.shutdownController.signal)
            .then(rows => {
              const value = calculate(rows, end, from)
              if (revision === this.liquidityHistoryRevision(instId, timeframe) && storeRevision === this.store.candlePriceRevision(instId, timeframe)) this.historicalWindows.set(windowKey, { rows: new Map(rows.map(row => [row.timestamp, row])), revision, storeRevision })
              return { rows, value }
            })
            .finally(() => { if (this.historicalSourceReads.get(identity) === task) this.historicalSourceReads.delete(identity) })
          this.historicalSourceReads.set(identity, task)
          this.track(task)
        }
        // One caller retiring cannot cancel another caller's canonical read.
        return abortable(task, signal)
      }
      try {
        ;({ rows, value } = await read())
        while (revision !== this.liquidityHistoryRevision(instId, timeframe)) {
          signal.throwIfAborted(); revision = this.liquidityHistoryRevision(instId, timeframe)
          ;({ rows, value } = await read())
        }
      } catch {
        signal.throwIfAborted()
        value = undefined
        if (revision !== this.liquidityHistoryRevision(instId, timeframe)) continue
        if (!acquire) throw new Error('The completed qualification window is not yet durable.')
        revision = this.liquidityHistoryRevision(instId, timeframe)
        rows = (await this.history.ensurePrices(instId, timeframe, from, through, 'continuity', signal)).rows
      }
      while (revision !== this.liquidityHistoryRevision(instId, timeframe)) {
        signal.throwIfAborted(); revision = this.liquidityHistoryRevision(instId, timeframe)
        ;({ rows, value } = await read())
      }
      signal.throwIfAborted()
      if (!current() || this.observations.get(instId) !== observations) return null
      if (end !== closedBoundary(timeframe)) continue
      value ??= calculate(rows, end, from)
      this.historicalWindows.set(`${instId}:${timeframe}`, { rows: new Map(rows.map(row => [row.timestamp, row])), revision, storeRevision: this.store.candlePriceRevision(instId, timeframe) })
      if (key === 'turnover') this.cacheRankingCandles(instId, rows)
      const observation = { value: { asOf: end, ...value }, observedAt: Date.now(), expiresAt: end + step }
      this.historicalInputs.set(observation, new Map(rows.map(row => [row.timestamp, row.quoteVolume])))
      observations[key] = observation
      return observation
    }
    return null
  }

  async evaluateCandidate(instrument, config, configKey, signal, priority, { localOnly = false, sources = {} } = {}) {
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const asOf = closedBoundary('5m')
    const instId = instrument.instId, observations = this.observations.get(instId) ?? {}
    // Keep in-flight historical facts in the same object that durable writes
    // invalidate. A correction during a live request cannot resurrect a copy.
    if (this.currentCandidate(instrument, configKey, signal)) this.observations.set(instId, observations)
    const errors = {}
    const ticker = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(ticker, 'ticker', instId) > Date.now()) observations.ticker = ticker
    // Bulk spread observations can exclude a contract immediately. Never
    // download history or books to prove conditions that cannot admit it.
    const early = this.observedCandidate(instrument, config, configKey, { ticker: observations.ticker })
    if (early.status === 'failed') {
      return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
    }
    const observeOpenInterest = async () => {
      try {
        if (!sources.openInterest) {
          const task = this.openInterest.observe(signal, priority).catch(error => {
            if (sources.openInterest === task) sources.openInterest = null
            throw error
          })
          sources.openInterest = task
        }
        let values = await sources.openInterest
        if (values.values().next().value?.expiresAt <= Date.now()) values = await this.openInterest.observe(signal, priority)
        const observation = values.get(instId)
        if (!observation) throw new Error(`Missing open-interest observation for ${instId}.`)
        if (this.currentCandidate(instrument, configKey, signal)) this.acceptObservation(instId, 'openInterest', observation)
        delete errors.openInterest
      } catch (error) { errors.openInterest = error instanceof Error ? error.message : String(error) }
    }
    if (!localOnly && config.openInterest.enabled && !this.observation(observations, 'openInterest')) await observeOpenInterest()
    // An authoritative bulk rejection must not queue historical downloads or
    // local scans ahead of the contracts that can actually enter the list.
    if (this.cheapLiquidity(this.liquidityInput(instrument, config, observations)).status === 'failed') {
      return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
    }
    const observeHistory = async key => {
      try { await this.observeHistoricalSource(instId, key, observations, signal, !localOnly, () => this.currentCandidate(instrument, configKey, signal)) }
      catch (error) { errors[key] = error instanceof Error ? error.message : String(error) }
    }
    const tasks = []
    if (config.volume24h.enabled && !(this.observation(observations, 'turnover')?.value.asOf === asOf)) tasks.push(observeHistory('turnover'))
    if (config.volumeStability.enabled && !(this.observation(observations, 'hourly')?.value.asOf === closedBoundary('1H', asOf))) tasks.push(observeHistory('hourly'))
    await Promise.all(tasks)
    // Fine-price acquisition may derive and correct an hourly window whose
    // independent read already finished. Reuse the final committed windows
    // before admission; a failed acquisition is not retried by this check.
    for (const [key, timeframe, rule] of [['turnover', '5m', 'volume24h'], ['hourly', '1H', 'volumeStability']]) {
      if (config[rule].enabled && !errors[key]
        && this.observation(observations, key)?.value.asOf !== closedBoundary(timeframe)) await observeHistory(key)
    }
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const historicalInput = this.liquidityInput(instrument, config, observations)
    const historicalResult = evaluateLiquidity({ instrument, config, asOf: historicalInput.asOf,
      turnover24hUSDT: historicalInput.turnover24hUSDT, hourlyCandles: historicalInput.hourlyCandles })
    // Historical repairs can take minutes. Obtain live liquidity only after
    // those repairs; acquire only a missing contract's bounded ticker fallback.
    // A known failing historical condition already excludes a contract; it
    // must not consume the live request budget needed by qualified contracts.
    const live = []
    if (!localOnly && historicalResult.status !== 'failed' && config.openInterest.enabled && !this.observation(observations, 'openInterest')) live.push(observeOpenInterest())
    if (!localOnly && historicalResult.status !== 'failed') live.push(this.tickerObservation(instId, signal, priority).then(value => {
      if (!value) throw new Error(`Missing ticker observation for ${instId}.`)
      if (this.currentCandidate(instrument, configKey, signal)) observations.ticker = value
    }).catch(error => { errors.ticker = error instanceof Error ? error.message : String(error) }))
    if (!localOnly && !this.publicRealtime?.started && historicalResult.status !== 'failed' && (config.depth.enabled || config.slippage.enabled) && !this.observation(observations, 'book')) live.push((async () => {
      try {
        const observation = await this.bookObservation(instId, signal, priority)
        if (this.currentCandidate(instrument, configKey, signal)) this.acceptObservation(instId, 'book', observation)
      } catch (error) { errors.book = error instanceof Error ? error.message : String(error) }
    })())
    await Promise.all(live)
    return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
  }

  async publishCandidate(instrument, config, configKey, signal, observations, errors) {
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const instId = instrument.instId
    this.observations.set(instId, observations)
    const now = Date.now()
    const currentAsOf = closedBoundary('5m')
    const record = this.observedCandidate(instrument, config, configKey, observations, errors, now)
    record.preferencesRevision = this.metadata.getSettings().revision
    const { status } = record
    if (status === 'unknown') this.recoverRequiredSources(instId)
    this.metadata.putCatalogEntry(record)
    this.catalogChecks.set(instId, record)
    this.scheduleSubscriptions()
    if (status === 'verified') this.renewalTargets.set(instId, instrument)
    else if (status === 'failed') this.renewalTargets.delete(instId)
    this.catalogPublications.set(instId, { record, signal })
    // A bulk snapshot completes many candidates in the same turn. Publish
    // them together instead of rebuilding every row and subscription N times.
    this.catalogPublicationTask ??= Promise.resolve().then(() => {
      this.catalogPublicationTask = null
      const records = [...this.catalogPublications.values()]; this.catalogPublications.clear()
      if (this.disposed) return
      const next = new Map(this.catalog)
      for (const { record, signal } of records) {
        if (this.catalogChecks.get(record.instrumentID) !== record || !this.currentCandidate(record.instrument, record.configKey, signal)) continue
        // The subscription ACK may have arrived between validation and this
        // deferred publication. Bind continuity once both facts are present.
        this.rememberHistoricalAssessment(record)
        if (this.validCatalogEntry(record)) next.set(record.instrumentID, record)
        else next.delete(record.instrumentID)
      }
      this.catalogSource = 'live'
      this.catalogUpdatedAt = Date.now()
      this.replaceCatalog([...next.values()])
      this.touchList()
    })
    await this.catalogPublicationTask
    if (this.catalogChecks.get(instId) !== record || !this.currentCandidate(instrument, configKey, signal)) return
    if (status === 'verified' && this.validCatalogEntry(record)) {
      this.track(this.updateRanking(instId, { ensure: true, asOf: currentAsOf }))
    }
  }

  currentCandidate(instrument, configKey, signal) {
    const current = this.instruments.get(instrument.instId)
    return !this.disposed && !signal.aborted && this.catalogCriteriaKey() === configKey
      && (!this.candidateIDs || this.candidateIDs.has(instrument.instId))
      && (!current || JSON.stringify(current) === JSON.stringify(instrument))
  }

  waitForInstrumentSubscription(signal) {
    if (this.instrumentStream || !this.publicRealtime.started || !this.publicRealtime.subscriptions.has('instruments:SWAP')) return Promise.resolve()
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason) }
      const cleanup = () => {
        clearTimeout(timer)
        this.instrumentSubscriptionWaiters.delete(finish)
        signal.removeEventListener('abort', abort)
      }
      const timer = setTimeout(finish, TICKER_BOOTSTRAP_MS)
      this.instrumentSubscriptionWaiters.add(finish)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  async catalogInstruments(configKey, signal, reuse) {
    // Normal startup obtains its baseline after the subscription ack. REST
    // remains available when the control stream cannot establish itself.
    if (!this.instrumentSnapshotReady) await this.waitForInstrumentSubscription(signal)
    const stream = this.instrumentStream
    if (stream && !stream.signal.aborted) {
      await abortable(stream.task, signal)
      if (this.instrumentStream === stream && stream.synchronized && !stream.signal.aborted) return [...this.candidateIDs].map(id => this.instruments.get(id))
      throw new Error('The instruments stream has not synchronized its authoritative snapshot.')
    }
    if (reuse && this.instrumentSnapshotReady && Date.now() - this.instrumentSnapshotObservedAt < OBSERVATION_TTL) return [...this.candidateIDs].map(id => this.instruments.get(id))
    return this.discoverInstruments(configKey, signal, 'foreground')
  }

  async discoverInstruments(configKey, signal, priority) {
    try {
      if (!this.instrumentTask || this.instrumentTask.signal.aborted) {
        const version = this.instrumentEventVersion
        const task = this.get('/public/instruments', { instType: 'SWAP' }, signal, priority)
          .finally(() => { if (this.instrumentTask?.task === task) this.instrumentTask = null })
        this.instrumentTask = { signal, task, version }
      }
      const acquisition = this.instrumentTask
      const instruments = await abortable(acquisition.task, signal)
      signal.throwIfAborted()
      if (!Array.isArray(instruments) || !instruments.length) throw new Error('OKX returned no swap instruments; market verification is unavailable.')
      const definitions = new Map(instruments.map(value => [value.instId, value]))
      // A REST cache may be older than a delta received during this acquisition.
      for (const [instId, delta] of this.instrumentDeltas) if (this.instrumentStream && !this.instrumentStream.signal.aborted || delta.version > acquisition.version) {
        definitions.set(instId, { ...(definitions.get(instId) ?? {}), ...delta.value })
      }
      if (![...definitions.values()].some(eligibleInstrument)) throw new Error('No supported swap instrument metadata could be verified. Retrying automatically.')
      this.instrumentSnapshotReady = true
      this.instrumentSnapshotObservedAt = Date.now()
      const candidates = this.installInstruments(definitions)
      this.sourceError('instruments', null)
      return candidates
    } catch (error) {
      if (!signal.aborted) this.sourceError('instruments', error)
      throw error
    }
  }

  installInstruments(definitions, observedIDs) {
    this.instrumentDefinitions = definitions
    const candidates = [...definitions.values()].filter(eligibleInstrument).map(value => value.ctMult === '' ? { ...value, ctMult: '1' } : value)
    const nextIDs = new Set(candidates.map(value => value.instId))
    const removedIDs = [...(this.candidateIDs ?? [])].filter(id => !nextIDs.has(id))
    if (removedIDs.length) this.track(this.history.removeTargets(removedIDs))
    this.liveStatistics.remove(removedIDs)
    this.candleDerivations.remove(removedIDs)
    for (const instId of removedIDs) {
      this.instrumentGenerations.set(instId, (this.instrumentGenerations.get(instId) ?? 0) + 1)
      // Invalidate in-flight latest reads even before this series has ever
      // received a forming candle. Re-listing retains the newer source epoch.
      for (const timeframe of CHART_TIMEFRAMES) {
        const key = `${instId}:${timeframe}`
        this.liveSourceRevisions.set(key, (this.liveSourceRevisions.get(key) ?? 0) + 1)
      }
      for (const recovery of this.sourceRecoveries.values()) if (recovery.instId === instId) this.cancelRequiredRecovery(recovery.key)
      this.tickerSubscriptions.delete(instId)
      this.cancelTickerRecovery(instId)
      this.clearTickerFault(instId)
      this.observations.delete(instId)
      this.bookRetirements.delete(instId)
      this.books.invalidate(instId)
      this.instrumentObservations.delete(instId)
      this.tickerCache?.values.delete(instId)
    }
    this.candidateIDs = nextIDs
    this.clearTickerFault()
    for (const instId of this.renewalTargets.keys()) if (!nextIDs.has(instId)) this.renewalTargets.delete(instId)
    for (const instId of this.catalogChecks.keys()) if (!nextIDs.has(instId)) this.catalogChecks.delete(instId)
    for (const instrument of candidates) {
      const previous = this.instruments.get(instrument.instId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(instrument)) {
        this.instrumentGenerations.set(instrument.instId, (this.instrumentGenerations.get(instrument.instId) ?? 0) + 1)
        const observations = this.observations.get(instrument.instId)
        if (observations) delete observations.book
        this.books.invalidate(instrument.instId)
      }
      this.instruments.set(instrument.instId, instrument)
      if (!observedIDs || observedIDs.has(instrument.instId)) this.instrumentObservations.set(instrument.instId, { observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_TTL })
      if (this.renewalTargets.has(instrument.instId)) this.renewalTargets.set(instrument.instId, instrument)
    }
    this.updateSubscriptions()
    for (const key of this.liveCandles.keys()) if (!nextIDs.has(key.slice(0, key.lastIndexOf(':')))) {
      this.liveCandles.delete(key); this.liveCandleSources.delete(key)
    }
    const configKey = this.catalogCriteriaKey(), signal = this.shutdownController.signal
    this.replaceCatalog([...this.catalog.values()].filter(entry => this.currentCandidate(entry.instrument, configKey, signal) && this.validCatalogEntry(entry)))
    return candidates
  }

  receiveInstruments(records, context) {
    if (this.closing || this.disposed || context.signal.aborted || this.instrumentStream?.signal !== context.signal) return
    const definitions = new Map(this.instrumentDefinitions), changed = []
    for (const value of records) {
      if (typeof value?.instId !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/.test(value.instId)) continue
      const patch = { ...(this.instrumentDeltas.get(value.instId)?.value ?? {}), ...value }
      const merged = { ...(definitions.get(value.instId) ?? {}), ...patch }
      definitions.set(value.instId, merged)
      this.instrumentDeltas.set(value.instId, { version: ++this.instrumentEventVersion, value: patch })
      changed.push(value.instId)
    }
    if (!changed.length) return
    // An incremental message cannot define the complete initial universe.
    // Keep it buffered until the first authoritative REST snapshot arrives.
    if (!this.instrumentSnapshotReady) return
    this.installInstruments(definitions, new Set(changed))
    for (const instId of changed) this.queueStreamQualification(instId)
    this.touchList()
  }

  async synchronizeInstruments(context) {
    if (this.closing || context.signal.aborted) return
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    this.instrumentRetryTimer = null
    const stream = { signal: context.signal, synchronized: false, delay: 1_000, task: null }
    this.instrumentStream = stream
    this.instrumentDeltas.clear()
    const synchronize = async () => {
      try {
        // Start the authoritative snapshot after acknowledgement. This closes
        // the gap before subscription; deltas received during HTTP are merged.
        await this.instrumentTask?.task.catch(() => undefined)
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        const signal = AbortSignal.any([stream.signal, this.shutdownController.signal])
        await this.discoverInstruments(this.catalogCriteriaKey(), signal, 'foreground')
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        stream.synchronized = true
        this.verifyCatalog()
        // Startup refresh already owns qualification and its priority order.
        // Reconnection reuses that coordinator instead of admitting a second
        // exchange-wide scan before the shared ticker snapshot has arrived.
        if (!this.refreshing) this.track(this.refresh({ reuse: true }))
        this.sourceError('instruments', null)
      } catch (error) {
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        this.sourceError('instruments', error)
        this.instrumentRetryTimer = setTimeout(() => { this.instrumentRetryTimer = null; stream.task = synchronize(); this.track(stream.task) }, stream.delay)
        stream.delay = Math.min(30_000, stream.delay * 2)
        this.instrumentRetryTimer.unref?.()
      }
    }
    stream.task = synchronize()
    for (const finish of this.instrumentSubscriptionWaiters) finish()
    return stream.task
  }

  instrumentStreamDisconnected(context) {
    for (const finish of this.instrumentSubscriptionWaiters) finish()
    if (this.instrumentStream?.signal !== context.signal) return
    this.instrumentStream = null
    this.instrumentDeltas.clear()
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    this.instrumentRetryTimer = null
    if (!this.closing && !this.disposed) { this.verifyCatalog(); this.touchList() }
  }

  async renewCatalog() {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.renewing) return this.renewing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = JSON.stringify(config)
    this.renewalController = controller
    this.catalogControllers.add(controller)
    this.renewalStartedAt = Date.now()
    let collecting = false
    this.renewing = (async () => {
      // Renewal must verify current contract units and trading state as well
      // as prices. An outage cannot keep extending old instrument metadata.
      await Promise.all([
        this.discoverInstruments(configKey, controller.signal, 'foreground'),
        this.tickerObservations(controller.signal, 'foreground'),
      ])
      if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
      this.verifyCatalog()
      // An explicit renewal does not wait for historical windows before
      // admitting independent candidates.
      const sources = {}
      const checks = [...this.renewalTargets.values()].map(
        instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground', { sources }))
      collecting = true
      this.track(Promise.allSettled(checks).finally(() => this.catalogControllers.delete(controller)))
      this.sourceError('refresh', null)
    })()
      .catch(error => {
        if (!controller.signal.aborted && !(error && typeof error === 'object' && this.handledSourceErrors.has(error))) this.sourceError('refresh', error)
      })
      .finally(() => {
        if (!collecting) this.catalogControllers.delete(controller)
        this.renewing = null
        if (this.renewalController === controller) this.renewalController = null
        this.touchList()
      })
    this.touchList()
    return this.renewing
  }

  async refresh({ reuse = false } = {}) {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.refreshing) return this.refreshing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = JSON.stringify(config)
    this.refreshController = controller
    this.catalogControllers.add(controller)
    const startedAt = Date.now()
    this.refreshStartedAt = startedAt
    this.refreshing = (async () => {
      try {
        this.verifyCatalog()
        const [candidates] = await Promise.all([
          this.catalogInstruments(configKey, controller.signal, reuse),
          ...(!reuse || !this.tickerFaults.size ? [this.tickerObservations(controller.signal, 'foreground', !reuse)] : []),
        ])
        if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
        this.verifyCatalog()
        // Previously qualified contracts get checked first, independently of
        // their position in the exchange's instrument response.
        candidates.sort((a, b) => Number(this.renewalTargets.has(b.instId)) - Number(this.renewalTargets.has(a.instId)))
        // A successful check publishes independently; the first row does not wait for the full exchange scan.
        const sources = {}
        await Promise.all(candidates.filter(instrument => !reuse || this.catalogChecks.get(instrument.instId)?.status === 'unknown')
          .map(instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground', { sources })))
        if (!controller.signal.aborted && this.catalogCriteriaKey() === configKey) {
          this.lastRefreshAt = startedAt
          this.sourceError('refresh', null)
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed && !(error && typeof error === 'object' && this.handledSourceErrors.has(error))) this.sourceError('refresh', error)
      } finally {
        this.catalogControllers.delete(controller)
        this.pruneCatalog()
        if (this.refreshController === controller) this.refreshController = null
        this.refreshing = null
        this.touchList()
      }
    })()
    this.touchList()
    return this.refreshing
  }

  async reconfigure(previousPreferences) {
    await this.ready
    const current = this.prefs(), previous = validatePreferences(previousPreferences)
    const liquidityChanged = JSON.stringify(previous.liquidity) !== JSON.stringify(current.liquidity)
    if (previous.chartTimeframe !== current.chartTimeframe) this.preparedCharts.sourceStateChanged()
    if (!liquidityChanged && previous.rankingLookback === current.rankingLookback) return
    if (liquidityChanged) {
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
      const configKey = JSON.stringify(current.liquidity)
      if (this.autoRefresh) this.track(Promise.allSettled([this.refreshing, this.renewing].filter(Boolean)).then(() => {
        if (!this.closing && !this.disposed && this.catalogCriteriaKey() === configKey) return this.refresh({ reuse: true })
      }))
    }
    if (previous.rankingLookback !== current.rankingLookback) {
      for (const instId of new Set([...this.catalog.keys(), ...this.listRemovals.keys()])) this.track(this.updateRanking(instId, { ensure: true }))
    }
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
    return { id: job.id, phase: ['queued', 'running', 'paused'].includes(job.status) ? 'running' : job.status,
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
      for (const instrument of this.instruments.values()) for (const timeframe of CHART_TIMEFRAMES) {
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

  async snapshot({ sinceRevision, serviceSession } = {}) {
    await this.ready
    const { rows, turnoverOrder, qualifiedCount, current: listCurrent } = this.canonicalMarketList()
    const configKey = this.catalogCriteriaKey()
    const pendingIDs = new Set([...this.pendingCandidates.values()].filter(value => value.configKey === configKey).map(value => value.instId))
    for (const recovery of this.sourceRecoveries.values()) pendingIDs.add(recovery.instId)
    for (const instId of this.tickerRecoveries.keys()) pendingIDs.add(instId)
    // A live notification can reach IPC before an already-due deadline gets
    // its event-loop turn. Count that admitted work without starting it here.
    if (this.autoRefresh && this.marketDeadlineTimer) {
      const now = Date.now()
      for (const [instId, deadline] of this.marketDeadlines) if (deadline <= now) pendingIDs.add(instId)
    }
    const pending = pendingIDs.size
    const catalogProgress = { total: this.candidateIDs?.size ?? this.catalogChecks.size, completed: this.catalogChecks.size, pending, verified: 0, failed: 0, unknown: 0 }
    let unavailableContracts = 0
    for (const record of this.catalogChecks.values()) {
      const status = record.status === 'verified' && !this.validCatalogEntry(record) ? 'unknown' : record.status
      catalogProgress[status] += 1
      if (status === 'unknown' && !pendingIDs.has(record.instrumentID)) unavailableContracts += 1
    }
    // A native close expires the old rolling window before its final candle
    // arrives. Active revalidation is pending work, not a source failure.
    const unavailable = !qualifiedCount && unavailableContracts > 0
      ? `Market verification is unavailable for ${unavailableContracts} contracts because required observations are missing or expired.${pending > 0 || this.refreshing || this.renewing ? ' Acquiring current observations.' : ''}` : ''
    const status = { error: this.error || unavailable, loading: this.refreshing !== null || this.renewing !== null || pending > 0,
      catalogProgress,
      updatedAt: this.listUpdatedAt ?? this.catalogUpdatedAt,
      catalogSource: this.catalogSource, realtimeState: this.realtimeState() }
    const metadata = { ...status, revision: this.revision, serviceSession: this.serviceSession }
    // A source or retirement deadline can reach IPC before its callback. Never
    // hide a changed projection or ranking boundary behind a version hit.
    const current = this.marketBoundary === closedBoundary('5m') && listCurrent
    if (current && serviceSession === this.serviceSession && sinceRevision === this.revision) return { ...metadata, unchanged: true }
    return { ...metadata, rows, turnoverOrder }
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
    this.unsubscribeStore?.()
    for (const instId of this.tickerRecoveries.keys()) this.cancelTickerRecovery(instId)
    this.tickerSubscriptions.clear()
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    if (this.qualificationImmediate) clearImmediate(this.qualificationImmediate)
    if (this.marketPublicationTimer) clearTimeout(this.marketPublicationTimer)
    if (this.streamQualificationTimer) clearTimeout(this.streamQualificationTimer)
    if (this.liveStatisticsTimer) clearTimeout(this.liveStatisticsTimer)
    this.marketListeners.clear()
    this.auditListeners.clear()
    this.downloadListeners.clear()
    this.qualificationQueue.clear()
    this.disposeTask = (async () => {
      try { await this.ready } catch { if (this.ownsMetadata) this.metadata?.close(); return }
      const failures = []
      const settle = async operations => {
        const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      }
      // A confirmed stream event resolves only after its durable write. Drain it before aborting source work.
      await settle([() => this.realtime?.close(), () => this.publicRealtime?.close()])
      this.candleDerivations.close()
      await settle([() => this.streamLiquidity?.close()])
      this.disposed = true
      this.refreshController?.abort()
      this.renewalController?.abort()
      for (const controller of this.catalogControllers) controller.abort()
      this.shutdownController.abort()
      for (const controller of this.abortControllers) controller.abort()
      await settle([() => this.historyDownload.close()])
      await settle([() => this.history.close()])
      await settle([() => this.preparedCharts.dispose()])
      await Promise.allSettled([this.refreshing, this.renewing, this.drainRequestQueues(), ...this.candidateTasks.values(), ...this.barTasks, ...this.backgroundTasks, ...this.rankingTasks.values(), ...this.candleMutations.values(), ...this.livePrefixTasks.values()].filter(Boolean))
      await settle([() => this.flushRankingPersistence()])
      if (this.ownsMetadata) await settle([() => this.metadata.close()])
      if (failures.length) throw new AggregateError(failures, `Market service shutdown failed: ${failures.map(error => error?.message ?? String(error)).join('; ')}`)
    })()
    return this.disposeTask
  }
}
