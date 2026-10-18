import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { LiveStatistics, type LiveTrade } from '../electron/services/live-statistics.js'
import type { CandleRecord } from '../electron/services/market-store.js'

const instId = 'BTC-USDT-SWAP'
const fiveMinutes = 300_000
const hour = 3_600_000
const candle = (timestamp = 0, timeframe = '5m', confirmed = false, volume = 0): CandleRecord => ({
  instrument: instId, timeframe, timestamp, confirmed, volume,
  open: 1, high: 1, low: 1, close: 1, oi: null, buy: null, sell: null,
})
const trade = (tradeId: string, ts: number, side: 'buy' | 'sell' = 'buy', sz = '2'): LiveTrade => ({ tradeId, ts: String(ts), side, sz })
const values = (row: CandleRecord) => [row.oi, row.buy, row.sell]

test('mid-period subscription never presents partial taker totals as a full candle', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 1_000)
  statistics.trades(instId, [trade('before-ack', 500), trade('partial', 2_000)], 2_000)
  assert.deepEqual(values(statistics.enrich(candle(), 2_000)), [null, null, null])
  statistics.trades(instId, [trade('full-buy', fiveMinutes + 100), trade('full-sell', fiveMinutes + 200, 'sell', '3')], fiveMinutes + 200)
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 200)), [null, 2, 3])
  assert.deepEqual(values(statistics.enrich(candle(0, '15m'), fiveMinutes + 200)), [null, null, null])
})

test('aggregate trade size is counted once, independent of count and duplicate frames', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.start(instId, 50)
  const buy = { ...trade('1', 100, 'buy', '12.5'), count: '8' }
  const sell = trade('2', 200, 'sell', '7.25')
  statistics.trades(instId, [sell, buy, buy], 200)
  statistics.trades(instId, [sell, buy], 201)
  const original = candle()
  const result = statistics.enrich(original, 201)
  assert.deepEqual(values(result), [null, 12.5, 7.25])
  assert.notEqual(result, original)
  assert.deepEqual(values(original), [null, null, null])
})

test('native 5m, 15m, and 1H totals use the same contract trades and aligned boundaries', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  const rows = Array.from({ length: 12 }, (_, index) => trade(String(index), index * fiveMinutes + 1, index % 2 ? 'sell' : 'buy', String(index + 1)))
  statistics.trades(instId, rows, hour)
  assert.deepEqual(values(statistics.enrich(candle(0, '1H', true, 78), hour)), [null, 36, 42])
  assert.deepEqual(values(statistics.enrich(candle(0, '15m', true, 6), hour)), [null, 4, 2])
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes, '5m', true, 2), hour)), [null, 0, 2])
  assert.deepEqual(values(statistics.enrich(candle(1, '5m'), hour)), [null, null, null])
})

test('disconnect invalidates its affected period and preserves previously completed coverage', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.trades(instId, [trade('complete', 1_000), trade('partial', fiveMinutes + 100)], fiveMinutes + 100)
  statistics.disconnect([instId], fiveMinutes + 200)
  statistics.trades(instId, [trade('offline', fiveMinutes + 300)], fiveMinutes + 300)
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 300)), [null, null, null])
  statistics.start(instId, fiveMinutes + 400)
  statistics.trades(instId, [trade('resumed', fiveMinutes + 500)], fiveMinutes + 500)
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 500)), [null, null, null])
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', true, 2), fiveMinutes + 500)), [null, 2, 0])
  statistics.trades(instId, [trade('next', 2 * fiveMinutes + 100, 'sell', '4')], 2 * fiveMinutes + 100)
  assert.deepEqual(values(statistics.enrich(candle(2 * fiveMinutes), 2 * fiveMinutes + 100)), [null, 0, 4])
  assert.deepEqual(values(statistics.enrich(candle(0, '15m'), 2 * fiveMinutes + 100)), [null, null, null])
})

