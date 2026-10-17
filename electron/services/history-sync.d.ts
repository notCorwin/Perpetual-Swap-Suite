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
  minRequestIntervalMS?: number
  retryBaseMS?: number
  maxRetryDelayMS?: number
  /** Consecutive failures before a recoverable pause; defaults to 5. */
  maxAttempts?: number
}
export class HistorySync {
  constructor(options: HistorySyncOptions)
  /** Recover saved tasks, including interrupted running tasks; start the lane. */
  start(): Promise<this>
  enqueue(request: HistoryRequest): Promise<HistoryTask>
  /** A 30-day completed-candle target plus a separate 200-candle EMA warmup. */
  enqueueTarget(request: Omit<HistoryRequest, 'from' | 'through' | 'purpose'> & { historyDays?: number; warmupCandles?: number; asOf?: number }): Promise<{ history: HistoryTask; warmup: HistoryTask | null }>
  /** Read detached snapshots after start() has resolved. */
  getTask(id: string): HistoryTask | null
  listTasks(): HistoryTask[]
  pause(id: string): Promise<HistoryTask>
  cancel(id: string): Promise<HistoryTask>
  /** Resume retries/cancelled work; unavailable tasks recheck source metadata. */
  resume(id: string): Promise<HistoryTask>
  /** Resolves when completed, unavailable, paused, or cancelled. */
  waitFor(id: string): Promise<HistoryTask>
  /** Includes scheduled retries; paused/cancelled/unavailable work is idle. */
  whenIdle(): Promise<void>
  /** Abort active fetches and preserve pending work for the next coordinator. */
  close(): Promise<void>
}
