import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { operationRecordingRequested } from '../../electron/services/operation-policy.js'

test('recording requires a sandbox or explicit diagnostic request, with an explicit off control', () => {
  assert.equal(operationRecordingRequested({}), false)
  assert.equal(operationRecordingRequested({ PERPETUAL_SWAP_TEST_UI: 'background' }), false)
  for (const flag of ['PERPETUAL_SWAP_OPERATION_TRACE', 'PERPETUAL_SWAP_GPU_TRACE', 'PERPETUAL_SWAP_SANDBOX', 'PERPETUAL_SWAP_E2E']) {
    assert.equal(operationRecordingRequested({ [flag]: '1' }), true)
    assert.equal(operationRecordingRequested({ [flag]: '1', PERPETUAL_SWAP_OPERATION_TRACE: '0' }), false)
  }
  assert.equal(operationRecordingRequested({ PERPETUAL_SWAP_OPERATION_DIR: '/explicit/diagnostics' }), true)
  assert.equal(operationRecordingRequested({ PERPETUAL_SWAP_OPERATION_DIR: '/explicit/diagnostics', PERPETUAL_SWAP_OPERATION_TRACE: '0' }), false)
})

test('explicit diagnostics record native SQLite work in a fresh runtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'explicit-operation-recording-'))
  const runtime = new URL('../../electron/services/operation-runtime.js', import.meta.url).href
  const operations = new URL('../../electron/services/operations.js', import.meta.url).href
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import sqlite from 'node:sqlite'
      const runtime = await import(${JSON.stringify(runtime)})
      const { attachOperationSink } = await import(${JSON.stringify(operations)})
      const recording = runtime.initializeOperationRecording(), events = []
      attachOperationSink(event => events.push(event))
      const database = new sqlite.DatabaseSync(':memory:')
      database.exec('CREATE TABLE candles (close INTEGER); INSERT INTO candles VALUES (101)')
      assert.equal(database.prepare('SELECT close FROM candles').get().close, 101)
      database.close()
      await runtime.closeOperationRecording()
      assert.ok(recording.enabledHooks.includes('sqlite'))
      for (const name of ['sqlite.open', 'sqlite.exec', 'sqlite.get', 'sqlite.close']) assert.ok(events.some(event => event.name === name), name)
      const health = recording.health()
      assert.equal(health.pending, 0)
      assert.equal(health.failed, 0)
      assert.equal(health.closed, true)
      assert.equal(health.persisted, health.recorded)
    `], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '',
      PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_TRACE: '1',
      PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT: '' } })
    assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('disabled runtime and workers skip clocks, metadata and trace envelopes while preserving results and failures', t => {
  const directory = mkdtempSync(join(tmpdir(), 'disabled-operation-recording-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const moduleURL = file => new URL(`../../electron/services/${file}`, import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { once } from 'node:events'
    const perf = globalThis.performance
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: new Proxy(perf, {
      get(target, key) {
        if (key === 'now' || key === 'timeOrigin') throw new Error('Disabled recording read a tracing clock')
        return Reflect.get(target, key, target)
      }
    }) })
    process.threadCpuUsage = process.cpuUsage = () => { throw new Error('Disabled recording sampled CPU') }
    const api = await import(${JSON.stringify(moduleURL('operations.js'))})
    const runtime = await import(${JSON.stringify(moduleURL('operation-runtime.js'))})
    const workers = await import(${JSON.stringify(moduleURL('worker-operations.js'))})
    assert.equal(runtime.initializeOperationRecording({ directory: '/must-not-be-created/diagnostics' }), undefined)
    assert.equal(api.hasOperationRecording(), false)
    assert.equal(api.hasOperationPropagation(), false)
    api.configureOperationContext({}, () => { throw new Error('Disabled recording called its CPU clock') })
    assert.equal(api.readOperationCPUTime(), undefined)
    const spec = new Proxy({}, { get() { throw new Error('Disabled recording inspected metadata') } })
    const value = {}, failure = new Error('domain failure')
    assert.equal(api.measureOperation(spec, () => value), value)
    const promise = Promise.resolve(value)
    assert.equal(api.measureOperation(spec, () => promise), promise)
    assert.throws(() => api.measureOperation(spec, () => { throw failure }), error => error === failure)
    const target = { add(value) { return this.offset + value }, offset: 7 }
    api.hookOperationMethods(target, { add() { throw new Error('Disabled recording built metadata') } })
    assert.equal(target.add(3), 10)
    const source =
      'import { parentPort } from "node:worker_threads";'+
      'import { onOperationMessage } from '+JSON.stringify(${JSON.stringify(moduleURL('worker-operations.js'))})+';'+
      'import { hasOperationRecording, hasOperationPropagation } from '+JSON.stringify(${JSON.stringify(moduleURL('operations.js'))})+';'+
      'onOperationMessage(parentPort,"echo", message => ({message, recording:hasOperationRecording(), propagation:hasOperationPropagation()}));'
    const worker = workers.createOperationWorker(new URL('data:text/javascript,' + encodeURIComponent(source)), {}, 'off-echo')
    try {
      const response = once(worker, 'message')
      const result = new Promise((resolve, reject) => {
        const request = workers.createWorkerRequest('off-echo', 'echo', resolve, reject)
        request.dispatch(worker, { id: 1, payload: [1, 'market data'] })
        response.then(([message]) => request.resolve(message), request.reject)
      })
      assert.deepEqual(await result, { message: { id: 1, payload: [1, 'market data'] }, recording: false, propagation: false })
      const { stopOperationWorker } = await import(${JSON.stringify(moduleURL('operation-worker.js'))})
      await stopOperationWorker(worker, 'off-echo')
    } finally { await worker.terminate() }
  `], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '',
    PERPETUAL_SWAP_OPERATION_DIR: join(directory, 'must-not-be-created'), PERPETUAL_SWAP_OPERATION_TRACE: '0',
    PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_PARENT_OPERATION_CONTEXT: 'not-json' } })
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`)
})
