import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { setImmediate } from 'node:timers/promises'
import { OKX_BUSINESS_WEBSOCKET_URL, RealtimeMarket } from '../electron/services/realtime-market.js'
import type { RealtimeMarketOptions, RealtimeMarketState, RealtimeSubscription, RealtimeWebSocket } from '../electron/services/realtime-market.js'
import type { CandleRecord } from '../electron/services/market-store.js'
import type { RadarTimeframe } from './timeframe.ts'

const turn = () => setImmediate()
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class Clock {
  time = 1_800_000_000_000
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next
    this.timers.set(id, { at: this.time + delay, callback })
    return id
  }
  clearTimeout = (id: unknown) => { this.timers.delete(Number(id)) }
  async advance(ms: number) {
    const end = this.time + ms
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await turn()
    }
    this.time = end
    await turn()
  }
}

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  sent: string[] = []
  autoAck = true
  autoClose = true
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  data(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: value })) }
  message(value: unknown) { this.data(typeof value === 'string' ? value : JSON.stringify(value)) }
  send(value: string) {
    assert.equal(this.readyState, 1)
    this.sent.push(value)
    if (value === 'ping') return
    const message = JSON.parse(value)
    if (this.autoAck) for (const arg of message.args) queueMicrotask(() => this.message({ id: message.id, event: message.op, arg }))
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 2
    if (this.autoClose) queueMicrotask(() => this.finishClose())
  }
  finishClose(code = 1000, reason = '') {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }
  commands() { return this.sent.filter(value => value !== 'ping').map(value => JSON.parse(value)) }
}

const btc: RealtimeSubscription = { instId: 'BTC-USDT-SWAP', timeframe: '5m' }
const eth: RealtimeSubscription = { instId: 'ETH-USDT-SWAP', timeframe: '1H' }
const sol: RealtimeSubscription = { instId: 'SOL-USDT-SWAP', timeframe: '15m' }
const epoch = 1_799_999_700_000
type Candle = CandleRecord & { timeframe: RadarTimeframe; baseVolume: number; quoteVolume: number }
const raw = (timestamp = epoch, close = 101, volume = 1, confirmed = false) => [String(timestamp), '100', '105', '95', String(close), String(volume), String(volume / 10), String(volume * 100), confirmed ? '1' : '0']
const push = (socket: Socket, value: string[], subscription = btc) => socket.message({ arg: { instId: subscription.instId, channel: `candle${subscription.timeframe}` }, data: [value] })
const parseCandle = (instrument: string, timeframe: RadarTimeframe, value: string[]): Candle => ({ instrument, timeframe, timestamp: Number(value[0]), open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]), volume: Number(value[5]), baseVolume: Number(value[6]), quoteVolume: Number(value[7]), confirmed: value[8] === '1' })

function fixture(overrides: Partial<RealtimeMarketOptions<Candle>> = {}) {
  const clock = new Clock(), sockets: Socket[] = [], urls: string[] = [], forming: Candle[] = [], confirmed: Candle[] = [], states: RealtimeMarketState[] = [], errors: string[] = []
  const market = new RealtimeMarket<Candle>({
    parseCandle,
    onForming: candle => { forming.push(candle) },
    onConfirmed: candle => { confirmed.push(candle) },
    onReconnect: async () => {},
    onState: state => { states.push(state) },
    webSocketFactory: url => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, reconnectJitter: 0,
    logger: { error: message => { errors.push(String(message)) } },
    ...overrides,
  })
  const open = async (subscriptions: RealtimeSubscription[] = [btc]) => {
    market.setSubscriptions(subscriptions)
    market.start()
    const socket = sockets.at(-1)!
    socket.open()
    await market.whenIdle()
    assert.equal(market.getState().status, 'live')
    return socket
  }
  return { market, clock, sockets, urls, forming, confirmed, states, errors, open }
}

