import type { BreakResult } from "./market-breaks.ts"
import type { MarketRow } from "./market-row.ts"
import type { OpportunityResult } from "./market-opportunity.ts"
import { percentageNumber } from "./market-percent.ts"

type FilterRow = MarketRow & { opportunity: OpportunityResult }
type Reading = number | string | null
type Choice = { value: string; label: string }
type FieldDefinition = {
  label: string
  group: string
  description: string
  kind: "number" | "choice"
  choices?: Choice[]
  minimum?: number
  maximum?: number
  integer?: boolean
  read: (row: FilterRow) => Reading
}

const comparisonChoices = [
  { value: "above", label: "Above / greater" },
  { value: "equal", label: "Equal" },
  { value: "below", label: "Below / less" },
]
const trendChoices = [
  { value: "rising", label: "Rising" }, { value: "flat", label: "Flat" }, { value: "falling", label: "Falling" },
]
const yesNo = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
const numeric = (label: string, group: string, description: string, read: FieldDefinition["read"], limits: Partial<Pick<FieldDefinition, "minimum" | "maximum" | "integer">> = {}): FieldDefinition =>
  ({ label, group, description, kind: "number", read, ...limits })
const choice = (label: string, group: string, description: string, choices: Choice[], read: FieldDefinition["read"]): FieldDefinition =>
  ({ label, group, description, kind: "choice", choices, read })

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
function percent(value: number | null | undefined, previous: number | null | undefined): number | null {
  const current = finite(value), prior = finite(previous)
  return current === null || prior === null || prior <= 0 ? null : (current - prior) / prior * 100
}
function relation(left: number | null | undefined, right: number | null | undefined): string | null {
  if (left == null || right == null || Number.isNaN(left) || Number.isNaN(right)) return null
  return left > right ? "above" : left < right ? "below" : "equal"
}
function trend(value: number | null): string | null {
  return value === null ? null : value > 0 ? "rising" : value < 0 ? "falling" : "flat"
}
function emaBody(row: FilterRow): string | null {
  const m = row.filterMetrics
  const open = finite(m?.liveOpen), close = finite(m?.liveClose), ema = finite(m?.ema200)
  if (open === null || close === null || ema === null) return null
  if (Math.min(open, close) > ema) return "above"
  if (Math.max(open, close) < ema) return "below"
  if (open < ema && close > ema) return "cross-up"
  if (open > ema && close < ema) return "cross-down"
  return "touching"
}
function currentBreak(row: FilterRow, hours: 48 | 96, direction: "high" | "low", wick: boolean): string | null {
  const current = finite(wick ? direction === "high" ? row.currentHigh : row.currentLow : row.filterMetrics?.liveClose)
  const key = direction === "high" ? hours === 48 ? "priorHigh48" : "priorHigh96" : hours === 48 ? "priorLow48" : "priorLow96"
  const prior = finite(row.filterMetrics?.[key])
  return current === null || prior === null ? null : (direction === "high" ? current > prior : current < prior) ? "yes" : "no"
}
function breakPresence(result: BreakResult | undefined): string | null {
  return result?.status === "event" ? "yes" : result?.status === "none" ? "no" : null
}
function breakAge(result: BreakResult | undefined, prior = false): number | null {
  return result?.status === "event" ? prior ? result.priorAgeHours : result.hoursAgo : null
}
const rsiLimits = { minimum: 0, maximum: 100 }
const nonnegative = { minimum: 0 }
const hoursLimits = { minimum: 0, integer: true }

