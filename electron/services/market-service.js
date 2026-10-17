import { barsWithIndicators } from './indicators.js'
import { evaluateMarketOpportunity, summarizeMarketBars } from './market-metrics.js'
import { PreparedChartPipeline } from './prepared-chart-service.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const USDT_TURNOVER_MINIMUM = 30_000_000
const OI_USD_MINIMUM = 5_000_000
const DEPTH_USD_MINIMUM = 100_000
const MAX_SPREAD_PERCENT = 0.05
const MAX_SLIPPAGE_PERCENT = 0.1
const MAX_HOURLY_VOLUME_RATIO = 2
const VISIBLE_CANDLES = 96
const EMA_WARMUP_CANDLES = 199

const LIST_WARMUP_CANDLES = EMA_WARMUP_CANDLES + 2
const DEFAULT_LIST_TIMEFRAME = '1H'
const LIST_TIMEFRAMES = ['5m', '15m', '1H']
const LIST_WARMUP_CONCURRENCY = 2
const FIVE_MINUTES = 300_000
const MAX_REPAIR_PAGES = 16
const RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000]
const UNAVAILABLE_RETRY_DELAY = 30_000
const LATEST_CANDLE_REFRESH = 60_000
const HISTORICAL_STATISTICS_REFRESH = 6 * 3_600_000
const HISTORY_BOUNDARY_EMPTY_RESPONSES = 3
const REQUEST_TIMEOUT = 12_000
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, warmup: 1, statistics: 2, foreground: 3, repair: 4, prepared: 5 }
// OKX applies the relevant public limits per endpoint family. A single global
// queue turns those independent budgets into artificial serial work: a candle
// repair used to hold OI and Taker behind it (and could even abort them).
// Keep one ordered worker per family, so each family remains within its own
// documented cadence while the three chart reads can make progress together.
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, market: 80 })
const requestLaneFor = path => path.includes('/rubik/stat/taker-volume-contract') ? 'taker'
  : path.includes('/rubik/stat/contracts/open-interest-history') ? 'oi'
    : path.includes('/market/candles') || path.includes('/market/history-candles') ? 'candles'
      : 'market'
// OI/Taker values are only reusable when they came from the current direct
// endpoint contract. Earlier builds derived them from 5m/USDT data, which is
// neither the requested timeframe nor the requested unit.
// `1` is the prior fully-hydrated marker. Keep writing it for complete numeric
// rows so an existing healthy cache remains valid. The format bit below is
// used only where one source has observed a terminal null.
const STATISTICS_VERSION = 1
// statisticsVersion is otherwise a persisted source-observation bitset. The
// format bit keeps it distinguishable from the previous `1` marker.
const STATISTICS_FORMAT = 0b100
const STATISTICS_OI = 0b001
const STATISTICS_TAKER = 0b010
const STATISTICS_COMPLETE = STATISTICS_OI | STATISTICS_TAKER
const statisticsExpiryField = source => source === STATISTICS_OI ? 'statisticsOIExpiresAt' : 'statisticsTakerExpiresAt'
// Bump this when liquidity eligibility semantics change. A cached catalogue
// must never survive a policy change as if it had been checked by the new one.
const CATALOG_SNAPSHOT_SCHEMA = 1
const LIQUIDITY_POLICY_VERSION = 1
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
const retryAfter = error => error instanceof RetryAfterError ? error.retryAfter : undefined
const retryLane = error => error instanceof RetryAfterError ? error.lane : undefined
const retryAfterDelay = value => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(RETRY_DELAYS[0], seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(RETRY_DELAYS[0], timestamp - Date.now()) : undefined
}
const retryPlan = (attempt, serverDelay) => {
  const nextAttempt = attempt + 1
  const serverDirected = Number.isFinite(serverDelay)
  const unavailable = !serverDirected && nextAttempt > RETRY_DELAYS.length
  return {
    attempt: nextAttempt,
    unavailable,
    // Retry-After is a server-provided minimum. Never clip it down: retrying
    // before that deadline recreates the 429 loop that blocked chart repairs.
    delay: serverDirected ? Math.max(RETRY_DELAYS[0], serverDelay) : unavailable ? UNAVAILABLE_RETRY_DELAY : RETRY_DELAYS[nextAttempt - 1],
  }
}
const requestPriority = priority => REQUEST_PRIORITY[priority] ?? REQUEST_PRIORITY.foreground
const requestWasPreempted = error => error instanceof Error && error.name === 'RequestPreemptedError'
const requestWasCancelled = error => requestWasPreempted(error) || error instanceof Error && error.name === 'AbortError'
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
const percent = (current, previous) => current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100
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

const rangeSlots = (ranges, intervalMS = FIVE_MINUTES) => ranges.reduce((total, range) => total + Math.floor((range.through - range.from) / intervalMS) + 1, 0)

function listRawRange(timeframe, end) {
  const intervalMS = timeframeMilliseconds(timeframe)
  return {
    from: end - (LIST_WARMUP_CANDLES - 1) * intervalMS,
    through: end,
  }
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

function linearNotional(price, size, instrument) {
  const contractValue = number(instrument.ctVal)
  if (price === null || size === null || contractValue === null) return 0
  return instrument.ctValCcy === 'USDT' ? size * contractValue : price * size * contractValue
}

function sideFill(levels, amount, instrument) {
  let remaining = amount, notional = 0, quantity = 0
  for (const level of levels) {
    const price = number(level[0]), size = number(level[1]), levelNotional = linearNotional(price, size, instrument)
    if (price === null || levelNotional <= 0) continue
    const take = Math.min(levelNotional, remaining), units = instrument.ctValCcy === 'USDT' ? take / number(instrument.ctVal) : take / price
    quantity += units; notional += take; remaining -= take
    if (remaining <= 0) break
  }
  return { complete: remaining <= 0, average: quantity > 0 ? notional / quantity : null, depth: amount - remaining }
}

function liquidity(instrument, ticker, book, openInterest, hourly, criteria) {
  const bid = number(ticker.bidPx), ask = number(ticker.askPx), last = number(ticker.last)
  const spread = bid === null || ask === null || bid <= 0 ? null : (ask - bid) / bid * 100
  const askFill = sideFill(Array.isArray(book.asks) ? book.asks : [], DEPTH_USD_MINIMUM, instrument), bidFill = sideFill(Array.isArray(book.bids) ? book.bids : [], DEPTH_USD_MINIMUM, instrument)
  const askSlippage = ask === null || askFill.average === null ? null : (askFill.average - ask) / ask * 100
  const bidSlippage = bid === null || bidFill.average === null ? null : (bid - bidFill.average) / bid * 100
  const confirmedHourly = hourly.filter(candle => candle[8] === '1').slice(0, 24)
  const volumes = confirmedHourly.map(candle => number(candle[7]) ?? (number(candle[5]) ?? 0) * (number(candle[4]) ?? 0)).filter(value => value > 0)
  const volumeRatio = volumes.length < 24 ? null : Math.max(...volumes) / Math.min(...volumes)
  const turnover = last === null ? null : (number(ticker.volCcy24h) ?? 0) * last, oiUSD = number(openInterest?.oiUsd)
  const reasons = [
    spread !== null && spread < MAX_SPREAD_PERCENT ? null : `Spread must be below ${MAX_SPREAD_PERCENT}%.`,
    askFill.depth >= DEPTH_USD_MINIMUM && bidFill.depth >= DEPTH_USD_MINIMUM ? null : `Both book sides need ${DEPTH_USD_MINIMUM.toLocaleString('en-US')} USDT depth.`,
    askSlippage !== null && bidSlippage !== null && askSlippage < MAX_SLIPPAGE_PERCENT && bidSlippage < MAX_SLIPPAGE_PERCENT ? null : `100k USDT slippage must be below ${MAX_SLIPPAGE_PERCENT}%.`,
    turnover !== null && turnover > USDT_TURNOVER_MINIMUM ? null : `24h turnover must exceed ${USDT_TURNOVER_MINIMUM.toLocaleString('en-US')} USDT.`,
    oiUSD !== null && oiUSD > OI_USD_MINIMUM ? null : `Open interest must exceed ${OI_USD_MINIMUM.toLocaleString('en-US')} USDT.`,
    !criteria.hourlyVolumeStabilityEnabled || volumeRatio !== null && volumeRatio < MAX_HOURLY_VOLUME_RATIO ? null : `Hourly volume max/min must be below ${MAX_HOURLY_VOLUME_RATIO}.`,
  ].filter(Boolean)
  return { eligible: reasons.length === 0, reasons, turnover, spread, oiUSD, askSlippage, bidSlippage, volumeRatio }
}

function candle(instrument, timeframe, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe, timestamp, open, high, low, close, volume: number(value[5]) ?? 0, quoteVolume: number(value[7]) ?? 0, confirmed: value[8] === '1' }
}

