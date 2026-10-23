import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import { OKX_BUSINESS_WEBSOCKET_URL, type RealtimeWebSocket } from '../electron/services/realtime-market.js'
import { OKX_PUBLIC_WEBSOCKET_URL } from '../electron/services/realtime-public-market.js'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'

const fiveMinutes = 300_000
const instrument = (symbol = 'BTC') => ({ instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: symbol, ruleType: 'normal' })
const ticker = (instId: string, price = 100) => ({ instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price), ts: String(Date.now()) })
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (condition: () => boolean, timeout = 3_000) => {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for streamed market work.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const preferences = (...enabled: (keyof typeof DEFAULT_PREFERENCES.liquidity)[]) => {
  const config = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(config.liquidity)) rule.enabled = false
  for (const key of enabled) config.liquidity[key].enabled = true
  return config
}
type Subscription = { channel: string; instId: string }
const subscriptionKey = ({ channel, instId }: Subscription) => `${channel}:${instId}`
const deepBook = (price = 100, size = '1000', seqId = 1) => ({
  asks: Array.from({ length: 400 }, (_, index) => [(price + index * 0.0001).toFixed(4), size]),
  bids: Array.from({ length: 400 }, (_, index) => [(price - 0.01 - index * 0.0001).toFixed(4), size]),
  ts: String(Date.now()), seqId, prevSeqId: -1,
})

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  subscriptions = new Map<string, Subscription>()
  sent: string[] = []
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  send(value: string) {
    assert.equal(this.readyState, 1)
    this.sent.push(value)
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    for (const arg of command.args as Subscription[]) {
      if (command.op === 'subscribe') this.subscriptions.set(subscriptionKey(arg), arg)
      else this.subscriptions.delete(subscriptionKey(arg))
      queueMicrotask(() => this.message({ id: command.id, event: command.op, arg }))
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })))
  }
}

const fixture = async (config: ReturnType<typeof preferences>, fetcher: typeof fetch) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-all-contract-streams-'))
  const store = await MarketStore.open(root)
  const sockets = new Map<string, Socket[]>()
  const service = new MarketService(store, () => config, fetcher, false, {
    webSocketFactory: url => {
      const socket = new Socket(), values = sockets.get(url) ?? []
      values.push(socket); sockets.set(url, values)
      return socket
    },
  })
  // Raw collection assertions exclude independent chart-history preparation.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  await service.ready
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.scheduleListProjection = () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
  service.publicRealtime.start()
  service.realtime.start()
  const idle = async () => {
    await Promise.all([service.publicRealtime.whenIdle(), service.realtime.whenIdle()])
    await setImmediate()
  }
  const open = async () => {
    for (const values of sockets.values()) for (const socket of values) if (socket.readyState === 0) socket.open()
    await idle()
  }
  const subscriptions = (url: string) => [...(sockets.get(url) ?? [])].filter(socket => socket.readyState !== 3).flatMap(socket => [...socket.subscriptions.keys()]).sort()
  const push = (url: string, instId: string, channel: string, data: unknown[], action?: string) => {
    const socket = sockets.get(url)?.find(value => value.readyState === 1 && value.subscriptions.has(subscriptionKey({ instId, channel })))
    assert.ok(socket, `Missing ${channel} subscription for ${instId}.`)
    socket.message({ arg: { instId, channel }, data, ...(action ? { action } : {}) })
  }
  const discover = () => service.discoverInstruments(service.catalogCriteriaKey(), new AbortController().signal, 'foreground')
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, sockets, idle, open, subscriptions, push, discover, close }
}

test('discovery subscribes candidates including failed and unknown filters without starting a bulk archive', async () => {
  const instruments = [instrument(), instrument('ETH'), instrument('SOL'), instrument('XRP')]
  const invalid = [{ ...instrument('USDC'), settleCcy: 'USDC' }, { ...instrument('CLOSED'), state: 'suspend' }]
  const paths: string[] = []
  const f = await fixture(preferences('spread', 'volume24h'), async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.ok(path.endsWith('/public/instruments'))
    return response([...instruments, ...invalid])
  })
  try {
    f.service.catalogChecks.set(instruments[0].instId, { status: 'failed', reason: 'Spread is too wide.' })
    f.service.catalogChecks.set(instruments[1].instId, { status: 'failed', reason: 'Historical volume is too low.' })
    f.service.catalogChecks.set(instruments[2].instId, { status: 'unknown', reason: 'Historical observations are unavailable.' })
    const discovery = f.discover()
    await waitFor(() => f.service.candidateIDs?.size === instruments.length)
    await discovery
    await f.open()
    const ids = instruments.map(value => value.instId)
    assert.deepEqual(f.subscriptions(OKX_BUSINESS_WEBSOCKET_URL), ids.flatMap(instId => ['5m', '15m', '1H'].map(frame => `candle${frame}:${instId}`)).sort())
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL), ids.flatMap(instId => ['tickers', 'open-interest', 'trades'].map(channel => `${channel}:${instId}`)).sort())
    assert.deepEqual(f.service.history.sync.listTasks(), [], 'Discovery must not start bulk history downloads.')
    assert.equal(f.service.catalog.size, 0)
    assert.deepEqual(paths, ['/api/v5/public/instruments'])
  } finally { await f.close() }
})

