import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

type Result = { name: string; iterations: number; medianMS: number; p95MS: number; validated: boolean }
const percentile = (values: number[], value: number) => values[Math.min(values.length - 1, Math.floor(values.length * value))]
async function benchmark(name: string, iterations: number, operation: (index: number) => Promise<void>, validate?: (index: number) => Promise<void>): Promise<Result> {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now(); await operation(index); values.push(performance.now() - start)
    await validate?.(index)
  }
  values.sort((a, b) => a - b)
  return { name, iterations, medianMS: Number(percentile(values, .5).toFixed(3)), p95MS: Number(percentile(values, .95).toFixed(3)), validated: Boolean(validate) }
}

const root = await mkdtemp(join(tmpdir(), 'perp-radar-benchmark-'))
const store = await MarketStore.open(root)
try {
  const base = Date.UTC(2026, 9, 16)
  const candles = Array.from({ length: 1_000 }, (_, index) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: base + index * 300_000, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 1_000 + index, confirmed: true }))
  const day = 86_400_000
  // Realistic session accumulation: many small hydration, repair, and
  // statistics writes across a fortnight, then the chart-shaped reads.
  for (let dayOffset = 1; dayOffset <= 14; dayOffset += 1) {
    const start = base - dayOffset * day
    for (let part = 0; part < 6; part += 1) {
      await store.appendCandles(Array.from({ length: 48 }, (_, index) => ({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', timestamp: start + (part * 48 + index) * 300_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1, quoteVolume: 10, confirmed: true })))
    }
  }
  const window = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base - day, through: base }
  const batches = Array.from({ length: 5 }, (_, batch) => candles.map(row => ({ ...row, timestamp: row.timestamp + batch * candles.length * 300_000 })))
  const corrections = Array.from({ length: 5 }, (_, batch) => candles.map(row => ({ ...row, close: row.close + (batch + 1) / 100 })))
  const baselineRows = (await store.coverage('BTC-USDT-SWAP', '5m')).count
  let watermark = await store.priceWatermark('BTC-USDT-SWAP', '5m')
  const verifyMutation = async (expectedRows: number, changed: boolean) => {
    assert.equal((await store.coverage('BTC-USDT-SWAP', '5m')).count, expectedRows)
    const next = await store.priceWatermark('BTC-USDT-SWAP', '5m')
    if (changed) assert.notEqual(next, watermark, 'Actual inserts/corrections must advance the price revision.')
    else assert.equal(next, watermark, 'Identical facts must not mutate the price revision.')
    watermark = next
  }
  const results = [
    await benchmark('SQLite worker insert (1,000 new candles per batch)', 5,
      async index => { await store.appendCandles(batches[index]) },
      async index => { await verifyMutation(baselineRows + (index + 1) * candles.length, true) }),
    await benchmark('SQLite worker correction (1,000 changed candles)', 5,
      async index => { await store.appendCandles(corrections[index]) }, async index => {
        await verifyMutation(baselineRows + batches.length * candles.length, true)
        const saved = await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 999 * 300_000 })
        assert.equal(saved.length, candles.length)
        assert.ok(saved.every((row: { close: number }, offset: number) => row.close === corrections[index][offset].close))
      }),
    await benchmark('SQLite worker deduplication (1,000 unchanged candles)', 5,
      async () => { await store.appendCandles(corrections.at(-1)!) },
      async () => { await verifyMutation(baselineRows + batches.length * candles.length, false) }),
    await benchmark('SQLite worker range query (1,000 candles)', 20, async () => { await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 999 * 300_000 }) }),
    await benchmark('SQLite chart window (15 days of appends)', 20, async () => { await store.candles(window) }),
    await benchmark('Coverage (15 days of appends)', 20, async () => { await store.coverage('BTC-USDT-SWAP', '5m') }),
    await benchmark('Gap detection, 295 slots (15 days of appends)', 20, async () => { await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base - day, through: base - day + 294 * 300_000 }) }),
  ]
  console.table(results)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), measurement: 'Operation latency excludes post-operation correctness checks; each insert uses distinct timestamps. Corrections and duplicate facts have separate scenarios.', results }, null, 2))
} finally { await store.close(); await rm(root, { recursive: true, force: true }) }
