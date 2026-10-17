import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { barsWithIndicators } from '../electron/services/indicators.js'
import { PreparedChartStore } from './chart-series-store.ts'

const hour = 3_600_000
const step = 300_000
const instId = 'BTC-USDT-SWAP'
const candle = (timestamp: number, index: number, timeframe = '1H', instrument = instId) => ({ instrument, timeframe, timestamp,
  open: 100 + Math.sin(index / 9), high: 102 + Math.sin(index / 9) + index / 1_000, low: 98 + Math.sin(index / 9),
  close: 100 + Math.sin(index / 9) + index / 1_000, volume: 10 + index / 100, baseVolume: 10 + index / 100, quoteVolume: 1_000 + index,
  oi: 10_000 + index, buy: 40 + index, sell: 20 + index, statisticsVersion: 1, confirmed: true })
const normalize = (row: any) => ({ ...row, oi: row.oi ?? null, buy: row.buy ?? null, sell: row.sell ?? null })
const visible = (frame: any, end = frame.endHour, interval = frame.intervalMS) => frame.bars.filter((bar: any) => bar.hour >= end - 95 * interval && bar.hour <= end)
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 300; i += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Timed out waiting for prepared data.')
}
const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const missingStatistics = (row: any) => ({ ...row, oi: null, buy: null, sell: null, statisticsVersion: null })
const cachedHistory = () => ({
  async ensurePrices() { throw new Error('Complete cached prices must not request a history task.') },
  async ensureStatistics() { throw new Error('Complete cached statistics must not request a history task.') },
  async latest() { return {} },
})
const createPipeline = (store: any, history: any = cachedHistory(), instruments = new Map<string, any>()): any => new PreparedChartPipeline({
  store, history, normalize, revision: () => 0, instrument: (id: string) => instruments.get(id),
})
const fixture = async (history?: any) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-prepared-chart-'))
  const store = await MarketStore.open(root)
  const instruments = new Map<string, any>()
  const pipeline = createPipeline(store, history ?? cachedHistory(), instruments)
  const persist = async (rows: any[]) => {
    if (!rows.length) return
    const previous = new Map((await store.candles({ instrument: rows[0].instrument, timeframe: rows[0].timeframe })).map(row => [row.timestamp, row]))
    await store.appendCandles(rows)
    pipeline.observe(rows, previous)
  }
  const close = async () => { await pipeline.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { root, store, pipeline, instruments, persist, close }
}

test('canonical windows and list projections share full-history math; statistics never reseed recursive indicators', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1)
  let source = Array.from({ length: 2_048 }, (_, index) => candle(first + index * hour, index))
  try {
    await f.store.appendCandles(source)
    const end = source.at(-1)!.timestamp - 200 * hour
    const original = await f.pipeline.prepare(instId, '1H', end)
    assert.equal(visible(original).length, 96)
    assert.ok(original.bars.length <= 200)
    const oracle = new Map(barsWithIndicators(source, hour).map((bar: any) => [bar.hour, bar]))
    for (const bar of visible(original)) for (const key of ['ema', 'rsi6', 'rsi12', 'rsi24', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc']) assert.equal(bar[key], (oracle.get(bar.hour) as any)[key])
    const projected = await f.pipeline.projectSeries(instId, '1H')
    assert.equal(projected.bars.find((bar: any) => bar.hour === end)?.ema, visible(original).at(-1).ema)
    const calculations = f.pipeline.nextCalculation
    await f.pipeline.prepare(instId, '1H', end - 101 * hour)
    const patchedRows = source.filter(row => row.timestamp >= end - 95 * hour && row.timestamp <= end).map(row => ({ ...row, oi: 90_000 }))
    await f.persist(patchedRows)
    const patched = await f.pipeline.prepare(instId, '1H', end)
    assert.equal(patched.generation, original.generation)
    assert.equal(f.pipeline.nextCalculation, calculations)
    assert.ok(visible(patched).every((bar: any) => bar.oi === 90_000))
    source[1_000] = { ...source[1_000], close: 110, high: 112 }
    await f.persist([source[1_000]])
    const corrected = await f.pipeline.prepare(instId, '1H', end)
    assert.ok(corrected.generation > original.generation)
    assert.equal(visible(corrected).at(-1).ema, barsWithIndicators(source, hour).find((bar: any) => bar.hour === end)?.ema)
    await f.persist([candle(source.at(-1)!.timestamp + hour, 2_048)])
    const appended = await f.pipeline.prepare(instId, '1H', end)
    assert.equal(appended.generation, corrected.generation)
    assert.equal(visible(appended).at(-1).ema, visible(corrected).at(-1).ema)
  } finally { await f.close() }
})