const candleFields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion', 'statisticsOIExpiresAt', 'statisticsTakerExpiresAt', 'confirmed']
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
  const last = number(ticker.last), metrics = summarizeMarketBars(bars), { latest, previous } = metrics
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
    logBBAboveBand: latest?.bandPosition ?? null,
    logBBExpansion: metrics.logBBExpansion,
    filterMetrics: {
      liveOpen: latest?.open ?? null,
      liveClose: latest?.close ?? null,
      ema200: latest?.ema ?? null,
      previousEMA200: previous?.ema ?? null,
      vwap14: latest?.vwap ?? null,
      bbUpper: latest?.logBBUpper ?? null,
      bbMiddle: latest?.logBBMiddle ?? null,
      bbLower: latest?.logBBLower ?? null,
      priorHigh48: metrics.priorHigh48,
      priorLow48: metrics.priorLow48,
      priorHigh96: metrics.priorHigh96,
      priorLow96: metrics.priorLow96,
      oiUSD: result.oiUSD,
      spreadPercent: result.spread,
      liveVolumeUSDT: latest?.quoteVolume ?? null,
    },
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
      logBBAboveBand: row.logBBAboveBand,
      logBBExpansion: row.logBBExpansion,
      highBreakout: row.highBreakout,
      lowBreakdown: row.lowBreakdown,
    }),
  }
}

export class MarketService {
  constructor(store, criteria = () => ({ hourlyVolumeStabilityEnabled: true }), fetcher = fetch, autoRefresh = true, { requestTimeout = REQUEST_TIMEOUT } = {}) {
    this.store = store; this.criteria = criteria; this.fetcher = fetcher; this.autoRefresh = autoRefresh
    this.catalog = new Map(); this.catalogRevision = 0; this.catalogUpdatedAt = null; this.catalogSource = 'none'; this.listRows = new Map(); this.listUpdatedAt = new Map(); this.listProjectionTasks = new Map(); this.listProjectionResults = new Map(); this.listProjectionDataVersions = new Map(); this.listCatalogProjectionTasks = new Map(); this.listProjectionVersions = new Map(); this.listWarmups = new Map(); this.listWarmupQueue = []; this.listWarmupRunning = 0; this.listGapStates = new Map()
    this.revision = 0; this.refreshing = null; this.error = ''; this.lastRefreshAt = 0; this.disposed = false
    this.hydrating = new Map(); this.lastCandleHydration = new Map(); this.instruments = new Map(); this.liveCandles = new Map()
    this.requestLanes = new Map(Object.entries(REQUEST_LANE_INTERVALS).map(([name, interval]) => [name, {
      name, interval, queue: [], task: null, running: false, active: null, nextAt: 0, rateLimitedUntil: 0,
    }]))
    this.backgroundRequestControllers = new Map(); this.refreshController = null
    this.historyBoundaries = new Map(); this.candleMutations = new Map(); this.latestCandleRetries = new Map(); this.dataRevisions = new Map(); this.shutdownController = new AbortController(); this.abortControllers = new Set(); this.barTasks = new Set(); this.disposeTask = null
    this.requestTimeout = Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : REQUEST_TIMEOUT
    this.preparedCharts = new PreparedChartPipeline({
      store,
      get: (path, parameters, priority = 'prepared') => this.get(path, parameters, this.shutdownController.signal, priority),
      parseCandle: candle,
      normalize: normalizedStatistics,
      persistCandles: (instId, rows, priority) => this.persistCandles(instId, rows, { projectList: false, priority: priority === 'chartWarm' ? 'background' : 'foreground' }),
      persistStatistics: (instrument, timeframe, end, source, values, range, priority = 'prepared') => this.persistStatisticsSource(instrument, timeframe, end, source, values, this.shutdownController.signal, priority, false, { range, projectList: false }),
      revision: instId => this.dataRevision(instId),
      liveCandles: this.liveCandles,
      instrument: instId => this.instruments.get(instId),
    })
  }

  listTimeframe(timeframe) { return LIST_TIMEFRAMES.includes(timeframe) ? timeframe : DEFAULT_LIST_TIMEFRAME }

  listKey(instrument, timeframe) { return `${timeframe}:${instrument}` }

  catalogEntry(instrument) { return this.catalog.get(instrument) }

  catalogCriteriaKey() { return `hourlyVolumeStabilityEnabled=${this.criteria()?.hourlyVolumeStabilityEnabled ? '1' : '0'}` }

  validCatalogEntry(entry) {
    return Boolean(entry && typeof entry === 'object' && entry.instrument && typeof entry.instrument.instId === 'string' && entry.instrument.instId
      && entry.ticker && typeof entry.ticker === 'object' && entry.result && typeof entry.result === 'object'
      && (entry.change24h === null || entry.change24h === undefined || Number.isFinite(Number(entry.change24h))))
  }

