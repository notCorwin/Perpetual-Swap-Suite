import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MarketBook } from '../electron/services/market-book.js'

const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'
const book = (price = 100) => ({ bids: [[String(price), '20']], asks: [[String(price + 1), '30']] })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('REST freshness starts at completion, never extends on reads, and expires at exactly 90 seconds', async () => {
  let now = 100_000, calls = 0
  const result = deferred<unknown>()
  const service = new MarketBook(async () => { calls += 1; return calls === 1 ? result.promise : [book(200)] }, () => now)
  const pending = service.observe(btc)
  await Promise.resolve()
  now += 1_000
  result.resolve([book()])
  const first = await pending
  assert.deepEqual(first, { value: book(), observedAt: 101_000, expiresAt: 191_000 })
  for (now of [102_000, 150_000, 190_999]) {
    assert.equal(await service.observe(btc), first)
    assert.equal(first.observedAt, 101_000)
    assert.equal(first.expiresAt, 191_000)
  }
  assert.equal(calls, 1)
  now = 191_000
  const renewed = await service.observe(btc)
  assert.equal(calls, 2)
  assert.equal(renewed.observedAt, now)
  assert.equal(renewed.expiresAt, now + 90_000)
  assert.deepEqual(renewed.value, book(200))
})

test('candidate and recovery waiters share one request for the same instrument', async () => {
  const result = deferred<unknown>()
  const calls: unknown[][] = []
  const service = new MarketBook(async (...args) => { calls.push(args); return result.promise })
  const candidate = service.observe(btc)
  const recovery = service.observe(btc, undefined, 'continuity')
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), ['/market/books', { instId: btc, sz: '400' }])
  assert.equal(calls[0][3], 'foreground')
  assert.ok(calls[0][2] instanceof AbortSignal)
  result.resolve([book()])
  assert.equal(await candidate, await recovery)
})

test('different instruments have independent requests, snapshots, and cancellation', async () => {
  const results = new Map([[btc, deferred<unknown>()], [eth, deferred<unknown>()]])
  const signals = new Map<string, AbortSignal>(), priorities = new Map<string, string>()
  const service = new MarketBook(async (_path, parameters, signal, priority) => {
    signals.set(parameters.instId, signal); priorities.set(parameters.instId, priority)
    return results.get(parameters.instId)!.promise
  })
  const controller = new AbortController()
  const first = service.observe(btc, controller.signal)
  const second = service.observe(eth, undefined, 'continuity')
  const canceled = assert.rejects(first, { name: 'AbortError' })
  await Promise.resolve()
  assert.equal(signals.size, 2)
  assert.equal(priorities.get(eth), 'continuity')
  controller.abort()
  await canceled
  assert.equal(signals.get(btc)!.aborted, true)
  assert.equal(signals.get(eth)!.aborted, false)
  results.get(eth)!.resolve([book(200)])
  const snapshot = await second
  assert.deepEqual(snapshot.value, book(200))
  assert.equal(await service.observe(eth), snapshot)
  results.get(btc)!.resolve([book()])
  await flush()
})

test('one canceled waiter does not abort the transport needed by another waiter', async () => {
  const result = deferred<unknown>()
  let transportSignal!: AbortSignal
  const service = new MarketBook(async (_path, _parameters, signal) => { transportSignal = signal; return result.promise })
  const controller = new AbortController(), reason = new Error('Candidate retired.')
  const first = service.observe(btc, controller.signal)
  const surviving = service.observe(btc, undefined, 'continuity')
  const canceled = assert.rejects(first, error => error === reason)
  await Promise.resolve()
  controller.abort(reason)
  await canceled
  assert.equal(transportSignal.aborted, false)
  result.resolve([book()])
  assert.deepEqual((await surviving).value, book())
  assert.equal(transportSignal.aborted, false, 'A successful acquisition must not abort its transport.')
})

test('only the last waiter aborts a transport, and its late result cannot replace a new snapshot', async () => {
  const results = [deferred<unknown>(), deferred<unknown>()], signals: AbortSignal[] = []
  let calls = 0, now = 100_000
  const service = new MarketBook(async (_path, _parameters, signal) => {
    signals.push(signal); return results[calls++].promise
  }, () => now)
  const a = new AbortController(), b = new AbortController()
  const first = service.observe(btc, a.signal), second = service.observe(btc, b.signal)
  const canceled = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]
  await Promise.resolve()
  a.abort()
  assert.equal(signals[0].aborted, false)
  b.abort()
  await Promise.all(canceled)
  assert.equal(signals[0].aborted, true)
  const replacement = service.observe(btc)
  await Promise.resolve()
  assert.equal(calls, 2)
  now += 1_000
  results[1].resolve([book(200)])
  const latest = await replacement
  now += 1_000
  results[0].resolve([book()])
  await flush()
  assert.equal(await service.observe(btc), latest)
  assert.equal(latest.observedAt, 101_000)
})

