import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, Save, Trash2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SuitePhaseExplanation } from '@/SuitePhaseExplanation'
import { StrategyPhaseEditor } from '@/StrategyPhaseEditor'
import { useStrategyFilter } from '@/use-strategy-filter'
import { useSuite } from '@/use-suite'
import { MarketListViewport } from '@/MarketListViewport'
import { ModeTitle } from '@/ModeTitle'
import { MarketChart } from '@/MarketChart'
import { SuitePhaseBadges } from '@/SuitePhaseBadges'
import { emptyFilterConfig, initialLibraryPreferences, parseFilterConfig } from '@/rule-engine'
import { researchTime } from '@/research-types'
import { requestSuite, SUITE_PHASES, suiteSpec, type StrategyProfile, type SuiteReading, type SuiteDraft, type SuiteWorkspaceProps } from '@/suite-types'

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
  const initialized = useRef(false)
  const resetUniverse = universe.reset, resetSetup = setup.reset
  const load = useCallback((profile: StrategyProfile | null) => {
    setLoaded(profile); setName(profile?.name ?? 'My strategy')
    resetUniverse(profile?.universeJSON ?? JSON.stringify(emptyFilterConfig()))
    resetSetup(profile?.phaseRules.bullishSetup ?? JSON.stringify(emptyFilterConfig()))
    setError(''); setNotice(''); setTab('rules')
  }, [resetUniverse, resetSetup])
  const original = loaded ? [loaded.universeJSON, ...SUITE_PHASES.map(p => loaded.phaseRules[p.key])] : []
  const dirty = name !== (loaded?.name ?? 'My strategy') || models.some((m, i) => m.dirty || loaded && m.canonical !== null && m.canonical !== original[i])
  const draftJSON = JSON.stringify({profile:loaded,name,rules:models.map(m=>({json:JSON.stringify(m.draft??m.filters),source:m.editor.source,nameDrafts:m.editor.nameDrafts,expressionDrafts:m.editor.expressionDrafts,lastValid:m.lastValid}))} satisfies SuiteDraft)
  useEffect(() => {
    if(!suite.ready || initialized.current)return
    initialized.current=true
    const savedDraft=snapshot.draft
    if(savedDraft && savedDraft.rules.length >= 2){setLoaded(savedDraft.profile);setName(savedDraft.name);models.forEach((m,i)=>m.restore(savedDraft.rules[i]))}
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
  if (!hydrated) return <MarketListViewport><main className="flex min-h-[inherit] flex-col gap-4 p-4 tabular-nums" data-suite-workspace={mode}><header className="flex items-center gap-3 border-b pb-3"><Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{mode === 'radar' ? 'Radar' : 'Research'}</Button><ModeTitle mode={mode} pending={switchingMode} onSwitch={onSwitchMode} /></header>{suite.error ? <Alert variant="destructive"><AlertDescription>{suite.error}</AlertDescription></Alert> : <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />Loading saved strategies and drafts…</p>}</main></MarketListViewport>
  if (active && chart) return <MarketChart instId={chart} listOrder={readings.map(r => r.instrument)} turnoverOrder={readings.map(r => r.instrument)} onSelect={setChart} onBack={() => setChart(null)} />
  return <MarketListViewport><main className="flex min-h-[inherit] flex-col gap-4 p-4 tabular-nums" data-suite-workspace={mode}>
    <header className="flex items-center gap-3 border-b pb-3"><Button variant="ghost" onClick={() => void leave()}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{mode === 'radar' ? 'Radar' : 'Research'}</Button><ModeTitle mode={mode} pending={switchingMode || suite.pending} onSwitch={() => void switchMode()} /><span className="flex-1 text-xs text-muted-foreground">Shared Strategy Library · Rules for Radar and Research · OKX · 1h</span>{activeProfile && <Badge variant="secondary">Radar: {activeProfile.name} · r{activeProfile.revision}</Badge>}</header>
    {(error || suite.error) && <Alert variant="destructive"><AlertDescription>{error || suite.error}</AlertDescription></Alert>}
    {notice && <p role="status" aria-live="polite" className="text-sm">{notice}</p>}
    {loaded && latestLoaded && latestLoaded.revision !== loaded.revision && <Alert variant="warning"><AlertDescription>A newer saved revision is available: r{latestLoaded.revision}. Your draft is retained. <Button variant="link" onClick={() => choose(latestLoaded)}>Reload saved strategy…</Button></AlertDescription></Alert>}
    {loaded && !latestLoaded && <Alert variant="warning"><AlertDescription>This strategy is no longer in the shared library. Duplicate it to restore its saved rules, or choose another strategy.</AlertDescription></Alert>}
    <div className="flex items-center gap-3"><Field className="w-80"><FieldLabel>Saved strategies</FieldLabel><Select value={loaded?.id ?? 'new'} onValueChange={id => choose(snapshot.profiles.find(p => p.id === id) ?? null)}><SelectTrigger aria-label="Saved strategies"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="new">New strategy…</SelectItem>{snapshot.profiles.map(p => <SelectItem key={p.id} value={p.id}>{p.name} · r{p.revision}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Button variant="outline" disabled={!loaded || suite.pending} onClick={() => void copy()}><Copy data-icon="inline-start" aria-hidden="true" />Duplicate saved strategy</Button>
      <Button variant="outline" disabled={!loaded || suite.pending} onClick={() => void perform(async () => { await suite.perform({ action: 'select', profileID: loaded!.id }); setNotice('Saved revision activated in Radar. Confirmation monitoring starts with a quiet baseline.') })}>{mode === 'radar' ? 'Activate saved strategy' : 'Use saved strategy in Radar'}</Button>
      {activeProfile && <Button variant="ghost" onClick={() => void perform(async () => { await suite.perform({ action: 'select', profileID: '' }); setNotice('Strategy deactivated. Radar displays all markets; confirmed alerts resume after activation.') })}>Deactivate</Button>}
      <Button variant="outline" disabled={!loaded || suite.pending} onClick={() => void perform(async () => { if (loaded) { await requestSuite({mode,action:'draft',draft:JSON.parse(draftJSON) as SuiteDraft});onResearch(suiteSpec([loaded])) } })}>Backtest saved strategy</Button>
      <Button variant="ghost" disabled={!loaded || suite.pending} onClick={() => setConfirm({ kind: 'delete', profile: loaded ?? undefined })}><Trash2 data-icon="inline-start" aria-hidden="true" />Delete…</Button>
    </div>
    <Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="rules">Strategy rules</TabsTrigger>{mode === 'radar' && <><TabsTrigger value="signals">Confirmed setups</TabsTrigger></>}</TabsList>
      <TabsContent value="rules" className="flex flex-col gap-4"><form onSubmit={e => { e.preventDefault(); void save() }} className="flex flex-col gap-4"><FieldGroup><Field><FieldLabel htmlFor="suite-strategy-name">Strategy name</FieldLabel><Input id="suite-strategy-name" name="strategyName" autoComplete="off" value={name} onChange={e => setName(e.target.value)} /><FieldDescription>Universe and Bullish Setup are saved together. Drafts and previews never change confirmed alerts.</FieldDescription></Field></FieldGroup><div className="flex gap-3"><Button type="submit" disabled={suite.pending || models.some(m => !m.valid)}>{suite.pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" aria-hidden="true" />}Save strategy</Button>{dirty && <Badge variant="outline">Unsaved draft</Badge>}</div></form>
        <ToggleGroup type="single" variant="outline" value={phase} onValueChange={value => { if (value) setPhase(value) }} aria-label="Phase rule editor"><ToggleGroupItem value="universe">Universe</ToggleGroupItem>{SUITE_PHASES.map(p => <ToggleGroupItem key={p.key} value={p.key}>{p.label}</ToggleGroupItem>)}</ToggleGroup>
        {[{ key: 'universe', label: 'Universe', description: 'Restricts the contracts evaluated for Bullish Setup.' }, ...SUITE_PHASES].map((p,i) => <div key={p.key} hidden={phase !== p.key}><StrategyPhaseEditor label={p.label} description={p.description} model={models[i]} inputs={inputs} preferences={preferences} onPreferences={savePreferences} active={active && tab === 'rules' && phase === p.key} strategyID={mode === 'radar' ? loaded?.id ?? '' : ''} /></div>)}
      </TabsContent>
      <TabsContent value="signals" className="flex flex-col gap-3"><Field><FieldLabel htmlFor="phase-search">Search contracts</FieldLabel><Input id="phase-search" name="phaseSearch" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} placeholder="BTC, ETH…" /></Field>
        <Table aria-label="Confirmed phase readings"><TableHeader><TableRow>{['Contract', 'Bullish Setup', 'Confirmed close', 'Decision', 'Evidence'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{readings.slice(page*50,page*50+50).map(r => <TableRow key={r.instrument}><TableCell><Button variant="link" onClick={() => setChart(r.instrument)}>{r.instrument}</Button></TableCell><TableCell><SuitePhaseBadges confirmed={r} provisional={snapshot.provisional?.find(p => p.instrument === r.instrument)} /></TableCell><TableCell>{researchTime(r.hour+3_600_000)}</TableCell><TableCell title={r.reason}>{r.action}</TableCell><TableCell><div className="flex gap-2"><Button variant="ghost" onClick={() => void inspect(r)}>Explain</Button></div></TableCell></TableRow>)}</TableBody></Table>
        {!readings.length && <Empty><EmptyHeader><EmptyTitle>No active setup readings</EmptyTitle><EmptyDescription>Save and activate a complete strategy, or wait for the native collector to load its hourly inputs.</EmptyDescription></EmptyHeader></Empty>}
        <div className="flex gap-2"><Button variant="outline" disabled={page === 0} onClick={() => setPage(p => p-1)}>Previous contracts</Button><Button variant="outline" disabled={(page+1)*50 >= readings.length} onClick={() => setPage(p => p+1)}>Next contracts</Button></div>
      </TabsContent>
    </Tabs>
    <Dialog open={active && Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(null) }}><DialogContent><DialogHeader><DialogTitle>{confirm?.kind === 'load' ? 'Discard unsaved draft?' : 'Delete strategy?'}</DialogTitle><DialogDescription>{confirm?.kind === 'load' ? 'The saved strategy and existing studies remain available.' : 'This removes the selected local item. Saved experiments keep their frozen rules.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="destructive" onClick={() => void perform(async () => { const value = confirm; if (!value) return; if (value.kind === 'load') load(value.profile ?? null); else if (value.kind === 'delete') { await suite.perform({ action: 'delete',profileID: value.profile!.id }); load(null) }; setConfirm(null) })}>Confirm</Button></DialogFooter></DialogContent></Dialog>
    {active && activeProfile && <SuitePhaseExplanation instrument={detail?.instrument ?? null} profile={activeProfile} inputs={inputs} onClose={() => setDetail(null)} />}
  </main></MarketListViewport>
}
