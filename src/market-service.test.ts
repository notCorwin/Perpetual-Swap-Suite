import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'

const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const hourly = Array.from({ length: 24 }, (_, index) => [String(1_700_000_000_000 + index * 3_600_000), '99', '101', '98', '100', '1', '1000', '100000', '1'])

test('market discovery admits only a fully liquid USDT perpetual', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-radar-market-service-'))
  const store = await MarketStore.open(root)
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([{ instId: 'BTC-USDT-SWAP', instCategory: '1', settleCcy: 'USDT', state: 'live', ctVal: '0.01', ctValCcy: 'BTC' }, { instId: 'ETH-USD-SWAP', instCategory: '1', settleCcy: 'USD', state: 'live', ctVal: '1', ctValCcy: 'USD' }])
    if (url.pathname.endsWith('/market/tickers')) return response([{ instId: 'BTC-USDT-SWAP', last: '100', bidPx: '99.99', askPx: '100', open24h: '90', high24h: '110', low24h: '80', volCcy24h: '400000' }])
    if (url.pathname.endsWith('/market/books')) return response([{ asks: [['100', '100100']], bids: [['99.99', '100100']] }])
    if (url.pathname.endsWith('/public/open-interest')) return response([{ oiUsd: '6000000' }])
    if (url.pathname.endsWith('/market/candles')) return response(hourly)
    throw new Error(`Unexpected ${url}`)
  }
  try {
    const service = new MarketService(store, () => ({ hourlyVolumeStabilityEnabled: true }), fetcher)
    await service.refresh()
    const snapshot = service.snapshot()
    assert.equal(snapshot.error, '')
    assert.equal(snapshot.rows.length, 1)
    assert.equal(snapshot.rows[0].instId, 'BTC-USDT-SWAP')
    assert.equal(snapshot.rows[0].turnover24hUSDT, 40_000_000)
    assert.equal(snapshot.rows[0].filterMetrics.oiUSD, 6_000_000)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
