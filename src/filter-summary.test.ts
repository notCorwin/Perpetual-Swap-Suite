import assert from 'node:assert/strict'
import test from 'node:test'
import { filterRuleSummary } from './filter-summary.ts'
import { emptyFilterConfig, makeRule } from './rule-engine.ts'

test('summaries show nested matching logic, thresholds, and closed time windows', () => {
  const config = emptyFilterConfig(), group = makeRule('any'), window = makeRule('every'), price = makeRule(), volume = makeRule()
  price.left = 'Close'; price.right = '100'
  volume.left = 'Volume'; volume.right = '200'
  window.mode = 'closed'; window.hours = 48; window.children = [price]
  group.children = [window, volume]; config.root.children = [group]
  assert.equal(filterRuleSummary(config, [], {}), '(Closed (Close > 100 · every hour for 48h) OR Volume > 200)')
})
