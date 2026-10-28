import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../electron/services/market-store.js'
import { attachOperationSink } from '../electron/services/operations.js'

const step = 300_000, base = Date.UTC(2024, 0, 1)
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 4 * step }
const candle = (index: number, close = 100, instrument = query.instrument) => ({ instrument, timeframe: '5m', timestamp: base + index * step,
  open: 100, high: Math.max(101, close), low: 99, close, volume: 1, baseVolume: 1, quoteVolume: 100, confirmed: true })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-candle-reuse-')), store = await MarketStore.open(root)
  await (store as any).migrationReady
  return { root, store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }) } }
}
const requests = (store: MarketStore) => store.getDiagnostics().reads.requests
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for a worker request.'); await turn() }
}

// Hold real worker messages after SQLite has executed and before the store's
// main-thread response handler observes them. The worker itself is unchanged.
function controlledTransport(store: MarketStore) {
  const internal = store as any, workers = [...internal.readers.workers, ...internal.writer.workers]
  const originals = new Map<any, (...args: any[]) => any>(), holds: any[] = []
  for (const worker of workers) {
    const emit = worker.emit; originals.set(worker, emit)
    worker.emit = function (event: string, ...args: any[]) {
      if (event === 'message' && worker.current) {
        const hold = holds.find(value => !value.message && value.active && value.predicate(worker.current, args[0]))
        if (hold) { hold.worker = worker; hold.message = args[0]; hold.reached.resolve({ job: worker.current, message: args[0] }); return true }
      }
      return emit.call(worker, event, ...args)
    }
  }
  const release = (hold: any, replacement?: any) => {
    if (!hold.active) return
    hold.active = false
    if (hold.message) originals.get(hold.worker)!.call(hold.worker, 'message', replacement ?? hold.message)
  }
  return {
    hold(predicate: (job: any, message: any) => boolean) {
      let resolve!: (value: any) => void
      const promise = new Promise<any>(done => { resolve = done })
      const hold = { predicate, reached: { promise, resolve }, active: true, message: null, worker: null }
      holds.push(hold)
      return { reached: hold.reached.promise, release: (replacement?: any) => release(hold, replacement) }
    },
    restore() { for (const hold of holds) release(hold); for (const [worker, emit] of originals) worker.emit = emit },
  }
}

test('candle queries own normalized parameters and return independent rows on misses and hits', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([0, 1, 2, 3, 4].map(index => candle(index)))
    const mutable = { ...query, through: base + step }, task = f.store.candles(mutable)
    mutable.through = query.through; mutable.instrument = 'OTHER-USDT-SWAP'
    const first = await task
    assert.deepEqual(first.map(row => row.timestamp), [base, base + step])
    const expected = first.map(row => ({ ...row })), before = requests(f.store)
    first[0].close = -1; first[0].statisticsOIExpiresAt = 123; first.push({ ...first[0] })
    const hit = await f.store.candles({ ...query, through: base + step })
    assert.deepEqual(hit, expected)
    assert.equal(requests(f.store), before, 'A repeated query skips the actual reader request.')
    hit[0].close = -2
    assert.deepEqual(await f.store.candles({ ...query, through: base + step }), expected)

    const defaults = { instrument: query.instrument, timeframe: query.timeframe }
    assert.deepEqual((await f.store.candles(defaults)).map(row => row.timestamp), [0, 1, 2, 3, 4].map(index => base + index * step))
    const defaultCount = requests(f.store)
    assert.equal((await f.store.candles({ ...defaults, from: 0, through: Number.MAX_SAFE_INTEGER, limit: undefined, order: 'asc' })).length, 5)
    assert.equal(requests(f.store), defaultCount, 'Explicit defaults use the same SQL semantics.')
    assert.deepEqual((await f.store.candles({ ...query, from: base + step, through: base + 3 * step, limit: 2, order: 'desc' })).map(row => row.timestamp), [base + 3 * step, base + 2 * step])
    assert.deepEqual((await f.store.candles({ ...query, from: base + step, through: base + 3 * step, limit: 2, order: 'asc' })).map(row => row.timestamp), [base + step, base + 2 * step])
    assert.deepEqual((await f.store.candles({ ...query, from: base + 2 * step, through: base + 3 * step })).map(row => row.timestamp), [base + 2 * step, base + 3 * step])
    await assert.rejects(f.store.candles({ ...query, order: 'sideways' } as any), /order/)
  } finally { await f.close() }
})

