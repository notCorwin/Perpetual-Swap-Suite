import assert from "node:assert/strict"
import test from "node:test"
import { arithmeticExpression, expressionTemplates, functionCompletion, numberExpression, rawExpression, selectRuleLeft, templateExpression, withExpressionArguments } from "./filter-expression.ts"
import { makeRule, type EditorExpression, type FilterMetric } from "./rule-engine.ts"

test("visual relative volume edits preserve a positive baseline and nested offsets", () => {
  const template = (name: string) => expressionTemplates.find(item => item.name === name)!
  const lag = templateExpression(template("lag"), rawExpression("Volume", "USDT"))
  const mean = templateExpression(template("mean"), lag)
  const multiple = templateExpression(template("multiple"), mean)
  assert.equal(multiple.source, "multiple(mean(lag(Volume, 1), 20), 2)")
  const emptyWindow = withExpressionArguments(mean, 1, numberExpression(""))
  assert.equal(emptyWindow.source, "mean(lag(Volume, 1), )")
  assert.equal(withExpressionArguments(emptyWindow, 1, numberExpression("48")).source, "mean(lag(Volume, 1), 48)")
  assert.equal(withExpressionArguments(lag, 1, numberExpression("0")).source, "lag(Volume, 0)")
})

test('BTC expressions edit the clock without formula entry, including an omitted aligned clock', () => {
  const btc = expressionTemplates.find(item => item.name === 'BTC')!
  const efficiency = templateExpression(expressionTemplates.find(item => item.name === 'Efficiency')!)
  const reading = templateExpression(btc, efficiency)
  assert.equal(reading.source, 'BTC(Efficiency(24), "aligned")')
  const closed = withExpressionArguments(reading, 1, { ...rawExpression('"closed"', 'category'), kind: 'text', value: 'closed' })
  assert.equal(closed.source, 'BTC(Efficiency(24), "closed")')
  const implicit = { ...reading, source: 'BTC(Efficiency(24))', arguments: [efficiency] }
  assert.equal(withExpressionArguments(implicit, 1, closed.arguments[1]).source, closed.source)
  assert.deepEqual(btc.parameters[1].choices?.map(choice => choice.value), ['aligned', 'live', 'closed'])
  assert.equal(functionCompletion('cooldown(condition, hours)'), 'cooldown(BTC(ROC(1), "live") < -2, 0)')
})

test("value block completions have usable defaults for every scalar and time function", () => {
  for (const item of expressionTemplates) {
    const completion = functionCompletion(`${item.name}(x, n)`)
    assert.equal(completion, templateExpression(item).source)
    assert.doesNotMatch(completion, /\b(?:x|n|rocN|meanN|searchHours|deviations)\b/)
  }
  for (const signature of ["all(...)", "any(...)", "NOT condition", "between(x, min, max)", "absGte(x, threshold)", "absLte(x, threshold)", "every(condition, hours)", "recent(condition, hours)", 'count(condition, hours, "gte", minimum)', "crossUp(left, right)", "crossDown(left, right)", "sequence(hours, stages)"]) assert.notEqual(functionCompletion(signature), signature)
})

test("categorical and numeric selections repair incompatible operators and preserve valid reference operands", () => {
  const oi: FilterMetric = { key: "oiTrend", label: "OI trend", group: "Participation", description: "", unit: "category", numeric: false, choices: [{ value: "rising", label: "Rising" }] }
  const symbol: FilterMetric = { ...oi, key: "Symbol", unit: "text", choices: [] }
  const name: EditorExpression = { ...rawExpression("trend", "category"), kind: "name", value: "trend", choices: oi.choices }
  const units = { trend: "category", emaTrend: "category", oiTrend: "category", "0": "constant" }
  const node = makeRule("crossup")
  assert.deepEqual(selectRuleLeft(node, "oiTrend", [oi], {}, units), { left: "oiTrend", kind: "condition", comparison: "eq", right: '"rising"' })
  assert.equal(selectRuleLeft(makeRule(), "Symbol", [symbol], {}, units).right, '""')
  assert.equal(selectRuleLeft(makeRule(), "trend", [oi], { trend: name }, units).right, '"rising"')
  const custom = { ...makeRule(), comparison: "eq", right: "emaTrend" }
  assert.equal(selectRuleLeft(custom, "oiTrend", [oi], {}, units).right, undefined)
  assert.equal(selectRuleLeft(custom, "EMA(200)", [oi], {}, units).right, "0")
  const arithmetic = arithmeticExpression("+")
  assert.equal(selectRuleLeft(custom, arithmetic.source, [oi], {}, units, arithmetic).right, "0")
})