test('confirmed totals wait for full contract-volume reconciliation, including zero-volume candles', () => {
  const statistics = new LiveStatistics()
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', true), fiveMinutes)), [null, null, null])
  statistics.start(instId, 0)
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', true), fiveMinutes)), [null, 0, 0])
  statistics.trades(instId, [trade('1', 1_000, 'buy', '0.1')], fiveMinutes)
  const confirmed = candle(0, '5m', true, 0.3)
  assert.deepEqual(values(statistics.enrich(confirmed, fiveMinutes - 1)), [null, null, null])
  assert.deepEqual(values(statistics.enrich(confirmed, fiveMinutes)), [null, null, null])
  statistics.trades(instId, [trade('2', fiveMinutes - 1, 'sell', '0.2')], fiveMinutes + 1)
  assert.deepEqual(values(statistics.enrich(confirmed, fiveMinutes + 1)), [null, 0.1, 0.2])
})

test('OI uses fresh contracts at or before observation and never requires trade coverage', () => {
  const statistics = new LiveStatistics()
  statistics.openInterest(instId, { oi: '123', oiCcy: '456', oiUsd: '789', ts: '1000' }, 1_000)
  assert.deepEqual(values(statistics.enrich(candle(), 1_000)), [123, null, null])
  assert.equal(statistics.enrich(candle(), 31_000).oi, 123)
  assert.equal(statistics.enrich(candle(), 31_001).oi, null)
  statistics.openInterest(instId, { oi: '0', ts: '32000' }, 32_000)
  statistics.openInterest(instId, { oi: '100', ts: '31000' }, 32_000)
  statistics.openInterest(instId, { oi: '999', ts: '33000' }, 32_000)
  assert.equal(statistics.enrich(candle(), 32_000).oi, 0)
  statistics.openInterest(instId, { oi: '200', ts: String(fiveMinutes - 1) }, fiveMinutes - 1)
  statistics.openInterest(instId, { oi: '300', ts: String(fiveMinutes + 1) }, fiveMinutes + 1)
  assert.equal(statistics.enrich(candle(0, '5m', true), fiveMinutes + 1).oi, 200)
})

test('an exact-boundary OI sample remains available after later observations', () => {
  const statistics = new LiveStatistics()
  statistics.openInterest(instId, { oi: '8', ts: String(fiveMinutes) }, fiveMinutes)
  statistics.openInterest(instId, { oi: '9', ts: String(fiveMinutes + 10) }, fiveMinutes + 10)
  assert.equal(statistics.enrich(candle(0, '5m', true), fiveMinutes + 10).oi, 8)
  assert.equal(statistics.enrich(candle(fiveMinutes), fiveMinutes + 10).oi, 9)
})

test('foreign observations cannot corrupt totals or trigger reads beyond a requested observation cutoff', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.trades(instId, [
    trade('valid', 100), { ...trade('foreign', 100), instId: 'ETH-USDT-SWAP' },
  ], 100)
  statistics.openInterest(instId, { oi: '-1', ts: '100' }, 100)
  statistics.openInterest(instId, { oi: '42', ts: '100', instId: 'ETH-USDT-SWAP' }, 100)
  assert.deepEqual(values(statistics.enrich(candle(), 100)), [null, 2, 0])
  // An earlier candle dispatch cannot accidentally include newer trades.
  assert.deepEqual(values(statistics.enrich(candle(), 99)), [null, null, null])
})

test('malformed or future trades invalidate affected periods instead of exposing known partial totals', () => {
  const malformed = [trade('future', 101), trade('negative', 100, 'buy', '-1'), trade('nan', 100, 'sell', 'NaN'),
    trade('', 100), { ...trade('invalid-time', 100), ts: '' }]
  for (const raw of malformed) {
    const statistics = new LiveStatistics()
    statistics.start(instId, 0)
    statistics.trades(instId, [trade('valid', 100), raw], 100)
    assert.deepEqual(values(statistics.enrich(candle(), 100)), [null, null, null])
    statistics.trades(instId, [trade('next', fiveMinutes + 100)], fiveMinutes + 100)
    assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 100)), [null, 2, 0])
  }
})

