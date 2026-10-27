import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const fiveMinutes = 300_000
const instrument = (symbol = 'BTC') => ({ instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: symbol, ruleType: 'normal' })
const ticker = (instId: string, price = 100) => ({ instId, last: String(price), bidPx: String(price - 0.01), askPx: String(price) })
const book = { asks: [['100', '200001']], bids: [['99.99', '200001']] }
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 3_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for market source work.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const preferences = (...enabled: (keyof typeof DEFAULT_PREFERENCES.liquidity)[]) => {
  const values = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(values.liquidity)) rule.enabled = false
  for (const key of enabled) values.liquidity[key].enabled = true
  return values
}
const fixture = async (config: ReturnType<typeof preferences>, fetcher: typeof fetch = async () => { throw new Error('Unexpected network request.') }) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-refresh-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => config, fetcher, false)
  await service.ready
  service.preparedCharts.setUniverse = () => ({ frames: [] })
  service.updateRanking = async () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, close }
}

test('150 contract checks share bulk sources and reuse valid OI across price refreshes', async () => {
  const instruments = Array.from({ length: 150 }, (_, index) => instrument(`COIN${index}`))
  const calls = new Map<string, number>()
  let price = 100
  const f = await fixture(preferences('spread', 'openInterest'), async input => {
    const url = new URL(String(input)), path = url.pathname
    calls.set(path, (calls.get(path) ?? 0) + 1)
    assert.equal(url.searchParams.has('instId'), false, 'Global sources must not be requested once per contract.')
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(instruments.map(value => ticker(value.instId, price)))
    if (path.endsWith('/public/open-interest')) return response(instruments.map(value => ({ instId: value.instId, oiUsd: '6000000' })))
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh()
    assert.equal(f.service.catalog.size, 150)
    assert.deepEqual([...calls.values()], [1, 1, 1])
    price = 200
    await f.service.refresh()
    const rows = f.service.listRowsFor()
    assert.equal(rows.length, 150)
    assert.ok(rows.every(row => row.lastPrice === 200))
    assert.deepEqual([...calls.values()], [2, 2, 1])
    const sources = instruments.map(value => f.service.observations.get(value.instId).openInterest)
    assert.equal(new Set(sources.map(value => value.observedAt)).size, 1)
    assert.ok(sources.every(value => value.expiresAt === value.observedAt + 90_000))
    assert.equal((await f.service.snapshot()).catalogProgress.pending, 0)
  } finally { await f.close() }
})

test('saturated slow book requests cannot block metadata and ticker renewal', async () => {
  const instruments = Array.from({ length: 17 }, (_, index) => instrument(`COIN${index}`))
  const gate = deferred()
  let blocked = false, activeBooks = 0, metadataCalls = 0, tickerCalls = 0
  const f = await fixture(preferences('depth', 'spread'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) { metadataCalls += 1; return response(instruments) }
    if (path.endsWith('/market/tickers')) { tickerCalls += 1; return response(instruments.map(value => ticker(value.instId))) }
    if (path.endsWith('/market/books')) {
      if (blocked) { activeBooks += 1; await gate.promise; activeBooks -= 1 }
      return response([book])
    }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let refresh: Promise<void> | undefined
  try {
    await f.service.refresh()
    assert.equal(f.service.catalog.size, 17)
    for (const value of instruments) {
      f.service.observations.get(value.instId).book.expiresAt = 0
      f.service.books.invalidate(value.instId)
    }
    blocked = true
    refresh = f.service.refresh()
    await waitFor(() => activeBooks === 16)
    f.service.tickerCache.observedAt = Date.now() - 30_001
    await f.service.renewCatalog()
    assert.equal(metadataCalls, 3)
    assert.equal(tickerCalls, 3)
    assert.equal(activeBooks, 16, 'Global source renewal must finish while all book slots remain occupied.')
    assert.ok(f.service.refreshing)
    gate.resolve(); await refresh
    assert.equal(f.service.catalog.size, 17)
  } finally { gate.resolve(); await refresh; await f.close() }
})

test('a known failing spread excludes a contract without downloading its history, book, or OI', async () => {
  const value = instrument()
  const paths: string[] = []
  const f = await fixture(preferences('spread', 'depth', 'slippage', 'volume24h', 'volumeStability', 'openInterest'), async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) return response([{ ...ticker(value.instId), bidPx: '99', askPx: '100' }])
    throw new Error(`A failing spread must skip ${path}.`)
  })
  try {
    let historyCalls = 0
    f.service.history.ensurePrices = async () => { historyCalls += 1; throw new Error('History is unnecessary for a known failure.') }
    await f.service.refresh()
    assert.deepEqual(paths.sort(), ['/api/v5/market/tickers', '/api/v5/public/instruments'])
    assert.equal(historyCalls, 0)
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'failed')
    assert.equal(f.service.catalog.size, 0)
    assert.equal((await f.service.snapshot()).catalogProgress.pending, 0)
  } finally { await f.close() }
})

