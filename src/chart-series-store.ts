import { hookOperationMethods, measureOperation } from '../electron/services/operations.js'
import { completeChartPriceRange } from './chart-data.ts'
import type { Bar, ChartSourceStatus, PreparedChartBar, PreparedChartLiveUpdate, PreparedChartMeta, PreparedChartResponse, PreparedChartState, ReadyChartWindow } from './chart-data.ts'
import { RADAR_TIMEFRAMES, timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

const WINDOW_BARS = 96
const indicatorFields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw'] as const
const barFields = ['hour', 'open', 'high', 'low', 'close', 'confirmed', 'priceComplete', 'statisticsSources', 'statisticsObserved', 'oiObserved', 'takerObserved', 'indicatorsObserved', ...indicatorFields, 'oi', 'buy', 'sell', 'oiUnavailableReason', 'takerUnavailableReason'] as const
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const sameBar = (left: Bar | undefined, right: Bar) => left !== undefined && barFields.every(field => left[field] === right[field])
const validPrice = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close].every(value => finite(value) && value > 0)
  && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
const validLiveBar = (bar: Bar, intervalMS: number) => bar?.confirmed === false && validPrice(bar)
  && Number.isSafeInteger(bar.hour) && bar.hour % intervalMS === 0
const keyFor = (instId: string, timeframe: RadarTimeframe) => `${timeframe}:${instId}`
const samePrices = (left: Bar, right: Bar) => (['hour', 'open', 'high', 'low', 'close', 'confirmed'] as const).every(field => left[field] === right[field])
const observed = (bar: Bar, source: 1 | 2) => (source === 1 ? bar.oiObserved : bar.takerObserved)
  ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & source)
const retainedStatus = (value: ChartSourceStatus | undefined, previous: ChartSourceStatus | undefined) =>
  value === previous || JSON.stringify(value) === JSON.stringify(previous) ? previous : value && Object.freeze(value)
const retainedVersions = (value: PreparedChartMeta['sourceVersions'], previous: PreparedChartMeta['sourceVersions']) =>
  value === undefined ? undefined : value === previous || JSON.stringify(value) === JSON.stringify(previous) ? previous : Object.freeze({ ...value })

export type ReadyChartBoundary = Readonly<{ firstEnd: number; lastEnd: number }>
export type PreparedChartStoreLimits = { maxSeries?: number; maxBarsPerSeries?: number; maxWindowsPerSeries?: number; maxBytes?: number }
type CachedBar = { bar: PreparedChartBar; revision: number; generation: number }
type CachedWindow = { window: ReadyChartWindow; meta: PreparedChartMeta; version: number; liveBar?: Bar }
type Series = {
  epoch: number
  version: number
  byteSize: number
  meta: PreparedChartMeta
  bars: Map<number, CachedBar>
  hours: number[]
  windows: Map<number, CachedWindow>
  boundaries: readonly ReadyChartBoundary[] | null
  liveBar?: Bar
  liveRevision: number
}