test('contradictory replay data invalidates the period instead of silently changing totals', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.trades(instId, [trade('1', 1_000), trade('1', 1_000, 'sell', '4')], 1_000)
  assert.deepEqual(values(statistics.enrich(candle(), 1_000)), [null, null, null])
})

test('a replay with a contradictory period invalidates both periods using instrument-wide identities', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.trades(instId, [trade('1', 1_000), trade('1', fiveMinutes + 1_000)], fiveMinutes + 1_000)
  assert.deepEqual(values(statistics.enrich(candle(), fiveMinutes + 1_000)), [null, null, null])
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 1_000)), [null, null, null])
})

test('100,000 sequential trades retain bounded replay memory without losing liquid-contract totals', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  const count = 100_000
  const rows = Array.from({ length: count }, (_, index) => trade(String(index + 1), 100_000, index % 2 ? 'sell' : 'buy', '1'))
  statistics.trades(instId, rows, 100_000)
  const state = Reflect.get(statistics, 'instruments').get(instId)
  assert.ok(state.replay.size <= 2_048, 'Replay memory must be bounded independently of observed trade count.')
  assert.equal(state.trades.size, 1)
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', false, count), 100_000)), [null, count / 2, count / 2])
  statistics.trades(instId, rows.slice(-100), 100_001)
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', false, count), 100_001)), [null, count / 2, count / 2])
})

test('unseen out-of-order IDs inside the replay window count once while evicted ambiguous IDs invalidate the period', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  const rows = Array.from({ length: 3_000 }, (_, index) => trade(String(index + 2), 100, 'buy', '1'))
  rows.splice(2_498, 1)
  statistics.trades(instId, rows, 100)
  statistics.trades(instId, [trade('2500', 100, 'sell', '4'), trade('2500', 100, 'sell', '4')], 100)
  assert.deepEqual(values(statistics.enrich(candle(), 100)), [null, 2_999, 4])
  statistics.trades(instId, [trade('2', 100, 'buy', '1')], 101)
  assert.deepEqual(values(statistics.enrich(candle(), 101)), [null, null, null])
  statistics.trades(instId, [trade('3002', fiveMinutes + 100, 'sell', '2')], fiveMinutes + 100)
  assert.deepEqual(values(statistics.enrich(candle(fiveMinutes), fiveMinutes + 100)), [null, 0, 2])
})

test('forming totals cannot be below already observed candle volume, and later valid trades can complete them', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  const forming = candle(0, '5m', false, 5)
  statistics.trades(instId, [trade('1', 100, 'buy', '2')], 100)
  assert.deepEqual(values(statistics.enrich(forming, 100)), [null, null, null])
  statistics.trades(instId, [trade('2', 101, 'sell', '4')], 101)
  assert.deepEqual(values(statistics.enrich(forming, 101)), [null, 2, 4])
})

test('removing and relisting an instrument cannot reuse old continuous coverage or observations', () => {
  const statistics = new LiveStatistics()
  statistics.start(instId, 0)
  statistics.trades(instId, [trade('1', 100)], 100)
  statistics.openInterest(instId, { oi: '10', ts: '100' }, 100)
  statistics.remove([instId])
  statistics.start(instId, 101)
  statistics.trades(instId, [trade('2', 200)], 200)
  assert.deepEqual(values(statistics.enrich(candle(), 200)), [null, null, null])
})

test('observations older than three hours expire without reviving retired subscriptions', () => {
  let now = 0
  const statistics = new LiveStatistics({ now: () => now })
  statistics.start(instId)
  now = 1_000
  statistics.trades(instId, [trade('1', now)])
  statistics.openInterest(instId, { oi: '5', ts: String(now) })
  statistics.disconnect([instId])
  now = 3 * hour + fiveMinutes
  statistics.disconnect(['ETH-USDT-SWAP'])
  assert.deepEqual(values(statistics.enrich(candle(0, '5m', true, 2))), [null, null, null])
  statistics.trades(instId, [trade('2', now)])
  assert.deepEqual(values(statistics.enrich(candle(now))), [null, null, null])
})
