import assert from "node:assert/strict"
import test from "node:test"
import { chartAxis, chartAxisForLabels, chartTimeLabels, chartTimeTicks, chartTimeTickStep, logarithmicChartAxis, logarithmicScale } from "./chart-axis.ts"

test('time labels preserve date context across days and stay inside the axis without overlaps', () => {
  const start = new Date(2026, 10, 20, 22, 0).getTime()
  const ticks = Array.from({ length: 5 }, (_, i) => ({ hour: start + i * 3_600_000, x: i * 150 }))
  const measure = (label: string) => label.length * 7
  const labels = chartTimeLabels(ticks, 0, 600, 8, measure)
  assert.match(labels[0].label, /Nov 20, 22:00/)
  assert.equal(labels[1].label, '23:00')
  assert.match(labels[2].label, /Nov 21, 00:00/)
  assert.equal(labels[3].label, '01:00')
  assert.deepEqual(labels.map(label => label.major), [true, false, true, false, false])
  assert.equal(labels[0].anchor, 'start')
  assert.equal(labels.at(-1)?.anchor, 'end')
  assert.ok(labels.every((label, i) => label.x === ticks.find(tick => tick.hour === label.hour)?.x && label.left >= 0 && label.right <= 600 && (!i || label.left >= labels[i - 1].right + 8)))
  assert.deepEqual(chartTimeLabels(ticks, 0, 20, 8, measure), [])
})

test('viewport time ticks remain regular at the right edge and across missing candles', () => {
  const interval = 900_000
  const start = Date.UTC(2026, 10, 20, 8, 17) // 16:17 in UTC+8
  const end = Date.UTC(2026, 10, 20, 13, 8) // 21:08 in UTC+8
  const ticks = chartTimeTicks(start, end, interval, 6, -480)
  assert.deepEqual(ticks, [16.5, 18, 19.5, 21].map(hour => Date.UTC(2026, 10, 20) + (hour - 8) * 3_600_000))
  // Tick generation is based on the viewport, so an absent candle at 19:30
  // cannot remove the corresponding label or grid line.
  assert.ok(ticks.includes(Date.UTC(2026, 10, 20, 11, 30)))
  assert.deepEqual(chartTimeTicks(start + interval / 3, end, interval, 6, -480), ticks)
  assert.deepEqual(chartTimeTicks(end, start, interval, 6, -480), [])
})

test('time ticks track pixel spacing and stay aligned to actual candle times', () => {
  assert.equal(chartTimeTickStep(20, 90, 8), 6)
  assert.equal(chartTimeTickStep(5, 90, 8), 24)
  assert.equal(chartTimeTickStep(100, 90, 8), 1)
  for (const interval of [300_000, 900_000, 3_600_000]) {
    const bars = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 10, 20) + i * interval)
    const ticks = chartTimeTicks(bars[0], bars.at(-1)!, interval, 6, -480)
    assert.ok(ticks.length >= 12)
    assert.ok(ticks.every((time, index) => index === 0 || time - ticks[index - 1] === 6 * interval))
    // A fractional viewport offset cannot change which timestamps are ticks.
    assert.deepEqual(chartTimeTicks(bars[1], bars.at(-1)!, interval, 6, -480), ticks.filter(time => time !== bars[0]))
  }
  // Local midnight and subsequent six-hour ticks in UTC+8.
  assert.deepEqual(chartTimeTicks(Date.UTC(2026, 10, 19, 16), Date.UTC(2026, 10, 19, 17), 3_600_000, 6, -480), [Date.UTC(2026, 10, 19, 16)])
})

test("linear axes keep data bounds independent of rounded ticks", () => {
  const price = chartAxis(90.23, 94.34, 8)
  assert.deepEqual([price.min, price.max], [90.23, 94.34])
  assert.deepEqual(price.ticks, [91, 92, 93, 94])
  assert.deepEqual(chartAxis(0.0000482, 0.0000491, 8).ticks, [0.0000482, 0.0000484, 0.0000486, 0.0000488, 0.000049])
  assert.deepEqual(chartAxis(2_567_200, 4_813_800).ticks, [3_000_000, 3_500_000, 4_000_000, 4_500_000])
  const flat = chartAxis(42, 42)
  assert.ok(flat.min < 42 && flat.max > 42)
  const roc = chartAxis(-38.9, 38.9, 8)
  assert.deepEqual([roc.min, roc.max], [-38.9, 38.9])
  assert.ok(roc.ticks.every(tick => tick >= roc.min && tick <= roc.max))
})

test("indicator labels use an even, rounded interval within the available height", () => {
  for (const [min, max] of [[1_450_000_000, 1_700_000_000], [1_430_000_000, 1_730_000_000], [0, 519_660]]) {
    const axis = chartAxisForLabels(min, max, 4)
    assert.deepEqual([axis.min, axis.max], [min, max])
    assert.ok(axis.ticks.length <= 4)
    assert.ok(axis.ticks.every((tick, index) => tick >= min && tick <= max && (!index || Math.abs(tick - axis.ticks[index - 1] - axis.step) < axis.step * 1e-9)))
  }
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
