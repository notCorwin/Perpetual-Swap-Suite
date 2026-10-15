import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPercent, signedRelativeChange } from './lib/market-math.ts'

test('signed relative change uses the baseline', () => {
  assert.equal(signedRelativeChange(110, 100), 10)
  assert.equal(signedRelativeChange(90, 100), -10)
})

test('percentage formatting preserves direction', () => {
  assert.equal(formatPercent(1.25), '+1.25%')
  assert.equal(formatPercent(-1.25), '-1.25%')
  assert.equal(formatPercent(null), '—')
})