test('a streamed ticker changes every published list price without waiting for history or screening', async () => {
  const value = instrument()
  let requests = 0
  const f = await fixture(preferences('spread'), async input => {
    requests += 1
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) return response([ticker(value.instId)])
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh(); await f.open()
    for (const frame of ['5m', '15m', '1H']) f.service.ensureListRows(frame)
    assert.equal(f.service.listRowsFor('15m')[0]?.lastPrice, 100)
    let reads = 0
    f.store.candles = async () => { reads += 1; throw new Error('A ticker must not read history.') }
    f.service.history.ensurePrices = async () => { reads += 1; throw new Error('A ticker must not repair history.') }
    const before = requests
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 200)])
    await f.idle()
    assert.ok(f.service.streamQualifications.has(value.instId), 'The price must publish before the deferred screening batch runs.')
    for (const frame of ['5m', '15m', '1H'] as const) assert.equal(f.service.listRowsFor(frame)[0]?.lastPrice, 200)
    assert.equal(reads, 0)
    assert.equal(requests, before)
  } finally { await f.close() }
})

test('a previously failing contract is requalified by the 100ms stream batch without another REST scan', async () => {
  const value = instrument()
  let requests = 0
  const f = await fixture(preferences('spread'), async input => {
    requests += 1
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) return response([{ ...ticker(value.instId), bidPx: '99', askPx: '100' }])
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh(); await f.open()
    assert.equal(f.service.catalogChecks.get(value.instId)?.status, 'failed')
    assert.equal(f.service.catalog.has(value.instId), false)
    const before = requests
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 200)])
    await f.idle()
    assert.equal(f.service.catalog.has(value.instId), false, 'Raw callbacks defer expensive qualification into one shared batch.')
    await waitFor(() => f.service.catalog.has(value.instId))
    assert.equal(f.service.catalogChecks.get(value.instId)?.status, 'verified')
    assert.equal(f.service.listRowsFor('15m')[0]?.lastPrice, 200)
    assert.equal(requests, before)
  } finally { await f.close() }
})

test('delayed REST ticker and book responses cannot regress newer WebSocket observations', async () => {
  const value = instrument(), tickerGate = deferred(), bookGate = deferred()
  let tickerStarted = false, bookStarted = false
  const f = await fixture(preferences('spread', 'depth'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) { tickerStarted = true; await tickerGate.promise; return response([ticker(value.instId)]) }
    if (path.endsWith('/market/books')) { bookStarted = true; await bookGate.promise; return response([{ asks: [['100', '1']], bids: [['99.99', '1']] }]) }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let checking: Promise<unknown> | undefined
  try {
    await f.discover(); await f.open()
    const signal = new AbortController().signal
    checking = Promise.all([
      f.service.tickerObservations(signal, 'foreground', true),
      f.service.checkCandidate(value, f.service.prefs().liquidity, f.service.catalogCriteriaKey(), signal),
    ])
    await waitFor(() => tickerStarted && bookStarted)
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 200)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [{ asks: [['200', '200001']], bids: [['199.99', '200001']], ts: String(Date.now()), seqId: 99, prevSeqId: -1 }], 'snapshot')
    await f.idle()
    const observations = f.service.observations.get(value.instId)
    const streamTicker = observations.ticker, streamBook = observations.book
    assert.equal(streamTicker.source, 'websocket')
    assert.equal(streamBook.source, 'websocket')
    tickerGate.resolve(); bookGate.resolve(); await checking
    assert.equal(f.service.tickerCache.values.get(value.instId), streamTicker)
    assert.equal(f.service.observations.get(value.instId).ticker, streamTicker)
    assert.equal(f.service.observations.get(value.instId).book, streamBook)
    assert.equal(f.service.catalogChecks.get(value.instId)?.status, 'verified')
    assert.equal(f.service.listRowsFor('15m')[0]?.lastPrice, 200)
  } finally { tickerGate.resolve(); bookGate.resolve(); await checking; await f.close() }
})

