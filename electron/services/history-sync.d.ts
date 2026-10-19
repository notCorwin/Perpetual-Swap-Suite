import type { CandleRecord, StatisticsRecord } from './market-store.js'

export type HistoryTimeframe = '5m' | '15m' | '1H'
export type HistoryPriority = 'interactive' | 'foreground' | 'prepared' | 'repair' | 'continuity' | 'statistics' | 'prefetch' | 'chartWarm' | 'background'
export type HistoryRange = { from: number; through: number }
export type HistoryCoverageLease = HistoryRange & { expiresAt: number }
export type UnavailableHistoryRange = HistoryRange & { reason: string }
export type HistoryTaskStatus = 'queued' | 'running' | 'retry' | 'paused' | 'cancelled' | 'completed' | 'unavailable'
export type HistoryTask = HistoryRange & {
  schemaVersion: 1
  id: string
  instrument: string
  timeframe: HistoryTimeframe
  source: string
  purpose: 'requested'
  priority: HistoryPriority
  status: HistoryTaskStatus
  createdAt: number
  updatedAt: number
  nextAttemptAt: number | null
  attempts: number
  cursor: string | number | null
  cursorRange: HistoryRange | null
  unavailableRanges: UnavailableHistoryRange[]
  /** Actual missing source slots, including explicitly unavailable history. */
  remaining: HistoryRange[]
  writtenRecords: number
  /** Durable numeric source slots, excluding missing slots and leased empty observations. */
  coveredRecords: number
  /** Union of covered empty-observation leases and explicitly unavailable missing slots. */
  unavailableRecords: number
  /** Numeric coverage observed at the consumer's first durable inspection. */
  localRecords: number
  inspected: boolean
  lastError: string | null
}
type MaybePromise<T> = T | Promise<T>
export type HistoryRequest = HistoryRange & {
  instrument: string
  timeframe: HistoryTimeframe
  source: string
  priority?: HistoryPriority
  purpose?: HistoryTask['purpose']
}
export type HistorySourceQuery = HistoryRange & {
  instrument: string
  timeframe: HistoryTimeframe
  source: string
  priority: HistoryPriority
  cursor: string | number | null
  signal: AbortSignal
}
export type HistorySourceInspection = {
  /** Only explicit source metadata may establish an availability boundary. */
  availableFrom?: number
  availableThrough?: number
  reason?: string
  unavailable?: UnavailableHistoryRange[]
}
export type HistoryRecord = CandleRecord | (Pick<StatisticsRecord, 'instrument' | 'timeframe' | 'timestamp'> & Partial<StatisticsRecord>)
export type HistoryFetchResult = {
  records: HistoryRecord[]
  cursor?: string | number | null
  unavailable?: UnavailableHistoryRange[]
}
export type HistorySource = {
  /** Native endpoint page size; defaults to 300 candles or 100 statistics slots. */
  pageSize?: number
  fetchGap(query: HistorySourceQuery): MaybePromise<HistoryRecord[] | HistoryFetchResult>
  inspect?(query: HistorySourceQuery): MaybePromise<HistorySourceInspection>
}
export type HistorySyncOptions = {
  metadata: {
    listSyncTasks(): MaybePromise<unknown[]>
    deleteSyncTask(id: string): MaybePromise<unknown>
    deleteSyncTasks?(ids: string[]): MaybePromise<unknown>
  }
  store: {
    missingCandleRanges(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string; intervalMS: number }, priority?: HistoryPriority): Promise<HistoryRange[]>
    /** Process-local mutation revision. Without one, completed enqueues revalidate storage. */
    coverageVersion?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): MaybePromise<number>
    /** Null ranges mean the journal no longer covers the requested revision. */
    coverageChanges?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }, revision: number): MaybePromise<{ revision: number; ranges: HistoryRange[] | null }>
    /** Direct empty-observation leases from the immediately preceding coverage read. Numeric observations have no lease. */
    coverageLeases?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): HistoryCoverageLease[]
    appendCandles?(records: CandleRecord[], priority?: HistoryPriority): Promise<number>
  }
  sources: Record<string, HistorySource>
  /** Defaults to store.appendCandles; resolve only after durable publication. */
  write?(records: HistoryRecord[], task: HistoryTask): MaybePromise<unknown>
  onProgress?(task: HistoryTask): MaybePromise<void>
  onError?(error: unknown, task?: HistoryTask): MaybePromise<void>
  now?: () => number
  /** Maximum in-flight source pages; defaults to 8. Interactive capacity is reserved and maintenance receives a turn after at most eight urgent admissions. */
  maxConcurrentTasks?: number
  /** Maximum pages per source; defaults to 4. Each series/source has one shared in-flight page. Low-priority work leaves one source slot reserved when the limit exceeds one. */
  maxConcurrentPerSource?: number | Record<string, number>
  /** Global minimum spacing between source fetch starts; defaults to 0. Endpoint-specific rate budgets belong to the transport. */
  minRequestIntervalMS?: number
  retryBaseMS?: number
  maxRetryDelayMS?: number
  /** Consecutive failures before a consumer pauses; defaults to 5. */
  maxAttempts?: number
  /** Recent terminal consumer handles retained in memory only; defaults to 512. */
  maxRetainedTerminalTasks?: number
}
export class HistorySync {
  constructor(options: HistorySyncOptions)
  /** Delete legacy persisted archive goals without admitting any source work. */
  start(): Promise<this>
  /** Create a finite process-local consumer. Overlapping and adjacent consumers share source coverage and API pages; cancellation removes only that consumer. */
  enqueue(request: HistoryRequest): Promise<HistoryTask>
  /** Remove delisted instruments' consumers without deleting durable facts. */
  removeTargets(instIds: Iterable<string>): Promise<void>
  /** Read detached snapshots. Terminal handles can expire from bounded result history. */
  getTask(id: string): HistoryTask | null
  listTasks(): HistoryTask[]
  /** Count unique instruments with retrying or unavailable/paused source demand. */
  progressFor(instIds: Iterable<string>, timeframe: HistoryTimeframe): { retrying: number; unavailable: number }
  /** Recheck an explicit observation or repair even before it changes storage. */
  invalidate(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): void
  /** Stop demand immediately; resolve after an already admitted durable write and coverage verification finish. Shared network fetches are never awaited. */
  pause(id: string): Promise<HistoryTask>
  cancel(id: string): Promise<HistoryTask>
  /** Resume retries/cancelled work; unavailable tasks recheck source metadata. */
  resume(id: string): Promise<HistoryTask>
  /** Resolves when completed, unavailable, paused, or cancelled. Registered waiters survive result pruning; an already expired ID is unknown. */
  waitFor(id: string): Promise<HistoryTask>
  /** Includes scheduled retries; paused/cancelled/unavailable work is idle. */
  whenIdle(): Promise<void>
  /** Reject waiters and abort active fetches; drain accepted writes. Consumers never restart. */
  close(): Promise<void>
}
