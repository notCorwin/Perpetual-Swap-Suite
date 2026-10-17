import type { AnalysisSettings, AnalysisSettingsRequest } from './chart-analysis.ts'
import type { ChartCaptureBounds, ChartImage } from './chart-capture.ts'
import type { PreparedChartResponse } from './chart-data.ts'
import type { NativeMarketRow } from './market-row.ts'
import type { Preferences } from './renderer-preferences.ts'
import type { RadarTimeframe } from './timeframe.ts'

export type RankedMarketRow = NativeMarketRow & { rankingChange: number | null; rankingAsOf: number | null }
export type ListProgress = { total: number; completed: number; pending: number; retrying: number; unavailable: number }
export type MarketSnapshot = {
  rows: RankedMarketRow[]; updatedAt: number | null; error: string; revision: number
  loading?: boolean; listProgress?: ListProgress; catalogSource?: 'none' | 'cache' | 'live'
  serviceSession?: string; timeframe?: RadarTimeframe; realtimeState?: string
}
export type UnchangedSnapshot = Partial<Omit<MarketSnapshot, 'rows'>> & { unchanged: true; revision: number; error: string }
export type DataAudit = {
  id?: string; phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  progress: { completed: number; total: number }
  issues: { instrument: string; timeframe: string; from: number; through: number; reason: string; repairable: boolean }[]
  error: string
}
export interface RadarDesktop {
  request(value: { preferences: { action: 'read' } | { action: 'update'; values: Partial<Preferences> } }): Promise<Preferences>
  request(value: { snapshot: { timeframe: RadarTimeframe; sinceRevision: number; serviceSession?: string } }): Promise<MarketSnapshot | UnchangedSnapshot>
  request(value: { dataAudit: { action: 'start' | 'cancel' | 'status' | 'repair' } }): Promise<DataAudit>
  request(value: { analysisSettings: AnalysisSettingsRequest }): Promise<AnalysisSettings>
  request(value: { gatewayFetch: { id: string; body: string } }): Promise<{ status: number; headers: Record<string, string> }>
  request(value: { cancelGatewayFetch: string }): Promise<{ ok: boolean }>
  request(value: { copyText: string }): Promise<{ ok: boolean }>
  request(value: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  request(value: { captureChart: ChartCaptureBounds }): Promise<{ ok: boolean }>
  request(value: { chartWindow: { instId: string; timeframe: RadarTimeframe; endHour?: number } }): Promise<PreparedChartResponse>
  request(value: { chartLocal: { instId: string; timeframe: RadarTimeframe } }): Promise<PreparedChartResponse | null>
  request(value: { chartUniverse: { instIds: string[]; timeframe: RadarTimeframe; focusInstId?: string } }): Promise<{ frames: PreparedChartResponse[] }>
}
declare global { interface Window { radarDesktop: RadarDesktop } }
