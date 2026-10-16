import { barsWithIndicators } from './indicators.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const USDT_TURNOVER_MINIMUM = 30_000_000
const OI_USD_MINIMUM = 5_000_000
const DEPTH_USD_MINIMUM = 100_000
const MAX_SPREAD_PERCENT = 0.05
const MAX_SLIPPAGE_PERCENT = 0.1
const MAX_HOURLY_VOLUME_RATIO = 2
const HISTORY_CANDLES = 2_520
const emptyBreak = { status: 'insufficient-history' }
const incompleteOpportunity = reasons => ({ direction: null, setup: null, status: 'Incomplete', score: null, components: null, reasons })
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const number = value => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
const percent = (current, previous) => current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100

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
    return [{ instrument: ordered[0].instrument, timeframe: period === 900_000 ? '15m' : '1H', timestamp, open: ordered[0].open, high: Math.max(...ordered.map(candle => candle.high)), low: Math.min(...ordered.map(candle => candle.low)), close: ordered.at(-1).close, volume: ordered.reduce((sum, candle) => sum + (candle.volume ?? 0), 0), quoteVolume: ordered.reduce((sum, candle) => sum + (candle.quoteVolume ?? 0), 0), confirmed: true }]
  })
}

function candle(instrument, value) {
  const timestamp = number(value[0]), open = number(value[1]), high = number(value[2]), low = number(value[3]), close = number(value[4])
  if ([timestamp, open, high, low, close].some(item => item === null)) return null
  return { instrument, timeframe: '5m', timestamp, open, high, low, close, volume: number(value[5]) ?? 0, quoteVolume: number(value[7]) ?? 0, confirmed: value[8] === '1' }
}

function marketRow(instrument, ticker, result, bars = []) {
  const last = number(ticker.last), open24h = number(ticker.open24h), latest = bars.at(-1), ema = latest?.ema ?? null
  const ema200Signal = ema === null || latest === undefined ? null : latest.open > ema && latest.close > ema ? 'Long' : latest.open < ema && latest.close < ema ? 'Short' : 'Unsure'
  return {
    instId: instrument.instId, turnover24hUSDT: result.turnover, price: last, lastPrice: last, priceChange: percent(last, open24h), currentLow: latest?.low ?? number(ticker.low24h), currentHigh: latest?.high ?? number(ticker.high24h), ema200Signal,
    buy: null, sell: null, takerRatio: null, oiChange: null, highBreakout: emptyBreak, lowBreakdown: emptyBreak, highBreakout96: emptyBreak, lowBreakdown96: emptyBreak,
    roc: latest?.roc ?? null, maroc: latest?.maroc ?? null, rocChange: latest?.rocChange ?? null, marocChange: latest?.marocChange ?? null, rsi6: latest?.rsi6 ?? null, rsi12: latest?.rsi12 ?? null, rsi24: latest?.rsi24 ?? null,
    logBBAboveBand: latest?.bandPosition ?? null, logBBExpansion: null,
    filterMetrics: { liveOpen: latest?.open ?? null, liveClose: latest?.close ?? null, ema200: ema, previousEMA200: bars.at(-2)?.ema ?? null, vwap14: latest?.vwap ?? null, bbUpper: latest?.logBBUpper ?? null, bbMiddle: latest?.logBBMiddle ?? null, bbLower: latest?.logBBLower ?? null, priorHigh48: null, priorLow48: null, priorHigh96: null, priorLow96: null, oiUSD: result.oiUSD, spreadPercent: result.spread, liveVolumeUSDT: latest?.quoteVolume ?? null },
    opportunity: incompleteOpportunity(['Open interest, taker volume, and breakout history are still loading.']),
  }
}

export class MarketService {
  constructor(store, criteria = () => ({ hourlyVolumeStabilityEnabled: true }), fetcher = fetch, autoRefresh = true) {
    this.store = store; this.criteria = criteria; this.fetcher = fetcher; this.autoRefresh = autoRefresh
    this.rows = []; this.revision = 0; this.refreshing = null; this.error = ''; this.lastRefreshAt = 0; this.hydrating = new Map(); this.instruments = new Map(); this.liveCandles = new Map(); this.nextRequestAt = 0
  }