test('all-source revisions invalidate related writes while unrelated commits preserve reuse', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([candle(0)])
    const original = await f.store.candles(query), firstCount = requests(f.store)
    await f.store.appendCandles([candle(0, 100, 'ETH-USDT-SWAP')])
    assert.deepEqual(await f.store.candles(query), original)
    assert.equal(requests(f.store), firstCount)
    await f.store.appendCandles([candle(0, 110)])
    assert.equal((await f.store.candles(query))[0].close, 110)
    const priceRevision = f.store.candlePriceRevision(query.instrument, query.timeframe)
    await f.store.appendStatistics({ ...query, through: base, source: 'oi', values: [[base, 1234]], observedAt: 123, expiresAt: 500 })
    assert.equal(f.store.candlePriceRevision(query.instrument, query.timeframe), priceRevision)
    assert.equal((await f.store.candles(query))[0].oi, 1234)
    await f.store.appendStatistics({ ...query, through: base, source: 'taker', values: [[base, 2, 3]], observedAt: 124, expiresAt: 501 })
    assert.deepEqual([(await f.store.candles(query))[0].sell, (await f.store.candles(query))[0].buy], [2, 3])
    await f.store.appendStatistics({ ...query, from: base + step, through: base + step, source: 'oi', values: [], observedAt: 125, expiresAt: 502 })
    await f.store.appendCandles([candle(1)])
    const [first, second] = await f.store.candles(query)
    assert.equal(first.oi, 1234); assert.equal(second.oi, null); assert.equal(second.statisticsOIExpiresAt, 502)
    const beforeRenewal = f.store.candlePriceRevision(query.instrument, query.timeframe)
    await f.store.appendStatistics({ ...query, from: base + step, through: base + step, source: 'oi', values: [], observedAt: 126, expiresAt: 503 })
    const renewed = (await f.store.candles(query))[1]
    assert.equal(f.store.candlePriceRevision(query.instrument, query.timeframe), beforeRenewal)
    assert.equal(renewed.statisticsOIExpiresAt, 503); assert.equal(renewed.statisticsOIAbsenceAttempts, 2)
    await f.store.replaceCandles({ ...query, through: base + step }, [])
    assert.deepEqual(await f.store.candles(query), [])
    // Migration writes go directly through the same writer protocol, without a
    // public append operation around them.
    await (f.store as any).writer.request('append', [[{ ...candle(2), writtenAt: 100 }], { importing: true }])
    assert.deepEqual((await f.store.candles(query)).map(row => row.timestamp), [base + 2 * step])
    const parent = { instrument: query.instrument, timeframe: '15m', from: base, through: base }
    assert.deepEqual(await f.store.candles(parent), [])
    await f.store.appendCandles([candle(0), candle(1), candle(2)])
    await f.store.aggregateCandles({ ...parent, timeframe: '15m' })
    assert.equal((await f.store.candles(parent)).length, 1)
  } finally { await f.close() }
})

test('concurrent reads share a real request and never share mutable results', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    const hold = transport.hold(job => job.command === 'candles'), before = requests(f.store)
    const first = f.store.candles(query, 'foreground')
    await hold.reached
    const second = f.store.candles(query, 'background')
    await turn()
    assert.equal(requests(f.store), before + 1)
    hold.release()
    const [a, b] = await Promise.all([first, second])
    assert.notEqual(a, b); assert.notEqual(a[0], b[0])
    a[0].close = 999; a.pop()
    assert.equal(b[0].close, 100)
    assert.equal((await f.store.candles(query))[0].close, 100)
  } finally { transport.restore(); await f.close() }
})

