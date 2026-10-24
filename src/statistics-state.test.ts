import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { statisticsMask, statisticsVersionFor } from '../electron/services/statistics-state.js'

test('runtime statistics use one source-bit format for both numeric and empty observations', () => {
  for (const sources of [0, 1, 2, 3]) {
    const version = statisticsVersionFor(sources)
    assert.equal(version, 8 | sources)
    assert.equal(statisticsMask({ statisticsVersion: version, oi: 100, buy: 20, sell: 10 }), sources)
    assert.equal(statisticsMask({ statisticsVersion: version, oi: null, buy: null, sell: null }), sources)
  }
  for (const statisticsVersion of [0, 1, 4, 5, 6, 7, 12]) {
    assert.equal(statisticsMask({ statisticsVersion, oi: 100, buy: 20, sell: 10 }), 0, 'Legacy encodings belong only at the import boundary.')
  }
})
