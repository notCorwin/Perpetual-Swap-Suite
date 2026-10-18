import type { Bar, PreparedChartBar, PreparedChartLiveUpdate, PreparedChartMeta, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { RADAR_TIMEFRAMES, timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const WINDOW_BARS = 96
const indicatorFields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24'] as const
const barFields = ['hour', 'open', 'high', 'low', 'close', 'confirmed', 'statisticsSources', 'statisticsObserved', 'oiObserved', 'takerObserved', 'indicatorsObserved', ...indicatorFields, 'oi', 'buy', 'sell', 'oiUnavailableReason', 'takerUnavailableReason'] as const
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const sameBar = (left: Bar | undefined, right: Bar) => left !== undefined && barFields.every(field => left[field] === right[field])
const validPrice = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close].every(value => finite(value) && value > 0)
  && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
const keyFor = (instId: string, timeframe: RadarTimeframe) => `${timeframe}:${instId}`

export type ReadyChartBoundary = Readonly<{ firstEnd: number; lastEnd: number }>
export type PreparedChartStoreLimits = { maxSeries?: number; maxBarsPerSeries?: number; maxWindowsPerSeries?: number; maxBytes?: number }
type CachedBar = { bar: PreparedChartBar; revision: number }
type Series = {
  epoch: number
  byteSize: number
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
    || ![bar.oi, bar.buy, bar.sell].every(value => nullableNumber(value) && (value === null || value >= 0))
    || (bar.buy === null) !== (bar.sell === null)
    || !indicatorFields.every(field => nullableNumber(bar[field]) || (field === 'roc' || field === 'maroc') && (bar[field] === 'Infinity' || bar[field] === '-Infinity'))) return null
  return Object.freeze({ ...bar })
}

