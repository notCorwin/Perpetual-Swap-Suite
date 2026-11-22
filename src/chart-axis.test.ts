import assert from "node:assert/strict"
import test from "node:test"
import { chartTimeLabels, chartTimeTicks, chartTimeTickStep } from "./chart-axis.ts"

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
