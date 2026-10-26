import assert from 'node:assert/strict'
import { eligibleInstrument } from '../electron/services/liquidity.js'
import { RealtimeMarket, OKX_BUSINESS_WEBSOCKET_URL } from '../electron/services/realtime-market.js'
import { RealtimePublicMarket, OKX_PUBLIC_WEBSOCKET_URL, PUBLIC_MARKET_CONTRACTS_PER_CONNECTION } from '../electron/services/realtime-public-market.js'

const TIMEOUT_MS = 30_000
const STREAM_SAMPLE_MS = 5_000
const TIMEFRAMES = ['5m']
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
const receiptTimes = new Map([...CHANNELS, 'candle5m'].map(channel => [channel, new Map()]))
let sampleStartedAt = null, sampleEndedAt = null
const recordReceipt = (channel, instId, receivedAt) => {
  if (sampleStartedAt === null) return
  if (Number.isSafeInteger(receivedAt) && (receivedAt < sampleStartedAt || sampleEndedAt !== null && receivedAt > sampleEndedAt)) return
  const values = receiptTimes.get(channel).get(instId) ?? []
  values.push(Number.isSafeInteger(receivedAt) ? receivedAt : null)
  receiptTimes.get(channel).set(instId, values)
}
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
const recordCandle = (row, context) => {
  candleSeries.add(`${row.timeframe}:${row.instrument}`)
  recordReceipt(`candle${row.timeframe}`, row.instrument, context?.receivedAt)
}
const candles = new RealtimeMarket({
  webSocketFactory,
  logger,
  parseCandle: (instrument, timeframe, raw) => ({
    instrument, timeframe, timestamp: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]), low: Number(raw[3]), close: Number(raw[4]),
    volume: Number(raw[5]), baseVolume: Number(raw[6]), quoteVolume: Number(raw[7]), confirmed: raw[8] === '1',
  }),
  onForming: (row, context) => { formingEvents++; recordCandle(row, context) },
  onConfirmed: (row, context) => { confirmedEvents++; recordCandle(row, context) },
  onReconnect: () => {},
})
const market = new RealtimePublicMarket({
  webSocketFactory,
  logger,
  onInstruments: () => {},
  onInstrumentsReady: () => { instrumentAcknowledgements++ },
  onSubscribed: (instId, channel) => { acknowledgements.get(channel).add(instId) },
  onTicker: (instId, _value, context) => { observations.get('tickers').add(instId); recordReceipt('tickers', instId, context?.receivedAt) },
  onOpenInterest: (instId, _value, context) => { observations.get('open-interest').add(instId); recordReceipt('open-interest', instId, context?.receivedAt) },
  onBook: (instId, book, context) => {
    assert.ok(book.bids.length <= 400 && book.asks.length <= 400, 'Native depth must stay within 400 levels per side.')
    observations.get('books').add(instId)
    recordReceipt('books', instId, context?.receivedAt)
  },
  onTrades: (instId, values, context) => {
    recordReceipt('trades', instId, context?.receivedAt)
    if (values.length) observations.get('trades').add(instId)
  },
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
  assert.equal(complete(), true, `Native streams did not connect and produce initial snapshots within ${TIMEOUT_MS}ms.`)
  sampleStartedAt = Date.now()
  await new Promise(resolve => setTimeout(resolve, STREAM_SAMPLE_MS))
  sampleEndedAt = Date.now()
  await Promise.all([market.whenIdle(), candles.whenIdle()])
  const publicTelemetry = market.getTelemetry(), candleTelemetry = candles.getTelemetry()
  const receiptEvidence = Object.fromEntries([...CHANNELS, 'candle5m'].map(channel => [channel,
    instIds.map(instId => {
      const receivedAtTimestamps = receiptTimes.get(channel).get(instId) ?? []
      const validTimestamps = receivedAtTimestamps.filter(Number.isSafeInteger)
      const complete = validTimestamps.length === receivedAtTimestamps.length
      const boundaries = complete ? [sampleStartedAt, ...validTimestamps, sampleEndedAt] : []
      const intervals = boundaries.slice(1).map((value, index) => ({ from: boundaries[index], to: value, intervalMS: value - boundaries[index] }))
      const maximum = complete ? intervals.reduce((best, value) => value.intervalMS > best.intervalMS ? value : best,
        { from: sampleStartedAt, to: sampleStartedAt, intervalMS: 0 }) : null
      return { instId, sampleMessages: receivedAtTimestamps.length, receivedAtTimestamps,
        timestampUnavailableCount: receivedAtTimestamps.length - validTimestamps.length,
        firstReceivedAt: validTimestamps[0] ?? null, lastReceivedAt: validTimestamps.at(-1) ?? null,
        maxIntervalMS: maximum?.intervalMS ?? null, maxIntervalFrom: maximum?.from ?? null, maxIntervalTo: maximum?.to ?? null }
    })]))
  const summary = {
    integration: 'okx-native-stream-connectivity',
    scope: 'Direct transport connectivity smoke. Production app demand and locally derived 15m/1H behavior are gated by the loopback market traffic benchmark.',
    elapsedMs: Date.now() - started,
    sample: { startedAt: sampleStartedAt, endedAt: sampleEndedAt, durationMs: sampleEndedAt - sampleStartedAt, streamSampleMs: STREAM_SAMPLE_MS },
    contracts: instIds.length,
    instrumentAcknowledgements,
    publicConnections: connections.get(OKX_PUBLIC_WEBSOCKET_URL) ?? 0,
    expectedPublicConnections: Math.ceil(instIds.length / PUBLIC_MARKET_CONTRACTS_PER_CONNECTION),
    candleConnections: connections.get(OKX_BUSINESS_WEBSOCKET_URL) ?? 0,
    publicState: market.getState().status,
    candleState: candles.getState().status,
    channels: Object.fromEntries(CHANNELS.map(channel => [channel, { observed: observations.get(channel).size, acknowledged: acknowledgements.get(channel).size }])),
    receipts: receiptEvidence,
    trades: { fillsObservedFor: observations.get('trades').size, fillEvents: publicTelemetry.tradeEvents,
      noFillAllowed: true, subscriptionAcknowledgementsRequired: instIds.length },
    candleSeries: { observed: candleSeries.size, acknowledged: candleAcknowledgements.size, expected: instIds.length * TIMEFRAMES.length, timeframes: TIMEFRAMES, formingEvents, confirmedEvents },
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
