import assert from "node:assert/strict"
import test from "node:test"
import { finitePercentage, formatPercent, percentageNumber, type PercentageValue } from "./market-percent.ts"

test("percentage readings keep their native percentage units and two decimal places", () => {
  for (const [value, expected] of [
    [20, "+20.00%"], [-20, "-20.00%"], [25, "+25.00%"],
    [100, "+100.00%"], [-50, "-50.00%"], [0, "0.00%"],
    [-0, "0.00%"], [null, "—"], [NaN, "—"],
  ] as const) {
    assert.equal(formatPercent(value), expected)
  }
  assert.equal(formatPercent(20, 0), "+20%")
  assert.equal(formatPercent(-0.001, 3), "-0.001%")
})

test("native infinity tokens display as signed percentages and retain their numeric direction", () => {
  for (const [value, expected, numeric] of [
    ["Infinity", "+∞%", Infinity], ["-Infinity", "−∞%", -Infinity],
    [Infinity, "+∞%", Infinity], [-Infinity, "−∞%", -Infinity],
  ] as const) {
    const snapshot = JSON.parse(JSON.stringify({ change: typeof value === "number" ? String(value) : value }))
    assert.equal(formatPercent(snapshot.change), expected)
    assert.equal(formatPercent(value), expected)
    assert.equal(percentageNumber(snapshot.change), numeric)
  }
  assert.equal(percentageNumber(null), null)
  assert.equal(percentageNumber(NaN), null)
})

test("chart coordinates include zero and finite percentages while infinite readings remain available to legends", () => {
  const readings: PercentageValue[] = ["Infinity", 20, 0, -50, "-Infinity", null, NaN]
  assert.deepEqual(readings.map(finitePercentage), [null, 20, 0, -50, null, null, null])
  assert.deepEqual(readings.map(value => formatPercent(value)), ["+∞%", "+20.00%", "0.00%", "-50.00%", "−∞%", "—", "—"])
})
