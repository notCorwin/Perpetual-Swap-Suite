import type { Bar, ReadyChartWindow } from './chart-data.ts'
import { createChartGeometryCache } from './chart-geometry.ts'
import type { RadarTimeframe } from './timeframe.ts'

export const chartRenderKey = (instId: string, timeframe: RadarTimeframe) => `${timeframe}:${instId}`

/** Missing/undefined observations have a finished, truthful panel of their own. */
export function chartReadyForListing(window: ReadyChartWindow | null) {
  return Boolean(window?.bars.length && (window.priceState === 'ready' || window.priceState === 'stale')
    && (window.indicatorState === 'ready' || window.indicatorState === 'unavailable')
    && window.oiState !== 'loading' && window.takerState !== 'loading')
}

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

/** A row is selectable only while its completed SVG is mounted in the pool. */
export class RenderedChartRegistry {
  private readonly receipts = new Map<string, Set<symbol>>()
  private snapshot: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()
  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly register = (instId: string, timeframe: RadarTimeframe) => {
    const key = chartRenderKey(instId, timeframe), token = Symbol(key)
    const owners = this.receipts.get(key) ?? new Set<symbol>()
    owners.add(token); this.receipts.set(key, owners)
    if (!this.snapshot.has(key)) this.publish()
    return () => {
      if (!owners.delete(token) || owners.size) return
      this.receipts.delete(key)
      this.publish()
    }
  }
  private publish() {
    this.snapshot = new Set(this.receipts.keys())
    for (const listener of this.listeners) listener()
  }
}
