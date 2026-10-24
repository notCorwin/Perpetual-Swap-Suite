import { chartAxis, chartAxisForLabels, logarithmicChartAxis, logarithmicScale } from './chart-axis.ts'
import { chartCandleWidth, chartHourX, chartLayout } from './chart-layout.ts'
import type { Bar } from './chart-data.ts'
import { finitePercentage, formatPercent } from './market-percent.ts'
import { measureOperation } from '../electron/services/operations.js'
import { chartRsiCrossings } from './rsi-crossings.ts'

const compactFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5, notation: 'compact' })
const priceFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 })
const axisFormatters = new Map<number, Intl.NumberFormat>()
export const chartCompact = (value: number | null) => value === null ? '—' : compactFormatter.format(value)
export const chartPrice = (value: number | null) => value === null ? '—' : priceFormatter.format(value)
export const chartPercent = (value: number | null, decimals = 2) => value === null ? '—' : `${value.toFixed(decimals)}%`
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const priceFields = ['low', 'high', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower'] as const
const lineFields = ['bollUpper', 'bollMiddle', 'bollLower', 'vwap', 'ema', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'roc', 'maroc', 'oi'] as const
const axisLabelLimit = (panel: readonly [number, number], maximum: number) =>
  Math.min(maximum, Math.max(2, Math.floor((panel[1] - panel[0]) / 32) + 1))
const axisFormatter = (decimals: number) => {
  let formatter = axisFormatters.get(decimals)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    axisFormatters.set(decimals, formatter)
  }
  return formatter
}

type Range = readonly [number, number]
export type ChartGeometryOptions = Readonly<{ width: number; height: number; endHour: number; intervalMS: number; liveClose?: number }>
const linearScale = (min: number, max: number, panel: Range) => {
  const span = max - min || 1, height = panel[1] - panel[0]
  return (value: number) => panel[1] - (value - min) / span * height
}
const paddedIndicatorRange = (min: number, max: number) => {
  if (!Number.isFinite(min)) return { min: 0, max: 1 }
  const padding = (max - min || max || 1) * 0.05
  return { min: Math.max(0, min - padding), max: max + padding }
}

