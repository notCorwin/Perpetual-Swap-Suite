import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'

const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const step = 300000, instId = 'BTC-USDT-SWAP'
const instrument = (id = instId) => ({ instId: id, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: id.split('-')[0], ruleType: 'normal' })
const ticker = (price = 100) => ({ instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price), ts: String(Date.now()) })
const book = () => ({ asks: [['100', '200001']], bids: [['99.99', '200001']], ts: String(Date.now()) })
const candle = (timestamp: number, timeframe = '5m', close = 100) => ({ instrument: instId, timeframe, timestamp, open: 99, high: Math.max(101, close), low: 98, close, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 4000) => { const deadline = performance.now() + timeout; while (!await condition()) { assert.ok(performance.now() < deadline, 'Coordinator did not publish the required outcome.'); await new Promise(resolve => setTimeout(resolve, 2)) } }
const preferences = (...enabled: Array<keyof typeof DEFAULT_PREFERENCES.liquidity>) => {
  const value = structuredClone(DEFAULT_PREFERENCES)
  for (const criterion of Object.values(value.liquidity)) criterion.enabled = false
  for (const key of enabled) value.liquidity[key].enabled = true
  return value
}
const nativeResponse = async (input: string | URL | Request) => {
  const url = new URL(String(input)), parameters = url.searchParams, path = url.pathname
  if (path.endsWith('/market/books')) return response([book()])
  if (path.endsWith('/public/open-interest')) return response([{ instId, oiUsd: '6000000' }])
  if (path.includes('/market/') && (path.endsWith('/candles') || path.endsWith('/history-candles'))) {
    const frame = parameters.get('bar')!, interval = frame === '5m' ? step : frame === '15m' ? 900000 : 3600000
    const end = Number(parameters.get('after') ?? Math.floor(Date.now() / interval) * interval) - interval
    return response(Array.from({ length: Number(parameters.get('limit') ?? 2) }, (_, index) => [String(end - index * interval), '99', '101', '98', '100', '10', '1', '1000', '1']))
  }
  if (path.includes('/rubik/')) {
    const stamp = Number(parameters.get('end')) - (parameters.get('period') === '5m' ? step : parameters.get('period') === '15m' ? 900000 : 3600000)
    return response([path.endsWith('/open-interest-history') ? [String(stamp), '50'] : [String(stamp), '20', '30']])
  }
  throw Error(`Unexpected source request: ${path}`)
}
const fixture = async (t: TestContext, config = preferences(), fetcher: typeof fetch = nativeResponse) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-architecture-')), store = await MarketStore.open(root)
  const service = new MarketService(store, () => config, fetcher, false)
  await service.ready
  for (const lane of service.requestLanes.values()) { lane.interval = 0; lane.nextAt = 0 }
  t.after(async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return { service, store, config }
}
const seedInstrument = (service: MarketService, now = Date.now()) => {
  service.candidateIDs = new Set([instId]); service.instruments.set(instId, instrument())
  service.instrumentObservations.set(instId, { observedAt: now, expiresAt: now + 3600000 })
}

for (const source of ['book', 'openInterest'] as const) test(`an expired ${source} schedules its own acquisition and restores qualification automatically`, async t => {
  let now = Math.floor(Date.now() / step) * step + 10000
  t.mock.method(Date, 'now', () => now)
  const calls: URL[] = [], { service } = await fixture(t, preferences(source === 'book' ? 'depth' : 'openInterest'), async input => { calls.push(new URL(String(input))); return nativeResponse(input) })
  seedInstrument(service, now)
  const observations = { [source]: { value: source === 'book' ? book() : { oiUsd: '6000000' }, source: 'websocket', observedAt: now, expiresAt: now + 90000 } }
  service.observations.set(instId, observations)
  const record = service.observedCandidate(instrument(), service.prefs().liquidity, service.catalogCriteriaKey(), observations)
  service.catalog.set(instId, record); service.catalogChecks.set(instId, record); service.ensureListRows('15m')
  assert.equal((await service.snapshot()).rows.length, 1)
  service.autoRefresh = true; service.scheduleMarketDeadline()
  now += 90001; service.processMarketDeadline()
  assert.equal(service.catalog.has(instId), false, 'Expired evidence is hidden before its source finishes recovering.')
  await waitFor(() => service.catalog.get(instId)?.status === 'verified')
  assert.equal((await service.snapshot()).rows.length, 1)
  const path = source === 'book' ? '/market/books' : '/public/open-interest'
  assert.equal(calls.filter(url => url.pathname.endsWith(path)).length, 1)
  assert.ok(service.observations.get(instId)[source].expiresAt > now)
  assert.equal(service.sourceRecoveries.has(`${instId}:${source}`), false)
})

test('287 contracts and three native collector periods do not restore or calculate full chart histories', async t => {
  let requests = 0
  const { service } = await fixture(t, preferences(), async input => { requests++; throw Error(`Collector membership must not acquire charts: ${input}`) })
  const ids = Array.from({ length: 287 }, (_, index) => `T${index}-USDT-SWAP`)
  service.candidateIDs = new Set(ids)
  for (const id of ids) service.instruments.set(id, instrument(id))
  service.updateSubscriptions()
  assert.equal(service.realtime.subscriptions.size, 287 * 3)
  assert.equal(service.preparedCharts.realtimeKeys.size, 287 * 3)
  for (const id of ids) for (const frame of ['5m', '15m', '1H']) {
    const interval = frame === '5m' ? step : frame === '15m' ? 900000 : 3600000
    await service.setLive(id, frame, { ...candle(Math.floor(Date.now() / interval) * interval, frame), instrument: id, confirmed: false })
  }
  assert.equal(service.liveCandles.size, 861)
  assert.equal(service.preparedCharts.series.size, 0)
  assert.equal(service.preparedCharts.snapshots.size, 0)
  assert.equal(service.preparedCharts.liveSeeds.size, 0)
  assert.equal(service.preparedCharts.workers.length, 0)
  assert.equal(requests, 0)
})

test('current quote and forming candle publish while independent OI and Taker requests remain blocked', async t => {
  const gate = deferred(), started = new Set<string>()
  t.after(() => gate.resolve())
  const { service, store } = await fixture(t, preferences(), async input => {
    const url = new URL(String(input))
    if (url.pathname.includes('/rubik/')) { started.add(url.pathname); await gate.promise }
    return nativeResponse(input)
  })
  seedInstrument(service)
  const frame = '15m', interval = 900000, formingAt = Math.floor(Date.now() / interval) * interval, end = formingAt - interval
  await store.appendCandles(Array.from({ length: 300 }, (_, index) => candle(end - (299 - index) * interval, frame)))
  await service.setChartUniverse([instId], frame, instId)
  const initial = await service.localChartWindow(instId, frame)
  assert.ok(initial?.bars.length)
  const observations = { ticker: { value: ticker(), observedAt: Date.now(), expiresAt: Date.now() + 90000 } }
  service.observations.set(instId, observations)
  const record = service.observedCandidate(instrument(), service.prefs().liquidity, service.catalogCriteriaKey(), observations)
  service.catalog.set(instId, record); service.catalogChecks.set(instId, record); service.ensureListRows(frame)
  const statistics = service.history.ensureStatistics(instId, frame, end, end, 'continuity')
  try {
    await waitFor(() => started.size === 2)
    service.receivePublicObservation(instId, 'ticker', ticker(220), { receivedAt: Date.now(), acknowledged: false })
    await service.setLive(instId, frame, { ...candle(formingAt, frame, 220), confirmed: false })
    const snapshot = await service.snapshot(frame), chart = await service.localChartWindow(instId, frame)
    assert.equal(snapshot.rows[0].lastPrice, 220)
    assert.equal(chart?.liveBar?.close, 220)
    assert.equal(chart?.priceState, 'ready')
    assert.equal(chart?.oiState, 'loading')
    assert.equal((await store.statistics({ instrument: instId, timeframe: frame, from: end, through: end })).length, 0)
  } finally { gate.resolve(); await statistics }
  const [observed] = await store.statistics({ instrument: instId, timeframe: frame, from: end, through: end })
  assert.deepEqual([observed.oi, observed.buy, observed.sell], [50, 30, 20])
})

test('service statistics commit directly before any price rows exist', async t => {
  const { service, store } = await fixture(t)
  const end = Math.floor(Date.now() / step) * step - step, bounds = { from: end, through: end, intervalMS: step }
  await Promise.all([
    service.persistStatisticsSource(instrument(), '5m', end, 1, [[end, 50]], undefined, 'continuity', false, { range: bounds }),
    service.persistStatisticsSource(instrument(), '5m', end, 2, [[end, 20, 30]], undefined, 'continuity', false, { range: bounds }),
  ])
  assert.equal((await store.coverage(instId, '5m')).count, 0)
  const [observed] = await store.statistics({ instrument: instId, timeframe: '5m', ...bounds })
  assert.deepEqual([observed.oi, observed.buy, observed.sell], [50, 30, 20])
  await service.persistCandles(instId, [candle(end)])
  const [joined] = await store.candles({ instrument: instId, timeframe: '5m', ...bounds })
  assert.deepEqual([joined.oi, joined.buy, joined.sell], [50, 30, 20])
})

test('HTTP admission gives maintenance a turn during a continuing interactive backlog', async t => {
  const gate = deferred(), started: string[] = []
  t.after(() => gate.resolve())
  const { service } = await fixture(t, preferences(), async input => {
    const id = new URL(String(input)).searchParams.get('id')!
    started.push(id)
    if (id === 'first') await gate.promise
    return response([])
  })
  service.requestLanes.get('candles').concurrency = 1
  const signal = new AbortController().signal
  const first = service.get('/market/history-candles', { id: 'first' }, signal, 'interactive')
  await waitFor(() => started.length === 1)
  const background = service.get('/market/history-candles', { id: 'maintenance' }, signal, 'background')
  const interactive = Array.from({ length: 24 }, (_, index) => service.get('/market/history-candles', { id: `interactive-${index}` }, signal, 'interactive'))
  gate.resolve(); await Promise.all([first, background, ...interactive])
  assert.ok(started.indexOf('maintenance') <= 8, started.slice(0, 12).join(','))
  assert.ok(started.indexOf('interactive-0') < started.indexOf('maintenance'))
})

test('HTTP fairness cannot fill the interactive reserve with an ineligible maintenance page', async t => {
  const gate = deferred(), started: string[] = []
  t.after(() => gate.resolve())
  const { service } = await fixture(t, preferences(), async input => {
    const id = new URL(String(input)).searchParams.get('id')!
    started.push(id)
    if (id.startsWith('prefetch')) await gate.promise
    return response([])
  })
  const lane = service.requestLanes.get('candles'); lane.concurrency = 4
  const signal = new AbortController().signal
  for (let index = 0; index < 4; index++) await service.get('/market/history-candles', { id: `prime-${index}` }, signal, 'interactive')
  const maintenance = Array.from({ length: 4 }, (_, index) => service.get('/market/history-candles', { id: `prefetch-${index}` }, signal, 'prefetch'))
  try {
    await waitFor(() => started.filter(id => id.startsWith('prefetch')).length === 3)
    const interactive = service.get('/market/history-candles', { id: 'focus' }, signal, 'interactive')
    await waitFor(() => started.includes('focus'))
    await interactive
    assert.equal(started.includes('prefetch-3'), false, 'The fairness turn must choose from eligible requests while all three maintenance slots are occupied.')
  } finally { gate.resolve(); await Promise.all(maintenance) }
})

test('delisting retires due recovery deadlines instead of leaving an immediately due inactive actor', async t => {
  const { service } = await fixture(t, preferences('depth'))
  seedInstrument(service); service.autoRefresh = true
  service.recoverRequiredSources(instId)
  assert.equal(service.sourceRecoveries.has(`${instId}:book`), true)
  service.installInstruments(new Map())
  assert.equal(service.sourceRecoveries.has(`${instId}:book`), false)
  service.processMarketDeadline()
  assert.equal(service.marketDeadlineAt, null, 'A previously queued wake cannot reschedule an inactive recovery after the universe becomes empty.')
})

test('a fresh native source retires its pending HTTP repair and cannot inherit that repair failure', async t => {
  let rejectBook!: (reason: Error) => void
  const entered = deferred()
  const { service } = await fixture(t, preferences('depth'), async input => {
    if (new URL(String(input)).pathname.endsWith('/market/books')) { entered.resolve(); return new Promise<Response>((_resolve, reject) => { rejectBook = reject }) }
    return nativeResponse(input)
  })
  seedInstrument(service); service.autoRefresh = true; service.recoverRequiredSources(instId); service.processMarketDeadline()
  await entered.promise
  const recovery = service.sourceRecoveries.get(`${instId}:book`)
  service.receivePublicObservation(instId, 'book', book(), { receivedAt: Date.now(), signal: new AbortController().signal, acknowledged: false })
  rejectBook(new Error('Retired HTTP source failed.'))
  await recovery.task
  assert.equal(service.sourceRecoveries.has(`${instId}:book`), false)
  assert.equal(service.sourceErrors.has(`${instId}:book`), false, 'A successful native observation owns current source health.')
})

test('an older REST book cannot replace a newer known native observation or renew its expired evidence', async t => {
  const now = Date.now(), { service } = await fixture(t, preferences('depth'), async input => {
    if (new URL(String(input)).pathname.endsWith('/market/books')) return response([{ ...book(), ts: String(now - 20000) }])
    return nativeResponse(input)
  })
  seedInstrument(service)
  const native = { value: { ...book(), ts: String(now - 10000) }, source: 'websocket', sourceTimestamp: now - 10000, observedAt: now - 90001, expiresAt: now - 1 }
  service.observations.set(instId, { book: native }); service.autoRefresh = true
  service.recoverRequiredSources(instId); service.processMarketDeadline()
  const recovery = service.sourceRecoveries.get(`${instId}:book`)
  await recovery.task
  assert.equal(service.observations.get(instId).book, native, 'Exchange timestamps must remain monotonic across recovery transports.')
  assert.ok(service.observationExpiry(native, 'book', instId) <= Date.now())
  assert.equal(service.sourceRecoveries.has(`${instId}:book`), true)
  assert.ok(recovery.retryAt > Date.now())
})

test('an older bulk OI value cannot renew newer native evidence during scoped recovery', async t => {
  const now = Date.now(), { service } = await fixture(t, preferences('openInterest'), async input => {
    if (new URL(String(input)).pathname.endsWith('/public/open-interest')) return response([{ instId, oiUsd: '6000000', ts: String(now - 20000) }])
    return nativeResponse(input)
  })
  seedInstrument(service)
  const native = { value: { oiUsd: '6000000', ts: String(now - 10000) }, source: 'websocket', sourceTimestamp: now - 10000, observedAt: now - 90001, expiresAt: now - 1 }
  service.observations.set(instId, { openInterest: native }); service.autoRefresh = true
  service.recoverRequiredSources(instId); service.processMarketDeadline()
  const recovery = service.sourceRecoveries.get(`${instId}:openInterest`)
  await recovery.task
  assert.equal(service.observations.get(instId).openInterest, native)
  assert.ok(service.observationExpiry(native, 'openInterest', instId) <= Date.now())
  assert.equal(service.sourceRecoveries.has(`${instId}:openInterest`), true)
  assert.ok(recovery.retryAt > Date.now())
})