export const FILTER_FIELDS = {
  emaTrend: choice("EMA200 trend", "EMA & live candle", "Live EMA200 compared with the previous completed hour's EMA200.", trendChoices, r => trend(percent(r.filterMetrics?.ema200, r.filterMetrics?.previousEMA200))),
  emaSlope: numeric("EMA200 hourly slope (%)", "EMA & live candle", "Percentage change of live EMA200 from the previous completed EMA200.", r => percent(r.filterMetrics?.ema200, r.filterMetrics?.previousEMA200)),
  emaBody: choice("Live body vs EMA200", "EMA & live candle", "Open and live close only; wicks do not affect this relation. Touching includes equality at either end.", [
    { value: "above", label: "Entire body above" }, { value: "below", label: "Entire body below" },
    { value: "cross-up", label: "Crossing upward" }, { value: "cross-down", label: "Crossing downward" },
    { value: "touching", label: "Touching EMA200" },
  ], emaBody),
  priceEMA: choice("Live price vs EMA200", "EMA & live candle", "Live close compared with the current EMA200, including the live candle.", comparisonChoices, r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.ema200)),
  emaDistance: numeric("Distance from EMA200 (%)", "EMA & live candle", "Signed (live close − EMA200) / EMA200 × 100%.", r => percent(r.filterMetrics?.liveClose, r.filterMetrics?.ema200)),
  candleDirection: choice("Live candle direction", "EMA & live candle", "Live close compared with its open.", [
    { value: "above", label: "Bullish" }, { value: "below", label: "Bearish" }, { value: "equal", label: "Doji" },
  ], r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.liveOpen)),
  bodyChange: numeric("Live body change (%)", "EMA & live candle", "Signed change from live open to live close; excludes wicks.", r => percent(r.filterMetrics?.liveClose, r.filterMetrics?.liveOpen)),
  candleRange: numeric("Live high–low range (%)", "EMA & live candle", "(Live high − live low) / live low × 100%.", r => percent(r.currentHigh, r.currentLow), nonnegative),
  rsi6: numeric("RSI6", "RSI", "Live RSI over 6 one-hour periods; 0–100.", r => finite(r.rsi6), rsiLimits),
  rsi12: numeric("RSI12", "RSI", "Live RSI over 12 one-hour periods; 0–100.", r => finite(r.rsi12), rsiLimits),
  rsi24: numeric("RSI24", "RSI", "Live RSI over 24 one-hour periods; 0–100.", r => finite(r.rsi24), rsiLimits),
  rsi6vs12: choice("RSI6 vs RSI12", "RSI", "Compare the fast and medium RSI readings.", comparisonChoices, r => relation(finite(r.rsi6), finite(r.rsi12))),
  rsi12vs24: choice("RSI12 vs RSI24", "RSI", "Compare the medium and slow RSI readings.", comparisonChoices, r => relation(finite(r.rsi12), finite(r.rsi24))),
  roc: numeric("ROC9 (%)", "Momentum", "9-hour price change. Use Positive / Negative and Absolute value ≥ as separate conditions.", r => percentageNumber(r.roc)),
  maroc: numeric("MAROC9 (%)", "Momentum", "Mean of nine hourly ROC9 readings, in percent.", r => percentageNumber(r.maroc)),
  rocVsMaroc: choice("ROC vs MAROC", "Momentum", "Compare the current ROC and MAROC readings.", comparisonChoices, r => relation(percentageNumber(r.roc), percentageNumber(r.maroc))),
  rocChange: numeric("ROC hourly change (%)", "Momentum", "(ROC − previous ROC) / |previous ROC| × 100%.", r => percentageNumber(r.rocChange)),
  marocChange: numeric("MAROC hourly change (%)", "Momentum", "(MAROC − previous MAROC) / |previous MAROC| × 100%.", r => percentageNumber(r.marocChange)),
  high48: choice("Live wick breaks 48h high", "Breakouts", "Live high strictly exceeds the previous 48 completed hourly highs. A retreat does not undo a wick break.", yesNo, r => currentBreak(r, 48, "high", true)),
  high96: choice("Live wick breaks 96h high", "Breakouts", "Live high strictly exceeds the previous 96 completed hourly highs.", yesNo, r => currentBreak(r, 96, "high", true)),
  closeHigh48: choice("Live close above 48h high", "Breakouts", "Live close is still strictly above the previous 48 completed hourly highs.", yesNo, r => currentBreak(r, 48, "high", false)),
  closeHigh96: choice("Live close above 96h high", "Breakouts", "Live close is still strictly above the previous 96 completed hourly highs.", yesNo, r => currentBreak(r, 96, "high", false)),
  low48: choice("Live wick breaks 48h low", "Breakouts", "Live low strictly falls below the previous 48 completed hourly lows.", yesNo, r => currentBreak(r, 48, "low", true)),
  low96: choice("Live wick breaks 96h low", "Breakouts", "Live low strictly falls below the previous 96 completed hourly lows.", yesNo, r => currentBreak(r, 96, "low", true)),
  closeLow48: choice("Live close below 48h low", "Breakouts", "Live close is still strictly below the previous 48 completed hourly lows.", yesNo, r => currentBreak(r, 48, "low", false)),
  closeLow96: choice("Live close below 96h low", "Breakouts", "Live close is still strictly below the previous 96 completed hourly lows.", yesNo, r => currentBreak(r, 96, "low", false)),
  recentHigh48: choice("Recent 48h high breakout", "Breakouts", "At least one 48h high breakout in the live hour or previous 47 hours. Loading or insufficient history is unavailable.", yesNo, r => breakPresence(r.highBreakout)),
  recentHigh96: choice("Recent 96h high breakout", "Breakouts", "At least one 96h high breakout in the live hour or previous 47 hours.", yesNo, r => breakPresence(r.highBreakout96)),
  recentLow48: choice("Recent 48h low breakdown", "Breakouts", "At least one 48h low breakdown in the live hour or previous 47 hours.", yesNo, r => breakPresence(r.lowBreakdown)),
  recentLow96: choice("Recent 96h low breakdown", "Breakouts", "At least one 96h low breakdown in the live hour or previous 47 hours.", yesNo, r => breakPresence(r.lowBreakdown96)),
  high48Age: numeric("48h breakout age (h)", "Breakouts", "Hours since the latest 48h high breakout, within the 48h search window. Live is 0; no event is unavailable.", r => breakAge(r.highBreakout), { ...hoursLimits, maximum: 47 }),
  high96Age: numeric("96h breakout age (h)", "Breakouts", "Hours since the latest 96h high breakout, within the 48h search window. Live is 0.", r => breakAge(r.highBreakout96), { ...hoursLimits, maximum: 47 }),
  low48Age: numeric("48h breakdown age (h)", "Breakouts", "Hours since the latest 48h low breakdown. Live is 0; no event is unavailable.", r => breakAge(r.lowBreakdown), { ...hoursLimits, maximum: 47 }),
  low96Age: numeric("96h breakdown age (h)", "Breakouts", "Hours since the latest 96h low breakdown. Live is 0.", r => breakAge(r.lowBreakdown96), { ...hoursLimits, maximum: 47 }),
  highPriorAge: numeric("Previous high age at break (h)", "Breakouts", "Age of the previous 48h high at the latest breakout; tied highs use the most recent occurrence.", r => breakAge(r.highBreakout, true), { minimum: 1, maximum: 48, integer: true }),
  buyVsSell: choice("Buy vs Sell", "Participation", "Compare current-hour taker buy and sell USDT volumes, including zero volumes.", comparisonChoices, r => relation(finite(r.buy), finite(r.sell))),
  takerRatio: numeric("Taker imbalance (%)", "Participation", "(Buy − Sell) / (Buy + Sell) × 100%; −100 to 100.", r => finite(r.takerRatio), { minimum: -100, maximum: 100 }),
  buy: numeric("Taker Buy (USDT)", "Participation", "Current-hour taker buy volume in USDT (OKX unit=2).", r => finite(r.buy), nonnegative),
  sell: numeric("Taker Sell (USDT)", "Participation", "Current-hour taker sell volume in USDT (OKX unit=2).", r => finite(r.sell), nonnegative),
  oiTrend: choice("OI trend", "Participation", "Current OI contracts compared with the previous completed hourly contracts; rising / flat / falling.", trendChoices, r => trend(percentageNumber(r.oiChange))),
  oiChange: numeric("OI hourly change (%)", "Participation", "Change in OI contracts; unaffected by price-only changes.", r => percentageNumber(r.oiChange)),
  oiUSD: numeric("Open interest (M USD)", "Participation", "Current open interest in millions of USD.", r => r.filterMetrics?.oiUSD == null ? null : r.filterMetrics.oiUSD / 1_000_000, nonnegative),
  priceUpper: choice("Live price vs Log BB upper", "Bands & VWAP", "Live close compared with the 20h upper log-price Bollinger band. Equality is explicit.", comparisonChoices, r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.bbUpper)),
  priceMiddle: choice("Live price vs Log BB middle", "Bands & VWAP", "Live close compared with the 20h middle log-price Bollinger band.", comparisonChoices, r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.bbMiddle)),
  priceLower: choice("Live price vs Log BB lower", "Bands & VWAP", "Live close compared with the 20h lower log-price Bollinger band.", comparisonChoices, r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.bbLower)),
  bbZone: choice("Log BB price zone", "Bands & VWAP", "Matches the list's highest band strictly below the live price. Equality belongs to the lower zone.", [
    { value: "upper", label: "Above upper" }, { value: "middle", label: "Middle < price ≤ upper" },
    { value: "lower", label: "Lower < price ≤ middle" }, { value: "below", label: "At / below lower" },
  ], r => r.logBBAboveBand),
  bbWidth: numeric("Log BB bandwidth (%)", "Bands & VWAP", "(Upper − Lower) / Middle × 100% for the live 20h bands.", r => {
    const m = r.filterMetrics, upper = finite(m?.bbUpper), lower = finite(m?.bbLower), middle = finite(m?.bbMiddle)
    return upper === null || lower === null || middle === null || middle <= 0 ? null : (upper - lower) / middle * 100
  }, nonnegative),
  bbExpansion: numeric("Known bandwidth expansion (h)", "Bands & VWAP", "Known consecutive hours of expanding bandwidth. A ≥ reading is a lower bound: use Expansion history = Complete for an exact duration.", r => r.logBBExpansion?.hours ?? null, hoursLimits),
  bbExpansionComplete: choice("Expansion history", "Bands & VWAP", "Complete identifies the start of the expansion run; Lower bound means older history is unavailable.", [
    { value: "complete", label: "Complete" }, { value: "partial", label: "Lower bound (≥)" },
  ], r => r.logBBExpansion == null ? null : r.logBBExpansion.complete ? "complete" : "partial"),
  priceVWAP: choice("Live price vs VWAP14", "Bands & VWAP", "Live close compared with the volume-weighted average price over 14 hours.", comparisonChoices, r => relation(r.filterMetrics?.liveClose, r.filterMetrics?.vwap14)),
  vwapDistance: numeric("Distance from VWAP14 (%)", "Bands & VWAP", "Signed (live close − VWAP14) / VWAP14 × 100%.", r => percent(r.filterMetrics?.liveClose, r.filterMetrics?.vwap14)),
  price: numeric("Live price (USDT)", "Market & opportunity", "Current live hourly close in USDT.", r => finite(r.filterMetrics?.liveClose), nonnegative),
  priceChange: numeric("Hourly price change (%)", "Market & opportunity", "Live close compared with the previous completed hourly close.", r => percentageNumber(r.priceChange)),
  turnover: numeric("24h turnover (M USDT)", "Market & opportunity", "24-hour turnover in millions of USDT.", r => r.turnover24hUSDT === null ? null : r.turnover24hUSDT / 1_000_000, nonnegative),
  spread: numeric("Bid–ask spread (%)", "Market & opportunity", "Current ticker spread in percent.", r => finite(r.filterMetrics?.spreadPercent), nonnegative),
  liveVolume: numeric("Live candle volume (USDT)", "Market & opportunity", "Current hourly candle's accumulated quote volume in USDT.", r => finite(r.filterMetrics?.liveVolumeUSDT), nonnegative),
  opportunityStatus: choice("Opportunity status", "Market & opportunity", "Current ranking classification. Scores are unchanged by filtering.", [
    { value: "Candidate", label: "Candidate" }, { value: "Watch", label: "Watch" },
    { value: "Overheated", label: "Overheated" }, { value: "Incomplete", label: "Incomplete" },
  ], r => r.opportunity.status),
  opportunityDirection: choice("Opportunity direction", "Market & opportunity", "EMA200 body direction used by Opportunity. Unclear direction is unavailable.", [
    { value: "Long", label: "Long" }, { value: "Short", label: "Short" },
  ], r => r.opportunity.direction),
  opportunitySetup: choice("Opportunity setup", "Market & opportunity", "Startup or Pullback; no matching setup is unavailable.", [
    { value: "Startup", label: "Startup" }, { value: "Pullback", label: "Pullback" },
  ], r => r.opportunity.setup),
  opportunityScore: numeric("Opportunity score", "Market & opportunity", "Current score, 0–100. Incomplete markets have no score.", r => r.opportunity.score, rsiLimits),
} satisfies Record<string, FieldDefinition>

