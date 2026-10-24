import assert from "node:assert/strict"
import test from "node:test"
import { MarketRowsBuffer, reconcileMarketRows } from "./market-snapshot.ts"
import type { NativeMarketRow } from "./market-row.ts"

test("bridge refreshes keep unchanged row identities while updating changed readings and opportunity", () => {
  const previous: NativeMarketRow[] = Array.from({ length: 3 }, (_, index) => ({
    instId: `MKT${index}`, turnover24hUSDT: 40_000_000, ema200Signal: "Long",
    price: 100, lastPrice: 101, priceChange: 1, currentLow: 99, currentHigh: 102,
    buy: 100, sell: 90, takerRatio: 5, oiChange: 2,
    highBreakout: { status: "none" }, lowBreakdown: { status: "none" },
    highBreakout96: { status: "none" }, lowBreakdown96: { status: "none" },
    roc: 2, maroc: 1, rocChange: 1, marocChange: 0.5,
    rsi6: 60, rsi12: 55, rsi24: 50, bollAboveBand: "middle", bollExpansion: null,
    opportunity: { direction: "Long", setup: "Startup", status: "Candidate", score: 87, components: null, reasons: [] },
  }))
  assert.equal(reconcileMarketRows(previous, structuredClone(previous)), previous)
  const incoming = structuredClone(previous)
  incoming[1].oiChange = -4
  incoming[2].opportunity.status = "Watch"
  incoming[2].opportunity.score = 21
  const next = reconcileMarketRows(previous, incoming)
  assert.equal(next[0], previous[0])
  assert.notEqual(next[1], previous[1])
  assert.equal(next[1].oiChange, -4)
  assert.equal(next[2].opportunity.score, 21)
  assert.deepEqual(reconcileMarketRows(next, [incoming[2], incoming[0]]), [next[2], next[0]])
})

test('contracts expire independently and new qualifying contracts appear immediately', () => {
  const buffer = new MarketRowsBuffer<NativeMarketRow>()
  const first = { instId: 'BTC-USDT-SWAP' } as NativeMarketRow
  const second = { instId: 'ETH-USDT-SWAP' } as NativeMarketRow
  buffer.update([first, second], 0, 'live:15m')
  assert.deepEqual(buffer.update([second], 1_000, 'live:15m'), [second, first])
  assert.equal(buffer.nextRemovalAt, 31_000)
  buffer.update([], 5_000, 'live:15m')
  assert.deepEqual(buffer.expire(30_999), [second, first])
  assert.deepEqual(buffer.expire(31_000), [second])
  assert.equal(buffer.nextRemovalAt, 35_000)
  const third = { instId: 'SOL-USDT-SWAP' } as NativeMarketRow
  assert.deepEqual(buffer.update([third], 34_999, 'live:15m'), [third, second])
  assert.deepEqual(buffer.expire(35_000), [third])
  assert.equal(buffer.nextRemovalAt, null)
})

test('a delayed refresh expires missing rows and a new collector session drops stale rows', () => {
  const buffer = new MarketRowsBuffer<NativeMarketRow>()
  const row = { instId: 'BTC-USDT-SWAP' } as NativeMarketRow
  buffer.update([row], 0, 'first:15m')
  buffer.update([], 100, 'first:15m')
  assert.deepEqual(buffer.update([], 30_100, 'first:15m'), [])
  buffer.update([row], 30_101, 'first:15m')
  buffer.update([], 30_102, 'first:15m')
  assert.deepEqual(buffer.update([], 30_103, 'second:15m'), [])
  assert.equal(buffer.nextRemovalAt, null)
})
