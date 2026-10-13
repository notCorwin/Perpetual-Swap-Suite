import { memo, startTransition, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { ArrowLeft, Camera, Radio } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { ChartAnalysisPanel } from '@/ChartAnalysisPanel'
import { ChartWorkspaceViewport } from '@/ChartWorkspaceViewport'
import { chartAnalysis } from '@/analysis-service'
import { type AnalysisDirection } from '@/chart-analysis'
import { chartCaptureBounds } from '@/chart-capture'
import { chartAxis, chartAxisForLabels, logarithmicChartAxis, logarithmicY } from "@/chart-axis"
import { chartCandleWidth, chartHourX, chartLayout, fitAxisPriceTag, type ChartPanel as Panel } from "@/chart-layout"
import { livePriceTag, scrollChartEnd, visibleChartBars } from "@/chart-viewport"
import { cn, pageVisible } from "@/lib/utils"
import { chartNavigationTarget, wrappedMarket } from "@/market-sort"
import { finitePercentage, formatPercent, type PercentageValue } from "@/market-percent"
import { SnapshotOrder } from '@/snapshot-order'
import { mergeChartBars } from '@/chart-snapshot'

export type Bar = {
  hour: number; open: number; high: number; low: number; close: number; confirmed: boolean
  vwap: number | null; ema: number | null; logBBUpper: number | null; logBBMiddle: number | null; logBBLower: number | null
  roc: PercentageValue; maroc: PercentageValue; rsi6: number | null; rsi12: number | null; rsi24: number | null
  oi: number | null; buy: number | null; sell: number | null
}
export type StrategyChartSignal = { hour: number; price: number }
export type ChartStrategy = { id: string; name: string; revision: number }
export type StrategyChartReplay = { fromHour: number; throughHour: number; historyHours: number; completedHours: number; matchedHours: number; unknownHours: number; signals: StrategyChartSignal[] }
export type ChartResponse = { bars: Bar[]; error: string; revision: number; serviceSession?: string; endHour?: number; oldestHour?: number | null; historyExhausted?: boolean; candleLoadFailed?: boolean; strategy?: ChartStrategy; strategySignals?: StrategyChartSignal[]; strategyReplay?: StrategyChartReplay }
export type ChartPollResponse = ChartResponse | { unchanged: true; error: string; revision: number; serviceSession?: string }

const chartCache = new Map<string, { data: ChartResponse; loadedAt: number }>()
const chartLoads = new Map<string, Promise<ChartResponse>>()
const chartPreviews = new Map<string, Promise<ChartResponse>>()
const chartOrders = new Map<string, SnapshotOrder>()
function rememberChart(id: string, data: ChartResponse, loadedAt: number) {
  let order = chartOrders.get(id)
  if (!order) { order = new SnapshotOrder(); chartOrders.set(id, order) }
  if (!order.accept(data)) {
    const cached = chartCache.get(id)
    if (cached) return cached.data
    throw new Error('Obsolete chart response; refreshing the current collector')
  }
  chartCache.delete(id)
  chartCache.set(id, { data, loadedAt })
  if (chartCache.size > 8) chartCache.delete(chartCache.keys().next().value!)
  return data
}
function loadChart(id: string): Promise<ChartResponse> {
  const pending = chartLoads.get(id)
  if (pending) return pending
  const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: id, loadChart: true }).then(result => {
    if ("unchanged" in result) throw new Error("No chart data returned")
    return rememberChart(id, result, Date.now())
  }).finally(() => chartLoads.delete(id))
  chartLoads.set(id, request)
  return request
}
function previewChart(id: string): Promise<ChartResponse> {
  const cached = chartCache.get(id)
  if (cached) return Promise.resolve(cached.data)
  const pending = chartPreviews.get(id)
  if (pending) return pending
  const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: id, sinceRevision: -1 }).then(result => {
    if ("unchanged" in result) throw new Error("No chart data returned")
    rememberChart(id, result, chartCache.get(id)?.loadedAt ?? 0)
    return chartCache.get(id)!.data
  }).finally(() => chartPreviews.delete(id))
  chartPreviews.set(id, request)
  return request
}

const compact = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5, notation: "compact" }).format(value)
const price = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(value)
const time = (hour: number) => new Date(hour).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
const hourLabel = (hour: number) => new Date(hour).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", hour12: false })
const chartPriceValues = (bars: Bar[]) => bars.flatMap(bar => [bar.low, bar.high, bar.vwap, bar.ema, bar.logBBUpper, bar.logBBMiddle, bar.logBBLower].filter((value): value is number => value !== null && value > 0))
const rocAxisFor = (bars: Bar[]) => {
  const values = bars.flatMap(bar => [finitePercentage(bar.roc), finitePercentage(bar.maroc)].filter((value): value is number => value !== null))
  const extent = values.length ? Math.max(...values.map(Math.abs)) || 1 : 1
  return chartAxis(-extent, extent, 8)
}
const axisLabelLimit = (panel: readonly [number, number], maximum: number) =>
  Math.min(maximum, Math.max(2, Math.floor((panel[1] - panel[0]) / 32) + 1))
const legendContext = document.createElement("canvas").getContext("2d")
const chartTextWidth = (text: string, fontSize: string) => {
  if (!legendContext) return text.length * 7
  const style = getComputedStyle(document.documentElement)
  legendContext.font = `${fontSize} ${style.fontFamily}`
  return legendContext.measureText(text.replace(/\d/g, "0")).width
}
const legendWidth = (text: string) => chartTextWidth(text, getComputedStyle(document.documentElement).getPropertyValue("--chart-text-size").trim())
const priceTagWidth = (priceText: string, countdown: string) => {
  const style = getComputedStyle(document.documentElement)
  const padding = Number.parseFloat(style.getPropertyValue("--chart-price-tag-padding-x"))
  const fontSize = style.getPropertyValue("--chart-price-tag-text-size").trim()
  return Math.ceil(Math.max(chartTextWidth(priceText, fontSize), chartTextWidth(countdown, fontSize)) + padding * 2)
}

