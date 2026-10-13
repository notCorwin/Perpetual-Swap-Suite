import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { CircleAlert, Check, ChevronDown, Copy, Filter, Plus, Redo2, Save, Trash2, Undo2, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FilterNameInput } from '@/FilterNameInput'
import { ExpressionInput } from '@/FilterExpressionInput'
import { RuleInspector, RuleOutline, RulePicker, type RuleDropTarget, type RuleTreeContext } from '@/FilterRuleEditor'
import { FilterRulePreview } from '@/FilterRulePreview'
import { RuleLibrary } from '@/RuleLibrary'
import { addLibraryRule, conditionLibrary, renameValueReferences, rulePath, topLevelSelection, visualPresets, type LibraryItem } from '@/filter-builder'
import type { ExpressionTemplate } from '@/filter-expression'
import { filterRuleSummary } from '@/filter-summary'
import { cn } from '@/lib/utils'
import { duplicateRule, emptyFilterConfig, findParent, findRule, newRuleID, parseFilterConfig, removeRule, ruleCount, updateRule, type EditorExpression, type FilterConfigV2, type FilterDraftRevision, type FilterEditorState, type FilterLibraryPreferences, type FilterMetric, type FilterTruth, type NativeMarketRow, type RuleNode } from '@/rule-engine'

