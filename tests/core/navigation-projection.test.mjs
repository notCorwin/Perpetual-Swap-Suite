import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finishNavigationFrameProbe } from '../../scripts/instrument-navigation-acceptance.mjs'

async function validateProjection(context, { project = bar => ({ ...bar }), requirePreparedStatistics = true, statisticsState = 'ready', zeroTaker = false } = {}) {
  const fields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
  const bars = Array.from({ length: 96 }, (_, index) => ({ hour: index * 900_000, confirmed: true, indicatorsObserved: true,
    statisticsObserved: true, ...Object.fromEntries(fields.map(field => [field, 100 + index])),
    ...(zeroTaker ? { buy: 0, sell: 0 } : {}) }))
  const snapshot = { instId: 'BTC-USDT-SWAP', timeframe: '15m', bars, indicatorState: 'ready', oiState: statisticsState, takerState: statisticsState }
  const projected = bars.slice(-4).map(project)
  const geometry = { viewport: { bars: projected }, pathData: [],
    oiSamples: projected.filter(bar => Number.isFinite(bar.oi)).length,
    takerBuySamples: projected.filter(bar => bar.buy > 0).length,
    takerSellSamples: projected.filter(bar => bar.sell > 0).length }
  const originals = new Map(['window', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  context.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  globalThis.cancelAnimationFrame = () => {}
  globalThis.window = { __navigationPaintProbe: { active: true, raf: 1, observer: { disconnect() {} },
    requirePreparedStatistics, oracles: new Map([[snapshot.instId, new Map([[snapshot.timeframe,
      { intervalMS: 900_000, bars: new Map(bars.map(bar => [bar.hour, bar])) }]])]]),
    observations: [{ snapshot, geometry }], violations: [], snapshotChanges: 1, rafSamples: 1, minimumBars: 96,
    commits: [], snapshotCaptureMS: 0, snapshotCaptureMaxMS: 0 } }
  return finishNavigationFrameProbe({ evaluate: callback => callback() })
}

test('navigation validates projected statistics independently of the complete canonical snapshot', async context => {
  const report = await validateProjection(context, { project: bar => ({ ...bar, oi: null, buy: null, sell: null }) })
  for (const field of ['oi', 'buy', 'sell']) assert.ok(report.violations.some(value => value.includes(`${field} has the wrong source value`)), field)
  for (const source of ['OI', 'Taker buy', 'Taker sell']) assert.ok(report.violations.some(value => value.startsWith(`${source} geometry was incomplete`)), source)
})

test('navigation rejects projected observation loss and numerically corrupted values', async context => {
  const report = await validateProjection(context, { project: bar => ({ ...bar, statisticsObserved: false, indicatorsObserved: false, close: bar.close + 1, vwap: bar.vwap + 1 }) })
  for (const source of ['OI', 'Taker']) assert.ok(report.violations.some(value => value.includes(`Fixture-known ${source} observation disappeared`)), source)
  assert.ok(report.violations.some(value => value.includes('Fixture-known indicator observation disappeared')))
  for (const field of ['close']) assert.ok(report.violations.some(value => value.includes(`${field} has the wrong source value`)), field)
})

test('observed projected statistics remain checked before full preparation is required', async context => {
  const report = await validateProjection(context, { requirePreparedStatistics: false, project: bar => ({ ...bar, oi: null, buy: null, sell: null }) })
  for (const field of ['oi', 'buy', 'sell']) assert.ok(report.violations.some(value => value.includes(`${field} has the wrong source value`)), field)
})

test('zero taker values require no rectangles while retaining valid observations', async context => {
  const report = await validateProjection(context, { zeroTaker: true })
  assert.deepEqual(report.violations, [])
})
