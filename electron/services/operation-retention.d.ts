export const DEFAULT_OPERATION_RETENTION: Readonly<{ maxAgeMS: number; maxBytes: number }>
export type OperationSessionManifest = {
  schemaVersion: 1; kind: string; id: string; token: string; pid: number
  createdAt: number; updatedAt: number; state: 'active' | 'closed' | 'interrupted'; closedAt?: number; failure?: string
}
export type OperationSession = {
  id: string; directory: string
  heartbeat(): Promise<OperationSessionManifest>
  /** Call only after all runtime/worker journals finish durable close. Rejects and preserves incomplete sessions. */
  close(options?: { complete?: boolean }): Promise<OperationSessionManifest>
}
export function createOperationSession(options: { root: string; now?: () => number; pid?: number }): Promise<OperationSession>
export type OperationRetentionStatus = {
  schemaVersion: 1; kind: string; updatedAt: number; policy: { maxAgeMS: number; maxBytes: number }
  state: 'ok' | 'over-budget' | 'blocked'; busy: boolean
  /** Includes measured session data and bounded manager metadata at the sweep's lease. Unmeasured paths make state blocked. */
  totalBytes: number; retainedBytes: number; protectedBytes: number; metadataBytes: number; overBudgetBytes: number
  expiredProtectedSessions: number; unmeasuredPaths: number
  sessions: Array<{ id: string; state: 'active' | 'closed' | 'interrupted' | 'unsafe'; reason: string; bytes: number }>
  pruned: Array<{ id: string; bytes: number; reason: string }>
  failures: Array<{ id: string; code: string }>
  auditFile: string; auditPolicy: { maxSegmentBytes: number; segments: number }
}
/** Keeps active, crashed, unsafe and unrecognized data. Budgets are policy targets, not hard bounds on protected data. */
export function enforceOperationRetention(root: string, options?: {
  maxAgeMS?: number; maxBytes?: number; now?: () => number; isProcessAlive?: (pid: number) => boolean
}): Promise<OperationRetentionStatus>
