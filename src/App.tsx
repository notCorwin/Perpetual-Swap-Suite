import { Fragment, Suspense, lazy, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowDownUp, ArrowUp, Radio, Search, ScanSearch, Settings2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { RadarSignalBoard } from "@/RadarSignalBoard"
import { radarSignals, type SignalTiming } from "@/radar-signals"
import { ModeTitle } from "@/ModeTitle"
import { modeTitle, suiteSpec } from "@/suite-types"
import { useSuite } from "@/use-suite"
import { SuitePhaseBadges } from "@/SuitePhaseBadges"
import type { StrategyProfile, SuiteReading, SuiteRequest, SuiteResponse } from "@/suite-types"
import type { ResearchInputs, ResearchRequest, ResearchResponse, StudySpec } from "@/research-types"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn, pageVisible } from "@/lib/utils"
import { compareMarketRows, compareMarketTurnover, defaultSortDescending, type SortKey } from "@/market-sort"
import { PERCENT_CHANGE_DESCRIPTION, formatPercent, percentageNumber, type PercentageValue } from "@/market-percent"
import { BREAK_DESCRIPTION, describeBreak, formatBreakPriorAge, formatBreakTime, type BreakDirection, type BreakResult } from "@/market-breaks"
import { BANDWIDTH_EXPANSION_DESCRIPTION, LOG_BB_DESCRIPTION, formatBandWidthExpansion, formatLiveBand } from "@/market-logbb"
import { MarketChart, type ChartPollResponse } from "@/MarketChart"
import { OPPORTUNITY_DESCRIPTION } from "@/market-opportunity"
import { MarketOpportunity } from "@/MarketOpportunity"
import { MarketListViewport } from "@/MarketListViewport"
import { MarketRowsViewport } from "@/MarketRowsViewport"
import { StrategyRules } from "@/StrategyRules"
import { SuitePhaseExplanation } from "@/SuitePhaseExplanation"
import { FilterExplanation } from "@/FilterExplanation"
import { keepSnapshotValue, reconcileMarketRows } from "@/market-snapshot"
import { SnapshotOrder } from "@/snapshot-order"
import { emptyFilterConfig, initialEditorState, initialLibraryPreferences, parseFilterConfig, previewResponseIsCurrent, newRuleID, type CompileResponse, type ExplainResponse, type FilterConfigV2, type FilterEditorState, type FilterLibraryPreferences, type FilterMetric, type FilterTruth, type NativeMarketRow } from "@/rule-engine"
import { expressionTemplates, type ExpressionTemplate } from "@/filter-expression"
import { AnalysisSettingsButton } from '@/AnalysisSettingsDialog'
import type { AnalysisSettings, AnalysisSettingsRequest } from '@/chart-analysis'
import type { ChartCaptureBounds, ChartImage } from '@/chart-capture'
import { BlurControls } from '@/BlurSettings'
import { initialBlurSettings, useBlurSettings, withSettingsDeadline, type BlurSettings } from '@/blur-settings'

const SuiteWorkspace = lazy(() => import('@/SuiteWorkspace').then(module => ({ default: module.SuiteWorkspace })))
const Research = lazy(() => import('@/Research').then(module => ({ default: module.Research })))

type WindowAppearance = BlurSettings & { frostedBackgroundEnabled: boolean; frostedBackgroundOpacity: number }
type NotificationSettings = { backgroundMonitoringEnabled: boolean; notificationsEnabled: boolean; notificationAuthorization: "notDetermined" | "denied" | "authorized" | "quiet" | "unavailable"; notificationError: string; backgroundMonitoringError: string; monitoringPaused: boolean; launchAtLogin: "enabled" | "disabled" | "requiresApproval" | "unavailable"; launchAtLoginError: string }
type HistoryProgress = { pending: number; completed: number; error: string }
type ChartMoveSettings = { chartMoveLabelsVisible: boolean; chartMoveEfficiencyFactor: number }
type Snapshot = WindowAppearance & NotificationSettings & ChartMoveSettings & { rows: NativeMarketRow[]; updatedAt: number | null; error: string; revision: number; serviceSession?: string; filterMetricsCatalog: FilterMetric[]; filterFunctions: string[]; filterFunctionCatalog: ExpressionTemplate[]; filterLibraryPreferences: FilterLibraryPreferences; }
type PreviewSnapshot = Snapshot & { filterResults: Record<string, FilterTruth>; filterToken: string; historyProgress: HistoryProgress }
type UnchangedSnapshot = { unchanged: true; revision: number; error: string; serviceSession?: string }
type SettingRequest = Partial<WindowAppearance & ChartMoveSettings> & { backgroundMonitoringEnabled?: boolean; notificationsEnabled?: boolean; monitoringPaused?: boolean; launchAtLogin?: boolean; notificationAction?: "refresh" | "requestPermission" | "test" | "openSettings"; filterLibraryPreferencesJSON?: string }
type NativeBridge = {
  postMessage(request: { analysisSettings: AnalysisSettingsRequest }): Promise<AnalysisSettings>
  postMessage(request: { gatewayFetch: { id: string; body: string } }): Promise<{ status: number; headers: Record<string, string> }>
  postMessage(request: { cancelGatewayFetch: string }): Promise<{ ok: boolean }>
  postMessage(request: { copyText: string }): Promise<{ ok: boolean }>
  postMessage(request: { captureChart: ChartCaptureBounds & { output: 'png' } }): Promise<ChartImage>
  postMessage(request: { suite: SuiteRequest }): Promise<SuiteResponse>
  postMessage(request: { research: ResearchRequest }): Promise<ResearchResponse>
  postMessage(request: { foregroundWorkspace: "radar" | "research" }): Promise<{ ok: boolean }>
  postMessage(request: { rocPeriod: number; marocPeriod: number; sinceRevision: number; serviceSession?: string }): Promise<Snapshot | UnchangedSnapshot>
  postMessage(request: { compileMarketFilters: { filtersJSON?: string; source?: string; previousJSON?: string; suitePhase?: string } }): Promise<CompileResponse>
  postMessage(request: { previewMarketFilters: { filtersJSON: string; token: string; atClose?: boolean; strategyID?: string } }): Promise<PreviewSnapshot>
  postMessage(request: { explainMarketFilters: { instId: string; filtersJSON: string; token: string; atClose?: boolean; strategyID?: string } }): Promise<ExplainResponse>
  postMessage(request: SettingRequest): Promise<Snapshot>
  postMessage(request: { captureChart: { x: number; y: number; width: number; height: number; backgroundRGB: number[] } }): Promise<{ ok: boolean }>
  postMessage(request: { windowTintRGB: number[] }): Promise<{ ok: boolean }>
  postMessage(request: { previewWindowBlur: number | null }): Promise<{ ok: boolean }>
  postMessage(request: { chartInstId: string; loadChart?: boolean; sinceRevision?: number; chartEndHour?: number; serviceSession?: string }): Promise<ChartPollResponse>
}
declare global {
  interface Window { radarNotificationContract?: string; radarNotificationStrategy?: string; radarAppearance?: WindowAppearance & { nativeWindowBackground?: boolean }; webkit: { messageHandlers: { radar: NativeBridge } } }
}
const ROC_PERIOD = 9
const MAROC_PERIOD = 9
const formatIndicator = (value: number | null) => value === null ? "—" : value.toFixed(2)
const priceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 })
const turnoverFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })
const formatPrice = (value: number | null) => value === null ? "—" : priceFormatter.format(value)
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

