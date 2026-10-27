import type { MarketStore } from './market-store.js'
import type { MetadataStore, Preferences } from './metadata-store.js'
import type { WebSocketFactory } from './realtime-market.js'
import type { CatalogProgress, DataAudit, HistoryDownload, RankedMarketRow } from '../../src/desktop-contract.ts'
export type { RankedMarketRow } from '../../src/desktop-contract.ts'
import type { PreparedChartResponse } from '../../src/chart-data.ts'
export type { PreparedChartBar } from '../../src/chart-data.ts'
export type PreparedChartWindow = PreparedChartResponse
export type DataAuditSnapshot = DataAudit
export type MarketServiceSnapshot = { rows: RankedMarketRow[]; turnoverOrder: string[]; revision: number; serviceSession: string; error: string; loading: boolean; updatedAt: number | null; realtimeState: 'connecting' | 'live' | 'reconnecting' | 'disconnected'; catalogSource: 'none' | 'cache' | 'live'; catalogProgress: CatalogProgress }
export class MarketService {
  constructor(store: MarketStore, preferences?: () => Readonly<Preferences>, fetcher?: typeof fetch, autoRefresh?: boolean, options?: { metadata?: MetadataStore; requestTimeout?: number; webSocketFactory?: WebSocketFactory })
  [key: string]: any
  readonly ready: Promise<MarketService>
  reconfigure(previousPreferences: Preferences): Promise<void>
  dataAuditRequest(request: { action: 'start' | 'status' | 'cancel' | 'repair' }): Promise<DataAuditSnapshot>
  subscribeAudit(listener: (report: DataAuditSnapshot) => void | Promise<void>): () => void
  historyDownloadRequest(request: { action: 'start' | 'status' | 'cancel' }): Promise<HistoryDownload>
  subscribeHistoryDownload(listener: (report: HistoryDownload) => void | Promise<void>): () => void
  invalidate(): void
  restoreCatalog(): Promise<boolean>
  refresh(options?: { reuse?: boolean }): Promise<void>
  /** Pure projection of the canonical list, including its bounded exit buffer. */
  listRowsFor(now?: number): RankedMarketRow[]
  prepareChartWindow(instId: string, timeframe: '5m' | '15m' | '1H', end?: number, historyBars?: number): Promise<PreparedChartWindow>
  getPreparedCharts(): Promise<{ frames: PreparedChartWindow[] }>
  subscribePreparedCharts(listener: (frame: PreparedChartWindow) => void): () => void
  subscribeMarket(listener: () => void): () => void
  localChartWindow(instId: string, timeframe: '5m' | '15m' | '1H'): Promise<PreparedChartWindow | null>
  localChartHistory(instId: string, timeframe: '5m' | '15m' | '1H', end?: number): Promise<PreparedChartWindow | null>
  dispose(): Promise<void>
  /** Observational IPC read: never starts provider requests or maintenance. */
  snapshot(): Promise<MarketServiceSnapshot>
  snapshot(version: { sinceRevision?: number; serviceSession?: string }): Promise<MarketServiceSnapshot | (Omit<MarketServiceSnapshot, 'rows' | 'turnoverOrder'> & { unchanged: true })>
}
