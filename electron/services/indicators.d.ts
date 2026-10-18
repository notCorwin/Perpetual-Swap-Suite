export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; baseVolume?: number | null; quoteVolume?: number | null; confirmed: boolean; oi?: number | null; buy?: number | null; sell?: number | null }
export type IndicatorBar = { hour: number; quoteVolume: number | null; open: number; high: number; low: number; close: number; confirmed: boolean; vwap: number | null; ema: number | null; bollUpper: number | null; bollMiddle: number | null; bollLower: number | null; roc: number | null; maroc: number | null; rsi6: number | null; rsi12: number | null; rsi24: number | null; oi: number | null; buy: number | null; sell: number | null; bandPosition: 'upper' | 'middle' | 'lower' | 'below' | null; rocChange: number | null; marocChange: number | null }
export type IndicatorState = {
  intervalMS: number
  lastTimestamp: number | null
  count: number
  previousClose: number | null
  emaSeedSum: number
  ema: number | null
  closes: number[]
  volumes: { typicalPrice: number; volume: number | null }[]
  rocs: (number | null)[]
  previousROC: number | null
  previousMAROC: number | null
  rsi: { period: number; gains: number; losses: number }[]
}
export function createIndicatorState(intervalMS?: number): IndicatorState
export function appendIndicatorCandle(state: IndicatorState, candle: Candle): IndicatorBar | null
export function projectIndicatorCandle(state: IndicatorState, candle: Candle): IndicatorBar | null
export function buildIndicatorSeries(candles: Candle[], intervalMS?: number): { bars: IndicatorBar[]; state: IndicatorState }
export function barsWithIndicators(candles: Candle[], intervalMS?: number): IndicatorBar[]
