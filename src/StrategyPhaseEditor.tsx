import { useEffect, useMemo, useState } from 'react'
import { pageVisible } from '@/lib/utils'
import { StrategyRules } from '@/StrategyRules'
import { FieldDescription } from '@/components/ui/field'
import { newRuleID, type FilterLibraryPreferences, type FilterTruth, type NativeMarketRow } from '@/rule-engine'
import type { ResearchInputs } from '@/research-types'
import type { useStrategyFilter } from '@/use-strategy-filter'

export type StageStatus = { matches: number; total: number; unknown: number }
export function StrategyPhaseEditor({ label, model, inputs, preferences, onPreferences, active, strategyID, description, readOnly = false, statusKey = label, onStatus }: {
  label: string; description?: string; model: ReturnType<typeof useStrategyFilter>; inputs: ResearchInputs; preferences: FilterLibraryPreferences
  onPreferences: (value: FilterLibraryPreferences) => Promise<void>; active: boolean; strategyID: string
  readOnly?: boolean; statusKey?: string; onStatus?: (key: string, status: StageStatus) => void
}) {
  const [rows, setRows] = useState<NativeMarketRow[]>([]), [results, setResults] = useState<Record<string, FilterTruth>>({})
  const [previewJSON, setPreviewJSON] = useState<string | null>(null)
  const [history, setHistory] = useState<{ pending: number; completed: number; error: string } | null>(null)
  useEffect(() => {
    if (!active || !model.lastValid) return
    let stopped = false, timer: number, backoff = 2000
    const token = newRuleID(), json = model.lastValid
    const refresh = async () => {
      await pageVisible(); if (stopped) return
      try {
        const snapshot = await window.webkit.messageHandlers.radar.postMessage({ previewMarketFilters: { filtersJSON: json, token, atClose: true, strategyID } })
        if (stopped) return
        if ("unchanged" in snapshot) {
          backoff = Math.min(backoff * 1.5, 30000)
        } else {
          setRows(snapshot.rows); setResults(snapshot.filterResults); setHistory(snapshot.historyProgress); setPreviewJSON(json)
          backoff = 2000
        }
      } catch (cause) {
        if (!stopped) {
          setHistory({ pending: 0, completed: 0, error: cause instanceof Error ? cause.message : 'Cannot preview these rules.' })
          backoff = Math.min(backoff * 2, 30000)
        }
      }
      if (!stopped) timer = window.setTimeout(refresh, backoff)
    }
    void refresh(); return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, model.lastValid, strategyID])
  const expressions = { ...model.editor.expressionDrafts, ...model.compilation.expressions }
  const metrics = inputs.metrics.filter(metric => !model.compilation.allowedMetrics || model.compilation.allowedMetrics.includes(metric.key))
  const { matches, unknown } = useMemo(() => Object.values(results).reduce((counts, value) => {
    if (value === 'true') counts.matches += 1
    else if (value === 'unknown') counts.unknown += 1
    return counts
  }, { matches: 0, unknown: 0 }), [results])
  // Report the latest preview so the pipeline overview stays informed while another stage is open.
  useEffect(() => { if (previewJSON !== null) onStatus?.(statusKey, { matches, total: rows.length, unknown }) }, [onStatus, statusKey, matches, rows.length, unknown, previewJSON])
  return <section aria-label={label} className="flex flex-col gap-3" data-strategy-rules>
    {description && <FieldDescription className="px-4">{description}</FieldDescription>}
    <StrategyRules label={label} embedded readOnly={readOnly} filters={model.filters} draft={model.draft} editor={model.editor} onEditorChange={model.setEditor} onDraftChange={model.setDraft} onApply={model.keep}
      metrics={metrics} templates={inputs.templates} preferences={preferences} onPreferences={onPreferences}
      previewJSON={previewJSON} units={model.compilation.units ?? {}} expressions={expressions}
      diagnostics={model.compilation.diagnostics} valid={model.valid} compiling={model.compiling} requiredHours={model.compilation.requiredHours ?? 0}
      matches={matches} total={rows.length} unknown={unknown} previewPending={previewJSON !== model.lastValid} history={history} />
  </section>
}