function readyWindow(meta: PreparedChartMeta, bars: PreparedChartBar[], endHour: number, liveBar?: Bar, previous?: ReadyChartWindow): ReadyChartWindow {
  const sameBars = previous && bars.length === previous.bars.length && bars.every((bar, index) => previous.bars[index] === bar)
  if (sameBars && previous.liveBar === liveBar && previous.realtimeState === meta.realtimeState && previous.priceObservedAt === meta.priceObservedAt && JSON.stringify(previous.sourceVersions) === JSON.stringify(meta.sourceVersions)) return previous
  return Object.freeze({
    key: meta.key, instId: meta.instId, timeframe: meta.timeframe, intervalMS: meta.intervalMS, bars: sameBars ? previous.bars : Object.freeze(bars), endHour,
    oiState: bars.length && bars.every(bar => bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)) ? bars.every(bar => finite(bar.oi)) ? 'ready' : 'unavailable' : 'loading',
    takerState: bars.length && bars.every(bar => bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)) ? bars.every(bar => finite(bar.buy) && finite(bar.sell)) ? 'ready' : 'unavailable' : 'loading',
    indicatorState: bars.length && bars.every(bar => bar.indicatorsObserved) ? bars.every(bar => indicatorFields.every(field => finite(bar[field]))) ? 'ready' : 'unavailable' : 'loading',
    ...(liveBar ? { liveBar } : {}), priceState: bars.length || liveBar ? bars.length < WINDOW_BARS ? 'partial' : 'ready' : 'loading', priceAsOf: meta.priceAsOf, priceObservedAt: meta.priceObservedAt, realtimeState: meta.realtimeState ?? 'stale', sourceVersions: meta.sourceVersions,
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
  private focusKey: string | null = null
  private readonly byteSizes = new WeakMap<object, number>()
  private readonly listeners = new Set<() => void>()
  private readonly maxSeries: number
  private readonly maxBarsPerSeries: number
  private readonly maxWindowsPerSeries: number
  private readonly maxBytes: number

  constructor({ maxSeries = 12, maxBarsPerSeries = 16_384, maxWindowsPerSeries = 128, maxBytes = 32 * 1024 * 1024 }: PreparedChartStoreLimits = {}) {
    if (![maxSeries, maxBarsPerSeries, maxWindowsPerSeries].every(value => Number.isSafeInteger(value) && value > 0) || maxBarsPerSeries < WINDOW_BARS) {
      throw new RangeError('Prepared chart cache limits must be positive integers and retain at least 96 candles per series.')
    }
    this.maxBytes = maxBytes
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
  setUniverse(instIds: readonly string[], _timeframe: RadarTimeframe, focusInstId?: string) {
    if (focusInstId) this.focusKey = keyFor(focusInstId, _timeframe)
    this.universe = new Set([...instIds, ...(focusInstId ? [focusInstId] : [])].flatMap(instId => RADAR_TIMEFRAMES.map(({ value }) => keyFor(instId, value))))
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
  ingestLive(update: PreparedChartLiveUpdate): boolean {
    const key = keyFor(update.instId, update.timeframe), previous = this.latestFrames.get(key)
    if (!this.universe.has(key) || !previous || update.generation !== previous.meta.generation
      || !Number.isSafeInteger(update.revision) || update.revision < previous.meta.revision || update.endHour !== previous.window.endHour) return false
    const incoming = update.liveBar
    if (incoming !== null && (incoming.confirmed || !validPrice(incoming) || !Number.isSafeInteger(incoming.hour)
      || incoming.hour % previous.meta.intervalMS !== 0 || incoming.hour <= update.endHour)) return false
    const liveBar = incoming === null ? undefined : sameBar(previous.window.liveBar, incoming) ? previous.window.liveBar : Object.freeze({ ...incoming })
    const meta = Object.freeze({ ...previous.meta, revision: update.revision, priceObservedAt: update.priceObservedAt ?? previous.meta.priceObservedAt, priceAsOf: update.priceAsOf ?? previous.meta.priceAsOf, realtimeState: update.realtimeState ?? previous.meta.realtimeState, sourceVersions: update.sourceVersions ?? previous.meta.sourceVersions })
    const window = readyWindow(meta, [...previous.window.bars], update.endHour, liveBar, previous.window)
    const entry = this.series.get(key)
    if (entry) {
      entry.meta = Object.freeze({ ...entry.meta, revision: Math.max(entry.meta.revision, update.revision),
        priceAsOf: meta.priceAsOf, priceObservedAt: meta.priceObservedAt, realtimeState: meta.realtimeState, sourceVersions: meta.sourceVersions })
      entry.liveBar = liveBar
      entry.liveRevision = update.revision
    }
    this.latestFrames.set(key, { meta, window })
    if (window !== previous.window || meta !== previous.meta) for (const listener of this.listeners) listener()
    return true
  }

  /** Latest-ready notifications never allocate a deep-history cache entry. */
  ingestLatest(response: PreparedChartResponse): boolean {
    if (response.endHour === null && response.liveBar) response = { ...response, endHour: response.liveBar.hour - response.intervalMS, latestEnd: response.liveBar.hour - response.intervalMS }
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
      if (!value) continue
      const bar = preparedBar(value, intervalMS)
      if (!bar) continue
      const oldBar = previous?.window.bars[WINDOW_BARS - index - 1]
      bars.push(sameBar(oldBar, bar) ? oldBar! : bar)
    }
    if ((!bars.length || !incoming.has(endHour)) && !response.liveBar) return false
    const meta: PreparedChartMeta = Object.freeze({
      key, instId, timeframe, intervalMS, generation, revision, latestEnd: endHour,
      priceAsOf: response.priceAsOf, priceObservedAt: response.priceObservedAt, realtimeState: response.realtimeState, sourceVersions: response.sourceVersions,
      oldestHour: response.oldestHour === null ? previous?.meta.oldestHour ?? null : Math.min(previous?.meta.oldestHour ?? Infinity, response.oldestHour),
      historyExhausted: response.historyExhausted || (previous?.meta.historyExhausted ?? false), error: response.error,
    })
    const live = response.liveBar
    const liveBar = live && !live.confirmed && validPrice(live) && live.hour > endHour
      && Number.isSafeInteger(live.hour) && live.hour % intervalMS === 0
      ? sameBar(previous?.window.liveBar, live) ? previous!.window.liveBar : Object.freeze({ ...live }) : undefined
    const window = readyWindow(meta, bars, endHour, liveBar, previous?.window)
    this.latestFrames.set(key, { meta, window })
    this.trimBytes()
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
        epoch: ++this.nextEpoch, byteSize: 0,
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
      priceAsOf: newestMeta ? response.priceAsOf ?? current.meta.priceAsOf : current.meta.priceAsOf,
      priceObservedAt: newestMeta ? response.priceObservedAt ?? current.meta.priceObservedAt : current.meta.priceObservedAt,
      realtimeState: newestMeta ? response.realtimeState ?? current.meta.realtimeState : current.meta.realtimeState,
      sourceVersions: newestMeta ? response.sourceVersions ?? current.meta.sourceVersions : current.meta.sourceVersions,
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
      // A historical batch can carry a new indicator generation and a fully
      // rebuilt latest window together. Repin that window in the same ingest.
      const end = finite(response.latestEnd) && current.bars.has(response.latestEnd)
        ? Math.max(previous?.window.endHour ?? -Infinity, response.latestEnd) : previous?.window.endHour
      const window = end === undefined ? null : this.seriesWindow(current, end)
      if (window) {
        this.latestFrames.set(key, { meta: Object.freeze({ ...current.meta, latestEnd: window.endHour }), window })
        if (window !== previous?.window) changed = true
      }
    }
    current.byteSize = this.sizeOfBars([...current.bars.values()].map(value => value.bar))
    this.trimBytes()
    if (changed) for (const listener of this.listeners) listener()
    return true
  }

  private sizeOfBars(bars: readonly PreparedChartBar[]): number {
    const cached = this.byteSizes.get(bars)
    if (cached !== undefined) return cached
    const size = bars.reduce((sum, bar) => {
      let bytes = this.byteSizes.get(bar)
      if (bytes === undefined) { bytes = JSON.stringify(bar).length * 2; this.byteSizes.set(bar, bytes) }
      return sum + bytes
    }, 0)
    this.byteSizes.set(bars, size)
    return size
  }

  private trimBytes() {
    let bytes = [...this.series.values()].reduce((sum, entry) => sum + entry.byteSize, 0)
      + [...this.latestFrames.values()].reduce((sum, entry) => sum + this.sizeOfBars(entry.window.bars), 0)
    for (const [key, entry] of this.series) {
      if (bytes <= this.maxBytes) break
      if (key === this.focusKey) continue
      bytes -= entry.byteSize; this.series.delete(key)
    }
    for (const [key, entry] of this.latestFrames) {
      if (bytes <= this.maxBytes) break
      if (key === this.focusKey) continue
      bytes -= this.sizeOfBars(entry.window.bars); this.latestFrames.delete(key)
    }
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
      if (!value) continue
      bars.push(value.bar)
    }
    const liveBar = endHour === entry.meta.latestEnd ? entry.liveBar : undefined
    if (!entry.bars.has(endHour) && !liveBar) return null
    if (!bars.length && !liveBar) return null
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
      if (index > start) runs.push(Object.freeze({ firstEnd: entry.hours[start], lastEnd: entry.hours[index - 1] }))
      start = index
    }
    entry.boundaries = Object.freeze(runs)
    return entry.boundaries
  }
}
