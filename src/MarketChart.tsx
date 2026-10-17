import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
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
import { chartRequestKey, isCurrentChartViewportGeneration, retainViewportTimers } from '@/chart-request-key'
import { chartAxis, chartAxisForLabels, logarithmicChartAxis, logarithmicY } from "@/chart-axis"
import { chartCandleWidth, chartHourX, chartLayout, fitAxisPriceTag, type ChartPanel as Panel } from "@/chart-layout"
import { chartHistoryNeedsLoad, chartIndicatorsNeedLoad, chartScrollFloor, chartStatisticsRequestable, chartStatisticsSnapshotNeeded, chartStatsNeedLoad, chartViewportRuns, hasCompleteChartWindow, livePriceTag, renderableChartEndFromRuns, scrollChartEnd, visibleChartBars } from "@/chart-viewport"
import { cn, pageVisible } from "@/lib/utils"
import { chartNavigationTarget, wrappedMarket } from "@/market-sort"
import { finitePercentage, formatPercent, type PercentageValue } from "@/market-percent"
import { ChartSeriesStore, type ChartSeriesEntry } from '@/chart-series-store'
import { RADAR_TIMEFRAMES, timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

export type Bar = {
  hour: number; open: number; high: number; low: number; close: number; confirmed: boolean
  /** Direct OKX source mask: OI=1, Taker=2. */
  statisticsSources?: number
  /** Both direct OKX statistic sources have answered for this period. */
  statisticsObserved?: boolean
  vwap: number | null; ema: number | null; logBBUpper: number | null; logBBMiddle: number | null; logBBLower: number | null
  roc: PercentageValue; maroc: PercentageValue; rsi6: number | null; rsi12: number | null; rsi24: number | null
  oi: number | null; buy: number | null; sell: number | null
}
export type ChartCandleState = 'ready' | 'loading' | 'retrying' | 'unavailable' | 'exhausted'
export type ChartStatisticsState = 'ready' | 'loading' | 'retrying' | 'unavailable'
export type ChartResponse = {
  bars: Bar[]; error: string; revision: number; timeframe?: RadarTimeframe; intervalMS?: number; serviceSession?: string; endHour?: number; oldestHour?: number | null; historyExhausted?: boolean; candleLoadFailed?: boolean
  candleState?: ChartCandleState; missingCandleRanges?: Array<{ from: number; through: number }>; candleRetryAt?: number | null
  statisticsState?: ChartStatisticsState; statisticsRetryAt?: number | null; oiState?: ChartStatisticsState; takerState?: ChartStatisticsState; statisticsEnd?: number; statusAuthoritative?: boolean
}
export type ChartPollResponse = ChartResponse | { unchanged: true; error: string; revision: number; serviceSession?: string }
type ChartSurface = {
  cacheKey: string
  instId: string
  timeframe: RadarTimeframe
  intervalMS: number
  bars: Bar[]
  endHour: number
  liveBar: Bar
}

type ChartStatus = Omit<ChartResponse, 'bars' | 'revision' | 'serviceSession'>

// A rendered series is application data, not a speculative preview. It must
// outlive navigation and never be evicted by neighboring-chart warmups.
const chartSeries = new ChartSeriesStore<Bar, ChartStatus>()
const chartLoads = new Map<string, Promise<ChartResponse>>()
const chartPreviews = new Map<string, Promise<ChartResponse>>()
const HISTORY_VIEWPORT_DEBOUNCE = 80
// A 1H chart initially has ~404 cached candles before its history floor. At
// the benchmark speed, start the next read as soon as history navigation
// begins instead of discovering the cache edge after the user's wheel burst.
const HISTORY_PREFETCH_CANDLES = 500
const WHEEL_PIXELS_PER_CANDLE = 12
const MAX_WHEEL_STEPS_PER_FRAME = 12
// Direct OI and Taker sources commit independently. While one is in flight,
// poll the foreground viewport quickly enough to display its sibling on the
// next paint instead of leaving a durable result blank for half a second.
const STATISTICS_PROGRESS_POLL_MS = 80
// Both direct OKX statistics endpoints expose their latest 1,440 periods.
const STATISTICS_HISTORY_PERIODS = 1_440
let nextChartFocusToken = 0
const chartKey = (id: string, timeframe: RadarTimeframe) => `${timeframe}:${id}`
const chartResponse = (entry: ChartSeriesEntry<Bar, ChartStatus> | undefined): ChartResponse | null => entry
  ? { ...entry.status, bars: entry.bars, revision: entry.revision, serviceSession: entry.serviceSession }
  : null
function rememberChart(key: string, data: ChartResponse, loadedAt = Date.now()) {
  const result = chartSeries.upsert(key, data, loadedAt)
  return { data: chartResponse(result.entry), accepted: result.accepted }
}
function loadChart(id: string, timeframe: RadarTimeframe, focusSession: number, focusToken: number): Promise<ChartResponse> {
  const key = chartKey(id, timeframe)
  const requestKey = `${key}:${focusSession}:${focusToken}`
  const pending = chartLoads.get(requestKey)
  if (pending) return pending
  const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: id, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken, loadChart: true }).then(result => {
    if ("unchanged" in result) {
      const retained = chartResponse(chartSeries.get(key))
      if (retained) return retained
      throw new Error("No chart data returned")
    }
    const retained = rememberChart(key, result).data
    if (retained) return retained
    throw new Error('Obsolete chart response; refreshing the current collector')
  }).finally(() => chartLoads.delete(requestKey))
  chartLoads.set(requestKey, request)
  return request
}
function previewChart(id: string, timeframe: RadarTimeframe): Promise<ChartResponse> {
  const key = chartKey(id, timeframe)
  const cached = chartResponse(chartSeries.get(key))
  if (cached?.bars.length) return Promise.resolve(cached)
  const pending = chartPreviews.get(key)
  if (pending) return pending
  const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: id, timeframe, preview: true, sinceRevision: -1 }).then(result => {
    if ("unchanged" in result) {
      const retained = chartResponse(chartSeries.get(key))
      if (retained) return retained
      throw new Error("No chart data returned")
    }
    const retained = rememberChart(key, result).data
    if (retained) return retained
    throw new Error('Obsolete chart response; refreshing the current collector')
  }).finally(() => chartPreviews.delete(key))
  chartPreviews.set(key, request)
  return request
}

const compactFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5, notation: "compact" })
const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 })
const chartTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
const compact = (value: number | null) => value === null ? "—" : compactFormatter.format(value)
const price = (value: number | null) => value === null ? "—" : priceFormatter.format(value)
const finiteNumber = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value)
const time = (hour: number) => chartTimeFormatter.format(hour)
const hourLabel = time
const indicatorKeys = ['vwap', 'ema', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'oi', 'buy', 'sell'] as const
type IndicatorKey = typeof indicatorKeys[number]
type IndicatorReadiness = Record<IndicatorKey, boolean>
const indicatorReadiness = (bars: Bar[]): IndicatorReadiness => {
  const ready = Object.fromEntries(indicatorKeys.map(key => [key, bars.length >= 96])) as IndicatorReadiness
  for (const bar of bars) for (const key of indicatorKeys) {
    if (typeof bar[key] !== 'number' || !Number.isFinite(bar[key])) ready[key] = false
  }
  return ready
}
const chartPriceValues = (bars: Bar[], ready = indicatorReadiness(bars)) => {
  return bars.flatMap(bar => [bar.low, bar.high,
    ...(ready.vwap ? [bar.vwap] : []), ...(ready.ema ? [bar.ema] : []),
    ...(ready.logBBUpper && ready.logBBMiddle && ready.logBBLower ? [bar.logBBUpper, bar.logBBMiddle, bar.logBBLower] : []),
  ].filter((value): value is number => value !== null && value > 0))
}
const rocAxisFor = (bars: Bar[]) => {
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
  return <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="var(--chart-price-tag-foreground)" fontSize={fontSize}>{value}</text>
})
export const chartGutter = (bars: Bar[], height: number, liveClose = bars[bars.length - 1].close, ready = indicatorReadiness(bars)) => {
  const { panels } = chartLayout(0, height)
  const values = chartPriceValues(bars, ready)
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

export const Plot = memo(function Plot({ bars, liveBar, inspected, width, height, now, endHour, intervalMS = 3_600_000, oiState = 'ready', takerState = 'ready' }: { bars: Bar[]; liveBar: Bar; inspected: number | null; width: number; height: number; now: number; endHour: number; intervalMS?: number; oiState?: ChartStatisticsState; takerState?: ChartStatisticsState }) {
  const areaClipId = useId().replaceAll(":", "")
  const n = bars.length
  const active = bars[inspected ?? n - 1]
  const latestHour = endHour
  const firstHour = endHour - 95 * intervalMS
  const firstAtLeft = bars[0].hour === firstHour
  const candleHigh = Math.max(...bars.map(bar => bar.high)), candleLow = Math.min(...bars.map(bar => bar.low))
  const ready = useMemo(() => indicatorReadiness(bars), [bars])
  const { gutter, scale: tagScale, offset: tagOffset, boxWidth: tagBoxWidth } = chartGutter(bars, height, liveBar.close, ready)
  const { panels, columns, axisStarts, headerY, left, right } = chartLayout(width, height, gutter)
  const x = (index: number, panel: Panel) => chartHourX(bars[index].hour, latestHour, ...columns[panel], intervalMS)
  const barWidth = chartCandleWidth(right - left)
  const priceValues = chartPriceValues(bars, ready)
  const indicatorReady = (key: IndicatorKey) => ready[key]
  const bandsReady = ready.logBBUpper && ready.logBBMiddle && ready.logBBLower
  const oiComplete = ready.oi
  const takerComplete = ready.buy && ready.sell
  const priceMin = Math.min(...priceValues), priceMax = Math.max(...priceValues)
  const priceAxis = logarithmicChartAxis(priceMin, priceMax, axisLabelLimit(panels.price, 9))
  const highIndex = bars.findIndex(bar => bar.high === candleHigh), lowIndex = bars.findIndex(bar => bar.low === candleLow)
  const priceDecimals = priceAxis.decimals
  const axisPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })
  const rocAxis = rocAxisFor(bars)
  // Statistics arrive independently from candles. A partially hydrated
  // viewport is still useful data: draw the known OI/Taker samples and leave
  // a visible gap for unknown points instead of hiding the whole panel.
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
  const tag = livePriceTag(liveBar, endHour, now, intervalMS)
  const latestY = priceY(tag.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--destructive)"
  const showCountdown = now > 0
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
      const pointY = typeof value === "number" ? y(value) : NaN
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
    if (bar.logBBUpper === null || bar.logBBLower === null) { finishBand(); return }
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
    {bandsReady && logBBBands.map((d, index) => <path key={index} d={d} fill="var(--chart-1)" fillOpacity="0.1" />)}
    {indicatorReady('roc') && indicatorReady('maroc') && rocAreas.map((area, index) => <g key={index}>
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
    {tag.inViewport && <line x1={columns.price[0]} x2={right + tagOffset * tagScale} y1={latestY} y2={latestY} stroke={latestColor} strokeWidth="1.2" strokeDasharray="4 5" />}
    <path d={upWicks.join(" ")} fill="none" stroke="var(--positive)" strokeWidth="1.2" />
    <path d={downWicks.join(" ")} fill="none" stroke="var(--destructive)" strokeWidth="1.2" />
    <path d={upBodies.join(" ")} fill="var(--positive)" />
    <path d={downBodies.join(" ")} fill="var(--destructive)" />
    <g data-chart-taker={takerComplete ? "complete" : takerAvailable ? "partial" : "empty"} data-chart-taker-state={takerState}>
      <path data-chart-taker-buy-samples={buys.length} d={buys.join(" ")} fill="var(--positive)" opacity="0.9" />
      <path data-chart-taker-sell-samples={sells.length} d={sells.join(" ")} fill="var(--destructive)" opacity="0.9" />
      <path d={sells.join(" ")} fill="url(#sell-hatch)" opacity="0.7" />
    </g>
    {bandsReady && <>{lineStroke(priceLine("logBBUpper"), "var(--chart-1)", indicatorWidth, 0.62)}{lineStroke(priceLine("logBBMiddle"), "var(--chart-1)")}{lineStroke(priceLine("logBBLower"), "var(--chart-1)", indicatorWidth, 0.62)}</>}
    {indicatorReady('vwap') && lineStroke(priceLine("vwap"), "var(--chart-2)")}
    {indicatorReady('ema') && lineStroke(priceLine("ema"), "var(--chart-3)", indicatorWidth, 0.9)}
    {indicatorReady('rsi6') && lineStroke(line("rsi6", "rsi", rsiY), "var(--chart-1)")}
    {indicatorReady('rsi12') && lineStroke(line("rsi12", "rsi", rsiY), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    {indicatorReady('rsi24') && lineStroke(line("rsi24", "rsi", rsiY), "var(--chart-3)", indicatorWidth, 1, "1 4")}
    {indicatorReady('roc') && lineStroke(line("roc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-1)")}
    {indicatorReady('maroc') && lineStroke(line("maroc", "roc", value => scale(value, rocAxis.min, rocAxis.max, panels.roc)), "var(--chart-2)", indicatorWidth, 1, "7 4")}
    <g data-chart-oi={oiAxis ? oiComplete ? "complete" : "partial" : "empty"} data-chart-oi-state={oiState} data-chart-oi-samples={oiSamples.length}>
      {oiAxis && <>{lineStroke(line("oi", "oi", oiY), "var(--chart-2)")}{!oiComplete && oiSamples.map(sample => <circle key={bars[sample.index].hour} data-chart-oi-sample cx={x(sample.index, "oi")} cy={oiY(sample.value)} r="2" fill="var(--chart-2)" />)}</>}
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
    {legend("price", [["VWAP14", price(indicatorReady('vwap') ? active.vwap : null), "var(--chart-2)"], ["EMA200", price(indicatorReady('ema') ? active.ema : null), "var(--chart-3)"], ["Log BB(20)", bandsReady ? `U ${price(active.logBBUpper)}\u00a0·\u00a0M ${price(active.logBBMiddle)}\u00a0·\u00a0L ${price(active.logBBLower)}` : "—", "var(--chart-1)"]])}
    {legend("roc", [["ROC(9)", indicatorReady('roc') ? formatPercent(active.roc) : "—", "var(--chart-1)"], ["MAROC(9)", indicatorReady('maroc') ? formatPercent(active.maroc) : "—", "var(--chart-2)"]])}
    {legend("rsi", [["RSI(6)", indicatorReady('rsi6') ? active.rsi6?.toFixed(1) ?? "—" : "—", "var(--chart-1)"], ["RSI(12)", indicatorReady('rsi12') ? active.rsi12?.toFixed(1) ?? "—" : "—", "var(--chart-2)"], ["RSI(24)", indicatorReady('rsi24') ? active.rsi24?.toFixed(1) ?? "—" : "—", "var(--chart-3)"]])}
    {legend("oi", [["OI (Contracts)", finiteNumber(active.oi) ? compact(active.oi) : oiState === 'unavailable' ? "Unavailable" : oiState === 'retrying' ? "Retrying…" : oiState === 'loading' || oiValues.length ? "Loading…" : "—", "var(--chart-2)"]])}
    {legend("taker", [["Taker Buy (Contracts)", finiteNumber(active.buy) ? compact(active.buy) : takerState === 'unavailable' ? "Unavailable" : takerState === 'retrying' ? "Retrying…" : takerState === 'loading' || takerAvailable ? "Loading…" : "—", "var(--positive)"], ["Taker Sell (Contracts)", finiteNumber(active.sell) ? compact(active.sell) : takerState === 'unavailable' ? "Unavailable" : takerState === 'retrying' ? "Retrying…" : takerState === 'loading' || takerAvailable ? "Loading…" : "—", "var(--destructive)"]])}
    {panels.rsi[1] - panels.rsi[0] >= 35 && <>{lineLabel(axisStarts.rsi, panels.rsi[0], "100")}{lineLabel(axisStarts.rsi, panels.rsi[1], "0")}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && <>{lineLabel(axisStarts.roc, panels.roc[0], formatPercent(rocAxis.max, rocAxis.decimals))}{lineLabel(axisStarts.roc, panels.roc[1], formatPercent(rocAxis.min, rocAxis.decimals))}</>}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && oiAxis.ticks.map(tick => <g key={tick}><line x1={columns.oi[0]} x2={right} y1={oiY(tick)} y2={oiY(tick)} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, oiY(tick), compact(tick))}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && takerAxis.ticks.map(tick => <g key={tick}>{lineLabel(axisStarts.taker, takerY(tick), compact(tick))}</g>)}
  </>
})

export function MarketChart({ instId, timeframe = '1H', onTimeframeChange, listOrder, turnoverOrder, onSelect, onBack, backLabel = 'Markets' }: { instId: string; timeframe?: RadarTimeframe; onTimeframeChange?: (value: RadarTimeframe) => void; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void; onBack: () => void; backLabel?: string }) {
  const intervalMS = timeframeMilliseconds(timeframe)
  const cacheKey = chartKey(instId, timeframe)
  // Foreground ownership is committed in a layout effect. Mutating this in
  // render lets an interrupted transition consume a token without ever
  // committing its viewport, which can orphan that viewport's retry timer.
  const committedFocusRef = useRef<{ id: string; token: number } | null>(null)
  const [focusGeneration, setFocusGeneration] = useState<{ id: string; token: number } | null>(null)
  const mountedRef = useRef(true)
  const currentCacheKey = useRef(cacheKey)
  const [focusSession, setFocusSession] = useState<number | null>(null)
  const analysis = useSyncExternalStore(chartAnalysis.subscribe, () => chartAnalysis.get(instId))
  const [analysisOpen, setAnalysisOpen] = useState(() => chartAnalysis.get(instId) !== null)
  const analysisBusy = analysis?.phase === 'capturing' || analysis?.phase === 'streaming'
  useEffect(() => () => chartAnalysis.stop(instId), [instId, timeframe])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    let stopped = false
    void window.webkit.messageHandlers.radar.postMessage({ chartSession: true }).then(({ session }) => {
      if (!stopped) setFocusSession(session)
    }).catch(() => {})
    return () => { stopped = true }
  }, [])
  // The canonical series is module-owned. This counter only subscribes the
  // currently visible chart to writes for its own key.
  const [seriesVersion, setSeriesVersion] = useState(0)
  const [historyBoundary, setHistoryBoundary] = useState<{ id: string; oldestHour: number } | null>(null)
  const [windowEnd, setWindowEnd] = useState<{ id: string; hour: number } | null>(null)
  const [settledWindowEnd, setSettledWindowEnd] = useState<{ id: string; hour: number } | null>(null)
  const [historyLoading, setHistoryLoading] = useState<string | null>(null)
  const [historyRetry, setHistoryRetry] = useState(0)
  // Only committed viewport state is allowed to own request generations and
  // retry callbacks. Wheel input keeps a separate optimistic value so rapid
  // input can still accumulate before the next render.
  const windowEndRef = useRef<{ id: string; hour: number } | null>(null)
  const pendingWindowEndRef = useRef<{ id: string; hour: number } | null>(null)
  const wheelPixels = useRef(0)
  const wheelFrame = useRef<number | null>(null)
  const flushWheelRef = useRef<() => void>(() => {})
  const historyRequests = useRef(new Map<string, Promise<ChartPollResponse>>())
  const historyPrefetches = useRef(new Map<string, Promise<ChartPollResponse>>())
  const historyNextRefreshAt = useRef(new Map<string, number>())
  const historyRetryTimers = useRef(new Map<string, number>())
  const historyRetryAttempts = useRef(new Map<string, number>())
  const historyExhaustedViewports = useRef(new Set<string>())
  const statisticsRequests = useRef(new Set<string>())
  const statisticsRetryTimers = useRef(new Map<string, number>())
  const [statisticsRetry, setStatisticsRetry] = useState(0)
  const [inspection, setInspection] = useState<{ id: string; hour: number } | null>(null)
  const heldPointer = useRef<{ id: string; pointerId: number; target: SVGSVGElement } | null>(null)
  const endInspection = useCallback(() => {
    const held = heldPointer.current
    heldPointer.current = null
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId)
    setInspection(null)
  }, [])
  const [chartError, setChartError] = useState<{ id: string; message: string } | null>(null)
  const [capture, setCapture] = useState<{ id: string; status: "idle" | "copying" | "flashing" | "failed"; error: string }>({ id: cacheKey, status: "idle", error: "" })
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const navigationId = useRef(instId)
  const navigationFrame = useRef<number | null>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const listPosition = listOrder.indexOf(instId)
  const previous = chartNavigationTarget(listOrder, turnoverOrder, instId, "ArrowUp")
  const next = chartNavigationTarget(listOrder, turnoverOrder, instId, "ArrowDown")
  const beforePrevious = listPosition < 0 ? undefined : wrappedMarket(listOrder, listPosition - 2)
  const afterNext = listPosition < 0 ? undefined : wrappedMarket(listOrder, listPosition + 2)
  const historicalEnd = windowEnd?.id === cacheKey ? windowEnd.hour : null
  const settledHistoricalEnd = settledWindowEnd?.id === cacheKey ? settledWindowEnd.hour : null
  // Input may move the visual cursor every frame. Foreground ownership only
  // moves after the cursor settles, so a fast wheel burst cannot repeatedly
  // cancel repair/statistics work in the main process.
  const focusKey = `${cacheKey}:${settledHistoricalEnd ?? 'latest'}`
  const focusToken = focusGeneration?.id === focusKey ? focusGeneration.token : null
  useLayoutEffect(() => {
    currentCacheKey.current = cacheKey
    windowEndRef.current = historicalEnd === null ? null : { id: cacheKey, hour: historicalEnd }
  }, [cacheKey, historicalEnd])
  useEffect(() => {
    if (historicalEnd === null) return
    const next = { id: cacheKey, hour: historicalEnd }
    const timer = window.setTimeout(() => setSettledWindowEnd(current => current?.id === next.id && current.hour === next.hour ? current : next), HISTORY_VIEWPORT_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [cacheKey, historicalEnd])
  useLayoutEffect(() => {
    if (committedFocusRef.current?.id === focusKey) return
    const next = { id: focusKey, token: ++nextChartFocusToken }
    committedFocusRef.current = next
    setFocusGeneration(current => current?.id === next.id && current.token === next.token ? current : next)
  }, [focusKey])
  useEffect(() => {
    if (focusSession === null || focusToken === null) return
    void window.webkit.messageHandlers.radar.postMessage({ chartFocus: { instId, session: focusSession, token: focusToken } }).catch(() => {})
  }, [instId, focusSession, focusToken])
  const chart = useMemo(() => {
    // `seriesVersion` is the visible-key subscription; the data itself stays
    // in the durable application-lifetime store.
    void seriesVersion
    return chartResponse(chartSeries.get(cacheKey))
  }, [cacheKey, seriesVersion])
  const cachedBars = chart?.bars ?? []
  const oldestCachedHour = cachedBars[0]?.hour ?? Infinity
  const error = chartError?.id === cacheKey ? chartError.message : chart?.error ?? ""
  const captureStatus = capture.id === cacheKey ? capture.status : "idle"
  const captureError = capture.id === cacheKey ? capture.error : ""
  const rememberVisibleChart = useCallback((data: ChartResponse, loadedAt = Date.now()) => {
    const result = rememberChart(cacheKey, data, loadedAt)
    if (result.accepted && currentCacheKey.current === cacheKey) setSeriesVersion(version => version + 1)
    return result
  }, [cacheKey])
  useEffect(() => {
    historyNextRefreshAt.current.clear()
    for (const timer of historyRetryTimers.current.values()) window.clearTimeout(timer)
    for (const timer of statisticsRetryTimers.current.values()) window.clearTimeout(timer)
    historyRetryTimers.current.clear(); historyRetryAttempts.current.clear(); historyExhaustedViewports.current.clear(); statisticsRetryTimers.current.clear(); statisticsRequests.current.clear()
    windowEndRef.current = null; pendingWindowEndRef.current = null; historyPrefetches.current.clear()
    setWindowEnd(null); setSettledWindowEnd(null); setInspection(null)
    setHistoryBoundary(null); setHistoryLoading(null)
  }, [cacheKey])
  useEffect(() => () => {
    for (const timer of historyRetryTimers.current.values()) window.clearTimeout(timer)
    for (const timer of statisticsRetryTimers.current.values()) window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    const activeEnd = settledHistoricalEnd === historicalEnd ? historicalEnd : null
    const historyKey = activeEnd === null || focusSession === null || focusToken === null ? null : chartRequestKey('history', cacheKey, activeEnd, focusSession, focusToken)
    const statisticsKey = activeEnd === null || focusSession === null || focusToken === null ? null : chartRequestKey('statistics', cacheKey, activeEnd, focusSession, focusToken)
    retainViewportTimers(historyRetryTimers.current, historyKey, timer => window.clearTimeout(timer), key => {
      historyNextRefreshAt.current.delete(key)
      historyRetryAttempts.current.delete(key)
    })
    retainViewportTimers(statisticsRetryTimers.current, statisticsKey, timer => window.clearTimeout(timer))
  }, [cacheKey, historicalEnd, settledHistoricalEnd, focusSession, focusToken])
  useEffect(() => {
    if (capture.status !== "flashing") return
    const timer = window.setTimeout(() => setCapture(current => current === capture ? { ...current, status: "idle" } : current), 550)
    return () => window.clearTimeout(timer)
  }, [capture])
  const captureChart = async () => {
    const rect = chartRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    setCapture({ id: cacheKey, status: "copying", error: "" })
    try {
      await window.webkit.messageHandlers.radar.postMessage({ captureChart: chartCaptureBounds(chartRef.current!) })
      setCapture({ id: cacheKey, status: "flashing", error: "" })
    } catch (cause) {
      setCapture({ id: cacheKey, status: "failed", error: cause instanceof Error ? cause.message : "Could not copy chart screenshot" })
    }
  }
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
  }, [cacheKey, endInspection])
  useEffect(() => {
    if (focusSession === null || focusToken === null || historicalEnd === null || settledHistoricalEnd !== historicalEnd) return
    const complete = hasCompleteChartWindow(cachedBars, historicalEnd, 96, intervalMS)
    const key = `${cacheKey}:${historicalEnd}`
    const requestKey = chartRequestKey('history', cacheKey, historicalEnd, focusSession, focusToken)
    const needsCandles = !historyExhaustedViewports.current.has(requestKey)
      && (!complete || chartIndicatorsNeedLoad(cachedBars, historicalEnd, 96, intervalMS) || chartHistoryNeedsLoad(historicalEnd, oldestCachedHour, 96, 48, intervalMS))
    if (!needsCandles || historyRequests.current.has(requestKey) || historyRetryTimers.current.has(requestKey) || (historyNextRefreshAt.current.get(requestKey) ?? 0) > Date.now()) return
    const viewportIsCurrent = () => mountedRef.current && isCurrentChartViewportGeneration(windowEndRef.current && committedFocusRef.current ? {
      cacheKey: windowEndRef.current.id,
      end: windowEndRef.current.hour,
      focusToken: committedFocusRef.current.token,
    } : null, { cacheKey, end: historicalEnd, focusToken })
    const currentViewport = viewportIsCurrent
    const retryAutomatically = (delay: number) => {
      if (!currentViewport() || historyRetryTimers.current.has(requestKey)) return
      const attempt = (historyRetryAttempts.current.get(requestKey) ?? 0) + 1
      historyRetryAttempts.current.set(requestKey, attempt)
      const wait = Math.max(250, delay || Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 5)))
      const timer = window.setTimeout(() => {
        historyRetryTimers.current.delete(requestKey)
        historyNextRefreshAt.current.delete(requestKey)
        if (viewportIsCurrent()) setHistoryRetry(value => value + 1)
      }, wait)
      historyNextRefreshAt.current.set(requestKey, Date.now() + wait)
      historyRetryTimers.current.set(requestKey, timer)
    }
    const startRequest = () => {
      if (!currentViewport() || historyRequests.current.has(requestKey)) return
      setHistoryLoading(key)
      const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken, chartEndHour: historicalEnd })
      historyRequests.current.set(requestKey, request)
      void request.then(result => {
        if (!currentViewport()) return
        if ("unchanged" in result) { retryAutomatically(STATISTICS_PROGRESS_POLL_MS); return }
        const stored = rememberVisibleChart(result)
        if (!stored.accepted) { retryAutomatically(STATISTICS_PROGRESS_POLL_MS); return }
        if (result.candleState === 'exhausted' || result.historyExhausted) {
          historyExhaustedViewports.current.add(requestKey)
          if (historyExhaustedViewports.current.size > 64) historyExhaustedViewports.current.delete(historyExhaustedViewports.current.values().next().value!)
        } else historyExhaustedViewports.current.delete(requestKey)
        if (result.historyExhausted && result.oldestHour !== null && result.oldestHour !== undefined) {
          const oldestHour = result.oldestHour
          setHistoryBoundary(current => current?.id === cacheKey && current.oldestHour === oldestHour ? current : { id: cacheKey, oldestHour })
          const latestHour = chartSeries.latestKnownHour(cacheKey) ?? result.bars.at(-1)?.hour ?? historicalEnd
          const boundaryEnd = Math.min(latestHour, oldestHour + 95 * intervalMS)
          const current = windowEndRef.current
          if (current?.id === cacheKey && current.hour < boundaryEnd) {
            const next = { id: cacheKey, hour: boundaryEnd }
            pendingWindowEndRef.current = next
            setWindowEnd(next)
          }
        }
        endInspection()
        setChartError({ id: cacheKey, message: result.error })
        setHistoryLoading(current => current === key ? null : current)
        const repaired = result.candleState === 'ready' && !chartIndicatorsNeedLoad(result.bars, historicalEnd, 96, intervalMS)
        if (!repaired && result.candleState !== 'exhausted') retryAutomatically(result.candleRetryAt === null || result.candleRetryAt === undefined ? 500 : result.candleRetryAt - Date.now())
        else historyRetryAttempts.current.delete(requestKey)
      }).catch(cause => {
        if (!currentViewport()) return
        setChartError({ id: cacheKey, message: cause instanceof Error ? cause.message : "Cannot load history" })
        setHistoryLoading(current => current === key ? null : current)
        retryAutomatically(0)
      }).finally(() => {
        if (historyRequests.current.get(requestKey) === request) historyRequests.current.delete(requestKey)
      })
    }
    startRequest()
  }, [instId, cacheKey, timeframe, intervalMS, historicalEnd, settledHistoricalEnd, oldestCachedHour, cachedBars, historyRetry, endInspection, focusSession, focusToken, rememberVisibleChart])
  useEffect(() => {
    if (historicalEnd === null || !Number.isFinite(oldestCachedHour)
      || !chartHistoryNeedsLoad(historicalEnd, oldestCachedHour, 96, HISTORY_PREFETCH_CANDLES, intervalMS)) return
    // A request at the oldest complete resident window extends the series by
    // roughly one full backend block. It runs before the cursor reaches the
    // cache edge and never claims foreground ownership.
    const targetEnd = oldestCachedHour + 95 * intervalMS
    const requestKey = `${cacheKey}:${targetEnd}`
    if (historyPrefetches.current.has(requestKey)) return
    const request = window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, timeframe, chartEndHour: targetEnd, preview: true })
    historyPrefetches.current.set(requestKey, request)
    void request.then(result => {
      if ("unchanged" in result || !mountedRef.current || currentCacheKey.current !== cacheKey) return
      rememberVisibleChart(result)
    }).catch(() => {}).finally(() => {
      if (historyPrefetches.current.get(requestKey) === request) historyPrefetches.current.delete(requestKey)
    })
  }, [instId, cacheKey, timeframe, intervalMS, historicalEnd, oldestCachedHour, rememberVisibleChart])
  useEffect(() => {
    const cancelQueuedWheel = () => {
      wheelPixels.current = 0
      if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
      wheelFrame.current = null
    }
    cancelQueuedWheel()
    return cancelQueuedWheel
  }, [cacheKey])
  useEffect(() => {
    // The history effects above own network work while the user is inspecting
    // an older window. Live polling would otherwise promote "latest" again
    // and cancel the visible window's OI/Taker job.
    if (focusSession === null || focusToken === null || historicalEnd !== null) return
    let stopped = false, timer: number, loadTimer: number
    let lastLoad = chartSeries.get(cacheKey)?.loadedAt ?? 0
    let hydrationError = chartResponse(chartSeries.get(cacheKey))?.error ?? ''
    let backoff = 2000
    const show = () => {
      if (windowEndRef.current?.id !== cacheKey) setSeriesVersion(version => version + 1)
    }
    const showError = (message: string) => {
      if (windowEndRef.current?.id !== cacheKey) setChartError(current => current?.id === cacheKey && current.message === message ? current : { id: cacheKey, message })
    }
    // Network hydration has its own clock. Snapshot polling continues while
    // an independent source is waiting, timing out, or retrying.
    const hydrate = async () => {
      await pageVisible(); if (stopped) return
      try {
        const data = await loadChart(instId, timeframe, focusSession, focusToken)
        if (stopped) return
        lastLoad = chartSeries.get(cacheKey)?.loadedAt ?? Date.now()
        hydrationError = data.error
        show(); showError(hydrationError)
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
        const current = chartSeries.get(cacheKey)
        const result = await window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken, sinceRevision: current?.barsRevision ?? -1, serviceSession: current?.serviceSession })
        if (stopped) return
        let status = "unchanged" in result ? chartResponse(chartSeries.get(cacheKey)) : result
        if (!("unchanged" in result)) {
          const stored = rememberVisibleChart(result, lastLoad)
          if (stored.accepted && result.bars.length === 0 && result.statisticsEnd !== undefined
            && (result.revision !== current?.barsRevision || chartStatisticsSnapshotNeeded(chartSeries.get(cacheKey)?.bars ?? [], result.statisticsEnd, result, intervalMS))) {
            const full = await window.webkit.messageHandlers.radar.postMessage({ chartInstId: instId, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken })
            if (stopped) return
            if (!("unchanged" in full) && rememberVisibleChart(full, lastLoad).accepted) status = full
          }
        }
        showError([...new Set([hydrationError, result.error].filter(Boolean))].join(' '))
        // While a foreground repair or direct-statistics request is active,
        // observe the result promptly instead of holding a 2-second idle poll.
        backoff = status?.candleState === 'loading' || status?.candleState === 'retrying'
          || status?.statisticsState === 'loading' || status?.statisticsState === 'retrying' ? STATISTICS_PROGRESS_POLL_MS : 2000
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
  }, [instId, cacheKey, timeframe, intervalMS, rememberVisibleChart, focusSession, focusToken, historicalEnd])

  useEffect(() => {
    for (const id of new Set([beforePrevious, previous, next, afterNext, listOrder[0], turnoverOrder[0]])) {
      if (!id || id === instId) continue
      void previewChart(id, timeframe).catch(() => {})
    }
  }, [instId, timeframe, beforePrevious, previous, next, afterNext, listOrder, turnoverOrder])

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

  const requestedViewportEnd = historicalEnd ?? chartSeries.latestKnownHour(cacheKey) ?? 0
  const viewportRuns = useMemo(() => chartViewportRuns(cachedBars, intervalMS), [cachedBars, intervalMS])
  const viewportEnd = useMemo(() => renderableChartEndFromRuns(viewportRuns, requestedViewportEnd, intervalMS), [viewportRuns, requestedViewportEnd, intervalMS])
  const bars = useMemo(() => viewportEnd === null ? [] : visibleChartBars(cachedBars, viewportEnd, intervalMS), [cachedBars, viewportEnd, intervalMS])
  // A neighboring/preloaded response may update the shared canonical bars,
  // but its source status must never be displayed for this viewport.
  const viewportResponse = chart?.statusAuthoritative !== false && (chart?.statisticsEnd === undefined || chart.statisticsEnd === viewportEnd) ? chart : undefined
  const candleState = viewportEnd !== null && !chartIndicatorsNeedLoad(cachedBars, viewportEnd, 96, intervalMS) ? 'ready' : viewportResponse?.candleState ?? 'ready'
  const statisticsNeedLoad = viewportEnd !== null && chartStatsNeedLoad(bars, viewportEnd, 96, intervalMS)
  const observedStatistics = !statisticsNeedLoad && bars.length === 96 && bars.every(bar => bar.statisticsObserved === true)
  const localOIState: ChartStatisticsState = observedStatistics && bars.some(bar => bar.oi === null) ? 'unavailable' : 'ready'
  const localTakerState: ChartStatisticsState = observedStatistics && bars.some(bar => bar.buy === null || bar.sell === null) ? 'unavailable' : 'ready'
  // Near-live statistic feeds can lag candles. The main process may be
  // revalidating an observed-but-empty source; do not let the local terminal
  // null hide that authoritative progress state from the user.
  const statisticsRefreshing = viewportResponse?.oiState === 'loading' || viewportResponse?.oiState === 'retrying'
    || viewportResponse?.takerState === 'loading' || viewportResponse?.takerState === 'retrying'
  const useLocalStatistics = observedStatistics && !statisticsRefreshing
  const statisticsState: ChartStatisticsState = useLocalStatistics
    ? localOIState === 'ready' && localTakerState === 'ready' ? 'ready' : 'unavailable'
    : viewportResponse?.statisticsState ?? (statisticsNeedLoad ? 'loading' : 'ready')
  const oiState: ChartStatisticsState = useLocalStatistics ? localOIState : viewportResponse?.oiState ?? (statisticsNeedLoad ? 'loading' : 'ready')
  const takerState: ChartStatisticsState = useLocalStatistics ? localTakerState : viewportResponse?.takerState ?? (statisticsNeedLoad ? 'loading' : 'ready')
  const statisticsHistoryDays = STATISTICS_HISTORY_PERIODS * intervalMS / 86_400_000
  const statisticsHistoryCutoff = Date.now() - STATISTICS_HISTORY_PERIODS * intervalMS
  const oiOutsideHistory = bars.some(bar => bar.oi === null && bar.hour < statisticsHistoryCutoff)
  const takerOutsideHistory = bars.some(bar => (bar.buy === null || bar.sell === null) && bar.hour < statisticsHistoryCutoff)
  const incompleteViewport = requestedViewportEnd > 0 && viewportEnd !== requestedViewportEnd
  useEffect(() => {
    const hasStatisticsProgress = statisticsRefreshing || viewportResponse?.statisticsState === 'unavailable' && Number.isFinite(viewportResponse.statisticsRetryAt)
    if (focusSession === null || focusToken === null || historicalEnd === null || settledHistoricalEnd !== historicalEnd || !chartStatisticsRequestable(bars, historicalEnd, viewportEnd, 96, intervalMS) && !hasStatisticsProgress) return
    const requestKey = chartRequestKey('statistics', cacheKey, historicalEnd, focusSession, focusToken)
    if (statisticsRequests.current.has(requestKey) || statisticsRetryTimers.current.has(requestKey)) return
    const viewportIsCurrent = () => mountedRef.current && isCurrentChartViewportGeneration(windowEndRef.current && committedFocusRef.current ? {
      cacheKey: windowEndRef.current.id,
      end: windowEndRef.current.hour,
      focusToken: committedFocusRef.current.token,
    } : null, { cacheKey, end: historicalEnd, focusToken })
    const currentViewport = viewportIsCurrent
    const retry = (delay: number) => {
      if (!currentViewport() || statisticsRetryTimers.current.has(requestKey)) return
      const timer = window.setTimeout(() => {
        statisticsRetryTimers.current.delete(requestKey)
        if (viewportIsCurrent()) setStatisticsRetry(value => value + 1)
      }, Math.max(STATISTICS_PROGRESS_POLL_MS, delay))
      statisticsRetryTimers.current.set(requestKey, timer)
    }
    const startRequest = () => {
      if (!currentViewport() || statisticsRequests.current.has(requestKey)) return
      statisticsRequests.current.add(requestKey)
      // The first foreground request loads the canonical bar snapshot. Once
      // it exists, progress polling only needs the independent source states.
      // Returning another 500-bar indicator payload every 80ms was the hot
      // path behind the visible stall while OI/Taker were waiting.
      const statusOnly = viewportResponse?.statisticsEnd === historicalEnd
      const request = window.webkit.messageHandlers.radar.postMessage({
        chartInstId: instId, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken,
        chartEndHour: historicalEnd, chartStatusOnly: statusOnly || undefined,
      })
      void request.then(async result => {
        if (!currentViewport()) return
        // A concurrent prefetch can advance the canonical series before this
        // reply arrives. Discarding that reply must not discard this poll's
        // next turn as well: no render follows removal of the in-flight key.
        if ("unchanged" in result) { retry(STATISTICS_PROGRESS_POLL_MS); return }
        const barsRevisionBefore = chartSeries.get(cacheKey)?.barsRevision
        let observed: ChartResponse = result
        if (!rememberVisibleChart(observed).accepted) { retry(STATISTICS_PROGRESS_POLL_MS); return }
        // A status-only reply may observe a just-committed source page. Keep
        // the bars on screen immediately, then perform exactly one complete
        // read to merge the new OI/Taker values into the retained series.
        if (statusOnly && (observed.revision !== barsRevisionBefore
          || chartStatisticsSnapshotNeeded(chartSeries.get(cacheKey)?.bars ?? [], historicalEnd, observed, intervalMS))) {
          const full = await window.webkit.messageHandlers.radar.postMessage({
            chartInstId: instId, timeframe, chartFocusSession: focusSession, chartFocusToken: focusToken,
            chartEndHour: historicalEnd,
          })
          if (!currentViewport()) return
          if ("unchanged" in full) { retry(STATISTICS_PROGRESS_POLL_MS); return }
          observed = full
          if (!rememberVisibleChart(observed).accepted) { retry(STATISTICS_PROGRESS_POLL_MS); return }
        }
        const sourceLoading = observed.oiState === 'loading' || observed.takerState === 'loading'
        const sourceRetrying = observed.oiState === 'retrying' || observed.takerState === 'retrying'
        if (sourceLoading) retry(STATISTICS_PROGRESS_POLL_MS)
        else if (sourceRetrying || observed.statisticsState === 'unavailable' && Number.isFinite(observed.statisticsRetryAt)) retry(observed.statisticsRetryAt === null || observed.statisticsRetryAt === undefined ? STATISTICS_PROGRESS_POLL_MS : observed.statisticsRetryAt - Date.now())
      }).catch(() => retry(STATISTICS_PROGRESS_POLL_MS)).finally(() => statisticsRequests.current.delete(requestKey))
    }
    startRequest()
  }, [instId, cacheKey, timeframe, intervalMS, historicalEnd, settledHistoricalEnd, viewportEnd, bars, statisticsRetry, focusSession, focusToken, rememberVisibleChart, statisticsRefreshing, viewportResponse?.statisticsState, viewportResponse?.statisticsRetryAt, viewportResponse?.statisticsEnd])
  const inspectedIndex = inspection?.id === cacheKey ? bars.findIndex(bar => bar.hour === inspection.hour) : -1
  const inspected = inspectedIndex < 0 ? null : inspectedIndex
  const inspectAt = (target: SVGSVGElement, clientX: number) => {
    const rect = target.getBoundingClientRect()
    if (!bars.length || viewportEnd === null || rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    const { columns } = chartLayout(plotSize.width, plotSize.height, chartGutter(bars, plotSize.height, chart?.bars.at(-1)?.close).gutter)
    const [start, end] = columns.price
    let index = 0
    for (let i = 1; i < bars.length; i++) {
      if (Math.abs(chartHourX(bars[i].hour, viewportEnd, start, end, intervalMS) - svgX) < Math.abs(chartHourX(bars[index].hour, viewportEnd, start, end, intervalMS) - svgX)) index = i
    }
    const hour = bars[index].hour
    setInspection(current => current?.id === cacheKey && current.hour === hour ? current : { id: cacheKey, hour })
  }
  const moveHistory = (steps: number) => {
    const latestHour = chartSeries.latestKnownHour(cacheKey) ?? bars.at(-1)?.hour
    if (latestHour === undefined || steps === 0) return false
    const current = pendingWindowEndRef.current?.id === cacheKey ? pendingWindowEndRef.current.hour : historicalEnd
    const oldestAvailableHour = historyBoundary?.id === cacheKey ? historyBoundary.oldestHour : null
    const floor = Math.min(latestHour, chartScrollFloor(oldestCachedHour, oldestAvailableHour, 96, intervalMS))
    if (steps < 0 && floor >= latestHour) { wheelPixels.current = 0; return false }
    const candidate = scrollChartEnd(current, latestHour, steps, 0, intervalMS)
    const nextHour = candidate === null ? null : Math.max(floor, candidate)
    if (nextHour === current) {
      // A cache extension makes future input possible; it must never replay a
      // wheel burst that was already stopped at the old cache floor. Replaying
      // it produces the delayed self-scroll the user can see after loading.
      wheelPixels.current = 0
      return false
    }
    const next = nextHour === null ? null : { id: cacheKey, hour: nextHour }
    pendingWindowEndRef.current = next
    if (next === null) setSettledWindowEnd(null)
    // This is a tiny interaction state change; it must commit rather than be
    // interrupted, because its committed generation owns network retries.
    setWindowEnd(next)
    endInspection()
    return true
  }
  const flushWheel = () => {
    wheelFrame.current = null
    const steps = Math.max(-MAX_WHEEL_STEPS_PER_FRAME, Math.min(MAX_WHEEL_STEPS_PER_FRAME, Math.trunc(wheelPixels.current / WHEEL_PIXELS_PER_CANDLE)))
    if (!steps) return
    if (!moveHistory(steps)) return
    wheelPixels.current -= steps * WHEEL_PIXELS_PER_CANDLE
    if (wheelFrame.current === null && Math.abs(wheelPixels.current) >= WHEEL_PIXELS_PER_CANDLE) {
      wheelFrame.current = window.requestAnimationFrame(() => flushWheelRef.current())
    }
  }
  useLayoutEffect(() => {
    flushWheelRef.current = flushWheel
  })
  const queueWheel = (pixels: number) => {
    wheelPixels.current += pixels
    if (wheelFrame.current === null && Math.abs(wheelPixels.current) >= WHEEL_PIXELS_PER_CANDLE) {
      wheelFrame.current = window.requestAnimationFrame(() => flushWheelRef.current())
    }
  }
  const active = bars[inspected ?? bars.length - 1]
  const atHistoryBoundary = historicalEnd !== null && historyBoundary?.id === cacheKey
    && historicalEnd === Math.min(chartSeries.latestKnownHour(cacheKey) ?? historicalEnd, historyBoundary.oldestHour + 95 * intervalMS)
  const targetSurface = useMemo<ChartSurface | null>(() => bars.length && viewportEnd !== null ? {
    cacheKey, instId, timeframe, intervalMS, bars, endHour: viewportEnd, liveBar: chart?.bars.at(-1) ?? bars.at(-1)!,
  } : null, [cacheKey, instId, timeframe, intervalMS, bars, viewportEnd, chart])
  // Keep the completed SVG in place during a genuine first load for the next
  // key. The next chart replaces it atomically; stale data is non-interactive
  // and visibly labelled, so it cannot be mistaken for the selected series.
  const lastSurface = useRef<ChartSurface | null>(null)
  useLayoutEffect(() => {
    if (targetSurface) lastSurface.current = targetSurface
  }, [targetSurface])
  const surface = targetSurface ?? lastSurface.current
  const surfaceIsStale = surface !== null && targetSurface === null
  const analyzeChart = (direction: AnalysisDirection) => {
    if (!bars.length || plotSize.width <= 0 || captureStatus === 'copying') return
    flushSync(() => { setAnalysisOpen(true); setCapture({ id: cacheKey, status: 'idle', error: '' }) })
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
  return <ChartWorkspaceViewport expanded={analysisOpen}><main className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{backLabel}</Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight" title={instId}>{instId.replace(/-SWAP$/, "")}</h1>
      </div>
      <ToggleGroup type="single" variant="outline" value={timeframe} onValueChange={value => { if (value) onTimeframeChange?.(value as RadarTimeframe) }} aria-label="Chart timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup>
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
      <Badge variant="secondary"><Radio data-icon="inline-start" aria-hidden="true" />{historicalEnd !== null ? `${timeframeLabel(timeframe)} history` : active && !active.confirmed ? `Live ${timeframeLabel(timeframe)}` : `${timeframeLabel(timeframe)} chart`}</Badge>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}{historicalEnd !== null && ' Retrying automatically.'}</div>}
    {captureError && <p role="alert" className="shrink-0 border-b px-5 py-2 text-destructive">{captureError}</p>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={instId} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-chart-cache-start={cachedBars[0]?.hour} data-chart-requested-end={requestedViewportEnd || undefined} data-chart-rendered-bars={surface?.bars.length ?? 0} data-chart-target-bars={bars.length} data-chart-visual-stale={surfaceIsStale ? 'true' : 'false'} data-chart-candle-state={candleState} data-chart-statistics-state={statisticsState} data-chart-statistics-end={viewportResponse?.statisticsEnd} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete={incompleteViewport ? 'true' : 'false'} data-chart-loading={historyLoading === `${cacheKey}:${historicalEnd}` || candleState === 'loading' || candleState === 'retrying' || incompleteViewport || oiState === 'loading' || oiState === 'retrying' || takerState === 'loading' || takerState === 'retrying' ? 'true' : 'false'} data-surface="panel" aria-label={`${instId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-chart-surface">
      {active && <div className="grid shrink-0 grid-cols-[minmax(9rem,1.2fr)_repeat(4,minmax(0,1fr))] items-center border-b px-4 py-1.5 text-[length:var(--chart-text-size)]" aria-live="off">
        <p className="min-w-0 truncate border-r pr-3"><span className="font-medium">{instId.replace(/-SWAP$/, "")}</span> · <span className="text-muted-foreground">{inspected === null ? historicalEnd === null ? "Latest" : "Window end" : "Selected"}</span> {time(active.hour)}{active.confirmed ? "" : " · Live"}</p>
        {([ ["Open", active.open], ["High", active.high], ["Low", active.low], ["Close", active.close] ] as const).map(([label, value]) => <div key={label} className="min-w-0 px-3">
          <span className="text-muted-foreground">{label} </span><span title={price(value)}>{price(value)}</span>
        </div>)}
      </div>}
      <div ref={plotRef} data-chart-plot className="relative min-h-0 flex-1 overflow-hidden" onWheel={event => {
        if (analysis?.phase === 'capturing') return
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        const delta = horizontal ? event.deltaX : -event.deltaY
        const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1)
        queueWheel(pixels)
      }}>
        <div className="relative h-full w-full">
        {surface && plotSize.width > 0 ? <svg key={surface.cacheKey} viewBox={`0 0 ${plotSize.width} ${plotSize.height}`} className={cn("absolute inset-0 h-full w-full text-[length:var(--chart-text-size)] select-none focus-visible:outline-2 focus-visible:outline-ring", surfaceIsStale && "pointer-events-none")} role="img" tabIndex={surfaceIsStale ? -1 : 0} aria-hidden={surfaceIsStale} aria-label={`${surface.instId} 96-candle ${timeframeLabel(surface.timeframe)} chart with VWAP14, EMA200, Log BB, open interest contracts, and taker buy/sell contracts. Hold the primary mouse button to inspect a candle, drag while holding to inspect others, and release to return to the window end. Scroll to review history; returning to the latest candle resumes automatic following. Up and down arrows follow the visible market list order; left jumps to the first market in the current sorted search results and right jumps to the highest 24-hour turnover market satisfying Settings and applied indicator filters, regardless of search.`} onPointerDown={event => {
          if (surfaceIsStale || event.button !== 0 || heldPointer.current) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          heldPointer.current = { id: surface.instId, pointerId: event.pointerId, target: event.currentTarget }
          inspectAt(event.currentTarget, event.clientX)
        }} onPointerUp={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onPointerCancel={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onLostPointerCapture={event => {
          if (heldPointer.current?.pointerId === event.pointerId) endInspection()
        }} onPointerMove={event => {
          if (surfaceIsStale || heldPointer.current?.id !== surface.instId || heldPointer.current.pointerId !== event.pointerId) return
          if (!(event.buttons & 1)) { endInspection(); return }
          inspectAt(event.currentTarget, event.clientX)
        }}>
          <Plot bars={surface.bars} liveBar={surface.liveBar} inspected={surfaceIsStale ? null : inspected} width={plotSize.width} height={plotSize.height} now={1} endHour={surface.endHour} intervalMS={surface.intervalMS} oiState={oiState} takerState={takerState} />
        </svg> : null}
        {surfaceIsStale && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Loading {timeframeLabel(timeframe)} chart…</span>}
        {historicalEnd !== null && historyLoading === `${cacheKey}:${historicalEnd}` && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Loading indicator warm-up history…</span>}
        {historyLoading !== `${cacheKey}:${historicalEnd}` && (candleState === 'loading' || candleState === 'retrying' || incompleteViewport) && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{candleState === 'retrying' ? 'Retrying chart history…' : 'Loading chart history…'}</span>}
        {candleState === 'unavailable' && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{historicalEnd === null ? 'Latest source candles unavailable' : 'Missing source candles in this range'}</span>}
        {oiState !== 'ready' && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-10 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{oiState === 'unavailable' ? oiOutsideHistory ? `OKX ${timeframeLabel(timeframe)} OI history is limited to ${statisticsHistoryDays} days` : `OKX ${timeframeLabel(timeframe)} OI history is incomplete for this range` : oiState === 'retrying' ? 'Retrying OI data…' : 'Loading OI data…'}</span>}
        {takerState !== 'ready' && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-20 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">{takerState === 'unavailable' ? takerOutsideHistory ? `OKX ${timeframeLabel(timeframe)} Taker history is limited to ${statisticsHistoryDays} days` : `OKX ${timeframeLabel(timeframe)} Taker history is incomplete for this range` : takerState === 'retrying' ? 'Retrying Taker data…' : 'Loading Taker data…'}</span>}
        {atHistoryBoundary && <span role="status" data-surface="control" className="pointer-events-none absolute right-4 top-2 rounded-(--control-radius) border bg-chart-annotation px-2 py-1 text-xs text-muted-foreground">Start of available history</span>}
        </div>
      </div>
      {captureStatus === "flashing" && <div aria-hidden="true" data-surface="inherited" className="pointer-events-none absolute inset-0 z-10 bg-[var(--chart-capture-flash)] motion-safe:animate-[chart-capture-flash_550ms_ease-out_both] motion-reduce:hidden" />}
    </section>
    {analysisOpen && <ChartAnalysisPanel instId={instId} timeframe={timeframeLabel(timeframe)} session={analysis} ready={bars.length > 0 && plotSize.width > 0 && captureStatus !== 'copying'} onNew={() => analyzeChart(analysis?.direction ?? 'long')} onClose={() => { chartAnalysis.stop(instId); setAnalysisOpen(false) }} />}
    </div>
  </main></ChartWorkspaceViewport>
}
