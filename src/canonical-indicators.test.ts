import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'

test('list and chart share the full-history EMA seed through corrections, eviction and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-canonical-'))
  let store = await MarketStore.open(root)
  const instrument = { instId: 'BTC-USDT-SWAP' }, step = 300_000, first = Date.UTC(2024, 0, 1)
  const rows = Array.from({ length: 1000 }, (_, index) => {
    const close = index < 799 ? 1000 : 100
    return { instrument: instrument.instId, timeframe: '5m', timestamp: first + index * step,
      open: close, high: close, low: close, close, volume: 1, baseVolume: 1, quoteVolume: close,
      confirmed: true, statisticsVersion: 1, oi: 100, buy: 10, sell: 10 }
  })
  let service = new MarketService(store, undefined, async () => { throw new Error('A complete canonical series must stay local.') }, false)
  const verify = async () => {
    const list = await service.readListBars({ instrument }, '5m')
    const chart = await service.prepareChartWindow(instrument.instId, '5m', rows.at(-1)!.timestamp)
    const byHour = new Map(list.bars.map((bar: { hour: number }) => [bar.hour, bar]))
    assert.equal(chart.bars.filter(bar => bar.hour >= rows.at(-1)!.timestamp - 95 * step && bar.hour <= rows.at(-1)!.timestamp).length, 96)
    const shared = chart.bars.filter(bar => byHour.has(bar.hour))
    assert.equal(shared.length, list.bars.length, 'The chart navigation history must contain the full bounded list projection.')
    for (const bar of shared) for (const field of ['ema', 'rsi6', 'rsi12', 'rsi24', 'vwap', 'bollMiddle'] as const) {
      assert.equal(bar[field], (byHour.get(bar.hour) as any)[field], `${field} at ${bar.hour}`)
    }
    return list.bars.at(-1)
  }
  try {
    await store.appendCandles(rows)
    const latest = await verify()
    // Closed form of 201 identical updates after the SMA seed of 1000.
    const expected = 100 + 900 * (199 / 201) ** 201
    assert.ok(Math.abs(latest.ema - expected) < 1e-9)
    assert.notEqual(latest.ema, 100, 'Truncating to 201 candles would silently reseed at 100.')
    await service.persistCandles(instrument.instId, [{ ...rows[500], close: 900, open: 900, high: 900, low: 900 }])
    await verify()
    service.preparedCharts.maxSeries = 1
    await store.appendCandles([{ ...rows[0], instrument: 'ETH-USDT-SWAP' }])
    await service.readListBars({ instrument: { instId: 'ETH-USDT-SWAP' } }, '5m')
    await verify()
    await service.dispose()
    await store.close()
    store = await MarketStore.open(root)
    service = new MarketService(store, undefined, async () => { throw new Error('A restart must reuse durable source history.') }, false)
    await verify()
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
