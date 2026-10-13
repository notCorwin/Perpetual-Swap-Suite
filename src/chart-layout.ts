export type ChartPanel = "price" | "rsi" | "roc" | "oi" | "taker"

type Range = readonly [number, number]

export function chartCandleWidth(plotWidth: number) {
  return Math.max(5, Math.min(13, plotWidth / 96 * 0.68))
}

export function chartHourX(hour: number, latestHour: number, start: number, end: number) {
  const candleWidth = chartCandleWidth(end - start)
  return start + candleWidth / 2 + (hour - (latestHour - 95 * 3_600_000)) * (end - start - candleWidth) / (95 * 3_600_000)
}

export function fitAxisPriceTag(axisGutter: number, tagWidth: number, strokeWidth: number, minimumScale: number) {
  const fullTagWidth = tagWidth + strokeWidth
  const gutter = Math.ceil(Math.max(axisGutter, fullTagWidth * minimumScale))
  const scale = Math.min(1, gutter / fullTagWidth)
  return { gutter, scale, boxWidth: gutter / scale - strokeWidth }
}

export function chartLayout(width: number, height: number, labelGutter = 64) {
  const rightMargin = 4, top = 4, headerHeight = 24, rowGap = 3, bottomAxis = 22
  const right = width - rightMargin - labelGutter, column: Range = [0, right]
  const availableHeight = Math.max(1, height - top - bottomAxis - headerHeight * 5 - rowGap * 4)
  const order: ChartPanel[] = ["price", "roc", "rsi", "oi", "taker"]
  const weights: Record<ChartPanel, number> = { price: 0.4, roc: 0.15, rsi: 0.15, oi: 0.15, taker: 0.15 }
  const panels = {} as Record<ChartPanel, Range>
  const headerY = {} as Record<ChartPanel, number>
  let cursor = top
  for (const key of order) {
    headerY[key] = cursor + 13
    cursor += headerHeight
    panels[key] = [cursor, cursor + availableHeight * weights[key]]
    cursor = panels[key][1] + rowGap
  }
  const columns = Object.fromEntries(order.map(key => [key, column])) as Record<ChartPanel, Range>
  const axisStarts = Object.fromEntries(order.map(key => [key, right + 8])) as Record<ChartPanel, number>
  return { panels, columns, axisStarts, headerY, left: column[0], right }
}
