import assert from 'node:assert/strict'
import test from 'node:test'
import { validateStoppedPaintCapture } from '../../scripts/chart-acceptance.mjs'

const curveFields = ['bollUpper', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi']

function fixture(context) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else delete globalThis.window
  })
  const bars = Array.from({ length: 96 }, (_, index) => ({ hour: 100 + index, confirmed: true, priceComplete: true,
    indicatorsObserved: true, statisticsObserved: true, bollMiddle: 1, open: 1, high: 2, low: 0, close: 1, ema: 1, buy: 1, sell: 1,
    ...Object.fromEntries(curveFields.map(field => [field, 1])) }))
  const snapshot = { instId: 'BTC', timeframe: '5m', endHour: 195, intervalMS: 1, generation: 1,
    priceState: 'ready', indicatorState: 'ready', oiState: 'ready', takerState: 'ready' }
  const path = bars.map((_, index) => `${index ? 'L' : 'M'}${index + .5} 1`).join(' ')
  const surface = {
    chart: { instId: 'BTC', label: 'BTC chart', start: 100, end: 195, completedEnd: 195, statisticsEnd: 195,
      requestedEnd: 195, renderedBars: 96, visibleBars: 96, targetBars: 96, barSpacing: 1, loading: 'false',
      oiSamples: 96, takerSamples: 96, candleState: 'ready', indicatorState: 'ready', indicatorInput: null,
      oiState: 'ready', takerState: 'ready', statisticsState: 'ready', incomplete: 'false' },
    svg: { instId: 'BTC', timeframe: '5m', start: 100, end: 195, label: 'BTC 96-candle 5m chart.',
      curves: curveFields.map(() => path), pathData: [path], hasClip: true, clipX: 0, clipWidth: 96,
      plotRight: 96, barWidth: 1, domainStart: 100, domainEnd: 195,
      oiSamples: 96, buySamples: 96, sellSamples: 96, oiState: 'ready', takerState: 'ready' },
  }
  const observation = { at: 1, frame: true, snapshot, bars, surface, phase: 'initial', newPaint: true, pendingWindowIndex: null }
  const probe = { instId: 'BTC', active: false, indicatorValidation: 'fixture', errors: [], observations: [observation],
    quality: [], frames: 1, paints: 1, pendingFrames: 0, minimumBars: 96, pendingWindows: [], commits: [],
    frameGaps: [], validationSamples: [{ at: 1, durationMS: 0 }], frameSamples: [], inputBursts: [], requestCommits: [] }
  globalThis.window = { __chartPaintProbe: probe }
  const series = { '5m': { intervalMS: 1, bars: structuredClone(bars) } }
  return { probe, observation, surface, bars, snapshot, series,
    finish: options => validateStoppedPaintCapture({ series, ...options }) }
}

// These are captured evidence records, not simulated DOM objects. Real
// MutationObserver/RAF capture and immutable retention remain Electron tests.
const corruptions = [
  ['curve corruption', svg => { svg.curves[5] = 'M0,0' }, /rsi12 SVG has 1 points/],
  ['missing curve', svg => { svg.curves[5] = '' }, /lost its rsi12 SVG curve/],
  ['extra sample', svg => { svg.curves[5] += ' L99999 0' }, /rsi12 SVG has 97 points/],
  ['wrong sample position', svg => { svg.curves[5] = svg.curves[5].replace('M0.5 1', 'M99999 0') }, /rsi12 SVG has 96 points/],
  ['nonfinite curve', svg => { svg.curves[5] = 'MNaN 0' }, /Nonfinite SVG geometry/],
  ['clip corruption', svg => { svg.clipWidth = 0 }, /SVG has .* points/],
  ['nonfinite path', svg => { svg.pathData = ['MNaN 0'] }, /Nonfinite SVG geometry/],
  ['range corruption', svg => { svg.start = -1 }, /SVG labels and the drawn range disagree/],
  ['identity corruption', svg => { svg.timeframe = 'wrong' }, /SVG and snapshot timeframes disagree/],
  ['label corruption', svg => { svg.label = 'wrong' }, /Chart labels disagree/],
  ['candle count corruption', (_, chart) => { chart.renderedBars = -1 }, /Chart candle-count metadata disagrees/],
  ['completed range corruption', (_, chart) => { chart.completedEnd = -1 }, /Chart completed-range metadata disagrees/],
  ['price state corruption', (_, chart) => { chart.candleState = 'wrong' }, /Published source states disagree/],
  ['OI state corruption', svg => { svg.oiState = 'wrong' }, /Published source states disagree/],
  ['indicator input corruption', (_, chart) => { chart.indicatorInput = 'wrong' }, /Published source states disagree/],
  ['published count corruption', (_, chart) => { chart.oiSamples = -1 }, /Published statistics sample counts disagree/],
  ['OI count corruption', svg => { svg.oiSamples = -1 }, /actual OI geometry does not cover/],
  ['Taker count corruption', svg => { svg.buySamples = -1 }, /actual Taker buy geometry does not cover/],
]

test('stopped chart observations accept complete geometry and reject active capture', context => {
  const { probe, finish } = fixture(context)
  probe.active = true
  assert.throws(() => finish(), /requires the stopped capture/)
  probe.active = false
  assert.deepEqual(finish().violations, [])
})

for (const [phase, corrupt, expected] of corruptions) test(`stopped chart validation retains ${phase}`, context => {
  const { probe, observation, finish } = fixture(context)
  const bad = structuredClone(observation)
  bad.phase = phase
  corrupt(bad.surface.svg, bad.surface.chart)
  // A repaired later record must not erase an earlier bad observation.
  probe.observations = [bad, observation]
  const report = finish()
  assert.ok(report.violations.some(error => expected.test(error)), JSON.stringify(report.violations))
  assert.equal(report.deferredValidationSamples, 2)
})

