import assert from "node:assert/strict"
import test from "node:test"
import { describeBreak, formatBreakPriorAge, formatBreakTime, type BreakEvent, type BreakResult } from "./market-breaks.ts"

const hour = Date.UTC(2026, 9, 4, 2)
const event: BreakEvent = { status: "event", hour, hoursAgo: 3, priorHour: hour - 37 * 3_600_000, priorAgeHours: 37, priorPrice: 0.5769, live: false }

test("break readings distinguish event age, prior age at the break, and live candles", () => {
  assert.equal(formatBreakTime(event), "3h ago")
  assert.equal(formatBreakPriorAge(event), "37h old")
  assert.equal(formatBreakTime({ ...event, hoursAgo: 0, live: true }), "Live")
  assert.equal(formatBreakTime({ ...event, hoursAgo: 0 }), "0h ago")
})

test("missing states distinguish no event, short history, and visible loading", () => {
  for (const status of ["none", "insufficient-history"] as const) {
    const result: BreakResult = { status }
    assert.equal(formatBreakTime(result), "—")
    assert.equal(formatBreakPriorAge(result), "—")
  }
  assert.equal(formatBreakTime({ status: "loading" }), "Loading")
  assert.equal(formatBreakPriorAge({ status: "loading" }), "—")
  assert.equal(describeBreak({ status: "none" }, "high"), "No breakout in the last 48h")
  assert.equal(describeBreak({ status: "none" }, "low"), "No breakdown in the last 48h")
  assert.match(describeBreak({ status: "insufficient-history" }, "high"), /48 completed hourly candles since listing/)
  assert.match(describeBreak({ status: "loading" }, "low"), /Low breakdown: loading hourly candles/)
})

test("break details identify the candle interval, previous price and prior age without inventing a tick time", () => {
  const high = describeBreak(event, "high")
  assert.match(high, /^High breakout during .* – .*\. Previous 48h high: 0\.5769/)
  assert.match(high, /formed during the hour starting .*; 37h old at the break\.$/)
  assert.doesNotMatch(high, /Current candle is live/)
  const low = describeBreak({ ...event, live: true, hoursAgo: 0 }, "low")
  assert.match(low, /^Low breakdown during/)
  assert.match(low, /Previous 48h low: 0\.5769/)
  assert.match(low, /Current candle is live\.$/)
})
