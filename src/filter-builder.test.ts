import assert from 'node:assert/strict'
import test from 'node:test'
import { addLibraryRule, anchorOffset, bodyPresentation, captureScope, conditionLibrary, parameterizedConditionMetrics, renameValueReferences, ruleSentence, topLevelSelection, visualPresets } from './filter-builder.ts'
import { arithmeticExpression, rawExpression } from './filter-expression.ts'
import { comparisonConditionMetrics, emptyFilterConfig, makeRule, unwrapRule, wrapRule, type FilterMetric } from './rule-engine.ts'

const metrics: FilterMetric[] = [
  { key: 'oiTrend', label: 'OI Trend', group: 'Open interest', description: 'Compare hourly OI.', unit: 'category', numeric: false, choices: [{ value: 'rising', label: 'Rising' }] },
  { key: 'customStatus', label: 'Custom status', group: 'Custom', description: 'Unique categorical state.', unit: 'category', numeric: false, choices: [{ value: 'ready', label: 'Ready' }] },
]
test('BTC presets expose independent clocks, confirmation, thresholds and disabled cooldowns', () => {
  const library = conditionLibrary(metrics)
  const crash = library.find(item => item.id === 'preset:btc-crash')!
  assert.equal(crash.group, 'BTC Market Context')
  const rule = crash.create()
  assert.equal(rule.kind, 'cooldown'); assert.equal(rule.hours, 0)
  assert.equal(rule.children[0].kind, 'any')
  assert.deepEqual(rule.children[0].children.map(node => [node.left, node.comparison, node.right]), [['BTC(ROC(1), "live")', 'lt', '-2'], ['BTC(ROC(3), "live")', 'lt', '-4']])
  const ranging = library.find(item => item.id === 'preset:btc-ranging')!.create()
  assert.equal(ranging.hours, 0)
  assert.equal(ranging.children[0].kind, 'every'); assert.equal(ranging.children[0].hours, 3)
  assert.equal(ranging.children[0].children[0].left, 'BTC(Efficiency(24), "closed")')
  const wrapped = wrapRule(rule, rule.children[0].id, 'cooldown')
  assert.equal(wrapped.children[0].hours, 0)
  assert.equal(unwrapRule(wrapped, wrapped.children[0].id).children[0].kind, 'any')
})
test('entry and exit BTC presets compose with all existing rules and preserve their clock', () => {
  const library = conditionLibrary(metrics)
  for (const [id, kind] of [['preset:btc-entry', 'all'], ['preset:btc-exit', 'any']]) {
    const cfg = emptyFilterConfig()
    cfg.root.kind = kind === 'all' ? 'any' : 'all'; cfg.root.mode = 'closed'
    cfg.root.children = [makeRule(), makeRule()]
    const original = structuredClone(cfg)
    const next = addLibraryRule(cfg, cfg.root.children[0].id, library.find(item => item.id === id)!)
    assert.equal(next.config.root.kind, kind)
    assert.deepEqual(next.config.root.children[0], original.root)
    assert.equal(next.config.root.children[1].id, next.selectedId)
    assert.equal(next.config.root.mode, 'live')
    assert.deepEqual(cfg, original)
  }
})
test('ready-to-use rules encode complete windows, closed anchors and frozen event references', () => {
  const preset = (id: string) => visualPresets.find(p => p.id === id)!.create()
  const body = preset('preset:body')
  assert.equal(body.mode, 'closed'); assert.equal(body.kind, 'every'); assert.equal(body.hours, 48)
  assert.deepEqual(body.children[0].children.map(n => [n.left, n.comparison, n.right, n.mode]), [['Open', 'gt', 'EMA(200)', 'live'], ['Close', 'gt', 'EMA(200)', 'live']])
  assert.equal(preset('preset:volume').right, 'multiple(mean(lag(Volume, 1), 20), 2)')
  const rsi = preset('preset:rsi'); assert.equal(rsi.mode, 'closed'); assert.equal(rsi.hours, 3)
  const sequence = preset('preset:sequence')
  assert.equal(sequence.hours, 6)
  assert.equal(sequence.children[0].captures[0].expression, 'PriorExtreme(48, "high")')
  assert.equal(sequence.children[1].right, 'break.level'); assert.equal(sequence.children[2].kind, 'crossup')
  assert.deepEqual(captureScope(sequence, sequence.children[2].id)?.map(c => c.name), ['break.level'])
})
test('library additions honor the selected group and preserve unrelated rules and settings', () => {
  const cfg = emptyFilterConfig(), group = makeRule('any'); cfg.root.children = [group]
  const item = conditionLibrary(metrics).find(i => i.id === 'metric:customStatus')!
  const next = addLibraryRule(cfg, group.id, item)
  assert.equal(next.config.root.children[0].children[0].id, next.selectedId)
  assert.equal(next.config.root.children[0].children[0].right, '"ready"')
  assert.equal(cfg.root.children[0].children.length, 0)
  assert.equal(next.config.root.kind, 'all')
  assert.equal(new Set(conditionLibrary(metrics).map(i => i.id)).size, conditionLibrary(metrics).length)
})
test('fixed derived conditions collapse into canonical parameterized entries', () => {
  const namedVariants: FilterMetric[] = [
    { key: 'rsi6', label: 'RSI6', group: 'RSI', description: 'Fixed RSI.', unit: '0–100', numeric: true, choices: [] },
    { key: 'rsi12', label: 'RSI12', group: 'RSI', description: 'Fixed RSI.', unit: '0–100', numeric: true, choices: [] },
    { key: 'rsi24', label: 'RSI24', group: 'RSI', description: 'Fixed RSI.', unit: '0–100', numeric: true, choices: [] },
    { key: 'roc', label: 'ROC9 (%)', group: 'Momentum', description: 'Fixed ROC.', unit: '%', numeric: true, choices: [] },
    { key: 'maroc', label: 'MAROC9 (%)', group: 'Momentum', description: 'Fixed MAROC.', unit: '%', numeric: true, choices: [] },
  ]
  const named = new Map(namedVariants.map(metric => [metric.key, metric]))
  const variants = [...new Set(Object.values(parameterizedConditionMetrics).flat())].map(key => named.get(key) ?? ({ key, label: key, group: 'Derived', description: 'Fixed derived condition.', unit: '%', numeric: true, choices: [] } satisfies FilterMetric))
  const library = conditionLibrary(variants)
  for (const keys of Object.values(parameterizedConditionMetrics)) {
    for (const key of keys) assert.equal(library.some(item => item.id === `metric:${key}`), false, key)
  }
  const rsi = library.find(item => item.id === 'function:RSI')!
  assert.equal(rsi.create().left, 'RSI(14)')
  assert.ok(rsi.keywords.includes('rsi6'))
  assert.ok(rsi.keywords.includes('RSI24'))
  assert.equal(library.filter(item => item.id === 'function:RSI').length, 1)
  assert.equal(library.find(item => item.id === 'function:ROC')!.create().left, 'ROC(9)')
  assert.equal(library.find(item => item.id === 'function:MAROC')!.create().left, 'MAROC(9, 9)')
  assert.equal(library.find(item => item.id === 'function:LogBB')!.create().left, 'LogBB(20, 2, "upper")')
  assert.equal(library.find(item => item.id === 'function:PriorExtreme')!.create().left, 'PriorExtreme(48, "high")')
  assert.equal(library.find(item => item.id === 'function:ExtremeAge')!.create().left, 'ExtremeAge(48, 48, "breakout")')
  assert.equal(library.find(item => item.id === 'function:relativeChange')!.create().left, 'relativeChange(Close, Open)')
})
test('legacy vs fields merge into direct editable comparisons', () => {
  const variants = [...comparisonConditionMetrics].map(key => ({ key, label: key.replace(/([a-z])([A-Z])/g, '$1 vs $2'), group: 'Derived', description: 'Legacy comparison.', unit: 'category', numeric: false, choices: [] } satisfies FilterMetric))
  const library = conditionLibrary(variants)
  for (const key of comparisonConditionMetrics) {
    assert.equal(library.some(item => item.id === `metric:${key}`), false, key)
    assert.equal(library.some(item => item.id.startsWith('vs:') && item.keywords.includes(key)), true, key)
  }
  assert.deepEqual(library.filter(item => item.id.startsWith('vs:')).map(item => item.id), ['vs:price-ema', 'vs:rsi-rsi', 'vs:roc-maroc', 'vs:buy-sell', 'vs:log-bb', 'vs:price-vwap'])
  const values = (id: string) => { const rule = library.find(item => item.id === id)!.create(); return [rule.left, rule.comparison, rule.right] }
  assert.deepEqual(values('vs:rsi-rsi'), ['RSI(6)', 'gt', 'RSI(12)'])
  assert.deepEqual(values('vs:roc-maroc'), ['ROC(9)', 'gt', 'MAROC(9, 9)'])
  assert.deepEqual(values('vs:buy-sell'), ['buy', 'gt', 'sell'])
  assert.deepEqual(values('vs:log-bb'), ['Close', 'gt', 'LogBB(20, 2, "upper")'])
  assert.ok(library.find(item => item.id === 'vs:rsi-rsi')!.keywords.includes('rsi12vs24'))
})
test('summaries retain the selected time semantics and bulk operations do not double-apply ancestors', () => {
  const root = makeRule('all'), group = makeRule('every'), child = makeRule()
  root.mode = 'closed'; group.mode = 'closed'; group.hours = 48; child.left = 'oiTrend'; child.comparison = 'eq'; child.right = '"rising"'
  group.children = [child]; root.children = [group]
  assert.equal(anchorOffset(root, child.id), 2)
  assert.match(ruleSentence(group, metrics, {}), /OI Trend is Rising · every hour for 48h/)
  assert.deepEqual(topLevelSelection(root, [root.id, group.id, child.id]), [])
  assert.deepEqual(topLevelSelection(root, [group.id, child.id]), [group.id])
})
test('editing an empty body period retains the specialized visual controls for repairing invalid drafts', () => {
  const body = visualPresets.find(p => p.id === 'preset:body')!.create().children[0]
  body.children.forEach(c => c.right = 'EMA()')
  assert.deepEqual(bodyPresentation(body), { period: '', direction: 'above' })
  body.children[1].mode = 'closed'
  assert.equal(bodyPresentation(body), null, 'A distinct child anchor must never be hidden by a composite control')
})
test('renaming captured values updates parsed references and preserves matching literal text', () => {
  const cfg = emptyFilterConfig(), rule = makeRule()
  rule.left = '(break.level * 2)'; rule.right = '"break.level"'; cfg.root.children = [rule]
  const tree = arithmeticExpression('*', { ...rawExpression('break.level', 'USDT'), kind: 'name', value: 'break.level' })
  const renamed = renameValueReferences(cfg, { 'break.level': 'break.reference' }, { [rule.left]: tree, [rule.right]: { ...rawExpression(rule.right, 'text'), kind: 'text', value: 'break.level' } })
  assert.equal(renamed.root.children[0].left, '(break.reference * 2)')
  assert.equal(renamed.root.children[0].right, '"break.level"')
  assert.equal(cfg.root.children[0].left, '(break.level * 2)')
})
