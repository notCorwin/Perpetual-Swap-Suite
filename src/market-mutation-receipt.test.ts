import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'

const instrument = 'BTC-USDT-SWAP', timestamp = Date.UTC(2024, 0, 1), step = 300_000
const candle = (index = 0, patch = {}) => ({ instrument, timeframe: '5m', timestamp: timestamp + index * step,
  open: 100, high: 110, low: 90, close: 105, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true, ...patch })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-receipt-')), store = await MarketStore.open(root)
  return { store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('writer receipts expose canonical changed rows and initial values without reader requests', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([candle(0, { oi: 123, buy: 2, sell: 3, statisticsVersion: 11 })])
    const query = { instrument, timeframe: '5m', from: timestamp, through: timestamp }
    const initial = await f.store.candles(query)
    const reads = f.store.getDiagnostics().reads.requests
    const receipt = await f.store.appendCandlesWithReceipt([candle(0, { close: 106 }), candle(1)])
    assert.deepEqual(receipt.previous, initial)
    assert.equal(f.store.getDiagnostics().reads.requests, reads)
    assert.deepEqual(receipt.rows, await f.store.candles({ ...query, through: timestamp + step }))
    assert.equal(receipt.rows[0].oi, 123)
    const revision = f.store.candleRevision(instrument, '5m')
    assert.deepEqual(await f.store.appendCandlesWithReceipt([candle(0, { close: 106 }), candle(1)]), { submitted: 2, rows: [], previous: [] })
    assert.equal(f.store.candleRevision(instrument, '5m'), revision)
    assert.deepEqual(await f.store.appendCandlesWithReceipt([candle(2)], 'foreground', { canWrite: () => false }), { submitted: 0, rows: [], previous: [] })
  } finally { await f.close() }
})

test('receipt projections reevaluate price-bound statistics and preserve independent facts', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([candle()])
    await f.store.appendStatistics({ instrument, timeframe: '5m', from: timestamp, through: timestamp, source: 'oi', values: [[timestamp, 123]] })
    await f.store.appendStatistics({ instrument, timeframe: '5m', from: timestamp, through: timestamp, source: 'taker', values: [[timestamp, 3, 7]], priceVolume: 10 })
    const receipt = await f.store.appendCandlesWithReceipt([candle(0, { volume: 11 })])
    assert.equal(receipt.previous[0].buy, 7)
    assert.equal(receipt.rows[0].buy, null)
    assert.equal(receipt.rows[0].oi, 123)
    assert.deepEqual(receipt.rows, await f.store.candles({ instrument, timeframe: '5m', from: timestamp, through: timestamp }))
  } finally { await f.close() }
})

test('bounded append receipts coalesce repeated timestamps across transactions to final values', async () => {
  const f = await fixture()
  try {
    const original = candle()
    await f.store.appendCandles([original])
    const initial = await f.store.candles({ instrument, timeframe: '5m', from: timestamp, through: timestamp })
    const rows = [candle(0, { close: 106 }), ...Array.from({ length: 2047 }, (_, index) => candle(index + 1)), candle(0, { close: 107 })]
    const receipt = await f.store.appendCandlesWithReceipt(rows)
    assert.equal(receipt.rows.length, 2048)
    assert.deepEqual(receipt.previous, initial)
    assert.equal(receipt.rows.find(row => row.timestamp === timestamp)?.close, 107)
  } finally { await f.close() }
})

test('service appends and aggregates reuse one writer receipt per operation and no reader IPC', async () => {
  const f = await fixture()
  try {
    const observed: any[] = []
    const context = { store: f.store, disposed: false, preparedCharts: { observe: (...args: unknown[]) => observed.push(args), invalidate: () => {} },
      invalidateLiquidityHistory: () => {}, markChartDataChanged: () => {}, scheduleQualification: () => {}, history: { sync: { invalidate: () => {} } } }
    const reads = f.store.getDiagnostics().reads
    const writes = f.store.getDiagnostics().writes
    const append = MarketService.prototype.appendChangedCandlesLocked
    const aggregate = MarketService.prototype.materializePricesLocked
    await append.call(context, [candle(), candle(1), candle(2)], 'foreground')
    const range = { instrument, timeframe: '15m' as const, from: timestamp, through: timestamp }
    assert.deepEqual(await aggregate.call(context, range, 'foreground'), { changed: 1, complete: 1, invalidated: 0 })
    assert.equal(observed.length, 2)
    assert.deepEqual(f.store.getDiagnostics().reads, reads)
    assert.equal(f.store.getDiagnostics().writes.completed - writes.completed, 2)
    assert.equal(observed[1][0][0].close, 105)
    assert.deepEqual(await aggregate.call(context, range, 'foreground'), { changed: 0, complete: 1, invalidated: 0 })
    assert.equal(observed.length, 2)
    const receipt = await f.store.aggregateCandlesWithReceipt(range)
    assert.deepEqual(receipt, { changed: 0, complete: 1, invalidated: 0, rows: [], previous: [] })
  } finally { await f.close() }
})
