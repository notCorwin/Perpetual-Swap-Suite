import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { researchPercent, researchSize, researchTime } from './research-types.ts'

test('research timestamps retain UTC dates and minute precision', () => {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC', timeZoneName: 'short' }
  for (const timestamp of [0, Date.UTC(2026, 9, 12, 0, 0), Date.UTC(2026, 9, 12, 23, 59)]) {
    assert.equal(researchTime(timestamp), new Date(timestamp).toLocaleString('en-US', options))
    assert.match(researchTime(timestamp), /UTC$/)
  }
})

test('research percentages and download sizes retain their display precision', () => {
  assert.equal(researchPercent(null), '—')
  assert.equal(researchPercent(undefined), '—')
  assert.equal(researchPercent(0), '0%')
  assert.equal(researchPercent(-0.00123456), '-0.123%')
  assert.equal(researchSize(0), '0 MB')
  assert.equal(researchSize(1_250_000), '1.25 MB')
  assert.equal(researchSize(999_000_000), '999 MB')
  assert.equal(researchSize(1_250_000_000), '1.25 GB')
})
