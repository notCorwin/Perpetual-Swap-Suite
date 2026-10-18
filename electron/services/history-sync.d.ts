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
    putSyncTasks?(tasks: HistoryTask[]): MaybePromise<unknown>
    deleteSyncTasks?(ids: string[]): MaybePromise<unknown>
  }
  store: {
    missingCandleRanges(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string; intervalMS: number }, priority?: HistoryPriority): Promise<HistoryRange[]>
    /** Process-local mutation revision. Without one, completed enqueues revalidate storage. */
    coverageVersion?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): MaybePromise<number>
    /** Null ranges mean the journal no longer covers the requested revision. */
    coverageChanges?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }, revision: number): MaybePromise<{ revision: number; ranges: HistoryRange[] | null }>
    /** Earliest observation lease from the immediately preceding coverage read. */
    coverageExpiry?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): number | null
    appendCandles?(records: CandleRecord[], priority?: HistoryPriority): Promise<number>
  }
  sources: Record<string, HistorySource>
  /** Defaults to store.appendCandles; resolve only after durable publication. */
  write?(records: CandleRecord[], task: HistoryTask): MaybePromise<unknown>
  onProgress?(task: HistoryTask): MaybePromise<void>
  onError?(error: unknown, task?: HistoryTask): MaybePromise<void>
  now?: () => number
  /** Maximum simultaneous tasks, with at most one per source; defaults to 1. Each page yields to ready foreground work, then rotates behind equal-priority peers. */
  maxConcurrentTasks?: number
  /** Global minimum spacing between source inspect/fetch starts, including concurrent sources; defaults to 125. */
  minRequestIntervalMS?: number
  retryBaseMS?: number
  maxRetryDelayMS?: number
  /** Consecutive failures before a recoverable pause; defaults to 5. */
  maxAttempts?: number
  /** Recent requested completed/unavailable/cancelled checkpoints to retain in memory and SQLite; defaults to 512, minimum 1. Paused and active tasks and registered waiters are never evicted. */
  maxRetainedTerminalTasks?: number
}
export class HistorySync {
  constructor(options: HistorySyncOptions)
  /** Recover saved tasks, including interrupted running tasks; start the pool. */
  start(): Promise<this>
  /** Requested ranges retain exact identities; rolling history/warmup use one stable identity each per instrument/timeframe/source. Completed verified ranges are reused until a mutation or observation expiry. */
  enqueue(request: HistoryRequest): Promise<HistoryTask>
  /** Replace the current rolling history and warmup windows without accumulating obsolete targets. Explicitly paused/cancelled targets stay stopped. */
  enqueueTarget(request: Omit<HistoryRequest, 'from' | 'through' | 'purpose'> & { historyDays?: number; warmupCandles?: number; asOf?: number }): Promise<{ history: HistoryTask; warmup: HistoryTask | null }>
  /** Read detached snapshots after start(). Old completed/unavailable/cancelled tasks can expire from the bounded result history and return null. Re-enqueue their range to recheck durable coverage. */
  getTask(id: string): HistoryTask | null
  listTasks(): HistoryTask[]
  /** Count unique instruments with retrying or unavailable/paused work without cloning task payloads. */
  progressFor(instIds: Iterable<string>, timeframe: HistoryTimeframe): { retrying: number; unavailable: number }
  /** Recheck an explicit observation or repair even before it changes storage. */
  invalidate(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): void
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
