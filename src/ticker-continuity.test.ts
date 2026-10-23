import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'
import { OKX_PUBLIC_WEBSOCKET_URL } from '../electron/services/realtime-public-market.js'
import type { RealtimeWebSocket } from '../electron/services/realtime-market.js'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'

const start = Date.UTC(2026, 9, 18, 0, 0, 10)
const instrument = (symbol = 'BTC') => ({ instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: symbol, ruleType: 'normal' })
const ticker = (instId: string, price = 100) => ({ instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price), ts: String(Date.now()) })
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const preferences = (depth = false) => {
  const value = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(value.liquidity)) rule.enabled = false
  value.liquidity.spread.enabled = true
  value.liquidity.depth.enabled = depth
  return value
}
const book = (seqId = 1) => ({
  asks: Array.from({ length: 400 }, (_, index) => [(100 + index * 0.0001).toFixed(4), '1000']),
  bids: Array.from({ length: 400 }, (_, index) => [(99.99 - index * 0.0001).toFixed(4), '1000']),
  ts: String(Date.now()), seqId, prevSeqId: -1,
})
type Subscription = { channel: string; instId?: string; instType?: string }
const key = (value: Subscription) => `${value.channel}:${value.instId ?? value.instType}`

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  subscriptions = new Map<string, Subscription>()
  pending = new Map<string, { id: string; arg: Subscription; event: string }>()
  url: string
  heldAcknowledgements: Set<string>
  constructor(url: string, heldAcknowledgements: Set<string>) { super(); this.url = url; this.heldAcknowledgements = heldAcknowledgements }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  acknowledge(subscriptionKey: string) {
    const acknowledgement = this.pending.get(subscriptionKey)
    assert.ok(acknowledgement, `No pending acknowledgement for ${subscriptionKey}.`)
    this.pending.delete(subscriptionKey)
    this.message(acknowledgement)
  }
  send(value: string) {
    assert.equal(this.readyState, 1)
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    for (const arg of command.args as Subscription[]) {
      const subscriptionKey = key(arg), acknowledgement = { id: command.id, event: command.op, arg }
      if (command.op === 'subscribe') this.subscriptions.set(subscriptionKey, arg)
      else this.subscriptions.delete(subscriptionKey)
      if (command.op === 'subscribe' && this.heldAcknowledgements.has(subscriptionKey)) this.pending.set(subscriptionKey, acknowledgement)
      else queueMicrotask(() => this.message(acknowledgement))
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })))
  }
}

