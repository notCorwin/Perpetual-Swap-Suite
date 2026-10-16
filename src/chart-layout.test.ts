import assert from "node:assert/strict"
import test from "node:test"
import { chartCandleWidth, chartHourX, chartLayout, fitAxisPriceTag, type ChartPanel } from "./chart-layout.ts"
import { placeChartLabels, type ChartLabel } from "./chart-label-layout.ts"

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

test("price tag rests inside the axis gutter without clipping or shrinking below axis text", () => {
  const stroke = 1.5, intrinsicWidth = 90, minimumScale = 10 / 12
  const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9)
  const narrow = fitAxisPriceTag(42, intrinsicWidth, stroke, minimumScale)
  assert.ok(narrow.scale >= minimumScale)
  assert.ok(narrow.gutter < intrinsicWidth + stroke + 6)
  closeTo(narrow.offset * narrow.scale, 2)
  closeTo((narrow.boxWidth + stroke) * narrow.scale, narrow.gutter - 6)

  const medium = fitAxisPriceTag(85, intrinsicWidth, stroke, minimumScale)
  assert.equal(medium.gutter, 85)
  assert.ok(medium.scale > narrow.scale && medium.scale < 1)
  closeTo(medium.offset * medium.scale, 2)
  closeTo((medium.boxWidth + stroke) * medium.scale, medium.gutter - 6)

  const wide = fitAxisPriceTag(120, intrinsicWidth, stroke, minimumScale)
  assert.equal(wide.gutter, 120)
  assert.equal(wide.scale, 1)
  assert.equal(wide.offset, 2)
  assert.equal(wide.boxWidth + stroke, wide.gutter - 6)
})

test("chart move labels occupy collision-free lanes while retaining their anchors", () => {
  const labels: ChartLabel[] = Array.from({ length: 8 }, (_, index) => ({
    id: `label-${index}`,
    anchorX: 100 + index * 2,
    anchorY: 100,
    text: `LONG #${index + 1}`,
    side: "bottom",
    priority: index,
  }))
  const layout = placeChartLabels(labels, { left: 0, right: 240, top: 20, bottom: 280 }, text => text.length * 7)
  const visible = [...layout.labels.values()].filter(label => !label.hidden)
  assert.equal(visible.length, labels.length)
  assert.equal(visible[0].x, labels[0].anchorX)
  for (const [index, label] of visible.entries()) {
    assert.ok(label.y > label.anchorY)
    for (const other of visible.slice(index + 1)) {
      const separatedHorizontally = label.x + label.width / 2 + 3 <= other.x - other.width / 2 || other.x + other.width / 2 + 3 <= label.x - label.width / 2
      const separatedVertically = Math.abs(label.y - other.y) >= 19
      assert.ok(separatedHorizontally || separatedVertically)
    }
  }
})

test("chart move labels stay inside the plot and summarize unavoidable overflow", () => {
  const labels: ChartLabel[] = Array.from({ length: 6 }, (_, index) => ({
    id: `label-${index}`,
    anchorX: index % 2 ? 2 : 198,
    anchorY: 55,
    text: `EXIT SHORT #${index + 1}`,
    side: "top",
    priority: index,
  }))
  const layout = placeChartLabels(labels, { left: 0, right: 200, top: 30, bottom: 80 }, text => text.length * 7)
  const visible = [...layout.labels.values()].filter(label => !label.hidden)
  assert.ok(visible.every(label => label.x - label.width / 2 >= 0 && label.x + label.width / 2 <= 200))
  assert.equal(layout.summaries.length, 1)
  assert.equal(layout.summaries[0].count, labels.length - visible.length)
  assert.match(layout.summaries[0].text, /^\+\d+$/)
})
