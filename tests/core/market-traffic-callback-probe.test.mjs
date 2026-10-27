import assert from 'node:assert/strict'
import test from 'node:test'
import { marketTrafficPayloadIdentity, monotonicMicroseconds, validateMarketTrafficDrainWindow, wrapAcceptedCallback } from '../../electron/services/market-traffic-callback-probe.js'

test('sync callback probes preserve the original receiver, return value, and acceptance order', () => {
  const observations = [], restorers = []
  const options = { onTicker(instId) { assert.equal(this, options); return `${instId}:handled` } }
  const original = options.onTicker
  wrapAcceptedCallback(options, 'onTicker', (args, timing) => { if (timing.phase === 'accepted') observations.push(args) }, restorers)
  const returned = options.onTicker('BTC-USDT-SWAP')
  assert.equal(returned, 'BTC-USDT-SWAP:handled')
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  assert.equal(returned instanceof Promise, false)

  options.onBook = () => { throw new Error('handler rejected input') }
  wrapAcceptedCallback(options, 'onBook', (args, timing) => { if (timing.phase === 'accepted') observations.push(args) }, restorers)
  assert.throws(() => options.onBook('bad-book'), /handler rejected input/)
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])

  for (const restore of restorers.reverse()) restore()
  assert.equal(options.onTicker, original)
})

test('drain rejects malformed future windows before waiting and accepts only the bounded fixture cadence', () => {
  const window = { sampleStartedMonotonicUS: 100, sampleEndedMonotonicUS: 1_000, drainDeadlineMonotonicUS: 2_001_000 }
  assert.doesNotThrow(() => validateMarketTrafficDrainWindow(window, 1_100))
  assert.throws(() => validateMarketTrafficDrainWindow({ ...window, drainDeadlineMonotonicUS: 2_001_001 }, 1_100), /maximum 2000 ms/)
  assert.throws(() => validateMarketTrafficDrainWindow(window, 999), /ordered, completed/)
  assert.throws(() => validateMarketTrafficDrainWindow({ ...window, sampleStartedMonotonicUS: 1_001 }, 1_100), /ordered, completed/)
  assert.throws(() => validateMarketTrafficDrainWindow({ ...window, drainDeadlineMonotonicUS: -1 }, 1_100), /ordered, completed/)
})

test('async callbacks are recorded once only after fulfillment, and rejected callbacks are not recorded', async () => {
  const observations = [], restorers = []
  let resolveAccepted
  const options = {
    onTrades: () => new Promise(resolve => { resolveAccepted = resolve }),
    onBook: async () => { throw new Error('async handler rejected input') },
  }
  wrapAcceptedCallback(options, 'onTrades', (args, timing) => { if (timing.phase === 'accepted') observations.push(args) }, restorers)
  wrapAcceptedCallback(options, 'onBook', (args, timing) => { if (timing.phase === 'accepted') observations.push(args) }, restorers)

  const pending = options.onTrades('BTC-USDT-SWAP')
  assert.deepEqual(observations, [])
  resolveAccepted('accepted')
  assert.equal(await pending, 'accepted')
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  await assert.rejects(options.onBook('bad-book'), /async handler rejected input/)
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  for (const restore of restorers.reverse()) restore()
})

test('thenable probes read and attach then exactly once', async () => {
  let getterCount = 0, attachCount = 0
  const observations = [], restorers = []
  const thenable = {
    get then() {
      getterCount++
      return function (resolve) { attachCount++; return resolve('accepted') }
    },
  }
  const options = { onTicker: () => thenable }
  wrapAcceptedCallback(options, 'onTicker', (args, timing) => { if (timing.phase === 'accepted') observations.push(args) }, restorers)
  assert.equal(options.onTicker('BTC-USDT-SWAP'), 'accepted')
  assert.equal(getterCount, 1)
  assert.equal(attachCount, 1)
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  for (const restore of restorers.reverse()) restore()
})

test('callback timing separates entry from fulfillment and payload identity follows existing OKX fields', async () => {
  const observations = [], restorers = []
  let resolveAccepted
  const options = { onTicker: () => new Promise(resolve => { resolveAccepted = resolve }) }
  wrapAcceptedCallback(options, 'onTicker', (_args, timing) => observations.push(timing), restorers)
  const pending = options.onTicker('BTC-USDT-SWAP', { ts: '100', last: '10' }, { receivedAt: 100 })
  assert.equal(observations.length, 1)
  assert.equal(observations[0].phase, 'entry')
  resolveAccepted('accepted')
  assert.equal(await pending, 'accepted')
  assert.equal(observations[1].phase, 'accepted')
  assert.ok(observations[1].callbackAcceptedAtMonotonicUS >= observations[0].callbackEnteredAtMonotonicUS)
  assert.ok(Number.isSafeInteger(monotonicMicroseconds()))
  for (const restore of restorers.reverse()) restore()

  const ticker = { ts: '100', last: '10', bidPx: '9', askPx: '10', open24h: '9', high24h: '11', low24h: '8', volCcy24h: '20', vol24h: '2' }
  const first = marketTrafficPayloadIdentity('tickers', 'BTC-USDT-SWAP', ticker)
  const changed = marketTrafficPayloadIdentity('tickers', 'BTC-USDT-SWAP', { ...ticker, last: '10.1' })
  assert.notEqual(first.identity, changed.identity)
  assert.notEqual(first.payloadFingerprint, changed.payloadFingerprint)
})
