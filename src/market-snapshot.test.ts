import assert from "node:assert/strict"
import test from "node:test"
import { reconcileMarketRows } from "./market-snapshot.ts"
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
