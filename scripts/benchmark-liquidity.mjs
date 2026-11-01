#!/usr/bin/env node
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createLiquidityEvaluator } from '../electron/services/liquidity.js'

// Supply the original module to measure before/after, e.g. a copy of the
// previous liquidity.js with its sibling operations.js in the same directory.
const baselinePath = process.argv[2]
if (!baselinePath) throw new Error('Usage: benchmark-liquidity.mjs BASELINE_MODULE')
const markets = Number(process.argv[3] ?? 1)
if (!Number.isSafeInteger(markets) || markets < 1 || markets > 512) throw new Error('Market count must be between 1 and 512.')
const cold = process.argv[4] === 'cold'
const baselineModule = await import(pathToFileURL(resolve(baselinePath)).href)
const instrument = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', instCategory: '1', ruleType: 'normal', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', expTime: '' }
const config = { spread: { enabled: true, maxPercent: 0.05 }, depth: { enabled: true, minUSDT: 100_000 },
  slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
  openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 } }
const input = { instrument, config, ticker: { bidPx: '100', askPx: '100.01' }, openInterest: { oiUsd: '6000000' }, turnover24hUSDT: 40_000_000 }
const books = Array.from({ length: markets }, () => ({
  bids: Array.from({ length: 400 }, (_, index) => [(100 - index * 0.01).toFixed(2), '1000']),
  asks: Array.from({ length: 400 }, (_, index) => [(100.01 + index * 0.01).toFixed(2), '1000']),
}))
const inputs = Array.from({ length: cold ? markets : Math.max(200, markets * 10) }, (_, index) => {
  const market = index % markets, base = `T${market}`, current = books[market]
  const bids = current.bids.map(level => [...level]), asks = current.asks.map(level => [...level])
  const position = [0, 31, 32, 199, 399][index % 5]
  bids[position][1] = String(1000 + index); asks[399 - position][1] = String(1000 + index)
  books[market] = { bids, asks }
  return { ...input, instrument: { ...instrument, instId: `${base}-USDT-SWAP`, ctValCcy: base }, book: books[market] }
})
const reference = baselineModule.createLiquidityEvaluator(), candidate = createLiquidityEvaluator()
const previous = new Map()
for (const value of inputs) {
  assert.deepEqual(candidate(value, previous.get(value.instrument.instId)), reference(value), 'Each updated book must preserve all business results.')
  previous.set(value.instrument.instId, value.book)
}

const run = factory => {
  const evaluate = factory(), cpuStart = process.cpuUsage(), started = performance.now()
  const prior = new Map()
  for (const value of inputs) { evaluate(value, prior.get(value.instrument.instId)); prior.set(value.instrument.instId, value.book) }
  const cpu = process.cpuUsage(cpuStart)
  return { cpuMS: (cpu.user + cpu.system) / 1000, wallMS: performance.now() - started }
}
// Alternate order to reduce the effect of drift and warm both code paths.
run(baselineModule.createLiquidityEvaluator); run(createLiquidityEvaluator)
const trials = []
for (let index = 0; index < 5; index += 1) {
  const order = index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'], trial = {}
  for (const mode of order) trial[mode] = run(mode === 'baseline' ? baselineModule.createLiquidityEvaluator : createLiquidityEvaluator)
  trials.push(trial)
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const medians = Object.fromEntries(['baseline', 'candidate'].map(mode => [mode, Object.fromEntries(['cpuMS', 'wallMS']
  .map(metric => [metric, median(trials.map(trial => trial[mode][metric]))]))]))
console.log(JSON.stringify({ workload: { markets, updates: inputs.length, cold, levelsPerSide: 400, changedLevelsPerUpdate: 2 }, medians, trials }, null, 2))
