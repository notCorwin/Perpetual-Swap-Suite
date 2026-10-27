import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const step = 300_000
const instrument = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', instCategory: '1', settleCcy: 'USDT',
  state: 'live', ruleType: 'normal', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-observation-events-'))
  const store = await MarketStore.open(root), preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  let requests = 0
  const service = new MarketService(store, () => preferences, async () => { requests++; throw new Error('Unexpected source request.') }, false)
  // These tests observe qualification events, not independent chart-history preparation.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  await service.ready
  service.preparedCharts.setUniverse = () => ({ frames: [] })
  service.updateRanking = async () => undefined
  const admit = (expiresAt = Date.now() + 90_000) => {
    service.instruments.set(instrument.instId, instrument)
    service.candidateIDs = new Set([instrument.instId])
    service.instrumentObservations.set(instrument.instId, { observedAt: Date.now(), expiresAt })
    service.verifyCatalog()
    assert.equal(service.catalog.size, 1)
  }
  return { service, preferences, admit, requests: () => requests,
    close: async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('canonical snapshot and prepared frame reads never admit source or calculation work', async () => {
  const f = await fixture(), service = f.service
  try {
    f.admit()
    const asOf = Math.floor(Date.now() / step) * step
    service.rankings.set(instrument.instId, { lookback: f.preferences.rankingLookback, rankingChange: 2, rankingAsOf: asOf })
    service.rankingWindows.set(instrument.instId, { marker: 'unchanged' })
    const revision = service.revision, ranking = structuredClone([...service.rankings]), windows = structuredClone([...service.rankingWindows])
    for (const method of ['refresh', 'updateSubscriptions', 'updateRanking', 'cachedRanking', 'pruneCatalog']) {
      service[method] = () => { throw new Error(`An observational read called ${method}.`) }
    }
    service.preparedCharts.setUniverse = () => { throw new Error('A read changed the preparation universe.') }
    service.preparedCharts.residentFrames = () => ({ frames: [] })
    service.history.ensurePrices = service.history.ensureStatistics = () => { throw new Error('A read admitted historical work.') }
    service.store.candles = () => { throw new Error('A read scanned SQLite history.') }
    service.lastRefreshAt = 0
    const first = await service.snapshot()
    assert.equal(first.rows.length, 1)
    assert.equal(first.rows[0].rankingChange, 2)
    assert.equal(first.rows[0].rankingAsOf, asOf)
    assert.deepEqual(service.listRowsFor(), first.rows)
    const next = await service.snapshot({ sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('unchanged' in next, true)
    assert.equal(service.revision, revision)
    assert.deepEqual([...service.rankings], ranking)
    assert.deepEqual([...service.rankingWindows], windows)
    assert.deepEqual(await service.getPreparedCharts(), { frames: [] })
    assert.equal(f.requests(), 0)
  } finally { await f.close() }
})

test('chart history retry and recovery do not publish or alter the canonical list', async () => {
  const f = await fixture(), service = f.service
  let events = 0
  try {
    f.admit()
    await new Promise(resolve => setTimeout(resolve, 25))
    service.history.sync.progressFor = () => { throw new Error('Canonical list reads cannot inspect timeframe progress.') }
    const before = await service.snapshot(), unsubscribe = service.subscribeMarket(() => { events++ })
    for (const status of ['retry', 'running', 'paused', 'completed']) {
      service.onHistoryProgress({ instrument: instrument.instId, timeframe: '15m', status })
      assert.deepEqual(await service.snapshot(), before)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(events, 0)
    assert.equal(f.requests(), 0)
    unsubscribe()
  } finally { await f.close() }
})

test('a finite metadata lease invalidates eligibility at its deadline without reads, HTTP or repeated expired wakes', async context => {
  const f = await fixture(), service = f.service, now = Math.floor(Date.now() / step) * step + 10_000
  let events = 0
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.admit(now + 1_500)
    service.subscribeMarket(() => { events++ })
    context.mock.timers.tick(16); await tick()
    events = 0
    context.mock.timers.tick(1_483); await tick()
    assert.equal(service.catalog.size, 1)
    assert.equal(events, 0)
    context.mock.timers.tick(1); await tick()
    assert.equal(service.catalog.size, 0, 'Eligibility must expire even when no renderer asks for another snapshot.')
    assert.equal(service.catalogChecks.get(instrument.instId)?.status, 'unknown')
    context.mock.timers.tick(16); await tick()
    assert.equal(events, 1)
    const revision = service.revision
    context.mock.timers.tick(500); await tick()
    assert.equal(events, 1)
    assert.equal(service.revision, revision, 'Already expired observations must not create a timer loop.')
    assert.equal(f.requests(), 0)
  } finally { context.mock.timers.reset(); await f.close() }
})

test('an expired failing observation becomes unknown before its held liquidity worker completes', async context => {
  const f = await fixture(), service = f.service, now = Math.floor(Date.now() / step) * step + 10_000
  let release!: (value: unknown) => void, evaluations = 0
  const result = new Promise(resolve => { release = resolve })
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    f.preferences.liquidity.spread.enabled = true
    f.preferences.liquidity.depth.enabled = true
    service.instruments.set(instrument.instId, instrument)
    service.candidateIDs = new Set([instrument.instId])
    service.instrumentObservations.set(instrument.instId, { observedAt: now, expiresAt: now + 90_000 })
    service.observations.set(instrument.instId, {
      ticker: { value: { instId: instrument.instId, last: '100', bidPx: '99', askPx: '100' }, observedAt: now, expiresAt: now + 1_500 },
      book: { value: { bids: [['99', '200001']], asks: [['100', '200001']] }, observedAt: now, expiresAt: now + 90_000 },
    })
    service.verifyCatalog()
    assert.equal(service.catalogChecks.get(instrument.instId).status, 'failed')
    service.streamLiquidity = { evaluate: () => { evaluations++; return result }, close: async () => {} }
    context.mock.timers.tick(1_500)
    assert.equal(evaluations, 1, 'The current book can be reevaluated independently of its expired spread observation.')
    assert.equal(service.catalogChecks.get(instrument.instId).status, 'unknown', 'A previously failing fact is unavailable as soon as its evidence expires.')
    assert.equal(service.catalog.size, 0)
    assert.equal(f.requests(), 0)
  } finally {
    release(service.evaluateLiquidity({ instrument, ticker: null, book: null, config: f.preferences.liquidity }))
    context.mock.timers.reset(); await f.close()
  }
})