  async get(path, parameters) {
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const now = Date.now(), scheduled = Math.max(now, this.nextRequestAt)
      this.nextRequestAt = scheduled + 80
      if (scheduled > now) await sleep(scheduled - now)
      try {
        const response = await this.fetcher(requestURL(path, parameters), { headers: { Accept: 'application/json' } })
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'))
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : Math.min(8_000, 500 * 2 ** attempt))
          continue
        }
        if (!response.ok) throw new Error(`OKX ${path} failed (${response.status}).`)
        const payload = await response.json()
        if (payload.code && payload.code !== '0') throw new Error(`OKX ${path}: ${payload.msg || payload.code}`)
        return payload.data ?? []
      } catch (error) { lastError = error; if (attempt < 3) await sleep(250 * 2 ** attempt) }
    }
    throw lastError instanceof Error ? lastError : new Error(`OKX ${path} failed after retries.`)
  }

  async hydrate(instrument) {
    if (this.hydrating.has(instrument.instId)) return this.hydrating.get(instrument.instId)
    const task = (async () => {
      const coverage = await this.store.coverage(instrument.instId, '5m')
      if (coverage.count < HISTORY_CANDLES) {
        const fetched = [], seen = new Set(); let after, path = '/market/candles', usingArchive = false
        while (fetched.length < HISTORY_CANDLES) {
          const page = await this.get(path, { instId: instrument.instId, bar: '5m', limit: 300, after })
          const values = page.map(value => candle(instrument.instId, value)).filter(Boolean).filter(value => !seen.has(value.timestamp) && seen.add(value.timestamp))
          if (!values.length) {
            if (!usingArchive) { path = '/market/history-candles'; usingArchive = true; continue }
            break
          }
          fetched.push(...values)
          const oldest = Math.min(...values.map(value => value.timestamp))
          if (after === oldest) break
          after = oldest
          if (page.length < 300 && !usingArchive) { path = '/market/history-candles'; usingArchive = true }
        }
        const confirmed = fetched.filter(value => value.confirmed)
        const live = fetched.filter(value => !value.confirmed).sort((left, right) => left.timestamp - right.timestamp).at(-1)
        if (live) this.liveCandles.set(instrument.instId, live)
        await this.store.appendCandles(confirmed)
        await this.store.appendCandles(aggregate(confirmed, 900_000))
        await this.store.appendCandles(aggregate(confirmed, 3_600_000))
      }
      this.revision += 1
    })().finally(() => this.hydrating.delete(instrument.instId))
    this.hydrating.set(instrument.instId, task)
    return task
  }

  async bars(instrument, timeframe) {
    const metadata = this.instruments.get(instrument)
    if (metadata) await this.hydrate(metadata)
    let candles = await this.store.candles({ instrument, timeframe })
    if (!candles.length && timeframe !== '5m') {
      const source = await this.store.candles({ instrument, timeframe: '5m' })
      candles = aggregate(source, timeframe === '15m' ? 900_000 : 3_600_000)
    }
    const live = timeframe === '5m' ? this.liveCandles.get(instrument) : undefined
    return barsWithIndicators(live ? [...candles, live] : candles)
  }

  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const [instruments, tickers] = await Promise.all([this.get('/public/instruments', { instType: 'SWAP' }), this.get('/market/tickers', { instType: 'SWAP' })])
        const tickerByID = new Map(tickers.map(ticker => [ticker.instId, ticker]))
        const candidates = instruments.filter(instrument => instrument.state === 'live' && instrument.instCategory === '1' && instrument.settleCcy === 'USDT' && instrument.instId?.endsWith('-USDT-SWAP')).filter(instrument => {
          const ticker = tickerByID.get(instrument.instId), last = number(ticker?.last), turnover = last === null ? null : (number(ticker?.volCcy24h) ?? 0) * last, bid = number(ticker?.bidPx), ask = number(ticker?.askPx)
          return turnover !== null && turnover > USDT_TURNOVER_MINIMUM && bid !== null && ask !== null && (ask - bid) / bid * 100 < MAX_SPREAD_PERCENT
        })
        candidates.forEach(instrument => this.instruments.set(instrument.instId, instrument))
        const approved = await mapConcurrent(candidates, 4, async instrument => {
          try {
            const [books, openInterest, hourly] = await Promise.all([this.get('/market/books', { instId: instrument.instId, sz: 400 }), this.get('/public/open-interest', { instType: 'SWAP', instId: instrument.instId }), this.get('/market/candles', { instId: instrument.instId, bar: '1H', limit: 25 })])
            const result = liquidity(instrument, tickerByID.get(instrument.instId), books[0] ?? {}, openInterest[0], hourly, this.criteria())
            return result.eligible ? marketRow(instrument, tickerByID.get(instrument.instId), result) : undefined
          } catch { return undefined }
        })
        this.rows = approved.sort((left, right) => Math.abs(Number(right.priceChange) || 0) - Math.abs(Number(left.priceChange) || 0) || left.instId.localeCompare(right.instId))
        this.revision += 1; this.error = this.rows.length ? '' : 'No contracts currently meet all enabled liquidity requirements.'; this.lastRefreshAt = Date.now()
      } catch (error) { this.error = error instanceof Error ? error.message : 'Cannot load OKX markets.'; this.lastRefreshAt = Date.now() }
      finally { this.refreshing = null }
    })()
    return this.refreshing
  }

  invalidate() { this.rows = []; this.lastRefreshAt = 0; if (this.autoRefresh) void this.refresh() }
  snapshot() { if (this.autoRefresh && !this.refreshing && Date.now() - this.lastRefreshAt >= 60_000) void this.refresh(); return { rows: this.rows, revision: this.revision, error: this.error, loading: this.refreshing !== null } }
}
