import { readDesignLengths } from '@/design-lengths'
import { CHART_DEFAULT_SPACING, chartPitchSpan } from './chart-layout.ts'
import { chartTimeTicks, chartTimeTickStep } from './chart-axis.ts'
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CHART_PANELS, chartContentClip, chartPanelClip, chartPriceLabelLayout, type ChartPanel as Panel } from "@/chart-layout"
import { chartCompact as compact, chartPercent, chartPricePresentation, type ChartGeometry } from "@/chart-geometry"
import { formatCurrentPrice, formatHistoricalPrice, formatIndicatorPrice } from '@/price-format'
import { CHART_WHEEL_PIXELS_PER_BAR, chartRsiNavigationTarget, chartWheelIntent, chartZoomDemand, chartZoomSpacing, chartWheelContentOffset, chartPresentedWheelFraction, createChartWheelBatch, createChartWheelScheduler } from '@/chart-navigation'
import { chartStatisticsSamples } from '@/chart-legend'
import { RSI_FIELDS, type RsiField } from '@/rsi-crossings'
import { cn } from "@/lib/utils"
import { chartNavigationTarget } from "@/market-sort"
import { formatCandleChange, formatPercent } from "@/market-percent"
import { RADAR_TIMEFRAMES, timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

import { chartController as defaultChartController, type ChartController } from '@/chart-controller'
import { createChartIndicatorPresentation, createChartPlotCache } from '@/chart-render'
import type { Bar, ChartSourceStatus, PreparedChartState, ReadyChartWindow } from '@/chart-data'
import { measureOperation } from '../electron/services/operations.js'
import { getPresentation, usePresentation, usePresentedStore } from '@/presentation-store'
import { isPriceFresh, watchPriceFreshness, watchPriceCountdown } from '@/price-clock'
import { sharedChartEnd, sharedChartGesture, sharedChartViewport, type SharedChartTime } from '@/chart-time-sync'

const ChartTimeSync = createContext<{ value: SharedChartTime | null; setValue: React.Dispatch<React.SetStateAction<SharedChartTime | null>>; gutter: number; reportGutter: (frame: RadarTimeframe, epoch: object | null, width: number | null) => void } | null>(null)
export function ChartTimeSyncProvider({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState<SharedChartTime | null>(null)
  const [gutter, setGutter] = useState(64)
  const measurements = useRef(new Map<RadarTimeframe, { epoch: object; width: number }>())
  const reportGutter = useCallback((frame: RadarTimeframe, epoch: object | null, width: number | null) => {
    const previous = measurements.current.get(frame)
    if (width === null) measurements.current.delete(frame)
    else if (epoch) {
      // Within one input epoch, changing the gutter can change which candle is
      // visible and hence its rebased labels. Grow monotonically until stable;
      // a new input epoch permits the gutter to shrink again.
      const next = previous?.epoch === epoch ? Math.max(previous.width, width) : width
      if (previous?.epoch === epoch && previous.width === next) return
      measurements.current.set(frame, { epoch, width: next })
    }
    const widths = [...measurements.current.values()].map(item => item.width)
    setGutter(widths.length ? Math.max(...widths) : 64)
  }, [])
  const context = useMemo(() => ({ value, setValue, gutter, reportGutter }), [value, gutter, reportGutter])
  return <ChartTimeSync.Provider value={context}>{children}</ChartTimeSync.Provider>
}

const presentationActive = () => getPresentation().active
const EMPTY_BARS: readonly Bar[] = []
const PriceStatus = memo(function PriceStatus({ observedAt, realtime, active, label }: { observedAt?: number | null; realtime?: 'live' | 'stale'; active: boolean; label?: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => watchPriceFreshness({ observedAt, realtime, active, displayedAt: now, isActive: presentationActive, onTime: setNow }), [active, observedAt, realtime, now])
  const fresh = isPriceFresh(observedAt, realtime, now)
  return fresh ? null : <Badge variant="secondary" role="status" title={observedAt ? `Last price observation ${new Date(observedAt).toLocaleTimeString('en-US')}` : 'Waiting for a current price observation'}>{label ? `${label} ` : ''}Cached price</Badge>
})

export type SharedChartStatusValue = { detail: string; severity: 'error' | 'warning' | 'info' }
const SharedChartStatus = memo(function SharedChartStatus({ timeframe, summary, error, warning, loading, observedAt, realtime, active, historical, onStatus }: {
  timeframe: RadarTimeframe; summary: string; error: string; warning: boolean; loading: boolean; observedAt?: number | null; realtime?: 'live' | 'stale'; active: boolean; historical: boolean; onStatus: (timeframe: RadarTimeframe, value: SharedChartStatusValue | null) => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => watchPriceFreshness({ observedAt, realtime, active, displayedAt: now, isActive: presentationActive, onTime: setNow }), [active, observedAt, realtime, now])
  const cached = !historical && !isPriceFresh(observedAt, realtime, now)
  const detail = [error || summary, cached ? 'Cached price. Check the market connection for current prices.' : ''].filter(Boolean).join(' · ')
  const severity = error ? 'error' : cached || warning ? 'warning' : 'info'
  useEffect(() => { onStatus(timeframe, detail ? { detail, severity } : null) }, [onStatus, timeframe, detail, severity, loading])
  useEffect(() => () => onStatus(timeframe, null), [onStatus, timeframe])
  return null
})

const chartTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
const time = (hour: number) => chartTimeFormatter.format(hour)
const hourLabel = time
const chartStyle = getComputedStyle(document.documentElement)
// Tokens are fixed for the page lifetime; geometry and rendered annotations share these resolved pixels.
const chartLengths = readDesignLengths({
  '--chart-text-size': 10, '--chart-legend-gap': 16, '--space-4': 12,
  '--space-annotation-small': 8, '--space-annotation-xs': 4,
  '--space-annotation-symbol': 18, '--space-annotation-label': 26, '--space-annotation-value': 10,
  '--chart-price-label-padding-y': 3, '--chart-top-inset': 2, '--chart-price-top-inset': 0,
  '--chart-panel-header-height': 18, '--chart-row-gap': 2,
  '--chart-bottom-axis-height': 16, '--chart-panel-header-baseline': 11,
})
const chartTokenNumber = (token: keyof typeof chartLengths) => chartLengths[token]
const chartTokens = {
  textSize: chartTokenNumber('--chart-text-size'),
  legendGap: chartTokenNumber('--chart-legend-gap'),
  annotationPadding: chartTokenNumber('--space-4'),
  annotationSmall: chartTokenNumber('--space-annotation-small'),
  annotationXs: chartTokenNumber('--space-annotation-xs'),
  legendSymbol: chartTokenNumber('--space-annotation-symbol'),
  legendLabel: chartTokenNumber('--space-annotation-label'),
  legendValue: chartTokenNumber('--space-annotation-value'),
  priceLabelPaddingY: chartTokenNumber('--chart-price-label-padding-y'),
} as const
const vwapOverlay = { label: 'VWAP(14)', color: 'var(--chart-2)', dash: '2 3',
  value: (bar: Bar, compact?: boolean) => formatIndicatorPrice(bar.vwap, compact) }
const bollOverlay = { label: 'BOLL(20,2)', color: 'var(--chart-1)', dash: undefined,
  value: (bar: Bar, compact?: boolean) => `U ${formatIndicatorPrice(bar.bollUpper, compact)}\u00a0·\u00a0M ${formatIndicatorPrice(bar.bollMiddle, compact)}\u00a0·\u00a0L ${formatIndicatorPrice(bar.bollLower, compact)}` }
const priceOverlays = [vwapOverlay, bollOverlay]

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
const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const documentVisible = () => document.visibilityState !== 'hidden'
const PriceCountdown = memo(function PriceCountdown({ hour, intervalMS, x, y }: { hour: number; intervalMS: number; x: number; y: number }) {
  const [now, setNow] = useState(Date.now)
  const visible = useContext(PlotVisible)
  useEffect(() => watchPriceCountdown(visible, presentationActive, setNow), [visible])
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
const chartPlot = createChartPlotCache(legendWidth, {
  top: chartTokenNumber('--chart-top-inset'),
  priceOnlyTop: chartTokenNumber('--chart-price-top-inset'),
  headerHeight: chartTokenNumber('--chart-panel-header-height'),
  rowGap: chartTokenNumber('--chart-row-gap'),
  bottomAxis: chartTokenNumber('--chart-bottom-axis-height'),
  headerBaseline: chartTokenNumber('--chart-panel-header-baseline'),
})
const chartOverscan = (surface: ReadyChartWindow | null, chartController: ChartController): { before?: Bar; after?: Bar } => {
  if (!surface?.bars.length) return {}
  if (chartController.store.snapshotMeta(surface.instId, surface.timeframe)?.generation !== surface.generation) return {}
  const bars = surface.liveBar
    ? [...surface.bars.filter(bar => bar.hour < surface.liveBar!.hour), surface.liveBar].slice(-(surface.windowBars ?? 96))
    : surface.bars
  const first = bars[0]!.hour, last = bars.at(-1)!.hour
  const [before, after] = chartController.store.knownBars(surface.instId, surface.timeframe,
    [first - surface.intervalMS, last + surface.intervalMS])
  return { before, after }
}

const PlotPaths = memo(function PlotPaths({ bars, geometry, areaClipId, oiState, takerState, priceVisible }: { priceVisible: boolean; bars: readonly Bar[]; geometry: ChartGeometry; areaClipId: string; oiState: PreparedChartState; takerState: PreparedChartState }) {
  const { upWicks, downWicks, upBodies, downBodies, buys, sells, lines, rsiMarkers, oiAxis, oiComplete, oiSamples, oiY, x, takerComplete, takerAvailable } = geometry
  const { panels } = geometry.layout
  const lineStroke = (key: keyof Bar, d: string, color: string, dash?: string) => <path data-chart-indicator={key} d={d} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
  return measureOperation({ category: 'cpu', name: 'chart.svg.paths.construct', attributes: { candles: bars.length } }, () => <>
    {/* Expose contrasting segments within the same 1px stroke for the mandated light green. */}
    <g clipPath={`url(#${areaClipId}-price)`} visibility={priceVisible ? "visible" : "hidden"}>
    <path d={upWicks} fill="none" stroke="var(--foreground)" />
    <path d={upWicks} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path d={downWicks} fill="none" stroke="var(--negative)" />
    <path d={upBodies} fill="var(--background)" stroke="var(--foreground)" />
    <path data-chart-candle-direction="up" data-chart-candle-fill="hollow" d={upBodies} fill="none" stroke="var(--positive)" strokeDasharray="2 3" />
    <path data-chart-candle-direction="down" data-chart-candle-fill="solid" d={downBodies} fill="var(--negative)" />
    </g>
    {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-taker)`} data-chart-taker={takerComplete ? "complete" : takerAvailable ? "partial" : "empty"} data-chart-taker-state={takerState}>
      <path data-chart-taker-buy-samples={geometry.buySamples} d={buys} fill="var(--positive)" stroke="var(--foreground)" opacity="0.9" />
      <path data-chart-taker-sell-samples={geometry.sellSamples} d={sells} fill="var(--negative)" stroke="var(--foreground)" opacity="0.9" />
      <path d={sells} fill={`url(#${areaClipId}-sell-hatch)`} opacity="0.7" />
    </g>}
    <g clipPath={`url(#${areaClipId}-price)`} visibility={priceVisible ? "visible" : "hidden"}>
    {lineStroke('bollUpper', lines.bollUpper, bollOverlay.color)}
    {lineStroke('bollMiddle', lines.bollMiddle, bollOverlay.color)}
    {lineStroke('bollLower', lines.bollLower, bollOverlay.color)}
    {lineStroke('vwap', lines.vwap, vwapOverlay.color, vwapOverlay.dash)}
    </g>
    {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-rsi)`}>
    {lineStroke("rsi6", lines.rsi6, "var(--chart-1)")}
    {lineStroke("rsi12", lines.rsi12, "var(--chart-2)", "7 4")}
    {lineStroke("rsi24", lines.rsi24, "var(--chart-3)", "3 4")}
    {rsiMarkers.map(marker => <path key={`${marker.field}:${marker.hour}`} data-chart-rsi-crossing={marker.field} data-chart-rsi-direction={marker.direction} data-chart-rsi-levels={marker.levels.join('/')} data-chart-rsi-hour={marker.hour}
      d={marker.d} fill={`var(--chart-${RSI_FIELDS.indexOf(marker.field) + 1})`} stroke="var(--background)" strokeLinejoin="round">
      <title>{`${time(marker.hour)} · RSI(${marker.field.slice(3)}) crossed ${marker.direction === 'up' ? 'above' : 'below'} ${marker.levels.join(' and ')} · ${marker.value.toFixed(1)}${marker.confirmed ? '' : ' · Forming candle'}`}</title>
    </path>)}
    </g>}
    {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-atr)`} data-chart-volatility-panel data-chart-panel-top={panels.atr[0]} data-chart-panel-bottom={panels.atr[1]}>
      {lineStroke("atrPercent", lines.atrPercent, "var(--chart-3)")}
      {lineStroke("bbw", lines.bbw, "var(--chart-1)", "7 4")}
    </g>}
    {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-roc)`}>
    {lineStroke("roc", lines.roc, "var(--chart-1)")}
    {lineStroke("maroc", lines.maroc, "var(--chart-2)", "7 4")}
    </g>}
    {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-oi)`} data-chart-oi={oiAxis ? oiComplete ? "complete" : "partial" : "empty"} data-chart-oi-state={oiState} data-chart-oi-samples={oiSamples.length}>
      {oiAxis && <>{lineStroke("oi", lines.oi, "var(--chart-2)")}{!oiComplete && oiSamples.map(sample => <circle key={bars[sample.index].hour} data-chart-oi-sample cx={x[sample.index]} cy={oiY(sample.value)} r="2" fill="var(--chart-2)" />)}</>}
    </g>}
  </>)
})

