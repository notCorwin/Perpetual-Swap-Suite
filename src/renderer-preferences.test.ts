import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compareRankingChange } from './market-ranking.ts'
import { DEFAULT_PREFERENCES, preferencesDraft, validatePreferencesDraft } from './renderer-preferences.ts'

test('ranking uses absolute completed change, null last and stable instrument ties', () => {
  const rows = [
    { instId: 'C', rankingChange: 1 }, { instId: 'B', rankingChange: 2 },
    { instId: 'D', rankingChange: null }, { instId: 'A', rankingChange: -5 },
    { instId: 'F', rankingChange: NaN }, { instId: 'AA', rankingChange: -2 },
  ]
  assert.deepEqual(rows.sort(compareRankingChange).map(row => row.instId), ['A', 'AA', 'B', 'C', 'D', 'F'])
})
test('default screening settings round trip independently from chart timeframe', () => {
  const draft = preferencesDraft(DEFAULT_PREFERENCES)
  assert.deepEqual(validatePreferencesDraft(draft), { values: DEFAULT_PREFERENCES, errors: {} })
  draft.chartTimeframe = '1H'
  draft.liquidity.spread.enabled = false
  const result = validatePreferencesDraft(draft).values!
  assert.equal(result.rankingLookback, 15)
  assert.equal(result.liquidity.spread.enabled, false)
  assert.equal(result.liquidity.volumeStability.enabled, false)
  assert.equal(result.liquidity.slippage.notionalUSDT, 100_000)
})
test('settings reject empty, nonfinite and invalid candle windows before saving', () => {
  const draft = preferencesDraft(DEFAULT_PREFERENCES)
  draft.rankingLookback = '7'
  draft.historyDays = ''
  draft.liquidity.depth.threshold = 'Infinity'
  draft.slippageNotional = '0'
  assert.deepEqual(Object.keys(validatePreferencesDraft(draft).errors).sort(), ['depth', 'historyDays', 'rankingLookback', 'slippageNotional'])
  assert.equal(validatePreferencesDraft(draft).values, undefined)
})
