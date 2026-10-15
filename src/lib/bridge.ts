import { mockSnapshot } from '../mock-data'
import type { AppSettings, BacktestReport, BacktestRequest, DataSyncStatus, StrategyDocument, StrategySummary, ValidationReport, WorkspaceSnapshot } from '../types'

type NativeBridge = { postMessage(request: Record<string, unknown>): Promise<unknown> }

declare global {
  interface Window {
    webkit?: { messageHandlers: { suite: NativeBridge } }
  }
}

export async function requestSnapshot(request: Record<string, unknown>): Promise<WorkspaceSnapshot> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) {
    await Promise.resolve()
    if (request.method === 'settings' && request.settings) return { ...mockSnapshot, settings: request.settings as AppSettings }
    if (request.instrument) return { ...mockSnapshot, selectedInstrument: request.instrument as string }
    return mockSnapshot
  }
  return await bridge.postMessage(request) as WorkspaceSnapshot
}

export async function validateData(): Promise<ValidationReport> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { checkedFiles: 6, invalidFiles: [], duplicateCandles: 0, checkedAt: Date.now() }
  return await bridge.postMessage({ method: 'validate' }) as ValidationReport
}

const previewStrategy: StrategyDocument = {
  id: 'ema-trend-entry', name: 'EMA Trend Entry', modifiedAt: Date.now(),
  source: `export async function onTick(context) {
  if (!context.bar.confirmed || context.position) return

  const fast = context.indicators.ema(20)
  const slow = context.indicators.ema(50)
  const previousFast = context.indicators.ema(20, 1)
  const previousSlow = context.indicators.ema(50, 1)
  if ([fast, slow, previousFast, previousSlow].some(value => value == null)) return

  if (previousFast <= previousSlow && fast > slow) {
    strategy.entry('EMA Long', strategy.long, {
      marginUSDT: context.settings.initialCapitalUSDT
    })
  } else if (previousFast >= previousSlow && fast < slow) {
    strategy.entry('EMA Short', strategy.short, {
      marginUSDT: context.settings.initialCapitalUSDT
    })
  }
}`,
}

export async function listStrategies(): Promise<StrategySummary[]> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return [previewStrategy]
  return await bridge.postMessage({ method: 'strategyList' }) as StrategySummary[]
}

export async function readStrategy(id: string): Promise<StrategyDocument> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { ...previewStrategy, id }
  return await bridge.postMessage({ method: 'strategyRead', id }) as StrategyDocument
}

export async function saveStrategy(document: Pick<StrategyDocument, 'id' | 'name' | 'source'>): Promise<StrategyDocument> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { ...document, modifiedAt: Date.now() }
  return await bridge.postMessage({ method: 'strategySave', ...document }) as StrategyDocument
}

export async function runBacktest(backtest: BacktestRequest): Promise<BacktestReport> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) {
    await new Promise(resolve => setTimeout(resolve, 350))
    return mockBacktest(backtest)
  }
  return await bridge.postMessage({ method: 'backtest', backtest }) as BacktestReport
}

function mockBacktest(request: BacktestRequest): BacktestReport {
  const markers = [
    { timestamp: Date.now() - 10_800_000, price: 66_300, kind: 'long', label: 'Long' },
    { timestamp: Date.now() - 8_100_000, price: 66_980, kind: 'exit', label: 'Take profit' },
  ]
  return {
    ...request, initialCapitalUSDT: 300, finalEquityUSDT: 337.28, netProfitUSDT: 37.28,
    returnPercent: 12.43, winRatePercent: 62.5, maximumDrawdownPercent: 7.18,
    totalTrades: 8, winningTrades: 5, losingTrades: 3, liquidations: 0, markers,
    trades: Array.from({ length: 8 }, (_, index) => ({
      id: `Trade ${index + 1}`, direction: index % 3 ? 'long' as const : 'short' as const,
      entryAt: Date.now() - (index + 2) * 18_000_000, exitAt: Date.now() - (index + 1) * 17_000_000,
      entryPrice: 65_000 + index * 300, exitPrice: 65_500 + index * 280, quantityContracts: .05,
      grossPnLUSDT: index < 5 ? 11.5 : -6.7, feesUSDT: 1.2, fundingUSDT: .08,
      netPnLUSDT: index < 5 ? 10.22 : -7.98, returnOnMarginPercent: index < 5 ? 10.1 : -7.7,
      durationMS: (8 - index) * 3_600_000, maximumAdverseExcursionPercent: -0.44,
      maximumFavorableExcursionPercent: 1.18, exitReason: index < 5 ? 'Take profit' : 'Stop loss', liquidated: false,
    })),
    warnings: ['5m OHLC broker emulation does not model queue position or historical order-book capacity.'], elapsedMS: 284,
  }
}

let previewSync: DataSyncStatus = { active: false, instruments: [], completedInstruments: 0, currentInstrument: null, downloadedCandles: 0, downloadedFundingRates: 0, startedAt: null, finishedAt: null, error: null }

export async function startDataSync(instruments: string[]): Promise<DataSyncStatus> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) {
    previewSync = { active: true, instruments, completedInstruments: 0, currentInstrument: instruments[0] ?? null, downloadedCandles: 18_420, downloadedFundingRates: 292, startedAt: Date.now(), finishedAt: null, error: null }
    return previewSync
  }
  return await bridge.postMessage({ method: 'syncStart', instruments }) as DataSyncStatus
}

export async function dataSyncStatus(): Promise<DataSyncStatus> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return previewSync
  return await bridge.postMessage({ method: 'syncStatus' }) as DataSyncStatus
}

export async function cancelDataSync(): Promise<DataSyncStatus> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) {
    previewSync = { ...previewSync, active: false, currentInstrument: null, finishedAt: Date.now() }
    return previewSync
  }
  return await bridge.postMessage({ method: 'syncCancel' }) as DataSyncStatus
}

export async function aiCredentialStatus(): Promise<{ configured: boolean }> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { configured: false }
  return await bridge.postMessage({ method: 'aiStatus' }) as { configured: boolean }
}

export async function saveAIKey(key: string): Promise<{ configured: boolean }> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { configured: Boolean(key.trim()) }
  return await bridge.postMessage({ method: 'aiSaveKey', key }) as { configured: boolean }
}

export async function nativeAIFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = input instanceof Request ? input : new Request(input, init)
  const body = source.body ? await source.clone().text() : null
  const request = { url: source.url, method: source.method, headers: Object.fromEntries(source.headers.entries()), body }
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return new Response(JSON.stringify({ error: { message: 'AI requests are available in the packaged macOS application.' } }), { status: 503, headers: { 'content-type': 'application/json' } })
  const result = await bridge.postMessage({ method: 'aiFetch', request }) as { status: number; headers: Record<string, string>; body: string }
  return new Response(result.body, { status: result.status, headers: result.headers })
}
