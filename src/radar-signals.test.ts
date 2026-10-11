import assert from 'node:assert/strict'
import { test } from 'node:test'
import { radarSignals, signalIsUnknown, signalMatches } from './radar-signals.ts'
import type { SuiteReading } from './suite-types.ts'

const reading = (instrument: string, changes: Partial<SuiteReading> = {}): SuiteReading => ({ strategyID: 'shared', revision: 2, instrument, hour: 3_600_000, provisional: false, universe: 'true', phases: { bullishSetup: { result: 'true', hour: 3_600_000 } }, action: 'Bullish Setup', reason: 'Setup matches', ...changes })

test('closed and forming Bullish Setup matches use their own Universe', () => {
  const confirmed = [reading('confirmed'), reading('forming', { universe: 'false' }), reading('blocked')]
  const provisional = [reading('forming', { provisional: true }), reading('blocked', { provisional: true, universe: 'false' })]
  const signals = radarSignals(confirmed, provisional, 'shared', 2)
  assert.deepEqual(signals.filter(signalMatches).map(s => s.instrument), ['confirmed', 'forming', 'blocked'])
})

test('hour selection and revision checks prevent stale or unrelated strategies from leaking into the board', () => {
  const confirmed = [reading('closed'), reading('old', { revision: 1 }), reading('other', { strategyID: 'another' })]
  const provisional = [reading('live', { provisional: true })]
  assert.deepEqual(radarSignals(confirmed, provisional, 'shared', 2, 'confirmed').map(s => s.instrument), ['closed'])
  assert.deepEqual(radarSignals(confirmed, provisional, 'shared', 2, 'provisional').map(s => s.instrument), ['live'])
})

test('Unknown or failed Universe and setup inputs never become matches', () => {
  const signals = radarSignals([
    reading('universe missing', { universe: 'unknown' }),
    reading('universe false', { universe: 'false' }),
    reading('setup missing', { phases: { bullishSetup: { result: 'unknown', hour: 3_600_000 } } }),
    reading('setup absent', { phases: {} }),
    reading('setup false', { phases: { bullishSetup: { result: 'false', hour: 3_600_000 } } }),
  ], [], 'shared', 2)
  assert.deepEqual(signals.map(signalIsUnknown), [true, false, true, true, false])
  assert.deepEqual(signals.filter(signalMatches), [])
})
