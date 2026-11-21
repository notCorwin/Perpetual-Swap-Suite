import { lazy, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DeferredPanel } from '@/DeferredPanel'
import { Camera, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { captureStableChart, chartCaptureBounds, eraseCapturedAction } from '@/chart-capture'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ChartTimeSyncProvider, MarketChart, type SharedChartStatusValue } from '@/MarketChart'
import { MarketRowsViewport } from '@/MarketRowsViewport'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { settingsHref, useSettingsSection, type SettingsNavigationState } from '@/settings-navigation'
import { chartCoordinator, multiChartControllers, ingestPreparedChart } from '@/chart-controller'
import { reconcileMarketOrder, reconcileMarketRows } from '@/market-snapshot'
import { SnapshotOrder } from '@/snapshot-order'
import { DEFAULT_PREFERENCES, type Preferences } from '@/renderer-preferences'
import type { DataAudit, HistoryDownload, MarketSnapshot, RankedMarketRow, UnchangedSnapshot } from '@/desktop-contract'
import type { PreparedChartNotification } from '@/chart-data'
import { cn } from '@/lib/utils'
import { formatCurrentPrice } from '@/price-format'
import { getPresentation, subscribePresentationTransition, usePresentation, waitForPresentation } from '@/presentation-store'
import { timeframeLabel, type RadarTimeframe } from '@/timeframe'
import type { SettingsStatusValue } from '@/WorkspaceSettings'

const WorkspaceSettings = lazy(() => import('@/WorkspaceSettings').then(module => ({ default: module.WorkspaceSettings })))