function preparedBar(bar: PreparedChartBar, intervalMS: number, previous?: PreparedChartBar, sameGeneration = true): PreparedChartBar | null {
  if (!Number.isSafeInteger(bar.hour) || bar.hour % intervalMS !== 0 || !bar.confirmed || !validPrice(bar)
    || ![bar.oi, bar.buy, bar.sell].every(value => nullableNumber(value) && (value === null || value >= 0))
    || (bar.buy === null) !== (bar.sell === null)
    || !indicatorFields.every(field => nullableNumber(bar[field]))) return null
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

function sourceMeta(previous: PreparedChartMeta | undefined, response: PreparedChartResponse) {
  let statuses = [...previous?.sourceStatuses ?? []].filter(value => value.source !== 'indicator' || previous?.generation === response.generation)
  for (const source of ['price', 'oi', 'taker', 'indicator'] as const) {
    const status = response[`${source}Status`]
    if (!status || status.through === null || !Number.isSafeInteger(status.from) || !Number.isSafeInteger(status.through)
      || status.from < 0 || status.from > status.through || status.from % response.intervalMS || status.through % response.intervalMS) continue
    // A status supersedes only its own slots. Keep uncovered failures until
    // their source succeeds or their navigation data leaves the cache.
    statuses = statuses.flatMap(value => {
      const prior = value.status
      if (value.source !== source || prior.through === null || prior.through < status.from || prior.from > status.through!) return [value]
      return [
        ...(prior.from < status.from ? [{ source, status: Object.freeze({ ...prior, through: status.from - response.intervalMS }) }] : []),
        ...(prior.through > status.through! ? [{ source, status: Object.freeze({ ...prior, from: status.through! + response.intervalMS }) }] : []),
      ]
    })
    statuses.push({ source, status: Object.freeze({ ...status }) })
  }
  return {
    priceStatus: retainedStatus(response.priceStatus && { ...response.priceStatus }, previous?.priceStatus),
    oiStatus: retainedStatus(response.oiStatus && { ...response.oiStatus }, previous?.oiStatus),
    takerStatus: retainedStatus(response.takerStatus && { ...response.takerStatus }, previous?.takerStatus),
    indicatorStatus: retainedStatus(response.indicatorStatus && { ...response.indicatorStatus }, previous?.indicatorStatus),
    sourceStatuses: Object.freeze(statuses.map(value => Object.freeze(value))),
  }
}

/** Status residency follows possible resident viewports, rather than an LRU count. */
function retainedSourceMeta(meta: PreparedChartMeta, hours: readonly number[], liveEnd?: number): PreparedChartMeta {
  if (!meta.sourceStatuses?.length) return meta
  const ranges: Array<{ from: number; through: number }> = []
  for (const hour of [...hours, ...(liveEnd === undefined ? [] : [liveEnd])].sort((left, right) => left - right)) {
    const from = hour - (WINDOW_BARS - 1) * meta.intervalMS, previous = ranges.at(-1)
    if (previous && from <= previous.through + meta.intervalMS) previous.through = hour
    else ranges.push({ from, through: hour })
  }
  const statuses = (meta.sourceStatuses ?? []).flatMap(value => ranges.flatMap(range => value.status.through !== null && value.status.from <= range.through && value.status.through >= range.from
    ? [{ source: value.source, status: Object.freeze({ ...value.status, from: Math.max(value.status.from, range.from), through: Math.min(value.status.through, range.through) }) }] : []))
    .sort((left, right) => left.source.localeCompare(right.source) || left.status.from - right.status.from)
  const merged: typeof statuses = []
  for (const value of statuses) {
    const prior = merged.at(-1)
    const { from: _from, through: _through, ...details } = value.status
    const { from: _priorFrom, through: _priorThrough, ...priorDetails } = prior?.status ?? {}
    if (prior?.source === value.source && prior.status.through! + meta.intervalMS === value.status.from && JSON.stringify(details) === JSON.stringify(priorDetails)) {
      merged[merged.length - 1] = { source: value.source, status: Object.freeze({ ...prior.status, through: value.status.through }) }
    } else merged.push(value)
  }
  return Object.freeze({ ...meta, sourceStatuses: Object.freeze(merged.map(value => Object.freeze(value))) })
}

function matchingStatus(meta: PreparedChartMeta, from: number, through: number, source: 'price' | 'oi' | 'taker' | 'indicator') {
  return [...meta.sourceStatuses ?? []].reverse().find(value => value.source === source && value.status.through !== null && value.status.from <= through && value.status.through >= from)?.status
}

type WindowSource = { state: PreparedChartState; status: ChartSourceStatus | undefined }

function windowSource(meta: PreparedChartMeta, bars: readonly PreparedChartBar[], from: number, through: number, source: 'price' | 'oi' | 'taker' | 'indicator'): WindowSource {
  const bit = source === 'oi' ? 1 : 2
  if (source === 'indicator' && !bars.length) return { state: 'loading', status: undefined }
  const missing = new Set<number>(source === 'indicator' ? bars.map(bar => bar.hour) : [])
  if (source !== 'indicator') for (let hour = from; hour <= through; hour += meta.intervalMS) missing.add(hour)
  for (const bar of bars) if (source === 'price' ? bar.priceComplete !== false : source === 'indicator' ? bar.indicatorsObserved : observed(bar, bit)) missing.delete(bar.hour)
  if (!missing.size) {
    const state = source === 'price' || bars.every(bar => source === 'indicator' ? indicatorFields.every(field => finite(bar[field])) : source === 'oi' ? finite(bar.oi) : finite(bar.buy) && finite(bar.sell)) ? 'ready' : 'unavailable'
    const prior = matchingStatus(meta, from, through, source)
    const reason = source === 'indicator' ? bars.some(bar => bar.ema === null) ? 'insufficient-history' : 'undefined-value' : 'not-published'
    const status: ChartSourceStatus | undefined = prior
      ? { state, from, through, ...(prior.inputVersion ? { inputVersion: prior.inputVersion } : {}), ...(state === 'unavailable' ? { reason } : {}) } : undefined
    return { state, status }
  }
  let matching: ChartSourceStatus | undefined
  let loading = false
  // Each missing slot belongs to its newest covering status. Work on other
  // slots cannot clear a failure that still owns an unresolved observation.
  for (const value of [...meta.sourceStatuses ?? []].reverse()) {
    const status = value.status
    if (value.source !== source || status.through === null) continue
    let relevant = false
    for (const hour of missing) if (status.from <= hour && hour <= status.through) {
      missing.delete(hour)
      relevant = true
    }
    if (!relevant) continue
    if (!matching || status.state === 'error' && matching.state !== 'error') matching = status
    if (status.state !== 'error' && !(status.state === 'unavailable' && status.reason === 'unsupported')) loading = true
  }
  const state = matching?.state === 'error' ? 'error' : missing.size || loading ? 'loading' : 'unavailable'
  const status: ChartSourceStatus | undefined = !matching ? undefined : state === 'error' ? { ...matching, from, through }
    : { state, from, through, ...(matching.inputVersion ? { inputVersion: matching.inputVersion } : {}), ...(state === 'unavailable' ? { reason: 'unsupported' as const } : {}) }
  return { state, status }
}

function presentWindow(meta: PreparedChartMeta, bars: readonly PreparedChartBar[], endHour: number, liveBar: Bar | undefined,
  first: number, complete: boolean, price: ChartSourceStatus | undefined, oi: WindowSource, taker: WindowSource, indicator: WindowSource,
  previous?: ReadyChartWindow): ReadyChartWindow {
  const latest = endHour === meta.latestEnd
  const detached = latest && liveBar && liveBar.hour !== endHour + meta.intervalMS
  const availability: PreparedChartState = !bars.length && !liveBar ? 'loading' : !complete ? 'partial'
    : latest && (detached || meta.priceState === 'stale') ? 'stale'
      : 'ready'
  const priceStatus = retainedStatus(price ? availability !== 'ready' && price.state === 'error' ? { ...price, from: first, through: endHour } : { state: availability, from: first, through: endHour } : undefined, previous?.priceStatus)
  const priceState = priceStatus?.state === 'error' ? 'error' : availability
  const oiStatus = retainedStatus(oi.status, previous?.oiStatus), takerStatus = retainedStatus(taker.status, previous?.takerStatus)
  const indicatorStatus = retainedStatus(indicator.status, previous?.indicatorStatus)
  const sameBars = previous && previous.generation === meta.generation && (bars === previous.bars
    || bars.length === previous.bars.length && bars.every((bar, index) => previous.bars[index] === bar))
  if (sameBars && previous.liveBar === liveBar && previous.priceState === priceState && previous.priceAsOf === meta.priceAsOf
    && previous.priceStatus === priceStatus && previous.oiState === oi.state && previous.takerState === taker.state
    && previous.oiStatus === oiStatus && previous.takerStatus === takerStatus && previous.indicatorState === indicator.state && previous.indicatorStatus === indicatorStatus
    && previous.realtimeState === (meta.realtimeState ?? 'stale') && previous.priceObservedAt === meta.priceObservedAt
    && (previous.sourceVersions === meta.sourceVersions || JSON.stringify(previous.sourceVersions) === JSON.stringify(meta.sourceVersions))) return previous
  return Object.freeze({
    key: meta.key, instId: meta.instId, timeframe: meta.timeframe, intervalMS: meta.intervalMS, generation: meta.generation, bars: sameBars ? previous.bars : Object.freeze(bars), endHour,
    priceStatus, oiState: oi.state, takerState: taker.state, oiStatus, takerStatus,
    indicatorState: indicator.state, indicatorStatus,
    ...(liveBar ? { liveBar } : {}), priceState, priceAsOf: meta.priceAsOf, priceObservedAt: meta.priceObservedAt, realtimeState: meta.realtimeState ?? 'stale', sourceVersions: meta.sourceVersions,
  })
}

function readyWindow(meta: PreparedChartMeta, bars: readonly PreparedChartBar[], endHour: number, liveBar?: Bar, previous?: ReadyChartWindow): ReadyChartWindow {
  const first = Math.max(endHour - (WINDOW_BARS - 1) * meta.intervalMS, meta.historyExhausted ? meta.oldestHour ?? -Infinity : -Infinity)
  const complete = completeChartPriceRange(bars, first, endHour, meta.intervalMS)
  const price = windowSource(meta, bars, first, endHour, 'price').status
  const oi = windowSource(meta, bars, first, endHour, 'oi'), taker = windowSource(meta, bars, first, endHour, 'taker')
  const indicator = windowSource(meta, bars, first, endHour, 'indicator')
  return presentWindow(meta, bars, endHour, liveBar, first, complete, price, oi, taker, indicator, previous)
}

function liveWindow(meta: PreparedChartMeta, liveBar: Bar | undefined, previous: ReadyChartWindow): ReadyChartWindow {
  // A nonempty ready/stale price window has already proven every completed
  // slot. The accepted live delta changes no completed bars, source statuses,
  // generation, or history boundary; failures in other sources are reusable.
  // Empty, partial, and price-error windows still need the full projection.
  if (!previous.bars.length || previous.priceState !== 'ready' && previous.priceState !== 'stale') {
    return readyWindow(meta, previous.bars, previous.endHour, liveBar, previous)
  }
  const first = Math.max(previous.endHour - (WINDOW_BARS - 1) * meta.intervalMS, meta.historyExhausted ? meta.oldestHour ?? -Infinity : -Infinity)
  return presentWindow(meta, previous.bars, previous.endHour, liveBar, first, true, previous.priceStatus,
    { state: previous.oiState, status: previous.oiStatus }, { state: previous.takerState, status: previous.takerStatus },
    { state: previous.indicatorState, status: previous.indicatorStatus }, previous)
}

/** Confirmed prices remain visible while each incomplete source repairs independently. */
export class PreparedChartStore {
  private nextEpoch = 0
  private readonly series = new Map<string, Series>()
  private readonly latestFrames = new Map<string, { meta: PreparedChartMeta; window: ReadyChartWindow }>()
  // Keep only the numeric watermark after eviction so in-flight old generations cannot reenter this session.
  private readonly generations = new Map<string, number>()
  private universe = new Set<string>()
  private renderedUniverse = new Set<string>()
  private focusKey: string | null = null
  private readonly byteSizes = new WeakMap<object, number>()
  private seriesBytes = 0
  private latestBytes = 0
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly changedKeys = new Set<string>()
  private mutationDepth = 0
  private notifying = false
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
    this.markChanged(key)
  }

  private setLatestFrame(key: string, value: { meta: PreparedChartMeta; window: ReadyChartWindow } | null) {
    const previous = this.latestFrames.get(key)
    if (value && (previous?.window.bars !== value.window.bars || previous.window.endHour !== value.window.endHour || previous.meta.sourceStatuses !== value.meta.sourceStatuses)) {
      value = { ...value, meta: retainedSourceMeta(value.meta, value.window.bars.map(bar => bar.hour), value.window.liveBar ? value.window.endHour : undefined) }
    }
    if (previous?.window.bars !== value?.window.bars) {
      this.latestBytes += (value ? this.sizeOfBars(value.window.bars) : 0) - (previous ? this.sizeOfBars(previous.window.bars) : 0)
    }
    if (value) this.latestFrames.set(key, value)
    else this.latestFrames.delete(key)
    if (previous?.window !== value?.window || previous?.meta !== value?.meta) this.markChanged(key)
  }

  private setSeriesBar(entry: Series, hour: number, value: CachedBar | null) {
    const previous = entry.bars.get(hour)
    const delta = (value ? this.sizeOfBar(value.bar) : 0) - (previous ? this.sizeOfBar(previous.bar) : 0)
    entry.byteSize += delta
    this.seriesBytes += delta
    if (value) entry.bars.set(hour, value)
    else entry.bars.delete(hour)
    entry.version += 1
    this.markChanged(entry.meta.key)
  }

  private access(key: string): Series | undefined {
    const entry = this.series.get(key)
    if (entry) { this.series.delete(key); this.series.set(key, entry) }
    return entry
  }

  private markChanged(key: string) {
    this.changedKeys.add(key)
  }

  private mutate<T>(operation: () => T): T {
    this.mutationDepth += 1
    try {
      return operation()
    } finally {
      this.mutationDepth -= 1
      if (this.mutationDepth === 0) this.flushChanges()
    }
  }

  private flushChanges() {
    if (this.notifying || this.mutationDepth > 0) return
    this.notifying = true
    let failure: unknown
    let failed = false
    try {
      while (this.changedKeys.size) {
        const keys = [...this.changedKeys]
        this.changedKeys.clear()
        for (const key of keys) for (const listener of [...this.listeners.get(key) ?? []]) {
          try { listener() } catch (error) { if (!failed) { failed = true; failure = error } }
        }
      }
    } finally {
      this.notifying = false
    }
    if (failed) throw failure
  }

  readonly subscribe = (instId: string, timeframe: RadarTimeframe, listener: () => void) => {
    const key = keyFor(instId, timeframe)
    let listeners = this.listeners.get(key)
    if (!listeners) this.listeners.set(key, listeners = new Set())
    listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners!.delete(listener)
      if (listeners!.size === 0 && this.listeners.get(key) === listeners) this.listeners.delete(key)
    }
  }

  get size() { return this.series.size }
  get latestSize() { return this.latestFrames.size }
  /** Changes when history is recreated or loses resident bars. Compact frames do not count. */
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
    this.mutate(() => {
      if (focusInstId) this.focusKey = keyFor(focusInstId, _timeframe)
      this.renderedUniverse = new Set(instIds.map(instId => keyFor(instId, _timeframe)))
      this.universe = new Set([...instIds, ...(focusInstId ? [focusInstId] : [])].flatMap(instId => RADAR_TIMEFRAMES.map(({ value }) => keyFor(instId, value))))
      for (const key of this.latestFrames.keys()) if (!this.universe.has(key)) this.setLatestFrame(key, null)
      for (const [key, entry] of this.series) {
        if (!this.universe.has(key) || this.latestFrame(key) || entry.meta.latestEnd === null) continue
        const window = this.seriesWindow(entry, entry.meta.latestEnd)
        if (window) this.setLatestFrame(key, { meta: entry.meta, window })
      }
      this.trimBytes()
    })
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
    if (generation !== known) this.markChanged(key)
    this.generations.set(key, generation)
    return true
  }

  /** Latest-ready notifications never allocate a deep-history cache entry. */
  ingestLive(update: PreparedChartLiveUpdate): boolean {
    return this.mutate(() => {
      const key = keyFor(update.instId, update.timeframe), previous = this.latestFrames.get(key)
      if (!this.universe.has(key) || !previous || update.generation !== this.generations.get(key) || update.generation !== previous.meta.generation
        || !Number.isSafeInteger(update.revision) || update.revision < previous.meta.revision || update.endHour !== previous.window.endHour) return false
      const incoming = update.liveBar
      if (incoming !== null && (!validLiveBar(incoming, previous.meta.intervalMS) || incoming.hour <= update.endHour)) return false
      const liveBar = incoming === null ? undefined : sameBar(previous.window.liveBar, incoming) ? previous.window.liveBar : Object.freeze({ ...incoming })
      const meta = Object.freeze({ ...previous.meta, revision: update.revision, priceState: update.priceState ?? previous.meta.priceState, priceObservedAt: update.priceObservedAt ?? previous.meta.priceObservedAt, priceAsOf: update.priceAsOf ?? previous.meta.priceAsOf, realtimeState: update.realtimeState ?? previous.meta.realtimeState, sourceVersions: retainedVersions(update.sourceVersions ?? previous.meta.sourceVersions, previous.meta.sourceVersions) })
      const window = liveWindow(meta, liveBar, previous.window)
      const entry = this.series.get(key)
      if (entry) {
        entry.meta = Object.freeze({ ...entry.meta, revision: Math.max(entry.meta.revision, update.revision),
          priceState: meta.priceState, priceAsOf: meta.priceAsOf, priceObservedAt: meta.priceObservedAt, realtimeState: meta.realtimeState, sourceVersions: meta.sourceVersions })
        entry.liveBar = liveBar
        entry.liveRevision = update.revision
      }
      this.setLatestFrame(key, { meta, window })
      if (window !== previous.window || meta !== previous.meta) this.markChanged(key)
      return true
    })
  }

  /** Latest-ready notifications never allocate a deep-history cache entry. */
  ingestLatest(response: PreparedChartResponse): boolean {
    return this.mutate(() => {
      if (response.endHour === null && response.liveBar && validLiveBar(response.liveBar, response.intervalMS)) {
        response = { ...response, endHour: response.liveBar.hour - response.intervalMS, latestEnd: response.liveBar.hour - response.intervalMS }
      }
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
      const live = response.liveBar
      const liveBar = live && validLiveBar(live, intervalMS) && live.hour > endHour
        ? sameBar(previous?.window.liveBar, live) ? previous!.window.liveBar : Object.freeze({ ...live }) : undefined
      if ((!bars.length || !incoming.has(endHour)) && !liveBar) return false
      const meta: PreparedChartMeta = Object.freeze({
        key, instId, timeframe, intervalMS, generation, revision, latestEnd: endHour,
        priceState: response.priceState, priceAsOf: response.priceAsOf, priceObservedAt: response.priceObservedAt, realtimeState: response.realtimeState, sourceVersions: retainedVersions(response.sourceVersions, previous?.meta.sourceVersions),
        ...sourceMeta(previous?.meta, response),
        oldestHour: response.oldestHour === null ? previous?.meta.oldestHour ?? null : Math.min(previous?.meta.oldestHour ?? Infinity, response.oldestHour),
        historyExhausted: response.historyExhausted || (previous?.meta.historyExhausted ?? false), error: response.error,
      })
      const window = readyWindow(meta, bars, endHour, liveBar, previous?.window)
      this.setLatestFrame(key, { meta, window })
      this.trimBytes()
      if (window !== previous?.window || revision !== previous?.meta.revision) this.markChanged(key)
      return true
    })
  }

  ingest(response: PreparedChartResponse): boolean {
    return this.mutate(() => {
      const { instId, timeframe, intervalMS, generation, revision } = response
      if (!instId || !['5m', '15m', '1H'].includes(timeframe) || intervalMS !== timeframeMilliseconds(timeframe)
        || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(generation) || generation < 0) return false
      const key = keyFor(instId, timeframe)
      if (!this.acceptGeneration(key, generation)) return false
      let entry = this.access(key)
      const latest = this.latestFrames.get(key)
      const previousGeneration = entry?.meta.generation ?? latest?.meta.generation
      const newGeneration = !entry || entry.meta.generation !== generation
      if (newGeneration) {
        entry = {
          epoch: ++this.nextEpoch, version: 0, byteSize: entry?.byteSize ?? (latest ? this.sizeOfBars(latest.window.bars) : 0),
          meta: Object.freeze({ ...(entry?.meta ?? latest?.meta), key, instId, timeframe, intervalMS, generation, revision, latestEnd: entry?.meta.latestEnd ?? latest?.meta.latestEnd ?? null, oldestHour: entry?.meta.oldestHour ?? latest?.meta.oldestHour ?? null, historyExhausted: entry?.meta.historyExhausted ?? latest?.meta.historyExhausted ?? false, error: '' }),
          bars: entry?.bars ?? new Map(latest?.window.bars.map(bar => [bar.hour, { bar, revision: latest.meta.revision, generation: latest.meta.generation }]) ?? []),
          hours: entry?.hours ?? latest?.window.bars.map(bar => bar.hour) ?? [],
          windows: latest?.meta.generation === generation ? new Map([[latest.window.endHour, { window: latest.window, meta: latest.meta, version: 0, liveBar: latest.window.liveBar }]]) : new Map(), boundaries: null,
          liveBar: latest?.meta.generation === generation ? latest.window.liveBar : undefined, liveRevision: latest?.meta.generation === generation ? latest.meta.revision : -1,
        }
        if (previousGeneration !== generation) entry.meta = Object.freeze({ ...entry.meta, indicatorStatus: undefined, sourceStatuses: entry.meta.sourceStatuses?.filter(value => value.source !== 'indicator') })
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
        if (previous?.bar.priceComplete !== bar.priceComplete) current.boundaries = null
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
        ...(newestMeta ? sourceMeta(current.meta, response) : { priceStatus: current.meta.priceStatus, oiStatus: current.meta.oiStatus, takerStatus: current.meta.takerStatus, indicatorStatus: current.meta.indicatorStatus, sourceStatuses: current.meta.sourceStatuses }),
        priceState: newestMeta && response.endHour === response.latestEnd ? response.priceState : current.meta.priceState,
        priceAsOf: newestMeta ? response.priceAsOf ?? current.meta.priceAsOf : current.meta.priceAsOf,
        priceObservedAt: newestMeta ? response.priceObservedAt ?? current.meta.priceObservedAt : current.meta.priceObservedAt,
        realtimeState: newestMeta ? response.realtimeState ?? current.meta.realtimeState : current.meta.realtimeState,
        sourceVersions: newestMeta ? retainedVersions(response.sourceVersions ?? current.meta.sourceVersions, current.meta.sourceVersions) : current.meta.sourceVersions,
        key, instId, timeframe, intervalMS, generation, revision: Math.max(current.meta.revision, revision), latestEnd, oldestHour,
        historyExhausted: current.meta.historyExhausted || response.historyExhausted,
        error: newestMeta ? response.error : current.meta.error,
      }
      if (Object.keys(nextMeta).some(field => nextMeta[field as keyof PreparedChartMeta] !== current.meta[field as keyof PreparedChartMeta])) {
        if (nextMeta.oldestHour !== current.meta.oldestHour || nextMeta.historyExhausted !== current.meta.historyExhausted) current.boundaries = null
        current.meta = Object.freeze(nextMeta)
        changed = true
      }
      if (response.liveBar && revision >= current.liveRevision && validLiveBar(response.liveBar, intervalMS)) {
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
        current.epoch = ++this.nextEpoch
        current.hours = current.hours.filter(hour => current.bars.has(hour))
        current.windows.clear()
        current.boundaries = null
        changed = true
      }
      current.meta = retainedSourceMeta(current.meta, current.hours.filter(hour => current.bars.get(hour)?.generation === generation), current.liveBar ? current.meta.latestEnd ?? undefined : undefined)
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
      if (changed) this.markChanged(key)
      return true
    })
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
      // Listed SVGs own their latest inputs. The byte target applies after
      // this bounded candidate working set; deep history is evicted first.
      if (key !== this.focusKey && !this.renderedUniverse.has(key)) this.setLatestFrame(key, null)
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

  /** Read exact cached slots for plot overscan without scheduling history work. */
  knownBars(instId: string, timeframe: RadarTimeframe, hours: readonly number[]): readonly (PreparedChartBar | undefined)[] {
    const key = keyFor(instId, timeframe), generation = this.generations.get(key)
    if (generation === undefined) return hours.map(() => undefined)
    const entry = this.series.get(key), latest = this.latestFrame(key)
    return hours.map(hour => {
      if (!Number.isSafeInteger(hour) || hour % timeframeMilliseconds(timeframe)) return undefined
      const cached = entry?.meta.generation === generation ? entry.bars.get(hour) : undefined
      if (cached?.generation === generation) return cached.bar
      if (latest?.meta.generation === generation) return latest.window.bars.find(bar => bar.hour === hour)
      return undefined
    })
  }

  private seriesWindow(entry: Series, endHour: number): ReadyChartWindow | null {
    if (entry.meta.generation !== this.generations.get(entry.meta.key)) return null
    const liveBar = endHour === entry.meta.latestEnd ? entry.liveBar : undefined
    const cached = entry.windows.get(endHour)
    // Immutable metadata owns source status/freshness; version owns changed or
    // evicted bars. Repeated navigation reads need no 96-slot projection work.
    const reusable = cached?.meta === entry.meta && cached.version === entry.version && cached.liveBar === liveBar
    const window = reusable ? cached.window : measureOperation({ category: 'cpu', name: 'chart.window.project', resource: entry.meta.instId,
      attributes: { inputRows: WINDOW_BARS } }, () => {
      const bars: PreparedChartBar[] = []
      for (let index = WINDOW_BARS - 1; index >= 0; index -= 1) {
        const value = entry.bars.get(endHour - index * entry.meta.intervalMS)
        if (value?.generation === entry.meta.generation) bars.push(value.bar)
      }
      if (entry.bars.get(endHour)?.generation !== entry.meta.generation && !liveBar || !bars.length && !liveBar) return null
      return readyWindow(entry.meta, bars, endHour, liveBar, cached?.window)
    })
    if (!window) return null
    entry.windows.delete(endHour)
    entry.windows.set(endHour, reusable ? cached : { window, meta: entry.meta, version: entry.version, liveBar })
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
    if (!entry) return latest?.window.priceState === 'ready' ? [{ firstEnd: latest.window.endHour, lastEnd: latest.window.endHour }] : []
    if (entry.meta.generation !== this.generations.get(key)) return []
    if (entry.boundaries) return entry.boundaries
    const hours = entry.hours.filter(hour => entry.bars.get(hour)?.generation === entry.meta.generation && entry.bars.get(hour)?.bar.priceComplete !== false)
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
