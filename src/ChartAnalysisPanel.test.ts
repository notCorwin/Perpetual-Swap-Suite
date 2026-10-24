import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { parse } from '@babel/parser'
import type { AnalysisSession } from './chart-analysis.ts'

// Execute the actual component's state/effect body without rendering JSX or
// importing any desktop API. A reintroduced presentation retry effect must fail.
const source = readFileSync(new URL('./ChartAnalysisPanel.tsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
const exported = ast.program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'ChartAnalysisPanel')
assert.ok(exported?.type === 'ExportNamedDeclaration' && exported.declaration?.type === 'FunctionDeclaration')
const component = exported.declaration
const renderReturn = component.body.body.at(-1)
assert.ok(renderReturn?.type === 'ReturnStatement')
const logic = stripTypeScriptTypes(`${source.slice(component.start!, renderReturn.start!)}return { send } }`)

test('mounting failed or stopped analysis never schedules recovery; retry requires an explicit send', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  for (const failure of ['missing-key', '401', '429', 'offline', 'stopped']) {
    let retries = 0, analyses = 0
    const cleanups: (() => void)[] = []
    const environment = {
      window: { setTimeout, clearTimeout },
      chartAnalysis: { retry() { retries++ } },
      useState: (initial: unknown) => [initial, () => {}],
      useRef: (initial: unknown) => ({ current: initial }),
      useEffect(setup: () => void | (() => void)) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) },
    }
    const render = new Function(...Object.keys(environment), `${logic}\nreturn ChartAnalysisPanel`)(...Object.values(environment)) as (props: {
      instId: string; session: AnalysisSession; ready: boolean; onNew: () => void; onClose: () => void
    }) => { send(): void }
    const hasImage = failure !== 'missing-key'
    const stopped = failure === 'stopped'
    const session: AnalysisSession = {
      instId: 'BTC', direction: 'long', model: 'fixture/model', capturedAt: 1, rangeLabel: 'fixture', draft: '',
      phase: stopped ? 'stopped' : 'error', error: stopped ? '' : failure,
      image: hasImage ? { imageDataURL: 'data:image/png;base64,AA==', width: 1, height: 1 } : null,
      turns: hasImage ? [{ id: 'turn-1', question: 'Question', text: '', status: stopped ? 'stopped' : 'error', error: stopped ? '' : failure }] : [],
    }
    const panel = render({ instId: 'BTC', session, ready: true, onNew() { analyses++ }, onClose() {} })
    context.mock.timers.tick(300_000)
    assert.equal(retries, 0, failure)
    assert.equal(analyses, 0, failure)
    panel.send()
    assert.equal(retries, hasImage ? 1 : 0, failure)
    context.mock.timers.tick(300_000)
    assert.equal(retries, hasImage ? 1 : 0, failure)
    cleanups.forEach(cleanup => cleanup())
  }
})
