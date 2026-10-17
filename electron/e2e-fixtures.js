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
