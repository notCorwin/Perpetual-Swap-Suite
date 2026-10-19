import { hookOperationMethods } from '../electron/services/operations.js'
import type { Bar, PreparedChartBar, PreparedChartLiveUpdate, PreparedChartMeta, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { RADAR_TIMEFRAMES, timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const WINDOW_BARS = 96
const indicatorFields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw'] as const
const barFields = ['hour', 'open', 'high', 'low', 'close', 'confirmed', 'statisticsSources', 'statisticsObserved', 'oiObserved', 'takerObserved', 'indicatorsObserved', ...indicatorFields, 'oi', 'buy', 'sell', 'oiUnavailableReason', 'takerUnavailableReason'] as const
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const sameBar = (left: Bar | undefined, right: Bar) => left !== undefined && barFields.every(field => left[field] === right[field])
const validPrice = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close].every(value => finite(value) && value > 0)
  && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
const keyFor = (instId: string, timeframe: RadarTimeframe) => `${timeframe}:${instId}`
const samePrices = (left: Bar, right: Bar) => (['hour', 'open', 'high', 'low', 'close', 'confirmed'] as const).every(field => left[field] === right[field])
const observed = (bar: Bar, source: 1 | 2) => (source === 1 ? bar.oiObserved : bar.takerObserved)
  ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & source)

export type ReadyChartBoundary = Readonly<{ firstEnd: number; lastEnd: number }>
export type PreparedChartStoreLimits = { maxSeries?: number; maxBarsPerSeries?: number; maxWindowsPerSeries?: number; maxBytes?: number }
type CachedBar = { bar: PreparedChartBar; revision: number; generation: number }
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

function preparedBar(bar: PreparedChartBar, intervalMS: number, previous?: PreparedChartBar, sameGeneration = true): PreparedChartBar | null {
  if (!Number.isSafeInteger(bar.hour) || bar.hour % intervalMS !== 0 || !bar.confirmed || !validPrice(bar)
    || ![bar.oi, bar.buy, bar.sell].every(value => nullableNumber(value) && (value === null || value >= 0))
    || (bar.buy === null) !== (bar.sell === null)
    || !indicatorFields.every(field => nullableNumber(bar[field]) || (field === 'roc' || field === 'maroc') && (bar[field] === 'Infinity' || bar[field] === '-Infinity'))) return null
  const next = { ...bar }
  // A price projection is not a retraction of independently prepared sources.
  // Price generations invalidate recursive results while independently proven
  // statistics remain reusable. Calculated/observed nulls are authoritative.
  if (sameGeneration && previous && samePrices(previous, bar) && previous.indicatorsObserved && !bar.indicatorsObserved) {
    Object.assign(next, Object.fromEntries(indicatorFields.map(field => [field, previous[field]])), { indicatorsObserved: true })
  }
  let retainedStatistics = false
  if (previous && !observed(bar, 1) && observed(previous, 1) && finite(previous.oi)) {
    next.oi = previous.oi; next.oiObserved = true
    next.statisticsSources = (next.statisticsSources ?? 0) | 1
    delete next.oiUnavailableReason
    retainedStatistics = true
  }
  if (previous && !observed(bar, 2) && observed(previous, 2) && finite(previous.buy) && finite(previous.sell)) {
    next.buy = previous.buy; next.sell = previous.sell; next.takerObserved = true
    next.statisticsSources = (next.statisticsSources ?? 0) | 2
    delete next.takerUnavailableReason
    retainedStatistics = true
  }
  if (retainedStatistics) next.statisticsObserved = observed(next, 1) && observed(next, 2)
  return Object.freeze(next)
}

