import assert from "node:assert/strict"
import test from "node:test"
import { chartAxis, chartAxisForLabels, logarithmicChartAxis, logarithmicY } from "./chart-axis.ts"

test("axes fit the plotted range and keep labels sparse", () => {
  const price = chartAxis(90, 94.34, 8)
  assert.equal(price.max, 95)
  assert.deepEqual(price.ticks, [90, 91, 92, 93, 94, 95])
  assert.deepEqual(chartAxis(0.0000482, 0.0000491, 8).ticks, [0.0000482, 0.0000484, 0.0000486, 0.0000488, 0.000049, 0.0000492])
  assert.deepEqual(chartAxis(2_567_200, 4_813_800).ticks, [2_500_000, 3_000_000, 3_500_000, 4_000_000, 4_500_000, 5_000_000])
  const taker = chartAxis(0, 519_660)
  assert.equal(taker.max, 600_000)
  const roc = chartAxis(-38.9, 38.9, 8)
  assert.deepEqual([roc.min, roc.max], [-40, 40])
  const narrowOI = chartAxis(10_000_000, 10_100_000)
  assert.deepEqual([narrowOI.min, narrowOI.max], [10_000_000, 10_100_000])
  assert.deepEqual([chartAxis(0, 0.03, 8).min, chartAxis(0, 0.03, 8).max], [0, 0.03])
})

test("indicator labels use an even, rounded interval within the available height", () => {
  const oi = chartAxisForLabels(1_450_000_000, 1_700_000_000, 4)
  assert.deepEqual(oi.ticks, [1_400_000_000, 1_500_000_000, 1_600_000_000, 1_700_000_000])
  assert.deepEqual(chartAxisForLabels(1_430_000_000, 1_730_000_000, 4).ticks, [1_400_000_000, 1_600_000_000, 1_800_000_000])
  assert.deepEqual(chartAxisForLabels(0, 519_660, 4).ticks, [0, 200_000, 400_000, 600_000])
})

test("price log axis gives equal space to equal price ratios and handles narrow ranges", () => {
  const axis = logarithmicChartAxis(10, 1_000, 7)
  const panel: readonly [number, number] = [0, 300]
  assert.ok(Math.abs((logarithmicY(10, axis, panel) - logarithmicY(100, axis, panel)) - (logarithmicY(100, axis, panel) - logarithmicY(1_000, axis, panel))) < 1e-9)
  assert.ok(axis.ticks.length <= 7 && axis.ticks.every(tick => tick > 0))
  for (const [min, max] of [[90, 94.34], [0.0000482, 0.0000491], [42, 42]]) {
    const narrow = logarithmicChartAxis(min, max, 8)
    assert.ok(narrow.min > 0 && narrow.min < min && narrow.max > max)
    assert.ok(narrow.ticks.length >= 2 && narrow.ticks.length <= 8)
    assert.ok(narrow.ticks.every((tick, index) => index === 0 || tick > narrow.ticks[index - 1]))
    assert.ok(narrow.ticks.every(tick => Number.isFinite(logarithmicY(tick, narrow, panel))))
  }
})

test("zero-inclusive log axes retain zero for open interest", () => {
  const axis = logarithmicChartAxis(0, 1_000, 6, true)
  const panel: readonly [number, number] = [0, 150]
  assert.equal(logarithmicY(0, axis, panel), panel[1])
  assert.ok(Math.abs((logarithmicY(0, axis, panel) - logarithmicY(1, axis, panel)) - (logarithmicY(1, axis, panel) - logarithmicY(3, axis, panel))) < 1e-9)
  assert.ok(logarithmicY(500, axis, panel) < logarithmicY(200, axis, panel))
  const empty = logarithmicChartAxis(0, 0, 4, true)
  assert.ok(empty.max > 0 && empty.ticks.includes(0))
  assert.ok(logarithmicChartAxis(0, 100, 5, true).ticks.length <= 5)
})
