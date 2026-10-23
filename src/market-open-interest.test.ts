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
  now += 89_999
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

test('cache reuse ends at its 90-second lease and a failed snapshot cannot renew or replace the successful source', async () => {
  let now = 100_000, calls = 0
  let result: unknown = [observation()]
  const service = new MarketOpenInterest(async () => { calls += 1; return result }, () => now)
  const initial = await service.observe()
  now += 90_000
  result = []
  await assert.rejects(service.observe(), /no swap open-interest/)
  assert.equal(initial.get('BTC-USDT-SWAP')?.expiresAt, 190_000)
  assert.equal(service.retryAt, now + 1_000)
  result = [observation('ETH-USDT-SWAP')]
  await assert.rejects(service.observe(), /no swap open-interest/)
  assert.equal(calls, 2, 'An expired snapshot cannot be returned while its source is cooling down.')
  now = service.retryAt
  const recovered = await service.observe()
  assert.equal(calls, 3, 'The failed request cannot be reused as a successful snapshot.')
  assert.equal(recovered.has('BTC-USDT-SWAP'), false)
  assert.equal(recovered.get('ETH-USDT-SWAP')?.observedAt, now)
  assert.equal(service.retryAt, 0)
})

test('malformed, duplicate, and empty OI snapshots reject without caching their partial data', async () => {
  let result: unknown
  let calls = 0, now = 100_000
  const service = new MarketOpenInterest(async () => { calls += 1; return result }, () => now)
  const invalid: unknown[] = [null, [], {}, [observation(), observation()], [observation(), { oiUsd: '1' }],
    [observation('BTC-USDT', '1')], [observation('BTC-USDT-SWAP', '')], [observation('BTC-USDT-SWAP', 'NaN')],
    [observation('BTC-USDT-SWAP', '-1')], [{ ...observation(), oiUsd: null }], [{ ...observation(), oiUsd: [] }]]
  for (result of invalid) {
    await assert.rejects(service.observe(), /open-interest/)
    now = service.retryAt
  }
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

test('staggered candidates and explicit refreshes share one source failure deadline', async () => {
  let now = 100_000, calls = 0
  const failure = new Error('The bulk source is unavailable.')
  const service = new MarketOpenInterest(async () => { calls += 1; throw failure }, () => now)
  const checks = Array.from({ length: 150 }, (_, index) => service.observe(undefined, index % 2 ? 'foreground' : 'continuity'))
  const results = await Promise.allSettled(checks)
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure))
  const retryAt = service.retryAt
  assert.equal(retryAt, 101_000)
  for (const offset of [1, 100, 999]) {
    now = 100_000 + offset
    await assert.rejects(service.observe(), error => error === failure)
    await assert.rejects(service.observe(undefined, 'foreground', true), error => error === failure)
    assert.equal(service.retryAt, retryAt, 'Rejected callers cannot slide the shared retry deadline.')
  }
  assert.equal(calls, 1)
  now = retryAt
  await assert.rejects(service.observe(), error => error === failure)
  assert.equal(calls, 2)
  assert.equal(service.retryAt, now + 2_000)
})

test('OI retries use bounded exponential backoff and reset only after a successful acquisition', async () => {
  let now = 100_000, calls = 0, healthy = false
  const service = new MarketOpenInterest(async () => {
    calls += 1
    if (!healthy) throw new Error('Unavailable.')
    return [observation()]
  }, () => now)
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]) {
    await assert.rejects(service.observe(), /Unavailable/)
    assert.equal(service.retryAt, now + delay)
    now = service.retryAt
  }
  healthy = true
  await service.observe()
  assert.equal(service.retryAt, 0)
  healthy = false
  await assert.rejects(service.observe(undefined, 'foreground', true), /Unavailable/)
  assert.equal(service.retryAt, now + 1_000)
  assert.equal(calls, 10)
})

test('a failed explicit refresh leaves a fresh successful snapshot reusable until its original expiry', async () => {
  let now = 100_000, calls = 0
  const failure = Object.assign(new Error('Rate limited.'), { retryAfter: 120_000 })
  const service = new MarketOpenInterest(async () => {
    if (++calls > 1) throw failure
    return [observation()]
  }, () => now)
  const snapshot = await service.observe()
  now += 1_000
  await assert.rejects(service.observe(undefined, 'foreground', true), error => error === failure)
  assert.equal(service.retryAt, now + 120_000)
  assert.equal(await service.observe(), snapshot, 'A source failure cannot erase still-valid evidence.')
  now = 189_999
  assert.equal(await service.observe(), snapshot)
  now += 1
  await assert.rejects(service.observe(), error => error === failure)
  assert.equal(calls, 2)
  assert.equal(snapshot.get('BTC-USDT-SWAP')?.observedAt, 100_000)
  assert.equal(snapshot.get('BTC-USDT-SWAP')?.expiresAt, 190_000)
})

test('shared retry deadlines honor server millisecond delays and raw Retry-After headers', async () => {
  const now = Date.UTC(2026, 9, 23)
  for (const [properties, delay] of [
    [{ retryAfter: 120_000 }, 120_000],
    [{ headers: new Headers({ 'Retry-After': '65' }) }, 65_000],
    [{ response: { headers: { 'Retry-After': new Date(now + 90_000).toUTCString() } } }, 90_000],
    [{ retryAfter: 30_000, headers: { 'retry-after': '60' } }, 60_000],
    [{ retryAfter: -1, headers: { 'retry-after': '-1' } }, 1_000],
    [{ retryAfter: NaN, headers: { 'retry-after': 'invalid' } }, 1_000],
  ] as const) {
    const failure = Object.assign(new Error('Rate limited.'), properties)
    const service = new MarketOpenInterest(async () => { throw failure }, () => now)
    await assert.rejects(service.observe(), error => error === failure)
    assert.equal(service.retryAt, now + delay)
  }
})

test('last-consumer cancellation does not create a cooldown even when transport fails after a replacement succeeds', async () => {
  let now = 100_000, calls = 0
  const oldSource = deferred<unknown>()
  const controller = new AbortController()
  const service = new MarketOpenInterest(async () => ++calls === 1 ? oldSource.promise : [observation()], () => now)
  const old = service.observe(controller.signal)
  await Promise.resolve()
  controller.abort(new Error('The scan retired deliberately.'))
  await assert.rejects(old, /retired deliberately/)
  assert.equal(service.retryAt, 0)
  const latest = await service.observe()
  oldSource.reject(Object.assign(new Error('Old transport failure.'), { retryAfter: 120_000 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.retryAt, 0)
  now += 1
  assert.equal(await service.observe(), latest)
  assert.equal(calls, 2)
})

test('canceling the only consumer before acquisition prevents GET without creating a cooldown', async () => {
  let calls = 0
  const service = new MarketOpenInterest(async () => { calls += 1; return [observation()] })
  const controller = new AbortController()
  const canceled = service.observe(controller.signal)
  controller.abort()
  await assert.rejects(canceled, { name: 'AbortError' })
  assert.equal(calls, 0)
  assert.equal(service.retryAt, 0)
  assert.equal((await service.observe()).size, 1)
  assert.equal(calls, 1)
})
