import assert from 'node:assert/strict'
import test from 'node:test'
import { compareRanking, rankingFromCandles, type RankingCandle } from '../electron/services/ranking.js'

const interval = 300_000
const closeBoundary = Date.UTC(2026, 9, 18, 12, 15)
const unavailable = { rankingChange: null, rankingAsOf: null }
const candle = (timestamp: number, close: number): RankingCandle => ({
  instrument: 'BTC-USDT-SWAP', timestamp, timeframe: '5m', confirmed: true, close,
})
const path = (closes = [100, 101, 101.5, 102], boundary = closeBoundary) =>
  closes.map((close, index) => candle(boundary - (closes.length - index) * interval, close))

test('ranking uses the completed close boundary and an independent 15-minute baseline', () => {
  // Opens: 11:55, 12:00, 12:05, 12:10; closes: 12:00 through 12:15.
  const candles = path()
  const before = structuredClone(candles)
  assert.deepEqual(rankingFromCandles(candles, 15, closeBoundary), { rankingChange: 2, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(candles, 15, closeBoundary + interval - 1), { rankingChange: 2, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles([...candles].reverse(), 15, closeBoundary), { rankingChange: 2, rankingAsOf: closeBoundary })
  assert.deepEqual(candles, before)
})

test('ranking never falls back to a stale completed endpoint at a missing as-of boundary', () => {
  const candles = path()
  assert.deepEqual(rankingFromCandles(candles, 15, closeBoundary - 1), unavailable)
  assert.deepEqual(rankingFromCandles(candles, 15, closeBoundary + interval), unavailable)
  const forming = { ...candle(closeBoundary, 999), confirmed: false }
  assert.deepEqual(rankingFromCandles([...candles, forming], 15, closeBoundary + 60_000), { rankingChange: 2, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles([...candles, forming], 15, closeBoundary + interval), unavailable)
})

test('signed relative change uses the absolute baseline and distinguishes zero from missing', () => {
  assert.deepEqual(rankingFromCandles(path([-100, -99, -98, -95]), 15, closeBoundary), { rankingChange: 5, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(path([100, 99, 98, 95]), 15, closeBoundary), { rankingChange: -5, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(path([100, 100, 100, 100]), 15, closeBoundary), { rankingChange: 0, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(path([100, 50, 10, 0]), 15, closeBoundary), { rankingChange: -100, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(path([0, 1, 2, 3]), 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles(path([-0, 1, 2, 3]), 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles(path([-Number.MAX_VALUE, -1, 1, Number.MAX_VALUE]), 15, closeBoundary), { rankingChange: 200, rankingAsOf: closeBoundary })
  assert.deepEqual(rankingFromCandles(path([Number.MIN_VALUE, 1, 2, Number.MAX_VALUE]), 15, closeBoundary), unavailable)
})

test('missing baselines, gaps and duplicate required records are unavailable', () => {
  const candles = path()
  assert.deepEqual(rankingFromCandles(candles.slice(1), 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles(candles.filter((_, index) => index !== 1), 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles([...candles, { ...candles[1] }], 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles([...candles, { ...candles[1], close: 500 }], 15, closeBoundary), unavailable)
  assert.deepEqual(rankingFromCandles([], 15, closeBoundary), unavailable)
})

test('native 5m confirmation, timestamps, numeric closes and one instrument are required', () => {
  const replacements = [
    { timeframe: '15m' }, { timeframe: '1h' }, { timeframe: undefined },
    { confirmed: false }, { confirmed: undefined }, { confirmed: '1' },
    { close: Number.NaN }, { close: Infinity }, { close: '101' }, { close: undefined },
    { timestamp: closeBoundary - 2 * interval + 1 }, { timestamp: (closeBoundary - 2 * interval) / 1000 },
    { timestamp: Number.NaN }, { instrument: 'ETH-USDT-SWAP' }, { instrument: '' },
  ]
  for (const replacement of replacements) {
    const candles = path()
    candles[2] = { ...candles[2], ...replacement } as RankingCandle
    assert.deepEqual(rankingFromCandles(candles, 15, closeBoundary), unavailable, JSON.stringify(replacement))
  }
  assert.deepEqual(rankingFromCandles(path().map(({ instrument: _instrument, ...entry }) => entry), 15, closeBoundary), { rankingChange: 2, rankingAsOf: closeBoundary })
})

test('only positive 5-minute lookbacks and valid millisecond as-of values are accepted', () => {
  for (const lookback of [0, -5, 1, 7, 5.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(rankingFromCandles(path(), lookback, closeBoundary), unavailable)
  }
  for (const asOf of [-1, Number.NaN, Infinity, closeBoundary + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(rankingFromCandles(path(), 15, asOf), unavailable)
  }
  assert.deepEqual(rankingFromCandles(path(), 5, closeBoundary), {
    rankingChange: (102 - 101.5) / 101.5 * 100, rankingAsOf: closeBoundary,
  })
})

test('historical extras do not alter the required path', () => {
  const candles = path()
  const old = { ...candle(closeBoundary - 10 * interval, 50), timeframe: '1h', confirmed: false }
  assert.deepEqual(rankingFromCandles([old, { ...old }, ...candles], 15, closeBoundary), { rankingChange: 2, rankingAsOf: closeBoundary })
})

test('+2%, -5%, +1% rank by absolute change descending with unavailable values last', () => {
  const rows = [
    { instId: 'PLUS-TWO', ...rankingFromCandles(path([100, 101, 101, 102]), 15, closeBoundary) },
    { instId: 'MINUS-FIVE', ...rankingFromCandles(path([100, 99, 97, 95]), 15, closeBoundary) },
    { instId: 'PLUS-ONE', ...rankingFromCandles(path([100, 100, 100, 101]), 15, closeBoundary) },
    { instId: 'UNKNOWN', ...unavailable },
  ]
  assert.deepEqual(rows.sort(compareRanking).map(row => row.instId), ['MINUS-FIVE', 'PLUS-TWO', 'PLUS-ONE', 'UNKNOWN'])
})

test('ranking ties use fixed instrument IDs for both known and unavailable changes', () => {
  const rows = [
    { instId: 'C-USDT-SWAP', rankingChange: -2 },
    { instId: 'B-USDT-SWAP', rankingChange: 2 },
    { instId: 'A-USDT-SWAP', rankingChange: 0 },
    { instId: 'Z-USDT-SWAP', rankingChange: null },
    { instId: 'Y-USDT-SWAP', rankingChange: Number.NaN },
    { instId: 'X-USDT-SWAP', rankingChange: Infinity },
  ]
  assert.deepEqual(rows.sort(compareRanking).map(row => row.instId), ['B-USDT-SWAP', 'C-USDT-SWAP', 'A-USDT-SWAP', 'X-USDT-SWAP', 'Y-USDT-SWAP', 'Z-USDT-SWAP'])
  assert.equal(compareRanking({ instId: 'A', rankingChange: 2 }, { instId: 'A', rankingChange: -2 }), 0)
  assert.equal(compareRanking({ instId: 'A', rankingChange: null }, { instId: 'A', rankingChange: null }), 0)
})

test('changing chart timeframe does not change the ranking lookback or native 5m inputs', () => {
  const state = { chartTimeframe: '5m', rankingLookback: 15, nativeCandles: path() }
  const before = rankingFromCandles(state.nativeCandles, state.rankingLookback, closeBoundary)
  for (const chartTimeframe of ['15m', '1h', '5m']) {
    state.chartTimeframe = chartTimeframe
    assert.deepEqual(rankingFromCandles(state.nativeCandles, state.rankingLookback, closeBoundary), before)
  }
  assert.equal(before.rankingChange, 2)
  // An aggregated chart series cannot substitute for the native ranking series.
  assert.deepEqual(rankingFromCandles(path().map(entry => ({ ...entry, timeframe: '15m' })), 15, closeBoundary), unavailable)
})
