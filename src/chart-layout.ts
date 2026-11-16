// Wider default candles; resize in coarse steps while data demand stays independent.
export function chartViewportBars(plotWidth: number) {
  return Math.min(192, 64 + Math.max(0, Math.floor((plotWidth - 720) / 240)) * 32)
}

export const CHART_PANELS = ["price", "roc", "rsi", "atr", "oi", "taker"] as const
export type ChartPanel = typeof CHART_PANELS[number]

type Range = readonly [number, number]

export function chartCandleWidth(plotWidth: number, windowBars = 96) {
  return Math.max(5, Math.min(13, plotWidth / windowBars * 0.68))
}

export function chartHourX(hour: number, latestHour: number, start: number, end: number, intervalMS = 3_600_000, windowBars = 96) {
  const candleWidth = chartCandleWidth(end - start, windowBars)
  return start + candleWidth / 2 + (hour - (latestHour - (windowBars - 1) * intervalMS)) * (end - start - candleWidth) / ((windowBars - 1) * intervalMS)
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

export function chartContentClip(layout: ReturnType<typeof chartLayout>, height: number) {
  const top = layout.panels.price[0]
  return { x: layout.columns.price[0], y: top, width: Math.max(0, layout.right - layout.columns.price[0]), height: Math.max(0, height - top) }
}

export function chartPanelClip(layout: ReturnType<typeof chartLayout>, panel: ChartPanel, horizontalOverscan = 0) {
  const overscan = Number.isFinite(horizontalOverscan) ? Math.max(0, horizontalOverscan) : 0
  return {
    x: layout.columns[panel][0] - overscan,
    y: layout.panels[panel][0],
    width: Math.max(0, layout.columns[panel][1] - layout.columns[panel][0] + 2 * overscan),
    height: Math.max(0, layout.panels[panel][1] - layout.panels[panel][0]),
  }
}

export type ChartLayoutDensity = { top: number; headerHeight: number; rowGap: number; bottomAxis: number; headerBaseline: number }
const compactChartDensity: ChartLayoutDensity = { top: 2, headerHeight: 18, rowGap: 2, bottomAxis: 16, headerBaseline: 11 }

export function chartLayout(width: number, height: number, labelGutter = 64, priceOnly = false, density: ChartLayoutDensity = compactChartDensity) {
  const rightMargin = 4
  const { top, headerHeight, rowGap, bottomAxis, headerBaseline } = density
  const right = width - rightMargin - labelGutter, column: Range = [0, right]
  const order: readonly ChartPanel[] = priceOnly ? ['price'] : CHART_PANELS
  const availableHeight = Math.max(1, height - top - bottomAxis - headerHeight * order.length - rowGap * (order.length - 1))
  const weights: Record<ChartPanel, number> = { price: 0.4, roc: 0.12, rsi: 0.12, atr: 0.12, oi: 0.12, taker: 0.12 }
  const panels = {} as Record<ChartPanel, Range>
  const headerY = {} as Record<ChartPanel, number>
  let cursor = top
  for (const key of order) {
    headerY[key] = cursor + headerBaseline
    cursor += headerHeight
    panels[key] = [cursor, cursor + availableHeight * (priceOnly ? 1 : weights[key])]
    cursor = panels[key][1] + rowGap
  }
  if (priceOnly) for (const key of CHART_PANELS) if (key !== 'price') { panels[key] = [height + 1, height + 1]; headerY[key] = height + 1 }
  const columns = Object.fromEntries(CHART_PANELS.map(key => [key, column])) as Record<ChartPanel, Range>
  const axisStarts = Object.fromEntries(CHART_PANELS.map(key => [key, right + 8])) as Record<ChartPanel, number>
  return { panels, columns, axisStarts, headerY, left: column[0], right }
}
