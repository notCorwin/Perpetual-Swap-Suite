import { barsWithIndicators } from './indicators.js'
import { evaluateMarketOpportunity, summarizeMarketBars } from './market-metrics.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const USDT_TURNOVER_MINIMUM = 30_000_000
const OI_USD_MINIMUM = 5_000_000
const DEPTH_USD_MINIMUM = 100_000
const MAX_SPREAD_PERCENT = 0.05
const MAX_SLIPPAGE_PERCENT = 0.1
const MAX_HOURLY_VOLUME_RATIO = 2
const VISIBLE_CANDLES = 96
const EMA_WARMUP_CANDLES = 199
const CHART_HISTORY_CANDLES = 499
const CHART_FUTURE_CANDLES = 249
const LIST_WARMUP_CANDLES = EMA_WARMUP_CANDLES + 2
const DEFAULT_LIST_TIMEFRAME = '1H'
const LIST_TIMEFRAMES = ['5m', '15m', '1H']
const LIST_WARMUP_CONCURRENCY = 2
const FIVE_MINUTES = 300_000
const MAX_REPAIR_PAGES = 16
const RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000]
const UNAVAILABLE_RETRY_DELAY = 30_000
const LATEST_CANDLE_REFRESH = 60_000
const HISTORY_BOUNDARY_EMPTY_RESPONSES = 3
const REQUEST_TIMEOUT = 12_000
const REQUEST_PRIORITY = { background: 0, warmup: 1, statistics: 2, foreground: 3, repair: 4 }
// OI/Taker values are only reusable when they came from the current direct
// endpoint contract. Earlier builds derived them from 5m/USDT data, which is
// neither the requested timeframe nor the requested unit.
const STATISTICS_VERSION = 1
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
  constructor(path, retryAfter) {
    super(`OKX ${path} is rate limited.`)
    this.retryAfter = retryAfter
  }
}
class RequestTimeoutError extends Error {
  constructor(path, timeout) {
    super(`OKX ${path} timed out after ${Math.ceil(timeout / 1_000)} seconds.`)
    this.name = 'RequestTimeoutError'
  }
}
const retryAfter = error => error instanceof RetryAfterError ? error.retryAfter : undefined
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
const percent = (current, previous) => current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100
const timeframeMilliseconds = timeframe => timeframe === '5m' ? FIVE_MINUTES : timeframe === '15m' ? 900_000 : 3_600_000

const rangesOverlap = (left, right) => left.from <= right.through && right.from <= left.through
const rangeSlots = ranges => ranges.reduce((total, range) => total + Math.floor((range.through - range.from) / FIVE_MINUTES) + 1, 0)

function splitRepairRange(range, visible) {
  if (!visible || !rangesOverlap(range, visible)) return [range]
  const segments = []
  const add = (from, through) => { if (from <= through) segments.push({ from, through }) }
  add(range.from, Math.min(range.through, visible.from - FIVE_MINUTES))
  add(Math.max(range.from, visible.from), Math.min(range.through, visible.through))
  add(Math.max(range.from, visible.through + FIVE_MINUTES), range.through)
  return segments
}

// A repair job has exactly one queue class: foreground-visible or warm-up.
// Keeping that boundary in the state itself is essential. If a single job
// straddles it, a slow warm-up page inherits foreground priority and can hold
// OI/Taker (or a newly scrolled viewport) behind its request deadline.
const repairRangeClass = (range, visible) => visible && rangesOverlap(range, visible) ? 'visible' : 'warmup'

function chartBaseRange(timeframe, end) {
  const intervalMS = timeframeMilliseconds(timeframe)
  return {
    from: end - (VISIBLE_CANDLES - 1 + EMA_WARMUP_CANDLES) * intervalMS,
    through: end + intervalMS - FIVE_MINUTES,
  }
}

function chartVisibleRange(timeframe, end) {
  const intervalMS = timeframeMilliseconds(timeframe)
  return {
    from: end - (VISIBLE_CANDLES - 1) * intervalMS,
    through: end + intervalMS - FIVE_MINUTES,
  }
}

function listRawRange(timeframe, end) {
  const intervalMS = timeframeMilliseconds(timeframe)
  return {
    from: end - (LIST_WARMUP_CANDLES - 1) * intervalMS,
    through: end + intervalMS - FIVE_MINUTES,
  }
}

function chartRepairRange(timeframe, end, repairEnd = end) {
  const range = chartBaseRange(timeframe, end)
  const intervalMS = timeframeMilliseconds(timeframe)
  return {
    ...range,
    // The newest raw bucket can be incomplete while the last displayable
    // bucket is still valid. Keep that tail inside the active repair range so
    // falling back for rendering never abandons its retry.
    through: Math.max(range.through, repairEnd + intervalMS - FIVE_MINUTES),
  }
}

// Derived periods are rendered from confirmed 5m source candles. A direct
// 15m/1H statistics row can exist before its complete raw source bucket does,
// so it must never choose the latest chart end. Doing so makes the statistics
// request target one interval to the right of the bar actually rendered.
async function latestCompleteChartEnds(store, instrument, rawCoverage, timeframe, priority = 'background') {
  const rawLast = rawCoverage.last
  if (rawLast === null) return { displayEnd: null, repairEnd: null }
  if (timeframe === '5m') return { displayEnd: rawLast, repairEnd: rawLast }
  const intervalMS = timeframeMilliseconds(timeframe)
  const bucket = Math.floor(rawLast / intervalMS) * intervalMS
  const repairEnd = rawLast >= bucket + intervalMS - FIVE_MINUTES ? bucket : bucket - intervalMS
  if (rawCoverage.first === null || repairEnd < rawCoverage.first) return { displayEnd: null, repairEnd: null }

  // `coverage.last` tells us only that the final 5m row exists. Inspect a
  // bounded tail before treating its parent 15m/1H bucket as chartable: an
  // internal raw gap otherwise makes aggregation silently drop that bar.
  const searchFrom = Math.max(rawCoverage.first, repairEnd - (VISIBLE_CANDLES - 1) * intervalMS)
  const source = await store.candles({
    instrument,
    timeframe: '5m',
    from: searchFrom,
    through: repairEnd + intervalMS - FIVE_MINUTES,
  }, priority)
  const timestamps = new Set(source.map(value => value.timestamp))
  const complete = end => {
    for (let timestamp = end; timestamp < end + intervalMS; timestamp += FIVE_MINUTES) if (!timestamps.has(timestamp)) return false
    return true
  }
  for (let displayEnd = repairEnd; displayEnd >= searchFrom; displayEnd -= intervalMS) {
    if (complete(displayEnd)) return { displayEnd, repairEnd }
  }
  // There is no displayable bucket in the recent chart tail. Preserve the
  // repair target so the normal gap-retry pipeline can recover it instead of
  // treating stale direct statistics as a valid chart.
  return { displayEnd: repairEnd, repairEnd }
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

function aggregate(candles, period) {
  const groups = new Map()
  for (const candle of candles.filter(candle => candle.confirmed)) {
    const timestamp = Math.floor(candle.timestamp / period) * period, group = groups.get(timestamp) ?? []
    group.push(candle); groups.set(timestamp, group)
  }
  const expected = period / 300_000
  return [...groups].flatMap(([timestamp, group]) => {
    const ordered = group.sort((left, right) => left.timestamp - right.timestamp)
    if (ordered.length !== expected || ordered.at(-1).timestamp - ordered[0].timestamp !== period - 300_000) return []
    // OI and taker values are endpoint-specific snapshots, not values that can
    // be derived faithfully from 5m rows. They are hydrated directly for the
    // visible timeframe and remain null until that happens.
    return [{ instrument: ordered[0].instrument, timeframe: period === 900_000 ? '15m' : '1H', timestamp, open: ordered[0].open, high: Math.max(...ordered.map(candle => candle.high)), low: Math.min(...ordered.map(candle => candle.low)), close: ordered.at(-1).close, volume: ordered.reduce((sum, candle) => sum + (candle.volume ?? 0), 0), quoteVolume: ordered.reduce((sum, candle) => sum + (candle.quoteVolume ?? 0), 0), oi: null, buy: null, sell: null, statisticsVersion: null, confirmed: true }]
  })
}

function candle(instrument, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe: '5m', timestamp, open, high, low, close, volume: number(value[5]) ?? 0, quoteVolume: number(value[7]) ?? 0, confirmed: value[8] === '1' }
}

