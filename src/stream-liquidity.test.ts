import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'
import { StreamLiquidityEvaluator } from '../electron/services/stream-liquidity.js'
import { stopOperationWorker } from '../electron/services/operation-worker.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'

const fixture = (index = 0): LiquidityInput => {
  const config = structuredClone(DEFAULT_PREFERENCES.liquidity)
  config.volumeStability.enabled = false
  return {
    instrument: { instId: 'BTC-USDT-SWAP', instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear',
      state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' },
    ticker: { last: '100', bidPx: '99.99', askPx: '100' },
    book: {
      asks: Array.from({ length: 400 }, (_, level) => [(100 + level / 10_000).toFixed(4), String(5_000 + index)]),
      bids: Array.from({ length: 400 }, (_, level) => [(99.99 - level / 10_000).toFixed(4), String(5_000 + index)]),
    },
    openInterest: { oiUsd: '6000000' }, turnover24hUSDT: 40_000_000,
    hourlyCandles: [], asOf: 1_800_000_000_000, config,
  }
}

test('worker results match exact liquidity rules for book, units, and threshold changes', async t => {
  const worker = new StreamLiquidityEvaluator()
  t.after(() => worker.close())
  const input = fixture()
  const alternateUnits = { ...input, instrument: { ...(input.instrument as Record<string, unknown>), ctVal: '0.0001' } }
  const alternateNotional = structuredClone(input)
  alternateNotional.config.slippage.notionalUSDT = 1_000_000
  const failedSpread = { ...input, ticker: { bidPx: '100', askPx: '100.05' } }
  const missingBook = { ...input, book: null }
  for (const observation of [input, alternateUnits, alternateNotional, failedSpread, missingBook]) {
    assert.deepEqual(await worker.evaluate(observation), evaluateLiquidity(observation))
  }
})

test('each promise describes its captured snapshot when later observations change', async t => {
  const worker = new StreamLiquidityEvaluator()
  t.after(() => worker.close())
  const input = fixture()
  const expected = evaluateLiquidity(input)
  const first = worker.evaluate(input)
  input.ticker!.askPx = '110'
  input.book = { ...input.book, asks: [['110', '1'], ...input.book!.asks!.slice(1)] }
  const second = worker.evaluate(input)
  assert.deepEqual(await first, expected)
  assert.deepEqual(await second, evaluateLiquidity(input))
})

test('a malformed uncloneable request rejects independently and later evaluations still work', async t => {
  const worker = new StreamLiquidityEvaluator()
  t.after(() => worker.close())
  const input = fixture()
  await assert.rejects(worker.evaluate({ ...input, ticker: { invalid: () => {} } }))
  assert.deepEqual(await worker.evaluate(input), evaluateLiquidity(input))
})

test('ticker and OI changes reuse the resident book without cloning its content again', async t => {
  const evaluator = new StreamLiquidityEvaluator()
  t.after(() => evaluator.close())
  const input = fixture()
  await evaluator.evaluate(input)
  const native = (evaluator as any).worker
  const postMessage = native.postMessage
  const sent: any[] = []
  native.postMessage = function (message: unknown, ...args: unknown[]) {
    sent.push(message)
    return postMessage.call(this, message, ...args)
  }
  const changed = { ...input, ticker: { ...input.ticker, last: '101' }, openInterest: { oiUsd: '7000000' } }
  assert.deepEqual(await evaluator.evaluate(changed), evaluateLiquidity(changed))
  assert.deepEqual(await evaluator.evaluate(input), evaluateLiquidity(input))
  assert.equal(sent.length, 2)
  assert.ok(sent.every(message => message.input.book === null && message.bookVersion && !message.bookSnapshot))
  assert.equal(sent[0].bookVersion, sent[1].bookVersion)
  const newBook = { ...input, book: { ...input.book, asks: [['100', '1000000']] } }
  assert.deepEqual(await evaluator.evaluate(newBook), evaluateLiquidity(newBook))
  assert.equal(sent[2].bookSnapshot, newBook.book)
  assert.notEqual(sent[2].bookVersion, sent[1].bookVersion)
})

test('a replacement worker receives the required book again after its old lifetime ends', async t => {
  const evaluator = new StreamLiquidityEvaluator()
  t.after(() => evaluator.close())
  const input = fixture()
  await evaluator.evaluate(input)
  const previous = (evaluator as any).worker
  await stopOperationWorker(previous, 'stream-liquidity')
  assert.deepEqual(await evaluator.evaluate(input), evaluateLiquidity(input))
  assert.notEqual((evaluator as any).worker, previous)
})

test('100 fresh deep-book calculations leave the main event loop responsive', async t => {
  const worker = new StreamLiquidityEvaluator()
  t.after(() => worker.close())
  await worker.evaluate(fixture())
  let turns = 0
  const timer = setInterval(() => { turns++ }, 5)
  try {
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => worker.evaluate(fixture(index + 1))))
    assert.equal(results.length, 100)
    assert.ok(results.every(result => result.eligible))
    assert.ok(turns >= 3, `Expected main-thread timers during worker calculations; received ${turns}.`)
  } finally { clearInterval(timer) }
})

test('close rejects queued work, terminates immediately, and cannot admit more work', async () => {
  const worker = new StreamLiquidityEvaluator()
  const pending = Promise.allSettled(Array.from({ length: 100 }, (_, index) => worker.evaluate(fixture(index))))
  const closing = worker.close()
  assert.equal(closing, worker.close())
  await closing
  const outcomes = await pending
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && /closed/.test(String(outcome.reason))))
  await assert.rejects(worker.evaluate(fixture()), /closed/)
  const unused = new StreamLiquidityEvaluator()
  await unused.close()
})
