import assert from 'node:assert/strict'
import test from 'node:test'
import { MarketService } from '../electron/services/market-service.js'

const interval = MarketService.prototype.bookSampleInterval
const config = { depth: { enabled: true, minUSDT: 100 }, slippage: { enabled: true, maxPercent: 1 } }
const record = (depth: number, slippage: number | null = null) => ({ result: { checks: [
  { key: 'depth', status: 'unknown', value: depth },
  { key: 'slippage', status: slippage === null ? 'unknown' : 'failed', value: slippage },
] } })

test('book sampling slows down with the magnitude of a measured shortfall', () => {
  assert.equal(interval.call({}, record(95), config), 30_000)
  assert.equal(interval.call({}, record(75), config), 60_000)
  assert.equal(interval.call({}, record(10), config), 120_000)
  assert.equal(interval.call({}, record(95, 3), config), 300_000)
  assert.equal(interval.call({}, { result: { checks: [] } }, config), null)
  assert.equal(interval.call({}, record(0), { ...config, depth: { ...config.depth, enabled: false } }), null)
})

test('a fresh qualifying sample restores the live subscription and publishes its assessment', async () => {
  const instId = 'BTC-USDT-SWAP', instrument = { instId }, sample = { configKey: JSON.stringify(config), next: 0, pending: false }
  const observation = { value: {}, observedAt: Date.now(), expiresAt: Date.now() + 1000 }
  const samples = new Map([[instId, sample]])
  let expires = 0, reads = 0, subscriptions = 0, publications = 0, task: Promise<void> | undefined
  const service = {
    instruments: new Map([[instId, instrument]]), prefs: () => ({ liquidity: config }), candidateIDs: new Set([instId]), bookSamples: samples,
    shutdownController: new AbortController(), books: { expire: () => { expires++ }, observe: async () => { reads++; return observation } },
    currentCandidate: () => true, acceptObservation: () => {}, observations: new Map([[instId, { book: observation }]]),
    liquidityInput: () => ({}), evaluateLiquidity: () => ({ checks: [{ key: 'depth', status: 'verified' }, { key: 'slippage', status: 'verified' }] }),
    bookSampleInterval: interval, observedCandidate: () => ({}), publishStreamRecords: () => { publications++ },
    sourceError: () => {}, scheduleSubscriptions: () => { subscriptions++ }, scheduleBookSamples: () => {}, track: (value: Promise<void>) => { task = value },
  }
  MarketService.prototype.sampleBook.call(service, instId, sample)
  await task
  assert.equal(expires, 1)
  assert.equal(reads, 1)
  assert.equal(samples.size, 0)
  assert.equal(publications, 1)
  assert.equal(subscriptions, 1)
})


test('sampling waits for book retirement and a changed configuration cancels the old sample', () => {
  const id = 'BTC-USDT-SWAP', instrument = { instId: id }, sample = { configKey: JSON.stringify(config), next: 0, pending: false }
  const samples = new Map([[id, sample]])
  let reads = 0, updates = 0
  const service = { instruments: new Map([[id, instrument]]), prefs: () => ({ liquidity: config }), candidateIDs: new Set([id]),
    bookSamples: samples, publicRealtime: { subscriptions: new Map([[`books:${id}`, {}]]) },
    books: { expire: () => {}, observe: () => { reads++ } }, scheduleSubscriptions: () => { updates++ } }
  MarketService.prototype.sampleBook.call(service, id, sample)
  assert.equal(reads, 0)
  assert.ok(sample.next > Date.now())
  sample.configKey = 'old preferences'
  MarketService.prototype.sampleBook.call(service, id, sample)
  assert.equal(samples.size, 0)
  assert.equal(updates, 1)
})

test('failed REST sampling retries without falsely restoring a subscription', async () => {
  const id = 'BTC-USDT-SWAP', instrument = { instId: id }, sample = { configKey: JSON.stringify(config), next: 0, pending: false }
  const samples = new Map([[id, sample]])
  let task: Promise<void> | undefined, errors = 0, restores = 0, priority = ''
  const service = { instruments: new Map([[id, instrument]]), prefs: () => ({ liquidity: config }), candidateIDs: new Set([id]), bookSamples: samples,
    shutdownController: new AbortController(), books: { expire: () => {}, observe: async (_id: string, _signal: AbortSignal, value: string) => { priority = value; throw new Error('unavailable') } },
    sourceError: () => { errors++ }, scheduleSubscriptions: () => { restores++ }, scheduleBookSamples: () => {}, track: (value: Promise<void>) => { task = value } }
  MarketService.prototype.sampleBook.call(service, id, sample)
  await task
  assert.equal(priority, 'background')
  assert.equal(samples.get(id), sample)
  assert.ok(sample.next >= Date.now() + 29_000)
  assert.equal(sample.pending, false)
  assert.equal(errors, 1)
  assert.equal(restores, 0)
})