export type FilterField = keyof typeof FILTER_FIELDS
export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "abs-gte" | "abs-lte" | "positive" | "negative" | "zero" | "present" | "missing"
export type FilterRule = { id: string; field: FilterField; operator: FilterOperator; value: string; upper: string }
export type MarketFilters = { version: 1; match: "all" | "any"; rules: FilterRule[] }
export type MarketFilterCombination = { id: string; name: string; filtersJSON: string }
export const emptyMarketFilters = (): MarketFilters => ({ version: 1, match: "all", rules: [] })
export const FILTER_GROUPS = [...new Set(Object.values(FILTER_FIELDS).map(field => field.group))]
export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "Equals", neq: "Does not equal", gt: "Greater than >", gte: "At least ≥", lt: "Less than <", lte: "At most ≤",
  between: "Between (inclusive)", "abs-gte": "Absolute value ≥", "abs-lte": "Absolute value ≤",
  positive: "Positive (> 0)", negative: "Negative (< 0)", zero: "Zero", present: "Available", missing: "Unavailable",
}
export function operatorsFor(field: FilterField): FilterOperator[] {
  return FILTER_FIELDS[field].kind === "choice" ? ["eq", "neq", "present", "missing"] :
    ["gte", "lte", "gt", "lt", "between", "eq", "neq", "abs-gte", "abs-lte", "positive", "negative", "zero", "present", "missing"]
}
export function requiresFilterValue(operator: FilterOperator): boolean {
  return !["positive", "negative", "zero", "present", "missing"].includes(operator)
}
export function makeFilterRule(field: FilterField = "emaBody", id: string = crypto.randomUUID()): FilterRule {
  const definition = FILTER_FIELDS[field]
  return { id, field, operator: definition.kind === "choice" ? "eq" : "gte", value: definition.choices?.[0]?.value ?? "", upper: "" }
}
export function validateFilterRule(rule: FilterRule): string | null {
  const definition: FieldDefinition | undefined = FILTER_FIELDS[rule.field]
  if (!definition || !operatorsFor(rule.field).includes(rule.operator)) return "Choose a valid indicator and comparison."
  if (!requiresFilterValue(rule.operator)) return null
  if (definition.kind === "choice") return definition.choices?.some(c => c.value === rule.value) ? null : "Choose a value."
  const values = rule.operator === "between" ? [rule.value, rule.upper] : [rule.value]
  const absolute = rule.operator === "abs-gte" || rule.operator === "abs-lte"
  for (const text of values) {
    if (!text.trim() || !Number.isFinite(Number(text))) return "Enter a finite number."
    const value = Number(text)
    if (absolute && value < 0) return "Absolute thresholds must be at least 0."
    if (!absolute && definition.minimum !== undefined && value < definition.minimum) return `Minimum is ${definition.minimum}.`
    if (definition.maximum !== undefined && value > (absolute ? Math.max(Math.abs(definition.minimum ?? 0), Math.abs(definition.maximum)) : definition.maximum)) return `Maximum is ${definition.maximum}.`
    if (definition.integer && !Number.isInteger(value)) return "Enter a whole number of hours."
  }
  return rule.operator === "between" && Number(rule.value) > Number(rule.upper) ? "Minimum must be no greater than maximum." : null
}

