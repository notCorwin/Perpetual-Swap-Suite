import type { Bar, PreparedChartBar, PreparedChartMeta, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const WINDOW_BARS = 96
const indicatorFields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24'] as const
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
  epoch: number
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

function readyWindow(meta: PreparedChartMeta, bars: PreparedChartBar[], endHour: number, liveBar?: Bar, previous?: ReadyChartWindow): ReadyChartWindow {
  if (previous && previous.liveBar === liveBar && bars.every((bar, index) => previous.bars[index] === bar)) return previous
  return Object.freeze({
    key: meta.key, instId: meta.instId, timeframe: meta.timeframe, intervalMS: meta.intervalMS, bars: Object.freeze(bars), endHour,
    oiState: bars.every(bar => finite(bar.oi)) ? 'ready' : 'unavailable',
    takerState: bars.every(bar => finite(bar.buy) && finite(bar.sell)) ? 'ready' : 'unavailable',
    indicatorState: bars.every(bar => indicatorFields.every(field => finite(bar[field]))) ? 'ready' : 'unavailable',
    ...(liveBar ? { liveBar } : {}),
  })
}

/** Only completed, prepared observations enter this cache. Rendering never reads a partial series. */
export class PreparedChartStore {
  private nextEpoch = 0
  private readonly series = new Map<string, Series>()
  private readonly latestFrames = new Map<string, { meta: PreparedChartMeta; window: ReadyChartWindow }>()
  // Keep only the numeric watermark after eviction so in-flight old generations cannot reenter this session.
  private readonly generations = new Map<string, number>()
  private universe = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly maxSeries: number
  private readonly maxBarsPerSeries: number
  private readonly maxWindowsPerSeries: number

  constructor({ maxSeries = 12, maxBarsPerSeries = 16_384, maxWindowsPerSeries = 512 }: PreparedChartStoreLimits = {}) {
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
  get latestSize() { return this.latestFrames.size }
  /** Changes when a full history entry is recreated after eviction. Compact frames do not count. */
  historyEpoch(instId: string, timeframe: RadarTimeframe) { return this.series.get(keyFor(instId, timeframe))?.epoch ?? 0 }
  latestEnd(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.latestEnd ?? null }
  oldestHour(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.oldestHour ?? null }
  snapshotMeta(instId: string, timeframe: RadarTimeframe): PreparedChartMeta | null {
    const key = keyFor(instId, timeframe), series = this.access(key), latest = this.latestFrames.get(key)
    if (!latest) return series ? this.universe.has(key) ? { ...series.meta, latestEnd: null } : series.meta : null
    return series ? { ...series.meta, latestEnd: latest.window.endHour } : latest.meta
  }

  /** Compact latest frames belong to navigation candidates, independently of the history LRU. */
  setUniverse(instIds: readonly string[], timeframe: RadarTimeframe, focusInstId?: string) {
    this.universe = new Set([...instIds, ...(focusInstId ? [focusInstId] : [])].map(instId => keyFor(instId, timeframe)))
    for (const key of this.latestFrames.keys()) if (!this.universe.has(key)) this.latestFrames.delete(key)
    for (const [key, entry] of this.series) {
      if (!this.universe.has(key) || this.latestFrames.has(key) || entry.meta.latestEnd === null) continue
      const window = this.seriesWindow(entry, entry.meta.latestEnd)
      if (window) this.latestFrames.set(key, { meta: entry.meta, window })
    }
  }

  private acceptGeneration(key: string, generation: number) {
    const known = this.generations.get(key)
    if (known !== undefined && generation < known) return false
    if (known !== undefined && generation > known) {
      this.series.delete(key)
      this.latestFrames.delete(key)
    }
    this.generations.set(key, generation)
    return true
  }

  /** Latest-ready notifications never allocate a deep-history cache entry. */
  ingestLatest(response: PreparedChartResponse): boolean {
    const { instId, timeframe, intervalMS, generation, revision, endHour } = response
    const key = keyFor(instId, timeframe)
    if (!this.universe.has(key) || !finite(endHour) || endHour !== response.latestEnd || !instId
      || !['5m', '15m', '1H'].includes(timeframe) || intervalMS !== timeframeMilliseconds(timeframe)
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(generation) || generation < 0
      || !this.acceptGeneration(key, generation)) return false
    if (this.series.has(key)) return this.ingest(response)
    const previous = this.latestFrames.get(key)
    if (previous && (revision < previous.meta.revision || endHour < previous.window.endHour)) return false
    const incoming = new Map(response.bars.map(bar => [bar.hour, bar]))
    const bars: PreparedChartBar[] = []
    for (let index = WINDOW_BARS - 1; index >= 0; index -= 1) {
      const hour = endHour - index * intervalMS, value = incoming.get(hour)
      if (!value) return false
      const bar = preparedBar(value, intervalMS)
      if (!bar) return false
      const oldBar = previous?.window.bars[WINDOW_BARS - index - 1]
      bars.push(sameBar(oldBar, bar) ? oldBar! : bar)
    }
    const meta: PreparedChartMeta = Object.freeze({
      key, instId, timeframe, intervalMS, generation, revision, latestEnd: endHour,
      oldestHour: response.oldestHour === null ? previous?.meta.oldestHour ?? null : Math.min(previous?.meta.oldestHour ?? Infinity, response.oldestHour),
      historyExhausted: response.historyExhausted || (previous?.meta.historyExhausted ?? false), error: response.error,
    })
    const live = response.liveBar
    const liveBar = live && !live.confirmed && validPrice(live) && live.hour > endHour
      && Number.isSafeInteger(live.hour) && live.hour % intervalMS === 0
      ? sameBar(previous?.window.liveBar, live) ? previous!.window.liveBar : Object.freeze({ ...live }) : undefined
    const window = readyWindow(meta, bars, endHour, liveBar, previous?.window)
    this.latestFrames.set(key, { meta, window })
    if (window !== previous?.window || revision !== previous?.meta.revision) for (const listener of this.listeners) listener()
    return true
  }

  ingest(response: PreparedChartResponse): boolean {
    const { instId, timeframe, intervalMS, generation, revision } = response
    if (!instId || !['5m', '15m', '1H'].includes(timeframe) || intervalMS !== timeframeMilliseconds(timeframe)
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(generation) || generation < 0) return false
    const key = keyFor(instId, timeframe)
    if (!this.acceptGeneration(key, generation)) return false
    let entry = this.access(key)
    const latest = this.latestFrames.get(key)
    const newGeneration = !entry || entry.meta.generation !== generation
    if (newGeneration) {
      entry = {
        epoch: ++this.nextEpoch,
        meta: latest?.meta ?? Object.freeze({ key, instId, timeframe, intervalMS, generation, revision, latestEnd: null, oldestHour: null, historyExhausted: false, error: '' }),
        bars: new Map(latest?.window.bars.map(bar => [bar.hour, { bar, revision: latest.meta.revision }]) ?? []),
        hours: latest?.window.bars.map(bar => bar.hour) ?? [],
        windows: latest ? new Map([[latest.window.endHour, latest.window]]) : new Map(), boundaries: null,
        liveBar: latest?.window.liveBar, liveRevision: latest?.meta.revision ?? -1,
      }
      this.series.set(key, entry)
      while (this.series.size > this.maxSeries) {
        const evicted = this.series.keys().next().value!
        this.series.delete(evicted)
      }
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
    if (this.universe.has(key)) {
      const previous = this.latestFrames.get(key)
      const end = response.endHour === response.latestEnd && finite(response.endHour)
        ? Math.max(previous?.window.endHour ?? -Infinity, response.endHour) : previous?.window.endHour
      const window = end === undefined ? null : this.seriesWindow(current, end)
      if (window) {
        this.latestFrames.set(key, { meta: Object.freeze({ ...current.meta, latestEnd: window.endHour }), window })
        if (window !== previous?.window) changed = true
      }
    }
    if (changed) for (const listener of this.listeners) listener()
    return true
  }

  window(instId: string, timeframe: RadarTimeframe, end?: number | null): ReadyChartWindow | null {
    const key = keyFor(instId, timeframe), entry = this.access(key), latest = this.latestFrames.get(key)
    if (latest && (end === null || end === undefined || end === latest.window.endHour)) return latest.window
    if ((end === null || end === undefined) && this.universe.has(key)) return null
    const endHour = end ?? entry?.meta.latestEnd
    if (!entry || endHour === null || endHour === undefined || !Number.isSafeInteger(endHour)) return null
    return this.seriesWindow(entry, endHour)
  }

  private seriesWindow(entry: Series, endHour: number): ReadyChartWindow | null {
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
    const window = readyWindow(entry.meta, bars, endHour, liveBar)
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
    const key = keyFor(instId, timeframe), entry = this.series.get(key), latest = this.latestFrames.get(key)
    if (!entry) return latest ? [{ firstEnd: latest.window.endHour, lastEnd: latest.window.endHour }] : []
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