const candleFields = ['instrument', 'timeframe', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'oi', 'buy', 'sell', 'statisticsVersion', 'confirmed']
const optionalCandleFields = new Set(['oi', 'buy', 'sell', 'statisticsVersion'])

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
    this.hydrating = new Map(); this.lastCandleHydration = new Map(); this.instruments = new Map(); this.liveCandles = new Map(); this.nextRequestAt = 0; this.rateLimitedUntil = 0
    this.requestQueue = []; this.requestQueueTask = null; this.requestQueueRunning = false; this.activeRequest = null; this.backgroundRequestControllers = new Set(); this.refreshController = null
    this.historyBoundaries = new Map(); this.candleMutations = new Map(); this.candleRepairs = new Map(); this.latestCandleRetries = new Map(); this.statistics = new Map(); this.chartResults = new Map(); this.chartEnds = new Map(); this.dataRevisions = new Map(); this.activeChartInstrument = null; this.activeChartFocus = -1; this.activeChartViewport = null; this.shutdownController = new AbortController(); this.abortControllers = new Set(); this.barTasks = new Set(); this.disposeTask = null
    this.requestTimeout = Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : REQUEST_TIMEOUT
  }

  listTimeframe(timeframe) { return LIST_TIMEFRAMES.includes(timeframe) ? timeframe : DEFAULT_LIST_TIMEFRAME }

  // The derived chart end only changes when 5m coverage changes: every write
  // adds rows and rewrites never add or remove timestamps. Cache it per
  // coverage identity so repeated loads and polls skip the large source scan.
  async latestChartEnds(instrument, rawCoverage, timeframe, priority = 'background') {
    const key = `${instrument}:${timeframe}`, coverageKey = `${rawCoverage.count}:${rawCoverage.first}:${rawCoverage.last}`
    const cached = this.chartEnds.get(key)
    if (cached?.coverageKey === coverageKey) return cached.ends
    const ends = await latestCompleteChartEnds(this.store, instrument, rawCoverage, timeframe, priority)
    this.chartEnds.set(key, { coverageKey, ends })
    return ends
  }

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
    const coverage = await this.store.coverage(instrument.instId, '5m')
    const ends = await this.latestChartEnds(instrument.instId, coverage, frame)
    if (ends.displayEnd === null) return { bars: [], end: null, repairEnd: ends.repairEnd, range: null }
    const intervalMS = timeframeMilliseconds(frame), range = listRawRange(frame, ends.displayEnd)
    let candles
    if (frame === '5m') {
      const source = await this.store.candles({ instrument: instrument.instId, timeframe: '5m', ...range })
      candles = source.map(value => this.hasCurrentStatistics(value) ? value : { ...value, oi: null, buy: null, sell: null })
    } else {
      const [source, direct] = await Promise.all([
        this.store.candles({ instrument: instrument.instId, timeframe: '5m', ...range }),
        this.store.candles({ instrument: instrument.instId, timeframe: frame, from: range.from, through: ends.displayEnd }),
      ])
      const directStatistics = new Map(direct.map(value => [value.timestamp, value]))
      candles = aggregate(source, intervalMS).map(value => {
        const statistics = directStatistics.get(value.timestamp), current = this.hasCurrentStatistics(statistics)
        return { ...value, oi: current ? number(statistics.oi) : null, buy: current ? number(statistics.buy) : null, sell: current ? number(statistics.sell) : null }
      })
    }
    const readings = barsWithIndicators(candles, intervalMS), byHour = new Map(readings.map(value => [value.hour, value])), bars = []
    for (let hour = ends.displayEnd; byHour.has(hour); hour -= intervalMS) bars.unshift(byHour.get(hour))
    return { bars, end: ends.displayEnd, repairEnd: ends.repairEnd, range }
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

  listHistoryGapKey(instrument, gap) { return `${instrument.instId}\u0000${gap.from}` }

  reconcileListGapStates(instrument, gaps) {
    const prefix = `${instrument.instId}\u0000`, active = new Set(gaps.map(gap => this.listHistoryGapKey(instrument, gap)))
    for (const key of this.listGapStates.keys()) if (key.startsWith(prefix) && !active.has(key)) this.listGapStates.delete(key)
  }

  trackedListGap(instrument, gap) {
    const key = this.listHistoryGapKey(instrument, gap), previous = this.listGapStates.get(key) ?? { emptyResponses: 0 }
    const tracked = { ...gap, emptyResponses: previous.emptyResponses ?? 0 }
    this.listGapStates.set(key, { emptyResponses: tracked.emptyResponses })
    return tracked
  }

  rememberListGap(instrument, gap) {
    this.listGapStates.set(this.listHistoryGapKey(instrument, gap), { emptyResponses: gap.emptyResponses ?? 0 })
  }

  clearListGap(instrument, gap) { this.listGapStates.delete(this.listHistoryGapKey(instrument, gap)) }

  hasFreshRawCoverage(coverage) {
    if (coverage.last === null) return false
    const latestLikelyComplete = Math.floor((Date.now() - FIVE_MINUTES) / FIVE_MINUTES) * FIVE_MINUTES
    return coverage.last >= latestLikelyComplete - FIVE_MINUTES
  }

  async warmListEntry(entry, timeframe, state, signal) {
    const frame = this.listTimeframe(timeframe), interrupted = () => signal.aborted || this.disposed || this.catalogEntry(entry.instrument.instId) !== entry
    try {
      // The cache prime already reads this exact window. Reuse that result to
      // inspect gaps instead of immediately enqueuing another serialized
      // DuckDB projection for every warm-up entry.
      let projection = await this.projectListEntry(entry.instrument.instId, frame)
      if (interrupted()) return
      let coverage = await this.store.coverage(entry.instrument.instId, '5m')
      const hydrated = !this.hasFreshRawCoverage(coverage) && await this.hydrate(entry.instrument, 'background')
      if (interrupted()) return
      coverage = await this.store.coverage(entry.instrument.instId, '5m')
      if (hydrated) projection = await this.projectListEntry(entry.instrument.instId, frame)
      if (!projection || projection.end === null || !projection.range) {
        const latest = this.latestCandleRetryState(entry.instrument)
        if (latest.retryAt && latest.retryAt > Date.now()) {
          this.scheduleListWarmupAt(entry, frame, state, latest.lastError || 'Cannot refresh latest candles.', latest.retryAt)
          return
        }
        throw new Error('No complete candle period is available yet.')
      }
      const gaps = await this.store.missingCandleRanges({ instrument: entry.instrument.instId, timeframe: '5m', ...projection.range, intervalMS: FIVE_MINUTES })
      this.reconcileListGapStates(entry.instrument, gaps)
      const boundary = this.historyBoundaries.get(entry.instrument.instId)
      const repairable = boundary === undefined ? gaps : gaps.filter(gap => gap.through >= boundary)
      let repaired = false
      for (const gap of repairable) {
        const tracked = this.trackedListGap(entry.instrument, gap)
        const result = await this.repairGap(entry.instrument, tracked, signal, 'background', true)
        if (interrupted()) return
        if (result.deferred) { this.deferListWarmup(entry, frame, state); return }
        repaired ||= result.repaired
        if (result.exhausted) { this.clearListGap(entry.instrument, tracked); continue }
        if (result.remaining?.length) {
          this.rememberListGap(entry.instrument, tracked)
          throw new Error('The list candle window is still incomplete.')
        }
        this.clearListGap(entry.instrument, tracked)
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

  nextQueuedRequest() {
    let next = 0
    for (let index = 1; index < this.requestQueue.length; index += 1) {
      if (requestPriority(this.requestQueue[index].priority) > requestPriority(this.requestQueue[next].priority)) next = index
    }
    return this.requestQueue.splice(next, 1)[0]
  }

  async drainRequestQueue() {
    if (this.requestQueueRunning) return this.requestQueueTask
    this.requestQueueRunning = true
    let task
    task = (async () => {
      while (this.requestQueue.length) {
        const request = this.nextQueuedRequest()
        this.activeRequest = request
        try {
          if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
          const interval = request.path.includes('/rubik/stat/taker-volume-contract') ? 400 : request.path.includes('/rubik/stat/contracts/open-interest-history') ? 200 : 80
          const scheduled = Math.max(Date.now(), this.nextRequestAt, this.rateLimitedUntil)
          if (scheduled > Date.now()) await sleep(scheduled - Date.now(), this.shutdownController.signal, request.controller.signal)
          if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
          this.nextRequestAt = Date.now() + interval
          const timeout = setTimeout(() => request.controller.abort(new RequestTimeoutError(request.path, this.requestTimeout)), this.requestTimeout)
          timeout.unref?.()
          try {
            const data = await abortable(Promise.resolve().then(async () => {
              const response = await this.fetcher(requestURL(request.path, request.parameters), { headers: { Accept: 'application/json' }, signal: request.controller.signal })
              if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
              if (response.status === 429) {
                const serverDelay = retryAfterDelay(response.headers.get('retry-after'))
                // Headerless 429s still cool the shared queue briefly, but
                // their individual jobs use normal bounded exponential retry.
                this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
                throw new RetryAfterError(request.path, serverDelay)
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
          if (this.activeRequest === request) this.activeRequest = null
          this.shutdownController.signal.removeEventListener('abort', request.abort)
          request.requestSignal?.removeEventListener('abort', request.abort)
          this.abortControllers.delete(request.controller)
          this.backgroundRequestControllers.delete(request.controller)
        }
      }
    })().finally(() => {
      this.requestQueueRunning = false
      if (this.requestQueueTask === task) this.requestQueueTask = null
      if (this.requestQueue.length) void this.drainRequestQueue()
    })
    this.requestQueueTask = task
    return task
  }

  get(path, parameters, requestSignal, priority = 'foreground') {
    if (this.disposed || requestSignal?.aborted) throw new Error('Market service is closed.')
    if (requestPriority(priority) > REQUEST_PRIORITY.background) this.cancelBackgroundRequests()
    this.preemptLowerPriorityRequest(priority)
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.shutdownController.signal.addEventListener('abort', abort, { once: true })
    requestSignal?.addEventListener('abort', abort, { once: true })
    this.abortControllers.add(controller)
    if (priority === 'background') this.backgroundRequestControllers.add(controller)
    const result = new Promise((resolve, reject) => {
      this.requestQueue.push({ path, parameters, requestSignal, priority, controller, abort, resolve, reject })
      void this.drainRequestQueue()
    })
    controller.signal.addEventListener('abort', () => { void this.drainRequestQueue() }, { once: true })
    return result
  }

  preemptLowerPriorityRequest(priority) {
    const active = this.activeRequest
    if (!active || active.controller.signal.aborted || requestPriority(active.priority) >= requestPriority(priority)) return
    const error = new Error(`A higher-priority ${priority} request superseded ${active.priority} work.`)
    error.name = 'RequestPreemptedError'
    active.controller.abort(error)
  }

  cancelBackgroundRequests() {
    this.refreshController?.abort()
    for (const controller of this.backgroundRequestControllers) controller.abort()
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
    if (changed.length) await this.store.appendCandles(changed, priority)
    return changed
  }

  async rebuildDerivedLocked(instrument, changed, priority = 'background') {
    if (!changed.length) return
    const first = Math.min(...changed.map(value => value.timestamp)), last = Math.max(...changed.map(value => value.timestamp))
    for (const period of [900_000, 3_600_000]) {
      const from = Math.floor(first / period) * period
      const through = Math.floor(last / period) * period + period - FIVE_MINUTES
      const source = await this.store.candles({ instrument, timeframe: '5m', from, through }, priority)
      await this.appendChangedCandlesLocked(aggregate(source, period), priority)
    }
  }

  async persistCandles(instrument, candles, { projectList = true, priority = 'foreground' } = {}) {
    const confirmed = candles.filter(value => value.confirmed)
    if (this.disposed || !confirmed.length) return false
    return this.enqueueCandleMutation(instrument, async () => {
      if (this.disposed) return false
      const changed = await this.appendChangedCandlesLocked(confirmed, priority)
      if (!changed.length) return false
      await this.rebuildDerivedLocked(instrument, changed, priority)
      this.markChartDataChanged(instrument)
      if (projectList) this.scheduleListProjection(instrument)
      return true
    })
  }

  markChartDataChanged(instrument) {
    const instId = typeof instrument === 'string' ? instrument : instrument?.instId
    // Chart results and revisions are per instrument. A list warm-up write
    // for another contract must not invalidate the focused chart's cached
    // bars or force its renderer to refetch data that has not changed.
    if (instId) {
      this.dataRevisions.set(instId, this.dataRevision(instId) + 1)
      for (const key of this.chartResults.keys()) if (key.startsWith(`${instId}:`)) this.chartResults.delete(key)
    }
  }

  dataRevision(instId) { return this.dataRevisions.get(instId) ?? 0 }

  statisticsKey(instrument, timeframe, end) { return `${instrument.instId}:${timeframe}:${end}` }

  isActiveChartInstrument(instrument) { return this.activeChartInstrument === null || this.activeChartInstrument === instrument.instId }

  isActiveStatistics(instrument, timeframe, end) {
    if (!this.isActiveChartInstrument(instrument)) return false
    // Once a chart has focus, statistics belong to its explicit viewport.
    // During a focus transition there is deliberately no active viewport, so
    // an aborted old task must not restart itself in that short interval.
    if (this.activeChartInstrument !== null && this.activeChartViewport === null) return false
    return this.activeChartViewport === null || this.activeChartViewport.instrument === instrument.instId && this.activeChartViewport.timeframe === timeframe && this.activeChartViewport.end === end
  }

  statisticsState(instrument, timeframe, end) {
    const key = this.statisticsKey(instrument, timeframe, end)
    let state = this.statistics.get(key)
    if (!state) {
      state = { status: 'ready', attempt: 0, retryAt: null, expiresAt: 0, timer: null, task: null, controller: null, lastError: '' }
      this.statistics.set(key, state)
    }
    return state
  }

  completeStatisticsRows(rows, first, intervalMS) {
    return rows.length === VISIBLE_CANDLES && rows.every((value, index) => value.timestamp === first + index * intervalMS
      && number(value.oi) !== null && number(value.buy) !== null && number(value.sell) !== null
      && number(value.statisticsVersion) === STATISTICS_VERSION)
  }

  hasCurrentStatistics(value) {
    return number(value?.statisticsVersion) === STATISTICS_VERSION
  }

  async hasCompleteStoredStatistics(instrument, timeframe, end, priority = 'foreground') {
    const intervalMS = timeframeMilliseconds(timeframe)
    const first = end - (VISIBLE_CANDLES - 1) * intervalMS
    const rows = await this.store.candles({ instrument: instrument.instId, timeframe, from: first, through: end }, priority)
    return this.completeStatisticsRows(rows, first, intervalMS)
  }

  statisticsExpiry(timeframe, end) {
    return end >= Date.now() - timeframeMilliseconds(timeframe) * 2 ? Date.now() + 60_000 : Infinity
  }

  isRateLimitedRetry(state, now = Date.now()) {
    return Number.isFinite(state?.retryAt) && state.retryAt > now && this.rateLimitedUntil > now
  }

  scheduleStatisticsRetry(instrument, timeframe, end, state, message, serverDelay) {
    if (this.disposed || !this.isActiveStatistics(instrument, timeframe, end)) return
    const plan = retryPlan(state.attempt, serverDelay)
    state.attempt = plan.attempt
    state.status = plan.unavailable ? 'unavailable' : 'retrying'
    state.retryAt = Date.now() + plan.delay
    state.lastError = message
    if (state.timer) clearTimeout(state.timer)
    const timer = setTimeout(() => {
      state.timer = null
      if (!this.disposed && this.isActiveStatistics(instrument, timeframe, end)) this.requestStatistics(instrument, timeframe, end)
    }, plan.delay)
    timer.unref?.()
    state.timer = timer
  }

  requestStatistics(instrument, timeframe, end) {
    if (this.disposed) return { status: 'unavailable', retryAt: null }
    const state = this.statisticsState(instrument, timeframe, end), key = this.statisticsKey(instrument, timeframe, end), now = Date.now()
    if (!this.isActiveStatistics(instrument, timeframe, end)) return state
    if (state.task || state.timer || state.retryAt && state.retryAt > now || state.status === 'ready' && state.expiresAt > now) return state
    state.status = 'loading'; state.retryAt = null; state.lastError = ''
    const controller = new AbortController()
    state.controller = controller
    let task
    task = (async () => {
      let changed = false
      try {
        // A process restart or a bounded in-memory state cache must not turn
        // verified, current-contract OI/Taker into another pair of requests.
        const stored = await this.hasCompleteStoredStatistics(instrument, timeframe, end)
        if (this.disposed || controller.signal.aborted || !this.isActiveStatistics(instrument, timeframe, end)) return
        const result = stored ? { changed: false, complete: true } : await this.hydrateStatistics(instrument, timeframe, end, controller.signal)
        if (this.disposed || controller.signal.aborted || !this.isActiveStatistics(instrument, timeframe, end)) return
        changed = result.changed
        if (result.complete) {
          state.status = 'ready'; state.attempt = 0; state.retryAt = null
          state.expiresAt = this.statisticsExpiry(timeframe, end)
        } else this.scheduleStatisticsRetry(instrument, timeframe, end, state, 'OKX has not published a complete OI/Taker window yet.')
      } catch (error) {
        if (!controller.signal.aborted) this.scheduleStatisticsRetry(instrument, timeframe, end, state, error instanceof Error ? error.message : 'Cannot load OI/Taker data.', retryAfter(error))
      } finally {
        if (state.task === task) state.task = null
        if (state.controller === controller) state.controller = null
        if (!this.isActiveStatistics(instrument, timeframe, end) && !(state.status === 'ready' && state.expiresAt > Date.now())) this.statistics.delete(key)
        else if (controller.signal.aborted && !this.disposed) {
          state.status = 'ready'; state.retryAt = null
          queueMicrotask(() => { if (!this.disposed && this.isActiveStatistics(instrument, timeframe, end)) this.requestStatistics(instrument, timeframe, end) })
        }
        if (changed) this.markChartDataChanged(instrument.instId)
      }
    })()
    state.task = task
    return state
  }

  // Candle repair progress can complete the raw window an OI/Taker retry is
  // waiting for. Clearing the retry backoff lets statistics follow the data
  // instead of a timer that no longer reflects OKX availability.
  promoteStatistics(instId) {
    const viewport = this.activeChartViewport
    if (this.disposed || viewport?.instrument !== instId || !Number.isFinite(viewport.end)) return
    const state = this.statistics.get(`${instId}:${viewport.timeframe}:${viewport.end}`)
    if (!state || state.task || state.timer || this.isRateLimitedRetry(state)) return
    state.retryAt = null
    this.requestStatistics({ instId }, viewport.timeframe, viewport.end)
  }

  async hydrateStatistics(instrument, timeframe, end, signal, priority = 'statistics') {
    if (this.disposed || signal?.aborted) return { changed: false, complete: false }
    const intervalMS = timeframeMilliseconds(timeframe)
    const statisticsEnd = end + intervalMS
    // Background list warm-up shares this code path; its DuckDB work must
    // stay behind foreground chart reads in the store lane.
    const storePriority = priority === 'background' ? 'background' : 'foreground'
    const requests = new AbortController()
    const abort = () => requests.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let openInterest, taker
    try {
      ;[openInterest, taker] = await Promise.all([
        this.get('/rubik/stat/contracts/open-interest-history', { instId: instrument.instId, period: timeframe, limit: 100, end: statisticsEnd }, requests.signal, priority),
        this.get('/rubik/stat/taker-volume-contract', { instId: instrument.instId, period: timeframe, unit: 1, limit: 100, end: statisticsEnd }, requests.signal, priority),
      ])
    } catch (error) {
      requests.abort()
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    // Both endpoints report contracts here: OI is the first OI field and
    // taker rows are [timestamp, sell contracts, buy contracts].
    const oiByHour = new Map(openInterest.map(value => [Number(value[0]), number(value[1])]))
    const takerByHour = new Map(taker.map(value => [Number(value[0]), { sell: number(value[1]), buy: number(value[2]) }]))
    const first = end - (VISIBLE_CANDLES - 1) * intervalMS
    const result = await this.enqueueCandleMutation(instrument.instId, async () => {
      if (this.disposed || signal?.aborted || requests.signal.aborted) return { changed: false, complete: false }
      // A chart intentionally rebuilds 15m/1H bars from raw 5m data so a
      // partial derived Parquet range cannot make scrolling stutter. Build
      // the same direct rows before writing OI/Taker; otherwise a partially
      // interrupted derived rebuild would leave most statistics nowhere to
      // attach and retry forever.
      const rebuilt = timeframe === '5m' ? [] : aggregate(await this.store.candles({
        instrument: instrument.instId,
        timeframe: '5m',
        from: first,
        through: end + intervalMS - FIVE_MINUTES,
      }, storePriority), intervalMS).filter(value => value.timestamp >= first && value.timestamp <= end)
      if (this.disposed || signal?.aborted || requests.signal.aborted) return { changed: false, complete: false }
      const rebuiltChanged = rebuilt.length ? await this.appendChangedCandlesLocked(rebuilt, storePriority) : []
      const local = await this.store.candles({ instrument: instrument.instId, timeframe, from: first, through: end }, storePriority)
      const patched = local.flatMap(value => {
        // Map.has deliberately distinguishes a missing endpoint row from a
        // row whose value is null. The former leaves a previously verified
        // observation alone; the latter is an explicit current response and
        // must not be backfilled from legacy unit=2 data.
        const hasOI = oiByHour.has(value.timestamp)
        const hasTaker = takerByHour.has(value.timestamp)
        if (!hasOI && !hasTaker) return []
        const current = this.hasCurrentStatistics(value)
        const oi = hasOI ? oiByHour.get(value.timestamp) : current ? number(value.oi) : null
        const volumes = hasTaker ? takerByHour.get(value.timestamp) : current ? { sell: number(value.sell), buy: number(value.buy) } : null
        return [{
          ...value,
          oi: oi ?? null,
          sell: volumes?.sell ?? null,
          buy: volumes?.buy ?? null,
          // Any field retained above is either from this direct request or
          // from an earlier direct request using the same contract. Legacy
          // 5m/USDT values are deliberately discarded rather than shown.
          statisticsVersion: STATISTICS_VERSION,
          replaceStatistics: true,
        }]
      })
      const changed = await this.appendChangedCandlesLocked(patched, storePriority)
      if (timeframe === '5m' && changed.length) await this.rebuildDerivedLocked(instrument.instId, changed, storePriority)
      const stored = await this.store.candles({ instrument: instrument.instId, timeframe, from: first, through: end }, storePriority)
      return { changed: rebuiltChanged.length > 0 || changed.length > 0, complete: this.completeStatisticsRows(stored, first, intervalMS) }
    })
    if (result.changed) this.scheduleListProjection(instrument.instId)
    return result
  }

  pauseInactiveStatistics(activeKey = null) {
    const now = Date.now()
    for (const [key, state] of this.statistics) {
      if (key === activeKey) {
        if (this.isRateLimitedRetry(state, now)) continue
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        state.retryAt = null
        continue
      }
      if (state.status === 'ready' && state.expiresAt > now) continue
      if (this.isRateLimitedRetry(state, now)) continue
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      state.retryAt = null
      state.controller?.abort()
      if (!state.task && !(state.status === 'ready' && state.expiresAt > now)) this.statistics.delete(key)
    }
  }

  pauseInactiveCandleRepairs(activeInstrument) {
    const now = Date.now()
    for (const [instrument, state] of this.candleRepairs) {
      if (instrument === activeInstrument) continue
      if (state.timer && !this.isRateLimitedRetry(state, now)) {
        clearTimeout(state.timer)
        state.timer = null
      }
      state.controller?.abort()
      for (const range of state.ranges) {
        if (range.status === 'loading') {
          range.status = 'queued'
          range.retryAt = null
          range.lastError = ''
        }
      }
      this.updateCandleRepairState(state)
    }
  }

  activateChartViewport(instrument, timeframe, end, latest = false, repairEnd = end) {
    if (!this.isActiveChartInstrument(instrument)) return
    // Hydrating the live 5m page is useful only while the viewport actually
    // follows latest. A same-instrument history jump must release its queued
    // slot immediately instead of waiting for the request deadline.
    if (!latest) this.pauseLatestCandleHydration(instrument)
    const next = { instrument: instrument.instId, timeframe, end, latest, repairEnd }
    if (this.activeChartViewport?.instrument === next.instrument && this.activeChartViewport.timeframe === next.timeframe && this.activeChartViewport.end === next.end && this.activeChartViewport.latest === next.latest && this.activeChartViewport.repairEnd === next.repairEnd) return
    this.activeChartViewport = next
    // The initial latest request has no confirmed end until it returns. It is
    // still an intentional latest viewport for cancellation/retry purposes,
    // but must not run gap-priority math against a fake epoch timestamp.
    if (latest && !Number.isFinite(end)) return
    this.pauseInactiveStatistics(this.statisticsKey(instrument, timeframe, end))
    const repairs = this.candleRepairs.get(instrument.instId)
    const repairable = chartRepairRange(timeframe, end, repairEnd)
    const visible = chartVisibleRange(timeframe, end)
    const repartitioned = repairs ? this.repartitionCandleRepairRanges(repairs, visible) : { changed: false, currentSplit: false }
    let reclassified = false
    if (repairs?.controller && repairs.currentRange) {
      const priorityChanged = repairs.currentPriority && repairs.currentPriority !== this.repairPriority(instrument, repairs.currentRange)
      if (!rangesOverlap(repairs.currentRange, repairable) || repartitioned.currentSplit || priorityChanged) {
        // A request can only keep its original priority while it remains in the
        // same queue class. Requeue it and let the new viewport select it again
        // rather than letting an old foreground/warm-up request occupy the lane.
        if (!repartitioned.currentSplit) {
          repairs.currentRange.status = 'queued'
          repairs.currentRange.retryAt = null
          repairs.currentRange.lastError = ''
        }
        reclassified = true
        repairs.controller.abort()
      }
    }
    const now = Date.now()
    let promoted = false
    for (const range of repairs?.ranges ?? []) {
      if (!rangesOverlap(range, repairable) || range.status !== 'retrying' && range.status !== 'unavailable') continue
      // Foreground promotion must never erase an explicit server cooldown.
      // Keeping retryAt visible also stops the renderer from polling this
      // viewport while the shared request lane correctly waits for OKX.
      if (this.isRateLimitedRetry(range, now)) continue
      range.status = 'queued'
      range.retryAt = null
      promoted = true
    }
    if (repairs?.timer && (repartitioned.changed || reclassified || promoted || repairs.ranges.some(range => range.status === 'queued' && rangesOverlap(range, repairable)))) {
      clearTimeout(repairs.timer)
      repairs.timer = null
    }
    if (repairs && (repartitioned.changed || reclassified || promoted || repairs.ranges.some(range => range.status === 'queued' && rangesOverlap(range, repairable)))) {
      this.updateCandleRepairState(repairs)
      this.scheduleCandleRepair(instrument, repairs)
    }
  }

  activeRepairViewport(instrument) {
    if (this.activeChartInstrument === null) return null
    const viewport = this.activeChartViewport
    if (this.activeChartInstrument !== instrument.instId || viewport?.instrument !== instrument.instId || !Number.isFinite(viewport.end)) return undefined
    return chartRepairRange(viewport.timeframe, viewport.end, viewport.repairEnd ?? viewport.end)
  }

  activeVisibleRepairRange(instrument) {
    const viewport = this.activeChartViewport
    if (this.activeChartInstrument !== instrument.instId || viewport?.instrument !== instrument.instId || !Number.isFinite(viewport.end)) return null
    return chartVisibleRange(viewport.timeframe, viewport.end)
  }

  canRepairRange(instrument, range) {
    const viewport = this.activeRepairViewport(instrument)
    return viewport !== undefined && (viewport === null || rangesOverlap(range, viewport))
  }

  repairPriority(instrument, range) {
    if (this.activeChartInstrument === null) return 'repair'
    const viewport = this.activeChartViewport
    if (viewport?.instrument !== instrument.instId || !Number.isFinite(viewport.end)) return 'warmup'
    return rangesOverlap(range, chartVisibleRange(viewport.timeframe, viewport.end)) ? 'repair' : 'warmup'
  }

  ownsForeground(instrument, focusToken) {
    return focusToken === undefined || this.activeChartInstrument === instrument && this.activeChartFocus === focusToken
  }

  isActiveChartViewport(instrument, timeframe, targetEnd) {
    const viewport = this.activeChartViewport
    return viewport?.instrument === instrument && viewport.timeframe === timeframe && (targetEnd === undefined ? viewport.latest : viewport.end === targetEnd)
  }

  candleRepairState(instrument) {
    let state = this.candleRepairs.get(instrument)
    if (!state) {
      state = { ranges: [], status: 'ready', retryAt: null, timer: null, scheduled: false, running: false, controller: null, currentRange: null, currentPriority: null, lastError: '' }
      this.candleRepairs.set(instrument, state)
    }
    return state
  }

  updateCandleRepairState(state) {
    const active = state.ranges.filter(range => range.status !== 'exhausted')
    if (!state.ranges.length) {
      state.status = 'ready'; state.retryAt = null; state.lastError = ''
      return
    }
    if (!active.length) {
      state.status = 'exhausted'; state.retryAt = null; state.lastError = ''
      return
    }
    state.status = active.some(range => range.status === 'queued' || range.status === 'loading') ? 'loading'
      : active.some(range => range.status === 'retrying') ? 'retrying' : 'unavailable'
    const retryAt = active.map(range => range.retryAt).filter(Number.isFinite)
    state.retryAt = retryAt.length ? Math.min(...retryAt) : null
    state.lastError = active.find(range => range.lastError)?.lastError ?? ''
  }

  repartitionCandleRepairRanges(state, visible) {
    if (!visible) return { changed: false, currentSplit: false }
    let changed = false, currentSplit = false
    const ranges = state.ranges.flatMap(range => {
      const pieces = splitRepairRange(range, visible)
      if (pieces.length === 1) return [range]
      changed = true
      const loading = range.status === 'loading'
      if (range === state.currentRange) currentSplit = true
      return pieces.map(piece => ({
        ...range,
        ...piece,
        // The original request is no longer valid once a loading range is
        // partitioned. It will be aborted by viewport activation and these
        // pieces are independently selected on the next pass.
        status: loading ? 'queued' : range.status,
        retryAt: loading ? null : range.retryAt,
        lastError: loading ? '' : range.lastError,
      }))
    })
    if (changed) state.ranges = ranges
    // This also covers a direct ensureChartRange() call made without a
    // foreground activation. A split loading job must not continue using the
    // pre-split range object.
    if (currentSplit && state.controller && !state.controller.signal.aborted) state.controller.abort()
    return { changed, currentSplit }
  }

  enqueueMissingCandleRepairs(state, missing, visible) {
    let added = this.repartitionCandleRepairRanges(state, visible).changed
    for (const gap of missing.flatMap(range => splitRepairRange(range, visible))) {
      const category = repairRangeClass(gap, visible)
      const covered = state.ranges.some(range => range.status !== 'exhausted' && repairRangeClass(range, visible) === category && range.from <= gap.from && range.through >= gap.through)
      if (covered) continue
      // Never merge across visible/warm-up classes. They deliberately have
      // different request priorities and cancellation behaviour.
      const overlapping = state.ranges.filter(range => range.status !== 'exhausted' && repairRangeClass(range, visible) === category && rangesOverlap(range, gap))
      if (overlapping.length) {
        state.ranges = state.ranges.filter(range => !overlapping.includes(range))
        state.ranges.push({
          from: Math.min(gap.from, ...overlapping.map(range => range.from)),
          through: Math.max(gap.through, ...overlapping.map(range => range.through)),
          attempt: 0, emptyResponses: 0, status: 'queued', retryAt: null, lastError: '',
        })
      } else state.ranges.push({ ...gap, attempt: 0, emptyResponses: 0, status: 'queued', retryAt: null, lastError: '' })
      added = true
    }
    this.updateCandleRepairState(state)
    return added
  }

  replaceCandleRepairRange(state, current, missing, reset = false, visible = null) {
    const index = state.ranges.indexOf(current)
    if (index < 0) return []
    const replacement = missing.flatMap(range => splitRepairRange(range, visible)).map(range => ({
      ...range,
      attempt: reset ? 0 : current.attempt,
      emptyResponses: reset ? 0 : current.emptyResponses ?? 0,
      status: reset ? 'queued' : current.status,
      retryAt: reset ? null : current.retryAt,
      lastError: reset ? '' : current.lastError,
    }))
    state.ranges.splice(index, 1, ...replacement)
    return replacement
  }

  nextCandleRepair(instrument, state) {
    this.repartitionCandleRepairRanges(state, this.activeVisibleRepairRange(instrument))
    const viewport = this.activeRepairViewport(instrument)
    if (viewport === undefined) return { range: null, retryAt: null }
    const active = state.ranges.filter(range => range.status !== 'exhausted' && (viewport === null || rangesOverlap(range, viewport)))
    const now = Date.now()
    const runnable = active.filter(range => !Number.isFinite(range.retryAt) || range.retryAt <= now)
    if (runnable.length) {
      const visible = this.activeChartViewport?.instrument === instrument.instId && Number.isFinite(this.activeChartViewport.end)
        ? chartVisibleRange(this.activeChartViewport.timeframe, this.activeChartViewport.end) : null
      runnable.sort((left, right) => {
        const rightVisible = visible && rangesOverlap(right, visible) ? 1 : 0
        const leftVisible = visible && rangesOverlap(left, visible) ? 1 : 0
        return rightVisible - leftVisible || (left.status === 'queued' ? -1 : 0) - (right.status === 'queued' ? -1 : 0) || right.through - left.through
      })
      return { range: runnable[0], retryAt: null }
    }
    const retryAt = active.map(range => range.retryAt).filter(Number.isFinite)
    return { range: null, retryAt: retryAt.length ? Math.min(...retryAt) : null }
  }

  canRepairActiveViewport(instrument) {
    return this.activeRepairViewport(instrument) !== undefined
  }

  scheduleCandleRepair(instrument, state) {
    if (this.disposed || !this.canRepairActiveViewport(instrument) || state.running || state.timer || state.scheduled) return
    const { range, retryAt } = this.nextCandleRepair(instrument, state)
    if (range) {
      state.scheduled = true
      queueMicrotask(() => {
        state.scheduled = false
        if (this.disposed || !this.canRepairActiveViewport(instrument)) return
        const task = this.runCandleRepair(instrument, state)
        state.task = task
        void task.finally(() => {
          if (state.task === task) state.task = null
        }).catch(() => undefined)
      })
    } else if (retryAt !== null) {
      const timer = setTimeout(() => {
        state.timer = null
        if (this.disposed || !this.canRepairActiveViewport(instrument)) return
        const task = this.runCandleRepair(instrument, state)
        state.task = task
        void task.finally(() => {
          if (state.task === task) state.task = null
        }).catch(() => undefined)
      }, Math.max(0, retryAt - Date.now()))
      timer.unref?.()
      state.timer = timer
    }
  }

  retryCandleRepairRange(range, message, serverDelay) {
    const plan = retryPlan(range.attempt, serverDelay)
    range.attempt = plan.attempt
    range.status = plan.unavailable ? 'unavailable' : 'retrying'
    range.retryAt = Date.now() + plan.delay
    range.lastError = message
  }

  async repairGap(instrument, gap, signal, priority = this.repairPriority(instrument, gap), allowOutsideActiveViewport = false) {
    let cursor = gap.through + FIVE_MINUTES, repaired = false, remaining = [gap]
    const initialSlots = rangeSlots(remaining)
    // Visible-window repair drives the chart the user is looking at; warm-up
    // repair serves indicator history. Only the former may cut ahead of
    // queued background reads in the store lane.
    const storePriority = priority === 'repair' ? 'foreground' : 'background'
    for (let pageNumber = 0; cursor > gap.from && pageNumber < MAX_REPAIR_PAGES; pageNumber += 1) {
      if (signal?.aborted || (!allowOutsideActiveViewport && !this.canRepairRange(instrument, gap))) return { repaired, exhausted: false, deferred: true, remaining }
      const page = await this.get('/market/history-candles', { instId: instrument.instId, bar: '5m', limit: 300, after: cursor }, signal, priority)
      if (this.disposed || signal?.aborted) return { repaired, exhausted: false, deferred: true, remaining }
      const older = page.map(value => candle(instrument.instId, value)).filter(value => value?.confirmed)
      if (!older.length) {
        // A successful earlier page may have advanced local coverage during
        // this same repair. Read it again before declaring a listing boundary:
        // the coverage captured by the caller can be hundreds of candles newer
        // and would permanently hide repairable history from both list and
        // chart paths.
        const currentCoverage = await this.store.coverage(instrument.instId, '5m', storePriority)
        const unresolved = remaining.length ? remaining : [gap]
        if (currentCoverage.first !== null && unresolved.every(range => range.through < currentCoverage.first)) {
          gap.emptyResponses = (gap.emptyResponses ?? 0) + 1
          if (gap.emptyResponses >= HISTORY_BOUNDARY_EMPTY_RESPONSES) {
            const previousBoundary = this.historyBoundaries.get(instrument.instId)
            this.historyBoundaries.set(instrument.instId, previousBoundary === undefined ? currentCoverage.first : Math.min(previousBoundary, currentCoverage.first))
            return { repaired, exhausted: true, remaining }
          }
        }
        return { repaired, exhausted: false, remaining }
      }
      gap.emptyResponses = 0
      const oldest = Math.min(...older.map(value => value.timestamp))
      if (oldest >= cursor) throw new Error('OKX history cursor did not advance.')
      await this.persistCandles(instrument.instId, older, { projectList: priority !== 'background', priority: storePriority })
      remaining = await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe: '5m', ...gap, intervalMS: FIVE_MINUTES }, storePriority)
      repaired ||= rangeSlots(remaining) < initialSlots
      if (!remaining.length) return { repaired: true, exhausted: false, remaining }
      cursor = oldest
    }
    return { repaired, exhausted: false, remaining }
  }

  async runCandleRepair(instrument, state) {
    if (this.disposed || !this.canRepairActiveViewport(instrument) || state.running) return
    state.running = true
    const controller = new AbortController()
    state.controller = controller
    try {
      while (true) {
        if (this.disposed || controller.signal.aborted || !this.canRepairActiveViewport(instrument)) break
        const next = this.nextCandleRepair(instrument, state)
        if (!next.range) break
        const gap = next.range
        state.currentRange = gap
        state.currentPriority = null
        const presentMissing = await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe: '5m', ...gap, intervalMS: FIVE_MINUTES }, 'foreground')
        if (!presentMissing.length) {
          this.replaceCandleRepairRange(state, gap, [], false, this.activeVisibleRepairRange(instrument))
          this.updateCandleRepairState(state)
          this.promoteStatistics(instrument.instId)
          continue
        }
        if (rangeSlots(presentMissing) !== rangeSlots([gap]) || presentMissing.length !== 1 || presentMissing[0].from !== gap.from || presentMissing[0].through !== gap.through) {
          this.replaceCandleRepairRange(state, gap, presentMissing, true, this.activeVisibleRepairRange(instrument))
          this.updateCandleRepairState(state)
          continue
        }
        gap.status = 'loading'; gap.retryAt = null; gap.lastError = ''
        state.currentPriority = this.repairPriority(instrument, gap)
        this.updateCandleRepairState(state)
        this.markChartDataChanged(instrument)
        let result
        try {
          result = await this.repairGap(instrument, gap, controller.signal)
        } catch (error) {
          result = controller.signal.aborted ? { repaired: false, exhausted: false, deferred: true, remaining: [gap] } : {
            repaired: false,
            exhausted: false,
            remaining: await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe: '5m', ...gap, intervalMS: FIVE_MINUTES }, 'foreground'),
            error: error instanceof Error ? error.message : 'Cannot repair missing candles.',
            retryAfter: retryAfter(error),
          }
        }
        const remaining = result.remaining ?? await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe: '5m', ...gap, intervalMS: FIVE_MINUTES }, 'foreground')
        if (!remaining.length) this.replaceCandleRepairRange(state, gap, [], false, this.activeVisibleRepairRange(instrument))
        else if (result.deferred) {
          gap.status = 'queued'; gap.retryAt = null; gap.lastError = ''
          this.updateCandleRepairState(state)
          this.markChartDataChanged(instrument)
          break
        }
        else if (result.exhausted) {
          gap.status = 'exhausted'; gap.retryAt = null; gap.lastError = ''
        } else if (result.repaired) this.replaceCandleRepairRange(state, gap, remaining, true, this.activeVisibleRepairRange(instrument))
        else {
          const retrying = this.replaceCandleRepairRange(state, gap, remaining, false, this.activeVisibleRepairRange(instrument))
          retrying.forEach(range => this.retryCandleRepairRange(range, result.error ?? 'OKX did not return the missing candle range.', result.retryAfter))
        }
        this.updateCandleRepairState(state)
        this.markChartDataChanged(instrument)
        this.promoteStatistics(instrument.instId)
      }
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Cannot inspect cached candle gaps.'
        for (const gap of state.ranges.filter(gap => gap.status === 'loading')) this.retryCandleRepairRange(gap, message, retryAfter(error))
        this.updateCandleRepairState(state)
        this.markChartDataChanged(instrument)
      }
    } finally {
      if (state.controller === controller) state.controller = null
      state.currentRange = null
      state.currentPriority = null
      state.running = false
      this.updateCandleRepairState(state)
      this.scheduleCandleRepair(instrument, state)
      this.promoteStatistics(instrument.instId)
    }
  }

  async ensureChartRange(instrument, timeframe, end, focusToken, repairEnd = end, priority = 'foreground') {
    const range = chartRepairRange(timeframe, end, repairEnd)
    const visibleRange = chartVisibleRange(timeframe, end)
    const state = this.candleRepairState(instrument.instId)
    this.repartitionCandleRepairRanges(state, visibleRange)
    const missing = await this.store.missingCandleRanges({ instrument: instrument.instId, timeframe: '5m', ...range, intervalMS: FIVE_MINUTES }, priority)
    if (focusToken !== undefined && !this.ownsForeground(instrument.instId, focusToken)) {
      return { stale: true, visibleCandleReady: false, candleState: 'ready', missingCandleRanges: [], candleRetryAt: null }
    }
    const visibleCandleReady = !missing.some(gap => rangesOverlap(gap, visibleRange))
    // A raw row is appended before its derived 15m/1H rows are rebuilt. Keep
    // the chart in repair state for that short transaction so consumers never
    // treat an incomplete derived window as ready.
    const hasPendingOverlap = state.ranges.some(gap => rangesOverlap(gap, range) && gap.status !== 'exhausted')
    if (!missing.length && hasPendingOverlap && (state.running || state.status === 'loading' || state.status === 'retrying')) {
      return { visibleCandleReady, candleState: state.status === 'retrying' ? 'retrying' : 'loading', missingCandleRanges: state.ranges, candleRetryAt: state.retryAt }
    }
    if (!missing.length) return { visibleCandleReady, candleState: 'ready', missingCandleRanges: [], candleRetryAt: null }
    const boundary = this.historyBoundaries.get(instrument.instId)
    const repairable = boundary === undefined ? missing : missing.filter(gap => gap.through >= boundary)
    if (!repairable.length) return { visibleCandleReady, candleState: 'exhausted', missingCandleRanges: missing, candleRetryAt: null }
    const added = this.enqueueMissingCandleRepairs(state, repairable, visibleRange)
    if (added && state.timer) { clearTimeout(state.timer); state.timer = null }
    this.scheduleCandleRepair(instrument, state)
    const jobs = state.ranges.filter(job => repairable.some(gap => rangesOverlap(job, gap)))
    const active = jobs.filter(job => job.status !== 'exhausted')
    const candleState = active.some(job => job.status === 'queued' || job.status === 'loading') ? 'loading'
      : active.some(job => job.status === 'retrying') ? 'retrying' : active.some(job => job.status === 'unavailable') ? 'unavailable' : 'exhausted'
    const retryAt = active.map(job => job.retryAt).filter(Number.isFinite)
    return { visibleCandleReady, candleState, missingCandleRanges: missing, candleRetryAt: retryAt.length ? Math.min(...retryAt) : null }
  }

  latestCandleRetryState(instrument) {
    let state = this.latestCandleRetries.get(instrument.instId)
    if (!state) {
      state = { status: 'ready', attempt: 0, retryAt: null, timer: null, controller: null, priority: 'foreground', lastError: '' }
      this.latestCandleRetries.set(instrument.instId, state)
    }
    return state
  }

  isActiveLatestCandle(instrument) {
    if (this.activeChartInstrument === null) return true
    const viewport = this.activeChartViewport
    return viewport?.instrument === instrument.instId && viewport.latest
  }

  pauseLatestCandleHydration(instrument) {
    const state = this.latestCandleRetries.get(instrument.instId)
    if (!state) return
    if (this.isRateLimitedRetry(state)) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.retryAt = null
    state.controller?.abort()
    if (!this.hydrating.has(instrument.instId)) this.latestCandleRetries.delete(instrument.instId)
  }

  pauseInactiveLatestCandles(activeInstrument) {
    const now = Date.now()
    for (const [instrument, state] of this.latestCandleRetries) {
      if (instrument === activeInstrument) continue
      if (this.isRateLimitedRetry(state, now)) continue
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      state.retryAt = null
      state.controller?.abort()
      if (!this.hydrating.has(instrument)) this.latestCandleRetries.delete(instrument)
    }
  }

  canContinueLatestCandle(instrument, priority) { return priority === 'background' || this.isActiveLatestCandle(instrument) }

  scheduleLatestCandleRetry(instrument, state, message, serverDelay, priority = state.priority) {
    if (this.disposed || !this.canContinueLatestCandle(instrument, priority)) return
    const plan = retryPlan(state.attempt, serverDelay)
    state.priority = priority; state.attempt = plan.attempt
    state.status = plan.unavailable ? 'unavailable' : 'retrying'
    state.retryAt = Date.now() + plan.delay
    state.lastError = message
    if (state.timer) clearTimeout(state.timer)
    const timer = setTimeout(() => {
      state.timer = null
      if (!this.disposed && this.canContinueLatestCandle(instrument, priority)) {
        state.retryAt = null
        void this.hydrate(instrument, priority)
      }
    }, plan.delay)
    timer.unref?.()
    state.timer = timer
    this.markChartDataChanged(instrument)
  }

  async hydrate(instrument, priority = 'foreground') {
    if (this.disposed || priority !== 'background' && !this.isActiveChartInstrument(instrument)) return false
    const previous = this.hydrating.get(instrument.instId)
    const state = this.latestCandleRetryState(instrument)
    if (previous) {
      if (requestPriority(priority) > requestPriority(state.priority)) {
        const error = new Error(`A ${priority} candle request superseded ${state.priority} work.`)
        error.name = 'RequestPreemptedError'
        state.priority = priority
        state.controller?.abort(error)
        return previous.catch(() => false).then(() => this.hydrate(instrument, priority))
      }
      return previous
    }
    if (requestPriority(priority) > requestPriority(state.priority)) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null; state.retryAt = null; state.status = 'ready'
    }
    if ((this.lastCandleHydration.get(instrument.instId) ?? 0) + LATEST_CANDLE_REFRESH > Date.now() || state.timer || state.retryAt && state.retryAt > Date.now()) return false
    const controller = new AbortController()
    state.controller = controller; state.priority = priority
    let task
    task = (async () => {
      const recovering = state.status !== 'ready'
      state.status = 'loading'; state.retryAt = null; state.lastError = ''
      try {
        const page = await this.get('/market/candles', { instId: instrument.instId, bar: '5m', limit: 300 }, controller.signal, priority)
        if (this.disposed || controller.signal.aborted || !this.canContinueLatestCandle(instrument, priority)) return false
        const fetched = page.map(value => candle(instrument.instId, value)).filter(Boolean)
        const confirmed = fetched.filter(value => value.confirmed)
        const live = fetched.filter(value => !value.confirmed).sort((left, right) => left.timestamp - right.timestamp).at(-1)
        const previousLive = this.liveCandles.get(instrument.instId)
        const liveChanged = live ? !previousLive || !sameCandle(previousLive, live) : previousLive !== undefined
        if (live) this.liveCandles.set(instrument.instId, live)
        else this.liveCandles.delete(instrument.instId)
        if (!confirmed.length) throw new Error('OKX returned no confirmed 5m candles.')
        const persisted = await this.persistCandles(instrument.instId, confirmed, { priority: priority === 'background' ? 'background' : 'foreground' })
        this.lastCandleHydration.set(instrument.instId, Date.now())
        state.status = 'ready'; state.attempt = 0; state.retryAt = null; state.lastError = ''
        if (!persisted && (liveChanged || recovering)) this.markChartDataChanged(instrument)
        return true
      } catch (error) {
        if (!controller.signal.aborted && !requestWasCancelled(error)) this.scheduleLatestCandleRetry(instrument, state, error instanceof Error ? error.message : 'Cannot refresh latest candles.', retryAfter(error), priority)
        else if (state.status === 'loading') { state.status = 'ready'; state.retryAt = null }
        return false
      }
    })().finally(() => {
      if (state.controller === controller) state.controller = null
      if (this.hydrating.get(instrument.instId) === task) this.hydrating.delete(instrument.instId)
      if (priority !== 'background' && !this.isActiveLatestCandle(instrument)) this.latestCandleRetries.delete(instrument.instId)
      else if (controller.signal.aborted && !this.disposed && !requestWasPreempted(controller.signal.reason) && this.canContinueLatestCandle(instrument, priority)) queueMicrotask(() => {
        if (!this.disposed && this.canContinueLatestCandle(instrument, priority)) void this.hydrate(instrument, priority)
      })
    })
    this.hydrating.set(instrument.instId, task)
    return task
  }

  bars(...arguments_) {
    if (this.disposed) return Promise.reject(new Error('Market service is closed.'))
    const task = this.loadBars(...arguments_)
    this.barTasks.add(task)
    return task.finally(() => this.barTasks.delete(task))
  }

  async loadBars(instrument, timeframe, targetEnd, { hydrate = true, repair = true, statistics = true, foreground = false, focusToken } = {}) {
    const staleForeground = () => foreground && focusToken !== undefined && !this.ownsForeground(instrument, focusToken)
    const staleResult = () => ({ stale: true, bars: [], revision: this.dataRevision(instrument), candleState: 'ready', missingCandleRanges: [], candleRetryAt: null, statisticsState: 'ready', statisticsRetryAt: null })
    if (staleForeground()) return staleResult()
    const metadata = this.instruments.get(instrument)
    if (foreground && metadata && targetEnd !== undefined && this.ownsForeground(instrument, focusToken)) this.activateChartViewport(metadata, timeframe, targetEnd, false)
    // A historical window is fully database-backed. Fetching the latest 5m
    // page here only competes with its repair/statistics work.
    if (metadata && hydrate && targetEnd === undefined) {
      // Claim a pending latest viewport before starting its network request.
      // This lets retry/finally distinguish an intentional latest load from
      // the no-viewport interval that follows a history focus transition.
      if (foreground && this.ownsForeground(instrument, focusToken)) this.activateChartViewport(metadata, timeframe, null, true)
      await this.hydrate(metadata)
    }
    if (staleForeground()) return staleResult()
    const intervalMS = timeframeMilliseconds(timeframe)
    // Neighbor previews and history windows read the store in the background
    // lane; only a focused latest viewport may cut ahead of queued work.
    const storePriority = foreground ? 'foreground' : 'background'
    const rawCoverage = targetEnd === undefined ? await this.store.coverage(instrument, '5m', storePriority) : null
    // A rapid wheel stream can leave many messages in flight. Never enqueue a
    // second DuckDB read, a repair, or a chart calculation for a viewport that
    // has already lost foreground ownership.
    if (staleForeground()) return staleResult()
    const latest = targetEnd === undefined ? await this.latestChartEnds(instrument, rawCoverage, timeframe, storePriority) : null
    if (staleForeground()) return staleResult()
    const chartEnd = targetEnd ?? latest?.displayEnd ?? null
    const repairEnd = targetEnd ?? latest?.repairEnd ?? chartEnd
    if (chartEnd === null) {
      const latestCandleState = metadata ? this.latestCandleRetryState(metadata) : null
      return { bars: [], candleState: latestCandleState?.status === 'ready' ? 'loading' : latestCandleState?.status ?? 'ready', missingCandleRanges: [], candleRetryAt: latestCandleState?.retryAt ?? null, statisticsState: 'ready', statisticsRetryAt: null }
    }
    let currentForeground = !foreground || this.ownsForeground(instrument, focusToken)
    if (foreground && metadata && currentForeground) {
      if (targetEnd === undefined) this.activateChartViewport(metadata, timeframe, chartEnd, true, repairEnd)
      else currentForeground = this.isActiveChartViewport(instrument, timeframe, chartEnd)
    }
    const availability = metadata && repair && currentForeground ? await this.ensureChartRange(metadata, timeframe, chartEnd, focusToken, repairEnd, storePriority) : { visibleCandleReady: true, candleState: 'ready', missingCandleRanges: [], candleRetryAt: null }
    if (staleForeground() || availability.stale) return staleResult()
    const ownsForeground = currentForeground && this.ownsForeground(instrument, focusToken)
    // OI/Taker hydration starts with the viewport, not after candle repair.
    // Its rows attach to whatever raw periods already exist, so statistics
    // fill in progressively while repair continues instead of waiting for the
    // whole visible window to finish.
    const statisticsState = metadata && statistics && ownsForeground ? this.requestStatistics(metadata, timeframe, chartEnd) : null
    const live = timeframe === '5m' ? this.liveCandles.get(instrument) : undefined
    const through = targetEnd === undefined ? Math.max(chartEnd, live?.timestamp ?? chartEnd) : chartEnd + CHART_FUTURE_CANDLES * intervalMS
    // To aggregate a derived bar at `through`, read the complete 5m bucket
    // that ends at `through + interval - 5m`. Using the display end as the
    // source end silently drops the rightmost 15m/1H bar, while OI/Taker was
    // fetched for that dropped bar.
    const sourceThrough = timeframe === '5m' ? through : through + intervalMS - FIVE_MINUTES
    const outputFrom = chartEnd - CHART_HISTORY_CANDLES * intervalMS
    const calculationFrom = outputFrom - EMA_WARMUP_CANDLES * intervalMS
    const key = `${instrument}:${timeframe}:${chartEnd}:${through}`
    let bars, revision
    while (true) {
      if (staleForeground()) return staleResult()
      revision = this.dataRevision(instrument)
      bars = this.chartResults.get(key)
      if (!bars) {
        let candles
        if (timeframe === '5m') {
          candles = await this.store.candles({ instrument, timeframe, from: calculationFrom, through }, storePriority)
        } else {
          const [source, direct] = await Promise.all([
            this.store.candles({ instrument, timeframe: '5m', from: calculationFrom, through: sourceThrough }, storePriority),
            this.store.candles({ instrument, timeframe, from: calculationFrom, through }, storePriority),
          ])
          const directStatistics = new Map(direct.map(value => [value.timestamp, value]))
          candles = aggregate(source, timeframe === '15m' ? 900_000 : 3_600_000).map(value => {
            const statistics = directStatistics.get(value.timestamp)
            // Never render the legacy 5m/USDT cache as if it were direct
            // timeframe contract data. It is rehydrated in the foreground.
            const current = this.hasCurrentStatistics(statistics)
            return {
              ...value,
              oi: current ? number(statistics.oi) : null,
              buy: current ? number(statistics.buy) : null,
              sell: current ? number(statistics.sell) : null,
            }
          })
        }
        if (staleForeground()) return staleResult()
        bars = barsWithIndicators(live ? [...candles, live] : candles, intervalMS).filter(value => value.hour >= outputFrom && value.hour <= through)
        // Never reinsert a chart that was read before a repair/statistics write.
        if (revision !== this.dataRevision(instrument)) continue
        if (staleForeground()) return staleResult()
        this.chartResults.set(key, bars)
        if (this.chartResults.size > 24) this.chartResults.delete(this.chartResults.keys().next().value)
      }
      break
    }
    return { bars, revision, ...availability, statisticsState: statisticsState?.status ?? 'ready', statisticsRetryAt: statisticsState?.retryAt ?? null }
  }

  isHistoryExhausted(instrument) { return this.historyBoundaries.has(instrument) || !this.instruments.has(instrument) }

  focusChart(instrument, token) {
    if (!Number.isSafeInteger(token) || token < this.activeChartFocus || token === this.activeChartFocus && this.activeChartInstrument !== instrument) return false
    const changed = token !== this.activeChartFocus || instrument !== this.activeChartInstrument
    this.activeChartFocus = token
    this.activeChartInstrument = instrument
    if (changed) {
      this.activeChartViewport = null
      this.pauseInactiveStatistics()
      this.pauseInactiveLatestCandles(instrument)
      this.pauseInactiveCandleRepairs(instrument)
      this.cancelBackgroundRequests()
      const currentRepairs = this.candleRepairs.get(instrument)
      if (currentRepairs) {
        if (currentRepairs.timer && !this.isRateLimitedRetry(currentRepairs)) {
          clearTimeout(currentRepairs.timer)
          currentRepairs.timer = null
        }
        currentRepairs.controller?.abort()
        for (const range of currentRepairs.ranges) {
          if (range.status === 'loading') {
            range.status = 'queued'
            range.retryAt = null
            range.lastError = ''
          }
        }
        this.updateCandleRepairState(currentRepairs)
      }
    }
    return true
  }

  async dispose() {
    if (this.disposeTask) return this.disposeTask
    this.disposed = true
    for (const state of this.candleRepairs.values()) if (state.timer) clearTimeout(state.timer)
    for (const state of this.latestCandleRetries.values()) if (state.timer) clearTimeout(state.timer)
    for (const state of this.statistics.values()) if (state.timer) clearTimeout(state.timer)
    for (const state of this.listWarmups.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.controller?.abort()
    }
    this.cancelBackgroundRequests()
    this.shutdownController.abort()
    for (const controller of this.abortControllers) controller.abort()
    const queued = this.drainRequestQueue()
    const work = [
      this.refreshing,
      queued,
      ...this.barTasks,
      ...this.hydrating.values(),
      ...this.candleMutations.values(),
      ...[...this.candleRepairs.values()].map(state => state.task),
      ...[...this.statistics.values()].map(state => state.task),
      ...[...this.listWarmups.values()].map(state => state.task),
      ...[...this.listProjectionTasks.values()].map(state => state.task),
      ...[...this.listCatalogProjectionTasks.values()].map(state => state.task),
    ].filter(Boolean)
    this.disposeTask = Promise.allSettled(work).then(() => {
      this.candleRepairs.clear()
      this.latestCandleRetries.clear()
      this.statistics.clear()
      this.listWarmups.clear()
      this.listWarmupQueue = []
      this.listGapStates.clear()
      this.listProjectionTasks.clear()
      this.listProjectionResults.clear()
      this.listProjectionDataVersions.clear()
      this.listCatalogProjectionTasks.clear()
      this.chartEnds.clear()
      this.dataRevisions.clear()
      this.activeChartInstrument = null
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
