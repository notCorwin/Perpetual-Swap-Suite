export type AuditTarget = {
  instrument: string
  timeframe: '5m' | '15m' | '1H'
  /** Inclusive millisecond bounds. Findings may describe off-grid timestamps. */
  from: number
  through: number
  source?: 'candles'
}
export type AuditFinding = Omit<AuditTarget, 'timeframe'> & {
  timeframe: string
  source: 'candles'
  reason: string
  repairable: boolean
  file?: string
  detail?: string
}
export type AuditInspection = {
  issues: AuditFinding[]
  checkedRows: number
  files: number
  missingRanges?: Array<{ from: number; through: number }>
}
export type AuditIssue = AuditFinding & {
  id: string
  status: 'open' | 'resolved'
  repairStatus?: 'pending' | 'repaired' | 'failed'
  repairError?: string
  resolvedAt?: number
  /** Original bounds retained when verification narrows a continuing defect. */
  originalRange?: { from: number; through: number }
}
export type AuditJob = {
  id: string
  schemaVersion: 1
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  phase: 'inspect' | 'repair' | 'verify'
  targets: Array<AuditTarget & { source: 'candles' }>
  cursor: { targetIndex: number; nextFrom: number | null }
  issues: AuditIssue[]
  checkedRows: number
  files: number
  repairTargets: Array<AuditTarget & { source: 'candles'; issueId: string }>
  repairIndex: number
  verifyTargets: Array<AuditTarget & { source: 'candles' }>
  verifyIndex: number
  verificationCheckedRows: number
  verificationFiles: number
  summary: { open: number; resolved: number; repairFailed: number }
  createdAt: number
  updatedAt: number
  completedAt: number | null
  error?: string
}
export type AuditMetadata = {
  saveAudit(audit: AuditJob): unknown
  listAudits(): unknown[]
}
export type AuditInspect = (target: AuditTarget, options: { signal: AbortSignal; priority: 'background' }) => Promise<AuditInspection>
export type AuditRepair = (issue: AuditIssue, options: { signal: AbortSignal }) => Promise<void>
export class DataAudit {
  constructor(options: {
    store?: { inspectCandles(target: AuditTarget, priority?: 'background'): Promise<AuditInspection> }
    metadata: AuditMetadata
    inspect?: AuditInspect
    /** Repair is explicit; unavailable observations are never synthesized. */
    repair?: AuditRepair
    now?: () => number
    /** Defaults to one day; yields between chunks on the background lane. */
    chunkMilliseconds?: number
  })
  /** Enqueues a durable audit and immediately returns its report. */
  start(request: { id?: string; targets: AuditTarget[] }): AuditJob
  get(id: string): AuditJob | null
  status(id: string): AuditJob | null
  list(): AuditJob[]
  /** Stops admitting work and signals any current callback to abort. */
  cancel(id: string): AuditJob
  /** Resumes from the last persisted completed chunk/repair/verification. */
  resume(id: string): AuditJob
  /** Repairs only open, repairable findings, then verifies affected ranges. */
  repair(id: string): AuditJob
  whenIdle(): Promise<void>
  /** Preserves active jobs as queued for the next instance; does not close stores. */
  close(): Promise<void>
}