/** One immutable viewport owns its axes, coordinates and paths. */
function buildGeometry(bars: readonly Bar[], options: ChartGeometryOptions, measureText: (text: string) => number) {
  const { width, height, endHour, intervalMS, liveClose } = options
  const firstHour = endHour - 95 * intervalMS, firstAtLeft = bars[0].hour === firstHour
  let priceMin = Infinity, priceMax = -Infinity, rocExtent = 0, minATR = Infinity, maxATR = 0, minBBW = Infinity, maxBBW = 0, maxTaker = 1
  let candleHigh = -Infinity, candleLow = Infinity, highIndex = 0, lowIndex = 0
  const oiSamples: { index: number; value: number }[] = []
  for (const [index, bar] of bars.entries()) {
    for (const field of priceFields) {
      const value = bar[field]
      if (finite(value)) { priceMin = Math.min(priceMin, value); priceMax = Math.max(priceMax, value) }
    }
    for (const value of [finitePercentage(bar.roc), finitePercentage(bar.maroc)]) if (value !== null) rocExtent = Math.max(rocExtent, Math.abs(value))
    if (finite(bar.atrPercent)) { minATR = Math.min(minATR, bar.atrPercent); maxATR = Math.max(maxATR, bar.atrPercent) }
    if (finite(bar.bbw)) { minBBW = Math.min(minBBW, bar.bbw); maxBBW = Math.max(maxBBW, bar.bbw) }
    if (finite(bar.oi)) oiSamples.push({ index, value: bar.oi })
    maxTaker = Math.max(maxTaker, (finite(bar.buy) ? bar.buy : 0) + (finite(bar.sell) ? bar.sell : 0))
    if (bar.high > candleHigh) { candleHigh = bar.high; highIndex = index }
    if (bar.low < candleLow) { candleLow = bar.low; lowIndex = index }
  }
  if (finite(liveClose)) { priceMin = Math.min(priceMin, liveClose); priceMax = Math.max(priceMax, liveClose) }
  // Panel heights do not depend on the label gutter, so each axis is computed
  // once and shared by both the gutter measurement and the final plot.
  const { panels } = chartLayout(0, height)
  const priceLabels = axisLabelLimit(panels.price, 9)
  const priceAxis = priceMin <= 0
    ? { ...chartAxisForLabels(priceMin, priceMax, priceLabels), kind: 'linear' as const }
    : { ...logarithmicChartAxis(priceMin, priceMax, priceLabels), kind: 'logarithmic' as const }
  const axisPrice = axisFormatter(priceAxis.decimals)
  const rocAxis = chartAxis(-(rocExtent || 1), rocExtent || 1, 8)
  const atrRange = paddedIndicatorRange(minATR, maxATR), bbwRange = paddedIndicatorRange(minBBW, maxBBW)
  const oiValues = oiSamples.map(sample => sample.value)
  const oiAxis = oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true) : null
  const takerAxis = chartAxisForLabels(0, maxTaker, axisLabelLimit(panels.taker, 7))
  const priceLabelsText = priceAxis.ticks.map(tick => axisPrice.format(tick))
  const oiLabelsText = oiAxis?.ticks.map(chartCompact) ?? [], takerLabelsText = takerAxis.ticks.map(chartCompact)
  const labels = [
    ...priceLabelsText,
    formatPercent(rocAxis.max, rocAxis.decimals), formatPercent(rocAxis.min, rocAxis.decimals), '100', '0',
    ...oiLabelsText, ...takerLabelsText,
    `${chartPrice(liveClose ?? bars.at(-1)!.close)} ↑`, '00:00',
  ]
  const gutter = Math.ceil(Math.max(...labels.map(measureText)) + 16)
  const layout = chartLayout(width, height, gutter), { left, right } = layout
  const x = bars.map(bar => chartHourX(bar.hour, endHour, left, right, intervalMS))
  const barWidth = chartCandleWidth(right - left)
  const priceY = priceAxis.kind === 'linear' ? linearScale(priceAxis.min, priceAxis.max, panels.price) : logarithmicScale(priceAxis, panels.price)
  const rsiY = linearScale(0, 100, panels.rsi), rocY = linearScale(rocAxis.min, rocAxis.max, panels.roc)
  const rsiCrossings = chartRsiCrossings(bars, intervalMS)
  const rsiMarkers: (typeof rsiCrossings[number] & { levels: (30 | 70)[]; x: number; y: number; d: string })[] = []
  for (const crossing of rsiCrossings) {
    const previous = rsiMarkers.at(-1)
    if (previous?.index === crossing.index && previous.field === crossing.field) { previous.levels.push(crossing.level); continue }
    const pointX = x[crossing.index], pointY = rsiY(crossing.value), baseY = pointY + (crossing.direction === 'up' ? 5 : -5)
    rsiMarkers.push({ ...crossing, levels: [crossing.level], x: pointX, y: pointY,
      d: `M${pointX.toFixed(1)} ${pointY.toFixed(1)} L${(pointX - 3.5).toFixed(1)} ${baseY.toFixed(1)} L${(pointX + 3.5).toFixed(1)} ${baseY.toFixed(1)} Z` })
  }
  const atrY = linearScale(atrRange.min, atrRange.max, panels.atr)
  const bbwY = linearScale(bbwRange.min, bbwRange.max, panels.atr)
  const oiY = oiAxis ? logarithmicScale(oiAxis, panels.oi) : () => NaN
  const takerY = linearScale(takerAxis.min, takerAxis.max, panels.taker), rocZeroY = rocY(0)
  const line = (key: typeof lineFields[number], y: (value: number) => number) => {
    const segments: string[] = []
    let segment = ''
    bars.forEach((bar, index) => {
      const value = bar[key], pointY = finite(value) ? y(value) : NaN
      if (!Number.isFinite(pointY) || index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) {
        if (segment) segments.push(segment)
        segment = ''
        if (!Number.isFinite(pointY)) return
      }
      if (index === 0 && firstAtLeft) segment = `M${left} ${pointY.toFixed(1)}`
      segment += `${segment ? ' L' : 'M'}${x[index].toFixed(1)} ${pointY.toFixed(1)}`
    })
    if (segment) segments.push(segment)
    return segments.join(' ')
  }
  const lines = Object.fromEntries(lineFields.map(field => [field, line(field,
    field.startsWith('rsi') ? rsiY : field === 'atrPercent' ? atrY : field === 'bbw' ? bbwY : field === 'roc' || field === 'maroc' ? rocY : field === 'oi' ? oiY : priceY)])) as Record<typeof lineFields[number], string>
  const rocArea = (key: 'roc' | 'maroc') => {
    const segments: string[] = []
    let points: [number, number][] = []
    const finish = () => {
      if (points.length > 1) {
        const firstX = points[0][0], lastX = points.at(-1)![0]
        segments.push(`M${firstX} ${rocZeroY} L${points.map(([pointX, pointY]) => `${pointX} ${pointY}`).join(' L')} L${lastX} ${rocZeroY} Z`)
      }
      points = []
    }
    bars.forEach((bar, index) => {
      const value = finitePercentage(bar[key])
      if (value === null || index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) finish()
      if (value === null) return
      const pointY = Number(rocY(value).toFixed(1))
      if (index === 0 && firstAtLeft) points.push([left, pointY])
      points.push([Number(x[index].toFixed(1)), pointY])
    })
    finish()
    return segments.join(' ')
  }
  const rocAreas = [rocArea('roc'), rocArea('maroc')]
  const bollBands: string[] = []
  let upper: string[] = [], lower: string[] = []
  const finishBand = () => {
    if (upper.length > 1) bollBands.push(`M${upper.join(' L')} L${lower.reverse().join(' L')} Z`)
    upper = []; lower = []
  }
  bars.forEach((bar, index) => {
    if (!finite(bar.bollUpper) || !finite(bar.bollLower)) { finishBand(); return }
    if (index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) finishBand()
    const pointX = x[index].toFixed(1)
    if (index === 0 && firstAtLeft) {
      upper.push(`${left} ${priceY(bar.bollUpper).toFixed(1)}`)
      lower.push(`${left} ${priceY(bar.bollLower).toFixed(1)}`)
    }
    upper.push(`${pointX} ${priceY(bar.bollUpper).toFixed(1)}`)
    lower.push(`${pointX} ${priceY(bar.bollLower).toFixed(1)}`)
  })
  finishBand()
  const rectangle = (x: number, y: number, width: number, height: number) => `M${x} ${y}h${width}v${height}h${-width}Z`
  const upWicks: string[] = [], downWicks: string[] = [], upBodies: string[] = [], downBodies: string[] = [], buys: string[] = [], sells: string[] = []
  const takerAvailable = bars.some(bar => finite(bar.buy) && bar.buy > 0 || finite(bar.sell) && bar.sell > 0)
  const zeroY = takerY(0)
  for (const [index, bar] of bars.entries()) {
    const rising = bar.close >= bar.open, center = x[index]
    const wicks = rising ? upWicks : downWicks, bodies = rising ? upBodies : downBodies
    wicks.push(`M${center} ${priceY(bar.high)}V${priceY(bar.low)}`)
    const top = priceY(Math.max(bar.open, bar.close))
    bodies.push(rectangle(center - barWidth / 2, top, barWidth, Math.max(1.5, priceY(Math.min(bar.open, bar.close)) - top)))
    const buy = finite(bar.buy) ? bar.buy : 0, sell = finite(bar.sell) ? bar.sell : 0
    const buyY = takerY(buy), totalY = takerY(buy + sell)
    if (takerAvailable && buy > 0) buys.push(rectangle(center - barWidth / 2, buyY, barWidth, zeroY - buyY))
    if (takerAvailable && sell > 0) sells.push(rectangle(center - barWidth / 2, totalY, barWidth, buyY - totalY))
  }
  return Object.freeze({
    ...options, layout, gutter, x, priceAxis, rocAxis, atrRange, bbwRange, oiAxis, takerAxis, priceY, rsiY, rocY, atrY, bbwY, oiY, takerY, rocZeroY, rsiMarkers,
    priceTicks: priceAxis.ticks.map((value, index) => ({ y: priceY(value), label: priceLabelsText[index] })),
    oiTicks: oiAxis?.ticks.map((value, index) => ({ y: oiY(value), label: oiLabelsText[index] })) ?? [],
    takerTicks: takerAxis.ticks.map((value, index) => ({ y: takerY(value), label: takerLabelsText[index] })),
    firstHour, candleHigh, candleLow, highIndex, lowIndex, oiSamples, takerAvailable,
    oiComplete: bars.every(bar => finite(bar.oi)), takerComplete: bars.every(bar => finite(bar.buy) && finite(bar.sell)),
    lines, rocAreas, bollBands,
    upWicks: upWicks.join(' '), downWicks: downWicks.join(' '), upBodies: upBodies.join(' '), downBodies: downBodies.join(' '),
    buys: buys.join(' '), sells: sells.join(' '), buySamples: buys.length, sellSamples: sells.length,
  })
}

