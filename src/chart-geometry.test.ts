import assert from 'node:assert/strict'
import test from 'node:test'
import { logarithmicY } from './chart-axis.ts'
import type { Bar } from './chart-data.ts'
import { createChartGeometryCache } from './chart-geometry.ts'

const intervalMS = 900_000
const candle = (index: number): Bar => ({ hour: index * intervalMS, open: 100, high: 103, low: 99, close: 102, confirmed: true,
  vwap: 101, ema: 100, bollUpper: 104, bollMiddle: 101, bollLower: 98,
  roc: index - 3, maroc: index - 4, rsi6: 25, rsi12: 50, rsi24: 75, atrPercent: 2.5, bbw: 6, oi: index * 10, buy: 7, sell: 3 })
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

test('RSI markers use the sampled candle coordinates and combine thresholds crossed in one jump', () => {
  const bars = rows().map((bar, index) => ({ ...bar, rsi6: index === 0 ? 20 : 80 }))
  const get = createChartGeometryCache(text => text.length * 6)
  const geometry = get(bars, viewport)
  assert.equal(geometry.rsiMarkers.length, 1)
  const marker = geometry.rsiMarkers[0]
  assert.equal(marker.index, 1)
  assert.equal(marker.hour, bars[1].hour)
  assert.equal(marker.field, 'rsi6')
  assert.equal(marker.direction, 'up')
  assert.deepEqual(marker.levels, [30, 70])
  close(marker.x, geometry.x[1])
  close(marker.y, geometry.rsiY(80))
  assert.equal(get(bars, viewport), geometry, 'Inspection reuses the prepared crossing geometry.')
  const forming = bars.map((bar, index) => index === 95 ? { ...bar, rsi6: 20, confirmed: false } : bar)
  const updated = get(forming, viewport).rsiMarkers.at(-1)!
  assert.equal(updated.index, 95)
  assert.equal(updated.direction, 'down')
  assert.deepEqual(updated.levels, [30, 70])
})

test('missing periods and unavailable observations break paths and filled areas without inventing zero samples', () => {
  const bars = [0, 1, 3, 4, 5].map(index => ({ ...candle(index), ema: index === 3 ? null : 100,
    atrPercent: index === 3 ? null : 2.5, bbw: index === 3 ? null : 6,
    buy: index === 3 ? null : 7, sell: index === 3 ? null : 3, oi: index === 3 ? null : index * 10 }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal((geometry.lines.ema.match(/M/g) ?? []).length, 2)
  assert.equal((geometry.lines.oi.match(/M/g) ?? []).length, 2)
  assert.equal((geometry.lines.atrPercent.match(/M/g) ?? []).length, 2)
  assert.equal((geometry.lines.bbw.match(/M/g) ?? []).length, 2)
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

test('ATR% and BBW use independent nonnegative percentage axes in one panel', () => {
  const bars = rows().map((bar, index) => ({ ...bar, atrPercent: index === 0 ? 0 : 0.5, bbw: index === 0 ? 0 : 8 }))
  const get = createChartGeometryCache(text => text.length * 6)
  const geometry = get(bars, viewport)
  const panel = geometry.layout.panels.atr
  assert.equal(geometry.atrRange.min, 0)
  assert.ok(geometry.atrRange.max >= 0.5 && geometry.atrRange.max < 8)
  assert.equal(geometry.bbwRange.min, 0)
  assert.ok(geometry.bbwRange.max >= 8)
  close(geometry.atrY(0), panel[1])
  close(geometry.atrY(geometry.atrRange.max), panel[0])
  close(geometry.bbwY(0), panel[1])
  close(geometry.bbwY(geometry.bbwRange.max), panel[0])
  for (const field of ['atrPercent', 'bbw'] as const) {
    const coordinates = [...geometry.lines[field].matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(([, x, y]) => [Number(x), Number(y)])
    assert.equal(coordinates.length, 97)
    assert.ok(coordinates.every(([, y]) => y >= panel[0] - 0.05 && y <= panel[1] + 0.05))
  }
  const missing = get(bars.map(bar => ({ ...bar, atrPercent: null, bbw: null })), viewport)
  assert.equal(missing.lines.atrPercent, '')
  assert.equal(missing.lines.bbw, '')
  assert.ok(Number.isFinite(missing.atrY(0)))
  assert.ok(Number.isFinite(missing.bbwY(0)))

  const higherBBW = get(bars.map(bar => ({ ...bar, bbw: bar.bbw * 100 })), viewport)
  assert.deepEqual(higherBBW.atrRange, geometry.atrRange, 'BBW cannot alter the ATR% domain.')
  close(higherBBW.atrY(0.5), geometry.atrY(0.5))
  assert.ok(higherBBW.bbwRange.max >= 800)
  const higherATR = get(bars.map(bar => ({ ...bar, atrPercent: bar.atrPercent * 100 })), viewport)
  assert.deepEqual(higherATR.bbwRange, geometry.bbwRange, 'ATR% cannot alter the BBW domain.')
  close(higherATR.bbwY(8), geometry.bbwY(8))
  assert.ok(higherATR.atrRange.max >= 50)

  const missingBBW = get(bars.map(bar => ({ ...bar, bbw: null })), viewport)
  assert.deepEqual(missingBBW.atrRange, geometry.atrRange)
  assert.equal(missingBBW.lines.bbw, '')
  const missingATR = get(bars.map(bar => ({ ...bar, atrPercent: null })), viewport)
  assert.deepEqual(missingATR.bbwRange, geometry.bbwRange)
  assert.equal(missingATR.lines.atrPercent, '')
})

test('positive ATR% and BBW ranges use the panel height without a forced zero baseline', () => {
  const bars = rows().map((bar, index) => ({ ...bar,
    atrPercent: index === 40 ? null : 0.12 + index / 95 * 0.14,
    bbw: index === 40 ? null : 2 + index / 95 * 6,
  }))
  for (const height of [400, 700, 1000]) {
    const geometry = createChartGeometryCache(text => text.length * 6)(bars, { ...viewport, height })
    const panel = geometry.layout.panels.atr, panelHeight = panel[1] - panel[0]
    close(geometry.atrRange.min, 0.113)
    close(geometry.atrRange.max, 0.267)
    close(geometry.bbwRange.min, 1.7)
    close(geometry.bbwRange.max, 8.3)
    for (const [scale, min, max] of [[geometry.atrY, 0.12, 0.26], [geometry.bbwY, 2, 8]] as const) {
      const top = scale(max), bottom = scale(min)
      assert.ok(top > panel[0] && bottom < panel[1], 'The curves retain padding at both ends.')
      assert.ok((bottom - top) / panelHeight > 0.9, 'The actual visible values must occupy most of the panel, even when the panel is short.')
    }
    assert.equal(geometry.layout.left, 0, 'Hidden volatility coordinates do not reserve a left gutter.')
  }
})

test('constant positive and zero volatility remain finite without artificial variation', () => {
  const get = createChartGeometryCache(text => text.length * 6)
  for (const value of [0, 0.000001, 0.2, 20]) {
    const geometry = get(rows().map(bar => ({ ...bar, atrPercent: value, bbw: value })), viewport)
    const panel = geometry.layout.panels.atr
    const expected = value === 0 ? panel[1] : (panel[0] + panel[1]) / 2
    close(geometry.atrY(value), expected)
    close(geometry.bbwY(value), expected)
    assert.ok(geometry.atrRange.min >= 0 && geometry.atrRange.max > geometry.atrRange.min)
    assert.doesNotMatch(geometry.lines.atrPercent + geometry.lines.bbw, /NaN|Infinity|undefined/)
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