const fixture = async (context: TestContext, instruments = [instrument()], options: { depth?: boolean; holdAcknowledgements?: string[]; initialBulkError?: string; requestTimeout?: number } = {}) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  const root = await mkdtemp(join(tmpdir(), 'perp-ticker-continuity-')), store = await MarketStore.open(root)
  const config = preferences(options.depth), bootstrap = deferred(), sockets: Socket[] = [], requests: URL[] = []
  const heldAcknowledgements = new Set(options.holdAcknowledgements)
  const repairs: Array<{ instId: string; signal: AbortSignal | null | undefined; resolve: (rows: unknown[]) => void }> = []
  const bulkReplies: Array<{ resolve: (rows: unknown[]) => void }> = []
  let bulkError = options.initialBulkError, holdBulk = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/public/instruments')) { await bootstrap.promise; return response(instruments) }
    if (url.pathname.endsWith('/market/tickers')) {
      await bootstrap.promise
      if (bulkError) { const error = bulkError; bulkError = undefined; throw new Error(error) }
      if (holdBulk) return new Promise<Response>(resolve => { bulkReplies.push({ resolve: rows => resolve(response(rows)) }) })
      return response(instruments.map(value => ticker(value.instId)))
    }
    if (url.pathname.endsWith('/market/ticker')) return new Promise<Response>(resolve => { repairs.push({ instId: url.searchParams.get('instId')!, signal: init?.signal, resolve: rows => resolve(response(rows)) }) })
    if (url.pathname.endsWith('/market/books')) return response([book()])
    throw new Error(`Unexpected source request: ${url.pathname}`)
  }
  const factory = (url: string) => { const socket = new Socket(url, heldAcknowledgements); sockets.push(socket); return socket }
  const service = new MarketService(store, () => config, fetcher, true, { webSocketFactory: factory, ...(options.requestTimeout ? { requestTimeout: options.requestTimeout } : {}) })
  // Keep real ticker/candle transport while excluding independent chart-history acquisition.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  const services = new Set([service])
  const prepare = (value: MarketService) => {
    value.projectListEntry = async () => null
    value.scheduleListProjection = () => undefined
    value.updateRanking = async () => undefined
    for (const lane of value.requestLanes.values()) { lane.interval = 0; lane.nextAt = 0 }
  }
  await service.ready; prepare(service); bootstrap.resolve()
  const initialRefresh = service.refreshing
  const idle = async () => {
    await Promise.all([...services].flatMap(value => [value.publicRealtime.whenIdle(), value.realtime.whenIdle()]))
    await setImmediate(); await setImmediate()
  }
  const waitFor = async (condition: () => boolean) => {
    const deadline = performance.now() + 3_000
    while (!condition()) {
      assert.ok(performance.now() < deadline, 'Streamed market work did not settle.')
      await idle()
    }
  }
  const advance = async (milliseconds: number) => {
    while (milliseconds > 0) {
      const step = Math.min(milliseconds, 1_000)
      context.mock.timers.tick(step); milliseconds -= step
      await idle()
    }
  }
  const open = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const socket of sockets) if (socket.readyState === 0) socket.open()
      await idle()
      const active = [...services].filter(value => !value.closing)
      if (sockets.every(socket => socket.readyState !== 0) && active.every(value => value.publicRealtime.gateTimer === null
        && (!value.publicRealtime.controlShard || value.instrumentStream?.synchronized))) return
      await advance(500)
    }
    throw new Error('Native market connections did not open.')
  }
  const socketFor = (channel: string, instId = 'SWAP') => {
    const socket = sockets.find(value => value.url === OKX_PUBLIC_WEBSOCKET_URL && value.readyState === 1 && value.subscriptions.has(`${channel}:${instId}`))
    assert.ok(socket, `Missing live ${channel}:${instId} subscription.`)
    return socket
  }
  const push = async (channel: string, instId: string, data: unknown[], action?: string) => {
    socketFor(channel, instId).message({ arg: { channel, ...(channel === 'instruments' ? { instType: instId } : { instId }) }, data, ...(action ? { action } : {}) })
    await idle()
  }
  const qualify = async () => { await advance(100); await waitFor(() => service.streamEvaluations.size === 0 && service.pendingCandidates.size === 0) }
  const reopen = async () => {
    const next = new MarketService(store, () => config, fetcher, false, { webSocketFactory: factory })
    next.preparedCharts.setRealtimeSubscriptions = () => undefined
    services.add(next); await next.ready; prepare(next)
    next.publicRealtime.start(); next.realtime.start(); await open()
    return next
  }
  const close = async () => {
    for (const repair of repairs) repair.resolve([])
    for (const reply of bulkReplies) reply.resolve([])
    await Promise.all([...services].map(value => value.dispose()))
    await store.close(); context.mock.timers.reset(); await rm(root, { recursive: true, force: true })
  }
  await open()
  await initialRefresh
  await waitFor(() => service.pendingCandidates.size === 0 && service.refreshing === null)
  return { service, store, config, sockets, requests, repairs, bulkReplies, holdBulk: () => { holdBulk = true }, socketFor, push, qualify, advance, idle, waitFor, open, reopen, close }
}

test('an acknowledged quiet native ticker remains eligible beyond 90 seconds without refreshing any raw timestamp or using REST', async context => {
  const value = instrument(), f = await fixture(context, [value])
  try {
    const raw: Record<string, string> = { ...ticker(value.instId) }; delete raw.instId
    await f.push('tickers', value.instId, [raw]); await f.qualify()
    const observation = f.service.observations.get(value.instId).ticker, original = structuredClone(observation)
    assert.equal(observation.value.instId, undefined, 'The callback subscription ID supplies identity independently of the raw ticker.')
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'verified')
    const before = f.requests.length
    await f.advance(180_000)
    assert.ok(Date.now() > observation.expiresAt)
    assert.equal(f.service.observations.get(value.instId).ticker, observation)
    assert.deepEqual(observation, original)
    assert.equal(f.service.tickerCache.values.get(value.instId), observation)
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'verified')
    assert.deepEqual((await f.service.snapshot()).rows.map(row => row.instId), [value.instId])
    assert.equal(f.requests.length, before, 'Native session continuity must not admit a healthy-source REST renewal.')
  } finally { await f.close() }
})

