import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { operationReportHasFailures, operationReportMarkdown, summarizeOperations } from '../../scripts/operation-report.mjs'
import { sandboxCoverage } from '../../scripts/test-sandbox.mjs'

const event = (overrides = {}) => ({ schemaVersion: 2, phase: 'end', id: 'execution:1', traceId: 'trace:1', sessionId: 'session', executionId: 'execution',
  category: 'cpu', name: 'indicators.replay', resource: 'BTC-USDT-SWAP', startedAt: 1_700_000_000_000, durationMS: 4, status: 'ok', attributes: {}, ...overrides })
const lifecycle = events => events.flatMap((value, index) => [
  { ...value, phase: 'start', sequence: index * 2 + 1, durationMS: 0, status: 'running', cpuTimeMS: undefined },
  { ...value, sequence: index * 2 + 2 },
])
async function recording(directory, records, { health = {}, raw = false, ending = '\n', suffix = '' } = {}) {
  const journal = raw ? records : lifecycle(records)
  await writeFile(join(directory, 'execution.jsonl'), journal.map(value => JSON.stringify(value)).join('\n') + ending + suffix)
  await writeFile(join(directory, 'execution.health.json'), JSON.stringify({ schemaVersion: 2, executionId: 'execution', participantId: 'participant-execution', role: 'fixture', enabledHooks: ['fixture.cpu'],
    recorded: journal.length, recordedOperations: journal.filter(value => value.phase === 'end').length, persisted: journal.length, failed: 0, pending: 0, closed: true, ...health }))
  await writeFile(join(directory, 'participant-execution.participant.json'), JSON.stringify({ schemaVersion: 2, id: 'participant-execution', executionId: 'execution', role: 'fixture', status: 'ready', registeredAt: 1_700_000_000_000 }))
}

