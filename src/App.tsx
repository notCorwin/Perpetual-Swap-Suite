import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { MarketChart } from '@/MarketChart'
import { MarketRowsViewport } from '@/MarketRowsViewport'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { WorkspaceSettings } from '@/WorkspaceSettings'
import { settingsHref, useSettingsSection, type SettingsNavigationState } from '@/settings-navigation'
import { chartController } from '@/chart-controller'
import { reconcileMarketOrder, reconcileMarketRows } from '@/market-snapshot'
import { SnapshotOrder } from '@/snapshot-order'
import { DEFAULT_PREFERENCES, type Preferences } from '@/renderer-preferences'
import type { MarketSnapshot, RankedMarketRow, UnchangedSnapshot } from '@/desktop-contract'
import type { PreparedChartNotification } from '@/chart-data'
import type { RadarTimeframe } from '@/timeframe'
import { cn } from '@/lib/utils'

const priceFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 })
const formatPrice = (value: number | null | undefined) => value == null ? '—' : priceFormatter.format(value)
const qualificationPending = (progress: MarketSnapshot['catalogProgress']) => !progress || progress.total === 0 || progress.completed < progress.total || progress.pending > 0
const collectorStatus = (snapshot: MarketSnapshot | UnchangedSnapshot) => {
  const catalog = snapshot.catalogProgress
  if (snapshot.loading && catalog && catalog.total > 0) {
    if (catalog.completed < catalog.total) return `Verifying ${catalog.completed}/${catalog.total}`
    if (catalog.pending > 0) return `Updating ${catalog.pending} contracts`
  }
  if (snapshot.error || catalog && catalog.unknown > 0) return snapshot.catalogSource === 'none' ? 'Unavailable' : 'Incomplete'
  if (snapshot.loading) return 'Refreshing'
  return snapshot.catalogSource === 'cache' ? 'Cached' : snapshot.catalogSource === 'none' ? 'Waiting' : 'Live'
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The desktop data service could not complete this request.'

const MarketRowView = memo(function MarketRowView({ row, index, selected, lookback, onSelect }: { row: RankedMarketRow; index: number; selected: boolean; lookback: number; onSelect: (id: string) => void }) {
  const change = Number.isFinite(row.rankingChange) ? row.rankingChange : null
  return <TableRow data-market-index={index} aria-rowindex={index + 2} aria-selected={selected} data-state={selected ? 'selected' : undefined} tabIndex={0} aria-label={`View ${row.instId} chart`} onClick={() => onSelect(row.instId)} onKeyDown={event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.instId) }
  }} className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2">
    <TableCell className="font-medium" title={row.instId}><span className="block truncate">{row.instId.replace(/-USDT-SWAP$/, '')}</span></TableCell>
    <TableCell className="text-right">{formatPrice(row.lastPrice)}</TableCell>
    <TableCell className="text-right" title={row.rankingAsOf ? `${lookback}-minute signed relative change · completed candle as of ${new Date(row.rankingAsOf).toLocaleString('en-US')}` : 'Completed candle ranking is not available'}>
      <span className="inline-flex items-center justify-end gap-1"><span aria-hidden="true" className={cn(change === null ? 'text-muted-foreground' : change > 0 ? 'text-positive' : change < 0 ? 'text-negative' : 'text-muted-foreground')}>{change === null ? '' : change > 0 ? '↑' : change < 0 ? '↓' : '→'}</span><span>{change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`}</span></span>
    </TableCell>
  </TableRow>
})

function App() {
  const settingsGuard = useRef<SettingsNavigationState>({ dirty: false, busy: false })
  const settingsSection = useSettingsSection(settingsGuard)
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
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  const [catalog, setCatalog] = useState<Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'catalogProgress'>>({ loading: true, catalogSource: 'none' })
  const [status, setStatus] = useState('Connecting')
  const [realtime, setRealtime] = useState('Connecting')
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const order = useRef(new SnapshotOrder())
  const preferenceWrite = useRef(0)
  const timeframe = preferences.chartTimeframe

  useEffect(() => {
    const receive = (event: Event) => chartController.ingestPrepared((event as CustomEvent<PreparedChartNotification>).detail)
    window.addEventListener('radar-chart-prepared', receive)
    return () => window.removeEventListener('radar-chart-prepared', receive)
  }, [])
  useEffect(() => {
    let stopped = false
    const write = preferenceWrite.current
    window.radarDesktop.request({ preferences: { action: 'read' } }).then(value => {
      if (!stopped && write === preferenceWrite.current) { setPreferences(value); setPreferencesError('') }
    }).catch(cause => { if (!stopped) setPreferencesError(message(cause)) }).finally(() => { if (!stopped) setPreferencesLoaded(true) })
    return () => { stopped = true }
  }, [])
  useEffect(() => {
    if (!preferencesLoaded) return
    let stopped = false
    let working = false
    let queued = false
    const visible = () => document.visibilityState !== 'hidden'
    const load = async () => {
      if (stopped) return
      if (working) { queued = true; return }
      if (!visible()) { queued = true; return }
      working = true
      queued = false
      try {
        const snapshot = await window.radarDesktop.request({ snapshot: { sinceRevision: order.current.revision, serviceSession: order.current.serviceSession } })
        if (stopped) return
        if (order.current.accept(snapshot)) {
          if (!('unchanged' in snapshot)) {
            const unverified = snapshot.loading && qualificationPending(snapshot.catalogProgress) || snapshot.error || snapshot.catalogSource === 'none' || (snapshot.catalogProgress?.unknown ?? 0) > 0
            // Membership and order come from the backend, independently of charts.
            setRows(current => reconcileMarketRows(current, snapshot.rows))
            setCandidateIds(current => reconcileMarketOrder(current, snapshot.rows.map(row => row.instId)))
            setTurnoverOrder(current => reconcileMarketOrder(current, snapshot.turnoverOrder))
            setSelected(current => snapshot.rows.some(row => row.instId === current) || (!snapshot.rows.length && unverified) ? current : snapshot.rows[0]?.instId ?? null)
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
        }
      } catch (cause) {
        if (stopped) return
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
  }, [preferencesLoaded])

  const visible = useMemo(() => rows.filter(row => row.instId.toLowerCase().includes(query.trim().toLowerCase())), [rows, query])
  const visibleIds = useMemo(() => candidateIds.filter(id => id.toLowerCase().includes(query.trim().toLowerCase())), [candidateIds, query])
  const verifying = Boolean(catalog.loading) && qualificationPending(catalog.catalogProgress) || (!ready && !error)
  const awaitingObservations = Boolean(catalog.loading && catalog.catalogProgress && catalog.catalogProgress.completed === catalog.catalogProgress.total && catalog.catalogProgress.pending > 0)
  const verificationUnavailable = !verifying && (Boolean(error) || catalog.catalogSource === 'none' || (catalog.catalogProgress?.unknown ?? 0) > 0)
  const emptyTitle = verifying ? catalog.catalogSource === 'none' ? 'Loading contracts' : awaitingObservations ? 'Updating market data' : 'Verifying contracts' : verificationUnavailable ? 'Market verification unavailable' : 'No qualified contracts'
  const emptyDescription = verifying
    ? awaitingObservations ? 'Waiting for fresh observations. Market data collection continues in the background.' : catalog.catalogProgress?.total ? `Checking enabled conditions: ${catalog.catalogProgress.completed} / ${catalog.catalogProgress.total} contracts completed.` : 'The data service is preparing and verifying the market list.'
    : verificationUnavailable ? 'Market data could not verify the enabled conditions. Waiting for updated observations from the data service.' : 'Adjust the enabled liquidity conditions in Settings.'
  const noSearchMatch = Boolean(query.trim()) && rows.length > 0
  // Keep the selected chart available while the backend reports a verification gap.
  const selectedRow = rows.find(row => row.instId === selected) ?? rows[0]
  const retainedChart = !rows.length && Boolean(selected) && (verifying || verificationUnavailable)
  const selectedID = selectedRow?.instId ?? (retainedChart ? selected : null)
  const connectionProblem = !['live', 'connected'].includes(realtime.toLowerCase())
  const marketProblem = preferencesError || error
  const marketStatus = marketProblem || (connectionProblem ? realtime : !rows.length && status !== 'Live' ? status : status === 'Cached' ? 'Cached' : '')
  const marketStatusDetail = [marketStatus, retainedChart ? 'Current chart remains available' : ''].filter(Boolean).join(' · ')
  const listOrder = candidateIds
  useEffect(() => { if (ready) chartController.setUniverse(retainedChart && selectedID ? [selectedID] : candidateIds, timeframe) }, [ready, candidateIds, timeframe, retainedChart, selectedID])
  const savePreferences = useCallback(async (values: Partial<Preferences>) => {
    const write = ++preferenceWrite.current
    let saved: Preferences
    try { saved = await window.radarDesktop.request({ preferences: { action: 'update', values } }) }
    catch (cause) { if (write !== preferenceWrite.current) return; throw cause }
    if (write !== preferenceWrite.current) return
    // Backend notifications own market updates; view preferences do not reload rows.
    setPreferences(saved); setPreferencesError('')
  }, [])
  const changeTimeframe = useCallback((chartTimeframe: RadarTimeframe) => {
    const previous = preferences.chartTimeframe
    setPreferences(current => ({ ...current, chartTimeframe }))
    void savePreferences({ chartTimeframe }).catch(cause => {
      setPreferences(current => current.chartTimeframe === chartTimeframe ? { ...current, chartTimeframe: previous } : current)
      setPreferencesError(message(cause))
    })
  }, [preferences.chartTimeframe, savePreferences])

  return <WorkspaceViewport>
    <div hidden={settingsSection !== null} inert={settingsSection !== null} className={cn('h-full min-w-0 flex-1', settingsSection === null ? 'flex' : 'hidden')}>
    <aside data-market-list className="flex h-full w-[420px] shrink-0 flex-col border-r" aria-label="Contract list">
      <header className="flex flex-col">
        <div data-sidebar-toolbar data-window-toolbar data-window-drag-region data-native-window-controls-row className="flex items-center gap-3 border-b px-4"><h1 className="min-w-0 flex-1 truncate text-sm font-medium">Perpetual Swap Suite</h1><a ref={settingsLauncher} href={settingsHref('workspace')} aria-label="Settings" title="Settings" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}><Settings2 aria-hidden="true" /></a></div>
        <div className="flex flex-col gap-4 border-b p-4">
        <Input aria-label="Search contracts" placeholder="Search contracts…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="flex h-5 min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground"><span className="shrink-0">{query.trim() ? `${visible.length} / ${rows.length}` : rows.length} contracts</span><span data-market-status role={marketProblem ? 'alert' : marketStatus ? 'status' : undefined} className={cn('min-w-0 truncate text-right', (marketProblem || connectionProblem) && 'text-destructive')} title={marketStatusDetail || undefined} aria-label={marketStatusDetail || undefined}>{marketStatus || (updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-US')}` : 'Waiting for market data')}</span></div>
        </div>
      </header>
      <section data-market-scroll className="min-h-0 flex-1 overflow-y-auto [&>[data-slot=table-container]]:overflow-visible" aria-label="Perpetual swap markets">
        <Table className="table-fixed [&_tr:not([data-virtual-spacer])>:first-child]:pl-4 [&_tr:not([data-virtual-spacer])>:last-child]:pr-4" data-market-count={visible.length} data-total-market-count={rows.length} aria-rowcount={visible.length + 1}>
          <colgroup><col className="w-[35%]" /><col className="w-[33%]" /><col className="w-[32%]" /></colgroup>
          <TableHeader className="sticky top-0 bg-background [&_th]:text-xs [&_th]:text-muted-foreground"><TableRow className="hover:bg-transparent"><TableHead>Contract</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right" aria-sort="descending" title="Sorted by absolute signed relative change, largest first">{preferences.rankingLookback}m change</TableHead></TableRow></TableHeader>
          {visible.length ? <MarketRowsViewport ids={visibleIds}>{index => <MarketRowView row={visible[index]} index={index} selected={visible[index].instId === selectedID} lookback={preferences.rankingLookback} onSelect={setSelected} />}</MarketRowsViewport> : <TableBody><TableRow><TableCell colSpan={3}>
            <Empty><EmptyHeader><EmptyTitle>{noSearchMatch ? 'No matching contracts' : emptyTitle}</EmptyTitle><EmptyDescription>{noSearchMatch ? 'Try another contract name.' : emptyDescription}</EmptyDescription></EmptyHeader></Empty>
          </TableCell></TableRow></TableBody>}
        </Table>
      </section>
    </aside>
    <section data-chart-panel className="h-full min-w-0 flex-1" aria-label="Market chart workspace">
      {selectedID ? <MarketChart active={settingsSection === null} instId={selectedID} timeframe={timeframe} candidateIds={candidateIds} onTimeframeChange={changeTimeframe} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={setSelected} /> : <div className="flex h-full items-center justify-center"><Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{verifying || verificationUnavailable ? emptyDescription : 'Enable different liquidity conditions to view a chart.'}</EmptyDescription></EmptyHeader></Empty></div>}
    </section>
    </div>
    {settingsSection && <WorkspaceSettings section={settingsSection} preferences={preferences} loaded={preferencesLoaded} loadError={preferencesError} onSave={savePreferences} onNavigationStateChange={updateSettingsGuard} />}
  </WorkspaceViewport>
}
export default App
