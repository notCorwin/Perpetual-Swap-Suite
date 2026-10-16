import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

const fiveMinutes = 300_000
const record = (timestamp: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, confirmed: true })

test('missingCandleRanges reports only contiguous gaps inside the requested 5m range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const base = Date.UTC(2024, 0, 1)
    await store.appendCandles(Array.from({ length: 10 }, (_, index) => index).filter(index => ![2, 4, 5].includes(index)).map(index => record(base + index * fiveMinutes)))
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base, through: base + 9 * fiveMinutes }), [
      { from: base + 2 * fiveMinutes, through: base + 2 * fiveMinutes },
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
    assert.deepEqual(await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', from: base + 3 * fiveMinutes, through: base + 6 * fiveMinutes }), [
      { from: base + 4 * fiveMinutes, through: base + 5 * fiveMinutes },
    ])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('candles normalize numeric statistics from heterogeneous Parquet parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  try {
    const timestamp = Date.UTC(2024, 0, 1)
    // The first part omits optional statistics, just like a raw/derived write
    // before direct OI/Taker hydration. A later part supplies them.
    await store.appendCandles([record(timestamp)])
    await store.appendCandles([{ ...record(timestamp), oi: 1_000, buy: 200, sell: 100 }])
    const [candle] = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: timestamp, through: timestamp })
    assert.equal(candle.oi, 1_000)
    assert.equal(candle.buy, 200)
    assert.equal(candle.sell, 100)
    assert.equal(typeof candle.oi, 'number')
    assert.equal(typeof candle.buy, 'number')
    assert.equal(typeof candle.sell, 'number')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('close drains work already admitted to the DuckDB lane and rejects new work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-store-'))
  const store = await MarketStore.open(root)
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const internal: any = store
  try {
    const admitted = internal.enqueue(async () => { await gate; return 'done' })
    const closing = store.close()
    await assert.rejects(() => internal.enqueue(async () => 'late'), /MarketStore is closed/)
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(closed, false)
    release?.()
    assert.equal(await admitted, 'done')
    await closing
    assert.equal(closed, true)
  } finally { release?.(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
