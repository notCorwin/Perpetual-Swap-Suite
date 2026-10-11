import type { MarketRow } from "./market-row.ts"
import type { OpportunityResult } from "./market-opportunity.ts"

export type FilterTruth = "true" | "false" | "unknown"
export type RuleKind = "all" | "any" | "not" | "condition" | "every" | "recent" | "count" | "cooldown" | "crossup" | "crossdown" | "sequence"
export type NamedFormula = { id: string; name: string; expression: string }
export type RuleNode = {
  id: string; kind: RuleKind; name: string; mode: "live" | "closed"; children: RuleNode[]
  left: string; comparison: string; right: string; upper: string; hours: number; minimum: number; gapHours: number; captures: NamedFormula[]
}
export type FilterConfigV2 = { version: 2; root: RuleNode; definitions: NamedFormula[] }
export type FilterMetricChoice = { value: string; label: string }
export type FilterMetric = { key: string; label: string; group: string; description: string; unit: string; numeric: boolean; choices: FilterMetricChoice[]; aliases?: string[] }
export type FilterLibraryPreferences = { favorites: string[]; recent: string[]; layout: "sentences" | "guided" }
export const initialLibraryPreferences = (): FilterLibraryPreferences => ({ favorites: [], recent: [], layout: "sentences" })
export type EditorExpression = { kind: "number" | "text" | "name" | "unary" | "binary" | "call" | "raw"; source: string; unit: string; value?: string; operation?: string; arguments: EditorExpression[]; choices: FilterMetricChoice[] }
export type CompileResponse = { configJSON?: string; formula?: string; diagnostics: string[]; requiredHours?: number; units?: Record<string, string>; expressions?: Record<string, EditorExpression>; allowedMetrics?: string[] }
export type FilterTrace = { id: string; label: string; result: FilterTruth; hour: number; readings: Record<string, string>; reason: string; children: FilterTrace[]; eventHours: number[]; readingSources?: Record<string, { instrument: string; hour: number; clock: string; updatedAt: number }[]>; referenceDriven?: boolean }
export type ExplainResponse = { instId: string; filterToken: string; revision: number; trace: FilterTrace }
export type NativeMarketRow = MarketRow & { opportunity: OpportunityResult }
export type FilterDraftRevision = { config: FilterConfigV2; source: string | null; expressionDrafts?: Record<string, EditorExpression> }
export type FilterEditorState = {
  open: boolean; tab: "rules" | "formula"; source: string | null; collapsed: Record<string, boolean>
  selectedRuleId: string | null; selectedIds: string[]; past: FilterDraftRevision[]; future: FilterDraftRevision[]; explainId: string | null
  nameDrafts: Record<string, string>
  expressionDrafts: Record<string, EditorExpression>
}
export const initialEditorState = (): FilterEditorState => ({ open: false, tab: "rules", source: null, collapsed: {}, selectedRuleId: null, selectedIds: [], past: [], future: [], explainId: null, nameDrafts: {}, expressionDrafts: {} })
// WKWebView's custom radar:// origin can omit randomUUID while still providing
// getRandomValues. Draft identities must work in the packaged native app.
export function newRuleID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export const makeRule = (kind: RuleKind = "condition"): RuleNode => ({
  id: newRuleID(), kind, name: "", mode: "live", children: [], left: "Price", comparison: "gt", right: "0", upper: "100", hours: kind === 'cooldown' ? 0 : 3, minimum: 1, gapHours: 6, captures: [],
})
export const emptyFilterConfig = (): FilterConfigV2 => ({ version: 2, root: makeRule("all"), definitions: [] })
export function parseFilterConfig(json: string): FilterConfigV2 {
  const parsed = JSON.parse(json)
  if (parsed?.version !== 2 || !parsed.root || !Array.isArray(parsed.definitions)) throw new Error("Unsupported native strategy rule configuration")
  return parsed as FilterConfigV2
}
export function updateRule(root: RuleNode, id: string, change: (node: RuleNode) => RuleNode): RuleNode {
  if (root.id === id) return change(root)
  return { ...root, children: root.children.map(node => updateRule(node, id, change)) }
}
export function findRule(root: RuleNode, id: string): RuleNode | undefined {
  if (root.id === id) return root
  for (const child of root.children) { const found = findRule(child, id); if (found) return found }
}
export function findParent(root: RuleNode, id: string): RuleNode | undefined {
  if (root.children.some(child => child.id === id)) return root
  for (const child of root.children) { const found = findParent(child, id); if (found) return found }
}
export function removeRule(root: RuleNode, id: string): RuleNode {
  return { ...root, children: root.children.filter(node => node.id !== id).map(node => removeRule(node, id)) }
}
export function cloneRule(node: RuleNode): RuleNode {
  return { ...node, id: newRuleID(), captures: node.captures.map(item => ({ ...item, id: newRuleID() })), children: node.children.map(cloneRule) }
}
export function canReceiveChildren(node: RuleNode): boolean { return ["all", "any", "sequence"].includes(node.kind) || ["not", "every", "recent", "count", "cooldown"].includes(node.kind) && node.children.length === 0 }
export function moveRule(root: RuleNode, sourceId: string, parentId: string, index: number): RuleNode {
  const source = findRule(root, sourceId), oldParent = findParent(root, sourceId), target = findRule(root, parentId)
  if (!source || !oldParent || !target || !Number.isInteger(index) || index < 0 || index > target.children.length || findRule(source, parentId)) return root
  if (oldParent.id !== parentId && !canReceiveChildren(target)) return root
  const oldIndex = oldParent.children.findIndex(node => node.id === sourceId)
  const insertion = oldParent.id === parentId && oldIndex < index ? index - 1 : index
  if (oldParent.id === parentId && insertion === oldIndex) return root
  const removed = removeRule(root, sourceId)
  return updateRule(removed, parentId, parent => ({ ...parent, children: [...parent.children.slice(0, insertion), source, ...parent.children.slice(insertion)] }))
}
export function duplicateRule(root: RuleNode, id: string): RuleNode {
  const parent = findParent(root, id), source = findRule(root, id)
  if (!parent || !source || !["all", "any", "sequence"].includes(parent.kind)) return root
  const clone = cloneRule(source)
  if (parent.kind === "sequence") {
    const existing = new Set(parent.children.map(child => child.name))
    let suffix = 1
    while (existing.has(`${source.name}_copy${suffix}`)) suffix += 1
    clone.name = `${source.name}_copy${suffix}`
  }
  const index = parent.children.findIndex(child => child.id === id)
  return updateRule(root, parent.id, node => ({ ...node, children: [...node.children.slice(0, index + 1), clone, ...node.children.slice(index + 1)] }))
}
export function wrapRule(root: RuleNode, id: string, kind: RuleKind): RuleNode {
  const stage = findParent(root, id)?.kind === "sequence"
  return updateRule(root, id, node => ({
    ...makeRule(kind), mode: node.mode, name: node.name, gapHours: node.gapHours, captures: stage ? node.captures : [],
    children: [{ ...node, mode: "live", name: "", captures: stage ? [] : node.captures }],
  }))
}
export function unwrapRule(root: RuleNode, id: string): RuleNode {
  const node = findRule(root, id)
  if (!node || node.children.length !== 1 || !["not", "every", "recent", "count", "cooldown", "all", "any"].includes(node.kind)) return root
  const stage = findParent(root, id)?.kind === "sequence", child = node.children[0]
  const replacement = { ...child, name: node.name || child.name, gapHours: node.gapHours, captures: stage ? [...node.captures, ...child.captures] : child.captures }
  // Preserve both closed anchors when the child independently uses closed data.
  if (node.mode === "closed" && child.mode === "closed") return updateRule(root, id, () => ({ ...makeRule("all"), mode: "closed", name: replacement.name, gapHours: replacement.gapHours, captures: replacement.captures, children: [{ ...child, name: "", captures: stage ? [] : child.captures }] }))
  return updateRule(root, id, () => ({ ...replacement, mode: node.mode === "closed" ? "closed" : child.mode }))
}
export const ruleCount = (node: RuleNode): number => (node.kind === "condition" || node.kind.startsWith("cross") ? 1 : 0) + node.children.reduce((sum, child) => sum + ruleCount(child), 0)
export const ruleKinds: { value: RuleKind; label: string }[] = [
  { value: "cooldown", label: "Cooldown after trigger" },
  { value: "condition", label: "Comparison" }, { value: "all", label: "All (AND)" }, { value: "any", label: "Any (OR)" }, { value: "not", label: "Not (NOT)" },
  { value: "every", label: "Every hour" }, { value: "recent", label: "Recently occurred" }, { value: "count", label: "Occurrence count" },
  { value: "crossup", label: "Crosses above" }, { value: "crossdown", label: "Crosses below" }, { value: "sequence", label: "Ordered sequence" },
]
export const comparisons = [
  ["gt", "Greater than >"], ["lt", "Less than <"], ["gte", "At least ≥"], ["lte", "At most ≤"], ["eq", "Equals"], ["neq", "Does not equal"],
  ["between", "Between (inclusive)"], ["abs-gte", "Absolute value ≥"], ["abs-lte", "Absolute value ≤"], ["positive", "Positive"], ["negative", "Negative"], ["zero", "Zero"], ["present", "Available"], ["missing", "Unavailable"],
]
export const unaryComparison = (op: string): boolean => ["positive", "negative", "zero", "present", "missing"].includes(op)
export const categoryComparisons = comparisons.filter(([key]) => ["eq", "neq", "present", "missing"].includes(key))
export const indicatorTemplates = [
  { expression: "EMA(200)", label: "EMA", unit: "USDT", params: ["Period (h)"] },
  { expression: "RSI(14)", label: "RSI", unit: "0–100", params: ["Period (h)"] },
  { expression: "ROC(9)", label: "ROC", unit: "%", params: ["Period (h)"] },
  { expression: "Efficiency(24)", label: "Direction efficiency", unit: "ratio", params: ["Period (h)"] },
  { expression: "MAROC(9, 9)", label: "MAROC", unit: "%", params: ["ROC period (h)", "Mean period (h)"] },
  ...["Upper", "Middle", "Lower"].map(band => ({ expression: `LogBB${band}(20, 2)`, label: `Log BB ${band}`, unit: "USDT", params: ["Period (h)", "Deviations"] })),
  { expression: "VWAP(14)", label: "VWAP", unit: "USDT", params: ["Period (h)"] },
  { expression: "PriorHigh(48)", label: "Prior high", unit: "USDT", params: ["Reference hours"] },
  { expression: "PriorLow(48)", label: "Prior low", unit: "USDT", params: ["Reference hours"] },
  { expression: "BreakoutAge(48, 48)", label: "Breakout age", unit: "hours", params: ["Reference hours", "Search hours"] },
  { expression: "BreakdownAge(48, 48)", label: "Breakdown age", unit: "hours", params: ["Reference hours", "Search hours"] },
]
export const formulaExamples = [
  { label: "Long or Short alignment", source: '(emaTrend == "rising" AND ROC(9) > 0) OR (emaTrend == "falling" AND ROC(9) < 0)' },
  { label: "Relative volume", source: 'Volume > multiple(mean(lag(Volume, 1), 20), 2)' },
  { label: "Three closed RSI hours", source: 'closed(every(RSI(14) > 50, 3))' },
  { label: "Break, retest, reclaim", source: 'sequence(6,\n  stage("break", High > PriorHigh(48), 6, capture("level", PriorHigh(48))),\n  stage("retest", Low < break.level, 6),\n  stage("reclaim", crossUp(Close, break.level), 6)\n)' },
]

export function previewResponseIsCurrent(response: { filterToken: string; revision: number }, token: string, minimumRevision: number): boolean {
  return response.filterToken === token && response.revision >= minimumRevision
}