test('foreground reads do not join a queued background read of the same query', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    const firstHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === 'BLOCK-A')
    const secondHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === 'BLOCK-B')
    const blockA = f.store.candles({ ...query, instrument: 'BLOCK-A' }), blockB = f.store.candles({ ...query, instrument: 'BLOCK-B' })
    await Promise.all([firstHold.reached, secondHold.reached])
    const backgroundHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === query.instrument && job.priority === 'background')
    const foregroundHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === query.instrument && job.priority === 'foreground')
    const before = requests(f.store), background = f.store.candles(query, 'background'), foreground = f.store.candles(query, 'foreground')
    await until(() => f.store.getDiagnostics().reads.queued === 2)
    assert.equal(requests(f.store), before + 2)
    firstHold.release()
    const foregroundJob = await foregroundHold.reached
    assert.equal(foregroundJob.job.priority, 'foreground')
    foregroundHold.release()
    await backgroundHold.reached
    backgroundHold.release(); secondHold.release()
    assert.equal((await foreground)[0].close, 100); assert.equal((await background)[0].close, 100)
    await Promise.all([blockA, blockB])
  } finally { transport.restore(); await f.close() }
})

test('a committed writer response held in transit cannot expose an old cached read', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    await f.store.candles(query)
    const revision = f.store.candleRevision(query.instrument, query.timeframe)
    const hold = transport.hold(job => job.command === 'append'), writing = f.store.appendCandles([candle(0, 110)])
    await hold.reached
    const db = new DatabaseSync(f.store.path, { readOnly: true })
    try { assert.equal(db.prepare('SELECT close FROM candles WHERE timestamp=?').get(base)!.close, 110) } finally { db.close() }
    assert.equal(f.store.candleRevision(query.instrument, query.timeframe), revision, 'Main has not received the committed mutation yet.')
    let count = requests(f.store)
    const readerHold = transport.hold(job => job.command === 'candles'), readDuringWrite = f.store.candles(query)
    await readerHold.reached
    assert.equal(requests(f.store), ++count, 'An active writer forces a fresh SQL request.')
    hold.release(); await writing
    readerHold.release(); assert.equal((await readDuringWrite)[0].close, 110)
    assert.equal((await f.store.candles(query))[0].close, 110)
    assert.equal(requests(f.store), ++count, 'A read started during a write cannot be admitted later.')
    await f.store.candles(query); assert.equal(requests(f.store), count)
  } finally { transport.restore(); await f.close() }
})

test('a delayed old reader result cannot be admitted under a newer revision', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    const hold = transport.hold(job => job.command === 'candles'), old = f.store.candles(query)
    await hold.reached
    await f.store.appendCandles([candle(0, 110)])
    hold.release()
    assert.equal((await old)[0].close, 100)
    let count = requests(f.store)
    assert.equal((await f.store.candles(query))[0].close, 110)
    assert.equal(requests(f.store), ++count)
    assert.equal((await f.store.candles(query))[0].close, 110); assert.equal(requests(f.store), count)
  } finally { transport.restore(); await f.close() }
})

test('a read is not admitted if any writer task ran while its response was in flight', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    const hold = transport.hold(job => job.command === 'candles'), old = f.store.candles(query)
    await hold.reached
    await f.store.appendCandles([candle(0, 100, 'ETH-USDT-SWAP')])
    hold.release(); assert.equal((await old)[0].close, 100)
    let count = requests(f.store)
    assert.equal((await f.store.candles(query))[0].close, 100)
    assert.equal(requests(f.store), ++count)
    await f.store.candles(query); assert.equal(requests(f.store), count)
  } finally { transport.restore(); await f.close() }
})

test('inspection fences old and in-progress reads around external corruption and repair', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    await f.store.candles(query)
    const oldHold = transport.hold(job => job.command === 'candles' && job.args[0].limit === 1)
    const old = f.store.candles({ ...query, limit: 1 }); await oldHold.reached
    const db = new DatabaseSync(f.store.path)
    try { db.prepare('UPDATE candles SET high=90 WHERE timestamp=?').run(base) } finally { db.close() }
    const revision = f.store.candleRevision(query.instrument, query.timeframe)
    const inspectionHold = transport.hold(job => job.command === 'inspect')
    const inspection = f.store.inspectCandles({ ...query, through: base }); await inspectionHold.reached
    const duringHold = transport.hold(job => job.command === 'candles' && job.args[0].limit === undefined)
    const during = f.store.candles(query)
    oldHold.release(); assert.equal((await old)[0].high, 101)
    await duringHold.reached
    const db2 = new DatabaseSync(f.store.path)
    try { db2.prepare('UPDATE candles SET high=80 WHERE timestamp=?').run(base) } finally { db2.close() }
    inspectionHold.release()
    assert.equal((await inspection).issues[0].reason, 'invalid-ohlc')
    duringHold.release(); assert.equal((await during)[0].high, 90)
    assert.equal(f.store.candleRevision(query.instrument, query.timeframe), revision, 'Inspection changes only the cache epoch.')
    let count = requests(f.store)
    assert.equal((await f.store.candles(query))[0].high, 80)
    assert.equal(requests(f.store), ++count, 'A read started during inspection is never retained.')
    await f.store.replaceCandles({ ...query, through: base }, [candle(0)])
    assert.equal((await f.store.candles(query))[0].high, 101)
    assert.deepEqual((await f.store.inspectCandles({ ...query, through: base })).issues, [])
  } finally { transport.restore(); await f.close() }
})

