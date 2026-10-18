import { barsWithIndicators } from './services/indicators.js'
import { quoteTurnover24h } from './services/liquidity.js'

const FIVE_MINUTES = 300_000
const HOUR = 3_600_000

// Keep this fixture at the data boundary.  It intentionally registers only a
// market catalog entry plus durable source/statistics observations: the
// production list projection is responsible for building the visible row.
export async function seedCachedListProjection(store, marketService) {
  const instId = 'ETH-USDT-SWAP'
  const timeframe = '1H'
  const savedAt = Date.now()
  const asOf = Math.floor(savedAt / FIVE_MINUTES) * FIVE_MINUTES
  const latestRaw = asOf - FIVE_MINUTES
  const currentBucket = Math.floor(latestRaw / HOUR) * HOUR
  const end = latestRaw >= currentBucket + HOUR - FIVE_MINUTES ? currentBucket : currentBucket - HOUR
  const periods = 201
  const start = end - (periods - 1) * HOUR
  const source = []

  for (let timestamp = start; timestamp <= latestRaw; timestamp += FIVE_MINUTES) {
    const index = (timestamp - start) / FIVE_MINUTES
    const center = 200 + index * 0.007 + Math.sin(index / 13) * 0.45
    const close = center + Math.sin(index / 5) * 0.08
    const volume = (120 + index % 11) * 10
    source.push({
      instrument: instId, timeframe: '5m', timestamp,
      open: center - 0.06, high: center + 0.42, low: center - 0.48, close,
      volume, baseVolume: volume, quoteVolume: volume * close,
      confirmed: true,
    })
  }

  const statistics = Array.from({ length: periods }, (_, index) => {
    const timestamp = start + index * HOUR
    const close = 200 + index * 0.084
    return {
      instrument: instId, timeframe, timestamp,
      open: close - 0.18, high: close + 0.51, low: close - 0.56, close,
      volume: 16_000, baseVolume: 16_000, quoteVolume: close * 16_000,
      oi: 2_000_000 + index * 4_000,
      buy: 12_000 + index * 17,
      sell: 8_000 + index * 11,
      statisticsVersion: 1,
      confirmed: true,
    }
  })

  await store.appendCandles([...source, ...statistics])
  const instrument = { instId, instType: 'SWAP', ctType: 'linear', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'ETH', ruleType: 'normal' }
  const ticker = { instId, last: String(statistics.at(-1).close), open24h: '198', low24h: '196', high24h: '220', bidPx: '216.79', askPx: '216.80', volCcy24h: '300000' }
  const lease = { observedAt: savedAt, expiresAt: savedAt + 90_000 }
  const hourlyAsOf = Math.floor(savedAt / HOUR) * HOUR
  const nativeCandles = await store.candles({ instrument: instId, timeframe: '5m', from: asOf - 288 * FIVE_MINUTES, through: latestRaw })
  const hourlyCandles = await store.candles({ instrument: instId, timeframe: '1H', from: hourlyAsOf - 24 * HOUR, through: hourlyAsOf - HOUR })
  const turnover = quoteTurnover24h(nativeCandles, asOf)
  const observations = {
    ticker: { value: ticker, ...lease },
    book: { value: { bids: [['216.79', '200000']], asks: [['216.80', '200000']] }, ...lease },
    openInterest: { value: { oiUsd: '6500000' }, ...lease },
    turnover: { value: { asOf, turnover }, observedAt: savedAt, expiresAt: asOf + FIVE_MINUTES },
    hourly: { value: { asOf: hourlyAsOf, rows: hourlyCandles }, observedAt: savedAt, expiresAt: hourlyAsOf + HOUR },
  }

  marketService.instrumentObservations.set(instId, lease)
  marketService.observations.set(instId, observations)
  const config = marketService.prefs().liquidity
  const entry = marketService.observedCandidate(instrument, config, JSON.stringify(config), observations, {}, savedAt)
  if (entry.status !== 'verified') throw new Error(`Cached projection fixture does not satisfy the enabled conditions: ${entry.result.reasons.join(' ')}`)
  entry.preferencesRevision = marketService.metadata.getSettings().revision
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.instruments.set(instId, instrument)
  marketService.catalogChecks.set(instId, entry)
  marketService.renewalTargets.set(instId, instrument)
  marketService.replaceCatalog([entry])
  await marketService.persistCatalog([entry], savedAt)
  await marketService.ensureListTimeframe(timeframe)
  await marketService.projectListEntry(instId, timeframe)

  return { instId, timeframe, end, periods, savedAt }
}

