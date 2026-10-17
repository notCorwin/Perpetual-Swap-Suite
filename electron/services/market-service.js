import { join } from 'node:path'
import { evaluateMarketOpportunity, summarizeMarketBars } from './market-metrics.js'
import { PreparedChartPipeline } from './prepared-chart-service.js'
import { MetadataStore, DEFAULT_PREFERENCES, validatePreferences } from './metadata-store.js'
import { MarketHistory } from './market-history.js'
import { eligibleInstrument, evaluateLiquidity, quoteTurnover24h } from './liquidity.js'
import { rankingFromCandles, compareRanking } from './ranking.js'
import { RealtimeMarket } from './realtime-market.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const FIVE_MINUTES = 300_000
const LIST_TIMEFRAMES = ['5m', '15m', '1H']
const OBSERVATION_TTL = 90_000
const LATEST_CANDLE_REFRESH = 60_000
const HISTORICAL_STATISTICS_REFRESH = 6 * 3_600_000
const REQUEST_TIMEOUT = 12_000
const RETRY_DELAYS = [1_000]
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, statistics: 1, foreground: 2, repair: 2, prepared: 2 }
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, market: 80 })
const requestLaneFor = path => path.includes('/rubik/stat/taker-volume-contract') ? 'taker'
  : path.includes('/rubik/stat/contracts/open-interest-history') ? 'oi'
    : path.includes('/market/candles') || path.includes('/market/history-candles') ? 'candles' : 'market'
const STATISTICS_VERSION = 1
const STATISTICS_FORMAT = 0b100
const STATISTICS_OI = 0b001
const STATISTICS_TAKER = 0b010
const STATISTICS_COMPLETE = STATISTICS_OI | STATISTICS_TAKER
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
const statisticsMask = value => {
  const version = number(value?.statisticsVersion)
  // Preserve good data written by the preceding format. It was only ever
  // assigned after both direct endpoint values were present.
  if (version === 1 && number(value?.oi) !== null && number(value?.buy) !== null && number(value?.sell) !== null) return STATISTICS_COMPLETE
  return version !== null && (version & STATISTICS_FORMAT) === STATISTICS_FORMAT ? version & STATISTICS_COMPLETE : 0
}
const hasStatisticsSource = (value, source) => (statisticsMask(value) & source) === source
const statisticsVersionFor = (sources, values) => sources === STATISTICS_COMPLETE
  && number(values?.oi) !== null && number(values?.buy) !== null && number(values?.sell) !== null
  ? STATISTICS_VERSION
  : STATISTICS_FORMAT | (sources & STATISTICS_COMPLETE)
const timeframeMilliseconds = timeframe => timeframe === '5m' ? FIVE_MINUTES : timeframe === '15m' ? 900_000 : 3_600_000
const statisticsExpiryAt = (timeframe, end, observedAt = Date.now()) => observedAt
  + (end >= observedAt - timeframeMilliseconds(timeframe) * 2 ? LATEST_CANDLE_REFRESH : HISTORICAL_STATISTICS_REFRESH)

function validTakerVolumes(candle, volumes = candle) {
  const buy = number(volumes?.buy), sell = number(volumes?.sell)
  if (buy === null || sell === null || buy < 0 || sell < 0) return null
  // Both the native derivative candle and unit=1 Taker feed use contracts.
  // A confirmed traded period cannot have no taker buys and no taker sells.
  // OKX also returns these zero placeholders for unavailable older periods.
  if (candle.confirmed && buy === 0 && sell === 0 && (number(candle.volume) > 0 || number(candle.quoteVolume) > 0)) return null
  return { buy, sell }
}