function BreakReadings({ result, direction }: { result: BreakResult; direction: BreakDirection }) {
  const description = describeBreak(result, direction)
  const hasEvent = result.status === "event"
  return <Fragment>
    <span className={cn("inline-flex items-baseline justify-end gap-1", hasEvent ? direction === "high" ? "text-positive" : "text-destructive" : "text-muted-foreground")} title={description}>
      <span className="sr-only">{direction === "high" ? "High breakout" : "Low breakdown"} </span>
      {hasEvent && <span aria-hidden="true">{direction === "high" ? "↑" : "↓"}</span>}
      {(hasEvent && result.live) || result.status === "loading" ? <Badge variant={result.status === "loading" ? "outline" : "secondary"}>{formatBreakTime(result)}</Badge> : formatBreakTime(result)}
    </span>
    <span className="text-xs text-muted-foreground" title={description}>
      <span className="sr-only">Previous {direction === "high" ? "high" : "low"} age at the break </span>{formatBreakPriorAge(result)}
    </span>
  </Fragment>
}

const MarketRowView = memo(function MarketRowView({ row, index, onSelect, onExplain, canExplain, confirmed, provisional }: { canExplain: boolean; confirmed?: SuiteReading; provisional?: SuiteReading; row: NativeMarketRow; index: number; onSelect: (id: string) => void; onExplain: (id: string) => void }) {
  return <TableRow data-market-index={index} aria-rowindex={index + 2} interactive tabIndex={0} aria-label={`View ${row.instId} chart`} onClick={() => onSelect(row.instId)} onKeyDown={event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.instId) }
  }}>
    <TableCell className="pl-[var(--market-table-leading-inset)] text-left" title={row.instId}>
      <span className="font-medium">{row.instId.replace(/-USDT-SWAP$/, "")}</span>
      {(confirmed || provisional) && <SuitePhaseBadges confirmed={confirmed} provisional={provisional} />}
      <div className="flex justify-start gap-2 text-xs tabular-nums">
        <span title="Latest traded price; hourly indicators use the exchange candle close">{formatPrice(row.lastPrice ?? row.price)}</span>
        <span className={directionClass(row.priceChange)} title={`Hourly candle close change from the previous completed hour. ${PERCENT_CHANGE_DESCRIPTION}`}>{formatPercent(row.priceChange)}</span>
      </div>
      <div className="flex items-center justify-start gap-3 text-xs tabular-nums">
        <span className="flex gap-1"><span className="text-muted-foreground">Low</span><span>{formatPrice(row.currentLow)}</span></span>
        <span className="flex gap-1"><span className="text-muted-foreground">High</span><span>{formatPrice(row.currentHigh)}</span></span>
      </div>
      <div className="flex items-center justify-start gap-1 text-xs tabular-nums" title={row.turnover24hUSDT === null ? "Estimated 24h turnover is unavailable" : `${row.turnover24hUSDT.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT · 24h base volume × latest price estimate`}>
        <span className="text-muted-foreground">Est. turnover</span><span>{row.turnover24hUSDT === null ? "—" : turnoverFormatter.format(row.turnover24hUSDT)} USDT</span>
      </div>
    </TableCell>
    <TableCell className="text-center tabular-nums"><MarketOpportunity instId={row.instId} opportunity={row.opportunity} /><Button variant="ghost" size="sm" className="mt-1" aria-label={`Explain ${row.instId} rules`} disabled={!canExplain} onClick={event => { event.stopPropagation(); onExplain(row.instId) }} onKeyDown={event => event.stopPropagation()}><ScanSearch data-icon="inline-start" aria-hidden="true" />Rules</Button></TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="mx-auto grid w-max grid-cols-[max-content_max-content] items-baseline gap-x-3 text-right">
        <BreakReadings result={row.highBreakout} direction="high" />
        <BreakReadings result={row.lowBreakdown} direction="low" />
      </div>
    </TableCell>
    <TableCell className={cn("text-center tabular-nums", directionClass(row.takerRatio))} title={row.buy !== null && row.sell !== null ? `Current 1h provisional cumulative volume · Buy ${row.buy.toLocaleString("en-US")} / Sell ${row.sell.toLocaleString("en-US")} USDT · Imbalance (Buy − Sell) / (Buy + Sell), not Buy / Sell` : "Loading current-hour taker volume"}>{formatPercent(row.takerRatio)}</TableCell>
    <TableCell className={cn("text-center tabular-nums", directionClass(row.oiChange))}>{formatPercent(row.oiChange)}</TableCell>
    <TableCell className="text-center tabular-nums">
      <div className="mx-auto grid w-max grid-cols-[max-content_max-content] gap-x-3 text-right">
        <span className={directionClass(row.roc)}><span className="sr-only">ROC </span>{formatPercent(row.roc)}</span>
        <span className={directionClass(row.rocChange)} title={`Hourly ROC change. ${PERCENT_CHANGE_DESCRIPTION}`}><span className="sr-only">ROC hourly change </span>{formatPercent(row.rocChange)}</span>
        <span className={directionClass(row.maroc)}><span className="sr-only">MAROC </span>{formatPercent(row.maroc)}</span>
        <span className={directionClass(row.marocChange)} title={`Hourly MAROC change. ${PERCENT_CHANGE_DESCRIPTION}`}><span className="sr-only">MAROC hourly change </span>{formatPercent(row.marocChange)}</span>
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
        <div className="flex gap-1" title={BANDWIDTH_EXPANSION_DESCRIPTION}><span className="text-muted-foreground">Expansion</span><span className={cn(row.logBBExpansion && row.logBBExpansion.hours > 0 ? "text-positive" : "text-muted-foreground")}>{formatBandWidthExpansion(row.logBBExpansion)}</span></div>
      </div>
    </TableCell>
  </TableRow>
})
const MarketRows = memo(function MarketRows({ rows, onSelect, onExplain, canExplain, confirmed = {}, provisional = {} }: { canExplain: boolean; confirmed?: Record<string, SuiteReading>; provisional?: Record<string, SuiteReading>; rows: NativeMarketRow[]; onSelect: (id: string) => void; onExplain: (id: string) => void }) {
  return <MarketRowsViewport ids={rows.map(row => row.instId)}>{index => <MarketRowView row={rows[index]} index={index} onSelect={onSelect} onExplain={onExplain} canExplain={canExplain} confirmed={confirmed[rows[index].instId]} provisional={provisional[rows[index].instId]} />}</MarketRowsViewport>
})

