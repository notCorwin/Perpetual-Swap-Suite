import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { barsWithIndicators } from '../electron/services/indicators.js'

const hour = 3_600_000
const step = 300_000
const instId = 'BTC-USDT-SWAP'
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const candle = (timestamp: number, index: number, timeframe = '1H') => ({ instrument: instId, timeframe, timestamp,
  open: 100 + Math.sin(index / 9), high: 102 + Math.sin(index / 9), low: 98 + Math.sin(index / 9),
  close: 100 + Math.sin(index / 9) + index / 1_000, volume: 10 + index / 100, quoteVolume: 1_000 + index,
  oi: 10_000 + index, buy: 40 + index, sell: 20 + index, statisticsVersion: 1, confirmed: true })
const visible = (result: any, end: number, interval = hour) => result.bars.filter((bar: any) => bar.hour >= end - 95 * interval && bar.hour <= end)
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 300; i += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }; throw new Error('Timed out waiting for prepared source requests.') }

test('prepared windows use the entire canonical native series and reuse indicators across statistics writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  let source = Array.from({ length: 2_048 }, (_, index) => candle(first + index * hour, index))
  const service = new MarketService(store, undefined, async () => { throw new Error('A complete cached series must not fetch.') }, false)
  try {
    await store.appendCandles(source)
    const end = source.at(-1)!.timestamp - 200 * hour
    const result = await service.prepareChartWindow(instId, '1H', end)
    assert.ok(result.bars.length <= 200)
    assert.equal(visible(result, end).length, 96)
    const oracle = new Map(barsWithIndicators(source, hour).map((bar: any) => [bar.hour, bar]))
    for (const bar of visible(result, end)) {
      for (const key of ['ema', 'rsi6', 'rsi12', 'rsi24', 'vwap', 'logBBUpper', 'roc', 'maroc']) assert.equal(bar[key], (oracle.get(bar.hour) as any)[key])
      assert.equal(bar.statisticsObserved, true)
      assert.equal(bar.indicatorsObserved, true)
    }
    const calculations = service.preparedCharts.nextCalculation
    await service.prepareChartWindow(instId, '1H', end - 101 * hour)
    assert.equal(service.preparedCharts.nextCalculation, calculations, 'Scrolling never chooses another recursive indicator seed.')

    await service.persistStatisticsSource({ instId }, '1H', end, 1, source.filter(row => row.timestamp >= end - 99 * hour && row.timestamp <= end).map(row => [String(row.timestamp), '90000']))
    const patched = await service.prepareChartWindow(instId, '1H', end)
    assert.equal(patched.generation, result.generation)
    assert.equal(service.preparedCharts.nextCalculation, calculations)
    assert.ok(visible(patched, end).every((bar: any) => bar.oi === 90_000))

    const corrected = { ...source[1_000], close: 110, high: 112 }
    await service.persistCandles(instId, [corrected], { projectList: false })
    source = source.map(row => row.timestamp === corrected.timestamp ? corrected : row)
    const correction = await service.prepareChartWindow(instId, '1H', end)
    assert.ok(correction.generation > result.generation)
    assert.equal(visible(correction, end).at(-1).ema, barsWithIndicators(source, hour).find((bar: any) => bar.hour === end)?.ema)
    const appended = candle(source.at(-1)!.timestamp + hour, 2_048)
    await service.persistCandles(instId, [appended], { projectList: false })
    const tail = await service.prepareChartWindow(instId, '1H', end)
    assert.equal(tail.generation, correction.generation, 'Appending a tail preserves every earlier recursive value.')
    assert.equal(visible(tail, end).at(-1).ema, visible(correction, end).at(-1).ema)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('prepared source pages are shared across concurrent windows and survive unrelated focus changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const end = (Math.floor(Date.now() / (100 * step)) - 2) * 100 * step + 99 * step
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(end - (399 - index) * step, index, '5m'), oi: null, buy: null, sell: null, statisticsVersion: null }))
  const calls: string[] = [], releases: Array<() => void> = []
  let released = false
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input)); calls.push(`${url.pathname}:${url.searchParams.get('end')}`)
    const from = Number(url.searchParams.get('begin')), through = Number(url.searchParams.get('end'))
    const rows = source.filter(row => row.timestamp > from && row.timestamp < through).map(row => url.pathname.endsWith('/open-interest-history')
      ? [String(row.timestamp), '1234'] : [String(row.timestamp), '20', '30'])
    if (!released) await new Promise<void>(resolve => releases.push(resolve))
    return response(rows)
  }, false)
  try {
    await store.appendCandles(source)
    const pending = service.prepareChartWindow(instId, '5m', end)
    await waitFor(() => calls.length === 2)
    service.cancelBackgroundRequests()
    const duplicate = service.prepareChartWindow(instId, '5m', end)
    released = true; releases.splice(0).forEach(release => release())
    const results = await Promise.all([pending, duplicate])
    assert.equal(calls.length, 2)
    assert.equal(new Set(calls).size, calls.length)
    for (const result of results) {
      assert.equal(result.oiState, 'ready'); assert.equal(result.takerState, 'ready')
      assert.ok(visible(result, end, step).every((bar: any) => bar.statisticsSources === 3 && bar.oi === 1_234 && bar.buy === 30 && bar.sell === 20))
    }
    const wholePage = await store.candles({ instrument: instId, timeframe: '5m', from: end - 99 * step, through: end })
    assert.equal(wholePage.length, 100)
    assert.ok(wholePage.every(row => row.oi === 1_234 && row.buy === 30 && row.sell === 20), 'Strict begin/end bounds must include all 100 observations, including the first period.')
  } finally { released = true; releases.splice(0).forEach(release => release()); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('transport failures do not create source-empty observations; successful unavailable history stays truthful', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const end = (Math.floor(Date.now() / (100 * step)) - 2) * 100 * step + 99 * step
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(end - (399 - index) * step, index, '5m'), oi: null, buy: null, sell: null, statisticsVersion: null }))
  let fail = true
  const service = new MarketService(store, undefined, async () => fail ? new Response(null, { status: 503 }) : response([]), false)
  try {
    await store.appendCandles(source)
    await assert.rejects(service.prepareChartWindow(instId, '5m', end), /503/)
    const unread = await store.candles({ instrument: instId, timeframe: '5m', from: end - 95 * step, through: end })
    assert.ok(unread.every(row => !row.statisticsVersion))
    fail = false
    const result = await service.prepareChartWindow(instId, '5m', end)
    assert.equal(result.oiState, 'unavailable'); assert.equal(result.takerState, 'unavailable')
    assert.ok(visible(result, end, step).every((bar: any) => bar.statisticsObserved && bar.oi === null && bar.buy === null && bar.sell === null))
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a partial latest statistics block never marks its unrequested older tail as observed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const blockStart = (Math.floor(Date.now() / (100 * step)) - 2) * 100 * step
  const end = blockStart + 95 * step
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(end - (399 - index) * step, index, '5m'), oi: null, buy: null, sell: null, statisticsVersion: null }))
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input)), from = Number(url.searchParams.get('begin')), through = Number(url.searchParams.get('end'))
    return response(source.filter(row => row.timestamp > from && row.timestamp < through).map(row => url.pathname.endsWith('/open-interest-history')
      ? [String(row.timestamp), '1234'] : [String(row.timestamp), '20', '30']))
  }, false)
  try {
    await store.appendCandles(source)
    const prepared = await service.prepareChartWindow(instId, '5m', end)
    assert.equal(visible(prepared, end, step).length, 96)
    const older = await store.candles({ instrument: instId, timeframe: '5m', from: blockStart - 4 * step, through: blockStart - step })
    assert.equal(older.length, 4)
    assert.ok(older.every(row => !row.statisticsVersion), 'No source request covered these older four periods.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an already complete 96-window never waits for the four extra statistics page observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const end = (Math.floor(Date.now() / (100 * step)) - 2) * 100 * step + 99 * step
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(end - (399 - index) * step, index, '5m'),
    ...(index >= 300 && index < 304 ? { oi: null, buy: null, sell: null, statisticsVersion: null } : {}) }))
  const service = new MarketService(store, undefined, async () => { throw new Error('The prepared 96-window must be immediately reusable.') }, false)
  try {
    await store.appendCandles(source)
    const result = await service.prepareChartWindow(instId, '5m', end)
    assert.equal(visible(result, end, step).length, 96)
    assert.equal(result.oiState, 'ready'); assert.equal(result.takerState, 'ready')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('new listings expose truthful undefined indicators and a provider floor instead of a resident cache floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 120 }, (_, index) => candle(first + index * hour, index))
  const service = new MarketService(store, undefined, async () => { throw new Error('A complete listing fixture must stay local.') }, false)
  try {
    await store.appendCandles(source)
    service.instruments.set(instId, { instId, listTime: String(first + 1_000) })
    const result = await service.prepareChartWindow(instId, '1H', first - 500 * hour)
    assert.equal(result.oldestHour, first)
    assert.equal(result.endHour, first + 95 * hour)
    assert.equal(result.historyExhausted, true)
    assert.equal(result.indicatorState, 'unavailable')
    assert.ok(visible(result, result.endHour!).every((bar: any) => bar.indicatorsObserved && bar.ema === null && bar.statisticsObserved))
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a proven new listing with fewer than 96 elapsed periods is unavailable until its first full window can close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Math.floor(Date.now() / step) * step - 20 * step
  const source = Array.from({ length: 20 }, (_, index) => candle(first + index * step, index, '5m'))
  let calls = 0
  const service = new MarketService(store, undefined, async () => { calls += 1; throw new Error('Future candles cannot be repaired.') }, false)
  try {
    await store.appendCandles(source)
    service.instruments.set(instId, { instId, listTime: String(first + 1_000) })
    const result = await service.prepareChartWindow(instId, '5m', source.at(-1)!.timestamp)
    assert.deepEqual(result.bars, [])
    assert.equal(result.endHour, null)
    assert.equal(result.error, '')
    assert.deepEqual(result.unavailable, { reason: 'insufficient-history', availableCandles: 20, requiredCandles: 96, retryAt: first + 96 * step + 1_000 })
    await service.prepareChartWindow(instId, '5m', source.at(-1)!.timestamp)
    assert.equal(calls, 0)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a new listing with zero completed candles returns terminal metadata on the latest path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Math.floor(Date.now() / step) * step
  let calls = 0
  const service = new MarketService(store, undefined, async () => { calls += 1; return response([[String(first), '100', '101', '99', '100', '1', '0', '100', '0']]) }, false)
  try {
    service.instruments.set(instId, { instId, listTime: String(first + 1) })
    const result = await service.prepareChartWindow(instId, '5m')
    assert.equal(result.error, '')
    assert.equal(result.endHour, null)
    assert.deepEqual(result.bars, [])
    assert.equal(result.unavailable?.availableCandles, 0)
    assert.equal(result.unavailable?.retryAt, first + 96 * step + 1_000)
    await service.prepareChartWindow(instId, '5m')
    assert.equal(calls, 1)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('missing native history is persisted once and a cache edge never declares exchange exhaustion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 900 }, (_, index) => candle(first + index * hour, index))
  const calls: string[] = []
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input)); calls.push(String(url))
    assert.ok(url.pathname.endsWith('/market/history-candles'))
    const after = Number(url.searchParams.get('after')), limit = Number(url.searchParams.get('limit'))
    return response(source.filter(row => row.timestamp < after).slice(-limit).reverse().map(row => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), String(row.volume), '0', String(row.quoteVolume), '1']))
  }, false)
  try {
    await store.appendCandles(source.slice(-100))
    const end = source.at(-1)!.timestamp
    // Historical statistics outside retention are explicitly observed nulls.
    const prepared = await service.prepareChartWindow(instId, '1H', end)
    assert.equal(visible(prepared, end).length, 96)
    assert.equal(prepared.oldestHour, null)
    assert.equal(prepared.historyExhausted, false)
    assert.ok(calls.length > 0)
    const count = calls.length
    await service.prepareChartWindow(instId, '1H', end)
    assert.equal(calls.length, count)
    assert.ok((await store.candles({ instrument: instId, timeframe: '1H' })).length >= 295)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a far empty historical cursor discovers the actual provider floor rather than the resident cache edge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 900 }, (_, index) => candle(first + index * hour, index))
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input))
    assert.ok(url.pathname.endsWith('/market/history-candles'))
    const after = Number(url.searchParams.get('after')), limit = Number(url.searchParams.get('limit'))
    return response(source.filter(row => row.timestamp < after).slice(-limit).reverse().map(row => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), String(row.volume), '0', String(row.quoteVolume), '1']))
  }, false)
  try {
    await store.appendCandles(source.slice(-100))
    const prepared = await service.prepareChartWindow(instId, '1H', first - 500 * hour)
    assert.equal(prepared.oldestHour, first)
    assert.equal(prepared.endHour, first + 95 * hour)
    assert.equal(prepared.historyExhausted, true)
    assert.equal(visible(prepared, prepared.endHour!).length, 96)
    assert.equal(prepared.indicatorState, 'unavailable')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('inactive canonical series are evicted by LRU and row budget, and revisits reproduce their full-history indicators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => candle(first + index * step, index, '5m'))
  const ids = Array.from({ length: 9 }, (_, index) => `MARKET${index}-USDT-SWAP`)
  const service = new MarketService(store, undefined, async () => { throw new Error('Canonical cache revisits must read durable data.') }, false)
  try {
    await store.appendCandles(ids.flatMap(instrument => source.map(row => ({ ...row, instrument }))))
    let original: any
    for (const id of ids) {
      const result = await service.prepareChartWindow(id, '5m', source.at(-1)!.timestamp)
      if (id === ids[0]) original = result
      assert.ok(service.preparedCharts.series.size <= 8)
    }
    assert.equal(service.preparedCharts.series.has(`${ids[0]}:5m`), false)
    const reloaded = await service.prepareChartWindow(ids[0], '5m', source.at(-1)!.timestamp)
    assert.ok(reloaded.generation > original.generation)
    const oldBars = visible(original, original.endHour, step), newBars = visible(reloaded, reloaded.endHour!, step)
    for (let i = 0; i < 96; i += 1) for (const field of ['ema', 'rsi6', 'rsi12', 'rsi24', 'vwap', 'logBBUpper']) assert.equal(newBars[i][field], oldBars[i][field])
    service.preparedCharts.maxRows = 700
    service.preparedCharts.trim()
    assert.equal(service.preparedCharts.series.size, 1)
    service.preparedCharts.maxRows = 100
    service.preparedCharts.trim()
    assert.equal(service.preparedCharts.series.size, 1, 'One oversized canonical series remains intact, never truncated.')
    assert.equal([...service.preparedCharts.series.values()][0].rows.size, 400)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an in-flight canonical series remains protected while another market finishes preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const end = (Math.floor(Date.now() / (100 * step)) - 2) * 100 * step + 99 * step
  const source = Array.from({ length: 400 }, (_, index) => candle(end - (399 - index) * step, index, '5m'))
  const secondId = 'ETH-USDT-SWAP'
  const releases: Array<() => void> = []
  let released = false
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input)), begin = Number(url.searchParams.get('begin')), stop = Number(url.searchParams.get('end'))
    if (!released) await new Promise<void>(resolve => releases.push(resolve))
    return response(source.filter(row => row.timestamp > begin && row.timestamp < stop).map(row => url.pathname.endsWith('/open-interest-history') ? [String(row.timestamp), '1000'] : [String(row.timestamp), '20', '30']))
  }, false)
  try {
    await store.appendCandles([...source.map(row => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null })), ...source.map(row => ({ ...row, instrument: secondId }))])
    service.preparedCharts.maxSeries = 1
    const pending = service.prepareChartWindow(instId, '5m', end)
    await waitFor(() => releases.length === 2)
    await service.prepareChartWindow(secondId, '5m', end)
    assert.equal(service.preparedCharts.series.has(`${instId}:5m`), true)
    assert.ok(service.preparedCharts.series.get(`${instId}:5m`).active > 0)
    released = true; releases.splice(0).forEach(release => release())
    await pending
    assert.equal(service.preparedCharts.series.size, 1)
  } finally { released = true; releases.splice(0).forEach(release => release()); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
