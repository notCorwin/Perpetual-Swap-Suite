import { test, type TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const instrument = (index: number) => ({ instId: `TOKEN${index}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: `TOKEN${index}`, ruleType: 'normal' })

async function fixture(t: TestContext, count: number) {
  let now = Math.floor(Date.now() / 300_000) * 300_000 + 20_000
  t.mock.method(Date, 'now', () => now)
  const root = await mkdtemp(join(tmpdir(), 'perp-subscription-incremental-')), store = await MarketStore.open(root)
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const [key, value] of Object.entries(preferences.liquidity)) value.enabled = key === 'spread' || key === 'depth'
  const service = new MarketService(store, () => preferences, fetch, false)
  await service.ready
  service.preparedCharts.setUniverse = () => undefined
  service.updateRanking = async () => undefined
  t.after(async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const instruments = Array.from({ length: count }, (_, index) => instrument(index))
  service.installInstruments(new Map(instruments.map(value => [value.instId, value])))
  const configKey = service.catalogCriteriaKey()
  for (const value of instruments) {
    const ticker = { value: { instId: value.instId, last: '100', bidPx: '99.99', askPx: '100', ts: String(now) }, source: 'rest', observedAt: now, expiresAt: now + 90_000 }
    const old = service.catalogChecks.get(value.instId)
    service.catalogChecks.set(value.instId, { ...old, instrument: value, instrumentID: value.instId, configKey, status: 'unknown',
      observations: { ticker }, result: { ...old?.result, checks: [{ key: 'spread', status: 'verified' }] } })
  }
  service.updateSubscriptions()
  await setImmediate()
  return { service, instruments, get now() { return now }, set now(value: number) { now = value } }
}

test('a local qualification renewal checks only changed subscriptions without changing demand', async t => {
  const state = await fixture(t, 96), { service, instruments } = state
  const before = [...service.publicSubscriptionDemand.books]
  assert.equal(before.length, instruments.length)
  let checks = 0
  const original = service.qualificationObservation.bind(service)
  service.qualificationObservation = (...args: unknown[]) => { checks++; return original(...args) }
  const changed = service.catalogChecks.get(instruments[0].instId)
  state.now++
  service.publishStreamRecords([{ ...changed }])
  await setImmediate()
  assert.deepEqual([...service.publicSubscriptionDemand.books], before)
  assert.ok(checks < 8, `Expected a local renewal to avoid a whole-universe subscription check; got ${checks}.`)
})

test('a different contract update observes a retired native session and preserves book grace', async t => {
  const state = await fixture(t, 2), { service, instruments } = state
  const id = instruments[0].instId, other = instruments[1].instId
  const signal = new AbortController(), subscription = { channel: 'tickers', instId: id }
  const record = service.catalogChecks.get(id), ticker = { ...record.observations.ticker, source: 'websocket', expiresAt: state.now - 1 }
  const session = { signal: signal.signal, receivedAt: state.now, subscription, observation: ticker, faulted: false }
  service.publicRealtime.subscriptions.set(`tickers:${id}`, subscription)
  service.tickerSubscriptions.set(id, session)
  service.tickerNativeObservations.set(ticker, { instId: id, session })
  service.catalogChecks.set(id, { ...record, observations: { ticker } })
  service.updateSubscriptions()
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
  signal.abort()
  service.tickerDisconnected([id], { signal: signal.signal })
  service.publishStreamRecords([{ ...service.catalogChecks.get(other) }])
  await setImmediate()
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
  assert.equal(service.bookRetirements.get(id), state.now + 30_000)
  const fresh = { ...ticker, source: 'rest', observedAt: state.now, expiresAt: state.now + 90_000 }
  service.publishStreamRecords([{ ...service.catalogChecks.get(id), observations: { ticker: fresh } }])
  await setImmediate()
  assert.equal(service.bookRetirements.has(id), false, 'Renewed proof cancels retirement before the deadline.')
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
})

test('simultaneous expiration of another contract begins grace before a local update', async t => {
  const state = await fixture(t, 2), { service, instruments } = state
  const id = instruments[0].instId, other = instruments[1].instId
  state.now += 90_000
  const record = service.catalogChecks.get(other)
  const ticker = { ...record.observations.ticker, observedAt: state.now, expiresAt: state.now + 90_000 }
  service.publishStreamRecords([{ ...record, observations: { ticker } }])
  await setImmediate()
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
  assert.equal(service.bookRetirements.get(id), state.now + 30_000)
  state.now += 30_000
  service.processMarketDeadline()
  await setImmediate()
  assert.equal(service.publicSubscriptionDemand.books.has(id), false)
})

test('clock rollback rechecks another contract and cancels no longer necessary grace', async t => {
  const state = await fixture(t, 2), { service, instruments } = state
  const id = instruments[0].instId, other = instruments[1].instId
  state.now += 100_000
  const record = service.catalogChecks.get(other)
  const ticker = { ...record.observations.ticker, observedAt: state.now, expiresAt: state.now + 90_000 }
  service.publishStreamRecords([{ ...record, observations: { ticker } }])
  await setImmediate()
  assert.equal(service.bookRetirements.get(id), state.now + 30_000)
  state.now -= 100_000
  service.publishStreamRecords([{ ...service.catalogChecks.get(other) }])
  await setImmediate()
  assert.equal(service.bookRetirements.has(id), false)
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
})

test('a qualification expiring during the full subscription pass is rechecked on the next local update', async t => {
  const state = await fixture(t, 2), { service, instruments } = state
  const id = instruments[0].instId, other = instruments[1].instId
  const old = service.catalogChecks.get(id)
  const expiring = { ...old.observations.ticker, expiresAt: state.now + 1 }
  service.catalogChecks.set(id, { ...old, observations: { ticker: expiring } })
  const schedule = service.scheduleMarketDeadline.bind(service)
  let advanceDuringFullPass = true
  service.scheduleMarketDeadline = () => {
    if (advanceDuringFullPass) { advanceDuringFullPass = false; state.now += 2 }
    return schedule()
  }
  service.updateSubscriptions()
  assert.equal(service.bookRetirements.has(id), false, 'The full pass began while the proof was still fresh.')
  assert.ok(service.marketDeadlineAt > state.now, 'The later deadline rebuild omitted the already expired proof.')
  service.publishStreamRecords([{ ...service.catalogChecks.get(other) }])
  await setImmediate()
  assert.equal(service.bookRetirements.get(id), state.now + 30_000, 'The next reconciliation must observe the expired proof.')
})

test('a local renewal cannot extend another contract’s subscription proof', async t => {
  const state = await fixture(t, 2), { service, instruments } = state
  const id = instruments[0].instId, other = instruments[1].instId
  const old = service.catalogChecks.get(id), deadline = state.now + 20
  service.catalogChecks.set(id, { ...old, observations: { ticker: { ...old.observations.ticker, expiresAt: deadline } } })
  service.updateSubscriptions()
  assert.equal(service.subscriptionDeadlines.get(id), deadline)
  state.now += 10
  service.publishStreamRecords([{ ...service.catalogChecks.get(other) }])
  await setImmediate()
  assert.equal(service.subscriptionDeadlines.get(id), deadline)
  state.now += 11
  service.publishStreamRecords([{ ...service.catalogChecks.get(other) }])
  await setImmediate()
  assert.equal(service.bookRetirements.get(id), state.now + 30_000)
})

test('an unqualified book retires after grace and configuration changes cancel its sampling', async t => {
  const state = await fixture(t, 1), { service, instruments } = state, id = instruments[0].instId
  service.autoRefresh = true
  const record = service.catalogChecks.get(id)
  record.result.checks.push({ key: 'depth', status: 'unknown', value: 10_000 })
  service.updateSubscriptions()
  assert.equal(service.bookSamples.has(id), true)
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
  state.now += 30_000
  service.updateSubscriptions()
  assert.equal(service.publicSubscriptionDemand.books.has(id), false)
  service.preferences().liquidity.depth.enabled = false
  service.updateSubscriptions()
  assert.equal(service.bookSamples.has(id), false)
  service.autoRefresh = false
})


test('a book that recovers during retirement grace remains continuously subscribed', async t => {
  const state = await fixture(t, 1), { service, instruments } = state, id = instruments[0].instId
  service.autoRefresh = true
  const record = service.catalogChecks.get(id)
  record.result.checks.push({ key: 'depth', status: 'unknown', value: 10_000 })
  service.updateSubscriptions()
  assert.equal(service.bookSamples.has(id), true)
  assert.equal(service.bookRetirements.has(id), true)
  record.result.checks = record.result.checks.map((check: { key: string }) => check.key === 'depth' ? { ...check, status: 'verified', value: 200_000 } : check)
  service.updateSubscriptions()
  assert.equal(service.bookSamples.has(id), false)
  assert.equal(service.bookRetirements.has(id), false)
  state.now += 30_000
  service.updateSubscriptions()
  assert.equal(service.publicSubscriptionDemand.books.has(id), true)
  service.autoRefresh = false
})
