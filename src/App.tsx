import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowDownUp, ArrowUp, Radio, Search, Settings2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn, pageVisible } from "@/lib/utils"
import { compareMarketRows, compareMarketTurnover, defaultSortDescending, type SortKey } from "@/market-sort"
import { PERCENT_CHANGE_DESCRIPTION, formatPercent, percentageNumber, type PercentageValue } from "@/market-percent"
import { BREAK_DESCRIPTION, describeBreak, formatBreakPriorAge, formatBreakTime, type BreakDirection, type BreakResult } from "@/market-breaks"
import { BANDWIDTH_EXPANSION_DESCRIPTION, LOG_BB_DESCRIPTION, formatBandWidthExpansion, formatLiveBand } from "@/market-logbb"
import { MarketChart } from "@/MarketChart"
import { chartController } from '@/chart-controller'
import type { PreparedChartResponse } from '@/chart-data'
import { OPPORTUNITY_DESCRIPTION } from "@/market-opportunity"
import { MarketOpportunity } from "@/MarketOpportunity"
import { MarketListViewport } from "@/MarketListViewport"
import { MarketRowsViewport } from "@/MarketRowsViewport"
import { reconcileMarketRows } from "@/market-snapshot"
import { SnapshotOrder } from "@/snapshot-order"
import type { NativeMarketRow } from "@/market-row"
import { AnalysisSettingsButton } from '@/AnalysisSettingsDialog'
import type { AnalysisSettings, AnalysisSettingsRequest } from '@/chart-analysis'
import type { ChartCaptureBounds, ChartImage } from '@/chart-capture'
import { BlurControls } from '@/BlurSettings'
import { initialBlurSettings, useBlurSettings, withSettingsDeadline, type BlurSettings } from '@/blur-settings'
import { RADAR_TIMEFRAMES, timeframeLabel, type RadarTimeframe } from '@/timeframe'

type WindowAppearance = BlurSettings & { frostedBackgroundEnabled: boolean; frostedBackgroundOpacity: number }
type LiquiditySettings = { hourlyVolumeStabilityEnabled: boolean }
type ListProgress = { total: number; completed: number; pending: number; retrying: number; unavailable: number }
type Snapshot = WindowAppearance & LiquiditySettings & { rows: NativeMarketRow[]; updatedAt: number | null; error: string; revision: number; loading?: boolean; listProgress?: ListProgress; catalogSource?: 'none' | 'cache' | 'live'; serviceSession?: string; timeframe?: RadarTimeframe; intervalMS?: number; }
type UnchangedSnapshot = { unchanged: true; revision: number; error: string; serviceSession?: string }
type SettingRequest = Partial<WindowAppearance & LiquiditySettings>
type NativeBridge = {
  postMessage(request: { analysisSettings: AnalysisSettingsRequest }): Promise<AnalysisSettings>
  postMessage(request: { gatewayFetch: { id: string; body: string } }): Promise<{ status: number; headers: Record<string, string> }>
  postMessage(request: { cancelGatewayFetch: string }): Promise<{ ok: boolean }>
  postMessage(request: { copyText: string }): Promise<{ ok: boolean }>
  postMessage(request: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  postMessage(request: { rocPeriod: number; marocPeriod: number; timeframe?: RadarTimeframe; sinceRevision: number; serviceSession?: string }): Promise<Snapshot | UnchangedSnapshot>
  postMessage(request: SettingRequest): Promise<Snapshot>
  postMessage(request: { captureChart: { x: number; y: number; width: number; height: number; backgroundRGB: number[] } }): Promise<{ ok: boolean }>
  postMessage(request: { windowTintRGB: number[] }): Promise<{ ok: boolean }>
  postMessage(request: { previewWindowBlur: number | null }): Promise<{ ok: boolean }>
  postMessage(request: { chartWindow: { instId: string; timeframe: RadarTimeframe; endHour?: number } }): Promise<PreparedChartResponse>
  postMessage(request: { chartLocal: { instId: string; timeframe: RadarTimeframe } }): Promise<PreparedChartResponse | null>
  postMessage(request: { chartUniverse: { instIds: string[]; timeframe: RadarTimeframe; focusInstId?: string } }): Promise<{ frames: PreparedChartResponse[] }>
}
declare global {
  interface Window { radarAppearance?: WindowAppearance & { nativeWindowBackground?: boolean }; webkit: { messageHandlers: { radar: NativeBridge } } }
}
const ROC_PERIOD = 9
const MAROC_PERIOD = 9
const formatIndicator = (value: number | null) => value === null ? "—" : value.toFixed(2)
const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 })
const turnoverFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })
const formatPrice = (value: number | null) => value === null ? "—" : priceFormatter.format(value)
const listCollectorStatus = (snapshot: Pick<Snapshot, "loading" | "listProgress" | "catalogSource">) => {
  const progress = snapshot.listProgress
  const cached = snapshot.catalogSource === 'cache'
  if (progress && progress.total > 0 && progress.completed < progress.total) {
    const work = progress.retrying || progress.unavailable ? `Retrying ${progress.completed}/${progress.total}` : `Loading ${progress.completed}/${progress.total}`
    return cached ? `Cached · ${work}` : work
  }
  if (snapshot.loading) return cached ? "Cached · Refreshing" : "Refreshing"
  return cached ? "Cached" : "Live"
}
const directionClass = (value: PercentageValue) => {
  const number = percentageNumber(value)
  return number === null ? "text-muted-foreground" : number > 0 ? "text-positive" : number < 0 ? "text-destructive" : ""
}
const rsiClass = (value: number | null) => value === null ? "text-muted-foreground" : value > 70 ? "text-positive" : value < 30 ? "text-destructive" : ""
const RSI_PERIODS = [6, 12, 24] as const
const indicatorFormula = (name: string, period: number) => <span data-header-formula="html" className="text-xs font-medium text-foreground" aria-hidden="true">{name}<sub>{period}</sub>{name === 'RSI' ? '' : ' (%)'}</span>
const takerImbalanceFormula = <span data-header-formula="html" className="inline-flex items-center gap-1 text-xs font-medium text-foreground" aria-hidden="true">
  <span className="inline-flex flex-col items-center leading-none">
    <span className="border-b border-current px-0.5 pb-0.5">Buy<sub>t</sub> − Sell<sub>t</sub></span>
    <span className="px-0.5 pt-0.5">Buy<sub>t</sub> + Sell<sub>t</sub></span>
  </span>
  <span>× 100%</span>
