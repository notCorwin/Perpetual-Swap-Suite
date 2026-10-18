import assert from 'node:assert/strict'
import test from 'node:test'
import { logarithmicY } from './chart-axis.ts'
import type { Bar } from './chart-data.ts'
import { createChartGeometryCache } from './chart-geometry.ts'

const intervalMS = 900_000
const candle = (index: number): Bar => ({ hour: index * intervalMS, open: 100, high: 103, low: 99, close: 102, confirmed: true,
  vwap: 101, ema: 100, bollUpper: 104, bollMiddle: 101, bollLower: 98,
  roc: index - 3, maroc: index - 4, rsi6: 25, rsi12: 50, rsi24: 75, oi: index * 10, buy: 7, sell: 3 })
const rows = () => Object.freeze(Array.from({ length: 96 }, (_, index) => Object.freeze(candle(index))))
const viewport = { width: 960, height: 700, endHour: 95 * intervalMS, intervalMS }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('shared viewport coordinates preserve time gaps and logarithmic price and zero-inclusive OI math', () => {
  const bars = rows(), geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  const { priceAxis, oiAxis, layout } = geometry
  assert.equal(priceAxis.kind, 'logarithmic')
  assert.ok(oiAxis)
  for (const value of [98, 100, 102, 104]) {
    close(geometry.priceY(value), logarithmicY(value, priceAxis, layout.panels.price))
  }
  for (const value of [0, 1, 10, 950]) close(geometry.oiY(value), logarithmicY(value, oiAxis, layout.panels.oi))
  close(geometry.oiY(0), layout.panels.oi[1])
  const first = geometry.x[0], last = geometry.x.at(-1)!
  for (let index = 0; index < bars.length; index++) close(geometry.x[index], first + (last - first) * index / 95)
  close(geometry.rsiY(0), layout.panels.rsi[1])
  close(geometry.rsiY(100), layout.panels.rsi[0])
  close(geometry.takerY(7) - geometry.takerY(10), (layout.panels.taker[1] - layout.panels.taker[0]) * 3 / (geometry.takerAxis.max - geometry.takerAxis.min))
  assert.ok(priceAxis.min < 98 && priceAxis.max > 104)
  assert.equal(geometry.buySamples, 96)
  assert.equal(geometry.sellSamples, 96)
})

test('missing periods and unavailable observations break paths and filled areas without inventing zero samples', () => {
  const bars = [0, 1, 3, 4, 5].map(index => ({ ...candle(index), ema: index === 3 ? null : 100,
    buy: index === 3 ? null : 7, sell: index === 3 ? null : 3, oi: index === 3 ? null : index * 10 }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal((geometry.lines.ema.match(/M/g) ?? []).length, 2)
  assert.equal((geometry.lines.oi.match(/M/g) ?? []).length, 2)
  assert.equal(geometry.bollBands.length, 2)
  assert.equal((geometry.rocAreas[0].match(/Z/g) ?? []).length, 2)
  assert.equal(geometry.oiSamples.length, 4)
  assert.equal(geometry.buySamples, 4)
  assert.equal(geometry.sellSamples, 4)
  assert.equal(geometry.oiComplete, false)
  assert.equal(geometry.takerComplete, false)
  close(geometry.x[2] - geometry.x[1], 2 * (geometry.x[1] - geometry.x[0]))
  for (const path of [...Object.values(geometry.lines), ...geometry.bollBands, ...geometry.rocAreas, geometry.buys, geometry.sells]) {
    assert.doesNotMatch(path, /NaN|Infinity|undefined/)
  }
})

test('Bollinger values crossing zero retain a linear domain and genuine warmup gaps', () => {
  const bars = rows().map((bar, index) => ({ ...bar, bollLower: index < 19 ? null : -2, ema: null }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal(geometry.priceAxis.kind, 'linear')
  assert.ok(geometry.priceAxis.min <= -2 && geometry.priceAxis.max >= 104)
  close(geometry.priceY(0) - geometry.priceY(1), geometry.priceY(1) - geometry.priceY(2))
  assert.equal(geometry.lines.ema, '')
  assert.equal((geometry.lines.bollLower.match(/[ML]/g) ?? []).length, 77)
  assert.equal(geometry.bollBands.length, 1)
})

test('immutable window revisits reuse geometry while corrections, resize, native period and live-domain changes recompute it', () => {
  let measurements = 0
  const get = createChartGeometryCache(text => { measurements++; return text.length * 6 })
  const bars = rows(), initial = get(bars, viewport), measured = measurements
  get(rows(), viewport)
  const afterOtherWindow = measurements
  assert.ok(afterOtherWindow > measured)
  assert.equal(get(bars, { ...viewport }), initial)
  assert.equal(measurements, afterOtherWindow, 'Revisiting an unchanged window performs no axis-label measurements.')

  const corrected = bars.map((bar, index) => index === 40 ? { ...bar, high: 150, close: 140 } : bar)
  const correction = get(corrected, viewport)
  assert.notEqual(correction, initial)
  assert.notEqual(correction.upWicks, initial.upWicks)
  assert.ok(correction.priceAxis.max > 150)

  const resized = get(bars, { ...viewport, width: 1200, height: 900 })
  assert.notEqual(resized.x.at(-1), initial.x.at(-1))
  assert.notEqual(resized.layout.panels.price[1], initial.layout.panels.price[1])
  const shifted = get(bars, { ...viewport, endHour: 96 * intervalMS })
  assert.ok(shifted.x[0] < initial.x[0])
  const otherPeriod = get(bars, { ...viewport, intervalMS: intervalMS * 4 })
  assert.notEqual(otherPeriod.x[1] - otherPeriod.x[0], initial.x[1] - initial.x[0])
  const quote = get(bars, { ...viewport, liveClose: 1000 })
  assert.ok(quote.priceAxis.max > 1000)
  assert.notEqual(quote.lines.ema, initial.lines.ema)
  assert.ok(quote.priceY(1000) >= quote.layout.panels.price[0])
})

test('derived geometry has a global retention bound even while source windows remain alive', () => {
  const get = createChartGeometryCache(text => text.length * 6)
  const windows = Array.from({ length: 65 }, rows)
  const first = get(windows[0], viewport)
  const second = get(windows[1], viewport)
  for (const bars of windows.slice(2, 64)) get(bars, viewport)
  assert.equal(get(windows[1], viewport), second)
  get(windows[64], viewport)
  assert.notEqual(get(windows[0], viewport), first, 'A source-window reference cannot retain derived paths beyond the global cache limit.')
  assert.equal(get(windows[1], viewport), second, 'Recently used windows survive eviction.')
})
