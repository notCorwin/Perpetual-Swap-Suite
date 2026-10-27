import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MarketStore, type CandleQuery } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'
import type { RealtimeWebSocket } from '../electron/services/realtime-market.js'

const fiveMinutes = 300_000
const fifteenMinutes = 900_000
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type Subscription = { channel: string; instId?: string; instType?: string }
const subscriptionKey = (arg: Subscription) => `${arg.channel}:${arg.instId ?? arg.instType}`

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  acknowledged = new Map<string, Subscription>()
  constructor() {
    super()
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }))
  }
  send(value: string) {
    assert.equal(this.readyState, 1)
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    for (const arg of command.args as Subscription[]) queueMicrotask(() => {
      if (this.readyState !== 1) return
      if (command.op === 'subscribe') this.acknowledged.set(subscriptionKey(arg), arg)
      else this.acknowledged.delete(subscriptionKey(arg))
      this.message({ id: command.id, event: command.op, arg })
      if (command.op === 'subscribe' && arg.channel === 'books') queueMicrotask(() => this.message({ arg, action: 'snapshot', data: [{
        seqId: 1, prevSeqId: -1, ts: String(Date.now()), bids: [['99.99', '2000', '0', '1']], asks: [['100', '2000', '0', '1']],
      }] }))
    })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })))
  }
}

