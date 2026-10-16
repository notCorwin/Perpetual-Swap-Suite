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
  coverage(instrument: string, timeframe: string): Promise<{ count: number; first: number | null; last: number | null }>
  close(): Promise<void>
}