test('offline reports retain completed costs and work counters with bounded cardinality and damaged traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-'))
  try {
    const records = [event({ cpuTimeMS: 2 }), event({ id: 'execution:2', category: 'database', name: 'sqlite.query', durationMS: 8, status: 'error', attributes: { calls: 7, queryCount: 3, rows: 5, changes: 4, bytes: 12 } }),
      ...Array.from({ length: 20 }, (_, index) => event({ id: `execution:${index + 3}`, resource: `contract-${index}`, durationMS: 1 })),
      event({ id: 'execution:23', category: 'network', name: 'http.request', durationMS: 16, status: 'cancelled', attributes: { incomplete: true, sentBytes: 5, receivedBytes: 20 } }),
      event({ id: 'execution:24', category: 'gpu', name: 'gpu.process-sample', durationMS: 32, attributes: { residentKB: 512, cpuPercent: 4 } })]
    await recording(directory, records, { ending: '', health: { persisted: 47, failed: 2, pending: 1 } })
    await writeFile(join(directory, 'damaged.jsonl'), 'invalid\n' + 'x'.repeat(4000) + '\n')
    const report = await summarizeOperations(directory, { maxGroups: 2, maxLineBytes: 1000, slowestLimit: 3 })
    assert.equal(report.schemaVersion, 2)
    assert.equal(report.journalRecords, 48)
    assert.equal(report.totals.count, 24)
    assert.equal(report.totals.totalMS, 80)
    assert.equal(report.totals.cpuTimeMS, 2)
    assert.deepEqual(report.totals.work, { calls: 7, queryCount: 3, rows: 5, changes: 4, bytes: 12, sentBytes: 5, receivedBytes: 20 })
    assert.equal(report.categories.find(value => value.category === 'database').work.calls, 7)
    const markdown = operationReportMarkdown(report)
    assert.match(markdown, /\| Calls \| Query batches \|/)
    assert.match(markdown, /\| database \| sqlite\.query \| 1 \| 8 \| 7 \| 3 \| 5 \| 4 \| 12 \| 0 \| 0 \|/)
    assert.deepEqual(report.totals.peaks, { residentKB: 512, cpuPercent: 4 })
    assert.equal(report.totals.errors, 1)
    assert.equal(report.totals.cancelled, 1)
    assert.equal(report.groups.length, 5)
    assert.equal(report.groups.reduce((sum, value) => sum + value.count, 0), 24)
    assert.equal(report.operations.find(value => value.category === 'cpu').count, 21)
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

test('lifecycle validation detects sequence gaps, duplicated ends, unmatched starts and bounded-state overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-lifecycle-'))
  try {
    const first = lifecycle([event({ name: 'expensive.abandoned' })])[0]
    const second = lifecycle([event({ id: 'execution:2', name: 'database.query', category: 'database' })])
    const third = lifecycle([event({ id: 'execution:3', name: 'network.pending', category: 'network' })])[0]
    await recording(directory, [first, { ...second[0], sequence: 3 }, { ...second[1], sequence: 3 }, { ...second[1], sequence: 4 }, { ...third, sequence: 5 }], { raw: true })
    const report = await summarizeOperations(directory)
    assert.equal(report.diagnostics.sequenceGaps, 1)
    assert.equal(report.diagnostics.duplicateSequences, 1)
    assert.equal(report.diagnostics.duplicateOperationIds, 1)
    assert.equal(report.diagnostics.unclosedOperations, 2)
    assert.deepEqual(report.abandonedOperations.map(value => value.name).sort(), ['expensive.abandoned', 'network.pending'])
    assert.equal(report.slowest[0].traceId, 'trace:1')
    assert.equal(operationReportHasFailures(report), true)
    const bounded = await summarizeOperations(directory, { maxOpenOperations: 1 })
    assert.ok(bounded.diagnostics.lifecycleLimitReached > 0)
    assert.equal(operationReportHasFailures(bounded), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('coverage contracts reject empty recordings and missing roles/categories and expose missing registered children', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-coverage-'))
  try {
    const empty = await summarizeOperations(directory)
    assert.equal(empty.diagnostics.emptyRecording, 1)
    assert.equal(operationReportHasFailures(empty), true)
    assert.equal(operationReportHasFailures(await summarizeOperations(directory, { allowEmpty: true })), false)
    await recording(directory, [event()])
    const complete = await summarizeOperations(directory, { requireCategories: ['cpu'], requireRoles: ['fixture'] })
    assert.equal(operationReportHasFailures(complete), false)
    assert.deepEqual(complete.coverage.participants[0].enabledHooks, ['fixture.cpu'])
    const missing = await summarizeOperations(directory, { requireCategories: ['io', 'ipc'], requireRoles: ['database-reader'] })
    assert.deepEqual(missing.coverage.missingCategories, ['io', 'ipc'])
    assert.deepEqual(missing.coverage.missingRoles, ['database-reader'])
    assert.equal(operationReportHasFailures(missing), true)
    await writeFile(join(directory, 'registered.participant.json'), JSON.stringify({ schemaVersion: 2, id: 'registered', role: 'indicator-worker', status: 'registered' }))
    await writeFile(join(directory, 'missing.participant.json'), JSON.stringify({ schemaVersion: 2, id: 'missing', role: 'database-reader', status: 'ready', executionId: 'absent-execution' }))
    const absent = await summarizeOperations(directory)
    assert.equal(absent.diagnostics.unclaimedParticipants, 1)
    assert.equal(absent.diagnostics.missingParticipantHealth, 1)
    assert.equal(absent.diagnostics.missingParticipantJournals, 1)
    assert.equal(operationReportHasFailures(absent), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('standard suites reject incidental filesystem recording while custom I/O commands remain valid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-standard-coverage-'))
  try {
    await recording(directory, [event({ category: 'io', name: 'fs.readFileSync' })])
    for (const mode of ['core', 'e2e', 'foreground', 'all']) {
      const coverage = sandboxCoverage(mode)
      const report = await summarizeOperations(directory, coverage)
      assert.ok(report.coverage.substantiveOperations > 0)
      assert.ok(report.diagnostics.missingRequiredCategories > 0, mode)
      assert.ok(report.diagnostics.missingRequiredRoles > 0, mode)
      assert.ok(report.diagnostics.missingRequiredOperations > 0, mode)
      assert.equal(operationReportHasFailures(report), true, mode)
      assert.ok(coverage.requireOperations.includes('market.append'), mode)
      const extended = sandboxCoverage(mode, { allowEmpty: true, requireCategories: ['io'], requireRoles: ['extra-role'] })
      assert.ok(coverage.requireCategories.every(category => extended.requireCategories.includes(category)))
      assert.ok(coverage.requireRoles.every(role => extended.requireRoles.includes(role)))
      assert.ok(extended.requireRoles.includes('extra-role'))
      assert.equal(operationReportHasFailures(await summarizeOperations(directory, extended)), true, '--allow-empty cannot weaken standard suite requirements.')
    }
    assert.ok(sandboxCoverage('core').requireCategories.includes('network'))
    assert.ok(!sandboxCoverage('core').requireCategories.includes('gpu'))
    assert.ok(sandboxCoverage('e2e').requireOperations.includes('chart.capture'))
    assert.ok(!sandboxCoverage('foreground').requireOperations.includes('chart.capture'))
    assert.ok(sandboxCoverage('e2e').requireCategories.includes('network'))
    assert.ok(!sandboxCoverage('foreground').requireCategories.includes('network'))
    assert.ok(sandboxCoverage('e2e').requireOperations.some(value => value.name === 'fetch.request' && value.source === 'native'))
    assert.ok(sandboxCoverage('e2e').requireOperations.some(value => value.name === 'websocket.receive' && value.source === 'native'))
    const combined = sandboxCoverage('all')
    for (const mode of ['core', 'e2e']) for (const key of ['requireCategories', 'requireRoles', 'requireOperations']) {
      assert.ok(sandboxCoverage(mode)[key].every(value => combined[key].some(known => JSON.stringify(known) === JSON.stringify(value))), `${mode} ${key}`)
    }
    const custom = sandboxCoverage('command')
    assert.deepEqual(custom, { allowEmpty: false, requireCategories: [], requireRoles: [], requireOperations: [] })
    assert.equal(operationReportHasFailures(await summarizeOperations(directory, custom)), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native transport requirements reject injected traffic and failed native requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-native-coverage-'))
  const requirements = ['fetch.request', 'websocket.receive'].map(name => ({ name, source: 'native' }))
  try {
    await recording(directory, [
      event({ name: 'fetch.request', category: 'network', attributes: { source: 'injected' } }),
      event({ id: 'execution:2', name: 'websocket.receive', category: 'network', attributes: { source: 'injected' } }),
      event({ id: 'execution:3', name: 'fetch.request', category: 'network', status: 'error', attributes: { source: 'native' } }),
    ])
    const missing = await summarizeOperations(directory, { requireOperations: requirements })
    assert.deepEqual(missing.coverage.missingOperations, requirements)
    assert.equal(operationReportHasFailures(missing), true)
    assert.match(operationReportMarkdown(missing), /websocket\.receive \[source=native\]/)
    await recording(directory, requirements.map((requirement, index) => event({ id: `execution:${index + 1}`, name: requirement.name, category: 'network', attributes: { source: 'native' } })))
    const complete = await summarizeOperations(directory, { requireOperations: requirements })
    assert.deepEqual(complete.coverage.missingOperations, [])
    assert.equal(operationReportHasFailures(complete), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('required business operations need successful completion and survive report-name overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-required-path-'))
  try {
    const coverage = { requireCategories: ['database'], requireRoles: ['fixture'], requireOperations: ['market.append'] }
    await recording(directory, [event({ category: 'database', name: 'market.append', status: 'error' })])
    const failed = await summarizeOperations(directory, coverage)
    assert.equal(failed.diagnostics.missingRequiredCategories, 0)
    assert.equal(failed.diagnostics.missingRequiredRoles, 0)
    assert.deepEqual(failed.coverage.missingOperations, ['market.append'])
    assert.equal(operationReportHasFailures(failed), true)
    assert.match(operationReportMarkdown(failed), /Missing successful required operations: market\.append/)
    await recording(directory, [
      ...Array.from({ length: 260 }, (_, index) => event({ id: `execution:${index + 1}`, name: `loader.operation${index}` })),
      event({ id: 'execution:261', category: 'database', name: 'market.append' }),
    ])
    const complete = await summarizeOperations(directory, coverage)
    assert.ok(!complete.operations.some(value => value.name === 'market.append'), 'The required name should be beyond the bounded display list.')
    assert.equal(complete.diagnostics.missingRequiredOperations, 0)
    assert.deepEqual(complete.coverage.missingOperations, [])
    assert.equal(operationReportHasFailures(complete), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sandbox runs isolate data, enforce declared coverage, record lifecycle pairs, and preserve command failures', async () => {
  const output = await mkdtemp(join(tmpdir(), 'operation-sandbox-'))
  const runner = fileURLToPath(new URL('../../scripts/test-sandbox.mjs', import.meta.url))
  const recorder = new URL('../../electron/services/operations.js', import.meta.url).href
  const run = (exitCode, flags = [], extra = '', onlyIO = false) => new Promise((resolve, reject) => {
    const source = `import { writeFile, mkdir } from 'node:fs/promises'; import { tmpdir } from 'node:os';
      import { join } from 'node:path'; import { measureOperation } from ${JSON.stringify(recorder)};
      await mkdir(process.env.PERPETUAL_SWAP_USER_DATA, { recursive: true });
      await writeFile(join(tmpdir(), 'isolation.json'), JSON.stringify({ temporary: tmpdir(), userData: process.env.PERPETUAL_SWAP_USER_DATA, sandbox: process.env.PERPETUAL_SWAP_SANDBOX, network: process.env.PERPETUAL_SWAP_ALLOW_NETWORK }));
      if (!${onlyIO}) measureOperation({ category: 'cpu', name: 'sandbox.fixture', attributes: { count: 1 } }, () => 42);
      ${extra}
      process.exitCode = ${exitCode};`
    const child = spawn(process.execPath, [runner, 'command', '--output', output, '--scenario', 'sandbox-contract', ...flags, '--', process.execPath, '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16_384) })
    child.on('error', reject); child.on('close', code => resolve({ code, diagnostics }))
  })
  try {
    const passed = await run(0, ['--require-category', 'cpu'])
    assert.equal(passed.code, 0, passed.diagnostics)
    const failed = await run(23)
    assert.equal(failed.code, 23, failed.diagnostics)
    const corrupt = await run(0, [], "await writeFile(join(process.env.PERPETUAL_SWAP_OPERATION_DIR, 'corrupt.jsonl'), 'broken-record\\n');")
    assert.equal(corrupt.code, 1)
    const missing = await run(0, ['--require-role', 'absent-worker'])
    assert.equal(missing.code, 1)
    const onlyIO = await run(0, [], '', true)
    assert.equal(onlyIO.code, 0, onlyIO.diagnostics)
    const directories = (await readdir(output)).sort(), manifests = []
    assert.equal(directories.length, 5)
    for (const entry of directories) {
      const directory = join(output, entry), manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      manifests.push(manifest)
      const isolation = JSON.parse(await readFile(join(directory, 'tmp/isolation.json'), 'utf8'))
      assert.equal(isolation.temporary, join(directory, 'tmp'))
      assert.equal(isolation.userData, join(directory, 'user-data'))
      assert.equal(isolation.sandbox, '1'); assert.equal(isolation.network, '0')
      assert.equal(manifest.scenario, 'sandbox-contract')
      assert.ok(manifest.recordedOperations >= 1)
      assert.equal(manifest.journalRecords, manifest.recordedOperations * 2)
      const report = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
      assert.ok(report.operations.some(operation => operation.name === 'sandbox.fixture') || report.coverage.actualCategories.every(category => category === 'io'))
      assert.deepEqual(manifest.coverage.requireOperations, [], 'Custom commands have no implicit business-path requirement.')
      assert.equal(report.diagnostics.persistenceFailures, 0)
      assert.equal(report.diagnostics.pendingRecords, 0)
      assert.equal(operationReportHasFailures(report), manifest.outcome.exitCode === 1)
    }
    assert.deepEqual(manifests.map(value => value.outcome.exitCode).sort((left, right) => left - right), [0, 0, 1, 1, 23])
    assert.notEqual(manifests[0].environment.userDataDirectory, manifests[1].environment.userDataDirectory)
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('reports expose killed executions, missing raw records and incomplete opt-in native GPU traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-interrupted-'))
  try {
    await recording(directory, [event()], { health: { recorded: 3, persisted: 3, closed: false, sourceFailures: 2, omittedRecords: 4, activeOperations: 1 } })
    await writeFile(join(directory, 'chromium-disabled.status.json'), JSON.stringify({ enabled: false, complete: false }))
    await writeFile(join(directory, 'chromium-truncated.status.json'), JSON.stringify({ enabled: true, complete: false, file: 'chromium-truncated.trace.json', bufferUsage: { percentage: 1 } }))
    const report = await summarizeOperations(directory)
    assert.equal(report.diagnostics.unclosedExecutions, 1)
    assert.equal(report.diagnostics.recorderCountMismatches, 1)
    assert.equal(report.diagnostics.missingRecords, 1)
    assert.equal(report.diagnostics.sourceFailures, 2)
    assert.equal(report.diagnostics.omittedRecords, 4)
    assert.equal(report.diagnostics.activeOperations, 1)
    assert.equal(report.diagnostics.persistenceFailures, 0, 'Source/transport loss must not be mislabeled as a disk failure.')
    assert.equal(report.diagnostics.nativeGpuStatusFiles, 2)
    assert.equal(report.diagnostics.incompleteNativeGpuTraces, 1)
    assert.equal(operationReportHasFailures(report), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('report reads operation files without inspecting application database trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-layout-'))
  try {
    await mkdir(join(directory, 'operations')); await mkdir(join(directory, 'user-data'))
    await recording(join(directory, 'operations'), [event()])
    await writeFile(join(directory, 'user-data/unrelated.jsonl'), 'not an operation recording\n')
    const report = await summarizeOperations(directory)
    assert.equal(report.totals.count, 1)
    assert.equal(operationReportHasFailures(report), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a closed journal cannot claim complete recording before its admitted entries are durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-durability-'))
  try {
    await recording(directory, [event()], { health: { durableRecords: 1 } })
    const pending = await summarizeOperations(directory)
    assert.equal(pending.diagnostics.pendingRecords, 0, 'OS writes and durable checkpoints are separate evidence.')
    assert.equal(pending.diagnostics.undurableRecords, 1)
    assert.equal(operationReportHasFailures(pending), true)
    await recording(directory, [event()], { health: { durableRecords: 2 } })
    assert.equal(operationReportHasFailures(await summarizeOperations(directory)), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reports stream lossless gzip members and reject a torn or corrupt compressed journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operation-report-gzip-'))
  try {
    await recording(directory, [event()])
    const raw = await readFile(join(directory, 'execution.jsonl'))
    const split = raw.indexOf(10) + 1
    const compressed = Buffer.concat([gzipSync(raw.subarray(0, split)), gzipSync(raw.subarray(split))])
    await rm(join(directory, 'execution.jsonl'))
    await writeFile(join(directory, 'execution.jsonl.gz'), compressed)
    const complete = await summarizeOperations(directory)
    assert.equal(complete.totals.count, 1)
    assert.equal(complete.journalRecords, 2)
    assert.equal(operationReportHasFailures(complete), false)
    await writeFile(join(directory, 'execution.jsonl.gz'), compressed.subarray(0, compressed.length - 4))
    const torn = await summarizeOperations(directory)
    assert.equal(torn.diagnostics.journalReadFailures, 1)
    assert.equal(operationReportHasFailures(torn), true)
    const corrupt = Buffer.from(compressed); corrupt[corrupt.length - 8] ^= 1
    await writeFile(join(directory, 'execution.jsonl.gz'), corrupt)
    assert.equal((await summarizeOperations(directory)).diagnostics.journalReadFailures, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
