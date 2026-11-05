import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyV8Stack, summarizeV8, summarizeTrace } from './profile-analysis.mjs'

test('business work below a telemetry wrapper is not charged to telemetry', () => {
  const wrapper = { functionName: 'runWithOperationContext', url: 'file:///operations.js' }
  assert.equal(classifyV8Stack([wrapper, { functionName: 'pendingSourceRanges', url: 'file:///prepared-chart-service.js' }]), 'application-or-runtime-js')
  assert.equal(classifyV8Stack([wrapper]), 'telemetry-direct')
  assert.equal(classifyV8Stack([{ functionName: 'JSONParse', url: '' }, { functionName: '0x123abc', url: '' }]), 'unresolved-native')
})

test('out-of-order V8 timestamps cannot inflate the observed time window', () => {
  const profile = { startTime: 100, endTime: 120, samples: [1, 2, 3], timeDeltas: [10, -5, 10], nodes: [
    { id: 1, callFrame: { functionName: 'JSONParse', url: '' } },
    { id: 2, callFrame: { functionName: 'pendingSourceRanges', url: 'file:///prepared-chart-service.js' } },
    { id: 3, callFrame: { functionName: '(idle)', url: '' } },
  ] }
  const result = summarizeV8(profile)
  assert.equal(result.negativeDeltas, 1)
  assert.equal(result.sampledWindowMS, .015)
  assert.deepEqual(result.categories, { 'application-or-runtime-js': .005, serialization: .005, idle: .005 })
})

test('nested timeline intervals are exclusive and other threads are excluded', () => {
  const result = summarizeTrace({ traceEvents: [
    { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
    { ph: 'X', pid: 1, tid: 2, name: 'FunctionCall', ts: 0, dur: 100 },
    { ph: 'X', pid: 1, tid: 2, name: 'Layout', ts: 10, dur: 20 },
    { ph: 'X', pid: 1, tid: 2, name: 'Paint', ts: 40, dur: 10 },
    { ph: 'X', pid: 1, tid: 3, name: 'Layout', ts: 0, dur: 100 },
  ] }, 1)
  assert.deepEqual(result.exclusiveInstrumentedWallMS, { javascript: .07, 'layout-style': .02, 'svg-or-other-paint': .01 })
})