const PriceCountdown = memo(function PriceCountdown({ hour, x, y, fontSize }: { hour: number; x: number; y: number; fontSize: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((hour + 3_600_000 - now) / 1000))
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="var(--chart-price-tag-foreground)" fontSize={fontSize}>{value}</text>
})
export const chartGutter = (bars: Bar[], height: number, liveClose = bars[bars.length - 1].close) => {
  const { panels } = chartLayout(0, height)
  const values = chartPriceValues(bars)
  const priceAxis = logarithmicChartAxis(Math.min(...values), Math.max(...values), axisLabelLimit(panels.price, 9))
  const decimals = priceAxis.decimals
  const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const rocAxis = rocAxisFor(bars)
  const oiValues = bars.flatMap(bar => bar.oi === null ? [] : [bar.oi])
  const takerAxis = chartAxisForLabels(0, Math.max(1, ...bars.map(bar => (bar.buy ?? 0) + (bar.sell ?? 0))), axisLabelLimit(panels.taker, 7))
  const labels = [
    ...priceAxis.ticks.map(tick => priceFormatter.format(tick)),
    formatPercent(rocAxis.max, rocAxis.decimals), formatPercent(rocAxis.min, rocAxis.decimals), "100", "0",
    ...(oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true).ticks.map(compact) : []),
    ...takerAxis.ticks.map(compact),
  ]
  const style = getComputedStyle(document.documentElement)
  const tagStrokeWidth = Number.parseFloat(style.getPropertyValue("--chart-price-tag-stroke-width"))
  const tagTextSize = Number.parseFloat(style.getPropertyValue("--chart-price-tag-text-size"))
  const axisTextSize = Number.parseFloat(style.getPropertyValue("--chart-text-size"))
  const minimumScale = Math.min(1, axisTextSize / tagTextSize)
  const axisGutter = Math.max(...labels.map(label => 8 + legendWidth(label)))
  return fitAxisPriceTag(axisGutter, priceTagWidth(price(liveClose), "00:00"), tagStrokeWidth, minimumScale)
}

