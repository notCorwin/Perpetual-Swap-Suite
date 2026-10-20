import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { setImmediate } from 'node:timers/promises'
import { OKX_PUBLIC_WEBSOCKET_URL, RealtimePublicMarket } from '../electron/services/realtime-public-market.js'
import type { PublicMarketBook, RealtimePublicMarketOptions } from '../electron/services/realtime-public-market.js'
import type { RealtimeWebSocket } from '../electron/services/realtime-market.js'

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

const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'
const push = (socket: Socket, channel: string, data: unknown[], instId = btc, action?: string) => socket.message({ arg: { channel, instId }, data, ...(action ? { action } : {}) })
const level = (price: number, size = 1) => [String(price), String(size), '0', '1']
const book = (seqId: number, prevSeqId = -1, bids = [level(100), level(99)], asks = [level(101), level(102)]) => ({ seqId, prevSeqId, ts: '1800000000000', bids, asks })

function fixture(overrides: Partial<RealtimePublicMarketOptions> = {}) {
  const clock = new Clock(), sockets: Socket[] = [], urls: string[] = [], tickers: string[] = [], oi: string[] = [], books: PublicMarketBook[] = [], trades: unknown[] = [], errors: string[] = []
  const market = new RealtimePublicMarket({
    onTicker: (instId, raw) => { tickers.push(`${instId}:${raw.last}`) },
    onOpenInterest: (instId, raw) => { oi.push(`${instId}:${raw.oi}`) },
    onBook: (_instId, value) => { books.push(value) },
    onTrades: (_instId, value) => { trades.push(value) },
    webSocketFactory: url => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, reconnectJitter: 0,
    logger: { error: message => { errors.push(String(message)) } },
    ...overrides,
  })
  const open = async (instIds = [btc]) => {
    market.setSubscriptions(instIds)
    market.start()
    const expected = Math.ceil(new Set(instIds).size / 25)
    for (let index = 0; index < expected; index++) {
      if (!sockets[index]) await clock.advance(500)
      sockets[index].open()
    }
    await market.whenIdle()
    assert.equal(market.getState().status, 'live')
    return sockets[0]
  }
  return { market, clock, sockets, urls, tickers, oi, books, trades, errors, open }
}

test('all contracts subscribe to all four native channels concurrently in bounded requests', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const instIds = Array.from({ length: 350 }, (_, index) => `TOKEN${index}-USDT-SWAP`)
  await f.open(instIds)
  assert.equal(f.sockets.length, 14)
  assert.ok(f.urls.every(url => url === OKX_PUBLIC_WEBSOCKET_URL))
  assert.equal(OKX_PUBLIC_WEBSOCKET_URL, 'wss://ws.okx.com/ws/v5/public')
  const commands = f.sockets.flatMap(socket => socket.commands())
  assert.equal(commands.length, 14)
  assert.ok(commands.every(command => command.args.length <= 100 && Buffer.byteLength(JSON.stringify(command)) < 64 * 1024))
  for (const instId of instIds) assert.deepEqual(commands.flatMap(command => command.args).filter(arg => arg.instId === instId).map(arg => arg.channel).sort(), ['books', 'open-interest', 'tickers', 'trades'])
  f.market.setSubscriptions([...instIds, instIds[0]])
  assert.equal(f.sockets.flatMap(socket => socket.commands()).length, 14)
  assert.equal(f.market.instruments.size, 350)
  assert.equal(f.market.subscriptions.size, 1400)
  assert.ok(f.sockets.every(socket => new Set(socket.commands().flatMap(command => command.args).map(arg => arg.instId)).size === 25))
  push(f.sockets[0], 'tickers', [{ last: '100' }], instIds[0])
  push(f.sockets.at(-1)!, 'open-interest', [{ oi: '1000' }], instIds.at(-1))
  push(f.sockets[0], 'trades', [{ side: 'buy', sz: '3', tradeId: '1' }, { side: 'sell', sz: '4', tradeId: '2' }], instIds[20])
  await f.market.whenIdle()
  assert.deepEqual(f.tickers, [`${instIds[0]}:100`])
  assert.deepEqual(f.oi, [`${instIds.at(-1)}:1000`])
  assert.equal(f.trades.length, 1)
  assert.equal(f.market.getTelemetry().tradeEvents, 2)
})

