import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { operationReportHasFailures, summarizeOperations } from '../../scripts/operation-report.mjs'

const event = (overrides = {}) => ({ schemaVersion: 1, id: 'execution:1', sessionId: 'session', executionId: 'execution',
  category: 'cpu', name: 'indicators.replay', resource: 'BTC-USDT-SWAP', startedAt: 1_700_000_000_000, durationMS: 4, status: 'ok', attributes: {}, ...overrides })

test('offline reports retain cost and failure totals with bounded resource cardinality and damaged traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-'))
  try {
    const records = [event(), event({ id: 'execution:2', category: 'database', name: 'sqlite.query', durationMS: 8, status: 'error' }),
      ...Array.from({ length: 20 }, (_, index) => event({ id: `execution:${index + 3}`, resource: `contract-${index}`, durationMS: 1 })),
      event({ id: 'execution:23', category: 'network', name: 'http.request', durationMS: 16, status: 'cancelled', attributes: { incomplete: true } })]
    await writeFile(join(directory, 'one.jsonl'), records.map(value => JSON.stringify(value)).join('\n') + '\ninvalid\n' + 'x'.repeat(4000) + '\n' + JSON.stringify(event({ id: 'execution:24', category: 'gpu', durationMS: 32 })))
    await writeFile(join(directory, 'one.health.json'), JSON.stringify({ recorded: 24, persisted: 23, failed: 2, pending: 1, closed: true }))
    const report = await summarizeOperations(directory, { maxGroups: 2, maxLineBytes: 1000, slowestLimit: 3 })
    assert.equal(report.totals.count, 24)
    assert.equal(report.totals.totalMS, 80)
    assert.equal(report.totals.errors, 1)
    assert.equal(report.totals.cancelled, 1)
    assert.equal(report.categories.find(value => value.category === 'gpu').maxMS, 32)
    assert.equal(report.groups.length, 5, 'Two named groups and one overflow group per represented category.')
    assert.equal(report.groups.reduce((sum, value) => sum + value.count, 0), 24)
    assert.equal(report.operations.reduce((sum, value) => sum + value.count, 0), 24)
    assert.equal(report.operations.find(value => value.category === 'cpu').count, 21, 'Resource overflow must retain the complete per-operation cost.')
    assert.equal(report.operations.find(value => value.name === 'http.request').totalMS, 16)
    assert.equal(report.diagnostics.groupedOverflow, 22)
    assert.equal(report.diagnostics.malformed, 1)
    assert.equal(report.diagnostics.oversized, 1)
    assert.equal(report.diagnostics.unterminated, 1)
    assert.equal(report.diagnostics.incomplete, 1)
    assert.equal(report.diagnostics.persistenceFailures, 2)
    assert.equal(report.diagnostics.pendingRecords, 1)
    assert.equal(report.diagnostics.recorderCountMismatches, 1)
    assert.equal(operationReportHasFailures(report), true)
    assert.deepEqual(report.slowest.map(value => value.durationMS), [32, 16, 8])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sandbox runs isolate app and temporary data, persist records, and preserve a failing command exit', async () => {
  const output = await mkdtemp(join(tmpdir(), 'operation-sandbox-'))
  const runner = fileURLToPath(new URL('../../scripts/test-sandbox.mjs', import.meta.url))
  const recorder = new URL('../../electron/services/operations.js', import.meta.url).href
  const run = (exitCode, corrupt = false) => new Promise((resolve, reject) => {
    const source = `import { writeFile, mkdir } from 'node:fs/promises'; import { tmpdir } from 'node:os';
      import { join } from 'node:path'; import { measureOperation } from ${JSON.stringify(recorder)};
      await mkdir(process.env.PERPETUAL_SWAP_USER_DATA, { recursive: true });
      await writeFile(join(tmpdir(), 'isolation.json'), JSON.stringify({ temporary: tmpdir(), userData: process.env.PERPETUAL_SWAP_USER_DATA, sandbox: process.env.PERPETUAL_SWAP_SANDBOX, network: process.env.PERPETUAL_SWAP_ALLOW_NETWORK }));
      measureOperation({ category: 'cpu', name: 'sandbox.fixture', attributes: { count: 1 } }, () => 42);
      if (${corrupt}) await writeFile(join(process.env.PERPETUAL_SWAP_OPERATION_DIR, 'corrupt.jsonl'), 'broken-record\\n');
      process.exitCode = ${exitCode};`
    const child = spawn(process.execPath, [runner, 'command', '--output', output, '--', process.execPath, '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16_384) })
    child.on('error', reject)
    child.on('close', code => resolve({ code, diagnostics }))
  })
  try {
    assert.equal((await run(0)).code, 0)
    const failed = await run(23)
    assert.equal(failed.code, 23, failed.diagnostics)
    const corrupt = await run(0, true)
    assert.equal(corrupt.code, 1, 'A passing command with an invalid recording must fail sandbox validation.')
    const directories = (await readdir(output)).sort()
    assert.equal(directories.length, 3)
    const manifests = []
    for (const entry of directories) {
      const directory = join(output, entry), manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      manifests.push(manifest)
      const isolation = JSON.parse(await readFile(join(directory, 'tmp/isolation.json'), 'utf8'))
      assert.equal(isolation.temporary, join(directory, 'tmp'))
      assert.equal(isolation.userData, join(directory, 'user-data'))
      assert.equal(isolation.sandbox, '1')
      assert.equal(isolation.network, '0')
      assert.equal(manifest.environment.network, 'loopback and injected fixtures only')
      assert.equal(manifest.recordedOperations, 1)
      const report = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
      assert.equal(report.groups[0].name, 'sandbox.fixture')
      assert.equal(report.diagnostics.persistenceFailures, 0)
      assert.equal(report.diagnostics.pendingRecords, 0)
      assert.equal(operationReportHasFailures(report), manifest.outcome.exitCode === 1)
    }
    assert.deepEqual(manifests.map(value => value.outcome.exitCode).sort((left, right) => left - right), [0, 1, 23])
    assert.notEqual(manifests[0].environment.userDataDirectory, manifests[1].environment.userDataDirectory)
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('reports expose killed executions, missing events and incomplete opt-in native GPU traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-interrupted-'))
  try {
    await writeFile(join(directory, 'worker.jsonl'), `${JSON.stringify(event())}\n`)
    await writeFile(join(directory, 'worker.health.json'), JSON.stringify({ recorded: 2, persisted: 2, failed: 0, pending: 0, closed: false }))
    await writeFile(join(directory, 'chromium-disabled.status.json'), JSON.stringify({ enabled: false, complete: false }))
    await writeFile(join(directory, 'chromium-truncated.status.json'), JSON.stringify({ enabled: true, complete: false, file: 'chromium-truncated.trace.json', bufferUsage: { percentage: 1 } }))
    const report = await summarizeOperations(directory)
    assert.equal(report.diagnostics.unclosedExecutions, 1)
    assert.equal(report.diagnostics.recorderCountMismatches, 1)
    assert.equal(report.diagnostics.missingRecords, 1)
    assert.equal(report.diagnostics.nativeGpuStatusFiles, 2)
    assert.equal(report.diagnostics.incompleteNativeGpuTraces, 1)
    assert.equal(report.nativeTraces.length, 2)
    assert.equal(operationReportHasFailures(report), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('report reads the recording directory without inspecting application database trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-layout-'))
  try {
    await mkdir(join(directory, 'operations'))
    await mkdir(join(directory, 'user-data'))
    await writeFile(join(directory, 'operations/worker.jsonl'), `${JSON.stringify(event())}\n`)
    await writeFile(join(directory, 'user-data/unrelated.jsonl'), 'not an operation recording\n')
    const report = await summarizeOperations(directory)
    assert.equal(report.totals.count, 1)
    assert.equal(report.diagnostics.malformed, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
