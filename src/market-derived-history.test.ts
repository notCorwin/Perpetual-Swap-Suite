import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MarketStore, type CandleRecord } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES, type Preferences } from '../electron/services/preferences.js'

const instId = 'BTC-USDT-SWAP', step = 300_000, base = Date.UTC(2024, 0, 1)
const row = (index: number): CandleRecord => ({ instrument: instId, timeframe: '5m', timestamp: base + index * step,
  open: 100, high: 110 + index, low: 90 - index, close: 101 + index,
  volume: 5, baseVolume: 1, quoteVolume: 100, confirmed: true })
async function fixture(get: (url: URL) => unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'perp-derived-history-')), store = await MarketStore.open(root)
  const preferences: Preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  const requests: URL[] = []
  const service = new MarketService(store, () => preferences, async input => {
    const url = new URL(String(input)); requests.push(url)
    return new Response(JSON.stringify({ code: '0', data: get(url) }))
  }, false)
  await service.ready
  service.instruments.set(instId, { instId, listTime: String(base) })
  for (const lane of service.requestLanes.values()) lane.interval = 0
  return { store, service, preferences, requests, close: async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('historical parent price gaps reuse already-local 5m facts without any exchange request', async () => {
  const f = await fixture(() => { throw new Error('Existing fine periods must satisfy the parent locally.') })
  try {
    await f.store.appendCandles(Array.from({ length: 12 }, (_, index) => row(index)))
    const hourly = await f.service.history.ensurePrices(instId, '1H', base, base)
    const quarters = await f.service.history.ensurePrices(instId, '15m', base, base + 9 * step)
    assert.equal(hourly.rows.length, 1)
    assert.equal(hourly.rows[0].volume, 60)
    assert.equal(hourly.rows[0].close, 112)
    assert.equal(quarters.rows.length, 4)
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('a missing fine prefix does not expand a coarse historical request into twelve remote candles', async () => {
  const f = await fixture(url => {
    assert.equal(url.pathname, '/api/v5/market/history-candles')
    assert.equal(url.searchParams.get('bar'), '1H')
    return [[String(base), '100', '120', '90', '110', '60', '12', '1200', '1']]
  })
  try {
    await f.store.appendCandles([row(0)])
    assert.equal((await f.service.history.ensurePrices(instId, '1H', base, base)).rows.length, 1)
    assert.equal(f.requests.length, 1)
  } finally { await f.close() }
})

test('complete observed trades replace closed Taker REST while OI keeps its independent source', async context => {
  context.mock.method(Date, 'now', () => base + step + 100)
  const f = await fixture(url => {
    assert.equal(url.pathname, '/api/v5/rubik/stat/contracts/open-interest-history')
    return [[String(base), '500']]
  })
  try {
    const candle = row(0)
    await f.store.appendCandles([candle])
    f.service.listedUniverse.add(instId)
    f.preferences.chartTimeframe = '5m'
    f.service.liveStatistics.start(instId, base)
    f.service.liveStatistics.trades(instId, [
      { instId, tradeId: '1', ts: String(base + 1), side: 'buy', sz: '2' },
      { instId, tradeId: '2', ts: String(base + 2), side: 'sell', sz: '3' },
    ], base + 3)
    await f.service.confirmStatistics(candle)
    await f.service.confirmStatistics(candle)
    const [saved] = await f.store.candles({ instrument: instId, timeframe: '5m', from: base, through: base })
    assert.equal(saved.buy, 2)
    assert.equal(saved.sell, 3)
    assert.equal(saved.oi, 500)
    assert.equal(f.requests.length, 1)
  } finally { await f.close() }
})

test('unselected closes save local Taker facts without acquiring remote statistics', async context => {
  context.mock.method(Date, 'now', () => base + step + 100)
  const f = await fixture(() => { throw new Error('An unselected close must not acquire history.') })
  try {
    const candle = row(0)
    await f.store.appendCandles([candle])
    f.service.listedUniverse.add(instId)
    f.preferences.chartTimeframe = '15m'
    f.service.liveStatistics.start(instId, base)
    f.service.liveStatistics.trades(instId, [
      { instId, tradeId: '1', ts: String(base + 1), side: 'buy', sz: '5' },
    ], base + 2)
    await f.service.confirmStatistics(candle)
    const [saved] = await f.store.candles({ instrument: instId, timeframe: '5m', from: base, through: base })
    assert.deepEqual([saved.buy, saved.sell, saved.oi], [5, 0, null])
    assert.equal(f.requests.length, 0)
    f.service.preparedCharts.focus = { instId, timeframe: '5m' }
    assert.equal(f.service.statisticsAcquisitionDemand(instId, '5m'), true)
    assert.equal(f.service.statisticsAcquisitionDemand(instId, '1H'), false)
  } finally { await f.close() }
})

test('a corrected close arriving during the local Taker write is recalculated and persisted', async context => {
  context.mock.method(Date, 'now', () => base + step + 100)
  const f = await fixture(() => { throw new Error('An unselected close must not acquire history.') })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const writing = new Promise<void>(resolve => { entered = resolve })
  try {
    const candle = row(0), corrected = { ...candle, volume: 6 }
    await f.store.appendCandles([candle])
    f.service.listedUniverse.add(instId)
    f.preferences.chartTimeframe = '15m'
    f.service.liveStatistics.start(instId, base)
    f.service.liveStatistics.trades(instId, [{ instId, tradeId: '1', ts: String(base + 1), side: 'buy', sz: '5' }], base + 2)
    const append = f.store.appendStatistics.bind(f.store)
    let writes = 0
    f.store.appendStatistics = async (...args) => {
      if (++writes === 1) { entered(); await gate }
      return append(...args)
    }
    const original = f.service.confirmStatistics(candle)
    await writing
    await f.store.appendCandles([corrected])
    f.service.liveStatistics.trades(instId, [{ instId, tradeId: '2', ts: String(base + 2), side: 'sell', sz: '1' }], base + 3)
    const update = f.service.confirmStatistics(corrected)
    release(); await Promise.all([original, update])
    const [saved] = await f.store.candles({ instrument: instId, timeframe: '5m', from: base, through: base })
    assert.equal(writes, 2)
    assert.deepEqual([saved.volume, saved.buy, saved.sell], [6, 5, 1])
  } finally { release(); await f.close() }
})

test('a late trade updates a local Taker proof even when the candle volume is unchanged', async context => {
  context.mock.method(Date, 'now', () => base + step + 100)
  const f = await fixture(() => { throw new Error('An unselected close must not acquire history.') })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const written = new Promise<void>(resolve => { entered = resolve })
  try {
    const candle = row(0)
    await f.store.appendCandles([candle])
    f.service.listedUniverse.add(instId)
    f.preferences.chartTimeframe = '15m'
    f.service.liveStatistics.start(instId, base)
    f.service.liveStatistics.trades(instId, [{ instId, tradeId: '1', ts: String(base + 1), side: 'buy', sz: '4.999999995' }], base + 2)
    const append = f.store.appendStatistics.bind(f.store)
    let writes = 0
    f.store.appendStatistics = async (...args) => {
      const result = await append(...args)
      if (++writes === 1) { entered(); await gate }
      return result
    }
    const first = f.service.confirmStatistics(candle)
    await written
    f.service.liveStatistics.trades(instId, [{ instId, tradeId: '2', ts: String(base + 2), side: 'sell', sz: '0.000000005' }], base + 3)
    const second = f.service.confirmStatistics(candle)
    release(); await Promise.all([first, second])
    const [saved] = await f.store.candles({ instrument: instId, timeframe: '5m', from: base, through: base })
    assert.equal(writes, 2)
    assert.deepEqual([saved.volume, saved.buy, saved.sell], [5, 4.999999995, 0.000000005])
  } finally { release(); await f.close() }
})