test('order book snapshots replace all levels; updates insert, replace, delete and sort both sides', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const socket = await f.open()
  push(socket, 'books', [book(10)], btc, 'snapshot')
  push(socket, 'books', [book(11, 10, [level(100, 0), level(99, 8), level(98, 4)], [level(102, 0), level(100.5, 2)])], btc, 'update')
  // Empty updates with equal sequence IDs are OKX keepalive messages.
  push(socket, 'books', [book(11, 11, [], [])], btc, 'update')
  push(socket, 'books', [book(20, -1, [level(50)], [level(51)])], btc, 'snapshot')
  await f.market.whenIdle()
  assert.deepEqual(f.books[0].bids, [level(100), level(99)])
  assert.deepEqual(f.books[1].bids, [level(99, 8), level(98, 4)])
  assert.deepEqual(f.books[1].asks, [level(100.5, 2), level(101)])
  assert.deepEqual(f.books[2], f.books[1])
  assert.deepEqual(f.books[3].bids, [level(50)])
  assert.deepEqual(f.books[3].asks, [level(51)])
  assert.equal(f.market.getTelemetry().bookEvents, 4)
  assert.equal(f.market.getState().updatedAt, f.clock.time)
  assert.equal(f.books[0].bids[0][1], '1', 'later updates cannot mutate prior callback snapshots')
  assert.equal(f.books[1].asks[1], f.books[0].asks[0], 'Unchanged levels retain their immutable resident value.')
  assert.notEqual(f.books[1].bids[0], f.books[0].bids[1], 'A changed level has a new value and preserves the prior snapshot.')
  assert.notEqual(f.books[2].bids, f.books[1].bids, 'Each callback owns its side arrays.')
  assert.ok(f.books[2].bids.every((value, index) => value === f.books[1].bids[index]), 'Keepalive snapshots reuse every unchanged level.')
})

test('shared book levels reject mutations and isolate raw inputs and prior snapshots', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  await f.open()
  // Supply raw decoded levels directly to verify ownership at reconstruction,
  // independently of the transport's earlier JSON parsing copy.
  type Reconstructor = { connection: unknown; updateBook(connection: unknown, instId: string, action: string, raw: ReturnType<typeof book>): PublicMarketBook }
  const shard = (f.market as unknown as { shards: Reconstructor[] }).shards[0]
  const raw = book(1)
  const first = shard.updateBook(shard.connection, btc, 'snapshot', raw)
  assert.notEqual(first.bids[0], raw.bids[0])
  assert.equal(Object.isFrozen(raw.bids[0]), false, 'Installing a level must not freeze caller-owned input.')
  raw.bids[0][1] = '77'
  raw.asks[0][0] = '777'
  const changed = level(100, 8)
  const second = shard.updateBook(shard.connection, btc, 'update', book(2, 1, [changed], []))
  changed[1] = '88'
  assert.deepEqual(first.bids, [level(100), level(99)])
  assert.deepEqual(second.bids, [level(100, 8), level(99)])
  assert.deepEqual(second.asks, [level(101), level(102)])
  assert.notEqual(second.bids[0], first.bids[0])
  assert.equal(second.bids[1], first.bids[1])
  assert.equal(second.asks[0], first.asks[0])
  for (const snapshot of [first, second]) for (const side of [snapshot.bids, snapshot.asks]) for (const value of side) {
    assert.equal(Object.isFrozen(value), true)
    assert.throws(() => Object.assign(value, { 1: '999' }), TypeError)
  }
  first.bids.splice(0)
  second.asks[0] = level(999)
  const third = shard.updateBook(shard.connection, btc, 'update', book(2, 2, [], []))
  assert.deepEqual(third.bids, [level(100, 8), level(99)])
  assert.deepEqual(third.asks, [level(101), level(102)])
  assert.equal(third.bids[0], second.bids[0], 'A rejected consumer mutation cannot corrupt resident state.')
})

