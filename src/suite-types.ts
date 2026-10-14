import type { FilterTruth, NativeMarketRow, FilterEditorState } from '@/rule-engine'
import type { ResearchInputs, StudySpec } from '@/research-types'
import type { RadarTimeframe } from '@/timeframe'

export const SUITE_PHASES = [
  { key: 'bullishSetup', label: 'Bullish Setup', description: 'Finds bullish candle setups within the Strategy Universe. Only market readings are used.' },
] as const
export type SuitePhase = typeof SUITE_PHASES[number]['key']
export type SuiteMode = 'radar' | 'research'
export const DEFAULT_STRATEGY_ID = 'builtin.default-strategy'
export const isDefaultStrategy = (profile: StrategyProfile | null | undefined): boolean => profile?.id === DEFAULT_STRATEGY_ID
export const modeTitle = (mode: SuiteMode) => mode === 'radar' ? 'Perpetual Swap Radar' : 'Perpetual Swap Research'
export type StrategyProfile = { id: string; mode: SuiteMode; name: string; universeJSON: string; phaseRules: Record<SuitePhase, string>; revision: number; updatedAt: number }
export type SuiteReading = { strategyID: string; revision: number; universeTraceJSON?: string; instrument: string; hour: number; provisional: boolean; universe: FilterTruth; phases: Partial<Record<SuitePhase, { result: FilterTruth; hour: number; traceJSON?: string }>>; action: string; reason: string; price?: number }
export type SuiteDraft = { profile: StrategyProfile | null; name: string; rules: { json: string; source: string | null; nameDrafts: FilterEditorState['nameDrafts']; expressionDrafts: FilterEditorState['expressionDrafts']; lastValid: string | null }[] }
export type SuiteRequest = { draft?: SuiteDraft; mode: SuiteMode; action: string; profileID?: string; profile?: StrategyProfile; instrument?: string; timeframe?: RadarTimeframe }
export type SuiteResponse = { draft?: SuiteDraft; profiles: StrategyProfile[]; selectedID: string; saved?: StrategyProfile; provisional?: SuiteReading[]; confirmed?: SuiteReading[]; paused?: boolean; recovering?: boolean; evaluationPending?: boolean; rows?: NativeMarketRow[]; revision?: number; serviceSession?: string; timeframe?: RadarTimeframe; historyProgress?: { pending: number; completed: number; error: string } }
export const requestSuite = (request: SuiteRequest) => window.webkit.messageHandlers.radar.postMessage({ suite: request })
export function sameStrategyVersion(saved: StrategyProfile | undefined, frozen: StrategyProfile): boolean {
  return Boolean(saved && saved.id === frozen.id.split('@r')[0] && saved.revision === frozen.revision &&
    saved.universeJSON === frozen.universeJSON && saved.phaseRules.bullishSetup === frozen.phaseRules.bullishSetup)
}
export function suiteSpec(profiles: StrategyProfile[]): StudySpec {
  if (!profiles.length || profiles.length > 2) throw new Error('Choose one strategy, or two versions to compare.')
  const frozen = profiles.map(source => {
    const { id, mode, name, universeJSON, phaseRules, revision, updatedAt } = source
    return { id: id.includes('@r') ? id : id + '@r' + revision, mode,
      name: id.includes('@r') ? name : name.slice(0, 68) + ' · r' + revision,
      universeJSON, phaseRules: { bullishSetup: phaseRules.bullishSetup }, revision, updatedAt }
  })
  return { name: profiles[0].name + ' Bullish Setup study', kind: profiles.length === 2 ? 'comparison' : 'filter', rules: [],
    instruments: [], from: null, through: Math.floor(Date.now() / 3_600_000) * 3_600_000,
    direction: 'Long', sampling: 'entries', costs: null, strategySnapshots: frozen }
}
export type SuiteWorkspaceProps = { mode: SuiteMode; inputs: ResearchInputs; active: boolean; initialTab?: 'rules' | 'signals'; routeKey?: number; onBack: () => void; onResearch: (spec: StudySpec) => void; onSwitchMode: () => void; switchingMode: boolean }
