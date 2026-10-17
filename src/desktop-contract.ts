import type { AnalysisSettings, AnalysisSettingsRequest } from './chart-analysis.ts'
import type { PreparedChartResponse } from './chart-data.ts'
import type { NativeMarketRow } from './market-row.ts'
import type { Preferences, PreferencesPatch } from '../electron/services/preferences.js'
import type { RadarTimeframe } from './timeframe.ts'

export type ChartCaptureBounds = { x: number; y: number; width: number; height: number; backgroundRGB: number[] }
export type ChartImage = { imageDataURL: string; width: number; height: number }

export type RankedMarketRow = NativeMarketRow & { rankingChange: number | null; rankingAsOf: number | null }
export type ListProgress = { total: number; completed: number; pending: number; retrying: number; unavailable: number }
export type CatalogProgress = { total: number; completed: number; verified: number; failed: number; unknown: number }
export type MarketSnapshot = {
  rows: RankedMarketRow[]; updatedAt: number | null; error: string; revision: number
  loading?: boolean; listProgress?: ListProgress; catalogSource?: 'none' | 'cache' | 'live'
  catalogProgress?: CatalogProgress
  serviceSession?: string; timeframe?: RadarTimeframe; realtimeState?: string
}
export type UnchangedSnapshot = Partial<Omit<MarketSnapshot, 'rows'>> & { unchanged: true; revision: number; error: string }
export type DataAudit = {
  id?: string; phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  progress: { completed: number; total: number }
  issues: { instrument: string; timeframe: string; from: number; through: number; reason: string; repairable: boolean }[]
  error: string
}
export type DesktopCommands = {
  preferences: { input: { action: 'read' } | { action: 'update'; values: PreferencesPatch }; output: Preferences }
  snapshot: { input: { timeframe: RadarTimeframe; sinceRevision?: number; serviceSession?: string }; output: MarketSnapshot | UnchangedSnapshot }
  dataAudit: { input: { action: 'start' | 'cancel' | 'status' | 'repair' }; output: DataAudit }
  analysisSettings: { input: AnalysisSettingsRequest; output: AnalysisSettings }
  gatewayFetch: { input: { id: string; body: string }; output: { status: number; headers: Record<string, string> } }
  cancelGatewayFetch: { input: string; output: { ok: boolean } }
  copyText: { input: string; output: { ok: boolean } }
  captureChart: { input: ChartCaptureBounds & { output?: 'png' }; output: { ok: boolean } }
  chartWindow: { input: { instId: string; timeframe: RadarTimeframe; endHour?: number }; output: PreparedChartResponse }
  chartLocal: { input: { instId: string; timeframe: RadarTimeframe }; output: PreparedChartResponse | null }
  chartHistory: { input: { instId: string; timeframe: RadarTimeframe; endHour?: number }; output: PreparedChartResponse | null }
  chartUniverse: { input: { instIds: string[]; timeframe: RadarTimeframe; focusInstId?: string }; output: { frames: PreparedChartResponse[] } }
}
export type DesktopRequest = { [K in keyof DesktopCommands]: { [P in K]: DesktopCommands[K]['input'] } }[keyof DesktopCommands]
export type DesktopResponse<Request extends DesktopRequest> = Request extends { captureChart: { output: 'png' } }
  ? ChartImage : { [K in keyof DesktopCommands]: Request extends Record<K, unknown> ? DesktopCommands[K]['output'] : never }[keyof DesktopCommands]
export interface RadarDesktop {
  request(value: { preferences: DesktopCommands['preferences']['input'] }): Promise<DesktopCommands['preferences']['output']>
  request(value: { snapshot: DesktopCommands['snapshot']['input'] }): Promise<DesktopCommands['snapshot']['output']>
  request(value: { dataAudit: DesktopCommands['dataAudit']['input'] }): Promise<DesktopCommands['dataAudit']['output']>
  request(value: { analysisSettings: DesktopCommands['analysisSettings']['input'] }): Promise<DesktopCommands['analysisSettings']['output']>
  request(value: { gatewayFetch: DesktopCommands['gatewayFetch']['input'] }): Promise<DesktopCommands['gatewayFetch']['output']>
  request(value: { cancelGatewayFetch: DesktopCommands['cancelGatewayFetch']['input'] }): Promise<DesktopCommands['cancelGatewayFetch']['output']>
  request(value: { copyText: DesktopCommands['copyText']['input'] }): Promise<DesktopCommands['copyText']['output']>
  request(value: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  request(value: { captureChart: DesktopCommands['captureChart']['input'] }): Promise<DesktopCommands['captureChart']['output']>
  request(value: { chartWindow: DesktopCommands['chartWindow']['input'] }): Promise<DesktopCommands['chartWindow']['output']>
  request(value: { chartLocal: DesktopCommands['chartLocal']['input'] }): Promise<DesktopCommands['chartLocal']['output']>
  request(value: { chartHistory: DesktopCommands['chartHistory']['input'] }): Promise<DesktopCommands['chartHistory']['output']>
  request(value: { chartUniverse: DesktopCommands['chartUniverse']['input'] }): Promise<DesktopCommands['chartUniverse']['output']>
}
declare global { interface Window { radarDesktop: RadarDesktop } }
