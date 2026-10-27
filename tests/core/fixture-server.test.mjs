import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { ownFixtureServer } from '../helpers/fixture-server.mjs'
import { createNativeExchange } from '../helpers/native-exchange.mjs'

test('fixture shutdown owns accepted sockets before HTTP headers and after upgrade', { timeout: 2000 }, async () => {
  const server = createServer(), owner = ownFixtureServer(server), clients = []
  server.on('upgrade', (request, socket) => socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const connect = async () => {
    const accepted = once(server, 'connection'), socket = createConnection(server.address().port, '127.0.0.1')
    socket.on('error', () => {})
    clients.push(socket)
    await Promise.all([once(socket, 'connect'), accepted])
    return socket
  }
  try {
    await connect() // Chromium can keep a preconnected socket without a request.
    const partial = await connect(); partial.write('GET / HTTP/1.1\r\nHost: localhost\r\n')
    const upgraded = await connect(), handshake = once(upgraded, 'data')
    upgraded.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    assert.match((await handshake)[0].toString(), /101/)
    assert.equal(owner.connections, 3)
    const closing = owner.close()
    assert.equal(owner.close(), closing, 'Repeated shutdown shares the same completion.')
    assert.equal(owner.closing, true)
    await closing
    assert.equal(server.listening, false)
  } finally {
    for (const socket of clients) socket.destroy()
    if (!owner.closing) await owner.close()
  }
})

test('native exchange shutdown rejects an upgrade admitted before shutdown but completed afterward', { timeout: 2000 }, async () => {
  const exchange = await createNativeExchange(), origin = new URL(exchange.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN)
  const socket = createConnection(Number(origin.port), origin.hostname)
  socket.on('error', () => {})
  let received = ''
  socket.on('data', chunk => { received += chunk })
  try {
    await once(socket, 'connect')
    // The write callback confirms submission, not remote receipt. A complete
    // ordinary request/response on this connection establishes server admission.
    const response = once(socket, 'data')
    socket.write('GET /api/v5/market/tickers HTTP/1.1\r\nHost: localhost\r\n\r\n')
    assert.match((await response)[0].toString(), /200 OK/)
    socket.write('GET /ws/v5/public HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')
    const closing = exchange.close()
    socket.write('\r\n')
    await closing
    assert.doesNotMatch(received, /101 Switching Protocols/)
  } finally { socket.destroy(); await exchange.close() }
})