test('integrity checks and failed inspections retire cached rows without changing business revisions', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    await f.store.candles(query)
    const other = { ...query, instrument: 'ETH-USDT-SWAP' }
    await f.store.candles(other)
    const revision = f.store.candleRevision(query.instrument, query.timeframe)
    const db = new DatabaseSync(f.store.path)
    try { db.prepare('UPDATE candles SET high=90 WHERE timestamp=?').run(base) } finally { db.close() }
    assert.deepEqual(await f.store.integrityCheck(), ['ok'])
    assert.equal((await f.store.candles(query))[0].high, 90)
    const afterIntegrity = requests(f.store)
    await f.store.candles(other)
    assert.equal(requests(f.store), afterIntegrity + 1, 'An integrity check retires every series.')
    const hold = transport.hold(job => job.command === 'inspect'), inspection = f.store.inspectCandles({ ...query, through: base })
    const response = await hold.reached
    hold.release({ ...response.message, result: undefined, error: { name: 'Error', message: 'Injected inspection transport failure' } })
    await assert.rejects(inspection, /Injected inspection transport failure/)
    const count = requests(f.store)
    assert.equal((await f.store.candles(query))[0].high, 90)
    assert.equal(requests(f.store), count + 1)
    const otherCount = requests(f.store)
    await f.store.candles(other)
    assert.equal(requests(f.store), otherCount, 'A series inspection leaves unrelated retained entries reusable.')
    assert.equal(f.store.candleRevision(query.instrument, query.timeframe), revision)
  } finally { transport.restore(); await f.close() }
})

test('inspecting another series preserves an unrelated in-flight read for reuse', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0), candle(0, 100, 'ETH-USDT-SWAP')])
    const hold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === query.instrument)
    const pending = f.store.candles(query)
    await hold.reached
    assert.deepEqual((await f.store.inspectCandles({ ...query, instrument: 'ETH-USDT-SWAP', through: base })).issues, [])
    hold.release()
    assert.equal((await pending)[0].close, 100)
    const count = requests(f.store)
    assert.equal((await f.store.candles(query))[0].close, 100)
    assert.equal(requests(f.store), count, 'A different series inspection cannot invalidate this completed SQL read.')
  } finally { transport.restore(); await f.close() }
})

test('failed shared reads are removed and close joins admitted work without accepting new reads', async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    await f.store.appendCandles([candle(0)])
    const failure = transport.hold(job => job.command === 'candles'), first = f.store.candles(query)
    const response = await failure.reached, second = f.store.candles(query)
    const outcomes = Promise.allSettled([first, second])
    await turn()
    failure.release({ ...response.message, result: undefined, error: { name: 'Error', message: 'Injected read failure' } })
    for (const result of await outcomes) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.match(result.reason.message, /Injected read failure/)
    }
    const hold = transport.hold(job => job.command === 'candles'), retry = f.store.candles(query)
    await hold.reached
    const closing = f.store.close()
    await assert.rejects(f.store.candles(query), /closed/)
    hold.release(); assert.equal((await retry)[0].close, 100); await closing
    await assert.rejects(f.store.candles(query), /closed/)
  } finally { transport.restore(); await f.close() }
})

test('a failed reader pool cannot be hidden by an earlier cached result', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([candle(0)])
    await f.store.candles(query)
    const reader = (f.store as any).readers.workers[0]
    reader.emit('error', new Error('Injected reader pool failure'))
    await assert.rejects(f.store.candles(query), /Injected reader pool failure/)
  } finally { await f.close() }
})

