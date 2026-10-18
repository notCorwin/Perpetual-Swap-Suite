import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const fiveMinutes = 300_000
const hour = 3_600_000
const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const ticker = { instId, last: '100', bidPx: '99.99', askPx: '100' }
const candle = (timestamp: number, quoteVolume = 200_000) => ({ instrument: instId, timeframe: '5m', timestamp, open: 99, high: 101, low: 98, close: 100, volume: 2_000, baseVolume: 20, quoteVolume, confirmed: true })
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 2_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for catalog requalification.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const fixture = async (now: number) => {
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  for (const key of ['volume24h', 'spread', 'depth', 'openInterest'] as const) preferences.liquidity[key].enabled = true
  const root = await mkdtemp(join(tmpdir(), 'perp-catalog-renewal-'))
  const store = await MarketStore.open(root)
  let fetches = 0, offline = false, refreshes = 0
  const service = new MarketService(store, () => preferences, async input => {
    fetches += 1
    if (offline) throw new Error('A durable candle update must not request network data.')
    const path = new URL(String(input)).pathname
    if (path.endsWith('/public/instruments')) return response([instrument])
    if (path.endsWith('/market/tickers')) return response([ticker])
    if (path.endsWith('/market/books')) return response([{ asks: [['100', '200001']], bids: [['99.99', '200001']] }])
    if (path.endsWith('/public/open-interest')) return response([{ instId, oiUsd: '6000000' }])
    throw new Error(`Unexpected endpoint: ${path}`)
  }, false)
  await service.ready
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.scheduleListProjection = () => undefined
  service.history.target = async () => []
  service.history.ensurePrices = async () => { throw new Error('Complete durable qualification data must not need acquisition.') }
  service.scheduleRefresh = () => undefined
  service.scheduleRenewal = () => undefined
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
  await store.appendCandles(Array.from({ length: 288 }, (_, index) => candle(asOf - (288 - index) * fiveMinutes)))
  await service.refresh()
  assert.equal(service.catalog.get(instId)?.status, 'verified')
  const fetchesBefore = fetches
  const sourcesBefore = () => Object.fromEntries(['ticker', 'book', 'openInterest'].map(key => [key, structuredClone(service.observations.get(instId)[key])]))
  const enableLocalUpdates = () => {
    offline = true
    service.refresh = async () => { refreshes += 1; throw new Error('A durable candle update must not start discovery.') }
    service.autoRefresh = true
  }
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, preferences, asOf, sourcesBefore, enableLocalUpdates, close,
    assertLocalOnly: () => { assert.equal(fetches, fetchesBefore); assert.equal(refreshes, 0) } }
}

test('temporarily expired qualification retains the confirmed-candle feeds needed for recovery', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    const subscriptions = () => [...f.service.realtime.subscriptions.values()].map(value => `${value.instId}:${value.timeframe}`).sort()
    const before = subscriptions()
    assert.deepEqual(before, ['15m', '1H', '5m'].map(timeframe => `${instId}:${timeframe}`))
    now = f.asOf + fiveMinutes
    const expired = await f.service.snapshot()
    assert.deepEqual(expired.rows, [], 'Expired qualification cannot remain in the eligible list.')
    assert.equal(expired.catalogProgress.unknown, 1)
    assert.deepEqual(subscriptions(), before, 'A previously qualified contract must keep receiving final candles while its observations renew.')
    f.assertLocalOnly()
  } finally { await f.close() }
})

test('the next durable final candle immediately restores the exact rolling turnover without live requests or extended leases', async context => {
  let now = Math.floor(Date.now() / hour) * hour + 4 * 60_000 + 45_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    const sources = f.sourcesBefore()
    const metadataLease = structuredClone(f.service.instrumentObservations.get(instId))
    f.enableLocalUpdates()
    now = f.asOf + fiveMinutes + 1
    assert.deepEqual((await f.service.snapshot()).rows, [])
    await f.service.persistCandles(instId, [candle(f.asOf, 400_000)])
    await waitFor(() => f.service.catalog.get(instId)?.result.turnover === 57_800_000)
    assert.deepEqual(f.service.listRowsFor('15m').map(row => row.instId), [instId])
    const turnover = f.service.metadata.getCatalogEntry(instId).observations.turnover
    assert.equal(turnover.value.asOf, f.asOf + fiveMinutes)
    assert.equal(turnover.value.turnover, 57_800_000, 'Drop the oldest 200,000 and add the newly completed 400,000 quote volume.')
    assert.deepEqual(f.sourcesBefore(), sources, 'Local historical recomputation cannot renew ticker, book, or open-interest leases.')
    assert.deepEqual(f.service.instrumentObservations.get(instId), metadataLease)
    f.assertLocalOnly()
  } finally { await f.close() }
})

test('a durable historical volume correction immediately applies the resulting qualification failure', async context => {
  const now = Math.floor(Date.now() / hour) * hour + 2 * 60_000
  context.mock.method(Date, 'now', () => now)
  const f = await fixture(now)
  try {
    f.preferences.liquidity.volume24h.minUSDT = 57_500_000
    f.service.verifyCatalog()
    assert.equal(f.service.catalog.get(instId)?.result.turnover, 57_600_000)
    const sources = f.sourcesBefore()
    f.enableLocalUpdates()
    await f.service.persistCandles(instId, [candle(f.asOf - fiveMinutes, 0)])
    await waitFor(() => f.service.catalogChecks.get(instId)?.status === 'failed')
    assert.deepEqual(f.service.listRowsFor('15m'), [])
    assert.equal(f.service.metadata.getCatalogEntry(instId).result.turnover, 57_400_000)
    assert.equal(f.service.renewalTargets.has(instId), false, 'A verified condition failure must stop priority renewal.')
    assert.deepEqual(f.sourcesBefore(), sources)
    f.assertLocalOnly()
  } finally { await f.close() }
})
