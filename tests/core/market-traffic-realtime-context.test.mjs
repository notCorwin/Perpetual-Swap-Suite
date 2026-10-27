import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeMarket } from '../../electron/services/realtime-market.js'
import { RealtimePublicMarket } from '../../electron/services/realtime-public-market.js'
import { marketTrafficPayloadIdentity, monotonicMicroseconds } from '../../electron/services/market-traffic-callback-probe.js'

class FakeSocket {
  constructor() { this.readyState = 1; this.listeners = new Map(); this.subscription = null }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener) }
  emit(name, event) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
  send(text) {
    const command = JSON.parse(text)
    if (command.op !== 'subscribe') return
    for (const subscription of command.args) queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({ id: command.id, event: 'subscribe', arg: subscription }),
    }))
  }
  close() { this.readyState = 3; this.emit('close', { code: 1000 }) }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(predicate(), true, 'Realtime fixture did not reach the expected callback state.')
}

test('native candle ingress time and identity reach the fulfilled realtime callback unchanged', async t => {
  const instId = 'BTC-USDT-SWAP', socket = new FakeSocket(), ingressEvents = []
  let callbackContext = null, callbackEntryUS = null, callbackAcceptedUS = null
  const timestamp = Math.floor(Date.now() / 300_000) * 300_000
  const raw = [timestamp, 100, 101, 99, 100, 10, 10, 1_000, '0'].map(String)
  const realtime = new RealtimeMarket({
    webSocketFactory: () => socket,
    parseCandle: (instrument, timeframe, values) => ({ instrument, timeframe, timestamp: Number(values[0]), open: Number(values[1]),
      high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]),
      baseVolume: Number(values[6]), quoteVolume: Number(values[7]), confirmed: values[8] === '1' }),
    onForming: async (_candle, context) => {
      callbackContext = context
      callbackEntryUS = monotonicMicroseconds()
      await new Promise(resolve => setTimeout(resolve, 2))
      callbackAcceptedUS = monotonicMicroseconds()
    },
    onConfirmed: () => {},
    onReconnect: () => {},
    onMarketTrafficIngress: (events, costUS) => ingressEvents.push({ events, costUS }),
    logger: { error() {} },
  })
  t.after(() => realtime.close())
  realtime.setSubscriptions([{ instId, timeframe: '5m' }])
  realtime.start()
  await waitFor(() => realtime.isSubscribed(instId, '5m'))
  const handlerCallAtUS = monotonicMicroseconds()
  socket.emit('message', { data: JSON.stringify({ arg: { channel: 'candle5m', instId }, data: [raw] }) })
  await waitFor(() => callbackContext !== null && callbackAcceptedUS !== null)
  await realtime.whenIdle()

  const expected = marketTrafficPayloadIdentity('candle5m', instId, raw)
  assert.equal(ingressEvents.length, 1)
  assert.equal(ingressEvents[0].events.length, 1)
  assert.ok(Number.isSafeInteger(ingressEvents[0].events[0].nativeHandlerEnteredAtMonotonicUS))
  assert.ok(ingressEvents[0].events[0].nativeHandlerEnteredAtMonotonicUS >= handlerCallAtUS)
  assert.ok(ingressEvents[0].costUS >= 0)
  assert.deepEqual(callbackContext.marketTrafficEvents[0], ingressEvents[0].events[0])
  assert.equal(callbackContext.marketTrafficEvents[0].payloadFingerprint, expected.payloadFingerprint)
  assert.ok(callbackEntryUS >= callbackContext.marketTrafficEvents[0].nativeHandlerEnteredAtMonotonicUS)
  assert.ok(callbackAcceptedUS >= callbackEntryUS)
})

test('native ticker ingress time and identity reach the public market callback unchanged', async t => {
  const instId = 'BTC-USDT-SWAP', socket = new FakeSocket(), ingressEvents = []
  let callbackContext = null, callbackEntryUS = null, callbackAcceptedUS = null
  const ticker = { instId, last: '100', bidPx: '99.99', askPx: '100', open24h: '98', high24h: '101', low24h: '97',
    volCcy24h: '200', vol24h: '2', ts: String(Date.now()) }
  const realtime = new RealtimePublicMarket({
    webSocketFactory: () => socket,
    onTicker: async (_id, _ticker, context) => {
      callbackContext = context
      callbackEntryUS = monotonicMicroseconds()
      await new Promise(resolve => setTimeout(resolve, 2))
      callbackAcceptedUS = monotonicMicroseconds()
    },
    onOpenInterest: () => {}, onBook: () => {}, onTrades: () => {},
    onMarketTrafficIngress: (events, costUS) => ingressEvents.push({ events, costUS }),
    logger: { error() {} },
  })
  t.after(() => realtime.close())
  realtime.setSubscriptions([instId], { books: false, trades: false })
  realtime.start()
  await waitFor(() => realtime.getState().status === 'live')
  const handlerCallAtUS = monotonicMicroseconds()
  socket.emit('message', { data: JSON.stringify({ arg: { channel: 'tickers', instId }, data: [ticker] }) })
  await waitFor(() => callbackContext !== null && callbackAcceptedUS !== null)
  await realtime.whenIdle()

  const expected = marketTrafficPayloadIdentity('tickers', instId, ticker)
  assert.equal(ingressEvents.length, 1)
  assert.equal(ingressEvents[0].events.length, 1)
  assert.ok(ingressEvents[0].events[0].nativeHandlerEnteredAtMonotonicUS >= handlerCallAtUS)
  assert.deepEqual(callbackContext.marketTrafficEvents[0], ingressEvents[0].events[0])
  assert.equal(callbackContext.marketTrafficEvents[0].payloadFingerprint, expected.payloadFingerprint)
  assert.ok(callbackEntryUS >= callbackContext.marketTrafficEvents[0].nativeHandlerEnteredAtMonotonicUS)
  assert.ok(callbackAcceptedUS >= callbackEntryUS)
})