test('a shared bulk OI rejection skips history and books for the entire excluded universe', async context => {
  const instruments = Array.from({ length: 289 }, (_, index) => instrument(`COIN${index}`))
  const eligible = instruments.slice(-14), eligibleIDs = new Set(eligible.map(value => value.instId))
  const paths: string[] = [], histories: string[] = []
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 60_000
  context.mock.method(Date, 'now', () => now)
  const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
  const f = await fixture(preferences('spread', 'depth', 'slippage', 'volume24h', 'openInterest'), async input => {
    const url = new URL(String(input)), path = url.pathname
    paths.push(path)
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(instruments.map(value => ticker(value.instId)))
    if (path.endsWith('/public/open-interest')) return response(instruments.map(value => ({ instId: value.instId, oiUsd: eligibleIDs.has(value.instId) ? '6000000' : '1' })))
    if (path.endsWith('/market/books')) {
      assert.ok(eligibleIDs.has(url.searchParams.get('instId')!))
      return response([book])
    }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    f.service.history.ensurePrices = async (id: string) => {
      histories.push(id)
      assert.ok(eligibleIDs.has(id), 'A known OI failure cannot consume a historical request slot.')
      return { rows: Array.from({ length: 288 }, (_, index) => ({ instrument: id, timeframe: '5m', timestamp: asOf - (288 - index) * fiveMinutes,
        open: 99, high: 101, low: 98, close: 100, volume: 2_000, baseVolume: 20, quoteVolume: 200_000, confirmed: true })) }
    }
    const started = performance.now()
    await f.service.refresh()
    context.diagnostic(`289 contracts: ${histories.length} historical acquisitions, ${paths.filter(path => path.endsWith('/public/open-interest')).length} bulk OI request, ${(performance.now() - started).toFixed(1)} ms.`)
    assert.deepEqual(new Set(histories), eligibleIDs)
    assert.equal(paths.filter(path => path.endsWith('/public/open-interest')).length, 1)
    assert.deepEqual(new Set(f.service.listRowsFor().map(row => row.instId)), eligibleIDs)
    assert.equal((await f.service.snapshot()).catalogProgress.failed, 275)
  } finally { await f.close() }
})

test('a book arriving after contract metadata changes cannot repopulate its invalidated observation', async () => {
  const gate = deferred()
  let current = instrument(), started = false
  const f = await fixture(preferences('depth'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([current])
    if (path.endsWith('/market/tickers')) return response([ticker(current.instId)])
    if (path.endsWith('/market/books')) { started = true; await gate.promise; return response([book]) }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let refresh: Promise<void> | undefined
  try {
    refresh = f.service.refresh()
    await waitFor(() => started)
    current = { ...current, ctVal: '1' }
    const signal = new AbortController().signal, key = f.service.catalogCriteriaKey()
    await f.service.discoverInstruments(key, signal, 'foreground')
    gate.resolve(); await refresh
    assert.equal(f.service.observations.get(current.instId).book, undefined)
    await f.service.checkCandidate(current, f.service.prefs().liquidity, key, signal, 'foreground', { localOnly: true })
    assert.equal(f.service.catalogChecks.get(current.instId).status, 'unknown')
    assert.equal(f.service.catalog.size, 0)
  } finally { gate.resolve(); await refresh; await f.close() }
})

test('a recovered OI source can serve a later history completion after the shared retry deadline', async context => {
  let now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 60_000
  context.mock.method(Date, 'now', () => now)
  const instruments = [instrument(), instrument('ETH')]
  const asOf = Math.floor(Date.now() / fiveMinutes) * fiveMinutes
  const rows = (instId: string) => Array.from({ length: 288 }, (_, index) => ({ instrument: instId, timeframe: '5m', timestamp: asOf - (288 - index) * fiveMinutes, open: 99, high: 101, low: 98, close: 100, volume: 2_000, baseVolume: 20, quoteVolume: 200_000, confirmed: true }))
  const gate = deferred()
  let historyStarted = false, oiCalls = 0
  const f = await fixture(preferences('volume24h', 'openInterest'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(instruments.map(value => ticker(value.instId)))
    if (path.endsWith('/public/open-interest')) {
      oiCalls += 1
      if (oiCalls === 1) throw new Error('The network temporarily disconnected.')
      return response(instruments.map(value => ({ instId: value.instId, oiUsd: '6000000' })))
    }
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let refresh: Promise<void> | undefined
  try {
    await f.store.appendCandles(rows(instruments[0].instId))
    f.service.history.ensurePrices = async (id: string, timeframe: string, from: number, through: number) => {
      assert.equal(id, instruments[1].instId)
      historyStarted = true; await gate.promise
      return { rows: await f.store.candles({ instrument: id, timeframe, from, through }) }
    }
    refresh = f.service.refresh()
    await waitFor(() => historyStarted && oiCalls === 1 && f.service.catalogChecks.get(instruments[0].instId)?.status === 'unknown')
    now = f.service.openInterest.retryAt
    await f.store.appendCandles(rows(instruments[1].instId))
    gate.resolve(); await refresh
    assert.equal(oiCalls, 2, 'The shared deadline permits one new acquisition after network recovery.')
    assert.equal(f.service.catalog.get(instruments[1].instId)?.status, 'verified')
    const recovered = f.service.observations.get(instruments[0].instId).openInterest
    if (recovered) assert.equal(recovered.observedAt, now, 'A sibling can reuse the successful recovery, never manufacture a lease from the failed first attempt.')
  } finally { gate.resolve(); await refresh; await f.close() }
})

test('a delayed previous-boundary history read cannot replace the current durable qualification window', async context => {
  let now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 4 * 60_000
  context.mock.method(Date, 'now', () => now)
  const value = instrument(), asOf = Math.floor(now / fiveMinutes) * fiveMinutes
  const gate = deferred(), entered = deferred()
  const row = (timestamp: number, quoteVolume = 200_000) => ({ instrument: value.instId, timeframe: '5m', timestamp, open: 99, high: 101, low: 98, close: 100, volume: 2_000, baseVolume: 20, quoteVolume, confirmed: true })
  const f = await fixture(preferences('volume24h'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([value])
    if (path.endsWith('/market/tickers')) return response([ticker(value.instId)])
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  let refresh: Promise<void> | undefined
  try {
    await f.store.appendCandles(Array.from({ length: 288 }, (_, index) => row(asOf - (288 - index) * fiveMinutes)))
    const read = f.service.readQualificationCandles.bind(f.service)
    let first = true
    f.service.readQualificationCandles = async (...args: unknown[]) => {
      const rows = await read(...args)
      if (first) { first = false; entered.resolve(); await gate.promise }
      return rows
    }
    refresh = f.service.refresh()
    await entered.promise
    now = asOf + fiveMinutes + 1
    await f.service.persistCandles(value.instId, [row(asOf, 400_000)])
    await f.service.checkCandidate(value, f.service.prefs().liquidity, f.service.catalogCriteriaKey(), new AbortController().signal, 'foreground', { localOnly: true })
    const current = f.service.observations.get(value.instId).turnover
    assert.equal(current.value.asOf, asOf + fiveMinutes)
    assert.equal(current.value.turnover, 57_800_000)
    gate.resolve(); await refresh
    assert.equal(f.service.observations.get(value.instId).turnover, current)
    assert.equal(f.service.catalog.get(value.instId).result.turnover, 57_800_000)
  } finally { gate.resolve(); await refresh; await f.close() }
})

test('reconnect admits every price series while charts retain ownership of statistics acquisition', async () => {
  const f = await fixture(preferences())
  const gate = deferred(), events: string[] = []
  let recovery: Promise<void> | undefined
  try {
    f.service.listedUniverse = new Set(['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    f.store.coverage = async () => ({ first: null, last: null, count: 0 })
    f.service.history.ensurePrices = async (id: string) => {
      events.push(`prices:${id}`)
      if (id === 'BTC-USDT-SWAP') await gate.promise
      return { rows: [] }
    }
    f.service.history.ensureStatistics = async (id: string) => { events.push(`statistics:${id}`); return { rows: [] } }
    recovery = f.service.reconcileRealtime([{ instId: 'BTC-USDT-SWAP', timeframe: '5m' }, { instId: 'ETH-USDT-SWAP', timeframe: '5m' }])
    await waitFor(() => events.includes('prices:ETH-USDT-SWAP'))
    gate.resolve(); await recovery
    assert.deepEqual(events.sort(), ['prices:BTC-USDT-SWAP', 'prices:ETH-USDT-SWAP'])
  } finally { gate.resolve(); await recovery; await f.close() }
})

test('failed reconnect recovery drains an already accepted sibling before reporting its failure', async () => {
  const f = await fixture(preferences())
  const gate = deferred()
  let siblingStarted = false, siblingWritten = false, finished = false
  let recovery: Promise<void> | undefined
  try {
    f.service.listedUniverse = new Set(['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    f.store.coverage = async () => ({ first: null, last: null, count: 0 })
    f.service.history.ensurePrices = async (id: string) => {
      if (id === 'BTC-USDT-SWAP') throw new Error('The first recovery source failed.')
      siblingStarted = true; await gate.promise
      siblingWritten = true
      return { rows: [] }
    }
    f.service.history.ensureStatistics = async () => { throw new Error('Collector recovery cannot own statistics acquisition.') }
    const running: Promise<void> = f.service.reconcileRealtime([{ instId: 'BTC-USDT-SWAP', timeframe: '5m' }, { instId: 'ETH-USDT-SWAP', timeframe: '5m' }])
    recovery = running
    void running.then(() => { finished = true }, () => { finished = true })
    await waitFor(() => siblingStarted)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    gate.resolve()
    await assert.rejects(running, /first recovery source failed/)
    assert.equal(siblingWritten, true)
  } finally { gate.resolve(); await recovery?.catch(() => undefined); await f.close() }
})

test('canceling a queued candidate publication prevents the deferred batch from displaying it', async () => {
  const f = await fixture(preferences())
  try {
    const value = instrument(), now = Date.now(), controller = new AbortController()
    f.service.instruments.set(value.instId, value)
    f.service.instrumentObservations.set(value.instId, { observedAt: now, expiresAt: now + 90_000 })
    const publication = f.service.publishCandidate(value, f.service.prefs().liquidity, f.service.catalogCriteriaKey(), controller.signal, {}, {})
    assert.equal(f.service.catalog.size, 0, 'Candidate results publish only when their shared batch flushes.')
    controller.abort()
    await publication
    assert.equal(f.service.catalog.size, 0, 'The batch must retain and honor the original publisher signal.')
    assert.deepEqual(f.service.history.sync.listTasks(), [])
  } finally { await f.close() }
})

test('a superseded queued assessment cannot replace its newer failure or start historical requests', async () => {
  const f = await fixture(preferences('spread'))
  try {
    const value = instrument(), now = Date.now()
    f.service.instruments.set(value.instId, value)
    f.service.instrumentObservations.set(value.instId, { observedAt: now, expiresAt: now + 90_000 })
    const observations = { ticker: { value: ticker(value.instId), observedAt: now, expiresAt: now + 90_000 } }
    const publication = f.service.publishCandidate(value, f.service.prefs().liquidity, f.service.catalogCriteriaKey(), new AbortController().signal, observations, {})
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'verified')
    observations.ticker = { ...observations.ticker, value: { ...ticker(value.instId), bidPx: '99', askPx: '100' } }
    f.service.verifyCatalog()
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'failed')
    await publication
    assert.equal(f.service.catalog.size, 0, 'The queued older assessment must not override a newer verification result.')
    assert.equal(f.service.catalogChecks.get(value.instId).status, 'failed')
    assert.deepEqual(f.service.history.sync.listTasks(), [], 'A superseded assessment must not consume historical request capacity.')
  } finally { await f.close() }
})

test('market subscribers receive the final bulk change together and stop receiving updates after unsubscribe or disposal', async context => {
  const now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const instruments = Array.from({ length: 150 }, (_, index) => instrument(`COIN${index}`))
  let price = 100
  const f = await fixture(preferences('spread'), async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response(instruments)
    if (path.endsWith('/market/tickers')) return response(instruments.map(value => ticker(value.instId, price)))
    throw new Error(`Unexpected endpoint: ${path}`)
  })
  try {
    await f.service.refresh()
    const before = await f.service.snapshot()
    let notifications = 0
    let reading: ReturnType<typeof f.service.snapshot> | undefined
    const unsubscribe = f.service.subscribeMarket(() => {
      notifications += 1
      reading = f.service.snapshot({ sinceRevision: before.revision, serviceSession: before.serviceSession })
    })
    price = 200
    await f.service.refresh()
    await waitFor(() => notifications > 0)
    assert.ok(reading)
    const changed = await reading
    assert.ok('rows' in changed)
    assert.ok(changed.revision > before.revision)
    assert.equal(changed.rows.length, 150)
    assert.ok(changed.rows.every(row => row.lastPrice === 200), 'The subscriber must read the complete changed source batch.')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(notifications, 1, 'One source batch must not wake the renderer separately for all 150 contracts.')

    unsubscribe()
    price = 300
    await f.service.refresh()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(notifications, 1)

    let afterDisposal = 0
    f.service.subscribeMarket(() => { afterDisposal += 1 })
    f.service.touchList()
    await f.service.dispose()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(afterDisposal, 0, 'Disposal must cancel an already queued renderer wakeup.')
  } finally { await f.close() }
})
