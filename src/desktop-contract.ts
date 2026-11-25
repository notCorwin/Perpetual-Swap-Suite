import type { PreparedChartResponse } from './chart-data.ts'
import type { Preferences, PreferencesPatch } from '../electron/services/preferences.js'
import type { RadarTimeframe } from './timeframe.ts'

export type ChartCaptureBounds = { x: number; y: number; width: number; height: number; backgroundRGB: number[] }
export type ChartImage = { imageDataURL: string; width: number; height: number }

export type RankedMarketRow = {
  instId: string; tickSz: string | null; lastPrice: number | null; turnover24hUSDT: number | null
  change5m: number | null; change5mAsOf: number | null
  change15m: number | null; change15mAsOf: number | null
  rankingChange: number | null; rankingAsOf: number | null
}
export type CatalogProgress = { total: number; completed: number; verified: number; failed: number; unknown: number; pending: number }
export type MarketSnapshot = {
  rows: RankedMarketRow[]; turnoverOrder: string[]; updatedAt: number | null; error: string; revision: number
  loading?: boolean; catalogSource?: 'none' | 'cache' | 'live'
  catalogProgress?: CatalogProgress
  serviceSession?: string; realtimeState?: string
}
export type UnchangedSnapshot = Partial<Omit<MarketSnapshot, 'rows'>> & { unchanged: true; revision: number; error: string }
export type DataAudit = {
  revision: number; serviceSession: string
  id?: string; phase: 'idle' | 'running' | 'validating' | 'completed' | 'cancelled' | 'failed'
  progress: { completed: number; total: number }
  issues: { instrument: string; timeframe: string; from: number; through: number; reason: string; repairable: boolean }[]
  error: string
}
export type HistoryDownload = {
  schemaVersion: 2
  revision: number; serviceSession: string
  id?: string; phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  startedAt: number | null; updatedAt: number | null; finishedAt: number | null
  contracts: { completed: number; total: number }
  streams: { completed: number; total: number }
  /** Successful coverage checks are independent from numeric data completeness. */
  progress: { checked: number; total: number; available: number; empty: number; unavailable: number; failed: number; reused: number; pending: number }
  active: { instrument: string; timeframe: string; source: string; from: number; through: number; status: string; attempts: number; nextAttemptAt: number | null; error: string }[]
  failures: { instrument: string; timeframe: string; source: string; from: number; through: number; error: string }[]
  error: string
}
export type PresentationSnapshot = {
  market: MarketSnapshot; frames: PreparedChartResponse[]; preferences: Preferences
  audit: DataAudit; download: HistoryDownload
}
export type PresentationUpdate = { epoch: number; active: boolean; startedAt: number; snapshot?: PresentationSnapshot; error?: string }
export type DesktopCommands = {
  statusLog: { input: { status: string; realtime: string; updatedAt: number | null; issues: string[]; cause: string; catalog: CatalogProgress | null }; output: { ok: boolean } }
  preferences: { input: { action: 'read' } | { action: 'update'; values: PreferencesPatch }; output: Preferences }
  snapshot: { input: { sinceRevision?: number; serviceSession?: string }; output: MarketSnapshot | UnchangedSnapshot }
  dataAudit: { input: { action: 'start' | 'cancel' | 'status' | 'repair' }; output: DataAudit }
  historyDownload: { input: { action: 'start' | 'cancel' | 'status' }; output: HistoryDownload }
  copyText: { input: string; output: { ok: boolean } }
  copyImage: { input: string; output: { ok: boolean } }
  captureChart: { input: ChartCaptureBounds & { output?: 'png' }; output: { ok: boolean } }
  screenshot: { input: Record<string, never>; output: { ok: boolean } }
  chartFocus: { input: { id: string; slot?: 'primary' | RadarTimeframe; target: { instId: string; timeframe: RadarTimeframe; endHour?: number; windowBars?: number } | null }; output: { ok: boolean } }
  chartLocal: { input: { instId: string; timeframe: RadarTimeframe }; output: PreparedChartResponse | null }
  chartHistory: { input: { instId: string; timeframe: RadarTimeframe; endHour?: number; focusId?: string; windowBars?: number }; output: PreparedChartResponse | null }
  chartUniverse: { input: Record<string, never>; output: { frames: PreparedChartResponse[] } }
}
export type DesktopRequest = { [K in keyof DesktopCommands]: { [P in K]: DesktopCommands[K]['input'] } }[keyof DesktopCommands]
export type DesktopResponse<Request extends DesktopRequest> = Request extends { captureChart: { output: 'png' } }
  ? ChartImage : { [K in keyof DesktopCommands]: Request extends Record<K, unknown> ? DesktopCommands[K]['output'] : never }[keyof DesktopCommands]
export interface RadarDesktop {
  readonly nativeWindowControls: boolean
  readonly isSettingsWindow: boolean
  setSettingsCloseGuard(value: { dirty: boolean; busy: boolean }): void
  closeSettingsWindow(): Promise<void>
  subscribePresentation(receiver: (update: PresentationUpdate) => void): () => void
  request(value: { statusLog: DesktopCommands['statusLog']['input'] }): Promise<DesktopCommands['statusLog']['output']>
  request(value: { preferences: DesktopCommands['preferences']['input'] }): Promise<DesktopCommands['preferences']['output']>
  request(value: { snapshot: DesktopCommands['snapshot']['input'] }): Promise<DesktopCommands['snapshot']['output']>
  request(value: { dataAudit: DesktopCommands['dataAudit']['input'] }): Promise<DesktopCommands['dataAudit']['output']>
  request(value: { historyDownload: DesktopCommands['historyDownload']['input'] }): Promise<DesktopCommands['historyDownload']['output']>
  request(value: { copyText: DesktopCommands['copyText']['input'] }): Promise<DesktopCommands['copyText']['output']>
  request(value: { copyImage: DesktopCommands['copyImage']['input'] }): Promise<DesktopCommands['copyImage']['output']>
  request(value: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  request(value: { captureChart: DesktopCommands['captureChart']['input'] }): Promise<DesktopCommands['captureChart']['output']>
  request(value: { screenshot: DesktopCommands['screenshot']['input'] }): Promise<DesktopCommands['screenshot']['output']>
  request(value: { chartFocus: DesktopCommands['chartFocus']['input'] }): Promise<DesktopCommands['chartFocus']['output']>
  request(value: { chartLocal: DesktopCommands['chartLocal']['input'] }): Promise<DesktopCommands['chartLocal']['output']>
  request(value: { chartHistory: DesktopCommands['chartHistory']['input'] }): Promise<DesktopCommands['chartHistory']['output']>
  request(value: { chartUniverse: DesktopCommands['chartUniverse']['input'] }): Promise<DesktopCommands['chartUniverse']['output']>
}
declare global { interface Window { radarDesktop: RadarDesktop } }
