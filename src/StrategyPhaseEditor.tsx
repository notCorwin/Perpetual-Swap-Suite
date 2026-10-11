import { useEffect, useState } from 'react'
import { StrategyRules } from '@/StrategyRules'
import { FilterExplanation } from '@/FilterExplanation'
import { FieldDescription } from '@/components/ui/field'
import { newRuleID, type FilterLibraryPreferences, type FilterTruth, type NativeMarketRow } from '@/rule-engine'
import type { ResearchInputs } from '@/research-types'
import type { useStrategyFilter } from '@/use-strategy-filter'

export function StrategyPhaseEditor({ label, model, inputs, preferences, onPreferences, active, strategyID, description }: {
  label: string; description?: string; model: ReturnType<typeof useStrategyFilter>; inputs: ResearchInputs; preferences: FilterLibraryPreferences
  onPreferences: (value: FilterLibraryPreferences) => Promise<void>; active: boolean; strategyID: string
}) {
  const [rows, setRows] = useState<NativeMarketRow[]>([]), [results, setResults] = useState<Record<string, FilterTruth>>({})
  const [revision, setRevision] = useState(0), [previewJSON, setPreviewJSON] = useState<string | null>(null)
  const [history, setHistory] = useState<{ pending: number; completed: number; error: string } | null>(null)
  const [explaining, setExplaining] = useState<string | null>(null)
  useEffect(() => {
    if (!active || !model.lastValid) return
    let stopped = false, timer: number
    const token = newRuleID(), json = model.lastValid
    const refresh = async () => {
      try {
        const snapshot = await window.webkit.messageHandlers.radar.postMessage({ previewMarketFilters: { filtersJSON: json, token, atClose: true, strategyID } })
        if (stopped) return
        setRows(snapshot.rows); setResults(snapshot.filterResults); setRevision(snapshot.revision); setHistory(snapshot.historyProgress); setPreviewJSON(json)
      } catch (cause) { if (!stopped) setHistory({ pending: 0, completed: 0, error: cause instanceof Error ? cause.message : 'Cannot preview these rules.' }) }
      if (!stopped) timer = window.setTimeout(refresh, 2000)
    }
    void refresh(); return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, model.lastValid, strategyID])
  const expressions = { ...model.editor.expressionDrafts, ...model.compilation.expressions }
  const metrics = inputs.metrics.filter(metric => !model.compilation.allowedMetrics || model.compilation.allowedMetrics.includes(metric.key))
  return <section aria-label={label} className="flex flex-col gap-3" data-strategy-rules>
    <FieldDescription className="px-4">{description} Keep rules for preview; Save strategy applies all five configurations together.</FieldDescription>
    <StrategyRules label={label} embedded atClose strategyID={strategyID} filters={model.filters} draft={model.draft} editor={model.editor} onEditorChange={model.setEditor} onDraftChange={model.setDraft} onApply={model.keep}
      metrics={metrics} templates={inputs.templates} preferences={preferences} onPreferences={onPreferences}
      rows={rows} results={results} previewJSON={previewJSON} revision={revision} onExplain={setExplaining} units={model.compilation.units ?? {}} expressions={expressions}
      diagnostics={model.compilation.diagnostics} valid={model.valid} compiling={model.compiling} requiredHours={model.compilation.requiredHours ?? 0}
      matches={Object.values(results).filter(v => v === 'true').length} total={rows.length} unknown={Object.values(results).filter(v => v === 'unknown').length} previewPending={previewJSON !== model.lastValid} history={history} />
    <FilterExplanation open={active && Boolean(explaining)} onOpenChange={open => { if (!open) setExplaining(null) }} instId={explaining} onSelect={setExplaining} rows={rows} results={results} filtersJSON={previewJSON} revision={revision}
      metrics={inputs.metrics} expressions={expressions} units={model.compilation.units ?? {}} templates={inputs.templates} atClose strategyID={strategyID} />
  </section>
}
