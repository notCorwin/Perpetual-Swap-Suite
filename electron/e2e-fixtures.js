const FIVE_MINUTES = 300_000
const HOUR = 3_600_000

// Keep this fixture at the data boundary.  It intentionally registers only a
// market catalog entry plus durable source/statistics observations: the
// production list projection is responsible for building the visible row.
export async function seedCachedListProjection(store, marketService) {
  const instId = 'ETH-USDT-SWAP'
  const timeframe = '1H'
  const latestRaw = Math.floor((Date.now() - FIVE_MINUTES) / FIVE_MINUTES) * FIVE_MINUTES
  const currentBucket = Math.floor(latestRaw / HOUR) * HOUR
  const end = latestRaw >= currentBucket + HOUR - FIVE_MINUTES ? currentBucket : currentBucket - HOUR
  const periods = 201
  const start = end - (periods - 1) * HOUR
  const source = []

  for (let timestamp = start; timestamp <= latestRaw; timestamp += FIVE_MINUTES) {
    const index = (timestamp - start) / FIVE_MINUTES
    const center = 200 + index * 0.007 + Math.sin(index / 13) * 0.45
    const close = center + Math.sin(index / 5) * 0.08
    source.push({
      instrument: instId, timeframe: '5m', timestamp,
      open: center - 0.06, high: center + 0.42, low: center - 0.48, close,
      volume: 120 + index % 11, quoteVolume: (120 + index % 11) * close,
      confirmed: true,
    })
  }

  const statistics = Array.from({ length: periods }, (_, index) => {
    const timestamp = start + index * HOUR
    const close = 200 + index * 0.084
    return {
      instrument: instId, timeframe, timestamp,
      open: close - 0.18, high: close + 0.51, low: close - 0.56, close,
      volume: 1_600, quoteVolume: close * 1_600,
      oi: 2_000_000 + index * 4_000,
      buy: 12_000 + index * 17,
      sell: 8_000 + index * 11,
      statisticsVersion: 1,
      confirmed: true,
    }
  })

  await store.appendCandles([...source, ...statistics])
  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'ETH' }
  const ticker = { instId, last: String(statistics.at(-1).close), open24h: '198', low24h: '196', high24h: '220', bidPx: '216.79', askPx: '216.80', volCcy24h: '300000' }
  const result = { eligible: true, turnover: 65_000_000, oiUSD: 6_500_000, spread: 0.005, depth: 250_000, slippage: 0.02 }

  const entry = { instrument, ticker, result, change24h: 4.2 }
  const savedAt = Date.now()
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.instruments.set(instId, instrument)
  marketService.lastCandleHydration.set(instId, Date.now())
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
  const periods = 2_048
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
        volume, quoteVolume: volume * close,
        oi: 2_100_000 + index * 230,
        buy: 92_000 + index % 800,
        sell: 76_000 + (index * 3) % 900,
        statisticsVersion: 1, confirmed: true,
      }
    })
  }
  // Keep both tested periods native. The production service must not derive
  // a 1H chart from a 5m fixture; this makes the benchmark exercise exactly
  // the persisted sequence and OKX period that the chart will use in-app.
  const hourly = buildCandles(timeframe, HOUR)
  const fifteenMinute = buildCandles(alternateTimeframe, 3 * FIVE_MINUTES)
  await store.appendCandles([...hourly, ...fifteenMinute])

  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.1', ctValCcy: 'SOL' }
  const ticker = { instId, last: String(hourly.at(-1).close), open24h: String(hourly.at(-25).open), low24h: '130', high24h: '180', bidPx: String(hourly.at(-1).close - .01), askPx: String(hourly.at(-1).close + .01), volCcy24h: '500000' }
  const result = { eligible: true, turnover: 90_000_000, oiUSD: 8_000_000, spread: 0.01, depth: 300_000, slippage: 0.02 }
  const entry = { instrument, ticker, result, change24h: 5.2 }
  const savedAt = Date.now()
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.instruments.set(instId, instrument)
  for (const frame of [timeframe, alternateTimeframe]) marketService.lastCandleHydration.set(`${frame}:${instId}`, savedAt)
  marketService.replaceCatalog([entry])
  await marketService.ensureListTimeframe(timeframe)
  await marketService.projectListEntry(instId, timeframe)
  marketService.error = ''
  marketService.lastRefreshAt = savedAt
  marketService.markChartDataChanged(instId)
  // 12 frames × 12 candles stays inside the resident chart range. The next
  // 22-frame phase deliberately reaches its 96-candle history floor.
  return { instId, timeframe, alternateTimeframe, intervalMS: HOUR, end, start: hourly[0].timestamp, periods, warmFrames: 12, boundaryFrames: 22 }
}

// Model the legacy cache at OKX's source retention boundary: prices exist,
// but OI is empty and Taker returned zero placeholders despite real trades.
export async function seedHistoricalStatisticsBoundary(store, marketService) {
  const fixture = await seedChartScrollBenchmark(store, marketService)
  const rows = await store.candles({ instrument: fixture.instId, timeframe: fixture.timeframe, from: fixture.end - 95 * HOUR, through: fixture.end })
  await store.appendCandles(rows.map(row => ({ ...row, oi: null, buy: 0, sell: 0, statisticsVersion: 7 })))
  marketService.markChartDataChanged(fixture.instId)
  return fixture
}