test('book depth stays at 400 levels and equivalent numeric price spellings replace the same level', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const socket = await f.open()
  const bids = Array.from({ length: 410 }, (_, i) => level(1000 - i)), asks = Array.from({ length: 410 }, (_, i) => level(1001 + i))
  push(socket, 'books', [book(1, -1, [...bids].reverse(), [...asks].reverse())], btc, 'snapshot')
  push(socket, 'books', [book(2, 1,
    [['1000.0', '9', '0', '1'], ['8.1e2', '3', '0', '1'], ['0601.0', '0'], ['1', '0']],
    [['1.201e3', '4', '0', '1'], ['1001.00', '0'], ['9999', '0']])], btc, 'update')
  await f.market.whenIdle()
  assert.deepEqual(f.books[0].bids, bids.slice(0, 400), 'updates preserve every level of the prior callback snapshot')
  assert.deepEqual(f.books[0].asks, asks.slice(0, 400))
  assert.deepEqual(f.books[1].bids, bids.slice(0, 399).map(value => value[0] === '1000' ? ['1000.0', '9', '0', '1'] : value[0] === '810' ? ['8.1e2', '3', '0', '1'] : value))
  assert.deepEqual(f.books[1].asks, asks.slice(1, 400).map(value => value[0] === '1201' ? ['1.201e3', '4', '0', '1'] : value))
})

test('new and reinserted prices restore priority and trim only the worst levels on both sides', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const socket = await f.open()
  const bids = Array.from({ length: 400 }, (_, i) => level(1000 - i)), asks = Array.from({ length: 400 }, (_, i) => level(1001 + i))
  push(socket, 'books', [book(1, -1, bids, asks)], btc, 'snapshot')
  push(socket, 'books', [book(2, 1,
    [level(600, 2), level(1000, 0), ['1000.0', '8', '0', '1'], level(601, 0), level(1000.5, 3)],
    [level(1401, 2), level(1001, 0), ['1001.0', '8', '0', '1'], level(1400, 0), level(1000.5, 3)])], btc, 'update')
  push(socket, 'books', [book(3, 2, [['1000.50', '0']], [['1.0005e3', '0']])], btc, 'update')
  await f.market.whenIdle()
  assert.deepEqual(f.books[0].bids, bids)
  assert.deepEqual(f.books[0].asks, asks)
  assert.deepEqual(f.books[1].bids, [level(1000.5, 3), ['1000.0', '8', '0', '1'], ...bids.slice(1, 399)])
  assert.deepEqual(f.books[1].asks, [level(1000.5, 3), ['1001.0', '8', '0', '1'], ...asks.slice(1, 399)])
  assert.deepEqual(f.books[2].bids, f.books[1].bids.slice(1), 'previously trimmed bids cannot reappear after deletion')
  assert.deepEqual(f.books[2].asks, f.books[1].asks.slice(1), 'previously trimmed asks cannot reappear after deletion')
})

