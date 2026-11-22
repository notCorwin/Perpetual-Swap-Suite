import assert from 'node:assert/strict'
import test from 'node:test'
import { attachOperationSink } from '../electron/services/operations.js'
import { createChartIndicatorPresentation, createChartPlotCache } from './chart-render.ts'
import type { ReadyChartWindow } from './chart-data.ts'

const step = 900_000
const window = (instId = 'BTC-USDT-SWAP'): ReadyChartWindow => ({
  instId, timeframe: '15m', key: `15m:${instId}`, generation: 1, intervalMS: step, endHour: 95 * step,
  priceState: 'ready', indicatorState: 'ready', oiState: 'ready', takerState: 'ready',
  bars: Array.from({ length: 96 }, (_, index) => ({
    hour: index * step, open: 100, high: 103, low: 99, close: 102, confirmed: true,
    ema: 101, vwap: 101, bollUpper: 104, bollMiddle: 101, bollLower: 98, roc: 1, maroc: 1,
    rsi6: 50, rsi12: 50, rsi24: 50, atrPercent: 2, bbw: 6, oi: 10, buy: 7, sell: 3,
  })),
})

const loadingWindow = (frame: ReadyChartWindow): ReadyChartWindow => ({ ...frame, generation: frame.generation + 1, indicatorState: 'loading',
  bars: frame.bars.map(bar => ({ ...bar, indicatorsObserved: false, ema: null, vwap: null, bollUpper: null, bollMiddle: null,
    bollLower: null, roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null })),
})

const committedPresentation = () => {
  const cache = createChartIndicatorPresentation()
  return (window: ReadyChartWindow | null) => {
    const result = cache.project(window)
    cache.commit(window)
    return result
  }
}

test('uncommitted render projections cannot replace or invalidate the displayed indicator snapshot', () => {
  const cache = createChartIndicatorPresentation(), frame = window()
  cache.project(frame)
  assert.equal(cache.project(loadingWindow(frame)).stale, false)
  cache.commit(frame)
  cache.project({ ...frame, bars: frame.bars.map(bar => ({ ...bar, vwap: 999 })) })
  cache.project({ ...frame, indicatorState: 'error' })
  cache.project(null)
  const result = cache.project(loadingWindow(frame))
  assert.equal(result.stale, true)
  assert.equal(result.window!.bars[0].vwap, frame.bars[0].vwap)
})

test('indicator replay retains continuous curves while current prices, statistics and source flags update', () => {
  const present = committedPresentation(), plots = createChartPlotCache(text => text.length * 6)
  const frame = window(), size = { width: 960, height: 700 }
  assert.equal(present(frame).window, frame)
  const initial = plots(frame, size)!
  const loading = { ...loadingWindow(frame), bars: loadingWindow(frame).bars.map(bar => ({ ...bar, close: 103, oi: 20 })) }
  const retained = present(loading)
  assert.equal(retained.stale, true)
  assert.equal(retained.window!.indicatorState, 'loading')
  assert.equal(retained.window!.generation, loading.generation)
  assert.equal(retained.window!.bars[0].indicatorsObserved, false)
  assert.equal(retained.window!.bars[0].close, 103)
  assert.equal(retained.window!.bars[0].oi, 20)
  assert.equal(loading.bars[0].vwap, null, 'Presentation must not mutate the invalidated source.')
  const retainedPlot = plots(retained.window, size)!
  assert.equal(retainedPlot.geometry.lines.vwap, initial.geometry.lines.vwap)
  assert.equal(retainedPlot.geometry.lines.rsi6, initial.geometry.lines.rsi6)
  assert.equal(present(loading), retained, 'Repeated renders reuse the same presentation projection.')
  const partial = { ...loading, bars: loading.bars.map((bar, index) => index < 40 ? { ...bar, vwap: 105, indicatorsObserved: true } : bar) }
  assert.deepEqual(present(partial).window!.bars.map(bar => bar.vwap), frame.bars.map(bar => bar.vwap), 'Chunked replay cannot repeatedly reshape the cached curves.')
  const complete = { ...frame, generation: loading.generation, bars: frame.bars.map(bar => ({ ...bar, vwap: 105 })) }
  assert.equal(present(complete).window, complete)
  assert.equal(present(complete).stale, false)
  const secondReplay = present(loadingWindow(complete))
  assert.equal(secondReplay.stale, true)
  assert.equal(secondReplay.window!.bars[0].vwap, 105, 'A second replay uses the latest complete snapshot.')
  const unavailable = { ...loadingWindow(complete), indicatorState: 'unavailable' as const }
  assert.equal(present(unavailable).window!.bars[0].vwap, null, 'Authoritative terminal nulls erase the previous curve.')
})

