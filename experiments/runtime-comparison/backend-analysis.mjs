import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { summarizeResources, summarizeInputs, summarizeRealtime, distribution } from './analyze.mjs'
import { operationReportHasFailures } from '../../scripts/operation-report.mjs'

export async function backendTrial(path) {
  const raw = await readFile(path), report = JSON.parse(raw)
  assert.equal(report.outcome, 'passed'); assert.equal(report.runs.length, 1)
  assert.equal(report.smoke, false)
  assert.equal(report.diagnostics, false); assert.equal(report.v8Profile, false)
  assert.equal(report.backendWorkProbe, false, 'Work-probe state must be explicitly disabled in an energy report.')
  assert.equal(report.sampleStacks, false); assert.equal(report.engineProfile, false)
  assert.equal(report.measurement.count, 287); assert.equal(report.measurement.periods, 384)
  assert.equal(report.measurement.requestedCadenceMS, 500); assert.equal(report.measurement.syntheticInteractionCadenceMS, 200)
  assert.ok(JSON.stringify(report.scenarios) === '["realtime"]'
    || JSON.stringify(report.scenarios) === '["idle","realtime","history","download"]', 'Require the replicated realtime workload or the full four-scenario workload.')
  const run = report.runs[0]
  assert.equal(run.outcome, 'passed'); assert.equal(run.runtime, 'electron'); assert.equal(run.telemetry, 'full')
  assert.equal(run.transport, 'native')
  assert.deepEqual(run.phases.map(phase => phase.scenario), report.scenarios)
  assert.equal(operationReportHasFailures(run.recording), false)
  assert.equal(run.final.actualRows, run.fixture.rowsSeeded); assert.deepEqual(run.final.liveMismatches, [])
  for (const teardown of Object.values(run.teardown)) { assert.equal(teardown.forced, false); assert.equal(teardown.code, 0) }
  const phases = run.phases.map(phase => {
    const inputs = summarizeInputs(phase), realtime = summarizeRealtime(phase), resources = summarizeResources(phase.resources)
    assert.deepEqual(phase.errors, []); assert.deepEqual(phase.failures, [])
    assert.equal(inputs.acknowledged, inputs.planned); assert.equal(inputs.errors, 0); assert.equal(inputs.pending, 0)
    assert.equal(inputs.planned, phase.scenario === 'idle' ? 0 : phase.scenario === 'realtime' ? 152 : 100)
    if (phase.scenario !== 'idle') assert.ok(phase.rafCount / (phase.durationMS / 1000) >= 50)
    if (realtime) {
      assert.equal(realtime.committed, 60); assert.equal(realtime.missing, 0); assert.equal(realtime.coalesced, 0)
      assert.equal(phase.load.completed, 60); assert.equal(run.final.nativeUpdates, 60 * run.fixture.count * 3)
    }
    if (phase.scenario === 'download') assert.equal(phase.downloadEnd.archiveRows, 12240)
    for (const group of Object.values(resources)) {
      assert.equal(group.coverage.cpu.complete, true); assert.equal(group.coverage.cpuEnergy.complete, true)
    }
    return { scenario: phase.scenario, durationMS: phase.durationMS, resources, inputs: { ...inputs, committedIndices: undefined }, realtime,
      rafCount: phase.rafCount, metrics: phase.transportMetrics,
      targets: phase.inputs.map(input => ({ index: input.index, kind: input.kind, targetEnd: input.targetEnd, term: input.term })),
      deliveries: phase.deliveries?.map(item => ({ sequence: item.sequence, expected: item.expected })) }
  })
  return { path: resolve(path), sha256: createHash('sha256').update(raw).digest('hex'), fingerprint: report.sourceFingerprint,
    epoch: report.marketEpochMS, dataHash: run.canonicalDataHash, oracle: report.oracleSHA256,
    fixture: { count: run.fixture.count, periods: run.fixture.periods, ids: run.fixture.instIds },
    recording: run.recording.diagnostics, phases }
}

