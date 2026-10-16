export type PriceMoveDirection = 'long' | 'short'
export type PriceMoveMode = 'close' | 'highLow'
export type PriceMoveObjective = 'amplitude' | 'efficiency'

export type PriceMoveSignal = {
  direction: PriceMoveDirection
  hour: number
  exitHour: number
  entryPrice: number
  exitPrice: number
  changePercent: number
  periods: number
  efficiencyScore: number
  rank: number
}

type PriceBar = { hour: number; close: number; high?: number; low?: number; confirmed: boolean }

const HOUR_MS = 3_600_000
const change = (from: number, to: number) => (to - from) / Math.abs(from) * 100

function compareMoves(candidate: PriceMoveSignal, current: PriceMoveSignal, objective: PriceMoveObjective): number {
  if (objective === 'efficiency') {
    const efficiency = candidate.efficiencyScore - current.efficiencyScore
    if (efficiency !== 0) return efficiency > 0 ? -1 : 1
  }
  const amplitude = Math.abs(candidate.changePercent) - Math.abs(current.changePercent)
  if (amplitude !== 0) return amplitude > 0 ? -1 : 1
  if (candidate.periods !== current.periods) return candidate.periods - current.periods
  if (candidate.hour !== current.hour) return candidate.hour - current.hour
  return candidate.direction === current.direction ? 0 : candidate.direction === 'long' ? -1 : 1
}

// Deliberately uses hindsight. Every valid pair of completed candles is
// considered, then exactly one move wins the selected lexicographic objective:
// total amplitude, or absolute signed relative change per candle period.
function segmentMoves(bars: PriceBar[], thresholdPercent: number, mode: PriceMoveMode, efficiencyFactor: number): PriceMoveSignal[] {
  const output: PriceMoveSignal[] = []
  const consider = (direction: PriceMoveDirection, start: number, end: number, entryPrice: number, exitPrice: number) => {
    const changePercent = change(entryPrice, exitPrice)
    if (direction === 'long' ? changePercent <= thresholdPercent : changePercent >= -thresholdPercent) return
    const periods = end - start
    const candidate: PriceMoveSignal = { direction, hour: bars[start].hour, exitHour: bars[end].hour,
      entryPrice, exitPrice, changePercent, periods, efficiencyScore: Math.abs(changePercent) / Math.pow(periods, efficiencyFactor), rank: 0 }
    output.push(candidate)
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
  return output
}

export function capturePriceMoves(input: PriceBar[], thresholdPercent = 1, mode: PriceMoveMode = 'close', objective: PriceMoveObjective = 'amplitude', efficiencyFactor = 1, intervalMS = HOUR_MS): PriceMoveSignal[] {
  if (!Number.isFinite(efficiencyFactor) || efficiencyFactor < 0 || efficiencyFactor > 2) efficiencyFactor = 1
  const valid = (bar: PriceBar) => bar.confirmed && Number.isFinite(bar.close) && bar.close > 0 && Number.isFinite(bar.hour)
    && (mode === 'close' || (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high! >= bar.low! && bar.low! > 0))
  const bars = [...new Map(input.filter(valid).map(bar => [bar.hour, bar])).values()].sort((a, b) => a.hour - b.hour)
  const candidates: PriceMoveSignal[] = []
  let segment: PriceBar[] = []
  const finish = () => {
    candidates.push(...segmentMoves(segment, thresholdPercent, mode, efficiencyFactor))
    segment = []
  }
  for (const bar of bars) {
    if (segment.length && bar.hour - segment.at(-1)!.hour !== intervalMS) finish()
    segment.push(bar)
  }
  finish()
  candidates.sort((a, b) => compareMoves(a, b, objective))
  const selected: PriceMoveSignal[] = []
  for (const candidate of candidates) {
    const overlaps = selected.some(existing => candidate.hour < existing.exitHour && candidate.exitHour > existing.hour)
    if (!overlaps) selected.push({ ...candidate, rank: selected.length + 1 })
  }
  return selected.sort((a, b) => a.hour - b.hour || a.exitHour - b.exitHour)
}