export function matchesFilterRule(row: FilterRow, rule: FilterRule): boolean {
  if (validateFilterRule(rule)) return false
  const definition = FILTER_FIELDS[rule.field]
  const raw = definition.read(row)
  const reading = typeof raw === "number" && Number.isNaN(raw) ? null : raw
  if (rule.operator === "missing") return reading == null
  if (rule.operator === "present") return reading != null
  // Unavailable values must never pass a negated comparison or a "No" condition.
  if (reading == null) return false
  const value = definition.kind === "number" ? Number(rule.value) : rule.value
  switch (rule.operator) {
    case "eq": return reading === value
    case "neq": return reading !== value
    case "gt": return typeof reading === "number" && reading > Number(value)
    case "gte": return typeof reading === "number" && reading >= Number(value)
    case "lt": return typeof reading === "number" && reading < Number(value)
    case "lte": return typeof reading === "number" && reading <= Number(value)
    case "between": return typeof reading === "number" && reading >= Number(value) && reading <= Number(rule.upper)
    case "abs-gte": return typeof reading === "number" && Math.abs(reading) >= Number(value)
    case "abs-lte": return typeof reading === "number" && Math.abs(reading) <= Number(value)
    case "positive": return typeof reading === "number" && reading > 0
    case "negative": return typeof reading === "number" && reading < 0
    case "zero": return reading === 0
  }
}
export function matchesMarketFilters(row: FilterRow, filters: MarketFilters): boolean {
  if (!filters.rules.length) return true
  return filters.match === "all" ? filters.rules.every(rule => matchesFilterRule(row, rule)) : filters.rules.some(rule => matchesFilterRule(row, rule))
}
export function previewMarketFilters(draft: MarketFilters): MarketFilters {
  return { ...draft, rules: draft.rules.filter(rule => validateFilterRule(rule) === null) }
}
// insertionIndex identifies a gap in the original list, from before the first rule to after the last.
export function reorderFilterRules(filters: MarketFilters, sourceId: string, insertionIndex: number): MarketFilters {
  const source = filters.rules.findIndex(rule => rule.id === sourceId)
  if (source < 0 || !Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > filters.rules.length) return filters
  const target = insertionIndex > source ? insertionIndex - 1 : insertionIndex
  if (source === target) return filters
  const rules = [...filters.rules]
  const [moved] = rules.splice(source, 1)
  rules.splice(target, 0, moved)
  return { ...filters, rules }
}
export function describeFilterRule(rule: FilterRule): string {
  const field = FILTER_FIELDS[rule.field]
  const value = field.choices?.find(c => c.value === rule.value)?.label ?? rule.value
  return `${field.label} · ${FILTER_OPERATOR_LABELS[rule.operator]}${requiresFilterValue(rule.operator) ? ` ${value}${rule.operator === "between" ? ` – ${rule.upper}` : ""}` : ""}`
}
export function parseMarketFilters(json: string | undefined): MarketFilters {
  try {
    const data = JSON.parse(json ?? "")
    if (data?.version !== 1 || !["all", "any"].includes(data.match) || !Array.isArray(data.rules)) return emptyMarketFilters()
    const ids = new Set<string>()
    const rules = data.rules.filter((rule: FilterRule) => {
      if (!rule || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) ||
          !Object.hasOwn(FILTER_FIELDS, rule.field) || typeof rule.value !== "string" || typeof rule.upper !== "string" || validateFilterRule(rule)) return false
      ids.add(rule.id)
      return true
    })
    return { version: 1, match: data.match, rules }
  } catch { return emptyMarketFilters() }
}