test('delisting removes every public and candle subscription, including a previously selected chart', async () => {
  let instruments = [instrument(), instrument('ETH')]
  const f = await fixture(preferences('spread'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(instruments.map(value => ticker(value.instId)))
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh(); await f.open()
    const removed = instruments[1].instId
    f.service.chartSubscriptions = [{ instId: removed, timeframe: '1H' }]
    instruments = instruments.slice(0, 1)
    await f.discover(); await f.idle()
    assert.deepEqual(f.subscriptions(OKX_BUSINESS_WEBSOCKET_URL), ['candle1H:BTC-USDT-SWAP', 'candle15m:BTC-USDT-SWAP', 'candle5m:BTC-USDT-SWAP'].sort())
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL), ['open-interest:BTC-USDT-SWAP', 'tickers:BTC-USDT-SWAP', 'trades:BTC-USDT-SWAP'].sort())
    assert.equal(f.service.catalog.has(removed), false)
    assert.equal(f.service.renewalTargets.has(removed), false)
  } finally { await f.close() }
})

test('liquidity settings retain books while either dependent rule is enabled and toggle only that channel', async () => {
  const instruments = [instrument(), instrument('ETH')], config = preferences('depth', 'slippage'), paths: string[] = []
  const f = await fixture(config, async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.ok(path.endsWith('/public/instruments'))
    return response(instruments)
  })
  try {
    await f.discover(); await f.open()
    const ids = instruments.map(value => value.instId), socket = f.sockets.get(OKX_PUBLIC_WEBSOCKET_URL)![0]
    const initialCommands = socket.sent.length
    const stable = [...f.service.publicRealtime.subscriptions].filter(([, value]) => value.channel !== 'books')
    const candles = f.subscriptions(OKX_BUSINESS_WEBSOCKET_URL)
    let previous = structuredClone(config)
    config.liquidity.depth.enabled = false
    await f.service.reconfigure(previous); await f.idle()
    assert.equal(socket.sent.length, initialCommands, 'Slippage still needs the resident books subscription.')
    previous = structuredClone(config)
    config.liquidity.slippage.enabled = false
    await f.service.reconfigure(previous); await f.idle()
    assert.deepEqual(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL), ids.flatMap(instId => ['tickers', 'open-interest', 'trades'].map(channel => `${channel}:${instId}`)).sort())
    assert.deepEqual(f.subscriptions(OKX_BUSINESS_WEBSOCKET_URL), candles)
    for (const [key, value] of stable) assert.equal(f.service.publicRealtime.subscriptions.get(key), value)
    f.push(OKX_PUBLIC_WEBSOCKET_URL, ids[0], 'tickers', [ticker(ids[0], 200)])
    await f.idle()
    assert.equal(f.service.observations.get(ids[0]).ticker.value.last, '200')
    previous = structuredClone(config)
    config.liquidity.depth.enabled = true
    await f.service.reconfigure(previous); await f.idle()
    for (const instId of ids) assert.ok(f.subscriptions(OKX_PUBLIC_WEBSOCKET_URL).includes(`books:${instId}`))
    for (const [key, value] of stable) assert.equal(f.service.publicRealtime.subscriptions.get(key), value)
    const controls = socket.sent.slice(initialCommands).map(value => JSON.parse(value))
    assert.equal(controls.filter(command => command.op === 'unsubscribe').length, 1)
    assert.equal(controls.filter(command => command.op === 'subscribe').length, 1)
    assert.ok(controls.every(command => command.args.every((arg: Subscription) => arg.channel === 'books')))
    f.push(OKX_PUBLIC_WEBSOCKET_URL, ids[0], 'books', [deepBook(200, '1000', 100)], 'snapshot')
    await f.idle()
    assert.equal(f.service.observations.get(ids[0]).book.value.seqId, 100)
    assert.deepEqual(paths, ['/api/v5/public/instruments'])
    assert.equal(f.sockets.get(OKX_PUBLIC_WEBSOCKET_URL)?.length, 1)
  } finally { await f.close() }
})