test('indicator snapshots expire on viewport changes, null, and every terminal result', () => {
  const frame = window()
  for (const changed of [
    { ...loadingWindow(frame), instId: 'ETH-USDT-SWAP' },
    { ...loadingWindow(frame), timeframe: '1H' as const },
    { ...loadingWindow(frame), endHour: frame.endHour - step },
    { ...loadingWindow(frame), windowBars: 192 },
    { ...loadingWindow(frame), bars: frame.bars.slice(1) },
    { ...loadingWindow(frame), bars: frame.bars.map(bar => ({ ...bar, hour: bar.hour + step })) },
    null,
    ...(['unavailable', 'error', 'partial', 'stale'] as const).map(indicatorState => ({ ...loadingWindow(frame), indicatorState })),
  ]) {
    const present = committedPresentation()
    present(frame)
    assert.equal(present(changed).stale, false)
    assert.equal(present(changed).window, changed)
    if (changed?.indicatorState !== 'unavailable') assert.equal(present(loadingWindow(frame)).stale, false)
  }
})

test('forming prices update during replay and a new forming slot cannot inherit old indicators', () => {
  const present = committedPresentation()
  const frame = window(), live = { ...frame.bars.at(-1)!, confirmed: false, hour: 96 * step }
  present({ ...frame, liveBar: live })
  const loading = { ...loadingWindow(frame), liveBar: { ...live, close: 103, vwap: null, indicatorsObserved: false } }
  const result = present(loading)
  assert.equal(result.window!.liveBar!.close, 103)
  assert.equal(result.window!.liveBar!.vwap, live.vwap)
  const next = { ...loading, liveBar: { ...loading.liveBar, hour: 97 * step } }
  assert.equal(present(next).window!.liveBar, next.liveBar)
})

test('selection reuses preconstructed live paths even beyond the geometry LRU capacity', () => {
  const cache = createChartPlotCache(text => text.length * 6), size = { width: 960, height: 700 }
  const windows = Array.from({ length: 90 }, (_, index) => {
    const frame = window(`CONTRACT${index}-USDT-SWAP`)
    return { ...frame, liveBar: { ...frame.bars.at(-1)!, confirmed: false, hour: 96 * step } }
  })
  const plots = windows.map(frame => cache(frame, size))
  const operations: string[] = [], stop = attachOperationSink(event => { operations.push(event.name) })
  try {
    for (const [index, frame] of windows.entries()) {
      assert.equal(cache(frame, size), plots[index])
      assert.equal(plots[index]!.bars.length, 96)
      assert.equal(plots[index]!.bars.at(-1), frame.liveBar)
      assert.equal(cache({ ...frame, realtimeState: 'stale', priceObservedAt: 123 }, size), plots[index],
        'Metadata-only freshness updates reuse merged live bars and geometry.')
    }
    assert.ok(!operations.includes('chart.geometry'), 'Selecting any listed candidate cannot reconstruct geometry.')
  } finally { stop() }
  const changed = { ...windows[0], liveBar: { ...windows[0].liveBar, close: 103 } }
  assert.notEqual(cache(changed, size), plots[0], 'New prices invalidate the prior immutable plot.')
  assert.notEqual(cache(windows[0], { ...size, width: 800 }), plots[0], 'Layout changes prepare correctly sized paths.')
})

