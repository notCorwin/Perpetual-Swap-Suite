import { PreparedChartStore } from './chart-series-store.ts'
import { completeChartPriceRange } from './chart-data.ts'
import type { PreparedChartNotification, PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
import { timeframeMilliseconds, type RadarTimeframe } from './timeframe.ts'

export type ChartTarget = { instId: string; timeframe: RadarTimeframe; end: number | null }
export type ChartPreparation = ChartTarget & { historyBars?: number }
export type ChartView = {
  requested: ChartTarget | null
  presented: ReadyChartWindow | null
  pending: boolean
  error: string
  oldestHour: number | null
  latestEnd: number | null
  historyExhausted: boolean
  unavailable: PreparedChartResponse['unavailable'] | null
}
export type ChartTransport = {
  focus?: (target: ChartTarget | null, id: string) => Promise<unknown> | void
  prepare: (target: ChartPreparation, focusId?: string) => Promise<PreparedChartResponse>
  local: (instId: string, timeframe: RadarTimeframe, focusId?: string) => Promise<PreparedChartResponse | null>
  history?: (target: ChartTarget, focusId?: string) => Promise<PreparedChartResponse | null>
  universe: (instIds: string[], timeframe: RadarTimeframe, focusInstId?: string) => Promise<{ frames: PreparedChartResponse[] }>
}
const targetKey = (target: ChartTarget) => `${target.timeframe}:${target.instId}:${target.end ?? 'latest'}`
const sameSeries = (left: ChartTarget, right: ChartTarget) => left.instId === right.instId && left.timeframe === right.timeframe
const seriesKey = (target: Pick<ChartTarget, 'instId' | 'timeframe'>) => `${target.timeframe}:${target.instId}`
// The backend retains 1,536 candles, including 256 newer than its cursor.
const HISTORY_RESERVE = 1_280

/** Local navigation never waits for provider work. Each remote lane keeps only the latest intent. */
export class ChartController {
  readonly store: PreparedChartStore
  private transport: ChartTransport
  private listeners = new Set<() => void>()
  private view: ChartView = { requested: null, presented: null, pending: false, error: '', oldestHour: null, latestEnd: null, historyExhausted: false, unavailable: null }
  private owner = 0
  private focusVersion = 0
  private readonly identity = crypto.randomUUID()
  private focusId = ''
  private active = false
  private demandTargets = new Set<string>()
  private maintenanceTarget: ChartPreparation | null = null
  private localTargets = new Set<string>()
  private localCheckedKey: string | null = null
  private historyTargets = new Set<string>()
  private historyAttempts = new Map<string, { key: string; state: 'succeeded' | 'failed' }>()
  private historyHydrated = new Map<string, string>()
  private universeIds: string[] = []
  private universeKey = ''
  private universeRequest = 0
  private universeTask: Promise<void> = Promise.resolve()
  private notificationVersion = 0
  private notificationVersions = new Map<string, number>()
  private refresh = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private prefetchAfter = 0
  private preparationFailures = new Map<string, { target: ChartTarget; basis: string; retryAt?: number }>()
  private direction = -1
  private scrollAt = 0
  private scrollSpeed = 0
  private preparationMS = 3_000

  constructor(transport: ChartTransport, store = new PreparedChartStore()) {
    this.transport = transport
    this.store = store
  }

  getSnapshot = () => this.view
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  setUniverse(instIds: readonly string[], timeframe: RadarTimeframe, focusInstId?: string) {
    const ids = [...new Set(instIds.filter(Boolean))]
    const key = JSON.stringify([timeframe, ids.toSorted()])
    this.universeIds = ids
    const focus = focusInstId ?? (this.view.requested?.timeframe === timeframe ? this.view.requested.instId : undefined)
    this.store.setUniverse(ids, timeframe, focus)
    if (key === this.universeKey) return this.universeTask
    this.universeKey = key
    const request = ++this.universeRequest
    const admittedAt = this.notificationVersion
    this.universeTask = this.transport.universe(ids, timeframe, focus).then(({ frames }) => {
      if (request !== this.universeRequest) return
      for (const frame of frames) this.store.ingestLatest(this.preservePushedLive(frame, admittedAt))
      if (this.active) { this.commit(); void this.pump() }
    }).catch(() => { if (request === this.universeRequest) this.universeKey = '' })
    return this.universeTask
  }

  ingestPrepared(response: PreparedChartNotification) {
    if ('type' in response) {
      if (!this.store.ingestLive(response)) return
    } else if (!(response.endHour !== response.latestEnd ? this.store.ingest(response) : this.store.ingestLatest(response))) return
    this.notificationVersions.set(seriesKey(response), ++this.notificationVersion)
    const live = 'type' in response
    this.preparedChanged(response, live)
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
      if (this.commit()) {
        this.refresh = false
        this.clearTimer()
      }
      if (!live) void this.pump()
    }
  }

  open(instId: string, timeframe: RadarTimeframe, end: number | null = null) {
    const owner = ++this.owner
    this.active = true
    this.refresh = false
    this.scrollAt = 0
    this.scrollSpeed = 0
    this.direction = -1
    this.prefetchAfter = 0
    this.clearTimer()
    this.store.setUniverse(this.universeIds, timeframe, instId)
    this.publish({ ...this.view, unavailable: null })
    this.setTarget({ instId, timeframe, end }, true)
    return () => {
      if (owner !== this.owner) return
      this.active = false
      this.clearTimer()
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
    const now = performance.now()
    const direction = Math.sign(steps)
    const elapsed = this.scrollAt ? now - this.scrollAt : Infinity
    const speed = Math.abs(Math.trunc(steps)) / Math.max(16, Math.min(200, elapsed))
    this.scrollSpeed = direction !== this.direction || elapsed > 500 ? speed : Math.max(speed, this.scrollSpeed * .8 + speed * .2)
    this.scrollAt = now
    this.direction = direction
    this.setTarget({ ...target, end: end >= latest ? null : end })
  }

  private updateFocus(target: ChartTarget | null) {
    this.focusId = `${this.identity}:${++this.focusVersion}`
    this.preparationFailures.clear()
    void Promise.resolve(this.transport.focus?.(target, this.focusId)).catch(() => {})
  }

  private setTarget(target: ChartTarget, forceFocus = false) {
    if (!forceFocus && this.view.requested && targetKey(this.view.requested) === targetKey(target)) {
      this.commit()
      void this.pump()
      return
    }
    this.clearTimer()
    this.localCheckedKey = null
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
    // Initial prices stay independent of optional sources. Moving an already
    // calculated chart in either direction switches curves and prices together.
    const presented = calculating ? previous : ready
      ?? (previous?.instId === target.instId && previous.timeframe === target.timeframe ? previous : null)
    this.publish({
      requested: target,
      presented,
      pending: ready === null || Boolean(calculating),
      error: ready?.priceStatus?.state === 'error' ? `Price history failed: ${ready.priceStatus.error || 'Source request failed'}${ready.priceStatus.retryAt ? ` · retry at ${new Date(ready.priceStatus.retryAt).toISOString()}` : ''}`
        : ready || requested !== this.view.requested ? '' : this.view.error,
      oldestHour: meta?.oldestHour ?? null,
      latestEnd,
      historyExhausted: meta?.historyExhausted ?? false,
      unavailable: ready || requested !== this.view.requested ? null : this.view.unavailable,
    })
    return ready !== null && !calculating
  }

  private prefetchTarget(target: ChartTarget): ChartPreparation | null {
    if (Date.now() < this.prefetchAfter) return null
    const window = this.store.window(target.instId, target.timeframe, target.end)
    // A cold viewport can display prices before its recursive calculation
    // finishes. Moving the backend reserve cursor now could evict those rows
    // before the pending calculation installs their indicators.
    if (!window || window.indicatorState === 'loading' || window.indicatorState === 'error') return null
    const interval = timeframeMilliseconds(target.timeframe)
    const range = this.store.readyBoundaries(target.instId, target.timeframe).find(range => range.firstEnd <= window.endHour && range.lastEnd >= window.endHour)
    if (!range) return null
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    const earliest = meta?.historyExhausted && meta.oldestHour !== null ? meta.oldestHour : 95 * interval
    // Reserve enough resident candles for two observed preparation times. Start
    // with a conservative network budget before the first response is measured.
    const speed = performance.now() - this.scrollAt <= 500 ? this.scrollSpeed : 0
    const runway = Math.min(3_072, Math.max(384, Math.ceil(speed * Math.max(3_000, this.preparationMS * 2))))
    const batch = Math.min(HISTORY_RESERVE - 95, Math.max(768, runway * 2))
    for (const direction of [this.direction, -this.direction]) {
      const distance = direction < 0 ? window.endHour - range.firstEnd : range.lastEnd - window.endHour
      if (distance > runway * interval) continue
      const end = direction < 0 ? range.firstEnd - interval : Math.min(meta?.latestEnd ?? window.endHour, range.lastEnd + batch * interval)
      if (end < earliest || end > (meta?.latestEnd ?? window.endHour)) continue
      const existing = this.store.window(target.instId, target.timeframe, end)
      if (existing && this.completePrices(existing)) continue
      const job = { ...target, end, historyBars: direction < 0 ? batch + 95 : (end - range.lastEnd) / interval + 95 }
      if (this.blockedPreparation(job)) continue
      return job
    }
    return null
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private wake(delay: number, retryTarget = false) {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.active) return
      this.refresh = retryTarget
      void this.pump()
    }, delay)
  }

  private async pump() {
    if (!this.active || !this.view.requested) return
    if (this.view.unavailable && this.view.unavailable.retryAt > Date.now()) {
      if (this.timer === null) this.wake(this.view.unavailable.retryAt - Date.now(), true)
      return
    }
    const target = this.view.requested
    const key = seriesKey(target)
    const window = this.store.window(target.instId, target.timeframe, target.end)
    // A resident end candle does not prove the preceding viewport exists.
    // Missing prices still need source repair while calculated prices can wait
    // independently for their indicator worker.
    const ready = window && this.completePrices(window) ? window : null
    if (target.end === null && this.localCheckedKey !== targetKey(target)) {
      if (!this.localTargets.has(key) && this.localTargets.size < 2) void this.hydrateLocal(target)
      if (!ready) return
    }
    // Focused durable history has its own lane. A slow provider request must
    // never prevent an already saved range from entering the renderer cache.
    const watermark = this.historyWatermark(target)
    const historyKey = `${targetKey(target)}:${watermark}:${this.focusId}`
    if (this.transport.history && (!ready || target.end !== null)) {
      const attempted = this.historyAttempts.get(key)?.key === historyKey
      const needsHistory = !attempted && (this.historyHydrated.get(key) !== watermark || !ready)
      if (needsHistory) {
        // Bound local work while allowing a newly selected series to bypass
        // one older read. Further selections coalesce in view.requested.
        if (!this.historyTargets.has(key) && this.historyTargets.size < 2) void this.hydrateHistory(target, historyKey, watermark)
      }
      // Give the first durable read at this revision a chance to satisfy the
      // request. Later moving cursors may read locally alongside source work:
      // requiring an exact cursor miss after every read would defer downloads
      // until input stopped changing the target.
      if ((needsHistory || this.historyTargets.has(key)) && (ready || this.historyHydrated.get(key) !== watermark)) return
    }
    if (this.blockedPreparation(target)) return
    if (!ready || this.refresh) {
      if (this.demandTargets.has(key) || this.demandTargets.size >= 2) return
      const maintenance = this.maintenanceTarget
      // Share a page already covering this cursor. A jump beyond it gets its
      // own bounded foreground lane instead of waiting for an obsolete page.
      if (maintenance && sameSeries(maintenance, target) && maintenance.end !== null && target.end !== null
        && target.end <= maintenance.end && target.end >= maintenance.end - ((maintenance.historyBars ?? 96) - 96) * timeframeMilliseconds(target.timeframe)) return
      // One slow previous selection cannot hold the current contract behind
      // its provider response. Further selections retain only the latest intent.
      this.demandTargets.add(key)
      this.refresh = false
      void this.run(target, ready ? 'refresh' : 'target')
      return
    }
    if (ready && this.view.pending) return
    const job = target.end === null || this.maintenanceTarget || this.demandTargets.has(key) ? null : this.prefetchTarget(target)
    if (job) { this.maintenanceTarget = job; void this.run(job, 'prefetch') }
    const cooldown = this.prefetchAfter - Date.now()
    if (cooldown > 0 && this.timer === null) this.wake(cooldown)
  }

  private async hydrateLocal(target: ChartTarget) {
    const focusId = this.focusId
    const key = seriesKey(target)
    this.localTargets.add(key)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.local(target.instId, target.timeframe, focusId)
      if (response && this.store.ingestLatest(this.preservePushedLive(response, admittedAt))) this.preparedChanged(response)
    } catch { /* A local miss still has the independent foreground preparation lane. */ }
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

  private preparationBasis(target: ChartTarget) { return `${this.focusId}:${this.historyWatermark(target)}` }

  private blockedPreparation(target: ChartTarget) {
    // Each target retains its own failure. An opposite reserve cannot erase it
    // and make the two directions retry one another without a new input basis.
    // A fixed focus has only the selected end and bounded reserve endpoints;
    // focus changes clear the set, while watermark/eviction changes retire it.
    for (const [key, failure] of this.preparationFailures) if (failure.basis !== this.preparationBasis(failure.target)) this.preparationFailures.delete(key)
    const failure = this.preparationFailures.get(targetKey(target))
    if (!failure) return false
    if (failure.retryAt !== undefined && failure.retryAt <= Date.now()) return false
    if (failure.retryAt !== undefined && this.timer === null) this.wake(failure.retryAt - Date.now(), this.view.requested !== null && targetKey(target) === targetKey(this.view.requested))
    return true
  }

  private async hydrateHistory(target: ChartTarget, checkedKey: string, watermark: string) {
    const focusId = this.focusId
    const key = seriesKey(target)
    this.historyTargets.add(key)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.history!(target, focusId)
      if (response) {
        const accepted = this.store.ingest(this.preservePushedLive(response, admittedAt))
        const meta = this.store.snapshotMeta(target.instId, target.timeframe)
        // A newer compact notification can arrive while this bulk read is in
        // flight. Its revision must not certify older historical observations.
        if (accepted) this.historyHydrated.set(key, `${response.generation}:${JSON.stringify(response.sourceVersions ?? response.revision)}:${meta?.latestEnd ?? -1}:${this.store.historyEpoch(target.instId, target.timeframe)}:${meta?.indicatorStatus?.inputVersion ?? ''}:${meta?.indicatorStatus?.state ?? ''}`)
        if (this.active) this.commit()
      } else this.historyHydrated.set(key, watermark)
      this.historyAttempts.set(key, { key: checkedKey, state: 'succeeded' })
    } catch {
      // A failed local read cannot hold the independent source repair lane.
      // It also cannot certify hydration or retry from its own finalizer.
      this.historyAttempts.set(key, { key: checkedKey, state: 'failed' })
    } finally {
      this.historyTargets.delete(key)
      void this.pump()
    }
  }

  private async run(job: ChartPreparation, kind: 'target' | 'refresh' | 'prefetch') {
    const focusId = this.focusId
    let failed = false
    let unavailableRetryAt: number | null = null
    const startedAt = performance.now()
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.prepare(job, focusId)
      const elapsed = performance.now() - startedAt
      this.preparationMS = Math.max(elapsed, this.preparationMS * .75 + elapsed * .25)
      if (response.error && response.priceStatus?.state !== 'error') throw new Error(response.error)
      if (response.unavailable) {
        if (this.active && focusId === this.focusId && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
          this.publish({ ...this.view, pending: false, error: '', unavailable: response.unavailable })
          unavailableRetryAt = response.unavailable.retryAt
        } else if (kind === 'prefetch' && focusId === this.focusId) this.prefetchAfter = response.unavailable.retryAt
      } else {
        const accepted = this.store.ingest(this.preservePushedLive(response, admittedAt))
        if (accepted && job.end !== null) {
          // Historical responses already carry the bounded durable navigation
          // range. Do not immediately serialize the same bulk history again.
          this.historyHydrated.set(seriesKey(job), this.historyWatermark(job))
        } else if (accepted && kind !== 'refresh') this.historyHydrated.delete(seriesKey(job))
        const prepared = this.store.window(job.instId, job.timeframe, job.end)
        if (this.active) this.commit()
        if (accepted && !prepared) throw new Error('No local prices are available for this range yet.')
        if (focusId === this.focusId) {
          if (accepted && prepared && !this.completePrices(prepared)) this.preparationFailures.set(targetKey(job), { target: job, basis: this.preparationBasis(job) })
          else this.preparationFailures.delete(targetKey(job))
        }
      }
    } catch (cause) {
      failed = true
      const retryAt = cause && typeof cause === 'object' && 'retryAt' in cause && typeof cause.retryAt === 'number' && cause.retryAt > Date.now() ? cause.retryAt : undefined
      if (focusId === this.focusId) this.preparationFailures.set(targetKey(job), { target: job, basis: this.preparationBasis(job), retryAt })
      if (kind !== 'prefetch' && this.active && focusId === this.focusId && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
        const complete = this.commit()
        this.publish({ ...this.view, pending: !complete, error: cause instanceof Error ? cause.message : 'Could not prepare chart history.' })
      }
    } finally {
      if (kind === 'prefetch') this.maintenanceTarget = null
      else this.demandTargets.delete(seriesKey(job))
    }
    if (!this.active) return
    const changed = focusId !== this.focusId || this.view.requested && targetKey(this.view.requested) !== targetKey(job)
    if (unavailableRetryAt !== null && !changed) this.wake(Math.max(0, unavailableRetryAt - Date.now()), true)
    else if (failed && !changed) { this.blockedPreparation(job) }
    else queueMicrotask(() => { void this.pump() })
  }
}

export const chartController = new ChartController({
  focus: (target, id) => window.radarDesktop.request({ chartFocus: { id, target: target ? { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } : null } }),
  prepare: (target, focusId) => window.radarDesktop.request({ chartWindow: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined, historyBars: target.historyBars, focusId } }),
  local: (instId, timeframe, focusId) => window.radarDesktop.request({ chartLocal: { instId, timeframe, focusId } }),
  history: (target, focusId) => window.radarDesktop.request({ chartHistory: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined, focusId } }),
  universe: (instIds, timeframe, focusInstId) => window.radarDesktop.request({ chartUniverse: { instIds, timeframe, focusInstId } }),
})
