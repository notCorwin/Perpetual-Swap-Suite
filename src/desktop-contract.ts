import type { AnalysisSettings, AnalysisSettingsRequest } from './chart-analysis.ts'
import type { PreparedChartResponse } from './chart-data.ts'
import type { Preferences, PreferencesPatch } from '../electron/services/preferences.js'
import type { RadarTimeframe } from './timeframe.ts'
import type { OperationContext, OperationJournalEvent } from '../electron/services/operations.js'

export type OperationSourceIdentity = { sessionId: string; executionId: string; scenarioId?: string }
export type OperationBatch = { executionId: string; batchId: string; firstSequence: number; events: OperationJournalEvent[] }
export type OperationAcknowledgment = { batchId: string; lastSequence: number }
export type OperationBridgeHooks = {
  beginRequest(command: string): { id: string; context: OperationContext }
  endRequest(id: string, status: 'ok' | 'error'): void
  receive(channel: string, detail: unknown, context?: OperationContext): void
  flush(): Promise<void>
}

export type ChartCaptureBounds = { x: number; y: number; width: number; height: number; backgroundRGB: number[] }
export type ChartImage = { imageDataURL: string; width: number; height: number }

export type RankedMarketRow = {
  instId: string; lastPrice: number | null; turnover24hUSDT: number | null
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
  id?: string; phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
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
export type DesktopCommands = {
  preferences: { input: { action: 'read' } | { action: 'update'; values: PreferencesPatch }; output: Preferences }
  snapshot: { input: { sinceRevision?: number; serviceSession?: string }; output: MarketSnapshot | UnchangedSnapshot }
  dataAudit: { input: { action: 'start' | 'cancel' | 'status' | 'repair' }; output: DataAudit }
  historyDownload: { input: { action: 'start' | 'cancel' | 'status' }; output: HistoryDownload }
  analysisSettings: { input: AnalysisSettingsRequest; output: AnalysisSettings }
  gatewayFetch: { input: { id: string; body: string }; output: { status: number; headers: Record<string, string> } }
  cancelGatewayFetch: { input: string; output: { ok: boolean } }
  copyText: { input: string; output: { ok: boolean } }
  captureChart: { input: ChartCaptureBounds & { output?: 'png' }; output: { ok: boolean } }
  chartFocus: { input: { id: string; target: { instId: string; timeframe: RadarTimeframe; endHour?: number } | null }; output: { ok: boolean } }
  chartWindow: { input: { instId: string; timeframe: RadarTimeframe; endHour?: number; historyBars?: number; focusId?: string }; output: PreparedChartResponse }
  chartLocal: { input: { instId: string; timeframe: RadarTimeframe }; output: PreparedChartResponse | null }
  chartHistory: { input: { instId: string; timeframe: RadarTimeframe; endHour?: number }; output: PreparedChartResponse | null }
  chartUniverse: { input: Record<string, never>; output: { frames: PreparedChartResponse[] } }
}
export type DesktopRequest = { [K in keyof DesktopCommands]: { [P in K]: DesktopCommands[K]['input'] } }[keyof DesktopCommands]
export type DesktopResponse<Request extends DesktopRequest> = Request extends { captureChart: { output: 'png' } }
  ? ChartImage : { [K in keyof DesktopCommands]: Request extends Record<K, unknown> ? DesktopCommands[K]['output'] : never }[keyof DesktopCommands]
export interface RadarDesktop {
  readonly nativeWindowControls: boolean
  initializeOperations(hooks: OperationBridgeHooks): Promise<OperationSourceIdentity>
  recordOperations(batch: OperationBatch): Promise<OperationAcknowledgment>
  operationSourceFailure(value: { executionId: string; reason: string; omitted: number }): Promise<void>
  request(value: { preferences: DesktopCommands['preferences']['input'] }): Promise<DesktopCommands['preferences']['output']>
  request(value: { snapshot: DesktopCommands['snapshot']['input'] }): Promise<DesktopCommands['snapshot']['output']>
  request(value: { dataAudit: DesktopCommands['dataAudit']['input'] }): Promise<DesktopCommands['dataAudit']['output']>
  request(value: { historyDownload: DesktopCommands['historyDownload']['input'] }): Promise<DesktopCommands['historyDownload']['output']>
  request(value: { analysisSettings: DesktopCommands['analysisSettings']['input'] }): Promise<DesktopCommands['analysisSettings']['output']>
  request(value: { gatewayFetch: DesktopCommands['gatewayFetch']['input'] }): Promise<DesktopCommands['gatewayFetch']['output']>
  request(value: { cancelGatewayFetch: DesktopCommands['cancelGatewayFetch']['input'] }): Promise<DesktopCommands['cancelGatewayFetch']['output']>
  request(value: { copyText: DesktopCommands['copyText']['input'] }): Promise<DesktopCommands['copyText']['output']>
  request(value: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  request(value: { captureChart: DesktopCommands['captureChart']['input'] }): Promise<DesktopCommands['captureChart']['output']>
  request(value: { chartWindow: DesktopCommands['chartWindow']['input'] }): Promise<DesktopCommands['chartWindow']['output']>
  request(value: { chartFocus: DesktopCommands['chartFocus']['input'] }): Promise<DesktopCommands['chartFocus']['output']>
  request(value: { chartLocal: DesktopCommands['chartLocal']['input'] }): Promise<DesktopCommands['chartLocal']['output']>
  request(value: { chartHistory: DesktopCommands['chartHistory']['input'] }): Promise<DesktopCommands['chartHistory']['output']>
  request(value: { chartUniverse: DesktopCommands['chartUniverse']['input'] }): Promise<DesktopCommands['chartUniverse']['output']>
}
declare global { interface Window { radarDesktop: RadarDesktop } }
