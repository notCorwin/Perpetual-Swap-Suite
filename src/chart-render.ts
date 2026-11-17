import type { ChartLayoutDensity } from './chart-layout.ts'
import type { Bar, ReadyChartWindow } from './chart-data.ts'
import { createChartGeometryCache, type ChartGeometryOverscan } from './chart-geometry.ts'

/** Selection and background rendering share the exact same immutable paths. */
export function createChartPlotCache(measureText: (text: string) => number, layoutDensity?: ChartLayoutDensity) {
  const geometry = createChartGeometryCache(measureText)
  type Plot = { sourceBefore?: Bar; sourceAfter?: Bar; bars: readonly Bar[]; geometry: ReturnType<typeof geometry>; before?: Bar; after?: Bar }
  const cache = new WeakMap<readonly Bar[], WeakMap<object, { bars: readonly Bar[]; variants: Plot[]; windowBars?: number }>>()
  return (window: ReadyChartWindow | null, size: { width: number; height: number }, overscan: ChartGeometryOverscan = {}, currentPriceTickSz?: string | null, priceOnly = false, viewport?: { count?: number; spacing?: number; offset: number }): Plot | null => {
    if (!window || !(size.width > 0 && size.height > 0)) return null
    let liveVariants = cache.get(window.bars)
    if (!liveVariants) { liveVariants = new WeakMap(); cache.set(window.bars, liveVariants) }
    const key = window.liveBar ?? window.bars
    let input = liveVariants.get(key)
    if (!input || input.windowBars !== window.windowBars) {
      const bars = window.liveBar
        ? [...window.bars.filter(bar => bar.hour < window.liveBar!.hour), window.liveBar].slice(-(window.windowBars ?? 96))
        : window.bars
      input = { bars, variants: [], windowBars: window.windowBars }
      liveVariants.set(key, input)
    }
    const { bars: sourceBars, variants } = input
    const count = viewport?.count ?? window.windowBars
    const spacing = viewport?.spacing
    const endHour = sourceBars.at(-1)?.hour === undefined ? window.endHour : sourceBars.at(-1)!.hour + (viewport?.offset ?? 0) * window.intervalMS
    const firstHour = endHour - ((count ?? 96) - 1) * window.intervalMS
    const cached = variants.find(plot => plot.geometry.width === size.width && plot.geometry.height === size.height && plot.geometry.intervalMS === window.intervalMS
      && plot.geometry.endHour === endHour && plot.geometry.barSpacing === spacing
      && (spacing !== undefined || (plot.geometry.windowBars ?? 96) === (count ?? 96))
      && plot.geometry.currentPriceTickSz === currentPriceTickSz && plot.geometry.priceOnly === priceOnly
      && plot.sourceBefore === overscan.before && plot.sourceAfter === overscan.after)
    if (cached) return cached
    const bars = viewport && spacing === undefined ? sourceBars.filter(bar => bar.hour >= firstHour - 0.001 && bar.hour <= endHour + 0.001) : sourceBars
    if (!bars.length) return null
    const before = viewport ? sourceBars.find(bar => bar.hour === bars[0].hour - window.intervalMS) ?? overscan.before : overscan.before
    const after = viewport ? sourceBars.find(bar => bar.hour === bars.at(-1)!.hour + window.intervalMS) ?? overscan.after : overscan.after
    const projected = geometry(bars, { ...size, endHour, intervalMS: window.intervalMS, windowBars: count, barSpacing: spacing, layoutDensity,
      liveClose: (window.liveBar && window.liveBar.hour <= endHour && window.liveBar.hour >= firstHour ? window.liveBar : bars.at(-1)!).close, currentPriceTickSz, priceOnly }, { before, after })
    const plot = { bars: projected.bars, before: projected.before, after: projected.after, sourceBefore: overscan.before, sourceAfter: overscan.after, geometry: projected }
    variants.push(plot)
    if (variants.length > 2) variants.shift()
    return plot
  }
}
