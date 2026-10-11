import { expressionName, expressionSource, expressionTemplates, templateExpression, type ExpressionTemplate } from './filter-expression.ts'
import { canReceiveChildren, comparisons, findParent, findRule, makeRule, newRuleID, ruleKinds, updateRule, type EditorExpression, type FilterConfigV2, type FilterMetric, type NamedFormula, type RuleKind, type RuleNode } from './rule-engine.ts'

export type LibraryItem = { id: string; label: string; group: string; description: string; keywords: string[]; unit?: string; metric?: FilterMetric; template?: ExpressionTemplate; create: () => RuleNode }
const condition = (left: string, comparison: string, right: string): RuleNode => ({ ...makeRule(), left, comparison, right })
const branch = (kind: RuleKind, children: RuleNode[], hours = 3): RuleNode => ({ ...makeRule(kind), children, hours })
export function makeVisualBranch(kind: RuleKind): RuleNode {
  if (kind === 'sequence') {
    const first = { ...condition('High', 'gt', 'PriorHigh(48)'), name: 'break', captures: [{ id: newRuleID(), name: 'level', expression: 'PriorHigh(48)' }] }
    return branch('sequence', [first, { ...condition('Low', 'lt', 'break.level'), name: 'retest' }, { ...condition('Close', 'gt', 'break.level'), kind: 'crossup', name: 'reclaim' }], 6)
  }
  if (['all', 'any'].includes(kind)) return branch(kind, [])
  if (['not', 'every', 'recent', 'count', 'cooldown'].includes(kind)) return branch(kind, [condition('RSI(14)', 'gt', '50')], kind === 'cooldown' ? 0 : 3)
  return makeRule(kind)
}
const btcCrash = () => ({ ...branch('cooldown', [branch('any', [condition('BTC(ROC(1), "live")', 'lt', '-2'), condition('BTC(ROC(3), "live")', 'lt', '-4')])], 0), name: 'BTC Crash' })
const btcRanging = () => ({ ...branch('cooldown', [branch('every', [condition('BTC(Efficiency(24), "closed")', 'lt', '0.30')], 3)], 0), name: 'BTC Ranging' })
export const visualPresets = [
  { id: 'preset:btc-crash', label: 'BTC Crash', description: 'Live BTC 1h change < −2% OR 3h change < −4%. Optional cooldown defaults to 0h. Editable example thresholds; not validated by backtest.', keywords: ['BTC Bitcoin crash market context 暴跌 大盘 冷却'], create: btcCrash },
  { id: 'preset:btc-ranging', label: 'BTC Ranging', description: 'BTC 24h direction efficiency < 0.30 for three completed hours. Includes narrow and wide directionless movement. Editable example parameters.', keywords: ['BTC Bitcoin ranging sideways efficiency 震荡 横盘'], create: btcRanging },
  { id: 'preset:btc-entry', label: 'BTC Entry Gate', description: 'Combines with all existing entry rules using AND: neither BTC Crash nor BTC Ranging. Every restriction is visible and editable.', keywords: ['BTC Bitcoin entry gate 入场'], create: () => ({ ...branch('not', [branch('any', [btcCrash(), btcRanging()])]), name: 'BTC Entry Gate' }) },
  { id: 'preset:btc-exit', label: 'BTC Exit Signal', description: 'Combines with all existing exit rules using OR: BTC Crash or BTC Ranging. Live BTC exits can precede the next contract close.', keywords: ['BTC Bitcoin exit signal 出场'], create: () => ({ ...branch('any', [btcCrash(), btcRanging()]), name: 'BTC Exit Signal' }) },
  { id: 'preset:oi', label: 'OI rising', description: 'OI Trend is Rising. Live or closed readings, with an editable time requirement.', keywords: ['open interest trend', '持仓上涨', '持仓趋势'], create: () => condition('oiTrend', 'eq', '"rising"') },
  { id: 'preset:body', label: 'Body above EMA', description: 'Whole candle body above EMA 200 for 48 consecutive closed hours. Wicks are excluded.', keywords: ['body ema 200 48h candle open close', 'K线 实体 均线 连续'], create: () => ({ ...branch('every', [branch('all', [condition('Open', 'gt', 'EMA(200)'), condition('Close', 'gt', 'EMA(200)')])], 48), mode: 'closed' as const }) },
  { id: 'preset:volume', label: 'Volume surge', description: 'Quote volume greater than 2 × the mean of the previous 20 closed candles. A nonpositive or unavailable baseline is Unknown.', keywords: ['volume average mean 20 two times', '成交量 放量 均量 两倍'], create: () => condition('Volume', 'gt', 'multiple(mean(lag(Volume, 1), 20), 2)') },
  { id: 'preset:rsi', label: 'Three closed RSI hours', description: 'RSI 14 above 50 in each of the last three closed hours.', keywords: ['rsi continuous consecutive', '已收盘 RSI 连续 三小时'], create: () => ({ ...branch('every', [condition('RSI(14)', 'gt', '50')], 3), mode: 'closed' as const }) },
  { id: 'preset:sequence', label: 'Break & retest', description: 'Break above the prior 48h high, retest the captured level, then reclaim within 6 hours.', keywords: ['breakout retest reclaim event sequence capture', '突破 回踩 重新站上'], create: () => makeVisualBranch('sequence') },
  { id: 'preset:alignment', label: 'Long or short alignment', description: 'Rising EMA and positive ROC, or falling EMA and negative ROC, in separate groups.', keywords: ['and or long short trend momentum', '多空 分组'], create: () => branch('any', [branch('all', [condition('emaTrend', 'eq', '"rising"'), condition('ROC(9)', 'gt', '0')]), branch('all', [condition('emaTrend', 'eq', '"falling"'), condition('ROC(9)', 'lt', '0')])]) },
]
export function conditionLibrary(metrics: FilterMetric[], templates: ExpressionTemplate[] = expressionTemplates): LibraryItem[] {
  return [
    ...visualPresets.map(p => ({ ...p, group: p.id.startsWith('preset:btc-') ? 'BTC Market Context' : 'Ready to use' })),
    ...metrics.map(metric => ({ id: `metric:${metric.key}`, label: metric.label, group: metric.group, description: metric.description, keywords: [metric.key, ...(metric.aliases ?? [])], unit: metric.unit, metric,
      create: () => condition(metric.key, metric.numeric ? 'gt' : 'eq', metric.numeric ? metric.unit === '0–100' ? '50' : '0' : JSON.stringify(metric.choices[0]?.value ?? '')) })),
    ...templates.map(template => ({ id: `function:${template.name}`, label: template.label, group: template.group === 'Expression functions' ? 'Value blocks' : template.group, description: template.description, keywords: [template.name], unit: template.unit, template,
      create: () => condition(templateExpression(template).source, 'gt', template.unit === '0–100' ? '50' : '0') })),
    ...ruleKinds.filter(k => k.value !== 'condition').map(k => ({ id: `rule:${k.value}`, label: k.label, group: 'Logic & time', description: ruleHelp(k.value), keywords: [k.value], create: () => makeVisualBranch(k.value) })),
    ...comparisons.map(([key, label]) => ({ id: `comparison:${key}`, label, group: 'Comparisons & availability', description: ['present', 'missing'].includes(key) ? 'Explicitly checks whether data exists. This can select markets with missing data.' : 'Compare any numeric indicator, constant or reusable value. Both sides are editable.', keywords: [key], create: () => condition('Price', key, '0') })),
  ]
}
export function addLibraryRule(config: FilterConfigV2, selectedId: string | null, item: LibraryItem): { config: FilterConfigV2; selectedId: string } {
  const child = item.create()
  if (['preset:btc-entry', 'preset:btc-exit'].includes(item.id)) {
    const kind: RuleKind = item.id === 'preset:btc-entry' ? 'all' : 'any'
    const root = config.root
    const combined = root.children.length === 0 ? { ...root, kind, children: [child] } : root.kind === kind && root.mode === 'live'
      ? { ...root, children: [...root.children, child] } : branch(kind, [root, child])
    return { config: { ...config, root: combined }, selectedId: child.id }
  }
  let target = selectedId ? findRule(config.root, selectedId) : config.root
  if (target && !canReceiveChildren(target)) target = findParent(config.root, target.id)
  while (target && !canReceiveChildren(target)) target = findParent(config.root, target.id)
  target ??= config.root
  if (!canReceiveChildren(target)) return { config, selectedId: config.root.id }
  if (target.kind === 'sequence') {
    const names = new Set(target.children.map(n => n.name)); let i = 1
    while (names.has(`stage${i}`)) i++
    child.name = `stage${i}`
  }
  return { config: { ...config, root: updateRule(config.root, target.id, n => ({ ...n, children: [...n.children, child] })) }, selectedId: child.id }
}
export function captureScope(root: RuleNode, target: string, scope: NamedFormula[] = []): NamedFormula[] | null {
  if (root.id === target) return scope
  const next = [...scope]
  for (const child of root.children) {
    const found = captureScope(child, target, next)
    if (found) return found
    if (root.kind === 'sequence') next.push(...child.captures.map(item => ({ ...item, name: `${child.name}.${item.name}` })))
  }
  return null
}
export function rulePath(root: RuleNode, id: string): RuleNode[] {
  if (root.id === id) return [root]
  for (const child of root.children) { const path = rulePath(child, id); if (path.length) return [root, ...path] }
  return []
}
export const anchorOffset = (root: RuleNode, id: string) => rulePath(root, id).filter(n => n.mode === 'closed').length
export function topLevelSelection(root: RuleNode, ids: string[]): string[] {
  return ids.filter(id => id !== root.id && findRule(root, id) && !rulePath(root, id).slice(0, -1).some(n => ids.includes(n.id)))
}
export const timeWrapper = (n: RuleNode) => ['every', 'recent', 'count', 'cooldown'].includes(n.kind)
export function renameValueReferences(config: FilterConfigV2, symbols: Record<string, string>, expressions: Record<string, EditorExpression>): FilterConfigV2 {
  const change = (tree: EditorExpression): EditorExpression => {
    const next = { ...tree, arguments: tree.arguments.map(change) }
    if (next.kind === 'name') { next.value = symbols[next.value ?? next.source] ?? next.value; next.source = next.value ?? next.source }
    return { ...next, source: expressionSource(next) }
  }
  const rename = (source: string) => expressions[source] ? change(expressions[source]).source : symbols[source] ?? source
  const node = (n: RuleNode): RuleNode => ({ ...n, left: rename(n.left), right: rename(n.right), upper: rename(n.upper), children: n.children.map(node), captures: n.captures.map(c => ({ ...c, expression: rename(c.expression) })) })
  return { ...config, root: node(config.root), definitions: config.definitions.map(d => ({ ...d, expression: rename(d.expression) })) }
}
export function bodyPresentation(n: RuleNode): { period: string; direction: string } | null {
  if (n.kind !== 'all' || n.children.length !== 2) return null
  const a = n.children.find(c => c.left === 'Open'), b = n.children.find(c => c.left === 'Close')
  if (!a || !b || a.kind !== 'condition' || b.kind !== 'condition' || a.mode !== 'live' || b.mode !== 'live' || a.captures.length || b.captures.length || a.comparison !== b.comparison || !['gt', 'lt'].includes(a.comparison) || a.right !== b.right) return null
  const period = /^EMA\(\s*([+-]?\d*)\s*\)$/i.exec(a.right)?.[1]
  return period !== undefined ? { period, direction: a.comparison === 'gt' ? 'above' : 'below' } : null
}
export function valueLabel(value: string, metrics: FilterMetric[], expressions: Record<string, EditorExpression>, templates: ExpressionTemplate[] = expressionTemplates): string {
  if (['Known matches', 'Unknown hours', 'Threshold', 'Maximum count'].includes(value)) return value
  if (value.startsWith('Previous ')) return `Previous ${valueLabel(value.slice(9), metrics, expressions, templates)}`
  if (value.startsWith('Maximum: ')) return `Maximum ${valueLabel(value.slice(9), metrics, expressions, templates)}`
  const metric = metrics.find(m => m.key.toLowerCase() === value.trim().toLowerCase())
  if (metric) return metric.label
  const tree = expressions[value]
  if (tree) return expressionLabel(tree, metrics, templates)
  try { const text: unknown = JSON.parse(value); if (typeof text === 'string') return text.charAt(0).toUpperCase() + text.slice(1) } catch { /* Native compiler handles expressions. */ }
  if (value.trim() && Number.isFinite(Number(value))) return value
  const template = templates.find(t => value.toLowerCase().startsWith(`${t.name.toLowerCase()}(`))
  return template?.label ?? (value.includes('.') ? value.split('.').map(humanName).join(' · ') : /^[A-Za-z_]\w*$/.test(value) ? humanName(value) : 'Value blocks')
}
export function humanName(name: string): string { return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^break\b/, 'Breakout').replace(/^level\b/, 'Level').replace(/\b\w/g, c => c.toUpperCase()) }
export function expressionLabel(e: EditorExpression, metrics: FilterMetric[], templates: ExpressionTemplate[] = expressionTemplates): string {
  const arg = (i: number) => e.arguments[i] ? expressionLabel(e.arguments[i], metrics, templates) : 'Value'
  if (e.kind === 'name') return metrics.find(m => m.key === (e.value ?? e.source))?.label ?? humanName(e.value ?? e.source)
  if (e.kind === 'number') return e.value ?? e.source
  if (e.kind === 'text') return humanName(e.value ?? '')
  if (e.kind === 'binary') return `${arg(0)} ${{ '+': '+', '-': '−', '*': '×', '/': '÷' }[e.operation ?? '+']} ${arg(1)}`
  if (e.kind === 'unary') return `${e.operation === '-' ? 'Negative' : 'Positive'} ${arg(0)}`
  const name = expressionName(e), label = templates.find(t => t.name.toLowerCase() === name)?.label
  if (name === 'multiple') return `${arg(1)}× ${arg(0)}`
  if (name === 'mean' && e.arguments[0]?.kind === 'call' && expressionName(e.arguments[0]) === 'lag' && e.arguments[0].arguments[1]?.value === '1') return `Average ${expressionLabel(e.arguments[0].arguments[0], metrics, templates)} · previous ${arg(1)} closed hours`
  if (['mean', 'sum', 'highest', 'lowest', 'stddev'].includes(name)) return `${label} of ${arg(0)} · ${arg(1)}h`
  if (name === 'lag') return `${arg(0)} · ${arg(1)}h earlier`
  if (name === 'closed') return `${arg(0)} · previous hour`
  if (name === 'live') return arg(0)
  if (e.kind === 'call' && label) return `${label} ${e.arguments.map((_, i) => arg(i)).join(' / ')}`
  return 'Value blocks'
}
export function ruleSentence(n: RuleNode, metrics: FilterMetric[], expressions: Record<string, EditorExpression>, templates: ExpressionTemplate[] = expressionTemplates): string {
  const body = bodyPresentation(n)
  if (body) return `Whole candle body ${body.direction} EMA ${body.period}`
  if (n.kind === 'all' || n.kind === 'any') return `${n.kind === 'all' ? 'All' : 'Any'} of ${n.children.length} ${n.children.length === 1 ? 'condition' : 'conditions'}`
  if (n.kind === 'sequence') return `${n.children.map(c => humanName(c.name || 'Stage')).join(' → ')} within ${n.hours}h`
  const child = n.children[0] ? ruleSentence(n.children[0], metrics, expressions, templates) : 'Add a condition'
  if (n.kind === 'not') return `NOT · ${child}`
  if (n.kind === 'every') return `${child} · every hour for ${n.hours}h`
  if (n.kind === 'recent') return `${child} · at least once in ${n.hours}h`
  if (n.kind === 'count') return `${child} · ${n.comparison === 'between' ? `between ${n.minimum} and ${n.upper}` : `${comparisons.find(c => c[0] === n.comparison)?.[1] ?? n.comparison} ${n.minimum}`} times in ${n.hours}h`
  if (n.kind === 'cooldown') return `${child} · cooldown ${n.hours}h${n.hours === 0 ? ' (disabled)' : ''}`
  const left = valueLabel(n.left, metrics, expressions, templates), right = valueLabel(n.right, metrics, expressions, templates)
  if (n.kind.startsWith('cross')) return `${left} crosses ${n.kind === 'crossup' ? 'above' : 'below'} ${right}`
  const op: Record<string, string> = { eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', 'abs-gte': 'absolute value ≥', 'abs-lte': 'absolute value ≤', positive: 'is positive', negative: 'is negative', zero: 'is zero', present: 'is available', missing: 'is unavailable' }
  return n.comparison === 'between' ? `${left} between ${right} and ${valueLabel(n.upper, metrics, expressions, templates)}` : `${left} ${op[n.comparison] ?? n.comparison}${['positive', 'negative', 'zero', 'present', 'missing'].includes(n.comparison) ? '' : ' ' + right}`
}
export function ruleHelp(kind: RuleKind): string {
  const help: Record<RuleKind, string> = {
    all: 'Every condition must be True. False takes priority over missing data.', any: 'At least one condition must be True. True takes priority over missing data.', not: 'Inverts True and False. Missing data stays Unknown; NOT never turns missing data into a match.',
    condition: 'Compare constants, indicators and reusable values. Only True selects a market. Available / Unavailable can explicitly select missing data.',
    every: 'Requires every hourly slot to match, including the evaluated hour. Missing slots are not skipped.', recent: 'At least one matching hour in the full window, including the evaluated hour. Use this to find already completed sequences.',
    count: 'Counts matching hours in the full window. Missing hours remain Unknown whenever they could change the answer.',
    cooldown: 'Triggers immediately and stays active for the configured hours after the last match. 0h disables the cooldown. Live triggers are retained in memory; historical studies use hourly samples.',
    crossup: 'Previous hour ≤ reference; evaluated hour strictly > reference. Equality is allowed only at the starting point.', crossdown: 'Previous hour ≥ reference; evaluated hour strictly < reference. Equality is allowed only at the starting point.',
    sequence: 'Stages occur in order at different hours. Each gap is measured from the previous stage; the last stage must occur at the evaluated hour. Captured values stay frozen along each feasible path.',
  }
  return help[kind]
}
