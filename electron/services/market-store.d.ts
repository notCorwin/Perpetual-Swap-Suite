export type CandleRecord = {
  instrument: string
  timeframe: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  confirmed: boolean
  [key: string]: unknown
}
export class MarketStore {
  static open(root: string): Promise<MarketStore>
  appendCandles(candles: CandleRecord[]): Promise<number>
  candles(query: { instrument: string; timeframe: string; from?: number; through?: number }): Promise<CandleRecord[]>
  close(): Promise<void>
}
