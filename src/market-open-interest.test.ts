import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MarketOpenInterest } from '../electron/services/market-open-interest.js'

const observation = (instId = 'BTC-USDT-SWAP', oiUsd: string | number = '6000000') => ({ instId, oiUsd })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('150 contract checks share one bulk OI source and its unchanged observation leases', async () => {
  const source = deferred<unknown>()
  const calls: unknown[][] = []
  let now = 100_000
  const service = new MarketOpenInterest(async (...args) => { calls.push(args); return source.promise }, () => now)
  const checks = Array.from({ length: 150 }, () => service.observe())
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), ['/public/open-interest', { instType: 'SWAP' }])
  assert.equal(calls[0][3], 'foreground')
  now += 1_000
  const values = Array.from({ length: 150 }, (_, index) => observation(`COIN${index}-USDT-SWAP`, index * 1_000_000))
  source.resolve(values)
  const snapshots = await Promise.all(checks)
  assert.ok(snapshots.every(value => value === snapshots[0]))
  assert.equal(snapshots[0].size, 150)
  assert.deepEqual(snapshots[0].get('COIN0-USDT-SWAP'), { value: values[0], observedAt: now, expiresAt: now + 90_000 })
  now += 29_999
  assert.equal(await service.observe(), snapshots[0])
  assert.equal(calls.length, 1)
  assert.equal(snapshots[0].get('COIN0-USDT-SWAP')?.observedAt, 101_000, 'Reading the cache cannot renew a source lease.')
})

test('fresh bulk scans bypass reusable cache, join an active acquisition, and retain exact source membership', async () => {
  let now = 100_000
  let calls = 0
  const next = deferred<unknown>()
  const service = new MarketOpenInterest(async () => {
    calls += 1
    return calls === 1 ? [observation(), observation('ETH-USDT-SWAP')] : next.promise
  }, () => now)
  const initial = await service.observe()
  now += 1
  const forced = service.observe(undefined, 'foreground', true)
  const joined = service.observe(undefined, 'foreground', true)
  await Promise.resolve()
  assert.equal(calls, 2)
  next.resolve([observation('ETH-USDT-SWAP', '8000000')])
  const current = await forced
  assert.equal(await joined, current)
  assert.notEqual(current, initial)
  assert.equal(current.has('BTC-USDT-SWAP'), false, 'An omitted contract must not receive a synthetic observation.')
  assert.equal(current.get('ETH-USDT-SWAP')?.observedAt, now)
})

test('cache reuse ends at 30 seconds and failed snapshots never renew or replace the successful source', async () => {
  let now = 100_000, calls = 0
  let result: unknown = [observation()]
  const service = new MarketOpenInterest(async () => { calls += 1; return result }, () => now)
  const initial = await service.observe()
  now += 30_000
  result = []
  await assert.rejects(service.observe(), /no swap open-interest/)
  assert.equal(initial.get('BTC-USDT-SWAP')?.expiresAt, 190_000)
  result = [observation('ETH-USDT-SWAP')]
  const recovered = await service.observe()
  assert.equal(calls, 3, 'The failed request cannot be reused as a successful snapshot.')
  assert.equal(recovered.has('BTC-USDT-SWAP'), false)
  assert.equal(recovered.get('ETH-USDT-SWAP')?.observedAt, now)
})

test('malformed, duplicate, and empty OI snapshots reject without caching their partial data', async () => {
  let result: unknown
  let calls = 0
  const service = new MarketOpenInterest(async () => { calls += 1; return result })
  const invalid: unknown[] = [null, [], {}, [observation(), observation()], [observation(), { oiUsd: '1' }],
    [observation('BTC-USDT', '1')], [observation('BTC-USDT-SWAP', '')], [observation('BTC-USDT-SWAP', 'NaN')],
    [observation('BTC-USDT-SWAP', '-1')], [{ ...observation(), oiUsd: null }], [{ ...observation(), oiUsd: [] }]]
  for (result of invalid) await assert.rejects(service.observe(), /open-interest/)
  result = [observation('BTC-USD-SWAP', '0')]
  const recovered = await service.observe()
  assert.equal(calls, invalid.length + 1)
  assert.equal(recovered.get('BTC-USD-SWAP')?.value.oiUsd, '0')
})

test('one canceled consumer cannot abort a shared OI source that another consumer still needs', async () => {
  const source = deferred<unknown>()
  let transportSignal!: AbortSignal
  const service = new MarketOpenInterest(async (_path, _parameters, signal) => { transportSignal = signal; return source.promise })
  const controller = new AbortController()
  const canceled = service.observe(controller.signal)
  const surviving = service.observe()
  await Promise.resolve()
  controller.abort(new Error('The first scan retired.'))
  await assert.rejects(canceled, /scan retired/)
  assert.equal(transportSignal.aborted, false)
  source.resolve([observation()])
  assert.equal((await surviving).size, 1)
})

test('a fully canceled older transport cannot replace a newer successful OI snapshot', async () => {
  const sources = [deferred<unknown>(), deferred<unknown>()]
  const signals: AbortSignal[] = []
  let calls = 0, now = 100_000
  const service = new MarketOpenInterest(async (_path, _parameters, signal) => {
    signals.push(signal)
    return sources[calls++].promise
  }, () => now)
  const controller = new AbortController()
  const old = service.observe(controller.signal)
  await Promise.resolve()
  controller.abort()
  await assert.rejects(old, { name: 'AbortError' })
  assert.equal(signals[0].aborted, true)
  const fresh = service.observe()
  await Promise.resolve()
  assert.equal(calls, 2)
  now += 1_000
  sources[1].resolve([observation('ETH-USDT-SWAP')])
  const latest = await fresh
  now += 1_000
  sources[0].resolve([observation()])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await service.observe(), latest)
  assert.equal(latest.has('BTC-USDT-SWAP'), false)
  assert.equal(latest.get('ETH-USDT-SWAP')?.observedAt, 101_000)
})

test('an already aborted scan receives no OI observations even when a reusable cache exists', async () => {
  let calls = 0
  const service = new MarketOpenInterest(async () => { calls += 1; return [observation()] })
  await service.observe()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.observe(controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
})
