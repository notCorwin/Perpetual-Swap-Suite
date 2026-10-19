import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createNativeExchange } from '../helpers/native-exchange.mjs'
import { createOKXRelay } from '../../scripts/okx-relay.mjs'
import { missingCandleEvidence, requiredMarketInputFailures } from '../../scripts/okx-live-evidence.mjs'

async function wait(condition) {
  const end = performance.now() + 2000
  while (!condition()) { if (performance.now() > end) throw new Error('Native relay condition timed out.'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

test('real native relay preserves subscribe ACK delivery while price envelopes are held and forwards original source candles exactly once', { timeout: 8000 }, async t => {
  const source = await createNativeExchange()
  const relay = await createOKXRelay({ httpOrigin: source.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN,
    websocketOrigin: source.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN })
  relay.gate('BTC-USDT-SWAP')
  const socket = new WebSocket(`${relay.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN}/ws/v5/business`)
  t.after(async () => { socket.close(); await relay.close(); await source.close() })
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  await once(socket, 'open')
  socket.send(JSON.stringify({ id: '1', op: 'subscribe', args: [{ channel: 'candle5m', instId: 'BTC-USDT-SWAP' }] }))
  await wait(() => messages.some(message => message.event === 'subscribe'))
  const acknowledgement = relay.connections[0].acknowledgements[0]
  assert.ok(acknowledgement.receivedAt > 0 && acknowledgement.forwardedAt >= acknowledgement.receivedAt)
  const command = relay.connections[0].commands[0]
  assert.ok(command.forwardedAt >= command.receivedAt)
  assert.ok(acknowledgement.receivedOrder > command.forwardedOrder)
  assert.equal(missingCandleEvidence(relay.snapshot(), { instId: 'BTC-USDT-SWAP', sinceOrder: relay.checkpoint() }).classification, 'integration-failed',
    'An exact live native ACK without a new candle does not prove an external outage.')
  source.sendCandle('BTC-USDT-SWAP', '5m', { close: 112.25, volume: 10 })
  await wait(() => relay.witnesses.length === 1)
  assert.equal(messages.filter(message => message.data).length, 0)
  const witness = relay.witnesses[0]
  assert.equal(witness.forwardedAt, null)
  relay.deliver(witness.sequence)
  await wait(() => messages.some(message => message.data))
  assert.deepEqual(messages.find(message => message.data).data[0], witness.raw)
  assert.equal(Number(witness.raw[4]), 112.25)
  assert.equal(Number(witness.raw[5]), 10)
  assert.ok(witness.forwardedAt >= witness.receivedAt)
  assert.throws(() => relay.deliver(witness.sequence), /not held/)
  relay.release('BTC-USDT-SWAP')
  assert.equal(messages.filter(message => message.data).length, 1)
  assert.deepEqual(relay.errors, [])
})

test('native relay evidence distinguishes an app wrong-period subscription from an independently closed acknowledged source', { timeout: 8000 }, async t => {
  const source = await createNativeExchange()
  const relay = await createOKXRelay({ httpOrigin: source.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN,
    websocketOrigin: source.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN })
  const socket = new WebSocket(`${relay.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN}/ws/v5/business`)
  let sourceClosed = false
  t.after(async () => { socket.close(); await relay.close(); if (!sourceClosed) await source.close() })
  await once(socket, 'open')
  socket.send(JSON.stringify({ id: 'wrong-period', op: 'subscribe', args: [{ channel: 'candle15m', instId: 'BTC-USDT-SWAP' }] }))
  await wait(() => relay.connections[0].acknowledgements.some(value => value.id === 'wrong-period' && value.forwardedAt))
  assert.equal(missingCandleEvidence(relay.snapshot(), { instId: 'BTC-USDT-SWAP', sinceOrder: relay.checkpoint() }).classification, 'app-failure')
  socket.send(JSON.stringify({ id: 'right-period', op: 'subscribe', args: [{ channel: 'candle5m', instId: 'BTC-USDT-SWAP' }] }))
  await wait(() => relay.connections[0].acknowledgements.some(value => value.id === 'right-period' && value.forwardedAt))
  const sinceOrder = relay.checkpoint()
  await source.close(); sourceClosed = true
  await wait(() => relay.connections[0].closedOrder)
  assert.equal(missingCandleEvidence(relay.snapshot(), { instId: 'BTC-USDT-SWAP', sinceOrder }).classification, 'external-unavailable')
  const evidence = missingCandleEvidence(relay.snapshot(), { instId: 'BTC-USDT-SWAP', sinceOrder: relay.checkpoint() })
  assert.equal(evidence.classification, 'external-unavailable', 'An independently failed exact app attempt remains source evidence even when it preceded the gate.')
  assert.equal(evidence.commandForwardedAt, relay.connections[0].commands.at(-1).forwardedAt)
})

test('real upstream HTTP failure status/body/retry evidence are preserved instead of becoming successful fixture data', { timeout: 3000 }, async t => {
  const source = createServer((_request, response) => response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '7' })
    .end(JSON.stringify({ code: '50026', msg: 'System error', data: [] })))
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  const origin = `http://127.0.0.1:${source.address().port}`
  const relay = await createOKXRelay({ httpOrigin: origin, websocketOrigin: origin.replace('http:', 'ws:') })
  t.after(async () => { await relay.close(); source.closeAllConnections(); await new Promise(resolve => source.close(resolve)) })
  const response = await fetch(`${relay.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN}/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=5m&limit=2`)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '7')
  assert.deepEqual(await response.json(), { code: '50026', msg: 'System error', data: [] })
  assert.equal(relay.requests[0].status, 503)
  assert.equal(relay.requests[0].code, '50026')
  assert.match(relay.requests[0].digest, /^[a-f0-9]{64}$/)
  assert.equal(requiredMarketInputFailures(relay.snapshot(), { instId: 'BTC-USDT-SWAP' }).length, 0,
    'A real chart-history outage is not proof that disabled-filter market-row admission failed externally.')
})