export function compareBackendTrials(before, after) {
  assert.equal(before.epoch, after.epoch); assert.equal(before.dataHash, after.dataHash); assert.equal(before.oracle, after.oracle)
  assert.deepEqual(before.fixture, after.fixture)
  const commonInputs = files => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('dist/')
    || ['electron/market-resource-fixtures.js', 'electron/resource-workload.js', 'experiments/runtime-comparison/browser.js',
      'experiments/runtime-comparison/server.mjs', 'experiments/runtime-comparison/fixture-policy.mjs'].includes(name)))
  assert.deepEqual(commonInputs(before.fingerprint.files), commonInputs(after.fingerprint.files), 'Frontend and replay fixtures must be identical.')
  assert.equal(before.phases.length, after.phases.length)
  assert.deepEqual(before.phases.map(phase => phase.scenario), after.phases.map(phase => phase.scenario))
  assert.equal(new Set(before.phases.map(phase => phase.scenario)).size, before.phases.length)
  return before.phases.map((base, index) => {
    const candidate = after.phases[index]
    assert.equal(base.scenario, candidate.scenario); assert.deepEqual(base.targets, candidate.targets)
    assert.deepEqual(base.deliveries, candidate.deliveries)
    const changes = Object.fromEntries(['backend', 'combined', 'runtime'].map(group => [group,
      Object.fromEntries(['cpuSeconds', 'cpuEnergyJoules', 'cpuPercentOfOneCore'].map(metric => {
        const a = base.resources[group][metric], b = candidate.resources[group][metric]
        assert.ok(a > 0 && Number.isFinite(b))
        return [metric, { before: a, after: b, relativePercent: (b - a) / a * 100 }]
      }))]))
    return { scenario: base.scenario, changes }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, ...paths] = process.argv.slice(2)
  assert.ok(output && paths.length && paths.length % 2 === 0, 'Supply output.json then before/after report pairs.')
  const trials = [], pairs = []
  for (let index = 0; index < paths.length; index += 2) {
    const before = await backendTrial(paths[index]), after = await backendTrial(paths[index + 1])
    trials.push({ before, after }); pairs.push(compareBackendTrials(before, after))
  }
  for (const pair of pairs) assert.deepEqual(pair.map(phase => phase.scenario), pairs[0].map(phase => phase.scenario),
    'All aggregated pairs must measure the same ordered scenarios.')
  const aggregate = Object.fromEntries(pairs[0].map((phase, index) => [phase.scenario,
    Object.fromEntries(Object.keys(phase.changes).map(group => [group,
      Object.fromEntries(Object.keys(phase.changes[group]).map(metric => [metric,
        distribution(pairs.map(pair => pair[index].changes[group][metric].relativePercent))]))]))]))
  const sourceManifests = {}
  for (const pair of trials) for (const trial of Object.values(pair)) {
    sourceManifests[trial.fingerprint.sha256] ??= trial.fingerprint.files
    trial.fingerprint = { sha256: trial.fingerprint.sha256 }
    // Exact targets/deliveries have been compared above and remain in the
    // hashed raw reports; do not duplicate their full arrays in compact evidence.
    for (const phase of trial.phases) { delete phase.targets; delete phase.deliveries }
  }
  const evidence = { schemaVersion: 1, createdAt: new Date().toISOString(),
    scope: 'Full recording, unchanged production frontend, shared production Node backend, native comparison bridge. CPU energy only; synthetic intake and DOM/RAF acknowledgement, not actual network or physical presentation.',
    limitations: 'Descriptive sequential trials on an active desktop. Diagnostic probes excluded. Shared-system, GPU, display and disk energy unavailable. Source snapshots separate optimization from concurrent recording policy changes.',
    sourceManifests, trials, pairs, aggregate }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(aggregate, null, 2))
}
