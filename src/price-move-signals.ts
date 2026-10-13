export type PriceMoveDirection = 'long' | 'short'
export type PriceMoveMode = 'close' | 'highLow'

export type PriceMoveSignal = {
  direction: PriceMoveDirection
  hour: number
  exitHour: number
  entryPrice: number
  exitPrice: number
  changePercent: number
  periods: number
}

type PriceBar = { hour: number; close: number; high?: number; low?: number; confirmed: boolean }

const HOUR_MS = 3_600_000
const change = (from: number, to: number) => (to - from) / Math.abs(from) * 100

function stronger(candidate: PriceMoveSignal, current: PriceMoveSignal | null): boolean {
  if (!current) return true
  const amplitude = Math.abs(candidate.changePercent) - Math.abs(current.changePercent)
  if (amplitude !== 0) return amplitude > 0
  if (candidate.periods !== current.periods) return candidate.periods < current.periods
  if (candidate.hour !== current.hour) return candidate.hour < current.hour
  return candidate.direction === 'long' && current.direction === 'short'
}

// Deliberately uses hindsight. Every valid pair of completed candles is
// considered, then exactly one move wins lexicographically: greatest absolute
// signed relative change first, fewest candle periods second.
function strongestSegmentMove(bars: PriceBar[], thresholdPercent: number, mode: PriceMoveMode): PriceMoveSignal | null {
  let best: PriceMoveSignal | null = null
  const consider = (direction: PriceMoveDirection, start: number, end: number, entryPrice: number, exitPrice: number) => {
    const changePercent = change(entryPrice, exitPrice)
    if (direction === 'long' ? changePercent <= thresholdPercent : changePercent >= -thresholdPercent) return
    const candidate: PriceMoveSignal = { direction, hour: bars[start].hour, exitHour: bars[end].hour,
      entryPrice, exitPrice, changePercent, periods: end - start }
    if (stronger(candidate, best)) best = candidate
  }
  for (let start = 0; start < bars.length - 1; start++) {
    for (let end = start + 1; end < bars.length; end++) {
      if (mode === 'close') {
        const direction = bars[end].close > bars[start].close ? 'long' : 'short'
        consider(direction, start, end, bars[start].close, bars[end].close)
      } else {
        consider('long', start, end, bars[start].low!, bars[end].high!)
        consider('short', start, end, bars[start].high!, bars[end].low!)
      }
    }
  }
  return best
}

export function capturePriceMoves(input: PriceBar[], thresholdPercent = 1, mode: PriceMoveMode = 'close'): PriceMoveSignal[] {
  const valid = (bar: PriceBar) => bar.confirmed && Number.isFinite(bar.close) && bar.close > 0 && Number.isFinite(bar.hour)
    && (mode === 'close' || (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high! >= bar.low! && bar.low! > 0))
  const bars = [...new Map(input.filter(valid).map(bar => [bar.hour, bar])).values()].sort((a, b) => a.hour - b.hour)
  let best: PriceMoveSignal | null = null
  let segment: PriceBar[] = []
  const finish = () => {
    const candidate = strongestSegmentMove(segment, thresholdPercent, mode)
    if (candidate && stronger(candidate, best)) best = candidate
    segment = []
  }
  for (const bar of bars) {
    if (segment.length && bar.hour - segment.at(-1)!.hour !== HOUR_MS) finish()
    segment.push(bar)
  }
  finish()
  return best ? [best] : []
}
