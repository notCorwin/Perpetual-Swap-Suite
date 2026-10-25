import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES, type Preferences } from '../electron/services/preferences.js'
import type { RealtimeWebSocket } from '../electron/services/realtime-market.js'

const instId = 'BTC-USDT-SWAP'
const FIVE_MINUTES = 300_000
const HOUR = 3_600_000

const response = (data: unknown[]) => new Response(JSON.stringify({ code: '0', data }))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 4_000
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for the 1H derived candle.')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function fine(hourStart: number, index: number, timeframe = '5m', confirmed = true) {
  const timestamp = hourStart + index * FIVE_MINUTES
  return {
    instrument: instId, timeframe, timestamp,
    open: 100 + index, high: 102 + index, low: 98 + index, close: 101 + index,
    volume: index + 1, baseVolume: (index + 1) / 10, quoteVolume: (index + 1) * 100, confirmed,
  }
}

const raw = (row: ReturnType<typeof fine>) => [String(row.timestamp), String(row.open), String(row.high), String(row.low),
  String(row.close), String(row.volume), String(row.baseVolume), String(row.quoteVolume), row.confirmed ? '1' : '0']

const previousHour = (hourStart: number) => ({ instrument: instId, timeframe: '1H', timestamp: hourStart - HOUR,
  open: 80, high: 90, low: 70, close: 85, volume: 50, baseVolume: 5, quoteVolume: 500, confirmed: true })

class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  send(value: string) {
    if (value === 'ping') return
    const command = JSON.parse(value)
    for (const arg of command.args) queueMicrotask(() => this.message({ id: command.id, event: command.op, arg }))
  }
  close() {
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '', wasClean: true })))
  }
}

async function fixture(hourStart: number, options: { holdPrefix?: ReturnType<typeof deferred> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-live-prefix-'))
  const store = await MarketStore.open(root)
  const preferences: Preferences = structuredClone(DEFAULT_PREFERENCES)
  preferences.chartTimeframe = '1H'
  preferences.rankingLookback = 15
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  preferences.liquidity.volume24h.enabled = false
  const socket = new Socket(), requests: URL[] = []
  const instrument = {
    instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live',
    ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal', listTime: String(hourStart - 24 * HOUR),
  }
  const service = new MarketService(store, () => preferences, async input => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/market/history-candles')) {
      assert.equal(url.searchParams.get('bar'), '5m', 'The live parent must acquire its missing fine prefix.')
      if (options.holdPrefix) await options.holdPrefix.promise
      const limit = Number(url.searchParams.get('limit'))
      const after = Number(url.searchParams.get('after'))
      return response(Array.from({ length: limit }, (_, index) => raw(fine(hourStart, (after - FIVE_MINUTES * (index + 1) - hourStart) / FIVE_MINUTES))))
    }
    if (url.pathname.endsWith('/market/candles')) {
      assert.equal(url.searchParams.get('bar'), '1H')
      return response([[String(hourStart), '1000', '1100', '900', '1050', '1', '1', '1', '0']])
    }
    throw new Error(`Unexpected HTTP request: ${url.pathname}`)
  }, false, { webSocketFactory: () => socket })
  await service.ready
  for (const lane of service.requestLanes.values()) lane.interval = 0
  service.installInstruments(new Map([[instId, instrument]]))
  service.listedUniverse.add(instId)
  service.realtime.setSubscriptions([{ instId, timeframe: '5m' }])
  service.preparedCharts.setRealtimeSubscriptions([{ instId, timeframe: '5m' }, { instId, timeframe: '1H' }])
  service.realtime.start(); socket.open(); await service.realtime.whenIdle()
  assert.equal(service.realtime.isSubscribed(instId, '5m'), true)
  const cleanup = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, preferences, requests, socket, cleanup }
}