export const Plot = memo(function Plot({ bars, geometry, liveBar, liveOverlay = false, inspected, inspectedBar, contentOffset = 0, oiState = 'ready', takerState = 'ready', oiStatus, takerStatus }: { bars: readonly Bar[]; geometry: ChartGeometry; liveBar: Bar; liveOverlay?: boolean; inspected: number | null; inspectedBar?: Bar; contentOffset?: number; oiState?: PreparedChartState; takerState?: PreparedChartState; oiStatus?: ChartSourceStatus; takerStatus?: ChartSourceStatus }) {
  const areaClipId = useId().replaceAll(":", "")
  return measureOperation({ category: 'cpu', name: 'chart.svg.construct', attributes: { candles: bars.length, inspected: inspected !== null } }, () => {
  const presentation = chartPricePresentation(geometry, contentOffset)
  const n = bars.length
  const inspecting = inspected !== null || inspectedBar !== undefined
  const active = inspectedBar ?? bars[inspected ?? n - 1]
  const statistics = geometry.priceOnly ? null : inspectedBar ? chartStatisticsSamples([inspectedBar], 0) : chartStatisticsSamples(bars, inspected)
  const { width, height, endHour, intervalMS, gutter, x, candleHigh, candleLow, highIndex, lowIndex,
    rocAxis, oiAxis,
    priceY, rsiY, rocY, rocZeroY, rocAreas, bollBands, rsiMarkers } = geometry
  const { panels, columns, axisStarts, headerY, right } = geometry.layout
  const contentClip = chartContentClip(geometry.layout, height)
  const rocClip = chartPanelClip(geometry.layout, 'roc', geometry.barPitch)
  const tag = { price: liveBar.close, rising: liveBar.close >= liveBar.open, inViewport: presentation.base !== null && geometry.priceAxis.base !== null && Number.isFinite(liveBar.close) && liveBar.hour <= endHour + (liveOverlay ? intervalMS : 0) }
  const latestY = tag.inViewport ? priceY(tag.price) : panels.price[0]
  const latestColor = tag.rising ? "var(--positive)" : "var(--negative)"
  const latestPrice = formatCandleChange(liveBar.open, tag.price)
  const priceLabel = chartPriceLabelLayout(latestY, panels.price, chartTokens.textSize, chartTokens.priceLabelPaddingY, liveOverlay)
  const tickHalfHeight = chartTokens.textSize / 2
  const inspectionX = x[0] + (active.hour - bars[0].hour) / intervalMS * geometry.barPitch
  const inspectedTime = inspecting ? time(active.hour) : null
  const inspectedTimeWidth = inspectedTime ? chartTextWidth(inspectedTime) + chartTokens.annotationPadding : 0
  const inspectedTimeX = !inspecting ? 0 : Math.max(columns.rsi[0], Math.min(right - inspectedTimeWidth, inspectionX + contentOffset - inspectedTimeWidth / 2))
  const rsiValue = (field: RsiField) => {
    const marker = !inspecting ? undefined : rsiMarkers.find(marker => marker.hour === active.hour && marker.field === field)
    return `${active[field]?.toFixed(1) ?? '—'}${marker ? ` ${marker.direction === 'up' ? '↑' : '↓'}${marker.levels.join('/')}` : ''}`
  }
  const lineLabel = (x: number, y: number, label: string, color = "var(--muted-foreground)") =>
    <text x={x} y={y} dominantBaseline="middle" fill={color}>{label}</text>
  const panelKeys: readonly Panel[] = geometry.priceOnly ? ['price'] : CHART_PANELS
  // The panel and time-axis dividers span the whole viewport. Drawing both
  // edges of each plot would frame the data separately from its axes.
  const dividers = panelKeys.map(key => <line key={key} data-chart-panel-divider={key}
    x1={0} x2={width} y1={panels[key][1]} y2={panels[key][1]} stroke="var(--border)" opacity="0.55" />)
  const legend = (key: Panel, items: [string, string, string, string?, number?][]) => {
    const gap = chartTokens.legendGap
    const start = columns[key][0] + gap / 2
    const contexts = items.map(([, , , , sourceHour]) => sourceHour !== undefined && sourceHour !== active.hour ? ` · as of ${time(sourceHour)}` : '')
    const widths = items.map(([label, value], index) => chartTokens.legendLabel + legendWidth(label) + chartTokens.legendValue + legendWidth(value) + legendWidth(contexts[index]))
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
        <title>{label} {value}{contexts[index]}</title>
        {key === "taker" && !dash && <line data-chart-legend-outline={label} x1="0" x2={chartTokens.legendSymbol} stroke="var(--foreground)" />}
        <line data-chart-legend={label} x1="0" x2={chartTokens.legendSymbol} stroke={color} strokeDasharray={key === "taker" && !dash ? "2 3" : dash} />
        <text x={chartTokens.legendLabel} dominantBaseline="middle" fill={labelColor}>{label}</text>
        <text data-chart-legend-value x={chartTokens.legendLabel + legendWidth(label) + chartTokens.legendValue} dominantBaseline="middle" fill="var(--foreground)">{value}</text>
        {contexts[index] && <text data-chart-legend-source-context x={chartTokens.legendLabel + legendWidth(label) + chartTokens.legendValue + legendWidth(value)} dominantBaseline="middle" fill="var(--muted-foreground)">{contexts[index]}</text>}
        </g>
      })}
      </g>
    </g>
  }
  // A viewport can straddle a month boundary where the day gains a digit.
  const timeTickStep = chartTimeTickStep(geometry.barPitch, chartTextWidth(hourLabel(bars[n - 1].hour)) + chartTokens.textSize, chartTokens.annotationSmall)
  const timeAtX = (position: number) => bars[0].hour + (position - x[0] - contentOffset) / geometry.barPitch * intervalMS
  const timeTicks = chartTimeTicks(timeAtX(0), timeAtX(right), intervalMS, timeTickStep)
    .map(hour => ({ hour, x: x[0] + (hour - bars[0].hour) / intervalMS * geometry.barPitch }))
  const timeLabels = timeTicks.filter(tick => {
    const halfWidth = chartTextWidth(hourLabel(tick.hour)) / 2
    const center = tick.x + contentOffset
    return !inspectedTime || center + halfWidth < inspectedTimeX - chartTokens.annotationXs || center - halfWidth > inspectedTimeX + inspectedTimeWidth + chartTokens.annotationXs
  })
  return <>
    <defs>
      <pattern id={`${areaClipId}-sell-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" x2="0" y1="0" y2="4" stroke="var(--background)" opacity="0.55" />
      </pattern>
      <clipPath id={`${areaClipId}-positive`}><rect x={rocClip.x} y={panels.roc[0]} width={rocClip.width} height={rocZeroY - panels.roc[0]} /></clipPath>
      <clipPath id={`${areaClipId}-negative`}><rect x={rocClip.x} y={rocZeroY} width={rocClip.width} height={panels.roc[1] - rocZeroY} /></clipPath>
      <clipPath id={`${areaClipId}-content`}><rect {...contentClip} /></clipPath>
      <clipPath id={`${areaClipId}-time-axis`}><rect x={0} y={panels[panelKeys.at(-1)!][1]} width={width} height={height - panels[panelKeys.at(-1)!][1]} /></clipPath>
      {panelKeys.map(key => <clipPath key={key} id={`${areaClipId}-${key}`}><rect {...chartPanelClip(geometry.layout, key, geometry.barPitch)} /></clipPath>)}
    </defs>
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
      <g clipPath={`url(#${areaClipId}-price)`} visibility={presentation.base !== null && presentation.geometryBase !== null ? "visible" : "hidden"}>{bollBands.map((d, index) => <path key={index} data-chart-boll-band d={d} fill="var(--chart-1)" fillOpacity="0.1" />)}</g>
      {!geometry.priceOnly && <g clipPath={`url(#${areaClipId}-roc)`}>{rocAreas.map((area, index) => <g key={index}>
        <path d={area} fill="var(--chart-roc-positive-area)" clipPath={`url(#${areaClipId}-positive)`} />
        <path d={area} fill="var(--chart-roc-negative-area)" clipPath={`url(#${areaClipId}-negative)`} />
      </g>)}</g>}
      </g>
    </g>
    {!geometry.priceOnly && [30, 50, 70].map(level => <line key={level} data-chart-rsi-threshold={level} x1={columns.rsi[0]} x2={columns.rsi[1]} y1={rsiY(level)} y2={rsiY(level)} stroke={level === 50 ? 'var(--chart-midpoint)' : 'var(--chart-threshold)'} />)}
    {dividers}
    {rocZeroY > panels.roc[0] && rocZeroY < panels.roc[1] && <line x1={columns.roc[0]} x2={columns.roc[1]} y1={rocZeroY} y2={rocZeroY} stroke="var(--muted-foreground)" strokeOpacity="0.5" />}
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
    {timeTicks.flatMap(tick => panelKeys.map(key => <line key={`${tick.hour}-${key}`} x1={tick.x} x2={tick.x} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />))}
    <PlotPaths bars={bars} geometry={geometry} areaClipId={areaClipId} oiState={oiState} takerState={takerState} priceVisible={presentation.base !== null && presentation.geometryBase !== null} />
    {inspecting && panelKeys.map(key => <line key={key} x1={inspectionX} x2={inspectionX} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--foreground)" strokeDasharray="3 5" opacity="0.3" />)}
    <g clipPath={`url(#${areaClipId}-price)`}>
    {presentation.base !== null && geometry.priceAxis.base !== null && ([[highIndex, candleHigh, "high"], [lowIndex, candleLow, "low"]] as const).map(([index, value, kind]) => {
      if (!Number.isFinite(value)) return null
      const markerX = x[index], label = formatHistoricalPrice(value)
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
    <g clipPath={`url(#${areaClipId}-time-axis)`}>
      <g transform={`translate(${contentOffset},0)`}>
        {timeLabels.map(tick => <text data-chart-time-label key={tick.hour} x={tick.x} y={height - 4} textAnchor="middle" fill="var(--muted-foreground)">{hourLabel(tick.hour)}</text>)}
      </g>
    </g>
    {tag.inViewport && <g data-chart-price-label>
      <title>{`Change from candle open ${latestPrice} · ${liveOverlay ? 'Forming candle' : 'Candle'}`}</title>
      <rect data-chart-price-label-background x={right} y={priceLabel.top} width={gutter} height={priceLabel.bottom - priceLabel.top} fill="var(--chart-annotation)" />
      <text data-chart-price-label-value x={axisStarts.price} y={latestY} dominantBaseline="middle" fill="var(--foreground)" textLength={chartTextWidth(latestPrice) > gutter - chartTokens.annotationPadding ? Math.max(1, gutter - chartTokens.annotationPadding) : undefined} lengthAdjust="spacingAndGlyphs">{latestPrice}</text>
      {priceLabel.countdownY !== null && <PriceCountdown hour={liveBar.hour} intervalMS={intervalMS} x={axisStarts.price} y={priceLabel.countdownY} />}
    </g>}
    {statistics && <>
    {legend("price", priceOverlays.map(({ label, value, color, dash }) => [label, value(active), color, dash]))}
    {legend("roc", [["ROC(9)", formatPercent(active.roc), "var(--chart-1)"], ["MAROC(9)", formatPercent(active.maroc), "var(--chart-2)", "7 4"]])}
    {legend("rsi", [["RSI(6)", rsiValue('rsi6'), "var(--chart-1)"], ["RSI(12)", rsiValue('rsi12'), "var(--chart-2)", "7 4"], ["RSI(24)", rsiValue('rsi24'), "var(--chart-3)", "3 4"]])}
    {legend("atr", [["ATR%(14)", chartPercent(active.atrPercent), "var(--chart-3)"], ["BBW(20,2)", chartPercent(active.bbw), "var(--chart-1)", "7 4"]])}
    {legend("oi", [["OI (Contracts)", statistics.oi ? compact(statistics.oi.oi) : oiState === "loading" ? "Loading…" : oiState === "error" ? "Failed" : "Unavailable", "var(--chart-2)", undefined, statistics.oi?.hour]])}
    {legend("taker", [["↑ Taker Buy (Contracts)", statistics.taker ? compact(statistics.taker.buy) : takerState === "loading" ? "Loading…" : takerState === "error" ? "Failed" : "Unavailable", "var(--positive)", undefined, statistics.taker?.hour], ["↓ Taker Sell (Contracts)", statistics.taker ? compact(statistics.taker.sell) : takerState === "loading" ? "Loading…" : takerState === "error" ? "Failed" : "Unavailable", "var(--negative)", "2 3", statistics.taker?.hour]])}
    </>}
    {!geometry.priceOnly && [30, 70].map(level => <g key={level} data-chart-rsi-tick={level}>{lineLabel(axisStarts.rsi, rsiY(level), String(level), 'var(--foreground)')}</g>)}
    {panels.rsi[1] - panels.rsi[0] >= chartTokens.textSize * 6 && <>{lineLabel(axisStarts.rsi, rsiY(100), '100')}{lineLabel(axisStarts.rsi, rsiY(50), '50')}{lineLabel(axisStarts.rsi, rsiY(0), '0')}</>}
    {panels.roc[1] - panels.roc[0] >= 35 && rocAxis.ticks.map(tick => <g key={tick} data-chart-roc-tick>{lineLabel(axisStarts.roc, rocY(tick), formatPercent(tick, rocAxis.decimals))}</g>)}
    {oiAxis && panels.oi[1] - panels.oi[0] >= 35 && geometry.oiTicks.map(({ y, label }, index) => <g key={index} data-chart-oi-tick><line x1={columns.oi[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.25" />{lineLabel(axisStarts.oi, y, label)}</g>)}
    {panels.taker[1] - panels.taker[0] >= 35 && geometry.takerTicks.map(({ y, label }, index) => <g key={index} data-chart-taker-tick>{lineLabel(axisStarts.taker, y, label)}</g>)}
    {inspectedTime && <g data-chart-inspected-time><rect x={inspectedTimeX} y={height - 16} width={inspectedTimeWidth} height={15} rx={3} fill="var(--chart-annotation)" /><text x={inspectedTimeX + inspectedTimeWidth / 2} y={height - 4} textAnchor="middle" fill="var(--foreground)">{inspectedTime}</text></g>}
    {presentation.ticks.map(({ y, label }, index) => <g key={index} data-chart-price-tick><line x1={columns.price[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.35" />{(!tag.inViewport || y + tickHalfHeight < priceLabel.top || y - tickHalfHeight > priceLabel.bottom) && <text x={axisStarts.price} y={y} dominantBaseline="middle" fill="var(--muted-foreground)" textLength={chartTextWidth(label) > gutter - chartTokens.annotationPadding ? Math.max(1, gutter - chartTokens.annotationPadding) : undefined} lengthAdjust="spacingAndGlyphs">{label}</text>}</g>)}
    <line x1={right} x2={right} y1={panels.price[0]} y2={geometry.priceOnly ? panels.price[1] : panels.taker[1]} stroke="var(--border)" opacity="0.8" />
    {tag.inViewport && tag.rising && <line data-chart-live-price-outline x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke="var(--foreground)" />}
    {tag.inViewport && <line data-chart-live-price x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke={latestColor} strokeDasharray="4 5" />}
  </>
  })
})

type PlotSize = { width: number; height: number }

const ChartSurface = memo(function ChartSurface({ instId, timeframe, hasCompletedBars, priceState, indicatorState, oiState, takerState, oiStatus, takerStatus,
  liveBar, plot, size, selected, visible, inspected, inspectedBar, wheelFraction, readoutId }: {
  instId: string; timeframe: RadarTimeframe; hasCompletedBars: boolean; priceState?: PreparedChartState; indicatorState: PreparedChartState
  oiState: PreparedChartState; takerState: PreparedChartState; oiStatus?: ChartSourceStatus; takerStatus?: ChartSourceStatus
  liveBar?: Bar; plot: NonNullable<ReturnType<typeof chartPlot>>; size: PlotSize; selected: boolean; visible: boolean; inspected: number | null
  inspectedBar?: Bar; wheelFraction: number; readoutId: string
}) {
  const ready = Boolean(hasCompletedBars && (priceState === 'ready' || priceState === 'stale')
    && (indicatorState === 'ready' || indicatorState === 'unavailable')
    && oiState !== 'loading' && takerState !== 'loading')
  const { bars, geometry } = plot
  const contentOffset = chartWheelContentOffset(wheelFraction, geometry.barPitch, Boolean(plot.before), Boolean(plot.after))
  return <PlotVisible value={visible}>
    <svg strokeWidth="var(--chart-line-width)" data-prepared-chart-inst={instId} data-prepared-chart-timeframe={timeframe}
      data-prepared-chart-ready={ready} data-prepared-indicator-state={indicatorState} data-prepared-oi-state={oiState} data-prepared-taker-state={takerState}
      data-rendered-inst={selected ? instId : undefined} data-rendered-timeframe={selected ? timeframe : undefined}
      data-rendered-start={bars[0]!.hour} data-rendered-end={bars.at(-1)!.hour}
      data-chart-bar-width={geometry.barWidth} data-chart-domain-start={geometry.firstHour} data-chart-domain-end={geometry.endHour} data-chart-plot-right={geometry.layout.right}
      viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden={!selected}
      style={{ visibility: selected ? 'visible' : 'hidden' }}
      className={cn('absolute inset-0 h-full w-full font-mono text-[length:var(--chart-text-size)] select-none outline-none', !selected && 'pointer-events-none')}
      role="img" tabIndex={selected ? 0 : -1} aria-describedby={readoutId}
      aria-label={`${instId} ${bars.length}-candle ${timeframeLabel(timeframe)} chart. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window end.${geometry.priceOnly ? '' : ' Hover RSI crossing triangles to inspect their candle and time. Alt+Left and Alt+Right inspect RSI crossings;'} Escape clears inspection. Scroll to review history. Pinch the trackpad to zoom around the pointer. Arrow keys navigate markets.`}>
      <Plot bars={bars} geometry={geometry} liveBar={liveBar ?? bars.at(-1)!} liveOverlay={!!liveBar} contentOffset={contentOffset}
        inspected={selected ? inspected : null} inspectedBar={selected ? inspectedBar : undefined} oiState={oiState} takerState={takerState} oiStatus={oiStatus} takerStatus={takerStatus} />
    </svg>
  </PlotVisible>
})

export const MarketChart = memo(function MarketChart({ instId, tickSz, timeframe = '15m', active: isActive = true, onTimeframeChange, listOrder, turnoverOrder, onSelect, controller: chartController = defaultChartController, priceOnly = false, navigation = true, onStatus }: { controller?: ChartController; priceOnly?: boolean; navigation?: boolean; onStatus?: (timeframe: RadarTimeframe, value: SharedChartStatusValue | null) => void; instId: string; tickSz?: string | null; timeframe?: RadarTimeframe; active?: boolean; onTimeframeChange?: (value: RadarTimeframe) => void; candidateIds?: string[]; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void }) {
  const sync = useContext(ChartTimeSync)
  const presentation = usePresentation()
  const readoutId = useId()
  const windowVisible = usePresentedStore(subscribeVisibility, documentVisible)
  const controlsHelp = useRef<HTMLDialogElement>(null)
  const view = usePresentedStore(chartController.subscribe, chartController.getSnapshot)
  useLayoutEffect(() => {
    if (!isActive) return
    const target = chartController.getSnapshot().requested
    return chartController.open(instId, timeframe, target?.instId === instId && target.timeframe === timeframe ? target.end : null)
  }, [instId, timeframe, isActive, chartController])
  const surface = view.presented
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Selection and controller changes own a new visual cache.
  const indicatorPresentation = useMemo(() => createChartIndicatorPresentation(), [instId, timeframe, chartController])
  const displayedIndicators = indicatorPresentation.project(surface)
  useLayoutEffect(() => { indicatorPresentation.commit(surface) }, [indicatorPresentation, surface])
  const matchesSelection = surface?.instId === instId && surface.timeframe === timeframe
  const wheelSession = useMemo(() => ({ isActive, instId, timeframe }), [isActive, instId, timeframe])
  const pending = view.pending || !matchesSelection || displayedIndicators.stale
  const intervalMS = surface?.intervalMS ?? timeframeMilliseconds(timeframe)
  const displayedId = surface?.instId ?? instId
  const displayedFrame = surface?.timeframe ?? timeframe
  const error = view.requested?.instId === instId && view.requested.timeframe === timeframe ? view.error : ''
  const requestedEnd = view.requested?.end ?? view.latestEnd
  const historical = surface ? surface.endHour !== chartController.store.latestEnd(surface.instId, surface.timeframe) : false
  // Only the selected contract's forming quote uses today's trading precision.
  // Completed candles and a retained previous contract keep their source digits.
  const currentPriceTickSz = matchesSelection && !historical && surface?.liveBar ? tickSz : undefined
  const chartRef = useRef<HTMLElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<{ spacing: number; offset: number } | null>(null)
  const zoomRef = useRef(zoom)
  const lastSourceBar = surface?.liveBar?.hour ?? surface?.bars.at(-1)?.hour
  const sharedEnd = sync?.value ? sharedChartEnd(sync.value, Date.now()) : null
  const hasSync = sync !== null
  const viewport = useMemo(() => sync?.value && sharedEnd !== null && lastSourceBar !== undefined
    ? { ...sharedChartViewport(sharedEnd, sync.value.spacing, intervalMS, lastSourceBar), fixedGutter: sync.gutter }
    : hasSync ? { ...(zoom ?? { spacing: CHART_DEFAULT_SPACING, offset: 0 }), fixedGutter: sync?.gutter }
      : zoom ?? { spacing: CHART_DEFAULT_SPACING, offset: 0 }, [hasSync, sync?.value, sync?.gutter, sharedEnd, lastSourceBar, intervalMS, zoom])
  const overscan = chartOverscan(surface, chartController)
  const preparedPlot = chartPlot(displayedIndicators.window, plotSize, overscan, currentPriceTickSz, priceOnly, viewport)
  const bars = preparedPlot?.bars ?? surface?.bars ?? EMPTY_BARS
  const plotGeometry = preparedPlot?.geometry ?? null
  const visibleBars = plotGeometry?.windowBars ?? chartPitchSpan(plotSize.width, viewport.spacing)
  const demandBars = chartZoomDemand(visibleBars)
  useLayoutEffect(() => { if (isActive) chartController.setWindowBars(demandBars) }, [chartController, demandBars, isActive])
  useLayoutEffect(() => {
    if (!sync || sync.value || timeframe !== '1H' || !surface || !matchesSelection || !plotGeometry) return
    const now = Date.now()
    const last = surface.liveBar?.hour ?? surface.bars.at(-1)?.hour
    if (last === undefined) return
    const live = Boolean(surface.liveBar)
    // A completed frame may be presented before the forming candle arrives.
    // Do not navigate that fresh frame into history while waiting for its live update.
    const nearNow = now >= last && now - last <= 2 * intervalMS
    const end = live ? Math.max(last, Math.min(surface.priceObservedAt ?? now, last + intervalMS))
      : nearNow ? now : plotGeometry.endHour + intervalMS * 0.34
    const spacing = plotGeometry.barPitch
    sync.setValue(current => current ?? { end, spacing, follow: true, liveEnd: end, observedAt: now, advancing: false, oldest: 0 })
  }, [sync, timeframe, surface, matchesSelection, plotGeometry, intervalMS])
  useLayoutEffect(() => {
    if (!sync?.value || timeframe !== '1H' || !matchesSelection || !surface?.liveBar || !surface.priceObservedAt) return
    const last = surface.liveBar.hour
    const observed = Math.max(last, Math.min(surface.priceObservedAt, last + intervalMS))
    sync.setValue(current => !current || observed <= current.liveEnd ? current : {
      ...current, end: current.follow ? observed : current.end, liveEnd: observed, observedAt: surface.priceObservedAt!, advancing: false,
    })
  }, [sync, timeframe, matchesSelection, surface, intervalMS])
  useLayoutEffect(() => {
    if (!sync?.value || !view.historyExhausted || view.oldestHour === null) return
    const oldest = view.oldestHour
    sync.setValue(current => !current || oldest <= current.oldest ? current : {
      ...current, oldest, end: Math.max(oldest, current.end),
    })
  }, [sync, view.historyExhausted, view.oldestHour])
  useLayoutEffect(() => {
    if (!sync?.value || sharedEnd === null || !isActive) return
    const current = chartController.getSnapshot()
    if (!current.requested || current.latestEnd === null) return
    // Following uses each native latest cursor even if the first cached frame
    // predates the next live update. Otherwise initialization can accidentally
    // turn a stale startup frame into a permanent historical request.
    const target = sync.value.follow ? current.latestEnd : Math.min(current.latestEnd, Math.floor(sharedEnd / intervalMS) * intervalMS)
    const currentEnd = current.requested.end ?? current.latestEnd
    const steps = Math.round((target - currentEnd) / intervalMS)
    if (steps) chartController.scroll(steps)
  }, [chartController, sync?.value, sharedEnd, intervalMS, isActive, view.latestEnd, view.requested])
  const [inspection, setInspection] = useState<{ instId: string; timeframe: RadarTimeframe; hour: number } | null>(null)
  const inspectedIndex = inspection?.instId === surface?.instId && inspection?.timeframe === surface?.timeframe ? bars.findIndex(bar => bar.hour === inspection?.hour) : -1
  const inspected = inspectedIndex >= 0 ? inspectedIndex : null
  const inspectedBar = inspection?.instId === surface?.instId && inspection?.timeframe === surface?.timeframe
    ? [preparedPlot?.before, ...bars, preparedPlot?.after].find(bar => bar?.hour === inspection?.hour) : undefined
  const heldPointer = useRef<{ pointerId: number; target: SVGSVGElement } | null>(null)
  const releaseInspection = useCallback(() => {
    const held = heldPointer.current
    heldPointer.current = null
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId)
  }, [])
  useLayoutEffect(() => {
    if (!presentation.active || !plotRef.current) return
    const { clientWidth: width, clientHeight: height } = plotRef.current
    if (width > 0 && height > 0) setPlotSize(current => current.width === width && current.height === height ? current : { width, height })
  }, [presentation.active])
  const endInspection = useCallback(() => { releaseInspection(); setInspection(null) }, [releaseInspection, setInspection])
  const wheelBatch = useRef(createChartWheelBatch())
  const wheelRemainder = useRef(0)
  const zoomPixels = useRef(0)
  const gestureKind = useRef<'pan' | 'zoom' | null>(null)
  const [wheelScheduler] = useState(() => createChartWheelScheduler({
    queueMicrotask: callback => queueMicrotask(callback),
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: handle => window.cancelAnimationFrame(handle),
  }))
  const [wheelFraction, setWheelFraction] = useState(0)
  const [wheelOwner, setWheelOwner] = useState<{ session: object; instId: string; timeframe: RadarTimeframe; generation: number } | null>(null)
  const wheelOwnerRef = useRef<typeof wheelOwner>(null)
  const wheelOwnerMatches = Boolean(wheelOwner?.session === wheelSession && wheelOwner.generation === surface?.generation)
  const requestedEndMatches = Boolean(surface && view.requested && view.requested.instId === surface.instId
    && view.requested.timeframe === surface.timeframe && (view.requested.end ?? view.latestEnd) === surface.endHour)
  const activeWheelFraction = matchesSelection && wheelOwnerMatches
    ? chartPresentedWheelFraction(wheelFraction, view.pending && !requestedEndMatches ? requestedEnd : surface?.endHour, surface?.endHour, intervalMS) : 0
  const wheelContentOffset = chartWheelContentOffset(activeWheelFraction, plotGeometry?.barPitch ?? 0,
    Boolean(preparedPlot?.before), Boolean(preparedPlot?.after))
  // Do not include the measured geometry or shared gutter in this epoch:
  // both change as the shared width converges. New market data, navigation,
  // fractional scrolling, and size changes invalidate the measurement.
  const gutterEpoch = useMemo(() => ({ window: displayedIndicators.window, sync: sync?.value, fraction: activeWheelFraction, width: plotSize.width, height: plotSize.height, instId, timeframe }), [displayedIndicators.window, sync?.value, activeWheelFraction, plotSize.width, plotSize.height, instId, timeframe])
  const reportGutter = sync?.reportGutter
  useLayoutEffect(() => {
    if (!reportGutter) return
    if (!plotGeometry || !matchesSelection || !bars.length) { reportGutter(timeframe, null, null); return }
    const ticks = chartPricePresentation(plotGeometry, wheelContentOffset).ticks.map(tick => tick.label)
    const quote = surface?.liveBar && surface.liveBar.hour <= plotGeometry.endHour + intervalMS * 0.34 ? surface.liveBar : bars.at(-1)!
    const change = formatCandleChange(quote.open, quote.close)
    // PriceCountdown can exceed two minute digits for future-dated candles.
    const seconds = Math.max(0, Math.floor((quote.hour + intervalMS - Date.now()) / 1000))
    const minutes = Math.max(Math.ceil(intervalMS / 60_000), Math.floor(seconds / 60))
    const countdown = `${String(minutes).padStart(2, '0')}:00`
    reportGutter(timeframe, gutterEpoch, Math.ceil(Math.max(...[...ticks, change, countdown].map(legendWidth)) + 16))
  }, [reportGutter, timeframe, gutterEpoch, plotGeometry, wheelContentOffset, matchesSelection, bars, surface?.liveBar, intervalMS])
  useEffect(() => () => reportGutter?.(timeframe, null, null), [reportGutter, timeframe])
  const navigationId = useRef(instId)
  const navigationTask = useRef<object | null>(null)
  useLayoutEffect(() => {
    navigationId.current = instId
    navigationTask.current = null
    wheelBatch.current.reset()
    wheelRemainder.current = 0
    zoomPixels.current = 0
    gestureKind.current = null
    if (zoomRef.current) {
      zoomRef.current = { ...zoomRef.current, offset: 0 }
      setZoom(zoomRef.current)
    }
    wheelScheduler.cancel()
    wheelOwnerRef.current = null
    releaseInspection()
  }, [isActive, instId, timeframe, releaseInspection, wheelScheduler])
  useLayoutEffect(() => {
    if (presentation.active) return
    wheelScheduler.cancel()
    wheelBatch.current.reset()
    zoomPixels.current = 0
    gestureKind.current = null
    wheelRemainder.current = 0
    wheelOwnerRef.current = null
  }, [presentation.active, wheelScheduler])
  useLayoutEffect(() => {
    const element = chartRef.current
    if (element) {
      Object.defineProperty(element, '__chartSnapshot', { configurable: true, value: surface })
      Object.defineProperty(element, '__chartRenderedBars', { configurable: true, value: bars })
    }
  }, [surface, bars])
  useLayoutEffect(() => () => {
    wheelScheduler.cancel()
    wheelBatch.current.reset()
    navigationTask.current = null
  }, [wheelScheduler])
  useLayoutEffect(() => {
    const element = plotRef.current
    if (!element) return
    const measure = (width: number, height: number) => {
      // Keep the rendered chart intact while its workspace is hidden.
      if (!getPresentation().active || !(width > 0 && height > 0)) return
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
  useLayoutEffect(() => {
    if (!isActive || !navigation) return
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, dialog, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="radio"], [role="radiogroup"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="tablist"], [role="tree"], [role="grid"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [aria-haspopup][aria-expanded="true"]')) return
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
          if (navigationTask.current !== task || !getPresentation().active) { navigationTask.current = null; return }
          navigationTask.current = null
          flushSync(() => onSelect(navigationId.current))
        })
      }
    }
    window.addEventListener('keydown', navigate, true)
    return () => window.removeEventListener('keydown', navigate, true)
  }, [isActive, navigation, listOrder, turnoverOrder, onSelect])
  const startGesture = (kind: 'pan' | 'zoom') => {
    if (gestureKind.current === kind) return
    wheelScheduler.cancel()
    wheelBatch.current.reset()
    zoomPixels.current = 0
    wheelRemainder.current = 0
    setWheelFraction(0)
    gestureKind.current = kind
  }
  const queueZoom = (pixels: number, clientX: number) => {
    if (!isActive || !getPresentation().active || !surface || !matchesSelection || !plotGeometry || !Number.isFinite(pixels) || !pixels) return
    const rect = plotRef.current?.getBoundingClientRect()
    if (!rect?.width) return
    const x = (clientX - rect.left) * plotSize.width / rect.width
    const anchor = (x - plotGeometry.layout.left) / (plotGeometry.layout.right - plotGeometry.layout.left)
    if (sync?.value) {
      startGesture('zoom')
      zoomPixels.current += pixels
      wheelScheduler.schedule(() => {
        const amount = zoomPixels.current
        zoomPixels.current = 0
        if (!getPresentation().active) return
        sync.setValue(current => current ? sharedChartGesture(current, 'zoom', amount, plotGeometry.layout.right - plotGeometry.layout.left, intervalMS, anchor, Date.now()) : current)
        endInspection()
      })
      return
    }
    startGesture('zoom')
    zoomPixels.current += pixels
    wheelScheduler.schedule(() => {
      if (!getPresentation().active) return
      const previous = zoomRef.current ?? { spacing: CHART_DEFAULT_SPACING, offset: 0 }
      const next = chartZoomSpacing(previous.spacing, zoomPixels.current, anchor, plotGeometry.layout.right - plotGeometry.layout.left)
      zoomPixels.current = 0
      if (next.spacing === previous.spacing) return
      const offset = previous.offset + next.shift
      // Keep a fractional endpoint while using the existing integer cache cursor.
      const current = chartController.getSnapshot()
      const sourceEnd = current.requested?.end ?? current.latestEnd
      const latestHasLive = Boolean(chartController.store.window(instId, timeframe, null)?.liveBar)
      const oldLive = current.requested?.end === null && latestHasLive ? 1 : 0
      const steps = oldLive && offset < 0 ? Math.min(0, Math.ceil(offset + 1)) : Math.ceil(offset)
      flushSync(() => {
        chartController.setWindowBars(chartZoomDemand(next.count))
        if (steps) chartController.scroll(steps)
        const target = chartController.getSnapshot().requested
        const targetEnd = target?.end ?? current.latestEnd
        const actualSteps = sourceEnd !== undefined && sourceEnd !== null && targetEnd !== null && targetEnd !== undefined ? (targetEnd - sourceEnd) / intervalMS : 0
        const newLive = target?.end === null && latestHasLive ? 1 : 0
        const remaining = offset - actualSteps - (newLive - oldLive)
        const nextZoom = { spacing: next.spacing, offset: Math.min(0, remaining) }
        zoomRef.current = nextZoom
        setZoom(nextZoom)
        endInspection()
      })
    })
  }
  const queueWheel = (pixels: number) => {
    if (!isActive || !getPresentation().active || !surface || !matchesSelection || !Number.isFinite(pixels) || pixels === 0) return
    if (sync?.value && plotGeometry) {
      startGesture('pan')
      wheelBatch.current.add(pixels)
      wheelScheduler.schedule(() => {
        const progress = wheelBatch.current.consume(0)
        const amount = progress.steps * CHART_WHEEL_PIXELS_PER_BAR + progress.remainderPixels
        if (!getPresentation().active) return
        sync.setValue(current => current ? sharedChartGesture(current, 'pan', amount, plotGeometry.layout.right - plotGeometry.layout.left, intervalMS, 0.5, Date.now()) : current)
        endInspection()
      })
      return
    }
    startGesture('pan')
    const owner = { session: wheelSession, instId: surface.instId, timeframe: surface.timeframe, generation: surface.generation }
    const currentOwner = wheelOwnerRef.current
    if (!currentOwner || currentOwner.session !== owner.session) {
      wheelOwnerRef.current = owner
      wheelBatch.current.reset()
      wheelRemainder.current = 0
      wheelScheduler.cancel()
    }
    wheelBatch.current.add(pixels)
    wheelScheduler.schedule(() => {
      if (!getPresentation().active) return
      const progress = wheelBatch.current.consume(wheelRemainder.current)
      wheelRemainder.current = progress.remainderPixels
      flushSync(() => {
        setWheelOwner(current => current?.session === owner.session && current.instId === owner.instId && current.timeframe === owner.timeframe && current.generation === owner.generation ? current : owner)
        endInspection()
        if (progress.steps) chartController.scroll(progress.steps)
        const atLatest = chartController.getSnapshot().requested?.end === null
        const viewport = zoomRef.current
        // The cache cursor stops at latest, so it cannot consume a pinch's
        // fractional endpoint. Release that endpoint when panning reaches it.
        const reachedLatest = viewport && atLatest && (progress.steps > 0
          || progress.fraction > 0 && progress.fraction + viewport.offset >= 0)
        if (reachedLatest) {
          if (viewport.offset !== 0) {
            zoomRef.current = { ...viewport, offset: 0 }
            setZoom(zoomRef.current)
          }
          wheelRemainder.current = 0
          setWheelFraction(0)
        } else setWheelFraction(progress.fraction)
      })
      if (progress.fraction && wheelOwnerRef.current?.session === owner.session) chartController.prefetchAdjacent(progress.fraction)
    })
  }
  const inspectAt = (target: SVGSVGElement, clientX: number) => {
    if (!surface || !bars.length || !plotGeometry) return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0) return
    const svgX = (clientX - rect.left) * plotSize.width / rect.width
    const candidates = [wheelContentOffset > 0 ? preparedPlot?.before : undefined, ...bars, wheelContentOffset < 0 ? preparedPlot?.after : undefined].filter((bar): bar is Bar => Boolean(bar))
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
  const active = inspectedBar ?? bars[inspected ?? bars.length - 1]
  const liveBar = surface?.liveBar && plotGeometry && surface.liveBar.hour <= plotGeometry.endHour + intervalMS * 0.34 ? surface.liveBar : undefined
  const oiState = surface?.oiState ?? 'ready'
  const takerState = surface?.takerState ?? 'ready'
  const atBoundary = view.historyExhausted && surface && view.oldestHour !== null && surface.endHour === Math.min(view.latestEnd ?? Infinity, view.oldestHour + ((surface.windowBars ?? 96) - 1) * intervalMS)
  const pricePresentation = plotGeometry ? chartPricePresentation(plotGeometry, wheelContentOffset, false) : null
  const priceScale = !pricePresentation || pricePresentation.base === null || pricePresentation.geometryBase === null ? 'unavailable' : 'relative'
  const priceState = surface?.priceState ?? 'loading'
  const statusMessages: string[] = []
  if (pending && !error) statusMessages.push(surface ? `Preparing ${instId.replace(/-SWAP$/, '')} ${timeframeLabel(timeframe)}${requestedEnd !== null ? ` · ${time(requestedEnd)}` : ''}…` : 'Loading local prices…')
  if (surface && !error && priceState === 'partial') statusMessages.push('Repairing missing price history…')
  if (surface && !error && priceState === 'stale') statusMessages.push('Recent price history is stale; repairing…')
  if (surface && !error && priceState === 'loading') statusMessages.push('Loading price history…')
  if (priceState === 'error') statusMessages.push(sourceStatusText('Price history', priceState, surface?.priceStatus))
  if (priceState === 'unavailable') statusMessages.push('Price history is unavailable for this range')
  if (surface?.indicatorState === 'loading') statusMessages.push(displayedIndicators.stale ? 'Calculating indicators… Showing previous indicators.' : 'Calculating indicators…')
  if (surface?.indicatorState === 'error') statusMessages.push(sourceStatusText('Indicators', 'error', surface.indicatorStatus))
  if (surface?.indicatorState === 'unavailable') statusMessages.push(surface.indicatorStatus?.reason === 'insufficient-history' ? 'Insufficient history for some indicators' : 'Some indicators are undefined for this range')
  if (!priceOnly) for (const [label, state, status] of [['OI', oiState, surface?.oiStatus], ['Taker', takerState, surface?.takerStatus]] as const) {
    const message = sourceStatusText(label, state, status)
    if (message) statusMessages.push(message)
  }
  if (atBoundary && !pending) statusMessages.push('Start of available history')
  if (!statusMessages.length && error) statusMessages.push('Chart update failed')
  if (priceOnly && historical && !inspectedBar && active) statusMessages.push(`Window end ${time(active.hour)}`)
  if (priceOnly && priceScale === 'unavailable' && surface) statusMessages.push('Price scale unavailable')
  const statusLoading = !error && ((pending) || priceState === 'loading' || priceState === 'partial' || priceState === 'stale')
    || surface?.indicatorState === 'loading' || !priceOnly && (oiState === 'loading' || takerState === 'loading')
  const statusSummary = statusMessages.join(' · ')
  const sharedError = [
    error ? 'Chart update failed. Check the data service and try again.' : '',
    priceState === 'error' ? 'Price history could not be loaded. Check the market connection and data service.' : '',
    surface?.indicatorState === 'error' ? 'Indicators could not be calculated. Check the data service.' : '',
  ].filter(Boolean).join(' · ')
  const inspectionReadout = active && <div id={readoutId} data-chart-inspection-readout hidden={priceOnly && inspectedBar === undefined} aria-live="off" className={priceOnly ? 'pointer-events-none absolute left-0 right-0 top-0 z-10 flex flex-wrap gap-x-3 bg-background/90 px-4 text-xs' : undefined}>
    <p className="min-w-0 truncate" data-chart-inspected-hour={inspectedBar?.hour}><span className="text-muted-foreground">{inspectedBar === undefined ? historical ? 'Window end' : 'Latest' : 'Selected'}</span> {time(active.hour)}</p>
    {([['Open', active.open], ['High', active.high], ['Low', active.low], ['Close', active.close]] as const).map(([label, value]) => {
      const text = label === 'Close' && active === surface?.liveBar ? formatCurrentPrice(value, currentPriceTickSz) : formatHistoricalPrice(value)
      return <div key={label} data-chart-ohlc={label.toLowerCase()} className="min-w-0"><span className="text-muted-foreground">{label} </span><span title={text}>{text}</span></div>
    })}
    {priceOnly && inspectedBar && priceOverlays.map(({ label, value }) => <div key={label} data-chart-inspection-indicator={label}>
      <span className="text-muted-foreground">{label} </span><span data-chart-legend-value title={value(inspectedBar)}>{value(inspectedBar, true)}</span>
    </div>)}
  </div>
  const statusContent = <div data-chart-status data-timeframe={timeframe} data-chart-indicator-state={surface?.indicatorState} data-chart-indicator-stale={displayedIndicators.stale} data-chart-indicator-input={surface?.indicatorStatus?.inputVersion} role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    {statusLoading && <Spinner aria-hidden="true" role="presentation" />}
    <p className="min-w-0 truncate" title={error || statusSummary}>{error || statusSummary}</p>
  </div>
  return <section data-chart-workspace aria-label="Market chart workspace" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    {priceOnly && onStatus && <SharedChartStatus timeframe={timeframe} summary={sharedError ? '' : statusSummary} error={sharedError} warning={priceState === 'stale' || priceState === 'partial' || priceState === 'unavailable' || surface?.indicatorState === 'unavailable'} loading={statusLoading} observedAt={surface?.priceObservedAt} realtime={surface?.realtimeState} active={windowVisible && presentation.active} historical={historical} onStatus={onStatus} />}
    {!priceOnly && <header data-chart-toolbar data-window-toolbar data-window-drag-region className="flex items-center gap-3 border-b px-4">
      <ToggleGroup variant="outline" size="sm" className="mr-auto" value={[timeframe]} onValueChange={values => { const value = values[0]; if (value) onTimeframeChange?.(value as RadarTimeframe) }} aria-label="Chart timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup>
      <Button variant="ghost" size="sm" onClick={() => controlsHelp.current?.showModal()}>Chart controls</Button>
      {(historical || displayedFrame !== timeframe) && <Badge variant="secondary">{timeframeLabel(displayedFrame)}{historical ? ' history' : ' chart'}</Badge>}
      {!historical && <PriceStatus observedAt={surface?.priceObservedAt} realtime={surface?.realtimeState} active={isActive && windowVisible && presentation.active} />}
    </header>}
    <dialog ref={controlsHelp} aria-labelledby="chart-controls-title" className="m-auto w-[min(28rem,calc(100%-var(--space-8)))] rounded-lg border bg-popover p-6 text-popover-foreground backdrop:bg-background/80">
      <div className="flex flex-col gap-4">
        <h2 id="chart-controls-title" className="text-base font-medium">Chart controls</h2>
        <ul className="flex list-disc flex-col gap-2 pl-4 text-sm">
          <li>Scroll over the chart to browse history; pinch to zoom around the pointer</li>
          <li>Hold and drag on the chart to inspect candles; release to return to the window end</li>
          <li>Hover an RSI crossing marker to inspect it, or focus the chart and use Alt + Left or Right to move between crossings</li>
          <li>Press Escape to clear a chart inspection</li>
          <li>Use Up or Down to change contracts; Left selects the largest move and Right selects the highest 24h volume</li>
        </ul>
        <div className="flex justify-end"><Button variant="outline" size="sm" onClick={() => controlsHelp.current?.close()}>Close</Button></div>
      </div>
    </dialog>
    {!priceOnly && error && <div role="alert" className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-destructive">{error}</div>}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={displayedId} data-chart-indicator-state={surface?.indicatorState} data-chart-indicator-stale={displayedIndicators.stale} data-chart-indicator-input={surface?.indicatorStatus?.inputVersion} data-chart-time-end={plotGeometry ? plotGeometry.endHour + intervalMS * 0.34 - wheelContentOffset / plotGeometry.barPitch * intervalMS : undefined} data-chart-time-start={plotGeometry ? plotGeometry.endHour + intervalMS * 0.34 - (plotGeometry.layout.right - plotGeometry.layout.left + wheelContentOffset) / plotGeometry.barPitch * intervalMS : undefined} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-chart-completed-end={surface?.endHour} data-chart-cache-start={view.oldestHour ?? undefined} data-chart-requested-end={requestedEnd ?? undefined} data-chart-rendered-bars={bars.length} data-chart-target-bars={surface?.windowBars ?? 96} data-chart-visible-bars={visibleBars} data-chart-bar-spacing={viewport.spacing} data-chart-visual-stale={surface && !matchesSelection ? 'true' : 'false'} data-chart-candle-state={priceState} data-chart-statistics-state={surface?.oiState === 'error' || surface?.takerState === 'error' ? 'error' : surface?.oiState === 'loading' || surface?.takerState === 'loading' ? 'loading' : surface?.oiState === 'unavailable' || surface?.takerState === 'unavailable' ? 'unavailable' : surface ? 'ready' : 'loading'} data-chart-statistics-end={surface?.endHour} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete={priceState !== 'ready' || surface?.indicatorState !== 'ready' || oiState !== 'ready' || takerState !== 'ready' ? 'true' : 'false'} data-chart-loading={pending ? 'true' : 'false'} aria-label={`${displayedId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {!priceOnly && <div data-chart-summary className="flex shrink-0 items-center border-b px-4">
        {!priceOnly && <h2 data-chart-title className="min-w-0 max-w-40 shrink-0 truncate" title={displayedId} aria-label={`${displayedId.replace(/-SWAP$/, '')} · ${timeframeLabel(displayedFrame)}`}>{`${displayedId.replace(/-SWAP$/, '')} · ${timeframeLabel(displayedFrame)}`}</h2>}
        {statusContent}
        {inspectionReadout}
        {(!priceOnly || priceScale === 'unavailable') && <span data-chart-price-scale={priceScale} className="ml-auto text-muted-foreground" title={priceScale === 'unavailable' ? 'Price scale unavailable: first visible open must be positive' : 'Change from first visible open'}>{priceScale === 'unavailable' ? 'Unavailable' : 'Change %'}</span>}
      </div>}
      {priceOnly && inspectionReadout}
      <div ref={plotRef} data-chart-plot tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden outline-none" onKeyDown={event => {
        if (event.key === 'Escape') { endInspection(); return }
        if (priceOnly || !matchesSelection || !surface || !plotGeometry || !event.altKey || !(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
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
      }} onPointerUp={endInspection} onPointerCancel={releaseInspection} onLostPointerCapture={releaseInspection} onPointerMove={event => {
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
        const intent = chartWheelIntent(event)
        if (intent.kind === 'zoom') queueZoom(intent.pixels, event.clientX)
        else queueWheel(intent.pixels)
      }}>
        {surface && preparedPlot && <ChartSurface instId={surface.instId} timeframe={surface.timeframe} hasCompletedBars={surface.bars.length > 0}
          priceState={surface.priceState} indicatorState={surface.indicatorState} oiState={surface.oiState} takerState={surface.takerState}
          oiStatus={surface.oiStatus} takerStatus={surface.takerStatus} liveBar={liveBar} plot={preparedPlot} size={plotSize}
          selected={matchesSelection} visible={matchesSelection && isActive && windowVisible && presentation.active} inspected={inspected} inspectedBar={inspectedBar} wheelFraction={activeWheelFraction} readoutId={readoutId} />}
      </div>
    </section>
    </div>
  </section>
})