test('history tasks commit missing prices once and the pipeline reloads durable rows without an observe callback', async () => {
  const first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const release = deferred(), calls: any[] = []
  const f = await fixture()
  f.pipeline.history = { ...cachedHistory(), async ensurePrices(...args: any[]) {
    calls.push(args); await release.promise
    await f.store.appendCandles(source.filter(row => row.timestamp >= args[2] && row.timestamp <= args[3]))
    return { rows: source }
  } }
  try {
    await f.store.appendCandles(source.slice(-100))
    const end = source.at(-1)!.timestamp
    const pending = f.pipeline.prepare(instId, '1H', end)
    await waitFor(() => calls.length === 1)
    const duplicate = f.pipeline.prepare(instId, '1H', end)
    release.resolve()
    const frames = await Promise.all([pending, duplicate])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], [instId, '1H', end - 294 * hour, end, 'foreground'])
    for (const frame of frames) assert.equal(visible(frame).length, 96)
    assert.equal(frames[0].oldestHour, null, 'A resident cache edge is never a provider floor.')
    await f.pipeline.prepare(instId, '1H', end)
    assert.equal(calls.length, 1)
    const durable = await f.store.candles({ instrument: instId, timeframe: '1H' })
    assert.equal(visible(frames[0]).at(-1).ema, barsWithIndicators(durable, hour).at(-1)?.ema)
  } finally { release.resolve(); await f.close() }
})

test('concurrent statistics requests share a task and publish only committed observations', async () => {
  const first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * step, index, '5m'))
  const release = deferred(), calls: any[] = []
  const f = await fixture()
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics(...args: any[]) {
    calls.push(args); await release.promise
    await f.store.appendCandles(source.filter(row => row.timestamp >= args[2] && row.timestamp <= args[3]).map(row => ({ ...row, oi: 1_234, buy: 30, sell: 20 })))
  } }
  try {
    await f.store.appendCandles(source.map(missingStatistics))
    const end = source.at(-1)!.timestamp
    const pending = f.pipeline.prepare(instId, '5m', end)
    await waitFor(() => calls.length === 1)
    const duplicate = f.pipeline.prepare(instId, '5m', end)
    assert.equal((await f.store.candles({ instrument: instId, timeframe: '5m' })).at(-1)?.oi, null)
    release.resolve()
    const frames = await Promise.all([pending, duplicate])
    assert.deepEqual(calls, [[instId, '5m', end - 95 * step, end, 'foreground']])
    for (const frame of frames) assert.ok(visible(frame).every((bar: any) => bar.statisticsSources === 3 && bar.statisticsObserved && bar.oi === 1_234 && bar.buy === 30 && bar.sell === 20))
    const older = await f.store.candles({ instrument: instId, timeframe: '5m', through: end - 96 * step })
    assert.ok(older.every(row => !row.statisticsVersion), 'Unrequested observations stay unknown.')
  } finally { release.resolve(); await f.close() }
})

test('transport failures leave statistics unknown; successful empty observations carry truthful leases', async () => {
  const first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => missingStatistics(candle(first + index * hour, index)))
  let fail = true
  const f = await fixture()
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics(_id: string, _tf: string, from: number, through: number) {
    if (fail) throw new Error('503')
    await f.store.appendCandles(source.filter(row => row.timestamp >= from && row.timestamp <= through).map(row => ({ ...row, statisticsVersion: 11, statisticsOIExpiresAt: Date.now() + 60_000, statisticsTakerExpiresAt: Date.now() + 60_000 })))
  } }
  try {
    await f.store.appendCandles(source)
    const end = source.at(-1)!.timestamp
    await assert.rejects(f.pipeline.prepare(instId, '1H', end), /503/)
    assert.ok((await f.store.candles({ instrument: instId, timeframe: '1H' })).every(row => !row.statisticsVersion))
    fail = false
    const frame = await f.pipeline.prepare(instId, '1H', end)
    assert.equal(frame.oiState, 'unavailable'); assert.equal(frame.takerState, 'unavailable')
    assert.ok(visible(frame).every((bar: any) => bar.statisticsObserved && bar.oi === null && bar.buy === null && bar.sell === null))
  } finally { await f.close() }
})

