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
const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 2_000
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'A source change must publish without a snapshot poll.')
    await tick()
  }
}
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-observation-events-'))
  const store = await MarketStore.open(root), preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  let requests = 0
  const service = new MarketService(store, () => preferences, async () => { requests++; throw new Error('Unexpected source request.') }, false)
  // These tests observe qualification events, not independent chart-history preparation.
  service.preparedCharts.setRealtimeSubscriptions = () => undefined
  await service.ready
  service.projectListEntry = async () => null
  service.updateRanking = async () => undefined
  service.history.target = async () => []
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

test('snapshot and list reads for an uncached timeframe are observational and never admit maintenance', async () => {
  const f = await fixture(), service = f.service
  try {
    f.admit()
    const asOf = Math.floor(Date.now() / step) * step
    service.rankings.set(instrument.instId, { lookback: f.preferences.rankingLookback, rankingChange: 2, rankingAsOf: asOf })
    service.rankingWindows.set(instrument.instId, { marker: 'unchanged' })
    const revision = service.revision, frames = [...service.listRows.keys()], ranking = structuredClone([...service.rankings]), windows = structuredClone([...service.rankingWindows])
    for (const method of ['refresh', 'ensureListRows', 'projectListEntry', 'updateRanking', 'cachedRanking', 'pruneCatalog']) {
      service[method] = () => { throw new Error(`An observational read called ${method}.`) }
    }
    service.lastRefreshAt = 0
    const first = await service.snapshot('5m')
    assert.equal(first.rows.length, 1)
    assert.equal(first.rows[0].rankingChange, 2)
    assert.equal(first.rows[0].rankingAsOf, asOf)
    assert.deepEqual(service.listRowsFor('5m'), first.rows)
    const next = await service.snapshot('5m', { sinceRevision: first.revision, serviceSession: first.serviceSession })
    assert.equal('unchanged' in next, true)
    assert.equal(service.revision, revision)
    assert.deepEqual([...service.listRows.keys()], frames)
    assert.deepEqual([...service.rankings], ranking)
    assert.deepEqual([...service.rankingWindows], windows)
    assert.equal(f.requests(), 0)
  } finally { await f.close() }
})

test('progress-only retry, recovery and pause changes publish while list values stay equal', async () => {
  const f = await fixture(), service = f.service
  let events = 0, progress = { retrying: 0, unavailable: 0 }
  try {
    f.admit()
    await new Promise(resolve => setTimeout(resolve, 25))
    service.history.sync.progressFor = () => progress
    const rows = service.listRowsFor('15m'), unsubscribe = service.subscribeMarket(() => { events++ })
    for (const status of ['retry', 'running', 'paused', 'completed']) {
      progress = { retrying: Number(status === 'retry'), unavailable: Number(status === 'paused') }
      const before = events
      service.onHistoryProgress({ instrument: instrument.instId, timeframe: '15m', status })
      await waitFor(() => events > before)
      const snapshot = await service.snapshot('15m')
      assert.deepEqual(snapshot.rows, rows)
      assert.equal(snapshot.listProgress.retrying, progress.retrying)
      assert.equal(snapshot.listProgress.unavailable, progress.unavailable)
    }
    unsubscribe()
    const before = events
    service.onHistoryProgress({ instrument: instrument.instId, timeframe: '15m', status: 'retry' })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(events, before)
    assert.equal(f.requests(), 0)
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
