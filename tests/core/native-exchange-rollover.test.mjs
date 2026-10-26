import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeExchange, nativeIntervals } from '../helpers/native-exchange.mjs'

const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'
const waitUntil = async (condition, description) => {
  const deadline = performance.now() + 1_500
  while (!condition()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}.`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('native exchange closes every elapsed 5m candle for each subscribed contract', { timeout: 4_000 }, async () => {
  const step = nativeIntervals['5m'], quarter = nativeIntervals['15m']
  const asOf = Date.UTC(2026, 0, 1, 12, 59, 30)
  let fixtureNow = asOf
  const exchange = await createNativeExchange({ asOf, now: () => fixtureNow })
  const origin = new URL(exchange.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN)
  const socket = new WebSocket(exchange.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN + '/ws/v5/business')
  const messages = [], messageErrors = []
  socket.addEventListener('message', event => {
    try { messages.push(JSON.parse(String(event.data))) } catch (error) { messageErrors.push(error) }
  })
  try {
    await waitUntil(() => socket.readyState === WebSocket.OPEN, 'native fixture socket to open')
    socket.send(JSON.stringify({ op: 'subscribe', args: [btc, eth].map(instId => ({ channel: 'candle5m', instId })) }))
    await Promise.all([btc, eth].map(instId => exchange.waitForSubscription(instId, 'candle5m')))
    await waitUntil(() => [btc, eth].every(instId => messages.some(message => message.event === 'subscribe' && message.arg?.instId === instId)),
      'both native 5m subscription acknowledgments')

    const active = Math.floor(asOf / step) * step
    exchange.sendCandle(btc, '5m', { timestamp: active, close: 120.25, volume: 5 })
    exchange.sendCandle(btc, '5m', { timestamp: active, close: 90.5, volume: 6 })
    const forming = exchange.sendCandle(btc, '5m', { timestamp: active, close: 111.25, volume: 7 })
    assert.deepEqual([forming.open, forming.high, forming.low, forming.close, forming.volume, forming.baseVolume, forming.quoteVolume, forming.confirmed],
      [100, 121.25, 89.5, 111.25, 7, 7, 778.75, false])

    // Cross four boundaries in fixture time. BTC has a real forming row for
    // the first elapsed bucket; ETH must receive deterministic closed baselines.
    fixtureNow = active + 4 * step
    const { currentTimestamp, closed } = exchange.closeElapsedCandles()
    assert.equal(currentTimestamp, active + 4 * step)
    assert.equal(closed.length, 8)
    assert.deepEqual(closed.map(row => [row.instId, row.timestamp]), [
      [btc, active], [eth, active], [btc, active + step], [eth, active + step],
      [btc, active + 2 * step], [eth, active + 2 * step], [btc, active + 3 * step], [eth, active + 3 * step],
    ])
    assert.deepEqual([closed[0].open, closed[0].high, closed[0].low, closed[0].close, closed[0].volume,
      closed[0].baseVolume, closed[0].quoteVolume, closed[0].confirmed], [100, 121.25, 89.5, 111.25, 7, 7, 778.75, true])
    assert.deepEqual([closed[1].open, closed[1].high, closed[1].low, closed[1].close, closed[1].volume,
      closed[1].baseVolume, closed[1].quoteVolume, closed[1].confirmed], [500, 501, 499, 500, 100, 100, 50_000, true])
    assert.ok(closed.every(row => row.confirmed))
    await waitUntil(() => closed.every(event => messages.some(message => message.arg?.instId === event.instId
      && message.arg.channel === 'candle5m' && message.data?.some(row => Number(row[0]) === event.timestamp && row[8] === '1'))),
    'all confirmed native candle updates')

    const exactCandle = async (instId, timeframe, timestamp) => {
      const url = new URL('/api/v5/market/history-candles', origin)
      url.search = new URLSearchParams({ instId, bar: timeframe, limit: '10', after: String(timestamp + 1), before: String(timestamp - 1) })
      const response = await fetch(url)
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.code, '0')
      const rows = payload.data.filter(row => Number(row[0]) === timestamp)
      assert.equal(rows.length, 1, `Expected one ${timeframe} source candle at ${timestamp} for ${instId}.`)
      return rows[0]
    }
    const wireRow = (instId, timestamp) => {
      const matches = messages.flatMap(message => message.arg?.instId === instId && message.arg.channel === 'candle5m' ? message.data ?? [] : [])
        .filter(row => Number(row[0]) === timestamp && row[8] === '1')
      assert.equal(matches.length, 1, `Expected one confirmed WebSocket row at ${timestamp} for ${instId}.`)
      return matches[0]
    }
    assert.deepEqual(wireRow(btc, active), [String(active), '100', '121.25', '89.5', '111.25', '7', '7', '778.75', '1'])
    assert.deepEqual(await exactCandle(btc, '5m', active), wireRow(btc, active))
    assert.deepEqual(await exactCandle(eth, '5m', active), [String(active), '500', '501', '499', '500', '100', '100', '50000', '1'])

    const firstQuarter = Math.floor(active / quarter) * quarter
    assert.deepEqual(await exactCandle(btc, '15m', firstQuarter), [String(firstQuarter), '100', '121.25', '89.5', '111.25', '207', '207', '20778.75', '1'])
    assert.deepEqual(await exactCandle(eth, '15m', firstQuarter), [String(firstQuarter), '500', '501', '499', '500', '300', '300', '150000', '1'])
    const nextQuarter = firstQuarter + quarter
    assert.deepEqual(await exactCandle(btc, '15m', nextQuarter), [String(nextQuarter), '111.25', '112.25', '110.25', '111.25', '300', '300', '33375', '1'])
    assert.deepEqual(await exactCandle(eth, '15m', nextQuarter), [String(nextQuarter), '500', '501', '499', '500', '300', '300', '150000', '1'])

    // The streamed closures remain backend-owned; the seed handed to SQLite
    // still omits the intentional interior repair gap and all post-seed rows.
    assert.equal(exchange.closedCandles.some(row => row.instrument === btc && row.timestamp === exchange.missingBaseEnd), false)
    assert.equal(exchange.closedCandles.some(row => row.timestamp > exchange.seededBaseThrough), false)

    // ETH's first manual forming candle arrives only after the rollover. Its
    // newly closed source remains complete and the current candle stays forming.
    const ethForming = exchange.sendCandle(eth, '5m', { timestamp: currentTimestamp, close: 512.5, volume: 3 })
    assert.equal(ethForming.confirmed, false)
    assert.equal((await exactCandle(eth, '5m', currentTimestamp - step))[8], '1')
    assert.deepEqual(exchange.errors, [])
    assert.deepEqual(messageErrors, [])
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
      socket.close()
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 500))])
    }
    await exchange.close()
  }
})
