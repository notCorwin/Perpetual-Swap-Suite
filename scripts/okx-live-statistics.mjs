import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketService } from '../electron/services/market-service.js'
import { MarketStore } from '../electron/services/market-store.js'

// Opt in with: node scripts/okx-live-statistics.mjs [--report PATH]
// This uses public OKX endpoints and an isolated, disposable data directory.
const INSTRUMENT = 'BTC-USDT-SWAP'
const DAY = 86_400_000, HOUR = 3_600_000
const INTERVALS = { '5m': 300_000, '1H': HOUR }
const configuredTimeout = Number(process.env.OKX_LIVE_TIMEOUT_MS)
const TEST_TIMEOUT = Number.isFinite(configuredTimeout) && configuredTimeout >= 10_000 ? configuredTimeout : 90_000
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--report' && args[1], 'Usage: node scripts/okx-live-statistics.mjs [--report PATH]')
const reportPath = args[1]
const startedAt = Date.now()
const root = await mkdtemp(join(tmpdir(), 'perp-radar-okx-live-statistics-'))
const controller = new AbortController()
const requests = [], operations = [], results = [], repeatRequests = []
const from = Math.floor((Date.now() - 30 * DAY) / HOUR) * HOUR
const targets = Object.entries(INTERVALS).map(([timeframe, intervalMS]) => ({
  instrument: INSTRUMENT, timeframe, intervalMS, from, through: from + HOUR - intervalMS,
}))
const sourceOf = url => url.pathname.endsWith('/open-interest-history') ? 'oi'
  : url.pathname.endsWith('/taker-volume-contract') ? 'taker' : null
const nonnegative = value => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
const fetcher = async (input, options) => {
  const url = new URL(String(input))
  const request = { url, startedAt: Date.now(), source: sourceOf(url) }
  requests.push(request)
  try {
    const response = await fetch(input, options)
    request.status = response.status
    const payload = await response.clone().json()
    request.code = payload.code
    if (request.source) request.records = payload.data
    return response
  } catch (error) {
    request.error = error.message
    throw error
  } finally {
    request.elapsedMS = Date.now() - request.startedAt
  }
}
let store, service, timer

function validateRows(target, rows) {
  const { timeframe, intervalMS } = target
  assert.equal(rows.length, HOUR / intervalMS, `${timeframe}: persist every native price candle in the requested hour.`)
  const sourceRequests = requests.filter(request => request.source && request.url.searchParams.get('period') === timeframe)
  for (const source of ['oi', 'taker']) {
    const calls = sourceRequests.filter(request => request.source === source)
    assert.ok(calls.length > 0, `${timeframe}: actually probe ${source}; never skip it using a local retention cutoff.`)
    for (const request of calls) {
      assert.equal(Number(request.url.searchParams.get('begin')), target.from - intervalMS, `${timeframe} ${source}: begin excludes its boundary.`)
      assert.equal(Number(request.url.searchParams.get('end')), target.through + intervalMS, `${timeframe} ${source}: end excludes its boundary.`)
      assert.equal(request.url.searchParams.get('limit'), '100')
      if (source === 'taker') assert.equal(request.url.searchParams.get('unit'), '1', 'Taker quantities must use contracts.')
      assert.equal(request.status, 200)
      assert.equal(request.code, '0')
      assert.ok(Array.isArray(request.records))
    }
  }
  const records = source => new Map(sourceRequests.filter(request => request.source === source)
    .flatMap(request => request.records ?? []).map(row => [Number(row[0]), row]))
  const oi = records('oi'), taker = records('taker')
  for (const [index, row] of rows.entries()) {
    assert.equal(row.timestamp, target.from + index * intervalMS)
    assert.equal(row.confirmed, true)
    assert.ok(row.volume >= 0 && row.baseVolume >= 0 && row.quoteVolume >= 0)
    assert.ok(Number.isInteger(row.statisticsVersion) && row.statisticsVersion > 0, 'Both sources must have durable observations.')
    const expectedOI = nonnegative(oi.get(row.timestamp)?.[1])
    const rawTaker = taker.get(row.timestamp)
    const sell = nonnegative(rawTaker?.[1]), buy = nonnegative(rawTaker?.[2])
    const validTaker = sell !== null && buy !== null
      && (sell + buy > 0 || row.volume === 0 && row.quoteVolume === 0)
    assert.equal(row.oi, expectedOI, `${timeframe}: preserve actual OI values and represent absent values with null.`)
    assert.equal(row.sell, validTaker ? sell : null, `${timeframe}: do not display zero placeholders as real traded-period sells.`)
    assert.equal(row.buy, validTaker ? buy : null, `${timeframe}: do not display zero placeholders as real traded-period buys.`)
    if (expectedOI === null) assert.ok(row.statisticsOIExpiresAt > Date.now(), 'An empty OI response needs a bounded retry lease.')
    if (!validTaker) assert.ok(row.statisticsTakerExpiresAt > Date.now(), 'Absent or inconsistent Taker data needs a bounded retry lease.')
  }
  return {
    timeframe,
    candles: rows.length,
    tradedCandles: rows.filter(row => row.volume > 0 || row.quoteVolume > 0).length,
    oiReturnedRows: [...oi.keys()].filter(timestamp => timestamp >= target.from && timestamp <= target.through).length,
    oiAvailableRows: rows.filter(row => row.oi !== null).length,
    takerReturnedRows: [...taker.keys()].filter(timestamp => timestamp >= target.from && timestamp <= target.through).length,
    takerAvailableRows: rows.filter(row => row.buy !== null && row.sell !== null).length,
    takerRawZeroPairs: [...taker].filter(([timestamp, row]) => timestamp >= target.from && timestamp <= target.through
      && nonnegative(row[1]) === 0 && nonnegative(row[2]) === 0).length,
    rows: rows.map(({ timestamp, volume, quoteVolume, oi, buy, sell }) => ({ timestamp, volume, quoteVolume, oi, buy, sell })),
  }
}

