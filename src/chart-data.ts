import type { PercentageValue } from './market-percent.ts'
import type { RadarTimeframe } from './timeframe.ts'

export type Bar = {
  hour: number; open: number; high: number; low: number; close: number; confirmed: boolean
  statisticsSources?: number
  statisticsObserved?: boolean
  oiObserved?: boolean
  takerObserved?: boolean
  indicatorsObserved?: boolean
  vwap: number | null; ema: number | null; bollUpper: number | null; bollMiddle: number | null; bollLower: number | null
  roc: PercentageValue; maroc: PercentageValue; rsi6: number | null; rsi12: number | null; rsi24: number | null
  oi: number | null; buy: number | null; sell: number | null
  oiUnavailableReason?: 'not-published'
  takerUnavailableReason?: 'not-published'
}

export type PreparedChartState = 'ready' | 'partial' | 'loading' | 'stale' | 'unavailable'
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
  priceAsOf?: number | null; priceObservedAt?: number | null; realtimeState?: 'live' | 'stale'; sourceVersions?: { price: number; oi: number; taker: number }
}>

export type ReadyChartWindow = Readonly<{
  key: string; instId: string; timeframe: RadarTimeframe; intervalMS: number
  generation: PreparedChartGeneration
  bars: readonly PreparedChartBar[]; endHour: number
  oiState: PreparedChartState; takerState: PreparedChartState; indicatorState: PreparedChartState
  liveBar?: Bar
  priceState?: PreparedChartState
  priceAsOf?: number | null
  priceObservedAt?: number | null
  realtimeState?: 'live' | 'stale'
  sourceVersions?: { price: number; oi: number; taker: number }
}>