  async restoreCatalog() {
    const snapshot = await this.store.readCatalogSnapshot()
    if (this.disposed || !snapshot || snapshot.schemaVersion !== CATALOG_SNAPSHOT_SCHEMA || snapshot.liquidityPolicyVersion !== LIQUIDITY_POLICY_VERSION || snapshot.criteriaKey !== this.catalogCriteriaKey() || !snapshot.entries.every(entry => this.validCatalogEntry(entry))) return false
    this.catalogUpdatedAt = snapshot.savedAt
    this.catalogSource = 'cache'
    this.replaceCatalog(snapshot.entries)
    // replaceCatalog starts the durable projection in the background. Base
    // rows are ready now; local OI/Taker and indicators stream in afterward.
    return true
  }

  async persistCatalog(entries, savedAt) {
    try {
      await this.store.writeCatalogSnapshot({
        schemaVersion: CATALOG_SNAPSHOT_SCHEMA,
        liquidityPolicyVersion: LIQUIDITY_POLICY_VERSION,
        criteriaKey: this.catalogCriteriaKey(),
        savedAt,
        entries,
      })
    } catch {
      // A disk-cache failure cannot invalidate a catalogue that the current
      // live scan has already verified. The next scan will attempt it again.
    }
  }

  catalogChange(entry) { return number(entry?.change24h) }

  listComparator = (left, right) => {
    const leftChange = Math.abs(this.catalogChange(this.catalogEntry(left.instId)) ?? 0)
    const rightChange = Math.abs(this.catalogChange(this.catalogEntry(right.instId)) ?? 0)
    return rightChange - leftChange || left.instId.localeCompare(right.instId)
  }

  listRowsFor(timeframe) {
    const frame = this.listTimeframe(timeframe)
    return [...(this.listRows.get(frame)?.values() ?? [])].sort(this.listComparator)
  }

  listWarmupState(instrument, timeframe) {
    const frame = this.listTimeframe(timeframe), key = this.listKey(instrument, frame)
    let state = this.listWarmups.get(key)
    if (!state) {
      state = { instrument, timeframe: frame, status: 'idle', attempt: 0, retryAt: null, timer: null, controller: null, task: null, entry: null, lastError: '' }
      this.listWarmups.set(key, state)
    }
    return state
  }

  listProgress(timeframe) {
    const frame = this.listTimeframe(timeframe), total = this.catalog.size
    let completed = 0, retrying = 0, unavailable = 0
    for (const instrument of this.catalog.keys()) {
      const state = this.listWarmups.get(this.listKey(instrument, frame))
      if (state?.status === 'ready') completed += 1
      else if (state?.status === 'retrying') retrying += 1
      else if (state?.status === 'unavailable') unavailable += 1
    }
    return { total, completed, pending: Math.max(0, total - completed - unavailable), retrying, unavailable }
  }

  touchList() { this.revision += 1 }

  listRowFor(entry, bars = []) { return marketRow(entry.instrument, entry.ticker, entry.result, bars) }

  mergeCatalogRow(entry, previous) {
    const base = this.listRowFor(entry)
    if (!previous) return base
    // A liquidity refresh must update live catalogue values without erasing
    // indicators that were already projected from the local Parquet cache.
    return {
      ...base,
      ...previous,
      instId: base.instId,
      turnover24hUSDT: base.turnover24hUSDT,
      lastPrice: base.lastPrice,
      filterMetrics: { ...previous.filterMetrics, oiUSD: base.filterMetrics.oiUSD, spreadPercent: base.filterMetrics.spreadPercent },
    }
  }

  ensureListRows(timeframe) {
    const frame = this.listTimeframe(timeframe), current = this.listRows.get(frame) ?? new Map(), next = new Map()
    for (const entry of this.catalog.values()) next.set(entry.instrument.instId, this.mergeCatalogRow(entry, current.get(entry.instrument.instId)))
    const changed = next.size !== current.size || [...next].some(([instrument, row]) => JSON.stringify(row) !== JSON.stringify(current.get(instrument)))
    if (changed) {
      this.listRows.set(frame, next)
      this.listUpdatedAt.set(frame, this.lastRefreshAt || this.catalogUpdatedAt || Date.now())
      this.touchList()
    }
    return frame
  }

  publishListRow(timeframe, row, updatedAt = Date.now()) {
    const frame = this.listTimeframe(timeframe), current = this.listRows.get(frame) ?? new Map(), previous = current.get(row.instId)
    if (previous && JSON.stringify(previous) === JSON.stringify(row)) return false
    const next = new Map(current)
    next.set(row.instId, row)
    this.listRows.set(frame, next)
    this.listUpdatedAt.set(frame, updatedAt)
    this.touchList()
    return true
  }

  replaceCatalog(entries) {
    if (this.disposed) return false
    const next = new Map(entries.map(entry => [entry.instrument.instId, entry]))
    const changed = next.size !== this.catalog.size || [...next].some(([instrument, entry]) => JSON.stringify(entry) !== JSON.stringify(this.catalog.get(instrument)))
    // Keep the existing entry objects when a completed discovery is identical.
    // It avoids needlessly invalidating warm-up state and starting another
    // catalogue generation for data that has not changed.
    if (!changed) return false
    this.catalog = next
    for (const entry of next.values()) this.instruments.set(entry.instrument.instId, entry.instrument)
    this.catalogRevision += 1
    for (const timeframe of new Set([DEFAULT_LIST_TIMEFRAME, ...this.listRows.keys()])) {
      this.ensureListRows(timeframe)
      this.listProjectionVersions.delete(timeframe)
      // Cache projections are keyed by catalogue generation. A live refresh
      // during startup therefore begins the current generation immediately,
      // rather than waiting for an older snapshot to settle.
      void this.primeListRowsFromCache(timeframe).catch(() => undefined)
    }
    for (const [key, state] of this.listWarmups) {
      const current = this.catalogEntry(state.instrument)
      if (current && (!state.entry || state.entry === current)) continue
      if (state.timer) clearTimeout(state.timer)
      state.controller?.abort()
      this.listWarmups.delete(key)
    }
    this.listWarmupQueue = this.listWarmupQueue.filter(key => this.listWarmups.has(key))
    return true
  }

  async readListBars(entry, timeframe) {
    const frame = this.listTimeframe(timeframe), instrument = entry.instrument
    const coverage = await this.store.coverage(instrument.instId, frame)
    if (coverage.last === null) return { bars: [], end: null, range: null }
    const intervalMS = timeframeMilliseconds(frame), end = Math.floor(coverage.last / intervalMS) * intervalMS, range = listRawRange(frame, end)
    const source = await this.store.candles({ instrument: instrument.instId, timeframe: frame, ...range })
    const candles = source.map(normalizedStatistics)
    const readings = barsWithIndicators(candles, intervalMS), byHour = new Map(readings.map(value => [value.hour, value])), bars = []
    for (let hour = end; byHour.has(hour); hour -= intervalMS) bars.unshift(byHour.get(hour))
    return { bars, end, range }
  }

