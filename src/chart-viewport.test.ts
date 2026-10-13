import assert from "node:assert/strict"
import test from "node:test"
import { livePriceTag, scrollChartEnd, visibleChartBars } from "./chart-viewport.ts"

const hour = 3_600_000
test("live price and countdown do not change when the chart scrolls into history", () => {
  const live = { hour: 100 * hour, open: 90, close: 110 }
  assert.deepEqual(livePriceTag(live, 40 * hour, 100 * hour + 30 * 60_000), {
    price: 110, rising: true, inViewport: false, secondsLeft: 1800,
  })
  assert.equal(livePriceTag(live, 100 * hour, 100 * hour + 30 * 60_000).secondsLeft, 1800)
  assert.equal(livePriceTag(live, 40 * hour, 101 * hour + 1000).secondsLeft, 0)
})

test("historical scrolling holds its hour while the latest candle advances", () => {
  assert.equal(scrollChartEnd(null, 100 * hour, -4), 96 * hour)
  assert.equal(scrollChartEnd(96 * hour, 101 * hour, 0), 96 * hour)
  assert.equal(scrollChartEnd(96 * hour, 101 * hour, 5), null)
  assert.equal(scrollChartEnd(null, 101 * hour, 0), null)
  assert.equal(scrollChartEnd(0, 101 * hour, -20), 95 * hour)
  assert.equal(scrollChartEnd(null, 249 * hour, -200, 0), 95 * hour)
  assert.equal(scrollChartEnd(105 * hour, 500 * hour, -1, 10 * hour), 105 * hour)
  assert.equal(scrollChartEnd(105 * hour, 500 * hour, -500, 10 * hour), 105 * hour)
  assert.equal(scrollChartEnd(105 * hour, 500 * hour, 1, 10 * hour), 106 * hour)
})

test("a cached candle range changes the visible 96-hour window immediately", () => {
  const bars = Array.from({ length: 250 }, (_, index) => ({ hour: index * hour }))
  assert.equal(visibleChartBars(bars, 249 * hour).length, 96)
  assert.equal(visibleChartBars(bars, 200 * hour)[0].hour, 105 * hour)
  assert.equal(visibleChartBars(bars, 200 * hour).at(-1)?.hour, 200 * hour)
})
