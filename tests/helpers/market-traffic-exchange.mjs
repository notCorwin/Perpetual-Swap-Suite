import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { marketTrafficPayloadIdentity, monotonicMicroseconds } from '../../electron/services/market-traffic-callback-probe.js'
import { ownFixtureServer } from './fixture-server.mjs'

export const marketTrafficIntervals = Object.freeze({ '5m': 300_000, '15m': 900_000, '1H': 3_600_000 })
const publicChannels = new Set(['tickers', 'open-interest', 'books', 'trades'])
const businessChannels = new Set(Object.keys(marketTrafficIntervals).map(timeframe => `candle${timeframe}`))
const frame = (value, opcode = 1) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (body.length < 126) header[1] = body.length
  else if (body.length < 65536) { header[1] = 126; header.writeUInt16BE(body.length, 2) }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2) }
  return Buffer.concat([header, body])
}
const keyFor = arg => `${arg.channel}:${arg.instId ?? arg.instType}`
const httpChannel = path => {
  if (path === '/public/instruments') return 'instruments'
  if (path === '/market/tickers' || path === '/market/ticker') return 'tickers'
  if (path === '/public/open-interest') return 'open-interest'
  if (path === '/market/books') return 'books'
  if (path === '/market/candles' || path === '/market/history-candles') return 'candles'
  if (path === '/rubik/stat/contracts/open-interest-history') return 'statistics-open-interest'
  if (path === '/rubik/stat/taker-volume-contract') return 'statistics-taker'
  return 'other'
}
const rawCandle = row => [row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume,
  row.quoteVolume, row.confirmed ? '1' : '0'].map(String)

function tally() { return { messages: 0, payloadBytes: 0 } }
function addTally(target, channel, bytes) {
  const value = target[channel] ??= tally()
  value.messages++
  value.payloadBytes += bytes
}

/**
 * Deterministic, loopback-only OKX protocol fixture. The app still uses its
 * production HTTP parser, WebSocket transports, subscription code and market
 * qualification path. Values are stable across runs; source timestamps are
 * current so the app's accepted observation path sees current live-feed values.
 */
