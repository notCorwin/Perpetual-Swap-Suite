import assert from 'node:assert/strict'
import test from 'node:test'
import { finishAcceptanceResources } from '../support/acceptance-resources.mjs'

test('a failed window restore still drains witnesses, removes probes, closes Electron and removes its profile', async () => {
  const calls = [], restoreFailure = new Error('Window restore failed')
  await assert.rejects(finishAcceptanceResources([
    async () => { calls.push('restore'); throw restoreFailure },
    async () => { calls.push('witness') },
    async () => { calls.push('probe') },
    async () => { calls.push('close') },
    async () => { calls.push('profile') },
  ]), error => error === restoreFailure)
  assert.deepEqual(calls, ['restore', 'witness', 'probe', 'close', 'profile'])
})

test('simultaneous witness and diagnostic failures are both retained after all cleanup completes', async () => {
  const first = new Error('Witness collection failed'), second = new Error('Diagnostic finalization failed')
  const calls = []
  await assert.rejects(finishAcceptanceResources([
    async () => { calls.push('witness'); throw first },
    async () => { calls.push('diagnostics'); throw second },
    async () => { calls.push('close') },
  ]), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.cause, first)
    assert.deepEqual(error.errors, [first, second])
    return true
  })
  assert.deepEqual(calls, ['witness', 'diagnostics', 'close'])
})