test('cancellation before the transport starts performs no REST call', async () => {
  let calls = 0
  const service = new MarketBook(async () => { calls += 1; return [book()] })
  const controller = new AbortController()
  const pending = service.observe(btc, controller.signal)
  const canceled = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await canceled
  await flush()
  assert.equal(calls, 0)
  await service.observe(btc)
  assert.equal(calls, 1)
  await assert.rejects(service.observe(btc, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1, 'An already aborted waiter cannot consume a cached snapshot.')
})

test('fresh supplied memory bypasses REST, preserves its lease and metadata, and owns stable book arrays', async () => {
  let calls = 0, now = 150_000
  const service = new MarketBook(async () => { calls += 1; return [book(200)] }, () => now)
  const value = { ...book(), ts: '100000' }
  const current = { value, observedAt: 100_000, expiresAt: 190_000, source: 'websocket' }
  const first = await service.observe(btc, undefined, 'foreground', current)
  now += 39_999
  const repeated = await service.observe(btc, undefined, 'continuity', current)
  assert.equal(calls, 0)
  assert.equal(repeated.observedAt, 100_000)
  assert.equal(repeated.expiresAt, 190_000)
  assert.equal(repeated.source, 'websocket')
  value.bids[0][1] = '999'
  assert.equal(first.value.bids[0][1], '20')
  assert.equal(Object.isFrozen(value.bids[0]), false, 'Do not freeze caller-owned memory.')
  now = 190_000
  assert.deepEqual((await service.observe(btc, undefined, 'foreground', current)).value, book(200))
  assert.equal(calls, 1, 'The original memory lease expires at equality.')
})

test('installing returned observations preserves immutable book identity across threshold reevaluations', async () => {
  let now = 100_000, calls = 0
  const service = new MarketBook(async () => { calls += 1; return [book()] }, () => now)
  const rest = await service.observe(btc)
  now += 1
  assert.equal(await service.observe(btc, undefined, 'foreground', rest), rest)
  const decorated = await service.observe(btc, undefined, 'foreground', { ...rest, source: 'rest' })
  assert.equal(decorated.value, rest.value)
  assert.equal(decorated.observedAt, rest.observedAt)
  service.invalidate(btc)
  const live = await service.observe(btc, undefined, 'foreground', { value: book(200), observedAt: now, expiresAt: now + 90_000, source: 'websocket' })
  now += 1
  assert.equal(await service.observe(btc, undefined, 'foreground', live), live)
  assert.equal(await service.observe(btc), live)
  assert.equal(calls, 1)
})

test('stale, future, or malformed supplied memory cannot bypass REST', async () => {
  let calls = 0
  const service = new MarketBook(async () => { calls += 1; return [book()] }, () => 100_000)
  const invalid = [
    { value: book(), observedAt: 0, expiresAt: 100_000 },
    { value: book(), observedAt: 100_001, expiresAt: 190_001 },
    { value: book(), observedAt: NaN, expiresAt: 190_000 },
    { value: book(), observedAt: 90_000, expiresAt: Infinity },
    { value: { bids: [], asks: [] }, observedAt: 90_000, expiresAt: 180_000 },
  ]
  for (const current of invalid) {
    service.invalidate(btc)
    assert.deepEqual((await service.observe(btc, undefined, 'foreground', current)).value, book())
  }
  assert.equal(calls, invalid.length)
})

test('malformed and empty REST books never cache partial data, while zero sizes and optional metadata are accepted', async () => {
  let result: unknown, calls = 0
  const service = new MarketBook(async () => { calls += 1; return result })
  const invalid: unknown[] = [null, [], {}, [null], [{}], [{ bids: [], asks: [] }],
    [{ bids: [['1', '1']], asks: {} }], [{ bids: [['1', '1']], asks: [['2']] }],
    [{ bids: [['0', '1']], asks: [['2', '1']] }], [{ bids: [['1', '-1']], asks: [['2', '1']] }],
    [{ bids: [['1', '1']], asks: [['2', 'NaN']] }], [{ bids: [['1', '1']], asks: [['2', '']] }],
    [{ bids: [[true, '1']], asks: [['2', '1']] }], [{ bids: [['1', null]], asks: [['2', '1']] }],
    [{ bids: [['0x10', '1']], asks: [['20', '1']] }], [{ bids: [['1', '1']], asks: [['Infinity', '1']] }],
    [{ ...book(), ts: 'bad' }], [{ ...book(), ts: null }], [{ ...book(), ts: -1 }], [{ ...book(), ts: 1.5 }],
    [{ bids: [['1', '1'], ...Array<unknown>(1), ['0.9', '1']], asks: [['2', '1']] }]]
  for (result of invalid) await assert.rejects(service.observe(btc), /order-book/)
  result = [{ bids: [[100, 0, '0', '1'], ['9.9e1', '1']], asks: [['101', 0], [102, '2']], ts: '100000' }]
  const recovered = await service.observe(btc)
  assert.equal(calls, invalid.length + 1)
  assert.deepEqual(recovered.value, (result as unknown[])[0])
  assert.equal(await service.observe(btc), recovered)
})

test('successful REST snapshots cannot be mutated through raw responses or consumer reads', async () => {
  const raw = book()
  const service = new MarketBook(async () => [raw])
  const snapshot = await service.observe(btc)
  raw.bids[0][1] = '999'
  raw.asks.push(['999', '999'])
  assert.deepEqual(snapshot.value, book())
  assert.throws(() => { (snapshot.value.bids[0] as string[])[1] = '123' }, TypeError)
  assert.throws(() => { (snapshot.value.asks as string[][]).push(['999', '999']) }, TypeError)
  assert.throws(() => { (snapshot as { observedAt: number }).observedAt += 1 }, TypeError)
  assert.equal(await service.observe(btc), snapshot)
})

test('failed REST acquisitions are not cached and never renew expired successful observations', async () => {
  let now = 100_000, calls = 0
  const service = new MarketBook(async () => {
    calls += 1
    if (calls === 2) throw new Error('Transport failed.')
    return [book(calls * 100)]
  }, () => now)
  const first = await service.observe(btc)
  now += 90_000
  await assert.rejects(service.observe(btc), /Transport failed/)
  assert.equal(first.observedAt, 100_000)
  assert.equal(first.expiresAt, 190_000)
  const recovered = await service.observe(btc)
  assert.equal(calls, 3)
  assert.deepEqual(recovered.value, book(300))
})

test('invalidation clears only one instrument and promptly rejects all its abort-ignoring waiters', async () => {
  const results = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()], signals: AbortSignal[] = []
  let btcCalls = 0
  const service = new MarketBook(async (_path, { instId }, signal) => {
    if (instId === eth) return [book(300)]
    signals.push(signal); return results[btcCalls++].promise
  })
  const unaffected = await service.observe(eth)
  const first = service.observe(btc), second = service.observe(btc, undefined, 'continuity')
  const canceled = [assert.rejects(first, /invalidated/), assert.rejects(second, /invalidated/)]
  await Promise.resolve()
  service.invalidate(btc)
  await Promise.all(canceled)
  assert.equal(signals[0].aborted, true)
  assert.equal(await service.observe(eth), unaffected)
  const replacement = service.observe(btc)
  await Promise.resolve()
  results[0].resolve([book()])
  await flush()
  const joined = service.observe(btc)
  await Promise.resolve()
  assert.equal(btcCalls, 2, 'Retired completion cannot remove a replacement acquisition.')
  results[1].resolve([book(200)])
  const latest = await replacement
  assert.equal(await joined, latest)
  assert.equal(await service.observe(btc), latest)
  service.invalidate(btc)
  const refreshed = service.observe(btc)
  await Promise.resolve()
  assert.equal(btcCalls, 3)
  results[2].resolve([book(400)])
  assert.deepEqual((await refreshed).value, book(400))
})

test('disposal promptly rejects every waiter, rejects future reads, and ignores late transports', async () => {
  const results = new Map([[btc, deferred<unknown>()], [eth, deferred<unknown>()]])
  const signals: AbortSignal[] = []
  let calls = 0
  const service = new MarketBook(async (_path, { instId }, signal) => {
    calls += 1; signals.push(signal); return results.get(instId)!.promise
  })
  const first = service.observe(btc), second = service.observe(btc), third = service.observe(eth)
  const canceled = [first, second, third].map(promise => assert.rejects(promise, /disposed/))
  await Promise.resolve()
  service.dispose()
  service.dispose()
  await Promise.all(canceled)
  assert.ok(signals.every(signal => signal.aborted))
  for (const result of results.values()) result.resolve([book()])
  await flush()
  await assert.rejects(service.observe(btc), /disposed/)
  await assert.rejects(service.observe(eth, undefined, 'foreground', { value: book(), observedAt: Date.now(), expiresAt: Date.now() + 90_000 }), /disposed/)
  assert.equal(calls, 2)
})
