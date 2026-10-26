import assert from 'node:assert/strict'
import test from 'node:test'
import { wrapAcceptedCallback } from '../../electron/services/market-traffic-callback-probe.js'

test('sync callback probes preserve the original receiver, return value, and acceptance order', () => {
  const observations = [], restorers = []
  const options = { onTicker(instId) { assert.equal(this, options); return `${instId}:handled` } }
  const original = options.onTicker
  wrapAcceptedCallback(options, 'onTicker', args => observations.push(args), restorers)
  const returned = options.onTicker('BTC-USDT-SWAP')
  assert.equal(returned, 'BTC-USDT-SWAP:handled')
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  assert.equal(returned instanceof Promise, false)

  options.onBook = () => { throw new Error('handler rejected input') }
  wrapAcceptedCallback(options, 'onBook', args => observations.push(args), restorers)
  assert.throws(() => options.onBook('bad-book'), /handler rejected input/)
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])

  for (const restore of restorers.reverse()) restore()
  assert.equal(options.onTicker, original)
})

test('async callbacks are recorded once only after fulfillment, and rejected callbacks are not recorded', async () => {
  const observations = [], restorers = []
  let resolveAccepted
  const options = {
    onTrades: () => new Promise(resolve => { resolveAccepted = resolve }),
    onBook: async () => { throw new Error('async handler rejected input') },
  }
  wrapAcceptedCallback(options, 'onTrades', args => observations.push(args), restorers)
  wrapAcceptedCallback(options, 'onBook', args => observations.push(args), restorers)

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
  wrapAcceptedCallback(options, 'onTicker', args => observations.push(args), restorers)
  assert.equal(options.onTicker('BTC-USDT-SWAP'), 'accepted')
  assert.equal(getterCount, 1)
  assert.equal(attachCount, 1)
  assert.deepEqual(observations, [['BTC-USDT-SWAP']])
  for (const restore of restorers.reverse()) restore()
})
