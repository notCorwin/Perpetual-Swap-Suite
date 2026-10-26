import { barsWithIndicators } from './services/indicators.js'
import { quoteTurnover24h } from './services/liquidity.js'

const FIVE_MINUTES = 300_000
const HOUR = 3_600_000

// Fixtures use the same independent price/statistic ledgers as production.
async function persistNativeFixture(store, marketService, rows) {
  const { instrument, timeframe } = rows[0]
  await marketService.persistCandles(instrument, rows)
  const range = { instrument, timeframe, from: rows[0].timestamp, through: rows.at(-1).timestamp, expiresAt: Date.now() + 60_000 }
  await store.appendStatistics({ ...range, source: 'oi', values: rows.filter(row => row.oi != null).map(row => [row.timestamp, row.oi]) })
  await store.appendStatistics({ ...range, source: 'taker', values: rows.filter(row => row.buy != null && row.sell != null).map(row => [row.timestamp, row.sell, row.buy]) })
  await marketService.preparedCharts.observeStatistics(instrument, timeframe, range.from, range.through)
}

// Keep this fixture at the data boundary.  It intentionally registers only a
// market catalog entry plus durable source/statistics observations: the
// backend publishes its canonical row and owns preparation of all native periods.
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
      statisticsVersion: 11,
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

  return { instId, timeframe, end, periods, savedAt }
}

// A dense, fully local chart fixture for renderer benchmarks. It writes the
// same durable rows that the production chart uses; no synthetic IPC response
// or network timing is involved.
export async function seedChartScrollBenchmark(store, marketService, { instId = 'SOL-USDT-SWAP', unavailableStatistics = false } = {}) {
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
        statisticsVersion: 11, statisticsSources: 3, statisticsObserved: true, confirmed: true,
      }
    })
  }
  // Persist each native period independently. The oracle is calculated once
  // from the complete durable sequence, including the canonical EMA/RSI seed,
  // so a later page cannot silently change the value at an existing timestamp.
  const intervals = { '5m': FIVE_MINUTES, '15m': 3 * FIVE_MINUTES, '1H': HOUR }
  const candlesByFrame = Object.fromEntries(timeframes.map(frame => [frame, buildCandles(frame, intervals[frame])]))
  const hourly = candlesByFrame[timeframe]
  for (const frame of timeframes) await persistNativeFixture(store, marketService, candlesByFrame[frame].map(row => unavailableStatistics && frame === timeframe ? { ...row, oi: null, buy: null, sell: null } : row))
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
  marketService.error = ''
  marketService.lastRefreshAt = savedAt
  marketService.markChartDataChanged(instId)
  return { instId, timeframe, alternateTimeframe, timeframes, intervalMS: HOUR, end, start: hourly[0].timestamp, periods, series }
}

// Model successful empty source observations: prices exist,
// but OI is empty and Taker returned zero placeholders despite real trades.
export async function seedHistoricalStatisticsBoundary(store, marketService) {
  const fixture = await seedChartScrollBenchmark(store, marketService, { instId: 'EMPTY-USDT-SWAP', unavailableStatistics: true })
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
          statisticsVersion: 11, statisticsSources: 3, statisticsObserved: true, confirmed: true,
        }
      })
      await persistNativeFixture(store, marketService, candles)
      series[timeframe] = { intervalMS, start, end, bars: barsWithIndicators(candles, intervalMS) }
    }
    const latest = series['1H'].bars.at(-1)
    const symbol = instId.split('-')[0]
    const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: symbol }
    const ticker = { instId, last: String(latest.close), open24h: String(series['1H'].bars.at(-25).open), low24h: String(latest.low - 2), high24h: String(latest.high + 2), bidPx: String(latest.close - .01), askPx: String(latest.close + .01), volCcy24h: '500000' }
    const result = { eligible: true, turnover: 90_000_000 + instrumentIndex * 1_000_000, oiUSD: 8_000_000, spread: .005, depth: 300_000, slippage: .02 }
    marketService.instruments.set(instId, instrument)
    // Source freshness has dedicated acceptance tests. Keep this synthetic
    // market available while all 48 first-ever canonical checkpoints are built,
    // including under an intentionally busy storage/indicator worker.
    catalog.push({ instrument, ticker, result, change24h: instrumentIndex + .1,
      observedAt: savedAt, expiresAt: savedAt + 10 * 60_000 })
    // The navigation acceptance only draws latest windows. Keep the oracle's
    // full canonical calculation above, then send its 96 visible values rather
    // than transferring all 61,440 history bars through the measurement driver.
    instruments.push({ instId, series: Object.fromEntries(Object.entries(series).map(([frame, value]) => [frame,
      { ...value, bars: value.bars.slice(-96) }])) })
    marketService.markChartDataChanged(instId)
  }
  marketService.catalogUpdatedAt = savedAt
  marketService.catalogSource = 'live'
  marketService.replaceCatalog(catalog)
  marketService.error = ''
  marketService.lastRefreshAt = savedAt
  return { instIds, timeframes, timeframe: '1H', intervalMS: HOUR, end, periods, instruments,
    seedStartedAt: savedAt, seedCompletedAt: Date.now() }
}

