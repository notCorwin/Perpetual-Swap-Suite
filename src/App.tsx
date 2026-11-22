import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ChartTimeSyncProvider, MarketChart, type SharedChartStatusValue } from '@/MarketChart'
import { MarketRowsViewport } from '@/MarketRowsViewport'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { chartCoordinator, multiChartControllers, ingestPreparedChart } from '@/chart-controller'
import { reconcileMarketOrder, reconcileMarketRows } from '@/market-snapshot'
import { SnapshotOrder } from '@/snapshot-order'
import { CHART_PRIMARY_TIMEFRAME, DEFAULT_PREFERENCES, type Preferences } from '@/renderer-preferences'
import type { DataAudit, HistoryDownload, MarketSnapshot, RankedMarketRow, UnchangedSnapshot } from '@/desktop-contract'
import type { PreparedChartNotification } from '@/chart-data'
import { cn } from '@/lib/utils'
import { formatCurrentPrice } from '@/price-format'
import { formatPercent } from '@/market-percent'
import { getPresentation, subscribePresentationTransition, usePresentation } from '@/presentation-store'
import { timeframeLabel, type RadarTimeframe } from '@/timeframe'

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

type ToastIssue = { id: string; label: string; detail: string; severity: string; instance: number }

function NotificationPanel({ issue, setToast }: { issue: ToastIssue; setToast: Dispatch<SetStateAction<ToastIssue[]>> }) {
  useEffect(() => {
    const timer = window.setTimeout(() => setToast(shown => shown.filter(item => item.instance !== issue.instance)), 7000)
    return () => window.clearTimeout(timer)
  }, [issue.instance, setToast])
  return <p data-chart-shared-status-item={['1H', '15m', '5m'].includes(issue.id) ? issue.id : undefined} className={cn('break-words rounded-md border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg', issue.severity === 'error' && 'text-destructive')}><span className="font-medium">{issue.label}: </span>{issue.detail}</p>
}

const MarketRowView = memo(function MarketRowView({ row, index, selected, lookback, onSelect }: { row: RankedMarketRow; index: number; selected: boolean; lookback: number; onSelect: (id: string) => void }) {
  const change = Number.isFinite(row.rankingChange) ? row.rankingChange : null
  const changeDirection = change === null ? 'unavailable' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
  const changeText = formatPercent(change)
  const price = formatCurrentPrice(row.lastPrice, row.tickSz)
  return <TableRow data-market-index={index} aria-rowindex={index + 2} aria-selected={selected} data-state={selected ? 'selected' : undefined} tabIndex={0} aria-label={`View ${row.instId} chart`} onClick={() => onSelect(row.instId)} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.instId) }
  }} className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2">
    <TableCell className="font-medium" title={row.instId}><span className="block truncate">{row.instId.replace(/-USDT-SWAP$/, '')}</span></TableCell>
    <TableCell className="text-right"><span className="block truncate" title={price}>{price}</span></TableCell>
    <TableCell data-market-change={changeDirection} aria-label={`${lookback}-minute change: ${changeText}, ${changeDirection === 'up' ? 'up' : changeDirection === 'down' ? 'down' : changeDirection === 'flat' ? 'unchanged' : 'unavailable'}`} className={cn('text-right', changeDirection === 'up' ? 'text-positive' : changeDirection === 'down' ? 'text-negative' : changeDirection === 'flat' ? 'text-foreground' : 'text-muted-foreground')} title={row.rankingAsOf ? `${lookback}-minute signed relative change · completed candle as of ${new Date(row.rankingAsOf).toLocaleString('en-US')}` : 'Completed candle ranking is not available'}>
      <span className="block truncate">{changeText}</span>
    </TableCell>
  </TableRow>
})