test('forming candles stay in memory; receive order and cumulative volume handle revisions without regression', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const socket = await f.open()
  assert.deepEqual(f.urls, [OKX_BUSINESS_WEBSOCKET_URL])
  assert.equal(OKX_BUSINESS_WEBSOCKET_URL, 'wss://ws.okx.com/ws/v5/business')
  for (const value of [raw(), raw(), raw(epoch, 102, 2), raw(epoch, 99, 1), raw(epoch, 103, 2), raw(epoch - 300_000, 104, 3), raw(epoch + 300_000, 104), raw(epoch, 100, 4)]) push(socket, value)
  await f.market.whenIdle()
  assert.deepEqual(f.forming.map(candle => candle.close), [101, 102, 103, 104])
  assert.equal(f.confirmed.length, 0)
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.timestamp, epoch + 300_000)
  for (const value of [raw(epoch, 103, 2, true), raw(epoch, 103, 2, true), raw(epoch, 104, 2, true), raw(epoch, 103, 2, true), raw(epoch, 102, 5)]) push(socket, value)
  await f.market.whenIdle()
  assert.deepEqual(f.confirmed.map(candle => candle.close), [103, 104])
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.timestamp, epoch + 300_000)
  push(socket, raw(epoch + 300_000, 104, 1, true))
  push(socket, raw(epoch + 300_000, 103, 2))
  await f.market.whenIdle()
  assert.equal(f.market.getForming(btc.instId, btc.timeframe), null)
  assert.equal(f.forming.length, 4)
  assert.ok(f.market.getTelemetry().ignoredEvents >= 6)
  f.market.setSubscriptions([])
  f.market.setSubscriptions([btc])
  const resubscribed = f.sockets.at(-1)!
  resubscribed.open()
  await f.market.whenIdle()
  push(resubscribed, raw(epoch + 300_000, 103, 2))
  push(resubscribed, raw(epoch + 300_000, 104, 1, true))
  await f.market.whenIdle()
  assert.equal(f.market.getForming(btc.instId, btc.timeframe), null)
  assert.equal(f.confirmed.length, 3)
})

test('a durable confirmation is a per-series barrier while other instruments keep updating', async t => {
  const write = deferred(), began = deferred(), seen: string[] = []
  const f = fixture({ onConfirmed: async candle => { seen.push(`write:${candle.timestamp}`); began.resolve(); await write.promise; seen.push('durable') } })
  t.after(() => f.market.close())
  const socket = await f.open([btc, eth])
  push(socket, raw())
  await f.market.whenIdle()
  push(socket, raw(epoch, 102, 2, true))
  push(socket, raw(epoch + 300_000, 103))
  push(socket, raw(epoch, 104), eth)
  await began.promise
  await turn()
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.timestamp, epoch)
  assert.equal(f.market.getForming(eth.instId, eth.timeframe)?.close, 104)
  assert.equal(f.market.getTelemetry().confirmedEvents, 0)
  assert.deepEqual(f.forming.map(candle => candle.instrument), [btc.instId, eth.instId])
  write.resolve()
  await f.market.whenIdle()
  assert.deepEqual(seen, [`write:${epoch}`, 'durable'])
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.timestamp, epoch + 300_000)
  assert.equal(f.market.getTelemetry().confirmedEvents, 1)
})

test('a failed durable write retains forming state, reports its error, and allows the same confirmation to retry', async t => {
  let writes = 0
  const f = fixture({ onConfirmed: async () => { if (++writes === 1) throw new Error('Disk is full.') } })
  t.after(() => f.market.close())
  const socket = await f.open()
  push(socket, raw())
  await f.market.whenIdle()
  const updatedAt = f.market.getState().updatedAt
  await f.clock.advance(10)
  push(socket, raw(epoch, 102, 2, true))
  await f.market.whenIdle()
  assert.match(f.market.getState().error, /Disk is full/)
  assert.match(f.errors.join('\n'), /Disk is full/)
  assert.equal(f.market.getState().updatedAt, updatedAt)
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.close, 101)
  push(socket, raw(epoch, 102, 2, true))
  push(socket, raw(epoch, 102, 2, true))
  await f.market.whenIdle()
  assert.equal(writes, 2)
  assert.equal(f.market.getForming(btc.instId, btc.timeframe), null)
  assert.equal(f.market.getState().error, '')
  assert.equal(f.market.getState().updatedAt, f.clock.now())
})

test('a failed forming projection can retry the same event and malformed input is reported', async t => {
  let attempts = 0
  const f = fixture({ onForming: async () => { if (++attempts === 1) throw new Error('Projection failed.') } })
  t.after(() => f.market.close())
  const socket = await f.open()
  push(socket, raw())
  await f.market.whenIdle()
  assert.match(f.market.getState().error, /Projection failed/)
  push(socket, raw())
  await f.market.whenIdle()
  assert.equal(attempts, 2)
  assert.equal(f.market.getState().error, '')
  push(socket, raw(epoch, 101, -1))
  socket.message('{invalid')
  await f.market.whenIdle()
  assert.equal(attempts, 2)
  assert.equal(f.market.getTelemetry().rejectedEvents, 1)
  assert.match(f.errors.join('\n'), /Invalid OKX candle payload/)
  assert.match(f.errors.join('\n'), /Invalid WebSocket JSON/)
})