test('forming OI updates remain in memory and a mid-period trade subscription never fabricates full taker totals', async context => {
  const start = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, now = start + 60_000
  context.mock.method(Date, 'now', () => now)
  const value = instrument()
  const f = await fixture(preferences(), async input => {
    const path = new URL(String(input)).pathname
    assert.ok(path.endsWith('/public/instruments'))
    return response([value])
  })
  try {
    await f.discover(); await f.open()
    const raw = [String(start), '100', '101', '99', '100', '7', '0.07', '7', '0']
    f.push(OKX_BUSINESS_WEBSOCKET_URL, value.instId, 'candle5m', [raw])
    await f.idle()
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'open-interest', [{ instId: value.instId, oi: '123', oiUsd: '6000000', ts: String(now) }])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'trades', [{ instId: value.instId, tradeId: '1', side: 'buy', sz: '7', ts: String(now), count: '3' }])
    await f.idle()
    await waitFor(() => f.service.liveCandles.get(`${value.instId}:5m`)?.oi === 123)
    const forming = f.service.liveCandles.get(`${value.instId}:5m`)
    assert.equal(forming.confirmed, false)
    assert.equal(forming.oi, 123)
    assert.ok(forming.buy == null && forming.sell == null, 'Trades observed after a mid-period acknowledgement are incomplete totals.')
    for (const timeframe of ['5m', '15m', '1H']) {
      assert.deepEqual(await f.store.candles({ instrument: value.instId, timeframe }), [])
      assert.equal((await f.store.coverage(value.instId, timeframe)).count, 0)
    }
  } finally { await f.close() }
})

test('fresh 400-level books are qualified asynchronously without exact book arithmetic on the main thread', async () => {
  const value = instrument()
  const f = await fixture(preferences('spread', 'depth', 'slippage'), async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/public/instruments'))
    return response([value])
  })
  try {
    await f.discover(); await f.open()
    const synchronous = f.service.evaluateLiquidity
    f.service.evaluateLiquidity = (input: LiquidityInput) => {
      assert.equal(input.book, null, 'Native book arithmetic must run in the worker.')
      return synchronous(input)
    }
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook()], 'snapshot')
    await f.idle()
    f.service.flushStreamQualifications()
    assert.equal(f.service.catalog.has(value.instId), false, 'Qualification must yield before a worker result arrives.')
    await waitFor(() => f.service.catalog.has(value.instId))
    const result = f.service.catalog.get(value.instId).result
    assert.equal(result.status, 'verified')
    assert.ok(result.depthAsk > 100_000 && result.depthBid > 100_000)
    assert.ok(result.askSlippage < 0.1 && result.bidSlippage < 0.1)
    assert.equal(f.service.observations.get(value.instId).book.value.asks.length, 400)
  } finally { await f.close() }
})

test('an older asynchronous depth result cannot replace a newer streamed list price', async () => {
  const value = instrument(), gate = deferred()
  const f = await fixture(preferences('spread', 'depth'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) return response([ticker(value.instId)])
    if (path.endsWith('/market/books')) return response([deepBook()])
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh(); await f.open()
    let captured: LiquidityInput | undefined
    f.service.streamLiquidity = { evaluate: async (input: LiquidityInput) => { captured = input; await gate.promise; return evaluateLiquidity(input) }, close: async () => { gate.resolve() } }
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 200)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook(200)], 'snapshot')
    await f.idle(); f.service.flushStreamQualifications()
    assert.equal(captured?.ticker?.last, '200')
    const evaluation = f.service.streamEvaluations.get(value.instId)
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 300)])
    await f.idle()
    assert.equal(f.service.listRowsFor('15m')[0]?.lastPrice, 300)
    gate.resolve(); await evaluation
    assert.equal(f.service.catalog.get(value.instId).ticker.last, '300')
    assert.equal(f.service.listRowsFor('15m')[0]?.lastPrice, 300)
  } finally { gate.resolve(); await f.close() }
})

