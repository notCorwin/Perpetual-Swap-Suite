import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { barsWithIndicators } from '../electron/services/indicators.js'
import { PreparedChartStore } from './chart-series-store.ts'

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
    assert.equal(calls, 0, 'A proven local listing boundary never waits for a latest HTTP request.')
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

test('the entire navigation universe prepares locally before remote warmup and survives canonical LRU eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-universe-'))
  const store = await MarketStore.open(root)
  const ids = Array.from({ length: 12 }, (_, index) => `LOCAL${index}-USDT-SWAP`)
  const first = Date.UTC(2024, 0, 1)
  const frames = new Map<string, any>()
  let calls = 0, readyAtFirstRequest = -1
  const service = new MarketService(store, undefined, async (_input, init) => {
    calls += 1
    readyAtFirstRequest = frames.size
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  }, false)
  const unsubscribe = service.subscribePreparedCharts(frame => { frames.set(frame.instId, frame) })
  try {
    for (const id of ids) await store.appendCandles(Array.from({ length: 400 }, (_, index) => ({ ...candle(first + index * hour, index), instrument: id })))
    assert.deepEqual(await service.setChartUniverse(ids, '1H', ids.at(-1)), { frames: [] })
    await waitFor(() => frames.size === ids.length && calls > 0)
    assert.equal(readyAtFirstRequest, ids.length, 'Every local candidate must finish before the first warm HTTP request starts.')
    assert.ok(service.preparedCharts.series.size <= 8)
    const calculations = service.preparedCharts.nextCalculation
    const coldId = ids.find(id => !service.preparedCharts.series.has(`${id}:1H`))!
    assert.ok(coldId)
    assert.equal(await service.localChartWindow(coldId, '1H'), frames.get(coldId))
    assert.equal(service.preparedCharts.nextCalculation, calculations, 'A compact selection never reloads an evicted canonical series.')
    const latest = await service.prepareChartWindow(coldId, '1H')
    assert.equal(latest.endHour, first + 399 * hour)
    assert.equal(latest.latestEnd, latest.endHour)
    assert.equal(latest.bars.length, 96)
    assert.equal(calls, 1, 'A pending freshness request cannot block or duplicate selection work.')
  } finally { unsubscribe(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('durable latest snapshots restart without full-series reads or calculations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-restart-'))
  let store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let service = new MarketService(store, undefined, async () => { throw new Error('Local snapshots never fetch.') }, false)
  try {
    await store.appendCandles(source)
    const state = service.preparedCharts.state(instId, '1H')
    state.live = { ...candle(first + 400 * hour, 400), confirmed: false }
    state.liveVersion += 1
    const original = await service.localChartWindow(instId, '1H')
    assert.equal(original?.bars.length, 96)
    assert.equal(original?.liveBar?.confirmed, false)
    const disk = await store.readChartSnapshot(instId, '1H') as any
    assert.equal('liveBar' in disk.frame, false)
    assert.ok(disk.frame.bars.every((bar: any) => bar.confirmed))
    assert.equal(disk.watermark, await store.candleWatermark(instId, '1H'))
    await service.dispose(); await store.close()
    store = await MarketStore.open(root)
    service = new MarketService(store, undefined, async () => { throw new Error('Snapshot restoration never fetches.') }, false)
    store.candles = async () => { throw new Error('A valid snapshot must not decompress the complete native series.') }
    const restored = await service.localChartWindow(instId, '1H')
    assert.deepEqual(restored?.bars, JSON.parse(JSON.stringify(original?.bars)))
    assert.equal(restored?.liveBar, undefined)
    assert.equal(service.preparedCharts.nextCalculation, 0)
    assert.equal(service.preparedCharts.series.size, 0)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a source correction invalidates a durable snapshot even when its previous process never rebuilt it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-correction-'))
  let store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let service = new MarketService(store, undefined, async () => { throw new Error('A complete corrected series stays local.') }, false)
  try {
    await store.appendCandles(source)
    const original = await service.localChartWindow(instId, '1H')
    await service.dispose()
    const corrected = { ...source[250], close: 120, high: 122 }
    source[250] = corrected
    await store.appendCandles([corrected])
    await store.close()
    store = await MarketStore.open(root)
    service = new MarketService(store, undefined, async () => { throw new Error('A correction must not fetch.') }, false)
    const rebuilt = await service.localChartWindow(instId, '1H')
    const expected = barsWithIndicators(source, hour).slice(-96)
    assert.equal(service.preparedCharts.nextCalculation, 1)
    assert.notEqual(rebuilt?.bars.at(-1)?.ema, original?.bars.at(-1)?.ema)
    assert.equal(rebuilt?.bars.at(-1)?.ema, expected.at(-1)?.ema)
    assert.equal((await store.readChartSnapshot(instId, '1H') as any).watermark, await store.candleWatermark(instId, '1H'))
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a partially observed new tail retains the complete latest pointer until one atomic ready publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-tail-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const service = new MarketService(store, undefined, async () => { throw new Error('Source writes already supply this fixture.') }, false)
  const published: any[] = []
  const unsubscribe = service.subscribePreparedCharts(frame => { published.push(frame) })
  try {
    await store.appendCandles(source)
    const original = await service.localChartWindow(instId, '1H')
    const next = { ...candle(first + 400 * hour, 400), oi: null, buy: null, sell: null, statisticsVersion: null }
    await service.persistCandles(instId, [next], { projectList: false })
    const retained = await service.localChartWindow(instId, '1H')
    assert.equal(retained?.endHour, original?.endHour)
    assert.equal(retained?.latestEnd, original?.endHour)
    assert.equal(retained?.generation, original?.generation)
    const range = { from: next.timestamp, through: next.timestamp, intervalMS: hour }
    await service.persistStatisticsSource({ instId }, '1H', next.timestamp, 1, [[String(next.timestamp), '1234']], undefined, 'statistics', false, { range, projectList: false })
    await service.persistStatisticsSource({ instId }, '1H', next.timestamp, 2, [[String(next.timestamp), '20', '30']], undefined, 'statistics', false, { range, projectList: false })
    await waitFor(() => published.some(frame => frame.endHour === next.timestamp))
    const complete = await service.localChartWindow(instId, '1H')
    assert.equal(complete?.latestEnd, next.timestamp)
    assert.equal(complete?.generation, original?.generation)
    assert.equal(complete?.bars.length, 96)
    assert.ok(complete?.bars.every(bar => bar.statisticsObserved && bar.indicatorsObserved))
    assert.equal(complete?.bars.at(-1)?.ema, barsWithIndicators([...source, next], hour).at(-1)?.ema)
  } finally { unsubscribe(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('durable source-unavailable snapshots expire with their observation leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-expiry-'))
  let store = await MarketStore.open(root)
  const originalNow = Date.now
  let now = originalNow()
  const first = Math.floor(now / hour) * hour - 400 * hour
  const expiresAt = now + 60_000
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(first + index * hour, index), ...(index === 399 ? { oi: null, buy: null, sell: null, statisticsVersion: 7, statisticsOIExpiresAt: expiresAt, statisticsTakerExpiresAt: expiresAt } : {}) }))
  let calls = 0
  let service = new MarketService(store, undefined, async () => { calls += 1; throw new Error('A local read never fetches.') }, false)
  try {
    Date.now = () => now
    await store.appendCandles(source)
    const initial = await service.localChartWindow(instId, '1H')
    assert.equal(initial?.oiState, 'unavailable')
    assert.equal((await store.readChartSnapshot(instId, '1H') as any).validUntil, expiresAt)
    await service.dispose(); await store.close()
    now = expiresAt + 1
    store = await MarketStore.open(root)
    service = new MarketService(store, undefined, async () => { calls += 1; throw new Error('An expired local observation never triggers HTTP itself.') }, false)
    const current = await service.localChartWindow(instId, '1H')
    assert.equal(current?.endHour, first + 398 * hour, 'An expired null lease cannot remain the latest ready observation forever.')
    assert.equal(current?.oiState, 'ready')
    assert.equal(calls, 0)
  } finally { Date.now = originalNow; await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('compact and historical generations stay coherent after full-series eviction and an older source expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-generation-'))
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
    await store.appendCandles(source.slice(-400))
    const initial = await service.localChartWindow(instId, '1H')
    assert.ok(initial)
    const renderer = new PreparedChartStore()
    renderer.ingest(initial)
    service.preparedCharts.maxSeries = 1
    const other = 'OTHER-USDT-SWAP'
    await store.appendCandles(source.slice(-400).map(row => ({ ...row, instrument: other })))
    await service.localChartWindow(other, '1H')
    assert.equal(service.preparedCharts.series.has(`${instId}:1H`), false)
    const sameInput = await service.prepareChartWindow(instId, '1H', source.at(-1)!.timestamp)
    assert.equal(sameInput.generation, initial.generation)
    renderer.ingest(sameInput)
    assert.ok(renderer.window(instId, '1H'), 'An unchanged canonical reload must preserve the compact latest generation.')

    const expanded = await service.prepareChartWindow(instId, '1H', source[650].timestamp)
    assert.ok(expanded.generation > initial.generation)
    renderer.ingest(expanded)
    const latest = await service.localChartWindow(instId, '1H')
    assert.ok(latest)
    assert.equal(latest.generation, expanded.generation)
    renderer.ingest(latest)
    assert.equal(renderer.window(instId, '1H')?.endHour, latest.endHour)
    const persisted = await store.candles({ instrument: instId, timeframe: '1H' })
    assert.equal(latest.bars.at(-1)?.ema, barsWithIndicators(persisted, hour).at(-1)?.ema)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('an expired latest null lease keeps its in-memory close while independent refresh replaces the observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-monotonic-'))
  const store = await MarketStore.open(root)
  const originalNow = Date.now
  let now = originalNow()
  const first = Math.floor(now / hour) * hour - 400 * hour
  const expiresAt = now + 60_000
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(first + index * hour, index), ...(index === 399 ? { oi: null, buy: null, sell: null, statisticsVersion: 7, statisticsOIExpiresAt: expiresAt, statisticsTakerExpiresAt: expiresAt } : {}) }))
  let statisticsCalls = 0
  const published: any[] = []
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/market/candles')) return response(source.slice(-300).reverse().map(row => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), String(row.volume), '0', String(row.quoteVolume), '1']))
    statisticsCalls += 1
    const begin = Number(url.searchParams.get('begin')), end = Number(url.searchParams.get('end'))
    return response(source.filter(row => row.timestamp > begin && row.timestamp < end).map(row => url.pathname.endsWith('/open-interest-history') ? [String(row.timestamp), '1234'] : [String(row.timestamp), '20', '30']))
  }, false)
  const unsubscribe = service.subscribePreparedCharts(frame => { published.push(frame) })
  try {
    Date.now = () => now
    await store.appendCandles(source)
    const original = await service.localChartWindow(instId, '1H')
    now = expiresAt + 1
    const retained = await service.localChartWindow(instId, '1H')
    assert.equal(retained, original)
    assert.equal(statisticsCalls, 0, 'The local path remains independent of HTTP.')
    const disk = await store.readChartSnapshot(instId, '1H') as any
    assert.equal(disk.frame.endHour, original?.endHour)
    assert.equal(disk.validUntil, expiresAt, 'Holding a visible frame must not silently renew a source lease.')
    await service.setChartUniverse([instId], '1H', instId)
    await waitFor(() => published.some(frame => frame.endHour === original?.endHour && frame.oiState === 'ready' && frame.takerState === 'ready'))
    const refreshed = await service.localChartWindow(instId, '1H')
    assert.equal(refreshed?.generation, original?.generation)
    assert.equal(refreshed?.latestEnd, original?.latestEnd)
    assert.equal(refreshed?.bars.at(-1)?.oi, 1_234)
    assert.equal(statisticsCalls, 2)
    assert.equal((await store.readChartSnapshot(instId, '1H') as any).validUntil, null)
  } finally { Date.now = originalNow; unsubscribe(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

for (const mutation of ['price', 'statistics'] as const) test(`latest preparation never certifies a prior frame after an intervening ${mutation} write`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-certification-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(first + index * hour, index), oi: null, buy: null, sell: null, statisticsVersion: null }))
  const service = new MarketService(store, undefined, async input => {
    const url = new URL(String(input))
    assert.ok(url.pathname.endsWith('/market/candles'))
    return response(source.slice(-300).reverse().map(row => [String(row.timestamp), String(row.open), String(row.high), String(row.low), String(row.close), String(row.volume), '0', String(row.quoteVolume), '1']))
  }, false)
  const pipeline = service.preparedCharts
  const originalPrepare = pipeline.prepareState.bind(pipeline)
  const originalWrite = store.writeChartSnapshot.bind(store)
  let mutated = false, mutationWatermark = 0
  const certified: any[] = []
  store.writeChartSnapshot = async (instrument, timeframe, snapshot) => {
    certified.push(snapshot)
    await originalWrite(instrument, timeframe, snapshot)
  }
  pipeline.prepareState = async (...args: any[]) => {
    const frame = await originalPrepare(...args)
    if (!mutated) {
      mutated = true
      if (mutation === 'price') {
        source[250] = { ...source[250], close: 120, high: 122 }
        await service.persistCandles(instId, [source[250]], { projectList: false })
      } else {
        const end = source.at(-1)!.timestamp
        await service.persistStatisticsSource({ instId }, '1H', end, 1, [[String(end), '9999']], undefined, 'statistics', false, { range: { from: end, through: end, intervalMS: hour }, projectList: false })
      }
      mutationWatermark = await store.candleWatermark(instId, '1H')
    }
    return frame
  }
  try {
    await store.appendCandles(source)
    const prepared = await service.prepareChartWindow(instId, '1H')
    const expectedEMA = barsWithIndicators(source, hour).at(-1)?.ema
    assert.ok(mutated)
    assert.ok(certified.length > 0)
    for (const snapshot of certified.filter(value => value.watermark >= mutationWatermark)) {
      if (mutation === 'price') assert.equal(snapshot.frame.bars.at(-1).ema, expectedEMA, 'An old EMA must never be paired with a corrected source watermark.')
      else assert.equal(snapshot.frame.bars.at(-1).oi, 9_999, 'Statistics-only writes also invalidate a frame awaiting certification.')
    }
    if (mutation === 'price') assert.equal(prepared.bars.at(-1)?.ema, expectedEMA)
    else assert.equal(prepared.bars.at(-1)?.oi, 9_999)
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('shutdown settles a preparation that reaches worker admission after its source read completes', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-switch-shutdown-'))
  const store = await MarketStore.open(root)
  const first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const service = new MarketService(store, undefined, async () => { throw new Error('The shutdown fixture is fully local.') }, false)
  const pipeline = service.preparedCharts
  const originalStatistics = pipeline.ensureStatistics.bind(pipeline)
  let reachedSourceRead = false, release = () => {}
  const released = new Promise<void>(resolve => { release = resolve })
  pipeline.ensureStatistics = async (...args: any[]) => {
    await originalStatistics(...args)
    reachedSourceRead = true
    await released
  }
  try {
    await store.appendCandles(source)
    const pending = service.prepareChartWindow(instId, '1H', source.at(-1)!.timestamp)
    const rejected = assert.rejects(pending, /closed/)
    await waitFor(() => reachedSourceRead)
    const disposed = service.dispose()
    assert.equal(pipeline.closed, true)
    release()
    await Promise.all([disposed, rejected])
    assert.equal(pipeline.worker, null)
    assert.equal(pipeline.nextCalculation, 0)
    assert.equal(pipeline.calculations.size, 0)
    assert.equal(pipeline.calculationQueue.length, 0)
  } finally { release(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
