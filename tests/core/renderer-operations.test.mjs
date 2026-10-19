import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRendererOperationReceiver } from '../../electron/services/renderer-operations.js'
import { attachOperationJournalSink, registerOperationImportSource } from '../../electron/services/operations.js'

test('renderer batches preserve source IDs and only acknowledge durable, replay-safe contiguous records', async () => {
  if (process.env.PERPETUAL_SWAP_RECEIVER_FIXTURE !== '1') {
    const environment = { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: '', PERPETUAL_SWAP_RECEIVER_FIXTURE: '1' }
    delete environment.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8',
      env: environment })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.ok(result.stdout.includes('renderer batches preserve source IDs'), result.stdout)
    return
  }
  let registrations = 0, persistenceFailure = true, release
  const persisted = [], receiver = createRendererOperationReceiver({
    register: role => { assert.equal(role, 'renderer'); registrations++; return { id: 'fixture-participant' } },
    claim: (_participant, executionId) => { registerOperationImportSource(executionId, 'fixture-session'); return { executionId, sessionId: 'fixture-session' } },
    flush: async () => {
      if (persistenceFailure) throw new Error('Fixture disk failure')
      await new Promise(resolve => { release = resolve })
    },
  })
  const identity = receiver.initialize(7, 'fixture-nonce')
  assert.deepEqual(receiver.initialize(7, 'fixture-nonce'), identity)
  assert.equal(registrations, 1)
  const unsubscribe = attachOperationJournalSink(event => { if (event.executionId === identity.executionId) persisted.push(event) })
  const event = (sequence, phase) => ({ schemaVersion: 2, ...identity, id: `${identity.executionId}:1`, sequence,
    traceId: 'fixture-trace', parentId: 'fixture-parent', category: 'cpu', name: 'chart.geometry', startedAt: 1_000,
    phase, status: phase === 'start' ? 'running' : 'ok', durationMS: phase === 'start' ? 0 : 5, attributes: { inputRows: 96 } })
  const batch = { executionId: identity.executionId, batchId: 'fixture-batch', firstSequence: 1, events: [event(1, 'start'), event(2, 'end')] }
  try {
    await assert.rejects(receiver.receive(7, batch), /Fixture disk failure/)
    assert.equal(persisted.length, 2)
    persistenceFailure = false
    let acknowledged = false
    const retry = receiver.receive(7, batch).then(value => { acknowledged = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(acknowledged, false)
    assert.equal(persisted.length, 2, 'The lost-ACK retry must not journal duplicate lifecycle records.')
    release()
    assert.deepEqual(await retry, { batchId: 'fixture-batch', lastSequence: 2 })
    assert.deepEqual(persisted.map(value => [value.id, value.traceId, value.parentId]), batch.events.map(value => [value.id, value.traceId, value.parentId]))
    assert.throws(() => receiver.receive(8, batch), /Unknown renderer/)
    await assert.rejects(receiver.receive(7, { ...batch, batchId: 'gap', firstSequence: 4, events: [event(4, 'start')] }), /out of sequence/)
    await assert.rejects(receiver.receive(7, { ...batch, events: batch.events.map(value => ({ ...value, name: 'changed' })) }), /different records/)
  } finally { unsubscribe() }
})
