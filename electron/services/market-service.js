import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { evaluateMarketOpportunity, summarizeMarketBars } from './market-metrics.js'
import { PreparedChartPipeline } from './prepared-chart-service.js'
import { MetadataStore, DEFAULT_PREFERENCES, validatePreferences } from './metadata-store.js'
import { MarketHistory } from './market-history.js'
import { eligibleInstrument, evaluateLiquidity, createLiquidityEvaluator, quoteTurnover24h } from './liquidity.js'
import { rankingFromCandles, compareRanking } from './ranking.js'
import { RealtimeMarket } from './realtime-market.js'
import { RealtimePublicMarket } from './realtime-public-market.js'
import { LiveStatistics } from './live-statistics.js'
import { StreamLiquidityEvaluator } from './stream-liquidity.js'
import { MarketOpenInterest } from './market-open-interest.js'
import { statisticsMask, statisticsVersionFor, validTakerVolumes, STATISTICS_OI, STATISTICS_TAKER } from './statistics-state.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const FIVE_MINUTES = 300_000
const LIST_TIMEFRAMES = ['5m', '15m', '1H']
const OBSERVATION_TTL = 90_000
const TICKER_BOOTSTRAP_MS = 10_000
const CATALOG_RENEW_INTERVAL = 30_000
const LATEST_CANDLE_REFRESH = 60_000
const HISTORICAL_STATISTICS_REFRESH = 6 * 3_600_000
const REQUEST_TIMEOUT = 12_000
const RETRY_DELAYS = [1_000]
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, prefetch: 1, statistics: 2, continuity: 2, foreground: 3, repair: 3, prepared: 3, interactive: 4 }
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, books: 50, instruments: 100, tickers: 100, openInterest: 100, market: 80 })
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
const statisticsExpiryAt = (timeframe, end, observedAt = Date.now()) => observedAt
  + (end >= observedAt - timeframeMilliseconds(timeframe) * 2 ? LATEST_CANDLE_REFRESH : HISTORICAL_STATISTICS_REFRESH)

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
  next.statisticsVersion = sources ? statisticsVersionFor(sources, next) : null
  for (const source of [STATISTICS_OI, STATISTICS_TAKER]) {
    const field = statisticsExpiryField(source)
    const missing = source === STATISTICS_OI ? next.oi === null : next.buy === null || next.sell === null
    // A price correction can invalidate a previously genuine zero Taker pair.
    // That is new missing coverage, not a new successful empty HTTP response.
    const invalidatedTaker = source === STATISTICS_TAKER && !volumes && (candle.buy != null || candle.sell != null)
    next[field] = sources & source && missing
      ? number(candle[field]) ?? (invalidatedTaker ? 0 : statisticsExpiryAt(candle.timeframe, candle.timestamp, number(candle.writtenAt) ?? 0))
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

function marketRow(instrument, ticker, result, bars = [], bollExpansion) {
  const last = number(ticker.last), metrics = summarizeMarketBars(bars), { latest } = metrics
  const row = {
    instId: instrument.instId,
    turnover24hUSDT: result.turnover,
    // The ticker is the freshest trade price; indicator readings remain tied
    // to the completed, persisted period represented by `latest`.
    price: latest?.close ?? last,
    lastPrice: last,
    priceChange: metrics.priceChange,
    currentLow: latest?.low ?? number(ticker.low24h),
    currentHigh: latest?.high ?? number(ticker.high24h),
    ema200Signal: metrics.ema200Signal,
    buy: metrics.buy,
    sell: metrics.sell,
    takerRatio: metrics.takerRatio,
    oiChange: metrics.oiChange,
    highBreakout: metrics.highBreakout,
    lowBreakdown: metrics.lowBreakdown,
    highBreakout96: metrics.highBreakout96,
    lowBreakdown96: metrics.lowBreakdown96,
    roc: latest?.roc ?? null,
    maroc: latest?.maroc ?? null,
    rocChange: latest?.rocChange ?? null,
    marocChange: latest?.marocChange ?? null,
    rsi6: latest?.rsi6 ?? null,
    rsi12: latest?.rsi12 ?? null,
    rsi24: latest?.rsi24 ?? null,
    bollAboveBand: latest?.bandPosition ?? null,
    bollExpansion: bollExpansion === undefined ? metrics.bollExpansion : bollExpansion,
  }
  return {
    ...row,
    opportunity: evaluateMarketOpportunity({
      ema200Signal: row.ema200Signal,
      priceChange: row.priceChange,
      roc: row.roc,
      maroc: row.maroc,
      rsi6: row.rsi6,
      rsi12: row.rsi12,
      rsi24: row.rsi24,
      takerRatio: row.takerRatio,
      oiChange: row.oiChange,
      bollAboveBand: row.bollAboveBand,
      bollExpansion: row.bollExpansion,
      highBreakout: row.highBreakout,
      lowBreakdown: row.lowBreakdown,
    }),
  }
}

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
    this.catalogPublications = new Map()
    this.catalogPublicationTask = null
    this.catalogChecks = new Map()
    this.renewalTargets = new Map()
    this.candidateTasks = new Map()
    this.pendingCandidates = new Map()
    this.catalogControllers = new Set()
    this.qualificationReads = new Set()
    this.historicalSourceReads = new Map()
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
    this.qualificationQueue = new Set()
    this.qualificationImmediate = null
    this.marketDeadlineTimer = null
    this.marketDeadlineAt = null
    this.marketDeadlines = new Map()
    this.marketBoundary = closedBoundary('5m')
    this.processingMarketDeadline = false
    this.renewing = null
    this.instruments = new Map()
    this.instrumentDefinitions = new Map()
    this.instrumentSnapshotReady = false
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
    this.listRows = new Map()
    this.listUpdatedAt = new Map()
    this.listProjectionTasks = new Map()
    this.listProjectionResults = new Map()
    this.listProjectionFailures = new Map()
    this.listProjectionDataVersions = new Map()
    this.listProjectionStoreRevisions = new Map()
    this.dataRevisions = new Map()
    this.liveCandles = new Map()
    this.liveCandleSources = new Map()
    this.liveReceivedAt = new Map()
    this.sourceRecoveries = new Map()
    this.liveStatistics = new LiveStatistics()
    this.streamQualifications = new Set()
    this.streamQualificationTimer = null
    this.streamEvaluations = new Map()
    this.streamLiquidity = null
    this.liveStatisticsQueue = new Set()
    this.liveStatisticsTimer = null
    this.historyTargets = new Map()
    this.candleMutations = new Map()
    this.barTasks = new Set()
    this.backgroundTasks = new Set()
    this.requestLanes = new Map(Object.entries(REQUEST_LANE_INTERVALS).map(([name, interval]) => [name, { name, interval, queue: [], task: null, running: false, active: new Map(), wake: null, nextAt: 0, rateLimitedUntil: 0 }]))
    this.abortControllers = new Set()
    this.shutdownController = new AbortController()
    this.revision = 0
    this.marketListeners = new Set()
    this.marketPublicationTimer = null
    this.serviceSession = randomUUID()
    this.auditListeners = new Set()
    this.auditRevision = 0
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
    this.chartSubscriptions = []
    this.latestAuditID = null
    // The proxy admits no historical work until durable metadata has opened.
    const history = Object.fromEntries(['ensurePrices', 'ensureStatistics', 'latest'].map(method => [method, async (...args) => { await this.ready; return this.history[method](...args) }]))
    this.preparedCharts = new PreparedChartPipeline({ store, history, normalize: normalizedStatistics, revision: instId => this.dataRevision(instId), instrument: instId => this.instruments.get(instId),
      streaming: (instId, timeframe) => this.realtime?.isSubscribed(instId, timeframe) ?? false })
    this.ready = this.initialize()
    this.unsubscribeStore = this.store.subscribe?.(change => {
      if (!change.imported || this.closing) return
      this.markChartDataChanged(change.instrument)
      if (change.priceFrom !== null) {
        this.preparedCharts.invalidate(change.instrument, change.timeframe)
        this.invalidateLiquidityHistory(change.instrument, null, change.timeframe)
        this.scheduleQualification(change.instrument, change.timeframe)
        if (change.timeframe === '5m') this.track(this.updateRanking(change.instrument))
      } else this.track(this.preparedCharts.observeStatistics(change.instrument, change.timeframe, change.from, change.through))
      this.scheduleListProjection(change.instrument)
    })
  }

  prefs() { return validatePreferences(this.preferences()) }
  listTimeframe(timeframe) { return LIST_TIMEFRAMES.includes(timeframe) ? timeframe : this.prefs().chartTimeframe }
  listKey(instId, timeframe) { return `${timeframe}:${instId}` }
  catalogCriteriaKey() { return JSON.stringify(this.prefs().liquidity) }
  catalogEntry(instId) { return this.catalog.get(instId) }
  touchList() {
    this.revision += 1
    if (!this.marketListeners.size || this.marketPublicationTimer || this.closing) return
    // Coalesce a batch of source/projection changes into one renderer wakeup.
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
      get: (path, parameters, signal, priority) => this.get(path, parameters, signal, priority),
      parseCandle: candle,
      persistCandles: (instId, rows, options) => this.persistCandles(instId, rows, typeof options === 'string' ? { priority: options } : options),
      persistStatistics: (instrument, timeframe, end, source, values, range, priority) => this.persistStatisticsSource(instrument, timeframe, end, source, values, this.shutdownController.signal, priority, false, { range }),
      instrument: instId => this.instruments.get(instId),
      onLive: (instId, timeframe, row) => this.setLive(instId, timeframe, row),
      replaceCandles: (range, rows, priority) => this.replaceCandles(range, rows, priority),
      onProgress: task => this.onHistoryProgress(task),
      onAuditCheckpoint: job => this.onAuditCheckpoint(job),
    })
    await this.history.ready
    const audits = this.history.audit.list().sort((a, b) => b.updatedAt - a.updatedAt)
    this.latestAuditID = audits[0]?.id ?? null
    if (audits.length) this.publishAudit(this.auditSnapshot(audits[0]))
    this.readCatalog()
    this.realtime = new RealtimeMarket({
      parseCandle: candle,
      onState: state => {
        if (this.realtimeStatus !== state.status) {
          this.realtimeStatus = state.status; this.touchList()
          if (!this.closing) this.preparedCharts.sourceStateChanged()
        }
      },
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      onForming: (row, context) => { this.track(Promise.resolve(this.setLive(row.instrument, row.timeframe, row, context))) },
      onConfirmed: async row => {
        await this.persistCandles(row.instrument, [row])
        // Native statistics remain authoritative for completed periods. Repair
        // this just-closed slot ahead of the multi-day background archive.
        this.track(this.history.ensureStatistics(row.instrument, row.timeframe, row.timestamp, row.timestamp, 'continuity', this.shutdownController.signal))
        const live = this.liveCandles.get(`${row.instrument}:${row.timeframe}`)
        if (!live || live.timestamp <= row.timestamp) this.track(Promise.resolve(this.setLive(row.instrument, row.timeframe, null)))
        this.track(this.updateRanking(row.instrument))
      },
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
      },
      onUnsubscribed: (instId, channel, context) => {
        if (channel === 'tickers') this.tickerDisconnected([instId], context)
      },
      onState: state => {
        if (this.publicRealtimeStatus !== state.status) { this.publicRealtimeStatus = state.status; this.touchList() }
      },
      onDisconnect: (ids, context) => {
        this.tickerDisconnected(ids, context)
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
      && entry.configKey === this.catalogCriteriaKey() && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now)
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
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.catalog])
    this.catalog = next
    for (const entry of next.values()) this.instruments.set(entry.instrument.instId, entry.instrument)
    if (changed) { this.catalogRevision += 1; this.touchList() }
    for (const timeframe of new Set([this.prefs().chartTimeframe, ...this.listRows.keys()])) {
      this.ensureListRows(timeframe)
      for (const instId of next.keys()) this.track(this.projectListEntry(instId, timeframe))
    }
    for (const instId of next.keys()) if (!previous.has(instId)) this.track(this.updateRanking(instId, { ensure: true }))
    for (const key of this.listProjectionFailures.keys()) if (!next.has(key.slice(key.indexOf(':') + 1))) this.listProjectionFailures.delete(key)
    this.updateSubscriptions()
    this.scheduleMarketDeadline()
    return changed
  }

  pruneCatalog() {
    const valid = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry))
    if (valid.length !== this.catalog.size) this.replaceCatalog(valid)
  }

  listRowFor(entry, bars = [], bollExpansion) {
    const { rankingChange, rankingAsOf } = this.cachedRanking(entry.instrument.instId)
    return { ...marketRow(entry.instrument, entry.ticker, entry.result, bars, bollExpansion), rankingChange, rankingAsOf }
  }

  ensureListRows(timeframe) {
    const frame = this.listTimeframe(timeframe), current = this.listRows.get(frame) ?? new Map(), next = new Map()
    for (const entry of this.catalog.values()) {
      const base = this.listRowFor(entry), previous = current.get(entry.instrument.instId)
      next.set(entry.instrument.instId, previous ? { ...previous, turnover24hUSDT: base.turnover24hUSDT, lastPrice: base.lastPrice, rankingChange: base.rankingChange, rankingAsOf: base.rankingAsOf } : base)
    }
    if (JSON.stringify([...current]) !== JSON.stringify([...next])) {
      this.listRows.set(frame, next); this.listUpdatedAt.set(frame, Date.now()); this.touchList()
    } else if (!this.listRows.has(frame)) this.listRows.set(frame, next)
    return frame
  }

  listRowsFor(timeframe, now = Date.now()) {
    const frame = this.listTimeframe(timeframe), cached = this.listRows.get(frame)
    const lookback = this.prefs().rankingLookback, asOf = closedBoundary('5m', now)
    return [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry, now)).map(entry => {
      const instId = entry.instrument.instId, ranking = this.rankings.get(instId)
      const current = ranking?.lookback === lookback && ranking.rankingAsOf === asOf
      return { ...(cached?.get(instId) ?? marketRow(entry.instrument, entry.ticker, entry.result, [])),
        rankingChange: current ? ranking.rankingChange : null, rankingAsOf: current ? ranking.rankingAsOf : null }
    }).sort(compareRanking)
  }

  publishListRow(timeframe, row, updatedAt = Date.now()) {
    if (!this.catalog.has(row.instId)) return false
    const frame = this.listTimeframe(timeframe), current = this.listRows.get(frame) ?? new Map()
    if (JSON.stringify(current.get(row.instId)) === JSON.stringify(row)) return false
    current.set(row.instId, row); this.listRows.set(frame, current); this.listUpdatedAt.set(frame, updatedAt); this.touchList()
    return true
  }

  async readListBars(entry, timeframe) { return this.preparedCharts.projectListSeries(entry.instrument.instId, this.listTimeframe(timeframe)) }

  invalidateListProjection(instId) {
    this.listProjectionDataVersions.set(instId, (this.listProjectionDataVersions.get(instId) ?? 0) + 1)
    let changed = false
    for (const timeframe of LIST_TIMEFRAMES) changed = this.listProjectionResults.delete(this.listKey(instId, timeframe)) || changed
    if (changed) this.touchList()
  }

  async projectListEntry(instId, timeframe) {
    const frame = this.listTimeframe(timeframe)
    if (this.disposed || !this.catalog.has(instId)) return null
    const key = this.listKey(instId, frame), version = this.listProjectionDataVersions.get(instId) ?? 0
    const existing = this.listProjectionTasks.get(key)
    if (existing?.version === version) return existing.task
    const task = (async () => {
      if (existing) await existing.task.catch(() => undefined)
      const entry = this.catalog.get(instId)
      if (!entry || this.disposed) return null
      const cached = this.listProjectionResults.get(key)
      const projection = cached?.version === version ? cached : await this.readListBars(entry, frame)
      if (this.disposed || (this.listProjectionDataVersions.get(instId) ?? 0) !== version) return null
      this.listProjectionResults.set(key, { ...projection, version })
      const recovered = this.listProjectionFailures.delete(key)
      if (cached?.version !== version || recovered) this.touchList()
      const current = this.catalog.get(instId)
      if (!current) return null
      const row = this.listRowFor(current, projection.bars, projection.bollExpansion)
      this.publishListRow(frame, row)
      return { ...projection, row }
    })().catch(error => {
      if (!this.closing && this.catalog.has(instId) && (this.listProjectionDataVersions.get(instId) ?? 0) === version) {
        const attempts = (this.listProjectionFailures.get(key)?.attempts ?? 0) + 1
        this.listProjectionFailures.set(key, { instId, timeframe: frame, attempts,
          retryAt: Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)),
          error: error instanceof Error ? error.message : String(error) })
        this.touchList(); this.scheduleMarketDeadline()
      }
      return null
    }).finally(() => {
      if (this.listProjectionTasks.get(key)?.task === task) this.listProjectionTasks.delete(key)
      this.scheduleMarketDeadline()
    })
    this.listProjectionTasks.set(key, { version, task })
    return task
  }

  scheduleListProjection(instId) {
    for (const timeframe of LIST_TIMEFRAMES) this.listProjectionStoreRevisions.set(`${instId}:${timeframe}`, this.store.candleRevision(instId, timeframe))
    this.invalidateListProjection(instId)
    for (const timeframe of this.listRows.keys()) this.track(this.projectListEntry(instId, timeframe))
  }

  async ensureListTimeframe(timeframe) {
    await this.ready
    const frame = this.ensureListRows(timeframe)
    await Promise.all([...this.catalog.keys()].map(instId => this.projectListEntry(instId, frame)))
    return this.listRowsFor(frame)
  }

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
      if (this.catalog.has(instId)) this.publishRanking(instId, this.prefs().rankingLookback, closedBoundary('5m'))
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
    const { rankingChange, rankingAsOf } = this.cachedRanking(instId, lookback, asOf)
    for (const frame of this.listRows.keys()) {
      const previous = this.listRows.get(frame)?.get(instId)
      if (previous) this.publishListRow(frame, { ...previous, rankingChange, rankingAsOf })
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

  requestLane(name) {
    const lane = this.requestLanes.get(name)
    if (!lane) throw new Error(`Unknown OKX request lane: ${name}`)
    return lane
  }

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
          const response = await this.fetcher(requestURL(request.path, request.parameters), { headers: { Accept: 'application/json' }, signal: request.controller.signal })
          if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
          if (response.status === 429) {
            const serverDelay = retryAfterDelay(response.headers.get('retry-after'))
            // A 429 cools only the endpoint family that returned it. OI
            // must never freeze an unrelated candle repair or Taker read.
            lane.rateLimitedUntil = Math.max(lane.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
            lane.concurrency = Math.max(2, Math.floor((lane.concurrency ?? 4) / 2))
            throw new RetryAfterError(request.path, serverDelay, lane.name)
          }
          if (!response.ok) throw new Error(`OKX ${request.path} failed (${response.status}).`)
          const payload = await response.json()
          if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
          if (payload.code && payload.code !== '0') throw new Error(`OKX ${request.path}: ${payload.msg || payload.code}`)
          return payload.data ?? []
        }), request.controller.signal)
        lane.latencyMS = lane.latencyMS === undefined ? performance.now() - startedAt : lane.latencyMS * 0.8 + (performance.now() - startedAt) * 0.2
        lane.completed = (lane.completed ?? 0) + 1
        if (lane.interval > 0) {
          lane.concurrency = Math.max(2, Math.min(lane.name === 'books' ? 16 : 8, Math.ceil(lane.latencyMS / lane.interval) + 1))
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
        const eligible = request => requestPriority(request.priority) >= 3 || maintenanceActive < Math.max(1, limit - 1)
        const canStart = lane.active.size < limit && lane.queue.some(eligible)
        if (!canStart) { await this.waitRequestLane(lane); continue }
        const delay = Math.max(lane.nextAt, lane.rateLimitedUntil) - Date.now()
        if (delay > 0) { await this.waitRequestLane(lane, delay); continue }
        // Choose at admission time so newly queued chart/qualification work
        // passes downloads that were waiting for the endpoint's rate budget.
        const request = this.nextQueuedRequest(lane, eligible)
        lane.nextAt = Date.now() + lane.interval
        const active = this.performRequest(lane, request).finally(() => {
          lane.active.delete(active)
          lane.wake?.()
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

  get(path, parameters, requestSignal, priority = 'foreground') {
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
    const request = { path, parameters, requestSignal, priority, lane, controller, abort, enqueuedAt: Date.now(), resolve: resolveRequest, reject: rejectRequest, cleaned: false, onAbort: null }
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

  async persistCandles(instrument, candles, { projectList = true, priority = 'foreground' } = {}) {
    const confirmed = candles.filter(value => value.confirmed)
    await this.ready
    if (this.disposed || !confirmed.length) return false
    return this.enqueueCandleMutation(instrument, async () => {
      if (this.disposed) return false
      const changed = await this.appendChangedCandlesLocked(confirmed, priority)
      if (!changed.length) return false
      this.invalidateLiquidityHistory(instrument, changed)
      this.markChartDataChanged(instrument)
      this.cacheRankingCandles(instrument, changed)
      for (const timeframe of new Set(changed.map(row => row.timeframe))) this.scheduleQualification(instrument, timeframe)
      if (confirmed.some(row => row.timeframe === '5m')) void this.updateRanking(instrument).catch(() => undefined)
      if (this.candidateIDs?.has(instrument) && changed.some(row => row.timeframe === '5m')) this.advanceHistoryTarget(instrument)
      if (projectList) this.scheduleListProjection(instrument)
      return true
    })
  }

  async replaceCandles(range, candles, priority = 'foreground') {
    await this.ready
    return this.enqueueCandleMutation(range.instrument, async () => {
      if (this.disposed) throw new Error('Market service is closed.')
      // Statistics belong to their own sources. Replacing prices must never
      // replay an earlier read over a newer independent statistic commit.
      await this.store.replaceCandles(range, candles.map(priceRecord), priority)
      this.onHistoryReplaced(range.instrument, range.timeframe)
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

  statisticsExpiry(timeframe, end) {
    return statisticsExpiryAt(timeframe, end)
  }

  async persistStatisticsSource(instrument, timeframe, end, source, values, signal, priority = 'statistics', preserveExistingSource = false, { range, projectList = true } = {}) {
    await this.ready
    if (this.disposed || signal?.aborted) return false
    const page = range ?? this.statisticsPageRange(timeframe, end)
    const changed = await this.store.appendStatistics({ instrument: instrument.instId, timeframe,
      source: source === STATISTICS_OI ? 'oi' : 'taker', from: page.from, through: page.through,
      values: values.map(value => value.map(number)), expiresAt: this.statisticsExpiry(timeframe, end), preserveExistingSource }, priority)
    if (changed) {
      this.markChartDataChanged(instrument.instId)
      this.track(this.preparedCharts.observeStatistics(instrument.instId, timeframe, page.from, page.through))
      if (projectList) this.scheduleListProjection(instrument.instId)
    }
    return changed > 0
  }


  setLive(instId, timeframe, row, { receivedAt } = {}) {
    if (this.disposed) return
    const key = `${instId}:${timeframe}`, current = this.liveCandles.get(key)
    // REST initialization can resolve after a newer stream event. Same-volume
    // price corrections remain valid; older timestamps/cumulative volume do not.
    if (row && current && (row.timestamp < current.timestamp || row.timestamp === current.timestamp && row.volume < current.volume)) return Promise.resolve(null)
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
      for (const id of ids) for (const timeframe of LIST_TIMEFRAMES) {
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
      // Publish the trade price immediately, independently of history reads,
      // screening batches, and the completed-candle indicator projection.
      for (const [frame, rows] of this.listRows) {
        const row = rows.get(instId)
        if (row) this.publishListRow(frame, { ...row, lastPrice: number(value.last) }, receivedAt)
      }
    }
    this.queueStreamQualification(instId)
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
      if (this.tickerSubscriptions.get(instId)?.signal !== signal) continue
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
        this.catalog.delete(instId); this.catalogRevision++
        for (const frame of this.listRows.keys()) this.ensureListRows(frame)
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

  queueStreamQualification(instId) {
    if (this.closing || this.disposed) return
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
        const task = this.streamLiquidity.evaluate(input).then(result => {
          if (this.closing || !this.currentCandidate(instrument, configKey, this.shutdownController.signal)
            || this.instrumentObservations.get(instId) !== instrumentObservation) return
          const current = this.observations.get(instId) ?? {}, now = Date.now()
          if (current.turnover !== observations.turnover || current.hourly !== observations.hourly) return
          const currentInput = this.liquidityInput(instrument, config, current, now)
          const capturedSources = ['book', ...(config.spread.enabled ? ['ticker'] : []), ...(config.openInterest.enabled ? ['openInterest'] : []),
            ...(config.volume24h.enabled ? ['turnover'] : []), ...(config.volumeStability.enabled ? ['hourly'] : [])]
          const expiredSource = capturedSources.some(key => observations[key] && !this.observation(observations, key, now))
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
          if (this.instrumentObservations.get(instId) !== instrumentObservation || ['ticker', 'book', 'openInterest', 'turnover', 'hourly'].some(key => current[key] !== observations[key])) this.queueStreamQualification(instId)
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
        next.set(instId, record); this.renewalTargets.set(instId, instrument)
        membershipChanged ||= !existing
      } else {
        next.delete(instId)
        if (record.status === 'failed') this.renewalTargets.delete(instId)
        membershipChanged ||= existing
      }
    }
    this.catalogSource = 'live'; this.catalogUpdatedAt = Date.now()
    // Durable catalog checkpoints belong to discovery/renewal. High-frequency
    // ticks update memory, and only a membership change rebuilds list projections.
    if (membershipChanged) this.replaceCatalog([...next.values()])
    else this.catalog = next
    this.touchList()
    this.scheduleMarketDeadline()
  }

  onHistoryProgress(task) {
    if (this.disposed) return
    this.touchList()
    if (['completed', 'unavailable'].includes(task.status)) {
      const key = `${task.instrument}:${task.timeframe}`, version = this.store.candleRevision(task.instrument, task.timeframe)
      if (this.listProjectionStoreRevisions.get(key) !== version) this.scheduleListProjection(task.instrument)
      if (task.timeframe === '5m') this.track(this.updateRanking(task.instrument))
    }
  }

  onHistoryReplaced(instId, timeframe) {
    this.invalidateLiquidityHistory(instId, null, timeframe)
    this.markChartDataChanged(instId)
    this.preparedCharts.invalidate(instId, timeframe)
    if (timeframe === '5m') {
      this.rankingWindows.delete(instId)
      this.rankingReads.delete(instId)
      this.rankingVersions.set(instId, (this.rankingVersions.get(instId) ?? 0) + 1)
    }
    this.invalidateListProjection(instId)
    for (const frame of this.listRows.keys()) {
      const entry = this.catalog.get(instId)
      if (entry) this.publishListRow(frame, this.listRowFor(entry))
    }
    this.scheduleListProjection(instId)
    this.scheduleQualification(instId, timeframe)
    if (timeframe === '5m') this.track(this.updateRanking(instId))
  }

  updateSubscriptions() {
    if (!this.realtime) return
    const subscriptions = new Map(this.chartSubscriptions.filter(value => !this.candidateIDs || this.candidateIDs.has(value.instId)).map(value => [`${value.instId}:${value.timeframe}`, value]))
    // A temporary observation gap must not unsubscribe the final candle that
    // closes that gap. Confirmed failures and delistings remove renewal targets.
    for (const instId of new Set([...this.catalog.keys(), ...this.renewalTargets.keys()])) for (const timeframe of LIST_TIMEFRAMES) subscriptions.set(`${instId}:${timeframe}`, { instId, timeframe })
    const ids = this.candidateIDs ?? new Set([...this.instruments.values()].filter(eligibleInstrument).map(value => value.instId))
    for (const instId of ids) for (const timeframe of LIST_TIMEFRAMES) subscriptions.set(`${instId}:${timeframe}`, { instId, timeframe })
    this.preparedCharts.setRealtimeSubscriptions([...subscriptions.values()])
    this.realtime.setSubscriptions([...subscriptions.values()])
    this.publicRealtime?.setSubscriptions([...ids])
    if (!this.closing) this.preparedCharts.sourceStateChanged()
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
      if (signal?.aborted) return
      await this.history.ensureStatistics(instId, timeframe, from, through, 'continuity', signal)
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

  async setChartUniverse(instIds, timeframe, focusInstId) {
    await this.ready
    if (this.closing || this.disposed) throw new Error('Market service is closed.')
    this.chartSubscriptions = [...new Set(instIds)].map(instId => ({ instId, timeframe }))
    this.updateSubscriptions()
    return this.preparedCharts.setUniverse(instIds, timeframe, focusInstId)
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

  invalidateLiquidityHistory(instId, rows, timeframe) {
    for (const frame of ['5m', '1H']) if (rows ? rows.some(row => row.timeframe === frame) : timeframe === frame) {
      const key = `${instId}:${frame}`
      this.liquidityHistoryRevisions.set(key, this.liquidityHistoryRevision(instId, frame) + 1)
    }
    const observations = this.observations.get(instId)
    if (!observations) return
    let changed = false, invalidated = false
    for (const [key, frame, count] of [['turnover', '5m', 288], ['hourly', '1H', 24]]) {
      const value = observations[key]?.value
      const step = timeframeMilliseconds(frame)
      if (value && (rows ? rows.some(row => row.timeframe === frame && row.timestamp >= value.asOf - count * step && row.timestamp < value.asOf) : timeframe === frame)) {
        delete observations[key]
        changed = true
        invalidated ||= this.prefs().liquidity[key === 'turnover' ? 'volume24h' : 'volumeStability'].enabled
      }
    }
    const record = this.catalogChecks.get(instId)
    if (changed && record) {
      if (invalidated) {
        record.status = 'unknown'; record.result = { ...record.result, eligible: false }; record.expiresAt = Date.now()
      }
      record.observations = { ...observations }
      this.metadata.putCatalogEntry(record)
    }
    if (invalidated) {
      const entry = this.catalog.get(instId)
      if (entry) entry.expiresAt = Date.now()
      this.touchList()
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
    const config = this.prefs().liquidity, required = []
    if (config.spread.enabled) required.push('ticker')
    if (config.depth.enabled || config.slippage.enabled) required.push('book')
    if (config.openInterest.enabled) required.push('openInterest')
    if (config.volume24h.enabled) required.push('turnover')
    if (config.volumeStability.enabled) required.push('hourly')
    const ids = new Set([...this.catalogChecks.keys(), ...this.catalog.keys()]), deadlines = new Map()
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted
    for (const instId of ids) {
      const values = [this.catalog.get(instId)?.expiresAt]
      if (!continuousMetadata || !this.candidateIDs?.has(instId)) values.push(this.instrumentObservations.get(instId)?.expiresAt)
      const observations = this.observations.get(instId) ?? {}
      const assessed = this.catalogChecks.get(instId)?.observations ?? {}
      for (const key of required) values.push(this.observationExpiry(observations[key], key, instId), this.observationExpiry(assessed[key], key, instId))
      const future = values.filter(value => Number.isSafeInteger(value) && value > now && value < Number.MAX_SAFE_INTEGER)
      if (future.length) deadlines.set(instId, Math.min(...future))
    }
    this.marketDeadlines = deadlines
    const retries = [...this.listProjectionFailures.values()].filter(value => this.catalog.has(value.instId) && !this.listProjectionTasks.has(this.listKey(value.instId, value.timeframe))).map(value => value.retryAt)
    const boundary = ids.size ? closedBoundary('5m', now) + FIVE_MINUTES : Infinity
    const tickerRetries = [...this.tickerRecoveries].filter(([id, value]) => this.candidateIDs?.has(id) && !value.signal.aborted && !value.task).map(([, value]) => value.retryAt)
    const sourceRetries = [...this.sourceRecoveries.values()].filter(value => !value.task).map(value => value.retryAt)
    const next = Math.min(boundary, ...deadlines.values(), ...retries, ...tickerRetries, ...sourceRetries)
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
      const now = Date.now(), asOf = closedBoundary('5m', now)
      const due = new Set([...this.marketDeadlines].filter(([, deadline]) => deadline <= now).map(([instId]) => instId))
      if (asOf !== this.marketBoundary) {
        this.marketBoundary = asOf
        this.touchList()
        for (const instId of this.candidateIDs ?? []) this.advanceHistoryTarget(instId)
        for (const instId of this.catalog.keys()) this.track(this.updateRanking(instId, { asOf }))
        for (const instId of this.catalogChecks.keys()) this.scheduleQualification(instId)
      }
      // A worker can still own an earlier immutable observation. Its published
      // lease expires independently of newer raw source observations.
      this.pruneCatalog()
      for (const instId of due) {
        const record = this.catalogChecks.get(instId)
        if (record) this.catalogChecks.set(instId, { ...record, status: 'unknown', result: { ...record.result, eligible: false }, expiresAt: now })
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
      for (const failure of this.listProjectionFailures.values()) if (failure.retryAt <= now && this.catalog.has(failure.instId)) this.track(this.projectListEntry(failure.instId, failure.timeframe))
    } finally {
      this.processingMarketDeadline = false
      this.scheduleMarketDeadline()
    }
  }

  recoverRequiredSources(instId) {
    if (!this.autoRefresh || this.closing || !this.candidateIDs?.has(instId)) return
    const config = this.prefs().liquidity, observations = this.observations.get(instId) ?? {}
    for (const source of ['book', 'openInterest', 'turnover', 'hourly']) {
      const enabled = source === 'book' ? config.depth.enabled || config.slippage.enabled
        : source === 'openInterest' ? config.openInterest.enabled : source === 'turnover' ? config.volume24h.enabled : config.volumeStability.enabled
      const key = `${instId}:${source}`
      if (!enabled || this.observation(observations, source)) { this.cancelRequiredRecovery(key); continue }
      if (!this.sourceRecoveries.has(key)) this.sourceRecoveries.set(key, { key, instId, source, attempts: 0, retryAt: Date.now(), task: null, controller: new AbortController() })
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
          ? await this.get('/market/books', { instId: recovery.instId, sz: 400 }, signal, 'continuity').then(values => {
            const value = values[0]
            if (!value?.bids?.length || !value?.asks?.length) throw new Error('Missing order-book observation.')
            const observedAt = Date.now()
            return { value, source: 'rest', sourceTimestamp: number(value.ts), observedAt, expiresAt: observedAt + OBSERVATION_TTL }
          })
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
          recovery.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(5, recovery.attempts++))
          this.sourceError(recovery.key, error)
        }
      }
    })().finally(() => { recovery.task = null; this.scheduleMarketDeadline() })
    recovery.task = task
    return task
  }

  liquidityInput(instrument, config, observations, now = Date.now()) {
    const fresh = key => this.observation(observations, key, now)
    const asOf = closedBoundary('5m', now)
    const turnover = fresh('turnover')?.value, hourly = fresh('hourly')?.value
    return { instrument, ticker: fresh('ticker')?.value ?? null, book: fresh('book')?.value ?? null,
      openInterest: fresh('openInterest')?.value ?? null, hourlyCandles: hourly?.asOf === closedBoundary('1H', now) ? hourly.rows : [],
      turnover24hUSDT: turnover?.asOf === asOf ? turnover.turnover : null, asOf, config }
  }

  cheapLiquidity(input) {
    const { config } = input
    return this.evaluateLiquidity({ ...input, book: null, config: { ...config, depth: { ...config.depth, enabled: false }, slippage: { ...config.slippage, enabled: false } } })
  }

  observedCandidate(instrument, config, configKey, observations, errors = {}, now = Date.now(), evaluatedResult) {
    const fresh = key => this.observation(observations, key, now)
    const input = this.liquidityInput(instrument, config, observations, now)
    if (!evaluatedResult && input.book && (config.depth.enabled || config.slippage.enabled) && this.cheapLiquidity(input).status === 'failed') input.book = null
    const result = evaluatedResult ?? this.evaluateLiquidity(input)
    const required = []
    if (config.spread.enabled) required.push('ticker')
    if (config.depth.enabled || config.slippage.enabled) required.push('book')
    if (config.openInterest.enabled) required.push('openInterest')
    if (config.volume24h.enabled) required.push('turnover')
    if (config.volumeStability.enabled) required.push('hourly')
    const instrumentObservation = this.instrumentObservations.get(instrument.instId)
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted && this.candidateIDs?.has(instrument.instId)
    const metadataFresh = continuousMetadata || instrumentObservation?.expiresAt > now
    const validObservations = required.map(fresh)
    const complete = metadataFresh && validObservations.every(Boolean)
    const status = !metadataFresh ? 'unknown' : result.status === 'verified' && complete ? 'verified' : result.status === 'failed' ? 'failed' : 'unknown'
    const leases = complete ? [continuousMetadata ? { ...instrumentObservation, expiresAt: Number.MAX_SAFE_INTEGER } : instrumentObservation,
      ...required.map((key, index) => ({ observedAt: validObservations[index].observedAt, expiresAt: this.observationExpiry(validObservations[index], key, instrument.instId) }))] : []
    return this.catalogRecord({ instrument, ...(instrumentObservation ? { instrumentObservation } : {}),
      ticker: fresh('ticker')?.value ?? {}, result: { ...result, eligible: status === 'verified' },
      status, configKey, observations: { ...observations }, observationErrors: errors,
      preferencesRevision: this.catalogChecks.get(instrument.instId)?.preferencesRevision ?? 0,
      renewalTarget: status === 'verified' || status === 'unknown' && this.renewalTargets.has(instrument.instId),
      observedAt: leases.length ? Math.min(...leases.map(value => value.observedAt)) : now,
      expiresAt: status === 'verified' ? Math.min(...leases.map(value => value.expiresAt)) : now }, now)
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

  async readQualificationCandles(query, signal) {
    // Bound only local I/O, never an acquisition's network/history wait. Keep
    // the highest-priority store queue short enough for chart interactions.
    while (this.qualificationReads.size >= 4) await abortable(Promise.race(this.qualificationReads), signal)
    signal.throwIfAborted()
    const read = this.store.candles(query, 'foreground')
    const pending = read.then(() => undefined, () => undefined)
    this.qualificationReads.add(pending)
    try { return await read }
    finally { this.qualificationReads.delete(pending) }
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
      let revision = this.liquidityHistoryRevision(instId, timeframe), rows, value
      const read = () => {
        const identity = `${instId}:${key}:${end}:${revision}`
        let task = this.historicalSourceReads.get(identity)
        if (!task) {
          task = this.readQualificationCandles({ instrument: instId, timeframe, from, through }, this.shutdownController.signal)
            .then(rows => ({ rows, value: calculate(rows, end, from) }))
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
      if (key === 'turnover') this.cacheRankingCandles(instId, rows)
      const observation = { value: { asOf: end, ...value }, observedAt: Date.now(), expiresAt: end + step }
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
    const observe = async (key, operation) => {
      const requestedAt = Date.now()
      try {
        const value = await operation()
        if (!this.currentCandidate(instrument, configKey, signal)) return
        const now = Date.now()
        if (!(observations[key]?.source === 'websocket' && observations[key].observedAt >= requestedAt)) observations[key] = { value, observedAt: now, expiresAt: now + OBSERVATION_TTL }
      } catch (error) {
        // Preserve a still-valid observation, never extend it on failure.
        errors[key] = error instanceof Error ? error.message : String(error)
      }
    }
    const observeHistory = async key => {
      try { await this.observeHistoricalSource(instId, key, observations, signal, !localOnly, () => this.currentCandidate(instrument, configKey, signal)) }
      catch (error) { errors[key] = error instanceof Error ? error.message : String(error) }
    }
    const tasks = []
    if (config.volume24h.enabled && !(this.observation(observations, 'turnover')?.value.asOf === asOf)) tasks.push(observeHistory('turnover'))
    if (config.volumeStability.enabled && !(this.observation(observations, 'hourly')?.value.asOf === closedBoundary('1H', asOf))) tasks.push(observeHistory('hourly'))
    await Promise.all(tasks)
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const historicalAsOf = closedBoundary('5m')
    const historicalResult = evaluateLiquidity({ instrument, config, asOf: historicalAsOf,
      turnover24hUSDT: observations.turnover?.value.asOf === historicalAsOf ? this.observation(observations, 'turnover')?.value.turnover ?? null : null,
      hourlyCandles: observations.hourly?.value.asOf === closedBoundary('1H', historicalAsOf) ? this.observation(observations, 'hourly')?.value.rows ?? [] : [] })
    // Historical repairs can take minutes. Obtain live liquidity only after
    // those repairs; acquire only a missing contract's bounded ticker fallback.
    // A known failing historical condition already excludes a contract; it
    // must not consume the live request budget needed by qualified contracts.
    const live = []
    if (!localOnly && historicalResult.status !== 'failed') live.push(this.tickerObservation(instId, signal, priority).then(value => {
      if (!value) throw new Error(`Missing ticker observation for ${instId}.`)
      if (this.currentCandidate(instrument, configKey, signal)) observations.ticker = value
    }).catch(error => { errors.ticker = error instanceof Error ? error.message : String(error) }))
    if (!localOnly && historicalResult.status !== 'failed' && (config.depth.enabled || config.slippage.enabled) && this.observation(observations, 'book')?.source !== 'websocket') live.push(observe('book', async () => {
      const value = (await this.get('/market/books', { instId, sz: 400 }, signal, priority))[0]
      if (!value || !Array.isArray(value.bids) || !value.bids.length || !Array.isArray(value.asks) || !value.asks.length) throw new Error('Missing order-book observation.')
      return value
    }))
    if (!localOnly && historicalResult.status !== 'failed' && config.openInterest.enabled && this.observation(observations, 'openInterest')?.source !== 'websocket') live.push((async () => {
      try {
        // One explicit source snapshot is shared by the whole refresh round.
        // A candidate delayed by history renews it if its lease has elapsed.
        if (!sources.openInterest) {
          const task = this.openInterest.observe(signal, priority, true).catch(error => {
            if (sources.openInterest === task) sources.openInterest = null
            throw error
          })
          sources.openInterest = task
        }
        let values = await sources.openInterest
        if (values.values().next().value?.expiresAt <= Date.now()) values = await this.openInterest.observe(signal, priority)
        const observation = values.get(instId)
        if (!observation) throw new Error(`Missing open-interest observation for ${instId}.`)
        if (this.currentCandidate(instrument, configKey, signal) && this.observation(observations, 'openInterest')?.source !== 'websocket') observations.openInterest = observation
      } catch (error) { errors.openInterest = error instanceof Error ? error.message : String(error) }
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
    for (const instId of removedIDs) {
      for (const recovery of this.sourceRecoveries.values()) if (recovery.instId === instId) this.cancelRequiredRecovery(recovery.key)
      this.tickerSubscriptions.delete(instId)
      this.cancelTickerRecovery(instId)
      this.clearTickerFault(instId)
      this.observations.delete(instId)
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
        const observations = this.observations.get(instrument.instId)
        if (observations) delete observations.book
      }
      this.instruments.set(instrument.instId, instrument)
      if (!observedIDs || observedIDs.has(instrument.instId)) this.instrumentObservations.set(instrument.instId, { observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_TTL })
      if (this.renewalTargets.has(instrument.instId)) this.renewalTargets.set(instrument.instId, instrument)
    }
    this.updateSubscriptions()
    for (const key of this.liveCandles.keys()) if (!nextIDs.has(key.slice(0, key.lastIndexOf(':')))) {
      this.liveCandles.delete(key); this.liveCandleSources.delete(key)
    }
    for (const instId of this.historyTargets.keys()) if (!nextIDs.has(instId)) this.historyTargets.delete(instId)
    for (const { instId } of candidates) this.advanceHistoryTarget(instId)
    const configKey = this.catalogCriteriaKey(), signal = this.shutdownController.signal
    this.replaceCatalog([...this.catalog.values()].filter(entry => this.currentCandidate(entry.instrument, configKey, signal) && this.validCatalogEntry(entry)))
    return candidates
  }

  advanceHistoryTarget(instId) {
    if (this.closing || this.disposed || !this.candidateIDs?.has(instId)) return
    const asOf = closedBoundary('5m'), historyDays = this.prefs().historyDays, targetKey = `${historyDays}:${asOf}`
    if (this.historyTargets.get(instId) === targetKey) return
    this.historyTargets.set(instId, targetKey)
    this.track(this.history.target(instId, { historyDays, asOf }).catch(error => {
      if (this.historyTargets.get(instId) === targetKey) this.historyTargets.delete(instId)
      throw error
    }))
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
    const stream = { signal: context.signal, synchronized: false, delay: 1_000 }
    this.instrumentStream = stream
    this.instrumentDeltas.clear()
    const synchronize = async () => {
      try {
        // Start the authoritative snapshot after acknowledgement. This closes
        // the gap before subscription; deltas received during HTTP are merged.
        await this.instrumentTask?.task.catch(() => undefined)
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        const signal = AbortSignal.any([stream.signal, this.shutdownController.signal])
        const candidates = await this.discoverInstruments(this.catalogCriteriaKey(), signal, 'foreground')
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        stream.synchronized = true
        this.verifyCatalog()
        const config = this.prefs().liquidity, key = JSON.stringify(config), sources = {}
        this.track(Promise.allSettled(candidates.map(instrument => this.checkCandidate(instrument, config, key, signal, 'foreground', { sources }))))
        this.sourceError('instruments', null)
      } catch (error) {
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        this.sourceError('instruments', error)
        this.instrumentRetryTimer = setTimeout(() => { this.instrumentRetryTimer = null; this.track(synchronize()) }, stream.delay)
        stream.delay = Math.min(30_000, stream.delay * 2)
        this.instrumentRetryTimer.unref?.()
      }
    }
    return synchronize()
  }

  instrumentStreamDisconnected(context) {
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

  async refresh() {
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
          this.discoverInstruments(configKey, controller.signal, 'foreground'),
          this.tickerObservations(controller.signal, 'foreground', true),
        ])
        if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
        this.verifyCatalog()
        // Previously qualified contracts get checked first, independently of
        // their position in the exchange's instrument response.
        candidates.sort((a, b) => Number(this.renewalTargets.has(b.instId)) - Number(this.renewalTargets.has(a.instId)))
        // A successful check publishes independently; the first row does not wait for the full exchange scan.
        const sources = {}
        await Promise.all(candidates.map(instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground', { sources })))
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
    if (JSON.stringify(previous.liquidity) !== JSON.stringify(current.liquidity)) {
      this.refreshController?.abort()
      this.renewalController?.abort()
      for (const controller of this.catalogControllers) controller.abort()
      this.catalogChecks.clear(); this.renewalTargets.clear()
      this.verifyCatalog()
      this.scheduleMarketDeadline()
      this.lastRefreshAt = 0
      const configKey = JSON.stringify(current.liquidity)
      if (this.autoRefresh) this.track(Promise.allSettled([this.refreshing, this.renewing].filter(Boolean)).then(() => {
        if (!this.closing && !this.disposed && this.catalogCriteriaKey() === configKey) return this.refresh()
      }))
    }
    if (previous.rankingLookback !== current.rankingLookback) {
      for (const frame of this.listRows.keys()) this.ensureListRows(frame)
      for (const instId of this.catalog.keys()) this.track(this.updateRanking(instId, { ensure: true }))
    }
    if (previous.historyDays !== current.historyDays) for (const instId of this.candidateIDs ?? this.instruments.keys()) this.track(this.history.target(instId, { historyDays: current.historyDays, asOf: closedBoundary('5m') }))
    if (previous.chartTimeframe !== current.chartTimeframe) {
      this.ensureListRows(current.chartTimeframe)
      for (const instId of this.catalog.keys()) this.track(this.projectListEntry(instId, current.chartTimeframe))
    }
    this.touchList()
    this.scheduleMarketDeadline()
  }

  invalidate() {
    this.refreshController?.abort()
    this.renewalController?.abort()
    for (const controller of this.catalogControllers) controller.abort()
    this.catalogChecks.clear(); this.renewalTargets.clear()
    this.replaceCatalog([])
    this.lastRefreshAt = 0
    if (this.autoRefresh) this.track(this.refresh())
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
      for (const instrument of this.instruments.values()) for (const timeframe of LIST_TIMEFRAMES) {
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

  listProgress(timeframe, entries = [...this.catalog.keys()]) {
    const frame = this.listTimeframe(timeframe)
    const completed = entries.filter(instId => this.listProjectionResults.has(this.listKey(instId, frame))).length
    const progress = this.history?.sync.progressFor(entries, frame) ?? { retrying: 0, unavailable: 0 }
    return { total: entries.length, completed, pending: Math.max(0, entries.length - completed),
      ...progress }
  }

  async snapshot(timeframe = this.prefs().chartTimeframe, { sinceRevision, serviceSession } = {}) {
    await this.ready
    const frame = this.listTimeframe(timeframe), rows = this.listRowsFor(frame)
    const configKey = this.catalogCriteriaKey()
    const pendingIDs = new Set([...this.pendingCandidates.values()].filter(value => value.configKey === configKey).map(value => value.instId))
    for (const recovery of this.sourceRecoveries.values()) pendingIDs.add(recovery.instId)
    for (const instId of this.tickerRecoveries.keys()) pendingIDs.add(instId)
    const pending = pendingIDs.size
    const catalogProgress = { total: this.candidateIDs?.size ?? this.catalogChecks.size, completed: this.catalogChecks.size, pending, verified: 0, failed: 0, unknown: 0 }
    for (const record of this.catalogChecks.values()) {
      const status = record.status === 'verified' && !this.validCatalogEntry(record) ? 'unknown' : record.status
      catalogProgress[status] += 1
    }
    const unavailable = !rows.length && catalogProgress.unknown > 0
      ? `Market verification is unavailable for ${catalogProgress.unknown} contracts because required observations are missing or expired.${pending > 0 || this.refreshing || this.renewing ? ' Acquiring current observations.' : ''}` : ''
    const projectionError = [...this.listProjectionFailures.values()].find(value => value.timeframe === frame && this.catalog.has(value.instId))?.error
    const status = { error: this.error || projectionError || unavailable, loading: this.refreshing !== null || this.renewing !== null || pending > 0,
      catalogProgress,
      updatedAt: this.listUpdatedAt.get(frame) ?? this.catalogUpdatedAt, listProgress: this.listProgress(frame, rows.map(row => row.instId)), timeframe: frame,
      catalogSource: this.catalogSource, realtimeState: this.realtimeState() }
    const metadata = { ...status, revision: this.revision, serviceSession: this.serviceSession }
    if (serviceSession === this.serviceSession && sinceRevision === this.revision) return { ...metadata, unchanged: true }
    return { ...metadata, rows }
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
    this.qualificationQueue.clear()
    this.disposeTask = (async () => {
      try { await this.ready } catch { if (this.ownsMetadata) this.metadata?.close(); return }
      // A confirmed stream event resolves only after its durable write. Drain it before aborting source work.
      await Promise.all([this.realtime?.close(), this.publicRealtime?.close()])
      await this.streamLiquidity?.close()
      this.disposed = true
      this.refreshController?.abort()
      this.renewalController?.abort()
      for (const controller of this.catalogControllers) controller.abort()
      this.shutdownController.abort()
      for (const controller of this.abortControllers) controller.abort()
      await this.history.close()
      await this.preparedCharts.dispose()
      await Promise.allSettled([this.refreshing, this.renewing, this.drainRequestQueues(), ...this.candidateTasks.values(), ...this.barTasks, ...this.backgroundTasks, ...this.rankingTasks.values(), ...this.candleMutations.values(), ...[...this.listProjectionTasks.values()].map(value => value.task)].filter(Boolean))
      try { this.flushRankingPersistence() }
      finally { if (this.ownsMetadata) this.metadata.close() }
    })()
    return this.disposeTask
  }
}
