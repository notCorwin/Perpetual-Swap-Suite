export const CHART_PANELS = ["price", "roc", "rsi", "atr", "oi", "taker"] as const
export type ChartPanel = typeof CHART_PANELS[number]

type Range = readonly [number, number]

export function chartCandleWidth(plotWidth: number) {
  return Math.max(5, Math.min(13, plotWidth / 96 * 0.68))
}

export function chartHourX(hour: number, latestHour: number, start: number, end: number, intervalMS = 3_600_000) {
  const candleWidth = chartCandleWidth(end - start)
  return start + candleWidth / 2 + (hour - (latestHour - 95 * intervalMS)) * (end - start - candleWidth) / (95 * intervalMS)
}

export function chartPriceLabelLayout(priceY: number, panel: Range, fontSize: number, paddingY: number, showCountdown: boolean) {
  const halfLine = fontSize / 2
  const below = priceY + fontSize
  const above = priceY - fontSize
  const countdownY = !showCountdown ? null
    : below + halfLine + paddingY <= panel[1] ? below
      : above - halfLine - paddingY >= panel[0] ? above : null
  // Keep the price anchor fixed; only its background clips at panel edges.
  return {
    countdownY,
    top: Math.max(panel[0], Math.min(priceY, countdownY ?? priceY) - halfLine - paddingY),
    bottom: Math.min(panel[1], Math.max(priceY, countdownY ?? priceY) + halfLine + paddingY),
  }
}

export function chartLayout(width: number, height: number, labelGutter = 64, leftLabelGutter = 0) {
  const rightMargin = 4, top = 4, headerHeight = 24, rowGap = 3, bottomAxis = 22
  const right = width - rightMargin - labelGutter, column: Range = [leftLabelGutter, right]
  const order = CHART_PANELS
  const availableHeight = Math.max(1, height - top - bottomAxis - headerHeight * order.length - rowGap * (order.length - 1))
  const weights: Record<ChartPanel, number> = { price: 0.4, roc: 0.12, rsi: 0.12, atr: 0.12, oi: 0.12, taker: 0.12 }
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
