import assert from "node:assert/strict"
import test from "node:test"
import { chartHistoryNeedsLoad, chartStatsNeedLoad, livePriceTag, scrollChartEnd, visibleChartBars } from "./chart-viewport.ts"

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

test("cached coverage must not be used as the exchange history boundary", () => {
  const latest = 500 * hour
  const oldestCached = latest - 95 * hour
  assert.equal(scrollChartEnd(null, latest, -1, oldestCached), null, "Passing cached coverage reproduces the locked viewport")
  assert.equal(scrollChartEnd(null, latest, -1), latest - hour, "An unknown history boundary allows loading the preceding candle")
})

test("a cached candle range changes the visible 96-hour window immediately", () => {
  const bars = Array.from({ length: 250 }, (_, index) => ({ hour: index * hour }))
  assert.equal(visibleChartBars(bars, 249 * hour).length, 96)
  assert.equal(visibleChartBars(bars, 200 * hour)[0].hour, 105 * hour)
  assert.equal(visibleChartBars(bars, 200 * hour).at(-1)?.hour, 200 * hour)
})

test("a buffered history block avoids native requests until the viewport nears its left edge", () => {
  const oldest = 1_000 * hour
  assert.equal(chartHistoryNeedsLoad(1_499 * hour, oldest), false)
  assert.equal(chartHistoryNeedsLoad(1_144 * hour, oldest), false)
  assert.equal(chartHistoryNeedsLoad(1_143 * hour, oldest), true)
})

test("cached candles still request history when visible OI or taker data is missing", () => {
  const complete = Array.from({ length: 500 }, (_, index) => ({ hour: index * hour, confirmed: true, oi: 1, buy: 2, sell: 3 }))
  assert.equal(chartStatsNeedLoad(complete, 450 * hour), false)
  const missingOI = complete.map(bar => bar.hour === 420 * hour ? { ...bar, oi: null } : bar)
  assert.equal(chartStatsNeedLoad(missingOI, 450 * hour), true)
  const missingTaker = complete.map(bar => bar.hour === 420 * hour ? { ...bar, buy: null } : bar)
  assert.equal(chartStatsNeedLoad(missingTaker, 450 * hour), true)
  assert.equal(chartStatsNeedLoad(missingTaker, 300 * hour), false, "Only the visible window should trigger a statistics request")
})
