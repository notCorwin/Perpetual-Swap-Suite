import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectMarketTrafficReadiness } from '../helpers/market-traffic-readiness.mjs'

const instIds = Array.from({ length: 6 }, (_, index) => `T00${index}-USDT-SWAP`)
const readyFrame = (instId, overrides = {}) => ({ instId, timeframe: '15m', present: true, barCount: 96,
  indicatorState: 'ready', priceState: 'ready', oiState: 'ready', takerState: 'ready', ...overrides })

test('market readiness diagnostics retain per-contract terminal states and reasons without relaxing the ready gate', () => {
  const { readyIDs, missingIDs, terminalStates } = inspectMarketTrafficReadiness(instIds, '15m', [
    readyFrame(instIds[0]),
    readyFrame(instIds[1], { indicatorState: 'loading', indicatorStatus: { state: 'loading', from: 1_000, through: 2_000 } }),
    readyFrame(instIds[2], { oiState: 'unavailable', oiStatus: { state: 'unavailable', reason: 'not-published' } }),
    { instId: instIds[3], timeframe: '15m', present: false },
    readyFrame(instIds[4], { barCount: 95, priceState: 'partial', priceStatus: { state: 'partial', error: 'one slot missing' } }),
    readyFrame(instIds[5], { takerState: 'error', takerStatus: { state: 'error', error: 'fixture request failed' } }),
  ])

  assert.deepEqual(readyIDs, [instIds[0], instIds[2]])
  assert.deepEqual(missingIDs, [instIds[1], instIds[3], instIds[4], instIds[5]])
  assert.deepEqual(terminalStates[1].notReadyReasons, ['indicators-loading'])
  assert.deepEqual(terminalStates[2].notReadyReasons, [])
  assert.equal(terminalStates[2].oiStatus.reason, 'not-published')
  assert.equal(terminalStates[3].present, false)
  assert.deepEqual(terminalStates[3].notReadyReasons, ['no-resident-frame'])
  assert.deepEqual(terminalStates[4].notReadyReasons, ['bar-count-95-instead-of-96', 'price-partial'])
  assert.equal(terminalStates[5].takerStatus.error, 'fixture request failed')
  assert.deepEqual(terminalStates[5].notReadyReasons, ['taker-volume-error'])
})
