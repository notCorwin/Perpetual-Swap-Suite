import { type EditorExpression, type FilterMetric, type RuleNode } from "./rule-engine.ts"

export type ExpressionParameter = { label: string; kind: "expression" | "number" | "choice"; minimum?: number; step?: string; unit?: string; choices?: { value: string; label: string }[] }
export type ExpressionTemplate = { name: string; label: string; group: string; unit: string; parameters: ExpressionParameter[]; defaults: string[]; description: string }
const periods = (label: string, minimum = 1): ExpressionParameter => ({ label, kind: "number", minimum, step: "1", unit: "candles" })
const source: ExpressionParameter = { label: "Source expression", kind: "expression" }
export const expressionTemplates: ExpressionTemplate[] = [
  { name: 'BTC', label: 'BTC reference', group: 'BTC Market Context', unit: 'source unit', parameters: [source, { label: 'BTC clock', kind: 'choice', choices: [{ value: 'aligned', label: 'Aligned with decision' }, { value: 'live', label: 'Live BTC hour' }, { value: 'closed', label: 'Latest closed BTC hour' }] }], defaults: ['ROC(1)', '"aligned"'], description: 'Reads BTC-USDT-SWAP. Live and Closed BTC clocks are independent of the contract decision clock; explicit time offsets still apply.' },
  ...[
    ['EMA', 'EMA', 'USDT', ['200'], [periods('Period (candles)')]],
    ['RSI', 'RSI', '0–100', ['14'], [periods('Period (candles)')]],
    ['ROC', 'ROC', '%', ['9'], [periods('Period (candles)')]],
    ['Efficiency', 'Direction efficiency', 'ratio', ['24'], [periods('Period (candles)')]],
    ['MAROC', 'MAROC', '%', ['9', '9'], [periods('ROC period (candles)'), periods('Mean period (candles)')]],
    ['VWAP', 'VWAP', 'USDT', ['14'], [periods('Period (candles)')]],
  ].map(([name, label, unit, defaults, parameters]) => ({ name, label, group: 'Parameterized indicators', unit, defaults, parameters, description: 'Computed at the selected evaluation candle.' } as ExpressionTemplate)),
  { name: 'LogBB', label: 'Log BB', group: 'Parameterized indicators', unit: 'USDT', parameters: [periods('Period (candles)'), { label: 'Deviations', kind: 'number', minimum: 0, step: 'any', unit: 'standard deviations' }, { label: 'Band', kind: 'choice', choices: [{ value: 'upper', label: 'Upper' }, { value: 'middle', label: 'Middle' }, { value: 'lower', label: 'Lower' }] }], defaults: ['20', '2', '"upper"'], description: 'Log-price Bollinger band with editable period, deviations and band.' },
  { name: 'PriorExtreme', label: 'Prior extreme', group: 'Parameterized indicators', unit: 'USDT', parameters: [periods('Reference candles'), { label: 'Extreme', kind: 'choice', choices: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }] }], defaults: ['48', '"high"'], description: 'Highest high or lowest low of the previous completed candles.' },
  { name: 'ExtremeAge', label: 'Extreme event age', group: 'Parameterized indicators', unit: 'candles', parameters: [periods('Reference candles'), periods('Search candles'), { label: 'Direction', kind: 'choice', choices: [{ value: 'breakout', label: 'High breakout' }, { value: 'breakdown', label: 'Low breakdown' }] }], defaults: ['48', '48', '"breakout"'], description: 'Candles since a high breakout or low breakdown, with editable reference and search windows.' },
  { name: "abs", label: "Absolute value", group: "Expression functions", unit: "source unit", parameters: [source], defaults: ["Price"], description: "Returns the magnitude of a numeric expression." },
  ...[["mean", "Mean"], ["sum", "Sum"], ["highest", "Highest"], ["lowest", "Lowest"], ["stddev", "Standard deviation"]].map(([name, label]) => ({ name, label, group: "Expression functions", unit: "source unit", parameters: [source, periods("Window candles")], defaults: ["Volume", "20"], description: "Includes the selected candle and preceding candle slots. Missing candles make the value Unknown." })),
  { name: "multiple", label: "Positive baseline multiple", group: "Expression functions", unit: "source unit", parameters: [source, { label: "Multiplier", kind: "number", minimum: Number.MIN_VALUE, step: "any", unit: "× baseline" }], defaults: ["mean(lag(Volume, 1), 20)", "2"], description: "Multiplies a strictly positive baseline by a positive constant. A zero, negative or unavailable baseline is Unknown." },
  { name: "lag", label: "Historical offset", group: "Expression functions", unit: "source unit", parameters: [source, periods("Offset candles", 0)], defaults: ["Volume", "1"], description: "Reads the expression at the selected candle minus the offset." },
  { name: "change", label: "Change rate", group: "Expression functions", unit: "%", parameters: [source, periods("Offset candles")], defaults: ["Price", "1"], description: "(Current − previous) / |previous| × 100%. The offset chooses the previous candle." },
  { name: "relativeChange", label: "Relative change", group: "Expression functions", unit: "%", parameters: [source, { ...source, label: 'Baseline expression' }], defaults: ["Close", "Open"], description: "(Current − baseline) / |baseline| × 100%. Both values are editable." },
  { name: "closed", label: "Previous closed candle", group: "Expression functions", unit: "source unit", parameters: [source], defaults: ["Price"], description: "Shifts this expression back one candle relative to the rule's evaluation candle." },
  { name: "live", label: "Current evaluation candle", group: "Expression functions", unit: "source unit", parameters: [source], defaults: ["Price"], description: "Reads at the rule's evaluation candle. A parent Closed anchor still applies." },
]
export const arithmeticOperations = [["+", "Add +"], ["-", "Subtract −"], ["*", "Multiply ×"]]
export const expressionName = (expression: EditorExpression): string => expression.operation?.toLowerCase() ?? ""
export function rawExpression(value: string, unit = ""): EditorExpression { return { kind: "raw", source: value, unit, arguments: [], choices: [] } }
export function numberExpression(value: string): EditorExpression { return { ...rawExpression(value, "constant"), kind: "number", value } }
export function expressionSource(expression: EditorExpression): string {
  switch (expression.kind) {
    case "number": case "name": return expression.value ?? expression.source
    case "text": return JSON.stringify(expression.value ?? "")
    case "binary": return `(${expressionSource(expression.arguments[0])} ${expression.operation} ${expressionSource(expression.arguments[1])})`
    case "unary": return `${expression.operation} (${expressionSource(expression.arguments[0])})`
    case "call": return `${expression.operation}(${expression.arguments.map(expressionSource).join(", ")})`
    default: return expression.source
  }
}
export function withExpressionArguments(expression: EditorExpression, index: number, argument: EditorExpression): EditorExpression {
  const result = { ...expression, arguments: Array.from({ length: Math.max(expression.arguments.length, index + 1) }, (_, i) => i === index ? argument : expression.arguments[i] ?? rawExpression('')) }
  return { ...result, source: expressionSource(result) }
}
export function templateExpression(template: ExpressionTemplate, argument?: EditorExpression): EditorExpression {
  const result: EditorExpression = {
    kind: "call", source: "", unit: template.unit, operation: template.name, choices: [],
    arguments: template.defaults.map((value, i) => template.parameters[i].kind === "expression" ? argument ?? rawExpression(value) : template.parameters[i].kind === 'choice' ? { ...rawExpression(value, 'category'), kind: 'text' as const, value: JSON.parse(value) as string } : numberExpression(value)),
  }
  if (argument && ["closed", "live", "BTC"].includes(template.name)) { result.unit = argument.unit; result.choices = argument.choices }
  return { ...result, source: expressionSource(result) }
}
export function arithmeticExpression(operation: string, argument: EditorExpression = rawExpression("Price")): EditorExpression {
  const result: EditorExpression = { kind: "binary", source: "", unit: "", operation, choices: [], arguments: [argument, numberExpression(["*", "/"].includes(operation) ? "2" : "0")] }
  return { ...result, source: expressionSource(result) }
}
export function functionCompletion(signature: string, templates = expressionTemplates): string {
  const template = templates.find(item => item.name.toLowerCase() === signature.split("(")[0].toLowerCase())
  if (template) return templateExpression(template).source
  const rules: Record<string, string> = {
    all: "all(Close > 0)", any: "any(Close > 0)", "not condition": "NOT (Close > 0)", between: "between(RSI(14), 30, 70)",
    positive: "positive(ROC(9))", negative: "negative(ROC(9))", zero: "zero(ROC(9))", available: "available(oiUSD)", unavailable: "unavailable(oiUSD)",
    absgte: "absGte(ROC(9), 2)", abslte: "absLte(ROC(9), 2)",
    every: "every(RSI(14) > 50, 3)", recent: 'recent(Close > PriorExtreme(48, "high"), 48)', count: 'count(RSI(14) > 50, 48, "gt", 3)',
    cooldown: 'cooldown(BTC(ROC(1), "live") < -2, 0)',
    crossup: "crossUp(Close, EMA(200))", crossdown: "crossDown(Close, EMA(200))",
    sequence: 'sequence(6, stage("break", High > PriorExtreme(48, "high"), 6, capture("level", PriorExtreme(48, "high"))), stage("retest", Low < break.level, 6), stage("reclaim", crossUp(Close, break.level), 6))',
  }
  return rules[signature.split("(")[0].toLowerCase()] ?? signature
}
export function selectRuleLeft(node: RuleNode, left: string, metrics: FilterMetric[], expressions: Record<string, EditorExpression>, units: Record<string, string>, selection?: EditorExpression, templates = expressionTemplates): Partial<RuleNode> {
  const metric = metrics.find(item => item.key.toLowerCase() === left.trim().toLowerCase())
  const template = templates.find(item => item.name.toLowerCase() === left.split("(")[0].toLowerCase())
  const info = expressions[left] ?? selection, unit = info?.unit || units[left] || metric?.unit || template?.unit
  const categorical = unit === "category" || unit === "text", numeric = metric?.numeric ?? (["binary", "unary", "number"].includes(info?.kind ?? "") ? true : unit ? !categorical : undefined)
  const next: Partial<RuleNode> = { left }
  if (numeric === undefined) return next
  if (categorical && node.kind !== "condition") next.kind = "condition"
  if (categorical && !["eq", "neq", "present", "missing"].includes(node.comparison)) next.comparison = "eq"
  if (["positive", "negative", "zero", "present", "missing"].includes(next.comparison ?? node.comparison)) return next
  const rightUnit = expressions[node.right]?.unit ?? units[node.right] ?? metrics.find(item => item.key.toLowerCase() === node.right.trim().toLowerCase())?.unit
  const choices = info?.choices ?? metric?.choices ?? []
  if (categorical && (!rightUnit || !["category", "text"].includes(rightUnit) || /^"/.test(node.right.trim()) && choices.length > 0 && !choices.some(choice => JSON.stringify(choice.value) === node.right.trim()))) next.right = JSON.stringify(choices[0]?.value ?? "")
  else if (numeric && (["category", "text"].includes(rightUnit ?? "") || /^"/.test(node.right.trim()))) next.right = "0"
  return next
}
