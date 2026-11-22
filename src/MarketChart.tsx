import { readDesignLengths } from '@/design-lengths'
import { CHART_DEFAULT_SPACING, chartPitchSpan } from './chart-layout.ts'
import { chartTimeLabels, chartTimeTicks, chartTimeTickStep } from './chart-axis.ts'
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { chartContentClip, chartIndicatorLabelLayout, chartPanelClip, chartPriceInPanel, chartPriceLabelLayout } from "@/chart-layout"
import { chartPricePresentation, chartVisibleLastBar, type ChartGeometry } from "@/chart-geometry"
import { formatCurrentPrice, formatHistoricalPrice, formatIndicatorPrice } from '@/price-format'
import { CHART_WHEEL_PIXELS_PER_BAR, chartWheelIntent, chartZoomDemand, chartZoomSpacing, chartWheelContentOffset, chartPresentedWheelFraction, createChartWheelBatch, createChartWheelScheduler } from '@/chart-navigation'
import { cn } from "@/lib/utils"
import { chartNavigationTarget } from "@/market-sort"
import { candleChangeDirection, formatCandleChange } from "@/market-percent"
import { timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

import { chartController as defaultChartController, type ChartController } from '@/chart-controller'
import { createChartIndicatorPresentation, createChartPlotCache } from '@/chart-render'
import type { Bar, ChartSourceStatus, PreparedChartState, ReadyChartWindow } from '@/chart-data'
import { measureOperation } from '../electron/services/operations.js'
import { getPresentation, usePresentation, usePresentedStore } from '@/presentation-store'
import { isPriceFresh, watchPriceFreshness, watchPriceCountdown } from '@/price-clock'
import { sharedChartEnd, sharedChartGesture, sharedChartLiveEnd, sharedChartViewport, type SharedChartTime } from '@/chart-time-sync'

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
const chartStyle = getComputedStyle(document.documentElement)
// Tokens are fixed for the page lifetime; geometry and rendered annotations share these resolved pixels.
const chartLengths = readDesignLengths({
  '--chart-text-size': 10, '--space-4': 12,
  '--space-annotation-small': 8, '--space-annotation-xs': 4,
  '--chart-price-label-padding-y': 3, '--chart-price-top-inset': 0, '--chart-bottom-axis-height': 16,
})
const chartTokenNumber = (token: keyof typeof chartLengths) => chartLengths[token]
const chartTokens = {
  textSize: chartTokenNumber('--chart-text-size'),
  annotationPadding: chartTokenNumber('--space-4'),
  annotationSmall: chartTokenNumber('--space-annotation-small'),
  annotationXs: chartTokenNumber('--space-annotation-xs'),
  priceLabelPaddingY: chartTokenNumber('--chart-price-label-padding-y'),
} as const
const bollOverlay = { label: 'BOLL(20,2)',
  value: (bar: Bar, compact?: boolean) => `U ${formatIndicatorPrice(bar.bollUpper, compact)}\u00a0·\u00a0M ${formatIndicatorPrice(bar.bollMiddle, compact)}\u00a0·\u00a0L ${formatIndicatorPrice(bar.bollLower, compact)}` }
const priceOverlays = [bollOverlay]

const legendContext = document.createElement("canvas").getContext("2d")
const chartTextWidths = new Map<string, number>()
const chartTextWidth = (text: string, fontSize: number = chartTokens.textSize, weight = 400) => {
  const normalized = text.replace(/\d/g, "0")
  const key = `${fontSize}:${weight}:${normalized}`
  const cached = chartTextWidths.get(key)
  if (cached !== undefined) return cached
  if (!legendContext) return normalized.length * fontSize * .7
  legendContext.font = `${weight} ${fontSize}px ${chartStyle.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'}`
  const width = legendContext.measureText(normalized).width
  chartTextWidths.set(key, width)
  return width
}
const legendWidth = (text: string) => Math.max(chartTextWidth(text), chartTextWidth(text, chartTokens.textSize, 700))
const PlotVisible = createContext(true)
const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const documentVisible = () => document.visibilityState !== 'hidden'
const PriceCountdown = memo(function PriceCountdown({ hour, intervalMS, x, y, fill }: { hour: number; intervalMS: number; x: number; y: number; fill: string }) {
  const [now, setNow] = useState(Date.now)
  const visible = useContext(PlotVisible)
  useEffect(() => watchPriceCountdown(visible, presentationActive, setNow), [visible])
  const seconds = Math.max(0, Math.floor((hour + intervalMS - now) / 1000))
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return <text data-chart-countdown x={x} y={y} dominantBaseline="middle" fill={fill}>{value}</text>
})
const sourceStatusText = (label: string, state: PreparedChartState, status?: ChartSourceStatus) => {
  if (state === 'error') return `${label} failed: ${status?.error || 'Source request failed'}${status?.retryAt ? ` · retry at ${new Date(status.retryAt).toLocaleTimeString('en-US', { hour12: false })}` : status?.retryOn === 'worker-recovery' ? ' · waiting for calculation service recovery' : status?.retryOn === 'input-change' ? ' · waiting for updated data' : ''}`
  if (state === 'loading') return `Loading ${label} history…`
  if (state === 'unavailable') return status?.reason === 'unsupported' ? `${label} history is unsupported` : `${label} is not published for part of this range`
  return ''
}
const chartPlot = createChartPlotCache(legendWidth, {
  priceOnlyTop: chartTokenNumber('--chart-price-top-inset'),
  bottomAxis: chartTokenNumber('--chart-bottom-axis-height'),
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

const PlotPaths = memo(function PlotPaths({ bars, geometry, areaClipId, priceVisible }: { priceVisible: boolean; bars: readonly Bar[]; geometry: ChartGeometry; areaClipId: string }) {
  const { upWicks, downWicks, upBodies, downBodies, bollLines } = geometry
  const lineStroke = (key: keyof Bar, d: string, color: string, dash?: string) => <path data-chart-indicator={key} d={d} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
  return measureOperation({ category: 'cpu', name: 'chart.svg.paths.construct', attributes: { candles: bars.length } }, () => <>
    <g clipPath={`url(#${areaClipId}-price)`} visibility={priceVisible ? "visible" : "hidden"}>
    {lineStroke("bollUpper", bollLines.bollUpper, "var(--chart-boll-upper)")}
    {lineStroke("bollMiddle", bollLines.bollMiddle, "var(--chart-boll-middle)")}
    {lineStroke("bollLower", bollLines.bollLower, "var(--chart-boll-lower)")}
    <path d={upWicks} fill="none" stroke="var(--positive)" />
    <path d={downWicks} fill="none" stroke="var(--negative)" />
    <path data-chart-candle-direction="up" data-chart-candle-fill="solid" d={upBodies} fill="var(--positive)" />
    <path data-chart-candle-direction="down" data-chart-candle-fill="solid" d={downBodies} fill="var(--negative)" />
    </g>
  </>)
})

const Plot = memo(function Plot({ bars, geometry, liveBar, liveOverlay = false, showBollingerPriceLabels = false, inspected, inspectedBar, contentOffset = 0 }: { bars: readonly Bar[]; geometry: ChartGeometry; liveBar: Bar; liveOverlay?: boolean; showBollingerPriceLabels?: boolean; inspected: number | null; inspectedBar?: Bar; contentOffset?: number }) {
  const areaClipId = useId().replaceAll(":", "")
  return measureOperation({ category: 'cpu', name: 'chart.svg.construct', attributes: { candles: bars.length, inspected: inspected !== null } }, () => {
  const presentation = chartPricePresentation(geometry, contentOffset)
  const n = bars.length
  const inspecting = inspected !== null || inspectedBar !== undefined
  const active = inspectedBar ?? bars[inspected ?? n - 1]
  const { width, height, endHour, intervalMS, gutter, x, candleHigh, candleLow, highIndex, lowIndex,
    priceY, bollBands } = geometry
  const { panels, columns, axisStarts, right } = geometry.layout
  const contentClip = chartContentClip(geometry.layout, height)
  const tag = { price: liveBar.close, rising: liveBar.close >= liveBar.open, inViewport: presentation.base !== null && geometry.priceAxis.base !== null && Number.isFinite(liveBar.close) && liveBar.hour <= endHour + (liveOverlay ? intervalMS : 0) }
  const latestY = tag.inViewport ? priceY(tag.price) : panels.price[0]
  const priceInViewport = tag.inViewport && chartPriceInPanel(latestY, panels.price)
  const latestColor = tag.rising ? "var(--positive)" : "var(--negative)"
  const latestPrice = formatCandleChange(liveBar.open, tag.price)
  const priceDirection = candleChangeDirection(liveBar.open, tag.price)
  const priceLabelBackground = priceDirection === 'up' ? 'var(--positive)' : priceDirection === 'down' ? 'var(--negative)' : 'var(--chart-annotation)'
  const priceLabelForeground = 'white'
  const priceLabel = chartPriceLabelLayout(latestY, panels.price, chartTokens.textSize, chartTokens.priceLabelPaddingY, liveOverlay)
  // Match the actual plotted series snapshot, including historical navigation;
  // never fill a missing value with a previous candle's indicator.
  const indicatorBar = chartVisibleLastBar(geometry, contentOffset)
  const bollLabelSpecs = [
    { field: 'bollUpper', name: 'Upper', color: 'var(--chart-boll-upper)' },
    { field: 'bollMiddle', name: 'Middle', color: 'var(--chart-boll-middle)' },
    { field: 'bollLower', name: 'Lower', color: 'var(--chart-boll-lower)' },
  ] as const
  const bollCandidates = !showBollingerPriceLabels || presentation.base === null || !indicatorBar || !(indicatorBar.open > 0) ? [] : bollLabelSpecs.flatMap(spec => {
    const value = indicatorBar[spec.field]
    if (value === null || !Number.isFinite(value)) return []
    const y = priceY(value)
    if (!chartPriceInPanel(y, panels.price)) return []
    return [{ ...spec, value, y, label: formatCandleChange(indicatorBar.open, value) }]
  })
  const bollLabels = chartIndicatorLabelLayout(bollCandidates, panels.price,
    chartTokens.textSize + chartTokens.priceLabelPaddingY * 2,
    priceInViewport ? [priceLabel.top, priceLabel.bottom] : undefined)
  const inspectionX = x[0] + (active.hour - bars[0].hour) / intervalMS * geometry.barPitch
  const inspectedTime = inspecting ? time(active.hour) : null
  const inspectedTimeWidth = inspectedTime ? chartTextWidth(inspectedTime) + chartTokens.annotationPadding : 0
  const inspectedTimeX = !inspecting ? 0 : Math.max(columns.price[0], Math.min(right - inspectedTimeWidth, inspectionX + contentOffset - inspectedTimeWidth / 2))
  const lineLabel = (x: number, y: number, label: string, color = "var(--muted-foreground)") =>
    <text x={x} y={y} dominantBaseline="middle" fill={color}>{label}</text>
  const panelKeys = ['price'] as const
  // The panel and time-axis dividers span the whole viewport. Drawing both
  // edges of each plot would frame the data separately from its axes.
  const dividers = panelKeys.map(key => <line key={key} data-chart-panel-divider={key}
    x1={0} x2={width} y1={panels[key][1]} y2={panels[key][1]} stroke="var(--border)" opacity="0.55" />)
  const timeTickStep = chartTimeTickStep(geometry.barPitch, chartTextWidth('00:00', chartTokens.textSize, 700), chartTokens.annotationSmall)
  const timeAtX = (position: number) => bars[0].hour + (position - x[0] - contentOffset) / geometry.barPitch * intervalMS
  const timeTicks = chartTimeTicks(timeAtX(0), timeAtX(right), intervalMS, timeTickStep)
    .map(hour => ({ hour, x: x[0] + (hour - bars[0].hour) / intervalMS * geometry.barPitch }))
  const timeLabels = chartTimeLabels(timeTicks.map(tick => ({ ...tick, x: tick.x + contentOffset })), 0, right, chartTokens.annotationSmall,
    (label, major) => chartTextWidth(label, chartTokens.textSize, major ? 700 : 400)).filter(tick => {
    return !inspectedTime || tick.right < inspectedTimeX - chartTokens.annotationXs || tick.left > inspectedTimeX + inspectedTimeWidth + chartTokens.annotationXs
  })
  return <>
    <defs>
      <clipPath id={`${areaClipId}-content`}><rect {...contentClip} /></clipPath>
      <clipPath id={`${areaClipId}-price-axis`}><rect x={0} y={panels.price[0]} width={width} height={Math.max(0, panels.price[1] - panels.price[0])} /></clipPath>
      <clipPath id={`${areaClipId}-time-axis`}><rect x={0} y={panels[panelKeys.at(-1)!][1]} width={width} height={height - panels[panelKeys.at(-1)!][1]} /></clipPath>
      {panelKeys.map(key => <clipPath key={key} id={`${areaClipId}-${key}`}><rect {...chartPanelClip(geometry.layout, key, geometry.barPitch)} /></clipPath>)}
    </defs>
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
      <g clipPath={`url(#${areaClipId}-price)`} visibility={presentation.base !== null && presentation.geometryBase !== null ? "visible" : "hidden"}>{bollBands.map((d, index) => <path key={index} data-chart-boll-band d={d} fill="var(--chart-boll-middle)" fillOpacity="0.05" />)}</g>
      </g>
    </g>
    {dividers}
    <g clipPath={`url(#${areaClipId}-content)`}>
      <g transform={`translate(${contentOffset},0)`} data-chart-wheel-content data-chart-wheel-offset={contentOffset}>
    {timeTicks.flatMap(tick => panelKeys.map(key => <line key={`${tick.hour}-${key}`} x1={tick.x} x2={tick.x} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--border)" strokeOpacity="0.22" />))}
    <PlotPaths bars={bars} geometry={geometry} areaClipId={areaClipId} priceVisible={presentation.base !== null && presentation.geometryBase !== null} />
    {inspecting && panelKeys.map(key => <line key={key} x1={inspectionX} x2={inspectionX} y1={panels[key][0]} y2={panels[key][1]} stroke="var(--foreground)" strokeDasharray="3 5" opacity="0.3" />)}
    <g clipPath={`url(#${areaClipId}-price)`}>
    {presentation.base !== null && geometry.priceAxis.base !== null && ([[highIndex, candleHigh, "high"], [lowIndex, candleLow, "low"]] as const).map(([index, value, kind]) => {
      if (!Number.isFinite(value)) return null
      const markerX = x[index], label = formatHistoricalPrice(value)
      const labelWidth = chartTextWidth(label) + 8
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
      {timeLabels.map(tick => <text data-chart-time-label key={tick.hour} x={tick.x} y={height - 6} textAnchor={tick.anchor} fill={tick.major ? 'var(--foreground)' : 'var(--muted-foreground)'} fontWeight={tick.major ? 700 : 400}>{tick.label}</text>)}
    </g>
    {inspectedTime && <g data-chart-inspected-time><rect x={inspectedTimeX} y={height - chartTokenNumber('--chart-bottom-axis-height')} width={inspectedTimeWidth} height={chartTokenNumber('--chart-bottom-axis-height') - 1} rx={3} fill="var(--chart-annotation)" /><text x={inspectedTimeX + inspectedTimeWidth / 2} y={height - 6} textAnchor="middle" fill="var(--foreground)">{inspectedTime}</text></g>}
    {priceInViewport && <line data-chart-live-price x1={columns.price[0]} x2={right} y1={latestY} y2={latestY} stroke={latestColor} strokeDasharray="4 5" />}
    <g clipPath={`url(#${areaClipId}-price-axis)`} data-chart-price-axis>
    {presentation.ticks.map(({ y, label }, index) => {
      const value = Number.parseFloat(label.replaceAll(',', ''))
      const major = Number.isFinite(value) && Math.abs(value / 10 - Math.round(value / 10)) < 1e-8
      return <g key={index} data-chart-price-tick><line x1={columns.price[0]} x2={right} y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.35" />
        <text data-chart-price-tick-label x={axisStarts.price} y={y} textAnchor="start" dominantBaseline="middle" fill={major ? 'var(--foreground)' : 'var(--muted-foreground)'} fontWeight={major ? 700 : 400}>{label}</text>
      </g>
    })}
    </g>
    {bollLabels.map(({ field, name, color, y, labelY, top, bottom, value, label }) => <g key={field} data-chart-boll-label={field} data-chart-boll-price={value} data-chart-boll-hour={indicatorBar?.hour}>
      <title>{`Bollinger ${name}: ${label} from candle open`}</title>
      {Math.abs(y - labelY) > 0.5 && <path d={`M ${right - 8} ${y} L ${right} ${labelY}`} fill="none" stroke={color} />}
      <rect x={right} y={top} width={gutter} height={bottom - top} fill={color} />
      <text x={axisStarts.price} y={labelY} dominantBaseline="middle" fill="white">{label}</text>
    </g>)}
    {priceInViewport && <g data-chart-price-label data-chart-price-direction={priceDirection}>
      <title>{`Change from candle open ${latestPrice} · ${priceDirection === 'flat' ? 'unchanged' : priceDirection} · ${liveOverlay ? 'Forming candle' : 'Candle'}`}</title>
      <rect data-chart-price-label-background x={right} y={priceLabel.top} width={gutter} height={priceLabel.bottom - priceLabel.top} fill={priceLabelBackground} />
      <text data-chart-price-label-value x={axisStarts.price} y={priceLabel.labelY} dominantBaseline="middle" fill={priceLabelForeground}>{latestPrice}</text>
      {priceLabel.countdownY !== null && <PriceCountdown hour={liveBar.hour} intervalMS={intervalMS} x={axisStarts.price} y={priceLabel.countdownY} fill={priceLabelForeground} />}
    </g>}
    <line x1={right} x2={right} y1={panels.price[0]} y2={panels.price[1]} stroke="var(--border)" opacity="0.8" />
  </>
  })
})

type PlotSize = { width: number; height: number }

const ChartSurface = memo(function ChartSurface({ instId, timeframe, hasCompletedBars, priceState, indicatorState, oiState, takerState,
  liveBar, plot, size, selected, visible, showBollingerPriceLabels, inspected, inspectedBar, wheelFraction, readoutId }: {
  instId: string; timeframe: RadarTimeframe; hasCompletedBars: boolean; priceState?: PreparedChartState; indicatorState: PreparedChartState
  oiState: PreparedChartState; takerState: PreparedChartState
  liveBar?: Bar; plot: NonNullable<ReturnType<typeof chartPlot>>; size: PlotSize; selected: boolean; visible: boolean; showBollingerPriceLabels: boolean; inspected: number | null
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
      aria-label={`${instId} ${bars.length}-candle ${timeframeLabel(timeframe)} chart. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window end. Escape clears inspection. Scroll to review history. Pinch the trackpad to zoom around the pointer. Arrow keys navigate markets.`}>
      <Plot bars={bars} geometry={geometry} liveBar={liveBar ?? bars.at(-1)!} liveOverlay={!!liveBar} showBollingerPriceLabels={showBollingerPriceLabels} contentOffset={contentOffset}
        inspected={selected ? inspected : null} inspectedBar={selected ? inspectedBar : undefined} />
    </svg>
  </PlotVisible>
})

export const MarketChart = memo(function MarketChart({ instId, tickSz, timeframe = '15m', active: isActive = true, listOrder, turnoverOrder, onSelect, controller: chartController = defaultChartController, showBollingerPriceLabels = false, navigation = true, onStatus }: { controller?: ChartController; showBollingerPriceLabels?: boolean; navigation?: boolean; onStatus?: (timeframe: RadarTimeframe, value: SharedChartStatusValue | null) => void; instId: string; tickSz?: string | null; timeframe?: RadarTimeframe; active?: boolean; listOrder: string[]; turnoverOrder: string[]; onSelect: (id: string) => void }) {
  const sync = useContext(ChartTimeSync)
  const presentation = usePresentation()
  const readoutId = useId()
  const windowVisible = usePresentedStore(subscribeVisibility, documentVisible)
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
  const [wheelFraction, setWheelFraction] = useState(0)
  const [wheelOwner, setWheelOwner] = useState<{ session: object; instId: string; timeframe: RadarTimeframe; generation: number } | null>(null)
  const wheelOwnerRef = useRef<typeof wheelOwner>(null)
  const wheelOwnerMatches = Boolean(wheelOwner?.session === wheelSession && wheelOwner.generation === surface?.generation)
  const requestedEndMatches = Boolean(surface && view.requested && view.requested.instId === surface.instId
    && view.requested.timeframe === surface.timeframe && (view.requested.end ?? view.latestEnd) === surface.endHour)
  const activeWheelFraction = matchesSelection && wheelOwnerMatches
    ? chartPresentedWheelFraction(wheelFraction, view.pending && !requestedEndMatches ? requestedEnd : surface?.endHour, surface?.endHour, intervalMS) : 0
  const overscan = chartOverscan(surface, chartController)
  const preparedPlot = chartPlot(displayedIndicators.window, plotSize, overscan, currentPriceTickSz, viewport, activeWheelFraction)
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
    const spacing = plotGeometry.barPitch
    const end = live ? sharedChartLiveEnd(last, intervalMS, Math.max(last, Math.min(surface.priceObservedAt ?? now, last + intervalMS)), spacing)
      : nearNow ? now : plotGeometry.endHour + intervalMS * 0.34
    sync.setValue(current => current ?? { end, spacing, follow: true, liveEnd: end, observedAt: now, advancing: false, oldest: 0 })
  }, [sync, timeframe, surface, matchesSelection, plotGeometry, intervalMS])
  useLayoutEffect(() => {
    if (!sync?.value || !matchesSelection || !surface?.liveBar || !surface.priceObservedAt) return
    const last = surface.liveBar.hour
    const observed = sharedChartLiveEnd(last, intervalMS, Math.max(last, Math.min(surface.priceObservedAt, last + intervalMS)), sync.value.spacing)
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
  const wheelContentOffset = chartWheelContentOffset(activeWheelFraction, plotGeometry?.barPitch ?? 0,
    Boolean(preparedPlot?.before), Boolean(preparedPlot?.after))
  // Do not include the measured geometry or shared gutter in this epoch:
  // both change as the shared width converges. New market data, navigation,
  // fractional scrolling, and size changes invalidate the measurement.
  const gutterEpoch = useMemo(() => ({ window: displayedIndicators.window, sync: sync?.value, fraction: activeWheelFraction, width: plotSize.width, height: plotSize.height, instId, timeframe, showBollingerPriceLabels }), [displayedIndicators.window, sync?.value, activeWheelFraction, plotSize.width, plotSize.height, instId, timeframe, showBollingerPriceLabels])
  const reportGutter = sync?.reportGutter
  useLayoutEffect(() => {
    if (!reportGutter) return
    if (!plotGeometry || !matchesSelection || !bars.length) { reportGutter(timeframe, null, null); return }
    const ticks = chartPricePresentation(plotGeometry, wheelContentOffset).ticks.map(tick => tick.label)
    const quote = surface?.liveBar && surface.liveBar.hour <= plotGeometry.endHour + intervalMS * 0.34 ? surface.liveBar : bars.at(-1)!
    const change = formatCandleChange(quote.open, quote.close)
    const indicatorBar = chartVisibleLastBar(plotGeometry, wheelContentOffset)
    const boll = showBollingerPriceLabels && indicatorBar ? (['bollUpper', 'bollMiddle', 'bollLower'] as const).map(field => {
      const value = indicatorBar[field]
      return value !== null && Number.isFinite(value) ? formatCandleChange(indicatorBar.open, value) : ''
    }) : []
    // PriceCountdown can exceed two minute digits for future-dated candles.
    const seconds = Math.max(0, Math.floor((quote.hour + intervalMS - Date.now()) / 1000))
    const minutes = Math.max(Math.ceil(intervalMS / 60_000), Math.floor(seconds / 60))
    const countdown = `${String(minutes).padStart(2, '0')}:00`
    reportGutter(timeframe, gutterEpoch, Math.ceil(Math.max(...[...ticks, change, countdown, ...boll].map(legendWidth)) + 16))
  }, [reportGutter, timeframe, gutterEpoch, plotGeometry, wheelContentOffset, matchesSelection, bars, surface?.liveBar, intervalMS, showBollingerPriceLabels])
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
  if (atBoundary && !pending) statusMessages.push('Start of available history')
  if (!statusMessages.length && error) statusMessages.push('Chart update failed')
  if (historical && !inspectedBar && active) statusMessages.push(`Window end ${time(active.hour)}`)
  if (priceScale === 'unavailable' && surface) statusMessages.push('Price scale unavailable')
  const statusLoading = !error && ((pending) || priceState === 'loading' || priceState === 'partial' || priceState === 'stale')
    || surface?.indicatorState === 'loading'
  const statusSummary = statusMessages.join(' · ')
  const sharedError = [
    error ? 'Chart update failed. Check the data service and try again.' : '',
    priceState === 'error' ? 'Price history could not be loaded. Check the market connection and data service.' : '',
    surface?.indicatorState === 'error' ? 'Indicators could not be calculated. Check the data service.' : '',
  ].filter(Boolean).join(' · ')
  const inspectionReadout = active && <div id={readoutId} data-chart-inspection-readout hidden={inspectedBar === undefined} aria-live="off" className='pointer-events-none absolute left-0 right-0 top-0 z-10 flex flex-wrap gap-x-3 bg-background/90 px-4 text-xs'>
    <p className="min-w-0 truncate" data-chart-inspected-hour={inspectedBar?.hour}><span className="text-muted-foreground">{inspectedBar === undefined ? historical ? 'Window end' : 'Latest' : 'Selected'}</span> {time(active.hour)}</p>
    {([['Open', active.open], ['High', active.high], ['Low', active.low], ['Close', active.close]] as const).map(([label, value]) => {
      const text = label === 'Close' && active === surface?.liveBar ? formatCurrentPrice(value, currentPriceTickSz) : formatHistoricalPrice(value)
      return <div key={label} data-chart-ohlc={label.toLowerCase()} className="min-w-0"><span className="text-muted-foreground">{label} </span><span title={text}>{text}</span></div>
    })}
    {inspectedBar && priceOverlays.map(({ label, value }) => <div key={label} data-chart-inspection-indicator={label}>
      <span className="text-muted-foreground">{label} </span><span data-chart-legend-value title={value(inspectedBar)}>{value(inspectedBar, true)}</span>
    </div>)}
  </div>
  return <section data-chart-workspace aria-label="Market chart workspace" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden overscroll-none text-sm font-normal tabular-nums">
    {onStatus && <SharedChartStatus timeframe={timeframe} summary={sharedError ? '' : statusSummary} error={sharedError} warning={priceState === 'stale' || priceState === 'partial' || priceState === 'unavailable' || surface?.indicatorState === 'unavailable'} loading={statusLoading} observedAt={surface?.priceObservedAt} realtime={surface?.realtimeState} active={windowVisible && presentation.active} historical={historical} onStatus={onStatus} />}
    <div className="flex min-h-0 flex-1">
    <section ref={chartRef} data-chart-inst={displayedId} data-chart-indicator-state={surface?.indicatorState} data-chart-indicator-stale={displayedIndicators.stale} data-chart-indicator-input={surface?.indicatorStatus?.inputVersion} data-chart-time-end={plotGeometry ? plotGeometry.endHour + intervalMS * 0.34 - wheelContentOffset / plotGeometry.barPitch * intervalMS : undefined} data-chart-time-start={plotGeometry ? plotGeometry.endHour + intervalMS * 0.34 - (plotGeometry.layout.right - plotGeometry.layout.left + wheelContentOffset) / plotGeometry.barPitch * intervalMS : undefined} data-chart-start={bars[0]?.hour} data-chart-end={bars.at(-1)?.hour} data-chart-completed-end={surface?.endHour} data-chart-cache-start={view.oldestHour ?? undefined} data-chart-requested-end={requestedEnd ?? undefined} data-chart-rendered-bars={bars.length} data-chart-target-bars={surface?.windowBars ?? 96} data-chart-visible-bars={visibleBars} data-chart-bar-spacing={viewport.spacing} data-chart-visual-stale={surface && !matchesSelection ? 'true' : 'false'} data-chart-candle-state={priceState} data-chart-statistics-state={surface?.oiState === 'error' || surface?.takerState === 'error' ? 'error' : surface?.oiState === 'loading' || surface?.takerState === 'loading' ? 'loading' : surface?.oiState === 'unavailable' || surface?.takerState === 'unavailable' ? 'unavailable' : surface ? 'ready' : 'loading'} data-chart-statistics-end={surface?.endHour} data-chart-oi-state={oiState} data-chart-taker-state={takerState} data-chart-oi-samples={bars.filter(bar => bar.oi !== null).length} data-chart-taker-samples={bars.filter(bar => bar.buy !== null && bar.sell !== null).length} data-chart-incomplete={priceState !== 'ready' || surface?.indicatorState !== 'ready' || oiState !== 'ready' || takerState !== 'ready' ? 'true' : 'false'} data-chart-loading={pending ? 'true' : 'false'} aria-label={`${displayedId} chart`} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {inspectionReadout}
      <div ref={plotRef} data-chart-plot tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden outline-none" onKeyDown={event => {
        if (event.key === 'Escape') { endInspection(); return }
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
        if (!held || !matchesSelection || held.pointerId !== event.pointerId) return
        if (!(event.buttons & 1)) { endInspection(); return }
        inspectAt(held.target, event.clientX)
      }} onWheel={event => {
        const intent = chartWheelIntent(event)
        if (intent.kind === 'zoom') queueZoom(intent.pixels, event.clientX)
        else queueWheel(intent.pixels)
      }}>
        {surface && preparedPlot && <ChartSurface instId={surface.instId} timeframe={surface.timeframe} hasCompletedBars={surface.bars.length > 0}
          priceState={surface.priceState} indicatorState={surface.indicatorState} oiState={surface.oiState} takerState={surface.takerState}
          liveBar={liveBar} plot={preparedPlot} size={plotSize}
          selected={matchesSelection} visible={matchesSelection && isActive && windowVisible && presentation.active} showBollingerPriceLabels={showBollingerPriceLabels} inspected={inspected} inspectedBar={inspectedBar} wheelFraction={activeWheelFraction} readoutId={readoutId} />}
      </div>
    </section>
    </div>
  </section>
})