  publishListProjection(instrument, timeframe, projection, updatedAt) {
    const entry = this.catalogEntry(instrument)
    if (!entry) return null
    const row = this.listRowFor(entry, projection.bars)
    this.publishListRow(timeframe, row, updatedAt)
    return { row, ...projection }
  }

  invalidateListProjection(instrument) {
    this.listProjectionDataVersions.set(instrument, (this.listProjectionDataVersions.get(instrument) ?? 0) + 1)
    for (const timeframe of this.listRows.keys()) this.listProjectionResults.delete(this.listKey(instrument, timeframe))
  }

  async projectListEntry(instrument, timeframe, { updatedAt } = {}) {
    const frame = this.listTimeframe(timeframe)
    if (this.disposed || !this.catalogEntry(instrument)) return null
    const key = this.listKey(instrument, frame), dataVersion = this.listProjectionDataVersions.get(instrument) ?? 0
    const cached = this.listProjectionResults.get(key)
    if (cached?.dataVersion === dataVersion) return this.publishListProjection(instrument, frame, cached, updatedAt)
    const existing = this.listProjectionTasks.get(key)
    if (existing?.dataVersion === dataVersion) return existing.task
    let task
    task = (async () => {
      // A newer local write waits behind the in-flight read, then starts a
      // new projection for its own data version. This prevents a stale query
      // from overwriting freshly hydrated OI/Taker or candles.
      if (existing) await existing.task.catch(() => undefined)
      if (this.disposed || !this.catalogEntry(instrument)) return null
      const current = this.listProjectionResults.get(key)
      if (current?.dataVersion === dataVersion) return this.publishListProjection(instrument, frame, current, updatedAt)
      const projection = await this.readListBars(this.catalogEntry(instrument), frame)
      // A projection is data for one instrument/timeframe, not for a ticker
      // object. A liquidity refresh may replace its ticker/result while this
      // DuckDB read is in flight; use that current entry to publish the same
      // durable bars. Only a removed instrument has no valid destination.
      if (this.disposed || (this.listProjectionDataVersions.get(instrument) ?? 0) !== dataVersion) return null
      this.listProjectionResults.set(key, { ...projection, dataVersion })
      return this.publishListProjection(instrument, frame, projection, updatedAt)
    })().finally(() => {
      if (this.listProjectionTasks.get(key)?.task === task) this.listProjectionTasks.delete(key)
    })
    this.listProjectionTasks.set(key, { dataVersion, task })
    return task
  }

  async primeListRowsFromCache(timeframe) {
    if (this.disposed) return
    const frame = this.ensureListRows(timeframe), version = this.catalogRevision
    if (this.listProjectionVersions.get(frame) === version) return
    const existing = this.listCatalogProjectionTasks.get(frame)
    if (existing?.version === version) return existing.task
    const instruments = [...this.catalog.keys()], updatedAt = this.catalogSource === 'cache' ? this.catalogUpdatedAt ?? Date.now() : Date.now()
    let task
    task = (async () => {
      await Promise.all(instruments.map(async instrument => {
        try { await this.projectListEntry(instrument, frame, { updatedAt }) } catch { /* A warm-up retry will report and repair it. */ }
      }))
      if (this.disposed) return
      if (this.catalogRevision === version) this.listProjectionVersions.set(frame, version)
      // A new catalogue generation might have arrived while this one was
      // reading. Its task is normally already running from replaceCatalog;
      // this fallback also makes direct callers generation-safe.
      else void this.primeListRowsFromCache(frame).catch(() => undefined)
    })().finally(() => {
      if (this.listCatalogProjectionTasks.get(frame)?.task === task) this.listCatalogProjectionTasks.delete(frame)
    })
    this.listCatalogProjectionTasks.set(frame, { version, task })
    return task
  }

  queueListWarmup(instrument, timeframe, force = false) {
    const frame = this.listTimeframe(timeframe), entry = this.catalogEntry(instrument)
    if (!entry || this.disposed) return
    const state = this.listWarmupState(instrument, frame), now = Date.now()
    if (state.task || state.status === 'queued') return
    if (state.timer || !force && state.retryAt && state.retryAt > now) return
    if (!force && state.status === 'ready') return
    state.status = 'queued'; state.retryAt = null; state.lastError = ''
    this.listWarmupQueue.push(this.listKey(instrument, frame))
    this.touchList()
    void this.drainListWarmups()
  }

  startListWarmups(timeframe, force = false) {
    const frame = this.listTimeframe(timeframe)
    for (const instrument of this.catalog.keys()) this.queueListWarmup(instrument, frame, force)
  }