const qualificationPending = (progress: MarketSnapshot['catalogProgress']) => !progress || progress.total === 0 || progress.completed < progress.total || progress.pending > 0
const collectorStatus = (snapshot: MarketSnapshot | UnchangedSnapshot) => {
  const catalog = snapshot.catalogProgress
  if (snapshot.loading && catalog && catalog.total > 0) {
    if (catalog.completed < catalog.total) return `Verifying ${catalog.completed}/${catalog.total}`
    if (catalog.pending > 0) return `Updating ${catalog.pending} contracts`
  }
  if (snapshot.error || catalog && catalog.unknown > 0) return snapshot.catalogSource === 'none' ? 'Unavailable' : 'Incomplete'
  if (snapshot.loading) return 'Refreshing'
  return snapshot.catalogSource === 'cache' ? 'Cached' : snapshot.catalogSource === 'live' ? 'Live' : 'Waiting'
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The desktop data service could not complete this request.'

const MarketRowView = memo(function MarketRowView({ row, index, selected, lookback, onSelect }: { row: RankedMarketRow; index: number; selected: boolean; lookback: number; onSelect: (id: string) => void }) {
  const change = Number.isFinite(row.rankingChange) ? row.rankingChange : null
  const price = formatCurrentPrice(row.lastPrice, row.tickSz)
  return <TableRow data-market-index={index} aria-rowindex={index + 2} aria-selected={selected} data-state={selected ? 'selected' : undefined} tabIndex={0} aria-label={`View ${row.instId} chart`} onClick={() => onSelect(row.instId)} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.instId) }
  }} className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2">
    <TableCell className="font-medium" title={row.instId}><span className="block truncate">{row.instId.replace(/-USDT-SWAP$/, '')}</span></TableCell>
    <TableCell className="text-right"><span className="block truncate" title={price}>{price}</span></TableCell>
    <TableCell className="text-right" title={row.rankingAsOf ? `${lookback}-minute signed relative change · completed candle as of ${new Date(row.rankingAsOf).toLocaleString('en-US')}` : 'Completed candle ranking is not available'}>
      <span className="inline-flex items-center justify-end gap-1"><span aria-hidden="true" className={cn(change === null ? 'text-muted-foreground' : change > 0 ? 'text-positive' : change < 0 ? 'text-negative' : 'text-muted-foreground')}>{change === null ? '' : change > 0 ? '↑' : change < 0 ? '↓' : '→'}</span><span>{change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`}</span></span>
    </TableCell>
  </TableRow>
})

function App() {
  const statusRow = useRef<HTMLElement>(null)
  const [statusHeight, setStatusHeight] = useState(0)
  useLayoutEffect(() => {
    const row = statusRow.current
    if (!row) return
    const update = () => setStatusHeight(row.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  const settingsGuard = useRef<SettingsNavigationState>({ dirty: false, busy: false })
  const settingsSection = useSettingsSection(settingsGuard)
  const lastVisibleSettings = useRef(settingsSection)
  if (settingsSection) lastVisibleSettings.current = settingsSection
  const settingsLauncher = useRef<HTMLAnchorElement>(null)
  const lastSettingsSection = useRef(settingsSection)
  const updateSettingsGuard = useCallback((value: SettingsNavigationState) => { settingsGuard.current = value }, [])
  useEffect(() => {
    if (lastSettingsSection.current && !settingsSection) settingsLauncher.current?.focus()
    lastSettingsSection.current = settingsSection
  }, [settingsSection])
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [preferencesError, setPreferencesError] = useState('')
  const [rows, setRows] = useState<RankedMarketRow[]>([])
  const [candidateIds, setCandidateIds] = useState<string[]>([])
  const [turnoverOrder, setTurnoverOrder] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [catalog, setCatalog] = useState<Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'catalogProgress'>>({ loading: true, catalogSource: 'none' })
  const [status, setStatus] = useState('Connecting')
  const [realtime, setRealtime] = useState('Connecting')
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [globalAudit, setGlobalAudit] = useState<DataAudit | null>(null)
  const [globalDownload, setGlobalDownload] = useState<HistoryDownload | null>(null)
  const [auditStatusUnavailable, setAuditStatusUnavailable] = useState(false)
  const [downloadStatusUnavailable, setDownloadStatusUnavailable] = useState(false)
  const auditOrder = useRef(new SnapshotOrder())
  const downloadOrder = useRef(new SnapshotOrder())
  const receiveAudit = useCallback((value: DataAudit) => { if (auditOrder.current.accept(value)) { setGlobalAudit(value); setAuditStatusUnavailable(false) } }, [])
  const receiveDownload = useCallback((value: HistoryDownload) => { if (downloadOrder.current.accept(value)) { setGlobalDownload(value); setDownloadStatusUnavailable(false) } }, [])
  const receiveSettingsJob = useCallback((kind: 'audit' | 'download', value: DataAudit | HistoryDownload) => {
    // The settings page can recover a failed initial read. Once a global
    // snapshot exists, only the shared notification stream can replace it.
    if (kind === 'audit' && auditOrder.current.revision < 0) receiveAudit(value as DataAudit)
    if (kind === 'download' && downloadOrder.current.revision < 0) receiveDownload(value as HistoryDownload)
  }, [receiveAudit, receiveDownload])
  const order = useRef(new SnapshotOrder())
  const retainSelection = useRef(false)
  const preferenceWrite = useRef(0)
  const committedPreferences = useRef<Preferences>(DEFAULT_PREFERENCES)
  const preferenceQueue = useRef<Promise<void>>(Promise.resolve())
  const timeframe = preferences.chartTimeframe
  const presentation = usePresentation()

  const applyMarket = useCallback((snapshot: MarketSnapshot | UnchangedSnapshot, preserveSelection = false) => {
    if (!order.current.accept(snapshot)) return
    if (!('unchanged' in snapshot)) {
      const unverified = snapshot.loading && qualificationPending(snapshot.catalogProgress) || snapshot.error || snapshot.catalogSource === 'none' || (snapshot.catalogProgress?.unknown ?? 0) > 0
      setRows(current => reconcileMarketRows(current, snapshot.rows))
      setCandidateIds(current => reconcileMarketOrder(current, snapshot.rows.map(row => row.instId)))
      setTurnoverOrder(current => reconcileMarketOrder(current, snapshot.turnoverOrder))
      setSelected(current => (preserveSelection || retainSelection.current) && current || snapshot.rows.some(row => row.instId === current) || (!snapshot.rows.length && unverified) ? current : snapshot.rows[0]?.instId ?? null)
      setReady(true)
    }
    setError(snapshot.error)
    setCatalog(current => ({
      loading: snapshot.loading ?? ('unchanged' in snapshot ? current.loading : false),
      catalogSource: snapshot.catalogSource ?? current.catalogSource,
      catalogProgress: snapshot.catalogProgress ?? ('unchanged' in snapshot ? current.catalogProgress : undefined),
    }))
    if (!('unchanged' in snapshot) || snapshot.catalogSource !== undefined || snapshot.catalogProgress !== undefined || snapshot.loading !== undefined) setStatus(collectorStatus(snapshot))
    if (snapshot.updatedAt !== undefined) setUpdatedAt(snapshot.updatedAt)
    if (snapshot.realtimeState) setRealtime(snapshot.realtimeState)
    else if (!('unchanged' in snapshot)) setRealtime('Unavailable')
  }, [])
  useLayoutEffect(() => subscribePresentationTransition(update => {
    if (!update.active) { retainSelection.current = true; chartCoordinator.setPresentationActive(false); return }
    if (update.snapshot) {
      chartCoordinator.setPresentationActive(true, update.snapshot.frames)
      applyMarket(update.snapshot.market, true)
      receiveAudit(update.snapshot.audit)
      receiveDownload(update.snapshot.download)
      committedPreferences.current = update.snapshot.preferences
      setPreferences(update.snapshot.preferences); setPreferencesError(''); setPreferencesLoaded(true)
    } else chartCoordinator.setPresentationActive(true)
  }), [applyMarket, receiveAudit, receiveDownload])
  useEffect(() => {
    const audit = (event: Event) => receiveAudit((event as CustomEvent<DataAudit>).detail)
    const download = (event: Event) => receiveDownload((event as CustomEvent<HistoryDownload>).detail)
    window.addEventListener('radar-audit-changed', audit)
    window.addEventListener('radar-history-download-changed', download)
    // An already-active window may never receive an activation snapshot. Seed
    // each missing job once; subsequent notifications and snapshots are ordered
    // by session/revision, so a late response cannot replace newer state.
    let stopped = false
    const epoch = getPresentation().epoch
    if (getPresentation().active && auditOrder.current.revision < 0) {
      void window.radarDesktop.request({ dataAudit: { action: 'status' } }).then(value => {
        if (!stopped && getPresentation().active && getPresentation().epoch === epoch && auditOrder.current.revision < 0) receiveAudit(value)
      }).catch(() => {
        if (!stopped && getPresentation().active && getPresentation().epoch === epoch && auditOrder.current.revision < 0) setAuditStatusUnavailable(true)
      })
    }
    if (getPresentation().active && downloadOrder.current.revision < 0) {
      void window.radarDesktop.request({ historyDownload: { action: 'status' } }).then(value => {
        if (!stopped && getPresentation().active && getPresentation().epoch === epoch && downloadOrder.current.revision < 0) receiveDownload(value)
      }).catch(() => {
        if (!stopped && getPresentation().active && getPresentation().epoch === epoch && downloadOrder.current.revision < 0) setDownloadStatusUnavailable(true)
      })
    }
    return () => { stopped = true; window.removeEventListener('radar-audit-changed', audit); window.removeEventListener('radar-history-download-changed', download) }
  }, [receiveAudit, receiveDownload])
  useLayoutEffect(() => {
    if (!presentation.active) return
    const epoch = presentation.epoch
    const frame = requestAnimationFrame(() => {
      if (!getPresentation().active || getPresentation().epoch !== epoch) return
      document.documentElement.setAttribute('data-presentation-epoch', String(epoch))
      window.dispatchEvent(new CustomEvent('radar-presentation-ready', { detail: { epoch } }))
    })
    return () => cancelAnimationFrame(frame)
  }, [presentation])

  useEffect(() => {
    const receive = (event: Event) => ingestPreparedChart((event as CustomEvent<PreparedChartNotification>).detail)
    window.addEventListener('radar-chart-prepared', receive)
    return () => window.removeEventListener('radar-chart-prepared', receive)
  }, [])
  useEffect(() => {
    let stopped = false
    const write = preferenceWrite.current
    const epoch = getPresentation().epoch
    window.radarDesktop.request({ preferences: { action: 'read' } }).then(value => {
      if (!stopped && getPresentation().active && epoch === getPresentation().epoch && write === preferenceWrite.current) { committedPreferences.current = value; setPreferences(value); setPreferencesError('') }
    }).catch(cause => { if (!stopped && getPresentation().active && epoch === getPresentation().epoch) setPreferencesError(message(cause)) }).finally(() => { if (!stopped && getPresentation().active && epoch === getPresentation().epoch) setPreferencesLoaded(true) })
    return () => { stopped = true }
  }, [])
  useEffect(() => {
    if (!preferencesLoaded) return
    let stopped = false
    let working = false
    let queued = false
    const visible = () => document.visibilityState !== 'hidden' && getPresentation().active
    const load = async () => {
      if (stopped) return
      if (working) { queued = true; return }
      if (!visible()) { queued = true; return }
      working = true
      queued = false
      const epoch = getPresentation().epoch
      try {
        const snapshot = await window.radarDesktop.request({ snapshot: { sinceRevision: order.current.revision, serviceSession: order.current.serviceSession } })
        if (stopped || !visible() || epoch !== getPresentation().epoch) return
        applyMarket(snapshot)
      } catch (cause) {
        if (stopped || !visible() || epoch !== getPresentation().epoch) return
        setError(message(cause)); setStatus('Unavailable'); setRealtime('Disconnected')
        setCatalog(current => ({ ...current, loading: false }))
      } finally {
        working = false
        if (!stopped && visible() && queued) void load()
      }
    }
    const changed = () => { void load() }
    const shown = () => { if (visible()) void load() }
    window.addEventListener('radar-market-changed', changed)
    document.addEventListener('visibilitychange', shown)
    void load()
    return () => {
      stopped = true
      window.removeEventListener('radar-market-changed', changed)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [preferencesLoaded, applyMarket])

  const visible = rows
  const visibleIds = candidateIds
  const verifying = Boolean(catalog.loading) && qualificationPending(catalog.catalogProgress) || (!ready && !error)
  const awaitingObservations = Boolean(catalog.loading && catalog.catalogProgress && catalog.catalogProgress.completed === catalog.catalogProgress.total && catalog.catalogProgress.pending > 0)
  const verificationUnavailable = !verifying && (Boolean(error) || catalog.catalogSource === 'none' || (catalog.catalogProgress?.unknown ?? 0) > 0)
  const emptyTitle = verifying ? catalog.catalogSource === 'none' ? 'Loading contracts' : awaitingObservations ? 'Updating market data' : 'Verifying contracts' : verificationUnavailable ? 'Market verification unavailable' : 'No qualified contracts'
  const emptyDescription = verifying
    ? awaitingObservations ? 'Waiting for fresh observations. Market data collection continues in the background.' : catalog.catalogProgress?.total ? `Checking enabled conditions: ${catalog.catalogProgress.completed} / ${catalog.catalogProgress.total} contracts completed.` : 'The data service is preparing and verifying the market list.'
    : verificationUnavailable ? 'Market data could not verify the enabled conditions. Waiting for updated observations from the data service.' : 'Adjust the enabled liquidity conditions in Settings.'
  // A qualification change must not discard the user's chart or history cursor.
  const selectedRow = rows.find(row => row.instId === selected)
  const selectedPrice = selectedRow?.lastPrice
  const sharedPrice = typeof selectedPrice === 'number' && Number.isFinite(selectedPrice) && selectedPrice > 0 ? selectedPrice : undefined
  const sharedPriceText = sharedPrice === undefined ? undefined : formatCurrentPrice(sharedPrice, selectedRow?.tickSz)
  const [chartStatuses, setChartStatuses] = useState<Partial<Record<RadarTimeframe, SharedChartStatusValue>>>({})
  const [settingsStatuses, setSettingsStatuses] = useState<SettingsStatusValue[]>([])
  const updateSettingsStatuses = useCallback((items: SettingsStatusValue[]) => {
    setSettingsStatuses(current => JSON.stringify(current) === JSON.stringify(items) ? current : items)
  }, [])
  const updateChartStatus = useCallback((frame: RadarTimeframe, value: SharedChartStatusValue | null) => {
    setChartStatuses(current => {
      const previous = current[frame]
      if ((!previous && !value) || (previous && value && previous.detail === value.detail && previous.severity === value.severity)) return current
      const next = { ...current }
      if (value) next[frame] = value
      else delete next[frame]
      return next
    })
  }, [])
  const retainedChart = Boolean(selected && !selectedRow)
  const selectedID = selected
  const connectionProblem = !['live', 'connected'].includes(realtime.toLowerCase())
  const connectionFailure = ['reconnecting', 'disconnected'].includes(realtime.toLowerCase())
  const listOrder = candidateIds
  useEffect(() => { if (ready) void chartCoordinator.setUniverse(retainedChart && selectedID ? [...candidateIds, selectedID] : candidateIds, timeframe) }, [ready, candidateIds, timeframe, retainedChart, selectedID])
  const savePreferences = useCallback(async (values: Partial<Preferences>) => {
    const write = ++preferenceWrite.current
    const epoch = getPresentation().epoch
    const task = preferenceQueue.current.then(() => window.radarDesktop.request({ preferences: { action: 'update', values } }))
    preferenceQueue.current = task.then(() => undefined, () => undefined)
    let saved: Preferences
    try {
      saved = await task
      await waitForPresentation()
      if (epoch !== getPresentation().epoch) {
        // A write can finish during the barrier; read the current committed
        // preferences instead of letting its older response replace it.
        const readEpoch = getPresentation().epoch
        try {
          const actual = await window.radarDesktop.request({ preferences: { action: 'read' } })
          await waitForPresentation()
          saved = readEpoch === getPresentation().epoch ? actual : committedPreferences.current
        } catch { await waitForPresentation(); saved = committedPreferences.current }
      }
    }
    catch (cause) {
      await waitForPresentation()
      if (write !== preferenceWrite.current) return
      // A failed response does not prove that the backend did not commit.
      try {
        const actual = await window.radarDesktop.request({ preferences: { action: 'read' } })
        await waitForPresentation()
        if (write !== preferenceWrite.current) return
        committedPreferences.current = actual
        setPreferences(actual)
      } catch { await waitForPresentation() /* Keep the last confirmed value if reconciliation is unavailable. */ }
      if (write !== preferenceWrite.current) return
      throw cause
    }
    committedPreferences.current = saved
    if (write !== preferenceWrite.current) return
    // Backend notifications own market updates; view preferences do not reload rows.
    setPreferences(saved); setPreferencesError('')
  }, [])
  const chartsRef = useRef<HTMLDivElement>(null)
  const copyButtonRef = useRef<HTMLButtonElement>(null)
  const copyOwner = useRef<object | null>(null)
  const [copyState, setCopyState] = useState<{ status: 'idle' | 'copying' | 'copied' | 'failed'; error: string }>({ status: 'idle', error: '' })
  useLayoutEffect(() => {
    copyOwner.current = null
    setCopyState({ status: 'idle', error: '' })
    return () => { copyOwner.current = null }
  }, [selectedID, settingsSection])
  useEffect(() => {
    if (copyState.status !== 'copied') return
    const timer = window.setTimeout(() => setCopyState({ status: 'idle', error: '' }), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState.status])
  const copyChart = async () => {
    const element = chartsRef.current
    if (!element) return
    const owner = {}
    copyOwner.current = owner
    setCopyState({ status: 'copying', error: '' })
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (copyOwner.current !== owner || chartsRef.current !== element) return
      const button = copyButtonRef.current
      if (!button) throw new Error('Copy action is unavailable.')
      const charts = Array.from(element.querySelectorAll<HTMLElement>('[data-chart-inst]'))
      if (charts.length !== 3 || charts.some(chart => chart.dataset.chartLoading !== 'false' || !(Number(chart.dataset.chartRenderedBars) > 0) || chart.dataset.chartInst !== selectedID)) throw new Error('Charts are still loading. Try again when all three are ready.')
      const bounds = chartCaptureBounds(element)
      const buttonBounds = button.getBoundingClientRect()
      const content = element.innerHTML
      const current = () => {
        if (copyOwner.current !== owner || chartsRef.current !== element || copyButtonRef.current !== button || element.innerHTML !== content) return false
        const rect = element.getBoundingClientRect()
        const action = button.getBoundingClientRect()
        return rect.x === bounds.x && rect.y === bounds.y && rect.width === bounds.width && rect.height === bounds.height
          && action.x === buttonBounds.x && action.y === buttonBounds.y && action.width === buttonBounds.width && action.height === buttonBounds.height
      }
      const image = await captureStableChart(() => window.radarDesktop.request({ captureChart: { ...bounds, output: 'png' } }), current)
      if (copyOwner.current !== owner) return
      if (!current()) throw new Error('Chart changed during capture. Start again.')
      const background = getComputedStyle(document.documentElement).getPropertyValue('--background')
      const dataURL = await eraseCapturedAction(image.imageDataURL, bounds, buttonBounds, background)
      if (copyOwner.current !== owner) return
      if (!current()) throw new Error('Chart changed during capture. Start again.')
      const result = await window.radarDesktop.request({ copyImage: dataURL })
      if (!result.ok) throw new Error('Could not copy chart.')
      if (copyOwner.current === owner) setCopyState({ status: 'copied', error: '' })
    } catch (cause) {
      if (copyOwner.current === owner) {
        const detail = cause instanceof Error ? cause.message : ''
        const error = detail === 'Charts are still loading. Try again when all three are ready.' ? detail
          : detail === 'Chart changed before capture. Start again.' || detail === 'Chart changed during capture. Start again.' ? 'Charts changed during capture. Try again.'
          : 'Could not copy the chart. Try again.'
        setCopyState({ status: 'failed', error })
      }
    }
  }

  const issues: { id: string; label: string; detail: string; severity: 'error' | 'warning' | 'info'; frame?: RadarTimeframe }[] = []
  if (presentation.error) issues.push({ id: 'presentation', label: 'Application', detail: 'The data service could not restore the workspace. Check the data service and try again.', severity: 'error' })
  if (preferencesError) issues.push({ id: 'preferences', label: 'Settings', detail: 'Settings could not be loaded. Check the local data service.', severity: 'error' })
  if (error) issues.push({ id: 'market-error', label: 'Market', detail: 'Market data is unavailable. Check the connection and data service.', severity: 'error' })
  if (connectionProblem) issues.push({ id: 'connection', label: 'Market', detail: `${connectionFailure ? 'Market connection interrupted' : 'Waiting for a live market connection'}. Check the connection for current prices.`, severity: 'warning' })
  if (status !== 'Live' && status !== 'Connecting') issues.push({ id: 'catalog', label: 'Contracts', detail: status === 'Cached' ? 'Cached market data' : status, severity: status === 'Incomplete' || status === 'Unavailable' || status === 'Cached' ? 'warning' : 'info' })
  if (copyState.error) issues.push({ id: 'copy', label: 'Copy chart', detail: copyState.error, severity: 'error' })
  // App owns the authoritative job snapshots. Settings only contributes local
  // requests and request errors so an older settings view cannot mask a newer
  // background snapshot from another service session.
  const transientSettingsStatuses = settingsStatuses.filter(item => !['data-audit', 'history-download'].includes(item.id) || item.transient)
  for (const item of transientSettingsStatuses) issues.push({ ...item, id: `settings-${item.id}` })
  if (auditStatusUnavailable && !transientSettingsStatuses.some(item => item.id === 'data-audit')) issues.push({ id: 'data-audit-status', label: 'Data audit', detail: 'Audit status unavailable. Check the data service in Data settings.', severity: 'warning' })
  if (downloadStatusUnavailable && !transientSettingsStatuses.some(item => item.id === 'history-download')) issues.push({ id: 'history-download-status', label: 'History download', detail: 'Download status unavailable. Check the data service in Data settings.', severity: 'warning' })
  if (globalAudit && !transientSettingsStatuses.some(item => item.id === 'data-audit')) {
    if (globalAudit.error || globalAudit.phase === 'failed') issues.push({ id: 'data-audit', label: 'Data audit', detail: 'Audit failed. Check the data service and retry.', severity: 'error' })
    else if (globalAudit.phase === 'running' || globalAudit.phase === 'validating') issues.push({ id: 'data-audit', label: 'Data audit', detail: globalAudit.phase === 'validating' ? 'Validating recent changes. Results are provisional.' : `Audit running · ${globalAudit.progress.completed} / ${globalAudit.progress.total}`, severity: 'info' })
    else if (globalAudit.issues.length) issues.push({ id: 'data-audit', label: 'Data audit', detail: `${globalAudit.issues.length} issues found. Review them in Data settings.`, severity: 'warning' })
    else if (globalAudit.phase === 'completed' || globalAudit.phase === 'cancelled') issues.push({ id: 'data-audit', label: 'Data audit', detail: globalAudit.phase === 'completed' ? 'Audit complete.' : 'Audit cancelled.', severity: 'info' })
  }
  if (globalDownload && !transientSettingsStatuses.some(item => item.id === 'history-download')) {
    if (globalDownload.error || globalDownload.phase === 'failed') issues.push({ id: 'history-download', label: 'History download', detail: 'Download failed. Check the data service and retry.', severity: 'error' })
    else if (globalDownload.phase === 'running') issues.push({ id: 'history-download', label: 'History download', detail: `Downloading history · ${globalDownload.progress.checked} / ${globalDownload.progress.total}`, severity: 'info' })
    else if (globalDownload.phase === 'completed' && (globalDownload.progress.empty || globalDownload.progress.unavailable || globalDownload.progress.failed)) issues.push({ id: 'history-download', label: 'History download', detail: 'Download finished with incomplete coverage. Review Data settings.', severity: 'warning' })
    else if (globalDownload.phase === 'completed' || globalDownload.phase === 'cancelled') issues.push({ id: 'history-download', label: 'History download', detail: globalDownload.phase === 'completed' ? 'Download complete.' : 'Download cancelled.', severity: 'info' })
  }
  for (const frame of ['1H', '15m', '5m'] as const) {
    const value = chartStatuses[frame]
    if (value) issues.push({ id: frame, label: timeframeLabel(frame), ...value, frame })
  }
  const rankedIssues = [...issues].sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]))
  const errorKey = JSON.stringify(rankedIssues.filter(issue => issue.severity === 'error').map(({ id, label, detail }) => ({ id, label, detail })))
  const previousErrors = useRef(new Map<string, string>())
  const [errorAnnouncement, setErrorAnnouncement] = useState('')
  useLayoutEffect(() => {
    const errors = JSON.parse(errorKey) as { id: string; label: string; detail: string }[]
    const added = errors.filter(error => !previousErrors.current.has(error.id))
    const changed = errors.filter(error => previousErrors.current.get(error.id) !== error.detail)
    if (added.length && statusRow.current) statusRow.current.scrollTop = 0
    setErrorAnnouncement(changed.map(error => `${error.label}: ${error.detail}`).join('. '))
    previousErrors.current = new Map(errors.map(error => [error.id, error.detail]))
  }, [errorKey])
  const statusText = updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-US')}` : 'Waiting for market data'

  return <WorkspaceViewport>
    <div className="relative flex h-full min-w-0 flex-1">
    <div hidden={settingsSection !== null} inert={settingsSection !== null} className={cn('h-full min-w-0 flex-1', settingsSection === null ? 'flex' : 'hidden')}>
    <aside data-market-list className="flex w-[var(--market-list-width)] shrink-0 flex-col border-r" style={{ height: `calc(100% - ${statusHeight}px)` }} aria-label="Contract list">
      <header data-sidebar-toolbar data-window-toolbar data-window-drag-region data-native-window-controls-row className="flex items-center gap-3 border-b px-4"><h1 className="min-w-0 flex-1 truncate text-sm font-medium">Perpetual Swap Suite</h1><a ref={settingsLauncher} href={settingsHref('workspace')} aria-label="Settings" title="Settings" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}><Settings2 aria-hidden="true" /></a></header>
      <section data-market-scroll className="min-h-0 flex-1 overflow-y-auto [&>[data-slot=table-container]]:overflow-visible" aria-label="Perpetual swap markets">
        <Table className="table-fixed [&_tr:not([data-virtual-spacer])>:first-child]:pl-4 [&_tr:not([data-virtual-spacer])>:last-child]:pr-4" data-market-count={visible.length} data-total-market-count={rows.length} aria-rowcount={visible.length + 1}>
          <colgroup><col className="w-[35%]" /><col className="w-[33%]" /><col className="w-[32%]" /></colgroup>
          <TableHeader className="sticky top-0 bg-background [&_th]:text-xs [&_th]:text-muted-foreground"><TableRow className="hover:bg-transparent"><TableHead>Contract</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right" aria-sort="other" aria-label={`${preferences.rankingLookback}m change By magnitude`} title="Sorted by absolute signed relative change from completed candles, largest first"><span>{preferences.rankingLookback}m change</span></TableHead></TableRow></TableHeader>
          {visible.length ? <MarketRowsViewport ids={visibleIds}>{index => <MarketRowView row={visible[index]} index={index} selected={visible[index].instId === selectedID} lookback={preferences.rankingLookback} onSelect={setSelected} />}</MarketRowsViewport> : <TableBody><TableRow><TableCell colSpan={3}>
            <Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{emptyDescription}</EmptyDescription></EmptyHeader></Empty>
          </TableCell></TableRow></TableBody>}
        </Table>
      </section>
    </aside>
    <section data-chart-panel className="h-full min-w-0 flex-1" aria-label="Market chart workspace">
      {selectedID ? <div data-chart-display-mode="multi" className="flex h-full min-h-0 flex-col">
        <span role="status" className="sr-only">{copyState.status === 'copying' ? 'Copying chart' : copyState.status === 'copied' ? 'Chart copied to clipboard' : ''}</span>
        <div ref={chartsRef} data-chart-capture className="flex min-h-0 flex-1 flex-col">
          <header data-chart-toolbar data-window-toolbar data-window-drag-region className="flex shrink-0 items-center gap-3 border-b px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h2 data-chart-title data-shared-chart-title className="max-w-32 truncate" title={selectedID}>{selectedID.replace(/-SWAP$/, '')}</h2>
              {sharedPriceText !== undefined && <><span className="sr-only">Market price</span><span data-shared-chart-price className="max-w-32 truncate" title={sharedPriceText}>{sharedPriceText}</span></>}
            </div>
            <Button ref={copyButtonRef} data-window-no-drag variant="outline" size="sm" disabled={copyState.status === 'copying'} onClick={() => { void copyChart() }}><Camera data-icon="inline-start" aria-hidden="true" />{copyState.status === 'copying' ? 'Copying…' : copyState.status === 'copied' ? 'Copied' : 'Copy chart'}</Button>
          </header>
          <ChartTimeSyncProvider key={selectedID}><div className="grid min-h-0 flex-1 grid-rows-3 divide-y" data-multi-timeframe-charts>
            {(['1H', '15m', '5m'] as const).map((frame, index) => <MarketChart key={frame} controller={multiChartControllers[frame]} priceOnly onStatus={updateChartStatus} navigation={index === 0} active={settingsSection === null} instId={selectedID} tickSz={selectedRow?.tickSz} timeframe={frame} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={setSelected} />)}
          </div></ChartTimeSyncProvider>
        </div>
      </div> : <div className="flex h-full items-center justify-center"><Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{verifying || verificationUnavailable ? emptyDescription : 'Enable different liquidity conditions to view a chart.'}</EmptyDescription></EmptyHeader></Empty></div>}
    </section>
    </div>
    {lastVisibleSettings.current && <div hidden={!settingsSection} inert={!settingsSection} className={cn('min-w-0 flex-1', settingsSection ? 'flex' : 'hidden')} style={{ height: `calc(100% - ${statusHeight}px)` }}><DeferredPanel name="Settings" className="p-4 pb-8" onClose={() => { window.location.hash = '#/' }}><WorkspaceSettings section={settingsSection ?? lastVisibleSettings.current} active={settingsSection !== null} preferences={preferences} loaded={preferencesLoaded} loadError={preferencesError} onSave={savePreferences} onNavigationStateChange={updateSettingsGuard} onStatusChange={updateSettingsStatuses} onJobSnapshot={receiveSettingsJob} /></DeferredPanel></div>}
    <footer ref={statusRow} data-market-status-row tabIndex={0} aria-label="Application status" onKeyDown={event => {
      const row = event.currentTarget
      if (row.scrollHeight <= row.clientHeight) return
      const offset = event.key === 'ArrowDown' ? row.clientHeight / 4 : event.key === 'ArrowUp' ? -row.clientHeight / 4
        : event.key === 'PageDown' ? row.clientHeight : event.key === 'PageUp' ? -row.clientHeight : null
      if (offset !== null) { event.preventDefault(); row.scrollTop += offset }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); row.scrollTop = event.key === 'Home' ? 0 : row.scrollHeight }
    }} className="absolute bottom-0 left-0 z-20 max-h-[40%] w-[var(--market-list-width)] max-w-full overflow-y-auto bg-background px-4 py-1 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <span role="status" aria-atomic="true" className="sr-only">{errorAnnouncement}</span>
      <div data-status-details data-market-status>
        {rankedIssues.map(issue => <p key={issue.id} role={issue.severity === 'error' ? undefined : 'status'} aria-atomic="true" data-chart-shared-status-item={issue.frame} data-timeframe={issue.frame} data-chart-status={issue.frame !== undefined ? '' : undefined} className={cn('break-words py-1', issue.severity === 'error' && 'text-destructive')}><span className="font-medium">{issue.label}: </span>{issue.detail}</p>)}
        <p aria-live="off">{statusText}</p>
      </div>
    </footer>
    </div>
  </WorkspaceViewport>
}
export default App