function RadarApp({ active, onResearch, onDecisions, switchingMode }: { active: boolean; onResearch: (inputs: ResearchInputs, spec?: StudySpec) => void; onDecisions: (inputs: ResearchInputs, tab?: 'rules' | 'signals') => void; switchingMode: boolean }) {
  const revision = useRef(-1)
  const serviceSession = useRef<string | undefined>(undefined)
  const snapshotOrder = useRef(new SnapshotOrder())
  const backgroundOpacityDraftDirty = useRef(false)
  const compileEpoch = useRef(0)
  const previewEpoch = useRef(0)
  const [ready, setReady] = useState(false)
  const suite = useSuite('radar', active)
  const activeProfile = suite.snapshot.profiles.find(p => p.id === suite.snapshot.selectedID)
  const activeStrategyID = activeProfile?.id
  const activeProfileRef = useRef<StrategyProfile | undefined>(activeProfile)
  activeProfileRef.current = activeProfile
  const [signalTiming, setSignalTiming] = useState<SignalTiming>('both')
  const confirmedPhases = useMemo(() => Object.fromEntries((suite.snapshot.confirmed ?? []).map(r => [r.instrument,r])), [suite.snapshot.confirmed])
  const provisionalPhases = useMemo(() => Object.fromEntries((suite.snapshot.provisional ?? []).map(r => [r.instrument,r])), [suite.snapshot.provisional])
  const [listFilters, setListFilters] = useState<FilterConfigV2>(emptyFilterConfig)
  const [filterDraft, setFilterDraft] = useState<FilterConfigV2 | null>(null)
  const [editor, setEditor] = useState<FilterEditorState>(initialEditorState)
  const [compilation, setCompilation] = useState<CompileResponse & { key: string; pending: boolean }>({ key: "", pending: true, diagnostics: [] })
  const [lastValidJSON, setLastValidJSON] = useState<string | null>(null)
  const [previewJSON, setPreviewJSON] = useState<string | null>(null)
  const [previewStrategyID, setPreviewStrategyID] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, FilterTruth>>({})
  const [history, setHistory] = useState<HistoryProgress | null>(null)
  const [metrics, setMetrics] = useState<FilterMetric[]>([])
  const [functions, setFunctions] = useState<string[]>([])
  const [templates, setTemplates] = useState<ExpressionTemplate[]>(expressionTemplates)
  const [libraryPreferences, setLibraryPreferences] = useState<FilterLibraryPreferences>(initialLibraryPreferences)
  const librarySaveEpoch = useRef(0), librarySavePending = useRef(false)
  const previewPolling = useRef(false)
  const [rows, setRows] = useState<NativeMarketRow[]>([])
  const routedStrategy = useRef<string | null>(null)
  useEffect(() => {
    const openStrategy = () => {
      const id = window.radarNotificationStrategy
      if (ready && id && routedStrategy.current !== id) {
        routedStrategy.current = id
        onDecisions({ metrics, templates, functions })
      }
    }
    const notified = () => { routedStrategy.current = null; openStrategy() }
    window.addEventListener('radar-open-strategy', notified)
    openStrategy()
    return () => window.removeEventListener('radar-open-strategy', notified)
  }, [ready, metrics, templates, functions, onDecisions])
  const [status, setStatus] = useState("Connecting")
  const [error, setError] = useState("")
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [frostedBackgroundEnabled, setFrostedBackgroundEnabled] = useState(window.radarAppearance?.frostedBackgroundEnabled ?? true)
  const [frostedBackgroundOpacity, setFrostedBackgroundOpacity] = useState(window.radarAppearance?.frostedBackgroundOpacity ?? 0.3)
  const [backgroundOpacityDraft, setBackgroundOpacityDraft] = useState(String(window.radarAppearance?.frostedBackgroundOpacity ?? 0.3))
  const [backgroundOpacityError, setBackgroundOpacityError] = useState("")
  previewPolling.current = Boolean(active && lastValidJSON && activeStrategyID)
  const blurSettings = useBlurSettings(() => initialBlurSettings(window.radarAppearance), async request => {
    const snapshot = await withSettingsDeadline(window.webkit.messageHandlers.radar.postMessage(request))
    acceptSnapshot(snapshot)
    return snapshot
  }, radius => withSettingsDeadline(window.webkit.messageHandlers.radar.postMessage({ previewWindowBlur: radius })))
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({ backgroundMonitoringEnabled: false, notificationsEnabled: true, notificationAuthorization: "notDetermined", notificationError: "", backgroundMonitoringError: "", monitoringPaused: false, launchAtLogin: "disabled", launchAtLoginError: "" })
  const [chartMoveSettings, setChartMoveSettings] = useState<ChartMoveSettings>({ chartMoveLabelsVisible: true, chartMoveEfficiencyFactor: 1 })
  const [chartEfficiencyFactorDraft, setChartEfficiencyFactorDraft] = useState('1')
  const [chartEfficiencyFactorError, setChartEfficiencyFactorError] = useState('')
  const [notificationPending, setNotificationPending] = useState(false)
  const [sort, setSort] = useState<SortKey>("opportunity")
  const [descending, setDescending] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [signalChartOrder, setSignalChartOrder] = useState<string[] | null>(null)
  useEffect(() => {
    const openContract = () => {
      if (window.radarNotificationContract) {
        setSelected(window.radarNotificationContract)
        delete window.radarNotificationContract
      }
    }
    window.addEventListener("radar-open-contract", openContract)
    openContract()
    return () => window.removeEventListener("radar-open-contract", openContract)
  }, [])
  const [explanationOpen, setExplanationOpen] = useState(false)
  const [explainingId, setExplainingId] = useState<string | null>(null)
  const [phaseExplainingID,setPhaseExplainingID] = useState<string|null>(null)
  const explainMarket = useCallback((id: string) => { setExplainingId(id); setExplanationOpen(true) }, [])
  const explainRow = useCallback((id: string) => { if (activeProfileRef.current) setPhaseExplainingID(id); else explainMarket(id) },[explainMarket])
  const draftJSON = JSON.stringify(filterDraft ?? listFilters)
  const compileKey = (activeProfile?.id ?? '') + ':universe:' + (editor.source === null ? draftJSON : `source:${editor.source}`)
  const editorExpressions = useMemo(() => ({ ...editor.expressionDrafts, ...compilation.expressions }), [editor.expressionDrafts, compilation.expressions])
  const allowedMetrics = useMemo(() => metrics.filter(metric => !compilation.allowedMetrics || compilation.allowedMetrics.includes(metric.key)), [metrics, compilation.allowedMetrics])
  const compiling = compilation.pending || compilation.key !== compileKey
  const valid = !compiling && compilation.diagnostics.length === 0 && Boolean(compilation.configJSON)
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
    if (!snapshotOrder.current.accept(snapshot)) return false
    serviceSession.current = snapshotOrder.current.serviceSession
    revision.current = snapshotOrder.current.revision
    setRows(current => reconcileMarketRows(current, snapshot.rows))
    setFrostedBackgroundEnabled(snapshot.frostedBackgroundEnabled)
    setFrostedBackgroundOpacity(snapshot.frostedBackgroundOpacity)
    blurSettings.synchronize(initialBlurSettings(snapshot))
    setNotificationSettings(current => keepSnapshotValue(current, {
      backgroundMonitoringEnabled: snapshot.backgroundMonitoringEnabled ?? false,
      notificationsEnabled: snapshot.notificationsEnabled ?? true,
      notificationAuthorization: snapshot.notificationAuthorization ?? "notDetermined",
      notificationError: snapshot.notificationError ?? "",
      backgroundMonitoringError: snapshot.backgroundMonitoringError ?? "",
      monitoringPaused: snapshot.monitoringPaused ?? false,
      launchAtLogin: snapshot.launchAtLogin ?? "disabled",
      launchAtLoginError: snapshot.launchAtLoginError ?? "",
    }))
    setChartMoveSettings({
      chartMoveLabelsVisible: snapshot.chartMoveLabelsVisible ?? true,
      chartMoveEfficiencyFactor: snapshot.chartMoveEfficiencyFactor ?? 1,
    })
    if (document.activeElement?.id !== 'default-efficiency-factor') setChartEfficiencyFactorDraft(String(snapshot.chartMoveEfficiencyFactor ?? 1))
    if (!backgroundOpacityDraftDirty.current && document.activeElement?.id !== "background-opacity") setBackgroundOpacityDraft(String(snapshot.frostedBackgroundOpacity))
    setMetrics(current => keepSnapshotValue(current, snapshot.filterMetricsCatalog))
    setFunctions(current => keepSnapshotValue(current, snapshot.filterFunctions))
    setTemplates(current => keepSnapshotValue(current, snapshot.filterFunctionCatalog ?? expressionTemplates))
    if (!librarySavePending.current) setLibraryPreferences(current => keepSnapshotValue(current, snapshot.filterLibraryPreferences ?? initialLibraryPreferences()))
    setUpdatedAt(snapshot.updatedAt)
    setError(snapshot.error)
    setReady(true)
    return true
  }
  useEffect(() => {
    if (!active) return
    let stopped = false
    let backoff = 2000
    const load = async () => {
      await pageVisible(); if (stopped) return
      // Rule previews return the same market snapshot plus filter results.
      // Avoid a second full bridge request while that richer poll is active.
      if (previewPolling.current) {
        timer = window.setTimeout(load, 2000)
        return
      }
      try {
        const snapshot = await window.webkit.messageHandlers.radar.postMessage({ rocPeriod: ROC_PERIOD, marocPeriod: MAROC_PERIOD, sinceRevision: revision.current, serviceSession: serviceSession.current })
        if (stopped) return
        if ("unchanged" in snapshot) {
          setStatus("Live")
          if (snapshotOrder.current.isCurrent(snapshot)) setError(snapshot.error)
          backoff = 2000
        } else {
          acceptSnapshot(snapshot)
          setStatus("Live")
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
  }, [active])
  useEffect(() => {
    if (!active || !ready || !activeStrategyID) return
    const epoch = ++compileEpoch.current
    let stopped = false
    setCompilation(current => ({ ...current, key: compileKey, pending: true, diagnostics: [] }))
    const timer = window.setTimeout(async () => {
      try {
        const request = editor.source === null ? { filtersJSON: draftJSON } : { source: editor.source, previousJSON: draftJSON }
        const response = await window.webkit.messageHandlers.radar.postMessage({ compileMarketFilters: { ...request, suitePhase: 'universe' } })
        if (stopped || epoch !== compileEpoch.current) return
        setCompilation(current => ({ ...current, ...response, allowedMetrics: response.allowedMetrics, key: compileKey, pending: false }))
        if (response.diagnostics.length === 0 && response.configJSON) {
          setLastValidJSON(response.configJSON)
          if (editor.source !== null) setFilterDraft(parseFilterConfig(response.configJSON))
        }
      } catch (cause) {
        if (!stopped && epoch === compileEpoch.current) setCompilation(current => ({ ...current, key: compileKey, pending: false, diagnostics: [cause instanceof Error ? cause.message : "Compilation failed."] }))
      }
    }, 150)
    return () => { stopped = true; window.clearTimeout(timer) }
    // Keep the effect keyed to the current visual draft compilation request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ready, compileKey, activeStrategyID])
  useEffect(() => {
    if (!active || !lastValidJSON || !activeStrategyID) return
    let stopped = false
    let timer: number
    let backoff = 2000
    const epoch = ++previewEpoch.current
    const token = `${epoch}:${newRuleID()}`
    const refresh = async () => {
      await pageVisible(); if (stopped) return
      try {
        const snapshot = await window.webkit.messageHandlers.radar.postMessage({ previewMarketFilters: { filtersJSON: lastValidJSON, token, strategyID: activeStrategyID } })
        if (stopped || epoch !== previewEpoch.current) return
        if (snapshotOrder.current.isCurrent(snapshot) && previewResponseIsCurrent(snapshot, token, snapshot.serviceSession && snapshot.serviceSession !== serviceSession.current ? -1 : revision.current)) startTransition(() => {
          const updated = acceptSnapshot(snapshot)
          if (!updated) { backoff = 2000; return }
          setResults(current => keepSnapshotValue(current, snapshot.filterResults))
          setPreviewJSON(lastValidJSON)
          setPreviewStrategyID(activeStrategyID)
          setHistory(current => keepSnapshotValue(current, snapshot.historyProgress))
          setStatus("Live")
          backoff = 2000
        })
      } catch (cause) {
        if (stopped) return
        setStatus("Reconnecting")
        setError(cause instanceof Error ? cause.message : "Cannot preview native rules")
        backoff = Math.min(backoff * 2, 30000)
      }
      if (!stopped) timer = window.setTimeout(refresh, backoff)
    }
    void refresh()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, lastValidJSON, activeStrategyID])

  const signals = useMemo(() => activeProfile ? radarSignals(suite.snapshot.confirmed ?? [], suite.snapshot.provisional ?? [], activeProfile.id, activeProfile.revision, signalTiming) : [], [activeProfile, suite.snapshot.confirmed, suite.snapshot.provisional, signalTiming])
  const searchedRows = useMemo(() => rows.filter(row => row.instId.toLowerCase().includes(query.trim().toLowerCase())), [rows, query])
  const eligibleRows = useMemo(() => activeProfile ? previewStrategyID === activeProfile.id ? rows.filter(row => results[row.instId] === "true") : [] : rows, [rows, activeProfile, previewStrategyID, results])
  const universeRows = useMemo(() => activeProfile ? previewStrategyID === activeProfile.id ? searchedRows.filter(row => results[row.instId] === "true") : [] : searchedRows, [searchedRows, activeProfile, previewStrategyID, results])
  const searchedSignals = useMemo(() => signals.filter(signal => signal.instrument.toLowerCase().includes(query.trim().toLowerCase())), [signals, query])
  const visible = useMemo(() => [...universeRows].sort((a, b) => compareMarketRows(a, b, sort, descending)), [universeRows, sort, descending])
  const unknownCount = useMemo(() => searchedRows.filter(row => results[row.instId] === "unknown").length, [searchedRows, results])
  const listOrder = useMemo(() => visible.map(row => row.instId), [visible])
  const turnoverOrder = useMemo(() => [...eligibleRows].sort(compareMarketTurnover).map(row => row.instId), [eligibleRows])
  useEffect(() => {
    if (activeProfile) {
      setListFilters(parseFilterConfig(activeProfile.universeJSON))
    }
  }, [activeProfile])
  const chooseStrategy = (id: string) => { void suite.perform({ action: 'select', profileID: id === 'none' ? '' : id }).then(() => { setFilterDraft(null); setEditor(initialEditorState()) }).catch(() => {}) }
  const saveUniverse = async (rules: FilterConfigV2) => {
    if (!activeProfile) throw new Error("Activate a strategy before editing its Universe.")
    const response = await suite.perform({ action: "save", profile: { ...activeProfile, universeJSON: JSON.stringify(rules) } })
    if (response.saved) setListFilters(parseFilterConfig(response.saved.universeJSON))
    setFilterDraft(null)
    setEditor(current => ({ ...current, source: null }))
  }
  const saveLibraryPreferences = async (preferences: FilterLibraryPreferences) => {
    const previous = libraryPreferences, epoch = ++librarySaveEpoch.current
    librarySavePending.current = true
    setLibraryPreferences(preferences)
    try {
      const snapshot = await window.webkit.messageHandlers.radar.postMessage({ filterLibraryPreferencesJSON: JSON.stringify(preferences) })
      if (epoch === librarySaveEpoch.current) { librarySavePending.current = false; acceptSnapshot(snapshot) }
    } catch (cause) {
      if (epoch === librarySaveEpoch.current) { librarySavePending.current = false; setLibraryPreferences(previous) }
      throw cause
    }
  }
  const changeSort = (key: SortKey) => {
    if (sort === key) setDescending(!descending)
    else { setSort(key); setDescending(defaultSortDescending(key)) }
  }

  const saveSetting = (request: SettingRequest) => {
    void window.webkit.messageHandlers.radar.postMessage(request)
      .then(acceptSnapshot)
      .catch(cause => setError(cause instanceof Error ? cause.message : "Cannot save setting"))
  }

  const updateNotifications = async (request: SettingRequest) => {
    setNotificationPending(true)
    try { acceptSnapshot(await window.webkit.messageHandlers.radar.postMessage(request)) }
    catch (cause) { setNotificationSettings(current => ({ ...current, notificationError: cause instanceof Error ? cause.message : "Cannot update notifications" })) }
    finally { setNotificationPending(false) }
  }
  const notificationDescription = {
    notDetermined: "Allow macOS notifications to receive strategy alerts.",
    denied: "Notifications are blocked. Enable Perpetual Swap Suite in System Settings.",
    authorized: "macOS notifications are allowed.",
    quiet: "Notification banners are disabled. Enable alerts in System Settings.",
    unavailable: "Launch the packaged macOS app to enable notifications.",
  }[notificationSettings.notificationAuthorization]

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
  const saveChartEfficiencyFactor = () => {
    const value = Number(chartEfficiencyFactorDraft)
    if (!chartEfficiencyFactorDraft.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
      setChartEfficiencyFactorError('Enter a number from 0 to 1.')
      return
    }
    setChartEfficiencyFactorError('')
    setChartEfficiencyFactorDraft(String(value))
    setChartMoveSettings(current => ({ ...current, chartMoveEfficiencyFactor: value }))
    if (value !== chartMoveSettings.chartMoveEfficiencyFactor) saveSetting({ chartMoveEfficiencyFactor: value })
  }

  const header = (label: string, key: SortKey, content: ReactNode = label, description?: string) => {
    const SortIcon = sort !== key ? ArrowDownUp : descending ? ArrowDown : ArrowUp
    return <Button variant="ghost" size="xs" className={cn("h-auto min-h-(--control-height-xs) gap-1", key === "turnover24hUSDT" && "border-l-0 pl-0")} onClick={() => changeSort(key)} aria-label={`Sort by ${label}`} aria-pressed={sort === key} title={description}>
      {content}<SortIcon data-icon="inline-end" aria-hidden="true" />
    </Button>
  }

  if (selected && active) return <MarketChart instId={selected} listOrder={signalChartOrder ?? listOrder} turnoverOrder={turnoverOrder} moveDefaults={chartMoveSettings} onMoveEfficiencyFactorChange={value => {
    setChartMoveSettings(current => ({ ...current, chartMoveEfficiencyFactor: value }))
    setChartEfficiencyFactorDraft(String(value))
    saveSetting({ chartMoveEfficiencyFactor: value })
  }} onSelect={setSelected} backLabel={signalChartOrder ? 'Signals' : 'Markets'} onBack={() => { setSelected(null); setSignalChartOrder(null) }} />

  if (!ready) {
    return (
      <MarketListViewport>
        <main className="flex min-h-[inherit] flex-col items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <p className="text-lg font-medium">{error || status}</p>
            {error && <p className="text-sm text-muted-foreground">Check that the Monitor process is running</p>}
          </div>
        </main>
      </MarketListViewport>
    )
  }

  return (
    <MarketListViewport>
    <main className="flex min-h-[inherit] flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3 whitespace-nowrap">
        <ModeTitle mode="radar" pending={switchingMode} onSwitch={() => onResearch({ metrics, templates, functions })} />
        <Button variant="outline" onClick={() => onDecisions({ metrics, templates, functions })}>Strategy Library</Button>
        <span className="text-xs tabular-nums text-muted-foreground">{visible.length} / {rows.length} markets</span>
        <Popover onOpenChange={open => { if (!open) { if (backgroundOpacityDraftDirty.current) saveBackgroundOpacity(); blurSettings.commitAll() } if (open) void updateNotifications({ notificationAction: "refresh" }) }}>
          <PopoverTrigger asChild><Button variant="outline"><Settings2 data-icon="inline-start" aria-hidden="true" />Settings</Button></PopoverTrigger>
          <PopoverContent align="end">
            <PopoverHeader><PopoverTitle>Settings</PopoverTitle><PopoverDescription>Customize monitoring, notifications and the window background.</PopoverDescription></PopoverHeader>
            <FieldGroup>
              <Field><FieldLabel>AI analysis</FieldLabel><AnalysisSettingsButton /><FieldDescription>Configure the Gateway API Key and chart analysis model.</FieldDescription></Field>
              <Field>
                <FieldLabel>Move label defaults</FieldLabel>
                <Field data-invalid={Boolean(chartEfficiencyFactorError)}><FieldLabel htmlFor="default-efficiency-factor">Efficiency factor</FieldLabel><Input id="default-efficiency-factor" type="number" min="0" max="1" step="0.01" inputMode="decimal" value={chartEfficiencyFactorDraft} aria-invalid={Boolean(chartEfficiencyFactorError)} onChange={event => { setChartEfficiencyFactorDraft(event.target.value); setChartEfficiencyFactorError('') }} onBlur={saveChartEfficiencyFactor} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />{chartEfficiencyFactorError && <FieldError>{chartEfficiencyFactorError}</FieldError>}</Field>
                <Field orientation="horizontal"><FieldLabel htmlFor="default-move-label-layer">Show labels by default</FieldLabel><Toggle id="default-move-label-layer" variant="outline" pressed={chartMoveSettings.chartMoveLabelsVisible} onPressedChange={value => saveSetting({ chartMoveLabelsVisible: value })}>{chartMoveSettings.chartMoveLabelsVisible ? 'On' : 'Off'}</Toggle></Field>
                <FieldDescription>Efficiency = |change| / periods^factor. 0 ignores time; 1 is change per K-line. New charts use these defaults.</FieldDescription>
              </Field>
              <Field><FieldLabel>Run mode</FieldLabel><ToggleGroup type="single" variant="outline" disabled={notificationPending} value={notificationSettings.backgroundMonitoringEnabled ? "background" : "onDemand"} onValueChange={value => { if (value) void updateNotifications({ backgroundMonitoringEnabled: value === "background" }) }} aria-label="Run mode"><ToggleGroupItem value="onDemand">On-demand</ToggleGroupItem><ToggleGroupItem value="background">Background Monitoring</ToggleGroupItem></ToggleGroup><FieldDescription>Background Monitoring allows the helper to keep collecting after closing or quitting. Start at Login requires this mode.</FieldDescription></Field>
              <Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="strategy-notifications">Strategy notifications</FieldLabel>
                  <Toggle id="strategy-notifications" variant="outline" pressed={notificationSettings.notificationsEnabled} disabled={notificationPending} onPressedChange={enabled => void updateNotifications({ notificationsEnabled: enabled })} aria-label="Enable strategy notifications" aria-describedby="notification-description">{notificationSettings.notificationsEnabled ? "On" : "Off"}</Toggle>
                </Field>
                <FieldDescription id="notification-description">Notify about confirmed Bullish Setup signals from the active saved strategy. Drafts and search do not affect alerts.</FieldDescription>
                <FieldDescription role="status">{notificationDescription}</FieldDescription>
                <div className="flex flex-wrap gap-2">
                  {notificationSettings.notificationAuthorization === "notDetermined" && <Button variant="outline" size="sm" disabled={notificationPending} onClick={() => void updateNotifications({ notificationAction: "requestPermission" })}>Allow notifications</Button>}
                  <Button variant="outline" size="sm" disabled={notificationPending || !notificationSettings.notificationsEnabled || !["authorized", "quiet"].includes(notificationSettings.notificationAuthorization)} onClick={() => void updateNotifications({ notificationAction: "test" })}>Test notification</Button>
                  <Button variant="ghost" size="sm" disabled={notificationPending} onClick={() => void updateNotifications({ notificationAction: "openSettings" })}>Notification Settings</Button>
                </div>
                <FieldDescription>{notificationSettings.backgroundMonitoringEnabled ? "Monitoring continues after closing the window or Cmd+Q. Use Quit Completely in the menu bar to stop everything." : "On-demand: closing the window or Cmd+Q saves research checkpoints and stops everything. Minimize to keep running."}</FieldDescription>
                {(notificationSettings.notificationError || notificationSettings.backgroundMonitoringError) && <FieldError role="alert">{notificationSettings.notificationError || notificationSettings.backgroundMonitoringError}</FieldError>}
              </Field>
              <Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="background-monitoring">Monitoring</FieldLabel>
                  <Toggle id="background-monitoring" variant="outline" pressed={!notificationSettings.monitoringPaused} disabled={notificationPending} onPressedChange={enabled => void updateNotifications({ monitoringPaused: !enabled })} aria-label="Enable background monitoring">{notificationSettings.monitoringPaused ? "Paused" : "Running"}</Toggle>
                </Field>
                <FieldDescription>Pausing stops collection and alerts. Resuming establishes a fresh baseline.</FieldDescription>
              </Field>
              <Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="launch-at-login">Start at Login</FieldLabel>
                  <Toggle id="launch-at-login" variant="outline" pressed={notificationSettings.launchAtLogin === "enabled" || notificationSettings.launchAtLogin === "requiresApproval"} disabled={notificationPending || !notificationSettings.backgroundMonitoringEnabled || notificationSettings.launchAtLogin === "unavailable"} onPressedChange={enabled => void updateNotifications({ launchAtLogin: enabled })} aria-label="Start monitoring at login">{notificationSettings.launchAtLogin === "enabled" ? "On" : notificationSettings.launchAtLogin === "requiresApproval" ? "Approval needed" : "Off"}</Toggle>
                </Field>
                <FieldDescription>Start the menu bar monitor after signing in, with the main window closed.</FieldDescription>
                {notificationSettings.launchAtLogin === "requiresApproval" && <Button variant="outline" size="sm" disabled={notificationPending} onClick={() => void updateNotifications({ launchAtLogin: true })}>Open Login Items</Button>}
                {notificationSettings.launchAtLoginError && <FieldError role="alert">{notificationSettings.launchAtLoginError}</FieldError>}
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
        <Button variant="outline" size="sm" disabled={!activeProfile} onClick={() => setExplanationOpen(true)}><ScanSearch data-icon="inline-start" aria-hidden="true" />Explain markets</Button>
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
        <Field orientation="horizontal" className="w-fit"><FieldLabel htmlFor="radar-strategy">Active strategy</FieldLabel><Select value={activeProfile?.id ?? 'none'} disabled={suite.pending || filterDraft !== null || editor.source !== null} onValueChange={chooseStrategy}><SelectTrigger id="radar-strategy" className="w-72" aria-label="Active Radar strategy"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">No active strategy</SelectItem>{suite.snapshot.profiles.map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name} · r{profile.revision}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {activeProfile ? <ToggleGroup type="single" variant="outline" value={signalTiming} onValueChange={value => { if (value) setSignalTiming(value as SignalTiming) }} aria-label="Signal timing"><ToggleGroupItem value="both">Both hours</ToggleGroupItem><ToggleGroupItem value="confirmed">Confirmed</ToggleGroupItem><ToggleGroupItem value="provisional">Provisional</ToggleGroupItem></ToggleGroup> : <span className="text-xs text-muted-foreground">Choose a shared strategy to watch Bullish Setup signals.</span>}
        {(filterDraft !== null || editor.source !== null) && <span className="ml-auto text-xs text-muted-foreground">Apply or discard Universe edits before changing strategy</span>}
      </div>
      {suite.ready && !activeProfile && <Empty className="border-b"><EmptyHeader><EmptyTitle>Activate a strategy to monitor signals</EmptyTitle><EmptyDescription>All markets remain available below. Create a Strategy with Universe and Bullish Setup rules to enable signals and confirmed alerts.</EmptyDescription></EmptyHeader><EmptyContent><Button variant="outline" onClick={() => onDecisions({ metrics, templates, functions })}>Strategy Library…</Button></EmptyContent></Empty>}
      {suite.error && <p role="alert" className="px-4 text-destructive">{suite.error}</p>}
      {activeProfile && <StrategyRules label="Universe rules" filters={listFilters} draft={filterDraft} editor={editor} onEditorChange={setEditor} onDraftChange={setFilterDraft} onApply={saveUniverse} metrics={allowedMetrics} templates={templates} preferences={libraryPreferences} onPreferences={saveLibraryPreferences} previewJSON={previewJSON} units={compilation.units ?? {}} expressions={editorExpressions} diagnostics={compilation.diagnostics} valid={valid} compiling={compiling} requiredHours={compilation.requiredHours ?? 0} matches={searchedRows.filter(row => results[row.instId] === 'true').length} total={searchedRows.length} unknown={unknownCount} previewPending={lastValidJSON !== previewJSON} history={history} />}
      {activeProfile && <SuitePhaseExplanation instrument={phaseExplainingID} profile={activeProfile} inputs={{metrics,templates,functions}} onClose={() => setPhaseExplainingID(null)} />}
      {activeProfile && <FilterExplanation strategyID={activeProfile.id} open={explanationOpen} onOpenChange={setExplanationOpen} instId={explainingId} onSelect={setExplainingId} rows={rows} results={results} filtersJSON={previewJSON} revision={revision.current} metrics={metrics} expressions={editorExpressions} units={compilation.units ?? {}} templates={templates} />}
      {error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{error}</p>}
      {activeProfile && <RadarSignalBoard profile={activeProfile} signals={searchedSignals} rows={rows} paused={suite.snapshot.paused} recovering={suite.snapshot.recovering} onChart={(instrument, order) => { setSignalChartOrder(order); setSelected(instrument) }} onExplain={explainRow} onResearch={() => onResearch({ metrics, templates, functions }, suiteSpec([activeProfile]))} onBrowseCharts={() => document.getElementById('all-markets')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}
      <section id="all-markets" aria-label="Perpetual swap markets" className="flex-1 scroll-mt-4">
        <header className="border-y px-4 py-3"><h2 className="font-semibold">All markets</h2>{activeProfile && <p className="text-xs text-muted-foreground">Showing contracts that match the active Strategy Universe.</p>}</header>
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
                  {header("High breakout · 48h", "highBreakout", undefined, BREAK_DESCRIPTION)}
                  {header("High age", "highBreakoutPriorAge", undefined, "Sort by the previous high's age at the breakout, longest first. Tied highs use the most recent occurrence.")}
                  {header("Low breakdown · 48h", "lowBreakdown", undefined, BREAK_DESCRIPTION)}
                  {header("Low age", "lowBreakdownPriorAge", undefined, "Sort by the previous low's age at the breakdown, longest first. Tied lows use the most recent occurrence.")}
                </div>
              </TableHead>
              <TableHead className="text-center" aria-sort={sort === "takerRatio" ? descending ? "descending" : "ascending" : "none"}>{header("Taker imbalance", "takerRatio", takerImbalanceFormula)}</TableHead>
              <TableHead className="text-center" aria-sort={sort === "oiChange" ? descending ? "descending" : "ascending" : "none"}>{header("OI Relative Change", "oiChange", undefined, `Hourly change in OI contracts, unaffected by price-only changes. ${PERCENT_CHANGE_DESCRIPTION}`)}</TableHead>
              <TableHead className="py-1.5 text-center" aria-sort={sort === "roc" || sort === "maroc" ? descending ? "descending" : "ascending" : "none"}>
                <div className="flex flex-col items-center">
                  {header(`ROC ${ROC_PERIOD}`, "roc", indicatorFormula('ROC', ROC_PERIOD), `${ROC_PERIOD}-hour price change. ${PERCENT_CHANGE_DESCRIPTION}`)}
                  {header(`MAROC ${MAROC_PERIOD}`, "maroc", indicatorFormula('MAROC', MAROC_PERIOD), `Mean of the latest ${MAROC_PERIOD} hourly ROC readings, as a percentage.`)}
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
          {visible.length ? <MarketRows canExplain={Boolean(activeProfile)} confirmed={confirmedPhases} provisional={provisionalPhases} rows={visible} onSelect={setSelected} onExplain={explainRow} /> : <TableBody><TableRow><TableCell colSpan={8} className="py-12">
              <Empty>
                <EmptyHeader><EmptyTitle>{rows.length ? activeProfile && previewStrategyID !== activeProfile.id ? "Evaluating Universe" : "No matching contracts" : "Waiting for contracts"}</EmptyTitle><EmptyDescription>{rows.length ? activeProfile && previewStrategyID !== activeProfile.id ? "Applying the active Strategy Universe to All markets." : "Adjust the search or inspect the active Strategy Universe. Explain markets includes unmatched and Unknown contracts." : "OKX hourly data is loading. Activate a strategy to monitor its Universe and Bullish Setup."}</EmptyDescription></EmptyHeader>
                <EmptyContent>
                  {filterDraft !== null && <Button variant="outline" size="sm" onClick={() => { setFilterDraft(null); setEditor(current => ({ ...current, source: null })) }}>Discard preview</Button>}
                  {activeProfile && listFilters.root.children.length > 0 && <Button variant="outline" size="sm" onClick={() => { void saveUniverse(emptyFilterConfig()).catch(cause => setError(cause instanceof Error ? cause.message : "Cannot clear Universe rules")) }}>Clear all rules</Button>}
                  {query && <Button variant="ghost" size="sm" onClick={() => setQuery("")}>Clear search</Button>}
                </EmptyContent>
              </Empty>
            </TableCell></TableRow></TableBody>}
        </Table>
      </section>
    </main>
    </MarketListViewport>
  )
}

function App() {
  const [workspace, setWorkspace] = useState<"radar" | "research" | "decisions">("radar")
  const [inputs, setInputs] = useState<ResearchInputs | null>(null)
  const [workspaceError, setWorkspaceError] = useState("")
  const [decisionsMounted, setDecisionsMounted] = useState(false)
  const [decisionsTab, setDecisionsTab] = useState<'rules' | 'signals'>('rules'), [decisionsRoute, setDecisionsRoute] = useState(0)
  const [researchMounted, setResearchMounted] = useState(false)
  const [switchingMode, setSwitchingMode] = useState(false), switching = useRef(false)
  const scrollPositions = useRef<Record<string, number>>({})
  const previousMode = useRef("radar")
  const [researchSpec, setResearchSpec] = useState<StudySpec | null>(null)
  const [researchSeed, setResearchSeed] = useState(0)
  const [researchReturn, setResearchReturn] = useState<"radar" | "decisions">("radar")
  const changeWorkspace = async (value: "radar" | "research" | "decisions", nextInputs?: ResearchInputs, spec?: StudySpec) => {
    if (switching.current) return
    switching.current = true; setSwitchingMode(true); setWorkspaceError("")
    try {
      await window.webkit.messageHandlers.radar.postMessage({ foregroundWorkspace: value === "research" ? "research" : "radar" })
      scrollPositions.current[workspace] = window.scrollY
      if (nextInputs) setInputs(nextInputs)
      if (value === "decisions") setDecisionsMounted(true)
      if (value === "research") {
        setResearchMounted(true)
        if (workspace !== "research") setResearchReturn(workspace)
        if (spec) { setResearchSpec(spec); setResearchSeed(current => current+1) }
      }
      setWorkspace(value)
    } catch (cause) { setWorkspaceError(cause instanceof Error ? cause.message : "Cannot switch workspace.") }
    finally { switching.current = false; setSwitchingMode(false) }
  }
  useLayoutEffect(() => {
    const mode = workspace === "research" ? "research" : "radar"
    const switched = previousMode.current !== mode
    previousMode.current = mode
    document.title = modeTitle(mode)
    let frame = 0, attempts = 0
    const restore = () => {
      window.scrollTo({ top: scrollPositions.current[workspace] ?? 0, behavior: 'instant' })
      if (switched) {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode-switch]')).find(candidate => candidate.getBoundingClientRect().height > 0)
        if (button) button.focus({ preventScroll: true })
        else if (++attempts < 60) { frame = window.requestAnimationFrame(restore); return }
      }
    }
    frame = window.requestAnimationFrame(restore)
    return () => window.cancelAnimationFrame(frame)
  },[workspace])
  return <Fragment>
    {workspaceError && <p role="alert" className="p-3 text-destructive">{workspaceError}</p>}
    <div hidden={workspace !== "radar"}><RadarApp active={workspace === "radar"} switchingMode={switchingMode} onResearch={(value, spec) => void changeWorkspace("research",value,spec)} onDecisions={(value, tab = 'rules') => { setDecisionsTab(tab); setDecisionsRoute(current => current + 1); void changeWorkspace("decisions", value) }} /></div>
    {inputs && decisionsMounted && <div hidden={workspace !== "decisions"}><Suspense fallback={<Spinner className="m-6" />}><SuiteWorkspace mode="radar" active={workspace === "decisions"} inputs={inputs} initialTab={decisionsTab} routeKey={decisionsRoute} switchingMode={switchingMode} onSwitchMode={() => void changeWorkspace("research")} onBack={() => void changeWorkspace("radar")} onResearch={spec => void changeWorkspace("research",undefined,spec)} /></Suspense></div>}
    {inputs && researchMounted && <div hidden={workspace !== "research"}><Suspense fallback={<Spinner className="m-6" />}><Research key={researchSeed} active={workspace === "research"} switchingMode={switchingMode} inputs={inputs} initialSpec={researchSpec} onRadar={() => void changeWorkspace("radar")} onSwitchMode={() => void changeWorkspace(researchReturn)} /></Suspense></div>}
  </Fragment>
}

export default App
