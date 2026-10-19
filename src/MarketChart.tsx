import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { Camera, Radio } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ChartAnalysisPanel } from '@/ChartAnalysisPanel'
import { chartAnalysis } from '@/analysis-service'
import { type AnalysisDirection } from '@/chart-analysis'
import { chartCaptureBounds } from '@/chart-capture'
import { CHART_PANELS, chartPriceLabelLayout, type ChartPanel as Panel } from "@/chart-layout"
import { chartCompact as compact, chartPrice as price, chartPercent, createChartGeometryCache, type ChartGeometry } from "@/chart-geometry"
import { chartStatisticsSamples } from '@/chart-legend'
import { cn } from "@/lib/utils"
import { chartNavigationTarget } from "@/market-sort"
import { formatPercent } from "@/market-percent"
import { RADAR_TIMEFRAMES, timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

import { chartController } from '@/chart-controller'
import type { Bar, PreparedChartState } from '@/chart-data'

const EMPTY_BARS: readonly Bar[] = []
const PriceStatus = memo(function PriceStatus({ observedAt, realtime }: { observedAt?: number | null; realtime?: 'live' | 'stale' }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const fresh = realtime === 'live' && observedAt != null && now - observedAt < 30_000
  return <Badge variant="secondary" role="status" title={observedAt ? `Last price observation ${new Date(observedAt).toLocaleTimeString('en-US')}` : 'Waiting for a current price observation'}>{fresh ? 'Live price' : 'Cached price'}</Badge>
})

const chartTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
const time = (hour: number) => chartTimeFormatter.format(hour)
const hourLabel = time
const chartStyle = getComputedStyle(document.documentElement)
const chartTokenNumber = (token: string, fallback: number) => {
  const value = Number.parseFloat(chartStyle.getPropertyValue(token))
  return Number.isFinite(value) ? value : fallback
}
const chartTokens = {
  textSize: chartTokenNumber('--chart-text-size', 10),
  legendGap: chartTokenNumber('--chart-legend-gap', 24),
  priceLabelPaddingY: chartTokenNumber('--chart-price-label-padding-y', 3),
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
const PriceCountdown = memo(function PriceCountdown({ hour, intervalMS, x, y }: { hour: number; intervalMS: number; x: number; y: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((hour + intervalMS - now) / 1000))
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return <text data-chart-countdown x={x} y={y} dominantBaseline="middle" fill="var(--muted-foreground)">{value}</text>
})
const chartGeometry = createChartGeometryCache(legendWidth)

export const Plot = memo(function Plot({ bars, geometry, liveBar, liveOverlay = false, inspected, oiState = 'ready', takerState = 'ready' }: { bars: readonly Bar[]; geometry: ChartGeometry; liveBar: Bar; liveOverlay?: boolean; inspected: number | null; oiState?: PreparedChartState; takerState?: PreparedChartState }) {
  const areaClipId = useId().replaceAll(":", "")
  const n = bars.length
  const active = bars[inspected ?? n - 1]
  const statistics = chartStatisticsSamples(bars, inspected)
  const { height, endHour, intervalMS, gutter, x, firstHour, candleHigh, candleLow, highIndex, lowIndex,
    oiComplete, takerComplete, oiSamples, takerAvailable, rocAxis, oiAxis,
    priceY, rsiY, oiY, rocZeroY, lines, rocAreas, bollBands, upWicks, downWicks, upBodies, downBodies, buys, sells } = geometry
  const { panels, columns, axisStarts, headerY, right } = geometry.layout
  const tag = { price: liveBar.close, rising: liveBar.close >= liveBar.open, inViewport: liveBar.hour <= endHour + (liveOverlay ? intervalMS : 0) }
  const latestY = priceY(tag.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--negative)"
  const latestPrice = `${price(tag.price)} ${tag.rising ? '↑' : '↓'}`
  const priceLabel = chartPriceLabelLayout(latestY, panels.price, chartTokens.textSize, chartTokens.priceLabelPaddingY, liveOverlay)
  const tickHalfHeight = chartTokens.textSize / 2
  const lineStroke = (key: keyof Bar, d: string, color: string, dash?: string) => <path data-chart-indicator={key} d={d} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
  const lineLabel = (x: number, y: number, label: string, color = "var(--muted-foreground)") =>
    <text x={x} y={y} dominantBaseline="middle" fill={color}>{label}</text>
  const panelKeys = CHART_PANELS
  const grid = panelKeys.flatMap(key => panels[key].map((y, index) =>
    <line key={`${key}-${index}`} x1={columns[key][0]} x2={columns[key][1]} y1={y} y2={y} stroke="var(--border)" opacity={index ? 0.32 : 0.55} />))
  const legend = (key: Panel, items: [string, string, string, string?, number?][]) => {
    const gap = chartTokens.legendGap
    const start = columns[key][0] + gap / 2
    const contexts = items.map(([, , , , sourceHour]) => sourceHour !== undefined && sourceHour !== active.hour ? ` · as of ${time(sourceHour)}` : '')
    const widths = items.map(([label, value], index) => 26 + legendWidth(label) + 10 + legendWidth(value) + legendWidth(contexts[index]))
    const available = right - start
    const required = widths.reduce((sum, itemWidth) => sum + itemWidth, 0) + gap * (items.length - 1)
    const shrink = Math.min(1, available / required)
    let cursor = 0
    return <g key={key} data-chart-panel-header={key}>
      <g transform={`translate(${start},${headerY[key]}) scale(${shrink})`}>
      {items.map(([label, value, color, dash, sourceHour], index) => {
        const itemStart = cursor
        cursor += widths[index] + gap
        const labelColor = key === "taker" ? index === 0 ? "var(--chart-positive-label)" : "var(--chart-negative-label)" : color
        return <g key={label} transform={`translate(${itemStart},0)`} data-chart-legend-source-hour={sourceHour}>
        {key === "taker" && !dash && <line data-chart-legend-outline={label} x1="0" x2="18" stroke="var(--foreground)" />}
        <line data-chart-legend={label} x1="0" x2="18" stroke={color} strokeDasharray={key === "taker" && !dash ? "2 3" : dash} />
        <text x="26" dominantBaseline="middle" fill={labelColor}>{label}</text>
        <text x={26 + legendWidth(label) + 10} dominantBaseline="middle" fill="var(--foreground)">{value}</text>
        {contexts[index] && <text data-chart-legend-source-context x={26 + legendWidth(label) + 10 + legendWidth(value)} dominantBaseline="middle" fill="var(--muted-foreground)">{contexts[index]}</text>}
        </g>
      })}
      </g>
    </g>
  }
  return <>
    <defs>
      <pattern id="sell-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" x2="0" y1="0" y2="4" stroke="var(--background)" opacity="0.55" />
      </pattern>
      <clipPath id={`${areaClipId}-positive`}><rect x={columns.roc[0]} y={panels.roc[0]} width={columns.roc[1] - columns.roc[0]} height={rocZeroY - panels.roc[0]} /></clipPath>
      <clipPath id={`${areaClipId}-negative`}><rect x={columns.roc[0]} y={rocZeroY} width={columns.roc[1] - columns.roc[0]} height={panels.roc[1] - rocZeroY} /></clipPath>
    </defs>
    {bollBands.map((d, index) => <path key={index} data-chart-boll-band d={d} fill="var(--chart-1)" fillOpacity="0.1" />)}
    {rocAreas.map((area, index) => <g key={index}>
      <path d={area} fill="var(--chart-roc-positive-area)" clipPath={`url(#${areaClipId}-positive)`} />
      <path d={area} fill="var(--chart-roc-negative-area)" clipPath={`url(#${areaClipId}-negative)`} />
    </g>)}
    <rect x={columns.rsi[0]} y={rsiY(70)} width={columns.rsi[1] - columns.rsi[0]} height={rsiY(30) - rsiY(70)} fill="var(--chart-rsi-area)" />
    {grid}
    {rocZeroY > panels.roc[0] && rocZeroY < panels.roc[1] && <line x1={columns.roc[0]} x2={columns.roc[1]} y1={rocZeroY} y2={rocZeroY} stroke="var(--muted-foreground)" strokeOpacity="0.5" />}
    {bars.flatMap((bar, index) => (bar.hour - firstHour) % (12 * intervalMS) === 0 ? panelKeys.map(key => <line key={`${(bar.hour - firstHour) / intervalMS}-${key}`} x1={x[index]} x2={x[index]} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />) : [])}
    {bars.map((bar, index) => ({ bar, index })).filter(({ bar, index }) => index === n - 1 || (bar.hour - firstHour) % (24 * intervalMS) === 0).map(({ bar, index }) => <text key={(bar.hour - firstHour) / intervalMS} x={x[index]} y={height - 7} textAnchor={index === 0 ? "start" : index === n - 1 ? "end" : "middle"} fill="var(--muted-foreground)">{hourLabel(bar.hour)}</text>)}
    {geometry.priceTicks.map(({ y, label }, index) => <g key={index} data-chart-price-tick><line x1={columns.price[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.35" />{(!tag.inViewport || y + tickHalfHeight < priceLabel.top || y - tickHalfHeight > priceLabel.bottom) && lineLabel(axisStarts.price, y, label)}</g>)}
    <line x1={right} x2={right} y1={panels.price[0]} y2={panels.taker[1]} stroke="var(--border)" opacity="0.8" />
    {tag.inViewport && tag.rising && <line data-chart-live-price-outline x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke="var(--foreground)" />}
    {tag.inViewport && <line data-chart-live-price x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke={latestColor} strokeDasharray="4 5" />}
    {/* Expose contrasting segments within the same 1px stroke for the mandated light green. */}
    <path d={upWicks} fill="none" stroke="var(--foreground)" />
    <path d={upWicks} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path d={downWicks} fill="none" stroke="var(--negative)" />
    <path d={upBodies} fill="var(--background)" stroke="var(--foreground)" />
    <path data-chart-candle-direction="up" data-chart-candle-fill="hollow" d={upBodies} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path data-chart-candle-direction="down" data-chart-candle-fill="solid" d={downBodies} fill="var(--negative)" />
    <g data-chart-taker={takerComplete ? "complete" : takerAvailable ? "partial" : "empty"} data-chart-taker-state={takerState}>
      <path data-chart-taker-buy-samples={geometry.buySamples} d={buys} fill="var(--positive)" stroke="var(--foreground)" opacity="0.9" />
      <path data-chart-taker-sell-samples={geometry.sellSamples} d={sells} fill="var(--negative)" stroke="var(--foreground)" opacity="0.9" />
      <path d={sells} fill="url(#sell-hatch)" opacity="0.7" />
    </g>
    {lineStroke("bollUpper", lines.bollUpper, "var(--chart-1)")}
    {lineStroke("bollMiddle", lines.bollMiddle, "var(--chart-1)")}
    {lineStroke("bollLower", lines.bollLower, "var(--chart-1)")}
    {lineStroke("vwap", lines.vwap, "var(--chart-2)", "2 3")}
    {lineStroke("ema", lines.ema, "var(--chart-3)", "7 4")}
    {lineStroke("rsi6", lines.rsi6, "var(--chart-1)")}
    {lineStroke("rsi12", lines.rsi12, "var(--chart-2)", "7 4")}
    {lineStroke("rsi24", lines.rsi24, "var(--chart-3)", "1 4")}
    <g data-chart-volatility-panel data-chart-panel-top={panels.atr[0]} data-chart-panel-bottom={panels.atr[1]}>
      {lineStroke("atrPercent", lines.atrPercent, "var(--chart-3)")}
      {lineStroke("bbw", lines.bbw, "var(--chart-1)", "7 4")}
    </g>
    {lineStroke("roc", lines.roc, "var(--chart-1)")}
    {lineStroke("maroc", lines.maroc, "var(--chart-2)", "7 4")}
    <g data-chart-oi={oiAxis ? oiComplete ? "complete" : "partial" : "empty"} data-chart-oi-state={oiState} data-chart-oi-samples={oiSamples.length}>
      {oiAxis && <>{lineStroke("oi", lines.oi, "var(--chart-2)")}{!oiComplete && oiSamples.map(sample => <circle key={bars[sample.index].hour} data-chart-oi-sample cx={x[sample.index]} cy={oiY(sample.value)} r="2" fill="var(--chart-2)" />)}</>}
    </g>
    {inspected !== null && panelKeys.map(key => <line key={key} x1={x[inspected]} x2={x[inspected]} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--foreground)" strokeDasharray="3 5" opacity="0.3" />)}
    {([[highIndex, candleHigh, "high"], [lowIndex, candleLow, "low"]] as const).map(([index, value, kind]) => {
      const markerX = x[index], label = price(value)
      const labelWidth = label.length * 6.5 + 8
      const start = index < n / 2 ? markerX + 10 : markerX - labelWidth - 10
      return <g key={kind}>
        <line x1={markerX} x2={index < n / 2 ? markerX + 10 : markerX - 10} y1={priceY(value)} y2={priceY(value)} stroke="var(--foreground)" />
        {lineLabel(start, priceY(value), label, "var(--foreground)")}
      </g>
    })}
    {tag.inViewport && <g data-chart-price-label>
      <rect data-chart-price-label-background x={right} y={priceLabel.top} width={gutter} height={priceLabel.bottom - priceLabel.top} fill="var(--chart-annotation)" />
      <text data-chart-price-label-value x={axisStarts.price} y={latestY} dominantBaseline="middle" fill="var(--foreground)">{latestPrice}</text>
      {priceLabel.countdownY !== null && <PriceCountdown hour={liveBar.hour} intervalMS={intervalMS} x={axisStarts.price} y={priceLabel.countdownY} />}
    </g>}
    {legend("price", [["VWAP(14)", price(active.vwap), "var(--chart-2)", "2 3"], ["EMA(200)", price(active.ema), "var(--chart-3)", "7 4"], ["BOLL(20,2)", `U ${price(active.bollUpper)}\u00a0·\u00a0M ${price(active.bollMiddle)}\u00a0·\u00a0L ${price(active.bollLower)}`, "var(--chart-1)"]])}
    {legend("roc", [["ROC(9)", formatPercent(active.roc), "var(--chart-1)"], ["MAROC(9)", formatPercent(active.maroc), "var(--chart-2)", "7 4"]])}
    {legend("rsi", [["RSI(6)", active.rsi6?.toFixed(1) ?? "—", "var(--chart-1)"], ["RSI(12)", active.rsi12?.toFixed(1) ?? "—", "var(--chart-2)", "7 4"], ["RSI(24)", active.rsi24?.toFixed(1) ?? "—", "var(--chart-3)", "1 4"]])}
    {legend("atr", [["ATR%(14)", chartPercent(active.atrPercent), "var(--chart-3)"], ["BBW(20,2)", chartPercent(active.bbw), "var(--chart-1)", "7 4"]])}
    {legend("oi", [["OI (Contracts)", statistics.oi ? compact(statistics.oi.oi) : "Unavailable", "var(--chart-2)", undefined, statistics.oi?.hour]])}
    {legend("taker", [["↑ Taker Buy (Contracts)", statistics.taker ? compact(statistics.taker.buy) : "Unavailable", "var(--positive)", undefined, statistics.taker?.hour], ["↓ Taker Sell (Contracts)", statistics.taker ? compact(statistics.taker.sell) : "Unavailable", "var(--negative)", "2 3", statistics.taker?.hour]])}
    {panels.rsi[1] - panels.rsi[0] >= 35 && <>{lineLabel(axisStarts.rsi, panels.rsi[0], "100")}{lineLabel(axisStarts.rsi, panels.rsi[1], "0")}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && <>{lineLabel(axisStarts.roc, panels.roc[0], formatPercent(rocAxis.max, rocAxis.decimals))}{lineLabel(axisStarts.roc, panels.roc[1], formatPercent(rocAxis.min, rocAxis.decimals))}</>}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && geometry.oiTicks.map(({ y, label }, index) => <g key={index}><line x1={columns.oi[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, y, label)}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && geometry.takerTicks.map(({ y, label }, index) => <g key={index}>{lineLabel(axisStarts.taker, y, label)}</g>)}
  </>
})

export function MarketChart({ instId, timeframe = '15m', onTimeframeChange, listOrder, turnoverOrder, onSelect }: { instId: string; timeframe?: RadarTimeframe; onTimeframeChange?: (value: RadarTimeframe) => void; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void }) {
  const view = useSyncExternalStore(chartController.subscribe, chartController.getSnapshot)
  useLayoutEffect(() => chartController.open(instId, timeframe), [instId, timeframe])
  const surface = view.presented
  const matchesSelection = surface?.instId === instId && surface.timeframe === timeframe
  const pending = view.pending || !matchesSelection
  const unavailable = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.unavailable : null
  const unavailableText = unavailable ? `${instId.replace(/-SWAP$/, '')} has ${unavailable.availableCandles} completed ${timeframeLabel(timeframe)} candles. A complete chart requires ${unavailable.requiredCandles}.` : ''
  const confirmedBars = surface?.bars ?? EMPTY_BARS, formingBar = surface?.liveBar
  const bars = useMemo(() => formingBar ? [...confirmedBars.filter(bar => bar.hour < formingBar.hour), formingBar].slice(-96) : confirmedBars, [confirmedBars, formingBar])
  const intervalMS = surface?.intervalMS ?? timeframeMilliseconds(timeframe)
  const displayedId = surface?.instId ?? instId
  const displayedFrame = surface?.timeframe ?? timeframe
  const error = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.error : ''
  const requestedEnd = view.requested?.end ?? view.latestEnd
  const historical = surface ? surface.endHour !== chartController.store.latestEnd(surface.instId, surface.timeframe) : false
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const plotEnd = bars.at(-1)?.hour ?? 0
  const plotLive = surface?.liveBar ?? bars.at(-1)
  const plotGeometry = bars.length && plotSize.width > 0 ? chartGeometry(bars, { ...plotSize, endHour: plotEnd, intervalMS,
    liveClose: plotLive && plotLive.hour <= plotEnd + (surface?.liveBar ? intervalMS : 0) ? plotLive.close : undefined }) : null
  const [inspection, setInspection] = useState<{ instId: string; timeframe: RadarTimeframe; hour: number } | null>(null)
  const inspectedIndex = inspection?.instId === surface?.instId && inspection?.timeframe === surface?.timeframe ? bars.findIndex(bar => bar.hour === inspection?.hour) : -1
  const inspected = inspectedIndex >= 0 ? inspectedIndex : null
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
  const navigationTask = useRef<object | null>(null)
  useEffect(() => () => chartAnalysis.stop(instId), [instId, timeframe])
  useLayoutEffect(() => {
    navigationId.current = instId
    navigationTask.current = null
    wheelPixels.current = 0
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
    releaseInspection()
  }, [instId, timeframe, releaseInspection])
  useLayoutEffect(() => {
    const element = chartRef.current
    if (element) {
      Object.defineProperty(element, '__chartSnapshot', { configurable: true, value: surface })
      Object.defineProperty(element, '__chartRenderedBars', { configurable: true, value: bars })
    }
  }, [surface, bars])
  useEffect(() => () => {
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    navigationTask.current = null
  }, [])
  useLayoutEffect(() => {
    const element = plotRef.current
    if (!element) return
    const measure = (width: number, height: number) => setPlotSize(current => current.width === width && current.height === height ? current : { width, height })
    // Client dimensions stay in chart coordinates when the workspace is scaled.
    measure(element.clientWidth, element.clientHeight)
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height))
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
      if (navigationTask.current === null) {
        const task = navigationTask.current = {}
        queueMicrotask(() => {
          if (navigationTask.current !== task) return
          navigationTask.current = null
          flushSync(() => onSelect(navigationId.current))
        })
      }
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
    if (!surface || !bars.length || !plotGeometry) return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    let nearest = 0
    for (let index = 1; index < bars.length; index += 1) {
      if (Math.abs(plotGeometry.x[index] - svgX)
        < Math.abs(plotGeometry.x[nearest] - svgX)) nearest = index
    }
    setInspection({ instId: surface.instId, timeframe: surface.timeframe, hour: bars[nearest].hour })
  }
  const captureChart = async () => {
    if (pending || !surface || !chartRef.current) return
    setCapture({ status: 'copying', error: '' })
    try {
      const result = await window.radarDesktop.request({ captureChart: chartCaptureBounds(chartRef.current) })
      if (!result.ok) throw new Error('Could not copy chart.')
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
      const image = await window.radarDesktop.request({ captureChart: { ...chartCaptureBounds(element), output: 'png' } })
      return { ...image, capturedAt: Date.now(), rangeLabel: `${time(capturedSurface.bars[0]!.hour)} – ${time(capturedSurface.endHour)}` }
    }, direction)
  }
  const active = bars[inspected ?? bars.length - 1]
  const oiState = surface?.oiState ?? 'ready'
  const takerState = surface?.takerState ?? 'ready'
  const atBoundary = view.historyExhausted && surface && view.oldestHour !== null && surface.endHour === Math.min(view.latestEnd ?? Infinity, view.oldestHour + 95 * intervalMS)
  const priceScale = plotGeometry?.priceAxis.kind ?? 'logarithmic'
  const statusMessages: string[] = []
  if (unavailable) statusMessages.push(unavailableText)
  else if (pending) statusMessages.push(surface ? `Preparing ${instId.replace(/-SWAP$/, '')} ${timeframeLabel(timeframe)}${requestedEnd !== null ? ` · ${time(requestedEnd)}` : ''}…` : 'Loading local prices…')
  if (surface?.indicatorState === 'loading') statusMessages.push('Calculating indicators…')
  if (oiState === 'loading') statusMessages.push('Loading OI history…')
  if (takerState === 'loading') statusMessages.push('Loading taker history…')
  if (oiState === 'unavailable') statusMessages.push(`OKX ${timeframeLabel(displayedFrame)} OI history is incomplete for this range`)
  if (takerState === 'unavailable') statusMessages.push(`OKX ${timeframeLabel(displayedFrame)} Taker history is incomplete for this range`)
  if (atBoundary && !pending) statusMessages.push('Start of available history')
  if (!statusMessages.length) statusMessages.push(error ? 'Chart update failed' : 'Chart ready')
  const statusLoading = (pending && !unavailable) || surface?.indicatorState === 'loading' || oiState === 'loading' || takerState === 'loading'
  const statusSummary = statusMessages.join(' · ')
  return <section data-chart-workspace aria-label="Market chart workspace" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
      <div className="min-w-0 flex-1"><h2 className="truncate text-base font-semibold tracking-tight" title={displayedId}>{displayedId.replace(/-SWAP$/, '')}</h2></div>
      <ToggleGroup variant="outline" value={[timeframe]} onValueChange={values => { const value = values[0]; if (value) onTimeframeChange?.(value as RadarTimeframe) }} aria-label="Chart timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup>
      <Button variant="outline" size="sm" disabled={pending || !bars.length || plotSize.width <= 0 || captureStatus === 'copying' || analysis?.phase === 'capturing'} onClick={() => { void captureChart() }}><Camera data-icon="inline-start" aria-hidden="true" />{captureStatus === 'copying' ? 'Copying…' : 'Copy chart'}</Button>
      <ButtonGroup aria-label="Chart analysis actions">{(['long', 'short'] as const).map(direction => <Button key={direction} variant="outline" size="sm" disabled={captureStatus === 'copying' || (analysis?.direction !== direction && (analysisBusy || pending || !bars.length || plotSize.width <= 0))} title={analysis?.direction === direction ? `Open existing ${direction} analysis` : undefined} onClick={() => { if (analysis?.direction === direction) setAnalysisOpen(true); else analyzeChart(direction) }}>{analysisBusy && analysis?.direction === direction && <Spinner data-icon="inline-start" />}Analyze {direction === 'long' ? 'Long' : 'Short'}</Button>)}</ButtonGroup>
      <span role="status" className="sr-only">{captureStatus === 'flashing' ? 'Chart copied to clipboard' : ''}</span>
      <Badge variant="secondary"><Radio data-icon="inline-start" aria-hidden="true" />{historical ? `${timeframeLabel(displayedFrame)} history` : `${timeframeLabel(displayedFrame)} chart`}</Badge>
      {!historical && <PriceStatus observedAt={surface?.priceObservedAt} realtime={surface?.realtimeState} />}
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}</div>}
    {capture.error && <p role="alert" className="shrink-0 border-b px-5 py-2 text-destructive">{capture.error}</p>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={displayedId} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-chart-completed-end={surface?.endHour} data-chart-cache-start={view.oldestHour ?? undefined} data-chart-requested-end={requestedEnd ?? undefined} data-chart-rendered-bars={bars.length} data-chart-target-bars={96} data-chart-visual-stale={surface && !matchesSelection ? 'true' : 'false'} data-chart-candle-state={surface?.priceState ?? (bars.length ? 'ready' : 'loading')} data-chart-statistics-state={surface?.oiState === 'loading' || surface?.takerState === 'loading' ? 'loading' : surface?.oiState === 'unavailable' || surface?.takerState === 'unavailable' ? 'unavailable' : surface ? 'ready' : 'loading'} data-chart-statistics-end={surface?.endHour} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete={bars.length < 96 || bars.some((bar, index) => index > 0 && bar.hour - bars[index - 1].hour !== intervalMS) ? 'true' : 'false'} data-chart-loading={pending && !unavailable ? 'true' : 'false'} aria-label={`${displayedId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {active && <div className="grid shrink-0 grid-cols-[minmax(9rem,1.2fr)_repeat(4,minmax(0,1fr))] items-center border-b px-4 py-1.5 text-[length:var(--chart-text-size)]" aria-live="off">
        <p className="min-w-0 truncate border-r pr-3"><span className="font-medium">{displayedId.replace(/-SWAP$/, '')}</span> · <span className="text-muted-foreground">{inspected === null ? historical ? 'Window end' : 'Latest' : 'Selected'}</span> {time(active.hour)}</p>
        {([['Open', active.open], ['High', active.high], ['Low', active.low], ['Close', active.close]] as const).map(([label, value]) => <div key={label} className="min-w-0 px-3"><span className="text-muted-foreground">{label} </span><span title={price(value)}>{price(value)}</span></div>)}
      </div>}
      <p data-chart-price-scale={priceScale} className="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground">{priceScale === 'linear' ? 'Linear scale · BOLL includes zero or negative values' : 'Logarithmic price scale'} · ↑ Hollow candles rise · ↓ Solid candles fall</p>
      <div data-chart-status role="status" aria-live="polite" aria-atomic="true" className="flex h-8 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
        <Badge variant="secondary">{statusLoading && <Spinner data-icon="inline-start" aria-hidden="true" role="presentation" />}Chart status</Badge>
        <p className="min-w-0 truncate" title={statusSummary}>{statusMessages.map((message, index) => <span key={message}>{index > 0 && ' · '}<span>{message}</span></span>)}</p>
      </div>
      <div ref={plotRef} data-chart-plot className="relative min-h-0 flex-1 overflow-hidden" onWheel={event => {
        if (analysis?.phase === 'capturing') return
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY
        queueWheel(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1))
      }}>
        {surface && plotGeometry && bars.length > 0 && plotSize.width > 0 ? <svg key={surface.key} strokeWidth="var(--chart-line-width)" data-rendered-inst={surface.instId} data-rendered-timeframe={surface.timeframe} data-rendered-start={bars[0]!.hour} data-rendered-end={bars.at(-1)!.hour} viewBox={`0 0 ${plotSize.width} ${plotSize.height}`} className={cn('absolute inset-0 h-full w-full text-[length:var(--chart-text-size)] select-none focus-visible:outline-2 focus-visible:outline-ring', !matchesSelection && 'pointer-events-none')} role="img" tabIndex={matchesSelection ? 0 : -1} aria-label={`${surface.instId} ${bars.length}-candle ${timeframeLabel(surface.timeframe)} chart. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window end. Scroll to review history. Arrow keys navigate markets.`} onPointerDown={event => {
          if (!matchesSelection || event.button !== 0 || heldPointer.current) return
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          heldPointer.current = { pointerId: event.pointerId, target: event.currentTarget }
          inspectAt(event.currentTarget, event.clientX)
        }} onPointerUp={endInspection} onPointerCancel={endInspection} onLostPointerCapture={endInspection} onPointerMove={event => {
          if (!matchesSelection || heldPointer.current?.pointerId !== event.pointerId) return
          if (!(event.buttons & 1)) { endInspection(); return }
          inspectAt(event.currentTarget, event.clientX)
        }}><Plot bars={bars} geometry={plotGeometry} liveBar={surface.liveBar ?? bars.at(-1)!} liveOverlay={!!surface.liveBar} inspected={inspected} oiState={oiState} takerState={takerState} /></svg> : null}
      </div>
      {captureStatus === 'flashing' && <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 bg-[var(--chart-capture-flash)] motion-safe:animate-[chart-capture-flash_550ms_ease-out_both] motion-reduce:hidden" />}
    </section>
    {analysisOpen && <ChartAnalysisPanel instId={instId} timeframe={timeframeLabel(timeframe)} session={analysis} ready={!pending && bars.length > 0 && plotSize.width > 0 && captureStatus !== 'copying'} onNew={() => analyzeChart(analysis?.direction ?? 'long')} onClose={() => { chartAnalysis.stop(instId); setAnalysisOpen(false) }} />}
    </div>
  </section>
}
