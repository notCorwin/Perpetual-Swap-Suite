import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { ArrowLeft, Camera, Radio } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ChartAnalysisPanel } from '@/ChartAnalysisPanel'
import { ChartWorkspaceViewport } from '@/ChartWorkspaceViewport'
import { chartAnalysis } from '@/analysis-service'
import { type AnalysisDirection } from '@/chart-analysis'
import { chartCaptureBounds } from '@/chart-capture'
import { chartAxis, chartAxisForLabels, logarithmicChartAxis, logarithmicY } from "@/chart-axis"
import { chartCandleWidth, chartHourX, chartLayout, fitAxisPriceTag, type ChartPanel as Panel } from "@/chart-layout"
import { cn } from "@/lib/utils"
import { chartNavigationTarget } from "@/market-sort"
import { finitePercentage, formatPercent } from "@/market-percent"
import { RADAR_TIMEFRAMES, timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

import { chartController } from '@/chart-controller'
import type { Bar, PreparedChartState } from '@/chart-data'

const EMPTY_BARS: readonly Bar[] = []

const compactFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5, notation: "compact" })
const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 })
const chartTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
const compact = (value: number | null) => value === null ? "—" : compactFormatter.format(value)
const price = (value: number | null) => value === null ? "—" : priceFormatter.format(value)
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const time = (hour: number) => chartTimeFormatter.format(hour)
const hourLabel = time
const chartPriceValues = (bars: readonly Bar[]) => bars.flatMap(bar => [
  bar.low, bar.high, bar.vwap, bar.ema, bar.logBBUpper, bar.logBBMiddle, bar.logBBLower,
].filter((value): value is number => finiteNumber(value) && value > 0))
const rocAxisFor = (bars: readonly Bar[]) => {
  const values = bars.flatMap(bar => [finitePercentage(bar.roc), finitePercentage(bar.maroc)].filter((value): value is number => value !== null))
  const extent = values.length ? Math.max(...values.map(Math.abs)) || 1 : 1
  return chartAxis(-extent, extent, 8)
}
const axisLabelLimit = (panel: readonly [number, number], maximum: number) =>
  Math.min(maximum, Math.max(2, Math.floor((panel[1] - panel[0]) / 32) + 1))
const chartStyle = getComputedStyle(document.documentElement)
const chartTokenNumber = (token: string, fallback: number) => {
  const value = Number.parseFloat(chartStyle.getPropertyValue(token))
  return Number.isFinite(value) ? value : fallback
}
const chartTokens = {
  textSize: chartTokenNumber('--chart-text-size', 10),
  legendGap: chartTokenNumber('--chart-legend-gap', 24),
  priceTagPaddingX: chartTokenNumber('--chart-price-tag-padding-x', 12),
  priceTagPaddingY: chartTokenNumber('--chart-price-tag-padding-y', 7),
  priceTagRowGap: chartTokenNumber('--chart-price-tag-row-gap', 2),
  priceTagTextSize: chartTokenNumber('--chart-price-tag-text-size', 12),
  priceTagStrokeWidth: chartTokenNumber('--chart-price-tag-stroke-width', 1.5),
  priceTagLineHeight: chartTokenNumber('--chart-price-tag-line-height', 1.1),
} as const
const legendContext = document.createElement("canvas").getContext("2d")
const chartTextWidths = new Map<string, number>()
const chartTextWidth = (text: string, fontSize: number = chartTokens.textSize) => {
  const normalized = text.replace(/\d/g, "0")
  const key = `${fontSize}:${normalized}`
  const cached = chartTextWidths.get(key)
  if (cached !== undefined) return cached
  if (!legendContext) return normalized.length * fontSize * .7
  legendContext.font = `${fontSize}px ${chartStyle.fontFamily || 'ui-sans-serif, system-ui, sans-serif'}`
  const width = legendContext.measureText(normalized).width
  chartTextWidths.set(key, width)
  return width
}
const legendWidth = (text: string) => chartTextWidth(text)
const priceTagWidth = (priceText: string, countdown: string) => {
  return Math.ceil(Math.max(chartTextWidth(priceText, chartTokens.priceTagTextSize), chartTextWidth(countdown, chartTokens.priceTagTextSize)) + chartTokens.priceTagPaddingX * 2)
}

const PriceCountdown = memo(function PriceCountdown({ hour, intervalMS, x, y, fontSize }: { hour: number; intervalMS: number; x: number; y: number; fontSize: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((hour + intervalMS - now) / 1000))
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return <text data-chart-countdown x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="var(--chart-price-tag-foreground)" fontSize={fontSize}>{value}</text>
})
export const chartGutter = (bars: readonly Bar[], height: number, liveClose = bars[bars.length - 1].close) => {
  const { panels } = chartLayout(0, height)
  const values = chartPriceValues(bars)
  const priceAxis = logarithmicChartAxis(Math.min(...values), Math.max(...values), axisLabelLimit(panels.price, 9))
  const decimals = priceAxis.decimals
  const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const rocAxis = rocAxisFor(bars)
  const oiValues = bars.flatMap(bar => finiteNumber(bar.oi) ? [bar.oi] : [])
  const takerAxis = chartAxisForLabels(0, Math.max(1, ...bars.map(bar => (finiteNumber(bar.buy) ? bar.buy : 0) + (finiteNumber(bar.sell) ? bar.sell : 0))), axisLabelLimit(panels.taker, 7))
  const labels = [
    ...priceAxis.ticks.map(tick => priceFormatter.format(tick)),
    formatPercent(rocAxis.max, rocAxis.decimals), formatPercent(rocAxis.min, rocAxis.decimals), "100", "0",
    ...(oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true).ticks.map(compact) : []),
    ...takerAxis.ticks.map(compact),
  ]
  const minimumScale = Math.min(1, chartTokens.textSize / chartTokens.priceTagTextSize)
  const axisGutter = Math.max(...labels.map(label => 8 + legendWidth(label)))
  return fitAxisPriceTag(axisGutter, priceTagWidth(price(liveClose), "00:00"), chartTokens.priceTagStrokeWidth, minimumScale)
}

