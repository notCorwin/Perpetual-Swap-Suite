import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { Camera } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ChartAnalysisPanel } from '@/ChartAnalysisPanel'
import { chartAnalysis } from '@/analysis-service'
import { type AnalysisDirection } from '@/chart-analysis'
import { chartCaptureBounds } from '@/chart-capture'
import { CHART_PANELS, chartContentClip, chartPanelClip, chartPriceLabelLayout, type ChartPanel as Panel } from "@/chart-layout"
import { chartCompact as compact, chartPrice as price, chartPercent, type ChartGeometry } from "@/chart-geometry"
import { chartRsiNavigationTarget, chartWheelContentOffset, createChartWheelBatch } from '@/chart-navigation'
import { chartStatisticsSamples } from '@/chart-legend'
import { RSI_FIELDS, type RsiField } from '@/rsi-crossings'
import { cn } from "@/lib/utils"
import { chartNavigationTarget } from "@/market-sort"
import { formatPercent } from "@/market-percent"
import { RADAR_TIMEFRAMES, timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

import { chartController } from '@/chart-controller'
import { createChartPlotCache } from '@/chart-render'
import type { Bar, ChartSourceStatus, PreparedChartState, ReadyChartWindow } from '@/chart-data'
import { measureOperation } from '../electron/services/operations.js'

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
  legendContext.font = `${fontSize}px ${chartStyle.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'}`
  const width = legendContext.measureText(normalized).width
  chartTextWidths.set(key, width)
  return width
}
const legendWidth = (text: string) => chartTextWidth(text)
const PlotVisible = createContext(true)
const PriceCountdown = memo(function PriceCountdown({ hour, intervalMS, x, y }: { hour: number; intervalMS: number; x: number; y: number }) {
  const [now, setNow] = useState(Date.now)
  const visible = useContext(PlotVisible)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible])
  const seconds = Math.max(0, Math.floor((hour + intervalMS - now) / 1000))
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return <text data-chart-countdown x={x} y={y} dominantBaseline="middle" fill="var(--muted-foreground)">{value}</text>
})
const sourceStatusText = (label: string, state: PreparedChartState, status?: ChartSourceStatus) => {
  if (state === 'error') return `${label} failed: ${status?.error || 'Source request failed'}${status?.retryAt ? ` · retry at ${new Date(status.retryAt).toLocaleTimeString('en-US', { hour12: false })}` : status?.retryOn === 'worker-recovery' ? ' · waiting for calculation service recovery' : status?.retryOn === 'input-change' ? ' · waiting for updated data' : ''}`
  if (state === 'loading') return `Loading ${label} history…`
  if (state === 'unavailable') return status?.reason === 'unsupported' ? `${label} history is unsupported` : `${label} is not published for part of this range`
  return ''
}
const chartPlot = createChartPlotCache(legendWidth)
const chartOverscan = (surface: ReadyChartWindow | null): { before?: Bar; after?: Bar } => {
  if (!surface?.bars.length) return {}
  const bars = surface.liveBar
    ? [...surface.bars.filter(bar => bar.hour < surface.liveBar!.hour), surface.liveBar].slice(-96)
    : surface.bars
  const first = bars[0]!.hour, last = bars.at(-1)!.hour
  const [before, after] = chartController.store.knownBars(surface.instId, surface.timeframe,
    [first - surface.intervalMS, last + surface.intervalMS])
  return { before, after }
}

