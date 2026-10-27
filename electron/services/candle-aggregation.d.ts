import type { CandleRecord } from './market-store.js'
export function aggregatePriceCandles(rows: CandleRecord[], timeframe: string, options?: { forming?: boolean }): CandleRecord | null
