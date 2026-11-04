import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'

const instId = 'BTC-USDT-SWAP', step = 300_000
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const candle = (timestamp: number, close: number) => ({ instrument: instId, timeframe: '5m', timestamp, open: 100, high: 250, low: 90, close, volume: 5, baseVolume: 1, quoteVolume: 500, confirmed: true })
const raw = (timestamp: number, close: number) => [String(timestamp), '100', '250', '90', String(close), '5', '1', '500', '1']
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }

for (const source of ['history', 'latest'] as const) test(`late ${source} response cannot replace a confirmed candle written while it was in flight`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-source-race-')), store = await MarketStore.open(root)
  const held = deferred(), requested = deferred(), timestamp = Math.floor(Date.now() / step) * step - 2 * step
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, `/api/v5/market/${source === 'history' ? 'history-candles' : 'candles'}`)
    requested.resolve(); await held.promise
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, 100), ...(source === 'history' ? [raw(timestamp - step, 100)] : [])] }))
  }, false)
  let pending: Promise<unknown> | undefined
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument]]))
    pending = source === 'history' ? service.history.ensurePrices(instId, '5m', timestamp - step, timestamp) : service.history.latest(instId, '5m')
    await requested.promise
    await service.persistCandles(instId, [candle(timestamp, 200)])
    held.resolve(); await pending
    const rows = await store.candles({ instrument: instId, timeframe: '5m', from: timestamp - step, through: timestamp })
    assert.equal(rows.find(row => row.timestamp === timestamp)?.close, 200)
    if (source === 'history') assert.equal(rows.find(row => row.timestamp === timestamp - step)?.close, 100, 'Unchanged missing slots remain reusable.')
  } finally {
    held.resolve(); await pending?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('a latest request from a removed listing cannot write confirmed candles or be reused by the relisting', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-latest-epoch-')), store = await MarketStore.open(root)
  const held = deferred(), requested = deferred(), timestamp = Math.floor(Date.now() / step) * step - 2 * step
  let requests = 0
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/candles')
    const request = ++requests
    if (request === 1) { requested.resolve(); await held.promise }
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, request === 1 ? 100 : 200)] }))
  }, false)
  let old: Promise<unknown> | undefined
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument]]))
    old = service.history.latest(instId, '5m'); await requested.promise
    service.installInstruments(new Map()); service.installInstruments(new Map([[instId, instrument]]))
    await service.history.latest(instId, '5m')
    held.resolve(); await old
    assert.equal(requests, 2)
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }))[0]?.close, 200)
  } finally {
    held.resolve(); await old?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

for (const intervening of ['write', 'removal'] as const) test(`${intervening} during the pre-write read fences the old history response`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-write-fence-')), store = await MarketStore.open(root)
  const sourceHeld = deferred(), requested = deferred(), readHeld = deferred(), reading = deferred()
  const timestamp = Math.floor(Date.now() / step) * step - 2 * step
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/history-candles')
    requested.resolve(); await sourceHeld.promise
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, 100)] }))
  }, false)
  let pending: Promise<unknown> | undefined
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument]]))
    pending = service.history.ensurePrices(instId, '5m', timestamp, timestamp)
    await requested.promise
    const candles = store.candles.bind(store)
    let holdNext = true
    ;(store as any).candles = async (...args: Parameters<typeof store.candles>) => {
      const result = await candles(...args)
      if (holdNext && args[0].from === timestamp && args[0].through === timestamp) { holdNext = false; reading.resolve(); await readHeld.promise }
      return result
    }
    sourceHeld.resolve(); await reading.promise
    if (intervening === 'write') {
      await (store as any).writer.request('append', [[{ ...candle(timestamp, 200), writtenAt: 1 }]], 'foreground')
    } else service.installInstruments(new Map())
    readHeld.resolve()
    await pending?.catch(() => {})
    const rows = await candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp })
    assert.equal(rows[0]?.close, intervening === 'write' ? 200 : undefined)
  } finally {
    sourceHeld.resolve(); readHeld.resolve(); await pending?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

for (const mode of ['append', 'replace'] as const) test(`a queued ${mode} rechecks its source revision after an independent write`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-queue-fence-')), store = await MarketStore.open(root)
  const timestamp = Math.floor(Date.now() / step) * step - 2 * step
  const writer = (store as any).writer, revision = store.candlePriceRevision(instId, '5m')
  try {
    writer.fencing = true
    const written = writer.request('append', [[{ ...candle(timestamp, 200), writtenAt: 1 }]], 'foreground')
    const canWrite = () => store.candlePriceRevision(instId, '5m') === revision
    const stale = mode === 'append'
      ? store.appendCandles([candle(timestamp, 100)], 'background', { canWrite })
      : store.replaceCandles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, [candle(timestamp, 100)], 'background', { canWrite })
    const settled = stale.catch(error => error)
    await Promise.resolve()
    writer.fencing = false; writer.drain()
    await written
    const result = await settled
    if (mode === 'replace') assert.match(String(result), /changed during repair/)
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }))[0]?.close, 200)
  } finally {
    writer.fencing = false; writer.drain()
    await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('removal completes only after a price transaction admitted by the retired lifetime has stopped', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-epoch-commit-')), store = await MarketStore.open(root)
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async () => { throw new Error('Unexpected network request.') }, false)
  let database: DatabaseSync | undefined
  try {
    await service.ready
    const history = service.history as any, timestamp = Math.floor(Date.now() / step) * step - 2 * step, row = candle(timestamp, 100)
    history.priceOrigins.set(row, { epoch: 0, revision: store.candlePriceRevision(instId, '5m') })
    const canWrite = history.priceGuard(instId, [row]), fence = new Int32Array(canWrite.lifetime.buffer)
    database = new DatabaseSync(join(root, 'market.sqlite')); database.exec('BEGIN IMMEDIATE')
    const writing = store.appendCandles([row], 'foreground', { canWrite }).catch(error => error)
    while (Atomics.load(fence, 1) !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    let retired = false
    const removal = history.removeTargets([instId]).then(() => { retired = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(retired && Atomics.load(fence, 1) === 1, false, 'Removal cannot complete while its retired price transaction remains active.')
    database.exec('ROLLBACK')
    assert.match(String(await writing), /lifetime was removed/)
    await removal
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp })).length, 0)
  } finally {
    try { database?.exec('ROLLBACK') } catch {}
    database?.close(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('a repair immediately reacquires its source after a concurrent confirmed correction', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-history-repair-conflict-')), store = await MarketStore.open(root)
  const held = deferred(), requested = deferred(), timestamp = Math.floor(Date.now() / step) * step - 2 * step
  let requests = 0
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/history-candles')
    const request = ++requests
    if (request === 1) { requested.resolve(); await held.promise }
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, request === 1 ? 100 : 210)] }))
  }, false)
  let repair: Promise<unknown> | undefined
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument]]))
    repair = (service.history as any).repair({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }, { signal: new AbortController().signal })
    await requested.promise
    await service.persistCandles(instId, [candle(timestamp, 200)])
    held.resolve(); await repair
    assert.equal(requests, 2)
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }))[0]?.close, 210)
  } finally {
    held.resolve(); await repair?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('production relisting and its new requests wait for the old confirmed transaction without delaying other contracts', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-production-retirement-')), store = await MarketStore.open(root)
  const timestamp = Math.floor(Date.now() / step) * step - 2 * step, other = { ...instrument, instId: 'ETH-USDT-SWAP' }
  let requests = 0, database: DatabaseSync | undefined, old: Promise<unknown> | undefined
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/candles'); requests++
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, 210)] }))
  }, false)
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument], [other.instId, other]]))
    database = new DatabaseSync(join(root, 'market.sqlite')); database.exec('BEGIN IMMEDIATE')
    const history = service.history as any
    old = (service as any).confirmPriceCandle(candle(timestamp, 100), { sourceEpoch: 0 })
    while (!history.instrumentFences.has(instId) || Atomics.load(history.instrumentFences.get(instId) as Int32Array, 1) !== 1) await new Promise<void>(resolve => setImmediate(resolve))
    service.installInstruments(new Map([[other.instId, other]]))
    service.installInstruments(new Map([[instId, instrument], [other.instId, other]]))
    assert.equal(service.candidateIDs.has(instId), false)
    assert.equal(service.candidateIDs.has(other.instId), true)
    const fresh = service.history.latest(instId, '5m')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(requests, 0, 'A new source request waits for the old transaction to retire.')
    database.exec('ROLLBACK'); await old; await fresh
    assert.equal(requests, 1)
    assert.equal(service.candidateIDs.has(instId), true)
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }))[0]?.close, 210)
    const next = { ...candle(timestamp + step, 200), confirmed: false }
    ;(service as any).setLive(instId, '5m', next)
    await (service as any).confirmPriceCandle(candle(timestamp, 100), { sourceEpoch: 0 })
    assert.equal(service.liveCandles.get(`${instId}:5m`).close, 200)
    assert.equal((await store.candles({ instrument: instId, timeframe: '5m', from: timestamp, through: timestamp }))[0]?.close, 210)
  } finally {
    try { database?.exec('ROLLBACK') } catch {}
    database?.close(); await old?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})
