import type { CandleRecord, StatisticsRecord } from './market-store.js'

export type HistoryTimeframe = '5m' | '15m' | '1H'
export type HistoryPriority = 'interactive' | 'foreground' | 'prepared' | 'repair' | 'continuity' | 'statistics' | 'prefetch' | 'chartWarm' | 'background'
export type HistoryRange = { from: number; through: number }
export type HistoryCoverageLease = HistoryRange & { expiresAt: number }
export type UnavailableHistoryRange = HistoryRange & { reason: string }
export type HistoryTaskStatus = 'queued' | 'running' | 'waiting' | 'retry' | 'paused' | 'cancelled' | 'completed' | 'unavailable'
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
  /** Unexpired successful empty observations, excluding explicit unavailable evidence. */
  emptyRecords: number
  /** Nonnumeric slots covered by explicit source evidence; numeric data takes precedence. */
  unavailableRecords: number
  /** Numeric source coverage reused without this held consumer's direct source downloads; ordinary consumers retain their first inspection count. */
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
  /** Priority when this source operation was dispatched. */
  priority: HistoryPriority
  /** Dynamic priority of live consumers overlapping this shared page. Pass to MarketService.get's fifth options argument. */
  getPriority(): HistoryPriority
  /** Notify the HTTP scheduler whenever the shared demand priority may change. */
  subscribePriority(listener: () => void): () => void
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
  store: {
    /** Gaps and direct absence leases come from the same storage snapshot. */
    missingCandleRanges(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string; intervalMS: number }, priority?: HistoryPriority): Promise<{ gaps: HistoryRange[]; leases: HistoryCoverageLease[] }>
    /** Process-local mutation revision. Without one, completed enqueues revalidate storage. */
    coverageVersion?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): MaybePromise<number>
    /** Null ranges mean the journal no longer covers the requested revision. */
    coverageChanges?(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }, revision: number): MaybePromise<{ revision: number; ranges: HistoryRange[] | null }>
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
  /** Start the process-local scheduler without restoring persisted demand. */
  start(): Promise<this>
  /** Create a finite process-local consumer. Overlapping and adjacent consumers share source coverage and API pages; cancellation removes only that consumer. */
  enqueue(request: HistoryRequest, options?: { hold?: boolean }): Promise<HistoryTask>
  /** Release a held consumer, invalidate its coverage and recheck before source access or completion. */
  release(id: string): boolean
  /** Remove delisted instruments' consumers without deleting durable facts. */
  removeTargets(instIds: Iterable<string>): Promise<void>
  /** Read detached snapshots. Terminal handles can expire from bounded result history. */
  getTask(id: string): HistoryTask | null
  listTasks(): HistoryTask[]
  /** Promote live consumers contained by these bounds and their shared page. Larger archive consumers retain background priority. Returns the number promoted. */
  promote(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }, priority: HistoryPriority): number
  /** Count unique instruments with retrying or explicitly unavailable source demand. */
  progressFor(instIds: Iterable<string>, timeframe: HistoryTimeframe): { retrying: number; unavailable: number }
  /** Recheck an explicit observation or repair even before it changes storage. */
  invalidate(query: HistoryRange & { instrument: string; timeframe: HistoryTimeframe; source: string }): void
  /** Stop demand immediately; resolve after an already admitted durable write and coverage verification finish. Shared network fetches are never awaited. */
  pause(id: string): Promise<HistoryTask>
  cancel(id: string): Promise<HistoryTask>
  /** Resume retries/cancelled work; unavailable tasks recheck source metadata. */
  resume(id: string): Promise<HistoryTask>
  /** Resolves when completed, unavailable, paused, or cancelled. failFast rejects on the first source error with Error.retryAt (number | null), leaving other consumers and background waiters intact. */
  waitFor(id: string, options?: { failFast?: boolean }): Promise<HistoryTask>
  /** Includes scheduled retries; paused/cancelled/unavailable work is idle. */
  whenIdle(): Promise<void>
  /** Reject waiters and abort active fetches; drain accepted writes. Consumers never restart. */
  close(): Promise<void>
}
