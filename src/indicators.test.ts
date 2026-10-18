import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { appendIndicatorCandle, barsWithIndicators, buildIndicatorSeries, createIndicatorState, projectIndicatorCandle } from '../electron/services/indicators.js'
import { signedRelativeChange } from '../electron/services/market-metrics.js'

const candle = (close: number, index: number, baseVolume: number | null = 1) => ({ timestamp: index * 300_000, open: close, high: close, low: close, close, baseVolume, quoteVolume: baseVolume === null ? null : baseVolume * close, confirmed: true })
const near = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null)
  assert.ok(Math.abs(actual! - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`)
}

test('EMA200 has an independent SMA seed and recursive continuation', () => {
  const bars = barsWithIndicators(Array.from({ length: 201 }, (_, index) => candle(index + 1, index)))
  assert.equal(bars[198].ema, null)
  near(bars[199].ema, 100.5)
  near(bars[200].ema, 101.5)
})

test('BOLL(20,2) uses arithmetic closes and population deviation including a negative lower band', () => {
  const bars = barsWithIndicators(Array.from({ length: 20 }, (_, index) => candle(index + 1, index)))
  assert.equal(bars[18].bollMiddle, null)
  near(bars[19].bollMiddle, 10.5)
  near(bars[19].bollUpper, 10.5 + 2 * Math.sqrt(399 / 12))
  near(bars[19].bollLower, 10.5 - 2 * Math.sqrt(399 / 12))
})

test('rolling VWAP14 weights typical price by base quantity, never quote amount', () => {
  const source = Array.from({ length: 14 }, (_, index) => candle(index < 7 ? 100 : 200, index))
  const bars = barsWithIndicators(source)
  assert.equal(bars[12].vwap, null)
  near(bars[13].vwap, 150)
  assert.equal(barsWithIndicators(source.map(row => ({ ...row, baseVolume: 0 }))).at(-1)?.vwap, null)
  assert.equal(barsWithIndicators(source.map((row, index) => index === 3 ? { ...row, baseVolume: null } : row)).at(-1)?.vwap, null)
  const typical = source.map(row => ({ ...row, high: row.close + 6, low: row.close - 3 }))
  near(barsWithIndicators(typical).at(-1)!.vwap, 151)
})

test('ROC9 and MAROC9 preserve percentage units and exact warmup boundaries', () => {
  const bars = barsWithIndicators(Array.from({ length: 18 }, (_, index) => candle(2 ** index, index)))
  assert.equal(bars[8].roc, null)
  near(bars[9].roc, 51_100)
  assert.equal(bars[16].maroc, null)
  near(bars[17].maroc, 51_100)
  near(bars[17].rocChange, 0)
})

test('Wilder RSI uses mean gain/loss seeds and explicit flat and one-sided boundaries', () => {
  const closes = [100, 102, 101, 104, 102, 103, 100, 104]
  const bars = barsWithIndicators(closes.map((close, index) => candle(close, index)))
  assert.equal(bars[5].rsi6, null)
  near(bars[6].rsi6, 50)
  near(bars[7].rsi6, 450 / 7)
  for (const period of [6, 12, 24] as const) {
    const source = Array.from({ length: period + 1 }, (_, index) => candle(100 + index, index))
    near(barsWithIndicators(source).at(-1)![`rsi${period}`], 100)
    near(barsWithIndicators(source.map(row => ({ ...row, close: 200 - row.close }))).at(-1)![`rsi${period}`], 0)
    near(barsWithIndicators(source.map(row => ({ ...row, close: 100 }))).at(-1)![`rsi${period}`], 50)
  }
})

test('a source gap restarts recursive and windowed indicator initialization', () => {
  const before = Array.from({ length: 220 }, (_, index) => candle(100 + index, index))
  const after = Array.from({ length: 12 }, (_, index) => candle(200 + index, 300 + index))
  const bar = barsWithIndicators([...before, ...after]).at(-1)!
  assert.equal(bar.ema, null)
  assert.equal(bar.rsi24, null)
  assert.equal(bar.vwap, null)
  assert.equal(bar.bollMiddle, null)
  assert.equal(bar.maroc, null)
})

test('signed relative change has a signed numerator, absolute baseline and unavailable zero baseline', () => {
  assert.equal(signedRelativeChange(-5, -10), 50)
  assert.equal(signedRelativeChange(-15, -10), -50)
  assert.equal(signedRelativeChange(0, 0), null)
  assert.equal(signedRelativeChange(10, 0), null)
  assert.equal(signedRelativeChange(NaN, 10), null)
})

test('incremental confirmed appends and repeated live projections equal canonical history at every warmup boundary', () => {
  const source = Array.from({ length: 260 }, (_, index) => {
    const close = 500 + index / 3 + Math.sin(index) * 30
    return { ...candle(close, index, index % 11), high: close + 9, low: close - 6 }
  })
  const canonical = barsWithIndicators(source), state = createIndicatorState()
  for (let index = 0; index < source.length; index += 1) {
    const confirmed = source[index], snapshot = structuredClone(state)
    for (const offset of [-20, 20, -5, 0]) {
      const revision = { ...confirmed, close: confirmed.close + offset, high: confirmed.high + Math.max(offset, 0), low: confirmed.low + Math.min(offset, 0), confirmed: false }
      const projected = projectIndicatorCandle(state, revision)
      assert.deepEqual(projected, barsWithIndicators([...source.slice(0, index), revision]).at(-1), `live revision ${offset} at ${index}`)
      assert.deepEqual(state, snapshot, 'A forming update must never change the durable EMA/RSI seed or rolling windows.')
    }
    assert.deepEqual(appendIndicatorCandle(state, confirmed), canonical[index], `confirmed candle ${index}`)
  }
  assert.deepEqual(state, buildIndicatorSeries(source).state)
})

test('gaps restart confirmed and live initialization without contaminating the preceding seed', () => {
  const before = Array.from({ length: 240 }, (_, index) => candle(100 + index, index))
  const after = Array.from({ length: 205 }, (_, index) => candle(600 - index / 2, 300 + index, index === 3 ? null : 1))
  const { state } = buildIndicatorSeries(before), snapshot = structuredClone(state)
  assert.deepEqual(projectIndicatorCandle(state, { ...after[0], confirmed: false }), barsWithIndicators([{ ...after[0], confirmed: false }])[0])
  assert.deepEqual(state, snapshot)
  const expected = barsWithIndicators(after)
  for (let index = 0; index < after.length; index += 1) assert.deepEqual(appendIndicatorCandle(state, after[index]), expected[index])
  assert.deepEqual(buildIndicatorSeries([...before, ...after]).state, state)
})

test('corrected and prepended durable history rebuilds the recursive seed instead of reusing a shortened window', () => {
  const source = Array.from({ length: 500 }, (_, index) => candle(index < 299 ? 1000 : 100, index))
  const original = buildIndicatorSeries(source), correction = { ...source[199], close: 500 }
  assert.throws(() => appendIndicatorCandle(original.state, correction), /rebuilding/)
  assert.throws(() => projectIndicatorCandle(original.state, correction), /rebuilding/)
  const corrected = source.map(row => row.timestamp === correction.timestamp ? correction : row)
  const rebuilt = buildIndicatorSeries(corrected)
  assert.notEqual(rebuilt.bars.at(-1)!.ema, original.bars.at(-1)!.ema)
  near(rebuilt.bars.at(-1)!.ema, 100 + (900 - 2.5 * (199 / 201) ** 99) * (199 / 201) ** 201)
  const tailOnly = buildIndicatorSeries(source.slice(200))
  assert.notEqual(tailOnly.bars.at(-1)!.ema, original.bars.at(-1)!.ema)
  assert.deepEqual(buildIndicatorSeries([...source.slice(200), ...source.slice(0, 200)]), original)
  const next = candle(105, 500)
  assert.deepEqual(projectIndicatorCandle(rebuilt.state, next), barsWithIndicators([...corrected, next]).at(-1))
})

test('worker-serializable seeds remain bounded and retain no source-history references', () => {
  const source = Array.from({ length: 10_000 }, (_, index) => candle(100 + index / 10 + Math.sin(index), index, index % 7))
  const { state } = buildIndicatorSeries(source), transferred = structuredClone(state)
  assert.ok(JSON.stringify(state).length < 4_000, 'A seed must fit fixed rolling windows regardless of the historical series length.')
  const next = candle(1200, source.length)
  source.forEach(row => { row.close = -1; row.baseVolume = null })
  assert.deepEqual(projectIndicatorCandle(state, next), projectIndicatorCandle(transferred, next))
  assert.deepEqual(appendIndicatorCandle(state, next), appendIndicatorCandle(transferred, next))
})

test('invalid observations do not mutate a seed and an unavailable ROC never enters the MAROC mean', () => {
  const source = Array.from({ length: 25 }, (_, index) => candle(index === 9 ? 0 : index + 1, index))
  const { bars, state } = buildIndicatorSeries(source)
  assert.equal(bars[18].roc, null)
  assert.equal(bars[18].maroc, null)
  const snapshot = structuredClone(state)
  assert.equal(appendIndicatorCandle(state, { ...candle(10, 25), close: NaN }), null)
  assert.equal(projectIndicatorCandle(state, { ...candle(10, 25), timestamp: NaN }), null)
  assert.deepEqual(state, snapshot)
  assert.throws(() => createIndicatorState(0), /positive/)
})
