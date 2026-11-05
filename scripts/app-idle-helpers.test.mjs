import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertReadyFrame, expectedClose, phaseWindow } from './app-idle-helpers.mjs'

const fixture = { instIds: ['SCALE000-USDT-SWAP', 'SCALE001-USDT-SWAP'], periods: 320,
  intervals: { '5m': 300_000, '15m': 900_000, '1H': 3_600_000 } }
const quote = expectedClose(fixture, fixture.instIds[1], '1H', 7)
const frame = { instId: fixture.instIds[1], chartInst: fixture.instIds[1], renderedInst: fixture.instIds[1],
  timeframe: '1H', renderedTimeframe: '1H', visible: true, visualStale: 'false', loading: 'false',
  renderedBars: 96, bars: 96, indicatorState: 'ready', renderedEnd: 20, chartEnd: 20, endHour: 20,
  liveBar: { hour: 20, close: quote }, priceLabel: String(quote) }

test('a ready event must contain the correct SVG identity and actual latest price', () => {
  assertReadyFrame(frame, { instId: frame.instId, timeframe: '1H', expected: quote })
  assertReadyFrame({ ...frame, priceLabel: `${quote} ↑` }, { instId: frame.instId, timeframe: '1H', expected: quote })
  assert.throws(() => assertReadyFrame({ ...frame, liveBar: { ...frame.liveBar, close: quote - .001 } }, { instId: frame.instId, timeframe: '1H', expected: quote }))
  assert.throws(() => assertReadyFrame({ ...frame, priceLabel: String(quote - .001) }, { instId: frame.instId, timeframe: '1H', expected: quote }))
  assert.throws(() => assertReadyFrame({ ...frame, renderedInst: fixture.instIds[0] }, { instId: frame.instId, timeframe: '1H', expected: quote }))
  assert.throws(() => assertReadyFrame({ ...frame, marketPrice: '1', marketCount: 2 }, { instId: frame.instId, timeframe: '1H', expected: quote, marketExpected: 2, marketCount: 2 }))
  assertReadyFrame({ ...frame, liveBar: null }, { instId: frame.instId, timeframe: '1H', historicalEnd: 20 })
  assert.throws(() => assertReadyFrame(frame, { instId: frame.instId, timeframe: '1H', historicalEnd: 19 }))
})

test('paired windows contain exactly the requested contiguous and successful native ticks', () => {
  const samples = Array.from({ length: 9 }, (_, index) => ({ timestampMS: index * 1000 }))
  const ticks = Array.from({ length: 16 }, (_, index) => ({ sequence: index + 1, emittedAt: index * 500 + 250, completedAt: index * 500 + 300, nativeUpdates: 6 }))
  const options = { start: 1000, end: 7000, tickCount: 8, expectedUpdates: 6 }
  const chosen = phaseWindow(samples, ticks, options)
  assert.equal(chosen.ticks.length, 8)
  assert.equal(chosen.through - chosen.from, 4000)
  assert.ok(chosen.from >= options.start && chosen.through <= options.end)
  assert.deepEqual(chosen.ticks.map(tick => tick.sequence), Array.from({ length: 8 }, (_, index) => chosen.ticks[0].sequence + index))
  const invalid = ticks.map(tick => ({ ...tick, nativeUpdates: 5 }))
  assert.throws(() => phaseWindow(samples, invalid, options), /No complete sampler window/)
  assert.throws(() => phaseWindow(samples, ticks.map(tick => ({ ...tick, completedAt: tick.emittedAt + 5000 })), options), /No complete sampler window/)
  assert.throws(() => phaseWindow(samples, ticks.filter(tick => tick.sequence !== 8), { ...options, tickCount: 12 }), /No complete sampler window/)
})

test('the synthetic price oracle distinguishes contracts, timeframes and source revisions', () => {
  assert.notEqual(quote, expectedClose(fixture, fixture.instIds[0], '1H', 7))
  assert.notEqual(quote, expectedClose(fixture, fixture.instIds[1], '15m', 7))
  assert.notEqual(quote, expectedClose(fixture, fixture.instIds[1], '1H', 6))
  assert.throws(() => expectedClose(fixture, 'UNKNOWN', '1H', 7))
  assert.throws(() => expectedClose(fixture, fixture.instIds[0], '1H', 0))
})
