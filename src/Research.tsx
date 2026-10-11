import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Database, Download, Pause, Play, Trash2, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TraceNode } from '@/FilterExplanation'
import { MarketOpportunity } from '@/MarketOpportunity'
import { MarketListViewport } from '@/MarketListViewport'
import { SuiteWorkspace } from '@/SuiteWorkspace'
import { ModeTitle } from '@/ModeTitle'
import { useSuite } from '@/use-suite'
import { sameStrategyVersion, suiteSpec, type StrategyProfile } from '@/suite-types'
import { ResearchChart } from '@/ResearchChart'
import { parseFilterConfig, type FilterTrace } from '@/rule-engine'
import { keepSnapshotValue } from '@/market-snapshot'
import { requestResearch, researchDateRange, researchPercent, researchSize, researchTime, RESEARCH_HORIZONS, type DataManifest, type DataPlan, type ResearchEvent, type ResearchInputs, type ResearchJob, type ResearchResponse, type ResearchStudy, type ResearchSummary, type StudyReport, type StudySpec } from '@/research-types'

const integer = (n: number) => n.toLocaleString('en-US')
const signed = (n?: number) => n == null ? '' : n > 0 ? 'text-positive' : n < 0 ? 'text-destructive' : ''
const ci = (low?: number, high?: number) => low == null || high == null ? '—' : researchPercent(low) + ' to ' + researchPercent(high)

