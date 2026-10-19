import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ownFixtureServer } from './fixture-server.mjs'

export const nativeIntervals = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const frame = (value, opcode = 1) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (body.length < 126) header[1] = body.length
  else if (body.length < 65536) { header[1] = 126; header.writeUInt16BE(body.length, 2) }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2) }
  return Buffer.concat([header, body])
}
const waitFor = async (condition, description, timeout = 15_000) => {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Loopback exchange timed out: ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const subscriptionKey = arg => `${arg.channel}:${arg.instId ?? arg.instType}`
const rawCandle = row => [row.timestamp, row.open, row.high, row.low, row.close, row.volume, row.baseVolume, row.quoteVolume, row.confirmed ? 1 : 0].map(String)

/** Only the exchange is synthetic: clients use native HTTP/WebSocket transport,
 * protocol acknowledgments, production parsing and the ordinary market pipeline. */
export async function createNativeExchange() {
  const asOf = Date.now(), identities = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']
  const basePrice = instId => instId.startsWith('BTC') ? 100 : 500
  const instruments = identities.map(instId => ({ instId, instType: 'SWAP', instCategory: '1', ctType: 'linear', settleCcy: 'USDT', state: 'live',
    ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal', listTime: String(asOf - 500 * nativeIntervals['1H']) }))
  const rows = identities.flatMap(instrument => Object.entries(nativeIntervals).flatMap(([timeframe, step]) => {
    const end = Math.floor(asOf / step) * step - step, close = basePrice(instrument)
    return Array.from({ length: 400 }, (_, index) => ({ instrument, timeframe, timestamp: end - (399 - index) * step,
      open: close, high: close + 1, low: close - 1, close, volume: 100, baseVolume: 100, quoteVolume: close * 100, confirmed: true }))
  }))
  // Missing one closed price forces a real latest-price request. Hold that
  // response until newer native forming events have already reached the SVG.
  const deferredKey = 'BTC-USDT-SWAP:15m', deferredEnd = Math.floor(asOf / nativeIntervals['15m']) * nativeIntervals['15m'] - nativeIntervals['15m']
  const closedCandles = rows.filter(row => `${row.instrument}:${row.timeframe}` !== deferredKey || row.timestamp !== deferredEnd)
  const clients = new Set(), requests = [], errors = [], held = [], latestQuotes = new Map(identities.map(id => [id, basePrice(id)])), lastCandles = new Map()
  let holdLatest = true, holdBusinessAcknowledgments = false
  const heldAcknowledgments = []
  const ticker = instId => {
    const price = latestQuotes.get(instId) ?? basePrice(instId)
    return { instId, last: String(price), bidPx: String(price - .01), askPx: String(price + .01), open24h: String(basePrice(instId)),
      high24h: String(price + 10), low24h: String(Math.max(.01, price - 10)), volCcy24h: '500000', ts: String(Date.now()) }
  }
  const sendJSON = (response, data) => {
    if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: '0', data }))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'), path = url.pathname.replace(/^\/api\/v5/, '')
    const parameters = Object.fromEntries(url.searchParams), record = { path, parameters, receivedAt: Date.now(), respondedAt: null, held: false }
    requests.push(record)
    response.once('finish', () => { record.respondedAt = Date.now() })
    const instId = parameters.instId ?? identities[0]
    if (path === '/public/instruments') return sendJSON(response, instruments)
    if (path === '/market/tickers') return sendJSON(response, identities.map(ticker))
    if (path === '/market/ticker') return sendJSON(response, [ticker(instId)])
    if (path === '/public/open-interest') return sendJSON(response, [{ instId, oi: '100000', oiUsd: '10000000', ts: String(Date.now()) }])
    if (path === '/market/books') return sendJSON(response, [{ bids: [[String(basePrice(instId) - .01), '100000']], asks: [[String(basePrice(instId) + .01), '100000']], ts: String(Date.now()) }])
    if (path.startsWith('/rubik/stat/')) return sendJSON(response, [])
    if (path === '/market/history-candles' || path === '/market/candles') {
      const timeframe = parameters.bar, step = nativeIntervals[timeframe]
      if (!step) { errors.push(`Unsupported native candle period: ${timeframe}`); return sendJSON(response, []) }
      const values = rows.filter(row => row.instrument === instId && row.timeframe === timeframe
        && (!parameters.after || row.timestamp < Number(parameters.after)) && (!parameters.before || row.timestamp > Number(parameters.before)))
        .toSorted((left, right) => right.timestamp - left.timestamp).slice(0, Math.min(300, Number(parameters.limit) || 100)).map(rawCandle)
      if (path === '/market/candles' && `${instId}:${timeframe}` === deferredKey && holdLatest) {
        record.held = true
        const close = 111.25, timestamp = Math.floor(asOf / step) * step
        held.push({ response, record, data: [rawCandle({ timestamp, open: 100, high: 112, low: 99, close, volume: 10, baseVolume: 10, quoteVolume: 1112.5, confirmed: false }), ...values] })
        return
      }
      const current = lastCandles.get(`${instId}:${timeframe}:${Math.floor(Date.now() / step) * step}`)
      return sendJSON(response, path === '/market/candles' && current && !current.confirmed
        ? [rawCandle(current), ...values].slice(0, Math.min(300, Number(parameters.limit) || 100)) : values)
    }
    errors.push(`Unexpected native exchange HTTP endpoint: ${request.url}`)
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'fixture-error', msg: 'Unsupported loopback exchange endpoint', data: [] }))
  })
  const ownedServer = ownFixtureServer(server)
  const send = (client, value) => { if (!client.socket.destroyed) client.socket.write(frame(typeof value === 'string' ? value : JSON.stringify(value))) }
  const snapshot = (client, arg) => {
    const { instId, channel } = arg
    if (channel === 'tickers') send(client, { arg, data: [ticker(instId)] })
    else if (channel === 'open-interest') send(client, { arg, data: [{ instId, oi: '100000', oiUsd: '10000000', ts: String(Date.now()) }] })
    else if (channel === 'books') send(client, { arg, action: 'snapshot', data: [{ bids: [[String(basePrice(instId) - .01), '100000', '0', '1']],
      asks: [[String(basePrice(instId) + .01), '100000', '0', '1']], seqId: 1, prevSeqId: -1, ts: String(Date.now()) }] })
  }
  const receiveText = (client, text) => {
    if (text === 'ping') { send(client, 'pong'); return }
    let command
    try { command = JSON.parse(text) } catch { errors.push('Native client sent malformed WebSocket JSON'); return }
    if (!['subscribe', 'unsubscribe'].includes(command.op) || !Array.isArray(command.args)) { errors.push('Unexpected native WebSocket command'); return }
    for (const arg of command.args) {
      if (command.op === 'subscribe' && client.path === '/ws/v5/business' && holdBusinessAcknowledgments) {
        heldAcknowledgments.push({ client, id: command.id, arg })
        continue
      }
      const key = subscriptionKey(arg)
      if (command.op === 'subscribe') client.subscriptions.set(key, arg)
      else client.subscriptions.delete(key)
      send(client, { id: command.id, event: command.op, arg })
      if (command.op === 'subscribe') snapshot(client, arg)
    }
  }
  const consume = (client, chunk) => {
    client.pending = Buffer.concat([client.pending, chunk])
    while (client.pending.length >= 2) {
      const buffer = client.pending, opcode = buffer[0] & 15, masked = Boolean(buffer[1] & 128)
      let length = buffer[1] & 127, offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      if (!masked || length > 1024 * 1024 || !(buffer[0] & 128)) { errors.push('Unsupported native WebSocket frame'); client.socket.destroy(); return }
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
    if (!['/ws/v5/public', '/ws/v5/business'].includes(request.url) || typeof request.headers['sec-websocket-key'] !== 'string') { socket.destroy(); return }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.setNoDelay(true)
    const client = { socket, path: request.url, pending: Buffer.alloc(0), subscriptions: new Map() }
    clients.add(client)
    socket.on('data', chunk => consume(client, chunk))
    socket.on('error', error => { if (error.code !== 'ECONNRESET') errors.push(`Native socket: ${error.code ?? error.name}`) })
    socket.on('close', () => clients.delete(client))
    if (head.length) consume(client, head)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const subscribed = (instId, channel) => [...clients].filter(client => client.subscriptions.has(`${channel}:${instId}`))
  return { asOf, instruments, closedCandles, requests, errors, deferredEnd,
    environment: { PERPETUAL_SWAP_E2E_HTTP_ORIGIN: origin, PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN: origin.replace('http:', 'ws:') },
    waitForSubscription: (instId, channel) => waitFor(() => subscribed(instId, channel).length > 0, `${channel}/${instId} native subscription`),
    waitForHeldLatest: () => waitFor(() => held.some(value => !value.response.destroyed), 'deferred native BTC 15m latest-price request'),
    async disconnectBusiness({ holdAcknowledgments = false } = {}) {
      holdBusinessAcknowledgments = holdAcknowledgments
      const previous = [...clients].filter(client => client.path === '/ws/v5/business')
      assert.ok(previous.length, 'The fixture must close an actual native business WebSocket.')
      const payload = Buffer.concat([Buffer.from([0x03, 0xf4]), Buffer.from('native-fixture-reconnect')]) // 1012: service restart
      for (const client of previous) { client.closing = true; client.socket.write(frame(payload, 8)) }
      await waitFor(() => previous.every(client => !clients.has(client)), 'old native business sockets to close')
      return previous.length
    },
    waitForBusinessReconnect: () => waitFor(() => new Set(heldAcknowledgments.filter(value => clients.has(value.client)).map(value => subscriptionKey(value.arg))).size
      === identities.length * Object.keys(nativeIntervals).length, 'real native business resubscription commands'),
    resumeBusinessAcknowledgments() {
      holdBusinessAcknowledgments = false
      for (const { client, id, arg } of heldAcknowledgments.splice(0)) {
        if (!clients.has(client) || client.socket.destroyed) continue
        client.subscriptions.set(subscriptionKey(arg), arg)
        send(client, { id, event: 'subscribe', arg })
      }
    },
    async releaseLatest() {
      holdLatest = false
      for (const value of held) sendJSON(value.response, value.data)
      await waitFor(() => held.every(value => value.response.destroyed || value.record.respondedAt !== null), 'deferred latest-price HTTP response completion')
      return held.filter(value => value.record.respondedAt !== null).length
    },
    sendCandle(instId, timeframe, { close, volume, timestamp = Math.floor(Date.now() / nativeIntervals[timeframe]) * nativeIntervals[timeframe], confirmed = false }) {
      const channel = `candle${timeframe}`, recipients = subscribed(instId, channel)
      assert.ok(recipients.length, `No native ${channel}/${instId} subscriber`)
      const key = `${instId}:${timeframe}:${timestamp}`, previous = lastCandles.get(key), cumulative = volume ?? (previous?.volume ?? 0) + 1
      const quoteVolume = Math.max(previous?.quoteVolume ?? 0, cumulative * close), open = basePrice(instId)
      const row = { timestamp, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close,
        volume: cumulative, baseVolume: cumulative, quoteVolume, confirmed }
      lastCandles.set(key, row)
      const sentAt = Date.now()
      for (const client of recipients) send(client, { arg: { channel, instId }, data: [rawCandle(row)] })
      return { instId, timeframe, hour: timestamp, close, sentAt }
    },
    sendTicker(instId, close) {
      latestQuotes.set(instId, close)
      const sentAt = Date.now()
      for (const client of subscribed(instId, 'tickers')) send(client, { arg: { channel: 'tickers', instId }, data: [ticker(instId)] })
      return { instId, close, sentAt }
    },
    async close() {
      holdLatest = false
      for (const value of held) value.response.destroy()
      await ownedServer.close()
    },
  }
}