  scheduleListWarmupAt(entry, timeframe, state, message, retryAt) {
    if (this.disposed || this.catalogEntry(entry.instrument.instId) !== entry) return
    const deadline = Math.max(Date.now() + 1_000, Number.isFinite(retryAt) ? retryAt : Date.now() + RETRY_DELAYS[0])
    state.status = 'retrying'; state.retryAt = deadline; state.lastError = message
    if (state.timer) clearTimeout(state.timer)
    const timer = setTimeout(() => {
      state.timer = null
      this.queueListWarmup(entry.instrument.instId, timeframe, true)
    }, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    state.timer = timer
    this.touchList()
  }

  scheduleListWarmupRetry(entry, timeframe, state, message, serverDelay) {
    if (this.disposed || this.catalogEntry(entry.instrument.instId) !== entry) return
    const plan = retryPlan(state.attempt, serverDelay)
    state.attempt = plan.attempt
    if (plan.unavailable) state.status = 'unavailable'
    else state.status = 'retrying'
    state.retryAt = Date.now() + plan.delay; state.lastError = message
    if (state.timer) clearTimeout(state.timer)
    const timer = setTimeout(() => {
      state.timer = null
      this.queueListWarmup(entry.instrument.instId, timeframe, true)
    }, plan.delay)
    timer.unref?.()
    state.timer = timer
    this.touchList()
  }

  deferListWarmup(entry, timeframe, state) {
    this.scheduleListWarmupAt(entry, timeframe, state, 'Foreground chart activity has priority.', Date.now() + RETRY_DELAYS[0])
  }

  seriesKey(instrument, timeframe) { return `${timeframe}:${typeof instrument === 'string' ? instrument : instrument.instId}` }

  listHistoryGapKey(instrument, timeframe, gap) { return `${this.seriesKey(instrument, timeframe)}\u0000${gap.from}` }

  reconcileListGapStates(instrument, timeframe, gaps) {
    const prefix = `${this.seriesKey(instrument, timeframe)}\u0000`, active = new Set(gaps.map(gap => this.listHistoryGapKey(instrument, timeframe, gap)))
    for (const key of this.listGapStates.keys()) if (key.startsWith(prefix) && !active.has(key)) this.listGapStates.delete(key)
  }

  trackedListGap(instrument, timeframe, gap) {
    const key = this.listHistoryGapKey(instrument, timeframe, gap), previous = this.listGapStates.get(key) ?? { emptyResponses: 0 }
    const tracked = { ...gap, emptyResponses: previous.emptyResponses ?? 0 }
    this.listGapStates.set(key, { emptyResponses: tracked.emptyResponses })
    return tracked
  }

  rememberListGap(instrument, timeframe, gap) {
    this.listGapStates.set(this.listHistoryGapKey(instrument, timeframe, gap), { emptyResponses: gap.emptyResponses ?? 0 })
  }

  clearListGap(instrument, timeframe, gap) { this.listGapStates.delete(this.listHistoryGapKey(instrument, timeframe, gap)) }

  hasFreshCandleCoverage(coverage, timeframe) {
    if (coverage.last === null) return false
    const intervalMS = timeframeMilliseconds(timeframe)
    const latestLikelyComplete = Math.floor((Date.now() - intervalMS) / intervalMS) * intervalMS
    return coverage.last >= latestLikelyComplete - intervalMS
  }

  async warmListEntry(entry, timeframe, state, signal) {
    const frame = this.listTimeframe(timeframe), interrupted = () => signal.aborted || this.disposed || this.catalogEntry(entry.instrument.instId) !== entry
    try {
      // The cache prime already reads this exact window. Reuse that result to
      // inspect gaps instead of immediately enqueuing another serialized
      // DuckDB projection for every warm-up entry.
      let projection = await this.projectListEntry(entry.instrument.instId, frame)
      if (interrupted()) return
      let coverage = await this.store.coverage(entry.instrument.instId, frame)
      const hydrated = !this.hasFreshCandleCoverage(coverage, frame) && await this.hydrate(entry.instrument, frame, 'background')
      if (interrupted()) return
      coverage = await this.store.coverage(entry.instrument.instId, frame)
      if (hydrated) projection = await this.projectListEntry(entry.instrument.instId, frame)
      if (!projection || projection.end === null || !projection.range) {
        const latest = this.latestCandleRetryState(entry.instrument, frame)
        if (latest.retryAt && latest.retryAt > Date.now()) {
          this.scheduleListWarmupAt(entry, frame, state, latest.lastError || 'Cannot refresh latest candles.', latest.retryAt)
          return
        }
        throw new Error('No complete candle period is available yet.')
      }
      const intervalMS = timeframeMilliseconds(frame)
      const gaps = await this.store.missingCandleRanges({ instrument: entry.instrument.instId, timeframe: frame, ...projection.range, intervalMS })
      this.reconcileListGapStates(entry.instrument, frame, gaps)
      const boundary = this.historyBoundaries.get(this.seriesKey(entry.instrument, frame))
      const repairable = boundary === undefined ? gaps : gaps.filter(gap => gap.through >= boundary)
      let repaired = false
      for (const gap of repairable) {
        const tracked = this.trackedListGap(entry.instrument, frame, gap)
        const result = await this.repairGap(entry.instrument, frame, tracked, signal, 'background')
        if (interrupted()) return
        if (result.deferred) { this.deferListWarmup(entry, frame, state); return }
        repaired ||= result.repaired
        if (result.exhausted) { this.clearListGap(entry.instrument, frame, tracked); continue }
        if (result.remaining?.length) {
          this.rememberListGap(entry.instrument, frame, tracked)
          throw new Error('The list candle window is still incomplete.')
        }
        this.clearListGap(entry.instrument, frame, tracked)
      }
      if (repaired) {
        this.invalidateListProjection(entry.instrument.instId)
        projection = await this.projectListEntry(entry.instrument.instId, frame)
      }
      if (interrupted()) return
      const end = projection?.end
      if (!Number.isFinite(end)) throw new Error('No complete candle period is available yet.')
      if (!await this.hasCompleteStoredStatistics(entry.instrument, frame, end)) {
        const statistics = await this.hydrateStatistics(entry.instrument, frame, end, signal, 'background')
        if (!statistics.complete) throw new Error('OKX has not published a complete OI/Taker window yet.')
      }
      await this.projectListEntry(entry.instrument.instId, frame)
      if (interrupted()) return
      state.status = 'ready'; state.attempt = 0; state.retryAt = null; state.lastError = ''
      this.touchList()
    } catch (error) {
      if (interrupted()) return
      if (requestWasCancelled(error)) { this.deferListWarmup(entry, frame, state); return }
      this.scheduleListWarmupRetry(entry, frame, state, error instanceof Error ? error.message : 'Cannot warm the list data.', retryAfter(error))
    }
  }

  async drainListWarmups() {
    while (!this.disposed && this.listWarmupRunning < LIST_WARMUP_CONCURRENCY && this.listWarmupQueue.length) {
      const key = this.listWarmupQueue.shift(), state = this.listWarmups.get(key), entry = state && this.catalogEntry(state.instrument)
      if (!state || !entry || state.status !== 'queued') continue
      this.listWarmupRunning += 1
      const controller = new AbortController()
      state.status = 'loading'; state.controller = controller; state.entry = entry; this.touchList()
      let task
      task = this.warmListEntry(entry, state.timeframe, state, controller.signal).finally(() => {
        if (state.task === task) { state.task = null; state.entry = null }
        if (state.controller === controller) state.controller = null
        this.listWarmupRunning -= 1
        if (!this.disposed && this.listWarmups.get(key) === state && state.status === 'loading') this.deferListWarmup(entry, state.timeframe, state)
        void this.drainListWarmups()
      })
      state.task = task
    }
  }

  async ensureListTimeframe(timeframe) {
    const frame = this.listTimeframe(timeframe)
    // This method is intentionally the explicit "wait for cache" API used
    // by fixtures and callers that need a settled list. Regular snapshots and
    // refreshes never await it, so the window is never blocked by DuckDB.
    while (!this.disposed) {
      const version = this.catalogRevision
      await this.primeListRowsFromCache(frame)
      if (version === this.catalogRevision && this.listProjectionVersions.get(frame) === version) break
    }
    if (!this.disposed) this.startListWarmups(frame)
    return frame
  }

  scheduleListProjection(instrument) {
    if (this.disposed) return
    this.invalidateListProjection(instrument)
    if (!this.catalog.has(instrument)) return
    for (const timeframe of this.listRows.keys()) void this.projectListEntry(instrument, timeframe).catch(() => undefined)
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
    if (requestPriority(priority) > REQUEST_PRIORITY.background) this.cancelBackgroundRequests(lane)
    this.preemptLowerPriorityRequest(priority, lane)
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

  preemptLowerPriorityRequest(priority, laneName) {
    const active = this.requestLane(laneName).active
    if (!active || active.controller.signal.aborted || requestPriority(active.priority) >= requestPriority(priority)) return
    const error = new Error(`A higher-priority ${priority} request superseded ${active.priority} work.`)
    error.name = 'RequestPreemptedError'
    active.controller.abort(error)
  }

  cancelBackgroundRequests(laneName) {
    // Disposal cancels all background work. Interactive preparation may
    // preempt list work only in the same endpoint family.
    if (laneName === undefined) this.refreshController?.abort()
    for (const [controller, lane] of this.backgroundRequestControllers) {
      if (laneName === undefined || lane === laneName) controller.abort()
    }
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
    if (this.disposed || !confirmed.length) return false
    return this.enqueueCandleMutation(instrument, async () => {
      if (this.disposed) return false
      const changed = await this.appendChangedCandlesLocked(confirmed, priority)
      if (!changed.length) return false
      this.markChartDataChanged(instrument)
      if (projectList) this.scheduleListProjection(instrument)
      return true
    })
  }

  markChartDataChanged(instrument) {
    const instId = typeof instrument === 'string' ? instrument : instrument?.instId
    if (instId) this.dataRevisions.set(instId, this.dataRevision(instId) + 1)
  }

  dataRevision(instId) { return this.dataRevisions.get(instId) ?? 0 }

  statisticsWindow(rows, first, intervalMS) {
    const candlesReady = this.completeCandleRows(rows, first, intervalMS)
    if (!candlesReady) return { candlesReady: false, complete: false, status: 'loading', oiState: 'loading', takerState: 'loading' }
    const sourceState = (source, fields) => {
      if (!rows.every(value => hasStatisticsSource(value, source))) return 'loading'
      return rows.every(value => fields.every(field => number(value[field]) !== null)) ? 'ready' : 'unavailable'
    }
    const oiState = sourceState(STATISTICS_OI, ['oi'])
    const takerState = sourceState(STATISTICS_TAKER, ['buy', 'sell'])
    const complete = oiState !== 'loading' && takerState !== 'loading'
    return {
      candlesReady,
      complete,
      oiState,
      takerState,
      // A source may have terminally empty historic rows while its sibling
      // is useful. That is unavailable, not a retryable generic loading.
      status: !complete ? 'loading' : oiState === 'ready' && takerState === 'ready' ? 'ready' : 'unavailable',
    }
  }

  completeCandleRows(rows, first, intervalMS) {
    return this.completeCandleRowsOfLength(rows, first, intervalMS, VISIBLE_CANDLES)
  }

  completeCandleRowsOfLength(rows, first, intervalMS, length) {
    return rows.length === length && rows.every((value, index) => (value.timestamp ?? value.hour) === first + index * intervalMS && value.confirmed)
  }

  statisticsRange(timeframe, end) {
    const intervalMS = timeframeMilliseconds(timeframe)
    return { from: end - (VISIBLE_CANDLES - 1) * intervalMS, through: end, intervalMS }
  }

  statisticsPageRange(timeframe, end) {
    const intervalMS = timeframeMilliseconds(timeframe)
    return { from: end - 99 * intervalMS, through: end, intervalMS }
  }

  async storedStatisticsWindow(instrument, timeframe, end, priority = 'foreground') {
    const range = this.statisticsRange(timeframe, end)
    const rows = (await this.store.candles({ instrument: instrument.instId, timeframe, from: range.from, through: range.through }, priority)).map(normalizedStatistics)
    return { ...this.statisticsWindow(rows, range.from, range.intervalMS), rows, range }
  }

  async hasCompleteStoredStatistics(instrument, timeframe, end, priority = 'foreground') {
    return (await this.storedStatisticsWindow(instrument, timeframe, end, priority)).complete
  }

  statisticsExpiry(timeframe, end) {
    return statisticsExpiryAt(timeframe, end)
  }

  async persistStatisticsSource(instrument, timeframe, end, source, values, signal, priority = 'statistics', preserveExistingSource = false, { range, projectList = true } = {}) {
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

  async hydrateStatistics(instrument, timeframe, end, signal, priority = 'statistics') {
    if (this.disposed || signal?.aborted) return { changed: false, complete: false, status: 'loading', oiState: 'loading', takerState: 'loading' }
    // The visible window decides what still needs a request. The actual write
    // uses the wider 100-period page below, so its four older samples are
    // immediately reusable when the user scrolls back one wheel tick.
    const visible = await this.storedStatisticsWindow(instrument, timeframe, end, priority === 'background' ? 'background' : 'foreground')
    if (!visible.candlesReady || visible.complete) return { changed: false, ...visible }
    const { intervalMS } = visible.range
    const storePriority = priority === 'background' ? 'background' : 'foreground'
    const statisticsEnd = end + intervalMS
    const persistSource = (source, values) => this.persistStatisticsSource(instrument, timeframe, end, source, values, signal, priority)
    const operations = []
    if (visible.oiState === 'loading') operations.push(this.get('/rubik/stat/contracts/open-interest-history', { instId: instrument.instId, period: timeframe, limit: 100, end: statisticsEnd }, signal, priority).then(values => persistSource(STATISTICS_OI, values)))
    if (visible.takerState === 'loading') operations.push(this.get('/rubik/stat/taker-volume-contract', { instId: instrument.instId, period: timeframe, unit: 1, limit: 100, end: statisticsEnd }, signal, priority).then(values => persistSource(STATISTICS_TAKER, values)))
    const settled = await Promise.allSettled(operations)
    if (this.disposed || signal?.aborted) throw signal?.reason ?? new Error('The statistics request was aborted.')
    const current = await this.storedStatisticsWindow(instrument, timeframe, end, storePriority)
    const error = settled.find(result => result.status === 'rejected')?.reason
    return { changed: settled.some(result => result.status === 'fulfilled' && result.value), ...current, error }
  }

  async repairGap(instrument, timeframe, gap, signal, priority = 'background') {
    const intervalMS = timeframeMilliseconds(timeframe)
    let cursor = gap.through + intervalMS, repaired = false, remaining = [gap]
    const initialSlots = rangeSlots(remaining, intervalMS)
    const storePriority = 'background'
    for (let pageNumber = 0; cursor > gap.from && pageNumber < MAX_REPAIR_PAGES; pageNumber += 1) {
      if (signal?.aborted) return { repaired, exhausted: false, deferred: true, remaining }
      const page = await this.get('/market/history-candles', { instId: instrument.instId, bar: timeframe, limit: 300, after: cursor }, signal, priority)
      if (this.disposed || signal?.aborted) return { repaired, exhausted: false, deferred: true, remaining }
      const older = page.map(value => candle(instrument.instId, timeframe, value)).filter(value => value?.confirmed)
      if (!older.length) {
        // A successful earlier page may have advanced local coverage during
        // this same repair. Read it again before declaring a listing boundary:
        // the coverage captured by the caller can be hundreds of candles newer
        // and would permanently hide repairable history from both list and
        // chart paths.
        const currentCoverage = await this.store.coverage(instrument.instId, timeframe, storePriority)
        const unresolved = remaining.length ? remaining : [gap]
        if (currentCoverage.first !== null && unresolved.every(range => range.through < currentCoverage.first)) {
          gap.emptyResponses = (gap.emptyResponses ?? 0) + 1
          if (gap.emptyResponses >= HISTORY_BOUNDARY_EMPTY_RESPONSES) {
            const key = this.seriesKey(instrument, timeframe), previousBoundary = this.historyBoundaries.get(key)
            this.historyBoundaries.set(key, previousBoundary === undefined ? currentCoverage.first : Math.min(previousBoundary, currentCoverage.first))
            return { repaired, exhausted: true, remaining }
          }
        }
        return { repaired, exhausted: false, remaining }
      }
      gap.emptyResponses = 0
      const oldest = Math.min(...older.map(value => value.timestamp))
      if (oldest >= cursor) throw new Error('OKX history cursor did not advance.')
      await this.persistCandles(instrument.instId, older, { projectList: priority !== 'background', priority: storePriority })
      remaining = await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe, ...gap, intervalMS }, storePriority)
      repaired ||= rangeSlots(remaining, intervalMS) < initialSlots
      if (!remaining.length) return { repaired: true, exhausted: false, remaining }
      cursor = oldest
    }
    return { repaired, exhausted: false, remaining }
  }

  latestCandleRetryState(instrument, timeframe = '5m') {
    const key = this.seriesKey(instrument, timeframe)
    let state = this.latestCandleRetries.get(key)
    if (!state) {
      state = { instrument: instrument.instId, timeframe, status: 'ready', attempt: 0, retryAt: null, rateLimitLane: null, timer: null, controller: null, priority: 'foreground', lastError: '' }
      this.latestCandleRetries.set(key, state)
    }
    return state
  }

  lastCandleHydratedAt(instrument, timeframe) {
    const key = this.seriesKey(instrument, timeframe)
    return this.lastCandleHydration.get(key) ?? 0
  }

  scheduleLatestCandleRetry(instrument, timeframe, state, message, serverDelay, priority = state.priority, rateLimitLane = null) {
    if (this.disposed) return
    const plan = retryPlan(state.attempt, serverDelay)
    state.priority = priority; state.attempt = plan.attempt
    state.status = plan.unavailable ? 'unavailable' : 'retrying'
    state.retryAt = Date.now() + plan.delay
    state.rateLimitLane = rateLimitLane
    state.lastError = message
    if (state.timer) clearTimeout(state.timer)
    const timer = setTimeout(() => {
      state.timer = null
      if (!this.disposed) {
        state.retryAt = null
        void this.hydrate(instrument, timeframe, priority)
      }
    }, plan.delay)
    timer.unref?.()
    state.timer = timer
    this.markChartDataChanged(instrument)
  }

  async hydrate(instrument, timeframe = '5m', priority = 'foreground') {
    if (this.disposed) return false
    const key = this.seriesKey(instrument, timeframe), previous = this.hydrating.get(key)
    const state = this.latestCandleRetryState(instrument, timeframe)
    if (previous) {
      if (requestPriority(priority) > requestPriority(state.priority)) {
        const error = new Error(`A ${priority} candle request superseded ${state.priority} work.`)
        error.name = 'RequestPreemptedError'
        state.priority = priority
        state.controller?.abort(error)
        return previous.catch(() => false).then(() => this.hydrate(instrument, timeframe, priority))
      }
      return previous
    }
    if (requestPriority(priority) > requestPriority(state.priority)) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null; state.retryAt = null; state.status = 'ready'
    }
    if (this.lastCandleHydratedAt(instrument, timeframe) + LATEST_CANDLE_REFRESH > Date.now() || state.timer || state.retryAt && state.retryAt > Date.now()) return false
    const controller = new AbortController()
    state.controller = controller; state.priority = priority
    let task
    task = (async () => {
      const recovering = state.status !== 'ready'
      state.status = 'loading'; state.retryAt = null; state.rateLimitLane = null; state.lastError = ''
      try {
        const page = await this.get('/market/candles', { instId: instrument.instId, bar: timeframe, limit: 300 }, controller.signal, priority)
        if (this.disposed || controller.signal.aborted) return false
        const fetched = page.map(value => candle(instrument.instId, timeframe, value)).filter(Boolean)
        const confirmed = fetched.filter(value => value.confirmed)
        const live = timeframe === '5m' ? fetched.filter(value => !value.confirmed).sort((left, right) => left.timestamp - right.timestamp).at(-1) : undefined
        const previousLive = this.liveCandles.get(instrument.instId)
        const liveChanged = live ? !previousLive || !sameCandle(previousLive, live) : previousLive !== undefined
        if (live) this.liveCandles.set(instrument.instId, live)
        else this.liveCandles.delete(instrument.instId)
        if (!confirmed.length) throw new Error(`OKX returned no confirmed ${timeframe} candles.`)
        const persisted = await this.persistCandles(instrument.instId, confirmed, { priority: priority === 'background' ? 'background' : 'foreground' })
        this.lastCandleHydration.set(key, Date.now())
        state.status = 'ready'; state.attempt = 0; state.retryAt = null; state.rateLimitLane = null; state.lastError = ''
        if (!persisted && (liveChanged || recovering)) this.markChartDataChanged(instrument)
        return true
      } catch (error) {
        if (!controller.signal.aborted && !requestWasCancelled(error)) this.scheduleLatestCandleRetry(instrument, timeframe, state, error instanceof Error ? error.message : 'Cannot refresh latest candles.', retryAfter(error), priority, retryLane(error))
        else if (state.status === 'loading') { state.status = 'ready'; state.retryAt = null }
        return false
      }
    })().finally(() => {
      if (state.controller === controller) state.controller = null
      if (this.hydrating.get(key) === task) this.hydrating.delete(key)
    })
    this.hydrating.set(key, task)
    return task
  }