function App() {
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
  const updatedAt = useRef<number | null>(null)
  const lastCatalogProgress = useRef<MarketSnapshot['catalogProgress']>(undefined)
  const [globalAudit, setGlobalAudit] = useState<DataAudit | null>(null)
  const [globalDownload, setGlobalDownload] = useState<HistoryDownload | null>(null)
  const [auditStatusUnavailable, setAuditStatusUnavailable] = useState(false)
  const [downloadStatusUnavailable, setDownloadStatusUnavailable] = useState(false)
  const auditOrder = useRef(new SnapshotOrder())
  const downloadOrder = useRef(new SnapshotOrder())
  const receiveAudit = useCallback((value: DataAudit) => { if (auditOrder.current.accept(value)) { setGlobalAudit(value); setAuditStatusUnavailable(false) } }, [])
  const receiveDownload = useCallback((value: HistoryDownload) => { if (downloadOrder.current.accept(value)) { setGlobalDownload(value); setDownloadStatusUnavailable(false) } }, [])
  const order = useRef(new SnapshotOrder())
  const retainSelection = useRef(false)
  const preferenceWrite = useRef(0)
  const timeframe = CHART_PRIMARY_TIMEFRAME
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
    if (snapshot.updatedAt !== undefined) updatedAt.current = snapshot.updatedAt
    if (snapshot.catalogProgress !== undefined) lastCatalogProgress.current = snapshot.catalogProgress
    if (snapshot.realtimeState) setRealtime(snapshot.realtimeState)
    else if (!('unchanged' in snapshot)) setRealtime('Unavailable')
  }, [])
  useLayoutEffect(() => subscribePresentationTransition(update => {
    if (!update.active) { retainSelection.current = true; chartCoordinator.setPresentationActive(false); return }
    if (update.snapshot) {
      preferenceWrite.current += 1
      chartCoordinator.setPresentationActive(true, update.snapshot.frames)
      applyMarket(update.snapshot.market, true)
      receiveAudit(update.snapshot.audit)
      receiveDownload(update.snapshot.download)
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
    const receive = (event: Event) => {
      preferenceWrite.current += 1
      const value = (event as CustomEvent<Preferences>).detail
      setPreferences(value); setPreferencesError(''); setPreferencesLoaded(true)
    }
    window.addEventListener('radar-preferences-changed', receive)
    return () => window.removeEventListener('radar-preferences-changed', receive)
  }, [])
  useEffect(() => {
    let stopped = false
    const write = preferenceWrite.current
    const epoch = getPresentation().epoch
    window.radarDesktop.request({ preferences: { action: 'read' } }).then(value => {
      if (!stopped && getPresentation().active && epoch === getPresentation().epoch && write === preferenceWrite.current) { setPreferences(value); setPreferencesError('') }
    }).catch(cause => { if (!stopped && getPresentation().active && epoch === getPresentation().epoch && write === preferenceWrite.current) setPreferencesError(message(cause)) }).finally(() => { if (!stopped && getPresentation().active && epoch === getPresentation().epoch) setPreferencesLoaded(true) })
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
  const focusChartAfterSelection = useRef(false)
  const selectFromChart = useCallback((id: string) => {
    focusChartAfterSelection.current = true
    setSelected(id)
  }, [])
  useLayoutEffect(() => {
    if (!focusChartAfterSelection.current) return
    focusChartAfterSelection.current = false
    document.querySelector<SVGElement>('[data-timeframe-panel="1H"] [data-chart-plot]')?.focus({ preventScroll: true })
  }, [selectedID])
  const connectionProblem = !['live', 'connected'].includes(realtime.toLowerCase())
  const connectionFailure = ['reconnecting', 'disconnected', 'unavailable'].includes(realtime.toLowerCase())
  const listOrder = candidateIds
  useEffect(() => { if (ready) void chartCoordinator.setUniverse(retainedChart && selectedID ? [...candidateIds, selectedID] : candidateIds, timeframe) }, [ready, candidateIds, timeframe, retainedChart, selectedID])
  const screenshotOwner = useRef<object | null>(null)
  const screenshotPending = useRef(false)
  const [copyState, setCopyState] = useState<{ status: 'idle' | 'copied' | 'failed'; error: string; revision: number }>({ status: 'idle', error: '', revision: 0 })
  useEffect(() => () => { screenshotOwner.current = null; screenshotPending.current = false }, [])
  useEffect(() => {
    if (copyState.status !== 'copied') return
    const timer = window.setTimeout(() => setCopyState(current => ({ ...current, status: 'idle', error: '' })), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState.status, copyState.revision])
  const screenshot = async () => {
    if (screenshotOwner.current) { screenshotPending.current = true; return }
    const owner = {}
    screenshotOwner.current = owner
    try {
      const result = await window.radarDesktop.request({ screenshot: {} })
      if (!result.ok) throw new Error('Screenshot failed.')
      if (screenshotOwner.current === owner) setCopyState(current => ({ status: 'copied', error: '', revision: current.revision + 1 }))
    } catch {
      if (screenshotOwner.current === owner) {
        const detail = 'Could not copy the screenshot. Check the clipboard and try again.'
        const issue = { id: 'copy', label: 'Screenshot', detail, severity: 'error', instance: ++toastSequence.current }
        setCopyState(current => ({ status: 'failed', error: detail, revision: current.revision + 1 }))
        setToast(shown => [...shown.slice(0, 3), ...[...shown.slice(3), issue].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))].slice(0, 32))
      }
    } finally {
      if (screenshotOwner.current === owner) {
        screenshotOwner.current = null
        if (screenshotPending.current) { screenshotPending.current = false; void screenshot() }
      }
    }
  }

  const issues: { id: string; label: string; detail: string; severity: 'error' | 'warning' | 'info'; frame?: RadarTimeframe }[] = []
  if (presentation.error) issues.push({ id: 'presentation', label: 'Application', detail: 'The data service could not restore the workspace. Check the data service and try again.', severity: 'error' })
  if (preferencesError) issues.push({ id: 'preferences', label: 'Settings', detail: 'Settings could not be loaded. Check the local data service.', severity: 'error' })
  if (error) issues.push({ id: 'market-error', label: 'Market', detail: 'Market data is unavailable. Check the connection and data service.', severity: 'error' })
  if (connectionProblem) issues.push({ id: 'connection', label: 'Market', detail: `${connectionFailure ? 'Market connection interrupted' : 'Waiting for a live market connection'}. Check the connection for current prices.`, severity: 'warning' })
  if (status !== 'Live' && status !== 'Connecting') issues.push({ id: 'catalog', label: 'Contracts', detail: status === 'Cached' ? 'Cached contract data. Check the connection for current contracts.' : status === 'Unavailable' ? 'Contract verification is unavailable. Check the connection and data service.' : status, severity: status === 'Incomplete' || status === 'Unavailable' || status === 'Cached' ? 'warning' : 'info' })
  if (copyState.error) issues.push({ id: 'copy', label: 'Screenshot', detail: copyState.error, severity: 'error' })
  if (auditStatusUnavailable) issues.push({ id: 'data-audit-status', label: 'Data audit', detail: 'Audit status unavailable. Check the data service in Data settings.', severity: 'warning' })
  if (downloadStatusUnavailable) issues.push({ id: 'history-download-status', label: 'History download', detail: 'Download status unavailable. Check the data service in Data settings.', severity: 'warning' })
  if (globalAudit) {
    if (globalAudit.error || globalAudit.phase === 'failed') issues.push({ id: 'data-audit', label: 'Data audit', detail: 'Audit failed. Check the data service and retry.', severity: 'error' })
    else if (globalAudit.phase === 'running' || globalAudit.phase === 'validating') issues.push({ id: 'data-audit', label: 'Data audit', detail: globalAudit.phase === 'validating' ? 'Validating recent changes. Results are provisional.' : `Audit running · ${globalAudit.progress.completed} / ${globalAudit.progress.total}`, severity: 'info' })
    else if (globalAudit.issues.length) issues.push({ id: 'data-audit', label: 'Data audit', detail: `${globalAudit.issues.length} issues found. Review them in Data settings.`, severity: 'warning' })
    else if (globalAudit.phase === 'completed' || globalAudit.phase === 'cancelled') issues.push({ id: 'data-audit', label: 'Data audit', detail: globalAudit.phase === 'completed' ? 'Audit complete.' : 'Audit cancelled.', severity: 'info' })
  }
  if (globalDownload) {
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
  const toastIssues = rankedIssues.filter(issue => issue.id !== 'copy' && (issue.id !== 'catalog' || status === 'Unavailable' || status === 'Cached') && issue.severity !== 'info' && (issue.id !== 'connection' || connectionFailure))
  const toastKey = JSON.stringify(toastIssues.map(({ id, label, detail, severity }) => ({ id, label, detail, severity })))
  const previousToastIssues = useRef(new Map<string, string>())
  const toastSequence = useRef(0)
  const [toast, setToast] = useState<ToastIssue[]>([])
  useEffect(() => {
    const current = JSON.parse(toastKey) as Omit<ToastIssue, 'instance'>[]
    const signature = (issue: Omit<ToastIssue, 'instance'>) => JSON.stringify([issue.label, issue.detail, issue.severity])
    const added = current.filter(issue => previousToastIssues.current.get(issue.id) !== signature(issue))
    previousToastIssues.current = new Map(current.map(issue => [issue.id, signature(issue)]))
    const instances = added.map(issue => ({ ...issue, instance: ++toastSequence.current }))
    if (instances.length) setToast(shown => {
      const remaining = shown.filter(issue => !instances.some(next => next.id === issue.id))
      const visible = remaining.slice(0, 3)
      const pending = [...remaining.slice(3), ...instances].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
      return [...visible, ...pending].slice(0, 32)
    })
  }, [toastKey])
  const logStatus = status.startsWith('Verifying ') ? 'Verifying' : status.startsWith('Updating ') ? 'Updating' : status
  const logIssues = rankedIssues.filter(issue => issue.id !== 'catalog' && issue.severity !== 'info').map(issue => `${issue.label}: ${issue.detail}`)
  if (globalAudit && globalAudit.phase !== 'idle') logIssues.push(`Data audit phase: ${globalAudit.phase}`)
  if (globalDownload && globalDownload.phase !== 'idle') logIssues.push(`History download phase: ${globalDownload.phase}`)
  const logCause = [error, presentation.error, preferencesError, globalAudit?.error, globalDownload?.error].filter(Boolean).join('; ').slice(0, 1024)
  const statusKey = JSON.stringify({ status: logStatus, realtime, issues: logIssues, cause: logCause })
  const lastLoggedStatus = useRef('')
  useEffect(() => {
    if (statusKey === lastLoggedStatus.current) return
    const detail = JSON.parse(statusKey) as { status: string; realtime: string; issues: string[]; cause: string }
    let cancelled = false
    let retryTimer: number | undefined
    const write = (attempt: number) => {
      void window.radarDesktop.request({ statusLog: { ...detail, updatedAt: updatedAt.current, catalog: lastCatalogProgress.current ?? null } }).then(() => {
        if (!cancelled) lastLoggedStatus.current = statusKey
      }).catch(cause => {
        if (cancelled) return
        if (attempt < 3) retryTimer = window.setTimeout(() => write(attempt + 1), 5000)
        else console.error('Could not write market status log.', cause)
      })
    }
    write(1)
    return () => { cancelled = true; window.clearTimeout(retryTimer) }
  }, [statusKey])

  const renderChart = (frame: '1H' | '15m' | '5m', navigation = false) => <div key={frame} data-timeframe-panel={frame} className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background">
    {selectedID ? <MarketChart controller={multiChartControllers[frame]} priceOnly showBollingerPriceLabels={preferences.showBollingerPriceLabels} onStatus={updateChartStatus} navigation={navigation} instId={selectedID} tickSz={selectedRow?.tickSz} timeframe={frame} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={selectFromChart} /> : <div className="flex h-full items-center justify-center"><Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{verifying || verificationUnavailable ? emptyDescription : 'Enable different liquidity conditions to view a chart.'}</EmptyDescription></EmptyHeader></Empty></div>}
  </div>

  return <WorkspaceViewport>
    <div className="relative flex h-full min-w-0 flex-1">
      {toast.length > 0 && <div data-market-status role="status" aria-atomic="false" className="pointer-events-none absolute bottom-4 left-4 z-50 flex max-w-[min(28rem,90%)] flex-col gap-2" aria-label="Application notifications">
        {toast.slice(0, 3).map(issue => <NotificationPanel key={issue.instance} issue={issue} setToast={setToast} />)}
      </div>}
      <div className="flex h-full min-w-0 flex-1">
        <section data-chart-panel className="h-full min-w-0 flex-1" aria-label="Market chart workspace">
          <div data-chart-display-mode="multi" className="flex h-full min-h-0 flex-col">
            <span role="status" className="sr-only">{copyState.status === 'copied' ? 'Screenshot copied to clipboard' : ''}</span>
            <div className="flex min-h-0 flex-1 flex-col">
              <header data-chart-toolbar data-window-toolbar data-window-drag-region className="flex shrink-0 items-center gap-3 px-4">
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <h1 className="sr-only">Perpetual Swap Suite</h1>
                  {selectedID && <h2 data-chart-title data-shared-chart-title className="max-w-32 truncate" title={selectedID}>{selectedID.replace(/-SWAP$/, '')}</h2>}
                  {sharedPriceText !== undefined && <><span className="sr-only">Market price</span><span data-shared-chart-price className="max-w-32 truncate" title={sharedPriceText}>{sharedPriceText}</span></>}
                </div>
                <Button data-window-no-drag aria-label="Screenshot" variant="outline" size="sm" onClick={() => { void screenshot() }}><Camera data-icon="inline-start" aria-hidden="true" />{copyState.status === 'copied' ? 'Copied' : 'Screenshot'}</Button>
              </header>
              <ChartTimeSyncProvider key={selectedID}><div className="grid min-h-0 flex-1 grid-rows-2 gap-2 p-2 pt-0" data-multi-timeframe-charts>
                <div className="flex min-h-0 min-w-0 gap-2">
                <div data-market-panel className="flex min-h-0 w-[max(var(--market-list-min-width),var(--market-list-share))] min-w-0 shrink-0 flex-col overflow-hidden rounded-lg border bg-background">
                  <aside data-market-list className="flex min-h-0 flex-1 flex-col" aria-label="Contract list">
      <section data-market-scroll className="min-h-0 flex-1 overflow-y-auto [&>[data-slot=table-container]]:overflow-visible" aria-label="Perpetual swap markets">
        <Table className="table-fixed [&_tr:not([data-virtual-spacer])>:first-child]:pl-4 [&_tr:not([data-virtual-spacer])>:last-child]:pr-4" data-market-count={visible.length} data-total-market-count={rows.length} aria-rowcount={visible.length + 1}>
          <colgroup><col className="w-[25%]" /><col className="w-[45%]" /><col className="w-[30%]" /></colgroup>
          <TableHeader className="sticky top-0 bg-background [&_th]:text-xs [&_th]:text-muted-foreground"><TableRow className="hover:bg-transparent"><TableHead>Contract</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right" aria-sort="other" aria-label={`${preferences.rankingLookback}m change By magnitude`} title="Sorted by absolute signed relative change from completed candles, largest first"><span>{preferences.rankingLookback}m Δ%</span></TableHead></TableRow></TableHeader>
          {visible.length ? <MarketRowsViewport ids={visibleIds}>{index => <MarketRowView row={visible[index]} index={index} selected={visible[index].instId === selectedID} lookback={preferences.rankingLookback} onSelect={setSelected} />}</MarketRowsViewport> : <TableBody><TableRow><TableCell colSpan={3}>
            <Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{emptyDescription}</EmptyDescription></EmptyHeader></Empty>
          </TableCell></TableRow></TableBody>}
        </Table>
      </section>
                  </aside>
                </div>
                {renderChart('1H', true)}
                </div>
                <div className="flex min-h-0 min-w-0 gap-2">
                  {renderChart('15m')}
                  {renderChart('5m')}
                </div>
              </div></ChartTimeSyncProvider>
            </div>
          </div>
        </section>
      </div>
    </div>
  </WorkspaceViewport>
}
export default App
