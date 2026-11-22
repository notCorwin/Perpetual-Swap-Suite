import type { ChartLayoutDensity } from './chart-layout.ts'
import type { Bar, ReadyChartWindow } from './chart-data.ts'
import { chartPricePresentation, createChartGeometryCache, type ChartGeometryOverscan } from './chart-geometry.ts'
import { chartWheelContentOffset } from './chart-navigation.ts'

const indicatorFields = ['ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw'] as const

/** A loading-only visual snapshot. It never certifies or enters the source store. */
export function createChartIndicatorPresentation() {
  let snapshot: ReadyChartWindow | null = null
  const projections = new WeakMap<ReadyChartWindow, { snapshot: ReadyChartWindow; window: ReadyChartWindow; stale: boolean }>()
  const sameViewport = (window: ReadyChartWindow | null) => snapshot && window && snapshot.instId === window.instId && snapshot.timeframe === window.timeframe
    && snapshot.intervalMS === window.intervalMS && snapshot.endHour === window.endHour && snapshot.windowBars === window.windowBars
    && snapshot.bars.length === window.bars.length && snapshot.bars.every((bar, index) => bar.hour === window.bars[index].hour)
  return {
    commit(window: ReadyChartWindow | null) {
      if (!sameViewport(window)) snapshot = null
      if (!window || window.indicatorState !== 'loading') {
        snapshot = window && (window.indicatorState === 'ready' || window.indicatorState === 'unavailable') ? window : null
      }
    },
    project(window: ReadyChartWindow | null): { window: ReadyChartWindow | null; stale: boolean } {
      if (!window || window.indicatorState !== 'loading' || !sameViewport(window)) return { window, stale: false }
      const previous = snapshot!
      const cached = projections.get(window)
      if (cached?.snapshot === previous) return cached
      const retain = <T extends Bar>(bar: T, prior: Bar): T => ({ ...bar,
        ...Object.fromEntries(indicatorFields.map(field => [field, prior[field]])),
      })
      // Keep current OHLC, source flags, statistics and lifecycle metadata. Only
      // the displayed curves retain their last committed shape until replay settles.
      const liveBar = window.liveBar && previous.liveBar?.hour === window.liveBar.hour
        ? retain(window.liveBar, previous.liveBar) : window.liveBar
      const result = { snapshot: previous, window: { ...window, bars: window.bars.map((bar, index) => retain(bar, previous.bars[index])), liveBar }, stale: true }
      projections.set(window, result)
      return result
    },
  }
}

/** Selection and background rendering share the exact same immutable paths. */
export function createChartPlotCache(measureText: (text: string) => number, layoutDensity?: ChartLayoutDensity) {
  const geometry = createChartGeometryCache(measureText)
  type Plot = { sourceBefore?: Bar; sourceAfter?: Bar; fixedGutter?: number; bars: readonly Bar[]; geometry: ReturnType<typeof geometry>; before?: Bar; after?: Bar }
  const cache = new WeakMap<readonly Bar[], WeakMap<object, { bars: readonly Bar[]; variants: Plot[]; windowBars?: number }>>()
  return (window: ReadyChartWindow | null, size: { width: number; height: number }, overscan: ChartGeometryOverscan = {}, currentPriceTickSz?: string | null, viewport?: { count?: number; spacing?: number; offset: number; fixedGutter?: number }, wheelFraction = 0): Plot | null => {
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
      && plot.fixedGutter === viewport?.fixedGutter
      && (spacing !== undefined || (plot.geometry.windowBars ?? 96) === (count ?? 96))
      && plot.geometry.currentPriceTickSz === currentPriceTickSz
      && (() => {
        const current = chartPricePresentation(plot.geometry, chartWheelContentOffset(wheelFraction, plot.geometry.barPitch, Boolean(plot.before), Boolean(plot.after)), false)
        return plot.geometry.priceAxis.base === current.base && plot.geometry.priceAxis.centerPrice === current.centerPrice
      })()
      && plot.sourceBefore === overscan.before && plot.sourceAfter === overscan.after)
    if (cached) return cached
    const bars = viewport && spacing === undefined ? sourceBars.filter(bar => bar.hour >= firstHour - 0.001 && bar.hour <= endHour + 0.001) : sourceBars
    if (!bars.length) return null
    const before = viewport ? sourceBars.find(bar => bar.hour === bars[0].hour - window.intervalMS) ?? overscan.before : overscan.before
    const after = viewport ? sourceBars.find(bar => bar.hour === bars.at(-1)!.hour + window.intervalMS) ?? overscan.after : overscan.after
    const options = { ...size, endHour, intervalMS: window.intervalMS, windowBars: count, barSpacing: spacing, fixedGutter: viewport?.fixedGutter, layoutDensity,
      liveClose: (window.liveBar && window.liveBar.hour <= endHour && window.liveBar.hour >= firstHour ? window.liveBar : bars.at(-1)!).close, currentPriceTickSz }
    let projected = geometry(bars, options, { before, after })
    {
      // A changed reference can widen labels and reveal a different edge candle.
      // Keep the gutter monotonic until geometry and displayed reference agree.
      let gutter = viewport?.fixedGutter ?? projected.gutter
      for (;;) {
        const offset = chartWheelContentOffset(wheelFraction, projected.barPitch, Boolean(projected.before), Boolean(projected.after))
        const { base, centerPrice } = chartPricePresentation(projected, offset, false)
        if (viewport?.fixedGutter === undefined) gutter = Math.max(gutter, projected.measuredGutter)
        if (projected.priceAxis.base === base && projected.priceAxis.centerPrice === centerPrice && projected.gutter === gutter) break
        projected = geometry(bars, { ...options, fixedGutter: gutter, priceScaleBase: base, priceScaleCenter: centerPrice }, { before, after })
      }
    }
    const plot = { bars: projected.bars, before: projected.before, after: projected.after, sourceBefore: overscan.before, sourceAfter: overscan.after, fixedGutter: viewport?.fixedGutter, geometry: projected }
    variants.push(plot)
    if (variants.length > 2) variants.shift()
    return plot
  }
}
