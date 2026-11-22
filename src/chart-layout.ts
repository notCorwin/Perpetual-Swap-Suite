export const CHART_DEFAULT_SPACING = 19.2
export const CHART_MIN_SPACING = 4
export const CHART_MAX_SPACING = 100
export const chartPitchBodyWidth = (spacing: number) => spacing * 0.68

/** Continuous display span inside the actual plot, independent of data buckets. */
export function chartPitchSpan(plotWidth: number, spacing = CHART_DEFAULT_SPACING) {
  return Math.max(1, 1 + (Math.max(0, plotWidth) - chartPitchBodyWidth(spacing)) / spacing)
}

export type ChartPanel = 'price'

type Range = readonly [number, number]

/** A live price outside its own panel must not draw into neighboring panels. */
export function chartPriceInPanel(y: number, panel: Range) {
  return Number.isFinite(y) && y >= panel[0] && y <= panel[1]
}

export function chartCandleWidth(plotWidth: number, windowBars = 96) {
  return Math.max(5, Math.min(13, plotWidth / windowBars * 0.68))
}

export function chartHourX(hour: number, latestHour: number, start: number, end: number, intervalMS = 3_600_000, windowBars = 96) {
  const candleWidth = chartCandleWidth(end - start, windowBars)
  return start + candleWidth / 2 + (hour - (latestHour - (windowBars - 1) * intervalMS)) * (end - start - candleWidth) / ((windowBars - 1) * intervalMS)
}

export function chartPriceLabelLayout(priceY: number, panel: Range, fontSize: number, paddingY: number, showCountdown: boolean) {
  const halfLine = fontSize / 2
  const inset = Math.min(halfLine + paddingY, (panel[1] - panel[0]) / 2)
  const labelY = Math.max(panel[0] + inset, Math.min(panel[1] - inset, priceY))
  const below = labelY + fontSize
  const above = labelY - fontSize
  const countdownY = !showCountdown ? null
    : below + halfLine + paddingY <= panel[1] ? below
      : above - halfLine - paddingY >= panel[0] ? above : null
  // Keep the text and its background inside the panel, even at its edges.
  return {
    labelY,
    countdownY,
    top: Math.max(panel[0], Math.min(labelY, countdownY ?? labelY) - halfLine - paddingY),
    bottom: Math.min(panel[1], Math.max(labelY, countdownY ?? labelY) + halfLine + paddingY),
  }
}

/** Fit the most indicator labels, then minimize displacement from their values.
 * At most three Bollinger labels are searched, so exhaustive bounded packing
 * avoids fragmentation around the reserved current-quote rectangle.
 */
export function chartIndicatorLabelLayout<T extends { y: number }>(candidates: readonly T[], panel: Range, height: number, reserved?: Range) {
  const free: [number, number][] = []
  const start = panel[0], end = panel[1]
  if (!(Number.isFinite(height) && height > 0 && end > start)) return []
  if (reserved) {
    if (reserved[0] > start) free.push([start, Math.min(end, reserved[0])])
    if (reserved[1] < end) free.push([Math.max(start, reserved[1]), end])
  } else free.push([start, end])
  type Placed = T & { labelY: number; top: number; bottom: number }
  let best: { placed: Placed[]; distance: number } = { placed: [], distance: Infinity }
  const search = (index: number, gaps: [number, number][], placed: Placed[], distance: number) => {
    if (index === candidates.length) {
      if (placed.length > best.placed.length || placed.length === best.placed.length && distance < best.distance) best = { placed, distance }
      return
    }
    const candidate = candidates[index]
    if (Number.isFinite(candidate.y) && candidate.y >= start && candidate.y <= end) {
      for (const [gapIndex, [lo, hi]] of gaps.entries()) {
        if (hi - lo < height) continue
        const ideal = Math.max(lo, Math.min(hi - height, candidate.y - height / 2))
        for (const top of new Set([lo, hi - height, ideal])) {
          const bottom = top + height
          const remainder: [number, number][] = [[lo, top], [bottom, hi]]
          const next = [...gaps]
          next.splice(gapIndex, 1, ...remainder.filter(([a, b]) => b > a))
          search(index + 1, next, [...placed, { ...candidate, labelY: top + height / 2, top, bottom }], distance + Math.abs(top + height / 2 - candidate.y))
        }
      }
    }
    search(index + 1, gaps, placed, distance)
  }
  search(0, free, [], 0)
  return best.placed
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

export type ChartLayoutDensity = { priceOnlyTop: number; bottomAxis: number }
const compactChartDensity: ChartLayoutDensity = { priceOnlyTop: 0, bottomAxis: 16 }

export function chartLayout(width: number, height: number, labelGutter = 64, density: ChartLayoutDensity = compactChartDensity) {
  const right = width - 4 - labelGutter, column: Range = [0, right]
  const top = density.priceOnlyTop
  const panels = { price: [top, top + Math.max(1, height - top - density.bottomAxis)] as Range }
  const columns = { price: column }
  const axisStarts = { price: right + 8 }
  return { panels, columns, axisStarts, left: column[0], right }
}