export async function createMarketTrafficExchange({ candidateCount = 50, passingCount = 6, spreadFailureCount = 22, seed = 1, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ candidateCount, passingCount, spreadFailureCount, seed })) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a nonnegative safe integer.`)
  }
  assert.ok(candidateCount >= 3 && candidateCount <= 100, 'candidateCount must be between 3 and 100.')
  assert.ok(passingCount > 0 && passingCount < candidateCount, 'The fixture needs passing and failing candidates.')
  assert.ok(spreadFailureCount <= candidateCount - passingCount, 'Too many spread failures.')
  const oiFailureCount = candidateCount - passingCount - spreadFailureCount
  assert.ok(oiFailureCount > 0, 'The fixture needs at least one open-interest failure.')
  const asOf = now()
  const instIds = Array.from({ length: candidateCount }, (_, index) => `T${String(index).padStart(3, '0')}-USDT-SWAP`)
  const kinds = new Map(instIds.map((instId, index) => [instId, index < passingCount ? 'pass'
    : index < passingCount + spreadFailureCount ? 'spread' : 'openInterest']))
  const instrumentById = new Map(instIds.map((instId, index) => {
    const base = instId.split('-')[0]
    return [instId, { instId, instType: 'SWAP', instCategory: '1', ctType: 'linear', settleCcy: 'USDT', state: 'live',
      ctVal: '1', ctMult: '1', ctValCcy: base, ruleType: 'normal', listTime: String(asOf - 500 * marketTrafficIntervals['1H']),
      tickSz: '0.01', lotSz: '1', minSz: '1', instFamily: 'T-USDT', index }]
  }))
  const tickerFor = (instId, messageTick = 0, timestamp = now()) => {
    const index = instrumentById.get(instId)?.index ?? 0
    const kind = kinds.get(instId) ?? 'pass'
    const last = 100 + index + messageTick * 0.001
    const bid = last - 0.01, ask = kind === 'spread' ? last + 0.2 : last
    return { instId, last: String(last), bidPx: String(bid), askPx: String(ask), open24h: String(100 + index),
      high24h: String(last + 2), low24h: String(last - 2), volCcy24h: '500000', vol24h: '500000', ts: String(timestamp) }
  }
  const openInterestFor = (instId, timestamp = now()) => {
    const index = instrumentById.get(instId)?.index ?? 0
    const low = kinds.get(instId) === 'openInterest'
    return { instId, oi: low ? '10000' : '100000', oiUsd: low ? '1000000' : '10000000', ts: String(timestamp) }
  }
  const bookFor = (instId, timestamp = now()) => {
    const ticker = tickerFor(instId)
    return { instId, bids: [[ticker.bidPx, '100000']], asks: [[ticker.askPx, '100000']], ts: String(timestamp) }
  }
  const confirmedCandle = (instId, timeframe, timestamp) => {
    const close = 100 + instrumentById.get(instId).index
    const quoteVolume = timeframe === '5m' ? 125_000 : timeframe === '15m' ? 375_000 : 1_500_000
    return { instrument: instId, timeframe, timestamp, open: close, high: close + 1, low: close - 1, close,
      volume: quoteVolume / close, baseVolume: quoteVolume / close, quoteVolume, confirmed: true }
  }
  const instruments = instIds.map(instId => { const { index, ...instrument } = instrumentById.get(instId); return instrument })
  const clients = new Set(), requests = [], errors = [], sentByChannel = {}, acknowledgements = {}, deliveries = {}, lastDelivery = {}, latestValues = {}, bookSequences = new Map(), bookFrames = []
  const window = { active: false, startedAt: null, endedAt: null, startedAtMonotonicUS: null, endedAtMonotonicUS: null,
    ws: {}, http: {}, ack: {}, deliveries: {}, deliveryTimestamps: {}, events: [], rounds: [] }
  let tick = 0, cadenceRound = 0, cadenceTimer = null, cadenceIntervalMS = null, sampleStartWaiter = null, currentRoundEvidence = null
  const streamSequences = new Map()
  const latestCounter = (channel, instId) => {
    const key = `${channel}:${instId}`
    deliveries[key] = (deliveries[key] ?? 0) + 1
    lastDelivery[key] = now()
    if (window.active) {
      const channelCounts = window.deliveries[channel] ??= {}
      channelCounts[instId] = (channelCounts[instId] ?? 0) + 1
      const channelTimes = window.deliveryTimestamps[channel] ??= {}
      const timestamps = channelTimes[instId] ??= []
      timestamps.push(now())
    }
  }
  const sendText = (client, value, channel, kind = 'data', roundId = cadenceRound) => {
    if (client.socket.destroyed) return false
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const bytes = Buffer.byteLength(text)
    const sidecar = kind === 'data' && window.active && currentRoundEvidence && Array.isArray(value?.data)
      ? value.data.map(payload => ({
        ...(marketTrafficPayloadIdentity(channel, value.arg?.instId, payload)
          ?? { channel, instId: value.arg?.instId ?? null, identity: null, payloadFingerprint: null }),
        roundId, sequence: 0, sentAt: now(),
      })) : []
    const sentAtMonotonicUS = sidecar.length ? monotonicMicroseconds() : null
    client.socket.write(frame(text))
    for (const event of sidecar) {
      const stream = `${event.channel}:${event.instId}`
      event.sequence = (streamSequences.get(stream) ?? 0) + 1
      event.sentAtMonotonicUS = sentAtMonotonicUS
      streamSequences.set(stream, event.sequence)
      window.events.push(event)
      currentRoundEvidence.events.push(event)
    }
    addTally(sentByChannel, channel, bytes)
    if (window.active) addTally(window.ws, channel, bytes)
    if (kind === 'ack' && window.active) addTally(window.ack, channel, bytes)
    return true
  }
  const sendJSON = (response, path, data, requestRecord) => {
    const body = JSON.stringify({ code: '0', data })
    const bytes = Buffer.byteLength(body)
    requestRecord.responsePayloadBytes = bytes
    requestRecord.responseChannel = httpChannel(path)
    if (window.active) addTally(window.http, requestRecord.responseChannel, bytes)
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(body)
  }
  const responseCandleRows = (instId, timeframe, url, path) => {
    const interval = marketTrafficIntervals[timeframe]
    if (!interval || !instrumentById.has(instId)) return []
    const initialCount = timeframe === '5m' ? 288 : 300
    const from = Math.floor(asOf / interval) * interval - initialCount * interval
    const end = Math.floor(now() / interval) * interval
    const source = Array.from({ length: (end - from) / interval }, (_, index) => confirmedCandle(instId, timeframe, from + index * interval))
    const after = Number(url.searchParams.get('after')) || Infinity
    const before = Number(url.searchParams.get('before')) || -Infinity
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 100))
    const values = source.filter(row => row.timestamp < after && row.timestamp > before)
      .toSorted((left, right) => right.timestamp - left.timestamp).slice(0, limit).map(rawCandle)
    if (path !== '/market/candles') return values
    const timestamp = Math.floor(now() / interval) * interval, index = instrumentById.get(instId).index
    const close = 100 + index
    const forming = [timestamp, close, close + 1, close - 1, close, 100, 100, 10_000, '0'].map(String)
    return [forming, ...values].slice(0, limit)
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/v5/')) {
      errors.push(`Unexpected fixture HTTP request: ${request.method} ${request.url}`)
      response.writeHead(400).end()
      return
    }
    const path = url.pathname.replace(/^\/api\/v5/, ''), params = Object.fromEntries(url.searchParams)
    const record = { path, parameters: params, receivedAt: now(), responsePayloadBytes: 0 }
    requests.push(record)
    response.once('finish', () => { record.respondedAt = now() })
    if (path === '/public/instruments') return sendJSON(response, path, instruments, record)
    if (path === '/market/tickers') return sendJSON(response, path, instIds.map(instId => tickerFor(instId)), record)
    if (path === '/market/ticker') {
      if (!instrumentById.has(params.instId)) return sendJSON(response, path, [], record)
      return sendJSON(response, path, [tickerFor(params.instId)], record)
    }
    if (path === '/public/open-interest') {
      const selected = params.instType ? instIds : [params.instId]
      return sendJSON(response, path, selected.filter(id => instrumentById.has(id)).map(id => openInterestFor(id)), record)
    }
    if (path === '/market/books') {
      const value = bookFor(params.instId)
      return sendJSON(response, path, value.instId ? [value] : [], record)
    }
    if (path === '/market/history-candles' || path === '/market/candles') {
      return sendJSON(response, path, responseCandleRows(params.instId, params.bar, url, path), record)
    }
    if (path === '/rubik/stat/contracts/open-interest-history' || path === '/rubik/stat/taker-volume-contract') {
      const interval = marketTrafficIntervals[params.period]
      if (!interval || !instrumentById.has(params.instId)) return sendJSON(response, path, [], record)
      const from = Number(params.begin) + interval, through = Number(params.end) - interval
      const low = kinds.get(params.instId) === 'openInterest', rows = []
      for (let timestamp = Math.ceil(from / interval) * interval; timestamp <= through; timestamp += interval) {
        rows.push(path.endsWith('open-interest-history')
          ? [String(timestamp), low ? '10000' : '100000']
          : [String(timestamp), '100', '200'])
      }
      return sendJSON(response, path, rows, record)
    }
    errors.push(`Unexpected fixture HTTP endpoint: ${request.url}`)
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'fixture-error', msg: 'Unsupported loopback fixture endpoint.', data: [] }))
  })
  const ownedServer = ownFixtureServer(server)
  const snapshotFor = arg => {
    const { channel, instId } = arg
    if (channel === 'instruments') return instruments.map(({ index, ...row }) => row)
    if (channel === 'tickers') return [tickerFor(instId)]
    if (channel === 'open-interest') return [openInterestFor(instId)]
    if (channel === 'books') {
      const value = bookFor(instId)
      return [{ bids: value.bids.map(([price, size]) => [price, size, '0', '1']), asks: value.asks.map(([price, size]) => [price, size, '0', '1']),
        seqId: 1, prevSeqId: -1, ts: value.ts }]
    }
    if (channel === 'trades') return [{ instId, tradeId: String(instrumentById.get(instId).index + 1), ts: String(now()), side: 'buy', sz: '10', px: '100', count: '1' }]
    if (businessChannels.has(channel)) {
      const timeframe = [...Object.keys(marketTrafficIntervals)].find(value => `candle${value}` === channel)
      const interval = marketTrafficIntervals[timeframe], timestamp = Math.floor(now() / interval) * interval
      const close = 100 + instrumentById.get(instId).index
      return [[timestamp, close, close + 1, close - 1, close, 100, 100, 10_000, '0'].map(String)]
    }
    return []
  }
  const sendSubscribed = (client, arg, currentTick = tick, forceBookSnapshot = false) => {
    if (arg.channel === 'instruments') {
      const rows = snapshotFor(arg)
      sendText(client, { arg, action: 'snapshot', data: rows }, arg.channel)
      return
    }
    const instId = arg.instId
    if (!instrumentById.has(instId)) { errors.push(`WebSocket subscribed to unknown instrument: ${instId}`); return }
    const timestamp = now()
    let sent = false
    if (arg.channel === 'tickers') {
      const value = tickerFor(instId, currentTick, timestamp)
      latestValues[`${arg.channel}:${instId}`] = value
      sent = sendText(client, { arg, data: [value] }, arg.channel)
    } else if (arg.channel === 'open-interest') {
      const value = openInterestFor(instId, timestamp)
      latestValues[`${arg.channel}:${instId}`] = value
      sent = sendText(client, { arg, data: [value] }, arg.channel)
    }
    else if (arg.channel === 'books') {
      const book = bookFor(instId, timestamp)
      const snapshot = forceBookSnapshot || !bookSequences.has(instId)
      const previousSequence = bookSequences.get(instId)
      const seqId = snapshot ? 1 : previousSequence + 1
      const prevSeqId = snapshot ? -1 : previousSequence
      const value = { bids: book.bids.map(([price, size]) => [price, size, '0', '1']),
        asks: book.asks.map(([price, size]) => [price, size, '0', '1']), seqId, prevSeqId, ts: book.ts }
      const action = snapshot ? 'snapshot' : 'update'
      bookSequences.set(instId, seqId)
      bookFrames.push({ instId, action, seqId, prevSeqId, bids: value.bids.length, asks: value.asks.length })
      latestValues[`${arg.channel}:${instId}`] = value
      sent = sendText(client, { arg, action, data: [value] }, arg.channel)
    } else if (arg.channel === 'trades') {
      const value = { instId, tradeId: String(currentTick + 1), ts: String(timestamp), side: currentTick % 2 ? 'sell' : 'buy', sz: '10', px: '100', count: '1' }
      latestValues[`${arg.channel}:${instId}`] = value
      sent = sendText(client, { arg, data: [value] }, arg.channel)
    } else if (businessChannels.has(arg.channel)) {
      const timeframe = [...Object.keys(marketTrafficIntervals)].find(value => `candle${value}` === arg.channel)
      const interval = marketTrafficIntervals[timeframe], period = Math.floor(timestamp / interval) * interval, index = instrumentById.get(instId).index
      const key = keyFor(arg), previous = client.candlePeriods.get(key)
      // A real stream confirms the elapsed candle before publishing the next
      // forming candle. HTTP recovery must expose the same completed values.
      if (previous !== undefined) for (let closed = previous; closed < period; closed += interval) {
        const row = rawCandle(confirmedCandle(instId, timeframe, closed))
        if (sendText(client, { arg, data: [row] }, arg.channel)) latestCounter(arg.channel, instId)
      }
      client.candlePeriods.set(key, period)
      const close = 100 + index + currentTick * 0.001, volume = 100 + currentTick, quoteVolume = volume * close
      const row = [period, close, close + 1, close - 1, close, volume, volume, quoteVolume, '0'].map(String)
      latestValues[`${arg.channel}:${instId}`] = row
      sent = sendText(client, { arg, data: [row] }, arg.channel)
    }
    if (sent) latestCounter(arg.channel, instId)
  }
  const receiveText = (client, text) => {
    if (text === 'ping') { sendText(client, 'pong', 'control'); return }
    let command
    try { command = JSON.parse(text) } catch { errors.push('Malformed WebSocket command JSON.'); return }
    if (!['subscribe', 'unsubscribe'].includes(command.op) || !Array.isArray(command.args)) {
      errors.push('Unexpected WebSocket command shape.')
      return
    }
    for (const arg of command.args) {
      const allowed = client.path === '/ws/v5/public' ? publicChannels.has(arg.channel) || arg.channel === 'instruments'
        : businessChannels.has(arg.channel)
      if (!allowed || (arg.channel !== 'instruments' && !instrumentById.has(arg.instId))) {
        errors.push(`Unsupported ${client.path} subscription: ${JSON.stringify(arg)}`)
        continue
      }
      const key = keyFor(arg)
      if (command.op === 'subscribe') {
        client.subscriptions.set(key, arg)
        const current = acknowledgements[arg.channel] ??= new Set()
        current.add(key)
      } else {
        client.subscriptions.delete(key)
        acknowledgements[arg.channel]?.delete(key)
      }
    }
    for (const arg of command.args) {
      if (command.op === 'subscribe' && !client.subscriptions.has(keyFor(arg))) continue
      sendText(client, { id: command.id, event: command.op, arg }, arg.channel, 'ack')
      if (command.op === 'subscribe') sendSubscribed(client, arg, tick, arg.channel === 'books')
    }
  }
  const consume = (client, chunk) => {
    client.pending = Buffer.concat([client.pending, chunk])
    while (client.pending.length >= 2) {
      const buffer = client.pending, opcode = buffer[0] & 15, masked = Boolean(buffer[1] & 128)
      let length = buffer[1] & 127, offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      if (!masked || length > 1024 * 1024 || !(buffer[0] & 128)) { errors.push('Unsupported client WebSocket frame.'); client.socket.destroy(); return }
      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
      client.pending = buffer.subarray(offset + 4 + length)
      if (opcode === 8) { client.socket.end(client.closing ? undefined : frame(payload, 8)); return }
      if (opcode === 9) client.socket.write(frame(payload, 10))
      else if (opcode === 1) receiveText(client, payload.toString('utf8'))
    }
  }
  server.on('upgrade', (request, socket, head) => {
    if (ownedServer.closing) { socket.destroy(); return }
    if (!['/ws/v5/public', '/ws/v5/business'].includes(request.url) || typeof request.headers['sec-websocket-key'] !== 'string') {
      errors.push(`Unexpected WebSocket upgrade: ${request.url}`)
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.setNoDelay(true)
    const client = { socket, path: request.url, pending: Buffer.alloc(0), subscriptions: new Map(), candlePeriods: new Map() }
    clients.add(client)
    socket.on('data', chunk => consume(client, chunk))
    socket.on('error', error => { if (error.code !== 'ECONNRESET') errors.push(`WebSocket socket: ${error.code ?? error.name}`) })
    socket.on('close', () => {
      clients.delete(client)
      for (const arg of client.subscriptions.values()) acknowledgements[arg.channel]?.delete(keyFor(arg))
    })
    if (head.length) consume(client, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const activeSubscriptions = () => {
    const result = new Map()
    for (const client of clients) for (const arg of client.subscriptions.values()) {
      const values = result.get(arg.channel) ?? new Set()
      values.add(arg.channel === 'instruments' ? 'SWAP' : arg.instId)
      result.set(arg.channel, values)
    }
    return result
  }
  const allTrafficChannels = ['tickers', 'open-interest', 'books', 'trades', 'candle5m', 'candle15m', 'candle1H']
  const trafficDemand = () => Object.fromEntries(allTrafficChannels.map(channel => [channel,
    [...(activeSubscriptions().get(channel) ?? [])].sort()]))
  const dispatchCadenceRound = () => {
    tick++
    cadenceRound++
    if (sampleStartWaiter) {
      window.active = true
      window.startedAt = now()
      window.startedAtMonotonicUS = monotonicMicroseconds()
      window.endedAt = null
      window.endedAtMonotonicUS = null
      window.ws = {}; window.http = {}; window.ack = {}; window.deliveries = {}; window.deliveryTimestamps = {}
      window.events = []; window.rounds = []
      streamSequences.clear()
    }
    currentRoundEvidence = window.active ? { roundId: cadenceRound, startedAtMonotonicUS: monotonicMicroseconds(),
      expectedSubscriptions: trafficDemand(), events: [] } : null
    if (currentRoundEvidence) window.rounds.push(currentRoundEvidence)
    for (const client of clients) for (const arg of client.subscriptions.values()) {
      if (arg.channel !== 'instruments') sendSubscribed(client, arg, tick + seed)
    }
    if (currentRoundEvidence) currentRoundEvidence.endedAtMonotonicUS = monotonicMicroseconds()
    currentRoundEvidence = null
    if (sampleStartWaiter) {
      const resolveStart = sampleStartWaiter
      sampleStartWaiter = null
      resolveStart({ startedAt: window.startedAt, startedAtMonotonicUS: window.startedAtMonotonicUS })
    }
  }
  return {
    asOf, instIds, instruments, kinds, passingCount, spreadFailureCount, oiFailureCount, seed,
    environment: { PERPETUAL_SWAP_E2E_HTTP_ORIGIN: origin,
      PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN: origin.replace('http:', 'ws:') },
    requests, errors,
    get readyState() { return { clients: clients.size, subscriptions: Object.fromEntries([...activeSubscriptions()].map(([channel, ids]) => [channel, ids.size])) } },
    get currentAcknowledgements() { return Object.fromEntries([...activeSubscriptions()].map(([channel, ids]) => [channel, [...ids].sort()])) },
    startCadence(intervalMS = 500) {
      assert.ok(Number.isSafeInteger(intervalMS) && intervalMS >= 100 && intervalMS <= 2_000, 'Cadence must be 100–2000ms.')
      if (cadenceTimer) throw new Error('The fixture cadence is already running.')
      dispatchCadenceRound()
      cadenceIntervalMS = intervalMS
      cadenceTimer = setInterval(dispatchCadenceRound, intervalMS)
      cadenceTimer.unref?.()
      return { stop: () => { if (cadenceTimer) clearInterval(cadenceTimer); cadenceTimer = null }, intervalMS }
    },
    beginSample() {
      if (window.active || sampleStartWaiter) throw new Error('A traffic sample is already active or starting.')
      return new Promise(resolve => { sampleStartWaiter = resolve })
    },
    endSample() {
      if (!window.active || !Number.isSafeInteger(window.startedAtMonotonicUS)) throw new Error('A traffic sample is not active.')
      if (cadenceTimer) clearInterval(cadenceTimer)
      cadenceTimer = null
      window.endedAtMonotonicUS = monotonicMicroseconds()
      const lastSendUS = window.events.at(-1)?.sentAtMonotonicUS
      while (lastSendUS != null && window.endedAtMonotonicUS <= lastSendUS) window.endedAtMonotonicUS = monotonicMicroseconds()
      window.endedAt = now()
      window.active = false
      const events = structuredClone(window.events), rounds = structuredClone(window.rounds)
      const drainDeadlineMonotonicUS = events.length
        ? Math.max(...events.map(event => event.sentAtMonotonicUS + 1_000 * cadenceIntervalMS)) : window.endedAtMonotonicUS
      return { startedAt: window.startedAt, endedAt: window.endedAt,
        durationSeconds: (window.endedAt - window.startedAt) / 1_000,
        startedAtMonotonicUS: window.startedAtMonotonicUS, endedAtMonotonicUS: window.endedAtMonotonicUS,
        drainDeadlineMonotonicUS, events, rounds,
        websocket: structuredClone(window.ws), http: structuredClone(window.http), acknowledgements: structuredClone(window.ack),
        deliveries: structuredClone(window.deliveries), deliveryTimestamps: structuredClone(window.deliveryTimestamps) }
    },
    deliverySummary() {
      const byChannel = Object.fromEntries([...new Set(Object.keys(deliveries).map(key => key.slice(0, key.indexOf(':'))))].sort().map(channel => {
        const entries = instIds.map(instId => ({ instId, count: deliveries[`${channel}:${instId}`] ?? 0,
          lastSentAt: lastDelivery[`${channel}:${instId}`] ?? null }))
        return [channel, { instrumentCount: entries.filter(value => value.count > 0).length, entries }]
      }))
      return { byChannel, sentPayloadsByChannel: structuredClone(sentByChannel) }
    },
    get latestValues() { return structuredClone(latestValues) },
    get bookFrames() { return structuredClone(bookFrames) },
    get subscribedInstruments() { return activeSubscriptions() },
    async close() {
      if (cadenceTimer) clearInterval(cadenceTimer)
      cadenceTimer = null
      cadenceIntervalMS = null
      for (const client of clients) client.socket.destroy()
      await ownedServer.close()
    },
  }
}
