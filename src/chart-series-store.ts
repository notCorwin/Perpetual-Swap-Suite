import { mergeChartBars } from './chart-snapshot.ts'
import { SnapshotOrder } from './snapshot-order.ts'

/** The minimum shape needed to merge a chart series without importing React UI types. */
export type ChartSeriesBar = { hour: number; confirmed: boolean }

/**
 * A chart response can carry any renderer-specific status fields. The store
 * treats only bars, revision, and serviceSession as canonical-series fields.
 */
export type ChartSeriesResponse<TBar extends ChartSeriesBar, TStatus extends object> = TStatus & {
  bars: TBar[]
  revision: number
  serviceSession?: string
}

export type ChartSeriesEntry<TBar extends ChartSeriesBar, TStatus extends object> = {
  bars: TBar[]
  latestKnownHour: number | null
  /** The newest accepted transport revision, including status-only replies. */
  revision: number
  /** The session that produced the newest accepted transport reply. */
  serviceSession?: string
  /** The session that produced the retained bars. It can trail serviceSession while a new session is loading. */
  barsServiceSession?: string
  status: TStatus
  loadedAt: number
}

export type ChartSeriesUpsert<TBar extends ChartSeriesBar, TStatus extends object> = {
  entry: ChartSeriesEntry<TBar, TStatus> | undefined
  accepted: boolean
}

const statusOf = <TBar extends ChartSeriesBar, TStatus extends object>(response: ChartSeriesResponse<TBar, TStatus>): TStatus => {
  const status = { ...response } as Record<string, unknown>
  delete status.bars
  delete status.revision
  delete status.serviceSession
  return status as TStatus
}

const latestHour = <TBar extends ChartSeriesBar>(bars: readonly TBar[]) => bars.length ? bars[bars.length - 1]!.hour : null

/**
 * Session-scoped, canonical chart data for the renderer.
 *
 * Entries are deliberately never evicted: the caller should use a separate
 * bounded cache for speculative previews. This prevents a preview from making
 * a previously rendered target disappear while its next request is in flight.
 */
export class ChartSeriesStore<TBar extends ChartSeriesBar, TStatus extends object> {
  private readonly entries = new Map<string, ChartSeriesEntry<TBar, TStatus>>()
  private readonly orders = new Map<string, SnapshotOrder>()

  get size() { return this.entries.size }

  get(key: string) { return this.entries.get(key) }

  hasBars(key: string) { return (this.entries.get(key)?.bars.length ?? 0) > 0 }

  latestKnownHour(key: string) { return this.entries.get(key)?.latestKnownHour ?? null }

  upsert(key: string, response: ChartSeriesResponse<TBar, TStatus>, loadedAt = Date.now()): ChartSeriesUpsert<TBar, TStatus> {
    const existing = this.entries.get(key)
    let order = this.orders.get(key)
    if (!order) {
      order = new SnapshotOrder()
      this.orders.set(key, order)
    }

    // Once the protocol has identified a collector session, an unlabelled
    // reply cannot safely be assigned to it. Keep the known visual series.
    if (order.serviceSession !== undefined && response.serviceSession === undefined) return { entry: existing, accepted: false }
    if (!order.accept(response)) return { entry: existing, accepted: false }

    const hasIncomingBars = response.bars.length > 0
    const mustReplaceBars = hasIncomingBars && existing !== undefined && existing.barsServiceSession !== response.serviceSession
    const incoming = { bars: response.bars, revision: response.revision, serviceSession: response.serviceSession }
    const current = existing && { bars: existing.bars, revision: existing.revision, serviceSession: existing.barsServiceSession }
    const bars = !hasIncomingBars
      ? existing?.bars ?? []
      : mustReplaceBars || !current
        ? mergeChartBars(incoming, null)
        : mergeChartBars(incoming, current)

    const entry: ChartSeriesEntry<TBar, TStatus> = {
      bars,
      latestKnownHour: latestHour(bars),
      revision: response.revision,
      serviceSession: response.serviceSession,
      barsServiceSession: hasIncomingBars ? response.serviceSession : existing?.barsServiceSession ?? response.serviceSession,
      status: statusOf(response),
      loadedAt,
    }
    this.entries.set(key, entry)
    return { entry, accepted: true }
  }
}