</span>

function BreakReadings({ result, direction, timeframe }: { result: BreakResult; direction: BreakDirection; timeframe: RadarTimeframe }) {
  const description = describeBreak(result, direction, timeframe)
  const hasEvent = result.status === "event"
  return <Fragment>
    <span className={cn("inline-flex items-baseline justify-end gap-1", hasEvent ? direction === "high" ? "text-positive" : "text-destructive" : "text-muted-foreground")} title={description}>
      <span className="sr-only">{direction === "high" ? "High breakout" : "Low breakdown"} </span>
      {hasEvent && <span aria-hidden="true">{direction === "high" ? "↑" : "↓"}</span>}
      {(hasEvent && result.live) || result.status === "loading" ? <Badge variant={result.status === "loading" ? "outline" : "secondary"}>{formatBreakTime(result, timeframe)}</Badge> : formatBreakTime(result, timeframe)}
    </span>
    <span className="text-xs text-muted-foreground" title={description}>
      <span className="sr-only">Previous {direction === "high" ? "high" : "low"} age at the break </span>{formatBreakPriorAge(result, timeframe)}
    </span>
  </Fragment>
}

const MarketRowView = memo(function MarketRowView({ row, index, onSelect, timeframe }: { row: NativeMarketRow; index: number; onSelect: (id: string) => void; timeframe: RadarTimeframe }) {
  return <TableRow data-market-index={index} aria-rowindex={index + 2} interactive tabIndex={0} aria-label={`View ${row.instId} chart`} onClick={() => onSelect(row.instId)} onKeyDown={event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.instId) }
  }}>
    <TableCell className="pl-[var(--market-table-leading-inset)] text-left" title={row.instId}>
      <span className="font-medium">{row.instId.replace(/-USDT-SWAP$/, "")}</span>
      <div className="flex justify-start gap-2 text-xs tabular-nums">
        <span title={`Latest traded price; ${timeframeLabel(timeframe)} indicators use the locally aggregated candle close`}>{formatPrice(row.lastPrice ?? row.price)}</span>
        <span className={directionClass(row.priceChange)} title={`${timeframeLabel(timeframe)} candle close change from the previous completed candle. ${PERCENT_CHANGE_DESCRIPTION}`}>{formatPercent(row.priceChange)}</span>
      </div>
      <div className="flex items-center justify-start gap-3 text-xs tabular-nums">
        <span className="flex gap-1"><span className="text-muted-foreground">Low</span><span>{formatPrice(row.currentLow)}</span></span>
        <span className="flex gap-1"><span className="text-muted-foreground">High</span><span>{formatPrice(row.currentHigh)}</span></span>
      </div>
      <div className="flex items-center justify-start gap-1 text-xs tabular-nums" title={row.turnover24hUSDT === null ? "Estimated 24h turnover is unavailable" : `${row.turnover24hUSDT.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT · 24h base volume × latest price estimate`}>
        <span className="text-muted-foreground">Est. turnover</span><span>{row.turnover24hUSDT === null ? "—" : turnoverFormatter.format(row.turnover24hUSDT)} USDT</span>
      </div>
    </TableCell>
    <TableCell className="text-center tabular-nums"><MarketOpportunity instId={row.instId} opportunity={row.opportunity} /></TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="mx-auto grid w-max grid-cols-[max-content_max-content] items-baseline gap-x-3 text-right">
        <BreakReadings result={row.highBreakout} direction="high" timeframe={timeframe} />
        <BreakReadings result={row.lowBreakdown} direction="low" timeframe={timeframe} />
      </div>
    </TableCell>
    <TableCell className={cn("text-center tabular-nums", directionClass(row.takerRatio))} title={row.buy !== null && row.sell !== null ? `Taker contracts · Buy ${row.buy.toLocaleString("en-US")} / Sell ${row.sell.toLocaleString("en-US")} · Imbalance (Buy − Sell) / (Buy + Sell), not Buy / Sell` : "Loading taker contract volume"}>{formatPercent(row.takerRatio)}</TableCell>
    <TableCell className={cn("text-center tabular-nums", directionClass(row.oiChange))}>{formatPercent(row.oiChange)}</TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="mx-auto grid w-max grid-cols-[max-content_max-content] gap-x-3 text-right">
        <span className={directionClass(row.roc)}><span className="sr-only">ROC </span>{formatPercent(row.roc)}</span>
        <span className={directionClass(row.rocChange)} title={`One-candle ROC change. ${PERCENT_CHANGE_DESCRIPTION}`}><span className="sr-only">ROC candle change </span>{formatPercent(row.rocChange)}</span>
        <span className={directionClass(row.maroc)}><span className="sr-only">MAROC </span>{formatPercent(row.maroc)}</span>
        <span className={directionClass(row.marocChange)} title={`One-candle MAROC change. ${PERCENT_CHANGE_DESCRIPTION}`}><span className="sr-only">MAROC candle change </span>{formatPercent(row.marocChange)}</span>
      </div>
    </TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="flex flex-col items-center text-xs">
        {RSI_PERIODS.map(period => <div key={period} className="flex gap-1"><span className="text-muted-foreground">{period}</span><span className={rsiClass(row[`rsi${period}`])}>{formatIndicator(row[`rsi${period}`])}</span></div>)}
      </div>
    </TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="flex flex-col items-center text-xs">
        <div className="flex gap-1" title={LOG_BB_DESCRIPTION}><span className="text-muted-foreground">Live</span><span className={cn(row.logBBAboveBand === null ? "text-muted-foreground" : row.logBBAboveBand === "below" ? "text-destructive" : "text-positive")}>{formatLiveBand(row.logBBAboveBand)}</span></div>
        <div className="flex gap-1" title={BANDWIDTH_EXPANSION_DESCRIPTION}><span className="text-muted-foreground">Expansion</span><span className={cn(row.logBBExpansion && row.logBBExpansion.hours > 0 ? "text-positive" : "text-muted-foreground")}>{formatBandWidthExpansion(row.logBBExpansion, timeframe)}</span></div>
      </div>
    </TableCell>
  </TableRow>
})
const MarketRows = memo(function MarketRows({ rows, onSelect, timeframe }: { rows: NativeMarketRow[]; onSelect: (id: string) => void; timeframe: RadarTimeframe }) {
  return <MarketRowsViewport ids={rows.map(row => row.instId)}>{index => <MarketRowView row={rows[index]} index={index} onSelect={onSelect} timeframe={timeframe} />}</MarketRowsViewport>
})

