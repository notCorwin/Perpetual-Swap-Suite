import assert from 'node:assert/strict'
import { eligibleInstrument } from '../electron/services/liquidity.js'
import { RealtimeMarket, OKX_BUSINESS_WEBSOCKET_URL } from '../electron/services/realtime-market.js'
import { RealtimePublicMarket, OKX_PUBLIC_WEBSOCKET_URL, PUBLIC_MARKET_CONTRACTS_PER_CONNECTION } from '../electron/services/realtime-public-market.js'

const TIMEOUT_MS = 30_000
const TIMEFRAMES = ['5m', '15m', '1H']
const CHANNELS = ['tickers', 'open-interest', 'books', 'trades']
const response = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP', { signal: AbortSignal.timeout(12_000) })
assert.equal(response.ok, true, `Instrument discovery returned HTTP ${response.status}.`)
const payload = await response.json()
assert.equal(payload.code, '0', `Instrument discovery failed: ${payload.msg}`)
assert.ok(Array.isArray(payload.data), 'Instrument discovery must return an array.')
const instIds = payload.data.filter(eligibleInstrument).map(instrument => instrument.instId).sort()
assert.ok(instIds.length > 0, 'No eligible live crypto USDT perpetuals were discovered.')

const observations = new Map(CHANNELS.map(channel => [channel, new Set()]))
const acknowledgements = new Map(CHANNELS.map(channel => [channel, new Set()]))
const candleSeries = new Set(), candleAcknowledgements = new Set()
const connections = new Map(), errors = []
const started = Date.now()
let formingEvents = 0, confirmedEvents = 0
let instrumentAcknowledgements = 0
const webSocketFactory = url => {
  connections.set(url, (connections.get(url) ?? 0) + 1)
  const socket = new WebSocket(url)
  // Candle transport marks live only after every matching subscription ack.
  // Also count the native acks for an independently inspectable smoke report.
  if (url === OKX_BUSINESS_WEBSOCKET_URL) socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data === 'pong') return
    try {
      const message = JSON.parse(event.data)
      if (message.event === 'subscribe') candleAcknowledgements.add(`${message.arg.channel}:${message.arg.instId}`)
    } catch { /* The transport reports malformed JSON and fails the smoke below. */ }
  })
  return socket
}
const logger = { error: (message, error) => { errors.push(`${message}${error instanceof Error ? ` ${error.message}` : ''}`) } }
const recordCandle = row => { candleSeries.add(`${row.timeframe}:${row.instrument}`) }
const candles = new RealtimeMarket({
  webSocketFactory,
  logger,
  parseCandle: (instrument, timeframe, raw) => ({
    instrument, timeframe, timestamp: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]),
    volume: Number(raw[5]), baseVolume: Number(raw[6]), quoteVolume: Number(raw[7]), confirmed: raw[8] === '1',
  }),
  onForming: row => { formingEvents++; recordCandle(row) },
  onConfirmed: row => { confirmedEvents++; recordCandle(row) },
  onReconnect: () => {},
})
const market = new RealtimePublicMarket({
  webSocketFactory,
  logger,
  onInstruments: () => {},
  onInstrumentsReady: () => { instrumentAcknowledgements++ },
  onSubscribed: (instId, channel) => { acknowledgements.get(channel).add(instId) },
  onTicker: instId => { observations.get('tickers').add(instId) },
  onOpenInterest: instId => { observations.get('open-interest').add(instId) },
  onBook: (instId, book) => {
    assert.ok(book.bids.length <= 400 && book.asks.length <= 400, 'Native depth must stay within 400 levels per side.')
    observations.get('books').add(instId)
  },
  onTrades: (instId, values) => { if (values.length) observations.get('trades').add(instId) },
})
const complete = () => market.getState().status === 'live' && candles.getState().status === 'live'
  && instrumentAcknowledgements === 1
  && ['tickers', 'open-interest', 'books'].every(channel => observations.get(channel).size === instIds.length)
  && CHANNELS.every(channel => acknowledgements.get(channel).size === instIds.length)
  && candleSeries.size === instIds.length * TIMEFRAMES.length
  && candleAcknowledgements.size === instIds.length * TIMEFRAMES.length

let poll, timeout
try {
  candles.setSubscriptions(instIds.flatMap(instId => TIMEFRAMES.map(timeframe => ({ instId, timeframe }))))
  market.setSubscriptions(instIds)
  // Start candles first; the public transport paces its own socket starts to
  // preserve one connection/second of the OKX IP limit for this business feed.
  candles.start()
  market.start()
  await new Promise(resolve => {
    poll = setInterval(() => { if (complete()) resolve() }, 100)
    timeout = setTimeout(resolve, TIMEOUT_MS)
  })
  clearInterval(poll)
  clearTimeout(timeout)
  await Promise.all([market.whenIdle(), candles.whenIdle()])
  const publicTelemetry = market.getTelemetry(), candleTelemetry = candles.getTelemetry()
  const summary = {
    integration: 'okx-all-contract-streams',
    elapsedMs: Date.now() - started,
    contracts: instIds.length,
    instrumentAcknowledgements,
    publicConnections: connections.get(OKX_PUBLIC_WEBSOCKET_URL) ?? 0,
    expectedPublicConnections: Math.ceil(instIds.length / PUBLIC_MARKET_CONTRACTS_PER_CONNECTION),
    candleConnections: connections.get(OKX_BUSINESS_WEBSOCKET_URL) ?? 0,
    publicState: market.getState().status,
    candleState: candles.getState().status,
    channels: Object.fromEntries(CHANNELS.map(channel => [channel, { observed: observations.get(channel).size, acknowledged: acknowledgements.get(channel).size }])),
    candleSeries: { observed: candleSeries.size, acknowledged: candleAcknowledgements.size, expected: instIds.length * TIMEFRAMES.length, formingEvents, confirmedEvents },
    publicTelemetry,
    candleTelemetry,
    errors,
  }
  console.log(JSON.stringify(summary, null, 2))
  const missing = Object.fromEntries(['tickers', 'open-interest', 'books'].map(channel => [channel, instIds.filter(instId => !observations.get(channel).has(instId))]))
  assert.equal(complete(), true, `Streams did not cover every eligible contract within ${TIMEOUT_MS}ms. Missing native snapshots: ${JSON.stringify(missing)}`)
  assert.equal(summary.publicConnections, summary.expectedPublicConnections)
  assert.equal(summary.candleConnections, 1)
  assert.equal(publicTelemetry.rejectedEvents + candleTelemetry.rejectedEvents, 0, 'Native events must pass payload and order-book sequence validation.')
  assert.equal(publicTelemetry.reconnects + candleTelemetry.reconnects, 0, 'The smoke must complete without connection recovery.')
  assert.deepEqual(errors, [], 'The native transports must not report errors.')
  // A contract can legitimately have no fills during this short window. Trades
  // require every native subscription acknowledgement, not an invented event.
} finally {
  clearInterval(poll)
  clearTimeout(timeout)
  await Promise.all([market.close(), candles.close()])
}