test('a cached complete 96-window never waits for observations outside its range', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1)
  const source = Array.from({ length: 400 }, (_, index) => index >= 300 && index < 304 ? missingStatistics(candle(first + index * hour, index)) : candle(first + index * hour, index))
  try {
    await f.store.appendCandles(source)
    const frame = await f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp)
    assert.equal(visible(frame).length, 96)
    assert.equal(frame.oiState, 'ready'); assert.equal(frame.takerState, 'ready')
  } finally { await f.close() }
})

test('listing metadata clamps history and preserves truthful undefined warmup indicators', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1)
  try {
    await f.store.appendCandles(Array.from({ length: 120 }, (_, index) => candle(first + index * hour, index)))
    f.instruments.set(instId, { listTime: String(first + 1_000) })
    const frame = await f.pipeline.prepare(instId, '1H', first - 500 * hour)
    assert.equal(frame.oldestHour, first); assert.equal(frame.endHour, first + 95 * hour)
    assert.equal(frame.historyExhausted, true); assert.equal(frame.indicatorState, 'unavailable')
    assert.ok(visible(frame).every((bar: any) => bar.ema === null && bar.indicatorsObserved && bar.statisticsObserved))
  } finally { await f.close() }
})

for (const count of [0, 20]) test(`a new listing with ${count} completed candles never requests nonexistent future history`, async () => {
  const f = await fixture(), first = Math.floor(Date.now() / step) * step - count * step
  f.pipeline.history.latest = async () => { throw new Error('Listing metadata already proves insufficient history.') }
  try {
    await f.store.appendCandles(Array.from({ length: count }, (_, index) => candle(first + index * step, index, '5m')))
    f.instruments.set(instId, { listTime: String(first + 1) })
    const frame = await f.pipeline.prepare(instId, '5m')
    assert.deepEqual(frame.bars, []); assert.equal(frame.endHour, null)
    assert.deepEqual(frame.unavailable, { reason: 'insufficient-history', availableCandles: count, requiredCandles: 96, retryAt: first + 96 * step + 1_000 })
  } finally { await f.close() }
})

test('only a history task proven provider floor restricts navigation', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 900 }, (_, index) => candle(first + index * hour, index))
  f.pipeline.history = { ...cachedHistory(), async ensurePrices() { await f.store.appendCandles(source); return { floor: first } } }
  try {
    await f.store.appendCandles(source.slice(-100))
    const frame = await f.pipeline.prepare(instId, '1H', first - 500 * hour)
    assert.equal(frame.oldestHour, first); assert.equal(frame.endHour, first + 95 * hour)
    assert.equal(frame.historyExhausted, true); assert.equal(frame.indicatorState, 'unavailable')
  } finally { await f.close() }
})

test('LRU eviction keeps full series intact and a reload reproduces every recursive indicator', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const ids = Array.from({ length: 9 }, (_, index) => `MARKET${index}-USDT-SWAP`)
  try {
    await f.store.appendCandles(ids.flatMap(instrument => source.map(row => ({ ...row, instrument }))))
    let original: any
    for (const id of ids) { const frame = await f.pipeline.prepare(id, '1H', source.at(-1)!.timestamp); if (id === ids[0]) original = frame; assert.ok(f.pipeline.series.size <= 8) }
    assert.equal(f.pipeline.series.has(`${ids[0]}:1H`), false)
    const reloaded = await f.pipeline.prepare(ids[0], '1H', source.at(-1)!.timestamp)
    assert.ok(reloaded.generation > original.generation)
    for (let i = 0; i < 96; i += 1) for (const field of ['ema', 'rsi6', 'rsi12', 'rsi24', 'vwap', 'bollUpper']) assert.equal(visible(reloaded)[i][field], visible(original)[i][field])
    f.pipeline.maxRows = 100; f.pipeline.trim()
    assert.equal(f.pipeline.series.size, 1)
    assert.equal([...f.pipeline.series.values()][0].rows.size, 400, 'An oversized canonical series is never truncated.')
  } finally { await f.close() }
})

