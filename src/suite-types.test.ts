import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameStrategyVersion, SUITE_PHASES, suiteSpec, type StrategyProfile } from './suite-types.ts'
const profile = (): StrategyProfile => ({ id: 'strategy', mode: 'radar', name: 'Bullish strategy', revision: 2, updatedAt: 1, universeJSON: 'universe', phaseRules: { bullishSetup: 'setup' } })

test('research freezes Bullish Setup without requiring exit or bearish rules', () => {
  const p = profile(), spec = suiteSpec([p])
  p.phaseRules.bullishSetup = 'changed'; p.universeJSON = 'changed'
  assert.equal(spec.strategySnapshots![0].id, 'strategy@r2')
  assert.deepEqual(spec.strategySnapshots![0].phaseRules, { bullishSetup: 'setup' })
  assert.equal(spec.strategySnapshots![0].universeJSON, 'universe')
  assert.equal(spec.kind, 'filter'); assert.equal(spec.direction, 'Long')
  assert.deepEqual(SUITE_PHASES.map(p => p.label), ['Bullish Setup'])
  assert.deepEqual(spec.rules, [], 'The native planner derives the Universe-gated setup rules.')
})
test('two strategy revisions produce a comparison and retain frozen identities', () => {
  const current = profile(), old = { ...profile(), id: 'strategy@r1', revision: 1, name: 'Bullish strategy · r1' }
  const spec = suiteSpec([old, current])
  assert.deepEqual(spec.strategySnapshots!.map(p => p.id), ['strategy@r1', 'strategy@r2'])
  assert.equal(spec.kind, 'comparison')
  assert.throws(() => suiteSpec([]), /Choose one/)
  assert.throws(() => suiteSpec([old, current, profile()]), /Choose one/)
})
test('Radar activation reuses only the exact researched Universe and Bullish Setup', () => {
  const saved = profile(), frozen = suiteSpec([saved]).strategySnapshots![0]
  assert.equal(sameStrategyVersion(saved, frozen), true)
  assert.equal(sameStrategyVersion({ ...saved, revision: 3 }, frozen), false)
  assert.equal(sameStrategyVersion(undefined, frozen), false)
  assert.equal(sameStrategyVersion({ ...saved, phaseRules: { bullishSetup: 'changed' } }, frozen), false)
  assert.equal(sameStrategyVersion({ ...saved, universeJSON: 'changed' }, frozen), false)
})
