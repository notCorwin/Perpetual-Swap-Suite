import { PreparedChartStore } from './chart-series-store.ts'
import type { PreparedChartResponse, ReadyChartWindow } from './chart-data.ts'
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
  unavailable: PreparedChartResponse['unavailable'] | null
}
export type ChartTransport = {
  prepare: (target: ChartTarget) => Promise<PreparedChartResponse>
  local: (instId: string, timeframe: RadarTimeframe) => Promise<PreparedChartResponse | null>
  universe: (instIds: string[], timeframe: RadarTimeframe, focusInstId?: string) => Promise<{ frames: PreparedChartResponse[] }>
}
const targetKey = (target: ChartTarget) => `${target.timeframe}:${target.instId}:${target.end ?? 'latest'}`
const sameSeries = (left: ChartTarget, right: ChartTarget) => left.instId === right.instId && left.timeframe === right.timeframe

/** Local navigation never waits for provider work. Each remote lane keeps only the latest intent. */
export class ChartController {
  readonly store: PreparedChartStore
  private transport: ChartTransport
  private listeners = new Set<() => void>()
  private view: ChartView = { requested: null, presented: null, pending: false, error: '', oldestHour: null, latestEnd: null, historyExhausted: false, unavailable: null }
  private owner = 0
  private active = false
  private demandTarget: ChartTarget | null = null
  private maintenanceTarget: ChartTarget | null = null
  private localWorking = false
  private localCheckedKey: string | null = null
  private universeIds: string[] = []
  private universeTimeframe: RadarTimeframe = '1H'
  private universeKey = ''
  private refresh = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private prefetchAfter = 0
  private failureCount = 0
  private retryAt = 0
  private direction = -1

  constructor(transport: ChartTransport, store = new PreparedChartStore()) {
    this.transport = transport
    this.store = store
  }

  getSnapshot = () => this.view
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  setUniverse(instIds: readonly string[], timeframe: RadarTimeframe, focusInstId?: string) {
    const ids = [...new Set(instIds.filter(Boolean))]
    const key = JSON.stringify([timeframe, ...ids.toSorted()])
    this.universeIds = ids
    this.universeTimeframe = timeframe
    const focus = focusInstId ?? (this.view.requested?.timeframe === timeframe ? this.view.requested.instId : undefined)
    this.store.setUniverse(ids, timeframe, focus)
    if (key === this.universeKey) return
    this.universeKey = key
    void this.transport.universe(ids, timeframe, focus).then(({ frames }) => {
      for (const frame of frames) this.store.ingestLatest(frame)
      if (this.active) { this.commit(); void this.pump() }
    }).catch(() => {})
  }

  ingestPrepared(response: PreparedChartResponse) {
    if (!this.store.ingestLatest(response)) return
    const target = this.view.requested
    if (this.active && target?.instId === response.instId && target.timeframe === response.timeframe) {
      this.commit()
      void this.pump()
    }
  }

  open(instId: string, timeframe: RadarTimeframe) {
    const owner = ++this.owner
    this.active = true
    this.refresh = false
    this.failureCount = 0
    this.retryAt = 0
    this.clearTimer()
    this.store.setUniverse(this.universeTimeframe === timeframe ? this.universeIds : [], timeframe, instId)
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
    const floor = meta?.historyExhausted && meta.oldestHour !== null ? Math.min(latest, meta.oldestHour + 95 * interval) : 95 * interval
    const end = Math.max(floor, Math.min(latest, (target.end ?? latest) + Math.trunc(steps) * interval))
    this.direction = Math.sign(steps)
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
    this.publish({ ...this.view, requested: target, pending: true, error: '', unavailable: null })
    this.commit()
    void this.pump()
  }

  private publish(next: ChartView) {
    if (Object.keys(next).every(key => next[key as keyof ChartView] === this.view[key as keyof ChartView])) return
    this.view = next
    for (const listener of this.listeners) listener()
  }

  private commit() {
    const requested = this.view.requested
    if (!requested) return false
    const meta = this.store.snapshotMeta(requested.instId, requested.timeframe)
    let target = requested
    if (target.end !== null && meta?.historyExhausted && meta.oldestHour !== null && meta.latestEnd !== null) {
      const floor = Math.min(meta.latestEnd, meta.oldestHour + 95 * timeframeMilliseconds(target.timeframe))
      if (target.end < floor) target = { ...target, end: floor }
    }
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    this.publish({
      requested: target,
      presented: ready ?? this.view.presented,
      pending: ready === null,
      error: ready ? '' : this.view.error,
      oldestHour: meta?.oldestHour ?? null,
      latestEnd: meta?.latestEnd ?? null,
      historyExhausted: meta?.historyExhausted ?? false,
      unavailable: ready ? null : this.view.unavailable,
    })
    return ready !== null
  }

