import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeChartWire, decodeChartWire } from '../../electron/chart-wire.js'

test('chart wire preserves full, historical, universe and compact publication values', () => {
  const bar = { hour: 600_000, open: 1.25, high: 2, low: 1, close: 1.5, confirmed: true,
    ema: null, rsi6: -0, roc: NaN, maroc: Infinity, bbw: -Infinity,
    oiUnavailableReason: undefined, takerUnavailableReason: 'not-published' }
  const full = { instId: 'BTC-USDT-SWAP', timeframe: '5m', intervalMS: 300_000,
    endHour: 600_000, latestEnd: 900_000, oldestHour: 0, historyExhausted: false,
    generation: 17, revision: 23, bars: [bar], liveBar: undefined,
    sourceVersions: { price: 7, oi: 5, taker: 8 }, priceState: 'stale',
    priceStatus: { state: 'error', from: 0, through: 600_000, error: 'repair', retryAt: 5 },
    oiState: 'unavailable', oiStatus: { state: 'unavailable', from: 0, through: 600_000, reason: 'not-published' },
    takerState: 'ready', indicatorState: 'ready', error: '' }
  const live = { type: 'live', instId: full.instId, timeframe: full.timeframe,
    generation: full.generation, revision: 24, endHour: 900_000, liveBar: { ...bar, confirmed: false },
    sourceVersions: { price: 8, oi: 5, taker: 8 }, priceObservedAt: undefined, priceAsOf: null }
  const correction = { ...full, revision: 25, bars: [{ ...bar, close: 1.75 }] }
  for (const payload of [full, live, correction, { frames: [full, correction] }, null]) {
    const wire = encodeChartWire(payload)
    assert.equal(typeof wire, 'string')
    assert.deepStrictEqual(decodeChartWire(wire), payload)
  }
  const result = decodeChartWire(encodeChartWire(full))
  assert.ok(Object.hasOwn(result, 'liveBar'))
  assert.ok(Object.hasOwn(result.bars[0], 'oiUnavailableReason'))
  assert.ok(Object.is(result.bars[0].rsi6, -0))
  assert.ok(Number.isNaN(result.bars[0].roc))
  assert.equal(result.bars[0].maroc, Infinity)
  assert.equal(result.bars[0].bbw, -Infinity)
})

test('wire values preserve undefined in arrays, at the root and in ordinary data fields', () => {
  const data = [undefined, null, -0, NaN, Infinity, -Infinity, { value: undefined, other: null }, '\u0000u']
  assert.deepStrictEqual(decodeChartWire(encodeChartWire(data)), data)
  assert.equal(decodeChartWire(encodeChartWire(undefined)), undefined)
  const protoKey = JSON.parse('{"__proto__":null}')
  Object.defineProperty(protoKey, '__proto__', { value: undefined, enumerable: true, configurable: true, writable: true })
  const restored = decodeChartWire(encodeChartWire(protoKey))
  assert.equal(Object.getPrototypeOf(restored), Object.prototype)
  assert.equal(Object.hasOwn(restored, '__proto__'), true)
  assert.equal(restored.__proto__, undefined)
})

test('wire rejects values JSON would silently discard or transform', () => {
  const sparse = []; sparse.length = 1
  const extra = [1]; extra.extra = true
  const hidden = {}; Object.defineProperty(hidden, 'value', { value: 1 })
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw new Error('getter ran') } })
  const cycle = {}; cycle.self = cycle
  for (const value of [sparse, extra, hidden, accessor, cycle, Object.create(null), new Date(), new Map(), { value: 1n }, { value: Symbol() }, { value() {} }, { [Symbol()]: 1 }]) {
    assert.throws(() => encodeChartWire(value), TypeError)
  }
})

test('malformed wire, exception paths, placeholders and duplicate exceptions reject', () => {
  const invalid = [null, {}, '', 'not json', '[]', '[2,null,[]]', '[1,null,{}]',
    '[1,{},[[["missing","x"],0]]]', '[1,{"x":null},[[["x"],0]]]',
    '[1,{"x":1},[[["x"],1]]]', '[1,{"x":null},[[["x"],9]]]',
    '[1,[null],[[["length"],0]]]', '[1,[null],[[["1"],0]]]',
    '[1,{"x":null},[[["x"],1],[["x"],1]]]', '[1,null,[[[],0],[[],0]]]']
  for (const wire of invalid) assert.throws(() => decodeChartWire(wire))
})