function readyWindow(meta: PreparedChartMeta, bars: PreparedChartBar[], endHour: number, liveBar?: Bar, previous?: ReadyChartWindow): ReadyChartWindow {
  const sameBars = previous && previous.generation === meta.generation && bars.length === previous.bars.length && bars.every((bar, index) => previous.bars[index] === bar)
  if (sameBars && previous.liveBar === liveBar && previous.realtimeState === meta.realtimeState && previous.priceObservedAt === meta.priceObservedAt && JSON.stringify(previous.sourceVersions) === JSON.stringify(meta.sourceVersions)) return previous
  return Object.freeze({
    key: meta.key, instId: meta.instId, timeframe: meta.timeframe, intervalMS: meta.intervalMS, generation: meta.generation, bars: sameBars ? previous.bars : Object.freeze(bars), endHour,
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
  private seriesBytes = 0
  private latestBytes = 0
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

  private setSeriesEntry(key: string, entry: Series | null) {
    this.seriesBytes += (entry?.byteSize ?? 0) - (this.series.get(key)?.byteSize ?? 0)
    if (entry) this.series.set(key, entry)
    else this.series.delete(key)
  }

  private setLatestFrame(key: string, value: { meta: PreparedChartMeta; window: ReadyChartWindow } | null) {
    const previous = this.latestFrames.get(key)
    if (previous?.window.bars !== value?.window.bars) {
      this.latestBytes += (value ? this.sizeOfBars(value.window.bars) : 0) - (previous ? this.sizeOfBars(previous.window.bars) : 0)
    }
    if (value) this.latestFrames.set(key, value)
    else this.latestFrames.delete(key)
  }

  private setSeriesBar(entry: Series, hour: number, value: CachedBar | null) {
    const previous = entry.bars.get(hour)
    const delta = (value ? this.sizeOfBar(value.bar) : 0) - (previous ? this.sizeOfBar(previous.bar) : 0)
    entry.byteSize += delta
    this.seriesBytes += delta
    if (value) entry.bars.set(hour, value)
    else entry.bars.delete(hour)
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
  private latestFrame(key: string) {
    const latest = this.latestFrames.get(key)
    return latest?.meta.generation === this.generations.get(key) ? latest : undefined
  }
  latestEnd(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.latestEnd ?? null }
  oldestHour(instId: string, timeframe: RadarTimeframe) { return this.snapshotMeta(instId, timeframe)?.oldestHour ?? null }
  snapshotMeta(instId: string, timeframe: RadarTimeframe): PreparedChartMeta | null {
    const key = keyFor(instId, timeframe), series = this.access(key), latest = this.latestFrame(key)
    if (!latest) return series ? this.universe.has(key) ? { ...series.meta, latestEnd: null } : series.meta : null
    return series ? { ...series.meta, latestEnd: latest.window.endHour } : latest.meta
  }

  /** Compact latest frames belong to navigation candidates, independently of the history LRU. */
  setUniverse(instIds: readonly string[], _timeframe: RadarTimeframe, focusInstId?: string) {
    if (focusInstId) this.focusKey = keyFor(focusInstId, _timeframe)
    this.universe = new Set([...instIds, ...(focusInstId ? [focusInstId] : [])].flatMap(instId => RADAR_TIMEFRAMES.map(({ value }) => keyFor(instId, value))))
    for (const key of this.latestFrames.keys()) if (!this.universe.has(key)) this.setLatestFrame(key, null)
    for (const [key, entry] of this.series) {
      if (!this.universe.has(key) || this.latestFrame(key) || entry.meta.latestEnd === null) continue
      const window = this.seriesWindow(entry, entry.meta.latestEnd)
      if (window) this.setLatestFrame(key, { meta: entry.meta, window })
    }
    this.trimBytes()
  }

  private acceptGeneration(key: string, generation: number) {
    const known = this.generations.get(key)
    if (known !== undefined && generation < known) return false
    if (known !== undefined && generation > known) {
      const entry = this.series.get(key)
      if (entry) { entry.windows.clear(); entry.boundaries = null }
      // Keep bounded old bar slots solely to merge independent statistics when
      // this generation's prices arrive. Read paths reject their old provenance.
    }
    this.generations.set(key, generation)
    return true
  }

  /** Latest-ready notifications never allocate a deep-history cache entry. */
  ingestLive(update: PreparedChartLiveUpdate): boolean {
    const key = keyFor(update.instId, update.timeframe), previous = this.latestFrames.get(key)
    if (!this.universe.has(key) || !previous || update.generation !== this.generations.get(key) || update.generation !== previous.meta.generation
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
    this.setLatestFrame(key, { meta, window })
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
    if (previous?.meta.generation === generation && (revision < previous.meta.revision || endHour < previous.window.endHour)) return false
    const incoming = new Map(response.bars.map(bar => [bar.hour, bar]))
    const previousBars = new Map(previous?.window.bars.map(bar => [bar.hour, bar]))
    const bars: PreparedChartBar[] = []
    for (let index = WINDOW_BARS - 1; index >= 0; index -= 1) {
      const hour = endHour - index * intervalMS, value = incoming.get(hour)
      if (!value) continue
      const previousBar = previousBars.get(hour)
      const bar = preparedBar(value, intervalMS, previousBar, previous?.meta.generation === generation)
      if (!bar) continue
      const oldBar = previousBar
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
    this.setLatestFrame(key, { meta, window })
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
        epoch: ++this.nextEpoch, byteSize: entry?.byteSize ?? (latest ? this.sizeOfBars(latest.window.bars) : 0),
        meta: Object.freeze({ ...(entry?.meta ?? latest?.meta), key, instId, timeframe, intervalMS, generation, revision, latestEnd: entry?.meta.latestEnd ?? latest?.meta.latestEnd ?? null, oldestHour: entry?.meta.oldestHour ?? latest?.meta.oldestHour ?? null, historyExhausted: entry?.meta.historyExhausted ?? latest?.meta.historyExhausted ?? false, error: '' }),
        bars: entry?.bars ?? new Map(latest?.window.bars.map(bar => [bar.hour, { bar, revision: latest.meta.revision, generation: latest.meta.generation }]) ?? []),
        hours: entry?.hours ?? latest?.window.bars.map(bar => bar.hour) ?? [],
        windows: latest?.meta.generation === generation ? new Map([[latest.window.endHour, latest.window]]) : new Map(), boundaries: null,
        liveBar: latest?.meta.generation === generation ? latest.window.liveBar : undefined, liveRevision: latest?.meta.generation === generation ? latest.meta.revision : -1,
      }
      this.setSeriesEntry(key, entry)
      while (this.series.size > this.maxSeries) {
        const evicted = this.series.keys().next().value!
        this.setSeriesEntry(evicted, null)
      }
    }
    const current = entry!
    let changed = newGeneration
    const addedHours: number[] = []
    for (const incoming of response.bars) {
      const previous = current.bars.get(incoming.hour)
      const sameGeneration = previous?.generation === generation
      if (sameGeneration && previous.revision > revision) continue
      const bar = preparedBar(incoming, intervalMS, previous?.bar, sameGeneration)
      if (!bar) continue
      if (previous && !sameGeneration) current.boundaries = null
      if (sameBar(previous?.bar, bar)) {
        previous!.revision = sameGeneration ? Math.max(previous!.revision, revision) : revision
        if (!sameGeneration) { previous!.generation = generation; changed = true }
        continue
      }
      if (!previous) addedHours.push(bar.hour)
      this.setSeriesBar(current, bar.hour, { bar, revision, generation })
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
      if (nextMeta.oldestHour !== current.meta.oldestHour || nextMeta.historyExhausted !== current.meta.historyExhausted) current.boundaries = null
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
      for (const hour of removable.slice(0, excess)) this.setSeriesBar(current, hour, null)
      current.hours = current.hours.filter(hour => current.bars.has(hour))
      current.windows.clear()
      current.boundaries = null
      changed = true
    }
    if (this.universe.has(key)) {
      const previous = this.latestFrame(key)
      // A historical batch can carry a new indicator generation and a fully
      // rebuilt latest window together. Repin that window in the same ingest.
      const end = finite(response.latestEnd) && current.bars.get(response.latestEnd)?.generation === generation
        ? Math.max(previous?.window.endHour ?? -Infinity, response.latestEnd) : previous?.window.endHour
      const window = end === undefined ? null : this.seriesWindow(current, end)
      if (window) {
        this.setLatestFrame(key, { meta: Object.freeze({ ...current.meta, latestEnd: window.endHour }), window })
        if (window !== previous?.window) changed = true
      }
    }
    this.trimBytes()
    if (changed) for (const listener of this.listeners) listener()
    return true
  }

  private sizeOfBar(bar: PreparedChartBar): number {
    const cached = this.byteSizes.get(bar)
    if (cached !== undefined) return cached
    const bytes = JSON.stringify(bar).length * 2
    this.byteSizes.set(bar, bytes)
    return bytes
  }

  private sizeOfBars(bars: readonly PreparedChartBar[]): number {
    const cached = this.byteSizes.get(bars)
    if (cached !== undefined) return cached
    const bytes = bars.reduce((sum, bar) => sum + this.sizeOfBar(bar), 0)
    this.byteSizes.set(bars, bytes)
    return bytes
  }

  private trimBytes() {
    if (this.seriesBytes + this.latestBytes <= this.maxBytes) return
    for (const key of this.series.keys()) {
      if (this.seriesBytes + this.latestBytes <= this.maxBytes) break
      if (key !== this.focusKey) this.setSeriesEntry(key, null)
    }
    for (const key of this.latestFrames.keys()) {
      if (this.seriesBytes + this.latestBytes <= this.maxBytes) break
      if (key !== this.focusKey) this.setLatestFrame(key, null)
    }
  }

  window(instId: string, timeframe: RadarTimeframe, end?: number | null): ReadyChartWindow | null {
    const key = keyFor(instId, timeframe), entry = this.access(key), latest = this.latestFrame(key)
    if (latest && (end === null || end === undefined || end === latest.window.endHour)) return latest.window
    if ((end === null || end === undefined) && this.universe.has(key)) return null
    const endHour = end ?? entry?.meta.latestEnd
    if (!entry || entry.meta.generation !== this.generations.get(key) || endHour === null || endHour === undefined || !Number.isSafeInteger(endHour)) return null
    return this.seriesWindow(entry, endHour)
  }

  private seriesWindow(entry: Series, endHour: number): ReadyChartWindow | null {
    if (entry.meta.generation !== this.generations.get(entry.meta.key)) return null
    const bars: PreparedChartBar[] = []
    for (let index = WINDOW_BARS - 1; index >= 0; index -= 1) {
      const value = entry.bars.get(endHour - index * entry.meta.intervalMS)
      if (!value || value.generation !== entry.meta.generation) continue
      bars.push(value.bar)
    }
    const liveBar = endHour === entry.meta.latestEnd ? entry.liveBar : undefined
    if (entry.bars.get(endHour)?.generation !== entry.meta.generation && !liveBar) return null
    if (!bars.length && !liveBar) return null
    const cached = entry.windows.get(endHour)
    if (cached && cached.generation === entry.meta.generation && cached.liveBar === liveBar && cached.bars.length === bars.length && bars.every((bar, index) => cached.bars[index] === bar)) {
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
    if (!entry || entry.meta.generation !== this.generations.get(keyFor(instId, timeframe)) || !Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from > through
      || (through - from) % entry.meta.intervalMS !== 0) return false
    for (let hour = from; hour <= through; hour += entry.meta.intervalMS) if (entry.bars.get(hour)?.generation !== entry.meta.generation) return false
    return true
  }

  readyBoundaries(instId: string, timeframe: RadarTimeframe): readonly ReadyChartBoundary[] {
    const key = keyFor(instId, timeframe), entry = this.series.get(key), latest = this.latestFrame(key)
    if (!entry) return latest ? [{ firstEnd: latest.window.endHour, lastEnd: latest.window.endHour }] : []
    if (entry.meta.generation !== this.generations.get(key)) return []
    if (entry.boundaries) return entry.boundaries
    const hours = entry.hours.filter(hour => entry.bars.get(hour)?.generation === entry.meta.generation)
    const runs: ReadyChartBoundary[] = []
    let start = 0
    for (let index = 1; index <= hours.length; index += 1) {
      if (index < hours.length && hours[index] === hours[index - 1] + entry.meta.intervalMS) continue
      if (index > start) {
        const first = hours[start], lastEnd = hours[index - 1]
        // Navigation consumes a whole viewport. Counting the first 95 candles
        // as available runway postpones acquisition until the chart is stuck.
        const firstEnd = entry.meta.historyExhausted && first === entry.meta.oldestHour
          ? first : first + (WINDOW_BARS - 1) * entry.meta.intervalMS
        if (firstEnd <= lastEnd) runs.push(Object.freeze({ firstEnd, lastEnd }))
      }
      start = index
    }
    entry.boundaries = Object.freeze(runs)
    return entry.boundaries
  }
}

hookOperationMethods(PreparedChartStore.prototype, {
  ingest: (response: PreparedChartResponse) => ({ category: 'cpu', name: 'chart.series.ingest', resource: response.instId,
    attributes: { inputRows: response.bars?.length ?? 0 } }),
  ingestLive: (response: PreparedChartLiveUpdate) => ({ category: 'cpu', name: 'chart.series.live', resource: response.instId }),
})
