import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from './chart-data.ts'
import { chartPricePresentation, createChartGeometryCache } from './chart-geometry.ts'
import { chartPanelClip } from './chart-layout.ts'

const intervalMS = 900_000
const candle = (index: number): Bar => ({ hour: index * intervalMS, open: 100, high: 103, low: 99, close: 102, confirmed: true,
  ema: 100, bollUpper: 104, bollMiddle: 101, bollLower: 98,
  roc: index - 3, maroc: index - 4, rsi6: 25, rsi12: 50, rsi24: 75, atrPercent: 2.5, bbw: 6, oi: index * 10, buy: 7, sell: 3 })
const rows = () => Object.freeze(Array.from({ length: 96 }, (_, index) => Object.freeze(candle(index))))
const viewport = { width: 960, height: 700, endHour: 95 * intervalMS, intervalMS }
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('shared viewport coordinates preserve time gaps and relative price and zero-inclusive OI math', () => {
  const bars = rows(), geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  const { priceAxis, oiAxis, layout } = geometry
  assert.equal(priceAxis.kind, 'relative')
  assert.ok(oiAxis)
  for (const value of [98, 100, 102, 104]) {
    const fraction = ((value / 100 - 1) * 100 - priceAxis.min) / (priceAxis.max - priceAxis.min)
    close(geometry.priceY(value), layout.panels.price[1] - fraction * (layout.panels.price[1] - layout.panels.price[0]))
  }
  for (const value of [0, 1, 10, 950]) {
    const fraction = Math.log((value + 1) / (oiAxis.min + 1)) / Math.log((oiAxis.max + 1) / (oiAxis.min + 1))
    close(geometry.oiY(value), layout.panels.oi[1] - fraction * (layout.panels.oi[1] - layout.panels.oi[0]))
  }
  close(geometry.oiY(0), layout.panels.oi[1])
  const first = geometry.x[0], last = geometry.x.at(-1)!
  for (let index = 0; index < bars.length; index++) close(geometry.x[index], first + (last - first) * index / 95)
  close(geometry.rsiY(0), layout.panels.rsi[1])
  close(geometry.rsiY(100), layout.panels.rsi[0])
  close(geometry.takerY(7) - geometry.takerY(10), (layout.panels.taker[1] - layout.panels.taker[0]) * 3 / (geometry.takerAxis.max - geometry.takerAxis.min))
  assert.ok(priceAxis.min <= -2 && priceAxis.max >= 4)
  assert.equal(geometry.buySamples, 96)
  assert.equal(geometry.sellSamples, 96)
})

