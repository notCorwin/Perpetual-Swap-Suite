import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

type Result = { name: string; iterations: number; medianMS: number; p95MS: number }
const percentile = (values: number[], value: number) => values[Math.min(values.length - 1, Math.floor(values.length * value))]
async function benchmark(name: string, iterations: number, operation: () => Promise<void>): Promise<Result> {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) { const start = performance.now(); await operation(); values.push(performance.now() - start) }
  values.sort((a, b) => a - b)
  return { name, iterations, medianMS: Number(percentile(values, .5).toFixed(3)), p95MS: Number(percentile(values, .95).toFixed(3)) }
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
  const results = [
    await benchmark('SQLite worker append (1,000 candles)', 5, async () => { await store.appendCandles(candles) }),
    await benchmark('SQLite worker range query (1,000 candles)', 20, async () => { await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 999 * 300_000 }) }),
    await benchmark('SQLite chart window (15 days of appends)', 20, async () => { await store.candles(window) }),
    await benchmark('Coverage (15 days of appends)', 20, async () => { await store.coverage('BTC-USDT-SWAP', '5m') }),
    await benchmark('Gap detection, 295 slots (15 days of appends)', 20, async () => { await store.missingCandleRanges({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base - day, through: base - day + 294 * 300_000 }) }),
  ]
  console.table(results)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
} finally { await store.close(); await rm(root, { recursive: true, force: true }) }
