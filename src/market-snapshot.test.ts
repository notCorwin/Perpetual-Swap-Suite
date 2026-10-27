import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileMarketOrder, reconcileMarketRows } from './market-snapshot.ts'
import type { RankedMarketRow } from './desktop-contract.ts'

const row = (instId: string, lastPrice = 100): RankedMarketRow => ({ instId, lastPrice, turnover24hUSDT: 40_000_000, rankingChange: 1, rankingAsOf: 900_000 })

test('navigation order identity follows membership and order rather than row prices', () => {
  const previous = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']
  assert.equal(reconcileMarketOrder(previous, [...previous]), previous)
  assert.deepEqual(reconcileMarketOrder(previous, [...previous].reverse()), ['ETH-USDT-SWAP', 'BTC-USDT-SWAP'])
  assert.deepEqual(reconcileMarketOrder(previous, ['ETH-USDT-SWAP']), ['ETH-USDT-SWAP'])
  assert.deepEqual(reconcileMarketOrder(previous, []), [])
})

test('snapshot reconciliation preserves unchanged row identities and backend order', () => {
  const previous = [row('BTC-USDT-SWAP'), row('ETH-USDT-SWAP')]
  assert.equal(reconcileMarketRows(previous, structuredClone(previous)), previous)
  const next = reconcileMarketRows(previous, [row('ETH-USDT-SWAP', 101), row('BTC-USDT-SWAP')])
  assert.deepEqual(next.map(value => value.instId), ['ETH-USDT-SWAP', 'BTC-USDT-SWAP'])
  assert.equal(next[1], previous[0])
  assert.equal(next[0].lastPrice, 101)
  assert.notEqual(next[0], previous[1])
})

test('snapshot reconciliation applies backend membership immediately', () => {
  const previous = [row('BTC-USDT-SWAP'), row('ETH-USDT-SWAP')]
  assert.deepEqual(reconcileMarketRows(previous, [row('ETH-USDT-SWAP')]), [previous[1]])
  assert.deepEqual(reconcileMarketRows(previous, []), [])
})
