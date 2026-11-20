import assert from "node:assert/strict"
import test from "node:test"
import { chartAxis, chartAxisForLabels, chartTimeTickStep, isChartTimeTick, logarithmicChartAxis, logarithmicScale } from "./chart-axis.ts"

test('time ticks track pixel spacing and stay aligned to actual candle times', () => {
  assert.equal(chartTimeTickStep(20, 90, 8), 6)
  assert.equal(chartTimeTickStep(5, 90, 8), 24)
  assert.equal(chartTimeTickStep(100, 90, 8), 1)
  for (const interval of [300_000, 900_000, 3_600_000]) {
    const bars = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 10, 20) + i * interval)
    const ticks = bars.filter(time => isChartTimeTick(time, interval, 6, -480))
    assert.ok(ticks.length >= 12)
    assert.ok(ticks.every((time, index) => index === 0 || time - ticks[index - 1] === 6 * interval))
    // A fractional viewport offset cannot change which timestamps are ticks.
    assert.deepEqual(bars.slice(1).filter(time => isChartTimeTick(time, interval, 6, -480)), ticks.filter(time => time !== bars[0]))
  }
  // Local midnight and subsequent six-hour ticks in UTC+8.
  assert.equal(isChartTimeTick(Date.UTC(2026, 10, 19, 16), 3_600_000, 6, -480), true)
  assert.equal(isChartTimeTick(Date.UTC(2026, 10, 19, 17), 3_600_000, 6, -480), false)
})

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
  const y = logarithmicScale(axis, panel)
  assert.ok(Math.abs((y(10) - y(100)) - (y(100) - y(1_000))) < 1e-9)
  assert.ok(axis.ticks.length <= 7 && axis.ticks.every(tick => tick > 0))
  for (const [min, max] of [[90, 94.34], [0.0000482, 0.0000491], [42, 42]]) {
    const narrow = logarithmicChartAxis(min, max, 8)
    const narrowY = logarithmicScale(narrow, panel)
    assert.ok(narrow.min > 0 && narrow.min < min && narrow.max > max)
    assert.ok(narrow.ticks.length >= 2 && narrow.ticks.length <= 8)
    assert.ok(narrow.ticks.every((tick, index) => index === 0 || tick > narrow.ticks[index - 1]))
    assert.ok(narrow.ticks.every(tick => Number.isFinite(narrowY(tick))))
  }
})

test("zero-inclusive log axes retain zero for open interest", () => {
  const axis = logarithmicChartAxis(0, 1_000, 6, true)
  const panel: readonly [number, number] = [0, 150]
  const y = logarithmicScale(axis, panel)
  assert.equal(y(0), panel[1])
  assert.ok(Math.abs((y(0) - y(1)) - (y(1) - y(3))) < 1e-9)
  assert.ok(y(500) < y(200))
  const empty = logarithmicChartAxis(0, 0, 4, true)
  assert.ok(empty.max > 0 && empty.ticks.includes(0))
  assert.ok(logarithmicChartAxis(0, 100, 5, true).ticks.length <= 5)
})
