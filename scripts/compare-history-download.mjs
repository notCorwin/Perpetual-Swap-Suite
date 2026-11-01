#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [baselinePath, candidatePath] = process.argv.slice(2)
if (!baselinePath || !candidatePath || process.argv.length !== 4) throw new Error('Usage: compare-history-download.mjs BASELINE_JSON CANDIDATE_JSON')
const baseline = JSON.parse(await readFile(baselinePath, 'utf8')), candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
assert.equal(baseline.variant, 'baseline'); assert.equal(candidate.variant, 'candidate')
for (const field of ['scenario', 'revision', 'baselineRevision', 'inputHash', 'sourceSHA256', 'delayMS', 'chunkSlots', 'instruments', 'listing', 'asOf']) {
  assert.deepEqual(candidate[field], baseline[field], `The paired runs must share ${field}.`)
}
assert.deepEqual(candidate.expectedRows, baseline.expectedRows, 'The same source slots must be materialized.')
assert.deepEqual(candidate.hashes, baseline.hashes, 'Every OHLCV and statistic field must match.')
assert.deepEqual(candidate.statisticsHashes, baseline.statisticsHashes, 'Independent statistic slots must match, including missing candles.')
assert.equal(candidate.report.phase, baseline.report.phase)
for (const field of ['checked', 'total', 'available', 'empty', 'unavailable', 'failed', 'pending']) {
  assert.equal(candidate.report.progress[field], baseline.report.progress[field], `Progress ${field} must match.`)
}
assert.deepEqual(candidate.report.failures.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  baseline.report.failures.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
const mapDelta = (before, after) => Object.fromEntries([...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()
  .map(key => [key, { before: before?.[key] ?? 0, after: after?.[key] ?? 0, delta: (after?.[key] ?? 0) - (before?.[key] ?? 0) }]))
const totals = value => Object.fromEntries(['calls', 'rows', 'bytes', 'failures'].map(field => [field,
  Object.values(value ?? {}).reduce((sum, entry) => sum + (entry[field] ?? 0), 0)]))
const bySource = Object.fromEntries([...new Set([...Object.keys(baseline.requests), ...Object.keys(candidate.requests)])].sort()
  .map(key => [key, mapDelta(baseline.requests[key], candidate.requests[key])]))
const paired = field => ({ before: baseline[field], after: candidate[field],
  delta: typeof baseline[field] === 'number' && typeof candidate[field] === 'number' ? candidate[field] - baseline[field] : null })
const nativeDatabase = async result => {
  assert.ok(result.sandboxDirectory, 'Each benchmark must run inside an operation-recording sandbox.')
  const manifest = JSON.parse(await readFile(join(result.sandboxDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.outcome.status, 'passed', 'The sandbox and operation recording must complete successfully.')
  const report = JSON.parse(await readFile(join(result.sandboxDirectory, 'summary.json'), 'utf8'))
  return Object.fromEntries(report.operations.filter(operation => operation.category === 'database').map(operation => [operation.name,
    { spans: operation.count, queryBatches: operation.work.queryCount, changes: operation.work.changes }]))
}
const baselineDB = await nativeDatabase(baseline), candidateDB = await nativeDatabase(candidate)
const nativeDB = Object.fromEntries([...new Set([...Object.keys(baselineDB), ...Object.keys(candidateDB)])].sort()
  .map(key => [key, mapDelta(baselineDB[key], candidateDB[key])]))
console.log(JSON.stringify({ scenario: baseline.scenario, inputHash: baseline.inputHash, revision: baseline.revision,
  output: 'Every source slot and OHLCV/statistic digest matched.',
  elapsedMS: paired('wallMS'), processCPUms: paired('processCPUms'), mainThreadCPUms: paired('mainThreadCPUms'),
  firstParentMS: paired('firstParentMS'), maximumConcurrentRequests: paired('maximumConcurrentRequests'),
  firstParentCoveredMS: paired('firstParentCoveredMS'),
  firstParentByTimeframe: { before: baseline.firstParentByTimeframe, after: candidate.firstParentByTimeframe },
  firstParentCoveredByTimeframe: { before: baseline.firstParentCoveredByTimeframe, after: candidate.firstParentCoveredByTimeframe },
  existingParentBeforeFineRelease: { before: baseline.existingParentBeforeFineRelease, after: candidate.existingParentBeforeFineRelease,
    regression: baseline.scenario === 'existing' && baseline.existingParentBeforeFineRelease.ready && !candidate.existingParentBeforeFineRelease.ready },
  fragmentation: { before: baseline.fragmentation, after: candidate.fragmentation },
  foreground: { before: baseline.foreground, after: candidate.foreground },
  requestTotals: mapDelta(totals(baseline.requests), totals(candidate.requests)), requestsBySource: bySource,
  databaseAPIcalls: mapDelta(baseline.databaseAPIcalls, candidate.databaseAPIcalls),
  recordedDatabase: { measurement: 'Instrumented query batches and changes per named span, including setup and independent oracle reads; nested spans may overlap.', operations: nativeDB },
  historyTasks: mapDelta(baseline.historyTasks, candidate.historyTasks) }, null, 2))