test('automatic startup gates 289 candidates on shared tickers and OI before acquiring only 14 qualifying windows', { timeout: 30_000 }, async t => {
  const started = performance.now(), wallClock = Date.now.bind(Date), wallStart = wallClock()
  // Keep ordinary request pacing and socket connection gates, away from a bar rollover.
  const asOf = Math.floor(wallStart / fiveMinutes) * fiveMinutes
  t.mock.method(Date, 'now', () => asOf + 60_000 + wallClock() - wallStart)
  const root = await mkdtemp(join(tmpdir(), 'perp-startup-regression-'))
  const tickerGate = deferred(), interestGate = deferred(), sockets: Socket[] = [], requests: URL[] = []
  const unexpected: string[] = []
  const instruments = Array.from({ length: 289 }, (_, index) => {
    const symbol = `START${String(index).padStart(3, '0')}`
    return { instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live',
      ctVal: '1', ctMult: '1', ctValCcy: symbol, ruleType: 'normal' }
  })
  const healthy = instruments.slice(-14).map(value => value.instId), healthyIDs = new Set(healthy)
  const ticker = (instId: string) => ({ instId, last: '100', bidPx: '99.99', askPx: '100', ts: String(Date.now()) })
  const requestsFor = (path: string) => requests.filter(url => url.pathname.endsWith(path))
  const waitFor = async (condition: () => boolean, description: string) => {
    const deadline = Math.min(started + 26_000, performance.now() + 10_000)
    while (!condition()) {
      assert.ok(performance.now() < deadline, `Timed out waiting for ${description}.`)
      await delay(5, undefined, { signal: t.signal })
    }
  }
  let store: MarketStore | undefined, service: MarketService | undefined
  try {
    store = await MarketStore.open(root)
    const latest15m = Math.floor(Date.now() / fifteenMinutes) * fifteenMinutes - fifteenMinutes
    const first5m = latest15m - 299 * fifteenMinutes
    const baseCount = (asOf - fiveMinutes - first5m) / fiveMinutes + 1
    const seeded = healthy.flatMap(instrument => Array.from({ length: baseCount }, (_, index) => {
      const timestamp = first5m + index * fiveMinutes
      const close = 100 + index / 100
      return { instrument, timeframe: '5m', timestamp,
        open: close - .05, high: close + 1, low: close - 1, close, volume: 2000, baseVolume: 2000, quoteVolume: 200_000, confirmed: true }
    }))
    assert.equal(await store.appendCandles(seeded), 14 * baseCount)
    const reads = t.mock.method(store, 'candles')
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input)); requests.push(url)
      if (url.pathname.endsWith('/public/instruments')) {
        assert.ok(sockets.some(socket => socket.acknowledged.has('instruments:SWAP')), 'Discovery follows the real metadata subscription ACK.')
        return response(instruments)
      }
      if (url.pathname.endsWith('/market/tickers')) { await tickerGate.promise; return response(instruments.map(value => ticker(value.instId))) }
      if (url.pathname.endsWith('/public/open-interest')) {
        assert.equal(url.searchParams.get('instType'), 'SWAP')
        assert.equal(url.searchParams.has('instId'), false, 'OI is acquired once for the whole exchange.')
        await interestGate.promise
        return response(instruments.map(({ instId }) => ({ instId, oi: '100000', oiUsd: healthyIDs.has(instId) ? '10000000' : '1000000', ts: String(Date.now()) })))
      }
      if (url.pathname.endsWith('/market/books')) return response([{ bids: [['99.99', '2000']], asks: [['100', '2000']], ts: String(Date.now()) }])
      // Unpublished independent native statistics are successful empty observations.
      if (url.pathname.includes('/rubik/stat/')) return response([])
      unexpected.push(url.toString())
      throw new Error(`Unexpected acquisition: ${url}`)
    }
    const market = service = new MarketService(store, () => DEFAULT_PREFERENCES, fetcher, true, {
      webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket },
    })
    const candidates = t.mock.method(market, 'checkCandidate')
    const qualificationReads = t.mock.method(market, 'readQualificationCandles')
    await market.ready
    const history = t.mock.method(market.history, 'ensurePrices')
    await waitFor(() => market.instrumentSnapshotReady && market.instrumentStream?.synchronized
      && market.candidateIDs?.size === 289 && requestsFor('/market/tickers').length === 1, 'acknowledged metadata snapshot with the ticker response held')
    await delay(120, undefined, { signal: t.signal })
    const metadataMS = Math.round(performance.now() - started)
    assert.equal(candidates.mock.callCount(), 0, 'Metadata synchronization cannot bypass the startup ticker gate.')
    assert.equal(qualificationReads.mock.callCount(), 0)
    assert.equal(reads.mock.callCount(), 0)
    assert.equal(history.mock.callCount(), 0)
    assert.equal(requestsFor('/public/open-interest').length, 0)
    assert.equal(requestsFor('/market/books').length, 0)

    tickerGate.resolve()
    await waitFor(() => requestsFor('/public/open-interest').length === 1 && market.candidateTasks.size === 289, 'all candidates waiting for shared bulk OI')
    await waitFor(() => market.tickerSubscriptions.size === 289, 'all paced native ticker subscription ACKs')
    for (const socket of sockets) for (const arg of socket.acknowledged.values()) {
      if (arg.channel === 'tickers') socket.message({ arg, data: [ticker(arg.instId!)] })
    }
    await waitFor(() => instruments.every(({ instId }) => market.observations.get(instId)?.ticker?.source === 'websocket'), '289 native tickers')
    market.flushStreamQualifications()
    await waitFor(() => market.sourceRecoveries.size === 289, 'native tick recovery consumers waiting for OI')
    // Let the real deadline scheduler admit recovery while the HTTP source stays held.
    await delay(120, undefined, { signal: t.signal })
    const pendingOIMS = Math.round(performance.now() - started)
    assert.ok([...market.sourceRecoveries.values()].every(value => value.source === 'openInterest'), 'Pending OI cannot schedule book or historical recovery.')
    assert.ok(instruments.every(({ instId }) => !market.observations.get(instId)?.openInterest))
    assert.equal(qualificationReads.mock.callCount(), 0, 'Native ticks cannot scan historical windows before the cheap OI gate completes.')
    assert.equal(reads.mock.callCount(), 0)
    assert.equal(history.mock.callCount(), 0)
    assert.equal(requestsFor('/market/books').length, 0)
    assert.equal(requestsFor('/public/open-interest').length, 1)
    assert.deepEqual(market.listRowsFor(), [])

    interestGate.resolve()
    await waitFor(() => market.refreshing === null && market.candidateTasks.size === 0 && market.sourceRecoveries.size === 0
      && market.streamQualifications.size === 0 && market.streamEvaluations.size === 0 && market.backgroundTasks.size === 0, 'qualification and backend chart preparation')
    const completedMS = Math.round(performance.now() - started)
    const snapshot = await market.snapshot()
    assert.deepEqual(snapshot.catalogProgress, { total: 289, completed: 289, pending: 0, verified: 14, failed: 275, unknown: 0 })
    assert.equal('listProgress' in snapshot, false)
    assert.equal(snapshot.loading, false)
    assert.equal(snapshot.error, '')
    assert.deepEqual(snapshot.rows.map(row => row.instId).sort(), healthy)
    for (const row of snapshot.rows) {
      assert.equal(row.turnover24hUSDT, 57_600_000)
      assert.equal(row.lastPrice, 100)
      assert.ok(Number.isFinite(row.rankingChange))
      assert.equal(market.validCatalogEntry(market.catalog.get(row.instId)), true)
      assert.deepEqual(Object.keys(row).sort(), ['instId', 'lastPrice', 'turnover24hUSDT', 'rankingChange', 'rankingAsOf'].sort())
    }
    const windows: CandleQuery[] = qualificationReads.mock.calls.map((call: { arguments: [CandleQuery, AbortSignal] }) => call.arguments[0])
    assert.equal(windows.length, 14, 'Only the final 14 cheap-gate survivors read qualification windows, rather than all 289 candidates.')
    assert.deepEqual(windows.map(query => query.instrument).sort(), healthy)
    assert.ok(windows.every(query => query.timeframe === '5m' && query.from === asOf - 288 * fiveMinutes && query.through === asOf - fiveMinutes))
    assert.ok(reads.mock.calls.every(call => healthyIDs.has(call.arguments[0].instrument)), 'None of the 275 bulk-OI failures reads per-contract candle data.')
    assert.equal(history.mock.callCount(), 0, 'Seeded 5m SQLite history and local aggregation need no source acquisition.')
    assert.equal(requestsFor('/market/books').length, 0, 'Live books come from their subscribed WebSocket snapshot without REST duplicates.')
    assert.equal(market.publicRealtime.getTelemetry().bookEvents, 14, 'Each eligible contract qualifies from an acknowledged WebSocket snapshot.')
    assert.ok(healthy.every(id => market.observations.get(id)?.book?.source === 'websocket'))
    assert.equal(requestsFor('/public/open-interest').length, 1)
    assert.equal(requestsFor('/market/tickers').length, 1)
    assert.equal(requestsFor('/public/instruments').length, 1)
    assert.deepEqual(unexpected, [])
    assert.ok(requests.filter(url => url.searchParams.has('instId')).every(url => healthyIDs.has(url.searchParams.get('instId')!)))
    t.diagnostic(JSON.stringify({ metadataMS, pendingOIMS, completedMS, qualificationWindows: windows.length, bulkOIRequests: 1,
      bookRequests: requestsFor('/market/books').length, websocketBookSnapshots: market.publicRealtime.getTelemetry().bookEvents,
      historyAcquisitions: history.mock.callCount(), candleReads: reads.mock.callCount(), database: store.getDiagnostics().reads }))
  } finally {
    tickerGate.resolve(); interestGate.resolve()
    await service?.dispose()
    await store?.close()
    await rm(root, { recursive: true, force: true })
  }
})
