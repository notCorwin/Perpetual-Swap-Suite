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

test('viewport coordinates preserve relative price and candle time', () => {
  const bars = rows(), geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  const { priceAxis, layout } = geometry
  assert.equal(priceAxis.kind, 'relative')
  for (const value of [98, 100, 102, 104]) {
    const fraction = ((value / 100 - 1) * 100 - priceAxis.min) / (priceAxis.max - priceAxis.min)
    close(geometry.priceY(value), layout.panels.price[1] - fraction * (layout.panels.price[1] - layout.panels.price[0]))
  }
  const first = geometry.x[0], last = geometry.x.at(-1)!
  for (let index = 0; index < bars.length; index++) close(geometry.x[index], first + (last - first) * index / 95)
  close(geometry.priceY(100) - geometry.priceY(101), 25)
})

test('fractional overscan extends paths without changing the 96-bar axes', () => {
  const bars = rows().map(bar => ({ ...bar, rsi6: 25 }))
  const before = { ...candle(-1), rsi6: 80, high: 1000, low: 50 }
  const after = { ...candle(96), rsi6: 80, high: 2000, low: 40 }
  const get = createChartGeometryCache(text => text.length * 6)
  const baseline = get(bars, viewport)
  const geometry = get(bars, viewport, { before, after })
  assert.deepEqual(geometry.priceAxis, baseline.priceAxis)
  assert.equal(geometry.x.length, 96)
  close(geometry.barPitch, geometry.x[1] - geometry.x[0])
  const bandX = [...geometry.bollBands[0].matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(([, x]) => Number(x))
  assert.equal(bandX.length, 196)
  assert.ok(bandX[0] < geometry.layout.left)
  assert.ok(Math.max(...bandX) > geometry.layout.right)
  const priceClip = chartPanelClip(geometry.layout, 'price', geometry.barPitch)
  assert.ok(bandX[0] >= priceClip.x && Math.max(...bandX) <= priceClip.x + priceClip.width,
    'The translated price panel clip must admit adjacent bar centers on both sides.')
  assert.equal((geometry.upWicks + geometry.downWicks).match(/M/g)?.length, 98, 'Candle paths include both exact adjacent overscan bars.')

})

test('Bollinger values crossing zero retain a relative domain and genuine warmup gaps', () => {
  const bars = rows().map((bar, index) => ({ ...bar, bollLower: index < 19 ? null : -2, ema: null }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal(geometry.priceAxis.kind, 'relative')
  close(geometry.priceY(100) - geometry.priceY(101), 25)
  close(geometry.priceY(0) - geometry.priceY(1), geometry.priceY(1) - geometry.priceY(2))
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
  assert.deepEqual(correction.priceAxis, initial.priceAxis, 'An earlier extreme does not change the fixed scale.')

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

test('price geometry fills the plot and reuses unchanged cache entries', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  const geometry = get(bars, { ...viewport, height: 240 })
  assert.equal(get(bars, { ...viewport, height: 240 }), geometry)
  assert.equal(geometry.layout.panels.price[1], 224)
  assert.ok(geometry.bollBands.length > 0)
  assert.ok(Object.values(geometry.bollLines).every(path => path.length > 0))
})

test('Bollinger lines independently break at missing values and time gaps', () => {
  const bars = rows().map((bar, index) => ({ ...bar, bollMiddle: index === 30 ? null : bar.bollMiddle }))
  bars.splice(60, 1)
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  const moves = (path: string) => (path.match(/M/g) ?? []).length
  assert.equal(moves(geometry.bollLines.bollUpper), 2)
  assert.equal(moves(geometry.bollLines.bollMiddle), 3)
  assert.equal(moves(geometry.bollLines.bollLower), 2)
  assert.equal(geometry.bollBands.length, 2, 'A missing candle splits the filled band; a missing middle line does not.')
  for (const path of Object.values(geometry.bollLines)) assert.doesNotMatch(path, /NaN|Infinity/)
})

test('Bollinger filled bands break where either outer line is missing', () => {
  const bars = rows().map((bar, index) => ({ ...bar,
    bollUpper: index === 10 ? null : bar.bollUpper,
    bollLower: index === 45 ? null : bar.bollLower,
  }))
  const geometry = createChartGeometryCache(text => text.length * 6)(bars, viewport)
  assert.equal(geometry.bollBands.length, 3)
  for (const path of geometry.bollBands) assert.doesNotMatch(path, /NaN|Infinity/)
})

test('unplotted EMA values cannot widen the price scale', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  const baseline = get(bars, viewport)
  const extremeEMA = get(bars.map(bar => ({ ...bar, ema: 1_000_000 })), viewport)
  assert.deepEqual(extremeEMA.priceAxis, baseline.priceAxis)
  assert.ok(extremeEMA.bollBands.length > 0)
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
  for (const path of [geometry.upWicks, geometry.downWicks, geometry.upBodies, geometry.downBodies, ...geometry.bollBands]) assert.doesNotMatch(path, /NaN|Infinity/)
  assert.ok(geometry.priceTicks.every(tick => Number.isFinite(tick.y)))
  const empty = broken.map(bar => ({ ...bar, open: NaN }))
  const unavailable = createChartGeometryCache(text => text.length * 6)(empty, viewport)
  assert.equal(unavailable.priceAxis.base, null)
  assert.deepEqual(unavailable.priceTicks, [])
})

test('price scale maps one percent of its reference to 25 CSS pixels', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  for (const height of [240, 700]) for (const base of [100, 150]) {
    const geometry = get(bars, { ...viewport, height, priceScaleBase: base })
    close(geometry.priceY(base) - geometry.priceY(base * 1.01), 25)
    close(geometry.priceY(bars.at(-1)!.close), (geometry.layout.panels.price[0] + geometry.layout.panels.price[1]) / 2)
    assert.equal(get(bars, { ...viewport, height, priceScaleBase: base }), geometry)
  }
})

test('price axis uses one-percent ticks and 25px spacing at every panel height', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  for (const height of [240, 560, 1000]) {
    const geometry = get(bars, { ...viewport, height, priceScaleBase: 100 })
    assert.equal(geometry.priceAxis.step, 1)
    assert.ok(geometry.priceAxis.ticks.every(Number.isInteger))
    const displayed = chartPricePresentation(geometry, 0).ticks
    assert.ok(displayed.some(tick => tick.label.startsWith('+')) && displayed.some(tick => tick.label.startsWith('-')))
    assert.ok(displayed.every((tick, index) => Number.parseFloat(tick.label) === geometry.priceAxis.ticks[index]))
    for (let i = 1; i < geometry.priceTicks.length; i++) {
      close(Math.abs(geometry.priceTicks[i].y - geometry.priceTicks[i - 1].y), 25)
    }
    close(geometry.priceY(100) - geometry.priceY(101), 25)
  }
  const tall = get(bars, { ...viewport, height: 560, priceScaleBase: 100 })
  assert.ok(tall.priceTicks.length > 9, 'A tall price-only panel is not limited to nine labels.')
})

test('price axis includes a tick beyond each panel edge for naturally clipped labels', () => {
  const bars = rows(), get = createChartGeometryCache(text => text.length * 6)
  const geometry = get(bars, { ...viewport, height: 240, priceScaleBase: 100 })
  const [top, bottom] = geometry.layout.panels.price
  const positions = geometry.priceTicks.map(tick => tick.y).sort((a, b) => a - b)
  assert.ok(positions[0] < top && positions[1] >= top)
  assert.ok(positions.at(-1)! > bottom && positions.at(-2)! <= bottom)
  for (let i = 1; i < positions.length; i++) close(positions[i] - positions[i - 1], 25)
})