test('fractional overscan paths retain the exact 96-bar presentation window', () => {
  const cache = createChartPlotCache(text => text.length * 6), size = { width: 960, height: 700 }
  const frame = window(), baseline = cache(frame, size)!
  const before = { ...frame.bars[0]!, hour: -step }
  const after = { ...frame.bars.at(-1)!, hour: 96 * step }
  const extended = cache(frame, size, { before, after })!
  assert.notEqual(extended, baseline)
  assert.equal(extended.bars, baseline.bars)
  assert.equal(extended.bars.length, 96)
  assert.equal(extended.geometry.x.length, 96)
  assert.equal(extended.geometry.priceAxis.min, baseline.geometry.priceAxis.min)
  assert.equal(extended.geometry.priceAxis.max, baseline.geometry.priceAxis.max)
  const vwapPoints = [...extended.geometry.lines.vwap.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(([, x]) => Number(x))
  assert.equal(vwapPoints.length, 98)
  assert.ok(vwapPoints[0] < extended.geometry.layout.left)
  assert.ok(vwapPoints.at(-1)! > extended.geometry.layout.right)
  assert.equal(cache(frame, size, { before, after }), extended, 'Repeating an unchanged overscan frame reuses its geometry.')
})

test('active candle change reserves label width and reuses unchanged chart inputs', () => {
  const labels: string[] = []
  const cache = createChartPlotCache(text => { labels.push(text); return text.length * 6 })
  const size = { width: 1280, height: 700 }, frame = window()
  const live = { ...frame, liveBar: { ...frame.bars.at(-1)!, confirmed: false, hour: 96 * step } }
  const plot = cache(live, size)!
  const quote = '+2.00%'
  assert.ok(labels.includes(quote), 'The gutter must measure the same candle change as the visible tag.')
  assert.ok(plot.geometry.gutter >= quote.length * 6 + 16)
  labels.length = 0
  assert.equal(cache(live, size), plot)
  assert.equal(labels.length, 0, 'Unchanged inputs must reuse geometry without measuring or rebuilding paths.')
})

test('wide live plots render the expanded time range with matching coordinates', () => {
  const cache = createChartPlotCache(text => text.length * 6), base = window()
  const bars = Array.from({ length: 192 }, (_, index) => ({ ...base.bars[index % 96], hour: index * step }))
  const frame = { ...base, bars, windowBars: 192, endHour: 191 * step,
    liveBar: { ...bars.at(-1)!, confirmed: false, hour: 192 * step } }
  const plot = cache(frame, { width: 2100, height: 700 })!
  assert.equal(plot.bars.length, 192)
  assert.equal(plot.bars[0].hour, step)
  assert.equal(plot.bars.at(-1)!.hour, 192 * step)
  assert.ok(plot.geometry.x[0] >= plot.geometry.layout.left)
  assert.ok(plot.geometry.x.at(-1)! <= plot.geometry.layout.right)
  assert.ok(Math.abs((plot.geometry.x[1] - plot.geometry.x[0]) - plot.geometry.barPitch) < 1e-8)
})


test('pinch projects continuous spans from cached indicators without changing canonical frames', () => {
  const cache = createChartPlotCache(text => text.length * 6), frame = window(), size = { width: 960, height: 700 }
  const canonical = cache(frame, size)!
  const viewport = { count: 42.5, offset: -0.25 }
  const plot = cache(frame, size, {}, undefined, false, viewport)!
  assert.equal(plot.geometry.endHour, 94.75 * step)
  assert.equal(plot.geometry.firstHour, 53.25 * step)
  assert.equal(plot.bars[0], frame.bars[54], 'Reuse the already calculated bar and its indicators.')
  assert.equal(plot.bars.at(-1), frame.bars[94])
  assert.equal(plot.before, frame.bars[53])
  assert.equal(plot.after, frame.bars[95])
  assert.ok(plot.geometry.barPitch > canonical.geometry.barPitch)
  assert.ok(plot.geometry.x.every(x => x >= plot.geometry.layout.left && x <= plot.geometry.layout.right))
  assert.equal(cache(frame, size, {}, undefined, false, viewport), plot, 'Unchanged zoom reuses immutable paths.')
  assert.equal(cache(frame, size), canonical, 'Pinching cannot change canonical candidate windows.')
  assert.equal(frame.bars.length, 96)
})


test('a forming price outside the zoom viewport cannot distort the visible price axis', () => {
  const cache = createChartPlotCache(text => text.length * 6), frame = window(), size = { width: 960, height: 700 }
  const live = { ...frame, liveBar: { ...frame.bars.at(-1)!, hour: 96 * step, close: 1_000_000 } }
  const plot = cache(live, size, {}, undefined, false, { count: 42.5, offset: -2.25 })!
  assert.ok(plot.geometry.priceAxis.max < 1000)
  assert.equal(plot.geometry.liveClose, 102)
})

test('fixed spacing survives resize and changing label gutters while axes use only visible prices', () => {
  const cache = createChartPlotCache(text => text.length * 6), base = window()
  const source = Array.from({ length: 1536 }, (_, index) => ({ ...base.bars[index % 96], hour: index * step,
    ...(index < 100 ? { high: 1_000_000, close: 999_999 } : {}) }))
  const frame = { ...base, bars: source, windowBars: 1536, endHour: 1535 * step }
  for (const spacing of [4, 9.6, 25]) {
    let previousCount = 0
    for (const width of [840, 841, 1290, 2180, 3000]) {
      const plot = cache(frame, { width, height: 700 }, {}, undefined, false, { spacing, offset: -0.25 })!
      assert.equal(plot.geometry.barPitch, spacing)
      assert.equal(plot.geometry.barWidth, spacing * 0.68)
      assert.ok(Math.abs(plot.geometry.x[1] - plot.geometry.x[0] - spacing) < 1e-9)
      assert.ok(plot.geometry.windowBars! > previousCount)
      assert.equal(plot.geometry.endHour, 1534.75 * step)
      assert.ok(plot.geometry.priceAxis.max < 1000, 'Hidden cache prices cannot affect vertical scaling.')
      assert.equal(cache(frame, { width, height: 700 }, {}, undefined, false, { spacing, offset: -0.25 }), plot)
      previousCount = plot.geometry.windowBars!
    }
  }
})

test('visible new highs can widen the price gutter without stretching candle spacing', () => {
  const cache = createChartPlotCache(text => text.length * 6), base = window(), size = { width: 960, height: 700 }
  const viewport = { spacing: 9.6, offset: 0 }
  const normal = cache(base, size, {}, undefined, true, viewport)!
  const changed = { ...base, bars: base.bars.map((bar, index) => index === base.bars.length - 1
    ? { ...bar, high: 9_999_999, close: 9_999_999 } : bar) }
  const expanded = cache(changed, size, {}, undefined, true, viewport)!
  assert.notEqual(expanded.geometry.gutter, normal.geometry.gutter)
  assert.equal(expanded.geometry.barPitch, normal.geometry.barPitch)
  assert.equal(expanded.geometry.barWidth, normal.geometry.barWidth)
  assert.ok(expanded.geometry.priceAxis.max >= 9_999_999)
})

test('fixed percentage scale follows the visible reference during fractional scrolling and reuses matching geometry', async () => {
  const { chartPricePresentation } = await import('./chart-geometry.ts')
  const { chartWheelContentOffset } = await import('./chart-navigation.ts')
  const original = window(), frame = { ...original, bars: original.bars.map((bar, index) => ({ ...bar, open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index })) }
  const plots = createChartPlotCache(text => text.length * 6)
  const size = { width: 400, height: 300 }
  for (const fixedGutter of [undefined, 70]) {
  const viewport = { spacing: 20, offset: 0, fixedGutter }
  const results = [-0.9, -0.4, 0, 0.4, 0.9].map(wheelFraction => {
    const plot = plots(frame, size, {}, null, true, viewport, { mode: 'fixed', pixelsPerPercent: 20, wheelFraction })!
    const offset = chartWheelContentOffset(wheelFraction, plot.geometry.barPitch, Boolean(plot.before), Boolean(plot.after))
    const base = chartPricePresentation(plot.geometry, offset).base!
    assert.ok(base > 0)
    assert.ok(Math.abs(plot.geometry.priceY(base) - plot.geometry.priceY(base * 1.01) - 20) < 1e-8)
    return plot.geometry
  })
  assert.ok(results.some(geometry => geometry !== results[0]))
  const again = plots(frame, size, {}, null, true, viewport, { mode: 'fixed', pixelsPerPercent: 20, wheelFraction: 0.9 })!
  assert.equal(again.geometry, results.at(-1))
  }
})
