export type PriceMoveDirection = 'long' | 'short'

export type PriceMoveSignal = {
  direction: PriceMoveDirection
  hour: number
  exitHour: number
  entryPrice: number
  exitPrice: number
  changePercent: number
  periods: number
}

type PriceBar = { hour: number; close: number; confirmed: boolean }
type Point = { index: number; bar: PriceBar }

const HOUR_MS = 3_600_000

const change = (from: number, to: number) => (to - from) / Math.abs(from) * 100

// This is deliberately a hindsight labeler, not a trading signal. A move stays
// open until price reverses by more than the threshold, preserving the largest
// swing first. Equal extrema use the shortest entry-to-exit candle span.
function captureSegment(bars: PriceBar[], thresholdPercent: number): PriceMoveSignal[] {
  if (bars.length < 2) return []
  const output: PriceMoveSignal[] = []
  let direction: PriceMoveDirection | null = null
  let low: Point = { index: 0, bar: bars[0] }
  let high: Point = { index: 0, bar: bars[0] }
  let entry: Point = low
  let extremeFirst: Point = low
  let extremeLast: Point = low

  const append = (moveDirection: PriceMoveDirection, from: Point, to: Point) => {
    const changePercent = change(from.bar.close, to.bar.close)
    if (Math.abs(changePercent) <= thresholdPercent || to.index <= from.index) return
    output.push({ direction: moveDirection, hour: from.bar.hour, exitHour: to.bar.hour,
      entryPrice: from.bar.close, exitPrice: to.bar.close, changePercent, periods: to.index - from.index })
  }

  for (let index = 1; index < bars.length; index++) {
    const point: Point = { index, bar: bars[index] }
    if (direction === null) {
      if (point.bar.close <= low.bar.close) low = point
      if (point.bar.close >= high.bar.close) high = point
      const longChange = low.index < index ? change(low.bar.close, point.bar.close) : 0
      const shortChange = high.index < index ? change(high.bar.close, point.bar.close) : 0
      if (longChange > thresholdPercent) {
        direction = 'long'; entry = low; extremeFirst = point; extremeLast = point
      } else if (shortChange < -thresholdPercent) {
        direction = 'short'; entry = high; extremeFirst = point; extremeLast = point
      }
      continue
    }

    if (direction === 'long') {
      if (point.bar.close > extremeFirst.bar.close) extremeFirst = extremeLast = point
      else if (point.bar.close === extremeFirst.bar.close) extremeLast = point
      if (change(extremeFirst.bar.close, point.bar.close) < -thresholdPercent) {
        append('long', entry, extremeFirst)
        direction = 'short'; entry = extremeLast; extremeFirst = point; extremeLast = point
      }
    } else {
      if (point.bar.close < extremeFirst.bar.close) extremeFirst = extremeLast = point
      else if (point.bar.close === extremeFirst.bar.close) extremeLast = point
      if (change(extremeFirst.bar.close, point.bar.close) > thresholdPercent) {
        append('short', entry, extremeFirst)
        direction = 'long'; entry = extremeLast; extremeFirst = point; extremeLast = point
      }
    }
  }
  if (direction) append(direction, entry, extremeFirst)
  return output
}

export function capturePriceMoves(input: PriceBar[], thresholdPercent = 1): PriceMoveSignal[] {
  const bars = [...new Map(input.filter(bar => bar.confirmed && Number.isFinite(bar.close) && bar.close > 0 && Number.isFinite(bar.hour))
    .map(bar => [bar.hour, bar])).values()].sort((a, b) => a.hour - b.hour)
  const output: PriceMoveSignal[] = []
  let segment: PriceBar[] = []
  for (const bar of bars) {
    if (segment.length && bar.hour - segment.at(-1)!.hour !== HOUR_MS) {
      output.push(...captureSegment(segment, thresholdPercent)); segment = []
    }
    segment.push(bar)
  }
  output.push(...captureSegment(segment, thresholdPercent))
  return output.sort((a, b) => a.hour - b.hour)
}
