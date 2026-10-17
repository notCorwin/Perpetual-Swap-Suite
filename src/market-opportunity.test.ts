import assert from "node:assert/strict"
import test from "node:test"
import { evaluateMarketOpportunity as evaluateMainProcessOpportunity } from "../electron/services/market-metrics.js"
import { evaluateMarketOpportunity, type OpportunityInput } from "./market-opportunity.ts"

const input: OpportunityInput = {
  ema200Signal: "Long",
  priceChange: 2,
  roc: 5,
  maroc: 1,
  rsi6: 60,
  rsi12: 55,
  rsi24: 58,
  takerRatio: 10,
  oiChange: 1,
  bollAboveBand: "middle",
  bollExpansion: { hours: 2, complete: true },
  highBreakout: { status: "event", hour: 1, hoursAgo: 2, priorHour: 0, priorAgeHours: 30, priorPrice: 100, live: false },
  lowBreakdown: { status: "none" },
}

test("renderer opportunity evaluation is the same canonical calculation used by Electron", () => {
  const renderer = evaluateMarketOpportunity(input)
  const mainProcess = evaluateMainProcessOpportunity(input)

  assert.deepEqual(renderer, mainProcess)
  assert.equal(renderer.status, "Candidate")
  assert.equal(renderer.setup, "Startup")
  assert.equal(renderer.score, 87)
})

test("non-finite snapshot percentages remain incomplete in both processes", () => {
  const nonFinite: OpportunityInput = { ...input, priceChange: Infinity }

  assert.deepEqual(evaluateMarketOpportunity(nonFinite), evaluateMainProcessOpportunity(nonFinite))
  assert.equal(evaluateMarketOpportunity(nonFinite).status, "Incomplete")
})