export const FILTER_PRESETS = [
  { id: "long", label: "Long alignment", rules: [
    { field: "emaTrend", operator: "eq", value: "rising" }, { field: "emaBody", operator: "eq", value: "above" },
    { field: "roc", operator: "positive", value: "" }, { field: "maroc", operator: "positive", value: "" },
  ] },
  { id: "short", label: "Short alignment", rules: [
    { field: "emaTrend", operator: "eq", value: "falling" }, { field: "emaBody", operator: "eq", value: "below" },
    { field: "roc", operator: "negative", value: "" }, { field: "maroc", operator: "negative", value: "" },
  ] },
  { id: "high48", label: "48h high breakout", rules: [{ field: "high48", operator: "eq", value: "yes" }] },
  { id: "high96", label: "96h high breakout", rules: [{ field: "high96", operator: "eq", value: "yes" }] },
  { id: "low96", label: "96h low breakdown", rules: [{ field: "low96", operator: "eq", value: "yes" }] },
  { id: "rsi-low", label: "RSI6 below 30", rules: [{ field: "rsi6", operator: "lt", value: "30" }] },
  { id: "rsi-high", label: "RSI6 above 70", rules: [{ field: "rsi6", operator: "gt", value: "70" }] },
] satisfies { id: string; label: string; rules: Pick<FilterRule, "field" | "operator" | "value">[] }[]
export function marketFilterPreset(id: string): MarketFilters {
  return { version: 1, match: "all", rules: (FILTER_PRESETS.find(p => p.id === id)?.rules ?? []).map(rule => ({ ...makeFilterRule(rule.field), ...rule })) }
}