function App() {
  useEffect(() => {
    const receive = (event: Event) => chartController.ingestPrepared((event as CustomEvent<PreparedChartResponse>).detail)
    window.addEventListener('radar-chart-prepared', receive)
    return () => window.removeEventListener('radar-chart-prepared', receive)
  }, [])
  const revision = useRef(-1)
  const serviceSession = useRef<string | undefined>(undefined)
  const snapshotOrder = useRef(new SnapshotOrder())
  const backgroundOpacityDraftDirty = useRef(false)
  const [ready, setReady] = useState(false)
  const [timeframe, setTimeframe] = useState<RadarTimeframe>('1H')
  const timeframeRef = useRef(timeframe)
  timeframeRef.current = timeframe
  const [rows, setRows] = useState<NativeMarketRow[]>([])
  const [status, setStatus] = useState("Connecting")
  const [error, setError] = useState("")
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [frostedBackgroundEnabled, setFrostedBackgroundEnabled] = useState(window.radarAppearance?.frostedBackgroundEnabled ?? true)
  const [frostedBackgroundOpacity, setFrostedBackgroundOpacity] = useState(window.radarAppearance?.frostedBackgroundOpacity ?? 0.3)
  const [backgroundOpacityDraft, setBackgroundOpacityDraft] = useState(String(window.radarAppearance?.frostedBackgroundOpacity ?? 0.3))
  const [backgroundOpacityError, setBackgroundOpacityError] = useState("")
  const blurSettings = useBlurSettings(() => initialBlurSettings(window.radarAppearance), async request => {
    const snapshot = await withSettingsDeadline(window.webkit.messageHandlers.radar.postMessage(request))
    acceptSnapshot(snapshot)
    return snapshot
  }, radius => withSettingsDeadline(window.webkit.messageHandlers.radar.postMessage({ previewWindowBlur: radius })))
  const [liquiditySettings, setLiquiditySettings] = useState<LiquiditySettings>({ hourlyVolumeStabilityEnabled: false })
  const [sort, setSort] = useState<SortKey>("opportunity")
  const [descending, setDescending] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  useLayoutEffect(() => {
    document.documentElement.dataset.frostedBackground = String(frostedBackgroundEnabled)
    document.documentElement.dataset.translucentBackground = String(frostedBackgroundEnabled && frostedBackgroundOpacity < 1)
    document.documentElement.style.setProperty("--window-background-opacity", String(frostedBackgroundEnabled ? frostedBackgroundOpacity : 1))
    if (!window.radarAppearance?.nativeWindowBackground) return
    document.documentElement.dataset.nativeWindowBackground = "true"
    const updateTint = () => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d")!
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--window-background-tint")
      context.fillRect(0, 0, 1, 1)
      const rgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value / 255)
      void window.webkit.messageHandlers.radar.postMessage({ windowTintRGB: rgb }).catch(() => {})
    }
    const theme = window.matchMedia("(prefers-color-scheme: dark)")
    updateTint()
    theme.addEventListener("change", updateTint)
    return () => theme.removeEventListener("change", updateTint)
  }, [frostedBackgroundEnabled, frostedBackgroundOpacity])
  const acceptSnapshot = (snapshot: Snapshot) => {
    if (snapshot.timeframe && snapshot.timeframe !== timeframeRef.current) return false
    if (!snapshotOrder.current.accept(snapshot)) return false
    serviceSession.current = snapshotOrder.current.serviceSession
    revision.current = snapshotOrder.current.revision
    setRows(current => reconcileMarketRows(current, snapshot.rows))
    setFrostedBackgroundEnabled(snapshot.frostedBackgroundEnabled)
    setFrostedBackgroundOpacity(snapshot.frostedBackgroundOpacity)
    blurSettings.synchronize(initialBlurSettings(snapshot))
    setLiquiditySettings({ hourlyVolumeStabilityEnabled: snapshot.hourlyVolumeStabilityEnabled ?? false })
    if (!backgroundOpacityDraftDirty.current && document.activeElement?.id !== "background-opacity") setBackgroundOpacityDraft(String(snapshot.frostedBackgroundOpacity))
    setUpdatedAt(snapshot.updatedAt)
    setError(snapshot.error)
    setStatus(listCollectorStatus(snapshot))
    setReady(true)
    return true
  }
  useEffect(() => {
    let stopped = false
    let backoff = 2000
    const load = async () => {
      await pageVisible(); if (stopped) return
      try {
        const snapshot = await window.webkit.messageHandlers.radar.postMessage({ rocPeriod: ROC_PERIOD, marocPeriod: MAROC_PERIOD, timeframe, sinceRevision: revision.current, serviceSession: serviceSession.current })
        if (stopped) return
        if ("unchanged" in snapshot) {
          if (snapshotOrder.current.isCurrent(snapshot)) setError(snapshot.error)
          backoff = 2000
        } else {
          acceptSnapshot(snapshot)
          backoff = 2000 // Reset to fast polling on changes
        }
      } catch (cause) {
        if (stopped) return
        setError(cause instanceof Error ? cause.message : "Cannot connect to the native collector")
        setStatus("Reconnecting")
        backoff = Math.min(backoff * 2, 30000) // Slower retry on errors
      }
      if (!stopped) timer = window.setTimeout(load, backoff)
    }
    let timer: number
    void load()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [timeframe])
  const visible = useMemo(() => rows.filter(row => row.instId.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => compareMarketRows(a, b, sort, descending)), [rows, query, sort, descending])
  const listOrder = useMemo(() => visible.map(row => row.instId), [visible])
  const turnoverOrder = useMemo(() => [...rows].sort(compareMarketTurnover).map(row => row.instId), [rows])
  const chartCandidates = useMemo(() => [...new Set([...listOrder, ...turnoverOrder])], [listOrder, turnoverOrder])
  useEffect(() => {
    chartController.setUniverse(ready ? chartCandidates : [], timeframe)
  }, [ready, chartCandidates, timeframe])
  const changeSort = (key: SortKey) => {
    if (sort === key) setDescending(!descending)
    else { setSort(key); setDescending(defaultSortDescending(key)) }
  }

  const saveSetting = (request: SettingRequest) => {
    void window.webkit.messageHandlers.radar.postMessage(request)
      .then(acceptSnapshot)
      .catch(cause => setError(cause instanceof Error ? cause.message : "Cannot save setting"))
  }

  const saveBackgroundOpacity = () => {
    const value = Number(backgroundOpacityDraft)
    if (!backgroundOpacityDraft.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
      setBackgroundOpacityError("Enter a number from 0 to 1.")
      return
    }
    backgroundOpacityDraftDirty.current = false
    setBackgroundOpacityError("")
    setBackgroundOpacityDraft(String(value))
    if (value !== frostedBackgroundOpacity) saveSetting({ frostedBackgroundOpacity: value })
  }
  const header = (label: string, key: SortKey, content: ReactNode = label, description?: string) => {
    const SortIcon = sort !== key ? ArrowDownUp : descending ? ArrowDown : ArrowUp
    return <Button variant="ghost" size="xs" className={cn("h-auto min-h-(--control-height-xs) gap-1", key === "turnover24hUSDT" && "border-l-0 pl-0")} onClick={() => changeSort(key)} aria-label={`Sort by ${label}`} aria-pressed={sort === key} title={description}>
      {content}<SortIcon data-icon="inline-end" aria-hidden="true" />
    </Button>
  }

  if (selected) return <MarketChart instId={selected} timeframe={timeframe} onTimeframeChange={setTimeframe} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={setSelected} backLabel="Markets" onBack={() => setSelected(null)} />

  if (!ready) {
    return (
      <MarketListViewport>
        <main className="flex min-h-[inherit] flex-col items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg font-medium">{error || status}</p>
            {error && <p className="text-sm text-muted-foreground">The desktop data service will retry automatically.</p>}
          </div>
        </main>
      </MarketListViewport>
    )
  }

  return (
    <MarketListViewport>
    <main className="flex min-h-[inherit] flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3 whitespace-nowrap">
        <h1 className="font-semibold">Perpetual Swap Radar</h1>
        <span className="text-xs tabular-nums text-muted-foreground">{visible.length} / {rows.length} markets</span>
        <Popover onOpenChange={open => { if (!open) { if (backgroundOpacityDraftDirty.current) saveBackgroundOpacity(); blurSettings.commitAll() } }}>
          <PopoverTrigger asChild><Button variant="outline"><Settings2 data-icon="inline-start" aria-hidden="true" />Settings</Button></PopoverTrigger>
          <PopoverContent align="end">
            <PopoverHeader><PopoverTitle>Settings</PopoverTitle><PopoverDescription>Customize liquidity screening, chart analysis and the window background.</PopoverDescription></PopoverHeader>
            <FieldGroup>
              <Field><FieldLabel>AI analysis</FieldLabel><AnalysisSettingsButton /><FieldDescription>Configure the Gateway API Key and chart analysis model.</FieldDescription></Field>
              <Field><FieldLabel>Liquidity screening</FieldLabel>
                <Field orientation="horizontal"><FieldLabel htmlFor="hourly-volume-stability">Require stable hourly volume</FieldLabel><Toggle id="hourly-volume-stability" variant="outline" pressed={liquiditySettings.hourlyVolumeStabilityEnabled} onPressedChange={enabled => saveSetting({ hourlyVolumeStabilityEnabled: enabled })}>{liquiditySettings.hourlyVolumeStabilityEnabled ? 'On' : 'Off'}</Toggle></Field>
                <FieldDescription>When on, contracts need a 24-hour 1h volume max/min ratio below 2. Turn it off to screen on the remaining liquidity requirements.</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="frosted-background">Frosted background</FieldLabel>
                <Toggle id="frosted-background" variant="outline" pressed={frostedBackgroundEnabled} onPressedChange={enabled => saveSetting({ frostedBackgroundEnabled: enabled })} aria-label="Enable frosted background">{frostedBackgroundEnabled ? "On" : "Off"}</Toggle>
              </Field>
              <Field data-invalid={Boolean(backgroundOpacityError)} data-disabled={!frostedBackgroundEnabled}>
                <FieldLabel htmlFor="background-opacity">Background opacity</FieldLabel>
                <Input id="background-opacity" name="frostedBackgroundOpacity" type="number" min="0" max="1" step="0.05" inputMode="decimal" autoComplete="off" disabled={!frostedBackgroundEnabled} aria-describedby={backgroundOpacityError ? "background-opacity-description background-opacity-error" : "background-opacity-description"} aria-invalid={Boolean(backgroundOpacityError)} value={backgroundOpacityDraft} onChange={event => { backgroundOpacityDraftDirty.current = true; setBackgroundOpacityDraft(event.target.value); setBackgroundOpacityError("") }} onBlur={saveBackgroundOpacity} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} />
                <FieldDescription id="background-opacity-description">0 reveals more of the blurred desktop; 1 is solid. Text and charts stay opaque.</FieldDescription>
                {backgroundOpacityError && <FieldError id="background-opacity-error" role="alert">{backgroundOpacityError}</FieldError>}
              </Field>
              <BlurControls settings={blurSettings} windowDisabled={!frostedBackgroundEnabled || frostedBackgroundOpacity === 1} />
            </FieldGroup>
          </PopoverContent>
        </Popover>
        <div className="relative ml-auto w-64 shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search contracts" placeholder="Search contracts" value={query} onChange={event => setQuery(event.target.value)} className="pl-8" />
        </div>
        <Badge variant={status === "Live" ? "secondary" : "outline"} aria-live="polite">
          <Radio aria-hidden="true" />{status}
        </Badge>
        <span className="text-xs text-muted-foreground">{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString("en-US")}` : "Waiting for data"}</span>
      </header>
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <Field orientation="horizontal" className="w-fit"><FieldLabel>Timeframe</FieldLabel><ToggleGroup type="single" variant="outline" value={timeframe} onValueChange={value => { if (value) { revision.current = -1; setRows([]); setStatus('Loading'); setTimeframe(value as RadarTimeframe) } }} aria-label="Radar timeframe">{RADAR_TIMEFRAMES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}</ToggleGroup></Field>
      </div>
      {error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{error}</p>}
      <section id="all-markets" aria-label="Perpetual swap markets" className="flex-1 scroll-mt-4">
        <header className="border-y px-4 py-3"><h2 className="font-semibold">All markets</h2></header>
        <Table className="table-fixed" data-market-count={visible.length} data-total-market-count={rows.length} aria-rowcount={visible.length + 1}>
          <colgroup>
            <col className="w-[17%]" />
            <col className="w-[12%]" />
            <col className="w-[21%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="py-1.5 pl-[var(--market-table-leading-inset)] text-left" aria-sort={sort === "turnover24hUSDT" ? descending ? "descending" : "ascending" : "none"}>
                <div className="flex flex-col items-start">
                  {header("Turnover", "turnover24hUSDT")}
                </div>
              </TableHead>
              <TableHead className="text-center" aria-sort={sort === "opportunity" ? descending ? "descending" : "ascending" : "none"}>{header("Opportunity", "opportunity", undefined, OPPORTUNITY_DESCRIPTION)}</TableHead>
              <TableHead className="py-1.5 text-center" aria-sort={["highBreakout", "highBreakoutPriorAge", "lowBreakdown", "lowBreakdownPriorAge"].includes(sort) ? descending ? "descending" : "ascending" : "none"}>
                <div className="mx-auto grid w-max grid-cols-[max-content_max-content] items-center gap-x-3">
                  {header(`High breakout · 48 × ${timeframeLabel(timeframe)}`, "highBreakout", undefined, BREAK_DESCRIPTION)}
                  {header("High age", "highBreakoutPriorAge", undefined, "Sort by the previous high's age at the breakout, longest first. Tied highs use the most recent occurrence.")}
                  {header(`Low breakdown · 48 × ${timeframeLabel(timeframe)}`, "lowBreakdown", undefined, BREAK_DESCRIPTION)}
                  {header("Low age", "lowBreakdownPriorAge", undefined, "Sort by the previous low's age at the breakdown, longest first. Tied lows use the most recent occurrence.")}
                </div>
              </TableHead>
              <TableHead className="text-center" aria-sort={sort === "takerRatio" ? descending ? "descending" : "ascending" : "none"}>{header("Taker imbalance", "takerRatio", takerImbalanceFormula)}</TableHead>
              <TableHead className="text-center" aria-sort={sort === "oiChange" ? descending ? "descending" : "ascending" : "none"}>{header("OI Relative Change", "oiChange", undefined, timeframe === '1H' ? `Hourly change in OI contracts, unaffected by price-only changes. ${PERCENT_CHANGE_DESCRIPTION}` : 'OI change is currently available on the 1h timeframe.')}</TableHead>
              <TableHead className="py-1.5 text-center" aria-sort={sort === "roc" || sort === "maroc" ? descending ? "descending" : "ascending" : "none"}>
                <div className="flex flex-col items-center">
                  {header(`ROC ${ROC_PERIOD}`, "roc", indicatorFormula('ROC', ROC_PERIOD), `${ROC_PERIOD}-candle price change on ${timeframeLabel(timeframe)} candles. ${PERCENT_CHANGE_DESCRIPTION}`)}
                  {header(`MAROC ${MAROC_PERIOD}`, "maroc", indicatorFormula('MAROC', MAROC_PERIOD), `Mean of the latest ${MAROC_PERIOD} ${timeframeLabel(timeframe)} ROC readings, as a percentage.`)}
                </div>
              </TableHead>
              <TableHead className="py-1.5 text-center" aria-sort={sort.startsWith("rsi") ? descending ? "descending" : "ascending" : "none"}>
                <div className="flex flex-col items-center">
                  {RSI_PERIODS.map(period => <Fragment key={period}>{header(`RSI ${period}`, `rsi${period}`, indicatorFormula('RSI', period))}</Fragment>)}
                </div>
              </TableHead>
              <TableHead className="py-1.5 text-center" aria-sort={sort.startsWith("logBB") ? descending ? "descending" : "ascending" : "none"}>
                <div className="flex flex-col items-center">
                  {header("Log BB · Live", "logBBAboveBand", undefined, LOG_BB_DESCRIPTION)}
                  {header("Bandwidth expansion", "logBBExpansion", undefined, BANDWIDTH_EXPANSION_DESCRIPTION)}
                </div>
              </TableHead>
            </TableRow>
          </TableHeader>
          {visible.length ? <MarketRows rows={visible} onSelect={setSelected} timeframe={timeframe} /> : <TableBody><TableRow><TableCell colSpan={8} className="py-12">
              <Empty>
                <EmptyHeader><EmptyTitle>{rows.length ? "No matching contracts" : "Waiting for contracts"}</EmptyTitle><EmptyDescription>{rows.length ? "Try a different contract name or clear the search." : `OKX 5m source data is loading for the ${timeframeLabel(timeframe)} view.`}</EmptyDescription></EmptyHeader>
                {query && <EmptyContent><Button variant="ghost" size="sm" onClick={() => setQuery("")}>Clear search</Button></EmptyContent>}
              </Empty>
            </TableCell></TableRow></TableBody>}
        </Table>
      </section>
    </main>
    </MarketListViewport>
  )
}

export default App
