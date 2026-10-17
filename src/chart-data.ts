import type { PercentageValue } from './market-percent.ts'
import type { RadarTimeframe } from './timeframe.ts'

export type Bar = {
  hour: number; open: number; high: number; low: number; close: number; confirmed: boolean
  statisticsSources?: number
  statisticsObserved?: boolean
  indicatorsObserved?: boolean
  vwap: number | null; ema: number | null; logBBUpper: number | null; logBBMiddle: number | null; logBBLower: number | null
  roc: PercentageValue; maroc: PercentageValue; rsi6: number | null; rsi12: number | null; rsi24: number | null
  oi: number | null; buy: number | null; sell: number | null
  oiUnavailableReason?: 'outside-retention' | 'not-published'
  takerUnavailableReason?: 'outside-retention' | 'not-published'
}

export type PreparedChartState = 'ready' | 'unavailable'
export type PreparedChartBar = Bar & { confirmed: true; statisticsSources: 3; statisticsObserved: true; indicatorsObserved: true }
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
  unavailable?: ChartUnavailable
  error: string
}

export type PreparedChartMeta = Readonly<{
  key: string; instId: string; timeframe: RadarTimeframe; intervalMS: number
  generation: PreparedChartGeneration; revision: number
  latestEnd: number | null; oldestHour: number | null; historyExhausted: boolean; error: string
}>

export type ReadyChartWindow = Readonly<{
  key: string; instId: string; timeframe: RadarTimeframe; intervalMS: number
  bars: readonly PreparedChartBar[]; endHour: number
  oiState: PreparedChartState; takerState: PreparedChartState; indicatorState: PreparedChartState
  liveBar?: Bar
}>

// Frozen research results share native bars, with no workspace loading protocol.
export type ChartResponse = {
  bars: Bar[]; error: string; revision: number
}