test('visible data determines padded linear viewports independently from their ticks', () => {
  const geometry = createChartGeometryCache(text => text.length * 6)(rows(), viewport)
  close(geometry.priceAxis.min, -2.3)
  close(geometry.priceAxis.max, 4.3)
  close(geometry.takerAxis.min, 0)
  close(geometry.takerAxis.max, 10.5)
  close(geometry.rocAxis.max, 92 * 1.05)
  assert.ok(geometry.priceAxis.ticks.every(tick => tick >= geometry.priceAxis.min && tick <= geometry.priceAxis.max))
  assert.ok(geometry.rocAxis.ticks.every(tick => tick >= geometry.rocAxis.min && tick <= geometry.rocAxis.max))
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

test('fractional overscan extends paths and crossings without changing the 96-bar axes', () => {
  const bars = rows().map(bar => ({ ...bar, rsi6: 25 }))
  const before = { ...candle(-1), rsi6: 80, high: 1000, low: 50 }
  const after = { ...candle(96), rsi6: 80, high: 2000, low: 40 }
  const get = createChartGeometryCache(text => text.length * 6)
  const baseline = get(bars, viewport)
  const geometry = get(bars, viewport, { before, after })
  assert.deepEqual(geometry.priceAxis, baseline.priceAxis)
  assert.deepEqual(geometry.oiAxis, baseline.oiAxis)
  assert.equal(geometry.x.length, 96)
  close(geometry.barPitch, geometry.x[1] - geometry.x[0])
  const bandX = [...geometry.bollBands[0].matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(([, x]) => Number(x))
  assert.equal(bandX.length, 196)
  assert.ok(bandX[0] < geometry.layout.left)
  assert.ok(Math.max(...bandX) > geometry.layout.right)
  const priceClip = chartPanelClip(geometry.layout, 'price', geometry.barPitch)
  assert.ok(bandX[0] >= priceClip.x && Math.max(...bandX) <= priceClip.x + priceClip.width,
    'The translated price panel clip must admit adjacent bar centers on both sides.')
  const leftCrossing = geometry.rsiMarkers.find(marker => marker.hour === bars[0].hour && marker.field === 'rsi6')
  const rightCrossing = geometry.rsiMarkers.find(marker => marker.hour === after.hour && marker.field === 'rsi6')
  assert.equal(leftCrossing?.index, 0)
  assert.equal(leftCrossing?.confirmed, true)
  assert.equal(rightCrossing?.index, -1, 'An overscan crossing does not masquerade as a visible selection index.')
  assert.equal(rightCrossing?.confirmed, true)
  assert.equal((geometry.upWicks + geometry.downWicks).match(/M/g)?.length, 98, 'Candle paths include both exact adjacent overscan bars.')
  assert.equal(geometry.buySamples, baseline.buySamples, 'Overscan does not change the visible statistics sample count.')
  assert.equal(geometry.sellSamples, baseline.sellSamples)
})

test('missing periods and unavailable observations break paths and filled areas without inventing zero samples', () => {
  const bars = [0, 1, 3, 4, 5].map(index => ({ ...candle(index),
    atrPercent: index === 3 ? null : 2.5, bbw: index === 3 ? null : 6,
    buy: index === 3 ? null : 7, sell: index === 3 ? null : 3, oi: index === 3 ? null : index * 10 }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
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

test('Bollinger values crossing zero retain a relative domain and genuine warmup gaps', () => {
  const bars = rows().map((bar, index) => ({ ...bar, bollLower: index < 19 ? null : -2, ema: null }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal(geometry.priceAxis.kind, 'relative')
  assert.ok(geometry.priceAxis.min <= -102 && geometry.priceAxis.max >= 4)
  close(geometry.priceY(0) - geometry.priceY(1), geometry.priceY(1) - geometry.priceY(2))
  assert.equal('ema' in geometry.lines, false)
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
  assert.ok(correction.priceAxis.max >= 50)

  const resized = get(bars, { ...viewport, width: 1200, height: 900 })
  assert.notEqual(resized.x.at(-1), initial.x.at(-1))
  assert.notEqual(resized.layout.panels.price[1], initial.layout.panels.price[1])
  const shifted = get(bars, { ...viewport, endHour: 96 * intervalMS })
  assert.ok(shifted.x[0] < initial.x[0])
  const otherPeriod = get(bars, { ...viewport, intervalMS: intervalMS * 4 })
  assert.notEqual(otherPeriod.x[1] - otherPeriod.x[0], initial.x[1] - initial.x[0])
  const quote = get(bars, { ...viewport, liveClose: 1000 })
  assert.ok(quote.priceAxis.max >= 900)
  assert.notDeepEqual(quote.bollBands, initial.bollBands)
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

test('price-only geometry fills the plot and has a separate reusable cache variant', () => {
  const bars = rows(), geometry = createChartGeometryCache(text => text.length * 6)
  const multi = geometry(bars, { ...viewport, height: 240, priceOnly: true })
  const full = geometry(bars, { ...viewport, height: 240, priceOnly: false })
  assert.notEqual(multi, full)
  assert.equal(geometry(bars, { ...viewport, height: 240, priceOnly: true }), multi)
  assert.equal(multi.layout.panels.price[1], 224)
  assert.ok(multi.layout.panels.price[1] - multi.layout.panels.price[0] > 180)
  assert.ok(multi.bollBands.length > 0)
  assert.equal(Object.values(multi.lines).every(path => path === ''), true)
})

test('unplotted EMA values cannot widen the main price scale or generate a path', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  for (const priceOnly of [false, true]) {
    const baseline = get(bars, { ...viewport, priceOnly })
    const extremeEMA = get(bars.map(bar => ({ ...bar, ema: 1_000_000 })), { ...viewport, priceOnly })
    assert.deepEqual(extremeEMA.priceAxis, baseline.priceAxis)
    assert.equal('ema' in extremeEMA.lines, false)
    assert.ok(extremeEMA.bollBands.length > 0)
    for (const field of ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']) assert.equal(field in extremeEMA.lines, false)
  }
})

test('relative normalization uses a positive reference even with an invalid visible base', () => {
  const bars = rows().map((bar, index) => ({ ...bar, open: 100 + index, high: 104 + index, low: 98 + index, close: 101 + index }))
  const get = createChartGeometryCache(text => text.length * 6)
  const options = { ...viewport, width: 400, barSpacing: 20 }
  const a = get(bars, options)
  assert.equal(a.priceAxis.base, a.bars[0].open)
  const b = get(bars, { ...options, endHour: viewport.endHour - intervalMS * 2.5 })
  assert.equal(b.priceAxis.base, b.bars[0].open)
  assert.notEqual(a.priceAxis.base, b.priceAxis.base)
  assert.equal(get(bars, options), a)
  assert.ok(a.priceTicks.every(tick => /%$/.test(tick.label)))
  const invalid = get([{ ...candle(0), open: 0 }], { ...viewport, endHour: 0 })
  assert.ok(invalid.priceAxis.base! > 0)
  assert.equal(chartPricePresentation(invalid, 0).base, null)
  assert.deepEqual(chartPricePresentation(invalid, 0).ticks, [])
})

test('presentation follows fractional body visibility including overscan without rebuilding paths', () => {
  const bars = rows().map((bar, index) => ({ ...bar, open: 100 + index, high: 104 + index, low: 98 + index, close: 101 + index }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, { ...viewport, width: 400, barSpacing: 20 })
  const first = geometry.bars[0]
  const boundary = -(geometry.x[0] + geometry.barWidth / 2)
  const a = chartPricePresentation(geometry, boundary + 0.01)
  const b = chartPricePresentation(geometry, boundary - 0.01)
  assert.equal(a.base, first.open)
  assert.equal(b.base, geometry.bars[1].open)
  assert.equal(a.geometryBase, geometry.priceAxis.base)
  const raw = geometry.priceAxis.base! * (1 + geometry.priceAxis.ticks[0] / 100)
  assert.ok(Math.abs(parseFloat(b.ticks[0].label.replaceAll(',', '')) - (raw / b.base! - 1) * 100) <= 0.5 * 10 ** -geometry.priceAxis.decimals + 1e-8)
  assert.deepEqual(chartPricePresentation(geometry, NaN).ticks, [])
})

test('rebased tick labels retain precision when the next visible base is much larger', () => {
  const bars = rows().map((bar, index) => ({ ...bar, open: index > 0 ? 10000 : 100, high: index > 0 ? 10001 : 104, low: index > 0 ? 9999 : 98, close: index > 0 ? 10000 : 101 }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, { ...viewport, endHour: 14 * intervalMS, width: 400, barSpacing: 20 })
  const offset = geometry.layout.left - (geometry.x[0] + geometry.barWidth / 2) - 0.01
  const presentation = chartPricePresentation(geometry, offset)
  assert.equal(presentation.base, 10000)
  const values = presentation.ticks.map(tick => parseFloat(tick.label.replaceAll(',', '')))
  assert.equal(new Set(values).size, values.length)
})

test('rebased labels preserve fractional offsets and cached paths across invalid bases', () => {
  const bars = rows().map((bar, index) => ({ ...bar, open: index === 1 ? 0 : 100 + index, high: 110 + index, low: 90 + index, close: 101 + index }))
  const get = createChartGeometryCache(text => text.length * 6)
  const options = { ...viewport, endHour: 14 * intervalMS, width: 400, barSpacing: 20 }
  const geometry = get(bars, options)
  const offsetFor = (index: number) => geometry.layout.left - (geometry.x[index] + geometry.barWidth / 2) + 0.01
  assert.ok(chartPricePresentation(geometry, offsetFor(0)).base! > 0)
  assert.equal(chartPricePresentation(geometry, offsetFor(1)).base, null)
  assert.ok(chartPricePresentation(geometry, offsetFor(2)).base! > 0)
  assert.equal(get(bars, options), geometry)
  assert.ok(geometry.upWicks + geometry.downWicks)
  const mock = { ...geometry, priceAxis: { ...geometry.priceAxis, base: 100, step: 2.5, ticks: [-50, -47.5, -45] }, priceTicks: [{ y: 0, label: '' }, { y: 1, label: '' }, { y: 2, label: '' }] }
  const rebased = chartPricePresentation(mock, offsetFor(0))
  const expected = (52.5 / rebased.base! - 1) * 100
  assert.ok(Math.abs(parseFloat(rebased.ticks[1].label.replaceAll(',', '')) - expected) <= 0.005001)
})

test('nonfinite OHLC never produces invalid cached price paths', () => {
  const broken = rows().map((bar, index) => ({ ...bar, open: index === 0 ? 100 : NaN, high: NaN, low: NaN, close: NaN, bollUpper: null, bollMiddle: null, bollLower: null }))
  const geometry = createChartGeometryCache(text => text.length * 6)(broken, viewport)
  assert.equal(geometry.priceAxis.base, 100)
  for (const path of [geometry.upWicks, geometry.downWicks, geometry.upBodies, geometry.downBodies, ...Object.values(geometry.lines), ...geometry.bollBands]) assert.doesNotMatch(path, /NaN|Infinity/)
  assert.ok(geometry.priceTicks.every(tick => Number.isFinite(tick.y)))
  const empty = broken.map(bar => ({ ...bar, open: NaN }))
  const unavailable = createChartGeometryCache(text => text.length * 6)(empty, viewport)
  assert.equal(unavailable.priceAxis.base, null)
  assert.deepEqual(unavailable.priceTicks, [])
})

test('fixed price scale maps one percent of its reference to the requested CSS pixels', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  for (const height of [240, 700]) for (const pixels of [5, 20, 120]) for (const base of [100, 150]) {
    const geometry = get(bars, { ...viewport, height, priceOnly: true, priceScaleMode: 'fixed', priceScalePixelsPerPercent: pixels, priceScaleBase: base })
    close(geometry.priceY(base) - geometry.priceY(base * 1.01), pixels)
    close(geometry.priceY(bars.at(-1)!.close), (geometry.layout.panels.price[0] + geometry.layout.panels.price[1]) / 2)
    assert.equal(get(bars, { ...viewport, height, priceOnly: true, priceScaleMode: 'fixed', priceScalePixelsPerPercent: pixels, priceScaleBase: base }), geometry)
  }
  const fixed = get(bars, { ...viewport, priceScaleMode: 'fixed', priceScalePixelsPerPercent: 20 })
  const automatic = get(bars, { ...viewport, priceScaleMode: 'auto', priceScalePixelsPerPercent: 20 })
  assert.notEqual(fixed, automatic)
  assert.notEqual(fixed.priceAxis.max - fixed.priceAxis.min, automatic.priceAxis.max - automatic.priceAxis.min)
})

test('price axis density follows panel height while preserving readable spacing and scale', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  for (const mode of ['fixed', 'auto'] as const) for (const height of [240, 560, 1000]) {
    const geometry = get(bars, { ...viewport, height, priceOnly: true, priceScaleMode: mode, priceScalePixelsPerPercent: 20, priceScaleBase: 100 })
    for (let i = 1; i < geometry.priceTicks.length; i++) {
      assert.ok(Math.abs(geometry.priceTicks[i].y - geometry.priceTicks[i - 1].y) >= 32 - 1e-8, 'Price labels have at least 32 CSS pixels of vertical separation.')
    }
    if (mode === 'fixed') close(geometry.priceY(100) - geometry.priceY(101), 20)
  }
  const tall = get(bars, { ...viewport, height: 560, priceOnly: true, priceScaleMode: 'fixed', priceScalePixelsPerPercent: 20, priceScaleBase: 100 })
  assert.ok(tall.priceTicks.length > 9, 'A tall price-only panel is not limited to nine labels.')
})
