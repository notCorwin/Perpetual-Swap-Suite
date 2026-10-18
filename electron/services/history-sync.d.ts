import type { CandleRecord } from './market-store.js'

export type HistoryTimeframe = '5m' | '15m' | '1H'
export type HistoryPriority = 'foreground' | 'background'
export type HistoryRange = { from: number; through: number }
export type UnavailableHistoryRange = HistoryRange & { reason: string }
export type HistoryTaskStatus = 'queued' | 'running' | 'retry' | 'paused' | 'cancelled' | 'completed' | 'unavailable'
export type HistoryTask = HistoryRange & {
  schemaVersion: 1
  id: string
  instrument: string
  timeframe: HistoryTimeframe
  source: string
  purpose: 'requested' | 'history' | 'warmup'
  priority: HistoryPriority
  status: HistoryTaskStatus
  createdAt: number
  updatedAt: number
  /** Latest rolling goal admission, independent of page checkpoints and exact-range reuse. */
  targetRequestedAt?: number
  nextAttemptAt: number | null
  attempts: number
  cursor: string | number | null
  cursorRange: HistoryRange | null
  unavailableRanges: UnavailableHistoryRange[]
  /** Actual missing Parquet slots, including explicitly unavailable history. */
  remaining: HistoryRange[]
  writtenRecords: number
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
export type HistoryFetchResult = {
  records: CandleRecord[]
  cursor?: string | number | null
  unavailable?: UnavailableHistoryRange[]
}
export type HistorySource = {
  fetchGap(query: HistorySourceQuery): MaybePromise<CandleRecord[] | HistoryFetchResult>
  inspect?(query: HistorySourceQuery): MaybePromise<HistorySourceInspection>
}
export type HistorySyncOptions = {
  metadata: {
    putSyncTask(task: HistoryTask): MaybePromise<unknown>
    getSyncTask(id: string): MaybePromise<unknown>
    listSyncTasks(): MaybePromise<unknown[]>
    deleteSyncTask(id: string): MaybePromise<unknown>
  }
  store: {
    missingCandleRanges(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string; intervalMS: number }, priority?: HistoryPriority): Promise<HistoryRange[]>
    appendCandles?(records: CandleRecord[], priority?: HistoryPriority): Promise<number>
  }
  sources: Record<string, HistorySource>
  /** Defaults to store.appendCandles; resolve only after durable publication. */
  write?(records: CandleRecord[], task: HistoryTask): MaybePromise<unknown>
  onProgress?(task: HistoryTask): MaybePromise<void>
  onError?(error: unknown, task?: HistoryTask): MaybePromise<void>
  now?: () => number
  /** Maximum simultaneous tasks across all sources; defaults to 1. Each page yields to ready foreground work, then rotates behind equal-priority peers. */
  maxConcurrentTasks?: number
  /** Foreground concurrency per source, as one limit or named source limits; each source defaults to 1. Background pages remain limited to one per source and yield to queued foreground work. Overlapping ranges for the same instrument/timeframe/source serialize. */
  maxConcurrentPerSource?: number | Record<string, number>
  /** Global minimum spacing between source inspect/fetch starts, including concurrent sources; defaults to 125. */
  minRequestIntervalMS?: number
  retryBaseMS?: number
  maxRetryDelayMS?: number
  /** Consecutive failures before a recoverable pause; defaults to 5. */
  maxAttempts?: number
  /** Recent completed/unavailable/cancelled checkpoints to retain in memory and SQLite; defaults to 512, minimum 1. Paused and active tasks and registered waiters are never evicted. */
  maxRetainedTerminalTasks?: number
}
export class HistorySync {
  constructor(options: HistorySyncOptions)
  /** Recover saved tasks, including interrupted running tasks; start the pool. */
  start(): Promise<this>
  /** Deduplicate exact ranges for either priority; overlapping targets share durable coverage, never completion barriers. */
  enqueue(request: HistoryRequest): Promise<HistoryTask>
  /** A 30-day completed-candle target plus a separate 200-candle EMA warmup. */
  enqueueTarget(request: Omit<HistoryRequest, 'from' | 'through' | 'purpose'> & { historyDays?: number; warmupCandles?: number; asOf?: number }): Promise<{ history: HistoryTask; warmup: HistoryTask | null }>
  /** Read detached snapshots after start(). Old completed/unavailable/cancelled tasks can expire from the bounded result history and return null. Re-enqueue their range to recheck durable coverage. */
  getTask(id: string): HistoryTask | null
  listTasks(): HistoryTask[]
  pause(id: string): Promise<HistoryTask>
  cancel(id: string): Promise<HistoryTask>
  /** Resume retries/cancelled work; unavailable tasks recheck source metadata. */
  resume(id: string): Promise<HistoryTask>
  /** Resolves when completed, unavailable, paused, or cancelled. Registered waiters survive result pruning; an already expired ID is unknown. */
  waitFor(id: string): Promise<HistoryTask>
  /** Includes scheduled retries; paused/cancelled/unavailable work is idle. */
  whenIdle(): Promise<void>
  /** Reject task/idle waiters and abort active fetches; drain accepted writes/checkpoints and preserve pending work for restart. */
  close(): Promise<void>
}
