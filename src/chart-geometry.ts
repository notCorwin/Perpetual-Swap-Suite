import { chartAxisForLabels, logarithmicChartAxis, logarithmicScale } from './chart-axis.ts'
import { chartCandleWidth, chartHourX, chartLayout, chartPitchBodyWidth, chartPitchSpan, type ChartLayoutDensity } from './chart-layout.ts'
import type { Bar } from './chart-data.ts'
import { finitePercentage, formatCandleChange, formatPercent } from './market-percent.ts'
import { measureOperation } from '../electron/services/operations.js'
import { chartRsiCrossings } from './rsi-crossings.ts'

const compactFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5, notation: 'compact' })
const axisFormatters = new Map<number, Intl.NumberFormat>()
export const chartCompact = (value: number | null) => value === null ? '—' : compactFormatter.format(value)
export const chartPercent = (value: number | null, decimals = 2) => value === null ? '—' : `${value.toFixed(decimals)}%`
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const lineFields = ['rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'roc', 'maroc', 'oi'] as const
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
export type ChartGeometryOptions = Readonly<{ width: number; height: number; endHour: number; intervalMS: number; liveClose?: number; currentPriceTickSz?: string | null; priceOnly?: boolean; windowBars?: number; layoutDensity?: ChartLayoutDensity; barSpacing?: number; fixedGutter?: number; priceScaleBase?: number | null; priceScaleCenter?: number | null }>
export const CHART_PRICE_PIXELS_PER_PERCENT = 25
export type ChartGeometryOverscan = Readonly<{ before?: Bar; after?: Bar }>
const linearScale = (min: number, max: number, panel: Range) => {
  const span = max - min || 1, height = panel[1] - panel[0]
  return (value: number) => panel[1] - (value - min) / span * height
}
const paddedIndicatorRange = (min: number, max: number) => {
  if (!Number.isFinite(min)) return { min: 0, max: 1 }
  const padding = (max - min || max || 1) * 0.05
  return { min: Math.max(0, min - padding), max: max + padding }
}

function chartAxes(bars: readonly Bar[], options: ChartGeometryOptions, measureText: (text: string) => number) {
  const { height, liveClose } = options
  let rocExtent = 0, minATR = Infinity, maxATR = 0, minBBW = Infinity, maxBBW = 0, maxTaker = 1
  let candleHigh = -Infinity, candleLow = Infinity, highIndex = 0, lowIndex = 0
  const oiSamples: { index: number; value: number }[] = []
  for (const [index, bar] of bars.entries()) {
    for (const value of [finitePercentage(bar.roc), finitePercentage(bar.maroc)]) if (value !== null) rocExtent = Math.max(rocExtent, Math.abs(value))
    if (finite(bar.atrPercent)) { minATR = Math.min(minATR, bar.atrPercent); maxATR = Math.max(maxATR, bar.atrPercent) }
    if (finite(bar.bbw)) { minBBW = Math.min(minBBW, bar.bbw); maxBBW = Math.max(maxBBW, bar.bbw) }
    if (finite(bar.oi)) oiSamples.push({ index, value: bar.oi })
    maxTaker = Math.max(maxTaker, (finite(bar.buy) ? bar.buy : 0) + (finite(bar.sell) ? bar.sell : 0))
    if (bar.high > candleHigh) { candleHigh = bar.high; highIndex = index }
    if (bar.low < candleLow) { candleLow = bar.low; lowIndex = index }
  }
  // Panel heights do not depend on the label gutter, so each axis is computed
  // once and shared by both the gutter measurement and the final plot.
  const { panels } = chartLayout(0, height, 64, options.priceOnly, options.layoutDensity)
  const base = options.priceScaleBase === undefined ? bars.flatMap(bar => [bar.open, bar.high, bar.low, bar.close]).find(value => finite(value) && value > 0) ?? null : options.priceScaleBase
  const relative = (value: number) => (value / base! - 1) * 100
  const lastClose = bars.at(-1)!.close
  const preferredCenter = options.priceScaleCenter === undefined ? liveClose : options.priceScaleCenter
  const centerPrice = base === null ? null : finite(preferredCenter) && preferredCenter > 0 ? preferredCenter : finite(lastClose) && lastClose > 0 ? lastClose : base
  const center = centerPrice === null ? 0 : relative(centerPrice)
  const halfSpan = (panels.price[1] - panels.price[0]) / CHART_PRICE_PIXELS_PER_PERCENT / 2
  const min = center - halfSpan, max = center + halfSpan
  const first = Math.ceil(min - 1e-10), last = Math.floor(max + 1e-10)
  const ticks = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
  const priceAxis = { min, max, ticks, step: 1, decimals: 0, kind: 'relative' as const, base, centerPrice }
  const axisPrice = axisFormatter(priceAxis.decimals)
  const rocRange = (rocExtent || 1) * 1.05
  const rocAxis = chartAxisForLabels(-rocRange, rocRange, axisLabelLimit(panels.roc, 7))
  const atrRange = paddedIndicatorRange(minATR, maxATR), bbwRange = paddedIndicatorRange(minBBW, maxBBW)
  const oiValues = oiSamples.map(sample => sample.value)
  const oiAxis = oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true) : null
  const takerAxis = chartAxisForLabels(0, maxTaker * 1.05, axisLabelLimit(panels.taker, 7))
  const priceLabelsText = priceAxis.ticks.map(tick => `${tick > 0 ? '+' : ''}${axisPrice.format(tick)}%`)
  const oiLabelsText = oiAxis?.ticks.map(chartCompact) ?? [], takerLabelsText = takerAxis.ticks.map(chartCompact)
  const labels = [
    ...priceLabelsText,
    ...(!options.priceOnly ? [...rocAxis.ticks.map(tick => formatPercent(tick, rocAxis.decimals)), '100', '0', ...oiLabelsText, ...takerLabelsText] : []),
    formatCandleChange(bars.at(-1)!.open, liveClose ?? bars.at(-1)!.close), '00:00',
  ]
  const gutter = Math.ceil(Math.max(...labels.map(measureText)) + 16)
  return { panels, priceAxis, priceLabelsText, rocAxis, atrRange, bbwRange, oiAxis, oiLabelsText, takerAxis, takerLabelsText, gutter, candleHigh, candleLow, highIndex, lowIndex, oiSamples }
}

