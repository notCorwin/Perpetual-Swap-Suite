import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeResources } from '../../scripts/resource-summary.mjs'

test('explicit measurement boundaries exclude setup and reject incomplete boundaries', () => {
  const sample = (boundary, energy) => ({ boundary, totals: {}, interval: energy == null ? null : {
    elapsedNsExact: '1000000000', combined: { complete: true, cpuNsExact: '1', cpuEnergyNjExact: String(energy) },
  } })
  const resources = { samples: [sample(null, null), sample('start', 1000000000), sample('end', 2000000000), sample(null, 3000000000)] }
  const result = summarizeResources(resources).combined
  assert.equal(result.cpuEnergyJoules, 2)
  assert.equal(result.cpuMeanWatts, 2)
  assert.equal(result.coverage.boundaryStatus, 'explicit')
  resources.samples[2].boundary = null
  assert.equal(summarizeResources(resources).combined.cpuEnergyJoules, null)
  assert.equal(summarizeResources(resources).combined.coverage.boundaryStatus, 'invalid')
})

test('preserves a confirmed counter total when its P/E split is unavailable', () => {
  const part = { complete: false, totalComplete: true, totalExact: '123', pCoreExact: null, eCoreExact: null }
  const resources = { samples: [{ boundary: 'start' }, { boundary: 'end', interval: {
    elapsedNsExact: '1000000000', combined: { complete: true, cpuNsExact: '1', breakdown: { cpuCycles: part } },
  } }] }
  const cycles = summarizeResources(resources).combined.breakdown.cpuCycles
  assert.equal(cycles.totalExact, '123')
  assert.equal(cycles.totalComplete, true)
  assert.equal(cycles.complete, false)
  assert.equal(cycles.pCoreExact, null)
  assert.equal(cycles.eCoreExact, null)
})


test('rejects counter splits without duration or conservation', () => {
  const part = { complete: true, totalComplete: true, totalExact: '12', pCoreExact: '5', eCoreExact: '6' }
  const interval = { elapsedNsExact: '1000000000', combined: { breakdown: { cpuCycles: part } } }
  const resources = { samples: [{ boundary: 'start' }, { boundary: 'end', interval }] }
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.complete, false)
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.totalExact, '12')
  part.eCoreExact = '7'
  interval.elapsedNsExact = '0'
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.complete, false)
  assert.equal(summarizeResources(resources).combined.breakdown.cpuCycles.totalComplete, false)
})
