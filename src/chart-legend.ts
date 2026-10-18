import type { Bar } from './chart-data.ts'

type StatisticsBar = Pick<Bar, 'hour' | 'oi' | 'buy' | 'sell'>
const finite = (value: number | null) => value !== null && Number.isFinite(value)

// Source families arrive independently. A default legend describes each family's
// latest visible observation; inspection always describes the exact candle.
export function chartStatisticsSamples(bars: readonly StatisticsBar[], inspected: number | null) {
  let oi: StatisticsBar | null = null
  let taker: StatisticsBar | null = null
  for (let index = inspected ?? bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index]
    if (!bar) break
    if (!oi && finite(bar.oi)) oi = bar
    if (!taker && finite(bar.buy) && finite(bar.sell)) taker = bar
    if (inspected !== null || oi && taker) break
  }
  return { oi, taker }
}
