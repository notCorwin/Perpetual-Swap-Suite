import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES, type Preferences } from '../electron/services/metadata-store.js'

const retention = 30_000
const fiveMinutes = 300_000
const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP', sol = 'SOL-USDT-SWAP'
const instrument = (instId: string, state = 'live') => ({ instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT',
  ctType: 'linear', state, ctVal: '0.01', ctMult: '1', ctValCcy: instId.split('-')[0], ruleType: 'normal' })
const ticker = (instId: string, last = '100') => ({ instId, last, bidPx: '99.99', askPx: '100', open24h: '90', high24h: '110', low24h: '80', volCcy24h: '40000000' })
const tick = () => setImmediate()

const fixture = async (enabled?: 'depth' | 'spread') => {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-list-buffer-'))
  const store = await MarketStore.open(root), preferences: Preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  if (enabled) preferences.liquidity[enabled].enabled = true
  let requests = 0
  const service = new MarketService(store, () => preferences, async () => { requests++; throw new Error('Unexpected source request.') }, false)
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  await service.ready
  const universes: string[][] = []
  service.preparedCharts.setUniverse = (ids: string[]) => { universes.push([...ids].sort()); return { frames: [] } }
  service.updateRanking = async () => undefined
  const admit = (ids: string[], expiresAt = Date.now() + 120_000) => {
    for (const id of ids) {
      const definition = instrument(id)
      service.instruments.set(id, definition)
      service.candidateIDs = new Set([...(service.candidateIDs ?? []), id])
      service.instrumentObservations.set(id, { observedAt: Date.now(), expiresAt })
      service.observations.set(id, {
        ticker: { value: ticker(id), observedAt: Date.now(), expiresAt },
        ...(enabled === 'depth' ? { book: { value: { asks: [['100', '200001']], bids: [['99.99', '200001']] }, observedAt: Date.now(), expiresAt } } : {}),
      })
    }
    service.verifyCatalog()
    assert.equal(service.catalog.size, ids.length)
  }
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, preferences, admit, universes, requests: () => requests, close }
}

test('confirmed ineligibility removes catalog membership immediately and retains the row and chart universe for 30 seconds', async context => {
  const f = await fixture(), service = f.service
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000
  let notifications = 0
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc, eth])
    const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
    service.rankings.set(btc, { lookback: f.preferences.rankingLookback, rankingChange: 3, rankingAsOf: asOf })
    service.rankings.set(eth, { lookback: f.preferences.rankingLookback, rankingChange: -1, rankingAsOf: asOf })
    service.subscribeMarket(() => { notifications++ })

    service.instruments.set(btc, instrument(btc, 'suspend'))
    service.verifyCatalog()
    assert.equal(service.catalog.has(btc), false, 'Eligibility is revoked as soon as qualification is confirmed.')
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [btc, eth])
    assert.equal(service.listRowsFor()[0].rankingChange, 3, 'Buffered rows keep using the current backend ranking and sort order.')
    assert.deepEqual(f.universes.at(-1), [btc, eth], 'Chart preparation retains buffered ids.')
    context.mock.timers.tick(16)
    await tick()
    notifications = 0

    context.mock.timers.tick(retention - 17)
    await tick()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [btc, eth])
    assert.equal(f.requests(), 0)
    context.mock.timers.tick(1)
    await tick()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [eth])
    assert.deepEqual(f.universes.at(-1), [eth], 'Expiry removes the id from the prepared chart universe.')
    context.mock.timers.tick(16)
    await tick()
    assert.ok(notifications > 0, 'Timer-driven expiry publishes a market change without a renderer read.')
    assert.equal(f.requests(), 0, 'Neither reads nor expiry start source acquisition.')
  } finally { context.mock.timers.reset(); await f.close() }
})

test('removal deadlines are independent, unchanged absence does not extend them, and requalification starts a fresh window', async context => {
  const f = await fixture(), service = f.service
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc, eth, sol])
    const asOf = Math.floor(now / fiveMinutes) * fiveMinutes
    for (const [id, rankingChange] of [[btc, 1], [eth, 2], [sol, 3]] as const)
      service.rankings.set(id, { lookback: f.preferences.rankingLookback, rankingChange, rankingAsOf: asOf })

    service.instruments.set(btc, instrument(btc, 'suspend'))
    service.verifyCatalog()
    const firstRows = service.listRowsFor()
    assert.deepEqual(firstRows.map(row => row.instId), [sol, eth, btc])
    context.mock.timers.tick(12_000)
    await tick()
    // Repeating the same failed assessment cannot move BTC's original deadline.
    service.verifyCatalog()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [sol, eth, btc])

    // ETH is removed later and therefore has its own later deadline.
    service.instruments.set(eth, instrument(eth, 'suspend'))
    service.verifyCatalog()
    context.mock.timers.tick(18_000)
    await tick()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [sol, eth], 'BTC expires at its first removal + 30 seconds.')

    // Requalify ETH, then remove it again; the canceled first deadline is not reused.
    service.instruments.set(eth, instrument(eth))
    service.observations.set(eth, { ticker: { value: ticker(eth, '101'), observedAt: Date.now(), expiresAt: now + 120_000 } })
    service.verifyCatalog()
    assert.equal(service.catalog.has(eth), true)
    assert.equal(service.listRowsFor().find(row => row.instId === eth)?.lastPrice, 101)
    service.instruments.set(eth, instrument(eth, 'suspend'))
    service.verifyCatalog()
    context.mock.timers.tick(12_000)
    await tick()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [sol, eth], 'Reappearance cancels retirement and the next absence receives a fresh 30 second window.')
    context.mock.timers.tick(18_000)
    await tick()
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [sol])
    assert.deepEqual(f.universes.at(-1), [sol])
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})

