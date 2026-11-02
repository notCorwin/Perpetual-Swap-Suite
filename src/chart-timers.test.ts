import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { parse } from '@babel/parser'

const source = readFileSync(new URL('./MarketChart.tsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
function componentLogic(name: string, result: string) {
  const declaration = ast.program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find(node => node.id.type === 'Identifier' && node.id.name === name)
  assert.ok(declaration?.init?.type === 'CallExpression')
  const component = declaration.init.arguments[0]
  assert.ok(component?.type === 'FunctionExpression')
  const renderReturn = component.body.body.at(-1)
  assert.ok(renderReturn?.type === 'ReturnStatement')
  return stripTypeScriptTypes(`${source.slice(component.start!, renderReturn.start!)}return ${result} }`)
}

test('price freshness schedules one expiration and cancels it on cleanup', () => {
  let now = 1000, timer: { at: number; callback: () => void } | undefined, updates = 0
  const cleanups: (() => void)[] = []
  const environment = {
    Date: { now: () => now },
    window: {
      setTimeout(callback: () => void, delay: number) { assert.equal(timer, undefined); timer = { at: now + delay, callback }; return 1 },
      clearTimeout() { timer = undefined },
      setInterval() { assert.fail('freshness must not poll') },
      clearInterval() {},
    },
    useState: (initial: () => number) => [initial(), () => { updates++ }],
    useEffect(setup: () => void | (() => void)) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) },
  }
  const render = new Function(...Object.keys(environment), `${componentLogic('PriceStatus', 'fresh')}\nreturn PriceStatus`)(...Object.values(environment))
  assert.equal(render({ observedAt: 500, realtime: 'live', active: true }), true)
  assert.equal(timer?.at, 30_500)
  now = 30_500
  timer!.callback()
  assert.equal(updates, 1)
  cleanups.forEach(cleanup => cleanup())
  assert.equal(timer, undefined)
  assert.equal(render({ observedAt: 500, realtime: 'live', active: true }), false)
  assert.equal(timer, undefined)
  assert.equal(render({ observedAt: 31_000, realtime: 'live', active: false }), true)
  assert.equal(timer, undefined)
})

test('countdown only runs when its chart is visible', () => {
  let visible = false, intervals = 0, clears = 0, updates = 0
  const cleanups: (() => void)[] = []
  const environment = {
    Date: { now: () => 1000 }, PlotVisible: {},
    useContext: () => visible,
    useState: (initial: () => number) => [initial(), () => { updates++ }],
    useEffect(setup: () => void | (() => void)) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) },
    window: { setInterval() { intervals++; return 1 }, clearInterval() { clears++ } },
  }
  const render = new Function(...Object.keys(environment), `${componentLogic('PriceCountdown', 'seconds')}\nreturn PriceCountdown`)(...Object.values(environment))
  render({ hour: 0, intervalMS: 5000, x: 0, y: 0 })
  assert.equal(intervals, 0)
  visible = true
  render({ hour: 0, intervalMS: 5000, x: 0, y: 0 })
  assert.equal(intervals, 1)
  assert.equal(updates, 1)
  cleanups.forEach(cleanup => cleanup())
  assert.equal(clears, 1)
})