test('an ACK cannot grant continuity to REST, pre-ACK native, or cloned ticker observations', async context => {
  const values = [instrument('REST'), instrument('PRE'), instrument('CLONE')]
  const f = await fixture(context, values, { holdAcknowledgements: [`tickers:${values[1].instId}`] })
  try {
    await f.push('tickers', values[1].instId, [ticker(values[1].instId)])
    const preACK = f.service.observations.get(values[1].instId).ticker
    f.socketFor('tickers', values[1].instId).acknowledge(`tickers:${values[1].instId}`)
    await f.idle()
    await f.push('tickers', values[2].instId, [ticker(values[2].instId)])
    const clone = structuredClone(f.service.observations.get(values[2].instId).ticker)
    f.service.observations.get(values[2].instId).ticker = clone
    f.service.tickerCache.values.set(values[2].instId, clone)
    f.service.verifyCatalog()
    const rest = f.service.observations.get(values[0].instId).ticker
    await f.advance(90_100)
    assert.equal(f.service.observation({ ticker: preACK }, 'ticker'), null)
    assert.equal(f.service.observation({ ticker: clone }, 'ticker'), null)
    assert.equal(f.service.observation({ ticker: rest }, 'ticker'), null)
    assert.deepEqual((await f.service.snapshot()).rows, [])
    assert.ok(values.every(value => f.service.catalogChecks.get(value.instId).status === 'unknown'))
  } finally { await f.close() }
})

test('a persisted quiet ticker loses session continuity across restart and a fresh ACK does not revive it', async context => {
  const value = instrument(), f = await fixture(context, [value])
  try {
    await f.push('tickers', value.instId, [ticker(value.instId)]); await f.qualify()
    const raw = structuredClone(f.service.observations.get(value.instId).ticker)
    await f.advance(91_000)
    await f.push('instruments', 'SWAP', [value]); await f.qualify()
    const entry = f.service.catalog.get(value.instId)
    assert.ok(entry.instrumentObservation.expiresAt > Date.now(), 'Only the persisted ticker lease is expired at restart.')
    assert.equal(entry.expiresAt, Number.MAX_SAFE_INTEGER)
    f.service.metadata.putCatalogEntry(entry)
    await f.service.dispose()
    const restarted = await f.reopen()
    assert.deepEqual(restarted.observations.get(value.instId).ticker, raw)
    assert.equal(restarted.observation(restarted.observations.get(value.instId), 'ticker'), null)
    assert.deepEqual((await restarted.snapshot()).rows, [])
    assert.equal((await restarted.snapshot()).catalogProgress.unknown, 1)
  } finally { await f.close() }
})

test('a data-shard disconnect and re-ACK without a new ticker revoke only that shard’s quiet quote', async context => {
  const values = Array.from({ length: 26 }, (_, index) => instrument(`COIN${String(index).padStart(2, '0')}`))
  const f = await fixture(context, values)
  try {
    for (const value of values) await f.push('tickers', value.instId, [ticker(value.instId)])
    await f.qualify(); await f.advance(91_000)
    const healthy = values[0].instId, affected = values.at(-1)!.instId
    const healthyObservation = f.service.observations.get(healthy).ticker
    const retired = f.socketFor('tickers', affected)
    assert.notEqual(retired, f.socketFor('tickers', healthy))
    retired.close(); await f.idle()
    assert.equal(f.service.catalog.has(affected), false)
    assert.equal(f.service.catalogChecks.get(affected).status, 'unknown')
    assert.equal(f.service.catalog.has(healthy), true)
    await f.advance(1_500); await f.open()
    assert.notEqual(f.socketFor('tickers', affected), retired)
    assert.equal(f.service.catalog.has(affected), false, 'A replacement ACK cannot adopt the preceding subscription’s quote.')
    assert.equal(f.service.observations.get(healthy).ticker, healthyObservation)
    assert.ok(f.repairs.every(repair => repair.instId === affected))
    await f.push('tickers', affected, [ticker(affected, 101)]); await f.qualify()
    assert.equal(f.service.catalog.has(affected), true)
    const current = f.service.observations.get(affected).ticker
    retired.message({ arg: { channel: 'tickers', instId: affected }, data: [ticker(affected, 999)] })
    await f.idle()
    assert.equal(f.service.observations.get(affected).ticker, current)
  } finally { await f.close() }
})

