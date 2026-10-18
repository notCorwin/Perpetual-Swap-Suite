import assert from "node:assert/strict"
import test from "node:test"
import { chartCandleWidth, chartHourX, chartLayout, chartPriceLabelLayout, type ChartPanel } from "./chart-layout.ts"

test("stacked chart layout stays aligned and bounded", () => {
  const order: ChartPanel[] = ["price", "roc", "rsi", "oi", "taker"]
  for (const [width, height] of [[900, 700], [1440, 900], [2560, 900]]) {
    const layout = chartLayout(width, height, 48)
    assert.equal(layout.right + 48, width - 4)
    assert.ok(Math.abs((layout.panels.price[1] - layout.panels.price[0]) / (layout.panels.roc[1] - layout.panels.roc[0]) - 40 / 15) < 0.001)
    for (const [index, key] of order.entries()) {
      assert.deepEqual(layout.columns[key], layout.columns.price)
      assert.ok(layout.axisStarts[key] - layout.columns[key][1] >= 8)
      assert.ok(layout.axisStarts[key] < width)
      assert.ok(layout.columns[key][0] < layout.columns[key][1] && layout.columns[key][1] <= width)
      assert.ok(layout.panels[key][0] < layout.panels[key][1] && layout.panels[key][1] <= height)
      assert.ok(layout.headerY[key] < layout.panels[key][0])
      if (index) assert.ok(layout.panels[order[index - 1]][1] < layout.panels[key][0])
    }
  }
})

test("chart hours retain their position when candles are missing", () => {
  const hour = 3_600_000
  const first = chartHourX(0, 95 * hour, 0, 960)
  const last = chartHourX(95 * hour, 95 * hour, 0, 960)
  const candleWidth = chartCandleWidth(960)
  assert.equal(first - candleWidth / 2, 0)
  assert.equal(last + candleWidth / 2, 960)
  assert.equal(chartHourX(10 * hour, 95 * hour, 0, 960), first + (last - first) * 10 / 95)
})

test("axis price row preserves its size and places countdown below in open space", () => {
  assert.deepEqual(chartPriceLabelLayout(60, [10, 110], 20, 12, 3, true), {
    priceTop: 50, priceHeight: 20, countdownY: 79, top: 50, bottom: 85,
  })
})

test("countdown flips above near the lower boundary without moving the price row", () => {
  assert.deepEqual(chartPriceLabelLayout(100, [10, 110], 20, 12, 3, true), {
    priceTop: 90, priceHeight: 20, countdownY: 81, top: 75, bottom: 110,
  })
  assert.deepEqual(chartPriceLabelLayout(110, [10, 110], 20, 12, 3, true), {
    priceTop: 100, priceHeight: 10, countdownY: 91, top: 85, bottom: 110,
  })
})

test("price background clips at the upper boundary and leaves countdown below", () => {
  assert.deepEqual(chartPriceLabelLayout(10, [10, 110], 20, 12, 3, true), {
    priceTop: 10, priceHeight: 10, countdownY: 29, top: 10, bottom: 35,
  })
})

test("historical axis labels occupy only their price row", () => {
  assert.deepEqual(chartPriceLabelLayout(60, [10, 110], 20, 12, 3, false), {
    priceTop: 50, priceHeight: 20, countdownY: null, top: 50, bottom: 70,
  })
})

test("countdown is omitted when neither side fits inside a small panel", () => {
  assert.deepEqual(chartPriceLabelLayout(20, [10, 30], 20, 12, 3, true), {
    priceTop: 10, priceHeight: 20, countdownY: null, top: 10, bottom: 30,
  })
  assert.deepEqual(chartPriceLabelLayout(12, [10, 14], 20, 12, 3, true), {
    priceTop: 10, priceHeight: 4, countdownY: null, top: 10, bottom: 14,
  })
})

test("a countdown that exactly fits a panel edge remains visible", () => {
  assert.deepEqual(chartPriceLabelLayout(85, [10, 110], 20, 12, 3, true), {
    priceTop: 75, priceHeight: 20, countdownY: 104, top: 75, bottom: 110,
  })
})