test('shared SVG evidence is rechecked against every phase, clip, and bar set', context => {
  const { probe, observation, finish } = fixture(context)
  const invalid = structuredClone(observation.surface.svg)
  invalid.curves[5] = 'M0,0'
  const record = (phase, svg, bars = observation.bars) => ({ ...observation, phase, bars,
    surface: { ...observation.surface, svg } })
  const changedBars = structuredClone(observation.bars)
  changedBars[0].rsi12 = null
  probe.observations = [
    record('first invalid curve', invalid), record('repeated invalid curve', invalid),
    record('changed clip', { ...invalid, clipWidth: 0 }), record('no clip', { ...invalid, hasClip: false }),
    record('changed bars', observation.surface.svg, changedBars),
  ]
  // Independent array-based reference deliberately avoids validator caches.
  const expected = new Set()
  for (const { snapshot, bars, surface, phase } of probe.observations) {
    const svg = surface.svg
    for (const [index, field] of curveFields.entries()) {
      const d = svg.curves[index], samples = bars.filter(bar => Number.isFinite(bar[field])).length
      if (samples > 1 && !d) expected.add(`${phase}: ${snapshot.timeframe} ${snapshot.endHour} lost its ${field} SVG curve with ${samples} known samples.`)
      const xs = [...d.matchAll(/[ML]([\d.e+-]+)[ ,]+([\d.e+-]+)/gi)].map(point => Number(point[1]))
      if (svg.hasClip) {
        const center = hour => svg.plotRight - svg.barWidth / 2 + (hour - svg.domainEnd) / snapshot.intervalMS * surface.chart.barSpacing
        const required = bars.filter(bar => Number.isFinite(bar[field])).map(bar => center(bar.hour))
        const extras = [center(bars[0].hour - snapshot.intervalMS), center(bars.at(-1).hour + snapshot.intervalMS)]
        if (Number(svg.domainStart) === bars[0].hour && Number.isFinite(bars[0][field])) extras.push(Number(svg.clipX))
        const remaining = [...xs]
        const allRequired = required.every(x => { const i = remaining.findIndex(actual => Math.abs(actual - x) <= .06); if (i < 0) return false; remaining.splice(i, 1); return true })
        const validExtras = remaining.every(x => { const i = extras.findIndex(candidate => Math.abs(candidate - x) <= .06); if (i < 0) return false; extras.splice(i, 1); return true })
        if (!allRequired || !validExtras || Math.abs(Number(svg.clipX) + Number(svg.clipWidth) - svg.plotRight) > .1) expected.add(`${phase}: ${snapshot.timeframe} ${snapshot.endHour} ${field} SVG has ${xs.length} points; expected ${samples} visible samples and at most one adjacent sample per side.`)
      } else {
        const points = samples + (bars[0].hour === bars.at(-1).hour - 95 * snapshot.intervalMS && Number.isFinite(bars[0][field]) ? 1 : 0)
        if (xs.length !== points) expected.add(`${phase}: ${snapshot.timeframe} ${snapshot.endHour} ${field} SVG has ${xs.length} points for ${points} known positions.`)
      }
    }
  }
  const report = finish()
  const actual = report.violations.filter(error => / SVG has | lost its .* SVG curve /.test(error)).sort()
  assert.deepEqual(actual, [...expected].sort())
  for (const { phase } of probe.observations) assert.ok(actual.some(error => error.startsWith(`${phase}:`)), phase)
  assert.equal(report.deferredValidationSamples, probe.observations.length)
})

for (const mode of ['retained', 'changed', 'unmarked', 'unproven', 'cross-viewport', 'revisited', 'errored', 'final-ready']) test(`replay indicator presentation ${mode} keeps explicit stale provenance`, context => {
  const state = fixture(context)
  const previous = state.observation
  const bars = state.bars.map(bar => ({ ...bar, indicatorsObserved: mode === 'final-ready' }))
  if (mode === 'changed' || mode === 'final-ready') bars[0].rsi12 = 2
  if (mode === 'unproven') state.probe.observations.length = 0
  if (mode === 'revisited') {
    state.series['1H'] = structuredClone(state.series['5m'])
    state.probe.observations.push({ ...previous, at: 1.5, snapshot: { ...state.snapshot, timeframe: '1H' },
      surface: { ...state.surface, svg: { ...state.surface.svg, timeframe: '1H', label: 'BTC 96-candle 1h chart.' } } })
  }
  if (mode === 'errored') state.probe.observations.push({ ...previous, at: 1.5,
    snapshot: { ...state.snapshot, indicatorState: 'error' },
    surface: { ...state.surface, chart: { ...state.surface.chart, indicatorState: 'error', incomplete: 'true' } } })
  const indicatorState = mode === 'final-ready' ? 'ready' : 'loading'
  state.probe.observations.push({ ...previous, at: 2, bars,
    snapshot: { ...state.snapshot, generation: 2, indicatorState,
      ...(mode === 'cross-viewport' ? { endHour: state.snapshot.endHour - 1 } : {}) },
    surface: { ...state.surface, chart: { ...state.surface.chart, indicatorState,
      indicatorStale: ['unmarked', 'final-ready'].includes(mode) ? 'false' : 'true',
      incomplete: String(mode !== 'final-ready'), loading: String(mode !== 'final-ready') } } })
  const report = state.finish()
  if (mode === 'retained') assert.deepEqual(report.violations, [])
  else assert.ok(report.violations.some(error => mode === 'final-ready' ? /rsi12: expected 1, got 2/.test(error)
    : /Retained indicators|without an observed calculation/.test(error)))
})