export const Plot = memo(function Plot({ bars, geometry, liveBar, liveOverlay = false, inspected, inspectedBar, contentOffset = 0, oiState = 'ready', takerState = 'ready', oiStatus, takerStatus }: { bars: readonly Bar[]; geometry: ChartGeometry; liveBar: Bar; liveOverlay?: boolean; inspected: number | null; inspectedBar?: Bar; contentOffset?: number; oiState?: PreparedChartState; takerState?: PreparedChartState; oiStatus?: ChartSourceStatus; takerStatus?: ChartSourceStatus }) {
  const areaClipId = useId().replaceAll(":", "")
  return measureOperation({ category: 'cpu', name: 'chart.svg.construct', attributes: { candles: bars.length, inspected: inspected !== null } }, () => {
  const n = bars.length
  const inspecting = inspected !== null || inspectedBar !== undefined
  const active = inspectedBar ?? bars[inspected ?? n - 1]
  const statistics = inspectedBar ? chartStatisticsSamples([inspectedBar], 0) : chartStatisticsSamples(bars, inspected)
  const { height, endHour, intervalMS, gutter, x, firstHour, candleHigh, candleLow, highIndex, lowIndex,
    oiComplete, takerComplete, oiSamples, takerAvailable, rocAxis, oiAxis,
    priceY, rsiY, oiY, rocZeroY, lines, rocAreas, bollBands, upWicks, downWicks, upBodies, downBodies, buys, sells, rsiMarkers } = geometry
  const { panels, columns, axisStarts, headerY, right } = geometry.layout
  const contentClip = chartContentClip(geometry.layout, height)
  const rocClip = chartPanelClip(geometry.layout, 'roc', geometry.barPitch)
  const tag = { price: liveBar.close, rising: liveBar.close >= liveBar.open, inViewport: liveBar.hour <= endHour + (liveOverlay ? intervalMS : 0) }
  const latestY = priceY(tag.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--negative)"
  const latestPrice = `${price(tag.price)} ${tag.rising ? '↑' : '↓'}`
  const priceLabel = chartPriceLabelLayout(latestY, panels.price, chartTokens.textSize, chartTokens.priceLabelPaddingY, liveOverlay)
  const tickHalfHeight = chartTokens.textSize / 2
  const inspectionX = x[0] + (active.hour - bars[0].hour) / intervalMS * geometry.barPitch
  const inspectedTime = inspecting ? time(active.hour) : null
  const inspectedTimeWidth = inspectedTime ? chartTextWidth(inspectedTime) + 12 : 0
  const inspectedTimeX = !inspecting ? 0 : Math.max(columns.rsi[0], Math.min(right - inspectedTimeWidth, inspectionX + contentOffset - inspectedTimeWidth / 2))
  const rsiValue = (field: RsiField) => {
    const marker = !inspecting ? undefined : rsiMarkers.find(marker => marker.hour === active.hour && marker.field === field)
    return `${active[field]?.toFixed(1) ?? '—'}${marker ? ` ${marker.direction === 'up' ? '↑' : '↓'}${marker.levels.join('/')}` : ''}`
  }
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
      {(key === "oi" || key === "taker") && <title>{sourceStatusText(key === "oi" ? "OI" : "Taker", key === "oi" ? oiState : takerState, key === "oi" ? oiStatus : takerStatus)}</title>}
      <g transform={`translate(${start},${headerY[key]}) scale(${shrink})`}>
      {items.map(([label, value, color, dash, sourceHour], index) => {
        const itemStart = cursor
        cursor += widths[index] + gap
        const labelColor = key === "rsi" ? "var(--muted-foreground)" : key === "taker" ? index === 0 ? "var(--chart-positive-label)" : "var(--chart-negative-label)" : color
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
      <pattern id={`${areaClipId}-sell-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" x2="0" y1="0" y2="4" stroke="var(--background)" opacity="0.55" />
      </pattern>
      <clipPath id={`${areaClipId}-positive`}><rect x={rocClip.x} y={panels.roc[0]} width={rocClip.width} height={rocZeroY - panels.roc[0]} /></clipPath>
      <clipPath id={`${areaClipId}-negative`}><rect x={rocClip.x} y={rocZeroY} width={rocClip.width} height={panels.roc[1] - rocZeroY} /></clipPath>
      <clipPath id={`${areaClipId}-content`}><rect {...contentClip} /></clipPath>
      {CHART_PANELS.map(key => <clipPath key={key} id={`${areaClipId}-${key}`}><rect {...chartPanelClip(geometry.layout, key, geometry.barPitch)} /></clipPath>)}
    </defs>
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
      <g clipPath={`url(#${areaClipId}-price)`}>{bollBands.map((d, index) => <path key={index} data-chart-boll-band d={d} fill="var(--chart-1)" fillOpacity="0.1" />)}</g>
      <g clipPath={`url(#${areaClipId}-roc)`}>{rocAreas.map((area, index) => <g key={index}>
        <path d={area} fill="var(--chart-roc-positive-area)" clipPath={`url(#${areaClipId}-positive)`} />
        <path d={area} fill="var(--chart-roc-negative-area)" clipPath={`url(#${areaClipId}-negative)`} />
      </g>)}</g>
      </g>
    </g>
    {[30, 50, 70].map(level => <line key={level} data-chart-rsi-threshold={level} x1={columns.rsi[0]} x2={columns.rsi[1]} y1={rsiY(level)} y2={rsiY(level)} stroke={level === 50 ? 'var(--chart-midpoint)' : 'var(--chart-threshold)'} />)}
    {grid}
    {rocZeroY > panels.roc[0] && rocZeroY < panels.roc[1] && <line x1={columns.roc[0]} x2={columns.roc[1]} y1={rocZeroY} y2={rocZeroY} stroke="var(--muted-foreground)" strokeOpacity="0.5" />}
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
    {bars.flatMap((bar, index) => (bar.hour - firstHour) % (12 * intervalMS) === 0 ? panelKeys.map(key => <line key={`${(bar.hour - firstHour) / intervalMS}-${key}`} x1={x[index]} x2={x[index]} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />) : [])}
    {bars.map((bar, index) => ({ bar, index })).filter(({ bar, index }) => index === n - 1 || (bar.hour - firstHour) % (24 * intervalMS) === 0).filter(({ bar, index }) => {
      if (!inspectedTime) return true
      const width = chartTextWidth(hourLabel(bar.hour)), start = x[index] + contentOffset - (index === 0 ? 0 : index === n - 1 ? width : width / 2)
      return start + width < inspectedTimeX - 4 || start > inspectedTimeX + inspectedTimeWidth + 4
    }).map(({ bar, index }) => <text key={(bar.hour - firstHour) / intervalMS} x={x[index]} y={height - 7} textAnchor={index === 0 ? "start" : index === n - 1 ? "end" : "middle"} fill="var(--muted-foreground)">{hourLabel(bar.hour)}</text>)}
    {/* Expose contrasting segments within the same 1px stroke for the mandated light green. */}
    <g clipPath={`url(#${areaClipId}-price)`}>
    <path d={upWicks} fill="none" stroke="var(--foreground)" />
    <path d={upWicks} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path d={downWicks} fill="none" stroke="var(--negative)" />
    <path d={upBodies} fill="var(--background)" stroke="var(--foreground)" />
    <path data-chart-candle-direction="up" data-chart-candle-fill="hollow" d={upBodies} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path data-chart-candle-direction="down" data-chart-candle-fill="solid" d={downBodies} fill="var(--negative)" />
    </g>
    <g clipPath={`url(#${areaClipId}-taker)`} data-chart-taker={takerComplete ? "complete" : takerAvailable ? "partial" : "empty"} data-chart-taker-state={takerState}>
      <path data-chart-taker-buy-samples={geometry.buySamples} d={buys} fill="var(--positive)" stroke="var(--foreground)" opacity="0.9" />
      <path data-chart-taker-sell-samples={geometry.sellSamples} d={sells} fill="var(--negative)" stroke="var(--foreground)" opacity="0.9" />
      <path d={sells} fill={`url(#${areaClipId}-sell-hatch)`} opacity="0.7" />
    </g>
    <g clipPath={`url(#${areaClipId}-price)`}>
    {lineStroke("bollUpper", lines.bollUpper, "var(--chart-1)")}
    {lineStroke("bollMiddle", lines.bollMiddle, "var(--chart-1)")}
    {lineStroke("bollLower", lines.bollLower, "var(--chart-1)")}
    {lineStroke("vwap", lines.vwap, "var(--chart-2)", "2 3")}
    {lineStroke("ema", lines.ema, "var(--chart-3)", "7 4")}
    </g>
    <g clipPath={`url(#${areaClipId}-rsi)`}>
    {lineStroke("rsi6", lines.rsi6, "var(--chart-1)")}
    {lineStroke("rsi12", lines.rsi12, "var(--chart-2)", "7 4")}
    {lineStroke("rsi24", lines.rsi24, "var(--chart-3)", "3 4")}
    {rsiMarkers.map(marker => <path key={`${marker.field}:${marker.hour}`} data-chart-rsi-crossing={marker.field} data-chart-rsi-direction={marker.direction} data-chart-rsi-levels={marker.levels.join('/')} data-chart-rsi-hour={marker.hour}
      d={marker.d} fill={`var(--chart-${RSI_FIELDS.indexOf(marker.field) + 1})`} stroke="var(--background)" strokeLinejoin="round">
      <title>{`${time(marker.hour)} · RSI(${marker.field.slice(3)}) crossed ${marker.direction === 'up' ? 'above' : 'below'} ${marker.levels.join(' and ')} · ${marker.value.toFixed(1)}${marker.confirmed ? '' : ' · Forming candle'}`}</title>
    </path>)}
    </g>
    <g clipPath={`url(#${areaClipId}-atr)`} data-chart-volatility-panel data-chart-panel-top={panels.atr[0]} data-chart-panel-bottom={panels.atr[1]}>
      {lineStroke("atrPercent", lines.atrPercent, "var(--chart-3)")}
      {lineStroke("bbw", lines.bbw, "var(--chart-1)", "7 4")}
    </g>
    <g clipPath={`url(#${areaClipId}-roc)`}>
    {lineStroke("roc", lines.roc, "var(--chart-1)")}
    {lineStroke("maroc", lines.maroc, "var(--chart-2)", "7 4")}
    </g>
    <g clipPath={`url(#${areaClipId}-oi)`} data-chart-oi={oiAxis ? oiComplete ? "complete" : "partial" : "empty"} data-chart-oi-state={oiState} data-chart-oi-samples={oiSamples.length}>
      {oiAxis && <>{lineStroke("oi", lines.oi, "var(--chart-2)")}{!oiComplete && oiSamples.map(sample => <circle key={bars[sample.index].hour} data-chart-oi-sample cx={x[sample.index]} cy={oiY(sample.value)} r="2" fill="var(--chart-2)" />)}</>}
    </g>
    {inspecting && panelKeys.map(key => <line key={key} x1={inspectionX} x2={inspectionX} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--foreground)" strokeDasharray="3 5" opacity="0.3" />)}
    <g clipPath={`url(#${areaClipId}-price)`}>
    {([[highIndex, candleHigh, "high"], [lowIndex, candleLow, "low"]] as const).map(([index, value, kind]) => {
      const markerX = x[index], label = price(value)
      const labelWidth = label.length * 6.5 + 8
      const start = index < n / 2 ? markerX + 10 : markerX - labelWidth - 10
      return <g key={kind}>
        <line x1={markerX} x2={index < n / 2 ? markerX + 10 : markerX - 10} y1={priceY(value)} y2={priceY(value)} stroke="var(--foreground)" />
        {lineLabel(start, priceY(value), label, "var(--foreground)")}
      </g>
    })}
    </g>
      </g>
    </g>
    {tag.inViewport && <g data-chart-price-label>
      <rect data-chart-price-label-background x={right} y={priceLabel.top} width={gutter} height={priceLabel.bottom - priceLabel.top} fill="var(--chart-annotation)" />
      <text data-chart-price-label-value x={axisStarts.price} y={latestY} dominantBaseline="middle" fill="var(--foreground)">{latestPrice}</text>
      {priceLabel.countdownY !== null && <PriceCountdown hour={liveBar.hour} intervalMS={intervalMS} x={axisStarts.price} y={priceLabel.countdownY} />}
    </g>}
    {legend("price", [["VWAP(14)", price(active.vwap), "var(--chart-2)", "2 3"], ["EMA(200)", price(active.ema), "var(--chart-3)", "7 4"], ["BOLL(20,2)", `U ${price(active.bollUpper)}\u00a0·\u00a0M ${price(active.bollMiddle)}\u00a0·\u00a0L ${price(active.bollLower)}`, "var(--chart-1)"]])}
    {legend("roc", [["ROC(9)", formatPercent(active.roc), "var(--chart-1)"], ["MAROC(9)", formatPercent(active.maroc), "var(--chart-2)", "7 4"]])}
    {legend("rsi", [["RSI(6)", rsiValue('rsi6'), "var(--chart-1)"], ["RSI(12)", rsiValue('rsi12'), "var(--chart-2)", "7 4"], ["RSI(24)", rsiValue('rsi24'), "var(--chart-3)", "3 4"]])}
    {legend("atr", [["ATR%(14)", chartPercent(active.atrPercent), "var(--chart-3)"], ["BBW(20,2)", chartPercent(active.bbw), "var(--chart-1)", "7 4"]])}
    {legend("oi", [["OI (Contracts)", statistics.oi ? compact(statistics.oi.oi) : oiState === "loading" ? "Loading…" : oiState === "error" ? "Failed" : "Unavailable", "var(--chart-2)", undefined, statistics.oi?.hour]])}
    {legend("taker", [["↑ Taker Buy (Contracts)", statistics.taker ? compact(statistics.taker.buy) : takerState === "loading" ? "Loading…" : takerState === "error" ? "Failed" : "Unavailable", "var(--positive)", undefined, statistics.taker?.hour], ["↓ Taker Sell (Contracts)", statistics.taker ? compact(statistics.taker.sell) : takerState === "loading" ? "Loading…" : takerState === "error" ? "Failed" : "Unavailable", "var(--negative)", "2 3", statistics.taker?.hour]])}
    {[30, 70].map(level => <g key={level} data-chart-rsi-tick={level}>{lineLabel(axisStarts.rsi, rsiY(level), String(level), 'var(--foreground)')}</g>)}
    {panels.rsi[1] - panels.rsi[0] >= chartTokens.textSize * 6 && <>{lineLabel(axisStarts.rsi, rsiY(100), '100')}{lineLabel(axisStarts.rsi, rsiY(50), '50')}{lineLabel(axisStarts.rsi, rsiY(0), '0')}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && <>{lineLabel(axisStarts.roc, panels.roc[0], formatPercent(rocAxis.max, rocAxis.decimals))}{lineLabel(axisStarts.roc, panels.roc[1], formatPercent(rocAxis.min, rocAxis.decimals))}</>}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && geometry.oiTicks.map(({ y, label }, index) => <g key={index} data-chart-oi-tick><line x1={columns.oi[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, y, label)}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && geometry.takerTicks.map(({ y, label }, index) => <g key={index} data-chart-taker-tick>{lineLabel(axisStarts.taker, y, label)}</g>)}
    {inspectedTime && <g data-chart-inspected-time><rect x={inspectedTimeX} y={height - 19} width={inspectedTimeWidth} height={18} rx={3} fill="var(--chart-annotation)" /><text x={inspectedTimeX + inspectedTimeWidth / 2} y={height - 7} textAnchor="middle" fill="var(--foreground)">{inspectedTime}</text></g>}
    {geometry.priceTicks.map(({ y, label }, index) => <g key={index} data-chart-price-tick><line x1={columns.price[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.35" />{(!tag.inViewport || y + tickHalfHeight < priceLabel.top || y - tickHalfHeight > priceLabel.bottom) && lineLabel(axisStarts.price, y, label)}</g>)}
    <line x1={right} x2={right} y1={panels.price[0]} y2={panels.taker[1]} stroke="var(--border)" opacity="0.8" />
    {tag.inViewport && tag.rising && <line data-chart-live-price-outline x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke="var(--foreground)" />}
    {tag.inViewport && <line data-chart-live-price x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke={latestColor} strokeDasharray="4 5" />}
  </>
  })
})

type PlotSize = { width: number; height: number }

/** Every candidate owns a mounted SVG. Selection changes visibility, not paths. */
const PreparedPlot = memo(function PreparedPlot({ instId, timeframe, size, selected, inspected, inspectedBar, wheelFraction = 0, navigationSurface, presentedSurface }: {
  instId: string; timeframe: RadarTimeframe; size: PlotSize; selected: boolean; inspected: number | null
  inspectedBar?: Bar
  wheelFraction?: number
  navigationSurface?: ReadyChartWindow; presentedSurface?: ReadyChartWindow
}) {
  const subscribe = useCallback((listener: () => void) => chartController.store.subscribe(instId, timeframe, listener), [instId, timeframe])
  const getSnapshot = useCallback(() => chartController.store.window(instId, timeframe), [instId, timeframe])
  const latest = useSyncExternalStore(subscribe, getSnapshot)
  // The selected SVG and its parent legends publish one immutable frame.
  // Hidden candidates may consume new cache entries independently.
  const surface = navigationSurface ?? presentedSurface ?? latest
  const overscan = chartOverscan(surface)
  const plot = chartPlot(surface, size, overscan)
  const ready = Boolean(surface?.bars.length && (surface.priceState === 'ready' || surface.priceState === 'stale')
    && (surface.indicatorState === 'ready' || surface.indicatorState === 'unavailable')
    && surface.oiState !== 'loading' && surface.takerState !== 'loading' && plot)
  if (!surface || !plot) return null
  const { bars, geometry } = plot
  const contentOffset = chartWheelContentOffset(wheelFraction, geometry.barPitch, Boolean(plot.before), Boolean(plot.after))
  return <PlotVisible value={selected}>
    <svg strokeWidth="var(--chart-line-width)" data-prepared-chart-inst={instId} data-prepared-chart-timeframe={timeframe}
      data-prepared-chart-ready={ready} data-prepared-indicator-state={surface.indicatorState} data-prepared-oi-state={surface.oiState} data-prepared-taker-state={surface.takerState}
      data-rendered-inst={selected ? instId : undefined} data-rendered-timeframe={selected ? timeframe : undefined}
      data-rendered-start={bars[0]!.hour} data-rendered-end={bars.at(-1)!.hour}
      viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden={!selected}
      style={{ visibility: selected ? 'visible' : 'hidden' }}
      className={cn('absolute inset-0 h-full w-full font-mono text-[length:var(--chart-text-size)] select-none focus-visible:outline-2 focus-visible:outline-ring', !selected && 'pointer-events-none')}
      role="img" tabIndex={selected ? 0 : -1}
      aria-label={`${instId} ${bars.length}-candle ${timeframeLabel(timeframe)} chart. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window end. Hover RSI crossing triangles to inspect their candle and time. Alt+Left and Alt+Right inspect RSI crossings; Escape clears inspection. Scroll to review history. Arrow keys navigate markets.`}>
      <Plot bars={bars} geometry={geometry} liveBar={surface.liveBar ?? bars.at(-1)!} liveOverlay={!!surface.liveBar} contentOffset={contentOffset}
        inspected={selected ? inspected : null} inspectedBar={selected ? inspectedBar : undefined} oiState={surface.oiState} takerState={surface.takerState} oiStatus={surface.oiStatus} takerStatus={surface.takerStatus} />
    </svg>
  </PlotVisible>
})

export const MarketChart = memo(function MarketChart({ instId, timeframe = '15m', active: isActive = true, onTimeframeChange, listOrder, candidateIds = listOrder, turnoverOrder, onSelect }: { instId: string; timeframe?: RadarTimeframe; active?: boolean; onTimeframeChange?: (value: RadarTimeframe) => void; candidateIds?: string[]; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void }) {
  const view = useSyncExternalStore(chartController.subscribe, chartController.getSnapshot)
  useLayoutEffect(() => {
    if (!isActive) return
    const target = chartController.getSnapshot().requested
    return chartController.open(instId, timeframe, target?.instId === instId && target.timeframe === timeframe ? target.end : null)
  }, [instId, timeframe, isActive])
  const surface = view.presented
  const matchesSelection = surface?.instId === instId && surface.timeframe === timeframe
  const wheelSession = useMemo(() => ({ isActive, instId, timeframe }), [isActive, instId, timeframe])
  const pending = view.pending || !matchesSelection
  const intervalMS = surface?.intervalMS ?? timeframeMilliseconds(timeframe)
  const displayedId = surface?.instId ?? instId
  const displayedFrame = surface?.timeframe ?? timeframe
  const error = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.error : ''
  const requestedEnd = view.requested?.end ?? view.latestEnd
  const historical = surface ? surface.endHour !== chartController.store.latestEnd(surface.instId, surface.timeframe) : false
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const overscan = chartOverscan(surface)
  const preparedPlot = chartPlot(surface, plotSize, overscan)
  const bars = preparedPlot?.bars ?? surface?.bars ?? EMPTY_BARS
  const plotGeometry = preparedPlot?.geometry ?? null
  const latestSurface = surface ? chartController.store.window(surface.instId, surface.timeframe) : null
  const navigationSurface = surface && surface !== latestSurface ? surface : undefined
  const plotCandidates = candidateIds.includes(displayedId) ? candidateIds : [...candidateIds, displayedId]
  // Visible input must not wait for the rest of the candidate pool to redraw.
  const backgroundTimeframe = useDeferredValue(timeframe)
  const [inspection, setInspection] = useState<{ instId: string; timeframe: RadarTimeframe; hour: number } | null>(null)
  const inspectedIndex = inspection?.instId === surface?.instId && inspection?.timeframe === surface?.timeframe ? bars.findIndex(bar => bar.hour === inspection?.hour) : -1
  const inspected = inspectedIndex >= 0 ? inspectedIndex : null
  const inspectedBar = inspection?.instId === surface?.instId && inspection?.timeframe === surface?.timeframe
    ? [overscan.before, ...bars, overscan.after].find(bar => bar?.hour === inspection?.hour) : undefined
  const heldPointer = useRef<{ pointerId: number; target: SVGSVGElement } | null>(null)
  const releaseInspection = useCallback(() => {
    const held = heldPointer.current
    heldPointer.current = null
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId)
  }, [])
  const endInspection = useCallback(() => { releaseInspection(); setInspection(null) }, [releaseInspection, setInspection])
  const analysis = useSyncExternalStore(chartAnalysis.subscribe, () => chartAnalysis.get(instId))
  const [analysisOpen, setAnalysisOpen] = useState(() => chartAnalysis.get(instId) !== null)
  const analysisBusy = analysis?.phase === 'capturing' || analysis?.phase === 'streaming'
  const [capture, setCapture] = useState<{ status: 'idle' | 'copying' | 'flashing' | 'failed'; error: string }>({ status: 'idle', error: '' })
  const captureStatus = capture.status
  const wheelBatch = useRef(createChartWheelBatch())
  const wheelRemainder = useRef(0)
  const wheelFrame = useRef<number | null>(null)
  const [wheelFraction, setWheelFraction] = useState(0)
  const [wheelOwner, setWheelOwner] = useState<{ session: object; instId: string; timeframe: RadarTimeframe; generation: number } | null>(null)
  const wheelOwnerRef = useRef<typeof wheelOwner>(null)
  const wheelOwnerMatches = Boolean(wheelOwner?.session === wheelSession && wheelOwner.generation === surface?.generation)
  const requestedEndMatches = Boolean(surface && view.requested && view.requested.instId === surface.instId
    && view.requested.timeframe === surface.timeframe && (view.requested.end ?? view.latestEnd) === surface.endHour)
  const activeWheelFraction = matchesSelection && wheelOwnerMatches && (!view.pending || requestedEndMatches) ? wheelFraction : 0
  const wheelContentOffset = chartWheelContentOffset(activeWheelFraction, plotGeometry?.barPitch ?? 0,
    Boolean(preparedPlot?.before), Boolean(preparedPlot?.after))
  const navigationId = useRef(instId)
  const navigationTask = useRef<object | null>(null)
  useEffect(() => () => chartAnalysis.stop(instId), [instId, timeframe])
  useLayoutEffect(() => {
    navigationId.current = instId
    navigationTask.current = null
    wheelBatch.current.reset()
    wheelRemainder.current = 0
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
    wheelOwnerRef.current = null
    releaseInspection()
  }, [isActive, instId, timeframe, releaseInspection])
  useLayoutEffect(() => {
    const element = chartRef.current
    if (element) {
      Object.defineProperty(element, '__chartSnapshot', { configurable: true, value: surface })
      Object.defineProperty(element, '__chartRenderedBars', { configurable: true, value: bars })
    }
  }, [surface, bars])
  useEffect(() => () => {
    if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
    wheelBatch.current.reset()
    navigationTask.current = null
  }, [])
  useLayoutEffect(() => {
    const element = plotRef.current
    if (!element) return
    const measure = (width: number, height: number) => {
      // Keep the rendered chart intact while its workspace is hidden.
      if (!(width > 0 && height > 0)) return
      setPlotSize(current => current.width === width && current.height === height ? current : { width, height })
    }
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
  useLayoutEffect(() => {
    if (!isActive) return
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="radio"], [role="radiogroup"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="tablist"], [role="tree"], [role="grid"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [aria-haspopup][aria-expanded="true"]')) return
      if (!(event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
      const id = chartNavigationTarget(listOrder, turnoverOrder, navigationId.current, event.key)
      if (!id) return
      // Market shortcuts own these keys before row and toolbar roving focus.
      // Keep focus outside candidate SVGs, which become hidden on selection.
      event.preventDefault()
      event.stopPropagation()
      plotRef.current?.focus({ preventScroll: true })
      if (id === navigationId.current) return
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
    window.addEventListener('keydown', navigate, true)
    return () => window.removeEventListener('keydown', navigate, true)
  }, [isActive, listOrder, turnoverOrder, onSelect])
  const queueWheel = (pixels: number) => {
    if (!isActive || !surface || !matchesSelection || !Number.isFinite(pixels) || pixels === 0) return
    const owner = { session: wheelSession, instId: surface.instId, timeframe: surface.timeframe, generation: surface.generation }
    const currentOwner = wheelOwnerRef.current
    if (!currentOwner || currentOwner.session !== owner.session) {
      wheelOwnerRef.current = owner
      wheelBatch.current.reset()
      wheelRemainder.current = 0
      if (wheelFrame.current !== null) window.cancelAnimationFrame(wheelFrame.current)
      wheelFrame.current = null
    }
    wheelBatch.current.add(pixels)
    if (wheelFrame.current !== null) return
    wheelFrame.current = window.requestAnimationFrame(() => {
      wheelFrame.current = null
      const progress = wheelBatch.current.consume(wheelRemainder.current)
      wheelRemainder.current = progress.remainderPixels
      setWheelFraction(progress.fraction)
      setWheelOwner(current => current?.session === owner.session && current.instId === owner.instId && current.timeframe === owner.timeframe && current.generation === owner.generation ? current : owner)
      endInspection()
      if (progress.steps) chartController.scroll(progress.steps)
      if (progress.fraction) chartController.prefetchAdjacent(progress.fraction)
    })
  }
  const inspectAt = (target: SVGSVGElement, clientX: number) => {
    if (!surface || !bars.length || !plotGeometry) return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    const candidates = [wheelContentOffset > 0 ? overscan.before : undefined, ...bars, wheelContentOffset < 0 ? overscan.after : undefined].filter((bar): bar is Bar => Boolean(bar))
    const position = (bar: Bar) => plotGeometry.x[0] + (bar.hour - bars[0].hour) / intervalMS * plotGeometry.barPitch + wheelContentOffset
    let nearest = candidates[0]
    for (const bar of candidates.slice(1)) {
      if (Math.abs(position(bar) - svgX) < Math.abs(position(nearest) - svgX)) nearest = bar
    }
    setInspection({ instId: surface.instId, timeframe: surface.timeframe, hour: nearest.hour })
  }
  const inspectCrossingAt = (target: SVGSVGElement, hovered: Element, clientX: number, clientY: number) => {
    if (!surface || !plotGeometry) return
    const rect = target.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return
    const exactHour = hovered.closest('[data-chart-rsi-crossing]')?.getAttribute('data-chart-rsi-hour')
    let nearest = exactHour ? plotGeometry.rsiMarkers.find(marker => marker.hour === Number(exactHour) && marker.index >= 0) ?? null : null
    let distance = 12
    if (nearest === null) for (const marker of plotGeometry.rsiMarkers) {
      if (marker.x + wheelContentOffset < plotGeometry.layout.left - 4 || marker.x + wheelContentOffset > plotGeometry.layout.right + 4) continue
      const next = Math.hypot(rect.left + (marker.x + wheelContentOffset) * rect.width / plotSize.width - clientX, rect.top + marker.y * rect.height / plotSize.height - clientY)
      if (next < distance) { distance = next; nearest = marker }
    }
    const hour = nearest?.hour ?? null
    setInspection(current => hour === null ? null : current?.instId === surface.instId && current.timeframe === surface.timeframe && current.hour === hour
      ? current : { instId: surface.instId, timeframe: surface.timeframe, hour })
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
  const active = inspectedBar ?? bars[inspected ?? bars.length - 1]
  const oiState = surface?.oiState ?? 'ready'
  const takerState = surface?.takerState ?? 'ready'
  const atBoundary = view.historyExhausted && surface && view.oldestHour !== null && surface.endHour === Math.min(view.latestEnd ?? Infinity, view.oldestHour + 95 * intervalMS)
  const priceScale = plotGeometry?.priceAxis.kind ?? 'logarithmic'
  const priceState = surface?.priceState ?? 'loading'
  const statusMessages: string[] = []
  if (pending && !error) statusMessages.push(surface ? `Preparing ${instId.replace(/-SWAP$/, '')} ${timeframeLabel(timeframe)}${requestedEnd !== null ? ` · ${time(requestedEnd)}` : ''}…` : 'Loading local prices…')
  if (surface && !error && priceState === 'partial') statusMessages.push('Repairing missing price history…')
  if (surface && !error && priceState === 'stale') statusMessages.push('Recent price history is stale; repairing…')
  if (surface && !error && priceState === 'loading') statusMessages.push('Loading price history…')
  if (priceState === 'error') statusMessages.push(sourceStatusText('Price history', priceState, surface?.priceStatus))
  if (priceState === 'unavailable') statusMessages.push('Price history is unavailable for this range')
  if (surface?.indicatorState === 'loading') statusMessages.push('Calculating indicators…')
  if (surface?.indicatorState === 'error') statusMessages.push(sourceStatusText('Indicators', 'error', surface.indicatorStatus))
  if (surface?.indicatorState === 'unavailable') statusMessages.push(surface.indicatorStatus?.reason === 'insufficient-history' ? 'Insufficient history for some indicators' : 'Some indicators are undefined for this range')
  for (const [label, state, status] of [['OI', oiState, surface?.oiStatus], ['Taker', takerState, surface?.takerStatus]] as const) {
    const message = sourceStatusText(label, state, status)
    if (message) statusMessages.push(message)
  }
  if (atBoundary && !pending) statusMessages.push('Start of available history')
  if (!statusMessages.length && error) statusMessages.push('Chart update failed')
  const statusLoading = !error && ((pending) || priceState === 'loading' || priceState === 'partial' || priceState === 'stale')
    || surface?.indicatorState === 'loading' || oiState === 'loading' || takerState === 'loading'
  const statusSummary = statusMessages.join(' · ')
  return <section data-chart-workspace aria-label="Market chart workspace" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    <header data-chart-toolbar data-window-toolbar data-window-drag-region className="flex items-center gap-3 border-b px-4">
      <ToggleGroup variant="outline" size="sm" className="mr-auto" value={[timeframe]} onValueChange={values => { const value = values[0]; if (value) onTimeframeChange?.(value as RadarTimeframe) }} aria-label="Chart timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup>
      <Button variant="outline" size="sm" disabled={pending || !bars.length || plotSize.width <= 0 || captureStatus === 'copying' || analysis?.phase === 'capturing'} onClick={() => { void captureChart() }}><Camera data-icon="inline-start" aria-hidden="true" />{captureStatus === 'copying' ? 'Copying…' : 'Copy chart'}</Button>
      <ButtonGroup aria-label="Chart analysis actions">{(['long', 'short'] as const).map(direction => <Button key={direction} variant="outline" size="sm" disabled={captureStatus === 'copying' || (analysis?.direction !== direction && (analysisBusy || pending || !bars.length || plotSize.width <= 0))} title={analysis?.direction === direction ? `Open existing ${direction} analysis` : undefined} onClick={() => { if (analysis?.direction === direction) setAnalysisOpen(true); else analyzeChart(direction) }}>{analysisBusy && analysis?.direction === direction && <Spinner data-icon="inline-start" />}Analyze {direction === 'long' ? 'Long' : 'Short'}</Button>)}</ButtonGroup>
      <span role="status" className="sr-only">{captureStatus === 'flashing' ? 'Chart copied to clipboard' : ''}</span>
      {(historical || displayedFrame !== timeframe) && <Badge variant="secondary">{timeframeLabel(displayedFrame)}{historical ? ' history' : ' chart'}</Badge>}
      {!historical && <PriceStatus observedAt={surface?.priceObservedAt} realtime={surface?.realtimeState} />}
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}</div>}
    {capture.error && <p role="alert" className="shrink-0 border-b px-5 py-2 text-destructive">{capture.error}</p>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={displayedId} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-chart-completed-end={surface?.endHour} data-chart-cache-start={view.oldestHour ?? undefined} data-chart-requested-end={requestedEnd ?? undefined} data-chart-rendered-bars={bars.length} data-chart-target-bars={96} data-chart-visual-stale={surface && !matchesSelection ? 'true' : 'false'} data-chart-candle-state={priceState} data-chart-statistics-state={surface?.oiState === 'error' || surface?.takerState === 'error' ? 'error' : surface?.oiState === 'loading' || surface?.takerState === 'loading' ? 'loading' : surface?.oiState === 'unavailable' || surface?.takerState === 'unavailable' ? 'unavailable' : surface ? 'ready' : 'loading'} data-chart-statistics-end={surface?.endHour} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete={priceState !== 'ready' || surface?.indicatorState !== 'ready' || oiState !== 'ready' || takerState !== 'ready' ? 'true' : 'false'} data-chart-loading={pending ? 'true' : 'false'} aria-label={`${displayedId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-6 border-b px-4">
        <h2 className="min-w-0 max-w-1/2 truncate text-base font-semibold tracking-tight" title={displayedId}>{displayedId.replace(/-SWAP$/, '')} · {timeframeLabel(displayedFrame)}</h2>
        <div data-chart-status data-chart-indicator-state={surface?.indicatorState} data-chart-indicator-input={surface?.indicatorStatus?.inputVersion} role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          {statusLoading && <Spinner aria-hidden="true" role="presentation" />}
          <p className="min-w-0 truncate" title={statusSummary}>{statusMessages.map((message, index) => <span key={message}>{index > 0 && ' · '}<span>{message}</span></span>)}</p>
        </div>
      </div>
      {active && <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b px-4 py-1.5 text-[length:var(--chart-text-size)]" aria-live="off">
        <p className="min-w-0 truncate" data-chart-inspected-hour={inspectedBar?.hour}><span className="text-muted-foreground">{inspectedBar === undefined ? historical ? 'Window end' : 'Latest' : 'Selected'}</span> {time(active.hour)}</p>
        {([['Open', active.open], ['High', active.high], ['Low', active.low], ['Close', active.close]] as const).map(([label, value]) => <div key={label} data-chart-ohlc={label.toLowerCase()} className="min-w-0"><span className="text-muted-foreground">{label} </span><span title={price(value)}>{price(value)}</span></div>)}
        <span data-chart-price-scale={priceScale} className="ml-auto text-muted-foreground" title={priceScale === 'linear' ? 'Linear scale · BOLL includes zero or negative values' : 'Logarithmic price scale'}>{priceScale === 'linear' ? 'Linear' : 'Log'}</span>
      </div>}
      <div ref={plotRef} data-chart-plot tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2" onKeyDown={event => {
        if (event.key === 'Escape') { endInspection(); return }
        if (!matchesSelection || !surface || !plotGeometry || !event.altKey || !(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
        event.preventDefault()
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        const current = inspectedBar ? (inspectedBar.hour - bars[0].hour) / intervalMS : direction < 0 ? bars.length : -1
        const index = chartRsiNavigationTarget(plotGeometry.rsiMarkers.map(marker => marker.index), current, direction)
        if (index !== undefined) setInspection({ instId: surface.instId, timeframe: surface.timeframe, hour: bars[index].hour })
      }} onPointerLeave={() => { if (!heldPointer.current) setInspection(null) }} onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        const target = (event.target as Element).closest<SVGSVGElement>('svg[data-rendered-inst]')
        if (!matchesSelection || !target || heldPointer.current) return
        target.setPointerCapture(event.pointerId)
        heldPointer.current = { pointerId: event.pointerId, target }
        inspectAt(target, event.clientX)
      }} onPointerUp={endInspection} onPointerCancel={endInspection} onLostPointerCapture={endInspection} onPointerMove={event => {
        const held = heldPointer.current
        if (!held) {
          const target = (event.target as Element).closest<SVGSVGElement>('svg[data-rendered-inst]')
          if (matchesSelection && target) inspectCrossingAt(target, event.target as Element, event.clientX, event.clientY)
          return
        }
        if (!matchesSelection || held?.pointerId !== event.pointerId) return
        if (!(event.buttons & 1)) { endInspection(); return }
        inspectAt(held.target, event.clientX)
      }} onWheel={event => {
        if (analysis?.phase === 'capturing') return
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY
        queueWheel(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1))
      }}>
        {plotCandidates.map(id => <PreparedPlot key={id} instId={id} timeframe={id === displayedId ? timeframe : backgroundTimeframe} size={plotSize}
          selected={matchesSelection && !navigationSurface && id === displayedId} wheelFraction={matchesSelection && !navigationSurface && id === displayedId ? activeWheelFraction : 0} inspected={id === displayedId ? inspected : null} inspectedBar={id === displayedId ? inspectedBar : undefined}
          presentedSurface={matchesSelection && !navigationSurface && id === displayedId ? surface ?? undefined : undefined} />)}
        {navigationSurface && <PreparedPlot key="navigation" instId={navigationSurface.instId} timeframe={navigationSurface.timeframe}
          size={plotSize} selected={true} inspected={inspected} inspectedBar={inspectedBar} wheelFraction={activeWheelFraction} navigationSurface={navigationSurface} />}
      </div>
      {captureStatus === 'flashing' && <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 bg-[var(--chart-capture-flash)] motion-safe:animate-[chart-capture-flash_550ms_ease-out_both] motion-reduce:hidden" />}
    </section>
    {analysisOpen && <ChartAnalysisPanel instId={instId} timeframe={timeframeLabel(timeframe)} session={analysis} ready={isActive && !pending && bars.length > 0 && plotSize.width > 0 && captureStatus !== 'copying'} onNew={() => analyzeChart(analysis?.direction ?? 'long')} onClose={() => { chartAnalysis.stop(instId); setAnalysisOpen(false) }} />}
    </div>
  </section>
})
