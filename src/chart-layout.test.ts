import assert from "node:assert/strict"
import test from "node:test"
import { chartCandleWidth, chartContentClip, chartHourX, chartLayout, chartPanelClip, chartPriceLabelLayout, type ChartPanel } from "./chart-layout.ts"

test("stacked chart layout stays aligned and bounded", () => {
  const order: ChartPanel[] = ["price", "roc", "rsi", "atr", "oi", "taker"]
  for (const [width, height] of [[900, 700], [1440, 900], [2560, 900]]) {
    const layout = chartLayout(width, height, 48)
    assert.equal(layout.left, 0)
    assert.equal(layout.right + 48, width - 4)
    assert.ok(Math.abs((layout.panels.price[1] - layout.panels.price[0]) / (layout.panels.roc[1] - layout.panels.roc[0]) - 40 / 12) < 0.001)
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

test("fractional content clipping stops before axis labels and legends", () => {
  const height = 700, layout = chartLayout(960, height, 64), clip = chartContentClip(layout, height)
  assert.equal(clip.x, layout.columns.price[0])
  assert.equal(clip.y, layout.panels.price[0])
  assert.equal(clip.width, layout.right - layout.columns.price[0])
  assert.equal(clip.y + clip.height, height)
  assert.ok(clip.x + clip.width < layout.axisStarts.price)
  assert.ok(clip.y > layout.headerY.price)

  const pitch = 8.5
  for (const panel of ["price", "roc", "rsi", "atr", "oi", "taker"] as const) {
    const inner = chartPanelClip(layout, panel, pitch)
    assert.equal(inner.x, layout.columns[panel][0] - pitch)
    assert.equal(inner.x + inner.width, layout.columns[panel][1] + pitch)
    assert.equal(inner.y, layout.panels[panel][0])
    assert.equal(inner.height, layout.panels[panel][1] - layout.panels[panel][0])
  }
  assert.equal(clip.x + clip.width, layout.right, 'The stationary outer clip still ends before the axis gutter.')
})

test("axis price and countdown share one-line spacing and outer padding", () => {
  assert.deepEqual(chartPriceLabelLayout(60, [10, 110], 10, 2, true), {
    countdownY: 70, top: 53, bottom: 77,
  })
})

test("countdown flips above with the same spacing near the lower boundary", () => {
  assert.deepEqual(chartPriceLabelLayout(100, [10, 110], 10, 2, true), {
    countdownY: 90, top: 83, bottom: 107,
  })
  assert.deepEqual(chartPriceLabelLayout(110, [10, 110], 10, 2, true), {
    countdownY: 100, top: 93, bottom: 110,
  })
})

test("price background clips at the upper boundary and leaves countdown below", () => {
  assert.deepEqual(chartPriceLabelLayout(10, [10, 110], 10, 2, true), {
    countdownY: 20, top: 10, bottom: 27,
  })
})

test("historical axis labels occupy one padded line", () => {
  assert.deepEqual(chartPriceLabelLayout(60, [10, 110], 10, 2, false), {
    countdownY: null, top: 53, bottom: 67,
  })
})

test("countdown is omitted when neither side fits inside a small panel", () => {
  assert.deepEqual(chartPriceLabelLayout(20, [10, 30], 10, 2, true), {
    countdownY: null, top: 13, bottom: 27,
  })
  assert.deepEqual(chartPriceLabelLayout(12, [10, 14], 10, 2, true), {
    countdownY: null, top: 10, bottom: 14,
  })
})

test("a countdown including its padding remains visible at an exact fit", () => {
  assert.deepEqual(chartPriceLabelLayout(93, [10, 110], 10, 2, true), {
    countdownY: 103, top: 86, bottom: 110,
  })
  assert.deepEqual(chartPriceLabelLayout(27, [10, 40], 10, 2, true), {
    countdownY: 17, top: 10, bottom: 34,
  })
})