for (const change of ['contract units', 'preferences', 'completed history'] as const) test(`a pending worker result is discarded after changes to ${change}`, async () => {
  let current = instrument()
  const config = preferences('spread', 'depth', 'volume24h'), gate = deferred()
  const f = await fixture(config, async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/public/instruments'))
    return response([current])
  })
  try {
    await f.discover(); await f.open()
    const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, observedAt = Date.now()
    f.service.observations.set(current.instId, { turnover: { value: { asOf, turnover: 50_000_000 }, observedAt, expiresAt: asOf + fiveMinutes } })
    let captured: LiquidityInput | undefined
    f.service.streamLiquidity = { evaluate: async (input: LiquidityInput) => { captured = input; await gate.promise; return evaluateLiquidity(input) }, close: async () => { gate.resolve() } }
    f.push(OKX_PUBLIC_WEBSOCKET_URL, current.instId, 'tickers', [ticker(current.instId)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, current.instId, 'books', [deepBook()], 'snapshot')
    await f.idle(); f.service.flushStreamQualifications()
    assert.ok(captured)
    assert.equal(evaluateLiquidity(captured).status, 'verified')
    const evaluation = f.service.streamEvaluations.get(current.instId)
    if (change === 'contract units') {
      current = { ...current, ctVal: '0.001' }
      await f.discover()
    } else if (change === 'preferences') config.liquidity.depth.minUSDT = 1_000_000_000
    else await f.service.persistCandles(current.instId, [{ instrument: current.instId, timeframe: '5m', timestamp: asOf - fiveMinutes, open: 100, high: 100, low: 100, close: 100, volume: 1, baseVolume: 0.01, quoteVolume: 1, confirmed: true }])
    gate.resolve(); await evaluation
    assert.equal(f.service.catalog.has(current.instId), false, 'An obsolete successful result must not admit the contract.')
    assert.notEqual(f.service.catalogChecks.get(current.instId)?.status, 'verified')
  } finally { gate.resolve(); await f.close() }
})

test('worker results preserve original book leases, evaluate the newest queued book, and reject expired sources', async context => {
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const value = instrument(), gates = [deferred(), deferred(), deferred()], inputs: LiquidityInput[] = []
  const f = await fixture(preferences('spread', 'depth'), async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/public/instruments'))
    return response([value])
  })
  try {
    await f.discover(); await f.open()
    f.service.streamLiquidity = {
      evaluate: async (input: LiquidityInput) => { const index = inputs.length; inputs.push(input); await gates[index]?.promise; return evaluateLiquidity(input) },
      close: async () => { for (const gate of gates) gate.resolve() },
    }
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook()], 'snapshot')
    await f.idle(); f.service.flushStreamQualifications()
    const evaluation = f.service.streamEvaluations.get(value.instId)
    const originalBook = f.service.observations.get(value.instId).book
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook(100, '1', 2)], 'snapshot')
    await f.idle()
    const newestBook = f.service.observations.get(value.instId).book
    gates[0].resolve(); await evaluation
    const qualified = f.service.catalog.get(value.instId)
    assert.equal(qualified?.status, 'verified')
    assert.equal(qualified.observations.book, originalBook, 'The result describes its original immutable book observation.')
    assert.ok(qualified.expiresAt <= originalBook.expiresAt, 'A delayed calculation must not renew the original source lease.')
    assert.equal(f.service.observations.get(value.instId).book, newestBook, 'Publishing a completed calculation must preserve the latest acquired book.')
    await waitFor(() => inputs.length === 2)
    assert.equal(inputs[1].book, newestBook.value)
    const newestEvaluation = f.service.streamEvaluations.get(value.instId)
    gates[1].resolve(); await newestEvaluation
    assert.equal(f.service.catalog.has(value.instId), false, 'The newest shallow-book result removes the earlier qualification.')
    assert.equal(f.service.catalogChecks.get(value.instId)?.status, 'unknown')
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook(100, '1000', 3)], 'snapshot')
    await f.idle(); f.service.flushStreamQualifications()
    assert.equal(inputs.length, 3)
    const delayedEvaluation = f.service.streamEvaluations.get(value.instId), delayedBook = f.service.observations.get(value.instId).book
    now += 90_000
    f.service.instrumentObservations.set(value.instId, { observedAt: now, expiresAt: now + 90_000 })
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'tickers', [ticker(value.instId, 200)])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, value.instId, 'books', [deepBook(200, '1000', 4)], 'snapshot')
    await f.idle()
    assert.equal(delayedBook.expiresAt, now)
    gates[2].resolve(); await delayedEvaluation
    assert.equal(f.service.catalog.has(value.instId), false)
    assert.notEqual(f.service.catalogChecks.get(value.instId)?.status, 'verified')
  } finally { for (const gate of gates) gate.resolve(); await f.close() }
})

