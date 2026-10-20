import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'
import type { RealtimeWebSocket } from '../electron/services/realtime-market.js'
import type { PreparedChartResponse } from './chart-data.ts'

const instId = 'BTC-USDT-SWAP', timeframe = '15m', step = 900_000
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const raw = (timestamp: number, close: number, volume: number) => [String(timestamp), '100', '250', '90', String(close), String(volume), '1', '500', '0']
class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  send(value: string) {
    if (value === 'ping') return
    const command = JSON.parse(value)
    for (const arg of command.args) queueMicrotask(() => this.message({ id: command.id, event: command.op, arg }))
  }
  close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
}

for (const volume of [5, 8]) test(`late forming REST cannot replace a newer native price with cumulative volume ${volume}`, async t => {
  // Both observations have the exact same clock value: admission is a source
  // revision, and an equal-volume native OHLC correction is still newer.
  const now = Math.floor(Date.now() / step) * step + 60_000
  t.mock.method(Date, 'now', () => now)
  const root = await mkdtemp(join(tmpdir(), 'perp-forming-source-race-')), store = await MarketStore.open(root)
  const held = deferred(), requested = deferred(), socket = new Socket(), published: PreparedChartResponse[] = []
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/candles')
    requested.resolve(); await held.promise
    return new Response(JSON.stringify({ code: '0', data: [raw(now - 60_000, 100, 5)] }))
  }, false, { webSocketFactory: () => socket })
  let pending: Promise<unknown> | undefined
  try {
    await service.ready
    await service.setChartUniverse([instId], timeframe, instId)
    service.subscribePreparedCharts(frame => published.push(frame))
    // Quote acquisition has its own lifetime; chart history demand now owns
    // completed-window coverage instead of substituting a latest-only read.
    pending = service.history.latest(instId, timeframe)
    await requested.promise
    assert.equal(service.history.latest(instId, timeframe), pending, 'Concurrent quote readers share their admitted source request.')
    service.realtime.start(); socket.open()
    await service.realtime.whenIdle()
    socket.message({ arg: { channel: 'candle15m', instId }, data: [raw(now - 60_000, 200, volume)] })
    await service.realtime.whenIdle()
    assert.equal(service.liveCandles.get(`${instId}:${timeframe}`).close, 200)
    assert.equal(service.preparedCharts.cached(`${instId}:${timeframe}`).liveBar.close, 200)
    held.resolve(); await pending
    await Promise.allSettled([...service.preparedCharts.tasks.values()])
    assert.equal(service.liveCandles.get(`${instId}:${timeframe}`).close, 200)
    assert.equal(service.preparedCharts.cached(`${instId}:${timeframe}`).liveBar.close, 200)
    assert.ok(published.some(frame => frame.liveBar?.close === 200))
    assert.ok(published.filter(frame => frame.liveBar).every(frame => frame.liveBar?.close === 200), 'No stale REST forming price may cross the publication boundary.')
    assert.equal(service.realtime.getTelemetry().formingEvents, 1)
    assert.equal((await store.coverage(instId, timeframe)).count, 0, 'Forming observations remain memory only.')
  } finally {
    held.resolve(); await pending?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})

test('a latest read admitted before the first native tick cannot revive its source after delisting and relisting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-forming-source-epoch-')), store = await MarketStore.open(root)
  const held = deferred(), requested = deferred(), timestamp = Math.floor(Date.now() / step) * step
  const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live',
    ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
  const service = new MarketService(store, () => DEFAULT_PREFERENCES, async input => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v5/rubik/')) return new Response(JSON.stringify({ code: '0', data: [] }))
    assert.equal(url.pathname, '/api/v5/market/candles')
    requested.resolve(); await held.promise
    return new Response(JSON.stringify({ code: '0', data: [raw(timestamp, 100, 5)] }))
  }, false)
  let pending: Promise<unknown> | undefined
  try {
    await service.ready
    service.installInstruments(new Map([[instId, instrument]]))
    await service.setChartUniverse([instId], timeframe, instId)
    pending = service.history.latest(instId, timeframe)
    await requested.promise
    assert.equal(service.liveCandles.size, 0, 'No native price has established this source yet.')
    service.installInstruments(new Map())
    service.installInstruments(new Map([[instId, instrument]]))
    held.resolve(); await pending
    await Promise.allSettled([...service.preparedCharts.tasks.values()])
    assert.equal(service.liveCandles.has(`${instId}:${timeframe}`), false)
    assert.equal(service.preparedCharts.cached(`${instId}:${timeframe}`)?.liveBar, undefined,
      'A new listing lifetime cannot accept a response admitted by its removed lifetime.')
    await service.history.latest(instId, timeframe)
    assert.equal(service.liveCandles.get(`${instId}:${timeframe}`).close, 100,
      'A fresh REST request remains valid in the relisted source lifetime.')
  } finally {
    held.resolve(); await pending?.catch(() => {})
    await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})
