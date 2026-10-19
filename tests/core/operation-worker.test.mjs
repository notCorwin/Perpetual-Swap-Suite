import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopOperationWorker } from '../../electron/services/operation-worker.js'
import { attachOperationSink } from '../../electron/services/operations.js'
import { PreparedChartPipeline } from '../../electron/services/prepared-chart-service.js'

test('worker shutdown persists its final calculation before acknowledging and terminating', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-worker-'))
  const environment = { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_ROLE: 'prepared-chart' }
  delete environment.PERPETUAL_SWAP_OPERATION_PARTICIPANT
  const worker = new Worker(new URL('../../electron/services/prepared-chart-worker.js', import.meta.url), {
    env: environment,
  })
  try {
    const response = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    worker.postMessage({ id: 1, intervalMS: 300_000, operationContext: { traceId: 'fixture-trace', parentId: 'fixture-admission' },
      operationDispatchedAt: performance.timeOrigin + performance.now(),
      candles: Array.from({ length: 220 }, (_, index) => ({ timestamp: index * 300_000, open: 100, close: 100, high: 101, low: 99, baseVolume: 1, confirmed: true })) })
    const result = await response
    assert.equal(result.bars.length, 220)
    await stopOperationWorker(worker, 'prepared-chart-test')
    const files = await readdir(directory)
    const health = JSON.parse(await readFile(join(directory, files.find(file => file.endsWith('.health.json'))), 'utf8'))
    assert.equal(health.closed, true)
    assert.equal(health.failed, 0)
    assert.equal(health.pending, 0)
    assert.ok(health.recorded >= 6)
    assert.equal(health.persisted, health.recorded)
    const events = (await readFile(join(directory, files.find(file => file.endsWith('.jsonl'))), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const replay = events.find(event => event.name === 'indicators.replay' && event.phase === 'end')
    assert.equal(replay.attributes.candles, 220)
    assert.equal(replay.schemaVersion, 2)
    assert.equal(replay.traceId, 'fixture-trace')
    assert.ok(replay.parentId)
    assert.equal(events.filter(event => event.phase === 'start').length, events.filter(event => event.phase === 'end').length)
    assert.ok(events.some(event => event.name === 'worker.execute' && event.phase === 'end'))
    assert.ok(events.some(event => event.name === 'worker.transport.queue' && event.phase === 'end' && event.durationMS >= 0))
  } finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }) }
})

test('unresponsive worker shutdown reports incomplete capture before bounded termination', async () => {
  // An intentional fake recorder failure belongs to the fixture process. It
  // must not mark the enclosing, healthy test sandbox as having lost records.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { EventEmitter } from 'node:events'
    import { stopOperationWorker } from ${JSON.stringify(new URL('../../electron/services/operation-worker.js', import.meta.url).href)}
    import { attachOperationSink } from ${JSON.stringify(new URL('../../electron/services/operations.js', import.meta.url).href)}
    const events = []
    attachOperationSink(event => events.push(event))
    class StalledWorker extends EventEmitter {
      threadId = 7
      terminated = false
      ref() {}
      postMessage() {}
      async terminate() { this.terminated = true }
    }
    const worker = new StalledWorker()
    await stopOperationWorker(worker, 'stalled-fixture', 5)
    assert.equal(worker.terminated, true)
    assert.equal(worker.listenerCount('message'), 0)
    assert.equal(events[0].name, 'diagnostics.worker.flush')
    assert.equal(events[0].status, 'error')
    assert.equal(events[0].attributes.incomplete, true)
    assert.equal(events[0].attributes.reason, 'flush-timeout')
  `], { encoding: 'utf8', env: { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: '' } })
  assert.equal(result.status, 0, result.stderr)
})

test('repeated chart-pipeline disposal shares one acknowledged worker shutdown', async () => {
  const pipeline = new PreparedChartPipeline({ store: {}, history: {}, normalize: value => value, revision: () => 0, instrument: () => null })
  const events = []
  const unsubscribe = attachOperationSink(event => events.push(event))
  try {
    await pipeline.calculate([{ timestamp: 0, open: 100, close: 100, high: 101, low: 99, baseVolume: 1, confirmed: true }], 300_000)
    const closing = pipeline.dispose()
    assert.equal(pipeline.dispose(), closing)
    await closing
    await pipeline.dispose()
    const shutdowns = events.filter(event => event.name === 'diagnostics.worker.flush')
    assert.equal(shutdowns.length, 1)
    assert.equal(shutdowns[0].status, 'ok')
    assert.equal(shutdowns[0].attributes.incomplete, false)
  } finally { unsubscribe(); await pipeline.dispose() }
})