// A dense, fully local chart fixture for renderer benchmarks. It writes the
// same durable rows that the production chart uses; no synthetic IPC response
// or network timing is involved.
export async function seedChartScrollBenchmark(store, marketService) {
  const instId = 'SOL-USDT-SWAP'
  const timeframe = '1H'
  const alternateTimeframe = '15m'
  const timeframes = ['5m', '15m', '1H']
  // Leave durable history beyond the largest jump and the 600-candle
  // prefetch horizon, so network assertions measure redundant downloads.
  const periods = 3_072
  const end = Date.UTC(2025, 9, 17, 12, 0)
  const buildCandles = (frame, intervalMS) => {
    const start = end - (periods - 1) * intervalMS
    return Array.from({ length: periods }, (_, index) => {
      const timestamp = start + index * intervalMS
      const trend = 135 + index * .018
      const wave = Math.sin(index / 9) * 1.6 + Math.cos(index / 23) * .7
      const open = trend + wave
      const close = open + Math.sin(index / 4) * .42
      const volume = 4_000 + index % 600
      return {
        instrument: instId, timeframe: frame, timestamp,
        open, high: Math.max(open, close) + .7, low: Math.min(open, close) - .7, close,
        volume, baseVolume: volume, quoteVolume: volume * close,
        oi: 2_100_000 + index * 230,
        buy: 92_000 + index % 800,
        sell: 76_000 + (index * 3) % 900,
        statisticsVersion: 1, statisticsSources: 3, statisticsObserved: true, confirmed: true,
      }
    })
  }
  // Persist each native period independently. The oracle is calculated once
  // from the complete durable sequence, including the canonical EMA/RSI seed,
  // so a later page cannot silently change the value at an existing timestamp.
  const intervals = { '5m': FIVE_MINUTES, '15m': 3 * FIVE_MINUTES, '1H': HOUR }
  const candlesByFrame = Object.fromEntries(timeframes.map(frame => [frame, buildCandles(frame, intervals[frame])]))
  const hourly = candlesByFrame[timeframe]
  for (const frame of timeframes) await marketService.persistCandles(instId, candlesByFrame[frame].map(row => ({ ...row, replaceStatistics: true })), { projectList: false })
  const series = Object.fromEntries(timeframes.map(frame => [frame, {
    intervalMS: intervals[frame], start: candlesByFrame[frame][0].timestamp, end,
    bars: barsWithIndicators(candlesByFrame[frame], intervals[frame]),
  }]))

  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.1', ctValCcy: 'SOL' }
  const ticker = { instId, last: String(hourly.at(-1).close), open24h: String(hourly.at(-25).open), low24h: '130', high24h: '180', bidPx: String(hourly.at(-1).close - .01), askPx: String(hourly.at(-1).close + .01), volCcy24h: '500000' }
  const result = { eligible: true, turnover: 90_000_000, oiUSD: 8_000_000, spread: 0.01, depth: 300_000, slippage: 0.02 }
  const entry = { instrument, ticker, result, change24h: 5.2 }
  const savedAt = Date.now()
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.instruments.set(instId, instrument)
  marketService.replaceCatalog([entry])
  await marketService.ensureListTimeframe(timeframe)
  await marketService.projectListEntry(instId, timeframe)
  marketService.error = ''
  marketService.lastRefreshAt = savedAt
  marketService.markChartDataChanged(instId)
  return { instId, timeframe, alternateTimeframe, timeframes, intervalMS: HOUR, end, start: hourly[0].timestamp, periods, series }
}

