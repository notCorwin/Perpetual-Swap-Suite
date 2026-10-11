import { useCallback, useEffect, useState } from 'react'
import { initialEditorState, parseFilterConfig, type CompileResponse, type FilterConfigV2 } from '@/rule-engine'

export function useStrategyFilter(initial: string, suitePhase?: string) {
  const [filters, setFilters] = useState(() => parseFilterConfig(initial)), [draft, setDraft] = useState<FilterConfigV2 | null>(null)
  const [editor, setEditor] = useState(() => ({ ...initialEditorState(), open: true }))
  const [compilation, setCompilation] = useState<CompileResponse & { key: string; pending: boolean }>({ key: '', pending: true, diagnostics: [] })
  const [lastValid, setLastValid] = useState<string | null>(null), [generation, setGeneration] = useState(0)
  const json = JSON.stringify(draft ?? filters), key = generation + ':' + (editor.source === null ? json : 'source:' + editor.source)
  useEffect(() => {
    let stopped = false
    setCompilation(current => ({ ...current, key, pending: true }))
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.webkit.messageHandlers.radar.postMessage({ compileMarketFilters: editor.source === null ? { filtersJSON: json, suitePhase } : { source: editor.source, previousJSON: json, suitePhase } })
        if (stopped) return
        setCompilation({ ...result, key, pending: false })
        if (result.configJSON && !result.diagnostics.length) { setLastValid(result.configJSON); if (editor.source !== null) setDraft(parseFilterConfig(result.configJSON)) }
      } catch (cause) { if (!stopped) setCompilation({ key, pending: false, diagnostics: [cause instanceof Error ? cause.message : 'Cannot compile these strategy rules.'] }) }
    }, 150)
    return () => { stopped = true; window.clearTimeout(timer) }
    // Match the compiler key so a completed native validation is not repeated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, suitePhase])
  const reset = useCallback((next: string) => {
    setFilters(parseFilterConfig(next)); setDraft(null); setEditor({ ...initialEditorState(), open: true }); setLastValid(null); setGeneration(current => current + 1)
  }, [])
  const restore = useCallback((value: { json: string; source: string|null; nameDrafts: typeof editor.nameDrafts; expressionDrafts: typeof editor.expressionDrafts; lastValid: string|null }) => {
    setFilters(parseFilterConfig(value.json)); setDraft(null); setEditor({ ...initialEditorState(),open:true,source:null,nameDrafts:value.nameDrafts,expressionDrafts:value.expressionDrafts });setLastValid(value.lastValid);setGeneration(g=>g+1)
  },[])
  const compiling = compilation.pending || compilation.key !== key
  const valid = !compiling && !compilation.diagnostics.length && Boolean(compilation.configJSON) && !Object.keys(editor.nameDrafts).length
  const canonical = valid ? compilation.configJSON! : null
  return { filters, draft, editor, setEditor, setDraft, compilation, lastValid, reset, restore, valid, compiling, canonical,
    dirty: draft !== null || editor.source !== null || Object.keys(editor.nameDrafts).length > 0,
    keep: async (config: FilterConfigV2) => { setFilters(config); setDraft(null); setEditor(current => ({ ...current, source: null, nameDrafts: {} })) } }
}
