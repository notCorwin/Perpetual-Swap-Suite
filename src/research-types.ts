import type { StrategyProfile } from '@/suite-types'
import type { ChartResponse } from '@/MarketChart'
import type { FilterMetric } from '@/rule-engine'
import type { ExpressionTemplate } from '@/filter-expression'

export const RESEARCH_HORIZONS = [1, 3, 6, 12, 24, 48] as const
export const RESEARCH_HOUR = 3_600_000
export type ResearchInputs = { metrics: FilterMetric[]; templates: ExpressionTemplate[]; functions?: string[] }
export type StudyRule = { name: string; filtersJSON: string }
export type StudySpec = {
  name: string; kind: 'filter' | 'score' | 'comparison'; rules: StudyRule[]; instruments: string[]
  from: number | null; through: number; direction: 'Long'; sampling: 'entries' | 'hourly'
  strategySnapshots?: StrategyProfile[]
  excludedSpreadConditions?: string[]
  costs: { entryFeeBps: number; exitFeeBps: number; slippageBps: number } | null
}
export type ResearchInstrument = { id: string; listedAt?: number; delistedAt?: number; verified: boolean; contractValue?: number; source: string; observedAt: number }
export type ResearchSource = { id: string; instrument: string; kind: string; from: number; through: number; filename: string; url: string; sizeBytes?: number; archive: boolean; module?: number; cached: boolean; rawHash?: string }
export type DataPlan = { id: string; spec: StudySpec; instruments: ResearchInstrument[]; referenceInstruments?: ResearchInstrument[]; from: number; through: number; warmupHours: number; sources: ResearchSource[]; coverage: ResearchCoverage[]; cachedHours: number; requestedHours: number; warnings: string[]; unknownInstruments: string[] }
export type ResearchStudy = { id: string; spec: StudySpec; planID: string; manifestID?: string; createdAt: number; phase: string; error?: string; active?: boolean; updatedAt?: number }
export type ResearchPreparation = { stage: string; filename: string; instrument: string; receivedBytes: number; totalBytes?: number; bytesPerSecond?: number; fileRemainingSeconds?: number; remainingSeconds?: number; pages: number; fraction?: number; retryAt?: number; recovery?: string; workers?: number; downloadLanes?: number }
export type ResearchCatalog = { kind: string; completed: number; total: number; message: string; waitingForResponse: boolean; remainingSeconds?: number; retryAt?: number }
export type ResearchPlanning = { stage: string; unit: string; completed: number; total: number; message: string; instrument?: string; kind?: string; from?: number; through?: number; remainingSeconds?: number; retryAt?: number }
export type ResearchJob = { id: string; phase: string; completed: number; total: number; message: string; error: string; resultID?: string; startedAt?: number; updatedAt?: number; preparation?: ResearchPreparation; catalog?: ResearchCatalog; planning?: ResearchPlanning; retryAt?: number; recovery?: string }
export type ResearchOutcome = { hours: number; gross?: number; net?: number; mfe?: number; mae?: number; reason?: string; netReason?: string }
export type ResearchEvent = { id: string; studyID: string; ruleIndex: number; instrument: string; timestamp: number; direction: string; entry: string; score?: number; scoreComplete: boolean; status: string; setup?: string; split: string; outcomes: ResearchOutcome[]; traceJSON: string; opportunityJSON: string; sources: string[] }
export type ResearchSummary = {
  group: string; ruleIndex: number; hours: number; count: number; excluded: number; netCount: number
  mean?: number; median?: number; winRate?: number; netMean?: number; netMedian?: number; netWinRate?: number
  mfe?: number; mae?: number; baseline?: number; excess?: number; intervalLow?: number; intervalHigh?: number; netIntervalLow?: number; netIntervalHigh?: number
}
export type StudyReport = { studyID: string; manifestID: string; spec: StudySpec; summaries: ResearchSummary[]; evaluated: number; unknown: number; directionless: number; commonPool: number; uncertain: number; baseline: number; warnings: string[]; completedAt: number }
export type ResearchCoverage = { instrument: string; kind: string; available: number; expected: number; first?: number; last?: number; gaps: { from: number; through: number }[] }
export type DataManifest = { id: string; digest: string; from: number; through: number; parser: string; engine: string; sourceRevision: string; instruments: ResearchInstrument[]; referenceInstruments?: ResearchInstrument[]; unknownInstruments: string[]; warnings: string[]; coverage: ResearchCoverage[]; sources: ResearchSource[] }
export type ResearchChartData = ChartResponse & { endHour: number; oldestHour?: number; latestHour?: number; signalHour: number; manifestID: string }
export type ResearchRequest = { action: string; spec?: StudySpec; refresh?: boolean; planID?: string; studyID?: string; eventID?: string; offset?: number; endHour?: number; kind?: string; profileID?: string; instrument?: string; model?: string }
export type ResearchResponse = { jobID?: string; job?: ResearchJob | null; studies?: ResearchStudy[]; plan?: DataPlan; estimatedBytes?: number; study?: ResearchStudy; report?: StudyReport | null; manifest?: DataManifest | null; events?: ResearchEvent[]; count?: number; chart?: ResearchChartData; cacheDirectory?: string; cachedRows?: number; rawFiles?: number; bytesRemoved?: number; ok?: boolean; cancelled?: boolean }
export const requestResearch = (request: ResearchRequest) => window.webkit.messageHandlers.radar.postMessage({ research: request })
const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 3 })
const timeFormatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC', timeZoneName: 'short' })
const sizeFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
export const researchPercent = (value: number | null | undefined) => value == null ? '—' : percentFormatter.format(value)
export const researchTime = (timestamp: number) => timeFormatter.format(timestamp)
export const researchSize = (bytes: number) => sizeFormatter.format(bytes / (bytes >= 1_000_000_000 ? 1_000_000_000 : 1_000_000)) + (bytes >= 1_000_000_000 ? ' GB' : ' MB')
export function researchDateRange(from: string, through: string, now = Date.now()): { from: number | null; through: number } {
  const start = from ? Date.parse(from + 'T00:00:00Z') : null
  const end = through ? Date.parse(through + 'T00:00:00Z') + 24 * RESEARCH_HOUR : now
  if (start !== null && !Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Choose valid dates.')
  const last = Math.min(end, Math.floor(now / RESEARCH_HOUR) * RESEARCH_HOUR)
  if (start !== null && start >= last) throw new Error('The start date must precede the last completed hour.')
  return { from: start, through: last }
}
