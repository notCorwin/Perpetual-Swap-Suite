import assert from 'node:assert/strict'
import test from 'node:test'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES, validatePreferences } from '../electron/services/preferences.js'
import type { Preferences } from '../electron/services/preferences.js'

// These projections need neither a database nor market/worker initialization.
const projection = (preferences: () => unknown) => Object.assign(Object.create(MarketService.prototype), { preferences })

test('liquidity keys reuse immutable settings and change immediately with settings replacement or invalid input', t => {
  let preferences = validatePreferences(structuredClone(DEFAULT_PREFERENCES))
  const service = projection(() => preferences), original = JSON.stringify
  let encoded = 0
  t.mock.method(JSON, 'stringify', (value: unknown, ...args: unknown[]) => {
    if (value === preferences.liquidity) encoded++
    return Reflect.apply(original, JSON, [value, ...args])
  })
  const first = service.catalogCriteriaKey()
  for (let index = 0; index < 20; index++) assert.equal(service.catalogCriteriaKey(), first)
  assert.equal(encoded, 1, 'Repeated qualification must reuse the validated configuration encoding.')
  const replacement: Preferences = structuredClone(preferences)
  replacement.liquidity.spread.maxPercent /= 2
  preferences = validatePreferences(replacement)
  const second = service.catalogCriteriaKey()
  assert.notEqual(second, first)
  assert.equal(second, original(preferences.liquidity))
  assert.equal(service.catalogCriteriaKey(), second)
  assert.equal(encoded, 2, 'A settings replacement owns a distinct encoding.')
  service.preferences = () => ({ ...preferences, rankingLookback: 1 })
  assert.throws(() => service.catalogCriteriaKey(), /rankingLookback/)
})

test('mutable and foreign frozen configurations never retain stale liquidity keys', () => {
  const preferences = structuredClone(DEFAULT_PREFERENCES), service = projection(() => preferences)
  const first = service.catalogCriteriaKey()
  preferences.liquidity.depth.minUSDT *= 2
  assert.notEqual(service.catalogCriteriaKey(), first, 'A mutable provider must be validated again after mutation.')

  const keys: string[] = []
  service.qualificationObservation = (_observations: unknown, _source: string, _id: string, key: string) => { keys.push(key) }
  const config = structuredClone(preferences.liquidity)
  service.liquidityInput({ instId: 'BTC-USDT-SWAP' }, config, {})
  const previous = keys.at(-1)
  config.depth.minUSDT *= 2
  service.liquidityInput({ instId: 'BTC-USDT-SWAP' }, config, {})
  assert.notEqual(keys.at(-1), previous, 'Unadmitted inputs cannot inherit an identity cache.')
  assert.equal(keys.at(-1), JSON.stringify(config))

  let threshold = 1
  const foreign = Object.freeze({ get threshold() { return threshold } })
  service.liquidityInput({ instId: 'BTC-USDT-SWAP' }, foreign, {})
  threshold++
  service.liquidityInput({ instId: 'BTC-USDT-SWAP' }, foreign, {})
  assert.equal(keys.at(-1), '{"threshold":2}', 'Object.freeze alone does not make foreign accessors immutable.')
})