test('a missing initial snapshot, sequence gap, reset or invalid level forces a fresh connection', async t => {
  for (const invalid of [
    { initial: false, value: book(2, 1) },
    { initial: true, value: book(12, 9) },
    { initial: true, value: book(2, 10) },
    { initial: true, value: book(11, 10, [['100', '-1']], []) },
  ]) {
    const f = fixture()
    t.after(() => f.market.close())
    const socket = await f.open()
    if (invalid.initial) push(socket, 'books', [book(10)], btc, 'snapshot')
    push(socket, 'books', [invalid.value], btc, 'update')
    await f.market.whenIdle()
    assert.equal(f.market.getState().status, 'reconnecting')
    assert.equal(f.market.getTelemetry().rejectedEvents, 1)
    assert.equal(f.books.length, invalid.initial ? 1 : 0)
    await f.clock.advance(1000)
    const replacement = f.sockets.at(-1)!
    replacement.open()
    await f.market.whenIdle()
    push(replacement, 'books', [book(100)], btc, 'snapshot')
    await f.market.whenIdle()
    assert.equal(f.books.at(-1)?.seqId, 100)
    assert.equal(f.market.getTelemetry().reconnects, 1)
  }
})

test('subscription generation rejects stale acknowledgements and late unsubscribed data', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  f.market.setSubscriptions([btc, eth])
  f.market.start()
  const socket = f.sockets[0]
  socket.autoAck = false
  socket.open()
  await f.market.whenIdle()
  const initial = socket.commands()[0]
  f.market.setSubscriptions([eth])
  f.market.setSubscriptions([btc, eth])
  const resubscription = socket.commands().at(-1)
  for (const arg of initial.args) socket.message({ id: initial.id, event: 'subscribe', arg })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'connecting')
  for (const arg of resubscription.args) socket.message({ id: resubscription.id, event: 'subscribe', arg })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  f.market.setSubscriptions([eth])
  push(socket, 'tickers', [{ last: '100' }])
  push(socket, 'tickers', [{ last: '200' }], eth)
  await f.market.whenIdle()
  assert.deepEqual(f.tickers, [`${eth}:200`])
  f.market.setSubscriptions([])
  assert.equal(f.market.getState().status, 'disconnected')
  await turn()
  assert.equal(socket.readyState, 3)
})

test('heartbeat and acknowledgement deadlines reconnect stalled transports', async t => {
  const f = fixture()
  t.after(() => f.market.close())
  const socket = await f.open()
  await f.clock.advance(15_000)
  assert.equal(socket.sent.at(-1), 'ping')
  socket.message('pong')
  await f.market.whenIdle()
  await f.clock.advance(15_000)
  assert.equal(socket.sent.at(-1), 'ping')
  await f.clock.advance(10_000)
  assert.equal(f.market.getState().status, 'reconnecting')
  assert.match(f.market.getState().error, /pong timed out/)
  await f.clock.advance(1000)
  const replacement = f.sockets.at(-1)!
  replacement.autoAck = false
  replacement.open()
  await f.market.whenIdle()
  await f.clock.advance(15_000)
  assert.match(f.market.getState().error, /acknowledgement timed out/)
})

test('reconnect waits for recovery, while independent streams can continue past a slow consumer', async t => {
  const repair = deferred(), repairBegan = deferred(), callback = deferred(), callbackBegan = deferred(), recovered: string[][] = []
  const f = fixture({
    onReconnect: async (instIds, { signal }) => { recovered.push(instIds); assert.equal(signal.aborted, false); repairBegan.resolve(); await repair.promise },
    onTicker: async instId => { if (instId === btc) { callbackBegan.resolve(); await callback.promise } },
  })
  t.after(() => f.market.close())
  const socket = await f.open([btc, eth])
  push(socket, 'tickers', [{ last: '100' }])
  push(socket, 'open-interest', [{ oi: '200' }], eth)
  await callbackBegan.promise
  await turn()
  assert.deepEqual(f.oi, [`${eth}:200`])
  socket.finishClose(1006)
  await f.clock.advance(1000)
  const replacement = f.sockets.at(-1)!
  replacement.open()
  await turn()
  assert.deepEqual(recovered, [], 'recovery waits for callbacks accepted on the old connection')
  callback.resolve()
  await repairBegan.promise
  push(replacement, 'open-interest', [{ oi: '300' }], eth)
  await turn()
  assert.deepEqual(f.oi, [`${eth}:200`])
  assert.equal(f.market.getState().status, 'reconnecting')
  repair.resolve()
  await f.market.whenIdle()
  assert.deepEqual(recovered, [[btc, eth]])
  assert.deepEqual(f.oi, [`${eth}:200`, `${eth}:300`])
  assert.equal(f.market.getState().status, 'live')
})

