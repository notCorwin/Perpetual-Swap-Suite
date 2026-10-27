import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_PREFERENCES, preferencesDraft, validatePreferencesDraft } from './renderer-preferences.ts'

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

test('renderer and canonical settings agree on strict thresholds and supported ranges', () => {
  for (const [key, value] of [['depth', '0'], ['volume24h', '0'], ['volumeStability', '1']]) {
    const draft = preferencesDraft(DEFAULT_PREFERENCES)
    draft.liquidity[key as keyof typeof draft.liquidity].threshold = value
    assert.equal(validatePreferencesDraft(draft).values, undefined)
  }
  const draft = preferencesDraft(DEFAULT_PREFERENCES)
  draft.historyDays = '3651'
  assert.equal(validatePreferencesDraft(draft).values, undefined)
})