// Unlike the dense scroll fixture, the selected historical period does not
// exist at installation. Each step enters the production post-fetch history
// writer as a native price/OI/Taker page; derived values are never injected.
export async function createChartAcquisitionFixture(store, marketService, { timeframe = '15m', mode = 'gap' } = {}) {
  if (!['5m', '15m', '1H'].includes(timeframe) || !['gap', 'prepend'].includes(mode)) throw new TypeError('Invalid acquisition fixture.')
  const instId = `ACQUIRE-${mode.toUpperCase()}-${timeframe.toUpperCase()}-USDT-SWAP`
  const intervalMS = { '5m': FIVE_MINUTES, '15m': 3 * FIVE_MINUTES, '1H': HOUR }[timeframe]
  const periods = 3072, end = Date.UTC(2025, 9, 17, 12), start = end - (periods - 1) * intervalMS
  const rows = Array.from({ length: periods }, (_, index) => {
    const open = 100 + index * .031 + Math.sin(index / 17) * 2.1 + Math.cos(index / 61) * .8
    const close = open + Math.sin(index / 5) * .27, volume = 2400 + index % 511
    return { instrument: instId, timeframe, timestamp: start + index * intervalMS,
      open, high: Math.max(open, close) + .8, low: Math.min(open, close) - .8, close,
      volume, baseVolume: volume, quoteVolume: volume * close, confirmed: true,
      oi: 2_000_000 + index * 213, buy: 81_000 + index % 711, sell: 62_000 + index % 811,
      statisticsVersion: 11, statisticsSources: 3, statisticsObserved: true }
  })
  const prefix = mode === 'gap' ? rows.slice(0, 768) : rows.slice(512, 1280)
  const pending = mode === 'gap' ? rows.slice(768, periods - 128) : rows.slice(0, 512)
  const queues = Object.fromEntries(['candles', 'oi', 'taker'].map(source => [source, [...pending]]))
  const writes = []
  const write = async (source, page) => {
    if (!page.length) return { source, count: 0, done: true }
    const task = { instrument: instId, timeframe, source, from: page[0].timestamp, through: page.at(-1).timestamp, priority: 'interactive' }
    const records = page.map(row => source === 'candles' ? row : { instrument: instId, timeframe, timestamp: row.timestamp,
      ...(source === 'oi' ? { oi: row.oi } : { buy: row.buy, sell: row.sell }) })
    await marketService.history.write(records, task)
    const result = { source, from: task.from, through: task.through, count: page.length }
    writes.push(result)
    return result
  }
  // Only a current quote tail exists before the first historical gesture.
  await persistNativeFixture(store, marketService, rows.slice(-128))
  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.1', ctValCcy: 'ACQUIRE', listTime: String(start) }
  const ticker = { instId, last: String(rows.at(-1).close), open24h: String(rows.at(-25).open), low24h: '100', high24h: '210',
    bidPx: String(rows.at(-1).close - .01), askPx: String(rows.at(-1).close + .01), volCcy24h: '500000' }
  marketService.instruments.set(instId, instrument)
  marketService.catalogUpdatedAt = Date.now(); marketService.catalogSource = 'live'
  marketService.replaceCatalog([{ instrument, ticker, result: { eligible: true, turnover: 90_000_000, oiUSD: 8_000_000, spread: .01, depth: 300_000, slippage: .02 }, change24h: 5.2 }])
  marketService.error = ''; marketService.lastRefreshAt = Date.now()
  const targetEnd = rows[mode === 'gap' ? 600 : 1100].timestamp
  const fixture = { instId, timeframe, timeframes: [timeframe], intervalMS, end, start, periods, targetEnd, mode,
    series: { [timeframe]: { intervalMS, start, end, bars: barsWithIndicators(rows, intervalMS) } },
    initialSeries: { [timeframe]: { intervalMS, start: prefix[0].timestamp, end: prefix.at(-1).timestamp, bars: barsWithIndicators(prefix, intervalMS) } } }
  let prefixed = false
  return { fixture, async step(source) {
    if (source === 'prefix') {
      if (!prefixed) for (const family of ['candles', 'oi', 'taker']) {
        const limit = family === 'candles' ? 300 : 100
        for (let offset = 0; offset < prefix.length; offset += limit) await write(family, prefix.slice(offset, offset + limit))
      }
      prefixed = true
      return { source, done: true, count: prefix.length, writes: writes.length }
    }
    if (!queues[source]) throw new TypeError('Invalid acquisition source.')
    const queue = queues[source], limit = source === 'candles' ? 300 : 100
    const page = queue.splice(Math.max(0, queue.length - limit))
    return { ...await write(source, page), done: queue.length === 0, writes: writes.length }
  } }
}