// Model successful empty source observations: prices exist,
// but OI is empty and Taker returned zero placeholders despite real trades.
export async function seedHistoricalStatisticsBoundary(store, marketService) {
  const fixture = await seedChartScrollBenchmark(store, marketService)
  const rows = await store.candles({ instrument: fixture.instId, timeframe: fixture.timeframe, from: fixture.end - 95 * HOUR, through: fixture.end })
  await marketService.persistCandles(fixture.instId, rows.map(row => ({ ...row, oi: null, buy: 0, sell: 0, statisticsVersion: 11, statisticsOIExpiresAt: Date.now() + 60_000, statisticsTakerExpiresAt: Date.now() + 60_000, replaceStatistics: true })), { projectList: false })
  marketService.markChartDataChanged(fixture.instId)
  fixture.series[fixture.timeframe].bars = fixture.series[fixture.timeframe].bars.map(bar => bar.hour >= fixture.end - 95 * HOUR
    ? { ...bar, oi: null, buy: null, sell: null } : bar)
  return fixture
}

// Distinct native sequences make changing a label without changing the chart
// fail numerical validation. Sixteen contracts also exceed the historical
// renderer cache's twelve-series budget, without requiring network data.
export async function seedInstrumentNavigationBenchmark(store, marketService) {
  const instIds = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'SUI', 'APT', 'NEAR', 'TRX', 'TON'].map(symbol => `${symbol}-USDT-SWAP`)
  const timeframes = ['5m', '15m', '1H']
  const intervals = { '5m': FIVE_MINUTES, '15m': 3 * FIVE_MINUTES, '1H': HOUR }
  // Cover the initial bulk prefetch and its canonical indicator warmup so
  // the held-navigation test measures IPC latency with fully durable sources.
  const periods = 1_280
  const end = Date.UTC(2025, 9, 17, 12, 0)
  const instruments = []
  const catalog = []
  const savedAt = Date.now()
  for (const [instrumentIndex, instId] of instIds.entries()) {
    const series = {}
    for (const timeframe of timeframes) {
      const intervalMS = intervals[timeframe]
      const start = end - (periods - 1) * intervalMS
      const candles = Array.from({ length: periods }, (_, index) => {
        const open = 75 * (instrumentIndex + 1) + index * .017 + Math.sin(index / 9 + instrumentIndex) * 1.7
        const close = open + Math.cos(index / 5 + instrumentIndex) * .4
        const volume = 3_000 + instrumentIndex * 100 + index % 400
        return {
          instrument: instId, timeframe, timestamp: start + index * intervalMS,
          open, high: Math.max(open, close) + .6, low: Math.min(open, close) - .6, close,
          volume, baseVolume: volume, quoteVolume: volume * close,
          oi: 2_000_000 + instrumentIndex * 150_000 + index * 219,
          buy: 60_000 + instrumentIndex * 1_300 + index % 700,
          sell: 48_000 + instrumentIndex * 1_100 + index % 900,
          statisticsVersion: 1, statisticsSources: 3, statisticsObserved: true, confirmed: true,
        }
      })
      await marketService.persistCandles(instId, candles.map(row => ({ ...row, replaceStatistics: true })), { projectList: false })
      series[timeframe] = { intervalMS, start, end, bars: barsWithIndicators(candles, intervalMS) }
    }
    const latest = series['1H'].bars.at(-1)
    const symbol = instId.split('-')[0]
    const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: symbol }
    const ticker = { instId, last: String(latest.close), open24h: String(series['1H'].bars.at(-25).open), low24h: String(latest.low - 2), high24h: String(latest.high + 2), bidPx: String(latest.close - .01), askPx: String(latest.close + .01), volCcy24h: '500000' }
    const result = { eligible: true, turnover: 90_000_000 + instrumentIndex * 1_000_000, oiUSD: 8_000_000, spread: .005, depth: 300_000, slippage: .02 }
    marketService.instruments.set(instId, instrument)
    catalog.push({ instrument, ticker, result, change24h: instrumentIndex + .1 })
    instruments.push({ instId, series })
    marketService.markChartDataChanged(instId)
  }
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.replaceCatalog(catalog)
  await marketService.ensureListTimeframe('1H')
  for (const instId of instIds) await marketService.projectListEntry(instId, '1H')
  marketService.error = ''
  marketService.lastRefreshAt = savedAt
  return { instIds, timeframes, timeframe: '1H', intervalMS: HOUR, end, periods, instruments }
}
