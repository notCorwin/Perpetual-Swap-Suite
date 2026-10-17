import assert from "node:assert/strict"
import test from "node:test"
import { chartHistoryNeedsLoad, chartIndicatorsNeedLoad, chartScrollFloor, chartStatisticsRequestable, chartStatisticsSnapshotNeeded, chartStatsNeedLoad, chartViewportRuns, completeIndicatorSeries, hasCompleteChartWindow, livePriceTag, renderableChartEnd, renderableChartEndFromRuns, scrollChartEnd, visibleChartBars } from "./chart-viewport.ts"

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

test("a pending history range keeps rendering the nearest cached window", () => {
  const bars = Array.from({ length: 96 }, (_, index) => ({ hour: index * hour }))
  assert.equal(renderableChartEnd(bars, -hour), 95 * hour)
  assert.equal(renderableChartEnd(bars, 95 * hour), 95 * hour)
})

test("a partial overlap is not a renderable chart window", () => {
  const bars = Array.from({ length: 301 }, (_, index) => ({ hour: index * hour })).filter(bar => bar.hour !== 148 * hour)
  assert.equal(hasCompleteChartWindow(bars, 148 * hour), false)
  assert.equal(renderableChartEnd(bars, 148 * hour), 147 * hour)
  assert.equal(visibleChartBars(bars, renderableChartEnd(bars, 148 * hour)!, hour).length, 96)
  assert.equal(renderableChartEnd(bars.slice(0, 95), 94 * hour), null)
})

test("precomputed viewport runs preserve nearest complete-window selection", () => {
  const bars = Array.from({ length: 360 }, (_, index) => ({ hour: index * hour })).filter(bar => bar.hour !== 180 * hour)
  const runs = chartViewportRuns(bars)

  assert.deepEqual(runs, [
    { firstEnd: 95 * hour, lastEnd: 179 * hour },
    { firstEnd: 276 * hour, lastEnd: 359 * hour },
  ])
  for (const requested of [0, 95, 148, 180, 220, 276, 359, 400].map(value => value * hour)) {
    assert.equal(renderableChartEndFromRuns(runs, requested), renderableChartEnd(bars, requested))
  }
})

test("indicators render only for a complete visible candle window", () => {
  const complete = Array.from({ length: 96 }, (_, index) => ({ ema: index + 1 }))
  assert.equal(completeIndicatorSeries(complete, 'ema'), true)
  assert.equal(completeIndicatorSeries([...complete.slice(0, 95), { ema: null }], 'ema'), false)
  assert.equal(completeIndicatorSeries(complete.slice(1), 'ema'), false)
})

test("a complete visible candle window still reloads when a warm-up gap leaves an indicator null", () => {
  const bars = Array.from({ length: 500 }, (_, index) => ({
    hour: index * hour, vwap: 1, ema: 1, logBBUpper: 1, logBBMiddle: 1, logBBLower: 1,
    roc: 1, maroc: 1, rsi6: 1, rsi12: 1, rsi24: 1,
  }))
  const end = 450 * hour
  assert.equal(chartIndicatorsNeedLoad(bars, end), false)
  assert.equal(chartIndicatorsNeedLoad(bars.map(bar => bar.hour === 400 * hour ? { ...bar, ema: null } : bar), end), true)
  assert.equal(chartIndicatorsNeedLoad(bars.map(bar => bar.hour === 200 * hour ? { ...bar, ema: null } : bar), end), false)
})

test("a buffered history block avoids native requests until the viewport nears its left edge", () => {
  const oldest = 1_000 * hour
  assert.equal(chartHistoryNeedsLoad(1_499 * hour, oldest), false)
  assert.equal(chartHistoryNeedsLoad(1_144 * hour, oldest), false)
  assert.equal(chartHistoryNeedsLoad(1_143 * hour, oldest), true)
})

test("scrolling never requests an end below the earliest complete cached window", () => {
  assert.equal(chartScrollFloor(1_000 * hour, null), 1_095 * hour)
  assert.equal(chartScrollFloor(1_000 * hour, 900 * hour), 995 * hour)
  const bars = Array.from({ length: 96 }, (_, index) => ({ hour: (1_000 + index) * hour }))
  const floor = chartScrollFloor(1_000 * hour, null)
  assert.equal(renderableChartEnd(bars, floor), floor)
})

test("cached candles still request history when visible OI or taker data is missing", () => {
  const complete = Array.from({ length: 500 }, (_, index) => ({ hour: index * hour, confirmed: true, oi: 1, buy: 2, sell: 3 }))
  assert.equal(chartStatsNeedLoad(complete, 450 * hour), false)
  assert.equal(chartStatsNeedLoad(complete.slice(0, 95), 94 * hour), true, "A partial viewport must never look statistics-ready")
  const missingOI = complete.map(bar => bar.hour === 420 * hour ? { ...bar, oi: null } : bar)
  assert.equal(chartStatsNeedLoad(missingOI, 450 * hour), true)
  const missingTaker = complete.map(bar => bar.hour === 420 * hour ? { ...bar, buy: null } : bar)
  assert.equal(chartStatsNeedLoad(missingTaker, 450 * hour), true)
  assert.equal(chartStatsNeedLoad(missingTaker, 300 * hour), false, "Only the visible window should trigger a statistics request")
})

test("a complete visible window requests OI/Taker while an unrelated indicator warm-up repair retries", () => {
  const complete = Array.from({ length: 96 }, (_, index) => ({ hour: index * hour, confirmed: true, oi: 1, buy: 2, sell: 3 }))
  const missingOI = complete.map(bar => bar.hour === 40 * hour ? { ...bar, oi: null } : bar)

  assert.equal(chartStatisticsRequestable(missingOI, 95 * hour, 95 * hour), true)
  assert.equal(chartStatisticsRequestable(missingOI, 95 * hour, 94 * hour), false, "Never request statistics for a fallback viewport")
})

test("a completed source materializes its visible observations independently of the pending sibling", () => {
  const pending = Array.from({ length: 200 }, (_, index) => ({ hour: index * hour, oi: null as number | null, buy: null as number | null, sell: null as number | null, statisticsSources: 0 }))
  const status = { oiState: 'ready', takerState: 'loading' }
  assert.equal(chartStatisticsSnapshotNeeded(pending, 199 * hour, status), true)
  const oiOnly = pending.map(bar => ({ ...bar, oi: 10, statisticsSources: 1 }))
  assert.equal(chartStatisticsSnapshotNeeded(oiOnly, 199 * hour, status), false, "A held Taker request must not repeatedly materialize an already rendered OI source")
  assert.equal(chartStatisticsSnapshotNeeded(oiOnly, 199 * hour, { ...status, takerState: 'ready' }), true)
  assert.equal(chartStatisticsSnapshotNeeded(oiOnly, 199 * hour, { ...status, takerState: 'unavailable' }), true, "Terminal null observations must also reach the visible series")
  const observedNulls = pending.map(bar => ({ ...bar, statisticsSources: 3 }))
  assert.equal(chartStatisticsSnapshotNeeded(observedNulls, 199 * hour, { oiState: 'unavailable', takerState: 'unavailable' }), false)
  assert.equal(chartStatisticsSnapshotNeeded(observedNulls, 199 * hour, { oiState: 'ready', takerState: 'unavailable' }), true, "A revalidated source must replace its earlier terminal nulls")
  const distantPreview = pending.map(bar => bar.hour < 96 * hour ? { ...bar, statisticsSources: 3 } : bar)
  assert.equal(chartStatisticsSnapshotNeeded(distantPreview, 199 * hour, status), true, "A materialized distant range cannot settle the active viewport")
})