test('closing from an operation observer cannot readmit a result after cache cleanup', async () => {
  const f = await fixture()
  let closing: Promise<void> | undefined
  const detach = attachOperationSink(event => {
    if (event.name === 'market.candle-cache.size' && !closing) closing = f.store.close()
  })
  try {
    await f.store.appendCandles(Array.from({ length: 128 }, (_, index) => candle(index)))
    const rows = await f.store.candles({ ...query, through: base + 127 * step })
    assert.equal(rows.length, 128, 'A previously admitted read still completes during shutdown.')
    assert.ok(closing, 'The actual bulk-work observer must initiate shutdown.')
    await closing
    assert.deepEqual(f.store.getDiagnostics().candleCache, { entries: 0, estimatedBytes: 0, pending: 0, pendingKeyBytes: 0 })
    await assert.rejects(f.store.candles(query), /closed/)
  } finally { detach(); await f.close() }
})

test('pending deduplication is bounded even with long query keys', { timeout: 30_000 }, async () => {
  const f = await fixture(), transport = controlledTransport(f.store)
  try {
    const firstHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === 'BLOCK-A')
    const secondHold = transport.hold(job => job.command === 'candles' && job.args[0].instrument === 'BLOCK-B')
    const blockers = [f.store.candles({ ...query, instrument: 'BLOCK-A' }), f.store.candles({ ...query, instrument: 'BLOCK-B' })]
    await Promise.all([firstHold.reached, secondHold.reached])
    const target = (index: number) => ({ ...query, instrument: `PENDING-${index}-${'X'.repeat(1400)}` })
    const reads = Array.from({ length: 60 }, (_, index) => f.store.candles(target(index)))
    await until(() => f.store.getDiagnostics().reads.queued === 60)
    let count = requests(f.store)
    const shared = f.store.candles(target(0))
    await turn(); assert.equal(requests(f.store), count, 'An admitted pending query still deduplicates.')
    const bypassA = f.store.candles(target(59)), bypassB = f.store.candles(target(59))
    await until(() => requests(f.store) === count + 2)
    count += 2
    firstHold.release(); secondHold.release()
    const results = await Promise.all([...blockers, ...reads, shared, bypassA, bypassB])
    assert.ok(results.every(rows => rows.length === 0))
    assert.equal(requests(f.store), count)
  } finally { transport.restore(); await f.close() }
})

test('cache bounds cover empty results, long keys and large retained results', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const empty = (index: number) => ({ ...query, instrument: `EMPTY-${index}` })
    await f.store.candles(empty(0))
    for (let index = 1; index < 540; index += 1) await f.store.candles(empty(index))
    let count = requests(f.store)
    await f.store.candles(empty(539)); assert.equal(requests(f.store), count)
    await f.store.candles(empty(0)); assert.equal(requests(f.store), ++count, 'Old empty entries are evicted.')
    const long = { ...query, instrument: `LONG-${'X'.repeat(5000)}` }
    await f.store.candles(long); await f.store.candles(long)
    assert.equal(requests(f.store), count + 2, 'Oversized keys cannot consume unbounded retained or pending memory.')

    await f.store.appendCandles(Array.from({ length: 2000 }, (_, index) => candle(index)))
    const large = (index: number) => ({ ...query, from: base + index * step, through: base + 1999 * step })
    const bulkOperations: string[] = []
    const detach = attachOperationSink(event => { if (event.name.startsWith('market.candle-cache.')) bulkOperations.push(event.name) })
    try {
      for (let index = 0; index < 10; index += 1) assert.ok((await f.store.candles(large(index))).length >= 1990)
      assert.ok(bulkOperations.includes('market.candle-cache.snapshot'))
      assert.ok(bulkOperations.includes('market.candle-cache.size'))
      assert.ok(bulkOperations.includes('market.candle-cache.copy'))
    } finally { detach() }
    count = requests(f.store)
    await f.store.candles(large(9)); assert.equal(requests(f.store), count)
    await f.store.candles(large(0)); assert.equal(requests(f.store), count + 1, 'Large rows are bounded by bytes, not just entry count.')
  } finally { await f.close() }
})