function normalizedStatistics(candle) {
  const sources = statisticsMask(candle)
  const volumes = sources & STATISTICS_TAKER ? validTakerVolumes(candle) : null
  const next = {
    ...candle,
    oi: sources & STATISTICS_OI ? number(candle.oi) : null,
    buy: volumes?.buy ?? null,
    sell: volumes?.sell ?? null,
  }
  // Normalize prior numeric zero placeholders without throwing away either
  // source's observation. They are terminal nulls with a bounded lease, and
  // a healthy OI sibling must remain usable when the Taker source is absent.
  next.statisticsVersion = sources ? statisticsVersionFor(sources, next) : null
  for (const source of [STATISTICS_OI, STATISTICS_TAKER]) {
    const field = statisticsExpiryField(source)
    const missing = source === STATISTICS_OI ? next.oi === null : next.buy === null || next.sell === null
    next[field] = sources & source && missing
      ? number(candle[field]) ?? statisticsExpiryAt(candle.timeframe, candle.timestamp, number(candle.writtenAt) ?? 0)
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
    this.instruments = new Map()
    this.observations = new Map()
    this.rankings = new Map()
    this.rankingTasks = new Map()
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
      onReplace: (instId, timeframe) => this.onHistoryReplaced(instId, timeframe),
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
    if (this.autoRefresh && !this.closing) { this.realtime.start(); this.scheduleRefresh() }
    return this
  }

  validCatalogEntry(entry, now = Date.now()) {
    return Boolean(entry?.instrument?.instId && entry.ticker && entry.result?.eligible && entry.status === 'verified'
      && entry.configKey === this.catalogCriteriaKey() && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now)
  }

  readCatalog() {
    const entries = this.metadata.listCatalogEntries()
    for (const entry of entries) {
      if (entry.instrument?.instId) this.instruments.set(entry.instrument.instId, entry.instrument)
      if (entry.observations) this.observations.set(entry.instrumentID, entry.observations)
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
    return { ...entry, instrumentID: entry.instrument.instId, schemaVersion: 1,
      status: entry.status ?? (entry.result?.eligible ? 'verified' : 'failed'),
      observedAt: entry.observedAt ?? timestamp, expiresAt: entry.expiresAt ?? timestamp + OBSERVATION_TTL,
      preferencesRevision: this.metadata?.getSettings().revision ?? 0, configKey }
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
    const ranking = this.rankings.get(entry.instrument.instId)
    return { ...marketRow(entry.instrument, entry.ticker, entry.result, bars), ...(ranking?.rankingAsOf === closedBoundary('5m') ? ranking : { rankingChange: null, rankingAsOf: null }) }
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

  async updateRanking(instId, { ensure = false, asOf = closedBoundary('5m') } = {}) {
    if (this.disposed) return
    const lookback = this.prefs().rankingLookback, key = `${instId}:${lookback}:${asOf}`
    if (this.rankingTasks.has(key)) return this.rankingTasks.get(key)
    const task = (async () => {
      const through = asOf - FIVE_MINUTES, from = Math.max(0, through - lookback * 60_000)
      if (ensure) await this.history.ensurePrices(instId, '5m', from, through, 'foreground')
      const rows = await this.store.candles({ instrument: instId, timeframe: '5m', from, through }, 'background')
      const ranking = rankingFromCandles(rows, lookback, asOf)
      if (this.disposed || this.prefs().rankingLookback !== lookback || asOf !== closedBoundary('5m')) return
      this.rankings.set(instId, ranking)
      for (const frame of this.listRows.keys()) {
        const previous = this.listRows.get(frame)?.get(instId)
        if (previous) this.publishListRow(frame, { ...previous, ...ranking })
      }
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
      this.markChartDataChanged(instrument)
      if (confirmed.some(row => row.timeframe === '5m')) void this.updateRanking(instrument).catch(() => undefined)
      if (projectList) this.scheduleListProjection(instrument)
      return true
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
    const key = `${instId}:${timeframe}`
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
    this.markChartDataChanged(instId)
    this.preparedCharts.invalidate(instId, timeframe)
    this.rankings.delete(instId)
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

  observation(entry, key, now = Date.now()) {
    const value = entry[key]
    return value && Number.isSafeInteger(value.observedAt) && value.expiresAt > now ? value : null
  }

  async checkCandidate(instrument, tickerObservation, config, configKey, asOf, signal) {
    const instId = instrument.instId, observations = { ...(this.observations.get(instId) ?? {}) }
    const observe = async (key, operation) => {
      try {
        const value = await operation()
        if (signal.aborted || this.disposed) return
        const now = Date.now()
        observations[key] = { value, observedAt: now, expiresAt: now + OBSERVATION_TTL }
      } catch { /* An unsuccessful attempt never extends an earlier observation. */ }
    }
    const ticker = tickerObservation?.value
    if (tickerObservation) observations.ticker = tickerObservation
    const tasks = []
    if (config.depth.enabled || config.slippage.enabled) tasks.push(observe('book', async () => {
      const value = (await this.get('/market/books', { instId, sz: 400 }, signal, 'background'))[0]
      if (!value || !Array.isArray(value.bids) || !value.bids.length || !Array.isArray(value.asks) || !value.asks.length) throw new Error('Missing order-book observation.')
      return value
    }))
    if (config.openInterest.enabled) tasks.push(observe('openInterest', async () => {
      const value = (await this.get('/public/open-interest', { instType: 'SWAP', instId }, signal, 'background'))[0]
      if (number(value?.oiUsd) === null || number(value?.oiUsd) < 0) throw new Error('Missing open-interest observation.')
      return value
    }))
    if (config.volume24h.enabled) tasks.push(observe('turnover', async () => {
      const through = asOf - FIVE_MINUTES, from = through - 287 * FIVE_MINUTES
      await this.history.ensurePrices(instId, '5m', from, through, 'foreground', signal)
      const candles = await this.store.candles({ instrument: instId, timeframe: '5m', from, through }, 'foreground')
      const turnover = quoteTurnover24h(candles, asOf)
      if (turnover === null) throw new Error('The completed 24-hour quote-volume range is incomplete.')
      return { asOf, turnover }
    }))
    if (config.volumeStability.enabled) tasks.push(observe('hourly', async () => {
      const end = closedBoundary('1H', asOf), through = end - 3_600_000, from = through - 23 * 3_600_000
      await this.history.ensurePrices(instId, '1H', from, through, 'foreground', signal)
      const rows = await this.store.candles({ instrument: instId, timeframe: '1H', from, through }, 'foreground')
      if (rows.length !== 24 || rows.some((row, index) => row.timestamp !== from + index * 3_600_000 || !row.confirmed || number(row.quoteVolume) === null)) throw new Error('Incomplete hourly source range.')
      return { asOf: end, rows }
    }))
    await Promise.all(tasks)
    if (this.disposed || signal.aborted || this.catalogCriteriaKey() !== configKey) return
    this.observations.set(instId, observations)
    const now = Date.now(), fresh = key => this.observation(observations, key, now)
    const turnoverObservation = fresh('turnover'), hourlyObservation = fresh('hourly')
    const turnover = turnoverObservation?.value.asOf === asOf ? turnoverObservation.value.turnover : null
    const hourly = hourlyObservation?.value.asOf === closedBoundary('1H', asOf) ? hourlyObservation.value.rows : []
    const result = evaluateLiquidity({ instrument, ticker: fresh('ticker')?.value ?? null, book: fresh('book')?.value ?? null,
      openInterest: fresh('openInterest')?.value ?? null, hourlyCandles: hourly, turnover24hUSDT: turnover, asOf, config })
    const required = []
    if (config.spread.enabled) required.push('ticker')
    if (config.depth.enabled || config.slippage.enabled) required.push('book')
    if (config.openInterest.enabled) required.push('openInterest')
    if (config.volume24h.enabled) required.push('turnover')
    if (config.volumeStability.enabled) required.push('hourly')
    const validObservations = required.map(fresh)
    const complete = validObservations.every(Boolean)
    const status = result.status === 'verified' && complete ? 'verified' : result.status === 'failed' ? 'failed' : 'unknown'
    const record = this.catalogRecord({ instrument, ticker: fresh('ticker')?.value ?? ticker ?? {}, result: { ...result, eligible: status === 'verified' },
      status, configKey, observations, observedAt: validObservations.length && complete ? Math.min(...validObservations.map(value => value.observedAt)) : now,
      expiresAt: status === 'verified' ? validObservations.length ? Math.min(...validObservations.map(value => value.expiresAt)) : now + OBSERVATION_TTL : now })
    this.metadata.putCatalogEntry(record)
    const next = new Map(this.catalog)
    if (status === 'verified') next.set(instId, record)
    else next.delete(instId)
    this.catalogSource = 'live'
    this.catalogUpdatedAt = now
    this.replaceCatalog([...next.values()])
    if (status === 'verified') {
      this.track(this.updateRanking(instId, { ensure: true, asOf }))
      this.track(this.history.target(instId, { historyDays: this.prefs().historyDays, asOf }))
    }
  }

  async refresh() {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.refreshing) return this.refreshing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = JSON.stringify(config), asOf = closedBoundary('5m')
    this.refreshController = controller
    this.refreshing = (async () => {
      try {
        const [instruments, tickers] = await Promise.all([
          this.get('/public/instruments', { instType: 'SWAP' }, controller.signal, 'background'),
          this.get('/market/tickers', { instType: 'SWAP' }, controller.signal, 'background').then(values => ({ values, observedAt: Date.now() })),
        ])
        // OKX documents all swap/futures contract multipliers as 1. The API
        // sometimes omits that inapplicable variation as an empty string.
        // Keep malformed or absent metadata unknown; only normalize this explicit
        // empty field for verified USDT linear swaps, never options.
        // https://www.okx.com/help/get-started-with-okx-options
        const candidates = instruments.filter(eligibleInstrument).map(value => value.ctMult === '' ? { ...value, ctMult: '1' } : value), tickerByID = new Map(tickers.values.map(value => [value.instId, { value, observedAt: tickers.observedAt, expiresAt: tickers.observedAt + OBSERVATION_TTL }]))
        const candidateIDs = new Set(candidates.map(value => value.instId))
        for (const instrument of candidates) this.instruments.set(instrument.instId, instrument)
        this.replaceCatalog([...this.catalog.values()].filter(entry => candidateIDs.has(entry.instrument.instId) && this.validCatalogEntry(entry)))
        // A successful check publishes independently; the first row does not wait for the full exchange scan.
        await mapConcurrent(candidates, 4, instrument => this.checkCandidate(instrument, tickerByID.get(instrument.instId), config, configKey, asOf, controller.signal))
        if (!controller.signal.aborted && this.catalogCriteriaKey() === configKey) {
          this.lastRefreshAt = Date.now()
          this.error = this.catalog.size ? '' : 'No contracts currently meet all enabled liquidity requirements.'
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
    const due = this.lastRefreshAt ? Math.max(1, this.lastRefreshAt + LATEST_CANDLE_REFRESH - Date.now()) : LATEST_CANDLE_REFRESH
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.track(this.refresh()) }, due)
    this.refreshTimer.unref?.()
  }

  async reconfigure(previousPreferences) {
    await this.ready
    const current = this.prefs(), previous = validatePreferences(previousPreferences)
    if (JSON.stringify(previous.liquidity) !== JSON.stringify(current.liquidity)) {
      this.refreshController?.abort()
      if (this.refreshing) await this.refreshing
      this.replaceCatalog([...this.catalog.values()].filter(entry => this.validCatalogEntry(entry)))
      this.lastRefreshAt = 0
      if (this.autoRefresh) this.track(this.refresh())
    }
    if (previous.rankingLookback !== current.rankingLookback) {
      this.rankings.clear()
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
        const listedAt = Number(instrument.listTime), horizon = Math.max(0, through - preferences.historyDays * 86_400_000 + step - 199 * step)
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
    if (!this.disposed && !this.closing) {
      if (this.autoRefresh && !this.refreshing && Date.now() - this.lastRefreshAt >= LATEST_CANDLE_REFRESH) this.track(this.refresh())
      for (const instId of this.catalog.keys()) { this.track(this.projectListEntry(instId, frame)); this.track(this.updateRanking(instId)) }
    }
    return { rows: this.listRowsFor(frame), revision: this.revision, error: this.error, loading: this.refreshing !== null,
      updatedAt: this.listUpdatedAt.get(frame) ?? this.catalogUpdatedAt, listProgress: this.listProgress(frame), timeframe: frame,
      catalogSource: this.catalogSource, realtimeState: this.realtime?.getState().status ?? 'disconnected' }
  }

  dispose() {
    if (this.disposeTask) return this.disposeTask
    this.closing = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.disposeTask = (async () => {
      try { await this.ready } catch { if (this.ownsMetadata) this.metadata?.close(); return }
      // A confirmed stream event resolves only after its durable write. Drain it before aborting source work.
      await this.realtime?.close()
      this.disposed = true
      this.refreshController?.abort()
      this.shutdownController.abort()
      for (const controller of this.abortControllers) controller.abort()
      await this.history.close()
      await this.preparedCharts.dispose()
      await Promise.allSettled([this.refreshing, this.drainRequestQueues(), ...this.barTasks, ...this.backgroundTasks, ...this.rankingTasks.values(), ...this.candleMutations.values(), ...[...this.listProjectionTasks.values()].map(value => value.task)].filter(Boolean))
      if (this.ownsMetadata) this.metadata.close()
    })()
    return this.disposeTask
  }
}
