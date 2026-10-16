import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { keepSnapshotValue, reconcileMarketRows } from "./market-snapshot.ts"
import type { NativeMarketRow } from "./rule-engine.ts"

test("bridge refreshes keep unchanged row identities while updating changed readings and opportunity", () => {
  const fixtures = JSON.parse(readFileSync(new URL("../Tests/Fixtures/filter-compatibility.json", import.meta.url), "utf8")) as { row: NativeMarketRow }[]
  const previous = fixtures.slice(0, 3).map((fixture, index) => ({ ...fixture.row, instId: `MKT${index}` }))
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

test("unchanged catalog and match results do not trigger editor or table updates", () => {
  const results = { BTC: "true", ETH: "unknown" }
  assert.equal(keepSnapshotValue(results, { ...results }), results)
  assert.notEqual(keepSnapshotValue(results, { BTC: "false", ETH: "unknown" }), results)
  const choices = [{ value: "rising", label: "Rising" }]
  assert.equal(keepSnapshotValue(choices, structuredClone(choices)), choices)
})
