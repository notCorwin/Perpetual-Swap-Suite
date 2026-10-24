import type { Bar, ReadyChartWindow } from './chart-data.ts'
import { createChartGeometryCache } from './chart-geometry.ts'

/** Selection and background rendering share the exact same immutable paths. */
export function createChartPlotCache(measureText: (text: string) => number) {
  const geometry = createChartGeometryCache(measureText)
  type Plot = { bars: readonly Bar[]; geometry: ReturnType<typeof geometry> }
  const cache = new WeakMap<readonly Bar[], WeakMap<object, { bars: readonly Bar[]; variants: Plot[] }>>()
  return (window: ReadyChartWindow | null, size: { width: number; height: number }): Plot | null => {
    if (!window || !(size.width > 0 && size.height > 0)) return null
    let liveVariants = cache.get(window.bars)
    if (!liveVariants) { liveVariants = new WeakMap(); cache.set(window.bars, liveVariants) }
    const key = window.liveBar ?? window.bars
    let input = liveVariants.get(key)
    if (!input) {
      const bars = window.liveBar
        ? [...window.bars.filter(bar => bar.hour < window.liveBar!.hour), window.liveBar].slice(-96)
        : window.bars
      input = { bars, variants: [] }
      liveVariants.set(key, input)
    }
    const { bars, variants } = input
    const cached = variants.find(plot => plot.geometry.width === size.width && plot.geometry.height === size.height && plot.geometry.intervalMS === window.intervalMS)
    if (cached) return cached
    if (!bars.length) return null
    const endHour = bars.at(-1)!.hour
    const plot = { bars, geometry: geometry(bars, { ...size, endHour, intervalMS: window.intervalMS,
      liveClose: (window.liveBar ?? bars.at(-1)!).close }) }
    variants.push(plot)
    if (variants.length > 2) variants.shift()
    return plot
  }
}
