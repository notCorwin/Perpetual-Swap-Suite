import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, CircleAlert, Copy, FlaskConical, Plus, Power, RotateCcw, Save, Trash2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SuitePhaseExplanation } from '@/SuitePhaseExplanation'
import { StrategyPhaseEditor, type StageStatus } from '@/StrategyPhaseEditor'
import { useStrategyFilter } from '@/use-strategy-filter'
import { useSuite } from '@/use-suite'
import { MarketListViewport } from '@/MarketListViewport'
import { ModeTitle } from '@/ModeTitle'
import { MarketChart } from '@/MarketChart'
import { SuitePhaseBadges } from '@/SuitePhaseBadges'
import { emptyFilterConfig, initialLibraryPreferences, parseFilterConfig } from '@/rule-engine'
import { researchTime } from '@/research-types'
import { isDefaultStrategy, requestSuite, SUITE_PHASES, suiteSpec, type StrategyProfile, type SuiteReading, type SuiteDraft, type SuiteWorkspaceProps } from '@/suite-types'

export function SuiteWorkspace({ mode, inputs, active, initialTab = 'rules', routeKey, onBack, onResearch, onSwitchMode, switchingMode }: SuiteWorkspaceProps) {
  const suite = useSuite(mode, active), snapshot = suite.snapshot
  const [loaded, setLoaded] = useState<StrategyProfile | null>(null), [name, setName] = useState('My strategy')
  const [hydrated, setHydrated] = useState(false)
  const [tab, setTab] = useState<string>(initialTab), [phase, setPhase] = useState('universe')
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [preferences, setPreferences] = useState(initialLibraryPreferences)
  const [page, setPage] = useState(0), [search, setSearch] = useState('')
  const [chart, setChart] = useState<string | null>(null), [detail, setDetail] = useState<SuiteReading | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'load' | 'delete'; profile?: StrategyProfile } | null>(null)
  const universe = useStrategyFilter(JSON.stringify(emptyFilterConfig()), 'universe'), setup = useStrategyFilter(JSON.stringify(emptyFilterConfig()), 'bullishSetup')
  const models = [universe, setup]
  const readOnly = isDefaultStrategy(loaded)
  const initialized = useRef(false)
  const resetUniverse = universe.reset, resetSetup = setup.reset
  const load = useCallback((profile: StrategyProfile | null) => {
    setLoaded(profile); setName(profile?.name ?? 'My strategy')
    resetUniverse(profile?.universeJSON ?? JSON.stringify(emptyFilterConfig()))
    resetSetup(profile?.phaseRules.bullishSetup ?? JSON.stringify(emptyFilterConfig()))
    setError(''); setNotice(''); setTab('rules')
  }, [resetUniverse, resetSetup])
  const original = loaded ? [loaded.universeJSON, ...SUITE_PHASES.map(p => loaded.phaseRules[p.key])] : []
  const dirty = !readOnly && (name !== (loaded?.name ?? 'My strategy') || models.some((m, i) => m.dirty || loaded && m.canonical !== null && m.canonical !== original[i]))
  const draftJSON = JSON.stringify({profile:loaded,name,rules:models.map(m=>({json:JSON.stringify(m.draft??m.filters),source:m.editor.source,nameDrafts:m.editor.nameDrafts,expressionDrafts:m.editor.expressionDrafts,lastValid:m.lastValid}))} satisfies SuiteDraft)
  useEffect(() => {
    if(!suite.ready || initialized.current)return
    initialized.current=true
    const savedDraft=snapshot.draft
    if(savedDraft && savedDraft.rules.length >= 2 && !isDefaultStrategy(savedDraft.profile)){setLoaded(savedDraft.profile);setName(savedDraft.name);models.forEach((m,i)=>m.restore(savedDraft.rules[i]))}
    else load(snapshot.profiles.find(p=>p.id===snapshot.selectedID)??snapshot.profiles[0]??null)
    setHydrated(true)
    // Initial hydration is applied once; later inventories must preserve edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[suite.ready])
  useEffect(() => { if (active && hydrated && routeKey !== undefined) setTab(initialTab) }, [routeKey, initialTab, active, hydrated])
  useEffect(()=>{
    if(!suite.ready || !initialized.current)return
    const timer=window.setTimeout(()=>{void requestSuite({mode,action:'draft',draft:JSON.parse(draftJSON) as SuiteDraft}).catch(cause=>setError(String(cause)))},350)
    return()=>window.clearTimeout(timer)
  },[suite.ready,mode,draftJSON])
  const leave = () => perform(async()=>{await requestSuite({mode,action:'draft',draft:JSON.parse(draftJSON) as SuiteDraft});onBack()})
  const switchMode = () => perform(async()=>{await requestSuite({mode,action:'draft',draft:JSON.parse(draftJSON) as SuiteDraft});onSwitchMode()})
  useEffect(() => {
    let stopped = false
    void window.webkit.messageHandlers.radar.postMessage({ rocPeriod: 9, marocPeriod: 9, sinceRevision: -1 }).then(value => { if (!stopped && !('unchanged' in value)) setPreferences(value.filterLibraryPreferences) }).catch(() => {})
    return () => { stopped = true }
  }, [])
  const perform = async (action: () => Promise<void>) => { setError(''); setNotice(''); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot complete this change.') } }
  const save = () => perform(async () => {
    if (readOnly) throw new Error('Default Strategy is built in and cannot be edited.')
    if (!name.trim()) { document.getElementById('suite-strategy-name')?.focus(); throw new Error('Give this strategy a name.') }
    const invalid = models.findIndex((m,i) => !m.valid || !m.canonical || i>0 && ['all','any'].includes(parseFilterConfig(m.canonical).root.kind) && parseFilterConfig(m.canonical).root.children.length===0)
    if (invalid >= 0) { setPhase(invalid ? SUITE_PHASES[invalid-1].key : 'universe'); throw new Error('Finish the Universe and Bullish Setup rules before saving.') }
    const profile: StrategyProfile = { id: loaded?.id ?? '', mode, name: name.trim(), universeJSON: universe.canonical!, phaseRules: Object.fromEntries(SUITE_PHASES.map((p,i) => [p.key,models[i+1].canonical!])) as StrategyProfile['phaseRules'], revision: loaded?.revision ?? 0, updatedAt: Date.now() }
    const response = await suite.perform({ action: 'save', profile })
    if (response.saved) { initialized.current = true; load(response.saved); setNotice(snapshot.selectedID===response.saved.id ? 'Strategy saved. Active revision updated with a quiet confirmation baseline; existing experiments keep their snapshots.' : 'Strategy saved. Activate it explicitly to change Radar monitoring; existing experiments keep their snapshots.') }
  })
  const choose = (profile: StrategyProfile | null) => { initialized.current = true; if (dirty) setConfirm({ kind: 'load', profile: profile ?? undefined }); else load(profile) }
  const copy = () => perform(async () => {
    if (!loaded) return
    const result = await suite.perform({ action: 'copy', profile: loaded })
    setNotice('Strategy duplicated in the shared library' + (result.saved ? ': ' + result.saved.name : '') + '. Both modes can use it.')
  })
  const latestLoaded = snapshot.profiles.find(profile => profile.id === loaded?.id)
  useEffect(() => {
    if (!active || !hydrated || dirty || !latestLoaded || latestLoaded.revision === loaded?.revision) return
    const previousTab = tab; load(latestLoaded); setTab(previousTab)
  }, [active, hydrated, dirty, latestLoaded, loaded?.revision, load, tab])
  const savePreferences = async (value: typeof preferences) => { await window.webkit.messageHandlers.radar.postMessage({ filterLibraryPreferencesJSON: JSON.stringify(value) }); setPreferences(value) }
  const readings = (snapshot.confirmed ?? []).filter(r => r.instrument.toLowerCase().includes(search.trim().toLowerCase()))
  const activeProfile = snapshot.profiles.find(p => p.id === snapshot.selectedID)
  const inspect = (reading: SuiteReading) => setDetail(reading)
  useEffect(() => {
    if (mode !== 'radar' || !active || !hydrated) return
    const openStrategy = () => {
      const id = window.radarNotificationStrategy
      const profile = snapshot.profiles.find(p => p.id === id)
      if (!profile) return
      delete window.radarNotificationStrategy
      choose(profile); setTab('rules')
    }
    window.addEventListener('radar-open-strategy',openStrategy);openStrategy()
    return () => window.removeEventListener('radar-open-strategy',openStrategy)
    // Consume the native route after inventory hydration; preserve any current draft warning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mode,active,hydrated,snapshot.profiles])
  // Pipeline overview: each stage reports its latest preview so both stay visible while one is edited.
  const [stageStatus, setStageStatus] = useState<Record<string, StageStatus>>({})
  const reportStatus = useCallback((key: string, next: StageStatus) => setStageStatus(current => {
    const old = current[key]
    return old && old.matches === next.matches && old.total === next.total && old.unknown === next.unknown ? current : { ...current, [key]: next }
  }), [])
  const invalidStage = models.findIndex(m => !m.compiling && !m.valid) >= 0 ? (i => i === 0 ? { label: 'Universe' } : SUITE_PHASES[i - 1])(models.findIndex(m => !m.compiling && !m.valid)) : null
  const stages = [{ key: 'universe', label: 'Universe', description: 'Which contracts are eligible. Bullish Setup only evaluates contracts that pass the Universe.' }, ...SUITE_PHASES]
  // ⌘S saves the whole strategy from anywhere in the workspace.
  const saveShortcut = useRef(save)
  useEffect(() => { saveShortcut.current = save })
  useEffect(() => {
    if (!active || !hydrated) return
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); void saveShortcut.current() } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [active, hydrated])
  if (!hydrated) return <MarketListViewport><main className="flex min-h-[inherit] flex-col gap-4 p-4 tabular-nums" data-suite-workspace={mode}><header className="flex items-center gap-3 border-b pb-3"><Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{mode === 'radar' ? 'Radar' : 'Research'}</Button><ModeTitle mode={mode} pending={switchingMode} onSwitch={onSwitchMode} /></header>{suite.error ? <Alert variant="destructive"><AlertDescription>{suite.error}</AlertDescription></Alert> : <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />Loading saved strategies and drafts…</p>}</main></MarketListViewport>
  if (active && chart) return <MarketChart instId={chart} listOrder={readings.map(r => r.instrument)} turnoverOrder={readings.map(r => r.instrument)} onSelect={setChart} onBack={() => setChart(null)} />
  return <MarketListViewport><main className="flex min-h-[inherit] flex-col gap-4 p-4 tabular-nums" data-suite-workspace={mode}>
    <header className="flex items-center gap-3 border-b pb-3"><Button variant="ghost" onClick={() => void leave()}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{mode === 'radar' ? 'Radar' : 'Research'}</Button><ModeTitle mode={mode} pending={switchingMode || suite.pending} onSwitch={() => void switchMode()} /><span className="flex-1 text-xs text-muted-foreground">Shared Strategy Library · Rules for Radar and Research · OKX · 1h</span>{activeProfile && <Badge variant="secondary">Radar: {activeProfile.name} · r{activeProfile.revision}</Badge>}</header>
    {(error || suite.error) && <Alert variant="destructive"><AlertDescription>{error || suite.error}</AlertDescription></Alert>}
    {notice && <p role="status" aria-live="polite" className="text-sm">{notice}</p>}
    {loaded && latestLoaded && latestLoaded.revision !== loaded.revision && <Alert variant="warning"><AlertDescription>A newer saved revision is available: r{latestLoaded.revision}. Your draft is retained. <Button variant="link" onClick={() => choose(latestLoaded)}>Reload saved strategy…</Button></AlertDescription></Alert>}
    {loaded && !latestLoaded && <Alert variant="warning"><AlertDescription>This strategy is no longer in the shared library. Duplicate it to restore its saved rules, or choose another strategy.</AlertDescription></Alert>}
    <div className="grid grid-cols-[16rem_minmax(0,1fr)] items-start gap-4">
      <nav aria-label="Saved strategies" className="flex flex-col gap-1 rounded-lg border p-2" data-strategy-library>
        <div className="flex items-center justify-between px-2 py-1"><span className="text-sm font-medium">Strategies</span><Button variant="ghost" size="icon-sm" aria-label="New strategy" title="New strategy" onClick={() => choose(null)}><Plus aria-hidden="true" /></Button></div>
        {!loaded && <Button variant="ghost" aria-pressed className="h-auto justify-start py-1.5 text-left"><span className="min-w-0 flex-1 truncate">{name.trim() || 'Untitled strategy'}</span><Badge variant="outline">Draft</Badge></Button>}
        {snapshot.profiles.map(p => <Button key={p.id} variant="ghost" aria-pressed={loaded?.id === p.id} aria-current={loaded?.id === p.id ? 'page' : undefined} data-strategy-id={p.id} className="h-auto justify-start py-1.5 text-left" onClick={() => { if (loaded?.id !== p.id) choose(p) }}>
          <span className="min-w-0 flex-1 truncate">{loaded?.id === p.id ? name.trim() || p.name : p.name}</span>
          {loaded?.id === p.id && dirty && <CircleAlert aria-label="Unsaved changes" className="text-warning" />}
          {snapshot.selectedID === p.id && <Badge variant="secondary">Radar</Badge>}
          <span className="text-xs text-muted-foreground">r{p.revision}</span>
        </Button>)}
        {!snapshot.profiles.length && <p className="px-2 py-1 text-xs text-muted-foreground">No saved strategies yet. Name this draft and save it.</p>}
      </nav>
      <div className="flex min-w-0 flex-col gap-4">
        <form onSubmit={e => { e.preventDefault(); void save() }} className="flex items-end gap-3" data-strategy-header>
          <Field className="min-w-0 flex-1"><FieldLabel htmlFor="suite-strategy-name">Strategy name</FieldLabel><Input id="suite-strategy-name" name="strategyName" autoComplete="off" value={name} disabled={readOnly} onChange={e => setName(e.target.value)} /></Field>
          <span role="status" aria-live="polite" className="flex h-(--control-height) items-center gap-1 text-xs text-muted-foreground" data-strategy-state={invalidStage ? 'invalid' : dirty ? 'dirty' : 'saved'}>{invalidStage ? <><CircleAlert aria-hidden="true" className="size-3.5 text-warning" />Finish {invalidStage.label} to save</> : dirty ? <><CircleAlert aria-hidden="true" className="size-3.5 text-warning" />Unsaved changes</> : loaded ? `Saved · r${loaded.revision}` : 'New strategy'}</span>
          {dirty && loaded && <Button type="button" variant="ghost" onClick={() => setConfirm({ kind: 'load', profile: latestLoaded ?? loaded })}><RotateCcw data-icon="inline-start" aria-hidden="true" />Revert…</Button>}
          <Button type="submit" title={readOnly ? 'Default Strategy is built in and cannot be edited' : 'Save strategy (⌘S)'} disabled={readOnly || suite.pending || models.some(m => !m.valid)}>{suite.pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" aria-hidden="true" />}Save strategy</Button>
        </form>
        <div className="flex items-center gap-2" role="toolbar" aria-label="Saved strategy actions">
          {loaded && snapshot.selectedID === loaded.id ? <><Badge variant="secondary"><Power data-icon="inline-start" aria-hidden="true" />Active in Radar · r{activeProfile?.revision}</Badge><Button variant="ghost" size="sm" disabled={suite.pending} onClick={() => void perform(async () => { await suite.perform({ action: 'select', profileID: '' }); setNotice('Strategy deactivated. Radar displays all markets; confirmed alerts resume after activation.') })}>Deactivate</Button></>
            : <Button variant="outline" size="sm" disabled={!loaded || suite.pending} title={dirty ? 'Activates the last saved revision, not this draft' : undefined} onClick={() => void perform(async () => { await suite.perform({ action: 'select', profileID: loaded!.id }); setNotice('Saved revision activated in Radar. Confirmation monitoring starts with a quiet baseline.') })}><Power data-icon="inline-start" aria-hidden="true" />{mode === 'radar' ? 'Activate saved strategy' : 'Use saved strategy in Radar'}</Button>}
          {activeProfile && loaded?.id !== activeProfile.id && <span className="text-xs text-muted-foreground">Radar uses {activeProfile.name} · r{activeProfile.revision}</span>}
          <Button variant="outline" size="sm" disabled={!loaded || suite.pending} onClick={() => void perform(async () => { if (loaded) { await requestSuite({mode,action:'draft',draft:JSON.parse(draftJSON) as SuiteDraft});onResearch(suiteSpec([loaded])) } })}><FlaskConical data-icon="inline-start" aria-hidden="true" />Backtest saved strategy</Button>
          <Button variant="outline" size="sm" disabled={!loaded || suite.pending} onClick={() => void copy()}><Copy data-icon="inline-start" aria-hidden="true" />Duplicate saved strategy</Button>
          {!readOnly && <Button variant="ghost" size="sm" className="ml-auto" disabled={!loaded || suite.pending} onClick={() => setConfirm({ kind: 'delete', profile: loaded ?? undefined })}><Trash2 data-icon="inline-start" aria-hidden="true" />Delete…</Button>}
        </div>
    <Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="rules">Strategy rules</TabsTrigger>{mode === 'radar' && <><TabsTrigger value="signals">Confirmed setups</TabsTrigger></>}</TabsList>
      <TabsContent value="rules" className="flex flex-col gap-4">
        <ToggleGroup type="single" variant="outline" spacing={0} value={phase} onValueChange={value => { if (value) setPhase(value) }} aria-label="Phase rule editor" data-strategy-pipeline>
          {stages.map((p, i) => { const s = stageStatus[p.key], m = models[i], broken = !m.compiling && !m.valid; return [
            i > 0 && <ChevronRight key={p.key + ':arrow'} aria-hidden="true" className="mx-1 text-muted-foreground" />,
            <ToggleGroupItem key={p.key} value={p.key} aria-label={p.label} aria-describedby={`stage-status-${p.key}`} className="h-auto flex-col items-start gap-0.5 px-3 py-1.5" data-stage={p.key}>
              <span className="flex items-center gap-1 font-medium">{broken && <CircleAlert aria-hidden="true" className="text-warning" />}{p.label}</span>
              <span id={`stage-status-${p.key}`} className="text-xs font-normal text-muted-foreground">{broken ? 'Needs attention' : m.compiling ? 'Checking…' : s ? `${s.matches} / ${s.total} pass${s.unknown ? ` · ${s.unknown} unknown` : ''}` : 'Preview pending'}</span>
            </ToggleGroupItem>] })}
        </ToggleGroup>
        {stages.map((p,i) => <div key={p.key} hidden={phase !== p.key}><StrategyPhaseEditor label={p.label} description={p.description} model={models[i]} inputs={inputs} preferences={preferences} onPreferences={savePreferences} active={active && tab === 'rules' && phase === p.key} strategyID={mode === 'radar' ? loaded?.id ?? '' : ''} readOnly={readOnly} statusKey={p.key} onStatus={reportStatus} /></div>)}
      </TabsContent>
      <TabsContent value="signals" className="flex flex-col gap-3"><Field><FieldLabel htmlFor="phase-search">Search contracts</FieldLabel><Input id="phase-search" name="phaseSearch" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} placeholder="BTC, ETH…" /></Field>
        <Table aria-label="Confirmed phase readings"><TableHeader><TableRow>{['Contract', 'Bullish Setup', 'Confirmed close', 'Decision', 'Evidence'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{readings.slice(page*50,page*50+50).map(r => <TableRow key={r.instrument}><TableCell><Button variant="link" onClick={() => setChart(r.instrument)}>{r.instrument}</Button></TableCell><TableCell><SuitePhaseBadges confirmed={r} provisional={snapshot.provisional?.find(p => p.instrument === r.instrument)} /></TableCell><TableCell>{researchTime(r.hour+3_600_000)}</TableCell><TableCell title={r.reason}>{r.action}</TableCell><TableCell><div className="flex gap-2"><Button variant="ghost" onClick={() => void inspect(r)}>Explain</Button></div></TableCell></TableRow>)}</TableBody></Table>
        {!readings.length && <Empty><EmptyHeader><EmptyTitle>No active setup readings</EmptyTitle><EmptyDescription>Save and activate a complete strategy, or wait for the native collector to load its hourly inputs.</EmptyDescription></EmptyHeader></Empty>}
        <div className="flex gap-2"><Button variant="outline" disabled={page === 0} onClick={() => setPage(p => p-1)}>Previous contracts</Button><Button variant="outline" disabled={(page+1)*50 >= readings.length} onClick={() => setPage(p => p+1)}>Next contracts</Button></div>
      </TabsContent>
    </Tabs>
      </div>
    </div>
    <Dialog open={active && Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(null) }}><DialogContent><DialogHeader><DialogTitle>{confirm?.kind === 'load' ? 'Discard unsaved draft?' : 'Delete strategy?'}</DialogTitle><DialogDescription>{confirm?.kind === 'load' ? 'The saved strategy and existing studies remain available.' : 'This removes the selected local item. Saved experiments keep their frozen rules.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="destructive" onClick={() => void perform(async () => { const value = confirm; if (!value) return; if (value.kind === 'load') load(value.profile ?? null); else if (value.kind === 'delete') { await suite.perform({ action: 'delete',profileID: value.profile!.id }); load(null) }; setConfirm(null) })}>Confirm</Button></DialogFooter></DialogContent></Dialog>
    {active && activeProfile && <SuitePhaseExplanation instrument={detail?.instrument ?? null} profile={activeProfile} inputs={inputs} onClose={() => setDetail(null)} />}
  </main></MarketListViewport>
}
