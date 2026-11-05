import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendTrial, compareBackendTrials } from './backend-analysis.mjs'

test('energy analysis refuses work probes and reports without explicit probe provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backend-analysis-'))
  try {
    for (const backendWorkProbe of [true, undefined]) {
      const file = join(directory, 'report.json')
      await writeFile(file, JSON.stringify({ outcome: 'passed', smoke: false, runs: [{}], diagnostics: false, v8Profile: false, backendWorkProbe }))
      await assert.rejects(backendTrial(file), /Work-probe state/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('backend pair comparison rejects changed frontend, input targets and extra phases', () => {
  const resources = Object.fromEntries(['backend', 'combined', 'runtime'].map(group => [group,
    { cpuSeconds: 10, cpuEnergyJoules: 20, cpuPercentOfOneCore: 30 }]))
  const trial = { epoch: 1, dataHash: 'same', oracle: 'same', fixture: { count: 287 },
    fingerprint: { files: { 'dist/assets/app.js': 'same' } },
    phases: [{ scenario: 'realtime', targets: [{ index: 0, term: 'btc' }], deliveries: [{ sequence: 1, expected: 100 }], resources }] }
  assert.equal(compareBackendTrials(trial, structuredClone(trial))[0].changes.backend.cpuSeconds.relativePercent, 0)
  for (const change of [
    candidate => { candidate.fingerprint.files['dist/assets/app.js'] = 'different' },
    candidate => { candidate.phases[0].targets[0].term = 'eth' },
    candidate => { candidate.phases.push(structuredClone(candidate.phases[0])) },
  ]) {
    const candidate = structuredClone(trial); change(candidate)
    assert.throws(() => compareBackendTrials(trial, candidate))
  }
})
