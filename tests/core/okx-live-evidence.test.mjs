import assert from 'node:assert/strict'
import test from 'node:test'
import { missingCandleEvidence, requiredMarketInputFailures } from '../../scripts/okx-live-evidence.mjs'

const instId = 'BTC-USDT-SWAP', arg = { instId, channel: 'candle5m' }
const options = { instId, sinceOrder: 10 }
const subscribed = () => ({ url: 'wss://ws.okx.com/ws/v5/business', startedAt: 100,
  commands: [{ id: 'native-1', op: 'subscribe', args: [arg], receivedAt: 100, forwardedAt: 100, forwardedOrder: 2 }],
  acknowledgements: [{ id: 'native-1', event: 'subscribe', arg, receivedAt: 100, receivedOrder: 3, forwardedAt: 100, forwardedOrder: 4 }] })

test('missing native candles cannot borrow absent, different, unsubscribed or closed app subscriptions as external outage evidence', async t => {
  const cases = [
    ['no business socket', [], 'app-failure'],
    ['public socket only', [{ ...subscribed(), url: 'wss://ws.okx.com/ws/v5/public' }], 'app-failure'],
    ['wrong timeframe', [{ ...subscribed(), commands: [{ op: 'subscribe', args: [{ ...arg, channel: 'candle15m' }], forwardedAt: 100, forwardedOrder: 2 }] }], 'app-failure'],
    ['wrong contract', [{ ...subscribed(), commands: [{ op: 'subscribe', args: [{ ...arg, instId: 'ETH-USDT-SWAP' }], forwardedAt: 100, forwardedOrder: 2 }] }], 'app-failure'],
    ['command queued but never sent upstream', [{ ...subscribed(), commands: [{ op: 'subscribe', args: [arg], forwardedAt: null }] }], 'integration-failed'],
    ['native ACK absent', [{ ...subscribed(), acknowledgements: [] }], 'integration-failed'],
    ['native ACK observed but not delivered', [{ ...subscribed(), acknowledgements: [{ ...subscribed().acknowledgements[0], forwardedAt: null }] }], 'integration-failed'],
    ['ACK belongs to older command despite the same wall-clock millisecond and ID', [{ ...subscribed(), commands: [{ ...subscribed().commands[0], forwardedOrder: 5 }] }], 'integration-failed'],
    ['later unsubscribe invalidates old ACK', [{ ...subscribed(), commands: [...subscribed().commands, { op: 'unsubscribe', args: [arg], forwardedAt: 110, forwardedOrder: 11 }] }], 'app-failure'],
    ['closed old socket requested by app', [{ ...subscribed(), closedAt: 100, closeRequestedOrder: 8, closedOrder: 9 }], 'app-failure'],
    ['new current socket cannot borrow previous socket ACK', [subscribed(), { ...subscribed(), acknowledgements: [] }], 'integration-failed'],
    ['healthy exact acknowledged subscription without an eligible candle is unclassified', [subscribed()], 'integration-failed'],
    ['acknowledged upstream independently failed', [{ ...subscribed(), error: { name: 'WebSocketError' }, errorOrder: 12 }], 'external-unavailable'],
    ['acknowledged upstream closed during the observation', [{ ...subscribed(), closedAt: 100, closedOrder: 12 }], 'external-unavailable'],
    ['app deliberately closed the acknowledged socket', [{ ...subscribed(), closeRequestedBy: 'app', closeRequestedOrder: 11, closedAt: 100, closedOrder: 12 }], 'integration-failed'],
    ['harness close cannot become an external outage', [{ ...subscribed(), closeRequestedBy: 'harness', closeRequestedOrder: 11, errorOrder: 12, error: { name: 'WebSocketError' } }], 'integration-failed'],
    ['app cleanup after an independent native error does not erase that error', [{ ...subscribed(), error: { name: 'WebSocketError' }, errorOrder: 11, closeRequestedOrder: 12, closedOrder: 13 }], 'external-unavailable'],
    ['native error before exact attempted subscription could leave its queue', [{ ...subscribed(), errorOrder: 5, closedOrder: 6, commands: [{ id: 'native-1', op: 'subscribe', args: [arg], receivedAt: 100, forwardedAt: null }], acknowledgements: [] }], 'external-unavailable'],
    ['native failure before ACK does not become an app defect', [{ ...subscribed(), errorOrder: 5, closedOrder: 6, acknowledgements: [] }], 'external-unavailable'],
    ['independent close just before gate remains actual source failure', [{ ...subscribed(), closedOrder: 9, closedAt: 100 }], 'external-unavailable'],
    ['native failure with no exact app attempt is inconclusive', [{ ...subscribed(), errorOrder: 5, commands: [], acknowledgements: [] }], 'integration-failed'],
    ['older socket outage cannot be borrowed by a newer unsubscribed socket', [{ ...subscribed(), errorOrder: 5, closedOrder: 6 }, { ...subscribed(), commands: [], acknowledgements: [] }], 'app-failure'],
  ]
  for (const [name, connections, expected] of cases) await t.test(name, () => {
    const result = missingCandleEvidence({ connections }, options)
    assert.equal(result.classification, expected)
    assert.ok(result.reason)
  })
})

