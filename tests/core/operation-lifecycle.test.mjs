import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { attachOperationJournalSink, attachOperationSink, beginOperation, measureOperation, getOperationContext,
  importOperationEvents, registerOperationImportSource } from '../../electron/services/operations.js'
import { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant,
  closeExternalOperationSource } from '../../electron/services/operation-runtime.js'
import { summarizeOperations, operationReportHasFailures } from '../../scripts/operation-report.mjs'

test('starts are observable before completion and concurrent asynchronous tasks retain separate ancestry', async t => {
  const journal = [], events = []
  t.after(attachOperationJournalSink(event => { if (event.name.startsWith('core.')) journal.push(event) }))
  t.after(attachOperationSink(event => { if (event.name.startsWith('core.')) events.push(event) }))
  const pending = beginOperation({ category: 'cpu', name: 'core.pending' })
  assert.equal(journal.length, 1)
  assert.equal(journal[0].phase, 'start')
  assert.equal(events.length, 0)
  pending.end()
  assert.equal(journal[1].id, journal[0].id)
  assert.equal(journal[1].phase, 'end')
  await Promise.all(['a', 'b'].map(key => measureOperation({ category: 'cpu', name: `core.parent.${key}` }, async () => {
    const before = getOperationContext()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(getOperationContext(), before)
    return measureOperation({ category: 'cpu', name: `core.child.${key}` }, () => 42)
  })))
  for (const key of ['a', 'b']) {
    const parent = events.find(event => event.name === `core.parent.${key}`), child = events.find(event => event.name === `core.child.${key}`)
    assert.equal(child.parentId, parent.id)
    assert.equal(child.traceId, parent.traceId)
    assert.equal(parent.cpuTimeMS, undefined, 'An async wall-time span must not attribute unrelated thread CPU time.')
  }
  assert.notEqual(events.find(event => event.name === 'core.parent.a').traceId, events.find(event => event.name === 'core.parent.b').traceId)
})

test('external batches retain source identity, reject gaps and deduplicate retries', async t => {
  const executionId = `renderer-test-${process.pid}`, recording = initializeOperationRecording()
  let sessionId = 'operation-test'
  if (recording) {
    const participant = registerOperationParticipant('renderer')
    sessionId = claimExternalOperationParticipant(participant.id, executionId).sessionId
    t.after(() => closeExternalOperationSource(executionId))
  } else registerOperationImportSource(executionId, sessionId)
  const entries = []
  t.after(attachOperationJournalSink(event => { if (event.executionId === executionId) entries.push(event) }))
  const base = { schemaVersion: 2, sessionId, executionId, id: `${executionId}:1`, traceId: `${executionId}:1`,
    category: 'cpu', name: 'core.external', startedAt: Date.now(), attributes: {} }
  const batch = [{ ...base, phase: 'start', sequence: 1, status: 'running', durationMS: 0 },
    { ...base, phase: 'end', sequence: 2, status: 'ok', durationMS: 3 }]
  assert.deepEqual(importOperationEvents(batch), { accepted: 2, duplicates: 0, rejected: 0, lastSequence: 2 })
  assert.deepEqual(importOperationEvents(batch), { accepted: 0, duplicates: 2, rejected: 0, lastSequence: 2 })
  assert.equal(importOperationEvents([{ ...batch[1], sequence: 4 }]).rejected, 1)
  assert.equal(entries.length, 2)
  assert.ok(entries.every(event => event.executionId === executionId && event.id === base.id))
  const next = { ...base, id: `${executionId}:2`, traceId: `${executionId}:2` }
  assert.equal(importOperationEvents([{ ...next, phase: 'start', sequence: 3, status: 'running', durationMS: 1 }]).rejected, 1)
  assert.equal(entries.length, 2, 'A nonzero start duration is rejected before reaching a journal sink.')
  assert.deepEqual(importOperationEvents([
    { ...next, phase: 'start', sequence: 3, status: 'running', durationMS: 0 },
    { ...next, phase: 'end', sequence: 4, status: 'ok', durationMS: 1 },
  ]), { accepted: 2, duplicates: 0, rejected: 0, lastSequence: 4 }, 'A rejected start cannot advance the acknowledged source sequence.')
})

test('a killed execution leaves a durable named unfinished operation', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-crash-start-'))
  try {
    const source = `import { initializeOperationRecording } from ${JSON.stringify(new URL('../../electron/services/operation-runtime.js', import.meta.url).href)};
      import { beginOperation } from ${JSON.stringify(new URL('../../electron/services/operations.js', import.meta.url).href)};
      const recording = initializeOperationRecording();
      beginOperation({ category: 'cpu', name: 'core.interrupted-computation' });
      await recording.flush(); process.kill(process.pid, 'SIGKILL');`
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env,
        PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_OPERATION_SESSION: 'crash-start' }, stdio: ['ignore', 'ignore', 'pipe'] })
      let diagnostics = ''
      child.stderr.on('data', chunk => { diagnostics += chunk })
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, diagnostics }))
    })
    assert.equal(result.signal, 'SIGKILL', result.diagnostics)
    const report = await summarizeOperations(directory)
    assert.equal(operationReportHasFailures(report), true)
    assert.ok(JSON.stringify(report).includes('core.interrupted-computation'))
    assert.ok(report.abandonedOperations.some(value => value.name === 'core.interrupted-computation' && value.count === 1))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a long-running execution checkpoints an unfinished operation without an explicit flush', { timeout: 12_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-automatic-checkpoint-'))
  let child
  try {
    const source = `import ${JSON.stringify(new URL('../../electron/services/operation-runtime.js', import.meta.url).href)};
      import { beginOperation } from ${JSON.stringify(new URL('../../electron/services/operations.js', import.meta.url).href)};
      beginOperation({ category: 'cpu', name: 'core.automatically-checkpointed' });
      setInterval(() => {}, 1000);`
    child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env,
      PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_OPERATION_SESSION: 'automatic-checkpoint' },
    stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    const deadline = Date.now() + 9000
    let health
    while (Date.now() < deadline) {
      const file = (await readdir(directory)).find(file => file.endsWith('.health.json') && !file.startsWith('.'))
      if (file) health = JSON.parse(await readFile(join(directory, file), 'utf8'))
      if (health?.durableRecords > 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(health?.durableRecords > 0, 'Periodic persistence must not depend on renderer activity or normal shutdown.')
    assert.ok(health.lastDurableAt >= health.updatedAt - 1000)
    child.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    const report = await summarizeOperations(directory)
    assert.equal(operationReportHasFailures(report), true)
    assert.ok(report.abandonedOperations.some(value => value.name === 'core.automatically-checkpointed'))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})
