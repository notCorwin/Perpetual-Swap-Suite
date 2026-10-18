import { join } from 'node:path'
import { evaluateMarketOpportunity, summarizeMarketBars } from './market-metrics.js'
import { PreparedChartPipeline } from './prepared-chart-service.js'
import { MetadataStore, DEFAULT_PREFERENCES, validatePreferences } from './metadata-store.js'
import { MarketHistory } from './market-history.js'
import { eligibleInstrument, evaluateLiquidity, createLiquidityEvaluator, quoteTurnover24h } from './liquidity.js'
import { rankingFromCandles, compareRanking } from './ranking.js'
import { RealtimeMarket } from './realtime-market.js'
import { statisticsMask, statisticsVersionFor, validTakerVolumes, STATISTICS_OI, STATISTICS_TAKER } from './statistics-state.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const FIVE_MINUTES = 300_000
const LIST_TIMEFRAMES = ['5m', '15m', '1H']
const OBSERVATION_TTL = 90_000
const CATALOG_RENEW_INTERVAL = 30_000
const LATEST_CANDLE_REFRESH = 60_000
const HISTORICAL_STATISTICS_REFRESH = 6 * 3_600_000
const REQUEST_TIMEOUT = 12_000
const RETRY_DELAYS = [1_000]
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, statistics: 1, foreground: 2, repair: 2, prepared: 2 }
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, market: 80 })
const requestLaneFor = path => path.includes('/rubik/stat/taker-volume-contract') ? 'taker'
  : path.includes('/rubik/stat/contracts/open-interest-history') ? 'oi'
    : path.includes('/market/candles') || path.includes('/market/history-candles') ? 'candles' : 'market'
const statisticsExpiryField = source => source === STATISTICS_OI ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
const closedBoundary = (timeframe, now = Date.now()) => Math.floor(now / timeframeMilliseconds(timeframe)) * timeframeMilliseconds(timeframe)
const emptyAudit = () => ({ phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' })
const sleep = (milliseconds, ...signals) => new Promise((resolve, reject) => {
  const activeSignals = signals.filter(Boolean)
  const aborted = activeSignals.find(signal => signal.aborted)
  if (aborted) { reject(aborted.reason ?? new Error('The request was aborted.')); return }
  const cleanup = () => activeSignals.forEach(signal => signal.removeEventListener('abort', abort))
  const abort = () => {
    clearTimeout(timer)
    cleanup()
    const signal = activeSignals.find(value => value.aborted)
    reject(signal?.reason ?? new Error('The request was aborted.'))
  }
  const finish = () => {
    cleanup()
    resolve()
  }
  const timer = setTimeout(finish, milliseconds)
  activeSignals.forEach(signal => signal.addEventListener('abort', abort, { once: true }))
  // AbortSignal can change between the initial check and listener setup.
  if (activeSignals.some(signal => signal.aborted)) abort()
})
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
const hasStatisticsSource = (value, source) => (statisticsMask(value) & source) === source
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

async function mapConcurrent(values, limit, operation) {
  const output = [], workers = Math.min(limit, values.length)
  let next = 0
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < values.length) {
      const index = next++
      const result = await operation(values[index])
      if (result !== undefined) output.push(result)
    }
  }))
  return output
}

function candle(instrument, timeframe, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe, timestamp, open, high, low, close, volume: number(value[5]), baseVolume: number(value[6]), quoteVolume: number(value[7]), confirmed: value[8] === '1' }
}

const candleFields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt', 'confirmed']
const optionalCandleFields = new Set(['oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt'])

function mergedCandle(previous, next) {
  // Raw/derived candle writes use null as “no new statistics”, so they must
  // preserve the direct statistics already attached to that timestamp.
  // Statistics hydration is different: an explicit null from the current
  // direct endpoint is authoritative and must clear any legacy value. Keep
  // that one-shot replacement instruction out of the Parquet record itself.
  const replaceStatistics = next.replaceStatistics === true
  const { replaceStatistics: _replaceStatistics, ...candidate } = next
  if (!previous) return candidate
  const merged = { ...previous, ...candidate }
  if (!replaceStatistics) for (const field of optionalCandleFields) if (candidate[field] === null || candidate[field] === undefined) merged[field] = previous[field] ?? null
  return merged
}

function sameCandle(left, right) {
  return candleFields.every(field => {
    const leftValue = optionalCandleFields.has(field) ? left[field] ?? null : left[field]
    const rightValue = optionalCandleFields.has(field) ? right[field] ?? null : right[field]
    return Object.is(leftValue, rightValue)
  })
}