test('subscription acknowledgements have independent deadlines and stale acknowledgements cannot mark a new request live', async t => {
  const f = fixture({ heartbeatIntervalMs: 20_000 })
  t.after(() => f.market.close())
  f.market.setSubscriptions([btc])
  f.market.start()
  const socket = f.sockets[0]
  socket.autoAck = false
  socket.open()
  await f.market.whenIdle()
  const first = socket.commands()[0]
  assert.equal(f.market.isSubscribed(btc.instId, btc.timeframe), false)
  await f.clock.advance(14_900)
  f.market.setSubscriptions([btc, eth])
  const second = socket.commands().at(-1)
  socket.message({ id: first.id, event: 'subscribe', arg: first.args[0] })
  await f.market.whenIdle()
  assert.equal(f.market.isSubscribed(btc.instId, btc.timeframe), true)
  assert.equal(f.market.isSubscribed(eth.instId, eth.timeframe), false)
  await f.clock.advance(200)
  assert.equal(f.sockets.length, 1)
  assert.equal(f.market.getState().status, 'connecting')
  socket.message({ id: second.id, event: 'subscribe', arg: second.args[0] })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  f.market.setSubscriptions([eth])
  assert.equal(f.market.isSubscribed(btc.instId, btc.timeframe), false)
  f.market.setSubscriptions([btc, eth])
  const latest = socket.commands().at(-1)
  socket.message({ id: first.id, event: 'subscribe', arg: first.args[0] })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'connecting')
  assert.equal(f.market.isSubscribed(btc.instId, btc.timeframe), false)
  assert.equal(f.market.isSubscribed(eth.instId, eth.timeframe), true, 'An unrelated pending subscription cannot invalidate an acknowledged series.')
  socket.message({ id: latest.id, event: 'subscribe', arg: latest.args[0] })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  f.market.setSubscriptions([btc, eth, sol])
  await f.clock.advance(15_000)
  assert.equal(f.market.getState().status, 'reconnecting')
  assert.equal(f.market.isSubscribed(eth.instId, eth.timeframe), false)
  assert.match(f.market.getState().error, /acknowledgement timed out/)
})

test('reconnect streams immediately during gap repair and keeps old writes as a barrier only for their own series', async t => {
  const write = deferred(), repair = deferred(), repairs: RealtimeSubscription[][] = [], order: string[] = []
  const f = fixture({
    onConfirmed: async () => { order.push('write'); await write.promise; order.push('durable') },
    onReconnect: async subscriptions => { repairs.push(subscriptions); order.push('repair'); await repair.promise },
  })
  t.after(async () => { write.resolve(); repair.resolve(); await f.market.close() })
  const first = await f.open([btc, eth])
  push(first, raw(epoch, 101, 1, true))
  push(first, raw(epoch + 300_000, 199))
  await turn()
  first.finishClose(1006, 'Connection lost')
  assert.equal(f.market.getState().status, 'reconnecting')
  assert.match(f.market.getState().error, /Connection lost/)
  await f.clock.advance(999)
  assert.equal(f.sockets.length, 1)
  await f.clock.advance(1)
  const second = f.sockets[1]
  second.open()
  push(second, raw(epoch + 300_000, 102))
  push(second, raw(epoch, 104), eth)
  await turn()
  assert.deepEqual(order, ['write', 'repair'])
  assert.deepEqual(f.forming.map(candle => [candle.instrument, candle.close]), [[eth.instId, 104]])
  assert.equal(f.market.getState().status, 'live')
  assert.equal(f.market.getState().error, '')
  write.resolve()
  await turn()
  assert.deepEqual(order, ['write', 'repair', 'durable'])
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.close, 102)
  f.market.setSubscriptions([btc, eth, sol])
  push(second, raw(epoch, 105), sol)
  await turn()
  assert.equal(f.market.getState().status, 'live')
  assert.equal(f.market.getForming(sol.instId, sol.timeframe)?.close, 105)
  repair.resolve()
  await f.market.whenIdle()
  assert.deepEqual(repairs, [[btc, eth], [sol]])
  assert.equal(f.market.getState().status, 'live')
  assert.equal(f.forming.length, 3)
  assert.deepEqual(second.commands().filter(message => message.op === 'subscribe').flatMap(message => message.args.map((arg: { channel: string }) => arg.channel)), ['candle5m', 'candle1H', 'candle15m'])
  f.market.setSubscriptions([eth, sol])
  push(second, raw(epoch + 300_000, 103))
  push(first, raw(epoch + 300_000, 104), eth)
  await f.market.whenIdle()
  assert.equal(second.commands().at(-1).op, 'unsubscribe')
  assert.deepEqual(second.commands().at(-1).args, [{ channel: 'candle5m', instId: btc.instId }])
  assert.equal(f.market.getForming(btc.instId, btc.timeframe), null)
  assert.equal(f.forming.length, 3)
  assert.equal(f.market.getTelemetry().reconnects, 1)
  second.message({ event: 'notice', code: '64008', msg: 'Reconnect for upgrade.' })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'reconnecting')
  f.market.setSubscriptions([])
  await f.clock.advance(60_000)
  assert.equal(f.sockets.length, 2)
  assert.equal(f.market.getState().status, 'disconnected')
})