function SummaryTable({ rows, report }: { rows: ResearchSummary[]; report: StudyReport }) {
  return <Table aria-label="Study statistics">
    <TableHeader><TableRow>{['Group / Rules', 'N', 'Excluded', 'Mean', 'Median', 'Win', 'MFE', 'MAE', 'Baseline', 'Excess', 'Gross 95% interval', 'Net N', 'Net mean', 'Net median', 'Net win', 'Net 95% interval'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{rows.map(s => <TableRow key={s.group + ':' + s.ruleIndex + ':' + s.hours}>
      <TableCell><div className="font-medium">{s.group}</div><div className="text-xs text-muted-foreground">{report.spec.rules[s.ruleIndex]?.name}</div></TableCell>
      <TableCell>{integer(s.count)}</TableCell><TableCell>{integer(s.excluded)}</TableCell>
      <TableCell className={signed(s.mean)}>{researchPercent(s.mean)}</TableCell><TableCell className={signed(s.median)}>{researchPercent(s.median)}</TableCell><TableCell>{researchPercent(s.winRate)}</TableCell>
      <TableCell className="text-positive">{researchPercent(s.mfe)}</TableCell><TableCell className="text-destructive">{researchPercent(s.mae)}</TableCell>
      <TableCell>{researchPercent(s.baseline)}</TableCell><TableCell className={signed(s.excess)}>{researchPercent(s.excess)}</TableCell>
      <TableCell>{ci(s.intervalLow, s.intervalHigh)}</TableCell><TableCell>{integer(s.netCount)}</TableCell><TableCell className={signed(s.netMean)}>{researchPercent(s.netMean)}</TableCell>
      <TableCell className={signed(s.netMedian)}>{researchPercent(s.netMedian)}</TableCell><TableCell>{researchPercent(s.netWinRate)}</TableCell><TableCell>{ci(s.netIntervalLow, s.netIntervalHigh)}</TableCell>
    </TableRow>)}</TableBody>
  </Table>
}

export function Research({ inputs, active, onSwitchMode, onRadar, switchingMode, initialSpec }: { inputs: ResearchInputs; active: boolean; onSwitchMode: () => void; onRadar: () => void; switchingMode: boolean; initialSpec?: StudySpec | null }) {
  const [kind, setKind] = useState<StudySpec['kind']>(initialSpec?.kind ?? 'filter'), [name, setName] = useState(initialSpec?.name ?? 'Bullish Setup study')
  const researchSuite = useSuite('research', active)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [selectedProfiles, setSelectedProfiles] = useState<StrategyProfile[]>(initialSpec?.strategySnapshots ?? [])
  const seededStrategy = useRef(Boolean(initialSpec?.strategySnapshots?.length))
  useEffect(() => {
    if (!researchSuite.ready || seededStrategy.current) return
    const profile = researchSuite.snapshot.profiles.find(p => p.id === researchSuite.snapshot.selectedID) ?? researchSuite.snapshot.profiles[0]
    if (profile) {
      seededStrategy.current = true
      // Initialize the study once from the native shared inventory; later
      // revisions must not silently change this selected configuration.
      // oxlint-disable-next-line react/set-state-in-effect
      setSelectedProfiles(suiteSpec([profile]).strategySnapshots!)
      setName(current => current === 'Bullish Setup study' ? profile.name + ' Bullish Setup study' : current)
    }
  }, [researchSuite.ready, researchSuite.snapshot.profiles, researchSuite.snapshot.selectedID])
  const chooseStrategySpec = (spec: StudySpec) => {
    seededStrategy.current = true
    setSelectedProfiles(spec.strategySnapshots ?? []); setKind(spec.kind); setName(spec.name); setLibraryOpen(false); setTab('configure')
  }
  const [from, setFrom] = useState(initialSpec?.from == null ? '' : new Date(initialSpec.from).toISOString().slice(0, 10)), [through, setThrough] = useState(() => new Date(initialSpec?.through ?? Date.now()).toISOString().slice(0, 10))
  const [instrumentText, setInstrumentText] = useState(initialSpec?.instruments.join(', ') ?? '')
  const [sampling, setSampling] = useState<StudySpec['sampling']>(initialSpec?.sampling ?? 'entries')
  const [fees, setFees] = useState({ entry: initialSpec?.costs ? String(initialSpec.costs.entryFeeBps) : '', exit: initialSpec?.costs ? String(initialSpec.costs.exitFeeBps) : '', slip: initialSpec?.costs ? String(initialSpec.costs.slippageBps) : '' })
  const [tab, setTab] = useState('configure'), [horizon, setHorizon] = useState('6'), [scoreView, setScoreView] = useState('Full')
  const [job, setJob] = useState<ResearchJob | null>(null), [studies, setStudies] = useState<ResearchStudy[]>([])
  const [plan, setPlan] = useState<DataPlan | null>(null), [estimatedBytes, setEstimatedBytes] = useState(0), [sourcePage, setSourcePage] = useState(0)
  const [study, setStudy] = useState<ResearchStudy | null>(null), [report, setReport] = useState<StudyReport | null>(null), [manifest, setManifest] = useState<DataManifest | null>(null)
  const [events, setEvents] = useState<ResearchEvent[]>([]), [eventCount, setEventCount] = useState(0), [offset, setOffset] = useState(0), [event, setEvent] = useState<ResearchEvent | null>(null)
  const [cache, setCache] = useState({ directory: '', rows: 0, files: 0 })
  const [error, setError] = useState(''), [pending, setPending] = useState(false)
  const [pollError, setPollError] = useState('')
  const [confirm, setConfirm] = useState<{ action: 'delete' | 'cleanCache'; studyID?: string } | null>(null)
  const [notice, setNotice] = useState('')
  const handledJob = useRef(''), selection = useRef(0), polling = useRef(false)
  const busy = pending || Boolean(job && ['planning', 'preparing', 'running'].includes(job.phase))
  // The picker and selected snapshot share the same revision-qualified ID.
  // Changing an option's ID after selection can clear Radix's native form value.
  const strategyOptions = useMemo(() => Array.from(new Map([...studies.flatMap(s => s.spec.strategySnapshots ?? []), ...selectedProfiles, ...researchSuite.snapshot.profiles].map(profile => {
    const frozen = suiteSpec([profile]).strategySnapshots![0]
    return [frozen.id, { profile: frozen, label: profile.id.includes('@r') ? 'Frozen: ' + profile.name : profile.name + ' · r' + profile.revision }]
  })).values()), [studies,selectedProfiles,researchSuite.snapshot.profiles])
  const outdatedProfiles = selectedProfiles.filter(profile => {
    const latest = researchSuite.snapshot.profiles.find(saved => saved.id === profile.id.split('@r')[0])
    return latest && latest.revision !== profile.revision
  })
  const pageEvents = useCallback(async (id: string, start: number) => {
    const result = await requestResearch({ action: 'events', studyID: id, offset: start })
    setEvents(result.events ?? []); setEventCount(result.count ?? 0); setOffset(start)
    return result.events ?? []
  }, [])
  const selectStudy = useCallback(async (id: string) => {
    const epoch = ++selection.current
    const result = await requestResearch({ action: 'study', studyID: id })
    if (epoch !== selection.current) return
    setStudy(result.study ?? null); setReport(result.report ?? null); setManifest(result.manifest ?? null)
    setPlan(result.manifest ? null : result.plan ?? null); setEstimatedBytes(result.estimatedBytes ?? 0)
    if (result.report) await pageEvents(id, 0)
    else { setEvents([]); setOffset(0); setEventCount(0) }
  }, [pageEvents])
  useEffect(() => {
    if (!active) return
    let stopped = false, timer: number
    const refresh = async () => {
      if (polling.current) { timer = window.setTimeout(refresh, 1000); return }
      polling.current = true
      try {
        const result = await requestResearch({ action: 'inventory' })
        if (stopped) return
        setJob(current => keepSnapshotValue(current, result.job ?? null)); setStudies(current => keepSnapshotValue(current, result.studies ?? []))
        setCache(current => keepSnapshotValue(current, { directory: result.cacheDirectory ?? '', rows: result.cachedRows ?? 0, files: result.rawFiles ?? 0 }))
        const j = result.job, key = j?.id + ':' + j?.phase + ':' + j?.resultID
        if (j && key !== handledJob.current && ['planned', 'ready', 'completed', 'paused', 'failed', 'cancelled'].includes(j.phase)) {
          if (j.phase === 'planned' && j.resultID) {
            const detail = await requestResearch({ action: 'planDetail', planID: j.resultID })
            if (stopped) return
            setPlan(detail.plan ?? null); setEstimatedBytes(detail.estimatedBytes ?? 0); setSourcePage(0); setStudy(null); setReport(null); setManifest(null); setTab('data')
          } else if (j.resultID) {
            await selectStudy(j.resultID)
            if (stopped) return
            if (j.phase === 'completed') setTab('results')
          }
          if (j.error) setError(j.error)
          handledJob.current = key
        }
        setPollError('')
      } catch (cause) { if (!stopped) setPollError(cause instanceof Error ? cause.message : 'Cannot open research.') }
      finally { polling.current = false; if (!stopped) timer = window.setTimeout(refresh, 1000) }
    }
    void refresh()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [active,selectStudy])
  const perform = async (action: () => Promise<ResearchResponse | void>) => {
    setPending(true); setError(''); setNotice('')
    try { const result = await action(); if (result?.jobID) setJob({ id: result.jobID, phase: 'running', completed: 0, total: 0, message: 'Starting…', error: '' }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Research request failed.') }
    finally { setPending(false) }
  }
  const createPlan = (refresh = false) => perform(async () => {
    if (!selectedProfiles.length) throw new Error('Choose a saved Strategy. Use Strategy Library to create one.')
    if (kind === 'comparison' && selectedProfiles.length !== 2) throw new Error('Choose two strategy versions to compare.')
    const allEmpty = Object.values(fees).every(value => !value.trim())
    if (!allEmpty && Object.values(fees).some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 10_000)) throw new Error('Enter all three costs in basis points, or leave all three blank for gross returns.')
    const frozen = suiteSpec(kind === 'comparison' ? selectedProfiles : selectedProfiles.slice(0, 1))
    const spec: StudySpec = { name: name.trim(), kind, rules: [], strategySnapshots: frozen.strategySnapshots,
      instruments: instrumentText.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean), ...researchDateRange(from, through),
      direction: 'Long', sampling: kind === 'score' ? 'hourly' : sampling, costs: allEmpty ? null : { entryFeeBps: Number(fees.entry), exitFeeBps: Number(fees.exit), slippageBps: Number(fees.slip) } }
    if (!spec.name) { document.getElementById('study-name')?.focus(); throw new Error('Give the study a name.') }
    setPlan(null); setStudy(null); setReport(null); setManifest(null)
    return requestResearch({ action: 'plan', spec, refresh })
  })
  const duplicate = (saved: ResearchStudy) => {
    seededStrategy.current = true
    const spec = saved.spec
    setSelectedProfiles(spec.strategySnapshots ?? [])
    setName(spec.name + ' copy'); setKind(spec.kind); setSampling(spec.sampling)
    setFrom(spec.from ? new Date(spec.from).toISOString().slice(0, 10) : ''); setThrough(new Date(spec.through - 1).toISOString().slice(0, 10))
    setInstrumentText(spec.instruments.join(', ')); setFees({ entry: spec.costs ? String(spec.costs.entryFeeBps) : '', exit: spec.costs ? String(spec.costs.exitFeeBps) : '', slip: spec.costs ? String(spec.costs.slippageBps) : '' })
    setTab('configure'); setPlan(null); setReport(null); setStudy(null); setManifest(null)
  }
  const navigateEvent = (step: number) => {
    if (!event || !study) return
    const index = events.findIndex(e => e.id === event.id), next = index + step
    if (next >= 0 && next < events.length) setEvent(events[next])
    else {
      const start = offset + (step > 0 ? 50 : -50)
      if (start < 0 || start >= eventCount) return
      void perform(async () => { const rows = await pageEvents(study.id, start); setEvent(step > 0 ? rows[0] : rows.at(-1) ?? null) })
    }
  }
  const coverage = manifest?.coverage ?? plan?.coverage ?? []
  const selectedRows = report?.summaries.filter(s => s.hours === Number(horizon)) ?? []
  const resultRows = selectedRows.filter(s => !s.group.startsWith('Score ·'))
  const scoreRows = selectedRows.filter(s => s.group.startsWith('Score · ' + scoreView + ' ·') && (scoreView === 'Thresholds' ? true : !s.group.includes('≥')))
  const context = { metrics: inputs.metrics, expressions: {}, units: {}, templates: inputs.templates }
  const radarSpec = tab === 'configure'
    ? selectedProfiles.length ? suiteSpec(selectedProfiles.slice(0, 1)) : null
    : ['data', 'results', 'scores'].includes(tab) && study?.spec.strategySnapshots?.length ? study.spec
      : tab === 'data' && plan?.spec.strategySnapshots?.length ? plan.spec : null
  const activateVersionInRadar = () => perform(async () => {
    const frozen = radarSpec?.strategySnapshots?.[0]
    if (!frozen) throw new Error('Choose a complete strategy version first.')
    const saved = researchSuite.snapshot.profiles.find(profile => profile.id === frozen.id.split('@r')[0])
    const same = sameStrategyVersion(saved, frozen)
    const profile = same ? saved : (await researchSuite.perform({ action: 'copy', profile: frozen })).saved
    if (!profile) throw new Error('Cannot restore this strategy version.')
    await researchSuite.perform({ action: 'select', profileID: profile.id }); onRadar()
    return {}
  })
  if (libraryOpen) return <SuiteWorkspace mode="research" active={active} inputs={inputs} switchingMode={switchingMode} onSwitchMode={onSwitchMode} onBack={() => setLibraryOpen(false)} onResearch={chooseStrategySpec} />
  return <MarketListViewport><main className="flex min-h-[inherit] flex-col gap-4 p-4 tabular-nums" data-research>
    <header className="flex items-center gap-3 border-b pb-3">
      <ModeTitle mode="research" pending={switchingMode} onSwitch={onSwitchMode} />
      <span className="flex-1 text-xs text-muted-foreground">OKX · Hourly close · Fixed local data</span>
      <Button variant="outline" disabled={!radarSpec || researchSuite.pending || pending} onClick={() => void activateVersionInRadar()}>Use this version in Radar</Button>
      <Badge variant="outline"><Database data-icon="inline-start" aria-hidden="true" />{integer(cache.rows)} cached rows</Badge>
    </header>
    {(error || pollError || job?.error || researchSuite.error) && <Alert variant="destructive"><AlertTitle>Research needs attention</AlertTitle><AlertDescription>{error || pollError || job?.error || researchSuite.error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {job && <section data-surface="panel" className="flex flex-col gap-2 rounded-lg border bg-card p-3" aria-label="Research task">
      <div className="flex items-center gap-3"><Badge variant="secondary">{job.phase}</Badge><span className="min-w-0 flex-1 truncate text-sm" role="status">{job.message || 'Cached files and checkpoints are retained.'}</span>
        {busy && <><Button variant="outline" size="sm" disabled={pending} onClick={() => void perform(() => requestResearch({ action: 'pause' }))}><Pause data-icon="inline-start" aria-hidden="true" />Pause</Button><Button variant="ghost" size="sm" disabled={pending} onClick={() => void perform(() => requestResearch({ action: 'cancel' }))}><X data-icon="inline-start" aria-hidden="true" />Cancel</Button></>}
      </div>
      {['planning', 'preparing', 'running'].includes(job.phase) && <Progress aria-label="Research task progress" value={job.total ? job.completed / job.total * 100 : undefined} />}
      <p className="text-xs text-muted-foreground">{job.total ? integer(job.completed) + ' / ' + integer(job.total) + ' work items · ' : ''}Pause or quit to save a checkpoint. Completed data stays on disk.</p>
    </section>}
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList variant="line"><TabsTrigger value="configure">Configure</TabsTrigger><TabsTrigger value="data">Data coverage</TabsTrigger><TabsTrigger value="results">Results</TabsTrigger><TabsTrigger value="scores">Score calibration</TabsTrigger><TabsTrigger value="history">Studies & cache</TabsTrigger></TabsList>
      <TabsContent value="configure">
        <form onSubmit={e => { e.preventDefault(); void createPlan() }} className="flex flex-col gap-4">
          <FieldGroup className="grid grid-cols-2 items-start gap-6">
            <FieldSet><FieldLegend>Study configuration</FieldLegend><FieldDescription>Research freezes a saved Strategy and evaluates its rules at each completed hourly close.</FieldDescription><FieldGroup>
              <Field><FieldLabel htmlFor="study-name">Study name</FieldLabel><Input id="study-name" name="studyName" autoComplete="off" value={name} onChange={e => setName(e.target.value)} disabled={busy} /></Field>
              <Field><FieldLabel>Research question</FieldLabel><ToggleGroup type="single" variant="outline" value={kind} disabled={busy} onValueChange={value => {
                if (!value) return; setKind(value as StudySpec['kind']); if (value === 'score') setSampling('hourly')
              }} aria-label="Research question"><ToggleGroupItem value="filter">Strategy signals</ToggleGroupItem><ToggleGroupItem value="score">Opportunity</ToggleGroupItem><ToggleGroupItem value="comparison">Compare strategies</ToggleGroupItem></ToggleGroup></Field>
              <FieldSet><FieldLegend>Shared strategy versions</FieldLegend><FieldDescription>Radar and Research use the same saved rules. This study freezes the selected revisions. Restoring an older version in Radar creates a separate shared strategy.</FieldDescription><FieldGroup>
                <Field><FieldLabel>Primary strategy</FieldLabel><Select value={selectedProfiles[0]?.id ?? ''} disabled={busy} onValueChange={id => {
                  const profile = strategyOptions.find(option => option.profile.id === id)?.profile
                  if (profile) { seededStrategy.current = true; setSelectedProfiles(current => [profile, ...current.slice(1).filter(other => other.id.split('@r')[0] !== profile.id.split('@r')[0] || other.revision !== profile.revision)]) }
                }}><SelectTrigger aria-label="Study strategy"><SelectValue placeholder="Choose a shared strategy…" /></SelectTrigger><SelectContent><SelectGroup>{strategyOptions.map(option => <SelectItem key={option.profile.id} value={option.profile.id}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
                {kind === 'comparison' && <Field><FieldLabel>Compare with</FieldLabel><Select value={selectedProfiles[1]?.id ?? 'none'} disabled={busy} onValueChange={id => {
                  const profile = strategyOptions.find(option => option.profile.id === id)?.profile
                  if (profile || id === 'none') setSelectedProfiles(current => current[0] ? profile ? [current[0], profile] : [current[0]] : [])
                }}><SelectTrigger aria-label="Compare strategy"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">{kind === 'comparison' ? 'Choose a comparison strategy…' : 'Single strategy'}</SelectItem>{strategyOptions.filter(({ profile }) => profile.id.split('@r')[0] !== selectedProfiles[0]?.id.split('@r')[0] || profile.revision !== selectedProfiles[0]?.revision).map(option => <SelectItem key={option.profile.id} value={option.profile.id}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>}
                <FieldDescription>Research evaluates Universe and Bullish Setup together, then measures Long returns over fixed holding periods. Missing readings remain Unknown.</FieldDescription>
                {outdatedProfiles.length > 0 && <Alert variant="warning"><AlertDescription>New saved revisions exist for {outdatedProfiles.map(p => p.name).join(', ')}. This study keeps its selected versions. <Button type="button" variant="link" disabled={busy} onClick={() => { const profiles = selectedProfiles.map(p => researchSuite.snapshot.profiles.find(saved => saved.id === p.id.split('@r')[0]) ?? p); setSelectedProfiles(suiteSpec(profiles).strategySnapshots!) }}>Use latest saved revisions</Button></AlertDescription></Alert>}
                <Button type="button" variant="outline" disabled={busy} onClick={() => setLibraryOpen(true)}>Strategy Library…</Button>
              </FieldGroup></FieldSet>
              <Field><FieldLabel>Signal sampling</FieldLabel><ToggleGroup type="single" variant="outline" value={kind === 'score' ? 'hourly' : sampling} disabled={busy || kind === 'score'} onValueChange={value => { if (value) setSampling(value as StudySpec['sampling']) }} aria-label="Signal sampling"><ToggleGroupItem value="entries">First entry per episode</ToggleGroupItem><ToggleGroupItem value="hourly">Every matching hour</ToggleGroupItem></ToggleGroup></Field>
            </FieldGroup></FieldSet>
            <FieldSet><FieldLegend>History and modeled costs</FieldLegend><FieldGroup>
              <Field><FieldLabel htmlFor="study-from">From (UTC date)</FieldLabel><Input id="study-from" name="studyFrom" type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={busy} /><FieldDescription>Leave blank for the longest available history, including indicator warmup.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="study-through">Through (UTC date)</FieldLabel><Input id="study-through" name="studyThrough" type="date" value={through} onChange={e => setThrough(e.target.value)} disabled={busy} /><FieldDescription>The selected day is included up to the last completed hour.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="study-instruments">Instruments (optional)</FieldLabel><Input id="study-instruments" name="studyInstruments" spellCheck={false} placeholder="BTC-USDT-SWAP, ETH-USDT-SWAP…" value={instrumentText} onChange={e => setInstrumentText(e.target.value)} disabled={busy} /><FieldDescription>Blank selects all verified eligible historical USDT swaps.</FieldDescription></Field>
              <FieldSet><FieldLegend>Costs in basis points</FieldLegend><FieldDescription>Leave all blank for gross returns. Enter all three values, including explicit zero, for modeled net returns and actual funding.</FieldDescription><FieldGroup className="grid grid-cols-3">
                {([['entry', 'Entry fee'], ['exit', 'Exit fee'], ['slip', 'Slippage / side']] as const).map(([key, label]) => <Field key={key}><FieldLabel htmlFor={'cost-' + key}>{label}</FieldLabel><Input id={'cost-' + key} name={'cost-' + key} inputMode="decimal" type="number" min="0" max="9999" step="any" placeholder="bps…" value={fees[key]} disabled={busy} onChange={e => setFees(current => ({ ...current, [key]: e.target.value }))} /></Field>)}
              </FieldGroup></FieldSet>
            </FieldGroup></FieldSet>
          </FieldGroup>
          <div className="flex items-center gap-3"><Button type="submit" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : <Database data-icon="inline-start" aria-hidden="true" />}Review data plan</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => void createPlan(true)}>Refresh source data plan…</Button><span className="text-xs text-muted-foreground">Archive downloads start only after Prepare Data.</span></div>
        </form>
      </TabsContent>
      <TabsContent value="data" className="flex flex-col gap-4">
        {!plan && !manifest ? <Empty><EmptyHeader><EmptyTitle>Prepare a data plan</EmptyTitle><EmptyDescription>Choose your rules and date range, then review local coverage and required downloads.</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => setTab('configure')}>Configure study</Button></Empty> : <>
          {plan && <><div className="flex items-center gap-3"><h2 className="font-semibold">{plan.spec.name}</h2><Badge variant="outline">{integer(plan.instruments.length)} verified instruments</Badge><span className="flex-1 text-xs text-muted-foreground">{researchTime(plan.from)} → {researchTime(plan.through)}</span>
            <Button disabled={busy} onClick={() => void perform(() => requestResearch({ action: 'prepare', planID: plan.id }))}><Download data-icon="inline-start" aria-hidden="true" />Prepare Data</Button></div>
            <div className="grid grid-cols-4 gap-4 text-sm"><p>Cached candle hours<br /><strong>{integer(plan.cachedHours)}</strong></p><p>Requested candle hours<br /><strong>{integer(plan.requestedHours)}</strong></p><p>Source files / ranges<br /><strong>{integer(plan.sources.length)}</strong></p><p>Known archive download size<br /><strong>{researchSize(estimatedBytes)}</strong></p></div>
            <p className="text-xs text-muted-foreground">REST size varies. The plan includes warmup and up to 48h of outcome data. Downloaded originals and normalized hours remain cached until you clear unreferenced data.</p>
            <Table aria-label="Planned data sources"><TableHeader><TableRow>{['Instrument / source', 'Input', 'From', 'Through', 'Size', 'Cache'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{plan.sources.slice(sourcePage * 50, sourcePage * 50 + 50).map(source => <TableRow key={source.id}><TableCell><div>{source.instrument}</div><div className="text-xs text-muted-foreground">{source.filename}</div></TableCell><TableCell><div>{source.kind}</div><div className="text-xs text-muted-foreground">{source.archive ? 'Published archive' : 'Requested REST range'}</div></TableCell><TableCell>{researchTime(source.from)}</TableCell><TableCell>{researchTime(source.through)}</TableCell><TableCell>{source.sizeBytes == null ? 'Varies' : researchSize(source.sizeBytes)}</TableCell><TableCell>{source.cached ? 'Raw file cached' : 'Download required'}</TableCell></TableRow>)}</TableBody></Table>
            {plan.sources.length === 0 && <p role="status">{coverage.filter(row => ['candle'].includes(row.kind)).every(row => row.available === row.expected) ? 'This range is fully cached.' : 'No additional history downloads are available for these gaps.'} Prepare Data will freeze available local inputs; missing readings stay Unknown.</p>}
            {plan.sources.length > 50 && <div className="flex gap-2"><Button variant="outline" disabled={sourcePage === 0} onClick={() => setSourcePage(value => value - 1)}>Previous sources</Button><Button variant="outline" disabled={(sourcePage + 1) * 50 >= plan.sources.length} onClick={() => setSourcePage(value => value + 1)}>Next sources</Button></div>}
          </>}
          {manifest && <section className="flex flex-col gap-2 rounded-lg border p-3"><h2 className="font-semibold">Frozen dataset</h2><p className="break-all text-xs text-muted-foreground">Data digest: {manifest.digest} · {manifest.engine} · {manifest.parser}</p><p className="text-sm">{manifest.instruments.length} sample instruments · {(manifest.referenceInstruments ?? []).length} reference instruments · {manifest.unknownInstruments.length} unverified or ineligible instruments excluded</p><p className="text-xs text-muted-foreground">BTC reference data informs rules without adding research samples. This experiment keeps its original rules and inputs when newer data is cached.</p>{study && !report && <Button className="w-fit" disabled={busy} onClick={() => void perform(() => requestResearch({ action: 'run', studyID: study.id }))}><Play data-icon="inline-start" aria-hidden="true" />Run Study</Button>}</section>}
          {(manifest || plan) && <details><summary className="font-medium">{manifest ? 'Frozen' : 'Local'} input coverage and data gaps</summary><p className="my-2 text-xs text-muted-foreground">Recorded turnover is supplemented from complete 24h base-volume history. Funding coverage records inspected intervals, including intervals without a settlement.</p><Table aria-label="Frozen input coverage"><TableHeader><TableRow>{['Instrument', 'Input', 'Available / expected', 'First', 'Last', 'Missing intervals'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{coverage.map(row => <TableRow key={row.instrument + ':' + row.kind}><TableCell>{row.instrument}{(manifest?.referenceInstruments ?? plan?.referenceInstruments ?? []).some(reference => reference.id === row.instrument) && <Badge variant="outline" className="ml-2">Reference</Badge>}</TableCell><TableCell>{row.kind}</TableCell><TableCell>{integer(row.available)} / {integer(row.expected)}</TableCell><TableCell>{row.first == null ? '—' : researchTime(row.first)}</TableCell><TableCell>{row.last == null ? '—' : researchTime(row.last)}</TableCell><TableCell>{row.gaps.length ? <details><summary>{integer(row.gaps.length)} gaps</summary>{row.gaps.map(gap => <p key={gap.from} className="text-xs">{researchTime(gap.from)} → {researchTime(gap.through)}</p>)}</details> : 'Complete'}</TableCell></TableRow>)}</TableBody></Table></details>}
          {(manifest || plan) && <details><summary className="font-medium">Historical instrument eligibility and sources</summary><Table aria-label="Historical instrument catalog"><TableHeader><TableRow>{['Instrument', 'Listed (UTC)', 'Delisted (UTC)', 'Contract base value', 'Metadata evidence'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{[...(manifest?.instruments ?? plan?.instruments ?? []), ...(manifest?.referenceInstruments ?? plan?.referenceInstruments ?? []).filter(reference => !(manifest?.instruments ?? plan?.instruments ?? []).some(target => target.id === reference.id))].map(instrument => <TableRow key={instrument.id}><TableCell>{instrument.id}</TableCell><TableCell>{instrument.listedAt == null ? 'Unknown' : researchTime(instrument.listedAt)}</TableCell><TableCell>{instrument.delistedAt == null ? '—' : researchTime(instrument.delistedAt)}</TableCell><TableCell>{instrument.contractValue ?? 'Unknown'}</TableCell><TableCell className="max-w-80 break-all text-xs">{instrument.source}<div className="text-muted-foreground">Captured {researchTime(instrument.observedAt)}</div></TableCell></TableRow>)}</TableBody></Table></details>}
          {(manifest?.warnings ?? plan?.warnings ?? []).map(warning => <Alert key={warning} variant="warning"><AlertDescription>{warning}</AlertDescription></Alert>)}
          {(manifest?.unknownInstruments ?? plan?.unknownInstruments ?? []).length > 0 && <details><summary>Unverified or ineligible historical instruments</summary><p className="mt-2 break-words text-xs text-muted-foreground">{(manifest?.unknownInstruments ?? plan?.unknownInstruments)?.join(', ')}</p></details>}
        </>}
      </TabsContent>
      {(['results', 'scores'] as const).map(view => <TabsContent key={view} value={view} className="flex flex-col gap-4">
        {!report ? <Empty><EmptyHeader><EmptyTitle>{study?.manifestID ? 'Ready to run' : 'No completed study selected'}</EmptyTitle><EmptyDescription>Prepare the fixed local dataset, run a study, or open an earlier result.</EmptyDescription></EmptyHeader>{study?.manifestID && <Button disabled={busy} onClick={() => void perform(() => requestResearch({ action: 'run', studyID: study.id }))}><Play data-icon="inline-start" aria-hidden="true" />Run Study</Button>}</Empty> : <>
          <div className="flex items-center gap-3"><h2 className="font-semibold">{report.spec.name}</h2><span className="flex-1 text-xs text-muted-foreground">{integer(report.evaluated)} rule-hours · {integer(report.unknown)} Unknown · {integer(report.directionless)} directionless · {integer(report.uncertain)} uncertain entries · {integer(report.baseline)} initial matches · {integer(report.commonPool)} common hours</span>
            <Button variant="outline" disabled={pending} onClick={() => void perform(() => requestResearch({ action: 'export', studyID: report.studyID, kind: 'summary' }))}>Export summary CSV</Button><Button variant="outline" disabled={pending} onClick={() => void perform(() => requestResearch({ action: 'export', studyID: report.studyID, kind: 'events' }))}>Export events CSV</Button></div>
          <div className="flex items-center gap-4"><Field className="w-fit"><FieldLabel>Holding period</FieldLabel><ToggleGroup type="single" variant="outline" value={horizon} onValueChange={value => { if (value) setHorizon(value) }} aria-label="Holding period">{RESEARCH_HORIZONS.map(hours => <ToggleGroupItem key={hours} value={String(hours)}>{hours}h</ToggleGroupItem>)}</ToggleGroup></Field>
            {view === 'scores' && <Field className="w-fit"><FieldLabel>Input coverage</FieldLabel><ToggleGroup type="single" variant="outline" value={scoreView} onValueChange={value => { if (value) setScoreView(value) }} aria-label="Score input coverage"><ToggleGroupItem value="Full">Full inputs</ToggleGroupItem><ToggleGroupItem value="Partial">Partial inputs</ToggleGroupItem><ToggleGroupItem value="Thresholds">Thresholds</ToggleGroupItem></ToggleGroup></Field>}</div>
          {report.warnings.filter(warning => warning.startsWith("Hourly approximation of live BTC rules")).map(warning => <Alert key={warning} variant="warning"><AlertDescription>{warning}</AlertDescription></Alert>)}
          <SummaryTable report={report} rows={view === 'results' ? resultRows : scoreView === 'Thresholds' ? selectedRows.filter(s => s.group.startsWith('Score · Full · ≥')) : scoreRows} />
          <p className="text-xs text-muted-foreground">Returns use 1 USDT initial notional and next-hour opens. Unknown, uncertain entry and purged boundary samples are excluded from main statistics. Net N includes only complete funding and settlement marks. Confidence intervals require 30 samples and 8 UTC weeks.</p>
          <h3 className="font-semibold">Signal events</h3>
          <Table aria-label="Signal events"><TableHeader><TableRow>{['Instrument', 'Signal close', 'Rules', 'Direction', 'Entry', 'Score inputs', 'Status', 'Split', 'Gross', 'Net', 'Inspect'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{events.map(e => {
            const outcome = e.outcomes.find(o => o.hours === Number(horizon))
            return <TableRow key={e.id}><TableCell>{e.instrument}</TableCell><TableCell>{researchTime(e.timestamp)}</TableCell><TableCell>{report.spec.rules[e.ruleIndex]?.name}</TableCell><TableCell>{e.direction}</TableCell><TableCell>{e.entry}</TableCell><TableCell>{e.score ?? '—'} · {e.scoreComplete ? 'Full' : 'Partial'}</TableCell><TableCell>{e.status}</TableCell><TableCell>{e.split}</TableCell><TableCell title={outcome?.reason} className={signed(outcome?.gross)}>{researchPercent(outcome?.gross)}</TableCell><TableCell title={outcome?.netReason} className={signed(outcome?.net)}>{researchPercent(outcome?.net)}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => setEvent(e)} aria-label={'Inspect ' + e.instrument + ' event'}>Inspect<ArrowRight data-icon="inline-end" aria-hidden="true" /></Button></TableCell></TableRow>
          })}</TableBody></Table>
          <div className="flex items-center gap-3"><Button variant="outline" disabled={offset === 0} onClick={() => void perform(() => pageEvents(report.studyID, Math.max(0, offset - 50)).then(() => undefined))}>Previous events</Button><span className="text-xs text-muted-foreground">{eventCount ? integer(offset + 1) + '–' + integer(Math.min(offset + events.length, eventCount)) : '0'} / {integer(eventCount)}</span><Button variant="outline" disabled={offset + 50 >= eventCount} onClick={() => void perform(() => pageEvents(report.studyID, offset + 50).then(() => undefined))}>Next events</Button></div>
        </>}
      </TabsContent>)}
      <TabsContent value="history" className="flex flex-col gap-4">
        <div className="flex items-center gap-3"><h2 className="flex-1 font-semibold">Saved experiments</h2><Button variant="outline" disabled={busy} onClick={() => void perform(() => requestResearch({ action: 'importCatalog' }))}>Import verified instrument catalog…</Button><Button variant="outline" disabled={busy} onClick={() => setConfirm({ action: 'cleanCache' })}><Trash2 data-icon="inline-start" aria-hidden="true" />Clear unreferenced cache…</Button></div>
        <p className="text-xs text-muted-foreground">{integer(cache.files)} raw sources · {integer(cache.rows)} cached rows · {cache.directory}</p>
        <Table aria-label="Saved studies"><TableHeader><TableRow>{['Study', 'Created', 'State', 'Actions'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{studies.map(saved => <TableRow key={saved.id}><TableCell><div className="font-medium">{saved.spec.name}</div><div className="text-xs text-muted-foreground">{saved.spec.kind} · {saved.spec.rules.map(r => r.name).join(' / ')}</div></TableCell><TableCell>{researchTime(saved.createdAt)}</TableCell><TableCell><Badge variant="outline">{saved.phase}</Badge></TableCell><TableCell><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => void perform(async () => { await selectStudy(saved.id); setTab(saved.phase === 'completed' ? 'results' : 'data') })}>Open</Button>{!['completed', 'cancelled'].includes(saved.phase) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => requestResearch({ action: 'resume', studyID: saved.id }))}>Resume</Button>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => duplicate(saved)}>Copy configuration</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm({ action: 'delete', studyID: saved.id })} aria-label={'Delete ' + saved.spec.name}><Trash2 data-icon="inline-start" aria-hidden="true" /></Button></div></TableCell></TableRow>)}</TableBody></Table>
        {!studies.length && <Empty><EmptyHeader><EmptyTitle>No saved studies yet</EmptyTitle><EmptyDescription>Prepared datasets, checkpoints and completed experiments will appear here.</EmptyDescription></EmptyHeader></Empty>}
      </TabsContent>
    </Tabs>
    <Dialog open={active && Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(null) }}><DialogContent><DialogHeader><DialogTitle>{confirm?.action === 'delete' ? 'Delete this experiment?' : 'Clear unreferenced cache?'}</DialogTitle><DialogDescription>{confirm?.action === 'delete' ? 'Remove this study, its report and checkpoint. Downloaded data remains cached.' : 'Remove data that no saved experiment references. Pinned experiment inputs and results are retained.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Keep</Button><Button variant="destructive" disabled={pending} onClick={() => void perform(async () => {
      if (!confirm) return
      const result = await requestResearch(confirm); if (confirm.action === 'delete' && study?.id === confirm.studyID) { setStudy(null); setReport(null); setManifest(null) }
      setNotice(confirm.action === 'cleanCache' ? researchSize(result.bytesRemoved ?? 0) + ' cleared. Pinned inputs were retained.' : 'Experiment deleted. Cached data was retained.'); setConfirm(null)
    })}>Remove</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={active && Boolean(event)} onOpenChange={open => { if (!open) setEvent(null) }}><DialogContent className="flex h-[min(calc(var(--market-list-layout-height)*0.94),80rem)] w-[min(calc(var(--market-list-layout-width)*0.94),100rem)] max-w-none scale-(--market-list-scale) flex-col sm:max-w-none">
      <DialogHeader><DialogTitle>{event?.instrument} · Signal evidence</DialogTitle><DialogDescription>{event && researchTime(event.timestamp)} · {event?.direction} · {event?.entry} · {event?.split}</DialogDescription></DialogHeader>
      {event && report && <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <ResearchChart key={event.id} event={event} onNavigate={navigateEvent} />
        <div className="flex items-center gap-3"><MarketOpportunity instId={event.instrument} opportunity={JSON.parse(event.opportunityJSON)} /><Badge variant="outline">{event.scoreComplete ? 'Full scoring inputs' : 'Partial scoring inputs'}</Badge><span className="flex-1" /><Button variant="outline" onClick={() => navigateEvent(-1)}>Previous event</Button><Button variant="outline" onClick={() => navigateEvent(1)}>Next event</Button></div>
        <Table aria-label="Event outcomes"><TableHeader><TableRow>{['Hold', 'Gross', 'Net', 'MFE', 'MAE', 'Coverage'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{event.outcomes.map(o => <TableRow key={o.hours}><TableCell>{o.hours}h</TableCell><TableCell className={signed(o.gross)}>{researchPercent(o.gross)}</TableCell><TableCell className={signed(o.net)}>{researchPercent(o.net)}</TableCell><TableCell>{researchPercent(o.mfe)}</TableCell><TableCell>{researchPercent(o.mae)}</TableCell><TableCell>{o.reason ?? o.netReason ?? 'Complete'}</TableCell></TableRow>)}</TableBody></Table>
        <h3 className="font-semibold">Frozen rule decisions</h3><TraceNode trace={JSON.parse(event.traceJSON) as FilterTrace} config={parseFilterConfig(report.spec.rules[event.ruleIndex].filtersJSON)} context={context} />
        <details><summary>Input provenance</summary><p className="my-2 break-all text-xs text-muted-foreground">Dataset {report.manifestID}</p><Table aria-label="Event input provenance"><TableHeader><TableRow><TableHead>Input / source</TableHead><TableHead>Range</TableHead><TableHead>SHA-256</TableHead></TableRow></TableHeader><TableBody>{manifest?.sources.filter(source => event.sources.includes(source.id)).map(source => <TableRow key={source.id}><TableCell><div>{source.kind} · {source.kind === 'metadata' ? 'Verified instrument catalog' : source.module === 3 ? 'Recorded funding archive' : source.archive ? 'Archive reconstruction' : source.kind === 'local' ? 'Recorded Radar inputs' : 'Public REST'}</div><div className="break-all text-xs text-muted-foreground">{source.url}</div></TableCell><TableCell>{researchTime(source.from)} → {researchTime(source.through)}</TableCell><TableCell className="max-w-56 break-all text-xs">{source.rawHash ?? '—'}</TableCell></TableRow>)}</TableBody></Table></details>
      </div>}
    </DialogContent></Dialog>
  </main></MarketListViewport>
}
