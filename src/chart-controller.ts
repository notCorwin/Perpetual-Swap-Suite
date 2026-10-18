import { PreparedChartStore } from './chart-series-store.ts'
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
  prepare: (target: ChartPreparation) => Promise<PreparedChartResponse>
  local: (instId: string, timeframe: RadarTimeframe) => Promise<PreparedChartResponse | null>
  history?: (target: ChartTarget) => Promise<PreparedChartResponse | null>
  universe: (instIds: string[], timeframe: RadarTimeframe, focusInstId?: string) => Promise<{ frames: PreparedChartResponse[] }>
}
const targetKey = (target: ChartTarget) => `${target.timeframe}:${target.instId}:${target.end ?? 'latest'}`
const sameSeries = (left: ChartTarget, right: ChartTarget) => left.instId === right.instId && left.timeframe === right.timeframe
const seriesKey = (target: Pick<ChartTarget, 'instId' | 'timeframe'>) => `${target.timeframe}:${target.instId}`

/** Local navigation never waits for provider work. Each remote lane keeps only the latest intent. */
export class ChartController {
  readonly store: PreparedChartStore
  private transport: ChartTransport
  private listeners = new Set<() => void>()
  private view: ChartView = { requested: null, presented: null, pending: false, error: '', oldestHour: null, latestEnd: null, historyExhausted: false, unavailable: null }
  private owner = 0
  private active = false
  private demandTargets = new Set<string>()
  private maintenanceTarget: ChartPreparation | null = null
  private localTargets = new Set<string>()
  private localCheckedKey: string | null = null
  private historyTargets = new Set<string>()
  private historyChecked = new Map<string, string>()
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
  private failureCount = 0
  private retryAt = 0
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
    const key = JSON.stringify(ids.toSorted())
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
      ? { ...response, liveBar: latest.liveBar } : response
  }

  private preparedChanged(response: Pick<PreparedChartResponse, 'instId' | 'timeframe'>, live = false) {
    const target = this.view.requested
    if (this.active && target?.instId === response.instId && target.timeframe === response.timeframe) {
      if (this.commit()) {
        this.failureCount = 0
        this.retryAt = 0
        this.refresh = false
        this.clearTimer()
      }
      if (!live) void this.pump()
    }
  }

  open(instId: string, timeframe: RadarTimeframe) {
    const owner = ++this.owner
    this.active = true
    this.refresh = false
    this.failureCount = 0
    this.retryAt = 0
    this.scrollAt = 0
    this.scrollSpeed = 0
    this.direction = -1
    this.prefetchAfter = 0
    this.clearTimer()
    this.store.setUniverse(this.universeIds, timeframe, instId)
    this.publish({ ...this.view, unavailable: null })
    this.setTarget({ instId, timeframe, end: null })
    return () => {
      if (owner !== this.owner) return
      this.active = false
      this.clearTimer()
    }
  }

  scroll(steps: number) {
    const target = this.view.requested
    if (!this.active || !target || !Number.isFinite(steps) || !Math.trunc(steps)) return
    const latest = this.store.latestEnd(target.instId, target.timeframe)
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

  private setTarget(target: ChartTarget) {
    if (this.view.requested && targetKey(this.view.requested) === targetKey(target)) {
      this.commit()
      void this.pump()
      return
    }
    this.clearTimer()
    this.failureCount = 0
    this.retryAt = 0
    this.localCheckedKey = null
    this.commit(target)
    void this.pump()
  }

  private publish(next: ChartView) {
    if (Object.keys(next).every(key => next[key as keyof ChartView] === this.view[key as keyof ChartView])) return
    this.view = next
    for (const listener of this.listeners) listener()
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
    this.publish({
      requested: target,
      presented: ready ?? (this.view.presented?.instId === target.instId && this.view.presented.timeframe === target.timeframe ? this.view.presented : null),
      pending: ready === null,
      error: ready || requested !== this.view.requested ? '' : this.view.error,
      oldestHour: meta?.oldestHour ?? null,
      latestEnd: meta?.latestEnd ?? null,
      historyExhausted: meta?.historyExhausted ?? false,
      unavailable: ready || requested !== this.view.requested ? null : this.view.unavailable,
    })
    return ready !== null
  }

  private prefetchTarget(target: ChartTarget): ChartPreparation | null {
    if (Date.now() < this.prefetchAfter) return null
    const window = this.store.window(target.instId, target.timeframe, target.end)
    if (!window) return null
    const interval = timeframeMilliseconds(target.timeframe)
    const range = this.store.readyBoundaries(target.instId, target.timeframe).find(range => range.firstEnd <= window.endHour && range.lastEnd >= window.endHour)
    if (!range) return null
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    const earliest = meta?.historyExhausted && meta.oldestHour !== null ? meta.oldestHour : 95 * interval
    // Reserve enough resident candles for two observed preparation times. Start
    // with a conservative network budget before the first response is measured.
    const speed = performance.now() - this.scrollAt <= 500 ? this.scrollSpeed : 0
    const runway = Math.min(3_072, Math.max(384, Math.ceil(speed * Math.max(3_000, this.preparationMS * 2))))
    const batch = Math.min(4_000, Math.max(768, runway * 2))
    for (const direction of [this.direction, -this.direction]) {
      const distance = direction < 0 ? window.endHour - range.firstEnd : range.lastEnd - window.endHour
      if (distance > runway * interval) continue
      const end = direction < 0 ? range.firstEnd - interval : Math.min(meta?.latestEnd ?? window.endHour, range.lastEnd + batch * interval)
      if (end < earliest || end > (meta?.latestEnd ?? window.endHour) || this.store.window(target.instId, target.timeframe, end)) continue
      return { ...target, end, historyBars: direction < 0 ? Math.min(4_096, batch + 95) : Math.min(4_096, (end - range.lastEnd) / interval + 95) }
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
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    if (target.end === null && this.localCheckedKey !== targetKey(target)) {
      if (!this.localTargets.has(key) && this.localTargets.size < 2) void this.hydrateLocal(target)
      if (!ready) return
    }
    // Focused durable history has its own lane. A slow provider request must
    // never prevent an already saved range from entering the renderer cache.
    const watermark = this.historyWatermark(target)
    const historyKey = `${targetKey(target)}:${watermark}`
    if (this.transport.history && (!ready || target.end !== null)) {
      const needsHistory = this.historyHydrated.get(key) !== watermark
        || !ready && this.historyChecked.get(key) !== historyKey
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
    if (this.retryAt > Date.now()) { this.wake(this.retryAt - Date.now(), true); return }
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
    const job = target.end === null || this.maintenanceTarget || this.demandTargets.has(key) ? null : this.prefetchTarget(target)
    if (job) { this.maintenanceTarget = job; void this.run(job, 'prefetch') }
    const cooldown = this.prefetchAfter - Date.now()
    if (cooldown > 0 && this.timer === null) this.wake(cooldown)
  }

  private async hydrateLocal(target: ChartTarget) {
    const key = seriesKey(target)
    this.localTargets.add(key)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.local(target.instId, target.timeframe)
      if (response && this.store.ingestLatest(this.preservePushedLive(response, admittedAt))) this.preparedChanged(response)
    } catch { /* A local miss still has the independent foreground preparation lane. */ }
    finally {
      this.localTargets.delete(key)
      if (this.view.requested && targetKey(this.view.requested) === targetKey(target)) this.localCheckedKey = targetKey(target)
      void this.pump()
    }
  }

  private historyWatermark(target: ChartTarget) {
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    return `${meta?.generation ?? -1}:${JSON.stringify(meta?.sourceVersions ?? meta?.revision ?? -1)}:${meta?.latestEnd ?? -1}:${this.store.historyEpoch(target.instId, target.timeframe)}`
  }

  private async hydrateHistory(target: ChartTarget, checkedKey: string, watermark: string) {
    const key = seriesKey(target)
    this.historyTargets.add(key)
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.history!(target)
      if (response) {
        const accepted = this.store.ingest(this.preservePushedLive(response, admittedAt))
        const meta = this.store.snapshotMeta(target.instId, target.timeframe)
        // A newer compact notification can arrive while this bulk read is in
        // flight. Its revision must not certify older historical observations.
        if (accepted) this.historyHydrated.set(key, `${response.generation}:${JSON.stringify(response.sourceVersions ?? response.revision)}:${meta?.latestEnd ?? -1}:${this.store.historyEpoch(target.instId, target.timeframe)}`)
        if (this.active) this.commit()
      } else this.historyHydrated.set(key, watermark)
    } catch {
      // A failed local read cannot hold the independent source repair lane.
      this.historyHydrated.set(key, watermark)
    } finally {
      this.historyChecked.set(key, checkedKey)
      this.historyTargets.delete(key)
      void this.pump()
    }
  }

  private async run(job: ChartPreparation, kind: 'target' | 'refresh' | 'prefetch') {
    let failed = false
    let unavailableRetryAt: number | null = null
    const startedAt = performance.now()
    const admittedAt = this.notificationVersion
    try {
      const response = await this.transport.prepare(job)
      const elapsed = performance.now() - startedAt
      this.preparationMS = Math.max(elapsed, this.preparationMS * .75 + elapsed * .25)
      if (response.error) throw new Error(response.error)
      if (response.unavailable) {
        if (this.active && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
          this.publish({ ...this.view, pending: false, error: '', unavailable: response.unavailable })
          unavailableRetryAt = response.unavailable.retryAt
        } else if (kind === 'prefetch') this.prefetchAfter = Math.max(Date.now() + 5_000, response.unavailable.retryAt)
      } else {
        const accepted = this.store.ingest(this.preservePushedLive(response, admittedAt))
        if (accepted && job.end !== null) {
          // Historical responses already carry the bounded durable navigation
          // range. Do not immediately serialize the same bulk history again.
          this.historyHydrated.set(seriesKey(job), this.historyWatermark(job))
        } else if (accepted && kind !== 'refresh') this.historyHydrated.delete(seriesKey(job))
        const prepared = this.store.window(job.instId, job.timeframe, response.endHour)
        if (accepted && !prepared) throw new Error('No local prices are available for this range yet.')
        if (this.active) this.commit()
      }
      if (this.view.requested && targetKey(this.view.requested) === targetKey(job)) { this.failureCount = 0; this.retryAt = 0 }
    } catch (cause) {
      failed = true
      if (kind === 'prefetch') this.prefetchAfter = Date.now() + 5_000
      else if (this.active && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
        this.failureCount += 1
        this.retryAt = Date.now() + Math.min(10_000, 500 * 2 ** Math.min(this.failureCount, 4))
        const complete = this.commit()
        this.publish({ ...this.view, pending: !complete, error: cause instanceof Error ? cause.message : 'Could not prepare chart history.' })
      }
    } finally {
      if (kind === 'prefetch') this.maintenanceTarget = null
      else this.demandTargets.delete(seriesKey(job))
    }
    if (!this.active) return
    const changed = this.view.requested && targetKey(this.view.requested) !== targetKey(job)
    if (unavailableRetryAt !== null && !changed) this.wake(Math.max(0, unavailableRetryAt - Date.now()), true)
    else if (failed && !changed && kind !== 'prefetch') this.wake(Math.max(0, this.retryAt - Date.now()), true)
    else queueMicrotask(() => { void this.pump() })
  }
}

export const chartController = new ChartController({
  prepare: target => window.radarDesktop.request({ chartWindow: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined, historyBars: target.historyBars } }),
  local: (instId, timeframe) => window.radarDesktop.request({ chartLocal: { instId, timeframe } }),
  history: target => window.radarDesktop.request({ chartHistory: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } }),
  universe: (instIds, timeframe, focusInstId) => window.radarDesktop.request({ chartUniverse: { instIds, timeframe, focusInstId } }),
})