test('a bulk REST request launched after a fresh per-contract stream cannot replace that contract with stale data', async () => {
  const instruments = [instrument(), instrument('ETH')], gate = deferred()
  let tickersStarted = false
  const f = await fixture(preferences('spread'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) { tickersStarted = true; await gate.promise; return response(instruments.map(value => ticker(value.instId))) }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let requesting: Promise<unknown> | undefined
  try {
    await f.discover(); await f.open()
    f.push(OKX_PUBLIC_WEBSOCKET_URL, instruments[0].instId, 'tickers', [ticker(instruments[0].instId, 200)])
    await f.idle()
    const fresh = f.service.tickerCache.values.get(instruments[0].instId)
    // ETH has no stream observation, so one bulk REST request remains useful.
    requesting = f.service.tickerObservations(new AbortController().signal, 'foreground', true)
    await waitFor(() => tickersStarted)
    gate.resolve(); await requesting
    assert.equal(f.service.tickerCache.values.get(instruments[0].instId), fresh)
    assert.equal(f.service.tickerCache.values.get(instruments[0].instId).value.last, '200')
    assert.equal(f.service.tickerCache.values.get(instruments[1].instId).value.last, '100')
  } finally { gate.resolve(); await requesting; await f.close() }
})

test('delisting and relisting reset trade coverage and OI even when the candle period has not changed', async context => {
  const start = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  let now = start, instruments = [instrument(), instrument('ETH')]
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(preferences(), async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/public/instruments'))
    return response(instruments)
  })
  try {
    await f.discover(); await f.open()
    const id = instruments[0].instId
    const raw = (volume: number) => [String(start), '100', '101', '99', '100', String(volume), String(volume / 100), String(volume), '0']
    now += 10
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'trades', [{ instId: id, tradeId: '1', side: 'buy', sz: '2', ts: String(now) }])
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'open-interest', [{ instId: id, oi: '123', oiUsd: '6000000', ts: String(now) }])
    await f.idle()
    f.push(OKX_BUSINESS_WEBSOCKET_URL, id, 'candle5m', [raw(2)])
    await f.idle()
    assert.equal(f.service.liveCandles.get(`${id}:5m`).buy, 2)
    instruments = instruments.slice(1)
    await f.discover(); await f.idle()
    assert.equal(f.service.liveCandles.has(`${id}:5m`), false)
    now += 10
    instruments = [instrument(), ...instruments]
    await f.discover(); await f.open()
    f.push(OKX_PUBLIC_WEBSOCKET_URL, id, 'trades', [{ instId: id, tradeId: '2', side: 'buy', sz: '3', ts: String(now) }])
    f.push(OKX_BUSINESS_WEBSOCKET_URL, id, 'candle5m', [raw(5)])
    await f.idle()
    const relisted = f.service.liveCandles.get(`${id}:5m`)
    assert.ok(relisted.buy == null && relisted.sell == null && relisted.oi == null)
  } finally { await f.close() }
})

test('a confirmed candle requests its exact statistics slot while subsequent forming candles continue', async () => {
  const value = instrument(), gate = deferred(), calls: unknown[][] = []
  const f = await fixture(preferences(), async input => {
    assert.ok(new URL(String(input)).pathname.endsWith('/public/instruments'))
    return response([value])
  })
  try {
    await f.discover(); await f.open()
    let finished = false
    f.service.history.ensureStatistics = async (...args: unknown[]) => { calls.push(args); await gate.promise; finished = true; return { rows: [] } }
    const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes, closed = now - fiveMinutes
    const raw = (time: number, price: number, volume: number, confirmed = false) => [String(time), '100', '105', '95', String(price), String(volume), String(volume / 100), String(volume), confirmed ? '1' : '0']
    f.push(OKX_BUSINESS_WEBSOCKET_URL, value.instId, 'candle5m', [raw(closed, 101, 1, true), raw(now, 102, 1)])
    await f.idle()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 5), [value.instId, '5m', closed, closed, 'continuity'])
    assert.ok(calls[0][5] instanceof AbortSignal)
    assert.equal(finished, false)
    assert.equal(f.service.liveCandles.get(`${value.instId}:5m`).close, 102)
    f.push(OKX_BUSINESS_WEBSOCKET_URL, value.instId, 'candle5m', [raw(now, 103, 2)])
    await f.idle()
    assert.equal(f.service.liveCandles.get(`${value.instId}:5m`).close, 103)
    assert.equal(finished, false)
    const durable = await f.store.candles({ instrument: value.instId, timeframe: '5m' })
    assert.deepEqual(durable.map(row => [row.timestamp, row.confirmed]), [[closed, true]])
  } finally { gate.resolve(); await f.close() }
})