test('replacing a quiet ticker immediately invalidates its old assessed continuity while a depth worker is held', async context => {
  const value = instrument(), f = await fixture(context, [value], { depth: true })
  let held: { input: LiquidityInput; resolve: (result: ReturnType<typeof evaluateLiquidity>) => void } | undefined
  let hold = false
  f.service.streamLiquidity = {
    evaluate: (input: LiquidityInput) => hold ? new Promise(resolve => { held = { input, resolve } }) : Promise.resolve(evaluateLiquidity(input)),
    close: async () => undefined,
  }
  try {
    await f.push('tickers', value.instId, [ticker(value.instId)])
    await f.push('books', value.instId, [book()], 'snapshot'); await f.qualify()
    await f.advance(80_000)
    await f.push('books', value.instId, [book(2)], 'snapshot'); await f.qualify()
    await f.advance(11_000)
    const old = f.service.observations.get(value.instId).ticker
    assert.ok(old.expiresAt < Date.now())
    assert.equal(f.service.observationExpiry(old, 'ticker', value.instId), Number.MAX_SAFE_INTEGER)
    assert.equal(f.service.catalog.has(value.instId), true)
    hold = true
    await f.push('tickers', value.instId, [ticker(value.instId, 101)])
    assert.equal(f.service.catalog.has(value.instId), false, 'The former infinite effective ticker lease must end at replacement, before batching or worker completion.')
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'unknown')
    assert.equal(f.service.observation({ ticker: old }, 'ticker'), null)
    await f.advance(100)
    assert.ok(held)
    assert.deepEqual((await f.service.snapshot()).rows, [])
    hold = false; held.resolve(evaluateLiquidity(held.input))
    await f.waitFor(() => f.service.streamEvaluations.size === 0)
    assert.equal(f.service.catalog.has(value.instId), true)
    assert.notEqual(f.service.observations.get(value.instId).ticker, old)
  } finally { if (held) held.resolve(evaluateLiquidity(held.input)); await f.close() }
})

test('a malformed native ticker revokes only its own continuity and admits only its targeted REST repair', async context => {
  const values = [instrument(), instrument('ETH')], f = await fixture(context, values)
  try {
    for (const value of values) await f.push('tickers', value.instId, [ticker(value.instId)])
    await f.qualify(); await f.advance(91_000)
    const affected = values[0].instId, healthy = values[1].instId
    const healthyObservation = f.service.observations.get(healthy).ticker, before = f.requests.length
    await f.push('tickers', affected, [{ last: 'invalid', bidPx: '99.99', askPx: '100', ts: String(Date.now()) }])
    assert.equal(f.service.catalog.has(affected), false)
    assert.equal(f.service.catalog.has(healthy), true)
    await f.advance(1)
    await f.waitFor(() => f.repairs.length > 0)
    assert.deepEqual(f.requests.slice(before).map(url => [url.pathname, url.searchParams.get('instId')]), [['/api/v5/market/ticker', affected]])
    assert.equal(f.service.observations.get(healthy).ticker, healthyObservation)
    assert.equal(f.service.catalogChecks.get(healthy).status, 'verified')
    f.repairs[0].resolve([ticker(affected, 102)])
    await f.waitFor(() => f.service.observations.get(affected).ticker.value.last === '102')
    const repaired = f.service.observations.get(affected).ticker
    assert.ok(repaired.expiresAt > Date.now() && repaired.expiresAt < Number.MAX_SAFE_INTEGER)
    assert.equal(f.service.observationExpiry(repaired, 'ticker', affected), repaired.expiresAt, 'A successful HTTP repair is still ordinary bounded evidence.')
  } finally { await f.close() }
})

