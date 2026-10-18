import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { MarketChart } from '@/MarketChart'
import { MarketRowsViewport } from '@/MarketRowsViewport'
import { WorkspaceViewport } from '@/WorkspaceViewport'
import { WorkspaceSettings } from '@/WorkspaceSettings'
import { chartController } from '@/chart-controller'
import { compareRankingChange } from '@/market-ranking'
import { reconcileMarketRows } from '@/market-snapshot'
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
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [preferencesError, setPreferencesError] = useState('')
  const [rows, setRows] = useState<RankedMarketRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [ready, setReady] = useState(false)
  const [catalog, setCatalog] = useState<Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'catalogProgress'>>({ loading: true, catalogSource: 'none' })
  const [status, setStatus] = useState('Connecting')
  const [realtime, setRealtime] = useState('Connecting')
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  const order = useRef(new SnapshotOrder())
  const revision = useRef(-1)
  const snapshotInFlight = useRef<Promise<MarketSnapshot | UnchangedSnapshot> | null>(null)
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
    let timer: number | undefined
    let working = false
    let queued = false
    let backoff = 2000
    // The first request for each timeframe needs its rows, even when the
    // collector revision has not changed since the previous timeframe.
    revision.current = -1
    const clearTimer = () => { clearTimeout(timer); timer = undefined }
    const visible = () => document.visibilityState !== 'hidden'
    const load = async () => {
      if (stopped) return
      clearTimer()
      if (working) { queued = true; return }
      if (!visible()) { queued = true; return }
      working = true
      queued = false
      let failed = false
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
            const unverified = snapshot.loading && qualificationPending(snapshot.catalogProgress) || snapshot.error || snapshot.catalogSource === 'none' || (snapshot.catalogProgress?.unknown ?? 0) > 0
            // Admit every native timeframe and recover missed startup pushes
            // before exposing selectable rows. This reads existing compact
            // frames; background history preparation remains independent.
            const first = snapshot.rows.reduce<RankedMarketRow | null>((best, row) => !best || compareRankingChange(row, best) < 0 ? row : best, null)
            const retained = !snapshot.rows.length && unverified ? chartController.getSnapshot().requested?.instId : undefined
            await chartController.setUniverse(retained ? [retained] : snapshot.rows.map(row => row.instId), timeframe, retained ?? first?.instId)
            if (stopped) return
            setRows(current => reconcileMarketRows(current, snapshot.rows) as RankedMarketRow[])
            setSelected(current => snapshot.rows.some(row => row.instId === current) || (!snapshot.rows.length && unverified) ? current : snapshot.rows.reduce<RankedMarketRow | null>((first, row) => !first || compareRankingChange(row, first) < 0 ? row : first, null)?.instId ?? null)
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
        backoff = 2000
      } catch (cause) {
        if (stopped) return
        failed = true
        setError(message(cause)); setStatus('Reconnecting'); setRealtime('Disconnected')
        setCatalog(current => ({ ...current, loading: false }))
        backoff = Math.min(backoff * 2, 30_000)
      } finally {
        working = false
        if (!stopped && visible()) {
          if (queued) void load()
          else if (failed) timer = window.setTimeout(load, backoff)
        }
      }
    }
    const changed = () => { void load() }
    const shown = () => { if (visible()) void load() }
    window.addEventListener('radar-market-changed', changed)
    document.addEventListener('visibilitychange', shown)
    void load()
    return () => {
      stopped = true
      clearTimer()
      window.removeEventListener('radar-market-changed', changed)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [preferencesLoaded, timeframe, refresh])

  const ranked = useMemo(() => [...rows].sort(compareRankingChange), [rows])
  const visible = useMemo(() => ranked.filter(row => row.instId.toLowerCase().includes(query.trim().toLowerCase())), [ranked, query])
  const verifying = Boolean(catalog.loading) && qualificationPending(catalog.catalogProgress) || (!ready && !error)
  const awaitingObservations = Boolean(catalog.loading && catalog.catalogProgress && catalog.catalogProgress.completed === catalog.catalogProgress.total && catalog.catalogProgress.pending > 0)
  const verificationUnavailable = !verifying && (Boolean(error) || catalog.catalogSource === 'none' || (catalog.catalogProgress?.unknown ?? 0) > 0)
  const emptyTitle = verifying ? catalog.catalogSource === 'none' ? 'Loading contracts' : awaitingObservations ? 'Updating market data' : 'Verifying contracts' : verificationUnavailable ? 'Market verification unavailable' : 'No qualified contracts'
  const emptyDescription = verifying
    ? awaitingObservations ? 'Waiting for fresh observations. Market data collection continues in the background.' : catalog.catalogProgress?.total ? `Checking enabled conditions: ${catalog.catalogProgress.completed} / ${catalog.catalogProgress.total} contracts completed.` : 'The data service is preparing and verifying the market list.'
    : verificationUnavailable ? 'Market data could not verify the enabled conditions. The data service will retry automatically.' : 'Adjust the enabled liquidity conditions in Settings.'
  const noSearchMatch = Boolean(query.trim()) && rows.length > 0
  // Only confirmed exclusions clear the chart. A temporary verification gap
  // clears the qualified list while preserving the current chart and its state.
  const selectedRow = rows.find(row => row.instId === selected) ?? ranked[0]
  const retainedChart = !rows.length && Boolean(selected) && (verifying || verificationUnavailable)
  const selectedID = selectedRow?.instId ?? (retainedChart ? selected : null)
  useEffect(() => { if (ready && !rows.length && !verifying && !verificationUnavailable) setSelected(null) }, [ready, rows.length, verifying, verificationUnavailable])
  const listOrder = useMemo(() => ranked.map(row => row.instId), [ranked])
  const turnoverOrder = useMemo(() => [...rows].sort((a, b) => (b.turnover24hUSDT ?? -1) - (a.turnover24hUSDT ?? -1) || a.instId.localeCompare(b.instId, 'en')).map(row => row.instId), [rows])
  useEffect(() => { chartController.setUniverse(retainedChart && selectedID ? [selectedID] : ready ? listOrder : [], timeframe) }, [ready, listOrder, timeframe, retainedChart, selectedID])
  const savePreferences = useCallback(async (values: Partial<Preferences>) => {
    const write = ++preferenceWrite.current
    let saved: Preferences
    try { saved = await window.radarDesktop.request({ preferences: { action: 'update', values } }) }
    catch (cause) { if (write !== preferenceWrite.current) return; throw cause }
    if (write !== preferenceWrite.current) return
    revision.current = -1
    setPreferences(saved); setPreferencesError(''); setStatus('Refreshing'); setRefresh(current => current + 1)
    if (JSON.stringify(saved.liquidity) !== JSON.stringify(preferences.liquidity)) {
      setRows([]); setReady(false); setError('')
      setCatalog(current => ({ ...current, loading: true, catalogProgress: undefined }))
    }
  }, [preferences.liquidity])
  const changeTimeframe = useCallback((chartTimeframe: RadarTimeframe) => {
    const previous = preferences.chartTimeframe
    setPreferences(current => ({ ...current, chartTimeframe }))
    void savePreferences({ chartTimeframe }).catch(cause => {
      setPreferences(current => current.chartTimeframe === chartTimeframe ? { ...current, chartTimeframe: previous } : current)
      setPreferencesError(message(cause))
    })
  }, [preferences.chartTimeframe, savePreferences])

  return <WorkspaceViewport>
    <aside data-market-list className="flex h-full w-[420px] shrink-0 flex-col border-r" aria-label="Contract list">
      <header className="flex flex-col gap-4 border-b p-4">
        <div className="flex items-center justify-between gap-2"><h1 className="text-base font-semibold">Perpetual Swap Suite</h1><WorkspaceSettings preferences={preferences} loadError={preferencesError} onSave={savePreferences} /></div>
        <Input aria-label="Search contracts" placeholder="Search contracts…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{visible.length} / {rows.length} contracts</span><Badge variant="outline"><Radio aria-hidden="true" />{status}</Badge></div>
      </header>
      {preferencesError && <p role="alert" className="border-b p-3 text-sm text-destructive">{preferencesError}</p>}
      {error && <p role="alert" className="border-b p-3 text-sm text-destructive">{error}</p>}
      <section data-market-scroll className="min-h-0 flex-1 overflow-y-auto [&>[data-slot=table-container]]:overflow-visible" aria-label="Perpetual swap markets">
        <Table className="table-fixed" data-market-count={visible.length} data-total-market-count={rows.length} aria-rowcount={visible.length + 1}>
          <colgroup><col className="w-[35%]" /><col className="w-[33%]" /><col className="w-[32%]" /></colgroup>
          <TableHeader className="sticky top-0 bg-background"><TableRow><TableHead>Contract</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right" aria-sort="descending" title="Sorted by absolute signed relative change, largest first">{preferences.rankingLookback}m change</TableHead></TableRow></TableHeader>
          {visible.length ? <MarketRowsViewport ids={visible.map(row => row.instId)}>{index => <MarketRowView row={visible[index]} index={index} selected={visible[index].instId === selectedID} lookback={preferences.rankingLookback} onSelect={setSelected} />}</MarketRowsViewport> : <TableBody><TableRow><TableCell colSpan={3}>
            <Empty><EmptyHeader><EmptyTitle>{noSearchMatch ? 'No matching contracts' : emptyTitle}</EmptyTitle><EmptyDescription>{noSearchMatch ? 'Try another contract name.' : emptyDescription}</EmptyDescription></EmptyHeader></Empty>
          </TableCell></TableRow></TableBody>}
        </Table>
      </section>
      <footer className="flex flex-col gap-1 border-t p-4 text-xs text-muted-foreground" aria-live="polite">{retainedChart && <span role="status">{verifying ? 'Rechecking qualification · Current chart remains available' : 'Qualification data unavailable · Current chart remains available'}</span>}<span>Realtime: {realtime}</span><span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-US')}` : 'Waiting for market data'}</span><span>Ranking: completed 5m closes · {preferences.rankingLookback}m lookback</span></footer>
    </aside>
    <section data-chart-panel className="h-full min-w-0 flex-1" aria-label="Market chart workspace">
      {selectedID ? <MarketChart instId={selectedID} timeframe={timeframe} onTimeframeChange={changeTimeframe} listOrder={listOrder} turnoverOrder={turnoverOrder} onSelect={setSelected} /> : <div className="flex h-full items-center justify-center"><Empty><EmptyHeader><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{verifying || verificationUnavailable ? emptyDescription : 'Enable different liquidity conditions to view a chart.'}</EmptyDescription></EmptyHeader></Empty></div>}
    </section>
  </WorkspaceViewport>
}
export default App
