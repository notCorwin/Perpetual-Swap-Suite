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
  const results = [await benchmark('Parquet append (1,000 candles)', 5, async () => { await store.appendCandles(candles) }), await benchmark('DuckDB range query (1,000 candles)', 20, async () => { await store.candles({ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 999 * 300_000 }) })]
  console.table(results)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
} finally { await store.close(); await rm(root, { recursive: true, force: true }) }