test('active canonical series cannot be evicted while awaiting a source task', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const release = deferred(); let requested = false
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics() { requested = true; await release.promise; await f.store.appendCandles(source) } }
  try {
    await f.store.appendCandles([...source.map(missingStatistics), ...source.map(row => ({ ...row, instrument: 'ETH-USDT-SWAP' }))])
    f.pipeline.maxSeries = 1
    const pending = f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp)
    await waitFor(() => requested)
    await f.pipeline.prepare('ETH-USDT-SWAP', '1H', source.at(-1)!.timestamp)
    assert.ok(f.pipeline.series.get(`${instId}:1H`).active > 0)
    release.resolve(); await pending
    assert.equal(f.pipeline.series.size, 1)
  } finally { release.resolve(); await f.close() }
})

test('the whole chart universe prepares local frames before source refresh and survives canonical eviction', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), ids = Array.from({ length: 12 }, (_, index) => `LOCAL${index}-USDT-SWAP`)
  const frames = new Map<string, any>(), release = deferred(); let readyAtRequest = -1
  f.pipeline.history.latest = async () => { readyAtRequest = frames.size; await release.promise; return {} }
  const unsubscribe = f.pipeline.subscribe((frame: any) => { frames.set(frame.instId, frame) })
  try {
    await f.store.appendCandles(ids.flatMap(id => Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index, '1H', id))))
    assert.deepEqual(f.pipeline.setUniverse(ids, '1H', ids.at(-1)), { frames: [] })
    await waitFor(() => frames.size === ids.length && readyAtRequest >= 0)
    assert.equal(readyAtRequest, ids.length)
    const cold = ids.find(id => !f.pipeline.series.has(`${id}:1H`))!, calculations = f.pipeline.nextCalculation
    assert.equal(await f.pipeline.local(cold, '1H'), frames.get(cold))
    assert.equal(f.pipeline.nextCalculation, calculations)
  } finally { unsubscribe(); release.resolve(); await f.close() }
})

test('durable snapshots restart without a full-series read and never restore forming candles', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let restarted: any
  try {
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H')
    const watermark = await f.store.candleWatermark(instId, '1H')
    let snapshotWrites = 0
    const writeSnapshot = f.store.writeChartSnapshot.bind(f.store)
    f.store.writeChartSnapshot = async (...args: any[]) => { snapshotWrites += 1; return writeSnapshot(args[0], args[1], args[2]) }
    const live = { ...candle(first + 400 * hour, 400), confirmed: false }
    const projected = await f.pipeline.setLive(instId, '1H', live)
    assert.equal(projected.liveBar.confirmed, false); assert.equal(projected.liveBar.close, live.close)
    assert.equal(snapshotWrites, 0, 'Forming updates never rewrite durable snapshots.')
    assert.equal(await f.store.candleWatermark(instId, '1H'), watermark)
    assert.equal((await f.store.candles({ instrument: instId, timeframe: '1H' })).length, 400)
    const disk = await f.store.readChartSnapshot(instId, '1H') as any
    assert.equal('liveBar' in disk.frame, false)
    await f.pipeline.dispose()
    restarted = createPipeline(f.store)
    f.store.candles = async () => { throw new Error('A valid snapshot must not decompress its complete native series.') }
    const restored = await restarted.local(instId, '1H')
    assert.deepEqual(restored.bars, JSON.parse(JSON.stringify(original.bars)))
    assert.equal(restored.liveBar, undefined); assert.equal(restarted.nextCalculation, 0); assert.equal(restarted.series.size, 0)
  } finally { await restarted?.dispose(); await f.close() }
})

test('live projections emit current math and confirmation clears live only after its durable write', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const emitted: any[] = []; f.pipeline.subscribe((frame: any) => emitted.push(frame))
  try {
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H')
    const live = { ...candle(first + 400 * hour, 400), confirmed: false }
    await f.pipeline.setLive(instId, '1H', live)
    const revised = { ...live, close: 101, high: 103 }
    const projected = await f.pipeline.setLive(instId, '1H', revised)
    assert.equal(projected.generation, original.generation)
    assert.equal(projected.liveBar.ema, barsWithIndicators([...source, revised], hour).at(-1)?.ema)
    assert.equal(emitted.at(-1).liveBar.close, 101)
    const confirmed = { ...revised, confirmed: true }
    await f.persist([confirmed])
    const final = await f.pipeline.local(instId, '1H', { force: true })
    assert.equal(final.endHour, confirmed.timestamp); assert.equal(final.liveBar, undefined)
    assert.equal(final.bars.at(-1).close, confirmed.close)
    assert.equal((await f.store.candles({ instrument: instId, timeframe: '1H' })).at(-1)?.confirmed, true)
  } finally { await f.close() }
})

