import { PreparedChartStore } from './chart-series-store.ts'
import { completeChartPriceRange } from './chart-data.ts'
import type { ChartSourceStatus, PreparedChartNotification, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

export type ChartTarget = { instId: string; timeframe: RadarTimeframe; end: number | null }
export type ChartView = {
  requested: ChartTarget | null
  presented: ReadyChartWindow | null
  pending: boolean
  error: string
  oldestHour: number | null
  latestEnd: number | null
  historyExhausted: boolean
}
export type ChartTransport = {
  focus: (target: ChartTarget | null, id: string) => Promise<unknown> | void
  local: (instId: string, timeframe: RadarTimeframe) => Promise<PreparedChartResponse | null>
  history?: (target: ChartTarget, focusId: string) => Promise<PreparedChartResponse | null>
  universe: () => Promise<{ frames: PreparedChartResponse[] }>
}
const targetKey = (target: ChartTarget) => `${target.timeframe}:${target.instId}:${target.end ?? 'latest'}`
const sameSeries = (left: Pick<ChartTarget, 'instId' | 'timeframe'>, right: Pick<ChartTarget, 'instId' | 'timeframe'>) => left.instId === right.instId && left.timeframe === right.timeframe
const seriesKey = (target: Pick<ChartTarget, 'instId' | 'timeframe'>) => `${target.timeframe}:${target.instId}`
type SourceRevision = Pick<PreparedChartResponse, 'generation' | 'revision'>
type SourceWatermark = SourceRevision & { cursor: number | 'latest' }
const sourceCursor = (response: PreparedChartNotification) => 'type' in response || response.endHour === response.latestEnd ? 'latest' : response.endHour!

/** Owns renderer cache and navigation. Acquisition, calculation and retries belong to backend demand. */
export class ChartController {
  readonly store: PreparedChartStore
  private transport: ChartTransport
  private listeners = new Set<() => void>()
  private view: ChartView = { requested: null, presented: null, pending: false, error: '', oldestHour: null, latestEnd: null, historyExhausted: false }
  private owner = 0
  private focusVersion = 0
  private readonly identity = crypto.randomUUID()
  private focusId = ''
  private active = false
  private localTargets = new Set<string>()
  private localCheckedKey: string | null = null
  private historyTargets = new Set<string>()
  private historyAttempts = new Map<string, string>()
  private historyHydrated = new Map<string, string>()
  private universeIds: string[] = []
  private universeKey = ''
  private universeRequest = 0
  private universeTask: Promise<void> = Promise.resolve()
  private notificationVersion = 0
  private notificationVersions = new Map<string, number>()
  private sourceRevisions = new Map<string, SourceWatermark>()
  private priceSource: (SourceRevision & { target: string; endHour: number | null; status: ChartSourceStatus | undefined }) | null = null

  constructor(transport: ChartTransport, store = new PreparedChartStore()) {
    this.transport = transport
    this.store = store
  }

  getSnapshot = () => this.view
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  setUniverse(instIds: readonly string[], timeframe: RadarTimeframe, focusInstId?: string) {
    const ids = [...new Set(instIds.filter(Boolean))]
    const key = JSON.stringify(ids.toSorted())
    this.universeIds = ids
    const focus = focusInstId ?? (this.view.requested?.timeframe === timeframe ? this.view.requested.instId : undefined)
    this.store.setUniverse(ids, timeframe, focus)
    if (key === this.universeKey) return this.universeTask
    this.universeKey = key
    const request = ++this.universeRequest
    const admittedAt = this.notificationVersion
    this.universeTask = this.transport.universe().then(({ frames }) => {
      if (request !== this.universeRequest) return
      for (const frame of frames) {
        if ((this.notificationVersions.get(seriesKey(frame)) ?? 0) <= admittedAt) this.retainPriceSource(frame)
        if (this.admitDrawable(frame)) this.store.ingestLatest(this.preservePushedLive(frame, admittedAt))
      }
      if (this.active) { this.commit(); void this.pump() }
    }).catch(() => { if (request === this.universeRequest) this.universeKey = '' })
    return this.universeTask
  }

  ingestPrepared(response: PreparedChartNotification) {
    const live = 'type' in response
    const sourceChanged = !live && this.retainPriceSource(response)
    const accepted = this.admitDrawable(response) && (live ? this.store.ingestLive(response)
      : response.endHour !== response.latestEnd ? this.store.ingest(response) : this.store.ingestLatest(response))
    if (!accepted && !sourceChanged) return
    this.notificationVersions.set(seriesKey(response), ++this.notificationVersion)
    this.preparedChanged(response, live || !response.bars.length && !response.liveBar)
  }

  private admitDrawable(response: PreparedChartNotification) {
    const watermark = this.sourceRevisions.get(seriesKey(response))
    // Empty source frames can advance the input basis without entering the
    // drawable store. Every later ingress must still obey that generation.
    // Historical pages at other cursors retain independent per-bar revisions.
    return !watermark || response.generation > watermark.generation
      || response.generation === watermark.generation
        && (sourceCursor(response) !== watermark.cursor || response.revision >= watermark.revision)
  }

  private retainPriceSource(response: PreparedChartResponse, focusId = this.focusId) {
    const target = this.view.requested
    if (!this.active || focusId !== this.focusId || !target || !sameSeries(target, response)
      || response.intervalMS !== timeframeMilliseconds(target.timeframe)
      || !Number.isSafeInteger(response.generation) || response.generation < 0
      || !Number.isSafeInteger(response.revision) || response.revision < 0
      || (response.endHour !== null && (!Number.isSafeInteger(response.endHour) || response.endHour % response.intervalMS))
      || (target.end === null ? response.endHour !== response.latestEnd : response.endHour !== target.end)) return false
    const key = seriesKey(target), meta = this.store.snapshotMeta(target.instId, target.timeframe)
    if (!this.admitDrawable(response) || meta && response.generation < meta.generation) return false
    if (target.end === null && (meta?.generation === response.generation && (response.endHour ?? -Infinity) < (meta.latestEnd ?? -Infinity)
      || this.priceSource?.generation === response.generation && (response.endHour ?? -Infinity) < (this.priceSource.endHour ?? -Infinity))) return false
    this.sourceRevisions.set(key, { generation: response.generation, revision: response.revision, cursor: sourceCursor(response) })
    const previous = this.priceSource?.target === targetKey(target) ? this.priceSource.status
      : this.store.window(target.instId, target.timeframe, target.end)?.priceStatus
    const first = response.endHour === null ? null : Math.max(response.endHour - 95 * response.intervalMS,
      response.historyExhausted ? response.oldestHour ?? -Infinity : -Infinity)
    const recovered = response.priceStatus?.state === 'ready' || response.priceState === 'ready'
      || first !== null && completeChartPriceRange(response.bars, first, response.endHour!, response.intervalMS)
    const status = recovered ? undefined : response.priceStatus?.state === 'error' ? response.priceStatus
      : previous?.state === 'error' ? previous : response.priceStatus
    // Source failures can arrive before a single drawable candle. Their
    // lifetime follows this exact selection, independently of frame residency.
    this.priceSource = { target: targetKey(target), generation: response.generation, revision: response.revision, endHour: response.endHour,
      status: status ? { ...status } : undefined }
    return true
  }

  private preservePushedLive(response: PreparedChartResponse, admittedAt: number): PreparedChartResponse {
    if ((this.notificationVersions.get(seriesKey(response)) ?? 0) <= admittedAt) return response
    const meta = this.store.snapshotMeta(response.instId, response.timeframe)
    const latest = this.store.window(response.instId, response.timeframe)
    return meta?.generation === response.generation && meta.revision >= response.revision && latest?.endHour === response.latestEnd
      ? { ...response, liveBar: latest.liveBar, priceObservedAt: latest.priceObservedAt, priceAsOf: latest.priceAsOf,
        realtimeState: latest.realtimeState, priceState: latest.priceState, sourceVersions: latest.sourceVersions } : response
  }

  private preparedChanged(response: Pick<PreparedChartResponse, 'instId' | 'timeframe'>, live = false) {
    const target = this.view.requested
    if (this.active && target?.instId === response.instId && target.timeframe === response.timeframe) {
      this.commit()
      if (!live) void this.pump()
    }
  }

  open(instId: string, timeframe: RadarTimeframe, end: number | null = null) {
    const owner = ++this.owner
    this.active = true
    this.store.setUniverse(this.universeIds, timeframe, instId)
    this.publish({ ...this.view })
    this.setTarget({ instId, timeframe, end }, true)
    return () => {
      if (owner !== this.owner) return
      this.active = false
      this.updateFocus(null)
    }
  }

  scroll(steps: number) {
    const target = this.view.requested
    if (!this.active || !target || !Number.isFinite(steps) || !Math.trunc(steps)) return
    const latest = this.view.latestEnd
    if (latest === null) return
    const interval = timeframeMilliseconds(target.timeframe)
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    const floor = meta?.historyExhausted && meta.oldestHour !== null ? Math.min(latest, meta.oldestHour) : 95 * interval
    const end = Math.max(floor, Math.min(latest, (target.end ?? latest) + Math.trunc(steps) * interval))
    this.setTarget({ ...target, end: end >= latest ? null : end })
  }

  /** Admit cached neighbours for sub-candle movement without changing demand. */
  prefetchAdjacent(direction: number) {
    const { requested, presented, latestEnd, oldestHour, historyExhausted } = this.view
    if (!this.active || !requested || !presented || !direction || !Number.isFinite(direction)
      || !sameSeries(requested, presented) || !this.transport.history) return
    const edge = direction < 0 ? presented.bars[0] : presented.bars.at(-1)
    if (!edge) return
    const hour = edge.hour + Math.sign(direction) * presented.intervalMS
    if (!Number.isSafeInteger(hour) || latestEnd === null || hour > latestEnd
      || historyExhausted && oldestHour !== null && hour < oldestHour
      || this.store.knownBars(requested.instId, requested.timeframe, [hour])[0]) return
    const target = { ...requested, end: requested.end ?? latestEnd }
    const key = seriesKey(target), watermark = this.historyWatermark(target)
    const checkedKey = `${targetKey(target)}:${watermark}:${this.focusId}`
    if (this.historyAttempts.get(key) === checkedKey || this.historyTargets.has(targetKey(target)) || this.historyTargets.size >= 2) return
    void this.hydrateHistory(target, checkedKey, watermark)
  }

  private updateFocus(target: ChartTarget | null) {
    this.focusId = `${this.identity}:${++this.focusVersion}`
    const focusId = this.focusId
    const failed = (cause: unknown) => {
      if (this.active && focusId === this.focusId) this.publish({ ...this.view, error: cause instanceof Error ? cause.message : 'Could not declare chart demand.' })
    }
    try { void Promise.resolve(this.transport.focus(target, focusId)).catch(failed) } catch (cause) { queueMicrotask(() => failed(cause)) }
  }

  private setTarget(target: ChartTarget, forceFocus = false) {
    if (!forceFocus && this.view.requested && targetKey(this.view.requested) === targetKey(target)) {
      this.commit()
      void this.pump()
      return
    }
    this.localCheckedKey = null
    this.priceSource = null
    this.updateFocus(target)
    this.commit(target)
    void this.pump()
  }

  private publish(next: ChartView) {
    if (Object.keys(next).every(key => next[key as keyof ChartView] === this.view[key as keyof ChartView])) return
    this.view = next
    for (const listener of this.listeners) listener()
  }

  private completePrices(window: ReadyChartWindow) {
    const meta = this.store.snapshotMeta(window.instId, window.timeframe)
    const first = Math.max(window.endHour - 95 * window.intervalMS, meta?.historyExhausted ? meta.oldestHour ?? -Infinity : -Infinity)
    return completeChartPriceRange(window.bars, first, window.endHour, window.intervalMS)
  }

  private commit(requested = this.view.requested) {
    if (!requested) return false
    const meta = this.store.snapshotMeta(requested.instId, requested.timeframe)
    let target = requested
    if (target.end !== null && meta?.historyExhausted && meta.oldestHour !== null && meta.latestEnd !== null) {
      const floor = Math.min(meta.latestEnd, meta.oldestHour)
      if (target.end < floor) target = { ...target, end: floor }
    }
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    const previous = this.view.presented
    // The confirmed navigation boundary outlives a prepared generation. A
    // rebuilt historical window can arrive before its latest counterpart;
    // that calculation gap must not discard already consumed wheel input.
    const latestEnd = meta?.latestEnd ?? (this.view.requested && sameSeries(this.view.requested, target) ? this.view.latestEnd : null)
    const completePrices = ready && this.completePrices(ready)
    const calculating = ready
      && (ready.indicatorState === 'loading' || target.end !== null && !completePrices)
      && previous?.instId === target.instId && previous.timeframe === target.timeframe
      && previous.bars.some(bar => bar.indicatorsObserved)
    // A prepared price window owns the requested cursor even while its missing
    // indicators or price slots recover. Never freeze navigation on an unrelated
    // older window; unavailable samples remain explicit gaps in the new frame.
    const presented = ready
      ?? (previous?.instId === target.instId && previous.timeframe === target.timeframe ? previous : null)
    const priceSource = this.priceSource?.target === targetKey(target) ? this.priceSource : null
    const priceStatus = priceSource ? priceSource.status : ready?.priceStatus
    this.publish({
      requested: target,
      presented,
      pending: ready === null || Boolean(calculating),
      error: priceStatus?.state === 'error' ? `Price history failed: ${priceStatus.error || 'Source request failed'}${priceStatus.retryAt ? ` · retry at ${new Date(priceStatus.retryAt).toISOString()}` : ''}`
        : priceSource || ready || requested !== this.view.requested || target !== requested ? '' : this.view.error,
      oldestHour: meta?.oldestHour ?? null,
      latestEnd,
      historyExhausted: meta?.historyExhausted ?? false,
    })
    return ready !== null && !calculating
  }

  private async pump() {
    if (!this.active || !this.view.requested) return
    const target = this.view.requested
    const key = seriesKey(target)
    if (target.end === null) {
      if (this.localCheckedKey !== targetKey(target) && !this.localTargets.has(key) && this.localTargets.size < 2) void this.hydrateLocal(target)
      return
    }
    if (!this.transport.history) return
    const watermark = this.historyWatermark(target)
    const checkedKey = `${targetKey(target)}:${watermark}:${this.focusId}`
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    if (this.historyAttempts.get(key) === checkedKey || ready && this.historyHydrated.get(key) === watermark) return
    // Durable reads are bounded separately from demand. One old selection
    // cannot hold a new series or distant cursor behind disk IPC.
    const requestKey = targetKey(target)
    if (!this.historyTargets.has(requestKey) && this.historyTargets.size < 2) void this.hydrateHistory(target, checkedKey, watermark)
  }

  private async hydrateLocal(target: ChartTarget) {
    const focusId = this.focusId
    const key = seriesKey(target)
    this.localTargets.add(key)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.local(target.instId, target.timeframe)
      if (response) {
        const sourceChanged = (this.notificationVersions.get(seriesKey(response)) ?? 0) <= admittedAt && this.retainPriceSource(response, focusId)
        const accepted = this.admitDrawable(response) && Boolean(response.bars.length || response.liveBar) && this.store.ingestLatest(this.preservePushedLive(response, admittedAt))
        if (accepted || sourceChanged) this.preparedChanged(response, !accepted)
      }
    } catch (cause) {
      if (this.active && focusId === this.focusId) this.publish({ ...this.view, error: cause instanceof Error ? cause.message : 'Could not read local chart data.' })
    }
    finally {
      this.localTargets.delete(key)
      if (focusId === this.focusId) this.localCheckedKey = targetKey(target)
      void this.pump()
    }
  }

  private historyWatermark(target: ChartTarget) {
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    return `${meta?.generation ?? -1}:${JSON.stringify(meta?.sourceVersions ?? meta?.revision ?? -1)}:${meta?.latestEnd ?? -1}:${this.store.historyEpoch(target.instId, target.timeframe)}:${meta?.indicatorStatus?.inputVersion ?? ''}:${meta?.indicatorStatus?.state ?? ''}`
  }

  private async hydrateHistory(target: ChartTarget, checkedKey: string, watermark: string) {
    const focusId = this.focusId
    const key = seriesKey(target)
    const requestKey = targetKey(target)
    this.historyTargets.add(requestKey)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.history!(target, focusId)
      if (response) {
        if ((this.notificationVersions.get(seriesKey(response)) ?? 0) <= admittedAt) this.retainPriceSource(response, focusId)
        const accepted = this.admitDrawable(response) && Boolean(response.bars.length || response.liveBar) && this.store.ingest(this.preservePushedLive(response, admittedAt))
        const meta = this.store.snapshotMeta(target.instId, target.timeframe)
        // A newer compact notification can arrive while this bulk read is in
        // flight. Its revision must not certify older historical observations.
        if (accepted && focusId === this.focusId) this.historyHydrated.set(key, `${response.generation}:${JSON.stringify(response.sourceVersions ?? response.revision)}:${meta?.latestEnd ?? -1}:${this.store.historyEpoch(target.instId, target.timeframe)}:${meta?.indicatorStatus?.inputVersion ?? ''}:${meta?.indicatorStatus?.state ?? ''}`)
        if (this.active) this.commit()
      } else if (focusId === this.focusId) this.historyHydrated.set(key, watermark)
      if (focusId === this.focusId) this.historyAttempts.set(key, checkedKey)
    } catch {
      // Failed reads wait for changed input or a new viewport. Backend source
      // repair proceeds independently and publishes its own lifecycle.
      if (focusId === this.focusId) this.historyAttempts.set(key, checkedKey)
    } finally {
      this.historyTargets.delete(requestKey)
      void this.pump()
    }
  }

}

export const chartController = new ChartController({
  focus: (target, id) => window.radarDesktop.request({ chartFocus: { id, target: target ? { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } : null } }),
  local: (instId, timeframe) => window.radarDesktop.request({ chartLocal: { instId, timeframe } }),
  history: (target, focusId) => window.radarDesktop.request({ chartHistory: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined, focusId } }),
  universe: () => window.radarDesktop.request({ chartUniverse: {} }),
})
