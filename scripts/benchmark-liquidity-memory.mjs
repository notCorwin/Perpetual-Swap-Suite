#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const modulePath = process.argv[2]
if (!modulePath || !globalThis.gc) throw new Error('Usage: node --expose-gc benchmark-liquidity-memory.mjs LIQUIDITY_MODULE')
const { createLiquidityEvaluator } = await import(pathToFileURL(resolve(modulePath)).href)
const config = { spread: { enabled: true, maxPercent: 0.05 }, depth: { enabled: true, minUSDT: 100_000 },
  slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
  openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 } }
const inputs = Array.from({ length: 512 }, (_, index) => {
  const base = `T${index}`
  return { instrument: { instId: `${base}-USDT-SWAP`, instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', instCategory: '1', ruleType: 'normal', ctVal: '0.01', ctMult: '1', ctValCcy: base, expTime: '' },
    config, ticker: { bidPx: '100', askPx: '100.01' }, openInterest: { oiUsd: '6000000' }, turnover24hUSDT: 40_000_000,
    book: { bids: Array.from({ length: 400 }, (_, level) => [(100 - level * 0.01).toFixed(2), '1000000']),
      asks: Array.from({ length: 400 }, (_, level) => [(100.01 + level * 0.01).toFixed(2), '1000000']) } }
})
const collect = () => { globalThis.gc(); return process.memoryUsage().heapUsed }
const inputHeap = collect(), evaluate = createLiquidityEvaluator()
let checksum = 0
const coldCPUStart = process.cpuUsage(), coldStarted = performance.now()
for (const input of inputs) checksum += evaluate(input).depthBid
const coldCPU = process.cpuUsage(coldCPUStart)
const coldTiming = { cpuMS: (coldCPU.user + coldCPU.system) / 1_000, wallMS: performance.now() - coldStarted }
const coldHeap = collect()
for (const input of inputs) {
  const previousBook = input.book
  const bids = input.book.bids.map(level => [...level]), asks = input.book.asks.map(level => [...level])
  bids[100][1] = '1000001'; asks[300][1] = '1000001'
  input.book = { bids, asks }
  checksum += evaluate(input, previousBook).depthAsk
}
const warmHeap = collect()
console.log(JSON.stringify({ instruments: inputs.length, levelsPerSide: 400, inputHeapBytes: inputHeap,
  coldHeapBytes: coldHeap, warmHeapBytes: warmHeap, coldIncrementBytes: coldHeap - inputHeap,
  warmIncrementBytes: warmHeap - inputHeap, coldTiming, checksum }))
