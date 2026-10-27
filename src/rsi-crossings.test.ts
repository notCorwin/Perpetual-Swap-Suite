import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from './chart-data.ts'
import { chartRsiCrossings, RSI_FIELDS, RSI_LEVELS, type RsiCrossing, type RsiField, type RsiLevel } from './rsi-crossings.ts'

type RsiBar = Pick<Bar, 'hour' | RsiField>
const intervalMS = 15 * 60_000
const bar = (index: number, values: Partial<Pick<Bar, RsiField>> = {}): RsiBar => ({
  hour: index * intervalMS, rsi6: null, rsi12: null, rsi24: null, ...values,
})
const series = (values: readonly (number | null)[]) => values.map((value, index) => bar(index, { rsi6: value }))
const crossing = (index: number, value: number, level: RsiLevel, direction: RsiCrossing['direction'], field: RsiField = 'rsi6'): RsiCrossing =>
  ({ field, index, hour: index * intervalMS, value, level, direction })

test('both thresholds cross in either direction, in candle, field, then level order', () => {
  const bars = [20, 80, 80, 20].map((value, index) => bar(index, { rsi6: value, rsi12: value, rsi24: value }))
  assert.deepEqual(chartRsiCrossings(bars, intervalMS), [
    ...RSI_FIELDS.flatMap(field => RSI_LEVELS.map(level => crossing(1, 80, level, 'up', field))),
    ...RSI_FIELDS.flatMap(field => RSI_LEVELS.map(level => crossing(3, 20, level, 'down', field))),
  ])
})

test('equality plateaus preserve sides without emitting on touches or initial equality', () => {
  for (const level of RSI_LEVELS) {
    for (const direction of ['up', 'down'] as const) {
      const before = level + (direction === 'up' ? -1 : 1), after = 2 * level - before
      assert.deepEqual(chartRsiCrossings(series([before, level, level, after, after]), intervalMS), [crossing(3, after, level, direction)])
      assert.deepEqual(chartRsiCrossings(series([before, level, level, before]), intervalMS), [])
      assert.deepEqual(chartRsiCrossings(series([level, level, after]), intervalMS), [])
    }
  }
})

test('RSI fields cross independently at their own sampled values', () => {
  const bars = [
    bar(0, { rsi6: 29, rsi12: 71, rsi24: 50 }),
    bar(1, { rsi6: 31, rsi12: 69, rsi24: 50 }),
    bar(2, { rsi6: 32, rsi12: 68, rsi24: 71 }),
  ]
  assert.deepEqual(chartRsiCrossings(bars, intervalMS), [
    crossing(1, 31, 30, 'up'), crossing(1, 69, 70, 'down', 'rsi12'), crossing(2, 71, 70, 'up', 'rsi24'),
  ])
})

test('invalid or missing observations reset only that field, and its next sample only seeds', () => {
  for (const invalid of [null, NaN, Infinity, -Infinity, 'missing'] as const) {
    for (const field of RSI_FIELDS) {
      const bars = [20, 30, 80, 20].map((value, index) => bar(index, { rsi6: value, rsi12: value, rsi24: value }))
      if (invalid === 'missing') Reflect.deleteProperty(bars[1], field)
      else bars[1][field] = invalid
      assert.deepEqual(chartRsiCrossings(bars, intervalMS), [
        ...RSI_FIELDS.filter(other => other !== field).flatMap(other => RSI_LEVELS.map(level => crossing(2, 80, level, 'up', other))),
        ...RSI_FIELDS.flatMap(other => RSI_LEVELS.map(level => crossing(3, 20, level, 'down', other))),
      ], `${field}: ${invalid}`)
    }
  }
})

test('gaps, duplicates, reversed times, and nonfinite timestamps reset all fields', () => {
  for (const interruptedHour of [2 * intervalMS, 0, -intervalMS, NaN, Infinity, -Infinity]) {
    const nextHour = Number.isFinite(interruptedHour) ? interruptedHour + intervalMS : 2 * intervalMS
    const bars = [20, 80, 20, 80].map((value, index) => bar(index, { rsi6: value, rsi12: value, rsi24: value }))
    bars[1].hour = interruptedHour
    bars[2].hour = nextHour
    bars[3].hour = nextHour + intervalMS
    const expected = [
      ...(Number.isFinite(interruptedHour) ? RSI_FIELDS.flatMap(field => RSI_LEVELS.map(level => ({ ...crossing(2, 20, level, 'down', field), hour: nextHour }))) : []),
      ...RSI_FIELDS.flatMap(field => RSI_LEVELS.map(level => ({ ...crossing(3, 80, level, 'up', field), hour: nextHour + intervalMS }))),
    ]
    assert.deepEqual(chartRsiCrossings(bars, intervalMS), expected, `timestamp: ${interruptedHour}`)
  }
})

test('an equality plateau cannot bridge missing observations or timestamp gaps', () => {
  assert.deepEqual(chartRsiCrossings(series([29, null, 30, 31]), intervalMS), [])
  const bars = series([71, 70, 69])
  bars[1].hour += intervalMS
  bars[2].hour += intervalMS
  assert.deepEqual(chartRsiCrossings(bars, intervalMS), [])
})

test('empty, single-sample, and invalid-interval inputs have no crossings', () => {
  assert.deepEqual(chartRsiCrossings([], intervalMS), [])
  assert.deepEqual(chartRsiCrossings([bar(0, { rsi6: 80, rsi12: 20, rsi24: 71 })], intervalMS), [])
  for (const invalid of [0, -intervalMS, NaN, Infinity]) {
    assert.deepEqual(chartRsiCrossings(series([20, 80]), invalid), [])
  }
})

test('frozen inputs yield repeatable results without mutation', () => {
  const bars = Object.freeze(series([29, 30, 31]).map(value => Object.freeze(value)))
  const expected = [crossing(2, 31, 30, 'up')]
  assert.deepEqual(chartRsiCrossings(bars, intervalMS), expected)
  assert.deepEqual(chartRsiCrossings(bars, intervalMS), expected)
})
