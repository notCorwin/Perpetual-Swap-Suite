import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const step: Record<string, number> = { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const waitFor = async (predicate: () => boolean) => {
  const until = performance.now() + 10_000
  while (!predicate()) { if (performance.now() >= until) throw new Error('Timed out waiting for history work.'); await setImmediate() }
}
const micros = (stamp: number) => {
  const index = Math.floor(stamp / step['5m']), small = BigInt(1 + index % 4)
  return { volume: 1_000_000n + small, baseVolume: index % 2 ? 1_000_000_000_000_000n : small,
    quoteVolume: index % 2 ? 1_000_000_000_000_000_000n : small }
}
const fine = (stamp: number) => {
  const index = Math.floor(stamp / step['5m']), open = 100 + index % 100, quantity = micros(stamp)
  return { open, high: open + 2, low: open - 2, close: open + 1, volume: Number(quantity.volume) / 1e6,
    baseVolume: Number(quantity.baseVolume) / 1e6, quoteVolume: Number(quantity.quoteVolume) / 1e6 }
}
const expectedPrice = (stamp: number, interval: number) => {
  const children = Array.from({ length: interval / step['5m'] }, (_, index) => fine(stamp + index * step['5m']))
  const quantities = Array.from({ length: interval / step['5m'] }, (_, index) => micros(stamp + index * step['5m']))
  return { open: children[0].open, high: Math.max(...children.map(value => value.high)), low: Math.min(...children.map(value => value.low)), close: children.at(-1)!.close,
    volume: Number(quantities.reduce((sum, value) => sum + value.volume, 0n)) / 1e6,
    baseVolume: Number(quantities.reduce((sum, value) => sum + value.baseVolume, 0n)) / 1e6,
    quoteVolume: Number(quantities.reduce((sum, value) => sum + value.quoteVolume, 0n)) / 1e6 }
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 16 * Number.EPSILON * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`)

async function fixture(options: { instruments?: string[]; block?: string; twoFineGates?: boolean; failFine?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perp-download-derived-')), store = await MarketStore.open(root)
  const now = Date.now()
  const listing = Math.floor(now / step['1H']) * step['1H'] - 5 * step['1H'] + 2 * step['5m'] + 12_345
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const criterion of Object.values(preferences.liquidity)) criterion.enabled = false
  const blocked = deferred(), entered = deferred(), secondBlocked = deferred(), secondEntered = deferred()
  let fineCalls = 0
  const calls: { instrument: string; timeframe: string; source: string; rows: number; bytes: number; timestamps: number[] }[] = []
  const instruments = options.instruments ?? ['BTC-USDT-SWAP']
  const service = new MarketService(store, () => preferences, async input => {
    const url = new URL(String(input)), timeframe = url.searchParams.get('bar') ?? url.searchParams.get('period')!, interval = step[timeframe]
    const instrument = url.searchParams.get('instId')!, source = url.pathname.endsWith('/history-candles') ? 'candles'
      : url.pathname.endsWith('/open-interest-history') ? 'oi' : url.pathname.endsWith('/taker-volume-contract') ? 'taker' : ''
    if (!source || !interval) throw new Error(`Unexpected source: ${url}`)
    if (source === 'candles' && timeframe === '5m' && instrument === options.block) {
      fineCalls++
      if (!options.twoFineGates || fineCalls === 1) { entered.resolve(); await blocked.promise }
      else if (fineCalls === 2) { secondEntered.resolve(); await secondBlocked.promise }
    }
    if (source === 'candles' && timeframe === '5m' && options.failFine) return new Response('', { status: 503 })
    const begin = source === 'candles' ? Number(url.searchParams.get('after')) - Number(url.searchParams.get('limit')) * interval : Number(url.searchParams.get('begin')) + interval
    const through = source === 'candles' ? Number(url.searchParams.get('after')) - interval : Number(url.searchParams.get('end')) - interval
    const data = []
    for (let stamp = through; stamp >= begin; stamp -= interval) {
      if (stamp < listing || stamp + interval > now) continue
      const value = expectedPrice(stamp, interval)
      data.push(source === 'candles' ? [stamp, value.open, value.high, value.low, value.close, value.volume, value.baseVolume, value.quoteVolume, 1].map(String)
        : source === 'oi' ? [String(stamp), '50'] : [String(stamp), '1', '2'])
    }
    const payload = JSON.stringify({ code: '0', data })
    calls.push({ instrument, timeframe, source, rows: data.length, bytes: Buffer.byteLength(payload), timestamps: data.map(value => Number(value[0])) })
    return new Response(payload, { headers: { 'content-type': 'application/json' } })
  }, false)
  await service.ready
  service.historyDownload.now = () => now
  service.history.now = () => now
  service.historyDownload.chunkSlots = 13 // Deliberately not divisible by 3 or 12.
  service.history.sync.maxAttempts = 1
  for (const lane of service.requestLanes.values()) lane.interval = 0
  for (const instId of instruments) service.instruments.set(instId, { instId, listTime: String(listing) })
  const start = () => service.historyDownload.start(instruments.map(instId => ({ instId, listTime: listing })))
  const close = async () => { blocked.resolve(); secondBlocked.resolve(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, now, listing, instruments, calls, blocked, entered, secondBlocked, secondEntered, start, close }
}

test('cold full-history acquisition reuses complete 5m blocks across parent boundaries', async () => {
  const f = await fixture({ instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], block: 'BTC-USDT-SWAP' })
  try {
    f.start(); await f.entered.promise
    await waitFor(() => f.calls.some(call => call.instrument === 'ETH-USDT-SWAP' && call.timeframe === '5m' && call.source === 'candles'))
    assert.equal(f.calls.filter(call => call.instrument === 'BTC-USDT-SWAP' && call.source === 'candles' && call.timeframe !== '5m').length, 0)
    f.blocked.resolve(); await f.service.historyDownload.job.promise
    const report = f.service.historyDownload.snapshot()
    assert.equal(report.phase, 'completed', JSON.stringify(report.failures))
    assert.equal(f.calls.filter(call => call.source === 'candles' && call.timeframe !== '5m').length, 0, 'Complete children eliminate parent price downloads.')
    for (const instrument of f.instruments) for (const timeframe of Object.keys(step)) {
      const interval = step[timeframe], from = Math.ceil(f.listing / interval) * interval, through = Math.floor(f.now / interval) * interval - interval
      const rows = await f.store.candles({ instrument, timeframe, from, through })
      assert.equal(rows.length, (through - from) / interval + 1)
      for (const row of rows) {
        const expected = expectedPrice(row.timestamp, interval)
        assert.deepEqual([row.open, row.high, row.low, row.close], [expected.open, expected.high, expected.low, expected.close])
        near(row.volume, expected.volume); near(row.baseVolume!, expected.baseVolume); near(row.quoteVolume!, expected.quoteVolume)
      }
    }
  } finally { await f.close() }
})

test('failed fine source releases parents to their independent native histories', async () => {
  const f = await fixture({ failFine: true })
  try {
    f.start(); await f.service.historyDownload.job.promise
    const report = f.service.historyDownload.snapshot()
    assert.equal(report.phase, 'failed')
    assert.ok(report.failures.some((entry: { timeframe: string; source: string }) => entry.timeframe === '5m' && entry.source === 'candles'))
    for (const timeframe of ['15m', '1H']) {
      assert.ok(f.calls.some(call => call.source === 'candles' && call.timeframe === timeframe))
      const interval = step[timeframe], from = Math.ceil(f.listing / interval) * interval, through = Math.floor(f.now / interval) * interval - interval
      assert.equal((await f.store.candles({ instrument: f.instruments[0], timeframe, from, through })).length, (through - from) / interval + 1, JSON.stringify(report.failures))
    }
  } finally { await f.close() }
})

test('existing parent coverage is counted while fine history waits, and interactive parent demand stays independent', async () => {
  const f = await fixture({ block: 'BTC-USDT-SWAP' })
  try {
    f.service.historyDownload.chunkSlots = 100
    const first = Math.ceil(f.listing / step['15m']) * step['15m'], value = expectedPrice(first, step['15m'])
    await f.store.appendCandles([{ instrument: f.instruments[0], timeframe: '15m', timestamp: first, ...value, confirmed: true }])
    f.start(); await f.entered.promise
    await waitFor(() => [...f.service.historyDownload.held.values()].some((item: any) => item.task.timeframe === '15m' && item.task.coveredRecords >= 1))
    const report = f.service.historyDownload.snapshot()
    assert.ok(report.progress.reused >= 1, 'Already stored parent slots count before the fine source completes.')
    assert.ok(report.active.length <= f.service.historyDownload.concurrency, 'Held consumers do not expand the active UI list.')
    const target = first + step['15m'], requested = f.service.history.ensurePrices(f.instruments[0], '15m', target, target, 'interactive')
    let done = false
    requested.finally(() => { done = true }).catch(() => {})
    await waitFor(() => done)
    assert.equal((await requested).rows.length, 1)
    assert.ok(f.calls.some(call => call.instrument === f.instruments[0] && call.timeframe === '15m' && call.source === 'candles'))
    const stopped = await f.service.historyDownload.cancel()
    assert.equal(stopped.phase, 'cancelled')
    assert.equal(stopped.active.length, 0)
    assert.equal(f.service.historyDownload.held.size, 0)
  } finally { await f.close() }
})

test('each completed fine page advances held parent progress through bounded local rechecks', async () => {
  const f = await fixture({ block: 'BTC-USDT-SWAP', twoFineGates: true })
  try {
    const sync = f.service.history.sync, original = sync.store.missingCandleRanges
    const reads: { timeframe: string; slots: number; from: number; through: number }[] = []
    sync.store.missingCandleRanges = async (query: { timeframe: string; source: string; from: number; through: number; intervalMS: number }, priority: string) => {
      if (query.source === 'candles' && query.timeframe !== '5m') reads.push({ timeframe: query.timeframe, slots: (query.through - query.from) / query.intervalMS + 1, from: query.from, through: query.through })
      return original(query, priority)
    }
    f.start(); await f.entered.promise
    await waitFor(() => [...f.service.historyDownload.held.values()].filter((item: any) => item.task.source === 'candles').length === 2)
    assert.ok([...f.service.historyDownload.held.values()].every((item: any) => item.task.coveredRecords === 0))
    const initialReads = reads.length
    f.blocked.resolve(); await f.secondEntered.promise
    await waitFor(() => [...f.service.historyDownload.held.values()].some((item: any) => item.task.timeframe === '15m' && item.task.coveredRecords > 0))
    assert.ok(f.service.historyDownload.snapshot().progress.reused > 0)
    assert.ok(reads.slice(initialReads).some(read => read.timeframe === '15m' && read.slots < f.service.historyDownload.chunkSlots),
      `The update should recheck the changed range, not the whole parent page: ${JSON.stringify(reads)}`)
    assert.equal(f.calls.filter(call => call.source === 'candles' && call.timeframe !== '5m').length, 0)
    await f.service.historyDownload.cancel()
  } finally { await f.close() }
})

for (const upgrade of ['release', 'interactive', 'inflight'] as const) test(`held dirty progress skips repeated derivation and ${upgrade} derives persisted children`, async () => {
  const f = await fixture()
  try {
    const instrument = f.instruments[0], timestamp = Math.ceil(f.listing / step['15m']) * step['15m']
    const query = { instrument, timeframe: '15m', source: 'candles', from: timestamp, through: timestamp, priority: 'background' }
    const history = f.service.history, sync = history.sync, derive = history.derivePrices.bind(history)
    let derivations = 0, progressReads = 0
    const entered = deferred(), gate = deferred()
    history.derivePrices = async (...args: any[]) => { derivations++; return derive(...args) }
    const missing = sync.store.missingCandleRanges.bind(sync.store)
    sync.store.missingCandleRanges = async (bounds: unknown, priority: unknown, options: { materialize?: boolean }) => {
      if (options.materialize === false) {
        progressReads++
        if (upgrade === 'inflight') { entered.resolve(); await gate.promise }
      }
      return missing(bounds, priority, options)
    }
    const held = await sync.enqueue(query, { hold: true })
    await waitFor(() => sync.getTask(held.id)?.status === 'waiting')
    const initialDerivations = derivations
    const children = Array.from({ length: 3 }, (_, index) => ({ instrument, timeframe: '5m', timestamp: timestamp + index * step['5m'],
      ...fine(timestamp + index * step['5m']), confirmed: true }))
    await f.store.appendCandles(children)
    // A separate parent mutation or repair can wake the hold after child write.
    sync.invalidate(query)
    if (upgrade === 'inflight') {
      await entered.promise
      const inflight = await sync.enqueue({ ...query, priority: 'interactive' })
      gate.resolve()
      assert.equal((await sync.waitFor(inflight.id)).status, 'completed')
    }
    await waitFor(() => progressReads > 0 && sync.getTask(held.id)?.status === 'waiting')
    if (upgrade !== 'inflight') {
      assert.equal(derivations, initialDerivations)
      assert.equal(sync.getTask(held.id)?.coveredRecords, 0, 'A derivable but not yet materialized parent is not reported as durable.')
    }
    if (upgrade === 'interactive') {
      const interactive = await sync.enqueue({ ...query, priority: 'interactive' })
      assert.equal((await sync.waitFor(interactive.id)).status, 'completed')
      assert.equal(f.calls.filter(call => call.source === 'candles').length, 0, 'An interactive upgrade must derive before attempting the source.')
    }
    sync.release(held.id)
    assert.equal((await sync.waitFor(held.id)).status, 'completed')
    assert.ok(derivations > initialDerivations, 'Release must derive the persisted children before completion.')
    assert.equal((await f.store.candles(query)).length, 1)
    assert.equal(f.calls.filter(call => call.source === 'candles').length, 0)
  } finally { await f.close() }
})

test('a deleted derived parent is rechecked after fine failure while a native parent survives', async () => {
  const f = await fixture({ block: 'BTC-USDT-SWAP', failFine: true })
  try {
    f.service.historyDownload.chunkSlots = 100
    const instrument = f.instruments[0], first = Math.ceil(f.listing / step['15m']) * step['15m'], native = first + step['15m']
    const children = Array.from({ length: 3 }, (_, index) => ({ instrument, timeframe: '5m', timestamp: first + index * step['5m'], ...fine(first + index * step['5m']), confirmed: true }))
    await f.store.appendCandles(children)
    await f.store.aggregateCandles({ instrument, timeframe: '15m', from: first, through: first })
    const nativeValue = expectedPrice(native, step['15m'])
    await f.store.appendCandles([{ instrument, timeframe: '15m', timestamp: native, ...nativeValue, confirmed: true }])
    f.start(); await f.entered.promise
    await waitFor(() => [...f.service.historyDownload.held.values()].some((item: any) => item.task.timeframe === '15m' && item.task.coveredRecords >= 2))
    const held = [...f.service.historyDownload.held.values()].find((item: any) => item.task.timeframe === '15m') as any
    const heldID = held.task.id
    await f.service.replaceCandles({ instrument, timeframe: '5m', from: first + step['5m'], through: first + step['5m'] }, [])
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: first, through: first })).length, 0)
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: native, through: native })).length, 1)
    f.blocked.resolve(); await f.service.historyDownload.job.promise
    const parent = f.service.history.sync.getTask(heldID)
    assert.equal(parent.status, 'completed')
    assert.equal(parent.localRecords, 1, 'Only the surviving native parent is local reuse; the deleted derived slot was downloaded.')
    const result = await f.store.candles({ instrument, timeframe: '15m', from: first, through: first })
    assert.equal(result.length, 1)
    assert.equal(result[0].open, expectedPrice(first, step['15m']).open)
    assert.ok(f.calls.some(call => call.source === 'candles' && call.timeframe === '15m'))
  } finally { await f.close() }
})

test('an explicitly unavailable fine slot triggers only its independent parent source gaps', async () => {
  const f = await fixture()
  try {
    f.service.historyDownload.chunkSlots = 13
    const missing = Math.ceil(f.listing / step['1H']) * step['1H'] + step['5m']
    const source = f.service.history.sync.sources.get('candles'), inspect = source.inspect
    source.inspect = async (query: { timeframe: string }) => {
      const result = await inspect(query)
      return query.timeframe === '5m' ? { ...result, unavailable: [{ from: missing, through: missing, reason: 'Unavailable fine source slot.' }] } : result
    }
    f.start(); await f.service.historyDownload.job.promise
    const report = f.service.historyDownload.snapshot()
    assert.equal(report.phase, 'completed', JSON.stringify(report.failures))
    assert.equal(report.progress.unavailable, 1)
    assert.equal((await f.store.candles({ instrument: f.instruments[0], timeframe: '5m', from: missing, through: missing })).length, 0)
    for (const timeframe of ['15m', '1H']) {
      const parent = Math.floor(missing / step[timeframe]) * step[timeframe]
      const fetched = f.calls.filter(call => call.source === 'candles' && call.timeframe === timeframe).flatMap(call => call.timestamps)
      assert.deepEqual(fetched, [parent], `${timeframe} independently fetches only the affected parent.`)
      const [row] = await f.store.candles({ instrument: f.instruments[0], timeframe, from: parent, through: parent })
      assert.ok(row)
      assert.equal(row.open, expectedPrice(parent, step[timeframe]).open)
    }
  } finally { await f.close() }
})

for (const action of ['remove', 'close'] as const) test(`${action} while parent pages wait can drain the archive without leaking consumers`, async () => {
  const f = await fixture({ block: 'BTC-USDT-SWAP' })
  try {
    f.start(); await f.entered.promise
    await waitFor(() => f.service.historyDownload.held.size > 0)
    if (action === 'remove') await f.service.history.removeTargets(f.instruments)
    else await f.service.history.sync.close()
    const stopped = await f.service.historyDownload.cancel()
    assert.ok(stopped.phase === 'cancelled' || stopped.phase === 'failed')
    assert.equal(stopped.active.length, 0)
    assert.equal(f.service.historyDownload.held.size, 0)
    assert.equal(f.service.historyDownload.active.size, 0)
  } finally { await f.close() }
})
