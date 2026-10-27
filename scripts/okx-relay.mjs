import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'

export const instruments = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']
const allowed = new Set(instruments), digest = text => createHash('sha256').update(text).digest('hex')
const MAX_MESSAGE = 1024 * 1024, MAX_HTTP = 4 * MAX_MESSAGE, MAX_TOTAL = 32 * MAX_MESSAGE
const frame = (text, opcode = 1) => {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text), header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (body.length < 126) header[1] = body.length
  else if (body.length < 65536) { header[1] = 126; header.writeUInt16BE(body.length, 2) }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2) }
  return Buffer.concat([header, body])
}

/** Real OKX envelopes, with only instrument-universe filtering and bounded
 * transport holds. Price/candle values and subscription acknowledgments are
 * never synthesized. The witness observes upstream before downstream delivery. */
export async function createOKXRelay({ signal, httpOrigin = 'https://www.okx.com', websocketOrigin = 'wss://ws.okx.com' } = {}) {
  for (const [origin, standard] of [[httpOrigin, 'https://www.okx.com'], [websocketOrigin, 'wss://ws.okx.com']]) {
    const parsed = new URL(origin)
    if (origin !== standard && !(parsed.origin === origin && ['127.0.0.1', '[::1]'].includes(parsed.hostname)
      && ['http:', 'ws:'].includes(parsed.protocol))) throw new TypeError('Only the real OKX origin or a core-test loopback source is supported.')
  }
  const clients = new Set(), requests = [], witnesses = [], connections = [], errors = [], transformations = [], inputs = [], gates = new Set()
  const pending = new Map()
  let sequence = 0, evidenceOrder = 0, totalBytes = 0, closed = false
  const inputDelivered = input => {
    const previous = inputs.findIndex(value => value.kind === input.kind && value.instId === input.instId)
    if (previous >= 0) inputs.splice(previous, 1)
    inputs.push(input)
  }
  const fail = (kind, message) => { if (errors.length < 64) errors.push({ kind, message, observedAt: Date.now() }) }
  const closeUpstream = (client, origin) => {
    if (!client.record.closeRequestedOrder) { client.record.closeRequestedOrder = ++evidenceOrder; client.record.closeRequestedBy = origin }
    client.upstream.close()
  }
  const budget = bytes => { totalBytes += bytes; if (totalBytes > MAX_TOTAL) throw new Error('Real OKX relay exceeded its 32 MiB traffic bound.') }
  const server = createServer(async (request, response) => {
    const start = Date.now(), url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/v5/') || requests.length >= 100
      || url.searchParams.has('instId') && !allowed.has(url.searchParams.get('instId'))) {
      fail('harness-bound', 'Unexpected app HTTP request or request-count limit.'); response.writeHead(502).end(); return
    }
    const record = { path: `${url.pathname}${url.search}`, startedAt: start, startedOrder: ++evidenceOrder }
    requests.push(record)
    try {
      const upstream = await fetch(`${httpOrigin}${url.pathname}${url.search}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean)), redirect: 'error' })
      const chunks = []; let size = 0
      for await (const chunk of upstream.body) { size += chunk.length; if (size > MAX_HTTP) throw new Error('OKX response exceeded 4 MiB.'); chunks.push(chunk) }
      let body = Buffer.concat(chunks, size); budget(body.length)
      let payload
      try { payload = JSON.parse(body) } catch {}
      Object.assign(record, { status: upstream.status, code: payload?.code, bytes: body.length, digest: digest(body), endedAt: Date.now(), endedOrder: ++evidenceOrder })
      if (!upstream.ok || payload?.code !== '0') record.bodyPreview = body.toString('utf8', 0, Math.min(body.length, 1024))
      if (url.pathname === '/api/v5/public/instruments' && payload?.code === '0' && Array.isArray(payload.data)) {
        const filtered = payload.data.filter(row => allowed.has(row.instId))
        transformations.push({ transport: 'http', path: url.pathname, sourceRows: payload.data.length, forwardedRows: filtered.length, digest: record.digest })
        body = Buffer.from(JSON.stringify({ ...payload, data: filtered }))
      }
      const headers = { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }
      for (const key of ['retry-after', 'date']) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key)
      const kind = url.pathname === '/api/v5/public/instruments' ? 'instruments' : ['/api/v5/market/ticker', '/api/v5/market/tickers'].includes(url.pathname) ? 'tickers' : null
      if (kind && upstream.ok && payload?.code === '0') for (const row of payload.data ?? []) {
        if (allowed.has(row.instId)) inputDelivered({ kind, instId: row.instId, receivedAt: record.endedAt,
          forwardedAt: Date.now(), forwardedOrder: ++evidenceOrder })
      }
      response.writeHead(upstream.status, headers).end(body)
    } catch (error) {
      Object.assign(record, { endedAt: Date.now(), endedOrder: ++evidenceOrder, error: { name: error.name, message: error.message, code: error.cause?.code } })
      if (!closed && !signal?.aborted) fail('upstream-http', `${url.pathname}: ${error.name}`)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'relay-upstream-unavailable', data: [] }))
      else response.destroy()
    }
  })
  const forward = item => {
    if (item.forwarded || item.client.socket.destroyed) return false
    if (item.client.socket.writableLength > MAX_MESSAGE) throw new Error('Downstream WebSocket exceeded its backpressure bound.')
    const forwardedAt = Date.now()
    item.client.socket.write(frame(item.text)); item.forwarded = true
    for (const witness of item.witnesses) {
      witness.forwardedAt = forwardedAt; witness.forwardedOrder = ++evidenceOrder
      if (witness.kind) inputDelivered(witness)
    }
    return true
  }
  const incoming = (client, text) => {
    budget(Buffer.byteLength(text))
    let payload
    try { payload = JSON.parse(text) } catch {}
    if (payload?.arg?.channel === 'instruments' && Array.isArray(payload.data)) {
      const filtered = payload.data.filter(row => allowed.has(row.instId))
      if (transformations.length < 32) transformations.push({ transport: 'websocket', channel: 'instruments', sourceRows: payload.data.length, forwardedRows: filtered.length, digest: digest(text) })
      text = JSON.stringify({ ...payload, data: filtered })
    }
    const values = [], instId = payload?.arg?.instId, channel = payload?.arg?.channel
    if (['instruments', 'tickers'].includes(channel) && Array.isArray(payload?.data)) for (const row of payload.data) {
      const id = row.instId ?? instId
      if (allowed.has(id)) {
        const input = { kind: channel, instId: id, receivedAt: Date.now(), forwardedAt: null }
        values.push(input)
      }
    }
    if (payload?.event && client.record.acknowledgements.length < 32) {
      const acknowledgment = { ...payload, receivedAt: Date.now(), receivedOrder: ++evidenceOrder, forwardedAt: null }
      client.record.acknowledgements.push(acknowledgment); values.push(acknowledgment)
    }
    if (allowed.has(instId) && channel === 'candle5m' && Array.isArray(payload.data)) {
      for (const row of payload.data) if (Array.isArray(row) && row.length >= 9 && row[8] === '0') {
        if (witnesses.length >= 256) throw new Error('Native candle witness exceeded its record bound.')
        const witness = { sequence: ++sequence, instId, channel, raw: row.slice(0, 9), receivedAt: Date.now(), forwardedAt: null, digest: digest(text), bytes: Buffer.byteLength(text) }
        witnesses.push(witness); values.push(witness)
      }
    }
    const item = { client, text, witnesses: values, forwarded: false }
    if (gates.has(instId) && Array.isArray(payload?.data) && (channel === 'tickers' || /^candle/.test(channel))) {
      const queue = pending.get(instId) ?? []
      if (queue.length >= 512) throw new Error('Price hold exceeded its frame bound.')
      queue.push(item); pending.set(instId, queue)
    } else forward(item)
  }
  const sendUpstream = (client, item) => {
    client.upstream.send(item.text)
    if (item.command) { item.command.forwardedAt = Date.now(); item.command.forwardedOrder = ++evidenceOrder }
  }
  const receive = (client, text) => {
    if (Buffer.byteLength(text) > MAX_MESSAGE) throw new Error('App command exceeded its frame bound.')
    let record
    if (text !== 'ping') {
      const command = JSON.parse(text)
      if (!['subscribe', 'unsubscribe'].includes(command.op) || !Array.isArray(command.args)
        || command.args.some(arg => arg.instId ? !allowed.has(arg.instId) : !(arg.channel === 'instruments' && arg.instType === 'SWAP'))) {
        fail('app-scope-escape', 'App requested a subscription outside BTC/ETH.'); client.socket.destroy(); return
      }
      if (client.record.commands.length >= 32) throw new Error('Native subscription evidence exceeded its command bound.')
      record = { ...command, receivedAt: Date.now(), forwardedAt: null }
      client.record.commands.push(record)
    }
    const item = { text, command: record }
    if (client.upstream.readyState === 1) sendUpstream(client, item)
    else { if (client.outbox.length >= 32) throw new Error('Upstream subscription queue exceeded its bound.'); client.outbox.push(item) }
  }
  const consume = (client, chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk])
    if (client.buffer.length > MAX_MESSAGE + 14) throw new Error('App WebSocket exceeded its buffer bound.')
    while (client.buffer.length >= 2) {
      const buffer = client.buffer, opcode = buffer[0] & 15
      let size = buffer[1] & 127, offset = 2
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4 }
      else if (size === 127) { if (buffer.length < 10) return; const raw = buffer.readBigUInt64BE(2); if (raw > BigInt(MAX_MESSAGE)) throw new Error('App frame exceeded its size bound.'); size = Number(raw); offset = 10 }
      if (!(buffer[0] & 128) || buffer[0] & 0x70 || !(buffer[1] & 128) || size > MAX_MESSAGE) throw new Error('Unsupported app WebSocket frame.')
      if (buffer.length < offset + 4 + size) return
      const key = buffer.subarray(offset, offset + 4), body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size))
      for (let index = 0; index < body.length; index++) body[index] ^= key[index % 4]
      client.buffer = buffer.subarray(offset + 4 + size)
      if (opcode === 8) { client.socket.end(frame(body, 8)); closeUpstream(client, 'app'); return }
      if (opcode === 9) client.socket.write(frame(body, 10))
      else if (opcode === 1) receive(client, body.toString('utf8'))
    }
  }
  server.on('upgrade', (request, socket, head) => {
    if (!['/ws/v5/public', '/ws/v5/business'].includes(request.url) || typeof request.headers['sec-websocket-key'] !== 'string' || connections.length >= 6) {
      fail('harness-bound', 'Unexpected native WebSocket upgrade or connection-count limit.'); socket.destroy(); return
    }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const record = { url: `${websocketOrigin}${request.url}`, startedAt: Date.now(), openedAt: null, commands: [], messages: 0 }
    record.acknowledgements = []
    connections.push(record)
    const upstream = new WebSocket(record.url), client = { socket, upstream, record, buffer: Buffer.alloc(0), outbox: [] }
    clients.add(client); socket.setNoDelay(true)
    upstream.addEventListener('open', () => { record.openedAt = Date.now(); for (const item of client.outbox.splice(0)) sendUpstream(client, item) })
    upstream.addEventListener('message', event => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_MESSAGE) { fail('upstream-websocket', 'Unsupported upstream WebSocket message.'); closeUpstream(client, 'harness'); return }
      record.messages++
      try { incoming(client, event.data) } catch (error) { fail('harness-bound', error.message); socket.destroy(); closeUpstream(client, 'harness') }
    })
    upstream.addEventListener('error', event => { record.error = { name: event.error?.name ?? 'WebSocketError',
      message: String(event.message || event.error?.message || 'Native upstream WebSocket error').slice(0, 512), code: event.error?.cause?.code };
      record.errorOrder = ++evidenceOrder
      if (!closed && !signal?.aborted) fail('upstream-websocket', record.error.message); socket.destroy() })
    upstream.addEventListener('close', event => { record.closedAt = Date.now(); record.closedOrder = ++evidenceOrder; record.closeCode = event.code; if (!socket.destroyed) socket.end(frame(Buffer.from([0x03, 0xe8]), 8)) })
    socket.on('data', chunk => { try { consume(client, chunk) } catch (error) { fail('harness-bound', error.message); socket.destroy(); closeUpstream(client, 'harness') } })
    socket.on('error', () => { if (!closed) fail('downstream', 'Native app relay socket error') })
    socket.on('close', () => { clients.delete(client); closeUpstream(client, 'app') })
    if (head.length) consume(client, head)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const close = async () => { if (closed) return; closed = true; for (const client of clients) { closeUpstream(client, 'harness'); client.socket.destroy() } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  signal?.addEventListener('abort', () => { void close() }, { once: true })
  return { requests, witnesses, connections, errors, transformations, inputs, checkpoint: () => evidenceOrder,
    environment: { PERPETUAL_SWAP_E2E_HTTP_ORIGIN: origin, PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN: origin.replace('http:', 'ws:') },
    gate(instId) { gates.add(instId) },
    release(instId) { gates.delete(instId); for (const item of pending.get(instId) ?? []) forward(item); pending.delete(instId) },
    deliver(sequence) { const witness = witnesses.find(value => value.sequence === sequence); if (!witness) throw new Error('Unknown upstream witness.');
      const queue = pending.get(witness.instId) ?? [], index = queue.findIndex(value => value.witnesses.includes(witness))
      if (index < 0 || queue[index].forwarded) throw new Error('Witness was not held for native delivery.')
      // Preserve FIFO through the selected genuine envelope, then keep later
      // prices held long enough for an exact independent SVG assertion.
      for (const item of queue.slice(0, index + 1)) forward(item)
      return witness },
    snapshot() { return { totalBytes, requests, connections, errors, transformations, witnesses, inputs, heldFrames: [...pending.values()].reduce((total, values) => total + values.filter(value => !value.forwarded).length, 0) } }, close }
}
