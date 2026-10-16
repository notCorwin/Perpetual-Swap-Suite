const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const USDT_TURNOVER_MINIMUM = 30_000_000
const OI_USD_MINIMUM = 5_000_000
const DEPTH_USD_MINIMUM = 100_000
const MAX_SPREAD_PERCENT = 0.05
const MAX_SLIPPAGE_PERCENT = 0.1
const MAX_HOURLY_VOLUME_RATIO = 2

const emptyBreak = { status: 'insufficient-history' }
const incompleteOpportunity = reasons => ({ direction: null, setup: null, status: 'Incomplete', score: null, components: null, reasons })
const number = value => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
const percent = (current, previous) => current === null || previous === null || previous === 0 ? null : (current - previous) / Math.abs(previous) * 100

function requestURL(path, parameters = {}) {
  const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]))
  return `${OKX_ORIGIN}${path}?${query}`
}

async function mapConcurrent(values, limit, operation) {
  const output = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
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
    const price = number(level[0]), size = number(level[1])
    const levelNotional = linearNotional(price, size, instrument)
    if (price === null || levelNotional <= 0) continue
    const take = Math.min(levelNotional, remaining)
    const units = instrument.ctValCcy === 'USDT' ? take / number(instrument.ctVal) : take / price
    quantity += units
    notional += take
    remaining -= take
    if (remaining <= 0) break
  }
  return { complete: remaining <= 0, average: quantity > 0 ? notional / quantity : null, depth: amount - remaining }
}

function liquidity(instrument, ticker, book, openInterest, hourly, criteria) {
  const confirmedHourly = hourly.filter(candle => candle[8] === '1').slice(0, 24)
  const bid = number(ticker.bidPx), ask = number(ticker.askPx), last = number(ticker.last)
  const spread = bid === null || ask === null || bid <= 0 ? null : (ask - bid) / bid * 100
  const asks = Array.isArray(book.asks) ? book.asks : [], bids = Array.isArray(book.bids) ? book.bids : []
  const askFill = sideFill(asks, DEPTH_USD_MINIMUM, instrument), bidFill = sideFill(bids, DEPTH_USD_MINIMUM, instrument)
  const askSlippage = ask === null || askFill.average === null ? null : (askFill.average - ask) / ask * 100
  const bidSlippage = bid === null || bidFill.average === null ? null : (bid - bidFill.average) / bid * 100
  const hourlyQuoteVolumes = confirmedHourly.map(candle => number(candle[7]) ?? (number(candle[5]) ?? 0) * (number(candle[4]) ?? 0)).filter(value => value > 0)
  const volumeRatio = hourlyQuoteVolumes.length < 24 ? null : Math.max(...hourlyQuoteVolumes) / Math.min(...hourlyQuoteVolumes)
  const turnover = last === null ? null : (number(ticker.volCcy24h) ?? 0) * last
  const oiUSD = number(openInterest?.oiUsd)
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

function marketRow(instrument, ticker, result) {
  const last = number(ticker.last), open24h = number(ticker.open24h)
  return {
    instId: instrument.instId, turnover24hUSDT: result.turnover, price: last, lastPrice: last, priceChange: percent(last, open24h),
    currentLow: number(ticker.low24h), currentHigh: number(ticker.high24h), ema200Signal: null,
    buy: null, sell: null, takerRatio: null, oiChange: null, highBreakout: emptyBreak, lowBreakdown: emptyBreak,
    highBreakout96: emptyBreak, lowBreakdown96: emptyBreak, roc: null, maroc: null, rocChange: null, marocChange: null,
    rsi6: null, rsi12: null, rsi24: null, logBBAboveBand: null, logBBExpansion: null,
    filterMetrics: { liveOpen: null, liveClose: null, ema200: null, previousEMA200: null, vwap14: null, bbUpper: null, bbMiddle: null, bbLower: null, priorHigh48: null, priorLow48: null, priorHigh96: null, priorLow96: null, oiUSD: result.oiUSD, spreadPercent: result.spread, liveVolumeUSDT: null },
    opportunity: incompleteOpportunity(['Indicator history is loading from OKX.']),
  }
}

export class MarketService {
  constructor(store, criteria = () => ({ hourlyVolumeStabilityEnabled: true }), fetcher = fetch) {
    this.store = store
    this.criteria = criteria
    this.fetcher = fetcher
    this.rows = []
    this.revision = 0
    this.refreshing = null
    this.error = ''
    this.lastRefreshAt = 0
  }

  async get(path, parameters) {
    const response = await this.fetcher(requestURL(path, parameters), { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`OKX ${path} failed (${response.status}).`)
    const payload = await response.json()
    if (payload.code && payload.code !== '0') throw new Error(`OKX ${path}: ${payload.msg || payload.code}`)
    return payload.data ?? []
  }

  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const [instruments, tickers] = await Promise.all([this.get('/public/instruments', { instType: 'SWAP' }), this.get('/market/tickers', { instType: 'SWAP' })])
        const tickerByID = new Map(tickers.map(ticker => [ticker.instId, ticker]))
        const candidates = instruments.filter(instrument => instrument.state === 'live' && instrument.instCategory === '1' && instrument.settleCcy === 'USDT' && instrument.instId?.endsWith('-USDT-SWAP')).filter(instrument => {
          const ticker = tickerByID.get(instrument.instId), last = number(ticker?.last), turnover = last === null ? null : (number(ticker?.volCcy24h) ?? 0) * last
          const bid = number(ticker?.bidPx), ask = number(ticker?.askPx)
          return turnover !== null && turnover > USDT_TURNOVER_MINIMUM && bid !== null && ask !== null && (ask - bid) / bid * 100 < MAX_SPREAD_PERCENT
        })
        const approved = await mapConcurrent(candidates, 8, async instrument => {
          try {
            const [books, openInterest, hourly] = await Promise.all([this.get('/market/books', { instId: instrument.instId, sz: 400 }), this.get('/public/open-interest', { instType: 'SWAP', instId: instrument.instId }), this.get('/market/candles', { instId: instrument.instId, bar: '1H', limit: 25 })])
            const result = liquidity(instrument, tickerByID.get(instrument.instId), books[0] ?? {}, openInterest[0], hourly, this.criteria())
            return result.eligible ? marketRow(instrument, tickerByID.get(instrument.instId), result) : undefined
          } catch { return undefined }
        })
        this.rows = approved.sort((left, right) => Math.abs(Number(right.priceChange) || 0) - Math.abs(Number(left.priceChange) || 0) || left.instId.localeCompare(right.instId))
        this.revision += 1
        this.error = this.rows.length ? '' : 'No contracts currently meet all enabled liquidity requirements.'
        this.lastRefreshAt = Date.now()
      } catch (error) { this.error = error instanceof Error ? error.message : 'Cannot load OKX markets.'; this.lastRefreshAt = Date.now() }
      finally { this.refreshing = null }
    })()
    return this.refreshing
  }

  invalidate() { this.rows = []; this.lastRefreshAt = 0; void this.refresh() }

  snapshot() {
    if (!this.refreshing && Date.now() - this.lastRefreshAt >= 60_000) void this.refresh()
    return { rows: this.rows, revision: this.revision, error: this.error, loading: this.refreshing !== null }
  }
}