const request = (path, extra = {}) => ({ path, startedAt: 100, startedOrder: 1, endedAt: 100, endedOrder: 2, status: 503, code: '50026', ...extra })
const ticker = '/api/v5/market/ticker?instId=BTC-USDT-SWAP'
test('market-row source failures require the exact necessary input and its final unrecovered attempt', async t => {
  const cases = [
    ['unfinished necessary request', { requests: [request(ticker, { endedAt: undefined, endedOrder: undefined, status: undefined, code: undefined })] }, 0],
    ['other contract failed', { requests: [request('/api/v5/market/ticker?instId=ETH-USDT-SWAP')] }, 0],
    ['chart history does not block disabled-filter row admission', { requests: [request('/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=5m')] }, 0],
    ['required catalog failed finally', { requests: [request('/api/v5/public/instruments?instType=SWAP')] }, 1],
    ['required current ticker failed finally', { requests: [request(ticker)] }, 1],
    ['later successful same input recovered', { requests: [request(ticker), request(ticker, { startedOrder: 3, endedOrder: 4, status: 200, code: '0' })] }, 0],
    ['bulk ticker recovery also recovers current single ticker failure', { requests: [request(ticker), request('/api/v5/market/tickers?instType=SWAP', { startedOrder: 3, endedOrder: 4, status: 200, code: '0' })] }, 0],
    ['latest retry still in flight', { requests: [request(ticker), request(ticker, { startedOrder: 3, endedAt: undefined, endedOrder: undefined })] }, 0],
    ['native exact-input recovery in same wall clock millisecond', { requests: [request(ticker)], inputs: [{ kind: 'tickers', instId, forwardedAt: 100, forwardedOrder: 3 }] }, 0],
    ['older native input does not erase later HTTP failure in same wall-clock millisecond', { requests: [request(ticker)], inputs: [{ kind: 'tickers', instId, forwardedAt: 100, forwardedOrder: 1 }] }, 1],
    ['native other-contract data cannot recover current failure', { requests: [request(ticker)], inputs: [{ kind: 'tickers', instId: 'ETH-USDT-SWAP', forwardedAt: 100, forwardedOrder: 3 }] }, 1],
    ['native input was received but held from the app', { requests: [request(ticker)], inputs: [{ kind: 'tickers', instId, forwardedAt: null, forwardedOrder: 3 }] }, 1],
  ]
  for (const [name, source, count] of cases) await t.test(name, () => assert.equal(requiredMarketInputFailures(source, { instId }).length, count))
  assert.equal(requiredMarketInputFailures({ requests: [request(ticker)] }, { instId, sinceOrder: 3 }).length, 0, 'A previous successful chart observation fences older input failures.')
})
