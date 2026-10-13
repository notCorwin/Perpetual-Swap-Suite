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
type Point = { index: number; bar: PriceBar }

const HOUR_MS = 3_600_000

const change = (from: number, to: number) => (to - from) / Math.abs(from) * 100

// This is deliberately a hindsight labeler, not a trading signal. A move stays
// open until price reverses by more than the threshold, preserving the largest
// swing first. Equal extrema use the shortest entry-to-exit candle span.
function captureSegment(bars: PriceBar[], thresholdPercent: number, mode: PriceMoveMode): PriceMoveSignal[] {
  if (bars.length < 2) return []
  const output: PriceMoveSignal[] = []
  let direction: PriceMoveDirection | null = null
  let low: Point = { index: 0, bar: bars[0] }
  let high: Point = { index: 0, bar: bars[0] }
  let entry: Point = low
  let extremeFirst: Point = low
  let extremeLast: Point = low
  const lowPrice = (point: Point) => mode === 'highLow' ? point.bar.low! : point.bar.close
  const highPrice = (point: Point) => mode === 'highLow' ? point.bar.high! : point.bar.close

  const append = (moveDirection: PriceMoveDirection, from: Point, to: Point) => {
    const entryPrice = moveDirection === 'long' ? lowPrice(from) : highPrice(from)
    const exitPrice = moveDirection === 'long' ? highPrice(to) : lowPrice(to)
    const changePercent = change(entryPrice, exitPrice)
    if (Math.abs(changePercent) <= thresholdPercent || to.index <= from.index) return
    output.push({ direction: moveDirection, hour: from.bar.hour, exitHour: to.bar.hour,
      entryPrice, exitPrice, changePercent, periods: to.index - from.index })
  }

  for (let index = 1; index < bars.length; index++) {
    const point: Point = { index, bar: bars[index] }
    if (direction === null) {
      const candidates = [
        { direction: 'long' as const, entry: low, change: change(lowPrice(low), highPrice(point)) },
        { direction: 'short' as const, entry: high, change: change(highPrice(high), lowPrice(point)) },
      ].filter(candidate => candidate.entry.index < index && (candidate.direction === 'long'
        ? candidate.change > thresholdPercent : candidate.change < -thresholdPercent))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || (index - a.entry.index) - (index - b.entry.index))
      const candidate = candidates[0]
      if (candidate) {
        direction = candidate.direction; entry = candidate.entry; extremeFirst = point; extremeLast = point
      } else {
        if (lowPrice(point) <= lowPrice(low)) low = point
        if (highPrice(point) >= highPrice(high)) high = point
      }
      continue
    }

    if (direction === 'long') {
      if (highPrice(point) > highPrice(extremeFirst)) extremeFirst = extremeLast = point
      else if (highPrice(point) === highPrice(extremeFirst)) extremeLast = point
      if (change(highPrice(extremeFirst), lowPrice(point)) < -thresholdPercent) {
        append('long', entry, extremeFirst)
        direction = 'short'; entry = extremeLast; extremeFirst = point; extremeLast = point
      }
    } else {
      if (lowPrice(point) < lowPrice(extremeFirst)) extremeFirst = extremeLast = point
      else if (lowPrice(point) === lowPrice(extremeFirst)) extremeLast = point
      if (change(lowPrice(extremeFirst), highPrice(point)) > thresholdPercent) {
        append('short', entry, extremeFirst)
        direction = 'long'; entry = extremeLast; extremeFirst = point; extremeLast = point
      }
    }
  }
  if (direction) append(direction, entry, extremeFirst)
  return output
}

export function capturePriceMoves(input: PriceBar[], thresholdPercent = 1, mode: PriceMoveMode = 'close'): PriceMoveSignal[] {
  const valid = (bar: PriceBar) => bar.confirmed && Number.isFinite(bar.close) && bar.close > 0 && Number.isFinite(bar.hour)
    && (mode === 'close' || (Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.high! >= bar.low! && bar.low! > 0))
  const bars = [...new Map(input.filter(valid)
    .map(bar => [bar.hour, bar])).values()].sort((a, b) => a.hour - b.hour)
  const output: PriceMoveSignal[] = []
  let segment: PriceBar[] = []
  for (const bar of bars) {
    if (segment.length && bar.hour - segment.at(-1)!.hour !== HOUR_MS) {
      output.push(...captureSegment(segment, thresholdPercent, mode)); segment = []
    }
    segment.push(bar)
  }
  output.push(...captureSegment(segment, thresholdPercent, mode))
  return output.sort((a, b) => a.hour - b.hour)
}