export const Plot = memo(function Plot({ bars, liveBar, inspected, width, height, now, endHour, strategySignals = [] }: { bars: Bar[]; liveBar: Bar; inspected: number | null; width: number; height: number; now: number; endHour: number; strategySignals?: StrategyChartSignal[] }) {
  const areaClipId = useId().replaceAll(":", "")
  const n = bars.length
  const active = bars[inspected ?? n - 1]
  const latestHour = endHour
  const firstHour = endHour - 95 * 3_600_000
  const firstAtLeft = bars[0].hour === firstHour
  const candleHigh = Math.max(...bars.map(bar => bar.high)), candleLow = Math.min(...bars.map(bar => bar.low))
  const { gutter, scale: tagScale, offset: tagOffset, boxWidth: tagBoxWidth } = chartGutter(bars, height, liveBar.close)
  const { panels, columns, axisStarts, headerY, left, right } = chartLayout(width, height, gutter)
  const x = (index: number, panel: Panel) => chartHourX(bars[index].hour, latestHour, ...columns[panel])
  const barWidth = chartCandleWidth(right - left)
  const priceValues = chartPriceValues(bars)
  const priceMin = Math.min(...priceValues), priceMax = Math.max(...priceValues)
  const priceAxis = logarithmicChartAxis(priceMin, priceMax, axisLabelLimit(panels.price, 9))
  const highIndex = bars.findIndex(bar => bar.high === candleHigh), lowIndex = bars.findIndex(bar => bar.low === candleLow)
  const priceDecimals = priceAxis.decimals
  const axisPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })
  const rocAxis = rocAxisFor(bars)
  const oiValues = bars.flatMap(bar => bar.oi === null ? [] : [bar.oi])
  const oiAxis = oiValues.length ? logarithmicChartAxis(Math.min(...oiValues), Math.max(...oiValues), axisLabelLimit(panels.oi, 7), true) : null
  const maxTaker = Math.max(1, ...bars.map(bar => (bar.buy ?? 0) + (bar.sell ?? 0)))
  const takerAxis = chartAxisForLabels(0, maxTaker, axisLabelLimit(panels.taker, 7))
  const scale = (value: number, min: number, max: number, panel: readonly [number, number]) =>
    panel[1] - (value - min) / (max - min || 1) * (panel[1] - panel[0])
  const priceY = (value: number) => logarithmicY(value, priceAxis, panels.price)
  const rsiY = (value: number) => scale(value, 0, 100, panels.rsi)
  const oiY = (value: number) => oiAxis ? logarithmicY(value, oiAxis, panels.oi) : NaN
  const takerY = (value: number) => scale(value, takerAxis.min, takerAxis.max, panels.taker)
  const rocZeroY = scale(0, rocAxis.min, rocAxis.max, panels.roc)
  const tag = livePriceTag(liveBar, endHour, now)
  const latestY = priceY(tag.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--destructive)"
  const showCountdown = now > 0
  const latestPrice = price(tag.price)
  const tagStyle = getComputedStyle(document.documentElement)
  const tagFontSize = tagStyle.getPropertyValue("--chart-price-tag-text-size").trim()
  const tagLineHeight = Number.parseFloat(tagFontSize) * Number.parseFloat(tagStyle.getPropertyValue("--chart-price-tag-line-height"))
  const tagPaddingY = Number.parseFloat(tagStyle.getPropertyValue("--chart-price-tag-padding-y"))
  const tagRowGap = Number.parseFloat(tagStyle.getPropertyValue("--chart-price-tag-row-gap"))
  const tagStrokeWidth = Number.parseFloat(tagStyle.getPropertyValue("--chart-price-tag-stroke-width"))
  const tickHalfHeight = Number.parseFloat(tagStyle.getPropertyValue("--chart-text-size")) / 2
  const tagHeight = tagLineHeight * (showCountdown ? 2 : 1) + (showCountdown ? tagRowGap : 0) + tagPaddingY * 2
  const scaledTagHeight = tagHeight * tagScale
  const priceTagY = tag.inViewport ? Math.max(panels.price[0], Math.min(latestY - scaledTagHeight / 2, panels.price[1] - scaledTagHeight)) : panels.price[0]
  const tagX = right
  const line = (key: keyof Bar, panelKey: Panel, y: (value: number) => number) => {
    const segments: string[] = []
    let segment = ""
    bars.forEach((bar, index) => {
      const value = bar[key]
      const pointY = typeof value === "number" ? y(value) : NaN
      if (!Number.isFinite(pointY) || (index > 0 && bar.hour - bars[index - 1].hour !== 3_600_000)) {
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
      if (value === null || (index > 0 && bar.hour - bars[index - 1].hour !== 3_600_000)) finish()
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
    if (bar.logBBUpper === null || bar.logBBLower === null) { finishBand(); return }
    if (index > 0 && bar.hour - bars[index - 1].hour !== 3_600_000) finishBand()
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
  const lineStroke = (d: string, color: string, width = indicatorWidth, opacity = 1, dash?: string) => <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} opacity={opacity} />
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
    const buy = bar.buy ?? 0, sell = bar.sell ?? 0
    const zeroY = takerY(0), buyY = takerY(buy), totalY = takerY(buy + sell)
    if (buy > 0) buys.push(rectangle(volumeX, buyY, barWidth, zeroY - buyY))
    if (sell > 0) sells.push(rectangle(volumeX, totalY, barWidth, buyY - totalY))
  }
  const panelKeys: Panel[] = ["price", "roc", "rsi", "oi", "taker"]
  const grid = panelKeys.flatMap(key => panels[key].map((y, index) =>
    <line key={`${key}-${index}`} x1={columns[key][0]} x2={columns[key][1]} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" opacity={index ? 0.32 : 0.55} />))
  const legend = (key: Panel, items: [string, string, string][]) => {
    const gap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chart-legend-gap"))
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
    {bars.flatMap((bar, index) => (bar.hour - firstHour) % (12 * 3_600_000) === 0 ? panelKeys.map(key => <line key={`${bar.hour}-${key}`} x1={x(index, key)} x2={x(index, key)} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />) : [])}
    {bars.map((bar, index) => ({ bar, index })).filter(({ bar, index }) => index === n - 1 || (bar.hour - firstHour) % (24 * 3_600_000) === 0).map(({ bar, index }) => <text key={bar.hour} x={x(index, "taker")} y={height - 7} textAnchor={index === 0 ? "start" : index === n - 1 ? "end" : "middle"} fill="var(--muted-foreground)">{hourLabel(bar.hour)}</text>)}
    {priceAxis.ticks.map(tick => {
      const tickY = priceY(tick)
      return <g key={tick}><line x1={columns.price[0]} x2={right} y1={tickY} y2={tickY} stroke="var(--border)" strokeOpacity="0.35" />{(tickY + tickHalfHeight < priceTagY || tickY - tickHalfHeight > priceTagY + scaledTagHeight) && lineLabel(axisStarts.price, tickY, axisPrice.format(tick))}</g>
    })}
    <line x1={right} x2={right} y1={panels.price[0]} y2={panels.taker[1]} stroke="var(--border)" strokeWidth="1" opacity="0.8" />
    {tag.inViewport && <line x1={columns.price[0]} x2={right + tagOffset * tagScale} y1={latestY} y2={latestY} stroke={latestColor} strokeWidth="1.2" strokeDasharray="4 5" />}
    <path d={upWicks.join(" ")} fill="none" stroke="var(--positive)" strokeWidth="1.2" />
    <path d={downWicks.join(" ")} fill="none" stroke="var(--destructive)" strokeWidth="1.2" />
    <path d={upBodies.join(" ")} fill="var(--positive)" />
    <path d={downBodies.join(" ")} fill="var(--destructive)" />
    <path d={buys.join(" ")} fill="var(--positive)" opacity="0.9" />
    <path d={sells.join(" ")} fill="var(--destructive)" opacity="0.9" />
    <path d={sells.join(" ")} fill="url(#sell-hatch)" opacity="0.7" />
    {lineStroke(priceLine("logBBUpper"), "var(--chart-1)", indicatorWidth, 0.62)}
    {lineStroke(priceLine("logBBMiddle"), "var(--chart-1)")}
    {lineStroke(priceLine("logBBLower"), "var(--chart-1)", indicatorWidth, 0.62)}
    {lineStroke(priceLine("vwap"), "var(--chart-2)")}
    {lineStroke(priceLine("ema"), "var(--chart-3)", indicatorWidth, 0.9)}
    {lineStroke(line("rsi6", "rsi", rsiY), "var(--chart-1)")}
    {lineStroke(line("rsi12", "rsi", rsiY), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    {lineStroke(line("rsi24", "rsi", rsiY), "var(--chart-3)", indicatorWidth, 1, "1 4")}
    {lineStroke(line("roc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-1)")}
    {lineStroke(line("maroc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    {oiAxis && lineStroke(line("oi", "oi", oiY), "var(--chart-2)")}
    {strategySignals.map(signal => {
      const signalHour = Number(signal.hour)
      const index = bars.findIndex(bar => Number(bar.hour) === signalHour && bar.confirmed)
      if (index < 0) return null
      const markerX = x(index, "price"), markerY = Math.min(panels.price[1] - 5, priceY(bars[index].low) + 9)
      return <g key={signalHour} data-chart-buy-hour={signalHour} aria-label={`Strategy buy signal at ${time(signalHour)} close; reference entry is the next-hour open`}>
        <path d={`M${markerX} ${markerY - 7}L${markerX - 5} ${markerY + 1}H${markerX + 5}Z`} fill="var(--positive)" stroke="var(--chart-surface)" strokeWidth="1.5" />
        <circle cx={markerX} cy={markerY + 3.5} r="2.25" fill="var(--positive)" stroke="var(--chart-surface)" strokeWidth="1" />
        <text x={markerX} y={markerY + 14} textAnchor="middle" fill="var(--positive)" fontWeight="700">BUY</text>
      </g>
    })}
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
      {showCountdown && <PriceCountdown hour={liveBar.hour} x={tagOffset + (tagBoxWidth + tagStrokeWidth) / 2} y={tagPaddingY + tagLineHeight * 1.5 + tagRowGap} fontSize={tagFontSize} />}
    </g>
    {legend("price", [["VWAP14", price(active.vwap), "var(--chart-2)"], ["EMA200", price(active.ema), "var(--chart-3)"], ["Log BB(20)", `U ${price(active.logBBUpper)}\u00a0·\u00a0M ${price(active.logBBMiddle)}\u00a0·\u00a0L ${price(active.logBBLower)}`, "var(--chart-1)"]])}
    {legend("roc", [["ROC(9)", formatPercent(active.roc), "var(--chart-1)"], ["MAROC(9)", formatPercent(active.maroc), "var(--chart-2)"]])}
    {legend("rsi", [["RSI(6)", active.rsi6?.toFixed(1) ?? "—", "var(--chart-1)"], ["RSI(12)", active.rsi12?.toFixed(1) ?? "—", "var(--chart-2)"], ["RSI(24)", active.rsi24?.toFixed(1) ?? "—", "var(--chart-3)"]])}
    {legend("oi", [["OI", compact(active.oi), "var(--chart-2)"]])}
    {legend("taker", [["Taker Buy (contracts)", compact(active.buy), "var(--positive)"], ["Taker Sell (contracts)", compact(active.sell), "var(--destructive)"]])}
    {panels.rsi[1] - panels.rsi[0] >= 35 && <>{lineLabel(axisStarts.rsi, panels.rsi[0], "100")}{lineLabel(axisStarts.rsi, panels.rsi[1], "0")}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && <>{lineLabel(axisStarts.roc, panels.roc[0], formatPercent(rocAxis.max, rocAxis.decimals))}{lineLabel(axisStarts.roc, panels.roc[1], formatPercent(rocAxis.min, rocAxis.decimals))}</>}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && oiAxis.ticks.map(tick => <g key={tick}><line x1={columns.oi[0]} x2={right} y1={oiY(tick)} y2={oiY(tick)} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, oiY(tick), compact(tick))}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && takerAxis.ticks.map(tick => <g key={tick}>{lineLabel(axisStarts.taker, takerY(tick), compact(tick))}</g>)}
  </>
})

export function MarketChart({ instId, listOrder, turnoverOrder, onSelect, onBack, backLabel = 'Markets' }: { instId: string; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void; onBack: () => void; backLabel?: string }) {
  const analysis = useSyncExternalStore(chartAnalysis.subscribe, () => chartAnalysis.get(instId))
  const [analysisOpen, setAnalysisOpen] = useState(() => chartAnalysis.get(instId) !== null)
  const analysisBusy = analysis?.phase === 'capturing' || analysis?.phase === 'streaming'
  useEffect(() => () => chartAnalysis.stop(instId), [instId])
  const [displayed, setDisplayed] = useState<{ id: string; data: ChartResponse } | null>(null)
  const [historyBars, setHistoryBars] = useState<{ id: string; data: ChartResponse } | null>(null)
  const [historyBoundary, setHistoryBoundary] = useState<{ id: string; oldestHour: number } | null>(null)
  const [windowEnd, setWindowEnd] = useState<{ id: string; hour: number } | null>(null)
  const [historyLoading, setHistoryLoading] = useState<string | null>(null)
  const [historyRetry, setHistoryRetry] = useState(0)
  const windowEndRef = useRef<{ id: string; hour: number } | null>(null)
  const wheelPixels = useRef(0)
  const wheelFrame = useRef<number | null>(null)
  const historyRequests = useRef(new Map<string, Promise<ChartPollResponse>>())
  const loadedHistoryBuckets = useRef(new Set<string>())
  const requestedHistoryEnds = useRef(new Set<string>())
  const [inspection, setInspection] = useState<{ id: string; hour: number } | null>(null)
  const heldPointer = useRef<{ id: string; pointerId: number; target: SVGSVGElement } | null>(null)
  const endInspection = useCallback(() => {
    const held = heldPointer.current
    heldPointer.current = null
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId)
    setInspection(null)
  }, [])
  const [chartError, setChartError] = useState<{ id: string; message: string } | null>(null)
  const [warmCharts, setWarmCharts] = useState(() => new Map<string, ChartResponse>())
  const [capture, setCapture] = useState<{ id: string; status: "idle" | "copying" | "flashing" | "failed"; error: string }>({ id: instId, status: "idle", error: "" })
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const navigationId = useRef(instId)
  const navigationFrame = useRef<number | null>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const listPosition = listOrder.indexOf(instId)
  const turnoverPosition = turnoverOrder.indexOf(instId)
  const previous = chartNavigationTarget(listOrder, turnoverOrder, instId, "ArrowUp")
  const next = chartNavigationTarget(listOrder, turnoverOrder, instId, "ArrowDown")
  const beforePrevious = listPosition < 0 ? undefined : wrappedMarket(listOrder, listPosition - 2)
  const afterNext = listPosition < 0 ? undefined : wrappedMarket(listOrder, listPosition + 2)
  const historicalEnd = windowEnd?.id === instId ? windowEnd.hour : null
  const chart = chartCache.get(instId)?.data ?? (displayed?.id === instId ? displayed.data : null) ?? warmCharts.get(instId) ?? null
  const cachedBars = useMemo(() => {
    return mergeChartBars(chart, historyBars?.id === instId ? historyBars.data : null)
  }, [chart, historyBars, instId])
  const oldestCachedHour = cachedBars[0]?.hour ?? Infinity
  const error = chartError?.id === instId ? chartError.message : chart?.error ?? ""
  const captureStatus = capture.id === instId ? capture.status : "idle"
  const captureError = capture.id === instId ? capture.error : ""
  useEffect(() => {
    loadedHistoryBuckets.current.clear(); requestedHistoryEnds.current.clear()
    setHistoryBars(null); setHistoryBoundary(null)
  }, [instId, chart?.serviceSession])
  useEffect(() => {
    if (capture.status !== "flashing") return
    const timer = window.setTimeout(() => setCapture(current => current === capture ? { ...current, status: "idle" } : current), 550)
    return () => window.clearTimeout(timer)
  }, [capture])
  const captureChart = async () => {
    const rect = chartRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    setCapture({ id: instId, status: "copying", error: "" })
    try {
      await window.webkit.messageHandlers.radar.postMessage({ captureChart: chartCaptureBounds(chartRef.current!) })
      setCapture({ id: instId, status: "flashing", error: "" })
    } catch (cause) {
      setCapture({ id: instId, status: "failed", error: cause instanceof Error ? cause.message : "Could not copy chart screenshot" })
    }
  }
  const warmChart = useCallback((id: string, data: ChartResponse, deferred = true) => {
    if (!data.bars.length) return
    const update = () => setWarmCharts(current => {
      if (current.get(id) === data) return current
      const updated = new Map(current)
      updated.delete(id)
      updated.set(id, data)
      if (updated.size > 7) updated.delete(updated.keys().next().value!)
      return updated
    })
    if (deferred) startTransition(update)
    else update()
  }, [])
  useEffect(() => {
    const element = plotRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setPlotSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = plotRef.current
    if (!element) return
    const preventPageScroll = (event: WheelEvent) => event.preventDefault()
    element.addEventListener("wheel", preventPageScroll, { passive: false })
    return () => element.removeEventListener("wheel", preventPageScroll)
  }, [])
  useEffect(() => {
    const endWhenHidden = () => { if (document.hidden) endInspection() }
    window.addEventListener("blur", endInspection)
    document.addEventListener("visibilitychange", endWhenHidden)
    return () => {
      window.removeEventListener("blur", endInspection)
      document.removeEventListener("visibilitychange", endWhenHidden)
      endInspection()
    }
  }, [instId, endInspection])
  useEffect(() => {
    if (historicalEnd === null) return
    const bucket = `${instId}:${Math.floor(historicalEnd / (96 * 3_600_000))}`
    const needsCandles = historicalEnd - 95 * 3_600_000 <= oldestCachedHour + 48 * 3_600_000
    const key = `${instId}:${historicalEnd}`
    if ((!needsCandles && loadedHistoryBuckets.current.has(bucket)) || requestedHistoryEnds.current.has(key)) return
    let stopped = false
    const timer = window.setTimeout(() => {
      setHistoryLoading(key)
      void (async () => {
        try { await historyRequests.current.get(instId) } catch { /* retry the newest position */ }
        if (stopped || windowEndRef.current?.id !== instId || windowEndRef.current.hour !== historicalEnd) return
        requestedHistoryEnds.current.add(key)
        const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, chartEndHour: historicalEnd })
        historyRequests.current.set(instId, request)
        try {
          const result = await request
        if (chartOrders.get(instId)?.isRetiredSession(result.serviceSession)) {
          requestedHistoryEnds.current.delete(key)
          if (!stopped) { setHistoryLoading(null); setHistoryRetry(value => value + 1) }
          return
        }
        if (!("unchanged" in result) && result.historyExhausted && result.oldestHour !== null && result.oldestHour !== undefined) {
          const oldestHour = result.oldestHour
          setHistoryBoundary(current => current?.id === instId && current.oldestHour === oldestHour ? current : { id: instId, oldestHour })
        }
        if (stopped || windowEndRef.current?.id !== instId || windowEndRef.current.hour !== historicalEnd || "unchanged" in result) return
        if (!result.error && !result.candleLoadFailed) loadedHistoryBuckets.current.add(bucket)
        setHistoryBars(current => {
          const merged = mergeChartBars(result, current?.id === instId ? current.data : null)
          const first = historicalEnd - 499 * 3_600_000
          const last = historicalEnd + 249 * 3_600_000
          return { id: instId, data: { ...result, bars: merged.filter(bar => bar.hour >= first && bar.hour <= last) } }
        })
        endInspection()
        if (result.endHour !== undefined && result.endHour !== historicalEnd) {
          const latestHour = chartCache.get(instId)?.data.bars.at(-1)?.hour ?? result.bars.at(-1)?.hour ?? result.endHour
          const next = result.endHour >= latestHour ? null : { id: instId, hour: result.endHour }
          windowEndRef.current = next
          setWindowEnd(next)
        }
        setChartError({ id: instId, message: result.error })
        setHistoryLoading(null)
        } catch (cause) {
          if (!stopped && windowEndRef.current?.id === instId && windowEndRef.current.hour === historicalEnd) {
            setChartError({ id: instId, message: cause instanceof Error ? cause.message : "Cannot load history" })
            setHistoryLoading(null)
          }
        } finally {
          if (historyRequests.current.get(instId) === request) historyRequests.current.delete(instId)
        }
      })()
    }, 80)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [instId, historicalEnd, oldestCachedHour, historyRetry, endInspection])
  useEffect(() => {
    wheelPixels.current = 0
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
  }, [instId])
  useEffect(() => {
    let stopped = false, timer: number, loadTimer: number
    let lastLoad = chartCache.get(instId)?.loadedAt ?? 0
    let hydrationError = chartCache.get(instId)?.data.error ?? ''
    let backoff = 2000
    const order = chartOrders.get(instId) ?? new SnapshotOrder()
    chartOrders.set(instId, order)
    const show = (data: ChartResponse) => {
      if (windowEndRef.current?.id !== instId) setDisplayed({ id: instId, data })
      warmChart(instId, data, false)
    }
    const showError = (message: string) => {
      if (windowEndRef.current?.id !== instId) setChartError(current => current?.id === instId && current.message === message ? current : { id: instId, message })
    }
    // Network hydration has its own clock. Snapshot polling continues while
    // an independent source is waiting, timing out, or retrying.
    const hydrate = async () => {
      await pageVisible(); if (stopped) return
      try {
        const data = await loadChart(instId)
        if (stopped) return
        lastLoad = chartCache.get(instId)?.loadedAt ?? Date.now()
        hydrationError = data.error
        show(data); showError(hydrationError)
      } catch (cause) {
        if (stopped) return
        hydrationError = cause instanceof Error ? cause.message : 'Cannot refresh chart sources'
        showError(hydrationError)
      }
      if (!stopped) loadTimer = window.setTimeout(hydrate, hydrationError ? 10_000 : 60_000)
    }
    const refresh = async () => {
      await pageVisible(); if (stopped) return
      try {
        const result = await window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, sinceRevision: order.revision, serviceSession: order.serviceSession })
        if (stopped) return
        if (order.isCurrent(result)) {
          if (!("unchanged" in result)) show(rememberChart(instId, result, lastLoad))
          showError([...new Set([hydrationError, result.error].filter(Boolean))].join(' '))
        }
        backoff = 2000
      } catch (cause) {
        if (!stopped) {
          showError(cause instanceof Error ? cause.message : "Cannot load chart")
          backoff = Math.min(backoff * 2, 30000)
        }
      }
      if (!stopped) timer = window.setTimeout(refresh, backoff)
    }
    loadTimer = window.setTimeout(hydrate, hydrationError ? 0 : Math.max(0, 60_000 - (Date.now() - lastLoad)))
    void refresh()
    return () => { stopped = true; window.clearTimeout(timer); window.clearTimeout(loadTimer) }
  }, [instId, warmChart])

  useEffect(() => {
    let stopped = false
    for (const id of new Set([beforePrevious, previous, next, afterNext, listOrder[0], turnoverOrder[0]])) {
      if (!id || id === instId) continue
      void previewChart(id).then(data => { if (!stopped) warmChart(id, data) }).catch(() => {})
      if ((id === previous || id === next) && !chartCache.get(id)?.loadedAt) {
        void loadChart(id).then(data => { if (!stopped) warmChart(id, data) }).catch(() => {})
      }
    }
    return () => { stopped = true }
  }, [instId, beforePrevious, previous, next, afterNext, listOrder, turnoverOrder, warmChart])

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="radio"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="button-group"]')) return
      if (!(event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")) return
      event.preventDefault()
      const id = chartNavigationTarget(listOrder, turnoverOrder, navigationId.current, event.key)
      if (id && id !== navigationId.current) {
        navigationId.current = id
        if (navigationFrame.current === null) navigationFrame.current = window.requestAnimationFrame(() => {
          navigationFrame.current = null
          onSelect(navigationId.current)
        })
      }
    }
    window.addEventListener("keydown", navigate)
    return () => {
      window.removeEventListener("keydown", navigate)
      if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current)
    }
  }, [listOrder, turnoverOrder, onSelect])

  const viewportEnd = historicalEnd ?? chart?.bars.at(-1)?.hour ?? 0
  const bars = useMemo(() => visibleChartBars(cachedBars, viewportEnd), [cachedBars, viewportEnd])
  const strategySignals = useMemo(() => {
    const sources = [chart, historyBars?.id === instId ? historyBars.data : null].filter((value): value is ChartResponse => value !== null)
    const strategy = chart?.strategy ?? sources.find(value => value.strategy)?.strategy
    if (!strategy) return []
    return [...new Map(sources.filter(value => value.strategy?.id === strategy.id && value.strategy.revision === strategy.revision)
      .flatMap(value => value.strategySignals ?? []).map(signal => [signal.hour, signal])).values()]
  }, [chart, historyBars, instId])
  const strategyReplay = historicalEnd === null ? chart?.strategyReplay : historyBars?.id === instId ? historyBars.data.strategyReplay : undefined
  const visibleStrategySignals = useMemo(() => {
    const hours = new Set(bars.map(bar => Number(bar.hour)))
    return (strategyReplay?.signals ?? strategySignals).filter(signal => hours.has(Number(signal.hour)))
  }, [bars, strategyReplay, strategySignals])
  const inspectedIndex = inspection?.id === instId ? bars.findIndex(bar => bar.hour === inspection.hour) : -1
  const inspected = inspectedIndex < 0 ? null : inspectedIndex
  const inspectAt = (target: SVGSVGElement, clientX: number) => {
    const rect = target.getBoundingClientRect()
    if (!bars.length || rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    const { columns } = chartLayout(plotSize.width, plotSize.height, chartGutter(bars, plotSize.height, chart?.bars.at(-1)?.close).gutter)
    const [start, end] = columns.price
    let index = 0
    for (let i = 1; i < bars.length; i++) {
      if (Math.abs(chartHourX(bars[i].hour, viewportEnd, start, end) - svgX) < Math.abs(chartHourX(bars[index].hour, viewportEnd, start, end) - svgX)) index = i
    }
    const hour = bars[index].hour
    setInspection(current => current?.id === instId && current.hour === hour ? current : { id: instId, hour })
  }
  const moveHistory = (steps: number) => {
    const latestHour = chartCache.get(instId)?.data.bars.at(-1)?.hour ?? bars.at(-1)?.hour
    if (latestHour === undefined || steps === 0) return
    const current = windowEndRef.current?.id === instId ? windowEndRef.current.hour : null
    const nextHour = scrollChartEnd(current, latestHour, steps, Number.isFinite(oldestCachedHour) ? oldestCachedHour : 0)
    if (nextHour === current) { wheelPixels.current = 0; return }
    const next = nextHour === null ? null : { id: instId, hour: nextHour }
    requestedHistoryEnds.current.clear()
    windowEndRef.current = next
    setWindowEnd(next)
    endInspection()
  }
  const active = bars[inspected ?? bars.length - 1]
  const atHistoryBoundary = historicalEnd !== null && historyBoundary?.id === instId
    && historicalEnd === Math.min(chart?.bars.at(-1)?.hour ?? historicalEnd, historyBoundary.oldestHour + 95 * 3_600_000)
  // Data for neighboring markets remains in warmCharts; mounting their full
  // hidden SVGs would still consume reconciliation, layout and a11y resources.
  const surfaces = new Map<string, ChartResponse>()
  if (bars.length && chart) surfaces.set(instId, { ...chart, bars, endHour: viewportEnd, strategySignals: visibleStrategySignals })
  const analyzeChart = (direction: AnalysisDirection) => {
    if (!bars.length || plotSize.width <= 0 || captureStatus === 'copying') return
    flushSync(() => { setAnalysisOpen(true); setCapture({ id: instId, status: 'idle', error: '' }) })
    void chartAnalysis.analyze(instId, async () => {
      // Let the scaled workspace and chart's ResizeObserver settle before
      // measuring the capture. Native snapshots include only this section.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
      const element = chartRef.current
      if (!element || element.dataset.chartInst !== instId) throw new Error('Chart changed before capture. Start a new analysis.')
      const capturedAt = Date.now()
      const rangeLabel = `${time(Number(element.dataset.chartStart))} – ${time(Number(element.dataset.chartEnd))}`
      const image = await window.webkit.messageHandlers.radar.postMessage({ captureChart: { ...chartCaptureBounds(element), output: 'png' } })
      return { ...image, capturedAt, rangeLabel }
    }, direction)
  }
  const chartDescription = `OKX perpetual · 1h · ${historicalEnd === null ? "Latest 96 hours" : `History through ${time(historicalEnd)}`} · Strategy BUY marks the signal close; reference entry is next-hour open · Hold to inspect · Scroll chart for history · 24h turnover rank ${turnoverPosition + 1}/${turnoverOrder.length} · ↑/↓ list order · ← list first · → turnover first`
  return <ChartWorkspaceViewport expanded={analysisOpen}><main className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{backLabel}</Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight" title={instId}>{instId.replace(/-SWAP$/, "")}</h1>
        <p className="truncate text-xs text-muted-foreground" title={chartDescription}>{chartDescription}</p>
      </div>
      <Button variant="outline" size="sm" disabled={!bars.length || plotSize.width <= 0 || captureStatus === "copying" || analysis?.phase === 'capturing'} onClick={() => { void captureChart() }}><Camera data-icon="inline-start" aria-hidden="true" />{captureStatus === "copying" ? "Copying…" : "Copy chart"}</Button>
      <ButtonGroup aria-label="Chart analysis actions">
        {(['long', 'short'] as const).map(direction => <Button
          key={direction} variant="outline" size="sm"
          disabled={captureStatus === 'copying' || (analysis?.direction !== direction && (analysisBusy || !bars.length || plotSize.width <= 0))}
          title={analysis?.direction === direction ? `Open existing ${direction} analysis` : undefined}
          onClick={() => { if (analysis?.direction === direction) setAnalysisOpen(true); else analyzeChart(direction) }}
        >{analysisBusy && analysis?.direction === direction && <Spinner data-icon="inline-start" />}Analyze {direction === 'long' ? 'Long' : 'Short'}</Button>)}
      </ButtonGroup>
      <span role="status" className="sr-only">{captureStatus === "flashing" ? "Chart copied to clipboard" : ""}</span>
      <Badge variant="secondary"><Radio data-icon="inline-start" aria-hidden="true" />{historicalEnd !== null ? "History" : active && !active.confirmed ? "Live candle" : "Hourly chart"}</Badge>
      {chart?.strategy && <Badge variant="outline" title="BUY markers use completed hourly candles only">{chart.strategy.name} · r{chart.strategy.revision} · {visibleStrategySignals.length} BUY</Badge>}
    </header>
    {chart?.strategy && strategyReplay && <div role="status" data-strategy-chart-summary className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-xs">
      <span className={visibleStrategySignals.length ? 'font-medium text-positive' : 'font-medium'}>{visibleStrategySignals.length} BUY {visibleStrategySignals.length === 1 ? 'entry' : 'entries'} across visible completed candles</span>
      <span className="text-muted-foreground">Rule-required history through each candle · no future data</span>
      <span className="text-muted-foreground">{strategyReplay.matchedHours} matching completed hours · {strategyReplay.completedHours} completed hours checked{strategyReplay.unknownHours ? ` · ${strategyReplay.unknownHours} Unknown` : ''}</span>
      {!visibleStrategySignals.length && <span className="ml-auto text-muted-foreground">The strategy did not transition from non-match to match in this window.</span>}
    </div>}
    {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}{historicalEnd !== null && <Button variant="outline" size="sm" onClick={() => {
      requestedHistoryEnds.current.delete(`${instId}:${historicalEnd}`)
      loadedHistoryBuckets.current.delete(`${instId}:${Math.floor(historicalEnd / (96 * 3_600_000))}`)
      setHistoryRetry(value => value + 1)
    }}>Retry</Button>}</div>}
    {captureError && <p role="alert" className="shrink-0 border-b px-5 py-2 text-destructive">{captureError}</p>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={instId} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-surface="panel" aria-label={`${instId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-chart-surface">
      {active && <div className="grid shrink-0 grid-cols-[minmax(9rem,1.2fr)_repeat(4,minmax(0,1fr))] items-center border-b px-4 py-1.5 text-[length:var(--chart-text-size)]" aria-live="off">
        <p className="min-w-0 truncate border-r pr-3"><span className="font-medium">{instId.replace(/-SWAP$/, "")}</span> · <span className="text-muted-foreground">{inspected === null ? historicalEnd === null ? "Latest" : "Window end" : "Selected"}</span> {time(active.hour)}{active.confirmed ? "" : " · Live"}</p>
        {([ ["Open", active.open], ["High", active.high], ["Low", active.low], ["Close", active.close] ] as const).map(([label, value]) => <div key={label} className="min-w-0 px-3">
          <span className="text-muted-foreground">{label} </span><span title={price(value)}>{price(value)}</span>
        </div>)}
      </div>}
      <div ref={plotRef} className="relative min-h-0 flex-1 overflow-hidden" onWheel={event => {
        if (analysis?.phase === 'capturing') return
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        const delta = horizontal ? event.deltaX : -event.deltaY
        wheelPixels.current += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1)
        if (wheelFrame.current !== null || Math.abs(wheelPixels.current) < 12) return
        wheelFrame.current = window.requestAnimationFrame(() => {
          wheelFrame.current = null
          const steps = Math.trunc(wheelPixels.current / 12)
          wheelPixels.current -= steps * 12
          flushSync(() => moveHistory(steps))
        })
      }}>
        <div className="relative h-full w-full">
        {bars.length && plotSize.width > 0 ? [...surfaces].map(([id, data]) => <svg key={id} viewBox={`0 0 ${plotSize.width} ${plotSize.height}`} className={cn("absolute inset-0 h-full w-full text-[length:var(--chart-text-size)] select-none focus-visible:outline-2 focus-visible:outline-ring", id !== instId && "hidden")} role="img" tabIndex={id === instId ? 0 : -1} aria-hidden={id !== instId} aria-label={`${id} 96 hour candlestick chart with VWAP14, EMA200 and Log BB on a logarithmic price scale; open interest uses a zero-inclusive logarithmic scale, while RSI, ROC, MAROC, and taker volume use linear scales. RSI has a shaded 30 to 70 range and ROC and MAROC have shaded positive and negative areas. Hold the primary mouse button to inspect a candle, drag while holding to inspect others, and release to return to the window end. Scroll to review history; returning to the latest candle resumes automatic following. Up and down arrows follow the visible market list order; left jumps to the first market in the current sorted search results and right jumps to the highest 24-hour turnover market satisfying Settings and applied indicator filters, regardless of search.`} onPointerDown={event => {
          if (id !== instId || event.button !== 0 || heldPointer.current) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          heldPointer.current = { id, pointerId: event.pointerId, target: event.currentTarget }
          inspectAt(event.currentTarget, event.clientX)
        }} onPointerUp={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onPointerCancel={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onLostPointerCapture={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onPointerMove={event => {
          if (id !== instId || heldPointer.current?.id !== id || heldPointer.current.pointerId !== event.pointerId) return
          if (!(event.buttons & 1)) { endInspection(); return }
          inspectAt(event.currentTarget, event.clientX)
        }}>
          <Plot bars={data.bars} liveBar={chart?.bars.at(-1) ?? data.bars.at(-1)!} inspected={inspected} width={plotSize.width} height={plotSize.height} now={1} endHour={data.endHour ?? data.bars.at(-1)!.hour} strategySignals={data.strategySignals} />
        </svg>) : <p className="flex h-full items-center justify-center text-muted-foreground">{chart ? "No candle data available yet" : "Loading chart…"}</p>}
        {historicalEnd !== null && historyLoading === `${instId}:${historicalEnd}` && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Loading history…</span>}
        {atHistoryBoundary && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Start of available history</span>}
        </div>
      </div>
      {captureStatus === "flashing" && <div aria-hidden="true" data-surface="inherited" className="pointer-events-none absolute inset-0 z-10 bg-[var(--chart-capture-flash)] motion-safe:animate-[chart-capture-flash_550ms_ease-out_both] motion-reduce:hidden" />}
    </section>
    {analysisOpen && <ChartAnalysisPanel instId={instId} session={analysis} ready={bars.length > 0 && plotSize.width > 0 && captureStatus !== 'copying'} onNew={() => analyzeChart(analysis?.direction ?? 'long')} onClose={() => { chartAnalysis.stop(instId); setAnalysisOpen(false) }} />}
    </div>
  </main></ChartWorkspaceViewport>
}