  prepareChartWindow(instId, timeframe, end) {
    if (this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.preparedCharts.prepare(instId, timeframe, end)
    this.barTasks.add(task)
    return task.finally(() => this.barTasks.delete(task))
  }

  setChartUniverse(instIds, timeframe, focusInstId) {
    if (this.disposed) return Promise.reject(new Error('Market service is closed.'))
    return Promise.resolve(this.preparedCharts.setUniverse(instIds, timeframe, focusInstId))
  }

  subscribePreparedCharts(listener) { return this.preparedCharts.subscribe(listener) }

  localChartWindow(instId, timeframe) {
    if (this.disposed) return Promise.reject(new Error('Market service is closed.'))
    return this.preparedCharts.local(instId, timeframe)
  }

  async dispose() {
    if (this.disposeTask) return this.disposeTask
    this.disposed = true
    for (const state of this.latestCandleRetries.values()) if (state.timer) clearTimeout(state.timer)
    for (const state of this.listWarmups.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.controller?.abort()
    }
    this.cancelBackgroundRequests()
    this.shutdownController.abort()
    const preparedClosed = this.preparedCharts.dispose()
    for (const controller of this.abortControllers) controller.abort()
    const queued = this.drainRequestQueues()
    const work = [
      this.refreshing,
      queued,
      preparedClosed,
      ...this.barTasks,
      ...this.hydrating.values(),
      ...this.candleMutations.values(),
      ...[...this.listWarmups.values()].map(state => state.task),
      ...[...this.listProjectionTasks.values()].map(state => state.task),
      ...[...this.listCatalogProjectionTasks.values()].map(state => state.task),
    ].filter(Boolean)
    this.disposeTask = Promise.allSettled(work).then(() => {
      this.latestCandleRetries.clear()
      this.listWarmups.clear()
      this.listWarmupQueue = []
      this.listGapStates.clear()
      this.listProjectionTasks.clear()
      this.listProjectionResults.clear()
      this.listProjectionDataVersions.clear()
      this.listCatalogProjectionTasks.clear()
      this.dataRevisions.clear()
    })
    return this.disposeTask
  }

  async refresh() {
    if (this.refreshing) return this.refreshing
    const controller = new AbortController()
    this.refreshController = controller
    this.refreshing = (async () => {
      let succeeded = false
      try {
        const [instruments, tickers] = await Promise.all([
          this.get('/public/instruments', { instType: 'SWAP' }, controller.signal, 'background'),
          this.get('/market/tickers', { instType: 'SWAP' }, controller.signal, 'background'),
        ])
        const tickerByID = new Map(tickers.map(ticker => [ticker.instId, ticker]))
        const candidates = instruments.filter(instrument => instrument.state === 'live' && instrument.instCategory === '1' && instrument.settleCcy === 'USDT' && instrument.instId?.endsWith('-USDT-SWAP')).filter(instrument => {
          const ticker = tickerByID.get(instrument.instId), last = number(ticker?.last), turnover = last === null ? null : (number(ticker?.volCcy24h) ?? 0) * last, bid = number(ticker?.bidPx), ask = number(ticker?.askPx)
          return turnover !== null && turnover > USDT_TURNOVER_MINIMUM && bid !== null && ask !== null && (ask - bid) / bid * 100 < MAX_SPREAD_PERCENT
        })
        candidates.forEach(instrument => this.instruments.set(instrument.instId, instrument))
        const checks = await mapConcurrent(candidates, 4, async instrument => {
          try {
            const [books, openInterest, hourly] = await Promise.all([
              this.get('/market/books', { instId: instrument.instId, sz: 400 }, controller.signal, 'background'),
              this.get('/public/open-interest', { instType: 'SWAP', instId: instrument.instId }, controller.signal, 'background'),
              this.get('/market/candles', { instId: instrument.instId, bar: '1H', limit: 25 }, controller.signal, 'background'),
            ])
            const result = liquidity(instrument, tickerByID.get(instrument.instId), books[0] ?? {}, openInterest[0], hourly, this.criteria())
            const ticker = tickerByID.get(instrument.instId)
            return { instrument, failed: false, entry: result.eligible ? { instrument, ticker, result, change24h: percent(number(ticker?.last), number(ticker?.open24h)) } : null }
          } catch { return { instrument, failed: true, entry: null } }
        })
        if (!controller.signal.aborted) {
          const failed = new Set(checks.filter(check => check.failed).map(check => check.instrument.instId))
          // A partial scan may not remove a previously verified contract just
          // because that contract's own request failed. Retain that entry in
          // memory, but only commit a new durable snapshot after a complete
          // scan has verified the whole catalogue.
          const preserved = [...this.catalog.values()].filter(entry => failed.has(entry.instrument.instId))
          const entries = [...checks.flatMap(check => check.entry ? [check.entry] : []), ...preserved]
          const complete = failed.size === 0
          if (!complete && !entries.length) throw new Error('Cannot validate the live liquidity catalogue.')
          const savedAt = Date.now()
          // A partial scan mixes newly checked candidates with the last known
          // catalog. Keep the persisted timestamp until a complete scan makes
          // the catalog wholly live again; otherwise the UI would imply a
          // successful full refresh that never happened.
          if (complete || this.catalogUpdatedAt === null) this.catalogUpdatedAt = savedAt
          this.catalogSource = complete ? 'live' : 'cache'
          this.replaceCatalog(entries)
          // The catalog is live as soon as liquidity discovery finishes. Its
          // Parquet projections continue separately; waiting for all of them
          // here made the first visible list depend on a serialized DuckDB
          // queue and recreated the apparent "blank forever" failure.
          this.startListWarmups(DEFAULT_LIST_TIMEFRAME, true)
          if (complete) {
            await this.persistCatalog(entries, savedAt)
            this.error = entries.length ? '' : 'No contracts currently meet all enabled liquidity requirements.'
          } else this.error = 'Some live liquidity checks failed; showing last verified contracts where necessary.'
          succeeded = true
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.error = error instanceof Error ? error.message : 'Cannot load OKX markets.'
      } finally {
        // A foreground chart can legitimately cancel discovery. Do not turn
        // that cancellation into a fake 60-second successful refresh delay.
        if (succeeded) this.lastRefreshAt = Date.now()
        else if (controller.signal.aborted) this.lastRefreshAt = 0
        if (this.refreshController === controller) this.refreshController = null
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  invalidate() {
    this.catalog.clear(); this.catalogRevision += 1; this.catalogUpdatedAt = null; this.catalogSource = 'none'; this.listRows.clear(); this.listUpdatedAt.clear(); this.listProjectionVersions.clear(); this.listGapStates.clear()
    for (const state of this.listWarmups.values()) { if (state.timer) clearTimeout(state.timer); state.controller?.abort() }
    this.listWarmups.clear(); this.listWarmupQueue = []; this.lastRefreshAt = 0; this.error = ''
    this.touchList()
    if (this.autoRefresh) void this.refresh()
  }

  async snapshot(timeframe = DEFAULT_LIST_TIMEFRAME) {
    const frame = this.listTimeframe(timeframe)
    if (this.autoRefresh && !this.disposed && !this.refreshing && Date.now() - this.lastRefreshAt >= LATEST_CANDLE_REFRESH) void this.refresh()
    // A renderer poll must never wait for a full catalogue projection. It can
    // render restored price/liquidity rows immediately while cache projections
    // publish their indicator readings incrementally.
    if (!this.disposed) {
      this.ensureListRows(frame)
      void this.primeListRowsFromCache(frame).catch(() => undefined)
      this.startListWarmups(frame)
    }
    return {
      rows: this.listRowsFor(frame), revision: this.revision, error: this.error, loading: this.refreshing !== null,
      updatedAt: this.listUpdatedAt.get(frame) ?? (this.lastRefreshAt || null),
      listProgress: this.listProgress(frame), timeframe: frame, catalogSource: this.catalogSource,
    }
  }
}