test('close aborts contexts, drains active callbacks and asynchronous decoding, and is idempotent', async () => {
  const callback = deferred(), began = deferred(), decode = deferred<string>()
  let signal: AbortSignal | undefined, closed = false
  const f = fixture({ onTicker: async (_instId, _raw, context) => { signal = context.signal; began.resolve(); await callback.promise } })
  const socket = await f.open()
  push(socket, 'tickers', [{ last: '100' }])
  await began.promise
  socket.data({ text: () => decode.promise })
  await turn()
  const closing = f.market.close()
  assert.equal(f.market.close(), closing)
  void closing.then(() => { closed = true })
  assert.equal(signal?.aborted, true)
  callback.resolve()
  await turn()
  assert.equal(closed, false)
  decode.resolve('pong')
  await closing
  assert.equal(closed, true)
  assert.equal(f.market.getState().status, 'disconnected')
  assert.equal(f.clock.timers.size, 0)
  assert.throws(() => f.market.start(), /closed/)
  assert.throws(() => f.market.setSubscriptions([btc]), /closed/)
})

test('shard reconnects are paced and disconnect/subscription callbacks identify exactly the affected contracts', async t => {
  const disconnected: string[][] = [], subscribed: string[] = [], starts: number[] = [], clock = new Clock(), sockets: Socket[] = []
  const f = fixture({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    webSocketFactory: () => { starts.push(clock.time); const socket = new Socket(); sockets.push(socket); return socket },
    onSubscribed: (instId, channel, context) => { assert.equal(context.signal.aborted, false); subscribed.push(`${instId}:${channel}`) },
    onDisconnect: (instIds, { signal }) => { assert.equal(signal.aborted, true); disconnected.push(instIds) },
  })
  t.after(() => f.market.close())
  const instIds = Array.from({ length: 60 }, (_, index) => `TOKEN${index}-USDT-SWAP`)
  f.market.setSubscriptions(instIds)
  f.market.start()
  assert.equal(sockets.length, 1)
  sockets[0].open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'connecting')
  await clock.advance(499)
  assert.equal(sockets.length, 1)
  await clock.advance(1)
  sockets[1].open()
  await clock.advance(500)
  sockets[2].open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  assert.equal(subscribed.length, 240)
  assert.deepEqual(starts.map(time => time - starts[0]), [0, 500, 1000])
  sockets[0].finishClose(1006)
  sockets[1].finishClose(1006)
  await f.market.whenIdle()
  assert.deepEqual(disconnected, [instIds.slice(0, 25), instIds.slice(25, 50)])
  assert.equal(f.market.getState().status, 'reconnecting')
  // The remaining socket continues dispatching while other shards reconnect.
  push(sockets[2], 'tickers', [{ last: '8' }], instIds[59])
  await f.market.whenIdle()
  assert.deepEqual(f.tickers, [`${instIds[59]}:8`])
  await clock.advance(1000)
  assert.equal(sockets.length, 4)
  sockets[3].open()
  await clock.advance(500)
  assert.equal(sockets.length, 5)
  sockets[4].open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  assert.equal(subscribed.length, 440)
  assert.ok(starts.slice(1).every((time, index) => time - starts[index] >= 500))
  f.market.setSubscriptions(instIds.slice(50))
  await f.market.whenIdle()
  assert.equal(f.market.instruments.size, 10)
  assert.equal(f.market.subscriptions.size, 40)
  assert.equal(f.market.getTelemetry().reconnects, 2)
  assert.equal(f.market.getTelemetry().tickerEvents, 1)
  assert.equal(f.market.getState().status, 'live')
})

