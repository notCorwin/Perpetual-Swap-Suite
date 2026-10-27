import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessMetalObserverPairs } from '../../scripts/metal-observer-overhead.mjs'

const pairs = () => Array.from({ length: 5 }, () => ({ baseline: { completed: 128, lastByte: 127, wallMS: 10, cpuMS: 8 },
  enabled: { completed: 128, lastByte: 127, wallMS: 12, cpuMS: 10 } }))

test('Metal observer gates paired CPU and wall margins independently and preserves business results', () => {
  assert.equal(assessMetalObserverPairs(pairs()).passed, true)
  const slow = pairs(); slow.forEach(pair => { pair.enabled.cpuMS = 100 })
  assert.equal(assessMetalObserverPairs(slow).passed, false)
  const corrupt = pairs(); corrupt[0].enabled.lastByte = 0
  assert.throws(() => assessMetalObserverPairs(corrupt), /buffer result/)
  const missing = pairs(); delete missing[0].baseline.cpuMS
  assert.throws(() => assessMetalObserverPairs(missing), /Missing Metal/)
})
