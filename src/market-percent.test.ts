import assert from "node:assert/strict"
import test from "node:test"
import { finitePercentage, formatCandleChange, formatPercent, type PercentageValue } from "./market-percent.ts"

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

test("non-finite percentages are unavailable for display and chart coordinates", () => {
  const readings: PercentageValue[] = [Infinity, 20, 0, -50, -Infinity, null, NaN]
  assert.deepEqual(readings.map(finitePercentage), [null, 20, 0, -50, null, null, null])
  assert.deepEqual(readings.map(value => formatPercent(value)), ["—", "+20.00%", "0.00%", "-50.00%", "—", "—", "—"])
})

test("active candle changes use its open, preserving direction and guarding invalid inputs", () => {
  assert.equal(formatCandleChange(100, 102), '+2.00% ↑')
  assert.equal(formatCandleChange(200, 196), '-2.00% ↓')
  assert.equal(formatCandleChange(100, 100), '0.00% ↑')
  assert.equal(formatCandleChange(100, 99.999), '0.00% ↓')
  assert.equal(formatCandleChange(0, 100), '—')
  assert.equal(formatCandleChange(NaN, 100), '—')
  assert.equal(formatCandleChange(100, Infinity), '—')
})