test('failed gap repair retries with bounded backoff while healthy live events continue', async t => {
  let calls = 0
  const repaired = deferred()
  const f = fixture({ reconnectBaseMs: 100, reconnectMaxMs: 250, onReconnect: async () => {
    if (++calls <= 3) throw new Error('History is unavailable.')
    await repaired.promise
  } })
  t.after(async () => { repaired.resolve(); await f.market.close() })
  const first = await f.open()
  first.finishClose(1006)
  await f.clock.advance(100)
  const second = f.sockets[1]
  second.open()
  await f.market.whenIdle()
  assert.equal(calls, 1)
  assert.equal(f.market.getState().status, 'live')
  assert.match(f.market.getState().error, /History is unavailable/)
  push(second, raw(epoch, 101))
  await f.market.whenIdle()
  assert.equal(f.forming.length, 1)
  assert.match(f.market.getState().error, /History is unavailable/)
  await f.clock.advance(99)
  assert.equal(calls, 1)
  await f.clock.advance(1)
  assert.equal(calls, 2)
  await f.clock.advance(200)
  assert.equal(calls, 3)
  await f.clock.advance(250)
  assert.equal(calls, 4)
  push(second, raw(epoch, 102, 2))
  await turn()
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.close, 102)
  assert.equal(f.sockets.length, 2, 'Historical failures must not reconnect a healthy transport.')
  repaired.resolve()
  await f.market.whenIdle()
  assert.equal(f.market.getState().error, '')
  assert.equal(f.market.getState().status, 'live')
})

test('connection failures back off to a bounded delay, and an empty universe cancels retry', async () => {
  const attempts: number[] = [], clock = new Clock(), errors: string[] = []
  const market = new RealtimeMarket({ parseCandle, onForming: () => {}, onConfirmed: () => {}, onReconnect: () => {}, webSocketFactory: () => { attempts.push(clock.now()); throw new Error('Offline.') }, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, reconnectBaseMs: 100, reconnectMaxMs: 250, reconnectJitter: 0, logger: { error: value => { errors.push(String(value)) } } })
  try {
    market.start()
    assert.deepEqual(attempts, [])
    market.setSubscriptions([btc])
    await clock.advance(800)
    assert.deepEqual(attempts.map(value => value - attempts[0]), [0, 100, 300, 550, 800])
    assert.equal(errors.length, 5)
    market.setSubscriptions([])
    await clock.advance(10_000)
    assert.equal(attempts.length, 5)
    assert.equal(clock.timers.size, 0)
  } finally { await market.close() }
  let closing: Promise<void> | undefined
  const observer = fixture({
    webSocketFactory: () => { throw new Error('Offline.') },
    onState: state => { if (state.status === 'reconnecting') closing = observer.market.close() },
  })
  observer.market.setSubscriptions([btc])
  observer.market.start()
  await closing
  assert.equal(observer.market.getState().status, 'disconnected')
  assert.equal(observer.clock.timers.size, 0)
})

test('text ping/pong proves liveness; a missing pong reconnects and close cancels the retry', async () => {
  const f = fixture({ heartbeatIntervalMs: 100, pongTimeoutMs: 50 })
  const socket = await f.open()
  await f.clock.advance(100)
  assert.equal(socket.sent.at(-1), 'ping')
  socket.message('pong')
  await f.market.whenIdle()
  await f.clock.advance(100)
  assert.equal(socket.sent.filter(value => value === 'ping').length, 2)
  await f.clock.advance(50)
  assert.equal(f.market.getState().status, 'reconnecting')
  assert.match(f.errors.join('\n'), /pong timed out/)
  await f.market.close()
  await f.clock.advance(60_000)
  assert.equal(f.sockets.length, 1)
  assert.equal(f.clock.timers.size, 0)
})

