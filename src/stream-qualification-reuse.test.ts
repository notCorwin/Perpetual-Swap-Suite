import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/preferences.js'
import { evaluateLiquidity, type LiquidityInput } from '../electron/services/liquidity.js'
import { attachOperationSink, type OperationEvent } from '../electron/services/operations.js'

const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const ticker = (price = 100, spread = .01) => ({ instId, last: String(price), bidPx: String(price), askPx: String(price + spread), ts: String(Date.now()) })
const book = () => ({ bids: [['99.99', '2000']], asks: [['100', '2000']], ts: String(Date.now()) })
const waitFor = async (condition: () => boolean) => { const deadline = performance.now() + 4000; while (!condition()) { assert.ok(performance.now() < deadline, 'Stream assessment did not settle.'); await delay(5) } }
const fixture = async (t: TestContext, enabled: Array<keyof typeof DEFAULT_PREFERENCES.liquidity> = []) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-qualification-reuse-')), store = await MarketStore.open(root)
  const config = structuredClone(DEFAULT_PREFERENCES)
  for (const [key, rule] of Object.entries(config.liquidity)) rule.enabled = enabled.includes(key as keyof typeof config.liquidity)
  let requests = 0
  const service = new MarketService(store, () => config, async () => { requests++; return new Response(JSON.stringify({ code: '0', data: [] })) }, false)
  await service.ready
  const rows = [['5m', 300000], ['15m', 900000]] as const
  await store.appendCandles(rows.flatMap(([timeframe, step]) => Array.from({ length: 300 }, (_, index) => ({ instrument: instId, timeframe,
    timestamp: Math.floor(Date.now() / step) * step - (300 - index) * step, open: 100, high: 101, low: 99, close: 100, volume: 10, baseVolume: 1, quoteVolume: 1000, confirmed: true }))))
  service.installInstruments(new Map([[instId, instrument]]))
  service.verifyCatalog()
  await waitFor(() => service.backgroundTasks.size === 0 && service.preparedCharts.liveSeeds.size === 0)
  t.after(async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return { service, config, requests: () => requests }
}

test('disabled liquidity sources reuse the assessment while latest trade prices and observations continue advancing', async t => {
  const { service, requests } = await fixture(t), original = service.catalogChecks.get(instId), operations: OperationEvent[] = []
  const unsubscribe = attachOperationSink(operation => operations.push(operation))
  try {
    for (let index = 0; index < 10; index++) {
      service.receivePublicObservation(instId, 'ticker', ticker(100 + index))
      service.receivePublicObservation(instId, 'book', book())
      service.receivePublicObservation(instId, 'openInterest', { instId, oi: String(100 + index), oiUsd: '10000000', ts: String(Date.now()) })
    }
    await delay(150)
    assert.equal(service.catalogChecks.get(instId), original)
    assert.equal(service.listRowsFor('15m')[0]?.lastPrice, 109)
    assert.equal(service.observations.get(instId).ticker.value.last, '109')
    assert.equal(service.observations.get(instId).openInterest.value.oi, '109')
    assert.equal(service.streamQualifications.size, 0)
    assert.equal(service.streamQualificationTimer, null)
    assert.equal(operations.filter(operation => operation.name === 'liquidity.evaluate').length, 0)
    assert.equal(requests(), 0)
  } finally { unsubscribe() }
})

test('enabled source changes and preference changes invalidate assessment reuse', async t => {
  const { service, config } = await fixture(t, ['spread'])
  service.receivePublicObservation(instId, 'ticker', ticker())
  await waitFor(() => service.catalog.has(instId))
  const original = service.catalogChecks.get(instId), operations: OperationEvent[] = []
  const unsubscribe = attachOperationSink(operation => operations.push(operation))
  try {
    service.receivePublicObservation(instId, 'book', book())
    service.receivePublicObservation(instId, 'openInterest', { instId, oiUsd: '10000000', ts: String(Date.now()) })
    await delay(150)
    assert.equal(service.catalogChecks.get(instId), original)
    assert.equal(operations.filter(operation => operation.name === 'liquidity.evaluate').length, 0)
    service.receivePublicObservation(instId, 'ticker', ticker(100, 1))
    await waitFor(() => !service.catalog.has(instId))
    assert.ok(operations.some(operation => operation.name === 'liquidity.evaluate'))
    config.liquidity.spread.enabled = false
    service.receivePublicObservation(instId, 'book', book())
    await waitFor(() => service.catalog.has(instId))
    assert.equal(service.catalogChecks.get(instId).result.status, 'verified')
  } finally { unsubscribe() }
})

