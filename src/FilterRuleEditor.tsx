import { useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Copy, GripVertical, Plus, Square, SquareCheck, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FilterNameInput } from '@/FilterNameInput'
import { ExpressionInput, type ExpressionInputProps } from '@/FilterExpressionInput'
import { anchorOffset, bodyPresentation, captureScope, humanName, makeVisualBranch, renameValueReferences, ruleHelp, ruleSentence, timeWrapper } from '@/filter-builder'
import { expressionName, expressionSource, numberExpression, rawExpression, selectRuleLeft, type ExpressionTemplate } from '@/filter-expression'
import { cn } from '@/lib/utils'
import { canReceiveChildren, categoryComparisons, comparisons, duplicateRule, findParent, findRule, moveRule, newRuleID, removeRule, ruleKinds, unaryComparison, unwrapRule, updateRule, wrapRule, type EditorExpression, type FilterConfigV2, type FilterEditorState, type FilterMetric, type RuleKind, type RuleNode } from '@/rule-engine'

export function RulePicker({ value, choices, onChange, label }: { value: string; choices: string[][]; onChange: (value: string) => void; label: string }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger className="w-full" aria-label={label}><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectGroup>{choices.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</SelectGroup></SelectContent></Select>
}
function CategoryValueInput(props: ExpressionInputProps) {
  const [custom, setCustom] = useState(false)
  const choices = props.choices ?? []
  let literal: string | undefined
  try { const decoded: unknown = JSON.parse(props.value); if (typeof decoded === 'string') literal = decoded } catch { /* Native compilation owns expression parsing. */ }
  if (props.expressions?.[props.value]?.kind === 'text') literal = props.expressions[props.value].value
  const selected = choices.find(choice => choice.value === literal), text = choices.length === 0
  const expression = custom || (text ? literal === undefined : !selected)
  return <FieldGroup className="gap-2"><Field><FieldLabel>Right value</FieldLabel><RulePicker label="Right value" value={expression ? 'expression' : text ? 'literal' : selected!.value} choices={[...(text ? [['literal', 'Text value']] : choices.map(choice => [choice.value, choice.label])), ['expression', 'Another indicator / value…']]} onChange={value => { setCustom(value === 'expression'); if (value !== 'expression') props.onChange(JSON.stringify(value === 'literal' ? literal ?? '' : value)) }} /></Field>
    {text && !expression && <Field><FieldLabel>Text value</FieldLabel><Input value={literal ?? ''} aria-label="Right text value" spellCheck={false} onChange={event => props.onChange(JSON.stringify(event.target.value))} /><FieldDescription>Exact text, including the full OKX contract ID.</FieldDescription></Field>}
    {expression && <ExpressionInput {...props} />}
  </FieldGroup>
}
export type RuleDropTarget = { parent: string; index: number; into?: boolean }
export type RuleTreeContext = {
  config: FilterConfigV2; edit: (config: FilterConfigV2, selectedId?: string) => void; select: (id: string) => void; selectedId: string
  metrics: FilterMetric[]; units: Record<string, string>; expressions: Record<string, EditorExpression>; templates: ExpressionTemplate[]
  editor: FilterEditorState; setEditor: Dispatch<SetStateAction<FilterEditorState>>; disabled: boolean; guided: boolean
  dragging: string | null; setDragging: (id: string | null) => void; drop: RuleDropTarget | null; setDrop: (drop: RuleDropTarget | null) => void
  rememberExpression: (expression: EditorExpression) => void
  /** Opens the condition library targeting this group, so additions land where the user clicked. */
  addInto?: (id: string) => void
}
function changeRule(tree: RuleTreeContext, node: RuleNode, next: Partial<RuleNode>) { tree.edit({ ...tree.config, root: updateRule(tree.config.root, node.id, n => ({ ...n, ...next })) }) }
function callExpression(operation: string, args: EditorExpression[], unit: string): EditorExpression {
  const expression: EditorExpression = { kind: 'call', source: '', unit, operation, arguments: args, choices: [] }
  return { ...expression, source: expressionSource(expression) }
}
function resolvedExpression(source: string, tree: RuleTreeContext, unit = ''): EditorExpression {
  const found = tree.expressions[source]
  if (found) return found
  if (source.trim() && Number.isFinite(Number(source))) return numberExpression(source)
  const metric = tree.metrics.find(item => item.key.toLowerCase() === source.trim().toLowerCase())
  return metric ? { ...rawExpression(metric.key, metric.unit), kind: 'name', value: metric.key, choices: metric.choices } : rawExpression(source, unit)
}
function defaultMultiple(node: RuleNode, tree: RuleTreeContext, unit: string): EditorExpression {
  const source = resolvedExpression(node.left, tree, unit)
  const lag = callExpression('lag', [source, numberExpression('1')], unit)
  const mean = callExpression('mean', [lag, numberExpression('20')], unit)
  return callExpression('multiple', [mean, numberExpression('2')], unit)
}
function averageMultipleParts(expression: EditorExpression, node: RuleNode, tree: RuleTreeContext, unit: string) {
  const fallback = defaultMultiple(node, tree, unit)
  const multiple = expressionName(expression) === 'multiple' ? expression : fallback
  const candidate = multiple.arguments[0]
  const baseline = candidate && expressionName(candidate) === 'mean' ? candidate : fallback.arguments[0]
  const sample = baseline.arguments[0] ?? fallback.arguments[0].arguments[0]
  const lag = expressionName(sample) === 'lag' ? sample : callExpression('lag', [sample, numberExpression('0')], unit)
  return {
    source: lag.arguments[0],
    window: baseline.arguments[1] ?? numberExpression('20'),
    offset: lag.arguments[1] ?? numberExpression('1'),
    multiplier: multiple.arguments[1] ?? numberExpression('2'),
  }
}
function NumericReferenceInput({ node, tree, field = 'right', displayLabel = 'Threshold / reference value' }: { node: RuleNode; tree: RuleTreeContext; field?: 'right' | 'upper'; displayLabel?: string }) {
  const definitions = [...tree.config.definitions, ...(captureScope(tree.config.root, node.id) ?? [])]
  const source = node[field]
  const leftUnit = tree.units[node.left] ?? tree.metrics.find(item => item.key.toLowerCase() === node.left.trim().toLowerCase())?.unit ?? ''
  const resolved = resolvedExpression(source, tree, leftUnit)
  const mode = expressionName(resolved) === 'multiple' || /^multiple\s*\(/i.test(source) ? 'multiple' : source.trim() === '' || Number.isFinite(Number(source)) ? 'fixed' : 'value'
  const shared = { metrics: tree.metrics, definitions, units: tree.units, expressions: tree.expressions, templates: tree.templates.filter(item => item.name.toLowerCase() !== 'multiple'), onExpressionDraft: tree.rememberExpression, allowArithmetic: false }
  const replace = (expression: EditorExpression) => { tree.rememberExpression(expression); changeRule(tree, node, field === 'right' ? { right: expression.source } : { upper: expression.source }) }
  const setMode = (next: string) => {
    if (next === mode) return
    if (next === 'fixed') replace(numberExpression('0'))
    else if (next === 'multiple') replace(defaultMultiple(node, tree, leftUnit))
    else replace(callExpression('lag', [resolvedExpression(node.left, tree, leftUnit), numberExpression('1')], leftUnit))
  }
  const multiple = expressionName(resolved) === 'multiple' ? resolved : defaultMultiple(node, tree, leftUnit)
  const average = averageMultipleParts(multiple, node, tree, leftUnit)
  const updateAverage = (next: Partial<typeof average>) => {
    const parts = { ...average, ...next }
    const lag = callExpression('lag', [parts.source, parts.offset], leftUnit)
    const mean = callExpression('mean', [lag, parts.window], leftUnit)
    replace(callExpression('multiple', [mean, parts.multiplier], leftUnit))
  }
  return <FieldGroup className="gap-3">
    <Field><FieldLabel>{displayLabel}</FieldLabel><RulePicker label={`${displayLabel} type`} value={mode} choices={[["fixed", "Fixed threshold"], ["value", "Another value / indicator"], ["multiple", "Average × multiplier"]]} onChange={setMode} /></Field>
    {mode === 'fixed' && <Field><FieldLabel>Threshold</FieldLabel><Input type="number" step="any" value={source} aria-label={field === 'upper' ? 'Maximum threshold' : 'Threshold'} onChange={event => changeRule(tree, node, field === 'right' ? { right: event.target.value } : { upper: event.target.value })} /><FieldDescription>{leftUnit || 'Numeric value'}</FieldDescription></Field>}
    {mode === 'value' && <ExpressionInput label={field === 'upper' ? 'Maximum reference value' : 'Reference value'} displayLabel="Reference value" value={source} expression={resolved} onChange={next => changeRule(tree, node, { [field]: next })} unit={leftUnit} {...shared} />}
    {mode === 'multiple' && <FieldGroup className="gap-3 rounded-lg border p-3">
      <FieldGroup className="grid grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] items-start gap-3">
        <ExpressionInput {...shared} templates={[]} allowTransforms={false} label={field === 'upper' ? 'Maximum baseline indicator' : 'Baseline indicator'} displayLabel="Baseline indicator" value={average.source.source} expression={average.source} onChange={(next, expression) => updateAverage({ source: expression ?? resolvedExpression(next, tree, leftUnit) })} unit={leftUnit} />
        <Field><FieldLabel>Average window (h)</FieldLabel><Input type="number" min="1" step="1" value={average.window.value ?? average.window.source} aria-label={field === 'upper' ? 'Maximum baseline average window hours' : 'Baseline average window hours'} onChange={event => updateAverage({ window: numberExpression(event.target.value) })} /><FieldDescription>Hourly samples.</FieldDescription></Field>
        <Field><FieldLabel>End offset (h)</FieldLabel><Input type="number" min="0" step="1" value={average.offset.value ?? average.offset.source} aria-label={field === 'upper' ? 'Maximum baseline end offset hours' : 'Baseline end offset hours'} onChange={event => updateAverage({ offset: numberExpression(event.target.value) })} /><FieldDescription>1 excludes live hour.</FieldDescription></Field>
        <Field><FieldLabel>Multiplier</FieldLabel><Input type="number" min={Number.MIN_VALUE} step="any" value={average.multiplier.value ?? average.multiplier.source} aria-label={field === 'upper' ? 'Maximum baseline multiplier' : 'Baseline multiplier'} onChange={event => updateAverage({ multiplier: numberExpression(event.target.value) })} /><FieldDescription>Must be greater than 0.</FieldDescription></Field>
      </FieldGroup>
      <FieldDescription>The reference is the selected indicator's hourly average × multiplier. A zero, negative or unavailable average returns Unknown; the comparison never divides.</FieldDescription>
    </FieldGroup>}
  </FieldGroup>
}
function ConditionFields({ node, tree }: { node: RuleNode; tree: RuleTreeContext }) {
  const definitions = [...tree.config.definitions, ...(captureScope(tree.config.root, node.id) ?? [])]
  const propsUnit = (source: string) => tree.units[source] ?? tree.metrics.find(m => m.key.toLowerCase() === source.toLowerCase())?.unit
  const metric = tree.metrics.find(m => m.key.toLowerCase() === node.left.trim().toLowerCase())
  const categorical = metric ? !metric.numeric : ['category', 'text'].includes(propsUnit(node.left) ?? '')
  const choices = tree.expressions[node.left]?.choices ?? metric?.choices ?? []
  const shared = { metrics: tree.metrics, definitions, units: tree.units, expressions: tree.expressions, templates: tree.templates, onExpressionDraft: tree.rememberExpression }
  return <FieldGroup className="gap-3">
    <Field><FieldLabel>Comparison</FieldLabel><RulePicker label="Comparison" value={node.kind === 'condition' ? node.comparison : node.kind} choices={categorical ? categoryComparisons : [...comparisons, ['crossup', 'Crosses above'], ['crossdown', 'Crosses below']]} onChange={comparison => changeRule(tree, node, comparison.startsWith('cross') ? { kind: comparison as RuleKind } : { kind: 'condition', comparison })} />{node.kind !== 'condition' && <FieldDescription>{ruleHelp(node.kind)}</FieldDescription>}</Field>
    <FieldGroup className="grid grid-cols-2 items-start gap-3">
      <ExpressionInput label="Left expression" displayLabel="Indicator / value" value={node.left} onChange={left => changeRule(tree, node, { left })} onSelectExpression={(left, expression) => changeRule(tree, node, selectRuleLeft(node, left, tree.metrics, tree.expressions, tree.units, expression, tree.templates))} allowArithmetic={false} {...shared} />
      {(node.kind !== 'condition' || !unaryComparison(node.comparison)) && <FieldGroup className="gap-3">{node.kind === 'condition' && categorical ? <CategoryValueInput label="Right expression" value={node.right} onChange={right => changeRule(tree, node, { right })} choices={choices} unit={propsUnit(node.left)} {...shared} /> : <NumericReferenceInput node={node} tree={tree} displayLabel={node.kind === 'condition' && node.comparison === 'between' ? 'Minimum reference' : 'Threshold / reference value'} />}
        {node.kind === 'condition' && node.comparison === 'between' && <NumericReferenceInput node={node} tree={tree} field="upper" displayLabel="Maximum reference" />}
      </FieldGroup>}
    </FieldGroup>
  </FieldGroup>
}
function DataHour({ node, tree, label = 'Evaluation hour' }: { node: RuleNode; tree: RuleTreeContext; label?: string }) {
  const offset = anchorOffset(tree.config.root, node.id)
  return <Field><FieldLabel>{label}</FieldLabel><ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={node.mode} onValueChange={mode => { if (mode) changeRule(tree, node, { mode: mode as 'live' | 'closed' }) }} aria-label={label}><ToggleGroupItem value="live">Live</ToggleGroupItem><ToggleGroupItem value="closed">Closed</ToggleGroupItem></ToggleGroup><FieldDescription>{offset === 0 ? 'Evaluates the current live hour.' : `Evaluates ${offset}h before the live hour${offset > 1 ? '; includes inherited Closed anchors' : ' (last completed hour)'}.`}</FieldDescription></Field>
}
function BodyFields({ node, tree }: { node: RuleNode; tree: RuleTreeContext }) {
  const body = bodyPresentation(node)!
  const update = (comparison: string, period: string) => changeRule(tree, node, { children: node.children.map(n => ({ ...n, comparison, right: `EMA(${period})` })) })
  return <FieldGroup className="gap-3"><FieldGroup className="grid grid-cols-2 gap-3"><Field><FieldLabel>Whole body position</FieldLabel><RulePicker label="Whole body position" value={body.direction} choices={[["above", "Above EMA"], ["below", "Below EMA"]]} onChange={value => update(value === 'above' ? 'gt' : 'lt', body.period)} /></Field><Field><FieldLabel>EMA period (h)</FieldLabel><Input type="number" min="1" step="1" value={body.period} aria-label="Body EMA period hours" onChange={event => update(body.direction === 'above' ? 'gt' : 'lt', event.target.value)} /></Field></FieldGroup><FieldDescription>Both open and close must be strictly {body.direction} the EMA of that candle. Wicks are excluded; equality does not match.</FieldDescription><div className="flex gap-2">{node.children.map(child => <Button key={child.id} type="button" variant="ghost" size="sm" onClick={() => tree.select(child.id)}>Edit {child.left === 'Open' ? 'open' : 'close'} check</Button>)}</div></FieldGroup>
}
export function RuleInspector({ node, tree }: { node: RuleNode; tree: RuleTreeContext }) {
  const parent = findParent(tree.config.root, node.id), stage = parent?.kind === 'sequence'
  const core = timeWrapper(node) && node.children.length === 1 ? node.children[0] : node
  const body = bodyPresentation(core)
  const simpleTime = timeWrapper(node) || ['condition', 'crossup', 'crossdown'].includes(node.kind) || body
  const family = node.id === tree.config.root.id ? ['all', 'any'] : ['all', 'any', 'sequence'].includes(node.kind) ? ['all', 'any', 'sequence'] : ['not', 'every', 'recent', 'count', 'cooldown'].includes(node.kind) ? ['not', 'every', 'recent', 'count', 'cooldown'] : ['condition', 'crossup', 'crossdown']
  const change = (next: Partial<RuleNode>) => changeRule(tree, node, next)
  const wrap = (kind: string) => {
    if (kind === 'wrap') return
    const root = kind === 'unwrap' ? unwrapRule(tree.config.root, node.id) : wrapRule(tree.config.root, node.id, kind as RuleKind)
    const selected = kind === 'unwrap' ? node.children[0]?.id : findParent(root, node.id)?.id
    tree.edit({ ...tree.config, root }, selected)
  }
  return <FieldSet data-rule-id={node.id} data-rule-kind={node.kind} aria-label={node.name || 'Selected rule'} className="min-w-0 gap-3">
    <FieldLegend className="sr-only">Selected rule parameters</FieldLegend>
    <div className="flex items-center justify-between gap-3"><span className="min-w-0 font-medium">{ruleSentence(node, tree.metrics, tree.expressions, tree.templates)}</span><Badge variant="outline">{node.mode === 'closed' ? 'Closed' : 'Live'}</Badge></div>
    <FieldGroup className="gap-3">{['all', 'any'].includes(node.kind) && !body && <Field><FieldLabel>Match group</FieldLabel><ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={node.kind} aria-label="Match group" onValueChange={kind => { if (kind) change({ kind: kind as RuleKind }) }}><ToggleGroupItem value="all">All (AND)</ToggleGroupItem><ToggleGroupItem value="any">Any (OR)</ToggleGroupItem></ToggleGroup></Field>}<DataHour node={node} tree={tree} />
      {simpleTime && <Field><FieldLabel>Time requirement</FieldLabel><RulePicker label="Time requirement" value={timeWrapper(node) ? node.kind : 'now'} choices={[["now", "This hour"], ["every", "Every hour"], ["recent", "At least once"], ["count", "Occurrence count"], ["cooldown", "Cooldown after trigger"]]} onChange={kind => {
        if (kind === 'now' && timeWrapper(node)) wrap('unwrap')
        else if (kind !== 'now' && timeWrapper(node)) change({ kind: kind as RuleKind, hours: kind === 'cooldown' ? 0 : Math.max(1, node.hours) })
        else if (kind !== 'now') wrap(kind)
      }} /></Field>}
      {(timeWrapper(node) || node.kind === 'sequence') && <FieldGroup className="grid grid-cols-2 gap-3"><Field><FieldLabel>{node.kind === 'sequence' ? 'Total sequence window (h)' : node.kind === 'cooldown' ? 'Cooldown hours (0 disables)' : 'Window hours'}</FieldLabel><Input type="number" min={node.kind === 'cooldown' ? 0 : 1} step="1" value={node.hours} aria-label="Window hours" onChange={event => change({ hours: Number(event.target.value) })} /></Field>
        {node.kind === 'count' && <><Field><FieldLabel>Count comparison</FieldLabel><RulePicker label="Count comparison" value={node.comparison} choices={comparisons.filter(([key]) => ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'between'].includes(key))} onChange={comparison => change({ comparison })} /></Field><Field><FieldLabel>Count threshold</FieldLabel><Input type="number" min="0" step="1" value={node.minimum} aria-label="Count threshold" onChange={event => change({ minimum: Number(event.target.value) })} /></Field>{node.comparison === 'between' && <Field><FieldLabel>Maximum count</FieldLabel><Input type="number" min="0" step="1" value={node.upper} aria-label="Maximum count" onChange={event => change({ upper: event.target.value })} /></Field>}</>}
      </FieldGroup>}
      {stage && <FieldGroup className="grid grid-cols-2 gap-3"><Field><FieldLabel>Stage identifier</FieldLabel><FilterNameInput id={node.id} name={node.name} label="Stage name" editor={tree.editor} setEditor={tree.setEditor} onCommit={name => {
        const symbols = Object.fromEntries(node.captures.map(c => [`${node.name}.${c.name}`, `${name}.${c.name}`]))
        const next = renameValueReferences(tree.config, symbols, tree.expressions)
        tree.edit({ ...next, root: updateRule(next.root, node.id, n => ({ ...n, name })) })
      }} /><FieldDescription>Spaces become underscores. Later references update when the name is committed.</FieldDescription></Field><Field><FieldLabel>Maximum gap (h)</FieldLabel><Input type="number" min="1" step="1" value={node.gapHours} aria-label="Maximum stage gap hours" disabled={parent.children[0].id === node.id} onChange={event => change({ gapHours: Number(event.target.value) })} /><FieldDescription>{parent.children[0].id === node.id ? 'First stage uses the total sequence window.' : 'Maximum hours after the preceding stage.'}</FieldDescription></Field></FieldGroup>}
      {body ? <BodyFields node={core} tree={tree} /> : ['condition', 'crossup', 'crossdown'].includes(core.kind) ? <ConditionFields node={core} tree={tree} /> : null}
      {core !== node && core.mode === 'closed' && <DataHour node={core} tree={tree} label="Nested condition evaluation hour" />}
      <FieldDescription>{ruleHelp(node.kind)}</FieldDescription>
      {node.kind === 'sequence' && <ol className="flex flex-col gap-2 border-l pl-3" aria-label="Sequence stages">{node.children.map((child, index) => <li key={child.id}><Button type="button" variant="outline" className="w-full justify-start" onClick={() => tree.select(child.id)}><span>{index + 1}. {humanName(child.name || `Stage ${index + 1}`)}</span><span className="ml-auto">{index === 0 ? 'Start' : `Gap ≤ ${child.gapHours}h`}</span></Button><FieldDescription>{ruleSentence(child, tree.metrics, tree.expressions, tree.templates)}{child.captures.length > 0 && ` · Capture: ${child.captures.map(c => humanName(c.name)).join(', ')}`}</FieldDescription></li>)}</ol>}
      {stage && <FieldSet><FieldLegend>Capture a value at this stage</FieldLegend><FieldDescription>Later stages use the price captured at this event, even when the live reference moves.</FieldDescription><FieldGroup className="gap-3">{node.captures.map(item => <FieldGroup key={item.id} className="gap-2"><Field><FieldLabel>Capture name</FieldLabel><div className="flex gap-2"><FilterNameInput id={item.id} name={item.name} label="Capture name" editor={tree.editor} setEditor={tree.setEditor} onCommit={name => {
        const next = renameValueReferences(tree.config, { [`${node.name}.${item.name}`]: `${node.name}.${name}` }, tree.expressions)
        tree.edit({ ...next, root: updateRule(next.root, node.id, n => ({ ...n, captures: n.captures.map(c => c.id === item.id ? { ...c, name } : c) })) })
      }} /><Button type="button" variant="ghost" size="icon" aria-label="Remove capture" onClick={() => change({ captures: node.captures.filter(c => c.id !== item.id) })}><X aria-hidden="true" /></Button></div></Field><ExpressionInput label="Captured expression" displayLabel="Captured value" value={item.expression} onChange={expression => change({ captures: node.captures.map(c => c.id === item.id ? { ...c, expression } : c) })} metrics={tree.metrics} definitions={[...tree.config.definitions, ...(captureScope(tree.config.root, node.id) ?? [])]} units={tree.units} expressions={tree.expressions} templates={tree.templates} onExpressionDraft={tree.rememberExpression} /></FieldGroup>)}</FieldGroup><Button type="button" variant="outline" size="sm" onClick={() => change({ captures: [...node.captures, { id: newRuleID(), name: `value${node.captures.length + 1}`, expression: 'Price' }] })}><Plus data-icon="inline-start" aria-hidden="true" />Add capture</Button></FieldSet>}
      <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm"><ChevronDown data-icon="inline-start" aria-hidden="true" />Structure & name</Button></CollapsibleTrigger><CollapsibleContent className="pt-2"><FieldGroup className="gap-3"><Field><FieldLabel>Rule type</FieldLabel><RulePicker label="Rule type" value={node.kind} choices={ruleKinds.filter(item => family.includes(item.value)).map(item => [item.value, item.label])} onChange={kind => change({ kind: kind as RuleKind, ...(kind === 'cooldown' ? { hours: 0 } : ['every', 'recent', 'count', 'sequence'].includes(kind) ? { hours: Math.max(1, node.hours) } : {}), ...(kind === 'sequence' ? { children: node.children.map((c, i) => ({ ...c, name: /^[A-Za-z_]\w*$/.test(c.name) ? c.name : `stage${i + 1}` })) } : {}) })} /></Field>{!stage && <Field><FieldLabel>Optional name</FieldLabel><Input value={node.name} aria-label="Rule name" placeholder="Name this rule…" onChange={event => change({ name: event.target.value })} /></Field>}
        {node.id !== tree.config.root.id && <Field><FieldLabel>Wrap rule</FieldLabel><RulePicker label="Wrap rule" value="wrap" choices={[["wrap", "Wrap in…"], ["not", "NOT"], ["cooldown", "Cooldown after trigger"], ["every", "Every hour"], ["recent", "Recently"], ["count", "Occurrence count"], ["all", "AND group"], ["any", "OR group"], ...(['not', 'every', 'recent', 'count', 'cooldown', 'all', 'any'].includes(node.kind) && node.children.length === 1 ? [["unwrap", "Remove wrapper"]] : [])]} onChange={wrap} /></Field>}
        {canReceiveChildren(node) && <Button type="button" variant="outline" size="sm" onClick={() => { const child = makeVisualBranch(node.kind === 'sequence' ? 'condition' : 'all'); if (node.kind === 'sequence') child.name = `stage${node.children.length + 1}`; tree.edit({ ...tree.config, root: updateRule(tree.config.root, node.id, n => ({ ...n, children: [...n.children, child] })) }, child.id) }}><Plus data-icon="inline-start" aria-hidden="true" />Add {node.kind === 'sequence' ? 'stage' : 'nested group'}</Button>}
      </FieldGroup></CollapsibleContent></Collapsible>
    </FieldGroup>
  </FieldSet>
}
export function RuleOutline({ node, parent, index = 0, tree }: { node: RuleNode; parent?: RuleNode; index?: number; tree: RuleTreeContext }) {
  const card = useRef<HTMLDivElement>(null)
  const selected = tree.selectedId === node.id, folded = tree.editor.collapsed[node.id] ?? false
  const body = bodyPresentation(node), wrappedLeaf = timeWrapper(node) && node.children.length === 1 && (['condition', 'crossup', 'crossdown'].includes(node.children[0].kind) || bodyPresentation(node.children[0]))
  const showChildren = node.children.length > 0 && ((!body && !wrappedLeaf) || !selected && Boolean(findRule(node, tree.selectedId)))
  const move = (direction: number) => { if (parent) tree.edit({ ...tree.config, root: moveRule(tree.config.root, node.id, parent.id, direction > 0 ? index + 2 : index - 1) }) }
  const targetAt = (event: DragEvent<HTMLDivElement>): RuleDropTarget | null => {
    const bounds = card.current?.getBoundingClientRect(), heading = card.current?.firstElementChild?.getBoundingClientRect()
    if (!bounds || !heading) return null
    const edge = heading.height / 4
    if (canReceiveChildren(node) && (!parent || event.clientY > bounds.top + edge && event.clientY < bounds.bottom - edge)) return { parent: node.id, index: node.children.length, into: true }
    return parent ? { parent: parent.id, index: index + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0) } : null
  }
  const movedRoot = (target: RuleDropTarget | null) => tree.dragging && !tree.disabled && target ? moveRule(tree.config.root, tree.dragging, target.parent, target.index) : tree.config.root
  const finishDrag = () => { tree.setDragging(null); tree.setDrop(null) }
  const dragOver = (event: DragEvent<HTMLDivElement>, target: RuleDropTarget | null) => {
    if (!tree.dragging) return
    event.stopPropagation()
    if (!target || movedRoot(target) === tree.config.root) { event.dataTransfer.dropEffect = 'none'; tree.setDrop(null); return }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'
    if (tree.drop?.parent !== target.parent || tree.drop.index !== target.index || tree.drop.into !== target.into) tree.setDrop(target)
  }
  const drop = (event: DragEvent<HTMLDivElement>, target: RuleDropTarget | null) => {
    if (!tree.dragging) return
    event.preventDefault(); event.stopPropagation()
    const root = movedRoot(target)
    if (target && root !== tree.config.root) {
      tree.edit({ ...tree.config, root }, tree.dragging)
      tree.setEditor(current => ({ ...current, collapsed: { ...current.collapsed, [target.parent]: false } }))
    }
    finishDrag()
  }
  // WebKit cancels a native drag if its handle becomes inert during dragstart.
  const receiving = Boolean(tree.drop?.into && tree.drop.parent === node.id)
  return <div className={cn('relative', tree.dragging && 'select-none')} data-rule-outline-id={node.id} onDragOver={event => dragOver(event, targetAt(event))} onDrop={event => drop(event, targetAt(event))} onDragEnd={finishDrag} onDragLeave={event => {
    if (tree.dragging && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) tree.setDrop(null)
  }}>
    {parent && !tree.drop?.into && tree.drop?.parent === parent.id && tree.drop.index === index && <div data-surface="inherited" data-filter-insertion-line aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-1 h-0.5 bg-primary" />}
    <div ref={card} data-surface="panel" data-filter-drop-target={receiving ? '' : undefined} className={cn('relative flex flex-col gap-2 rounded-lg border bg-card p-2', (selected || receiving) && 'border-selection-border bg-state-selection', tree.dragging === node.id && 'opacity-50')}>
      <div className="flex items-start gap-1">
        {parent && <Button type="button" variant="ghost" size="icon" draggable={!tree.disabled} aria-label={`Move ${node.name || 'rule'}`} title="Drag onto a group to move inside; drag to an edge or use ArrowUp / ArrowDown to reorder" onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; tree.setDrop(null); tree.setDragging(node.id) }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1) } }}><GripVertical aria-hidden="true" /></Button>}
        <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start whitespace-normal text-left" aria-label={`Edit ${ruleSentence(node, tree.metrics, tree.expressions, tree.templates)}`} aria-pressed={selected} onClick={() => tree.select(node.id)}><span className="min-w-0"><span className="block">{node.name && `${parent?.kind === 'sequence' ? `${index + 1}. ` : ''}${humanName(node.name)} · `}{ruleSentence(node, tree.metrics, tree.expressions, tree.templates)}</span><span className="block text-xs text-muted-foreground">{anchorOffset(tree.config.root, node.id) > 0 ? `Closed anchor · −${anchorOffset(tree.config.root, node.id)}h` : 'Live hour'}{parent?.kind === 'sequence' && index > 0 && ` · gap ≤ ${node.gapHours}h`}</span></span></Button>
        {parent && <Button type="button" variant="ghost" size="icon" aria-label={`Select ${node.name || 'rule'} for bulk editing`} aria-pressed={tree.editor.selectedIds.includes(node.id)} onClick={() => tree.setEditor(current => ({ ...current, selectedIds: current.selectedIds.includes(node.id) ? current.selectedIds.filter(id => id !== node.id) : [...current.selectedIds, node.id] }))}>{tree.editor.selectedIds.includes(node.id) ? <SquareCheck aria-hidden="true" /> : <Square aria-hidden="true" />}</Button>}
        {tree.addInto && ['all', 'any', 'sequence'].includes(node.kind) && !body && <Button type="button" variant="ghost" size="icon" aria-label={`Add condition to ${node.name || ruleSentence(node, tree.metrics, tree.expressions, tree.templates)}`} title="Add a condition inside this group" onClick={() => tree.addInto?.(node.id)}><Plus aria-hidden="true" /></Button>}
        {showChildren && <Button type="button" variant="ghost" size="icon" aria-label={folded ? 'Expand rule' : 'Collapse rule'} aria-expanded={!folded} onClick={() => tree.setEditor(current => ({ ...current, collapsed: { ...current.collapsed, [node.id]: !folded } }))}><ChevronDown aria-hidden="true" className={cn(folded && '-rotate-90')} /></Button>}
      </div>
      {selected && parent && <div className="flex justify-end gap-1">{['all', 'any', 'sequence'].includes(parent.kind) && <Button type="button" variant="ghost" size="icon" aria-label="Duplicate rule" onClick={() => tree.edit({ ...tree.config, root: duplicateRule(tree.config.root, node.id) })}><Copy aria-hidden="true" /></Button>}<Button type="button" variant="ghost" size="icon" aria-label="Move rule up" disabled={index === 0} onClick={() => move(-1)}><ArrowUp aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon" aria-label="Move rule down" disabled={index === parent.children.length - 1} onClick={() => move(1)}><ArrowDown aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon" aria-label="Remove rule" onClick={() => tree.edit({ ...tree.config, root: removeRule(tree.config.root, node.id) }, parent.id)}><Trash2 aria-hidden="true" /></Button></div>}
      {selected && tree.guided && <div inert={tree.dragging === node.id} className="border-t p-2"><RuleInspector node={node} tree={tree} /></div>}
      {/* Overlay hints preserve the drag source's layout while WebKit starts its native session. */}
      {canReceiveChildren(node) && tree.dragging && movedRoot({ parent: node.id, index: node.children.length, into: true }) !== tree.config.root && <div data-surface="inherited" data-filter-drop-group={node.id} aria-hidden="true" className="pointer-events-none absolute right-2 bottom-2 rounded-md border border-dashed bg-state-selection px-2 py-1 text-xs text-muted-foreground">Drop into this group</div>}
    </div>
    {showChildren && !folded && <div className="ml-3 mt-2 flex flex-col gap-2 border-l pl-3">{node.children.map((child, childIndex) => <RuleOutline key={child.id} node={child} parent={node} index={childIndex} tree={tree} />)}</div>}
    {parent && index === parent.children.length - 1 && !tree.drop?.into && tree.drop?.parent === parent.id && tree.drop.index === index + 1 && <div data-surface="inherited" data-filter-insertion-line aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-1 h-0.5 bg-primary" />}
  </div>
}