test('source corrections on disk invalidate snapshots across restarts', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let restarted: any
  try {
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H')
    await f.pipeline.dispose()
    source[250] = { ...source[250], close: 120, high: 122 }
    await f.store.appendCandles([source[250]])
    restarted = createPipeline(f.store)
    const corrected = await restarted.local(instId, '1H')
    assert.equal(restarted.nextCalculation, 1)
    assert.notEqual(corrected.bars.at(-1).ema, original.bars.at(-1).ema)
    assert.equal(corrected.bars.at(-1).ema, barsWithIndicators(source, hour).at(-1)?.ema)
  } finally { await restarted?.dispose(); await f.close() }
})

test('partial tails retain the complete latest pointer until both statistics sources are durable', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  try {
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H'), next = missingStatistics(candle(first + 400 * hour, 400))
    await f.persist([next])
    const retained = await f.pipeline.local(instId, '1H', { force: true })
    assert.equal(retained.endHour, original.endHour); assert.equal(retained.generation, original.generation)
    await f.persist([{ ...next, oi: 1_234, statisticsVersion: 5 }])
    assert.equal((await f.pipeline.local(instId, '1H', { force: true })).endHour, original.endHour)
    await f.persist([{ ...next, oi: 1_234, buy: 30, sell: 20, statisticsVersion: 1 }])
    const complete = await f.pipeline.local(instId, '1H', { force: true })
    assert.equal(complete.endHour, next.timestamp); assert.equal(complete.generation, original.generation)
    assert.equal(complete.bars.at(-1).ema, barsWithIndicators([...source, next], hour).at(-1)?.ema)
  } finally { await f.close() }
})

test('expired null leases retain an in-memory close without renewing the durable lease until source refresh', async () => {
  const f = await fixture(), originalNow = Date.now; let now = originalNow()
  const first = Math.floor(now / hour) * hour - 400 * hour, expiresAt = now + 60_000
  const source = Array.from({ length: 400 }, (_, index) => ({ ...candle(first + index * hour, index), ...(index === 399 ? { oi: null, buy: null, sell: null, statisticsVersion: 11, statisticsOIExpiresAt: expiresAt, statisticsTakerExpiresAt: expiresAt } : {}) }))
  let calls = 0
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics(_id: string, _tf: string, from: number, through: number) { calls += 1; await f.persist(source.filter(row => row.timestamp >= from && row.timestamp <= through).map(row => ({ ...row, oi: 1_234, buy: 30, sell: 20, statisticsVersion: 1 }))) } }
  try {
    Date.now = () => now
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H')
    now = expiresAt + 1
    assert.equal(await f.pipeline.local(instId, '1H'), original)
    assert.equal((await f.store.readChartSnapshot(instId, '1H') as any).validUntil, expiresAt)
    assert.equal(calls, 0)
    f.pipeline.setUniverse([instId], '1H', instId)
    await waitFor(() => f.pipeline.cached(`${instId}:1H`)?.oiState === 'ready')
    const refreshed = await f.pipeline.local(instId, '1H')
    assert.equal(refreshed.endHour, original.endHour); assert.equal(refreshed.generation, original.generation)
    assert.equal(refreshed.bars.at(-1).oi, 1_234); assert.equal(calls, 1)
    assert.equal((await f.store.readChartSnapshot(instId, '1H') as any).validUntil, null)
  } finally { Date.now = originalNow; await f.close() }
})

for (const mutation of ['price', 'statistics']) test(`an intervening ${mutation} write cannot certify a stale latest frame`, async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const prepare = f.pipeline.prepareState.bind(f.pipeline), certified: any[] = []
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics(_id: string, _tf: string, from: number, through: number) { await f.persist(source.filter(row => row.timestamp >= from && row.timestamp <= through)) } }
  let mutated = false
  const snapshotWrite = f.store.writeChartSnapshot.bind(f.store)
  f.store.writeChartSnapshot = async (...args: any[]) => { certified.push(args[2]); return snapshotWrite(args[0], args[1], args[2]) }
  f.pipeline.prepareState = async (...args: any[]) => {
    const frame = await prepare(...args)
    if (!mutated) {
      mutated = true
      if (mutation === 'price') { source[250] = { ...source[250], close: 120, high: 122 }; await f.persist([source[250]]) }
      else await f.persist([{ ...source.at(-1)!, oi: 9_999 }])
    }
    return frame
  }
  try {
    await f.store.appendCandles(source.map(missingStatistics))
    const frame = await f.pipeline.prepare(instId, '1H')
    assert.ok(mutated); assert.ok(certified.length)
    for (const snapshot of certified) {
      if (mutation === 'price') assert.equal(snapshot.frame.bars.at(-1).ema, barsWithIndicators(source, hour).at(-1)?.ema)
      else assert.equal(snapshot.frame.bars.at(-1).oi, 9_999)
    }
    assert.equal(frame.bars.length, 96)
  } finally { await f.close() }
})