export type ChartGeometry = ReturnType<typeof buildGeometry>

/** Weak ownership follows immutable chart windows. A separate LRU also caps
 * derived paths globally, including windows still resident in the source cache. */
export function createChartGeometryCache(measureText: (text: string) => number) {
  const cache = new WeakMap<readonly Bar[], ChartGeometry[]>()
  const resident = new Map<ChartGeometry, ChartGeometry[]>()
  return (bars: readonly Bar[], options: ChartGeometryOptions): ChartGeometry => {
    const variants = cache.get(bars) ?? []
    const liveClose = finite(options.liveClose) ? options.liveClose : undefined
    const index = variants.findIndex(value => value.width === options.width && value.height === options.height
      && value.endHour === options.endHour && value.intervalMS === options.intervalMS && value.liveClose === liveClose)
    if (index >= 0) {
      const [value] = variants.splice(index, 1)
      variants.push(value)
      resident.delete(value); resident.set(value, variants)
      return value
    }
    const value = measureOperation({ category: 'cpu', name: 'chart.geometry', attributes: {
      candles: bars.length, width: options.width, height: options.height, intervalMS: options.intervalMS,
    } }, () => buildGeometry(bars, { ...options, liveClose }, measureText))
    variants.push(value)
    if (variants.length > 4) resident.delete(variants.shift()!)
    cache.set(bars, variants)
    resident.set(value, variants)
    if (resident.size > 64) {
      const [oldest, entries] = resident.entries().next().value!
      resident.delete(oldest)
      entries.splice(entries.indexOf(oldest), 1)
    }
    return value
  }
}