/** One immutable viewport owns its axes, coordinates and paths. */
function buildGeometry(sourceBars: readonly Bar[], options: ChartGeometryOptions, overscan: ChartGeometryOverscan, axesFor: (bars: readonly Bar[], options: ChartGeometryOptions) => ReturnType<typeof chartAxes>) {
  const { width, height, endHour, intervalMS, liveClose, barSpacing } = options
  let bars = sourceBars
  let windowBars = options.windowBars ?? 96
  let axes = axesFor(bars, { ...options, liveClose: liveClose !== undefined && sourceBars.at(-1)!.hour <= endHour ? liveClose : bars.at(-1)!.close })
  let gutter = options.fixedGutter ?? axes.gutter
  if (barSpacing !== undefined) {
    // Reserve the measured label gutter monotonically within this layout pass.
    // Only axes are recalculated if an edge candle leaves; paths are built once.
    for (;;) {
      windowBars = chartPitchSpan(Math.max(0, width - 4 - gutter), barSpacing)
      const first = endHour - (windowBars - 1) * intervalMS
      const inRange = sourceBars.filter(bar => bar.hour > first - chartPitchBodyWidth(barSpacing) / barSpacing * intervalMS && bar.hour < endHour + chartPitchBodyWidth(barSpacing) / barSpacing * intervalMS)
      // A sub-candle-sized plot still uses only its nearest endpoint, never the
      // entire cache as an accidental vertical-axis fallback.
      const visible = inRange.length ? inRange : sourceBars.filter(bar => bar.hour <= endHour).slice(-1)
      if (!visible.length) { bars = sourceBars.slice(0, 1); axes = axesFor(bars, { ...options, liveClose: undefined }); break }
      const same = visible.length === bars.length && visible[0] === bars[0] && visible.at(-1) === bars.at(-1)
      if (same) break
      bars = visible
      const visibleLive = liveClose !== undefined && sourceBars.at(-1)!.hour <= endHour ? liveClose : bars.at(-1)!.close
      axes = axesFor(bars, { ...options, liveClose: visibleLive })
      const nextGutter = options.fixedGutter ?? Math.max(gutter, axes.gutter)
      if (nextGutter === gutter) break
      gutter = nextGutter
    }
  }
  const { panels, priceAxis, priceLabelsText, rocAxis, atrRange, bbwRange, oiAxis, oiLabelsText, takerAxis, takerLabelsText, candleHigh, candleLow, highIndex, lowIndex, oiSamples } = axes
  const firstHour = endHour - (windowBars - 1) * intervalMS, firstAtLeft = bars[0].hour === firstHour
  const before = sourceBars.find(bar => bar.hour === bars[0].hour - intervalMS) ?? overscan.before
  const after = sourceBars.find(bar => bar.hour === bars.at(-1)!.hour + intervalMS) ?? overscan.after
  const pathBars = [
    ...(before?.hour === bars[0].hour - intervalMS ? [before] : []),
    ...bars,
    ...(after?.hour === bars.at(-1)!.hour + intervalMS ? [after] : []),
  ]
  const layout = chartLayout(width, height, gutter, options.priceOnly, options.layoutDensity), { left, right } = layout
  const barWidth = barSpacing === undefined ? chartCandleWidth(right - left, windowBars) : chartPitchBodyWidth(barSpacing)
  const barPitch = barSpacing ?? (right - left - barWidth) / (windowBars - 1)
  const hourX = (hour: number) => barSpacing === undefined ? chartHourX(hour, endHour, left, right, intervalMS, windowBars)
    : right - barWidth / 2 + (hour - endHour) / intervalMS * barSpacing
  const x = bars.map(bar => hourX(bar.hour))
  const pathX = pathBars.map(bar => hourX(bar.hour))
  const relativeY = linearScale(priceAxis.min, priceAxis.max, panels.price)
  const priceY = (value: number) => priceAxis.base === null ? NaN : relativeY((value / priceAxis.base - 1) * 100)
  const rsiY = linearScale(0, 100, panels.rsi), rocY = linearScale(rocAxis.min, rocAxis.max, panels.roc)
  const visibleIndex = new Map(bars.map((bar, index) => [bar.hour, index]))
  const rsiCrossings = options.priceOnly ? [] : chartRsiCrossings(pathBars, intervalMS)
  const rsiMarkers: (typeof rsiCrossings[number] & { index: number; confirmed: boolean; levels: (30 | 70)[]; x: number; y: number; d: string })[] = []
  for (const crossing of rsiCrossings) {
    const previous = rsiMarkers.at(-1)
    const pointX = pathX[crossing.index], pointY = rsiY(crossing.value), baseY = pointY + (crossing.direction === 'up' ? 5 : -5)
    const index = visibleIndex.get(crossing.hour) ?? -1
    if (previous?.hour === crossing.hour && previous.field === crossing.field) { previous.levels.push(crossing.level); continue }
    rsiMarkers.push({ ...crossing, index, confirmed: pathBars[crossing.index].confirmed, levels: [crossing.level], x: pointX, y: pointY,
      d: `M${pointX.toFixed(1)} ${pointY.toFixed(1)} L${(pointX - 3.5).toFixed(1)} ${baseY.toFixed(1)} L${(pointX + 3.5).toFixed(1)} ${baseY.toFixed(1)} Z` })
  }
  const atrY = linearScale(atrRange.min, atrRange.max, panels.atr)
  const bbwY = linearScale(bbwRange.min, bbwRange.max, panels.atr)
  const oiY = oiAxis ? logarithmicScale(oiAxis, panels.oi) : () => NaN
  const takerY = linearScale(takerAxis.min, takerAxis.max, panels.taker), rocZeroY = rocY(0)
  const line = (key: typeof lineFields[number], y: (value: number) => number) => {
    const segments: string[] = []
    let segment = ''
    pathBars.forEach((bar, index) => {
      const value = bar[key], pointY = finite(value) ? y(value) : NaN
      if (!Number.isFinite(pointY) || index > 0 && bar.hour - pathBars[index - 1].hour !== intervalMS) {
        if (segment) segments.push(segment)
        segment = ''
        if (!Number.isFinite(pointY)) return
      }
      if (index === 0 && firstAtLeft && bar.hour === firstHour) segment = `M${left} ${pointY.toFixed(1)}`
      segment += `${segment ? ' L' : 'M'}${pathX[index].toFixed(1)} ${pointY.toFixed(1)}`
    })
    if (segment) segments.push(segment)
    return segments.join(' ')
  }
  const lines = Object.fromEntries(lineFields.map(field => [field, options.priceOnly ? '' : line(field,
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
    pathBars.forEach((bar, index) => {
      const value = finitePercentage(bar[key])
      if (value === null || index > 0 && bar.hour - pathBars[index - 1].hour !== intervalMS) finish()
      if (value === null) return
      const pointY = Number(rocY(value).toFixed(1))
      if (index === 0 && firstAtLeft && bar.hour === firstHour) points.push([left, pointY])
      points.push([Number(pathX[index].toFixed(1)), pointY])
    })
    finish()
    return segments.join(' ')
  }
  const rocAreas = options.priceOnly ? [] : [rocArea('roc'), rocArea('maroc')]
  const bollBands: string[] = []
  let upper: string[] = [], lower: string[] = []
  const finishBand = () => {
    if (upper.length > 1) bollBands.push(`M${upper.join(' L')} L${lower.reverse().join(' L')} Z`)
    upper = []; lower = []
  }
  pathBars.forEach((bar, index) => {
    if (priceAxis.base === null || !finite(bar.bollUpper) || !finite(bar.bollLower)) { finishBand(); return }
    if (index > 0 && bar.hour - pathBars[index - 1].hour !== intervalMS) finishBand()
    const pointX = pathX[index].toFixed(1)
    if (index === 0 && firstAtLeft && bar.hour === firstHour) {
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
  for (const [index, bar] of pathBars.entries()) {
    const rising = bar.close >= bar.open, center = pathX[index]
    const wicks = rising ? upWicks : downWicks, bodies = rising ? upBodies : downBodies
    if (priceAxis.base !== null) {
      if (finite(bar.high) && finite(bar.low)) wicks.push(`M${center} ${priceY(bar.high)}V${priceY(bar.low)}`)
      if (finite(bar.open) && finite(bar.close)) {
        const top = priceY(Math.max(bar.open, bar.close))
        bodies.push(rectangle(center - barWidth / 2, top, barWidth, Math.max(1.5, priceY(Math.min(bar.open, bar.close)) - top)))
      }
    }
    const buy = finite(bar.buy) ? bar.buy : 0, sell = finite(bar.sell) ? bar.sell : 0
    const buyY = takerY(buy), totalY = takerY(buy + sell)
    if (takerAvailable && buy > 0) buys.push(rectangle(center - barWidth / 2, buyY, barWidth, zeroY - buyY))
    if (takerAvailable && sell > 0) sells.push(rectangle(center - barWidth / 2, totalY, barWidth, buyY - totalY))
  }
  return Object.freeze({
    ...options, windowBars, bars, before, after, layout, gutter, measuredGutter: axes.gutter, x, barPitch, barWidth, priceAxis, rocAxis, atrRange, bbwRange, oiAxis, takerAxis, priceY, rsiY, rocY, atrY, bbwY, oiY, takerY, rocZeroY, rsiMarkers,
    priceTicks: priceAxis.base === null ? [] : priceAxis.ticks.map((value, index) => ({ y: relativeY(value), label: priceLabelsText[index] })),
    oiTicks: oiAxis?.ticks.map((value, index) => ({ y: oiY(value), label: oiLabelsText[index] })) ?? [],
    takerTicks: takerAxis.ticks.map((value, index) => ({ y: takerY(value), label: takerLabelsText[index] })),
    firstHour, candleHigh, candleLow, highIndex, lowIndex, oiSamples, takerAvailable,
    oiComplete: bars.every(bar => finite(bar.oi)), takerComplete: bars.every(bar => finite(bar.buy) && finite(bar.sell)),
    lines, rocAreas, bollBands,
    upWicks: upWicks.join(' '), downWicks: downWicks.join(' '), upBodies: upBodies.join(' '), downBodies: downBodies.join(' '),
    buys: buys.join(' '), sells: sells.join(' '),
    buySamples: bars.filter(bar => finite(bar.buy) && bar.buy > 0).length,
    sellSamples: bars.filter(bar => finite(bar.sell) && bar.sell > 0).length,
  })
}

export type ChartGeometry = ReturnType<typeof buildGeometry>

/** Rebase labels without changing the cached raw-price geometry. */
export function chartPricePresentation(geometry: ChartGeometry, contentOffset: number, includeTicks = true) {
  const { left, right } = geometry.layout
  const visible = (bar: Bar) => {
    const center = geometry.x[0] + (bar.hour - geometry.bars[0].hour) / geometry.intervalMS * geometry.barPitch + contentOffset
    return center + geometry.barWidth / 2 > left && center - geometry.barWidth / 2 < right
  }
  const first = (geometry.before && visible(geometry.before) ? geometry.before : undefined) ?? geometry.bars.find(visible) ?? (geometry.after && visible(geometry.after) ? geometry.after : undefined)
  const last = (geometry.after && visible(geometry.after) ? geometry.after : undefined) ?? geometry.bars.findLast(visible) ?? (geometry.before && visible(geometry.before) ? geometry.before : undefined)
  const base = first && finite(first.open) && first.open > 0 ? first.open : null
  const centerPrice = base === null ? null : last && finite(last.close) && last.close > 0 ? last.close : base
  const geometryBase = geometry.priceAxis.base
  const step = base !== null && geometryBase !== null ? geometry.priceAxis.step * geometryBase / base : 1
  const decimals = Math.max(2, Math.min(20, -Math.floor(Math.log10(step)) + 1))
  const formatter = axisFormatter(decimals)
  const formatChange = (raw: number) => {
    if (base === null) return null
    const change = (raw / base - 1) * 100
    if (!finite(change)) return null
    const rounded = Math.abs(change) < 0.5 * 10 ** -decimals ? 0 : change
    return `${rounded > 0 ? '+' : ''}${formatter.format(rounded)}%`
  }
  const ticks = !includeTicks || base === null || geometryBase === null ? [] : geometry.priceAxis.ticks.map((value, index) => {
    const raw = geometryBase * (1 + value / 100)
    return { y: geometry.priceTicks[index].y, label: formatChange(raw) ?? '—' }
  })
  return { base, centerPrice, geometryBase, ticks, formatChange }
}

/** Weak ownership follows immutable chart windows. A separate LRU also caps
 * derived paths globally, including windows still resident in the source cache. */
export function createChartGeometryCache(measureText: (text: string) => number) {
  type AxesVariant = { options: ChartGeometryOptions; axes: ReturnType<typeof chartAxes> }
  const axisCache = new WeakMap<readonly Bar[], AxesVariant[]>()
  const axesFor = (bars: readonly Bar[], options: ChartGeometryOptions) => {
    const variants = axisCache.get(bars) ?? []
    const cached = variants.find(({ options: prior }) => prior.height === options.height && prior.liveClose === options.liveClose
      && prior.priceOnly === options.priceOnly && prior.currentPriceTickSz === options.currentPriceTickSz && prior.layoutDensity === options.layoutDensity
      && prior.priceScaleBase === options.priceScaleBase && prior.priceScaleCenter === options.priceScaleCenter)
    if (cached) return cached.axes
    const axes = chartAxes(bars, options, measureText)
    variants.push({ options, axes })
    if (variants.length > 2) variants.shift()
    axisCache.set(bars, variants)
    return axes
  }
  type Variant = { value: ChartGeometry; before?: Bar; after?: Bar }
  const cache = new WeakMap<readonly Bar[], Variant[]>()
  const resident = new Map<ChartGeometry, Variant[]>()
  return (bars: readonly Bar[], options: ChartGeometryOptions, overscan: ChartGeometryOverscan = {}): ChartGeometry => {
    const variants = cache.get(bars) ?? []
    const liveClose = finite(options.liveClose) ? options.liveClose : undefined
    const index = variants.findIndex(({ value, before, after }) => value.width === options.width && value.height === options.height
      && value.endHour === options.endHour && value.intervalMS === options.intervalMS && value.liveClose === liveClose
      && value.barSpacing === options.barSpacing && value.fixedGutter === options.fixedGutter && value.layoutDensity === options.layoutDensity && (options.barSpacing !== undefined || (value.windowBars ?? 96) === (options.windowBars ?? 96)) && value.currentPriceTickSz === options.currentPriceTickSz && value.priceOnly === options.priceOnly
      && value.priceScaleBase === options.priceScaleBase && value.priceScaleCenter === options.priceScaleCenter
      && before === overscan.before && after === overscan.after)
    if (index >= 0) {
      const [variant] = variants.splice(index, 1)
      variants.push(variant)
      const { value } = variant
      resident.delete(value); resident.set(value, variants)
      return value
    }
    const value = measureOperation({ category: 'cpu', name: 'chart.geometry', attributes: {
      candles: bars.length + Number(Boolean(overscan.before)) + Number(Boolean(overscan.after)), width: options.width, height: options.height, intervalMS: options.intervalMS,
    } }, () => buildGeometry(bars, { ...options, liveClose }, overscan, axesFor))
    const variant = { value, before: overscan.before, after: overscan.after }
    variants.push(variant)
    if (variants.length > 4) resident.delete(variants.shift()!.value)
    cache.set(bars, variants)
    resident.set(value, variants)
    if (resident.size > 64) {
      const [oldest, entries] = resident.entries().next().value!
      resident.delete(oldest)
      const index = entries.findIndex(entry => entry.value === oldest)
      if (index >= 0) entries.splice(index, 1)
    }
    return value
  }
}
