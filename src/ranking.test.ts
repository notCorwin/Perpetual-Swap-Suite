import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { compareRanking } from '../electron/services/ranking.js'

test('ranking ties use fixed instrument IDs for both known and unavailable changes', () => {
  const rows = [
    { instId: 'C-USDT-SWAP', rankingChange: -2 },
    { instId: 'B-USDT-SWAP', rankingChange: 2 },
    { instId: 'A-USDT-SWAP', rankingChange: 0 },
    { instId: 'Z-USDT-SWAP', rankingChange: null },
    { instId: 'Y-USDT-SWAP', rankingChange: Number.NaN },
    { instId: 'X-USDT-SWAP', rankingChange: Infinity },
  ]
  assert.deepEqual(rows.sort(compareRanking).map(row => row.instId), ['B-USDT-SWAP', 'C-USDT-SWAP', 'A-USDT-SWAP', 'X-USDT-SWAP', 'Y-USDT-SWAP', 'Z-USDT-SWAP'])
  assert.equal(compareRanking({ instId: 'A', rankingChange: 2 }, { instId: 'A', rankingChange: -2 }), 0)
  assert.equal(compareRanking({ instId: 'A', rankingChange: null }, { instId: 'A', rankingChange: null }), 0)
})
