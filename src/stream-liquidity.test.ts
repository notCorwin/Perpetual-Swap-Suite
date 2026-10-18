import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'
import { StreamLiquidityEvaluator } from '../electron/services/stream-liquidity.js'
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
