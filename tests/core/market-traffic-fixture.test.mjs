import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarketTrafficExchange } from '../helpers/market-traffic-exchange.mjs'

const urlOf = (fixture, path) => `${fixture.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN}/api/v5${path}`

test('market traffic fixture keeps valid deterministic qualification and history inputs', async t => {
  const fixture = await createMarketTrafficExchange()
  t.after(() => fixture.close())

  assert.equal(fixture.instIds.length, 50)
  assert.equal(fixture.passingCount, 6)
  assert.equal(fixture.spreadFailureCount, 22)
  assert.equal(fixture.oiFailureCount, 22)
  assert.deepEqual(fixture.instIds.slice(0, 6).map(id => fixture.kinds.get(id)), Array(6).fill('pass'))
  assert.equal(fixture.kinds.get(fixture.instIds[6]), 'spread')
  assert.equal(fixture.kinds.get(fixture.instIds[28]), 'openInterest')

  const instrumentResponse = await fetch(urlOf(fixture, '/public/instruments?instType=SWAP'))
  const instruments = (await instrumentResponse.json()).data
  assert.equal(instruments.length, 50)
  assert.ok(instruments.every(value => value.instType === 'SWAP' && value.ctType === 'linear' && value.settleCcy === 'USDT'
    && value.state === 'live' && value.instCategory === '1' && value.ruleType === 'normal'))

  const tickerResponse = await fetch(urlOf(fixture, '/market/tickers?instType=SWAP'))
  const tickers = (await tickerResponse.json()).data
  assert.equal(tickers.length, 50)
  assert.ok(tickers.every(value => Number(value.last) > 0 && Number(value.bidPx) > 0 && Number(value.askPx) > 0 && Number(value.ts) > 0))
  assert.ok(Number(tickers[6].askPx) - Number(tickers[6].bidPx) > Number(tickers[0].askPx) - Number(tickers[0].bidPx))

  const interestResponse = await fetch(urlOf(fixture, '/public/open-interest?instType=SWAP'))
  const interest = (await interestResponse.json()).data
  assert.equal(interest.length, 50)
  assert.ok(interest.every(value => Number.isFinite(Number(value.oiUsd)) && Number(value.oiUsd) > 0 && Number(value.ts) > 0))
  assert.ok(Number(interest[0].oiUsd) > 5_000_000)
  assert.ok(Number(interest[28].oiUsd) < 5_000_000)

  const candleResponse = await fetch(urlOf(fixture, '/market/history-candles?instId=T000-USDT-SWAP&bar=5m&limit=300'))
  const candles = (await candleResponse.json()).data
  assert.equal(candles.length, 288)
  assert.equal(candles.reduce((sum, value) => sum + Number(value[7]), 0), 36_000_000)
  assert.ok(candles.every(value => value.length === 9 && Number.isSafeInteger(Number(value[0])) && value[8] === '1'))
})

test('market traffic fixture counts acknowledged subscriptions and exact sent payload bytes', async t => {
  const fixture = await createMarketTrafficExchange({ candidateCount: 3, passingCount: 1, spreadFailureCount: 1, seed: 3 })
  const socket = new WebSocket(`${fixture.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN}/ws/v5/public`)
  t.after(async () => {
    if (socket.readyState < WebSocket.CLOSING) await new Promise(resolve => {
      socket.addEventListener('close', resolve, { once: true })
      socket.close()
    })
    await fixture.close()
  })
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  fixture.beginSample()
  socket.send(JSON.stringify({ id: 'bench-1', op: 'subscribe', args: [{ channel: 'tickers', instId: 'T000-USDT-SWAP' }] }))
  const deadline = Date.now() + 2_000
  while (messages.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  const cadence = fixture.startCadence(100)
  await new Promise(resolve => setTimeout(resolve, 150))
  cadence.stop()
  const sample = fixture.endSample()
  assert.equal(messages[0]?.event, 'subscribe')
  assert.equal(messages[1]?.arg?.channel, 'tickers')
  assert.ok((sample.websocket.tickers?.messages ?? 0) >= 3)
  assert.ok(sample.websocket.tickers.payloadBytes > 0)
  assert.ok(sample.acknowledgements.tickers.payloadBytes > 0)
  assert.deepEqual(fixture.currentAcknowledgements.tickers, ['T000-USDT-SWAP'])
  assert.ok((sample.deliveries.tickers?.['T000-USDT-SWAP'] ?? 0) >= 2)
})

test('market traffic book snapshots use the native reset sequence and updates advance it', async t => {
  const fixture = await createMarketTrafficExchange({ candidateCount: 3, passingCount: 1, spreadFailureCount: 1, seed: 5 })
  const socket = new WebSocket(`${fixture.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN}/ws/v5/public`)
  t.after(async () => {
    if (socket.readyState < WebSocket.CLOSING) await new Promise(resolve => {
      socket.addEventListener('close', resolve, { once: true })
      socket.close()
    })
    await fixture.close()
  })
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  fixture.beginSample()
  socket.send(JSON.stringify({ id: 'book-bench-1', op: 'subscribe', args: [{ channel: 'books', instId: 'T000-USDT-SWAP' }] }))
  const initialDeadline = Date.now() + 2_000
  while (messages.filter(value => value.arg?.channel === 'books').length < 2 && Date.now() < initialDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const cadence = fixture.startCadence(100)
  const updateDeadline = Date.now() + 2_000
  while (messages.filter(value => value.arg?.channel === 'books' && value.action).length < 3 && Date.now() < updateDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  cadence.stop()
  const sample = fixture.endSample()
  const frames = messages.filter(value => value.arg?.channel === 'books' && value.action)
  assert.ok(frames.length >= 3, 'The fixture must send one book snapshot and recurring book updates.')
  let previousSequence = null, snapshots = 0, updates = 0
  for (const message of frames) {
    assert.equal(message.data.length, 1)
    const value = message.data[0]
    assert.ok(Number.isSafeInteger(value.seqId) && value.seqId >= 0)
    assert.equal(typeof value.ts, 'string')
    assert.ok(Array.isArray(value.bids) && Array.isArray(value.asks))
    if (message.action === 'snapshot') {
      assert.equal(value.prevSeqId, -1, 'Every snapshot must use OKX’s reset sentinel.')
      previousSequence = value.seqId
      snapshots++
    } else {
      assert.equal(message.action, 'update')
      assert.notEqual(previousSequence, null, 'A book update must follow a snapshot.')
      assert.equal(value.prevSeqId, previousSequence, 'An update must point at the preceding sequence.')
      assert.ok(value.seqId >= value.prevSeqId)
      if (value.seqId === value.prevSeqId) assert.equal(value.bids.length + value.asks.length, 0)
      previousSequence = value.seqId
      updates++
    }
  }
  assert.equal(snapshots, 1)
  assert.ok(updates >= 2)
  assert.ok(sample.websocket.books.payloadBytes > 0)
  assert.ok(sample.deliveries.books['T000-USDT-SWAP'] >= 3)
  assert.deepEqual(fixture.errors, [])
  assert.deepEqual(fixture.bookFrames.map(({ action, seqId, prevSeqId }) => ({ action, seqId, prevSeqId })),
    frames.map(({ action, data }) => ({ action, seqId: data[0].seqId, prevSeqId: data[0].prevSeqId })))
})
