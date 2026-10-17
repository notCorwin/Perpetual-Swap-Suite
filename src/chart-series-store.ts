import type { Bar, PreparedChartBar, PreparedChartMeta, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const WINDOW_BARS = 96
const indicatorFields = ['vwap', 'ema', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24'] as const
const barFields = ['hour', 'open', 'high', 'low', 'close', 'confirmed', 'statisticsSources', 'statisticsObserved', 'indicatorsObserved', ...indicatorFields, 'oi', 'buy', 'sell', 'oiUnavailableReason', 'takerUnavailableReason'] as const
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const sameBar = (left: Bar | undefined, right: Bar) => left !== undefined && barFields.every(field => left[field] === right[field])
const validPrice = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close].every(value => finite(value) && value > 0)
  && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
const keyFor = (instId: string, timeframe: RadarTimeframe) => `${timeframe}:${instId}`

export type ReadyChartBoundary = Readonly<{ firstEnd: number; lastEnd: number }>
export type PreparedChartStoreLimits = { maxSeries?: number; maxBarsPerSeries?: number; maxWindowsPerSeries?: number }
type CachedBar = { bar: PreparedChartBar; revision: number }
type Series = {
  meta: PreparedChartMeta
  bars: Map<number, CachedBar>
  hours: number[]
  windows: Map<number, ReadyChartWindow>
  boundaries: readonly ReadyChartBoundary[] | null
  liveBar?: Bar
  liveRevision: number
}

function preparedBar(bar: PreparedChartBar, intervalMS: number): PreparedChartBar | null {
  if (!Number.isSafeInteger(bar.hour) || bar.hour % intervalMS !== 0 || !bar.confirmed || !validPrice(bar)
    || bar.statisticsSources !== 3 || bar.statisticsObserved !== true || bar.indicatorsObserved !== true
    || ![bar.oi, bar.buy, bar.sell].every(value => nullableNumber(value) && (value === null || value >= 0))
    || (bar.buy === null) !== (bar.sell === null)
    || !indicatorFields.every(field => nullableNumber(bar[field]) || (field === 'roc' || field === 'maroc') && (bar[field] === 'Infinity' || bar[field] === '-Infinity'))) return null
  return Object.freeze({ ...bar })
}

/** Only completed, prepared observations enter this cache. Rendering never reads a partial series. */
export class PreparedChartStore {
  private readonly series = new Map<string, Series>()
  private readonly listeners = new Set<() => void>()
  private readonly maxSeries: number
  private readonly maxBarsPerSeries: number
  private readonly maxWindowsPerSeries: number

  constructor({ maxSeries = 12, maxBarsPerSeries = 4_096, maxWindowsPerSeries = 512 }: PreparedChartStoreLimits = {}) {
    if (![maxSeries, maxBarsPerSeries, maxWindowsPerSeries].every(value => Number.isSafeInteger(value) && value > 0) || maxBarsPerSeries < WINDOW_BARS) {
      throw new RangeError('Prepared chart cache limits must be positive integers and retain at least 96 candles per series.')
    }
    this.maxSeries = maxSeries
    this.maxBarsPerSeries = maxBarsPerSeries
    this.maxWindowsPerSeries = maxWindowsPerSeries
  }

  private access(key: string): Series | undefined {
    const entry = this.series.get(key)
    if (entry) { this.series.delete(key); this.series.set(key, entry) }
    return entry
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get size() { return this.series.size }
  latestEnd(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.latestEnd ?? null }
  oldestHour(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.oldestHour ?? null }
  snapshotMeta(instId: string, timeframe: RadarTimeframe): PreparedChartMeta | null { return this.access(keyFor(instId, timeframe))?.meta ?? null }

  ingest(response: PreparedChartResponse): boolean {
    const { instId, timeframe, intervalMS, generation, revision } = response
    if (!instId || !['5m', '15m', '1H'].includes(timeframe) || intervalMS !== timeframeMilliseconds(timeframe)
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(generation) || generation < 0) return false
    const key = keyFor(instId, timeframe)
    let entry = this.access(key)
    if (entry && generation < entry.meta.generation) return false
    const newGeneration = !entry || entry.meta.generation !== generation
    if (newGeneration) {
      entry = {
        meta: Object.freeze({ key, instId, timeframe, intervalMS, generation, revision, latestEnd: null, oldestHour: null, historyExhausted: false, error: '' }),
        bars: new Map(), hours: [], windows: new Map(), boundaries: null, liveRevision: -1,
      }
      this.series.set(key, entry)
      while (this.series.size > this.maxSeries) this.series.delete(this.series.keys().next().value!)
    }
    const current = entry!
    let changed = newGeneration
    const addedHours: number[] = []
    for (const incoming of response.bars) {
      const previous = current.bars.get(incoming.hour)
      if (previous && previous.revision > revision) continue
      const bar = preparedBar(incoming, intervalMS)
      if (!bar) continue
      if (sameBar(previous?.bar, bar)) {
        previous!.revision = Math.max(previous!.revision, revision)
        continue
      }
      if (!previous) addedHours.push(bar.hour)
      current.bars.set(bar.hour, { bar, revision })
      changed = true
    }
    if (addedHours.length) {
      current.hours = [...current.hours, ...addedHours].sort((left, right) => left - right)
      current.boundaries = null
    }
    const newestMeta = revision >= current.meta.revision
    const latestEnd = finite(response.latestEnd) ? Math.max(current.meta.latestEnd ?? -Infinity, response.latestEnd) : current.meta.latestEnd
    const oldestHour = finite(response.oldestHour) ? Math.min(current.meta.oldestHour ?? Infinity, response.oldestHour) : current.meta.oldestHour
    const nextMeta: PreparedChartMeta = {
      key, instId, timeframe, intervalMS, generation, revision: Math.max(current.meta.revision, revision), latestEnd, oldestHour,
      historyExhausted: current.meta.historyExhausted || response.historyExhausted,
      error: newestMeta ? response.error : current.meta.error,
    }
    if (Object.keys(nextMeta).some(field => nextMeta[field as keyof PreparedChartMeta] !== current.meta[field as keyof PreparedChartMeta])) {
      current.meta = Object.freeze(nextMeta)
      changed = true
    }
    if (response.liveBar && revision >= current.liveRevision && !response.liveBar.confirmed && validPrice(response.liveBar)
      && Number.isSafeInteger(response.liveBar.hour) && response.liveBar.hour % intervalMS === 0) {
      if (!sameBar(current.liveBar, response.liveBar)) { current.liveBar = Object.freeze({ ...response.liveBar }); changed = true }
      current.liveRevision = revision
    }
    if (current.liveBar && current.meta.latestEnd !== null && current.liveBar.hour <= current.meta.latestEnd) {
      current.liveBar = undefined
      changed = true
    }
    if (current.bars.size > this.maxBarsPerSeries) {
      const anchor = finite(response.endHour) ? response.endHour : current.meta.latestEnd ?? current.hours.at(-1)!
      const first = anchor - (WINDOW_BARS - 1) * intervalMS
      const removable = current.hours.filter(hour => hour < first || hour > anchor)
        .sort((left, right) => Math.abs(right - anchor) - Math.abs(left - anchor) || left - right)
      const excess = current.bars.size - this.maxBarsPerSeries
      for (const hour of removable.slice(0, excess)) current.bars.delete(hour)
      current.hours = current.hours.filter(hour => current.bars.has(hour))
      current.windows.clear()
      current.boundaries = null
      changed = true
    }
    if (changed) for (const listener of this.listeners) listener()
    return true
  }

  window(instId: string, timeframe: RadarTimeframe, end?: number | null): ReadyChartWindow | null {
    const entry = this.access(keyFor(instId, timeframe))
    const endHour = end ?? entry?.meta.latestEnd
    if (!entry || endHour === null || endHour === undefined || !Number.isSafeInteger(endHour)) return null
    const bars: PreparedChartBar[] = []
    for (let index = WINDOW_BARS - 1; index >= 0; index -= 1) {
      const value = entry.bars.get(endHour - index * entry.meta.intervalMS)
      if (!value) return null
      bars.push(value.bar)
    }
    const liveBar = endHour === entry.meta.latestEnd ? entry.liveBar : undefined
    const cached = entry.windows.get(endHour)
    if (cached && cached.liveBar === liveBar && bars.every((bar, index) => cached.bars[index] === bar)) {
      entry.windows.delete(endHour)
      entry.windows.set(endHour, cached)
      return cached
    }
    const window: ReadyChartWindow = Object.freeze({
      key: entry.meta.key, instId, timeframe, intervalMS: entry.meta.intervalMS, bars: Object.freeze(bars), endHour,
      oiState: bars.every(bar => finite(bar.oi)) ? 'ready' : 'unavailable',
      takerState: bars.every(bar => finite(bar.buy) && finite(bar.sell)) ? 'ready' : 'unavailable',
      indicatorState: bars.every(bar => indicatorFields.every(field => finite(bar[field]))) ? 'ready' : 'unavailable',
      ...(liveBar ? { liveBar } : {}),
    })
    entry.windows.delete(endHour)
    entry.windows.set(endHour, window)
    while (entry.windows.size > this.maxWindowsPerSeries) entry.windows.delete(entry.windows.keys().next().value!)
    return window
  }

  hasRange(instId: string, timeframe: RadarTimeframe, from: number, through: number): boolean {
    const entry = this.series.get(keyFor(instId, timeframe))
    if (!entry || !Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from > through
      || (through - from) % entry.meta.intervalMS !== 0) return false
    for (let hour = from; hour <= through; hour += entry.meta.intervalMS) if (!entry.bars.has(hour)) return false
    return true
  }

  readyBoundaries(instId: string, timeframe: RadarTimeframe): readonly ReadyChartBoundary[] {
    const entry = this.series.get(keyFor(instId, timeframe))
    if (!entry) return []
    if (entry.boundaries) return entry.boundaries
    const runs: ReadyChartBoundary[] = []
    let start = 0
    for (let index = 1; index <= entry.hours.length; index += 1) {
      if (index < entry.hours.length && entry.hours[index] === entry.hours[index - 1] + entry.meta.intervalMS) continue
      if (index - start >= WINDOW_BARS) runs.push(Object.freeze({ firstEnd: entry.hours[start + WINDOW_BARS - 1], lastEnd: entry.hours[index - 1] }))
      start = index
    }
    entry.boundaries = Object.freeze(runs)
    return entry.boundaries
  }
}
