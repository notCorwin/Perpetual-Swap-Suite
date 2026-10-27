import type { CandleRecord } from './market-store.js'
export const STATISTICS_OI: 1
export const STATISTICS_TAKER: 2
export function validTakerVolumes(candle: Partial<CandleRecord>, volumes?: Partial<CandleRecord> | null): { buy: number; sell: number } | null
export function statisticsMask(row: Partial<CandleRecord>): number
export function statisticsVersionFor(sources: number): number
