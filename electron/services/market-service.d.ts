import type { MarketStore } from './market-store.js'
import type { MetadataStore, Preferences } from './metadata-store.js'
import type { WebSocketFactory } from './realtime-market.js'
import type { CatalogProgress, DataAudit } from '../../src/desktop-contract.ts'
import type { NativeMarketRow } from '../../src/market-row.ts'
import type { PreparedChartResponse } from '../../src/chart-data.ts'
export type { PreparedChartBar } from '../../src/chart-data.ts'
export type PreparedChartWindow = PreparedChartResponse
export type DataAuditSnapshot = DataAudit
export type RankedMarketRow = NativeMarketRow & { rankingChange: number | null; rankingAsOf: number | null }
export type MarketServiceSnapshot = { rows: RankedMarketRow[]; revision: number; serviceSession: string; error: string; loading: boolean; updatedAt: number | null; timeframe: '5m' | '15m' | '1H'; realtimeState: 'connecting' | 'live' | 'reconnecting' | 'disconnected'; catalogSource: 'none' | 'cache' | 'live'; catalogProgress: CatalogProgress; listProgress: { total: number; completed: number; pending: number; retrying: number; unavailable: number } }
export class MarketService {
  constructor(store: MarketStore, preferences?: () => Readonly<Preferences>, fetcher?: typeof fetch, autoRefresh?: boolean, options?: { metadata?: MetadataStore; requestTimeout?: number; webSocketFactory?: WebSocketFactory })
  [key: string]: any
  readonly ready: Promise<MarketService>
  reconfigure(previousPreferences: Preferences): Promise<void>
  dataAuditRequest(request: { action: 'start' | 'status' | 'cancel' | 'repair' }): Promise<DataAuditSnapshot>
  subscribeAudit(listener: (report: DataAuditSnapshot) => void | Promise<void>): () => void
  invalidate(): void
  restoreCatalog(): Promise<boolean>
  refresh(): Promise<void>
  /** Pure projection of current facts; an inactive timeframe does not admit work. */
  listRowsFor(timeframe: '5m' | '15m' | '1H', now?: number): RankedMarketRow[]
  prepareChartWindow(instId: string, timeframe: '5m' | '15m' | '1H', end?: number, historyBars?: number): Promise<PreparedChartWindow>
  setChartUniverse(instIds: string[], timeframe: '5m' | '15m' | '1H', focusInstId?: string): Promise<{ frames: PreparedChartWindow[] }>
  subscribePreparedCharts(listener: (frame: PreparedChartWindow) => void): () => void
  subscribeMarket(listener: () => void): () => void
  localChartWindow(instId: string, timeframe: '5m' | '15m' | '1H'): Promise<PreparedChartWindow | null>
  localChartHistory(instId: string, timeframe: '5m' | '15m' | '1H', end?: number): Promise<PreparedChartWindow | null>
  dispose(): Promise<void>
  /** Observational IPC read: never starts provider requests or maintenance. */
  snapshot(timeframe?: '5m' | '15m' | '1H'): Promise<MarketServiceSnapshot>
  snapshot(timeframe: '5m' | '15m' | '1H', version: { sinceRevision?: number; serviceSession?: string }): Promise<MarketServiceSnapshot | (Omit<MarketServiceSnapshot, 'rows'> & { unchanged: true })>
}