// Unlike a delayed chart IPC response, these requests cross the real native
// source adapter, history scheduler and SQLite page writer. Only the latest
// tail exists initially; older reserve pages and both optional sources can be
// held independently after the nearest price page has arrived.
export async function createChartColdBoundaryFixture(store, marketService, {
  timeframe = '15m', scenario = 'single-missing-boundary', sourceDelayMS = 100, failNearestCandles = false,
} = {}) {
  if (!['5m', '15m', '1H'].includes(timeframe) || !['single-missing-boundary', 'full-missing-window'].includes(scenario)
    || !Number.isFinite(sourceDelayMS) || sourceDelayMS < 0 || typeof failNearestCandles !== 'boolean') throw new TypeError('Invalid cold-boundary fixture.')
  const variant = scenario === 'full-missing-window' ? failNearestCandles ? 'EMPTY-FAIL' : 'EMPTY' : 'BOUNDARY'
  const instId = `COLD-${variant}-${timeframe.toUpperCase()}-USDT-SWAP`
  const intervalMS = { '5m': FIVE_MINUTES, '15m': 3 * FIVE_MINUTES, '1H': HOUR }[timeframe]
  const periods = 8192, initialHistoryBars = scenario === 'full-missing-window' ? 512 : 1000
  const end = Math.floor(Date.now() / intervalMS) * intervalMS - intervalMS
  const targetDistance = scenario === 'full-missing-window' ? initialHistoryBars + 1 : initialHistoryBars - 95
  const start = end - (periods - 1) * intervalMS, targetEnd = end - targetDistance * intervalMS
  const targetWindowStart = targetEnd - 95 * intervalMS
  const firstMissingEnd = end - initialHistoryBars * intervalMS
  const rows = Array.from({ length: periods }, (_, index) => {
    const open = 130 + index * .009 + Math.sin(index / 19) * 1.1
    const close = open + Math.cos(index / 7) * .31, volume = 3000 + index % 401
    return { instrument: instId, timeframe, timestamp: start + index * intervalMS,
      open, high: Math.max(open, close) + .6, low: Math.min(open, close) - .6, close,
      volume, baseVolume: volume, quoteVolume: volume * close, confirmed: true,
      oi: 2_000_000 + index * 113, buy: 70_000 + index % 701, sell: 60_000 + index % 601,
      statisticsVersion: 11, statisticsSources: 3, statisticsObserved: true }
  })
  const original = marketService.get.bind(marketService), requests = []
  let release
  const released = new Promise(resolve => { release = resolve })
  let holding = true, active = 0, maxActive = 0
  marketService.get = async (path, parameters, signal, priority) => {
    if (parameters?.instId !== instId) return original(path, parameters, signal, priority)
    const source = path === '/market/history-candles' ? 'candles'
      : path === '/rubik/stat/contracts/open-interest-history' ? 'oi'
        : path === '/rubik/stat/taker-volume-contract' ? 'taker' : null
    if (!source || (source === 'candles' ? parameters.bar : parameters.period) !== timeframe) return original(path, parameters, signal, priority)
    const through = source === 'candles' ? Number(parameters.after) - intervalMS : Number(parameters.end) - intervalMS
    const from = source === 'candles' ? through - (Number(parameters.limit) - 1) * intervalMS : Number(parameters.begin) + intervalMS
    const nearestSourceEnd = scenario === 'full-missing-window' ? targetEnd : firstMissingEnd
    const held = source !== 'candles' || through < nearestSourceEnd
    const request = { source, path, parameters: { ...parameters }, from, through, priority, held: held && holding,
      startedAt: Date.now(), completedAt: null, failedAt: null, error: null }
    requests.push(request)
    active += 1; maxActive = Math.max(maxActive, active)
    try {
      if (held && holding) await new Promise((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cold-boundary request aborted.')) }
        if (signal?.aborted) return abort()
        signal?.addEventListener('abort', abort, { once: true })
        released.then(() => { signal?.removeEventListener('abort', abort); resolve() })
      })
      await new Promise(resolve => setTimeout(resolve, sourceDelayMS))
      signal?.throwIfAborted()
      if (failNearestCandles && source === 'candles' && from <= targetEnd && through >= targetWindowStart) {
        throw new Error('Configured cold-window source failure.')
      }
      const page = rows.filter(row => row.timestamp >= from && row.timestamp <= through).reverse()
      request.completedAt = Date.now()
      return page.map(row => source === 'candles'
        ? [row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume, row.quoteVolume, '1'].map(String)
        : (source === 'oi' ? [row.timestamp, row.oi] : [row.timestamp, row.sell, row.buy]).map(String))
    } catch (error) {
      request.failedAt = Date.now(); request.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { active -= 1 }
  }
  await persistNativeFixture(store, marketService, rows.slice(-initialHistoryBars))
  const instrument = { instId, instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.1', ctValCcy: 'COLD', listTime: String(start) }
  const ticker = { instId, last: String(rows.at(-1).close), open24h: String(rows.at(-25).open), low24h: '100', high24h: '230',
    bidPx: String(rows.at(-1).close - .01), askPx: String(rows.at(-1).close + .01), volCcy24h: '500000' }
  marketService.instruments.set(instId, instrument)
  marketService.catalogUpdatedAt = Date.now(); marketService.catalogSource = 'live'
  marketService.replaceCatalog([{ instrument, ticker, result: { eligible: true, turnover: 90_000_000, oiUSD: 8_000_000,
    spread: .01, depth: 300_000, slippage: .02 }, change24h: 5.2 }])
  marketService.error = ''; marketService.lastRefreshAt = Date.now()
  const fixture = { instId, timeframe, timeframes: [timeframe], intervalMS, end, start, periods, scenario,
    initialHistoryBars, targetDistance, targetEnd, targetWindowStart, firstMissingEnd, sourceDelayMS, failNearestCandles,
    initiallyMissingViewportBars: scenario === 'full-missing-window' ? 96 : 1,
    series: { [timeframe]: { intervalMS, start, end, bars: barsWithIndicators(rows, intervalMS) } } }
  return { fixture, read: () => ({ holding, active, maxActive, requests: requests.map(request => ({ ...request })) }),
    release: () => { holding = false; release() },
    remove: () => { holding = false; release(); marketService.get = original } }
}
