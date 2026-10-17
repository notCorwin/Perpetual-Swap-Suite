export type ChartTimeframe = '5m' | '15m' | '1H'
export type Preferences = {
  chartTimeframe: ChartTimeframe
  rankingLookback: number
  /** Whole days, from 1 through 3650 inclusive. */
  historyDays: number
  liquidity: {
    spread: { enabled: boolean; maxPercent: number }
    depth: { enabled: boolean; minUSDT: number }
    slippage: { enabled: boolean; maxPercent: number; notionalUSDT: number }
    volume24h: { enabled: boolean; minUSDT: number }
    openInterest: { enabled: boolean; minUSDT: number }
    volumeStability: { enabled: boolean; maxRatio: number }
  }
}
export type PreferencesPatch = {
  chartTimeframe?: ChartTimeframe
  rankingLookback?: number
  historyDays?: number
  liquidity?: { [Rule in keyof Preferences['liquidity']]?: Partial<Preferences['liquidity'][Rule]> }
}
export type SettingsSnapshot = { schemaVersion: 1; revision: number; preferences: Preferences }
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }
export type AnalysisSettings = { model?: string; apiKey?: string; [key: string]: JSONValue | undefined }
export type SyncTaskRecord = {
  id: string
  schemaVersion?: 1
  instrument: string
  timeframe: ChartTimeframe
  source: string
  from: number
  through: number
  status: 'queued' | 'running' | 'retry' | 'paused' | 'cancelled' | 'completed' | 'unavailable' | 'failed'
  [key: string]: unknown
}
export type AuditRecord = {
  id: string
  schemaVersion?: 1
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  phase?: 'inspect' | 'repair' | 'verify'
  [key: string]: unknown
}
export type CatalogEntry = {
  instrumentID: string
  schemaVersion?: 1
  status: 'verified' | 'failed' | 'unknown'
  observedAt: number
  expiresAt: number
  preferencesRevision: number
  [key: string]: unknown
}
export const DEFAULT_PREFERENCES: Readonly<Preferences>
/** Complete schema validation; throws TypeError and returns a detached copy. */
export function validatePreferences(value: unknown): Preferences
export class SettingsRevisionConflictError extends Error {
  constructor(expectedRevision: number, actualRevision: number)
  readonly code: 'SETTINGS_REVISION_CONFLICT'
  readonly expectedRevision: number
  readonly actualRevision: number
}
/** SQLite stores mutable metadata only. Completed candles remain in Parquet. */
export class MetadataStore {
  private constructor(database: unknown)
  static open(root: string, options?: { legacySettingsPath?: string }): Promise<MetadataStore>
  getSettings(): SettingsSnapshot
  /** Deep merge reads the latest revision inside a transaction; optional CAS. */
  updateSettings(patch: PreferencesPatch, options?: { expectedRevision?: number }): SettingsSnapshot
  /** Main process only; never send credential-bearing settings over IPC. */
  getAnalysisSettings(): AnalysisSettings
  /** Main process only. */
  updateAnalysisSettings(patch: AnalysisSettings): AnalysisSettings
  putSyncTask<T extends SyncTaskRecord>(task: T): T
  getSyncTask(id: string): SyncTaskRecord | null
  listSyncTasks(): SyncTaskRecord[]
  deleteSyncTask(id: string): boolean
  saveAudit<T extends AuditRecord>(audit: T): T
  getAudit(id: string): AuditRecord | null
  listAudits(): AuditRecord[]
  putCatalogEntry<T extends CatalogEntry>(entry: T): T
  getCatalogEntry(instrumentID: string): CatalogEntry | null
  listCatalogEntries(): CatalogEntry[]
  deleteCatalogEntry(instrumentID: string): boolean
  replaceCatalogEntries<T extends CatalogEntry>(entries: T[]): T[]
  close(): void
}
