import assert from 'node:assert/strict'
import test from 'node:test'
import { attachOperationSink } from '../electron/services/operations.js'
import { chartReadyForListing, chartRenderKey, createChartPlotCache, RenderedChartRegistry } from './chart-render.ts'
import type { ReadyChartWindow } from './chart-data.ts'

const step = 900_000
const window = (instId = 'BTC-USDT-SWAP'): ReadyChartWindow => ({
  instId, timeframe: '15m', key: chartRenderKey(instId, '15m'), generation: 1, intervalMS: step, endHour: 95 * step,
  priceState: 'ready', indicatorState: 'ready', oiState: 'ready', takerState: 'ready',
  bars: Array.from({ length: 96 }, (_, index) => ({
    hour: index * step, open: 100, high: 103, low: 99, close: 102, confirmed: true,
    ema: 101, vwap: 101, bollUpper: 104, bollMiddle: 101, bollLower: 98, roc: 1, maroc: 1,
    rsi6: 50, rsi12: 50, rsi24: 50, atrPercent: 2, bbw: 6, oi: 10, buy: 7, sell: 3,
  })),
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

test('list admission waits for price and indicator preparation and settled source panels', () => {
  const frame = window()
  assert.equal(chartReadyForListing(null), false)
  assert.equal(chartReadyForListing(frame), true)
  for (const changes of [{ priceState: 'partial' }, { indicatorState: 'loading' }, { indicatorState: 'error' }, { oiState: 'loading' }, { takerState: 'loading' }] as const) {
    assert.equal(chartReadyForListing({ ...frame, ...changes }), false)
  }
  assert.equal(chartReadyForListing({ ...frame, indicatorState: 'unavailable', oiState: 'unavailable', takerState: 'unavailable' }), true,
    'Unsupported or mathematically undefined values render truthful finished panels.')
})

test('mounted render receipts are scoped to timeframe and expire when the last SVG leaves', () => {
  const registry = new RenderedChartRegistry(), key = chartRenderKey('BTC-USDT-SWAP', '15m')
  const release = registry.register('BTC-USDT-SWAP', '15m'), before = registry.getSnapshot()
  const duplicate = registry.register('BTC-USDT-SWAP', '15m')
  assert.equal(registry.getSnapshot(), before)
  assert.equal(before.has(key), true)
  assert.equal(before.has(chartRenderKey('BTC-USDT-SWAP', '1H')), false)
  release(); release()
  assert.equal(registry.getSnapshot(), before)
  duplicate()
  assert.equal(registry.getSnapshot().has(key), false)
  const remount = registry.register('BTC-USDT-SWAP', '15m')
  duplicate()
  assert.equal(registry.getSnapshot().has(key), true, 'Obsolete cleanup cannot retire a new SVG.')
  remount()
})
