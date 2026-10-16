import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

test('DuckDB writes partitioned Parquet candles and queries their range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    await store.appendCandles([
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_000_000, open: 100, high: 110, low: 95, close: 105, volume: 42, confirmed: true },
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_300_000, open: 105, high: 115, low: 100, close: 110, volume: 43, confirmed: true },
    ])
    const rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: 1_700_000_000_000, through: 1_700_000_000_000 })
    assert.deepEqual(rows.map(row => ({ timestamp: row.timestamp, close: row.close, confirmed: row.confirmed })), [{ timestamp: 1_700_000_000_000, close: 105, confirmed: true }])
    const timeframes = await readdir(join(root, 'candles'))
    assert.deepEqual(timeframes, ['timeframe=5m'])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