test('projection reads honor known expiry before a delayed maintenance callback without resetting the removal deadline', async context => {
  const f = await fixture(), service = f.service
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000, expiry = now + 1_000
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc], expiry)
    const first = await service.snapshot()
    context.mock.timers.setTime(expiry)
    const expired = await service.snapshot({ sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('unchanged' in expired, false)
    assert.equal(expired.catalogProgress.verified, 0)
    assert.equal(service.revision, first.revision, 'Reads cannot run the due maintenance callback.')
    assert.deepEqual('rows' in expired && expired.rows.map(row => row.instId), [btc])
    context.mock.timers.setTime(expiry + retention - 1)
    assert.deepEqual(service.listRowsFor().map(row => row.instId), [btc])
    context.mock.timers.setTime(expiry + retention)
    assert.deepEqual(service.listRowsFor(), [])
    service.processMarketDeadline()
    assert.deepEqual(service.listRowsFor(), [], 'A late callback cannot resurrect the row with a new exit window.')
    assert.deepEqual(f.universes.at(-1), [])
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})

test('buffered rows receive prices immediately and never carry a ranking across its completed-candle boundary', async context => {
  const f = await fixture(), service = f.service
  const boundary = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + fiveMinutes, now = boundary - 10_000
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc, eth])
    for (const [id, rankingChange] of [[btc, 2], [eth, 1]] as const)
      service.rankings.set(id, { lookback: f.preferences.rankingLookback, rankingChange, rankingAsOf: boundary - fiveMinutes })
    service.replaceCatalog([service.catalog.get(eth)])
    assert.equal(service.catalog.has(btc), false)
    const first = await service.snapshot()
    assert.equal(first.rows[0].lastPrice, 100)
    service.receivePublicObservation(btc, 'ticker', ticker(btc, '123'), { receivedAt: now })
    const updated = await service.snapshot({ sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('unchanged' in updated, false)
    assert.equal('rows' in updated && updated.rows.find(row => row.instId === btc)?.lastPrice, 123)
    context.mock.timers.setTime(boundary)
    const nextBoundary = await service.snapshot()
    assert.equal(nextBoundary.rows.length, 2)
    assert.ok(nextBoundary.rows.every(row => row.rankingChange === null && row.rankingAsOf === null))
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})

test('lookback changes recompute buffered rankings from shared candle inputs without new source work', async context => {
  const f = await fixture(), service = f.service
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000, asOf = now - 10_000
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc, eth])
    for (const id of [btc, eth]) service.cacheRankingCandles(id, Array.from({ length: 7 }, (_, index) => ({
      instrument: id, timeframe: '5m', timestamp: asOf - (7 - index) * fiveMinutes,
      open: 100, high: 110, low: 90, close: id === btc ? 100 + index : 100, confirmed: true,
    })))
    service.replaceCatalog([service.catalog.get(eth)])
    const previous = structuredClone(f.preferences)
    f.preferences.rankingLookback = 30
    service.updateRanking = MarketService.prototype.updateRanking.bind(service)
    await service.reconfigure(previous)
    const rows = service.listRowsFor()
    assert.deepEqual(rows.map(row => [row.instId, row.rankingChange, row.rankingAsOf]), [[btc, 6, asOf], [eth, 0, asOf]])
    assert.equal(service.catalog.has(btc), false)
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})

for (const source of ['depth', 'spread'] as const) test(`a late ${source} revocation cannot restart a completed exit buffer`, async context => {
  const f = await fixture(source), service = f.service
  const now = Math.floor(Date.now() / fiveMinutes) * fiveMinutes + 10_000, expiry = now + 1_000
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit([btc], expiry)
    assert.equal((await service.snapshot()).rows.length, 1)
    context.mock.timers.setTime(expiry + retention)
    assert.deepEqual(service.listRowsFor(), [])
    if (source === 'depth') service.bookUnsubscribed(btc)
    else service.capTickerAssessment(btc)
    assert.deepEqual(service.listRowsFor(), [], 'Revocation must preserve the known loss time, even before its maintenance callback.')
    service.processMarketDeadline()
    assert.deepEqual(service.listRowsFor(), [])
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})