test('replacement invalidation rejects old in-flight calculations and advances the renderer generation', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  const release = deferred(), renderer = new PreparedChartStore()
  try {
    await f.store.appendCandles(source)
    const original = await f.pipeline.local(instId, '1H'); renderer.ingest(original)
    const calculate = f.pipeline.calculate.bind(f.pipeline); let reached = false
    f.pipeline.calculate = async (...args: any[]) => { const bars = await calculate(...args); if (!reached) { reached = true; await release.promise }; return bars }
    source[250] = { ...source[250], close: 110, high: 112 }
    await f.persist([source[250]])
    const pending = f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp)
    await waitFor(() => reached)
    source[250] = { ...source[250], close: 120, high: 122 }
    await f.store.replaceCandles({ instrument: instId, timeframe: '1H', from: source[0].timestamp, through: source.at(-1)!.timestamp }, source)
    f.pipeline.invalidate(instId, '1H')
    assert.equal(f.pipeline.cached(`${instId}:1H`), null)
    release.resolve()
    const repaired = await pending
    assert.ok(repaired.generation > original.generation)
    assert.equal(visible(repaired).at(-1).ema, barsWithIndicators(source, hour).at(-1)?.ema)
    renderer.ingest(repaired)
    assert.ok(renderer.window(instId, '1H'))
  } finally { release.resolve(); await f.close() }
})

test('shutdown prevents worker admission after an outstanding source task resolves', { timeout: 5_000 }, async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => missingStatistics(candle(first + index * hour, index)))
  const release = deferred(); let requested = false
  f.pipeline.history = { ...cachedHistory(), async ensureStatistics() { requested = true; await release.promise } }
  try {
    await f.store.appendCandles(source)
    const pending = f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp)
    const rejected = assert.rejects(pending, /closed/)
    await waitFor(() => requested)
    const disposed = f.pipeline.dispose()
    release.resolve(); await Promise.all([disposed, rejected])
    assert.equal(f.pipeline.worker, null); assert.equal(f.pipeline.nextCalculation, 0)
    assert.equal(f.pipeline.calculations.size, 0); assert.equal(f.pipeline.calculationQueue.length, 0)
  } finally { release.resolve(); await f.close() }
})

test('a forming tick can build its first memory frame without writing a durable snapshot', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let writes = 0
  const writeSnapshot = f.store.writeChartSnapshot.bind(f.store)
  f.store.writeChartSnapshot = async (...args: any[]) => { writes += 1; return writeSnapshot(args[0], args[1], args[2]) }
  try {
    await f.store.appendCandles(source)
    const frame = await f.pipeline.setLive(instId, '1H', { ...candle(first + 400 * hour, 400), confirmed: false })
    assert.equal(frame.bars.length, 96); assert.equal(frame.liveBar.confirmed, false)
    assert.equal(writes, 0); assert.equal(await f.store.readChartSnapshot(instId, '1H'), null)
    assert.equal((await f.store.candles({ instrument: instId, timeframe: '1H' })).length, 400)
  } finally { await f.close() }
})

test('missing base-volume units in the warmup remain an explicit history gap until repaired', async () => {
  const f = await fixture(), first = Date.UTC(2024, 0, 1), source = Array.from({ length: 400 }, (_, index) => candle(first + index * hour, index))
  let repair = false, requests = 0
  f.pipeline.history = { ...cachedHistory(), async ensurePrices() { requests += 1; if (repair) await f.store.appendCandles([source[150]]) } }
  try {
    await f.store.appendCandles(source.map((row, index) => index === 150 ? { ...row, baseVolume: null } : row))
    await assert.rejects(f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp), /complete source candle coverage/)
    repair = true
    const frame = await f.pipeline.prepare(instId, '1H', source.at(-1)!.timestamp)
    assert.equal(requests, 2)
    assert.equal(visible(frame).at(-1).vwap, barsWithIndicators(source, hour).at(-1)?.vwap)
  } finally { await f.close() }
})