function marketRow(instrument, ticker, result, bars = []) {
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
    bollExpansion: metrics.bollExpansion,
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
    this.catalogChecks = new Map()
    this.renewalTargets = new Map()
    this.candidateTasks = new Map()
    this.candidateIDs = null
    this.tickerCache = null
    this.tickerTask = null
    this.renewing = null
    this.renewalTimer = null
    this.instruments = new Map()
    this.instrumentObservations = new Map()
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
    this.listProjectionDataVersions = new Map()
    this.dataRevisions = new Map()
    this.liveCandles = new Map()
    this.candleMutations = new Map()
    this.barTasks = new Set()
    this.backgroundTasks = new Set()
    this.requestLanes = new Map(Object.entries(REQUEST_LANE_INTERVALS).map(([name, interval]) => [name, { name, interval, queue: [], task: null, running: false, active: null, nextAt: 0, rateLimitedUntil: 0 }]))
    this.backgroundRequestControllers = new Map()
    this.abortControllers = new Set()
    this.shutdownController = new AbortController()
    this.revision = 0
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
    this.refreshTimer = null
    this.chartSubscriptions = []
    this.latestAuditID = null
    // The proxy admits no historical work until durable metadata has opened.
    const history = Object.fromEntries(['ensurePrices', 'ensureStatistics', 'latest'].map(method => [method, async (...args) => { await this.ready; return this.history[method](...args) }]))
    this.preparedCharts = new PreparedChartPipeline({ store, history, normalize: normalizedStatistics, revision: instId => this.dataRevision(instId), instrument: instId => this.instruments.get(instId) })
    this.ready = this.initialize()
  }

  prefs() { return validatePreferences(this.preferences()) }
  listTimeframe(timeframe) { return LIST_TIMEFRAMES.includes(timeframe) ? timeframe : this.prefs().chartTimeframe }
  listKey(instId, timeframe) { return `${timeframe}:${instId}` }
  catalogCriteriaKey() { return JSON.stringify(this.prefs().liquidity) }
  catalogEntry(instId) { return this.catalog.get(instId) }
  touchList() { this.revision += 1 }

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
    })
    await this.history.ready
    const audits = this.history.audit.list().sort((a, b) => b.updatedAt - a.updatedAt)
    this.latestAuditID = audits[0]?.id ?? null
    this.readCatalog()
    this.realtime = new RealtimeMarket({
      parseCandle: candle,
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      onForming: row => this.setLive(row.instrument, row.timeframe, row),
      onConfirmed: async row => {
        await this.persistCandles(row.instrument, [row])
        const live = this.liveCandles.get(`${row.instrument}:${row.timeframe}`)
        if (!live || live.timestamp <= row.timestamp) await this.setLive(row.instrument, row.timeframe, null)
        await this.updateRanking(row.instrument)
      },
      onReconnect: (subscriptions, context) => this.reconcileRealtime(subscriptions, context),
      onState: () => { this.touchList() },
    })
    this.updateSubscriptions()
    if (this.autoRefresh && !this.closing) {
      this.realtime.start(); this.scheduleRefresh()
      this.track(this.renewCatalog())
    }
    return this
  }

  validCatalogEntry(entry, now = Date.now()) {
    return Boolean(entry?.instrument?.instId && entry.ticker && entry.result?.eligible && entry.status === 'verified'
      && entry.configKey === this.catalogCriteriaKey() && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now)
  }

  readCatalog() {
    const entries = this.metadata.listCatalogEntries()
    for (const entry of entries) {
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
    const next = new Map(entries.map(entry => { const record = this.catalogRecord(entry); return [record.instrument.instId, record] }))
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.catalog])
    this.catalog = next
    for (const entry of next.values()) this.instruments.set(entry.instrument.instId, entry.instrument)
    if (changed) { this.catalogRevision += 1; this.touchList() }
    for (const timeframe of new Set([this.prefs().chartTimeframe, ...this.listRows.keys()])) {
      this.ensureListRows(timeframe)
      for (const instId of next.keys()) this.track(this.projectListEntry(instId, timeframe))
    }
    this.updateSubscriptions()
    return changed
  }

  pruneCatalog() {
    const valid = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry))
    if (valid.length !== this.catalog.size) this.replaceCatalog(valid)
  }

  listRowFor(entry, bars = []) {
    const { rankingChange, rankingAsOf } = this.cachedRanking(entry.instrument.instId)
    return { ...marketRow(entry.instrument, entry.ticker, entry.result, bars), rankingChange, rankingAsOf }
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

  listRowsFor(timeframe) { this.pruneCatalog(); return [...(this.listRows.get(this.listTimeframe(timeframe))?.values() ?? [])].sort(compareRanking) }

  publishListRow(timeframe, row, updatedAt = Date.now()) {
    if (!this.catalog.has(row.instId)) return false
    const frame = this.listTimeframe(timeframe), current = this.listRows.get(frame) ?? new Map()
    if (JSON.stringify(current.get(row.instId)) === JSON.stringify(row)) return false
    current.set(row.instId, row); this.listRows.set(frame, current); this.listUpdatedAt.set(frame, updatedAt); this.touchList()
    return true
  }

  async readListBars(entry, timeframe) { return this.preparedCharts.projectSeries(entry.instrument.instId, this.listTimeframe(timeframe)) }

  invalidateListProjection(instId) {
    this.listProjectionDataVersions.set(instId, (this.listProjectionDataVersions.get(instId) ?? 0) + 1)
    for (const timeframe of LIST_TIMEFRAMES) this.listProjectionResults.delete(this.listKey(instId, timeframe))
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
      const current = this.catalog.get(instId)
      if (!current) return null
      const row = this.listRowFor(current, projection.bars)
      this.publishListRow(frame, row)
      return { ...projection, row }
    })().finally(() => { if (this.listProjectionTasks.get(key)?.task === task) this.listProjectionTasks.delete(key) })
    this.listProjectionTasks.set(key, { version, task })
    return task
  }

  scheduleListProjection(instId) {
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
    // A new completed boundary can arrive before its durable candle. Keep the
    // last confirmed ordering with its original timestamp until repair catches up.
    const ranking = result.rankingChange === null && previous?.lookback === lookback && previous.rankingChange !== null
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

  nextQueuedRequest(lane) {
    let next = 0
    for (let index = 1; index < lane.queue.length; index += 1) {
      if (requestPriority(lane.queue[index].priority) > requestPriority(lane.queue[next].priority)) next = index
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
    this.backgroundRequestControllers.delete(request.controller)
  }

  rejectQueuedRequest(request) {
    const lane = this.requestLane(request.lane)
    const index = lane.queue.indexOf(request)
    if (index < 0) return
    lane.queue.splice(index, 1)
    request.reject(request.controller.signal.reason ?? new Error('The request was aborted.'))
    this.cleanupRequest(request)
  }

  async drainRequestLane(name) {
    const lane = this.requestLane(name)
    if (lane.running) return lane.task
    lane.running = true
    const task = (async () => {
      while (lane.queue.length) {
        const request = this.nextQueuedRequest(lane)
        lane.active = request
        try {
          if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
          const scheduled = Math.max(Date.now(), lane.nextAt, lane.rateLimitedUntil)
          if (scheduled > Date.now()) await sleep(scheduled - Date.now(), this.shutdownController.signal, request.controller.signal)
          if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
          lane.nextAt = Date.now() + lane.interval
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
                throw new RetryAfterError(request.path, serverDelay, lane.name)
              }
              if (!response.ok) throw new Error(`OKX ${request.path} failed (${response.status}).`)
              const payload = await response.json()
              if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
              if (payload.code && payload.code !== '0') throw new Error(`OKX ${request.path}: ${payload.msg || payload.code}`)
              return payload.data ?? []
            }), request.controller.signal)
            request.resolve(data)
          } finally {
            clearTimeout(timeout)
          }
        } catch (error) {
          request.reject(error)
        } finally {
          if (lane.active === request) lane.active = null
          this.cleanupRequest(request)
        }
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
    // Foreground work may evict background work only from the same OKX
    // budget. In particular, a candle repair cannot cancel OI or Taker.
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.shutdownController.signal.addEventListener('abort', abort, { once: true })
    requestSignal?.addEventListener('abort', abort, { once: true })
    this.abortControllers.add(controller)
    if (priority === 'background') this.backgroundRequestControllers.set(controller, lane)
    let resolveRequest, rejectRequest
    const result = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject })
    const queue = this.requestLane(lane)
    const request = { path, parameters, requestSignal, priority, lane, controller, abort, resolve: resolveRequest, reject: rejectRequest, cleaned: false, onAbort: null }
    request.onAbort = () => this.rejectQueuedRequest(request)
    controller.signal.addEventListener('abort', request.onAbort, { once: true })
    if (controller.signal.aborted) request.onAbort()
    else {
      queue.queue.push(request)
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
    const changed = candles.map(value => mergedCandle(byTimestamp.get(value.timestamp), value)).filter(value => !sameCandle(byTimestamp.get(value.timestamp) ?? {}, value))
    if (changed.length) {
      await this.store.appendCandles(changed, priority)
      this.preparedCharts.observe(changed, byTimestamp)
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
      if (confirmed.some(row => row.timeframe === '5m')) void this.updateRanking(instrument).catch(() => undefined)
      if (projectList) this.scheduleListProjection(instrument)
      return true
    })
  }

  async replaceCandles(range, candles, priority = 'foreground') {
    await this.ready
    return this.enqueueCandleMutation(range.instrument, async () => {
      if (this.disposed) throw new Error('Market service is closed.')
      let previous
      try { previous = await this.store.candles(range, priority) }
      catch (error) {
        // Strict reads cannot recover statistics from corrupt or invalid data.
        // Confirm a data defect before proceeding; operational I/O errors must
        // still fail the repair rather than masquerading as missing metadata.
        const inspection = await this.store.inspectCandles(range, priority)
        if (!inspection.issues.some(issue => issue.repairable && issue.reason !== 'gap')) throw error
        previous = []
      }
      const byTimestamp = new Map(previous.map(row => [row.timestamp, row]))
      const replacement = candles.map(row => {
        const prior = byTimestamp.get(row.timestamp)
        if (!prior) return row
        const merged = { ...row }
        // Downloaded prices and volumes are authoritative. Only source
        // statistics survive, with their existing observation leases intact.
        for (const field of optionalCandleFields) if (merged[field] == null) merged[field] = prior[field] ?? null
        // Validate Taker zero observations against the repaired traded volume.
        return normalizedStatistics(merged)
      })
      await this.store.replaceCandles(range, replacement, priority)
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
    const byHour = source === STATISTICS_OI
      ? new Map(values.map(value => [Number(value[0]), number(value[1])]))
      : new Map(values.map(value => [Number(value[0]), { sell: number(value[1]), buy: number(value[2]) }]))
    const page = range ?? this.statisticsPageRange(timeframe, end)
    const expiresAt = this.statisticsExpiry(timeframe, end)
    const expiryField = statisticsExpiryField(source)
    const storePriority = priority === 'background' || priority === 'chartWarm' ? 'background' : 'foreground'
    const changed = await this.enqueueCandleMutation(instrument.instId, async () => {
      if (this.disposed || signal?.aborted) return false
      const local = (await this.store.candles({ instrument: instrument.instId, timeframe, from: page.from, through: page.through }, storePriority)).map(normalizedStatistics)
      const patched = local.filter(value => value.confirmed).map(value => {
        const sourceAlreadyObserved = hasStatisticsSource(value, source)
        const preserveSource = preserveExistingSource && sourceAlreadyObserved
        const existingOI = number(value.oi)
        const existingVolumes = { sell: number(value.sell), buy: number(value.buy) }
        const incomingOI = source === STATISTICS_OI ? byHour.get(value.timestamp) ?? null : null
        const incomingVolumes = source === STATISTICS_TAKER ? validTakerVolumes(value, byHour.get(value.timestamp) ?? null) : null
        const incomingHasValue = source === STATISTICS_OI
          ? incomingOI !== null
          : incomingVolumes !== null && incomingVolumes.sell !== null && incomingVolumes.buy !== null
        const existingHasValue = source === STATISTICS_OI
          ? sourceAlreadyObserved && existingOI !== null
          : sourceAlreadyObserved && existingVolumes.sell !== null && existingVolumes.buy !== null
        // An empty current page is a useful direct observation for rows that
        // were never observed, but it is not better data than a numeric
        // direct observation from an overlapping page. Near the live edge
        // OKX may return an empty 100-row page while its preceding cursor
        // still has the shared 88 values. Clearing those values caused the
        // back-scroll gaps seen in the chart, so only a concrete source value
        // may replace an existing concrete source value.
        const retainExistingValue = preserveSource || !incomingHasValue && existingHasValue
        const sources = preserveSource ? statisticsMask(value) : statisticsMask(value) | source
        const oi = source === STATISTICS_OI ? retainExistingValue ? existingOI : incomingOI
          : hasStatisticsSource(value, STATISTICS_OI) ? existingOI : null
        const volumes = source === STATISTICS_TAKER ? retainExistingValue ? existingVolumes : incomingVolumes
          : hasStatisticsSource(value, STATISTICS_TAKER) ? existingVolumes : null
        const sourceExpiry = preserveSource ? number(value[expiryField])
          // Direct numeric values do not need an expiry. This also removes a
          // stale lease from a prior empty page when a neighboring numeric
          // observation is retained.
          : incomingHasValue || existingHasValue ? null
            : Number.isFinite(expiresAt) ? expiresAt : null
        const next = {
          ...value,
          oi,
          sell: volumes?.sell ?? null,
          buy: volumes?.buy ?? null,
          [expiryField]: sourceExpiry,
        }
        return { ...next, statisticsVersion: statisticsVersionFor(sources, next), replaceStatistics: true }
      })
      const written = await this.appendChangedCandlesLocked(patched, storePriority)
      return written.length > 0
    })
    if (changed) {
      this.markChartDataChanged(instrument.instId)
      if (projectList) this.scheduleListProjection(instrument.instId)
    }
    return changed
  }


  setLive(instId, timeframe, row) {
    if (this.disposed) return
    const key = `${instId}:${timeframe}`, current = this.liveCandles.get(key)
    // REST initialization can resolve after a newer stream event. Same-volume
    // price corrections remain valid; older timestamps/cumulative volume do not.
    if (row && current && (row.timestamp < current.timestamp || row.timestamp === current.timestamp && row.volume < current.volume)) return Promise.resolve(null)
    if (row) this.liveCandles.set(key, row)
    else this.liveCandles.delete(key)
    return this.preparedCharts.setLive(instId, timeframe, row)
  }

  onHistoryProgress(task) {
    if (this.disposed) return
    if (['completed', 'unavailable'].includes(task.status)) {
      this.scheduleListProjection(task.instrument)
      if (task.timeframe === '5m') this.track(this.updateRanking(task.instrument))
    }
    this.touchList()
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
    if (timeframe === '5m') this.track(this.updateRanking(instId))
  }

  updateSubscriptions() {
    if (!this.realtime) return
    const subscriptions = new Map(this.chartSubscriptions.map(value => [`${value.instId}:${value.timeframe}`, value]))
    for (const instId of this.catalog.keys()) for (const timeframe of LIST_TIMEFRAMES) subscriptions.set(`${instId}:${timeframe}`, { instId, timeframe })
    this.realtime.setSubscriptions([...subscriptions.values()])
  }

  async reconcileRealtime(subscriptions, { signal } = {}) {
    await this.ready
    for (const { instId, timeframe } of subscriptions) {
      if (this.closing || signal?.aborted) return
      const step = timeframeMilliseconds(timeframe), through = closedBoundary(timeframe) - step
      const coverage = await this.store.coverage(instId, timeframe, 'background')
      const from = Math.max(0, coverage.last === null ? through - step : Math.min(through, coverage.last + step))
      await this.history.ensurePrices(instId, timeframe, from, through, 'foreground', signal)
      if (signal?.aborted) return
      await this.history.ensureStatistics(instId, timeframe, from, through, 'foreground', signal)
    }
  }

  prepareChartWindow(instId, timeframe, end) {
    if (this.closing || this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.ready.then(() => this.preparedCharts.prepare(instId, timeframe, end))
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

  observation(entry, key, now = Date.now()) {
    const value = entry[key]
    return value && Number.isSafeInteger(value.observedAt) && value.expiresAt > now ? value : null
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
      record.observations = observations
      this.metadata.putCatalogEntry(record)
    }
    if (invalidated) {
      const entry = this.catalog.get(instId)
      if (entry) entry.expiresAt = Date.now()
      this.touchList()
    }
  }

  liquidityHistoryRevision(instId, timeframe) { return this.liquidityHistoryRevisions.get(`${instId}:${timeframe}`) ?? 0 }

  observedCandidate(instrument, config, configKey, observations, errors = {}, now = Date.now()) {
    const fresh = key => this.observation(observations, key, now)
    const asOf = closedBoundary('5m', now)
    const turnover = fresh('turnover')?.value, hourly = fresh('hourly')?.value
    const result = this.evaluateLiquidity({ instrument, ticker: fresh('ticker')?.value ?? null, book: fresh('book')?.value ?? null,
      openInterest: fresh('openInterest')?.value ?? null, hourlyCandles: hourly?.asOf === closedBoundary('1H', now) ? hourly.rows : [],
      turnover24hUSDT: turnover?.asOf === asOf ? turnover.turnover : null, asOf, config })
    const required = []
    if (config.spread.enabled) required.push('ticker')
    if (config.depth.enabled || config.slippage.enabled) required.push('book')
    if (config.openInterest.enabled) required.push('openInterest')
    if (config.volume24h.enabled) required.push('turnover')
    if (config.volumeStability.enabled) required.push('hourly')
    const instrumentObservation = this.instrumentObservations.get(instrument.instId)
    const metadataFresh = instrumentObservation?.expiresAt > now
    const validObservations = required.map(fresh)
    const complete = metadataFresh && validObservations.every(Boolean)
    const status = !metadataFresh ? 'unknown' : result.status === 'verified' && complete ? 'verified' : result.status === 'failed' ? 'failed' : 'unknown'
    const leases = complete ? [instrumentObservation, ...validObservations] : []
    return this.catalogRecord({ instrument, ...(instrumentObservation ? { instrumentObservation } : {}),
      ticker: fresh('ticker')?.value ?? {}, result: { ...result, eligible: status === 'verified' },
      status, configKey, observations, observationErrors: errors,
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
      if (ticker?.expiresAt > now) observations.ticker = ticker
      const record = this.observedCandidate(instrument, config, configKey, observations, {}, now)
      this.catalogChecks.set(instrument.instId, record)
      if (record.status === 'verified') { verified.push(record); this.renewalTargets.set(instrument.instId, instrument) }
      else if (record.status === 'failed') this.renewalTargets.delete(instrument.instId)
    }
    const checks = [...this.catalogChecks.values()]
    if (checks.some(record => record.status !== 'unknown') && this.catalogSource === 'none') this.catalogSource = 'cache'
    if (checks.length && checks.every(record => record.status !== 'unknown')) this.error = ''
    this.replaceCatalog(verified)
    this.touchList()
  }

  async tickerObservations(signal, priority = 'background', force = false) {
    if (!force && this.tickerCache && Date.now() - this.tickerCache.observedAt < CATALOG_RENEW_INTERVAL) return this.tickerCache.values
    if (this.tickerTask && !this.tickerTask.signal.aborted) return this.tickerTask.task
    const task = this.get('/market/tickers', { instType: 'SWAP' }, signal, priority).then(values => {
      if (!Array.isArray(values) || !values.length) throw new Error('OKX returned no swap tickers.')
      const observedAt = Date.now()
      const observations = new Map(values.map(value => [value.instId, { value, observedAt, expiresAt: observedAt + OBSERVATION_TTL }]))
      if (!signal.aborted && !this.disposed) this.tickerCache = { values: observations, observedAt }
      return observations
    }).finally(() => { if (this.tickerTask?.task === task) this.tickerTask = null })
    this.tickerTask = { signal, task }
    return task
  }

  async checkCandidate(instrument, config, configKey, signal, priority = 'background') {
    const key = `${configKey}:${JSON.stringify(instrument)}`
    if (this.candidateTasks.has(key)) return this.candidateTasks.get(key)
    const task = this.evaluateCandidate(instrument, config, configKey, signal, priority)
      .finally(() => { if (this.candidateTasks.get(key) === task) this.candidateTasks.delete(key) })
    this.candidateTasks.set(key, task)
    return task
  }

  async evaluateCandidate(instrument, config, configKey, signal, priority) {
    const asOf = closedBoundary('5m')
    const instId = instrument.instId, observations = { ...(this.observations.get(instId) ?? {}) }
    // Keep in-flight historical facts in the same object that durable writes
    // invalidate. A correction during a live request cannot resurrect a copy.
    if (this.currentCandidate(instrument, configKey, signal)) this.observations.set(instId, observations)
    const errors = {}
    const observe = async (key, operation) => {
      try {
        const value = await operation()
        if (signal.aborted || this.disposed) return
        const now = Date.now()
        observations[key] = { value, observedAt: now, expiresAt: now + OBSERVATION_TTL }
      } catch (error) {
        // Preserve a still-valid observation, never extend it on failure.
        errors[key] = error instanceof Error ? error.message : String(error)
      }
    }
    const observeHistory = async (key, timeframe, end, count, calculate) => {
      try {
        const step = timeframeMilliseconds(timeframe), through = end - step, from = end - count * step
        let revision = this.liquidityHistoryRevision(instId, timeframe)
        let { rows } = await this.history.ensurePrices(instId, timeframe, from, through, priority, signal)
        // A source write may finish after ensurePrices read its return value.
        // Reuse that read when stable; otherwise read the corrected durable range.
        while (revision !== this.liquidityHistoryRevision(instId, timeframe)) {
          signal.throwIfAborted()
          revision = this.liquidityHistoryRevision(instId, timeframe)
          rows = await this.store.candles({ instrument: instId, timeframe, from, through }, priority)
        }
        if (!this.currentCandidate(instrument, configKey, signal)) return
        const value = calculate(rows, from, through)
        observations[key] = { value: { asOf: end, ...value }, observedAt: Date.now(), expiresAt: end + step }
      } catch (error) { errors[key] = error instanceof Error ? error.message : String(error) }
    }
    const tasks = []
    if (config.volume24h.enabled && !(this.observation(observations, 'turnover')?.value.asOf === asOf)) tasks.push(observeHistory('turnover', '5m', asOf, 288, candles => {
      this.cacheRankingCandles(instId, candles)
      const turnover = quoteTurnover24h(candles, asOf)
      if (turnover === null) throw new Error('The completed 24-hour quote-volume range is incomplete.')
      return { turnover }
    }))
    if (config.volumeStability.enabled && !(this.observation(observations, 'hourly')?.value.asOf === closedBoundary('1H', asOf))) tasks.push(observeHistory('hourly', '1H', closedBoundary('1H', asOf), 24, (rows, from) => {
      if (rows.length !== 24 || rows.some((row, index) => row.timestamp !== from + index * 3_600_000 || !row.confirmed || number(row.quoteVolume) === null)) throw new Error('Incomplete hourly source range.')
      return { rows }
    }))
    await Promise.all(tasks)
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const historicalAsOf = closedBoundary('5m')
    const historicalResult = evaluateLiquidity({ instrument, config, asOf: historicalAsOf,
      turnover24hUSDT: observations.turnover?.value.asOf === historicalAsOf ? this.observation(observations, 'turnover')?.value.turnover ?? null : null,
      hourlyCandles: observations.hourly?.value.asOf === closedBoundary('1H', historicalAsOf) ? this.observation(observations, 'hourly')?.value.rows ?? [] : [] })
    // Historical repairs can take minutes. Obtain live liquidity only after
    // those repairs, and renew the bulk ticker independently of scan age.
    // A known failing historical condition already excludes a contract; it
    // must not consume the live request budget needed by qualified contracts.
    const live = []
    if (historicalResult.status !== 'failed') live.push(this.tickerObservations(signal, priority).then(values => {
      const value = values.get(instId)
      if (!value) throw new Error(`Missing ticker observation for ${instId}.`)
      observations.ticker = value
    }).catch(error => { errors.ticker = error instanceof Error ? error.message : String(error) }))
    if (historicalResult.status !== 'failed' && (config.depth.enabled || config.slippage.enabled)) live.push(observe('book', async () => {
      const value = (await this.get('/market/books', { instId, sz: 400 }, signal, priority))[0]
      if (!value || !Array.isArray(value.bids) || !value.bids.length || !Array.isArray(value.asks) || !value.asks.length) throw new Error('Missing order-book observation.')
      return value
    }))
    if (historicalResult.status !== 'failed' && config.openInterest.enabled) live.push(observe('openInterest', async () => {
      const value = (await this.get('/public/open-interest', { instType: 'SWAP', instId }, signal, priority))[0]
      if (number(value?.oiUsd) === null || number(value?.oiUsd) < 0) throw new Error('Missing open-interest observation.')
      return value
    }))
    await Promise.all(live)
    if (!this.currentCandidate(instrument, configKey, signal)) return
    this.observations.set(instId, observations)
    const now = Date.now()
    const currentAsOf = closedBoundary('5m')
    const record = this.observedCandidate(instrument, config, configKey, observations, errors, now)
    record.preferencesRevision = this.metadata.getSettings().revision
    const { status } = record
    this.metadata.putCatalogEntry(record)
    this.catalogChecks.set(instId, record)
    if (status === 'verified') this.renewalTargets.set(instId, instrument)
    else if (status === 'failed') this.renewalTargets.delete(instId)
    const next = new Map(this.catalog)
    if (status === 'verified') next.set(instId, record)
    else next.delete(instId)
    this.catalogSource = 'live'
    this.catalogUpdatedAt = now
    this.replaceCatalog([...next.values()])
    if (status === 'verified') {
      this.track(this.updateRanking(instId, { ensure: true, asOf: currentAsOf }))
      this.track(this.history.target(instId, { historyDays: this.prefs().historyDays, asOf: currentAsOf }))
    }
  }

  currentCandidate(instrument, configKey, signal) {
    const current = this.instruments.get(instrument.instId)
    return !this.disposed && !signal.aborted && this.catalogCriteriaKey() === configKey
      && (!this.candidateIDs || this.candidateIDs.has(instrument.instId))
      && (!current || JSON.stringify(current) === JSON.stringify(instrument))
  }

  async discoverInstruments(configKey, signal, priority) {
    const instruments = await this.get('/public/instruments', { instType: 'SWAP' }, signal, priority)
    if (signal.aborted || this.catalogCriteriaKey() !== configKey) return []
    if (!Array.isArray(instruments) || !instruments.length) throw new Error('OKX returned no swap instruments; market verification is unavailable.')
    // Normalize only OKX's explicit empty multiplier for supported swaps.
    const candidates = instruments.filter(eligibleInstrument).map(value => value.ctMult === '' ? { ...value, ctMult: '1' } : value)
    if (!candidates.length) throw new Error('No supported swap instrument metadata could be verified. Retrying automatically.')
    this.candidateIDs = new Set(candidates.map(value => value.instId))
    for (const instId of this.renewalTargets.keys()) if (!this.candidateIDs.has(instId)) this.renewalTargets.delete(instId)
    for (const instId of this.catalogChecks.keys()) if (!this.candidateIDs.has(instId)) this.catalogChecks.delete(instId)
    for (const instrument of candidates) {
      const previous = this.instruments.get(instrument.instId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(instrument)) {
        const observations = this.observations.get(instrument.instId)
        if (observations) delete observations.book
      }
      this.instruments.set(instrument.instId, instrument)
      this.instrumentObservations.set(instrument.instId, { observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_TTL })
      if (this.renewalTargets.has(instrument.instId)) this.renewalTargets.set(instrument.instId, instrument)
    }
    this.replaceCatalog([...this.catalog.values()].filter(entry => this.currentCandidate(entry.instrument, configKey, signal) && this.validCatalogEntry(entry)))
    return candidates
  }

  async renewCatalog() {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.renewing) return this.renewing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = JSON.stringify(config)
    this.renewalController = controller
    this.renewalStartedAt = Date.now()
    this.renewing = (async () => {
      if (!this.renewalTargets.size) return
      // Renewal must verify current contract units and trading state as well
      // as prices. An outage cannot keep extending old instrument metadata.
      await this.discoverInstruments(configKey, controller.signal, 'foreground')
      if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
      await mapConcurrent([...this.renewalTargets.values()], 4,
        instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground'))
      this.error = ''
    })()
      .catch(error => { if (!controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error) })
      .finally(() => {
        this.renewing = null
        if (this.renewalController === controller) this.renewalController = null
        this.scheduleRenewal()
      })
    return this.renewing
  }

  scheduleRenewal() {
    if (this.renewalTimer) clearTimeout(this.renewalTimer)
    this.renewalTimer = null
    if (!this.autoRefresh || this.closing || this.disposed) return
    const due = Math.max(1, (this.renewalStartedAt ?? Date.now()) + CATALOG_RENEW_INTERVAL - Date.now())
    this.renewalTimer = setTimeout(() => { this.renewalTimer = null; this.track(this.renewCatalog()) }, due)
    this.renewalTimer.unref?.()
  }

  async refresh() {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.refreshing) return this.refreshing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = JSON.stringify(config)
    this.refreshController = controller
    const startedAt = Date.now()
    this.refreshStartedAt = startedAt
    this.refreshing = (async () => {
      try {
        this.verifyCatalog()
        const [candidates] = await Promise.all([
          this.discoverInstruments(configKey, controller.signal, 'background'),
          this.tickerObservations(controller.signal, 'background', true),
        ])
        if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
        this.verifyCatalog()
        // Previously qualified contracts get checked first, independently of
        // their position in the exchange's instrument response.
        candidates.sort((a, b) => Number(this.renewalTargets.has(b.instId)) - Number(this.renewalTargets.has(a.instId)))
        // A successful check publishes independently; the first row does not wait for the full exchange scan.
        await mapConcurrent(candidates, 4, instrument => this.checkCandidate(instrument, config, configKey, controller.signal))
        if (!controller.signal.aborted && this.catalogCriteriaKey() === configKey) {
          this.lastRefreshAt = startedAt
          this.error = ''
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.pruneCatalog()
        if (this.refreshController === controller) this.refreshController = null
        this.refreshing = null
        this.scheduleRefresh()
      }
    })()
    return this.refreshing
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (!this.autoRefresh || this.closing || this.disposed) return
    const startedAt = this.refreshStartedAt || this.lastRefreshAt
    const due = startedAt ? Math.max(1, startedAt + LATEST_CANDLE_REFRESH - Date.now()) : LATEST_CANDLE_REFRESH
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.track(this.refresh()) }, due)
    this.refreshTimer.unref?.()
  }

  async reconfigure(previousPreferences) {
    await this.ready
    const current = this.prefs(), previous = validatePreferences(previousPreferences)
    if (JSON.stringify(previous.liquidity) !== JSON.stringify(current.liquidity)) {
      this.refreshController?.abort()
      this.renewalController?.abort()
      this.catalogChecks.clear(); this.renewalTargets.clear()
      this.verifyCatalog()
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
    if (previous.historyDays !== current.historyDays) for (const instId of this.catalog.keys()) this.track(this.history.target(instId, { historyDays: current.historyDays, asOf: closedBoundary('5m') }))
    if (previous.chartTimeframe !== current.chartTimeframe) {
      this.ensureListRows(current.chartTimeframe)
      for (const instId of this.catalog.keys()) this.track(this.projectListEntry(instId, current.chartTimeframe))
    }
    this.touchList()
  }

  invalidate() {
    this.refreshController?.abort()
    this.renewalController?.abort()
    this.catalogChecks.clear(); this.renewalTargets.clear(); this.candidateIDs = null
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

  async dataAuditRequest({ action, id } = {}) {
    await this.ready
    const audit = this.history.audit
    const currentID = id ?? this.latestAuditID
    if (action === 'start') {
      const existing = currentID ? audit.get(currentID) : null
      if (existing && ['queued', 'running'].includes(existing.status)) return this.auditSnapshot(existing)
      const preferences = this.prefs(), targets = []
      for (const instrument of this.instruments.values()) for (const timeframe of LIST_TIMEFRAMES) {
        const step = timeframeMilliseconds(timeframe), through = closedBoundary(timeframe) - step
        const listedAt = Number(instrument.listTime), horizon = Math.max(0, through - preferences.historyDays * 86_400_000 + step - 200 * step)
        const from = Number.isFinite(listedAt) && listedAt > 0 ? Math.max(horizon, Math.ceil(listedAt / step) * step) : horizon
        if (from <= through) targets.push({ instrument: instrument.instId, timeframe, source: 'candles', from, through })
      }
      if (!targets.length) return { ...emptyAudit(), phase: 'completed' }
      const job = audit.start({ targets }); this.latestAuditID = job.id
      return this.auditSnapshot(job)
    }
    if (!['status', 'cancel', 'repair'].includes(action)) throw new TypeError('Unknown data audit action.')
    if (!currentID) return emptyAudit()
    const job = action === 'cancel' ? audit.cancel(currentID) : action === 'repair' ? audit.repair(currentID) : audit.get(currentID)
    return this.auditSnapshot(job)
  }

  listProgress(timeframe) {
    const frame = this.listTimeframe(timeframe), entries = [...this.catalog.keys()]
    const tasks = this.history?.sync.listTasks().filter(task => entries.includes(task.instrument) && task.timeframe === frame) ?? []
    const completed = entries.filter(instId => this.listProjectionResults.has(this.listKey(instId, frame))).length
    return { total: entries.length, completed, pending: Math.max(0, entries.length - completed),
      retrying: new Set(tasks.filter(task => task.status === 'retry').map(task => task.instrument)).size,
      unavailable: new Set(tasks.filter(task => ['unavailable', 'paused'].includes(task.status)).map(task => task.instrument)).size }
  }

  async snapshot(timeframe = this.prefs().chartTimeframe) {
    await this.ready
    this.pruneCatalog()
    const frame = this.ensureListRows(timeframe)
    let refreshScheduled = false
    if (!this.disposed && !this.closing) {
      if (this.autoRefresh && !this.refreshing && Date.now() - (this.refreshStartedAt || this.lastRefreshAt) >= LATEST_CANDLE_REFRESH) {
        refreshScheduled = true
        this.track(this.refresh())
      }
      for (const instId of this.catalog.keys()) { this.track(this.projectListEntry(instId, frame)); this.track(this.updateRanking(instId)) }
    }
    const rows = this.listRowsFor(frame)
    const catalogProgress = { total: this.candidateIDs?.size ?? this.catalogChecks.size, completed: this.catalogChecks.size, verified: 0, failed: 0, unknown: 0 }
    for (const record of this.catalogChecks.values()) {
      const status = record.status === 'verified' && !this.validCatalogEntry(record) ? 'unknown' : record.status
      catalogProgress[status] += 1
    }
    const unavailable = !this.catalog.size && catalogProgress.unknown > 0
      ? `Market verification is unavailable for ${catalogProgress.unknown} contracts because required observations are missing or expired. Retrying automatically.` : ''
    return { rows, revision: this.revision, error: this.error || unavailable, loading: refreshScheduled || this.refreshing !== null || this.renewing !== null,
      catalogProgress,
      updatedAt: this.listUpdatedAt.get(frame) ?? this.catalogUpdatedAt, listProgress: this.listProgress(frame), timeframe: frame,
      catalogSource: this.catalogSource, realtimeState: this.realtime?.getState().status ?? 'disconnected' }
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask
    this.closing = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.renewalTimer) clearTimeout(this.renewalTimer)
    this.disposeTask = (async () => {
      try { await this.ready } catch { if (this.ownsMetadata) this.metadata?.close(); return }
      // A confirmed stream event resolves only after its durable write. Drain it before aborting source work.
      await this.realtime?.close()
      this.disposed = true
      this.refreshController?.abort()
      this.renewalController?.abort()
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