  private prefetchTarget(target: ChartTarget): ChartTarget | null {
    if (Date.now() < this.prefetchAfter) return null
    const window = this.store.window(target.instId, target.timeframe, target.end)
    if (!window) return null
    const interval = timeframeMilliseconds(target.timeframe)
    const range = this.store.readyBoundaries(target.instId, target.timeframe).find(range => range.firstEnd <= window.endHour && range.lastEnd >= window.endHour)
    if (!range) return null
    const meta = this.store.snapshotMeta(target.instId, target.timeframe)
    const earliest = meta?.historyExhausted && meta.oldestHour !== null ? meta.oldestHour + 95 * interval : 95 * interval
    const candidates = this.direction > 0 ? [range.lastEnd + 96 * interval, range.firstEnd - 96 * interval] : [range.firstEnd - 96 * interval, range.lastEnd + 96 * interval]
    for (const end of candidates) {
      if (end < earliest || end > (meta?.latestEnd ?? window.endHour) || Math.abs(end - window.endHour) > 700 * interval) continue
      const next = { ...target, end }
      if (this.store.window(next.instId, next.timeframe, end)) continue
      return next
    }
    return null
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private wake(delay: number) {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.active) return
      this.refresh = true
      void this.pump()
    }, delay)
  }

  private async pump() {
    if (!this.active || !this.view.requested) return
    if (this.view.unavailable && this.view.unavailable.retryAt > Date.now()) {
      if (this.timer === null) this.wake(this.view.unavailable.retryAt - Date.now())
      return
    }
    const target = this.view.requested
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    if (!ready && target.end === null && this.localCheckedKey !== targetKey(target)) {
      if (!this.localWorking) void this.hydrateLocal(target)
      return
    }
    if (this.retryAt > Date.now()) { this.wake(this.retryAt - Date.now()); return }
    if (!ready || this.refresh) {
      if (this.demandTarget || this.maintenanceTarget && sameSeries(this.maintenanceTarget, target)) return
      this.demandTarget = target
      this.refresh = false
      void this.run(target, ready ? 'refresh' : 'target')
      return
    }
    const job = this.maintenanceTarget || this.demandTarget && sameSeries(this.demandTarget, target) ? null : this.prefetchTarget(target)
    if (job) { this.maintenanceTarget = job; void this.run(job, 'prefetch') }
    const cooldown = this.prefetchAfter - Date.now()
    if (this.timer === null) this.wake(cooldown > 0 ? Math.min(2_000, cooldown) : 2_000)
  }

  private async hydrateLocal(target: ChartTarget) {
    this.localWorking = true
    try {
      const response = await this.transport.local(target.instId, target.timeframe)
      if (response) this.ingestPrepared(response)
    } catch { /* A local miss still has the independent foreground preparation lane. */ }
    finally {
      this.localWorking = false
      if (this.view.requested && targetKey(this.view.requested) === targetKey(target)) this.localCheckedKey = targetKey(target)
      void this.pump()
    }
  }

  private async run(job: ChartTarget, kind: 'target' | 'refresh' | 'prefetch') {
    let failed = false
    let unavailableRetryAt: number | null = null
    try {
      const response = await this.transport.prepare(job)
      if (response.error) throw new Error(response.error)
      if (response.unavailable) {
        if (this.active && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
          this.publish({ ...this.view, pending: false, error: '', unavailable: response.unavailable })
          unavailableRetryAt = response.unavailable.retryAt
        } else if (kind === 'prefetch') this.prefetchAfter = Math.max(Date.now() + 5_000, response.unavailable.retryAt)
      } else {
        const accepted = this.store.ingest(response)
        const prepared = this.store.window(job.instId, job.timeframe, response.endHour)
        if (accepted && !prepared) throw new Error('The selected range does not yet contain 96 complete source candles.')
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
      else this.demandTarget = null
    }
    if (!this.active) return
    const changed = this.view.requested && targetKey(this.view.requested) !== targetKey(job)
    if (unavailableRetryAt !== null && !changed) this.wake(Math.max(0, unavailableRetryAt - Date.now()))
    else if (failed && !changed && kind !== 'prefetch') this.wake(Math.max(0, this.retryAt - Date.now()))
    else queueMicrotask(() => { void this.pump() })
  }
}

export const chartController = new ChartController({
  prepare: target => window.webkit.messageHandlers.radar.postMessage({ chartWindow: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined } }),
  local: (instId, timeframe) => window.webkit.messageHandlers.radar.postMessage({ chartLocal: { instId, timeframe } }),
  universe: (instIds, timeframe, focusInstId) => window.webkit.messageHandlers.radar.postMessage({ chartUniverse: { instIds, timeframe, focusInstId } }),
})