test('an in-flight depth result is reused when only disabled source families change', async t => {
  const { service } = await fixture(t, ['depth'])
  let release!: () => void, evaluations = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  service.streamLiquidity = { evaluate: async (input: LiquidityInput) => { evaluations++; await gate; return evaluateLiquidity(input) }, close: async () => { release() } }
  try {
    service.receivePublicObservation(instId, 'book', book())
    await waitFor(() => evaluations === 1)
    const pending = service.streamEvaluations.get(instId)
    service.receivePublicObservation(instId, 'ticker', ticker(200))
    service.receivePublicObservation(instId, 'openInterest', { instId, oiUsd: '10000000', ts: String(Date.now()) })
    release(); await pending
    await delay(150)
    assert.equal(evaluations, 1, 'Unrelated observations must not enqueue another exact book calculation.')
    assert.equal(service.catalog.get(instId).ticker.last, '200')
    assert.equal(service.catalog.get(instId).result.status, 'verified')
  } finally { release() }
})

test('enabling a previously unused criterion waits for its genuine source before readmission', async t => {
  const { service, config } = await fixture(t), previous = structuredClone(config)
  assert.equal(service.catalog.has(instId), true)
  config.liquidity.openInterest.enabled = true
  await service.reconfigure(previous)
  assert.equal(service.catalog.has(instId), false, 'The old disabled-filter decision cannot admit an enabled criterion.')
  service.receivePublicObservation(instId, 'ticker', ticker(200))
  service.receivePublicObservation(instId, 'book', book())
  await delay(150)
  assert.equal(service.catalog.has(instId), false)
  service.receivePublicObservation(instId, 'openInterest', { instId, oiUsd: '10000000', ts: String(Date.now()) })
  await waitFor(() => service.catalog.has(instId))
  assert.equal(service.catalogChecks.get(instId).result.oiUSD, 10000000)
})

test('an expired instrument lease revokes a reused disabled-filter assessment', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 60000
  t.mock.method(Date, 'now', () => now)
  const { service } = await fixture(t)
  assert.equal(service.catalog.has(instId), true)
  now += 90001
  service.processMarketDeadline()
  assert.equal(service.catalog.has(instId), false)
  service.receivePublicObservation(instId, 'ticker', ticker(200))
  await delay(150)
  assert.equal(service.catalog.has(instId), false, 'A fresh unrelated quote cannot renew expired contract metadata.')
  assert.equal(service.catalogChecks.get(instId).status, 'unknown')
})

test('disabled-source updates cannot extend the lease of an enabled criterion', async t => {
  let now = Math.floor(Date.now() / 300000) * 300000 + 60000
  t.mock.method(Date, 'now', () => now)
  const { service } = await fixture(t, ['openInterest'])
  service.receivePublicObservation(instId, 'openInterest', { instId, oiUsd: '10000000', ts: String(now) })
  await waitFor(() => service.catalog.has(instId))
  const originalExpiry = service.catalog.get(instId).expiresAt
  service.receivePublicObservation(instId, 'ticker', ticker(200))
  await delay(150)
  assert.equal(service.catalog.get(instId).expiresAt, originalExpiry)
  now += 90001
  // Contract metadata remains proven; only the required OI source expires.
  service.instrumentObservations.set(instId, { observedAt: now, expiresAt: now + 90000 })
  service.processMarketDeadline()
  assert.equal(service.catalog.has(instId), false)
  service.receivePublicObservation(instId, 'ticker', ticker(201))
  await delay(150)
  assert.equal(service.catalog.has(instId), false)
  service.receivePublicObservation(instId, 'openInterest', { instId, oiUsd: '11000000', ts: String(now) })
  await waitFor(() => service.catalog.has(instId))
  assert.equal(service.catalog.get(instId).result.oiUSD, 11000000)
})
