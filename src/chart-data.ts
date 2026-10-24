import type { PercentageValue } from './market-percent.ts'
import type { RadarTimeframe } from './timeframe.ts'

export type Bar = {
  hour: number; open: number; high: number; low: number; close: number; confirmed: boolean
  /** Source completeness includes native base and quote volumes. */
  priceComplete?: boolean
  statisticsSources?: number
  statisticsObserved?: boolean
  oiObserved?: boolean
  takerObserved?: boolean
  indicatorsObserved?: boolean
  vwap: number | null; ema: number | null; bollUpper: number | null; bollMiddle: number | null; bollLower: number | null
  roc: PercentageValue; maroc: PercentageValue; rsi6: number | null; rsi12: number | null; rsi24: number | null
  atrPercent: number | null; bbw: number | null
  oi: number | null; buy: number | null; sell: number | null
  oiUnavailableReason?: 'not-published'
  takerUnavailableReason?: 'not-published'
}

export type PreparedChartState = 'ready' | 'partial' | 'loading' | 'stale' | 'unavailable' | 'error'
export type ChartSourceStatus = Readonly<{
  state: PreparedChartState; from: number; through: number | null
  error?: string; retryAt?: number; reason?: 'not-published' | 'unsupported' | 'insufficient-history' | 'undefined-value'
  /** Exact recursive input basis; unrelated statistic/quote updates do not change it. */
  inputVersion?: string
  retryOn?: 'input-change' | 'worker-recovery'
}>
/** Both navigation and presentation require the same complete source slots. */
export const completeChartPriceRange = (bars: readonly Pick<Bar, 'hour' | 'priceComplete'>[], from: number, through: number, intervalMS: number) =>
  bars.length === (through - from) / intervalMS + 1
  && bars.every((bar, index) => bar.hour === from + index * intervalMS && bar.priceComplete !== false)
export type PreparedChartBar = Bar & { confirmed: true }
export type PreparedChartGeneration = number
export type ChartUnavailable = Readonly<{ reason: 'insufficient-history'; availableCandles: number; requiredCandles: 96; retryAt: number }>
export type PreparedChartResponse = {
  instId: string
  timeframe: RadarTimeframe
  intervalMS: number
  endHour: number | null
  latestEnd: number | null
  oldestHour: number | null
  historyExhausted: boolean
  generation: PreparedChartGeneration
  revision: number
  bars: PreparedChartBar[]
  priceStatus?: ChartSourceStatus
  oiStatus?: ChartSourceStatus
  takerStatus?: ChartSourceStatus
  indicatorStatus?: ChartSourceStatus
  oiState: PreparedChartState
  takerState: PreparedChartState
  indicatorState: PreparedChartState
  liveBar?: Bar
  priceState?: PreparedChartState
  priceAsOf?: number | null
  priceObservedAt?: number | null
  realtimeState?: 'live' | 'stale'
  sourceVersions?: { price: number; oi: number; taker: number }
  unavailable?: ChartUnavailable
  error: string
}

export type PreparedChartLiveUpdate = {
  type: 'live'
  instId: string
  timeframe: RadarTimeframe
  generation: PreparedChartGeneration
  revision: number
  endHour: number
  liveBar: Bar | null
  priceObservedAt?: number | null
  realtimeState?: 'live' | 'stale'
  priceState?: PreparedChartState
  priceAsOf?: number | null
  sourceVersions?: { price: number; oi: number; taker: number }
}
export type PreparedChartNotification = PreparedChartResponse | PreparedChartLiveUpdate

export type PreparedChartMeta = Readonly<{
  key: string; instId: string; timeframe: RadarTimeframe; intervalMS: number
  generation: PreparedChartGeneration; revision: number
  latestEnd: number | null; oldestHour: number | null; historyExhausted: boolean; error: string
  sourceStatuses?: readonly Readonly<{ source: 'price' | 'oi' | 'taker' | 'indicator'; status: ChartSourceStatus }>[]
  priceStatus?: ChartSourceStatus
  oiStatus?: ChartSourceStatus
  takerStatus?: ChartSourceStatus
  indicatorStatus?: ChartSourceStatus
  priceState?: PreparedChartState
  priceAsOf?: number | null; priceObservedAt?: number | null; realtimeState?: 'live' | 'stale'; sourceVersions?: { price: number; oi: number; taker: number }
}>

export type ReadyChartWindow = Readonly<{
  key: string; instId: string; timeframe: RadarTimeframe; intervalMS: number
  generation: PreparedChartGeneration
  bars: readonly PreparedChartBar[]; endHour: number
  priceStatus?: ChartSourceStatus
  oiStatus?: ChartSourceStatus
  takerStatus?: ChartSourceStatus
  indicatorStatus?: ChartSourceStatus
  oiState: PreparedChartState; takerState: PreparedChartState; indicatorState: PreparedChartState
  liveBar?: Bar
  priceState?: PreparedChartState
  priceAsOf?: number | null
  priceObservedAt?: number | null
  realtimeState?: 'live' | 'stale'
  sourceVersions?: { price: number; oi: number; taker: number }
}>