test('global instruments acknowledgements use their SWAP namespace and bootstrap never blocks market or delta events', async t => {
  const bootstrap = deferred(), ready = deferred(), deltaSeen = deferred(), tickerSeen = deferred()
  const received: unknown[] = [], marketAcks: string[] = []
  let readiness = 0
  const f = fixture({
    onInstrumentsReady: async context => { readiness++; assert.equal(context.signal.aborted, false); assert.equal(context.receivedAt, f.clock.now()); ready.resolve(); await bootstrap.promise },
    onInstruments: (records, context) => { assert.equal(context.signal.aborted, false); received.push(records); deltaSeen.resolve() },
    onSubscribed: (instId, channel) => { marketAcks.push(`${instId}:${channel}`) },
    onTicker: () => { tickerSeen.resolve() },
  })
  t.after(() => f.market.close())
  f.market.setSubscriptions([btc])
  f.market.start()
  const socket = f.sockets[0]
  socket.autoAck = false
  socket.open()
  await f.market.whenIdle()
  const command = socket.commands()[0]
  assert.deepEqual(command.args.find((arg: { channel: string }) => arg.channel === 'instruments'), { channel: 'instruments', instType: 'SWAP' })
  for (const arg of command.args.filter((arg: { channel: string }) => arg.channel !== 'instruments')) socket.message({ id: command.id, event: 'subscribe', arg })
  socket.message({ id: command.id, event: 'subscribe', arg: { channel: 'instruments', instType: 'SPOT' } })
  socket.message({ id: 'obsolete', event: 'subscribe', arg: { channel: 'instruments', instType: 'SWAP' } })
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'connecting')
  assert.equal(readiness, 0)
  socket.message({ id: command.id, event: 'subscribe', arg: { channel: 'instruments', instType: 'SWAP' } })
  await ready.promise
  assert.equal(f.market.getState().status, 'live')
  socket.message({ id: command.id, event: 'subscribe', arg: { channel: 'instruments', instType: 'SWAP' } })
  socket.message({ arg: { channel: 'instruments', instType: 'SPOT' }, data: [{ instId: 'SPOT' }] })
  const updates = [{ instId: 'NEW-USDT-SWAP', state: 'live' }, { instId: btc, state: 'suspend' }]
  socket.message({ arg: { channel: 'instruments', instType: 'SWAP' }, data: updates })
  push(socket, 'tickers', [{ last: '100' }])
  await Promise.all([deltaSeen.promise, tickerSeen.promise])
  assert.equal(readiness, 1)
  assert.deepEqual(received, [updates])
  assert.equal(marketAcks.length, 4, 'Control acknowledgements never enter the instrument-specific market callback.')
  bootstrap.resolve()
  await f.market.whenIdle()
})

