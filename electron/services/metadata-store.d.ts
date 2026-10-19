import type { ChartTimeframe, Preferences, PreferencesPatch } from './preferences.js'
export type { ChartTimeframe, Preferences, PreferencesPatch } from './preferences.js'
export { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js'
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
  putSyncTasks<T extends SyncTaskRecord>(tasks: T[]): T[]
  getSyncTask(id: string): SyncTaskRecord | null
  listSyncTasks(): SyncTaskRecord[]
  deleteSyncTask(id: string): boolean
  deleteSyncTasks(ids: string[]): number
  saveAudit<T extends AuditRecord>(audit: T): T
  getAudit(id: string): AuditRecord | null
  listAudits(): AuditRecord[]
  getHistoryDownload(): Omit<import('../../src/desktop-contract.ts').HistoryDownload, 'revision' | 'serviceSession'> | null
  saveHistoryDownload(report: Omit<import('../../src/desktop-contract.ts').HistoryDownload, 'revision' | 'serviceSession'>): void
  putCatalogEntry<T extends CatalogEntry>(entry: T): T
  saveCatalogRankings(entries: Array<{ instrumentID: string; lookback: number; rankingChange: number; rankingAsOf: number }>): string[]
  getCatalogEntry(instrumentID: string): CatalogEntry | null
  listCatalogEntries(): CatalogEntry[]
  deleteCatalogEntry(instrumentID: string): boolean
  replaceCatalogEntries<T extends CatalogEntry>(entries: T[]): T[]
  close(): void
}
