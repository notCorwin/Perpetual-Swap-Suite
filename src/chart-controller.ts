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
type Transport = (target: ChartTarget) => Promise<PreparedChartResponse>
const targetKey = (target: ChartTarget) => `${target.timeframe}:${target.instId}:${target.end ?? 'latest'}`

/** One requested cursor, one immutable painted window, and one data job. */
export class ChartController {
  readonly store: PreparedChartStore
  private transport: Transport
  private listeners = new Set<() => void>()
  private view: ChartView = { requested: null, presented: null, pending: false, error: '', oldestHour: null, latestEnd: null, historyExhausted: false, unavailable: null }
  private owner = 0
  private active = false
  private working = false
  private refresh = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private prefetchAfter = 0
  private failureCount = 0
  private direction = -1

  constructor(transport: Transport, store = new PreparedChartStore()) {
    this.transport = transport
    this.store = store
  }

  getSnapshot = () => this.view
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  open(instId: string, timeframe: RadarTimeframe) {
    const owner = ++this.owner
    this.active = true
    this.refresh = false
    this.failureCount = 0
    this.clearTimer()
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
    if (!this.active || this.working || !this.view.requested) return
    if (this.view.unavailable && this.view.unavailable.retryAt > Date.now()) {
      if (this.timer === null) this.wake(this.view.unavailable.retryAt - Date.now())
      return
    }
    const target = this.view.requested
    const ready = this.store.window(target.instId, target.timeframe, target.end)
    const kind = !ready ? 'target' : this.refresh ? 'refresh' : 'prefetch'
    const job = kind === 'prefetch' ? this.prefetchTarget(target) : target
    if (!job) {
      const cooldown = this.prefetchAfter - Date.now()
      this.wake(cooldown > 0 ? Math.min(2_000, cooldown) : 2_000)
      return
    }
    this.working = true
    this.refresh = false
    let failed = false
    let unavailableRetryAt: number | null = null
    try {
      const response = await this.transport(job)
      if (response.error) throw new Error(response.error)
      if (response.unavailable) {
        if (this.active && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
          this.publish({ ...this.view, pending: false, error: '', unavailable: response.unavailable })
          unavailableRetryAt = response.unavailable.retryAt
        } else if (kind === 'prefetch') this.prefetchAfter = Math.max(Date.now() + 5_000, response.unavailable.retryAt)
      } else {
        this.store.ingest(response)
        const prepared = this.store.window(job.instId, job.timeframe, response.endHour)
        if (!prepared) throw new Error('The selected range does not yet contain 96 complete source candles.')
        if (this.active) this.commit()
      }
      this.failureCount = 0
    } catch (cause) {
      failed = true
      if (kind === 'prefetch') this.prefetchAfter = Date.now() + 5_000
      else if (this.active && this.view.requested && targetKey(this.view.requested) === targetKey(job)) {
        this.failureCount += 1
        const complete = this.commit()
        this.publish({ ...this.view, pending: !complete, error: cause instanceof Error ? cause.message : 'Could not prepare chart history.' })
      }
    } finally {
      this.working = false
    }
    if (!this.active) return
    const changed = this.view.requested && targetKey(this.view.requested) !== targetKey(target)
    if (unavailableRetryAt !== null && !changed) this.wake(Math.max(0, unavailableRetryAt - Date.now()))
    else if (failed && !changed) this.wake(Math.min(10_000, 500 * 2 ** Math.min(this.failureCount, 4)))
    else queueMicrotask(() => { void this.pump() })
  }
}

export const chartController = new ChartController(target => window.webkit.messageHandlers.radar.postMessage({
  chartWindow: { instId: target.instId, timeframe: target.timeframe, endHour: target.end ?? undefined },
}))
