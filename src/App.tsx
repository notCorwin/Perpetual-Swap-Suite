import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Radio, Settings2 } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { MarketChart } from '@/MarketChart'
import { MarketRowsViewport } from '@/MarketRowsViewport'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { WorkspaceSettings } from '@/WorkspaceSettings'
import { settingsHref, useSettingsSection, type SettingsNavigationState } from '@/settings-navigation'
import { chartController } from '@/chart-controller'
import { chartRenderKey, RenderedChartRegistry } from '@/chart-render'
import { compareRankingChange } from '@/market-ranking'
import { MarketRowsBuffer } from '@/market-snapshot'
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
  const progress = snapshot.listProgress
  if (progress && progress.total > 0 && progress.completed < progress.total) return `Loading ${progress.completed}/${progress.total}`
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
    <TableCell className="text-right">{formatPrice(row.lastPrice ?? row.price)}</TableCell>
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
  const [renderedCharts] = useState(() => new RenderedChartRegistry())
  const rendered = useSyncExternalStore(renderedCharts.subscribe, renderedCharts.getSnapshot)
  const [rows, setRows] = useState<RankedMarketRow[]>([])
  const marketRows = useRef(new MarketRowsBuffer<RankedMarketRow>())
  const [removalAt, setRemovalAt] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  const [catalog, setCatalog] = useState<Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'catalogProgress'>>({ loading: true, catalogSource: 'none' })
  const [status, setStatus] = useState('Connecting')
  const [realtime, setRealtime] = useState('Connecting')
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const order = useRef(new SnapshotOrder())
  const revision = useRef(-1)
  const snapshotInFlight = useRef<Promise<MarketSnapshot | UnchangedSnapshot> | null>(null)
  const preferenceWrite = useRef(0)
  const timeframe = preferences.chartTimeframe

  useEffect(() => {
    if (removalAt === null) return
    let timer: number
    const expire = () => {
      const now = performance.now()
      if (now < removalAt) {
        timer = window.setTimeout(expire, Math.ceil(removalAt - now))
        return
      }
      setRows(marketRows.current.expire(now))
      setRemovalAt(marketRows.current.nextRemovalAt)
    }
    timer = window.setTimeout(expire, Math.max(0, Math.ceil(removalAt - performance.now())))
    return () => window.clearTimeout(timer)
  }, [removalAt])

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
    // The first request for each timeframe needs its rows, even when the
    // collector revision has not changed since the previous timeframe.
    revision.current = -1
    const visible = () => document.visibilityState !== 'hidden'
    const load = async () => {
      if (stopped) return
      if (working) { queued = true; return }
      if (!visible()) { queued = true; return }
      working = true
      queued = false
      try {
        // Effect replacements share the outstanding IPC request until it
        // settles, but each response still belongs to its original effect.
        while (snapshotInFlight.current) {
          await snapshotInFlight.current.catch(() => undefined)
          if (stopped) return
        }
        if (!visible()) { queued = true; return }
        const request = window.radarDesktop.request({ snapshot: { timeframe, sinceRevision: revision.current, serviceSession: order.current.serviceSession } })
        snapshotInFlight.current = request
        let snapshot: MarketSnapshot | UnchangedSnapshot
        try { snapshot = await request }
        finally { if (snapshotInFlight.current === request) snapshotInFlight.current = null }
        if (stopped) return
        if ((!snapshot.timeframe || snapshot.timeframe === timeframe) && order.current.accept(snapshot)) {
          revision.current = order.current.revision
          if (!('unchanged' in snapshot)) {
            const buffered = marketRows.current.update(snapshot.rows, performance.now(), order.current.serviceSession ?? '')
            const unverified = snapshot.loading && qualificationPending(snapshot.catalogProgress) || snapshot.error || snapshot.catalogSource === 'none' || (snapshot.catalogProgress?.unknown ?? 0) > 0
            // Start candidate preparation independently of list admission.
            // The SVG pool acknowledges each chart after its DOM is committed.
            const first = buffered.reduce<RankedMarketRow | null>((best, row) => !best || compareRankingChange(row, best) < 0 ? row : best, null)
            const retained = !buffered.length && unverified ? chartController.getSnapshot().requested?.instId : undefined
            void chartController.setUniverse(retained ? [retained] : buffered.map(row => row.instId), timeframe, retained ?? first?.instId)
            if (stopped) return
            setRows(buffered)
            setRemovalAt(marketRows.current.nextRemovalAt)
            setSelected(current => buffered.some(row => row.instId === current) || (!buffered.length && unverified) ? current : first?.instId ?? null)
            setReady(true)
          }
          setError(snapshot.error)
          setCatalog(current => ({
            loading: snapshot.loading ?? ('unchanged' in snapshot ? current.loading : false),
            catalogSource: snapshot.catalogSource ?? current.catalogSource,
            catalogProgress: snapshot.catalogProgress ?? ('unchanged' in snapshot ? current.catalogProgress : undefined),
          }))
          if (!('unchanged' in snapshot) || snapshot.catalogSource !== undefined || snapshot.catalogProgress !== undefined || snapshot.listProgress !== undefined || snapshot.loading !== undefined) setStatus(collectorStatus(snapshot))
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
  }, [preferencesLoaded, timeframe])

  const ranked = useMemo(() => [...rows].sort(compareRankingChange), [rows])
  const listed = useMemo(() => ranked.filter(row => rendered.has(chartRenderKey(row.instId, timeframe))), [ranked, rendered, timeframe])
  const visible = useMemo(() => listed.filter(row => row.instId.toLowerCase().includes(query.trim().toLowerCase())), [listed, query])
  const preparingCharts = rows.length - listed.length
  const verifying = Boolean(catalog.loading) && qualificationPending(catalog.catalogProgress) || (!ready && !error)
  const awaitingObservations = Boolean(catalog.loading && catalog.catalogProgress && catalog.catalogProgress.completed === catalog.catalogProgress.total && catalog.catalogProgress.pending > 0)
  const verificationUnavailable = !verifying && (Boolean(error) || catalog.catalogSource === 'none' || (catalog.catalogProgress?.unknown ?? 0) > 0)
  const emptyTitle = preparingCharts ? 'Preparing charts' : verifying ? catalog.catalogSource === 'none' ? 'Loading contracts' : awaitingObservations ? 'Updating market data' : 'Verifying contracts' : verificationUnavailable ? 'Market verification unavailable' : 'No qualified contracts'
  const emptyDescription = preparingCharts ? `${listed.length} / ${rows.length} charts ready. Contracts appear when their charts are rendered.` : verifying
    ? awaitingObservations ? 'Waiting for fresh observations. Market data collection continues in the background.' : catalog.catalogProgress?.total ? `Checking enabled conditions: ${catalog.catalogProgress.completed} / ${catalog.catalogProgress.total} contracts completed.` : 'The data service is preparing and verifying the market list.'
    : verificationUnavailable ? 'Market data could not verify the enabled conditions. Waiting for updated observations from the data service.' : 'Adjust the enabled liquidity conditions in Settings.'
  const noSearchMatch = Boolean(query.trim()) && listed.length > 0
  // After the list buffer expires, a verification gap still preserves the
  // current chart until the service can confirm its exclusion.
  const selectedRow = rows.find(row => row.instId === selected) ?? listed[0] ?? ranked[0]
  const retainedChart = !rows.length && Boolean(selected) && (verifying || verificationUnavailable)
  const selectedID = selectedRow?.instId ?? (retainedChart ? selected : null)
  useEffect(() => { if (ready && !retainedChart) setSelected(selectedRow?.instId ?? null) }, [ready, retainedChart, selectedRow?.instId])
  const candidateIds = useMemo(() => ranked.map(row => row.instId), [ranked])
  const listOrder = useMemo(() => listed.map(row => row.instId), [listed])
  const turnoverOrder = useMemo(() => [...listed].sort((a, b) => (b.turnover24hUSDT ?? -1) - (a.turnover24hUSDT ?? -1) || a.instId.localeCompare(b.instId, 'en')).map(row => row.instId), [listed])
  useEffect(() => { chartController.setUniverse(retainedChart && selectedID ? [selectedID] : ready ? candidateIds : [], timeframe) }, [ready, candidateIds, timeframe, retainedChart, selectedID])
  const savePreferences = useCallback(async (values: Partial<Preferences>) => {
    const write = ++preferenceWrite.current
    let saved: Preferences
    try { saved = await window.radarDesktop.request({ preferences: { action: 'update', values } }) }
    catch (cause) { if (write !== preferenceWrite.current) return; throw cause }
    if (write !== preferenceWrite.current) return
    // The backend publishes changed qualification/ranking data. Clearing rows
    // here can erase a newer snapshot that arrived before the save response.
    // Only a timeframe change restarts the loader and requests its own rows.
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
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{query.trim() ? `${visible.length} / ${listed.length}` : listed.length} contracts</span><Badge variant="outline"><Radio aria-hidden="true" />{status}</Badge></div>
        </div>
      </header>
      {preferencesError && <p role="alert" className="border-b p-3 text-sm text-destructive">{preferencesError}</p>}
      {error && <p role="alert" className="border-b p-3 text-sm text-destructive">{error}</p>}
      <section data-market-scroll className="min-h-0 flex-1 overflow-y-auto [&>[data-slot=table-container]]:overflow-visible" aria-label="Perpetual swap markets">
        <Table className="table-fixed" data-market-count={visible.length} data-total-market-count={listed.length} data-preparing-chart-count={preparingCharts} aria-rowcount={visible.length + 1}>
          <colgroup><col className="w-[35%]" /><col className="w-[33%]" /><col className="w-[32%]" /></colgroup>
          <TableHeader className="sticky top-0 bg-background"><TableRow><TableHead>Contract</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right" aria-sort="descending" title="Sorted by absolute signed relative change, largest first">{preferences.rankingLookback}m change</TableHead></TableRow></TableHeader>
          {visible.length ? <MarketRowsViewport ids={visible.map(row => row.instId)}>{index => <MarketRowView row={visible[index]} index={index} selected={visible[index].instId === selectedID} lookback={preferences.rankingLookback} onSelect={setSelected} />}</MarketRowsViewport> : <TableBody><TableRow><TableCell colSpan={3}>
            <Empty><EmptyHeader><EmptyTitle>{noSearchMatch ? 'No matching contracts' : emptyTitle}</EmptyTitle><EmptyDescription>{noSearchMatch ? 'Try another contract name.' : emptyDescription}</EmptyDescription></EmptyHeader></Empty>
          </TableCell></TableRow></TableBody>}
        </Table>
      </section>
      <footer className="flex flex-col gap-1 border-t p-4 text-xs text-muted-foreground" aria-live="polite">{preparingCharts > 0 && <span role="status">Preparing charts · {listed.length} / {rows.length} ready</span>}{retainedChart && <span role="status">{verifying ? 'Rechecking qualification · Current chart remains available' : 'Qualification data unavailable · Current chart remains available'}</span>}<div className="flex items-center justify-between gap-3"><span aria-label={`Realtime connection: ${realtime}`}>{realtime}</span><span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-US')}` : 'Waiting for market data'}</span></div></footer>
    </aside>
    <section data-chart-panel className="h-full min-w-0 flex-1" aria-label="Market chart workspace">
      {selectedID ? <MarketChart active={settingsSection === null} instId={selectedID} timeframe={timeframe} candidateIds={candidateIds} onRenderReady={renderedCharts.register} onTimeframeChange={changeTimeframe} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={setSelected} /> : <div className="flex h-full items-center justify-center"><Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{verifying || verificationUnavailable ? emptyDescription : 'Enable different liquidity conditions to view a chart.'}</EmptyDescription></EmptyHeader></Empty></div>}
    </section>
    </div>
    {settingsSection && <WorkspaceSettings section={settingsSection} preferences={preferences} loaded={preferencesLoaded} loadError={preferencesError} onSave={savePreferences} onNavigationStateChange={updateSettingsGuard} />}
  </WorkspaceViewport>
}
export default App