try {
  store = await MarketStore.open(root)
  service = new MarketService(store, undefined, fetcher, false, { requestTimeout: 12_000 })
  const run = (async () => {
    await service.ready
    for (const target of targets) {
      const result = await service.history.ensureStatistics(INSTRUMENT, target.timeframe, target.from, target.through, 'foreground', controller.signal)
      const rows = result.rows.sort((a, b) => a.timestamp - b.timestamp)
      results.push(validateRows(target, rows))
      const requestCount = requests.length
      await service.history.ensureStatistics(INSTRUMENT, target.timeframe, target.from, target.through, 'foreground', controller.signal)
      assert.equal(requests.length, requestCount, `${target.timeframe}: repeat requests must reuse published values and unexpired null observations.`)
      repeatRequests.push({ timeframe: target.timeframe, httpRequests: requests.length - requestCount })
    }
    await service.dispose()
    await store.close()
    store = await MarketStore.open(root)
    for (const [index, target] of targets.entries()) {
      const rows = (await store.candles(target)).sort((a, b) => a.timestamp - b.timestamp)
      assert.deepEqual(validateRows(target, rows), results[index], `${target.timeframe}: closing and reopening DuckDB must preserve source observations.`)
    }
    assert.equal(requests.some(request => request.status === 429), false, 'The regression must respect source request pacing.')
  })()
  operations.push(run)
  await Promise.race([run, new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Historical statistics regression exceeded ${TEST_TIMEOUT}ms.`)
      controller.abort(error)
      reject(error)
    }, TEST_TIMEOUT)
  })])
  const report = {
    integration: 'okx-bounded-historical-statistics', instrument: INSTRUMENT, checkedAt: new Date().toISOString(),
    elapsedMS: Date.now() - startedAt, verification: { repeatRequests, durableReopen: true },
    from: new Date(from).toISOString(), through: new Date(from + HOUR - 1).toISOString(),
    semantics: 'Observed public API responses; successful timestamps alone do not prove available quantities. No coarse-period interpolation.',
    sameHour: results.map(result => ({
      timeframe: result.timeframe,
      availableTakerRows: result.takerAvailableRows,
      buyContracts: result.takerAvailableRows === result.candles ? result.rows.reduce((sum, row) => sum + row.buy, 0) : null,
      sellContracts: result.takerAvailableRows === result.candles ? result.rows.reduce((sum, row) => sum + row.sell, 0) : null,
    })),
    results,
    requests: requests.map(({ url, source, status, code, error, startedAt, elapsedMS }) => ({
      path: url.pathname, query: url.search, source, status, code, error, startedAt, elapsedMS,
    })),
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (reportPath) await writeFile(reportPath, serialized)
  process.stdout.write(serialized)
} catch (error) {
  if (error instanceof Error) error.message += `\nObserved requests:\n${requests.map(request => `${request.url} status=${request.status ?? request.error} code=${request.code}`).join('\n')}`
  throw error
} finally {
  clearTimeout(timer)
  controller.abort()
  // Source tasks may still be unwinding after a timeout. Drain accepted writes
  // and all callers before deleting the temporary Parquet/SQLite directory.
  await service?.dispose()
  await Promise.allSettled(operations)
  await store?.close()
  await rm(root, { recursive: true, force: true })
}
