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
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_100_000, open: 100, high: 110, low: 95, close: 105, volume: 42, confirmed: true },
      { instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: 1_700_000_400_000, open: 105, high: 115, low: 100, close: 110, volume: 43, confirmed: true },
    ])
    const rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: 1_700_000_100_000, through: 1_700_000_100_000 })
    assert.deepEqual(rows.map(row => ({ timestamp: row.timestamp, close: row.close, confirmed: row.confirmed })), [{ timestamp: 1_700_000_100_000, close: 105, confirmed: true }])
    const timeframes = await readdir(join(root, 'candles'))
    assert.deepEqual(timeframes, ['timeframe=5m'])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('foreground store work cuts ahead of queued background reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    let releaseHold: (() => void) | undefined
    const holdGate = new Promise<void>(resolve => { releaseHold = resolve })
    const order: string[] = []
    const hold = store.enqueue(async () => { await holdGate; order.push('hold') })
    store.enqueue(async () => { order.push('background-1') })
    store.enqueue(async () => { order.push('background-2') })
    const foreground = store.enqueue(async () => { order.push('foreground') }, 'foreground')
    releaseHold?.()
    await Promise.all([hold, foreground])
    await store.enqueue(async () => undefined)
    assert.deepEqual(order, ['hold', 'foreground', 'background-1', 'background-2'])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('repeated appends stay one part per partition with newest values winning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-parquet-'))
  const store = await MarketStore.open(root)
  try {
    const first = 1_700_000_100_000, second = first + 300_000, third = first + 600_000
    const candle = (timestamp: number, close: number) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp, open: 100, high: Math.max(111, close), low: 95, close, volume: 1, confirmed: true })
    await store.appendCandles([candle(first, 105), candle(second, 110)])
    let coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.equal(coverage.count, 2)
    // A statistics patch overwrites the first timestamp and adds a third.
    await store.appendCandles([candle(first, 106), candle(third, 111)])
    coverage = await store.coverage('BTC-USDT-SWAP', '5m')
    assert.equal(coverage.count, 3, 'Every write invalidates the cached coverage scan.')
    const directory = join(root, 'candles', 'timeframe=5m', 'instrument=BTC-USDT-SWAP', 'date=2023-11-14')
    const parts = (await readdir(directory)).filter(name => name.endsWith('.parquet'))
    assert.equal(parts.length, 1, 'Appends merge into the partition instead of accumulating parts.')
    const rows = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: third })
    assert.deepEqual(rows.map(row => row.close), [106, 110, 111])
    const missing = await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: third })
    assert.deepEqual(missing, [], 'A complete window reports no gaps after merged writes.')
    const fourth = third + 600_000
    await store.appendCandles([candle(fourth, 112)])
    const holes = await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: first, through: fourth })
    assert.deepEqual(holes, [{ from: third + 300_000, through: third + 300_000 }])
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