test('a cold 1H live prefix fetches only missing closed 5m rows once and aggregates the complete fine prefix', async t => {
  const now = Math.floor(Date.now() / HOUR) * HOUR + 49 * 60_000
  const hour = Math.floor(now / HOUR) * HOUR
  t.mock.method(Date, 'now', () => now)
  const held = deferred(), f = await fixture(hour, { holdPrefix: held })
  try {
    // Ranking's 15 minute tail is present, but the current hourly prefix is cold.
    await f.store.appendCandles([fine(hour, 6), fine(hour, 7), fine(hour, 8), previousHour(hour)])
    const current = fine(hour, 9, '5m', false)
    current.high = 130; current.low = 95; current.close = 119
    f.socket.message({ arg: { channel: 'candle5m', instId }, data: [raw(current)] })
    await f.service.realtime.whenIdle()
    assert.equal(f.service.liveCandles.has(`${instId}:1H`), false, 'The SQLite bootstrap must not invent the missing hourly prefix.')

    const first = f.service.latestChartPrice(instId, '1H', 'interactive')
    const fetchStarted = f.requests.length
    const started = waitFor(() => f.requests.length > fetchStarted)
    await started
    const second = f.service.latestChartPrice(instId, '1H', 'interactive')
    const prefixRequest = f.requests.find(url => url.pathname.endsWith('/market/history-candles'))
    assert.ok(prefixRequest)
    assert.equal(prefixRequest.searchParams.get('bar'), '5m')
    assert.equal(Number(prefixRequest.searchParams.get('limit')), 6, 'Only the six missing closed children should be fetched.')
    assert.equal(Number(prefixRequest.searchParams.get('after')), hour + 6 * FIVE_MINUTES)
    assert.ok(Number(prefixRequest.searchParams.get('limit')) <= 11, 'A parent period can need at most eleven closed fine rows.')
    assert.equal(f.requests.filter(url => url.pathname.endsWith('/market/candles')).length, 0,
      'The live 1H quote must be reconstructed from the 5m stream, not a coarse REST snapshot.')
    held.resolve()
    await Promise.all([first, second])
    await waitFor(() => f.service.liveCandles.get(`${instId}:1H`)?.close === current.close)

    const parent = f.service.liveCandles.get(`${instId}:1H`)
    assert.deepEqual([parent.open, parent.high, parent.low, parent.close], [100, 130, 95, 119])
    assert.deepEqual([parent.volume, parent.baseVolume, parent.quoteVolume], [55, 5.5, 5_500])
    assert.ok(parent.volume > 0 && parent.baseVolume > 0 && parent.quoteVolume > 0, 'Missing children must never become zero-valued placeholders.')
    assert.equal(f.service.priceStreaming(instId, '1H'), true, 'Only the complete derivation owns the coarse streaming quote.')
    assert.equal(f.requests.filter(url => url.pathname.endsWith('/market/history-candles')).length, 1,
      'Concurrent latest chart readers share the same prefix acquisition.')
    const durable = await f.store.candles({ instrument: instId, timeframe: '5m', from: hour, through: hour + 8 * FIVE_MINUTES })
    assert.equal(durable.length, 9)
    assert.deepEqual(durable.map(row => row.timestamp), Array.from({ length: 9 }, (_, index) => hour + index * FIVE_MINUTES))

    const correction = { ...current, close: 123, high: 135, volume: 10.5, baseVolume: 1.05, quoteVolume: 1_050 }
    f.socket.message({ arg: { channel: 'candle5m', instId }, data: [raw(correction)] })
    await f.service.realtime.whenIdle()
    await waitFor(() => f.service.liveCandles.get(`${instId}:1H`)?.close === correction.close)
    assert.equal(f.service.liveCandles.get(`${instId}:1H`).volume, 55.5)
    assert.equal(f.requests.filter(url => url.pathname.endsWith('/market/history-candles')).length, 1,
      'A later 5m update reuses the repaired prefix without another HTTP read.')
  } finally { held.resolve(); await f.cleanup() }
})

test('a native 1H REST forming row is not streaming proof, and a durable 5m prefix needs no HTTP', async t => {
  const now = Math.floor(Date.now() / HOUR) * HOUR + 49 * 60_000
  const hour = Math.floor(now / HOUR) * HOUR
  t.mock.method(Date, 'now', () => now)
  const f = await fixture(hour)
  try {
    await f.store.appendCandles([
      ...Array.from({ length: 9 }, (_, index) => fine(hour, index)),
      previousHour(hour),
    ])
    // Exercise the low-level coarse REST source so a 5m ACK cannot confer provenance by itself.
    await f.service.history.latest(instId, '1H')
    assert.equal(f.service.liveCandles.get(`${instId}:1H`)?.close, 1050)
    assert.equal(f.service.priceStreaming(instId, '1H'), false)

    const current = fine(hour, 9, '5m', false)
    f.socket.message({ arg: { channel: 'candle5m', instId }, data: [raw(current)] })
    await f.service.realtime.whenIdle()
    await waitFor(() => f.service.liveCandles.get(`${instId}:1H`)?.close === current.close)
    assert.equal(f.service.priceStreaming(instId, '1H'), true, 'The derived row gains provenance only after the complete prefix is available.')

    f.requests.length = 0
    await f.service.latestChartPrice(instId, '1H', 'interactive')
    assert.deepEqual(f.requests, [], 'A durable 5m prefix reconstructs the selected parent without any HTTP request.')
    const parent = f.service.liveCandles.get(`${instId}:1H`)
    assert.deepEqual([parent.open, parent.high, parent.low, parent.close], [100, 111, 98, 110])
    assert.deepEqual([parent.volume, parent.baseVolume, parent.quoteVolume], [55, 5.5, 5_500])
  } finally { await f.cleanup() }
})
