import { useId, useRef, useState } from "react"
import { ChevronDown, ChevronsUpDown, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { arithmeticExpression, arithmeticOperations, expressionName, expressionSource, expressionTemplates, numberExpression, rawExpression, templateExpression, withExpressionArguments, type ExpressionTemplate } from "@/filter-expression"
import { expressionLabel, humanName } from "@/filter-builder"
import { replacedConditionMetrics, type EditorExpression, type FilterMetric, type NamedFormula } from "@/rule-engine"

export type ExpressionInputProps = {
  label: string; displayLabel?: string; value: string; onChange: (value: string, expression?: EditorExpression) => void; onSelectExpression?: (value: string, expression?: EditorExpression) => void
  metrics: FilterMetric[]; definitions: NamedFormula[]; choices?: { value: string; label: string }[]; unit?: string
  units?: Record<string, string>; expressions?: Record<string, EditorExpression>; expression?: EditorExpression
  templates?: ExpressionTemplate[]
  onExpressionDraft?: (expression: EditorExpression) => void
  allowArithmetic?: boolean
  allowTransforms?: boolean
}
function ExpressionSelect({ label, value, choices, onChange }: { label: string; value: string; choices: string[][]; onChange: (value: string) => void }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger className="w-full" aria-label={label}><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectGroup>{choices.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</SelectGroup></SelectContent></Select>
}

export function ExpressionInput({ label, displayLabel = label, value, onChange, onSelectExpression, metrics, definitions, choices = [], unit, units = {}, expressions = {}, expression, templates = expressionTemplates, onExpressionDraft, allowArithmetic = true, allowTransforms = true }: ExpressionInputProps) {
  const [open, setOpen] = useState(false), [partsOpen, setPartsOpen] = useState(true)
  const [edited, setEdited] = useState<EditorExpression | null>(null)
  const fieldID = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const selectedExpression = useRef(false)
  const reading = metrics.find(metric => metric.key.toLowerCase() === value.trim().toLowerCase())
  const resolved = expressions[value] ?? expression
  const tree = resolved && resolved.kind !== "raw" ? resolved : edited?.source === value ? edited : resolved ?? rawExpression(value, reading?.unit ?? units[value] ?? "")
  const template = templates.find(item => item.name.toLowerCase() === expressionName(tree))
  const numericConstant = Number.isFinite(Number(value)) && Boolean(value.trim()) || resolved?.unit === "constant" || tree.kind === "number"
  const resolvedUnit = reading?.unit ?? resolved?.unit ?? units[value] ?? (tree.unit === "source unit" ? "" : tree.unit)
  const description = numericConstant ? unit ? `${unit} (constant)` : "Numeric constant" : resolvedUnit || unit || "Enter an expression to resolve its unit"
  const visualLabel = reading?.label ?? definitions.find(item => item.name === value.trim())?.name ?? (tree.kind === "raw" ? "Choose a value" : expressionLabel(tree, metrics, templates))
  const textConstant = tree.kind === "text"
  const visual = !numericConstant && !textConstant
  const changeTree = (next: EditorExpression, selecting = false) => {
    next = { ...next, source: expressionSource(next) }; setEdited(next); setPartsOpen(true)
    onExpressionDraft?.(next)
    if (selecting && onSelectExpression) onSelectExpression(next.source, next)
    else onChange(next.source, next)
  }
  const insert = (next: EditorExpression) => { changeTree(next, true); selectedExpression.current = true; setOpen(false); trigger.current?.focus() }
  const shared = { metrics, definitions, units, expressions, templates, onExpressionDraft, allowArithmetic, allowTransforms }
  const wrappers = templates.filter(item => item.parameters[0]?.kind === "expression" && (!["category", "text"].includes(resolvedUnit) || ["closed", "live", "BTC"].includes(item.name)))
  const visibleMetrics = metrics.filter(metric => !replacedConditionMetrics.has(metric.key))
  const hasParts = ["binary", "unary"].includes(tree.kind) || tree.kind === "call" && template
  return <FieldGroup className="gap-2" data-expression-field={label} data-expression-source={value}>
    <Field>
      <FieldLabel htmlFor={fieldID}>{displayLabel}</FieldLabel>
      <div className="flex items-center gap-1">
        {!visual && <Input id={fieldID} value={textConstant ? tree.value ?? "" : value} inputMode={numericConstant ? "decimal" : undefined} onChange={event => changeTree(textConstant ? { ...rawExpression(JSON.stringify(event.target.value), "text"), kind: "text", value: event.target.value } : numberExpression(event.target.value))} onKeyDown={event => { if (event.key === " " && event.ctrlKey) { event.preventDefault(); setOpen(true) } }} aria-label={label} autoComplete="off" spellCheck={false} />}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild><Button ref={trigger} id={visual ? fieldID : undefined} type="button" variant="outline" size={visual ? "default" : "icon"} className={cn(visual && "min-w-0 flex-1 justify-between")} role="combobox" aria-expanded={open} aria-label={`Choose ${label}`} title="Choose an indicator, value block, or named value" onKeyDown={event => { if (event.key === "ArrowDown" || event.key === " " && event.ctrlKey) { event.preventDefault(); setOpen(true) } }}>{visual ? <><span className="truncate">{visualLabel}</span><ChevronsUpDown data-icon="inline-end" aria-hidden="true" /></> : <Search aria-hidden="true" />}</Button></PopoverTrigger>
          <PopoverContent data-expression-picker={label} className="w-[28rem] p-0" align="start" onCloseAutoFocus={event => { if (selectedExpression.current) { event.preventDefault(); selectedExpression.current = false } }}><Command>
            <CommandInput placeholder="Search indicators (e.g. OI Trend)…" />
            <CommandList><CommandEmpty>No matching expressions.</CommandEmpty>
              <CommandGroup heading="Constants"><CommandItem value="Numeric value constant" onSelect={() => insert(numberExpression("0"))}>Numeric value</CommandItem><CommandItem value="Text value constant" onSelect={() => insert({ ...rawExpression('""', "text"), kind: "text", value: "" })}>Text value</CommandItem></CommandGroup>
              {choices.length > 0 && <CommandGroup heading="Values">{choices.map(choice => <CommandItem key={choice.value} value={`value ${choice.label}`} onSelect={() => insert({ ...rawExpression(JSON.stringify(choice.value), "category"), kind: "text", value: choice.value })}>{choice.label}</CommandItem>)}</CommandGroup>}
              {[...new Set(visibleMetrics.map(metric => metric.group))].map(group => <CommandGroup key={group} heading={group}>{visibleMetrics.filter(metric => metric.group === group).map(metric => <CommandItem key={metric.key} data-metric-key={metric.key} value={`${metric.label} ${metric.key}`} keywords={[`${metric.group} ${metric.label}`, metric.description, ...(metric.aliases ?? [])]} onSelect={() => insert({ ...rawExpression(metric.key, metric.unit), kind: "name", value: metric.key, choices: metric.choices })}>{metric.label}<span className="ml-auto text-muted-foreground">{metric.unit}</span></CommandItem>)}</CommandGroup>)}
              {definitions.length > 0 && <CommandGroup heading="Reusable values / captured prices">{definitions.map(item => <CommandItem key={item.id} value={item.name} onSelect={() => insert(expressions[item.name] ?? { ...rawExpression(item.name, units[item.name]), kind: "name", value: item.name })}>{humanName(item.name)}<span className="ml-auto text-muted-foreground">{units[item.name] ?? "value"}</span></CommandItem>)}</CommandGroup>}
              {[...new Set(templates.filter(item => item.name.toLowerCase() !== "multiple").map(item => item.group))].map(group => <CommandGroup key={group} heading={group === "Expression functions" ? "Value blocks" : group}>{templates.filter(item => item.group === group && item.name.toLowerCase() !== "multiple").map(item => <CommandItem key={item.name} data-function-name={item.name} value={`${item.label} ${item.name}`} keywords={[item.description]} onSelect={() => insert(templateExpression(item))}>{item.label}<span className="ml-auto text-muted-foreground">{item.unit}</span></CommandItem>)}</CommandGroup>)}
              {allowArithmetic && <CommandGroup heading="Calculation blocks">{arithmeticOperations.map(([operation, title]) => <CommandItem key={operation} value={`arithmetic ${title}`} onSelect={() => insert(arithmeticExpression(operation))}>{title}</CommandItem>)}</CommandGroup>}
            </CommandList>
          </Command></PopoverContent>
        </Popover>
      </div>
      <FieldDescription>{description}{reading?.description && <span className="block">{reading.description}</span>}</FieldDescription>
    </Field>
    {allowTransforms && <div className="max-w-72"><ExpressionSelect label={`Transform ${label}`} value="transform" choices={[["transform", "Add value block…"], ...(!["category", "text"].includes(resolvedUnit) ? [["previous-mean", "Average of previous closed hours"]] : []), ...wrappers.filter(item => item.name.toLowerCase() !== "multiple").map(item => [item.name, item.label]), ...(allowArithmetic && !["category", "text"].includes(resolvedUnit) ? arithmeticOperations : [])]} onChange={operation => {
      if (operation === "transform") return
      if (operation === "previous-mean") {
        const mean = templates.find(item => item.name === "mean"), lag = templates.find(item => item.name === "lag")
        if (mean && lag) changeTree(templateExpression(mean, templateExpression(lag, tree)))
        return
      }
      const wrapper = templates.find(item => item.name === operation)
      changeTree(wrapper ? templateExpression(wrapper, tree) : arithmeticExpression(operation, tree))
    }} /></div>}
    {allowTransforms && hasParts && <Collapsible open={partsOpen} onOpenChange={setPartsOpen} className="rounded-lg border p-2">
      <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" aria-label={`Toggle ${label} parameters`} aria-expanded={partsOpen}><ChevronDown data-icon="inline-start" aria-hidden="true" className={cn(!partsOpen && "-rotate-90")} />{template?.label ?? "Arithmetic"} parameters</Button></CollapsibleTrigger>
      <CollapsibleContent><FieldGroup className="mt-2 gap-2">
        {template && tree.kind === "call" && <>
          {template.parameters.map((parameter, index) => parameter.kind === "number" ? <Field key={index}>
            <FieldLabel htmlFor={`${fieldID}-${index}`}>{parameter.label}</FieldLabel><Input id={`${fieldID}-${index}`} type="number" min={parameter.minimum} step={parameter.step} value={tree.arguments[index]?.value ?? tree.arguments[index]?.source ?? ""} aria-label={`${label} ${parameter.label}`} onChange={event => changeTree(withExpressionArguments(tree, index, numberExpression(event.target.value)))} /><FieldDescription>{parameter.unit}</FieldDescription>
          </Field> : parameter.kind === 'choice' ? <Field key={index}><FieldLabel>{parameter.label}</FieldLabel><ExpressionSelect label={`${label} ${parameter.label}`} value={tree.arguments[index]?.value ?? 'aligned'} choices={(parameter.choices ?? []).map(choice => [choice.value, choice.label])} onChange={value => changeTree(withExpressionArguments(tree, index, { ...rawExpression(JSON.stringify(value), 'category'), kind: 'text', value }))} /></Field> : <ExpressionInput key={index} label={`${label} ${parameter.label}`} displayLabel={parameter.label} value={tree.arguments[index]?.source ?? ""} expression={tree.arguments[index]} onChange={(next, nextTree) => changeTree(withExpressionArguments(tree, index, nextTree ?? rawExpression(next)))} {...shared} />)}
          <FieldDescription>{template.description}</FieldDescription>
        </>}
        {tree.kind === "binary" && <>
          <Field><FieldLabel>Operation</FieldLabel><ExpressionSelect label={`${label} Operation`} value={tree.operation ?? "+"} choices={arithmeticOperations} onChange={operation => changeTree({ ...tree, operation })} /></Field>
          {tree.arguments.map((argument, index) => <ExpressionInput key={index} label={`${label} ${index === 0 ? "Left operand" : "Right operand"}`} displayLabel={index === 0 ? "Left operand" : "Right operand"} value={argument.source} expression={argument} onChange={(next, nextTree) => changeTree(withExpressionArguments(tree, index, nextTree ?? rawExpression(next)))} {...shared} />)}
        </>}
        {tree.kind === "unary" && <>
          <Field><FieldLabel>Sign</FieldLabel><ExpressionSelect label={`${label} Sign`} value={tree.operation ?? "+"} choices={[["+", "Positive +"], ["-", "Negative −"]]} onChange={operation => changeTree({ ...tree, operation })} /></Field>
          <ExpressionInput label={`${label} Source expression`} displayLabel="Source expression" value={tree.arguments[0].source} expression={tree.arguments[0]} onChange={(next, nextTree) => changeTree(withExpressionArguments(tree, 0, nextTree ?? rawExpression(next)))} {...shared} />
        </>}
      </FieldGroup></CollapsibleContent>
    </Collapsible>}
  </FieldGroup>
}