export const Plot = memo(function Plot({ bars, liveBar, liveOverlay = false, inspected, width, height, endHour, intervalMS = 3_600_000, oiState = 'ready', takerState = 'ready' }: { bars: readonly Bar[]; liveBar: Bar; liveOverlay?: boolean; inspected: number | null; width: number; height: number; endHour: number; intervalMS?: number; oiState?: PreparedChartState; takerState?: PreparedChartState }) {
  const areaClipId = useId().replaceAll(":", "")
  const n = bars.length
  const active = bars[inspected ?? n - 1]
  const latestHour = endHour
  const firstHour = endHour - 95 * intervalMS
  const firstAtLeft = bars[0].hour === firstHour
  const candleHigh = Math.max(...bars.map(bar => bar.high)), candleLow = Math.min(...bars.map(bar => bar.low))
  const { gutter, scale: tagScale, offset: tagOffset, boxWidth: tagBoxWidth } = chartGutter(bars, height, liveBar.close)
  const { panels, columns, axisStarts, headerY, left, right } = chartLayout(width, height, gutter)
  const x = (index: number, panel: Panel) => chartHourX(bars[index].hour, latestHour, ...columns[panel], intervalMS)
  const barWidth = chartCandleWidth(right - left)
  const priceValues = chartPriceValues(bars)
  const oiComplete = n === 96 && bars.every(bar => finiteNumber(bar.oi))
  const takerComplete = n === 96 && bars.every(bar => finiteNumber(bar.buy) && finiteNumber(bar.sell))
  const priceMin = Math.min(...priceValues), priceMax = Math.max(...priceValues)
  const priceAxis = logarithmicChartAxis(priceMin, priceMax, axisLabelLimit(panels.price, 9))
  const highIndex = bars.findIndex(bar => bar.high === candleHigh), lowIndex = bars.findIndex(bar => bar.low === candleLow)
  const priceDecimals = priceAxis.decimals
  const axisPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })
  const rocAxis = rocAxisFor(bars)
  // Observed unavailable source values remain gaps; they are never false zeros.
  const oiSamples = bars.flatMap((bar, index) => finiteNumber(bar.oi) ? [{ index, value: bar.oi }] : [])
  const oiValues = oiSamples.map(sample => sample.value)
  const oiAxis = oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true) : null
  const takerSamples = bars.flatMap((bar, index) => {
    const buy = finiteNumber(bar.buy) ? bar.buy : 0
    const sell = finiteNumber(bar.sell) ? bar.sell : 0
    return buy > 0 || sell > 0 ? [{ index, buy, sell }] : []
  })
  const takerAvailable = takerSamples.length > 0
  const maxTaker = takerAvailable ? Math.max(1, ...takerSamples.map(sample => sample.buy + sample.sell)) : 1
  const takerAxis = chartAxisForLabels(0, maxTaker, axisLabelLimit(panels.taker, 7))
  const scale = (value: number, min: number, max: number, panel: readonly [number, number]) =>
    panel[1] - (value - min) / (max - min || 1) * (panel[1] - panel[0])
  const priceY = (value: number) => logarithmicY(value, priceAxis, panels.price)
  const rsiY = (value: number) => scale(value, 0, 100, panels.rsi)
  const oiY = (value: number) => oiAxis ? logarithmicY(value, oiAxis, panels.oi) : NaN
  const takerY = (value: number) => scale(value, takerAxis.min, takerAxis.max, panels.taker)
  const rocZeroY = scale(0, rocAxis.min, rocAxis.max, panels.roc)
  const tag = { price: liveBar.close, rising: liveBar.close >= liveBar.open, inViewport: liveBar.hour <= endHour + (liveOverlay ? intervalMS : 0) }
  const latestY = priceY(tag.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--destructive)"
  const showCountdown = liveOverlay
  const latestPrice = price(tag.price)
  const tagFontSize = `${chartTokens.priceTagTextSize}px`
  const tagLineHeight = chartTokens.priceTagTextSize * chartTokens.priceTagLineHeight
  const tagPaddingY = chartTokens.priceTagPaddingY
  const tagRowGap = chartTokens.priceTagRowGap
  const tagStrokeWidth = chartTokens.priceTagStrokeWidth
  const tickHalfHeight = chartTokens.textSize / 2
  const tagHeight = tagLineHeight * (showCountdown ? 2 : 1) + (showCountdown ? tagRowGap : 0) + tagPaddingY * 2
  const scaledTagHeight = tagHeight * tagScale
  const priceTagY = tag.inViewport ? Math.max(panels.price[0], Math.min(latestY - scaledTagHeight / 2, panels.price[1] - scaledTagHeight)) : panels.price[0]
  const tagX = right
  const line = (key: keyof Bar, panelKey: Panel, y: (value: number) => number) => {
    const segments: string[] = []
    let segment = ""
    bars.forEach((bar, index) => {
      const value = bar[key]
      const pointY = finiteNumber(value) ? y(value) : NaN
      if (!Number.isFinite(pointY) || (index > 0 && bar.hour - bars[index - 1].hour !== intervalMS)) {
        if (segment) segments.push(segment)
        segment = ""
        if (!Number.isFinite(pointY)) return
      }
      if (index === 0 && firstAtLeft) segment = `M${left} ${pointY.toFixed(1)}`
      segment += `${segment ? " L" : "M"}${x(index, panelKey).toFixed(1)} ${pointY.toFixed(1)}`
    })
    if (segment) segments.push(segment)
    return segments.join(" ")
  }
  const priceLine = (key: keyof Bar) => line(key, "price", priceY)
  const rocArea = (key: "roc" | "maroc") => {
    const segments: string[] = []
    let points: [number, number][] = []
    const finish = () => {
      if (points.length > 1) {
        const firstX = points[0][0], lastX = points[points.length - 1][0]
        segments.push(`M${firstX} ${rocZeroY} L${points.map(([pointX, pointY]) => `${pointX} ${pointY}`).join(" L")} L${lastX} ${rocZeroY} Z`)
      }
      points = []
    }
    bars.forEach((bar, index) => {
      const value = finitePercentage(bar[key])
      if (value === null || (index > 0 && bar.hour - bars[index - 1].hour !== intervalMS)) finish()
      if (value === null) return
      const pointY = Number(scale(value, rocAxis.min, rocAxis.max, panels.roc).toFixed(1))
      if (index === 0 && firstAtLeft) points.push([left, pointY])
      points.push([Number(x(index, "roc").toFixed(1)), pointY])
    })
    finish()
    return segments.join(" ")
  }
  const rocAreas = [rocArea("roc"), rocArea("maroc")]
  const logBBBands: string[] = []
  let upper: string[] = [], lower: string[] = []
  const finishBand = () => {
    if (upper.length > 1) logBBBands.push(`M${upper.join(" L")} L${lower.reverse().join(" L")} Z`)
    upper = []; lower = []
  }
  bars.forEach((bar, index) => {
    if (!finiteNumber(bar.logBBUpper) || !finiteNumber(bar.logBBLower) || bar.logBBUpper <= 0 || bar.logBBLower <= 0) { finishBand(); return }
    if (index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) finishBand()
    const pointX = x(index, "price").toFixed(1)
    if (index === 0 && firstAtLeft) {
      upper.push(`${left} ${priceY(bar.logBBUpper).toFixed(1)}`)
      lower.push(`${left} ${priceY(bar.logBBLower).toFixed(1)}`)
    }
    upper.push(`${pointX} ${priceY(bar.logBBUpper).toFixed(1)}`)
    lower.push(`${pointX} ${priceY(bar.logBBLower).toFixed(1)}`)
  })
  finishBand()
  const indicatorWidth = "var(--chart-indicator-line-width)"
  const lineStroke = (key: keyof Bar, d: string, color: string, width = indicatorWidth, opacity = 1, dash?: string) => <path data-chart-indicator={key} d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} opacity={opacity} />
  const lineLabel = (x: number, y: number, label: string, color = "var(--muted-foreground)") =>
    <text x={x} y={y} dominantBaseline="middle" fill={color}>{label}</text>
  const rectangle = (x: number, y: number, width: number, height: number) => `M${x} ${y}h${width}v${height}h${-width}Z`
  const upWicks: string[] = [], downWicks: string[] = [], upBodies: string[] = [], downBodies: string[] = []
  const buys: string[] = [], sells: string[] = []
  for (let index = 0; index < n; index++) {
    const bar = bars[index]
    const rising = bar.close >= bar.open
    const center = x(index, "price")
    const wicks = rising ? upWicks : downWicks
    const bodies = rising ? upBodies : downBodies
    wicks.push(`M${center} ${priceY(bar.high)}V${priceY(bar.low)}`)
    const top = priceY(Math.max(bar.open, bar.close))
    bodies.push(rectangle(center - barWidth / 2, top, barWidth, Math.max(1.5, priceY(Math.min(bar.open, bar.close)) - top)))
    const volumeCenter = x(index, "taker")
    const volumeX = volumeCenter - barWidth / 2
    const buy = finiteNumber(bar.buy) ? bar.buy : 0, sell = finiteNumber(bar.sell) ? bar.sell : 0
    const zeroY = takerY(0), buyY = takerY(buy), totalY = takerY(buy + sell)
    if (takerAvailable && buy > 0) buys.push(rectangle(volumeX, buyY, barWidth, zeroY - buyY))
    if (takerAvailable && sell > 0) sells.push(rectangle(volumeX, totalY, barWidth, buyY - totalY))
  }
  const panelKeys: Panel[] = ["price", "roc", "rsi", "oi", "taker"]
  const grid = panelKeys.flatMap(key => panels[key].map((y, index) =>
    <line key={`${key}-${index}`} x1={columns[key][0]} x2={columns[key][1]} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" opacity={index ? 0.32 : 0.55} />))
  const legend = (key: Panel, items: [string, string, string][]) => {
    const gap = chartTokens.legendGap
    const start = columns[key][0] + gap / 2
    const widths = items.map(([label, value]) => legendWidth(label) + 10 + legendWidth(value))
    const available = right - start
    const required = widths.reduce((sum, itemWidth) => sum + itemWidth, 0) + gap * (items.length - 1)
    const shrink = Math.min(1, available / required)
    let cursor = 0
    return <g key={key}>
      <g transform={`translate(${start},${headerY[key]}) scale(${shrink})`}>
      {items.map(([label, value, color], index) => {
        const itemStart = cursor
        cursor += widths[index] + gap
        return <g key={label} transform={`translate(${itemStart},0)`}>
        <text dominantBaseline="middle" fill="var(--muted-foreground)">{label}</text>
        <text x={legendWidth(label) + 10} dominantBaseline="middle" fill={color}>{value}</text>
        </g>
      })}
      </g>
    </g>
  }
  return <>
    <defs>
      <pattern id="sell-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" x2="0" y1="0" y2="4" stroke="var(--background)" strokeWidth="1" opacity="0.55" />
      </pattern>
      <clipPath id={`${areaClipId}-positive`}><rect x={columns.roc[0]} y={panels.roc[0]} width={columns.roc[1] - columns.roc[0]} height={rocZeroY - panels.roc[0]} /></clipPath>
      <clipPath id={`${areaClipId}-negative`}><rect x={columns.roc[0]} y={rocZeroY} width={columns.roc[1] - columns.roc[0]} height={panels.roc[1] - rocZeroY} /></clipPath>
    </defs>
    {logBBBands.map((d, index) => <path key={index} d={d} fill="var(--chart-1)" fillOpacity="0.1" />)}
    {rocAreas.map((area, index) => <g key={index}>
      <path d={area} fill="var(--chart-roc-positive-area)" clipPath={`url(#${areaClipId}-positive)`} />
      <path d={area} fill="var(--chart-roc-negative-area)" clipPath={`url(#${areaClipId}-negative)`} />
    </g>)}
    <rect x={columns.rsi[0]} y={rsiY(70)} width={columns.rsi[1] - columns.rsi[0]} height={rsiY(30) - rsiY(70)} fill="var(--chart-rsi-area)" />
    {grid}
    {rocZeroY > panels.roc[0] && rocZeroY < panels.roc[1] && <line x1={columns.roc[0]} x2={columns.roc[1]} y1={rocZeroY} y2={rocZeroY} stroke="var(--muted-foreground)" strokeWidth="1" strokeOpacity="0.5" />}
    {bars.flatMap((bar, index) => (bar.hour - firstHour) % (12 * intervalMS) === 0 ? panelKeys.map(key => <line key={`${bar.hour}-${key}`} x1={x(index, key)} x2={x(index, key)} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />) : [])}
    {bars.map((bar, index) => ({ bar, index })).filter(({ bar, index }) => index === n - 1 || (bar.hour - firstHour) % (24 * intervalMS) === 0).map(({ bar, index }) => <text key={bar.hour} x={x(index, "taker")} y={height - 7} textAnchor={index === 0 ? "start" : index === n - 1 ? "end" : "middle"} fill="var(--muted-foreground)">{hourLabel(bar.hour)}</text>)}
    {priceAxis.ticks.map(tick => {
      const tickY = priceY(tick)
      return <g key={tick}><line x1={columns.price[0]} x2={right} y1={tickY} y2={tickY} stroke="var(--border)" strokeOpacity="0.35" />{(tickY + tickHalfHeight < priceTagY || tickY - tickHalfHeight > priceTagY + scaledTagHeight) && lineLabel(axisStarts.price, tickY, axisPrice.format(tick))}</g>
    })}
    <line x1={right} x2={right} y1={panels.price[0]} y2={panels.taker[1]} stroke="var(--border)" strokeWidth="1" opacity="0.8" />
    {tag.inViewport && <line data-chart-live-price x1={columns.price[0]} x2={right + tagOffset * tagScale} y1={latestY} y2={latestY} stroke={latestColor} strokeWidth="1.2" strokeDasharray="4 5" />}
    <path d={upWicks.join(" ")} fill="none" stroke="var(--positive)" strokeWidth="1.2" />
    <path d={downWicks.join(" ")} fill="none" stroke="var(--destructive)" strokeWidth="1.2" />
    <path d={upBodies.join(" ")} fill="var(--positive)" />
    <path d={downBodies.join(" ")} fill="var(--destructive)" />
    <g data-chart-taker={takerComplete ? "complete" : takerAvailable ? "partial" : "empty"} data-chart-taker-state={takerState}>
      <path data-chart-taker-buy-samples={buys.length} d={buys.join(" ")} fill="var(--positive)" opacity="0.9" />
      <path data-chart-taker-sell-samples={sells.length} d={sells.join(" ")} fill="var(--destructive)" opacity="0.9" />
      <path d={sells.join(" ")} fill="url(#sell-hatch)" opacity="0.7" />
    </g>
    {lineStroke("logBBUpper", priceLine("logBBUpper"), "var(--chart-1)", indicatorWidth, 0.62)}
    {lineStroke("logBBMiddle", priceLine("logBBMiddle"), "var(--chart-1)")}
    {lineStroke("logBBLower", priceLine("logBBLower"), "var(--chart-1)", indicatorWidth, 0.62)}
    {lineStroke("vwap", priceLine("vwap"), "var(--chart-2)")}
    {lineStroke("ema", priceLine("ema"), "var(--chart-3)", indicatorWidth, 0.9)}
    {lineStroke("rsi6", line("rsi6", "rsi", rsiY), "var(--chart-1)")}
    {lineStroke("rsi12", line("rsi12", "rsi", rsiY), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    {lineStroke("rsi24", line("rsi24", "rsi", rsiY), "var(--chart-3)", indicatorWidth, 1, "1 4")}
    {lineStroke("roc", line("roc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-1)")}
    {lineStroke("maroc", line("maroc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    <g data-chart-oi={oiAxis ? oiComplete ? "complete" : "partial" : "empty"} data-chart-oi-state={oiState} data-chart-oi-samples={oiSamples.length}>
      {oiAxis && <>{lineStroke("oi", line("oi", "oi", oiY), "var(--chart-2)")}{!oiComplete && oiSamples.map(sample => <circle key={bars[sample.index].hour} data-chart-oi-sample cx={x(sample.index, "oi")} cy={oiY(sample.value)} r="2" fill="var(--chart-2)" />)}</>}
    </g>
    {inspected !== null && panelKeys.map(key => <line key={key} x1={x(inspected, key)} x2={x(inspected, key)} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--foreground)" strokeWidth="0.65" strokeDasharray="3 5" opacity="0.3" />)}
    {([[highIndex, candleHigh, "high"], [lowIndex, candleLow, "low"]] as const).map(([index, value, kind]) => {
      const markerX = x(index, "price"), label = price(value)
      const labelWidth = label.length * 6.5 + 8
      const start = index < n / 2 ? markerX + 10 : markerX - labelWidth - 10
      return <g key={kind}>
        <line x1={markerX} x2={index < n / 2 ? markerX + 10 : markerX - 10} y1={priceY(value)} y2={priceY(value)} stroke="var(--foreground)" strokeWidth="1" />
        {lineLabel(start, priceY(value), label, "var(--foreground)")}
      </g>
    })}
    <g data-surface="inherited" transform={`translate(${tagX},${priceTagY}) scale(${tagScale})`}>
      <rect x={tagOffset + tagStrokeWidth / 2} width={tagBoxWidth} height={tagHeight} rx="4" fill={latestColor} stroke={latestColor} strokeWidth="var(--chart-price-tag-stroke-width)" />
      <text x={tagOffset + (tagBoxWidth + tagStrokeWidth) / 2} y={tagPaddingY + tagLineHeight / 2} textAnchor="middle" dominantBaseline="middle" fill="var(--chart-price-tag-foreground)" fontSize={tagFontSize}>{latestPrice}</text>
      {showCountdown && <PriceCountdown hour={liveBar.hour} intervalMS={intervalMS} x={tagOffset + (tagBoxWidth + tagStrokeWidth) / 2} y={tagPaddingY + tagLineHeight * 1.5 + tagRowGap} fontSize={tagFontSize} />}
    </g>
    {legend("price", [["VWAP14", price(active.vwap), "var(--chart-2)"], ["EMA200", price(active.ema), "var(--chart-3)"], ["Log BB(20)", `U ${price(active.logBBUpper)}\u00a0·\u00a0M ${price(active.logBBMiddle)}\u00a0·\u00a0L ${price(active.logBBLower)}`, "var(--chart-1)"]])}
    {legend("roc", [["ROC(9)", formatPercent(active.roc), "var(--chart-1)"], ["MAROC(9)", formatPercent(active.maroc), "var(--chart-2)"]])}
    {legend("rsi", [["RSI(6)", active.rsi6?.toFixed(1) ?? "—", "var(--chart-1)"], ["RSI(12)", active.rsi12?.toFixed(1) ?? "—", "var(--chart-2)"], ["RSI(24)", active.rsi24?.toFixed(1) ?? "—", "var(--chart-3)"]])}
    {legend("oi", [["OI (Contracts)", finiteNumber(active.oi) ? compact(active.oi) : "Unavailable", "var(--chart-2)"]])}
    {legend("taker", [["Taker Buy (Contracts)", finiteNumber(active.buy) ? compact(active.buy) : "Unavailable", "var(--positive)"], ["Taker Sell (Contracts)", finiteNumber(active.sell) ? compact(active.sell) : "Unavailable", "var(--destructive)"]])}
    {panels.rsi[1] - panels.rsi[0] >= 35 && <>{lineLabel(axisStarts.rsi, panels.rsi[0], "100")}{lineLabel(axisStarts.rsi, panels.rsi[1], "0")}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && <>{lineLabel(axisStarts.roc, panels.roc[0], formatPercent(rocAxis.max, rocAxis.decimals))}{lineLabel(axisStarts.roc, panels.roc[1], formatPercent(rocAxis.min, rocAxis.decimals))}</>}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && oiAxis.ticks.map(tick => <g key={tick}><line x1={columns.oi[0]} x2={right} y1={oiY(tick)} y2={oiY(tick)} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, oiY(tick), compact(tick))}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && takerAxis.ticks.map(tick => <g key={tick}>{lineLabel(axisStarts.taker, takerY(tick), compact(tick))}</g>)}
  </>
})

export function MarketChart({ instId, timeframe = '1H', onTimeframeChange, listOrder, turnoverOrder, onSelect, onBack, backLabel = 'Markets' }: { instId: string; timeframe?: RadarTimeframe; onTimeframeChange?: (value: RadarTimeframe) => void; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void; onBack: () => void; backLabel?: string }) {
  const view = useSyncExternalStore(chartController.subscribe, chartController.getSnapshot)
  useLayoutEffect(() => chartController.open(instId, timeframe), [instId, timeframe])
  const surface = view.presented
  const matchesSelection = surface?.instId === instId && surface.timeframe === timeframe
  const pending = view.pending || !matchesSelection
  const unavailable = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.unavailable : null
  const unavailableText = unavailable ? `${instId.replace(/-SWAP$/, '')} has ${unavailable.availableCandles} completed ${timeframeLabel(timeframe)} candles. A complete chart requires ${unavailable.requiredCandles}.` : ''
  const bars = surface?.bars ?? EMPTY_BARS
  const intervalMS = surface?.intervalMS ?? timeframeMilliseconds(timeframe)
  const displayedId = surface?.instId ?? instId
  const displayedFrame = surface?.timeframe ?? timeframe
  const error = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.error : ''
  const requestedEnd = view.requested?.end ?? view.latestEnd
  const historical = surface ? surface.endHour !== chartController.store.latestEnd(surface.instId, surface.timeframe) : false
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const [inspection, setInspection] = useState<{ surface: typeof surface; index: number } | null>(null)
  const inspected = inspection?.surface === surface ? inspection?.index ?? null : null
  const heldPointer = useRef<{ pointerId: number; target: SVGSVGElement } | null>(null)
  const releaseInspection = useCallback(() => {
    const held = heldPointer.current
    heldPointer.current = null
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId)
  }, [])
  const endInspection = useCallback(() => { releaseInspection(); setInspection(null) }, [releaseInspection])
  const analysis = useSyncExternalStore(chartAnalysis.subscribe, () => chartAnalysis.get(instId))
  const [analysisOpen, setAnalysisOpen] = useState(() => chartAnalysis.get(instId) !== null)
  const analysisBusy = analysis?.phase === 'capturing' || analysis?.phase === 'streaming'
  const [capture, setCapture] = useState<{ status: 'idle' | 'copying' | 'flashing' | 'failed'; error: string }>({ status: 'idle', error: '' })
  const captureStatus = capture.status
  const wheelPixels = useRef(0)
  const wheelFrame = useRef<number | null>(null)
  const navigationId = useRef(instId)
  const navigationFrame = useRef<number | null>(null)
  useEffect(() => () => chartAnalysis.stop(instId), [instId, timeframe])
  useLayoutEffect(() => {
    navigationId.current = instId
    wheelPixels.current = 0
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
    releaseInspection()
  }, [instId, timeframe, releaseInspection])
  useLayoutEffect(() => {
    releaseInspection()
    const element = chartRef.current
    if (element) Object.defineProperty(element, '__chartSnapshot', { configurable: true, value: surface })
  }, [surface, releaseInspection])
  useEffect(() => () => {
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current)
  }, [])
  useEffect(() => {
    const element = plotRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setPlotSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    const preventPageScroll = (event: WheelEvent) => event.preventDefault()
    observer.observe(element)
    element.addEventListener('wheel', preventPageScroll, { passive: false })
    return () => { observer.disconnect(); element.removeEventListener('wheel', preventPageScroll) }
  }, [])
  useEffect(() => {
    const hide = () => { if (document.hidden) endInspection() }
    window.addEventListener('blur', endInspection)
    document.addEventListener('visibilitychange', hide)
    return () => { window.removeEventListener('blur', endInspection); document.removeEventListener('visibilitychange', hide) }
  }, [endInspection])
  useEffect(() => {
    if (capture.status !== 'flashing') return
    const timer = window.setTimeout(() => setCapture({ status: 'idle', error: '' }), 550)
    return () => window.clearTimeout(timer)
  }, [capture.status])
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="radio"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="button-group"]')) return
      if (!(event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
      event.preventDefault()
      const id = chartNavigationTarget(listOrder, turnoverOrder, navigationId.current, event.key)
      if (!id || id === navigationId.current) return
      navigationId.current = id
      if (navigationFrame.current === null) navigationFrame.current = window.requestAnimationFrame(() => {
        navigationFrame.current = null
        onSelect(navigationId.current)
      })
    }
    window.addEventListener('keydown', navigate)
    return () => window.removeEventListener('keydown', navigate)
  }, [listOrder, turnoverOrder, onSelect])
  const queueWheel = (pixels: number) => {
    wheelPixels.current += pixels
    if (wheelFrame.current !== null) return
    wheelFrame.current = window.requestAnimationFrame(() => {
      wheelFrame.current = null
      const steps = Math.trunc(wheelPixels.current / 12)
      wheelPixels.current -= steps * 12
      if (steps) { endInspection(); chartController.scroll(steps) }
    })
  }
  const inspectAt = (target: SVGSVGElement, clientX: number) => {
    if (!surface || !bars.length) return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    const { columns } = chartLayout(plotSize.width, plotSize.height, chartGutter(bars, plotSize.height).gutter)
    let nearest = 0
    for (let index = 1; index < bars.length; index += 1) {
      if (Math.abs(chartHourX(bars[index].hour, surface.endHour, ...columns.price, intervalMS) - svgX)
        < Math.abs(chartHourX(bars[nearest].hour, surface.endHour, ...columns.price, intervalMS) - svgX)) nearest = index
    }
    setInspection({ surface, index: nearest })
  }
  const captureChart = async () => {
    if (pending || !surface || !chartRef.current) return
    setCapture({ status: 'copying', error: '' })
    try {
      await window.webkit.messageHandlers.radar.postMessage({ captureChart: chartCaptureBounds(chartRef.current) })
      setCapture({ status: 'flashing', error: '' })
    } catch (cause) { setCapture({ status: 'failed', error: cause instanceof Error ? cause.message : 'Could not copy chart.' }) }
  }
  const analyzeChart = (direction: AnalysisDirection) => {
    if (pending || !surface || plotSize.width <= 0 || captureStatus === 'copying') return
    const capturedSurface = surface
    flushSync(() => { setAnalysisOpen(true); setCapture({ status: 'idle', error: '' }) })
    void chartAnalysis.analyze(instId, async () => {
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
      const element = chartRef.current
      if (!element || chartController.getSnapshot().presented !== capturedSurface || chartController.getSnapshot().pending) throw new Error('Chart changed before capture. Start a new analysis.')
      const image = await window.webkit.messageHandlers.radar.postMessage({ captureChart: { ...chartCaptureBounds(element), output: 'png' } })
      return { ...image, capturedAt: Date.now(), rangeLabel: `${time(capturedSurface.bars[0]!.hour)} – ${time(capturedSurface.endHour)}` }
    }, direction)
  }
  const active = bars[inspected ?? bars.length - 1]
  const oiState = surface?.oiState ?? 'ready'
  const takerState = surface?.takerState ?? 'ready'
  const historyDays = 1_440 * intervalMS / 86_400_000
  const atBoundary = view.historyExhausted && surface && view.oldestHour !== null && surface.endHour === Math.min(view.latestEnd ?? Infinity, view.oldestHour + 95 * intervalMS)
  return <ChartWorkspaceViewport expanded={analysisOpen}><main className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{backLabel}</Button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold tracking-tight" title={displayedId}>{displayedId.replace(/-SWAP$/, '')}</h1></div>
      <ToggleGroup type="single" variant="outline" value={timeframe} onValueChange={value => { if (value) onTimeframeChange?.(value as RadarTimeframe) }} aria-label="Chart timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup>
      <Button variant="outline" size="sm" disabled={pending || !bars.length || plotSize.width <= 0 || captureStatus === 'copying' || analysis?.phase === 'capturing'} onClick={() => { void captureChart() }}><Camera data-icon="inline-start" aria-hidden="true" />{captureStatus === 'copying' ? 'Copying…' : 'Copy chart'}</Button>
      <ButtonGroup aria-label="Chart analysis actions">{(['long', 'short'] as const).map(direction => <Button key={direction} variant="outline" size="sm" disabled={captureStatus === 'copying' || (analysis?.direction !== direction && (analysisBusy || pending || !bars.length || plotSize.width <= 0))} title={analysis?.direction === direction ? `Open existing ${direction} analysis` : undefined} onClick={() => { if (analysis?.direction === direction) setAnalysisOpen(true); else analyzeChart(direction) }}>{analysisBusy && analysis?.direction === direction && <Spinner data-icon="inline-start" />}Analyze {direction === 'long' ? 'Long' : 'Short'}</Button>)}</ButtonGroup>
      <span role="status" className="sr-only">{captureStatus === 'flashing' ? 'Chart copied to clipboard' : ''}</span>
      <Badge variant="secondary"><Radio data-icon="inline-start" aria-hidden="true" />{historical ? `${timeframeLabel(displayedFrame)} history` : `${timeframeLabel(displayedFrame)} chart`}</Badge>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}</div>}
    {capture.error && <p role="alert" className="shrink-0 border-b px-5 py-2 text-destructive">{capture.error}</p>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={displayedId} data-chart-start={bars[0]?.hour} data-chart-end={surface?.endHour} data-chart-cache-start={view.oldestHour ?? undefined} data-chart-requested-end={requestedEnd ?? undefined} data-chart-rendered-bars={bars.length} data-chart-target-bars={96} data-chart-visual-stale={surface && !matchesSelection ? 'true' : 'false'} data-chart-candle-state={surface ? 'ready' : 'loading'} data-chart-statistics-state={surface?.oiState === 'unavailable' || surface?.takerState === 'unavailable' ? 'unavailable' : surface ? 'ready' : 'loading'} data-chart-statistics-end={surface?.endHour} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete="false" data-chart-loading={pending && !unavailable ? 'true' : 'false'} data-surface="panel" aria-label={`${displayedId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-chart-surface">
      {active && <div className="grid shrink-0 grid-cols-[minmax(9rem,1.2fr)_repeat(4,minmax(0,1fr))] items-center border-b px-4 py-1.5 text-[length:var(--chart-text-size)]" aria-live="off">
        <p className="min-w-0 truncate border-r pr-3"><span className="font-medium">{displayedId.replace(/-SWAP$/, '')}</span> · <span className="text-muted-foreground">{inspected === null ? historical ? 'Window end' : 'Latest' : 'Selected'}</span> {time(active.hour)}</p>
        {([['Open', active.open], ['High', active.high], ['Low', active.low], ['Close', active.close]] as const).map(([label, value]) => <div key={label} className="min-w-0 px-3"><span className="text-muted-foreground">{label} </span><span title={price(value)}>{price(value)}</span></div>)}
      </div>}
      <div ref={plotRef} data-chart-plot className="relative min-h-0 flex-1 overflow-hidden" onWheel={event => {
        if (analysis?.phase === 'capturing') return
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY
        queueWheel(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1))
      }}>
        {surface && plotSize.width > 0 ? <svg key={surface.key} data-rendered-inst={surface.instId} data-rendered-timeframe={surface.timeframe} data-rendered-start={bars[0]!.hour} data-rendered-end={surface.endHour} viewBox={`0 0 ${plotSize.width} ${plotSize.height}`} className={cn('absolute inset-0 h-full w-full text-[length:var(--chart-text-size)] select-none focus-visible:outline-2 focus-visible:outline-ring', !matchesSelection && 'pointer-events-none')} role="img" tabIndex={matchesSelection ? 0 : -1} aria-label={`${surface.instId} complete 96-candle ${timeframeLabel(surface.timeframe)} chart. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window end. Scroll to review history. Arrow keys navigate markets.`} onPointerDown={event => {
          if (!matchesSelection || event.button !== 0 || heldPointer.current) return
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          heldPointer.current = { pointerId: event.pointerId, target: event.currentTarget }
          inspectAt(event.currentTarget, event.clientX)
        }} onPointerUp={endInspection} onPointerCancel={endInspection} onLostPointerCapture={endInspection} onPointerMove={event => {
          if (!matchesSelection || heldPointer.current?.pointerId !== event.pointerId) return
          if (!(event.buttons & 1)) { endInspection(); return }
          inspectAt(event.currentTarget, event.clientX)
        }}><Plot bars={bars} liveBar={surface.liveBar ?? bars.at(-1)!} liveOverlay={!!surface.liveBar} inspected={inspected} width={plotSize.width} height={plotSize.height} endHour={surface.endHour} intervalMS={surface.intervalMS} oiState={oiState} takerState={takerState} /></svg> : <div role="status" className="flex h-full items-center justify-center gap-2 text-muted-foreground">{unavailable ? unavailableText : <><Spinner />Preparing complete chart…</>}</div>}
        {pending && surface && !unavailable && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Preparing {instId.replace(/-SWAP$/, '')} {timeframeLabel(timeframe)}{requestedEnd !== null ? ` · ${time(requestedEnd)}` : ''}…</span>}
        {unavailable && surface && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 max-w-md rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{unavailableText}</span>}
        {oiState === 'unavailable' && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-10 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{bars.some(bar => bar.oiUnavailableReason === 'outside-retention') ? `OKX ${timeframeLabel(displayedFrame)} OI history is limited to ${historyDays} days` : `OKX ${timeframeLabel(displayedFrame)} OI history is incomplete for this range`}</span>}
        {takerState === 'unavailable' && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-20 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{bars.some(bar => bar.takerUnavailableReason === 'outside-retention') ? `OKX ${timeframeLabel(displayedFrame)} Taker history is limited to ${historyDays} days` : `OKX ${timeframeLabel(displayedFrame)} Taker history is incomplete for this range`}</span>}
        {atBoundary && !pending && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Start of available history</span>}
      </div>
      {captureStatus === 'flashing' && <div aria-hidden="true" data-surface="inherited" className="pointer-events-none absolute inset-0 z-10 bg-[var(--chart-capture-flash)] motion-safe:animate-[chart-capture-flash_550ms_ease-out_both] motion-reduce:hidden" />}
    </section>
    {analysisOpen && <ChartAnalysisPanel instId={instId} timeframe={timeframeLabel(timeframe)} session={analysis} ready={!pending && bars.length === 96 && plotSize.width > 0 && captureStatus !== 'copying'} onNew={() => analyzeChart(analysis?.direction ?? 'long')} onClose={() => { chartAnalysis.stop(instId); setAnalysisOpen(false) }} />}
    </div>
  </main></ChartWorkspaceViewport>
}