test('same-socket unsubscribe and re-add revoke the old quiet proof and cancel a held targeted repair', async context => {
  const values = [instrument(), instrument('ETH')], f = await fixture(context, values)
  try {
    for (const value of values) await f.push('tickers', value.instId, [ticker(value.instId)])
    await f.qualify(); await f.advance(91_000)
    const affected = values[0].instId, healthy = values[1].instId
    const socket = f.socketFor('tickers', affected), previous = f.service.observations.get(affected).ticker
    assert.equal(f.service.observationExpiry(previous, 'ticker', affected), Number.MAX_SAFE_INTEGER)
    f.service.publicRealtime.setSubscriptions([healthy])
    assert.equal(f.service.catalog.has(affected), false, 'Revocation is synchronous with unsubscribe, before the network acknowledgement.')
    assert.equal(f.service.catalogChecks.get(affected).status, 'unknown')
    await f.idle()
    assert.equal(f.socketFor('tickers', healthy), socket)
    f.service.publicRealtime.setSubscriptions(values.map(value => value.instId)); await f.idle()
    assert.equal(f.socketFor('tickers', affected), socket)
    assert.equal(f.service.catalog.has(affected), false)
    await f.advance(10_001)
    await f.waitFor(() => f.repairs.length === 1)
    const repair = f.repairs[0]
    assert.equal(repair.instId, affected)
    assert.equal(repair.signal?.aborted, false)
    f.service.publicRealtime.setSubscriptions([healthy])
    assert.equal(repair.signal?.aborted, true, 'Unsubscribing must abort a held repair owned by that subscription.')
    await f.idle()
    f.service.publicRealtime.setSubscriptions(values.map(value => value.instId)); await f.idle()
    repair.resolve([ticker(affected, 999)]); await f.idle()
    assert.equal(f.service.observations.get(affected).ticker, previous)
    assert.equal(f.service.catalog.has(affected), false)
    assert.equal(f.service.catalog.has(healthy), true)
    await f.push('tickers', affected, [ticker(affected, 102)]); await f.qualify()
    assert.equal(f.service.catalog.has(affected), true)
    assert.equal(f.service.observations.get(affected).ticker.value.last, '102')
  } finally { await f.close() }
})

test('a bulk REST request completing after native silence preserves the exact continuously valid native observation', async context => {
  const value = instrument(), f = await fixture(context, [value], { requestTimeout: 300_000 })
  let refreshing: Promise<void> | undefined
  try {
    f.holdBulk(); refreshing = f.service.refresh()
    await f.waitFor(() => f.bulkReplies.length === 1)
    await f.push('tickers', value.instId, [ticker(value.instId, 130)]); await f.qualify()
    const native = f.service.observations.get(value.instId).ticker, original = structuredClone(native)
    await f.advance(91_000)
    assert.ok(native.expiresAt < Date.now())
    f.bulkReplies[0].resolve([ticker(value.instId, 90)])
    await refreshing; await f.idle()
    assert.equal(f.service.tickerCache.values.get(value.instId), native)
    assert.equal(f.service.observations.get(value.instId).ticker, native)
    assert.deepEqual(native, original)
    assert.equal(f.service.catalog.has(value.instId), true)
    assert.equal((await f.service.snapshot()).rows[0].lastPrice, 130)
  } finally { for (const reply of f.bulkReplies) reply.resolve([]); await refreshing; await f.close() }
})

test('partial native recovery retains a bulk ticker fault and the final recovery preserves an unrelated worker error', async context => {
  const values = [instrument(), instrument('ETH')]
  const f = await fixture(context, values, { depth: true, initialBulkError: 'Bulk ticker source unavailable.' })
  let failWorker = false
  f.service.streamLiquidity = {
    evaluate: (input: LiquidityInput) => failWorker ? Promise.reject(new Error('Depth worker unavailable.')) : Promise.resolve(evaluateLiquidity(input)),
    close: async () => undefined,
  }
  try {
    assert.match((await f.service.snapshot()).error, /Bulk ticker source unavailable/)
    await f.push('tickers', values[0].instId, [ticker(values[0].instId)]); await f.qualify()
    assert.match((await f.service.snapshot()).error, /Bulk ticker source unavailable/, 'One native quote cannot resolve the other missing contract’s acquisition failure.')
    failWorker = true
    await f.push('books', values[0].instId, [book()], 'snapshot'); await f.qualify()
    assert.match((await f.service.snapshot()).error, /Depth worker unavailable/)
    await f.push('tickers', values[1].instId, [ticker(values[1].instId)]); await f.qualify()
    assert.match((await f.service.snapshot()).error, /Depth worker unavailable/, 'Resolving the final ticker fault must preserve the independently active worker failure.')
    failWorker = false
    await f.push('books', values[0].instId, [book(2)], 'snapshot'); await f.qualify()
    assert.equal((await f.service.snapshot()).error, '', 'After the worker itself recovers, no retired bulk ticker error may reappear.')
  } finally { await f.close() }
})