type Props = {
  label?: string; embedded?: boolean; atClose?: boolean; strategyID?: string
  filters: FilterConfigV2; draft: FilterConfigV2 | null; editor: FilterEditorState
  onDraftChange: (draft: FilterConfigV2 | null) => void; onEditorChange: Dispatch<SetStateAction<FilterEditorState>>
  onApply: (filters: FilterConfigV2) => Promise<void>
  metrics: FilterMetric[]; templates: ExpressionTemplate[]; units: Record<string, string>; expressions: Record<string, EditorExpression>; diagnostics: string[]; valid: boolean; compiling: boolean; requiredHours: number
  preferences: FilterLibraryPreferences; onPreferences: (preferences: FilterLibraryPreferences) => Promise<void>
  rows: NativeMarketRow[]; results: Record<string, FilterTruth>; previewJSON: string | null; revision: number; onExplain: (id: string) => void
  matches: number; total: number; unknown: number; previewPending: boolean; history: { pending: number; completed: number; error: string } | null
}
export function StrategyRules(props: Props) {
  const { filters, draft: override, editor, onEditorChange, onDraftChange, metrics } = props
  const lastEdit = useRef(''), coalesceTimer = useRef<number | undefined>(undefined)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState(''), [feedback, setFeedback] = useState('')
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<RuleDropTarget | null>(null)
  const pendingName = Object.keys(editor.nameDrafts).length > 0
  const draft = override ?? filters, dirty = override !== null || pendingName
  useEffect(() => () => window.clearTimeout(coalesceTimer.current), [])
  const activeFilters = useMemo(() => props.previewJSON ? parseFilterConfig(props.previewJSON) : filters, [props.previewJSON, filters])
  const activeName = props.label ?? 'Strategy rules'
  const activeSummary = useMemo(() => filterRuleSummary(activeFilters, metrics, props.expressions, props.templates), [activeFilters, metrics, props.expressions, props.templates])
  const activeCount = ruleCount(activeFilters.root)
  const selectedRule = findRule(draft.root, editor.selectedRuleId ?? '') ?? draft.root
  const guided = props.preferences.layout === 'guided'
  const record = (source: string | null, selectedId?: string, nextConfig = draft) => {
    const field = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.getAttribute('aria-label') ?? document.activeElement.id : ''
    const coalesce = Boolean(field && lastEdit.current === field)
    const previous: FilterDraftRevision = { config: draft, source: editor.source, expressionDrafts: editor.expressionDrafts }
    const sources = new Set<string>(nextConfig.definitions.map(d => d.expression))
    const names = new Set<string>(nextConfig.definitions.map(d => d.id))
    const collect = (node: RuleNode) => { names.add(node.id); sources.add(node.left); sources.add(node.right); sources.add(node.upper); node.captures.forEach(c => { sources.add(c.expression); names.add(c.id) }); node.children.forEach(collect) }
    collect(nextConfig.root)
    onEditorChange(current => ({ ...current, source, selectedRuleId: selectedId ?? current.selectedRuleId, past: coalesce ? current.past : [...current.past, previous].slice(-40), future: [], nameDrafts: Object.fromEntries(Object.entries(current.nameDrafts).filter(([id]) => names.has(id))), expressionDrafts: Object.fromEntries(Object.entries(current.expressionDrafts).filter(([key]) => sources.has(key))) }))
    lastEdit.current = field; window.clearTimeout(coalesceTimer.current); coalesceTimer.current = window.setTimeout(() => { lastEdit.current = '' }, 700); setSaveError(''); setFeedback('')
  }
  const edit = (config: FilterConfigV2, selectedId?: string) => { record(null, selectedId ?? selectedRule.id, config); onDraftChange(config) }
  const travel = (direction: 'undo' | 'redo') => {
    const list = direction === 'undo' ? editor.past : editor.future, next = list[list.length - 1]
    if (!next) return
    const current = { config: draft, source: editor.source, expressionDrafts: editor.expressionDrafts }
    onEditorChange(value => ({ ...value, source: next.source, nameDrafts: {}, expressionDrafts: next.expressionDrafts ?? {}, past: direction === 'undo' ? value.past.slice(0, -1) : [...value.past, current], future: direction === 'redo' ? value.future.slice(0, -1) : [...value.future, current], selectedIds: [] }))
    onDraftChange(next.config); lastEdit.current = ''; setSaveError(''); setFeedback('')
  }
  const perform = async (action: () => Promise<void>, success: string) => { setSaving(true); setSaveError(''); try { await action(); setFeedback(success) } catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Cannot save strategy rules.') } finally { setSaving(false) } }
  const applyDisabled = saving || !props.valid || props.compiling || pendingName
  const apply = () => { void perform(async () => { await props.onApply(draft); onEditorChange(current => ({ ...current, source: null })) }, props.embedded ? 'Rules kept. Save strategy to apply Universe and Bullish Setup.' : 'Universe saved to the strategy.') }
  const preferences = (next: FilterLibraryPreferences) => { void props.onPreferences(next).catch(cause => setSaveError(cause instanceof Error ? cause.message : 'Cannot save condition library preferences.')) }
  const select = (id: string) => onEditorChange(current => ({ ...current, selectedRuleId: id, collapsed: { ...current.collapsed, ...Object.fromEntries(rulePath(draft.root, id).map(node => [node.id, false])) } }))
  const add = (item: LibraryItem) => { const next = addLibraryRule(draft, selectedRule.id, item); edit(next.config, next.selectedId) }
  const preset = (id: string) => { const item = conditionLibrary(metrics, props.templates).find(item => item.id === id); if (item) { add(item); preferences({ ...props.preferences, recent: [id, ...props.preferences.recent.filter(item => item !== id)].slice(0, 12) }) } }
  const bulkIds = topLevelSelection(draft.root, editor.selectedIds)
  const bulk = (action: 'live' | 'closed' | 'copy' | 'delete') => {
    let root = draft.root
    for (const id of bulkIds) root = action === 'copy' ? duplicateRule(root, id) : action === 'delete' ? removeRule(root, id) : updateRule(root, id, n => ({ ...n, mode: action }))
    edit({ ...draft, root }); if (action === 'delete') onEditorChange(current => ({ ...current, selectedIds: [] }))
  }
  const rememberExpression = (expression: EditorExpression) => onEditorChange(current => ({ ...current, expressionDrafts: { ...current.expressionDrafts, [expression.source]: expression } }))
  const tree: RuleTreeContext = { config: draft, edit, select, selectedId: selectedRule.id, metrics, units: props.units, expressions: props.expressions, templates: props.templates, editor, setEditor: onEditorChange, disabled: saving, guided, rememberExpression, dragging, setDragging, drop, setDrop, addInto: id => { select(id); setLibraryOpen(true) } }
  const preview = <FilterRulePreview nodeId={selectedRule.id} rows={props.rows} results={props.results} filtersJSON={props.previewJSON} revision={props.revision} instId={editor.explainId} onSelect={id => onEditorChange(current => ({ ...current, explainId: id }))} onExplain={props.onExplain} metrics={metrics} expressions={props.expressions} units={props.units} templates={props.templates} valid={props.valid} atClose={props.atClose} strategyID={props.strategyID} />
  return <Collapsible open={editor.open} onOpenChange={open => onEditorChange(current => ({ ...current, open }))} className="border-b px-4 py-3" onKeyDown={event => {
    if (event.defaultPrevented) return
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    if (event.ctrlKey && event.key === ' ') { event.preventDefault(); setLibraryOpen(true) }
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo') }
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); edit({ ...draft, root: duplicateRule(draft.root, selectedRule.id) }) }
    // Delete only acts on focus inside the rule tree, never from inspector controls.
    const inTree = event.target instanceof Element && event.target.closest('[data-rule-outline-id]') && !event.target.closest('[data-rule-id]')
    if (!typing && inTree && ['Delete', 'Backspace'].includes(event.key) && selectedRule.id !== draft.root.id) {
      event.preventDefault()
      edit({ ...draft, root: removeRule(draft.root, selectedRule.id) }, findParent(draft.root, selectedRule.id)?.id ?? draft.root.id)
    }
  }}>
    <div className="flex min-w-0 items-center gap-3" role="group" aria-label="Current strategy rules" data-filter-summary>
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="shrink-0"><Filter data-icon="inline-start" aria-hidden="true" />{props.label ?? 'Strategy rules'}<ChevronDown data-icon="inline-end" aria-hidden="true" className={cn(!editor.open && '-rotate-90')} /></Button></CollapsibleTrigger>
      {dirty && !props.embedded && <Badge variant="warning" data-filter-unsaved-badge><CircleAlert data-icon="inline-start" aria-hidden="true" />Unsaved changes</Badge>}
      <Badge variant="secondary" className="max-w-64" title={activeName} data-filter-name><span className="truncate">{activeName}</span></Badge>
      <Badge variant="outline" data-filter-count>{activeCount} {activeCount === 1 ? 'condition' : 'conditions'}</Badge>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={activeSummary} data-filter-rules>{activeSummary}</span>
      <span className="shrink-0 text-xs text-muted-foreground" role="status" data-strategy-match-count={props.matches} data-rule-draft-state={props.compiling ? 'compiling' : !props.valid || pendingName ? 'invalid' : 'valid'}>{props.matches} / {props.total} markets · {props.unknown} Unknown{props.compiling ? ' · Compiling…' : !props.valid ? ' · Invalid draft · Last valid preview' : props.previewPending ? ' · Updating preview…' : dirty ? ' · Draft preview' : ' · Applied'}</span>
    </div>
    {dirty && !props.embedded && <Alert variant="warning" role="status" aria-live="polite" aria-atomic="true" aria-busy={saving} className="mt-3" data-filter-unsaved>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{saving ? 'Saving rule changes…' : 'Unsaved rule changes'}</AlertTitle>
      <AlertDescription>{props.embedded ? props.compiling ? 'Checking these rules. Save strategy applies Universe and Bullish Setup together.' : pendingName ? 'Finish editing the rule name before keeping these rules.' : !props.valid ? 'Fix the rule errors before keeping these rules. The last valid preview remains active.' : 'These rules are a strategy draft. Keep them for preview; Save strategy applies all rules together.' : props.compiling ? 'Checking your draft. Save Universe when validation finishes to update the strategy.' : pendingName ? 'Finish editing the rule name, then save Universe to update the strategy.' : !props.valid ? 'Fix the rule errors before applying. The last valid preview remains active.' : 'These changes are previewed only. Save Universe to update the strategy.'}</AlertDescription>
      <AlertAction><Button type="button" size="sm" disabled={applyDisabled} onClick={apply}>{saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Save data-icon="inline-start" aria-hidden="true" />}{props.embedded ? 'Keep rules' : 'Save Universe'}</Button></AlertAction>
    </Alert>}
    <CollapsibleContent className="pt-3"><fieldset disabled={saving} className="flex flex-col gap-4"><legend className="sr-only">Strategy rule editor</legend>
      <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Rule judgments</p><p className="text-xs text-muted-foreground">Choose values, comparisons and explicit thresholds. Unknown data never becomes a match.</p></div><ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={props.preferences.layout} onValueChange={layout => { if (layout) preferences({ ...props.preferences, layout: layout as FilterLibraryPreferences['layout'] }) }} aria-label="Rule layout"><ToggleGroupItem value="sentences">Sentence rows</ToggleGroupItem><ToggleGroupItem value="guided">Guided cards</ToggleGroupItem></ToggleGroup></div>
        <FieldGroup className="gap-3"><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Start with a condition</span>{visualPresets.filter(p => ['preset:oi', 'preset:body', 'preset:volume', 'preset:sequence'].includes(p.id)).map(p => <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => preset(p.id)}>{p.label}</Button>)}</div>
          <div className="flex items-center gap-2"><RuleLibrary metrics={metrics} templates={props.templates} preferences={props.preferences} onPreferences={preferences} onAdd={add} open={libraryOpen} onOpenChange={setLibraryOpen} /><Button type="button" variant="outline" onClick={() => preset('rule:all')}><Plus data-icon="inline-start" aria-hidden="true" />Add group</Button><div className="w-64"><RulePicker label="Rule example" value="example" choices={[["example", "More ready-to-use conditions…"], ...visualPresets.map(p => [p.id, p.label])]} onChange={value => { if (value !== 'example') preset(value) }} /></div><span className="text-xs text-muted-foreground">Ctrl+Space to find a condition</span><div className="ml-auto flex items-center gap-1"><Button type="button" variant="ghost" size="icon" aria-label="Undo rule edit" disabled={!editor.past.length} onClick={() => travel('undo')}><Undo2 aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon" aria-label="Redo rule edit" disabled={!editor.future.length} onClick={() => travel('redo')}><Redo2 aria-hidden="true" /></Button></div></div>
          {bulkIds.length > 0 && <div className="flex items-center gap-2"><Badge variant="outline">{bulkIds.length} selected</Badge><Button type="button" variant="outline" size="sm" onClick={() => bulk('live')}>Set Live</Button><Button type="button" variant="outline" size="sm" onClick={() => bulk('closed')}>Set Closed</Button><Button type="button" variant="outline" size="sm" onClick={() => bulk('copy')}><Copy data-icon="inline-start" aria-hidden="true" />Duplicate selected</Button><Button type="button" variant="outline" size="sm" onClick={() => bulk('delete')}><Trash2 data-icon="inline-start" aria-hidden="true" />Remove selected</Button><Button type="button" variant="ghost" size="sm" onClick={() => onEditorChange(current => ({ ...current, selectedIds: [] }))}>Clear selection</Button></div>}
          <div className={cn('grid items-start gap-4', !guided && 'grid-cols-[minmax(0,1fr)_minmax(36rem,0.85fr)]')} data-rule-layout={props.preferences.layout}>
            <div className="flex min-w-0 flex-col gap-3"><RuleOutline node={draft.root} tree={tree} />{!draft.root.children.length && <Empty><EmptyHeader><EmptyTitle>All contracts in the universe</EmptyTitle><EmptyDescription>Choose a ready-to-use condition or search the complete library. Every market restriction is visible in the rule tree.</EmptyDescription></EmptyHeader></Empty>}{guided && preview}</div>
            {!guided && <aside data-surface="panel" className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4" aria-label="Selected rule editor"><RuleInspector key={selectedRule.id} node={selectedRule} tree={tree} />{props.diagnostics.length > 0 && <FieldError role="alert">{props.diagnostics.join(' ')}</FieldError>}{preview}</aside>}
          </div>
          <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm"><ChevronDown data-icon="inline-start" aria-hidden="true" />Reusable values{draft.definitions.length > 0 ? ` (${draft.definitions.length})` : ''}</Button></CollapsibleTrigger><CollapsibleContent className="pt-3"><FieldSet><FieldLegend>Reusable values</FieldLegend><FieldDescription>Build a value with indicators and calculation blocks, give it a name, then select it in any condition.</FieldDescription><FieldGroup className="mt-3 gap-3">{draft.definitions.map(item => <FieldGroup key={item.id} className="grid grid-cols-[16rem_minmax(0,1fr)_auto] items-start gap-3"><Field><FieldLabel>Value name</FieldLabel><FilterNameInput id={item.id} name={item.name} label="Value name" editor={editor} setEditor={onEditorChange} onCommit={name => {
        const next = renameValueReferences(draft, { [item.name]: name }, props.expressions)
        edit({ ...next, definitions: next.definitions.map(c => c.id === item.id ? { ...c, name } : c) })
      }} /><FieldDescription>Spaces become underscores; references update automatically.</FieldDescription></Field><ExpressionInput label="Reusable value" value={item.expression} metrics={metrics} units={props.units} expressions={props.expressions} templates={props.templates} onExpressionDraft={rememberExpression} definitions={draft.definitions.filter(c => c.id !== item.id)} onChange={expression => edit({ ...draft, definitions: draft.definitions.map(c => c.id === item.id ? { ...c, expression } : c) })} /><Button type="button" variant="ghost" size="icon" className="mt-6" aria-label="Remove reusable value" onClick={() => edit({ ...draft, definitions: draft.definitions.filter(c => c.id !== item.id) })}><X aria-hidden="true" /></Button></FieldGroup>)}</FieldGroup><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { let i = 1; while (draft.definitions.some(item => item.name === `value${i}`)) i++; edit({ ...draft, definitions: [...draft.definitions, { id: newRuleID(), name: `value${i}`, expression: 'Price' }] }) }}><Plus data-icon="inline-start" aria-hidden="true" />Add reusable value</Button></FieldSet></CollapsibleContent></Collapsible>
        </FieldGroup>
      {props.diagnostics.length > 0 && <FieldError role="alert">{props.diagnostics.join(' ')} Last valid preview remains active.</FieldError>}{pendingName && <FieldDescription>Press Enter or leave the name field to update its references before applying.</FieldDescription>}
      <div className="flex items-center gap-2">{!props.embedded && <Button type="button" disabled={applyDisabled} onClick={apply}>{saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Check data-icon="inline-start" aria-hidden="true" />}Save Universe</Button>}<Button type="button" variant="outline" disabled={!dirty} onClick={() => { record(null); onDraftChange(null); onEditorChange(current => ({ ...current, nameDrafts: {}, expressionDrafts: {} })); setFeedback(props.embedded ? `${props.label ?? 'Stage'} restored to the saved rules.` : 'Saved Universe restored.') }}>Discard changes</Button><Button type="button" variant="ghost" onClick={() => { edit(emptyFilterConfig()); onEditorChange(current => ({ ...current, selectedRuleId: null, selectedIds: [] })) }}>Reset draft</Button><span className="ml-auto text-xs text-muted-foreground">Required history: {props.requiredHours}h · only True matches</span></div>
    </fieldset>{props.history && props.history.pending > 0 && <p className="mt-2 text-xs text-muted-foreground" role="status">Loading rule history for {props.history.pending} contracts · {props.history.completed} completed.</p>}{props.history?.error && <FieldError>{props.history.error} Available history remains usable.</FieldError>}</CollapsibleContent>
    {saveError && <FieldError role="alert" className="mt-2">{saveError}</FieldError>}{feedback && <p className="mt-2 text-xs text-muted-foreground" role="status">{feedback}</p>}
  </Collapsible>
}