test('instruments control survives an empty universe, shares the first shard, and bootstraps again after reconnect', async t => {
  const readySignals: AbortSignal[] = [], disconnectSignals: AbortSignal[] = [], batches: unknown[] = [], disconnectedIDs: string[][] = []
  const f = fixture({
    onInstruments: records => { batches.push(records) },
    onInstrumentsReady: context => { readySignals.push(context.signal) },
    onInstrumentsDisconnect: context => { assert.equal(context.receivedAt, f.clock.now()); disconnectSignals.push(context.signal) },
    onDisconnect: ids => { disconnectedIDs.push(ids) },
  })
  t.after(() => f.market.close())
  f.market.start()
  const socket = f.sockets[0]
  socket.open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  assert.equal(f.market.instruments.size, 0)
  assert.deepEqual([...f.market.subscriptions.values()], [{ channel: 'instruments', instType: 'SWAP' }])
  assert.equal(readySignals.length, 1)
  f.market.setSubscriptions([btc])
  await f.market.whenIdle()
  assert.equal(f.sockets.length, 1)
  assert.equal(f.market.subscriptions.size, 5)
  assert.equal(readySignals.length, 1, 'Changing eligible IDs preserves the fixed control subscription.')
  f.market.setSubscriptions([])
  await f.market.whenIdle()
  assert.equal(socket.readyState, 1)
  assert.equal(f.market.subscriptions.size, 1)
  assert.equal(f.market.getState().status, 'live')
  const metadata = [{ instId: 'NEW-USDT-SWAP', state: 'live' }]
  socket.message({ arg: { channel: 'instruments', instType: 'SWAP' }, data: metadata })
  await f.market.whenIdle()
  assert.deepEqual(batches, [metadata])
  socket.finishClose(1006)
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'reconnecting')
  assert.equal(disconnectSignals.length, 1)
  assert.equal(disconnectSignals[0], readySignals[0])
  assert.equal(disconnectSignals[0].aborted, true)
  assert.deepEqual(disconnectedIDs, [[]], 'Control subscriptions must not introduce undefined instrument IDs.')
  await f.clock.advance(1000)
  const replacement = f.sockets.at(-1)!
  replacement.open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
  assert.equal(readySignals.length, 2)
  assert.equal(readySignals[1].aborted, false)
  assert.deepEqual(replacement.commands()[0].args, [{ channel: 'instruments', instType: 'SWAP' }])
})

test('instruments disconnect is delivered before acknowledgement and zero-ID close cancels all recovery', async () => {
  const disconnected: AbortSignal[] = []
  let readiness = 0
  const f = fixture({
    onInstruments: () => {},
    onInstrumentsReady: () => { readiness++ },
    onInstrumentsDisconnect: ({ signal }) => { disconnected.push(signal) },
  })
  f.market.start()
  const socket = f.sockets[0]
  socket.autoAck = false
  socket.open()
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'connecting')
  socket.finishClose(1006)
  await f.market.whenIdle()
  assert.equal(readiness, 0)
  assert.equal(disconnected.length, 1)
  assert.equal(disconnected[0].aborted, true)
  assert.equal(f.market.getState().status, 'reconnecting')
  await f.market.close()
  await f.clock.advance(30_000)
  assert.equal(f.sockets.length, 1)
  assert.equal(f.clock.timers.size, 0)
  assert.equal(f.market.getState().status, 'disconnected')
})

test('native event acknowledgement proof is captured at admission before queued callbacks run', async t => {
  const accepted: (boolean | undefined)[] = []
  const f = fixture({ onTicker: (_id, _value, context) => { accepted.push(context.acknowledged) } })
  t.after(() => f.market.close())
  f.market.setSubscriptions([btc]); f.market.start()
  const socket = f.sockets[0]
  socket.autoAck = false
  socket.open()
  await f.market.whenIdle()
  const command = socket.commands()[0]
  push(socket, 'tickers', [{ last: '100' }])
  for (const arg of command.args) socket.message({ id: command.id, event: 'subscribe', arg })
  push(socket, 'tickers', [{ last: '101' }])
  await f.market.whenIdle()
  assert.deepEqual(accepted, [false, true], 'Same-millisecond ACKs cannot retrospectively certify a pre-ACK event.')
})

test('same-socket removal notifies consumers synchronously without retiring healthy neighbors', async t => {
  const removed: string[] = []
  const f = fixture({ onUnsubscribed: (instId, channel, context) => { assert.equal(context.signal.aborted, false); removed.push(`${channel}:${instId}`) } })
  t.after(() => f.market.close())
  const socket = await f.open([btc, eth])
  f.market.setSubscriptions([eth])
  assert.equal(removed.length, 4)
  assert.ok(removed.every(value => value.endsWith(`:${btc}`)))
  assert.equal(socket.readyState, 1)
  await f.market.whenIdle()
  assert.equal(f.market.getState().status, 'live')
})