test('shutdown waits for accepted durable callbacks and native socket closure without aborting the write', async () => {
  const write = deferred(), began = deferred()
  let signal: AbortSignal | undefined
  const f = fixture({ onConfirmed: async (_candle, context) => { signal = context.signal; began.resolve(); await write.promise; assert.equal(context.signal.aborted, false) } })
  const socket = await f.open()
  socket.autoClose = false
  push(socket, raw(epoch, 102, 2, true))
  await began.promise
  let closed = false
  const closing = f.market.close().then(() => { closed = true })
  const sameClose = f.market.close()
  assert.equal(sameClose, f.market.close())
  assert.equal(signal?.aborted, false)
  await turn()
  assert.equal(closed, false)
  write.resolve()
  await turn()
  assert.equal(closed, false)
  socket.finishClose()
  await closing
  assert.equal(signal?.aborted, true)
  assert.equal(f.market.getTelemetry().confirmedEvents, 1)
  assert.equal(f.market.getState().status, 'disconnected')
  push(socket, raw(epoch + 300_000))
  await turn()
  assert.equal(f.forming.length, 0)
  assert.equal(f.clock.timers.size, 0)
})

test('native decoding preserves receive order and shutdown drains decoding and canceled recovery', async () => {
  const f = fixture()
  const socket = await f.open()
  const decoding = deferred<string>()
  socket.data({ text: () => decoding.promise })
  push(socket, raw(epoch, 102, 2))
  await turn()
  assert.equal(f.forming.length, 0)
  decoding.resolve(JSON.stringify({ arg: { channel: 'candle5m', instId: btc.instId }, data: [raw()] }))
  await f.market.whenIdle()
  assert.deepEqual(f.forming.map(candle => candle.volume), [1, 2])
  const pendingDecode = deferred<string>()
  socket.data({ text: () => pendingDecode.promise })
  await turn()
  let done = false
  const close = f.market.close().then(() => { done = true })
  await turn()
  assert.equal(done, false)
  pendingDecode.resolve('pong')
  await close

  const recovery = deferred()
  let recoverySignal: AbortSignal | undefined
  const r = fixture({ onReconnect: async (_subscriptions, context) => { recoverySignal = context.signal; await recovery.promise } })
  const first = await r.open()
  first.finishClose(1006)
  await r.clock.advance(1_000)
  r.sockets[1].open()
  await turn()
  let stopped = false
  const stop = r.market.close().then(() => { stopped = true })
  assert.equal(recoverySignal?.aborted, true)
  await turn()
  assert.equal(stopped, false)
  recovery.resolve()
  await stop
  assert.equal(r.clock.timers.size, 0)
})

test('repeated disconnects serialize repairs while the newest transport continues delivering candles', async t => {
  const firstRepair = deferred()
  let calls = 0, active = 0, maxActive = 0
  const signals: AbortSignal[] = []
  const f = fixture({ onReconnect: async (_subscriptions, context) => {
    calls++
    signals.push(context.signal)
    maxActive = Math.max(maxActive, ++active)
    if (calls === 1) await firstRepair.promise
    active--
  } })
  t.after(async () => { firstRepair.resolve(); await f.market.close() })
  const first = await f.open()
  first.finishClose(1006)
  await f.clock.advance(1_000)
  const second = f.sockets[1]
  second.open()
  await turn()
  assert.equal(calls, 1)
  second.finishClose(1006)
  await f.clock.advance(2_000)
  f.sockets[2].open()
  await turn()
  assert.equal(signals[0].aborted, true)
  assert.equal(calls, 1)
  push(f.sockets[2], raw(epoch, 103))
  await turn()
  assert.equal(f.market.getForming(btc.instId, btc.timeframe)?.close, 103)
  assert.equal(f.market.getState().status, 'live')
  firstRepair.resolve()
  await f.market.whenIdle()
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  assert.equal(f.market.getState().status, 'live')
})

test('250 ms input cadence has a bounded receive-to-callback budget under an injected clock', async () => {
  const clock = new Clock(), completed: number[] = []
  const f = fixture({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, onForming: async () => { await new Promise<void>(resolve => clock.setTimeout(resolve, 5)); completed.push(clock.now()) } })
  try {
    const socket = await f.open()
    for (let index = 0; index < 20; index++) clock.setTimeout(() => push(socket, raw(epoch, 100 + index / 10, index + 1)), index * 250)
    await clock.advance(5_000)
    await f.market.whenIdle()
    assert.equal(completed.length, 20)
    assert.equal(f.market.getTelemetry().pendingEvents, 0)
    assert.ok(f.market.getTelemetry().maxDispatchLatencyMs <= 1)
    assert.ok(f.market.getTelemetry().maxCallbackLatencyMs <= 5)
  } finally { await f.market.close() }
})
