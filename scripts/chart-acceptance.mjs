import assert from 'node:assert/strict'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { barsWithIndicators } from '../electron/services/indicators.js'
import { validChartWindowBars } from '../electron/chart-viewport.js'
import { startRendererCPUCounter } from './renderer-cpu-counter.mjs'
import { accountChartIntents, assertColdBoundaryResponsiveness, assertColdBoundaryTiming, assertScrollResponsiveness, assertWarmStatistics, coldBoundaryTiming, collectAcceptanceChecks, summarizeLatencySamples } from './chart-acceptance-metrics.mjs'

// The guarded runtime owns focus isolation. Performance acceptance keeps the
// production rendering configuration instead of forcing software/headless work.
export async function offscreenChartWindow(electron) {
  const state = await electron.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen(),
      headless: app.commandLine.hasSwitch('headless'), disableGPU: app.commandLine.hasSwitch('disable-gpu') }
  })
  assert.deepEqual(state, { visible: false, focused: false, offscreen: true, headless: false, disableGPU: false },
    'Offscreen chart performance acceptance must stay hidden and unfocused with the default Electron rendering configuration.')
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setFrameRate(60))
  return state
}

// A foreground paint budget requires a native foreground window. A hidden
// BrowserWindow can still report document.visibilityState === 'visible' while
// macOS schedules its animation frames at an occluded-window cadence.
export async function foregroundPaintWindow(electron, page) {
  requireForegroundTests()
  const previous = await electron.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const state = { id: window.id, visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized() }
    if (state.minimized) window.restore()
    window.show()
    app.focus({ steal: true })
    window.focus()
    return state
  })
  const restore = () => electron.evaluate(({ BrowserWindow }, previous) => {
    const window = BrowserWindow.fromId(previous.id)
    if (previous.minimized) window.minimize()
    else if (!previous.visible) window.hide()
    else if (!previous.focused) window.blur()
  }, previous)
  try {
    await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), null, { timeout: 5_000 })
    const native = await electron.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id)
      return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized() }
    }, previous.id)
    assert.deepEqual(native, { visible: true, focused: true, minimized: false }, 'Paint latency requires a visible, focused native window.')
    const environment = await electron.evaluate(async ({ app, screen, BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id), display = screen.getDisplayMatching(window.getBounds())
      const gpuInfo = await app.getGPUInfo('basic')
      return { electron: process.versions.electron, chromium: process.versions.chrome, arch: process.arch,
        headless: app.commandLine.hasSwitch('headless'), disableGPU: app.commandLine.hasSwitch('disable-gpu'),
        hardwareAcceleration: app.isHardwareAccelerationEnabled(), gpuFeatureStatus: app.getGPUFeatureStatus(), gpuDevices: gpuInfo.gpuDevice,
        backgroundThrottling: window.webContents.getBackgroundThrottling(), offscreen: window.webContents.isOffscreen(),
        display: { frequency: display.displayFrequency, scaleFactor: display.scaleFactor, size: display.size } }
    }, previous.id)
    assert.equal(environment.headless, false, 'Foreground paint must use the normal Electron compositor.')
    assert.equal(environment.disableGPU, false, 'Foreground paint must use the production GPU configuration.')
    const idleFrameCadenceSamples = await page.evaluate(() => new Promise((resolve, reject) => {
      const startedAt = performance.now(), gaps = []
      let previous = null, raf
      const deadline = setTimeout(() => { cancelAnimationFrame(raf); reject(new Error('Foreground animation frames did not advance within 5 seconds.')) }, 5000)
      const frame = timestamp => {
        if (previous !== null) gaps.push(timestamp - previous)
        previous = timestamp
        if (timestamp - startedAt < 1000) { raf = requestAnimationFrame(frame); return }
        clearTimeout(deadline)
        resolve({ frames: gaps.length, durationMS: timestamp - startedAt, frameGaps: gaps })
      }
      raf = requestAnimationFrame(frame)
    }))
    const cadence = summarizeLatencySamples(idleFrameCadenceSamples.frameGaps)
    const idleFrameCadence = { phase: 'before scenario setup', frames: idleFrameCadenceSamples.frames,
      durationMS: idleFrameCadenceSamples.durationMS, medianMS: cadence.p50MS, p95MS: cadence.p95MS,
      p95SampleCount: cadence.sampleCount, p95SampleMinimum: cadence.p95SampleMinimum, maxMS: cadence.maxMS }
    return { previous, native, environment, idleFrameCadence, restore }
  } catch (error) {
    await restore()
    throw error
  }
}

export async function selectTimeframe(page, timeframe) {
  const index = ['1H', '15m', '5m'].indexOf(timeframe)
  assert.notEqual(index, -1, `Unsupported chart timeframe: ${timeframe}`)
  await page.locator('[data-multi-timeframe-charts] [data-timeframe-panel]').nth(index).waitFor({ state: 'visible' })
  await page.evaluate(({ index, timeframe }) => {
    const charts = [...document.querySelectorAll('[data-multi-timeframe-charts] [data-timeframe-panel]')]
    charts.forEach((chart, position) => chart.toggleAttribute('data-acceptance-target', position === index))
    document.documentElement.dataset.acceptanceTimeframe = timeframe
  }, { index, timeframe })
}

export async function waitForRendered(page, fixture, timeframe = fixture.timeframe, end = fixture.end) {
  try {
    await page.waitForFunction(({ instId, timeframe, end }) => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)
      const svg = chart?.querySelector('svg[data-rendered-inst]')
      return svg?.getAttribute('data-rendered-inst') === instId
        && svg.getAttribute('data-rendered-timeframe') === timeframe
        && Number(chart.getAttribute('data-chart-completed-end') ?? svg.getAttribute('data-rendered-end')) === end
        && Number(chart.getAttribute('data-chart-rendered-bars')) > 0
        && Number(chart.getAttribute('data-chart-rendered-bars')) >= Math.floor(Number(chart.getAttribute('data-chart-visible-bars')))
        && Number(chart.getAttribute('data-chart-target-bars')) >= Number(chart.getAttribute('data-chart-visible-bars'))
        && chart.getAttribute('data-chart-loading') === 'false'
    }, { instId: fixture.instId, timeframe, end }, { timeout: 20_000 })
  } catch (error) {
    const state = await page.locator('[data-acceptance-target] [data-chart-inst]').evaluate(chart => ({
      attributes: Object.fromEntries([...chart.attributes].filter(attribute => attribute.name.startsWith('data-chart-')).map(attribute => [attribute.name, attribute.value])),
      inputs: window.__chartPaintProbe?.inputBursts,
      commits: window.__chartPaintProbe?.commits?.slice(-12),
    }))
    throw new Error(`${error.message}\nExpected ${fixture.instId} ${timeframe} at ${end}. Chart state: ${JSON.stringify(state)}`, { cause: error })
  }
}

// Cold acquisition can present a complete target price window while indicator
// preparation is still pending. This waits for that exact rendered cursor
// without treating the pending flag as a missing price frame.
export async function waitForTargetSnapshot(page, fixture, timeframe, end) {
  await page.waitForFunction(({ instId, timeframe, end }) => {
    const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    return svg?.getAttribute('data-rendered-inst') === instId
      && svg.getAttribute('data-rendered-timeframe') === timeframe
      && Number(svg.getAttribute('data-rendered-end')) === end
      && Number(chart.getAttribute('data-chart-completed-end')) === end
      && Number(chart.getAttribute('data-chart-rendered-bars')) > 0
      && Number(chart.getAttribute('data-chart-rendered-bars')) >= Math.floor(Number(chart.getAttribute('data-chart-visible-bars')))
      && Number(chart.getAttribute('data-chart-rendered-bars')) <= Math.floor(Number(chart.getAttribute('data-chart-visible-bars'))) + 2
      && Number(chart.getAttribute('data-chart-target-bars')) >= Number(chart.getAttribute('data-chart-visible-bars'))
  }, { instId: fixture.instId, timeframe, end }, { timeout: 20_000 })
}

export async function assertWorkspaceLayout(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-layout="market-workspace"]')
    return root && Math.abs(root.getBoundingClientRect().width - innerWidth) < 1
      && Math.abs(root.getBoundingClientRect().height - innerHeight) < 1
  })
  const layout = await page.locator('[data-layout="market-workspace"]').evaluate(root => {
    const rectangle = node => { if (!node) return null; const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
    const overlay = root.querySelector('[data-market-panel]')
    const panels = [...root.querySelectorAll('[data-timeframe-panel]')]
    const chart = root.querySelector('[data-chart-panel]')
    const toolbar = root.querySelector('[data-chart-toolbar]')
    return {
      designWidth: Number(root.dataset.designWidth), scale: Number(root.dataset.uiScale),
      viewport: { width: innerWidth, height: innerHeight }, root: rectangle(root),
      overlay: rectangle(overlay), panels: panels.map(panel => ({ ...rectangle(panel), radius: Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius) })), radius: Number.parseFloat(getComputedStyle(overlay).borderTopLeftRadius),
      list: rectangle(root.querySelector('[data-market-list]')), chart: rectangle(chart),
      toolbar: rectangle(toolbar), title: rectangle(toolbar?.querySelector('[data-chart-title]')),
      toolbarControls: toolbar ? [...toolbar.querySelectorAll('button')].map(rectangle) : [],
      nativeControls: window.radarDesktop.nativeWindowControls,
      documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    }
  })
  assert.equal(layout.designWidth, 1_600)
  assert.equal(layout.scale, 1, `Every window retains normal density: ${JSON.stringify(layout)}`)
  assert.ok(layout.overlay && layout.chart && layout.panels.length === 3, 'The contract list and three chart panels must remain mounted together.')
  assert.ok(layout.overlay.x > 0 && layout.overlay.y > 0, 'The list panel must be inset from the window edges.')
  assert.ok(layout.chart.x === 0 && layout.chart.y === 0 && Math.abs(layout.chart.width - layout.viewport.width) < 1 && Math.abs(layout.chart.height - layout.viewport.height) < 1, 'The workspace must fill the window.')
  const [hour, quarter, five] = layout.panels
  assert.ok(layout.radius > 0 && layout.panels.every(panel => panel.radius === layout.radius), 'All four panels must use the same rounded corners.')
  assert.ok(Math.abs(layout.overlay.y - hour.y) < 1 && layout.overlay.x + layout.overlay.width <= hour.x, 'The list and 1H chart must share the top row.')
  assert.ok(Math.abs(quarter.y - five.y) < 1 && quarter.y >= layout.overlay.y + layout.overlay.height && quarter.x + quarter.width <= five.x, 'The 15m and 5m charts must share the bottom row.')
  assert.ok(Math.abs(quarter.width - five.width) < 2, 'Bottom charts must have equal widths.')
  if (layout.toolbar) {
    assert.ok(layout.toolbar.y === 0 && Math.abs(layout.toolbar.height - 36) < 1, 'The chart toolbar must remain at the top of the window.')
    assert.ok(layout.overlay.y >= layout.toolbar.y + layout.toolbar.height, 'The list must not cover the chart toolbar.')
    const center = layout.toolbar.y + layout.toolbar.height / 2
    assert.ok(layout.toolbarControls.every(control => Math.abs(control.y + control.height / 2 - center) < 1), 'Chart toolbar controls must share the vertical center.')
    if (layout.nativeControls && layout.title) assert.ok(layout.title.x >= 84 - 1, 'The chart title must clear the native window controls.')
  }
  assert.ok(layout.documentWidth <= layout.viewport.width + 1 && layout.documentHeight <= layout.viewport.height + 1, 'The workspace must scroll inside its panels, not the window.')
  return layout
}

export async function assertIndicatorLegends(page) {
  const reading = await page.locator('[data-multi-timeframe-charts] svg[data-rendered-inst]').evaluateAll(charts => charts.map(svg => ({
    timeframe: svg.dataset.renderedTimeframe,
    panels: svg.querySelectorAll('[data-chart-panel-header]').length,
    curves: ['vwap', 'bollUpper', 'bollMiddle', 'bollLower'].map(field => {
      const curve = svg.querySelector(`[data-chart-indicator="${field}"]`)
      return { field, path: curve?.getAttribute('d') ?? '', stroke: curve ? getComputedStyle(curve).stroke : null,
        width: curve ? Number.parseFloat(getComputedStyle(curve).strokeWidth) : null }
    }),
  })))
  assert.deepEqual(reading.map(chart => chart.timeframe), ['1H', '15m', '5m'])
  assert.equal(await page.locator('[data-shared-chart-legend]').count(), 0)
  for (const chart of reading) {
    assert.equal(chart.panels, 0, `${chart.timeframe} should contain only its price chart.`)
    for (const curve of chart.curves) {
      assert.ok(curve.path, `${chart.timeframe} ${curve.field} must have a drawn curve.`)
      assert.equal(curve.width, 1, `${chart.timeframe} ${curve.field} must use a 1 px stroke.`)
      assert.equal(curve.stroke, reading[0].curves.find(first => first.field === curve.field).stroke, `${chart.timeframe} ${curve.field} must use the same color across timeframes.`)
    }
    assert.ok(chart.curves[0].stroke !== chart.curves[1].stroke, `${chart.timeframe} VWAP and BOLL must remain visually distinct.`)
  }
  return reading
}

// Serializable DOM capture; domain assertions run after timing, outside RAF.
export function captureChartViewport(chart) {
  const svg = chart.querySelector('svg[data-rendered-inst]'), snapshot = chart.__chartSnapshot
  return {
    instId: snapshot?.instId, timeframe: snapshot?.timeframe, intervalMS: snapshot?.intervalMS, endHour: snapshot?.endHour,
    visibleBars: Number(chart.dataset.chartVisibleBars), barSpacing: Number(chart.dataset.chartBarSpacing),
    domainStart: Number(svg?.dataset.chartDomainStart), domainEnd: Number(svg?.dataset.chartDomainEnd),
    barWidth: Number(svg?.dataset.chartBarWidth), plotRight: Number(svg?.dataset.chartPlotRight),
    renderedBars: Number(chart.dataset.chartRenderedBars), targetBars: Number(chart.dataset.chartTargetBars),
    chartStart: Number(chart.dataset.chartStart), chartEnd: Number(chart.dataset.chartEnd),
    svgStart: Number(svg?.dataset.renderedStart), svgEnd: Number(svg?.dataset.renderedEnd),
    bars: chart.__chartRenderedBars ?? snapshot?.bars ?? [],
  }
}

// Candle bodies intersect the continuous domain at either edge. Derive slots
// from geometry, independently of the bars supplied by the production store.
export function chartViewportHours({ domainStart, domainEnd, barWidth, barSpacing, intervalMS }) {
  assert.ok([domainStart, domainEnd, barWidth, barSpacing, intervalMS].every(Number.isFinite)
    && domainStart <= domainEnd && barWidth > 0 && barSpacing > 0 && intervalMS > 0, 'Chart domain geometry must be finite and ordered.')
  const padding = barWidth / barSpacing * intervalMS
  const first = Math.floor((domainStart - padding) / intervalMS) + 1
  const last = Math.ceil((domainEnd + padding) / intervalMS) - 1
  assert.ok(last >= first && last - first < 10000, 'Chart domain must contain a bounded native candle range.')
  return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * intervalMS)
}

export function chartViewportX(reading, hour) {
  assert.ok(Number.isFinite(hour) && Number.isFinite(reading.plotRight), 'Candle coordinates require finite geometry.')
  return reading.plotRight - reading.barWidth / 2 + (hour - reading.domainEnd) / reading.intervalMS * reading.barSpacing
}

export function assertChartViewport(reading, { fullSlots = 96, endHour, availableThrough = Infinity } = {}) {
  const expectedHours = chartViewportHours(reading).filter(hour => hour <= availableThrough)
  assert.ok(Number.isFinite(reading.visibleBars) && reading.visibleBars > 0, 'The chart must publish its continuous visible span.')
  if (fullSlots !== null) assert.equal(Math.floor(reading.visibleBars), fullSlots, 'The full-slot workload must match its calibrated viewport.')
  const full = fullSlots ?? Math.floor(reading.visibleBars)
  assert.ok(expectedHours.length >= full && expectedHours.length <= full + 2, 'Only the two edge candles may be partially visible.')
  assert.deepEqual(reading.bars.map(bar => bar.hour), expectedHours, 'The chart must draw every native slot intersecting its independent geometric domain.')
  assert.equal(reading.renderedBars, expectedHours.length)
  assert.ok(reading.targetBars >= expectedHours.length, 'Prepared demand must cover the entire geometric viewport.')
  assert.equal(reading.chartStart, expectedHours[0]); assert.equal(reading.svgStart, expectedHours[0])
  assert.equal(reading.chartEnd, expectedHours.at(-1)); assert.equal(reading.svgEnd, expectedHours.at(-1))
  if (endHour !== undefined) assert.equal(reading.endHour, endHour)
  return { ...reading, expectedHours }
}

export async function assertCompleteChartViewport(page, instId, options) {
  return assertChartViewport(await page.locator(`[data-acceptance-target] [data-chart-inst="${instId}"]`).evaluate(captureChartViewport), options)
}

export async function openChart(page, fixture, timeframe = fixture.timeframe, { liveOverlay = false } = {}) {
  // These timing/oracle fixtures use a fixed 96-candle workload. Responsive
  // width and density coverage belongs to the workspace resize acceptance.
  await page.setViewportSize({ width: 1360, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click({ timeout: 15_000 })
  await selectTimeframe(page, timeframe)
  await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
  await assertWorkspaceLayout(page)
  // Calibrate the viewport from actual drawable width, excluding its measured
  // axis gutter. Keep exactly 96 plotted candles, without changing production
  // spacing or relying on a particular sidebar/font width.
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).evaluate(chart => ({
      span: Number(chart.dataset.chartVisibleBars), spacing: Number(chart.dataset.chartBarSpacing),
      scale: Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale),
    }))
    if (Math.abs(state.span - 96.5) <= .05) break
    const viewport = page.viewportSize()
    await page.setViewportSize({ ...viewport, width: Math.round(viewport.width + (96.5 - state.span) * state.spacing * state.scale) })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  await waitForRendered(page, fixture, timeframe)
  const targetBars = Number(await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).getAttribute('data-chart-target-bars'))
  assert.ok(validChartWindowBars(targetBars), 'The selected chart must publish a supported prepared demand bucket.')
  fixture.currentWindowBars = Math.max(fixture.currentWindowBars ?? 96, targetBars)
  if (!liveOverlay) {
    const count = Number(await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).getAttribute('data-chart-rendered-bars'))
    assert.ok(count >= 96 && count <= 98, `Expected 96 full slots plus partially visible candles; got ${count}.`)
  }
}

// Inspect the actual immutable data passed to Plot and its SVG, rather than
// treating the requested viewport or an aggregate loading flag as a render.
// __chartSnapshot is a reference to the rendered object; it avoids serializing
// 96 full bars into an attribute on every production animation frame.
const paintProbes = new WeakMap()

async function releasePaintProbe(page) {
  await page.evaluate(() => {
    const probe = window.__chartPaintProbe
    // Release retained snapshots even if stopping one resource fails.
    delete window.__chartPaintProbe
    probe?.stop({ capturePending: false })
  })
}

export async function startPaintProbe(page, fixture, { requireMatureData = false, requireWarmStatistics = false, indicatorValidation = 'fixture' } = {}) {
  assert.ok(['fixture', 'finite', 'deferred-canonical'].includes(indicatorValidation), 'Unknown chart indicator validation contract.')
  assert.ok(!paintProbes.has(page), 'The previous paint probe must finish before starting another.')
  if (requireWarmStatistics) {
    const { timeframe, bars } = await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).evaluate(chart => ({
      timeframe: chart.__chartSnapshot?.timeframe,
      bars: (chart.__chartSnapshot?.bars ?? []).map(bar => ({
        hour: bar.hour, oi: bar.oi, buy: bar.buy, sell: bar.sell, oiObserved: bar.oiObserved,
        takerObserved: bar.takerObserved, statisticsObserved: bar.statisticsObserved, statisticsSources: bar.statisticsSources,
      })),
    }))
    assert.ok(fixture.series[timeframe], `The warm chart timeframe ${timeframe} must have a fixture oracle.`)
    assertWarmStatistics(bars, fixture.series[timeframe].bars)
  }
  const cpu = await startRendererCPUCounter(page, { label: fixture.instId })
  try { await page.evaluate(({ instId, series, requireMatureData, requireWarmStatistics, indicatorValidation, cpuMarkerPrefix }) => {
    const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)
    if (!(chart instanceof HTMLElement)) throw new Error('No chart surface to inspect.')
    const expectedTimeframe = chart.__chartSnapshot?.timeframe
    if (!series[expectedTimeframe]) throw new Error('The initial chart needs a known fixture timeframe.')
    const curveFields = ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']
    const probe = {
      instId, expectedTimeframe, series, requireMatureData, requireWarmStatistics, indicatorValidation, priceOnly: true,
      active: true, frames: 0, pendingFrames: 0, paints: 0, minimumBars: Infinity, errors: [],
      frameGaps: [], frameSamples: [], validationSamples: [], inputBursts: [], commits: [], requestCommits: [], pendingWindows: [], previousFrame: null,
      phase: 'initial', quality: [], observations: [],
      cpuMarkerIndex: 0, cpuMarkerCostMS: { samples: 0, totalMS: 0, maxMS: 0 },
      raf: null, observer: null, schedulerObservers: [],
      scheduler: { counts: {}, entries: [], supportedEntryTypes: PerformanceObserver.supportedEntryTypes },
    }
    probe.stop = ({ capturePending = true } = {}) => {
      const failures = [], wasActive = probe.active
      const attempt = operation => { try { operation() } catch (error) { failures.push(error) } }
      if (wasActive && capturePending) attempt(() => probe.capturePending?.())
      probe.active = false
      attempt(() => cancelAnimationFrame(probe.raf))
      attempt(() => probe.observer?.disconnect())
      for (const { observer, record } of probe.schedulerObservers) {
        if (wasActive) attempt(() => record(observer.takeRecords()))
        attempt(() => observer.disconnect())
      }
      if (wasActive && probe.cpuMarkerIndex > 0) attempt(() => probe.markCPU('stop'))
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'), { cause: failures[0] })
    }
    // Initialization owns resources as soon as it starts acquiring them.
    window.__chartPaintProbe = probe
    probe.markCPU = (phase, frame) => {
      const at = performance.now()
      try { console.timeStamp(cpuMarkerPrefix + JSON.stringify({ at, timeOrigin: performance.timeOrigin, phase, index: probe.cpuMarkerIndex++, ...frame })) }
      finally {
        const duration = performance.now() - at
        probe.cpuMarkerCostMS.samples++; probe.cpuMarkerCostMS.totalMS += duration
        probe.cpuMarkerCostMS.maxMS = Math.max(probe.cpuMarkerCostMS.maxMS, duration)
      }
    }
    for (const type of ['longtask', 'long-animation-frame']) if (probe.scheduler.supportedEntryTypes.includes(type)) {
      const record = entries => {
        for (const entry of entries) {
          probe.scheduler.counts[type] = (probe.scheduler.counts[type] ?? 0) + 1
          probe.scheduler.entries.push({ type, startTime: entry.startTime, duration: entry.duration,
            blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: [...(entry.scripts ?? [])].map(script => ({ sourceURL: script.sourceURL, invoker: script.invoker,
              invokerType: script.invokerType, duration: script.duration, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) })
        }
      }
      const observer = new PerformanceObserver(list => record(list.getEntries()))
      observer.observe({ type })
      probe.schedulerObservers.push({ observer, record })
    }

    // The store normally supplies frozen windows and bars. The live plot may
    // use an unfrozen array of frozen bars, and negative fixtures may publish
    // mutable objects. Preserve their observed values without freezing or
    // modifying app data, and share each unchanged immutable capture.
    const barCopies = new WeakMap(), barsCopies = new WeakMap(), snapshotCopies = new WeakMap()
    const nestedSnapshotFields = ['bars', 'liveBar', 'priceStatus', 'oiStatus', 'takerStatus', 'indicatorStatus', 'sourceVersions']
    const retainBar = bar => {
      if (!bar || typeof bar !== 'object' || Object.isFrozen(bar)) return bar
      const previous = barCopies.get(bar), keys = Object.keys(bar)
      if (previous && keys.length === Object.keys(previous).length && keys.every(key => Object.is(bar[key], previous[key]))) return previous
      const retained = Object.freeze({ ...bar })
      barCopies.set(bar, retained)
      return retained
    }
    const retainBars = bars => {
      if (!Array.isArray(bars)) return bars
      const entry = barsCopies.get(bars)
      if (entry?.immutable) return entry.value
      if (!entry && Object.isFrozen(bars) && bars.every(bar => !bar || typeof bar !== 'object' || Object.isFrozen(bar))) {
        barsCopies.set(bars, { immutable: true, value: bars })
        return bars
      }
      const previous = entry?.value
      let next = !previous || previous.length !== bars.length ? [] : null
      for (let index = 0; index < bars.length; index += 1) {
        const bar = retainBar(bars[index])
        if (!next && previous[index] !== bar) next = previous.slice(0, index)
        if (next) next.push(bar)
      }
      if (!next) return previous
      const retained = Object.freeze(next)
      barsCopies.set(bars, { immutable: false, value: retained })
      return retained
    }
    const retainSnapshot = snapshot => {
      if (!snapshot || typeof snapshot !== 'object') return snapshot
      const retainedFields = Object.fromEntries(nestedSnapshotFields.filter(field => Object.hasOwn(snapshot, field)).map(field => [field,
        field === 'bars' ? retainBars(snapshot[field]) : retainBar(snapshot[field])]))
      const keys = Object.keys(snapshot)
      const retainedValue = field => Object.hasOwn(retainedFields, field) ? retainedFields[field] : snapshot[field]
      if (Object.isFrozen(snapshot) && keys.every(field => Object.is(snapshot[field], retainedValue(field)))) return snapshot
      const previous = snapshotCopies.get(snapshot)
      if (previous && keys.length === Object.keys(previous).length && keys.every(field => Object.is(retainedValue(field), previous[field]))) return previous
      const retained = Object.freeze({ ...snapshot, ...retainedFields })
      snapshotCopies.set(snapshot, retained)
      return retained
    }
    const shareRecord = (previous, current) => previous && Object.keys(current).every(key => Object.is(previous[key], current[key]))
      ? previous : Object.freeze(current)
    let lastSurface = null
    const captureSurface = () => {
      const previous = lastSurface
      const status = document.querySelector(`[data-market-status-row] [data-chart-shared-status-item="${expectedTimeframe}"]`)
      const chartState = shareRecord(previous?.chart, {
        instId: chart.dataset.chartInst, label: chart.getAttribute('aria-label'), start: chart.dataset.chartStart, end: chart.dataset.chartEnd,
        completedEnd: chart.dataset.chartCompletedEnd, requestedEnd: chart.dataset.chartRequestedEnd, renderedBars: chart.dataset.chartRenderedBars,
        barSpacing: chart.dataset.chartBarSpacing, targetBars: chart.dataset.chartTargetBars, visibleBars: chart.dataset.chartVisibleBars, loading: chart.dataset.chartLoading, visualStale: chart.dataset.chartVisualStale,
        candleState: chart.dataset.chartCandleState, statisticsState: chart.dataset.chartStatisticsState, statisticsEnd: chart.dataset.chartStatisticsEnd,
        oiState: chart.dataset.chartOiState, takerState: chart.dataset.chartTakerState, incomplete: chart.dataset.chartIncomplete,
        oiSamples: chart.dataset.chartOiSamples, takerSamples: chart.dataset.chartTakerSamples,
        indicatorState: chart.getAttribute('data-chart-indicator-state'), indicatorStale: chart.getAttribute('data-chart-indicator-stale'), indicatorInput: chart.getAttribute('data-chart-indicator-input'), status: status?.textContent ?? '',
      })
      const svg = chart.querySelector('svg[data-rendered-inst]')
      if (!svg) {
        lastSurface = shareRecord(previous, { chart: chartState, svg: null })
        return lastSurface
      }
      const previousSVG = previous?.svg
      let curves = null
      for (let index = 0; index < curveFields.length; index += 1) {
        const d = svg.querySelector(`[data-chart-indicator="${curveFields[index]}"]`)?.getAttribute('d') ?? ''
        if (!curves && (!previousSVG || previousSVG.curves[index] !== d)) curves = previousSVG ? previousSVG.curves.slice(0, index) : []
        if (curves) curves.push(d)
      }
      curves = curves ? Object.freeze(curves) : previousSVG.curves
      const paths = svg.querySelectorAll('path[d]')
      let pathData = previousSVG?.pathData
      let pathsChanged = !pathData || pathData.length !== paths.length
      for (let index = 0; !pathsChanged && index < paths.length; index += 1) pathsChanged = paths[index].getAttribute('d') !== pathData[index]
      if (pathsChanged) {
        pathData = Object.freeze(Array.from(paths, path => path.getAttribute('d')))
      }
      const clipPath = svg.querySelector('[data-chart-wheel-content]')?.parentElement?.getAttribute('clip-path')
      const hash = clipPath?.indexOf('#') ?? -1, close = hash < 0 ? -1 : clipPath.indexOf(')', hash)
      const clipId = hash < 0 ? null : clipPath.slice(hash + 1, close < 0 ? undefined : close)
      const clip = clipId ? svg.querySelector(`[id="${CSS.escape(clipId)}"] rect`) : null
      const oi = svg.querySelector('[data-chart-oi]'), taker = svg.querySelector('[data-chart-taker]')
      const svgState = shareRecord(previousSVG, {
        instId: svg.dataset.renderedInst, timeframe: svg.dataset.renderedTimeframe, start: svg.dataset.renderedStart, end: svg.dataset.renderedEnd,
        label: svg.getAttribute('aria-label'),
        plotRight: svg.dataset.chartPlotRight, barWidth: svg.dataset.chartBarWidth, domainEnd: svg.dataset.chartDomainEnd, domainStart: svg.dataset.chartDomainStart, clipPath, hasClip: Boolean(clip), clipX: clip?.getAttribute('x'), clipWidth: clip?.getAttribute('width'), curves, pathData,
        oi: oi?.getAttribute('data-chart-oi'), oiState: oi?.getAttribute('data-chart-oi-state'), oiSamples: oi?.getAttribute('data-chart-oi-samples'),
        taker: taker?.getAttribute('data-chart-taker'), takerState: taker?.getAttribute('data-chart-taker-state'),
        buySamples: taker?.querySelector('[data-chart-taker-buy-samples]')?.getAttribute('data-chart-taker-buy-samples'),
        sellSamples: taker?.querySelector('[data-chart-taker-sell-samples]')?.getAttribute('data-chart-taker-sell-samples'),
      })
      lastSurface = shareRecord(previous, { chart: chartState, svg: svgState })
      return lastSurface
    }

    let previousSnapshot = null, previousBars = null, previousRetainedSnapshot = null, previousRetainedBars = null
    const sample = (frame, timestamp, sampledAt, dirty) => {
      try {
        if (frame) {
          probe.frames += 1
          probe.firstFrameAt ??= sampledAt
          if (chart.dataset.chartLoading === 'true') probe.pendingFrames += 1
          if (probe.previousFrame !== null) {
            const gapMS = timestamp - probe.previousFrame
            probe.frameGaps.push(gapMS)
            probe.frameSamples.push({ at: sampledAt, rafTimestamp: timestamp, previousRafTimestamp: probe.previousFrame, gapMS })
          }
          probe.previousFrame = timestamp
        }
        // A mutation queued by an earlier RAF callback must not be hidden by
        // reuse of the previous surface. Mutation callbacks capture directly.
        if (frame && probe.observer.takeRecords().length) dirty = true
        const snapshot = chart.__chartSnapshot
        const bars = chart.__chartRenderedBars ?? snapshot?.bars
        const retainedSnapshot = retainSnapshot(snapshot), retainedBars = retainBars(bars)
        const surface = dirty || !lastSurface || snapshot !== previousSnapshot || bars !== previousBars ? captureSurface() : lastSurface
        const loading = surface.chart.loading === 'true'
        let newPaint = false, pendingWindowIndex = null
        if (snapshot && surface.svg) {
          const { timeframe } = retainedSnapshot
          const requestedEnd = Number(surface.chart.requestedEnd)
          if (Number.isFinite(requestedEnd) && requestedEnd > 0) {
            const previous = probe.requestCommits.at(-1)
            if (!previous || previous.end !== requestedEnd || previous.instId !== retainedSnapshot.instId || previous.timeframe !== timeframe) {
              probe.requestCommits.push({ at: sampledAt, rafSampledAt: frame ? sampledAt : null, end: requestedEnd, instId: retainedSnapshot.instId, timeframe })
            } else if (frame && previous.rafSampledAt === null) previous.rafSampledAt = sampledAt
          }
          if (frame && loading && probe.pendingWindows.length < 10) {
            pendingWindowIndex = probe.pendingWindows.length
            probe.pendingWindows.push({ at: sampledAt, end: retainedSnapshot.endHour, requestedEnd: surface.chart.requestedEnd, generation: retainedSnapshot.generation,
              bars: retainedBars?.length, indicatorState: retainedSnapshot.indicatorState, priceState: retainedSnapshot.priceState })
          }
          newPaint = snapshot !== previousSnapshot || bars !== previousBars || retainedSnapshot !== previousRetainedSnapshot || retainedBars !== previousRetainedBars
          if (newPaint) {
            previousSnapshot = snapshot; previousBars = bars
            previousRetainedSnapshot = retainedSnapshot; previousRetainedBars = retainedBars
            probe.paints += 1
            if (Array.isArray(retainedBars)) {
              probe.minimumBars = Math.min(probe.minimumBars, retainedBars.length)
              // A mutation is a React commit; the following RAF samples the DOM.
              // Neither timestamp asserts compositor presentation.
              probe.commits.push({ at: sampledAt, rafSampledAt: frame ? sampledAt : null, end: retainedSnapshot.endHour,
                instId: retainedSnapshot.instId, timeframe, phase: probe.phase })
            }
          } else if (frame && probe.commits.at(-1)?.rafSampledAt === null) probe.commits.at(-1).rafSampledAt = sampledAt
        }
        const observation = { at: sampledAt, frame, snapshot: retainedSnapshot, bars: retainedBars, surface, phase: probe.phase, newPaint, pendingWindowIndex }
        probe.observations.push(observation)
        if (frame) probe.lastFrame = observation
      } catch (error) {
        probe.errors.push(`${probe.phase}: Paint capture failed: ${error?.message ?? String(error)}`)
        probe.observations.push({ at: sampledAt, frame, captureFailure: true })
      } finally {
        // Keep the existing live diagnostics used by intent accounting. These
        // samples now measure synchronous capture, never deferred validation.
        probe.validationSamples.push({ at: sampledAt, durationMS: performance.now() - sampledAt })
      }
    }
    probe.observer = new MutationObserver(() => {
      const sampledAt = performance.now()
      sample(false, sampledAt, sampledAt, true)
    })
    probe.observer.observe(chart, { subtree: true, childList: true, attributes: true, characterData: true })
    const sharedStatus = document.querySelector('[data-market-status-row]')
    if (sharedStatus) probe.observer.observe(sharedStatus, { subtree: true, childList: true, attributes: true, characterData: true })
    const frame = timestamp => {
      const sampledAt = performance.now()
      if (!probe.active) return
      const previousRafTimestamp = probe.previousFrame
      sample(true, timestamp, sampledAt, false)
      probe.markCPU('raf', { rafTimestamp: timestamp, previousRafTimestamp, callbackAt: sampledAt })
      probe.raf = requestAnimationFrame(frame)
    }
    const sampledAt = performance.now()
    sample(false, sampledAt, sampledAt, true)
    probe.raf = requestAnimationFrame(frame)
    // Expose the final pending mutation batch to finish without changing RAF
    // or input timestamps.
    probe.capturePending = () => {
      const sampledAt = performance.now()
      if (probe.observer.takeRecords().length) {
        sample(false, sampledAt, sampledAt, true)
      }
    }
    probe.markCPU('start')
  }, { instId: fixture.instId,
    series: Object.fromEntries(Object.entries(fixture.series).map(([timeframe, entry]) => [timeframe, { intervalMS: entry.intervalMS }])),
    requireMatureData, requireWarmStatistics, indicatorValidation, cpuMarkerPrefix: cpu.markerPrefix }) }
  catch (error) {
    const failures = [error]
    try { await releasePaintProbe(page) } catch (cleanup) { failures.push(cleanup) }
    try { await cpu.stop() } catch (cleanup) { failures.push(cleanup) }
    if (failures.length > 1) throw new AggregateError(failures, failures.map(error => error.message).join('\n'), { cause: error })
    throw error
  }
  paintProbes.set(page, { series: fixture.series, cpu })
}

export async function finishPaintProbe(page, { readyTarget = null, includeRequestCommits = false, includeTimingEvidence = false } = {}) {
  const owner = paintProbes.get(page)
  assert.ok(owner, 'No paint oracle belongs to this page.')
  const oracleSeries = owner.series
  try {
    // Stop capture before transporting any oracle values into the renderer.
    // A full fixture can contain thousands of bars that no observed viewport
    // uses. Keep that archive in Node and send only the retained observations'
    // timestamps after the measured input/RAF phase has ended.
    let observed, captureFailure
    try { observed = await page.evaluate(() => {
      const probe = window.__chartPaintProbe
      if (!probe) throw new Error('No chart paint probe was installed.')
      probe.stop()
      const hours = new Map(), seenBars = new Map()
      for (const { snapshot, bars } of probe.observations) {
        if (!snapshot || !Array.isArray(bars)) continue
        const timeframe = snapshot.timeframe
        if (!hours.has(timeframe)) { hours.set(timeframe, new Set()); seenBars.set(timeframe, new WeakSet()) }
        if (seenBars.get(timeframe).has(bars)) continue
        seenBars.get(timeframe).add(bars)
        for (const bar of bars) if (bar && Number.isFinite(bar.hour)) hours.get(timeframe).add(bar.hour)
      }
      return Object.fromEntries([...hours].map(([timeframe, values]) => [timeframe, [...values]]))
    }) } catch (error) { captureFailure = error }
    let rendererCPU
    try { rendererCPU = await owner.cpu.stop() }
    catch (error) {
      if (captureFailure) throw new AggregateError([captureFailure, error], captureFailure.message, { cause: captureFailure })
      throw error
    }
    if (captureFailure) throw captureFailure
    assert.ok(rendererCPU.complete, `Renderer thread CPU evidence is incomplete: ${JSON.stringify(rendererCPU.captureErrors)}`)
    let fixtureBars = 0, transferredBars = 0
    const series = Object.fromEntries(Object.entries(oracleSeries).map(([timeframe, entry]) => {
      const hours = new Set(observed[timeframe] ?? [])
      const bars = entry.bars.filter(bar => hours.has(bar.hour))
      fixtureBars += entry.bars.length; transferredBars += bars.length
      return [timeframe, { intervalMS: entry.intervalMS, bars }]
    }))
    const paint = await validateStoppedPaintProbe(page, { readyTarget, includeRequestCommits, includeTimingEvidence, series,
      oracleTransfer: { phase: 'after capture stopped', fixtureBars, transferredBars } })
    return { ...paint, rendererCPU }
  } catch (error) {
    try { await releasePaintProbe(page) }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${error.message}\n${cleanup.message}`, { cause: error }) }
    throw error
  } finally { paintProbes.delete(page) }
}

// The measured phase owns capture even when an assertion aborts that phase.
// Finish deferred validation before releasing ownership, retaining both the
// original failure and any paint/cleanup failure rather than poisoning the next test.
export async function withPaintProbe(page, fixture, options, measure) {
  await startPaintProbe(page, fixture, options)
  const failures = []
  let paint
  try { await measure() } catch (error) { failures.push(error) }
  try {
    paint = await finishPaintProbe(page, { includeTimingEvidence: failures.length > 0 })
    if (failures.length) assertCompletePaints(paint)
  } catch (error) { failures.push(error) }
  if (failures.length) {
    const message = failures.map(error => error?.message ?? String(error)).join('\n')
    const phase = paint ? paintPhaseEvidence(paint) : null
    const error = new Error(`${message}\nPaint phase data: ${JSON.stringify(phase)}`,
      { cause: failures.length === 1 ? failures[0] : new AggregateError(failures, message) })
    error.paintPhaseData = phase
    throw error
  }
  return paint
}

// Runs after capture stops; the same immutable observations are validated in
// Electron and in deterministic core regression tests without a browser.
export function validateStoppedPaintCapture({ readyTarget = null, includeRequestCommits = false, includeTimingEvidence = false, series }) {
  const probe = window.__chartPaintProbe
  if (!probe || probe.active) throw new Error('Paint validation requires the stopped capture.')

  const validationStartedAt = performance.now()
  const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
  const indicatorFields = fields.slice(4, -3), statisticFields = ['oi', 'buy', 'sell']
  const curveFields = probe.priceOnly ? ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']
    : ['vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi']
  const { instId, requireMatureData, requireWarmStatistics, indicatorValidation } = probe
  const oracles = Object.fromEntries(Object.entries(series).map(([frame, entry]) => [frame, new Map(entry.bars.map(bar => [bar.hour, bar]))]))
  const expectedGeometry = new WeakMap(), svgGeometry = new WeakMap(), known = new Map(), seenErrors = new Set(probe.errors)
  const fail = message => { if (!seenErrors.has(message)) { seenErrors.add(message); probe.errors.push(message) } }
  // The capture owns immutable SVG records, including curves and clip bounds.
  // Many RAFs share one record: parse each path once, but compare its counts
  // with every observation's bars and report that observation's phase.
  const curveGeometry = (svg, index) => {
    let curves = svgGeometry.get(svg)
    if (!curves) { curves = []; svgGeometry.set(svg, curves) }
    if (curves[index]) return curves[index]
    const left = Number(svg.clipX), right = left + Number(svg.clipWidth)
    let count = 0, inside = 0, before = 0, after = 0, atLeft = false, xs = []
    for (const point of svg.curves[index].matchAll(/[ML]([\d.e+-]+)[ ,]+([\d.e+-]+)/gi)) {
      const x = Number(point[1])
      count += 1
      xs.push(x)
      if (x >= left - .05 && x <= right + .05) { inside += 1; if (Math.abs(x - left) <= .05) atLeft = true }
      if (x < left - .05) before += 1
      if (x > right + .05) after += 1
    }
    return curves[index] = { count, inside, before, after, atLeft, xs }
  }
  let deferredValidationSamples = 0, failedCaptureSamples = 0, readyFrame = null, committedIndicatorViewport = null
  for (const { at, frame, snapshot, bars, surface, phase, newPaint, pendingWindowIndex, captureFailure } of probe.observations) {
    if (captureFailure) { failedCaptureSamples += 1; continue }
    deferredValidationSamples += 1
    try {
      if (pendingWindowIndex !== null) probe.pendingWindows[pendingWindowIndex].observedIndicators = bars?.filter(bar => bar.indicatorsObserved).length
      const chart = surface.chart, svg = surface.svg
      if (!snapshot || !svg) { fail('The current chart SVG disappeared.'); continue }
      const { timeframe } = snapshot
      const viewportKey = `${snapshot.instId}:${timeframe}:${snapshot.intervalMS}:${snapshot.endHour}:${snapshot.windowBars ?? 96}`
      if (committedIndicatorViewport && (committedIndicatorViewport.key !== viewportKey || !Array.isArray(bars)
        || bars.length !== committedIndicatorViewport.bars.length
        || bars.some((bar, index) => bar.hour !== committedIndicatorViewport.bars[index].hour))) committedIndicatorViewport = null
      if (!['loading', 'ready', 'unavailable'].includes(snapshot.indicatorState)) committedIndicatorViewport = null
      const previousIndicators = committedIndicatorViewport?.bars
      const staleIndicators = chart.indicatorStale === 'true'
      if (staleIndicators) {
        if (snapshot.indicatorState !== 'loading' || !previousIndicators || !Array.isArray(bars)
          || bars.length !== previousIndicators.length || bars.some((bar, index) => bar.hour !== previousIndicators[index].hour
            || indicatorFields.some(field => !Object.is(bar[field], previousIndicators[index][field])))) {
          fail(`${phase}: Retained indicators must match the previous committed viewport and explicitly report loading/stale.`)
        }
      } else if (Array.isArray(bars) && bars.every(bar => bar.indicatorsObserved
        || snapshot.indicatorState === 'unavailable' && indicatorFields.every(field => bar[field] === null)) && ['ready', 'unavailable'].includes(snapshot.indicatorState)) {
        committedIndicatorViewport = { key: viewportKey, bars }
      }
      if (readyTarget && !readyFrame && frame && Number.isFinite(at) && at >= readyTarget.afterAt
        && snapshot.instId === readyTarget.instId && timeframe === readyTarget.timeframe && snapshot.endHour === readyTarget.endHour
        && snapshot.intervalMS === readyTarget.intervalMS && chart.indicatorStale !== 'true'
        && Number(chart.requestedEnd) === readyTarget.endHour && Number(chart.completedEnd) === readyTarget.endHour
        && svg.instId === readyTarget.instId && svg.timeframe === readyTarget.timeframe && Number(svg.end) === readyTarget.endHour
        && Array.isArray(bars) && bars.length >= 96 && bars.length <= 98
        && bars.some(bar => bar.hour === readyTarget.endHour)
        && bars.every((bar, index) => (!index || bar.hour - bars[index - 1].hour === readyTarget.intervalMS) && bar.confirmed && bar.priceComplete !== false
          && bar.indicatorsObserved && ['open', 'high', 'low', 'close', ...indicatorFields].every(field => Number.isFinite(bar[field])))) {
        // Retain just this one already-captured frame for the post-timing
        // SQLite oracle. SVG validation below uses the same observation.
        readyFrame = { at, frame: true, snapshot: { ...snapshot, bars: undefined }, bars,
          viewport: { intervalMS: snapshot.intervalMS, endHour: snapshot.endHour,
            visibleBars: Number(chart.visibleBars), barSpacing: Number(chart.barSpacing),
            domainStart: Number(svg.domainStart), domainEnd: Number(svg.domainEnd), barWidth: Number(svg.barWidth), plotRight: Number(svg.plotRight),
            renderedBars: Number(chart.renderedBars), targetBars: Number(chart.targetBars),
            chartStart: Number(chart.start), chartEnd: Number(chart.end), svgStart: Number(svg.start), svgEnd: Number(svg.end) } }
      }
      if (Array.isArray(bars)) {
        // This validator is serialized without module imports. Check the same
        // independent body/domain intersections used by chartViewportHours.
        const padding = Number(svg.barWidth) / Number(chart.barSpacing) * snapshot.intervalMS
        const firstSlot = Math.floor((Number(svg.domainStart) - padding) / snapshot.intervalMS) + 1
        const lastSlot = Math.ceil((Number(svg.domainEnd) + padding) / snapshot.intervalMS) - 1
        if (![firstSlot, lastSlot].every(Number.isFinite) || bars.length !== lastSlot - firstSlot + 1
          || bars.some((bar, index) => bar.hour !== (firstSlot + index) * snapshot.intervalMS)) fail('The rendered bars do not cover every native slot in the geometric viewport.')
        if (Number(chart.renderedBars) !== bars.length || Math.floor(Number(chart.visibleBars)) !== 96 || Number(chart.targetBars) < 96) fail(`Chart candle-count metadata disagrees with the actual snapshot: ${JSON.stringify({ renderedBars: chart.renderedBars, actualBars: bars.length, visibleBars: chart.visibleBars, targetBars: chart.targetBars })}`)
        if (Number(svg.start) !== bars[0]?.hour || Number(svg.end) !== bars.at(-1)?.hour) fail('SVG labels and the drawn range disagree.')
        if (Number(chart.start) !== bars[0]?.hour || Number(chart.end) !== bars.at(-1)?.hour) fail('Header and actual plot refer to different ranges.')
        if (Number(chart.completedEnd) !== snapshot.endHour || Number(chart.statisticsEnd) !== snapshot.endHour) fail('Chart completed-range metadata disagrees with the snapshot.')
        if (chart.label !== `${snapshot.instId} chart` || !svg.label?.startsWith(`${snapshot.instId} ${bars.length}-candle ${String(timeframe ?? '').toLowerCase()} chart.`)) fail('Chart labels disagree with the rendered snapshot.')
        const requestedEnd = Number(chart.requestedEnd)
        if (chart.loading === 'false' && requestedEnd > 0 && requestedEnd !== snapshot.endHour) fail('The chart claims completion for a different requested range.')
        let expected = expectedGeometry.get(bars)
        if (!expected || expected.intervalMS !== snapshot.intervalMS) {
          const firstAtLeft = bars[0]?.hour === bars.at(-1)?.hour - 95 * snapshot.intervalMS
          expected = { intervalMS: snapshot.intervalMS, curves: new Map(curveFields.map(field => {
            const samples = bars.filter(bar => typeof bar[field] === 'number' && Number.isFinite(bar[field])).length
            return [field, { samples, points: samples + (firstAtLeft && Number.isFinite(bars[0]?.[field]) ? 1 : 0) }]
          })) }
          expectedGeometry.set(bars, expected)
        }
        for (let index = 0; index < curveFields.length; index += 1) {
          const field = curveFields[index], d = svg.curves[index]
          const { samples, points: expectedPoints } = expected.curves.get(field)
          if (samples > 1 && !d) fail(`${phase}: ${timeframe} ${snapshot.endHour} lost its ${field} SVG curve with ${samples} known samples.`)
          const coordinates = curveGeometry(svg, index)
          if (svg.hasClip) {
            const padding = expectedPoints > samples && coordinates.atLeft ? 1 : 0
            const pitch = Number(chart.barSpacing), right = Number(svg.plotRight), width = Number(svg.barWidth), end = Number(svg.domainEnd)
            const center = hour => right - width / 2 + (hour - end) / snapshot.intervalMS * pitch
            const required = bars.filter(bar => Number.isFinite(bar[field])).map(bar => center(bar.hour))
            const candidates = [center(bars[0].hour - snapshot.intervalMS), center(bars.at(-1).hour + snapshot.intervalMS)]
            if (Number(svg.domainStart) === bars[0].hour && Number.isFinite(bars[0][field])) candidates.push(Number(svg.clipX))
            const remaining = [...coordinates.xs]
            const take = x => { const i = remaining.findIndex(actual => Math.abs(actual - x) <= .06); if (i < 0) return false; remaining.splice(i, 1); return true }
            const allRequired = required.every(take)
            const validExtras = remaining.every(x => { const i = candidates.findIndex(candidate => Math.abs(candidate - x) <= .06); if (i < 0) return false; candidates.splice(i, 1); return true })
            if (!allRequired || !validExtras || Math.abs(Number(svg.clipX) + Number(svg.clipWidth) - right) > .1) fail(`${phase}: ${timeframe} ${snapshot.endHour} ${field} SVG has ${coordinates.count} points; expected ${samples} visible samples and at most one adjacent sample per side.`)
          } else if (coordinates.count !== expectedPoints) fail(`${phase}: ${timeframe} ${snapshot.endHour} ${field} SVG has ${coordinates.count} points for ${expectedPoints} known positions.`)
          if (/NaN|Infinity|undefined/.test(d)) fail('Nonfinite SVG geometry.')
        }
        if (requireMatureData) {
          for (let index = 0; index < curveFields.length - (probe.priceOnly ? 0 : 1); index += 1) if (!svg.curves[index]) fail(`${phase}: ${timeframe} ${snapshot.endHour} has no ${curveFields[index]} SVG curve for mature local history.`)
          const expectsOI = bars.some(bar => Number.isFinite(oracles[timeframe]?.get(bar.hour)?.oi))
          const expectsTaker = bars.some(bar => Number.isFinite(oracles[timeframe]?.get(bar.hour)?.buy) && Number.isFinite(oracles[timeframe]?.get(bar.hour)?.sell))
          if (!probe.priceOnly && (requireWarmStatistics ? expectsOI : bars.some(bar => bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)))
            && svg.oi !== 'complete') fail(`${phase}: ${timeframe} ${snapshot.endHour} lost complete observed OI geometry.`)
          if (!probe.priceOnly && (requireWarmStatistics ? expectsTaker : bars.some(bar => bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)))
            && svg.taker !== 'complete') fail(`${phase}: ${timeframe} ${snapshot.endHour} lost complete observed Taker geometry.`)
        }
        const oiCount = bars.filter(bar => bar.oi !== null).length
        const takerCount = bars.filter(bar => bar.buy !== null && bar.sell !== null).length
        const buyRectangles = bars.filter(bar => bar.buy !== null && bar.buy > 0).length
        const sellRectangles = bars.filter(bar => bar.sell !== null && bar.sell > 0).length
        if (Number(chart.oiSamples) !== oiCount || Number(chart.takerSamples) !== takerCount) fail('Published statistics sample counts disagree with the actual snapshot.')
        if (!probe.priceOnly && Number(svg.oiSamples) !== oiCount) fail('The actual OI geometry does not cover the snapshot.')
        if (!probe.priceOnly && Number(svg.buySamples) !== buyRectangles) fail('The actual Taker buy geometry does not cover the snapshot.')
        if (!probe.priceOnly && Number(svg.sellSamples) !== sellRectangles) fail('The actual Taker sell geometry does not cover the snapshot.')
      }
      if (snapshot.instId !== instId || chart.instId !== instId || svg.instId !== instId) fail('Mixed instrument in the rendered surface.')
      if (svg.timeframe !== timeframe) fail('SVG and snapshot timeframes disagree.')
      const oiState = snapshot.oiState ?? 'ready', takerState = snapshot.takerState ?? 'ready', priceState = snapshot.priceState ?? 'loading'
      const statisticsState = oiState === 'error' || takerState === 'error' ? 'error' : oiState === 'loading' || takerState === 'loading' ? 'loading'
        : oiState === 'unavailable' || takerState === 'unavailable' ? 'unavailable' : 'ready'
      const incomplete = priceState !== 'ready' || snapshot.indicatorState !== 'ready' || oiState !== 'ready' || takerState !== 'ready'
      if (chart.candleState !== priceState || chart.indicatorState !== (snapshot.indicatorState ?? null)
        || chart.indicatorInput !== (snapshot.indicatorStatus?.inputVersion ?? null)
        || chart.oiState !== oiState || chart.takerState !== takerState || chart.statisticsState !== statisticsState
        || chart.incomplete !== String(incomplete) || !probe.priceOnly && (svg.oiState !== oiState || svg.takerState !== takerState)) fail('Published source states disagree with the snapshot.')
      for (const d of svg.pathData) if (/NaN|Infinity|undefined/.test(d)) fail('Nonfinite SVG geometry.')
      if (!newPaint) continue
      if (!Array.isArray(bars)) { fail('The rendered snapshot has no bars.'); continue }
      probe.quality.push({ phase, end: snapshot.endHour, timeframe, bars: bars.length, indicators: bars.filter(bar => indicatorFields.every(field => Number.isFinite(bar[field]))).length,
        oi: bars.filter(bar => Number.isFinite(bar.oi)).length, taker: bars.filter(bar => Number.isFinite(bar.buy) && Number.isFinite(bar.sell)).length })
      if (bars.length < 96 || bars.length > 98) fail(`Rendered ${bars.length} bars for ${timeframe}; expected 96 full slots plus partially visible candles.`)
      const intervalMS = series[timeframe]?.intervalMS
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index]
        if (!bar.confirmed) continue // Forming values are checked against the live payload, independently of the closed-bar oracle.
        const expected = oracles[timeframe]?.get(bar.hour)
        if (!expected) { fail(`Unexpected ${timeframe} timestamp ${bar.hour}.`); continue }
        if (index && bar.hour - bars[index - 1].hour !== intervalMS) fail(`Noncontiguous ${timeframe} candles at ${bar.hour}.`)
        const key = `${timeframe}:${snapshot.generation}:${bar.hour}`, previous = known.get(key)
        const samePrice = previous && ['open', 'high', 'low', 'close'].every(field => previous[field] === bar[field])
        if (samePrice) for (const field of [...indicatorFields, ...statisticFields]) {
          if (Number.isFinite(previous[field]) && !Number.isFinite(bar[field])) fail(`${phase}: ${key} downgraded previously drawn ${field} from ${previous[field]} to ${bar[field]} without a price change.`)
        }
        known.set(key, { ...bar })
        const expectedOI = Number.isFinite(expected.oi)
        const expectedTaker = Number.isFinite(expected.buy) && Number.isFinite(expected.sell)
        if (requireWarmStatistics && expectedOI && !(bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1))) fail(`${phase}: ${key} has fixture-known OI but it is not observed in the warm-statistics contract.`)
        if (requireWarmStatistics && expectedTaker && !(bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2))) fail(`${phase}: ${key} has fixture-known Taker values but they are not observed in the warm-statistics contract.`)
        if (!bar.indicatorsObserved && !staleIndicators) for (const field of indicatorFields) {
          if (bar[field] !== null) fail(`${phase}: ${key} retained ${field} without an observed calculation for its canonical generation.`)
        }
        for (const field of fields.filter(field => {
          if (['open', 'high', 'low', 'close'].includes(field)) return true
          if (field === 'oi') return (requireWarmStatistics && Number.isFinite(expected.oi))
            || (bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1))
          if (field === 'buy' || field === 'sell') return (requireWarmStatistics && Number.isFinite(expected[field]))
            || (bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2))
          if (staleIndicators) return false
          if (requireMatureData && Number.isFinite(expected[field])) return true
          return bar.indicatorsObserved
        })) {
          const actual = bar[field], wanted = expected[field]
          // A new canonical prefix can legitimately change recursive values and
          // its warmup boundary. Deferred mode checks exact local inputs after
          // replay settles; it never substitutes the unseen provider archive.
          if (indicatorValidation !== 'fixture' && indicatorFields.includes(field)) {
            if (!Number.isFinite(actual) && !(indicatorValidation === 'deferred-canonical' && actual === null)) {
              fail(`${phase}: ${timeframe} ${bar.hour} ${field} retracted to ${actual} during prefix acquisition.`)
            }
            continue
          }
          if (wanted === null) {
            if (actual !== null) fail(`${timeframe} ${bar.hour} ${field}: expected missing, got ${actual}.`)
          } else if (typeof actual !== 'number' || !Number.isFinite(actual)
            || Math.abs(actual - wanted) > Math.max(1, Math.abs(wanted)) * 1e-10) {
            fail(`${timeframe} ${bar.hour} ${field}: expected ${wanted}, got ${actual}.`)
          }
        }
      }
    } catch (error) {
      fail(`${phase}: Paint validation failed: ${error?.message ?? String(error)}`)
    }
  }
  const deferredValidationMS = performance.now() - validationStartedAt
  delete window.__chartPaintProbe
  return {
    frames: probe.frames, pendingFrames: probe.pendingFrames, pendingWindows: probe.pendingWindows, paints: probe.paints, minimumBars: probe.minimumBars,
    violations: probe.errors, commits: probe.commits, quality: probe.quality, scheduler: probe.scheduler,
    frameGaps: probe.frameGaps,
    droppedFrames: probe.frameGaps.filter(gap => gap > 25).length,
    probeValidationSamples: probe.validationSamples.length,
    totalProbeValidationMS: Number(probe.validationSamples.reduce((sum, sample) => sum + sample.durationMS, 0).toFixed(3)),
    validationDurations: probe.validationSamples.map(sample => sample.durationMS),
    deferredValidationSamples, failedCaptureSamples, totalDeferredValidationMS: Number(deferredValidationMS.toFixed(3)),
    cpuMarkerCostMS: probe.cpuMarkerCostMS,
    ...(readyTarget || includeTimingEvidence ? { firstFrameAt: probe.firstFrameAt ?? null, frameSamples: probe.frameSamples, inputBursts: probe.inputBursts,
      observationSamples: probe.observations.map(({ at, frame, phase, captureFailure }) => ({ at, frame, phase, captureFailure: Boolean(captureFailure) })) } : {}),
    ...(readyTarget ? { readyFrame } : {}),
    ...(includeRequestCommits ? { requestCommits: probe.requestCommits } : {}),
    ...(includeTimingEvidence ? { captureTimings: probe.validationSamples } : {}),
  }
}

async function validateStoppedPaintProbe(page, { readyTarget, includeRequestCommits, includeTimingEvidence, series, oracleTransfer }) {
  const report = await page.evaluate(validateStoppedPaintCapture, { readyTarget, includeRequestCommits, includeTimingEvidence, series })
  const frameGaps = summarizeLatencySamples(report.frameGaps)
  const capture = summarizeLatencySamples(report.validationDurations)
  delete report.frameGaps
  delete report.validationDurations
  return { ...report, oracleTransfer, rafSampleCount: report.frames,
    p95FrameGapMS: frameGaps.p95MS, maxFrameGapMS: frameGaps.maxMS,
    p95FrameGapSampleCount: frameGaps.sampleCount, p95FrameGapSampleMinimum: frameGaps.p95SampleMinimum,
    p99FrameGapMS: frameGaps.p99MS, p99FrameGapSampleMinimum: frameGaps.p99SampleMinimum,
    p95ProbeValidationMS: capture.p95MS, maxProbeValidationMS: capture.maxMS,
    p95ProbeValidationSampleMinimum: capture.p95SampleMinimum,
    probeCaptureSamples: report.probeValidationSamples, totalProbeCaptureMS: report.totalProbeValidationMS,
    p95ProbeCaptureMS: capture.p95MS, maxProbeCaptureMS: capture.maxMS }
}

export function assertCompletePaints(report) {
  assert.ok(report.frames > 0, 'The acceptance probe must observe renderer animation frames.')
  assert.ok(report.paints > 0, 'The acceptance probe must inspect the real rendered snapshot.')
  assert.ok(report.minimumBars >= 96 && report.minimumBars <= 98, 'Every observed window must contain its complete candle range.')
  assert.deepEqual(report.violations, [], 'A rendered window was incomplete, mixed, or mathematically incorrect.')
}

// Keep only timing and validation metadata in failure evidence. The retained
// bars and SVG paths are checked inside finishPaintProbe and are not serialized
// once per observation.
function paintPhaseEvidence(paint) {
  return { frames: paint.frames, pendingFrames: paint.pendingFrames, pendingWindows: paint.pendingWindows,
    paints: paint.paints, minimumBars: paint.minimumBars, violations: paint.violations,
    deferredValidationSamples: paint.deferredValidationSamples, failedCaptureSamples: paint.failedCaptureSamples,
    totalDeferredValidationMS: paint.totalDeferredValidationMS, probeCaptureSamples: paint.probeCaptureSamples,
    totalProbeCaptureMS: paint.totalProbeCaptureMS, maxProbeCaptureMS: paint.maxProbeCaptureMS, scheduler: paint.scheduler,
    firstFrameAt: paint.firstFrameAt, inputBursts: paint.inputBursts, commits: paint.commits,
    requestCommits: paint.requestCommits, frameSamples: paint.frameSamples, captureTimings: paint.captureTimings,
    observationSamples: paint.observationSamples, oracleTransfer: paint.oracleTransfer,
    rendererCPU: { complete: paint.rendererCPU.complete, sampleCount: paint.rendererCPU.sampleCount,
      droppedSamples: paint.rendererCPU.droppedSamples, captureErrors: paint.rendererCPU.captureErrors,
      artifact: paint.rendererCPU.artifact }, cpuMarkerCostMS: paint.cpuMarkerCostMS }
}

function prefetchPerformanceChecks(latency) {
  return [
    ['100 ms input and RAF budgets', () => assertScrollResponsiveness(latency)],
    ['100 ms maximum raw input latency', () => assert.ok(latency.maxInputToRafSampleMS < 100,
      `A wheel intent took ${latency.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target.`)],
  ]
}

export async function wheelBurst(page, { frames = 1, eventsPerFrame = 1, deltaY = 12, deltaX = 0, deltaMode = 0 }) {
  return page.evaluate(async options => {
    const plot = document.querySelector('[data-acceptance-target] [data-chart-plot]') ?? document.querySelector('[data-chart-plot]')
    if (!(plot instanceof HTMLElement)) throw new Error('The chart plot is unavailable.')
    const inputs = []
    for (let frame = 0; frame < options.frames; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      let firstAt, lastAt
      for (let event = 0; event < options.eventsPerFrame; event += 1) {
        const input = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: options.deltaY, deltaX: options.deltaX, deltaMode: options.deltaMode })
        lastAt = performance.now()
        firstAt ??= lastAt
        plot.dispatchEvent(input)
      }
      inputs.push(lastAt)
      window.__chartPaintProbe?.inputBursts.push({ firstAt, lastAt, events: options.eventsPerFrame })
    }
    return inputs
  }, { frames, eventsPerFrame, deltaY, deltaX, deltaMode })
}

export async function measureChartIntentLatency(page, { inputs, targets, requireForeground = true, milestone = 'rendered-window', enforceBudgets = true }) {
  assert.ok(['rendered-window', 'requested-cursor'].includes(milestone), 'Unknown chart intent acknowledgment milestone.')
  const commitKey = milestone === 'requested-cursor' ? 'requestCommits' : 'commits'
  const latestInput = inputs.at(-1)
  const expectedEnd = targets.at(-1)
  await page.waitForFunction(({ latestInput, expectedEnd, commitKey }) => window.__chartPaintProbe?.[commitKey].some(commit =>
    commit.end === expectedEnd && commit.instId === window.__chartPaintProbe.instId
    && commit.timeframe === window.__chartPaintProbe.expectedTimeframe
    && commit.at >= latestInput && commit.rafSampledAt !== null), { latestInput, expectedEnd, commitKey })
  const observation = await page.evaluate(({ inputs, targets, requireForeground, commitKey }) => {
    const visibility = document.visibilityState, focused = document.hasFocus()
    if (requireForeground && (visibility !== 'visible' || !focused)) {
      throw new Error(`Foreground renderer timing lost its visible, focused window: ${JSON.stringify({ visibility, focused })}.`)
    }
    const probe = window.__chartPaintProbe, commits = probe[commitKey]
    for (const { observer, record } of probe.schedulerObservers) record(observer.takeRecords())
    const bursts = inputs.map(input => probe.inputBursts.find(burst => burst.lastAt === input))
    if (bursts.some(burst => !burst)) throw new Error('Every measured wheel burst must include its first and final input timestamps.')
    const latestBurst = bursts.at(-1), startedAt = bursts[0].firstAt
    return {
      visibility, focused, rendererTimeOrigin: performance.timeOrigin,
      commits, instId: probe.instId, timeframe: probe.expectedTimeframe,
      scheduler: probe.scheduler.entries.filter(entry => entry.startTime + entry.duration >= startedAt),
      bursts, inputs, targets, startedAt,
      frameSamples: probe.frameSamples.filter(sample => sample.at >= startedAt),
      validationSamples: probe.validationSamples.filter(sample => sample.at >= startedAt),
    }
  }, { inputs, targets, requireForeground, commitKey })
  const accounted = accountChartIntents(inputs.map((at, index) => ({ at, target: targets[index], instId: observation.instId, timeframe: observation.timeframe })), observation.commits)
  const latest = accounted.at(-1)
  if (!latest?.commit) throw new Error(`The latest chart intent ${targets.at(-1)} has no renderer RAF sample.`)
  const endAt = latest.commit.rafSampledAt
  assert.ok(observation.commits.filter(commit => commit.at >= observation.startedAt && commit.at <= endAt)
    .every(commit => commit.instId === observation.instId && commit.timeframe === observation.timeframe),
  'A scroll gesture committed an unintended instrument or timeframe.')
  const frameGaps = observation.frameSamples.filter(sample => sample.at <= endAt).map(sample => sample.gapMS)
  const validation = observation.validationSamples.filter(sample => sample.at <= endAt).map(sample => sample.durationMS)
  const latencies = accounted.filter(intent => intent.commit).map(intent => intent.latencyMS)
  const latencySummary = summarizeLatencySamples(latencies)
  const frameSummary = summarizeLatencySamples(frameGaps)
  const validationSummary = summarizeLatencySamples(validation)
  const latestBurst = observation.bursts.at(-1)
  const startedAt = observation.startedAt
  if (accounted.some(intent => intent.commit?.rafSampledAt > endAt)) throw new Error('The gesture report contains a chart sample after the latest target.')
  const report = {
      milestone,
      documentVisibility: observation.visibility, documentFocused: observation.focused, rendererTimeOrigin: observation.rendererTimeOrigin,
      scheduler: observation.scheduler.filter(entry => entry.startTime <= endAt),
      committedInputs: accounted.filter(intent => intent.status === 'committed').length,
      supersededInputs: accounted.filter(intent => intent.status === 'coalesced').length,
      unaccountedInputs: accounted.filter(intent => intent.status === 'unaccounted').map(({ index, target }) => ({ index, target })),
      intents: accounted.map(({ index, target, status, supersededBy, commit, latencyMS }) => ({ index, inputAt: inputs[index], target, status, supersededBy,
        commitAt: commit?.at ?? null, rafSampledAt: commit?.rafSampledAt ?? null, committedTarget: commit?.end ?? null, latencyMS })),
      intentLatenciesMS: latencies.map(value => Number(value.toFixed(3))),
      p50InputToRafSampleMS: latencySummary.p50MS,
      p95InputToRafSampleMS: latencySummary.p95MS,
      p95InputToRafSampleCount: latencySummary.sampleCount,
      p95InputToRafSampleMinimum: latencySummary.p95SampleMinimum,
      p99InputToRafSampleMS: latencySummary.p99MS,
      p99InputToRafSampleMinimum: latencySummary.p99SampleMinimum,
      maxInputToRafSampleMS: latencySummary.maxMS,
      latestInputToRafSampleMS: Number(latest.latencyMS.toFixed(3)),
      latestInputToCommitMS: Number((latest.commit.at - inputs.at(-1)).toFixed(3)),
      latestCommitToRafSampleMS: Number((endAt - latest.commit.at).toFixed(3)),
      latestBurstStartToRafSampleMS: Number((endAt - latestBurst.firstAt).toFixed(3)),
      latestBurstStartToCommitMS: Number((latest.commit.at - latestBurst.firstAt).toFixed(3)),
      latestBurstDispatchMS: Number((latestBurst.lastAt - latestBurst.firstAt).toFixed(3)),
      latestBurstEvents: latestBurst.events,
      maxBurstDispatchMS: Number(Math.max(0, ...observation.bursts.map(burst => burst.lastAt - burst.firstAt)).toFixed(3)),
      p95FrameGapMS: frameSummary.p95MS, p95FrameGapSampleCount: frameSummary.sampleCount,
      p95FrameGapSampleMinimum: frameSummary.p95SampleMinimum, p99FrameGapMS: frameSummary.p99MS,
      p99FrameGapSampleMinimum: frameSummary.p99SampleMinimum, maxFrameGapMS: frameSummary.maxMS,
      probeValidationSamples: validation.length,
      totalProbeValidationMS: Number(validation.reduce((sum, duration) => sum + duration, 0).toFixed(3)),
      p95ProbeValidationMS: validationSummary.p95MS, p95ProbeValidationSampleMinimum: validationSummary.p95SampleMinimum,
      maxProbeValidationMS: validationSummary.maxMS,
      probeMeasurement: 'Synchronous state capture; correctness validation runs after input timing.',
      probeCaptureSamples: validation.length,
      totalProbeCaptureMS: Number(validation.reduce((sum, duration) => sum + duration, 0).toFixed(3)),
      p95ProbeCaptureMS: validationSummary.p95MS, maxProbeCaptureMS: validationSummary.maxMS,
  }
  if (report.unaccountedInputs.length) {
    throw new Error(`Chart intents disappeared without a committed target or coalescing successor: ${JSON.stringify(report.unaccountedInputs)}`)
  }
  if (requireForeground && enforceBudgets) {
    try { assertScrollResponsiveness(report) }
    catch (error) { throw new Error(`${error.message}\nScroll timing: ${JSON.stringify(report)}`, { cause: error }) }
  }
  return report
}

export async function waitForLocalHistory(electron, page, fixture, timeframe = fixture.timeframe, { requireIndicators = false } = {}) {
  const intervalMS = fixture.series[timeframe].intervalMS, warmEnd = fixture.end - intervalMS
  const geometry = await page.locator('[data-acceptance-target] [data-chart-inst]').evaluate(chart => ({
    edge: Number(chart.dataset.chartTimeEnd), spacing: Number(chart.dataset.chartBarSpacing),
  }))
  assert.ok(Number.isFinite(geometry.edge) && Number.isFinite(geometry.spacing) && geometry.spacing > 0)
  // The shared edge starts after the latest candle and follows physical candle
  // width; a fixed 12 px gesture does not necessarily enter history.
  const warmEdge = warmEnd + intervalMS / 2
  const distance = (geometry.edge - warmEdge) / intervalMS * geometry.spacing
  assert.ok(distance > 0, 'The warm target must be behind the initial shared edge.')
  await wheelBurst(page, { deltaY: distance })
  const deadline = Date.now() + 20_000
  let resident = 0, historyFrame
  const calculatedReserve = () => historyFrame && historyFrame.bars >= resident && historyFrame.calculated === historyFrame.bars
    && historyFrame.first <= warmEnd - 95 * intervalMS && historyFrame.end >= warmEnd
  while (Date.now() < deadline) {
    const requests = await readRequestProbe(electron)
    resident = requests.historyResponses.filter(response => response.timeframe === timeframe).at(-1)?.bars ?? 0
    historyFrame = requests.historyFrames[timeframe]
    if (resident > 96 && (!requireIndicators || calculatedReserve())) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(resident > 96 && resident <= 1536, `History hydration must return a bounded price reserve: ${resident}`)
  if (requireIndicators) {
    assert.ok(calculatedReserve(), `The resident ${timeframe} reserve must finish canonical indicator preparation: ${JSON.stringify(historyFrame)}`)
    // Keep the historical target active until both the calculated reserve and
    // its real viewport are ready. Returning to latest clears history publishing.
    await page.waitForFunction(({ instId, timeframe, end }) => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`), snapshot = chart?.__chartSnapshot
      const bars = chart?.__chartRenderedBars ?? snapshot?.bars
      const fields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
      return snapshot?.instId === instId && snapshot.timeframe === timeframe && snapshot.endHour === end
        && snapshot.indicatorState === 'ready' && chart.dataset.chartLoading === 'false'
        && Math.floor(Number(chart.dataset.chartVisibleBars)) === 96 && bars?.length >= 96 && bars.length <= 98
        && bars.every(bar => bar.indicatorsObserved && fields.every(field => Number.isFinite(bar[field])))
    }, { instId: fixture.instId, timeframe, end: warmEnd }, { timeout: Math.max(1, deadline - Date.now()) })
  }
  await page.evaluate(async () => { for (let frame = 0; frame < 2; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
  await assertCompleteChartViewport(page, fixture.instId, { endHour: warmEnd })
  // Go past the original edge to resume the shared live-follow state.
  await wheelBurst(page, { deltaY: -distance - geometry.spacing })
  await waitForRendered(page, fixture, timeframe)
  await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.end, availableThrough: fixture.end })
  return resident
}

export function separateSourceMaintenance(sourceRequests, fixture) {
  const historical = [], historicalExtensions = [], currentMaintenance = []
  const observedWindowBars = fixture.currentWindowBars ?? 96
  const currentWindowBars = validChartWindowBars(observedWindowBars) ? observedWindowBars : 96
  for (const request of sourceRequests) {
    const parameters = request.parameters ?? {}
    const after = Number(parameters.after), limit = Number(parameters.limit)
    const intervalMS = fixture.series[parameters.bar]?.intervalMS
    const latestCandles = request.path === '/market/candles' && limit === 2 && Number.isFinite(intervalMS)
      && parameters.after == null && parameters.before == null
    // Ranking and selected-chart repairs request at most one current viewport.
    // Exclude them only when every possible returned slot is later than the
    // fixture. An overlapping, unbounded or ambiguous cursor still fails.
    const currentCandles = request.path === '/market/history-candles' && Number.isSafeInteger(limit) && limit > 0 && limit <= currentWindowBars
      && Number.isFinite(intervalMS) && intervalMS > 0 && Number.isSafeInteger(after) && after % intervalMS === 0
      && parameters.before == null && after - limit * intervalMS > fixture.end
    const begin = Number(parameters.begin), end = Number(parameters.end)
    const statisticsRequest = ['/rubik/stat/contracts/open-interest-history', '/rubik/stat/taker-volume-contract'].includes(request.path)
    const currentRange = statisticsRequest && Number.isFinite(fixture.series[parameters.period]?.intervalMS)
      && Number.isSafeInteger(begin) && Number.isSafeInteger(end) && end >= begin && begin > fixture.end
    const candleStart = fixture.series[parameters.bar]?.bars?.[0]?.hour
    const statisticsStart = fixture.series[parameters.period]?.bars?.[0]?.hour
    // Candle `after` and both statistics boundaries are exclusive (see
    // MarketHistory.fetchPrices/fetchStatistics), so equality with the first
    // persisted source period still proves a wholly older request.
    const olderCandles = request.path === '/market/history-candles' && Number.isFinite(after)
      && Number.isFinite(candleStart) && after <= candleStart && Number.isFinite(limit) && limit > 0
    const olderStatistics = statisticsRequest
      && Number.isFinite(begin) && Number.isFinite(end) && end >= begin
      && Number.isFinite(statisticsStart) && end <= statisticsStart
    if (latestCandles || currentCandles || currentRange) currentMaintenance.push(request)
    else if (olderCandles || olderStatistics) historicalExtensions.push(request)
    else historical.push(request)
  }
  // Unknown paths, unbounded requests, and ambiguous ranges remain subject to
  // the strict no-history-download assertion.
  return { historical, historicalExtensions, currentMaintenance }
}

export async function installRequestProbe(electron, instId, { holdHistorical = false, initialHistoryBars = null, historicalDelayMS = 0 } = {}) {
  await electron.evaluate(async ({ ipcMain, BrowserWindow }, { instId, holdHistorical, initialHistoryBars, historicalDelayMS }) => {
    const { encodeChartWire, decodeChartWire } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/chart-wire.js')
    const original = ipcMain._invokeHandlers.get('radar:request')
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const originalSend = contents.send
    await globalThis.__marketBackend.probe({ action: 'sourceInstall', instId })
    const probe = {
      original, contents, originalSend, calls: [], active: 0, maxActive: 0, focusCalls: [], legacyWindowCalls: 0,
      historicalActive: 0, maxHistoricalActive: 0, localActive: 0, maxLocalActive: 0,
      historyCalls: [], historyResponses: [], historyFrames: new Map(), transferredHistoryBars: 0,
      preparedPushes: 0, preparedPushBars: 0, fullHistoryPushes: 0, fullHistoryPushBars: 0,
      historyPushSamples: new Map(), fullHistoryPushShapes: new Map(), sourceBaseline: 0,
      holdHistorical, holdLocal: false, held: false, heldCall: null, heldSettled: false, callsAtHold: null, release: null,
      extendHistory: initialHistoryBars === null, deliveredFloors: new Map(), delayFloors: new Map(), extensions: [], pendingPushes: new Map(), timers: new Set(), closed: false,
    }
    const rememberHistory = response => {
      if (response?.instId !== instId || !['5m', '15m', '1H'].includes(response.timeframe) || !Array.isArray(response.bars) || response.bars.length <= (response.windowBars ?? 96)) return
      const previous = probe.historyFrames.get(response.timeframe)
      if (previous && (previous.generation > response.generation || previous.generation === response.generation && previous.revision > response.revision)) return
      probe.historyFrames.set(response.timeframe, {
        bars: response.bars.length, calculated: response.bars.filter(bar => bar.indicatorsObserved).length,
        first: response.bars[0].hour, end: response.bars.at(-1).hour, endHour: response.endHour,
        generation: response.generation, revision: response.revision,
      })
    }
    const floor = response => {
      if (response?.instId !== instId || !Array.isArray(response.bars)) return null
      if (probe.deliveredFloors.has(response.timeframe)) return probe.deliveredFloors.get(response.timeframe)
      if (!Number.isSafeInteger(initialHistoryBars)) return null
      if (!probe.deliveredFloors.has(response.timeframe)) probe.deliveredFloors.set(response.timeframe, response.latestEnd - (initialHistoryBars - 1) * response.intervalMS)
      return probe.deliveredFloors.get(response.timeframe)
    }
    const clip = response => {
      const first = floor(response)
      if (first === null) return response
      const bars = response.bars.filter(bar => bar.hour >= first)
      return bars.length === response.bars.length ? response : { ...response, bars }
    }
    const extension = (response, kind, startedAt, readCompletedAt = Date.now()) => {
      const previousFloor = floor(response)
      if (!probe.extendHistory || previousFloor === null || !response.bars.length) return null
      if (!probe.delayFloors.has(response.timeframe)) probe.delayFloors.set(response.timeframe, previousFloor)
      const delayFloor = probe.delayFloors.get(response.timeframe)
      if (response.bars[0].hour >= delayFloor) return null
      const record = { kind, instId: response.instId, timeframe: response.timeframe, endHour: response.endHour,
        startedAt, readCompletedAt, completedAt: null, previousFloor, first: response.bars[0].hour, end: response.bars.at(-1).hour, bars: response.bars.length,
        generation: response.generation, revision: response.revision, sourceVersions: response.sourceVersions && { ...response.sourceVersions } }
      probe.extensions.push(record)
      return record
    }
    const delivered = (response, record) => {
      if (record) {
        probe.deliveredFloors.set(response.timeframe, Math.min(probe.deliveredFloors.get(response.timeframe), response.bars[0].hour))
        Object.assign(record, { completedAt: Date.now(), first: response.bars[0].hour, end: response.bars.at(-1).hour, bars: response.bars.length,
          endHour: response.endHour, generation: response.generation, revision: response.revision,
          sourceVersions: response.sourceVersions && { ...response.sourceVersions } })
      }
      const result = clip(response)
      rememberHistory(result)
      return result
    }
    // Timers can fire just before their requested deadline. Check both the
    // monotonic interval and the wall-clock timestamps used by the evidence.
    const remainingDelay = (record, deadline) => Math.max(deadline - performance.now(), record.readCompletedAt + historicalDelayMS - Date.now())
    const waitForDelay = record => new Promise(resolve => {
      const deadline = performance.now() + historicalDelayMS
      const check = () => {
        const remaining = remainingDelay(record, deadline)
        if (remaining > 0) setTimeout(check, Math.ceil(remaining))
        else resolve()
      }
      check()
    })
    contents.send = function (channel, ...args) {
      if (channel !== 'radar:chart-prepared') return originalSend.call(this, channel, ...args)
      const response = decodeChartWire(args[0])
      if (response?.instId === instId && Array.isArray(response.bars)) {
        probe.preparedPushes += 1
        probe.preparedPushBars += response.bars.length
        if (response.bars.length > (response.windowBars ?? 96)) {
          probe.fullHistoryPushes += 1
          probe.fullHistoryPushBars += response.bars.length
          const shape = [response.timeframe, response.generation, response.revision, response.endHour,
            response.bars[0]?.hour, response.bars.at(-1)?.hour, response.bars.length].join(':')
          probe.fullHistoryPushShapes.set(shape, (probe.fullHistoryPushShapes.get(shape) ?? 0) + 1)
          const sample = probe.historyPushSamples.get(response.timeframe) ?? { first: response, last: null, count: 0 }
          sample.count += 1
          if (sample.count > 1) sample.last = response
          probe.historyPushSamples.set(response.timeframe, sample)
        }
      }
      const record = extension(response, 'push', Date.now())
      if (record && historicalDelayMS > 0) {
        const pending = probe.pendingPushes.get(response.timeframe)
        const entry = pending ?? { args, response, record, timer: null }
        if (pending) {
          clearTimeout(entry.timer); probe.timers.delete(entry.timer)
          entry.args = args
          entry.response = response
          entry.record.readCompletedAt = record.readCompletedAt
          probe.extensions.pop()
        }
        probe.pendingPushes.set(response.timeframe, entry)
        const deadline = performance.now() + historicalDelayMS
        const deliver = () => {
          probe.timers.delete(entry.timer)
          if (probe.closed) return
          const remaining = remainingDelay(entry.record, deadline)
          if (remaining > 0) {
            entry.timer = setTimeout(deliver, Math.ceil(remaining))
            probe.timers.add(entry.timer)
            return
          }
          probe.pendingPushes.delete(response.timeframe)
          const result = delivered(entry.response, entry.record)
          if (result !== entry.response) entry.args[0] = encodeChartWire(result)
          originalSend.call(contents, channel, ...entry.args)
        }
        entry.timer = setTimeout(deliver, historicalDelayMS)
        probe.timers.add(entry.timer)
        return
      }
      const result = delivered(response, record)
      if (result !== response) args[0] = encodeChartWire(result)
      return originalSend.call(this, channel, ...args)
    }
    const released = new Promise(resolve => { probe.release = resolve })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value, context) => {
      if (value.chartFocus) {
        probe.focusCalls.push({ ...value.chartFocus, at: Date.now() })
        return original(event, value, context)
      }
      if (value.chartWindow) probe.legacyWindowCalls += 1
      const kind = value.chartHistory?.instId === instId ? 'history' : value.chartLocal?.instId === instId ? 'local' : null
      if (!kind) {
        const wire = await original(event, value, context)
        if (!value.chartUniverse) return wire
        const response = decodeChartWire(wire), frames = response.frames.map(clip)
        return frames.every((frame, index) => frame === response.frames[index]) ? wire : encodeChartWire({ ...response, frames })
      }
      const query = value.chartHistory ?? value.chartLocal
      const call = { kind, ...query, startedAt: Date.now(), readCompletedAt: null, completedAt: null, bars: 0 }
      probe.calls.push(call)
      probe.active += 1; probe.maxActive = Math.max(probe.maxActive, probe.active)
      const lane = kind === 'history' ? 'historicalActive' : 'localActive'
      const maximum = kind === 'history' ? 'maxHistoricalActive' : 'maxLocalActive'
      probe[lane] += 1; probe[maximum] = Math.max(probe[maximum], probe[lane])
      if (kind === 'history') probe.historyCalls.push({ ...query })
      let held = false
      try {
        // Read first, then hold delivery of the detached old reply. Explicit
        // backend focus/demand continues while either renderer disk lane waits.
        const wire = await original(event, value, context)
        const response = decodeChartWire(wire)
        call.readCompletedAt = Date.now()
        if (kind === 'history' && probe.holdHistorical && !probe.held && Number.isFinite(query.endHour)) {
          held = probe.held = true; probe.heldCall = call; probe.callsAtHold = probe.calls.length
          await released
        } else if (kind === 'local' && probe.holdLocal) await released
        const record = extension(response, kind, call.startedAt, call.readCompletedAt)
        if (record && historicalDelayMS > 0) await waitForDelay(record)
        const result = delivered(response, record)
        call.bars = result?.bars.length ?? 0
        call.first = result?.bars[0]?.hour ?? null; call.end = result?.bars.at(-1)?.hour ?? null
        call.delayedExtension = Boolean(record)
        if (kind === 'history') {
          probe.transferredHistoryBars += call.bars
          probe.historyResponses.push({ ...query, bars: call.bars, first: call.first, end: call.end })
        }
        return result === response ? wire : encodeChartWire(result)
      } finally {
        call.completedAt = Date.now(); probe.active -= 1; probe[lane] -= 1
        if (held) probe.heldSettled = true
      }
    })
    globalThis.__chartRequestProbe = probe
  }, { instId, holdHistorical, initialHistoryBars, historicalDelayMS })
}

export async function releaseRequestProbe(electron) {
  await electron.evaluate(async () => { globalThis.__chartRequestProbe?.release(); await globalThis.__marketBackend.probe({ action: 'sourceRelease' }) })
}

export async function readRequestProbe(electron) {
  return electron.evaluate(async () => {
    const probe = globalThis.__chartRequestProbe
    const sourceRequests = (await globalThis.__marketBackend.probe({ action: 'sourceRead' })).slice(probe.sourceBaseline)
    const uniqueOrUnchangedOverlap = Object.fromEntries([...probe.historyPushSamples].map(([timeframe, { first, last, count }]) => {
      if (!last) return [timeframe, { fullHistoryPushes: count, firstBars: first.bars.length, lastBars: 0,
        firstStart: first.bars[0]?.hour ?? null, firstEnd: first.bars.at(-1)?.hour ?? null,
        lastStart: null, lastEnd: null, sharedBars: 0, newBars: 0, changedBars: 0,
        byteIdenticalBars: 0, firstAndLastPayloadIdentical: false }]
      const earlier = new Map(first.bars.map(bar => [bar.hour, JSON.stringify(bar)]))
      let sharedBars = 0, byteIdenticalBars = 0
      for (const bar of last.bars) if (earlier.has(bar.hour)) {
        sharedBars += 1
        if (earlier.get(bar.hour) === JSON.stringify(bar)) byteIdenticalBars += 1
      }
      const newBars = last.bars.length - sharedBars
      return [timeframe, { fullHistoryPushes: count, firstBars: first.bars.length, lastBars: last.bars.length,
        firstStart: first.bars[0]?.hour ?? null, firstEnd: first.bars.at(-1)?.hour ?? null,
        lastStart: last.bars[0]?.hour ?? null, lastEnd: last.bars.at(-1)?.hour ?? null,
        sharedBars, newBars, changedBars: sharedBars - byteIdenticalBars, byteIdenticalBars,
        firstAndLastPayloadIdentical: first.bars.length === last.bars.length && sharedBars === first.bars.length && byteIdenticalBars === first.bars.length }]
    }))
    return {
      calls: probe.calls, active: probe.active, maxActive: probe.maxActive,
      historicalActive: probe.historicalActive, maxHistoricalActive: probe.maxHistoricalActive, localActive: probe.localActive, maxLocalActive: probe.maxLocalActive,
      focusCalls: probe.focusCalls, legacyWindowCalls: probe.legacyWindowCalls, heldCall: probe.heldCall, heldSettled: probe.heldSettled, extensions: probe.extensions,
      historyCalls: probe.historyCalls, historyResponses: probe.historyResponses, historyFrames: Object.fromEntries(probe.historyFrames),
      transferredHistoryBars: probe.transferredHistoryBars, transferredBars: probe.transferredHistoryBars,
      traffic: { preparedPushes: probe.preparedPushes, totalBars: probe.preparedPushBars,
        fullHistoryPushes: probe.fullHistoryPushes, fullHistoryPushBars: probe.fullHistoryPushBars,
        duplicateFullHistorySignatures: [...probe.fullHistoryPushShapes.values()].reduce((total, count) => total + count - 1, 0),
        uniqueOrUnchangedOverlap },
      sourceCalls: sourceRequests.length, sourceRequests, held: probe.held, callsAtHold: probe.callsAtHold,
    }
  })
}

export async function resetRequestProbe(electron) {
  await electron.evaluate(async () => {
    const probe = globalThis.__chartRequestProbe
    if (!probe) throw new Error('The chart request probe is not installed.')
    if (probe.active || probe.timers.size || probe.pendingPushes.size) throw new Error('Cannot reset an active chart request probe.')
    const sourceRequests = await globalThis.__marketBackend.probe({ action: 'sourceRead' })
    probe.sourceBaseline = sourceRequests.length
    probe.calls.length = 0; probe.focusCalls.length = 0; probe.historyCalls.length = 0; probe.historyResponses.length = 0
    probe.historyFrames.clear(); probe.extensions.length = 0; probe.deliveredFloors.clear()
    probe.transferredHistoryBars = 0; probe.legacyWindowCalls = 0; probe.maxActive = 0
    probe.maxHistoricalActive = 0; probe.maxLocalActive = 0
    probe.preparedPushes = 0; probe.preparedPushBars = 0; probe.fullHistoryPushes = 0; probe.fullHistoryPushBars = 0
    probe.historyPushSamples.clear()
    probe.fullHistoryPushShapes.clear()
  })
}

export async function removeRequestProbe(electron) {
  await electron.evaluate(async ({ ipcMain }) => {
    const probe = globalThis.__chartRequestProbe
    if (!probe) return
    probe.release()
    probe.closed = true
    for (const timer of probe.timers) clearTimeout(timer)
    await globalThis.__marketBackend.probe({ action: 'sourceRemove' })
    probe.contents.send = probe.originalSend
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', probe.original)
    delete globalThis.__chartRequestProbe
  })
}

// Exercise backend reserve preparation while real wheel events keep arriving.
// Restrict all initial ingresses, then delay both durable reads and backend
// pushes so neither path can bypass the observed history-delivery latency.
export async function measureLatencyCoveredPrefetch(electron, page, fixture, { offscreen = false } = {}) {
  const historicalDelayMS = 1_500
  const frames = 768
  const candlesPerFrame = 2
  const phaseData = { presentation: offscreen ? 'hidden offscreen' : 'native foreground', historicalDelayMS,
    continuousWheelFrames: frames, candlesPerFrame }
  let foreground, probeInstalled = false, paintStarted = false, failure
  try {
    foreground = offscreen ? null : await foregroundPaintWindow(electron, page)
    if (offscreen) {
      const native = await electron.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() }
      })
      phaseData.native = native
      assert.deepEqual(native, { visible: false, focused: false, offscreen: true })
    } else phaseData.foreground = { native: foreground.native, environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence }
    await installRequestProbe(electron, fixture.instId, { historicalDelayMS })
    probeInstalled = true
    await openChart(page, fixture)
    // Delay only facts beyond the genuinely admitted range. Silently clipping
    // already delivered facts gives the backend a false view of client runway.
    await waitForLocalHistory(electron, page, fixture, fixture.timeframe, { requireIndicators: true })
    await waitForRendered(page, fixture)
    const initialViewport = await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.end })
    const viewportBars = initialViewport.expectedHours.length
    phaseData.viewportBars = viewportBars
    const initial = await readRequestProbe(electron)
    const admitted = initial.historyFrames[fixture.timeframe]
    phaseData.initial = initial
    assert.ok(admitted && admitted.calculated === admitted.bars)
    assert.equal(admitted.end, fixture.end, 'The initial delivered range must end at the fixture latest candle.')
    const initialHistoryBars = (fixture.end - admitted.first) / fixture.intervalMS + 1
    assert.equal(initialHistoryBars, admitted.bars, 'The initial delivered reserve must contain every native candle slot.')
    assert.ok(initialHistoryBars > 96 && initialHistoryBars <= 1536)
    assert.ok(frames * candlesPerFrame > initialHistoryBars - viewportBars + 1, 'The gesture must cross the actual delivered boundary.')
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    phaseData.rendererTimeOrigin = timeOrigin
    phaseData.initialHistoryBars = initialHistoryBars
    assert.deepEqual(initial.extensions, [], 'Initial preparation must finish before delayed delivery begins.')
    await electron.evaluate((_, { timeframe, first }) => {
      globalThis.__chartRequestProbe.deliveredFloors.set(timeframe, first)
    }, { timeframe: fixture.timeframe, first: admitted.first })
    await startPaintProbe(page, fixture)
    paintStarted = true
    await electron.evaluate(() => { globalThis.__chartRequestProbe.extendHistory = true })
    const inputs = await wheelBurst(page, { frames, deltaY: 24 })
    phaseData.inputs = inputs
    const expectedEnd = fixture.end - frames * candlesPerFrame * fixture.intervalMS
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    const latency = await measureChartIntentLatency(page, {
      inputs, targets: inputs.map((_, index) => fixture.end - (index + 1) * candlesPerFrame * fixture.intervalMS),
      requireForeground: !offscreen, enforceBudgets: false,
    })
    phaseData.latency = latency
    const paint = await finishPaintProbe(page, { includeRequestCommits: true, includeTimingEvidence: true })
    paintStarted = false
    phaseData.paint = paintPhaseEvidence(paint)
    const requests = await readRequestProbe(electron)
    phaseData.requests = requests
    const extensions = requests.extensions.filter(record => record.completedAt !== null && record.startedAt >= timeOrigin + inputs[0])
    const first = extensions[0]
    const requestTime = first ? first.startedAt - timeOrigin : null
    const responseTime = first ? first.completedAt - timeOrigin : null
    const observedDeliveryMS = first ? first.completedAt - first.readCompletedAt : null
    const initialFirst = fixture.end - (initialHistoryBars - 1) * fixture.intervalMS
    const crossingIndex = Math.ceil((initialHistoryBars - viewportBars + 1) / candlesPerFrame) - 1
    const inputsAtRequest = first ? inputs.filter(input => input <= requestTime).length : null
    const runwayAtRequest = first ? initialHistoryBars - viewportBars - inputsAtRequest * candlesPerFrame : null
    const delayedReads = requests.calls.filter(call => call.delayedExtension)
    const readBudget = 2 * (Math.ceil((inputs.at(-1) - inputs[0]) / historicalDelayMS) + 1)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    phaseData.runway = { requestTime, responseTime, observedDeliveryMS, inputsAtRequest, runwayAtRequest, crossingIndex,
      crossingInputAt: inputs[crossingIndex], delayedReadCount: delayedReads.length, readBudget, initialFirst }
    phaseData.sources = sources
    // All paint, source, delivery, and timing checks run after deferred paint
    // validation. A slow gesture must not hide the functional result, and a
    // functional failure must not hide either timing budget.
    const checks = [
      ['complete paints', () => assertCompletePaints(paint)],
      ['no pending frames', () => assert.equal(paint.pendingFrames, 0, 'Latency-covered scrolling must never expose an unprepared requested viewport.')],
      ['history delivery', () => assert.ok(first, 'Backend reserve preparation must extend the delivered history during the gesture.')],
      ...(first ? [
        ['delivery during gesture', () => assert.ok(requestTime >= inputs[0] && responseTime < inputs.at(-1), 'A delayed history delivery must start and finish while wheel input is still arriving.')],
        ['delivery delay', () => assert.ok(observedDeliveryMS >= historicalDelayMS, 'The actual prepared data must spend the full configured interval behind the delivery gate.')],
        ['continuous extension', () => assert.ok(first.first < initialFirst && first.end >= initialFirst && first.bars > 96, 'A real bulk response must extend continuously across the original delivered boundary.')],
        ['delivery before crossing', () => assert.ok(responseTime < inputs[crossingIndex], 'Backend reserve data must reach the renderer before the first viewport crosses the original boundary.')],
        ['request runway', () => assert.ok(runwayAtRequest >= 192, `Only ${runwayAtRequest} resident candles remained when backend history delivery started.`)],
      ] : []),
      ['historical read lanes', () => assert.ok(requests.maxHistoricalActive <= 2, 'Continuous input must keep durable reads within two independent lanes.')],
      ['legacy window calls', () => assert.equal(requests.legacyWindowCalls, 0)],
      ['delayed read budget', () => assert.ok(delayedReads.length <= readBudget, `A cold-boundary traversal admitted ${delayedReads.length} delayed disk reads (budget ${readBudget}).`)],
      ['persisted sources', () => assert.deepEqual(sources.historical, [], 'Prefetch must reuse persisted source candles and statistics within the latency test range.')],
      ...(!offscreen ? prefetchPerformanceChecks(latency) : []),
    ]
    const { results, failures } = collectAcceptanceChecks(checks)
    phaseData.checks = results
    if (failures.length) throw new AggregateError(failures, failures.map(error => error?.message ?? String(error)).join('\n'))
    return {
      foregroundWindow: foreground?.native, environment: foreground?.environment, idleFrameCadence: foreground?.idleFrameCadence,
      timingScope: offscreen
        ? { presentation: 'offscreen', wallTime: 'input-to-renderer-RAF values are diagnostics; no native display deadline is inferred', frames: 'all renderer RAF and pending-frame assertions remain enforced' }
        : { presentation: 'native foreground', wallTime: '100 ms maximum intent-to-renderer-RAF deadline enforced', frames: 'all renderer RAF and pending-frame assertions remain enforced' },
      nativePaintMeasured: false, foregroundRafObservationMeasured: !offscreen,
      viewportBars, initialHistoryBars, initialHistoryFirst: admitted.first, historicalDelayMS, continuousWheelFrames: frames,
      scrolledCandles: frames * candlesPerFrame, crossedInitialBoundary: true,
      runwayAtRequest, deliveredHistoryBars: first.bars, observedHistoryDeliveryMS: observedDeliveryMS,
      prefetchStartedDuringGesture: true, prefetchCompletedDuringGesture: true,
      historicalRequests: delayedReads.length, delayedBackendPushes: extensions.filter(record => record.kind === 'push').length,
      maxConcurrentHistoricalRequests: requests.maxHistoricalActive,
      olderSourceExtensions: sources.historicalExtensions.length,
      repeatedSourceDownloads: sources.historical.length,
      ...latency, ...paint, frameSamples: undefined, captureTimings: undefined, observationSamples: undefined,
      inputBursts: undefined, requestCommits: undefined, commits: paint.commits.length,
    }
  } catch (error) {
    const evidenceErrors = []
    if (paintStarted) {
      try {
        const paint = await finishPaintProbe(page, { includeRequestCommits: true, includeTimingEvidence: true })
        paintStarted = false
        phaseData.paint = paintPhaseEvidence(paint)
      } catch (evidenceError) { evidenceErrors.push(`Paint evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (phaseData.rendererTimeOrigin === undefined) {
      try { phaseData.rendererTimeOrigin = await page.evaluate(() => performance.timeOrigin) }
      catch (evidenceError) { evidenceErrors.push(`Renderer clock: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (probeInstalled && !phaseData.requests) {
      try { phaseData.requests = await readRequestProbe(electron) }
      catch (evidenceError) { evidenceErrors.push(`Request evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    const observedInputs = phaseData.inputs ?? phaseData.paint?.inputBursts?.map(burst => burst.lastAt)
    if (!phaseData.latency && observedInputs?.length && phaseData.paint?.commits) {
      try {
        const intents = observedInputs.map((at, index) => ({ at, target: fixture.end - (index + 1) * candlesPerFrame * fixture.intervalMS,
          instId: fixture.instId, timeframe: fixture.timeframe }))
        phaseData.intentAccounting = accountChartIntents(intents, phaseData.paint.commits).map(intent => ({
          index: intent.index, inputAt: observedInputs[intent.index], target: intent.target, status: intent.status,
          supersededBy: intent.supersededBy, commitAt: intent.commit?.at ?? null, rafSampledAt: intent.commit?.rafSampledAt ?? null,
          committedTarget: intent.commit?.end ?? null, latencyMS: intent.latencyMS }))
      } catch (evidenceError) { evidenceErrors.push(`Intent evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (!phaseData.runway && observedInputs?.length && Number.isFinite(phaseData.initialHistoryBars)
      && Number.isFinite(phaseData.rendererTimeOrigin) && phaseData.requests) {
      const first = phaseData.requests.extensions.find(record => record.startedAt >= phaseData.rendererTimeOrigin + observedInputs[0])
      if (first) {
        const requestTime = first.startedAt - phaseData.rendererTimeOrigin
        const inputsAtRequest = observedInputs.filter(input => input <= requestTime).length
        phaseData.runway = { requestTime, responseTime: Number.isFinite(first.completedAt) ? first.completedAt - phaseData.rendererTimeOrigin : null,
          inputsAtRequest, runwayAtRequest: phaseData.initialHistoryBars - phaseData.viewportBars - inputsAtRequest * candlesPerFrame,
          deliveryPending: first.completedAt === null }
      }
    }
    const performanceFailures = []
    if (!offscreen && phaseData.latency && !phaseData.checks) {
      const performance = collectAcceptanceChecks(prefetchPerformanceChecks(phaseData.latency))
      phaseData.checks = performance.results
      performanceFailures.push(...performance.failures)
    }
    if (evidenceErrors.length) phaseData.evidenceErrors = evidenceErrors
    const failures = [error, ...performanceFailures]
    const message = failures.map(item => item?.message ?? String(item)).join('\n')
    failure = new Error(`${message}\nPrefetch phase data: ${JSON.stringify(phaseData)}`,
      { cause: failures.length === 1 ? error : new AggregateError(failures, message) })
    throw failure
  } finally {
    const cleanupErrors = []
    if (paintStarted) try { await finishPaintProbe(page) } catch (error) { cleanupErrors.push(error) }
    if (probeInstalled) {
      try { await releaseRequestProbe(electron) } catch (error) { cleanupErrors.push(error) }
      try { await removeRequestProbe(electron) } catch (error) { cleanupErrors.push(error) }
    }
    try { await foreground?.restore() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      const message = cleanupErrors.map(error => error?.message ?? String(error)).join('\n')
      if (failure) failure.message += `\nPrefetch cleanup failures: ${message}`
      else throw new AggregateError(cleanupErrors, `Prefetch cleanup failures: ${message}\nPrefetch phase data: ${JSON.stringify(phaseData)}`)
    }
  }
}

// A genuinely absent SQLite range, rather than a capped renderer response.
// Keep farther source pages and OI/Taker unresolved while the nearest complete
// price/indicator viewport crosses every production boundary and reaches SVG.
export async function measureNativeColdBoundary(electron, page, options = {}) {
  const foreground = await foregroundPaintWindow(electron, page)
  try { return { ...await nativeColdBoundary(electron, page, options), environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence } }
  finally { await foreground.restore() }
}

export async function measureOffscreenColdBoundary(electron, page, options = {}) {
  const native = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() }
  })
  assert.deepEqual(native, { visible: false, focused: false, offscreen: true }, 'Cold-boundary data-path measurement requires the protected hidden offscreen window.')
  return { ...await nativeColdBoundary(electron, page, { ...options, offscreen: true }), native,
    presentation: 'protected hidden offscreen renderer; native compositor paint is not measured' }
}

// Exercise one complete 96-slot viewport that has no durable candles. Input
// continues while its source request is delayed; the later reverse gesture
// must remain the cursor that eventually resolves. A second run fails that
// source page and checks that the UI does not claim the absent range completed.
export async function measureMissingWindow(electron, page, { timeframe = '15m', failSource = false, offscreen = true } = {}) {
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  let foreground, failure, sourceStarted = false, probeInstalled = false, paintStarted = false
  try {
    foreground = offscreen ? null : await foregroundPaintWindow(electron, page)
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() }
    })
    assert.deepEqual(native, { visible: !offscreen, focused: !offscreen, offscreen }, 'Cold missing-window measurement must use its declared window presentation.')
    sourceStarted = true
    const fixture = await probe({ action: 'coldBoundaryInstall', timeframe, scenario: 'full-missing-window', sourceDelayMS: 1_800, failNearestCandles: failSource })
    const initialRows = await electron.evaluate((_, fixture) => globalThis.__marketBackend.request({ e2e: {
      action: 'readCandles', instrument: fixture.instId, timeframe: fixture.timeframe,
      from: fixture.targetWindowStart, through: fixture.targetEnd,
    } }), fixture)
    assert.equal(initialRows.length, 0, 'All 96 target candle slots must be absent from SQLite before the gesture.')
    await installRequestProbe(electron, fixture.instId)
    probeInstalled = true
    await openChart(page, fixture)
    await startPaintProbe(page, fixture, { indicatorValidation: 'deferred-canonical' })
    paintStarted = true

    const firstInputs = await wheelBurst(page, { deltaY: fixture.targetDistance * 12 })
    const deadline = Date.now() + 10_000
    let sourceSnapshot, nearest
    do {
      sourceSnapshot = await probe({ action: 'coldBoundaryRead' })
      nearest = sourceSnapshot.requests.find(request => request.source === 'candles'
        && request.from <= fixture.targetEnd && request.through >= fixture.targetWindowStart)
      if (nearest) break
      assert.ok(Date.now() < deadline, `The completely absent viewport did not start native source acquisition: ${JSON.stringify(sourceSnapshot)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    assert.equal(nearest.held, false, 'The nearest source page must be the active delayed or failed request, not farther speculative work.')
    assert.equal(nearest.completedAt, null)
    assert.equal(nearest.failedAt, null)

    const firstState = await readColdWindowState(page, fixture.instId)
    assert.equal(firstState.loading, true, 'The renderer must expose a pending request while the absent window is unresolved.')
    assert.equal(firstState.requestedEnd, fixture.targetEnd)
    assert.notEqual(firstState.renderedEnd, fixture.targetEnd, 'The old SVG must not be labeled as the missing requested window.')

    const continuation = await wheelBurst(page, { frames: 6, deltaY: 72 })
    const reversal = await wheelBurst(page, { frames: 4, deltaY: -72 })
    const latestDistance = fixture.targetDistance + 12
    const latestEnd = fixture.end - latestDistance * fixture.intervalMS
    const latestInputs = [...firstInputs, ...continuation, ...reversal]
    const latestTargets = [fixture.targetEnd,
      ...continuation.map((_, index) => fixture.end - (fixture.targetDistance + (index + 1) * 6) * fixture.intervalMS),
      ...reversal.map((_, index) => fixture.end - (fixture.targetDistance + 36 - (index + 1) * 6) * fixture.intervalMS)]
    assert.equal(latestTargets.at(-1), latestEnd)
    await page.waitForFunction(({ instId, end }) => Number(document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)?.dataset.chartRequestedEnd) === end,
      { instId: fixture.instId, end: latestEnd }, { timeout: 5000 })
    const latestState = await readColdWindowState(page, fixture.instId)
    assert.equal(latestState.requestedEnd, latestEnd, 'The reverse gesture must update the pending target to the latest intent.')
    assert.notEqual(latestState.renderedEnd, latestEnd, 'The missing window must remain visibly pending before source resolution.')
    sourceSnapshot = await probe({ action: 'coldBoundaryRead' })
    nearest = sourceSnapshot.requests.find(request => request.source === 'candles'
      && request.from <= fixture.targetEnd && request.through >= fixture.targetWindowStart)
    assert.equal(nearest.completedAt, null, 'The delayed request must remain active through continuing and reversed input.')
    assert.equal(nearest.failedAt, null, 'A configured delayed source failure must occur after continuing and reversed input.')
    const pendingInputAcknowledgment = await measureChartIntentLatency(page, {
      inputs: latestInputs, targets: latestTargets, requireForeground: !offscreen, milestone: 'requested-cursor', enforceBudgets: false,
    })

    let latency = null
    if (failSource) {
      const failedDeadline = Date.now() + 10_000
      while (!nearest.failedAt) {
        assert.ok(Date.now() < failedDeadline, `The configured source failure did not surface: ${JSON.stringify(sourceSnapshot)}`)
        await new Promise(resolve => setTimeout(resolve, 20))
        sourceSnapshot = await probe({ action: 'coldBoundaryRead' })
        nearest = sourceSnapshot.requests.find(request => request.source === 'candles'
          && request.from <= fixture.targetEnd && request.through >= fixture.targetWindowStart)
      }
      await page.waitForFunction(({ instId, latestEnd }) => {
        const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)
        const alert = document.querySelector('[role="alert"]')?.textContent ?? ''
        return Number(chart?.dataset.chartRequestedEnd) === latestEnd && /price history failed/i.test(alert)
      }, { instId: fixture.instId, latestEnd }, { timeout: 5_000 }).catch(async error => {
        throw new Error(`A failed cold source must remain a truthful chart error. State: ${JSON.stringify(await readColdWindowState(page, fixture.instId))}`, { cause: error })
      })
      const failedState = await readColdWindowState(page, fixture.instId)
      assert.equal(failedState.requestedEnd, latestEnd)
      assert.notEqual(failedState.completedEnd, latestEnd, 'A failed page must not publish the missing target as complete.')
      assert.match(failedState.alert, /price history failed/i)
      assert.equal(nearest.error, 'Configured cold-window source failure.', `The delayed fixture must fail for its configured reason: ${JSON.stringify(nearest)}`)
      assert.match(failedState.alert, /Configured cold-window source failure\./)
      assert.ok(nearest.failedAt - nearest.startedAt >= fixture.sourceDelayMS,
        `The configured failed price source must remain delayed for the full interval: ${JSON.stringify(nearest)}`)
    } else {
      await waitForRendered(page, fixture, timeframe, latestEnd)
      await page.waitForFunction(instId => {
        const snapshot = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)?.__chartSnapshot
        return ['ready', 'unavailable'].includes(snapshot?.indicatorState) && snapshot.bars.every(bar => bar.indicatorsObserved)
      }, fixture.instId, { timeout: 10_000 })
      latency = await measureChartIntentLatency(page, { inputs: latestInputs, targets: latestTargets, requireForeground: false })
      const recoveredState = await readColdWindowState(page, fixture.instId)
      assert.equal(recoveredState.renderedEnd, latestEnd)
      assert.equal(recoveredState.completedEnd, latestEnd)
      assert.equal(recoveredState.loading, false)
      assert.equal(recoveredState.candleState, 'ready')
      assert.equal(recoveredState.incomplete, true, 'The target remains explicitly incomplete while optional OI/Taker source pages are held.')
      assert.equal(recoveredState.statisticsState, 'loading')
      assert.ok(['loading', 'unavailable'].includes(recoveredState.oiState) && ['loading', 'unavailable'].includes(recoveredState.takerState),
        `Statistics readiness must reflect the held sources: ${JSON.stringify(recoveredState)}`)
    }

    sourceSnapshot = await probe({ action: 'coldBoundaryRead' })
    nearest = sourceSnapshot.requests.find(request => request.source === 'candles'
      && request.from <= fixture.targetEnd && request.through >= fixture.targetWindowStart)
    const finishedAt = failSource ? nearest.failedAt : nearest.completedAt
    assert.ok(Number.isFinite(finishedAt) && finishedAt - nearest.startedAt >= fixture.sourceDelayMS,
      `The configured price source must remain delayed for the full interval before success or failure: ${JSON.stringify(nearest)}`)
    const heldStatistics = sourceSnapshot.requests.filter(request => request.source !== 'candles'
      && request.held && request.completedAt === null)
    if (!failSource) assert.ok(heldStatistics.length, 'The ready price window must remain explicitly incomplete while OI/Taker source pages are held.')

    const finalWindow = await readColdWindowState(page, fixture.instId)
    const paint = await finishPaintProbe(page, { includeRequestCommits: true, includeTimingEvidence: true })
    paintStarted = false
    // End the timing phase at the terminal UI state. Reading and independently
    // checking its SQLite prefix is correctness verification outside that phase.
    let observedFieldOracle, oracleError
    try { observedFieldOracle = await assertColdCanonicalViewport(electron, page, fixture, finalWindow.renderedEnd) }
    catch (error) { oracleError = error }
    const requests = await readRequestProbe(electron)
    const sourceKeys = sourceSnapshot.requests.map(request => `${request.source}:${request.from}:${request.through}`)
    const duplicatePages = sourceKeys.length - new Set(sourceKeys).size
    const { results, failures } = collectAcceptanceChecks([
      ['complete paints', () => assertCompletePaints(paint)],
      ['canonical viewport', () => { if (oracleError) throw oracleError }],
      ['indicator readiness', () => assert.equal(finalWindow.indicatorState, observedFieldOracle?.expectedIndicatorState,
        'Indicator readiness must describe the available SQLite prefix, including its real warmup boundary.')],
      ['historical read lanes', () => assert.ok(requests.maxHistoricalActive <= 2, 'Cold acquisition exceeded the two historical read lanes.')],
      ['legacy window calls', () => assert.equal(requests.legacyWindowCalls, 0)],
      ['source request budget', () => assert.ok(sourceSnapshot.requests.length <= 8, 'A single cold viewport admitted too many source requests.')],
      ['duplicate source pages', () => assert.ok(duplicatePages <= (failSource ? 1 : 0), 'The same cold source page was requested repeatedly.')],
      ...(!offscreen ? [
        ['100 ms pending input and RAF budgets', () => assertScrollResponsiveness(pendingInputAcknowledgment)],
        ['100 ms terminal phase RAF budget', () => assert.ok(paint.maxFrameGapMS < 100,
          `A completely absent viewport caused a renderer RAF stall of at least 100 ms: ${paint.maxFrameGapMS}`)],
      ] : []),
    ])
    if (failures.length) {
      const evidence = { rendererTimeOrigin: pendingInputAcknowledgment.rendererTimeOrigin, pendingInputAcknowledgment,
        finalWindow, sourceSnapshot, requests, observedFieldOracle, paint: paintPhaseEvidence(paint), checks: results }
      throw new Error(`${failures.map(error => error?.message ?? String(error)).join('\n')}\nMissing-window phase data: ${JSON.stringify(evidence)}`,
        { cause: new AggregateError(failures) })
    }
    return { scenario: 'full-missing-window', observedFieldOracle, initiallyMissingCandles: fixture.initiallyMissingViewportBars,
      initiallyPresentCandles: initialRows.length,
      latestIntentPreserved: failSource ? latestState.requestedEnd === latestEnd : true,
      sourceFailure: failSource ? nearest.error : null, sourceDelayMS: fixture.sourceDelayMS,
      sourceRequests: sourceSnapshot.requests.length, duplicateSourcePages: duplicatePages,
      heldSourceRequests: sourceSnapshot.requests.filter(request => request.held && request.completedAt === null).length,
      heldStatisticsRequests: heldStatistics.length,
      maximumActiveSourceRequests: sourceSnapshot.maxActive,
      boundedHistoricalReads: requests.maxHistoricalActive <= 2, failedSourceDidNotClaimCompletion: failSource,
      presentation: offscreen ? 'protected hidden offscreen renderer' : 'native foreground renderer',
      timingScope: 'Input-to-requested-cursor RAF acknowledgment and continuous RAF gaps through the terminal source success/error UI; source availability latency is reported separately. SQLite oracle checks follow the timing phase.',
      foregroundRafObservationMeasured: !offscreen,
      inputBudgetMS: offscreen ? null : 100,
      pendingInputAcknowledgment,
      dataAvailability: latency ? { latestInputToRenderedWindowRafMS: latency.latestInputToRafSampleMS,
        maximumIntentToRenderedWindowRafMS: latency.maxInputToRafSampleMS, sourceDelayMS: fixture.sourceDelayMS } : null,
      ...(foreground ? { environment: foreground.environment, idleFrameCadence: foreground.idleFrameCadence } : {}),
      exactInputAccounting: latency ? { intents: latestInputs.length, committed: latency.committedInputs,
        superseded: latency.supersededInputs, maximumIntentToRafSampleMS: latency.maxInputToRafSampleMS,
        allIntentsAccounted: latency.unaccountedInputs.length === 0 } : null,
      nativePaintMeasured: false, rendererRafSamples: paint.frames, ...paint,
      frameSamples: undefined, captureTimings: undefined, requestCommits: undefined, observationSamples: undefined }
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupErrors = []
    if (paintStarted) try { await finishPaintProbe(page) } catch (error) { cleanupErrors.push(error) }
    if (probeInstalled) {
      try { await releaseRequestProbe(electron) } catch (error) { cleanupErrors.push(error) }
      try { await removeRequestProbe(electron) } catch (error) { cleanupErrors.push(error) }
    }
    if (sourceStarted) try { await probe({ action: 'coldBoundaryRemove' }) } catch (error) { cleanupErrors.push(error) }
    try { await foreground?.restore() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      const errors = failure ? [failure, ...cleanupErrors] : cleanupErrors
      throw new AggregateError(errors, errors.map(error => error?.message ?? String(error)).join('\n'), { cause: errors[0] })
    }
  }
}

async function readColdWindowState(page, instId) {
  return page.locator(`[data-acceptance-target] [data-chart-inst="${instId}"]`).evaluate(chart => {
    const svg = chart.querySelector('svg[data-rendered-inst]')
    return { loading: chart.dataset.chartLoading === 'true', incomplete: chart.dataset.chartIncomplete === 'true',
      requestedEnd: Number(chart.dataset.chartRequestedEnd), completedEnd: Number(chart.dataset.chartCompletedEnd),
      renderedEnd: Number(svg?.dataset.renderedEnd), candleState: chart.dataset.chartCandleState,
      statisticsState: chart.dataset.chartStatisticsState, oiState: chart.dataset.chartOiState,
      takerState: chart.dataset.chartTakerState,
      indicatorState: chart.dataset.chartIndicatorState ?? null,
      alert: document.querySelector('[role="alert"]')?.textContent ?? '' }
  })
}

async function assertColdCanonicalViewport(electron, page, fixture, endHour, capturedFrame = null) {
  const timeframe = fixture.timeframe
  const recovered = capturedFrame
    ? assertChartViewport({ ...capturedFrame.viewport, bars: capturedFrame.bars }, { endHour })
    : await assertCompleteChartViewport(page, fixture.instId, { endHour })
  // The cold fixture's full provider history is intentionally not all present
  // in SQLite. Build this oracle from every candle actually available after
  // the nearest page is committed, so recursive seeds and missing-period
  // resets match the canonical input the product can replay at this point.
  const canonicalCandles = await electron.evaluate((_, fixture) => globalThis.__marketBackend.request({ e2e: {
    action: 'readCandles', instrument: fixture.instId, timeframe: fixture.timeframe,
    from: fixture.start, through: fixture.end,
  } }), fixture)
  assert.ok(canonicalCandles.length > 0, `The cold ${timeframe} canonical SQLite prefix must be readable.`)
  const oracle = new Map(barsWithIndicators(canonicalCandles, fixture.intervalMS).map(bar => [bar.hour, bar]))
  const priceFields = ['open', 'high', 'low', 'close'], indicatorFieldsObserved = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower',
    'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
  let observedIndicatorBars = 0, observedOIBars = 0, observedTakerBars = 0
  const assertCanonical = (actual, expected, field) => {
    if (expected[field] === null) {
      assert.equal(actual, null, `${timeframe} ${expected.hour} ${field} must match the canonical undefined value.`)
      return
    }
    assert.equal(typeof actual, 'number', `${timeframe} ${expected.hour} ${field} must be observed as a number.`)
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected[field]) <= Math.max(1, Math.abs(expected[field])) * 1e-10,
      `${timeframe} ${expected.hour} ${field}: expected canonical ${expected[field]}, got ${actual}.`)
  }
  for (const bar of recovered.bars) {
    const expected = oracle.get(bar.hour)
    assert.ok(expected, `No canonical SQLite-derived ${timeframe} bar exists for ${bar.hour}.`)
    for (const field of priceFields) assertCanonical(bar[field], expected, field)
    if (bar.indicatorsObserved) {
      observedIndicatorBars += 1
      for (const field of indicatorFieldsObserved) assertCanonical(bar[field], expected, field)
    } else {
      assert.fail(`${timeframe} ${bar.hour} did not finish its local canonical indicator calculation.`)
    }
    const oiObserved = bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)
    const takerObserved = bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)
    if (oiObserved) { observedOIBars += 1; assertCanonical(bar.oi, expected, 'oi') }
    else assert.equal(bar.oi, null, `${timeframe} ${bar.hour} must keep unobserved OI explicitly missing.`)
    if (takerObserved) {
      observedTakerBars += 1
      assertCanonical(bar.buy, expected, 'buy'); assertCanonical(bar.sell, expected, 'sell')
    } else {
      assert.equal(bar.buy, null, `${timeframe} ${bar.hour} must keep unobserved taker buys explicitly missing.`)
      assert.equal(bar.sell, null, `${timeframe} ${bar.hour} must keep unobserved taker sells explicitly missing.`)
    }
  }
  const expectedIndicatorState = recovered.bars.every(bar => indicatorFieldsObserved.every(field => Number.isFinite(oracle.get(bar.hour)?.[field]))) ? 'ready' : 'unavailable'
  return { expectedBars: recovered.expectedHours.length, expectedHours: recovered.expectedHours, priceBars: recovered.bars.length, indicatorBars: observedIndicatorBars, oiBars: observedOIBars, takerBars: observedTakerBars, expectedIndicatorState,
    checksCanonicalValues: true, unobservedFieldsRemainNull: true }
}

function summarizeColdApproach(inputs, target, fixture, timeframe, commits, frameSamples, endAt, milestone) {
  const intents = accountChartIntents(inputs.map(at => ({ at, target, instId: fixture.instId, timeframe })), commits)
  const last = intents.at(-1)
  const gaps = frameSamples.filter(sample => sample.at >= inputs[0]
    && sample.at <= (last.commit?.rafSampledAt ?? endAt)).map(sample => sample.gapMS)
  const latencies = intents.filter(intent => intent.commit).map(intent => intent.latencyMS)
  return { milestone,
    committedInputs: intents.filter(intent => intent.status === 'committed').length,
    supersededInputs: intents.filter(intent => intent.status === 'coalesced').length,
    unaccountedInputs: intents.filter(intent => intent.status === 'unaccounted').map(({ index, target }) => ({ index, target })),
    intents: intents.map(({ index, target, status, supersededBy, commit, latencyMS }) => ({ index, inputAt: inputs[index], target, status, supersededBy,
      commitAt: commit?.at ?? null, rafSampledAt: commit?.rafSampledAt ?? null, committedTarget: commit?.end ?? null, latencyMS })),
    lastCommit: last.commit, intentLatenciesMS: latencies.map(value => Number(value.toFixed(3))),
    maxInputToRafSampleMS: summarizeLatencySamples(latencies).maxMS,
    maxFrameGapMS: summarizeLatencySamples(gaps).maxMS }
}

async function nativeColdBoundary(electron, page, { timeframe = '15m', offscreen = false } = {}) {
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  const fixture = await probe({ action: 'coldBoundaryInstall', timeframe })
  let paintStarted = false
  let cdp, beforeMetrics, approachInputs, inputs, failure
  const phaseData = { timeframe, presentation: offscreen ? 'hidden offscreen' : 'native foreground',
    clocks: { renderer: 'performance.now() offsets plus renderer performance.timeOrigin', source: 'worker performance.timeOrigin plus performance.now()' } }
  try {
    const before = await electron.evaluate((_, fixture) => globalThis.__marketBackend.request({ e2e: {
      action: 'readCandles', instrument: fixture.instId, timeframe: fixture.timeframe,
      from: fixture.targetEnd - 95 * fixture.intervalMS, through: fixture.targetEnd,
    } }), fixture)
    assert.equal(before.length, 95, 'The first boundary viewport must contain exactly one never-downloaded candle.')
    assert.ok(before.every(row => row.timestamp > fixture.firstMissingEnd), 'The missing boundary candle must not already exist in SQLite.')
    await openChart(page, fixture)
    if (offscreen) {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      beforeMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
    }
    await page.waitForFunction(instId => {
      const chart = document.querySelector(`[data-acceptance-target] [data-chart-inst="${instId}"]`)
      return ['ready', 'unavailable'].includes(chart?.__chartSnapshot?.indicatorState) && chart?.dataset.chartIndicatorStale !== 'true'
    }, fixture.instId)
    await startPaintProbe(page, fixture, { indicatorValidation: 'finite' })
    paintStarted = true
    const approachDistance = fixture.initialHistoryBars - 96 - 256
    approachInputs = await wheelBurst(page, { deltaY: approachDistance * 12 })
    phaseData.approachInputs = approachInputs
    const approachEnd = fixture.end - approachDistance * fixture.intervalMS
    await waitForRendered(page, fixture, timeframe, approachEnd)
    const deadline = Date.now() + 10_000
    let sources
    do {
      sources = await probe({ action: 'coldBoundaryRead' })
      phaseData.sources = sources
      if (sources.requests.some(request => request.source === 'candles' && request.through === fixture.firstMissingEnd && Number.isFinite(request.completedAt))
        && sources.requests.some(request => request.source === 'candles' && request.held && request.completedAt === null)
        && sources.requests.some(request => request.source !== 'candles' && request.held && request.completedAt === null)) break
      assert.ok(Date.now() < deadline, `Native prefetch did not publish its nearest page before the held reserve: ${JSON.stringify(sources)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    inputs = await wheelBurst(page, { deltaY: (fixture.targetDistance - approachDistance) * 12 })
    phaseData.finalInputs = inputs
    await waitForTargetSnapshot(page, fixture, timeframe, fixture.targetEnd)
    const initialTarget = await page.locator(`[data-acceptance-target] [data-chart-inst="${fixture.instId}"]`).evaluate(chart => ({
      loading: chart.dataset.chartLoading === 'true', incomplete: chart.dataset.chartIncomplete === 'true',
      renderedBars: Number(chart.dataset.chartRenderedBars), end: Number(chart.dataset.chartCompletedEnd),
    }))
    await assertCompleteChartViewport(page, fixture.instId, { endHour: fixture.targetEnd })
    assert.equal(initialTarget.end, fixture.targetEnd)
    // Wait only for constant-time published readiness metadata. The exact
    // 96-bar and indicator checks run on retained RAF observations after the
    // active timing phase, never inside a timed callback.
    await page.waitForFunction(({ instId, timeframe, targetEnd, afterAt }) => {
      const observation = window.__chartPaintProbe?.lastFrame, snapshot = observation?.snapshot
      return observation?.at >= afterAt && snapshot?.instId === instId && snapshot.timeframe === timeframe
        && snapshot.endHour === targetEnd && snapshot.priceState === 'ready' && snapshot.indicatorState === 'ready'
        && Math.floor(Number(observation.surface?.chart?.visibleBars)) === 96
        && observation.bars?.length >= 96 && observation.bars.length <= 98
    }, { instId: fixture.instId, timeframe, targetEnd: fixture.targetEnd, afterAt: inputs.at(-1) }, { timeout: 10_000 })
    const latency = await measureChartIntentLatency(page, { inputs, targets: [fixture.targetEnd], requireForeground: false })
    phaseData.finalLatency = latency
    sources = await probe({ action: 'coldBoundaryRead' })
    phaseData.sources = sources
    const nearest = sources.requests.find(request => request.source === 'candles' && request.through === fixture.firstMissingEnd)
    assert.ok(Number.isFinite(nearest?.completedAt),
      `The first download must end at the adjacent missing viewport, without a skipped 96-candle page: ${JSON.stringify(sources.requests)}`)
    assert.ok(Number(nearest.parameters.limit) >= 200 && Number(nearest.parameters.limit) <= 300,
      `Nearest preparation must reuse the saved suffix and fetch at most one native page including indicator warmup: ${JSON.stringify(nearest)}`)
    assert.ok(nearest.completedAt - nearest.startedAt >= fixture.sourceDelayMS, 'The real source page must include the configured network latency.')
    const heldReserve = sources.requests.filter(request => request.source === 'candles' && request.held && request.completedAt === null)
    const heldStatistics = sources.requests.filter(request => request.source !== 'candles' && request.held && request.completedAt === null)
    assert.ok(sources.holding && heldReserve.length && heldStatistics.length,
      'The target SVG snapshot must be available while both the farther price reserve and optional statistics remain unresolved.')
    const keys = sources.requests.map(request => `${request.source}:${request.from}:${request.through}`)
    assert.equal(new Set(keys).size, keys.length, `Concurrent consumers must reuse the same native source page: ${JSON.stringify(sources.requests)}`)
    const paint = await finishPaintProbe(page, { readyTarget: { instId: fixture.instId, timeframe, endHour: fixture.targetEnd,
      intervalMS: fixture.intervalMS, afterAt: inputs.at(-1) }, includeRequestCommits: true, includeTimingEvidence: true })
    paintStarted = false
    phaseData.paint = paintPhaseEvidence(paint)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    phaseData.rendererTimeOrigin = timeOrigin
    const targetCommit = paint.commits.find(commit => commit.end === fixture.targetEnd && commit.instId === fixture.instId
      && commit.timeframe === timeframe && commit.at >= inputs.at(-1) && Number.isFinite(commit.rafSampledAt))
    const sourceStartedAt = nearest.startedAt - timeOrigin
    const sourcePhaseStart = Math.min(approachInputs[0], sourceStartedAt)
    const sourceFrames = paint.frameSamples.filter(sample => sample.at >= sourcePhaseStart && sample.at <= inputs.at(-1))
    const sourceFrameSummary = summarizeLatencySamples(sourceFrames.map(sample => sample.gapMS))
    phaseData.sourcePhaseRAF = { startAt: sourcePhaseStart, sourceStartedAt, firstProbeFrameAt: paint.firstFrameAt, endAt: inputs.at(-1), samples: sourceFrames,
      sampleCount: sourceFrameSummary.sampleCount, maxGapMS: sourceFrameSummary.maxMS }
    phaseData.inputBursts = paint.inputBursts
    phaseData.targetCommit = targetCommit ?? null
    phaseData.readyFrame = paint.readyFrame ? { at: paint.readyFrame.at, endHour: paint.readyFrame.snapshot.endHour,
      bars: paint.readyFrame.bars.length, generation: paint.readyFrame.snapshot.generation } : null
    phaseData.paintViolations = paint.violations
    phaseData.commits = paint.commits
    phaseData.scheduler = paint.scheduler
    phaseData.observationSamples = paint.observationSamples
    phaseData.probeCapture = { samples: paint.probeCaptureSamples, totalMS: paint.totalProbeCaptureMS, maxMS: paint.maxProbeCaptureMS }
    const targetFrames = paint.frameSamples.filter(sample => sample.at >= inputs.at(-1) && sample.at <= (paint.readyFrame?.at ?? Infinity))
    const targetFrameSummary = summarizeLatencySamples(targetFrames.map(sample => sample.gapMS))
    phaseData.targetPhaseRAF = { startAt: inputs.at(-1), endAt: paint.readyFrame?.at ?? null, samples: targetFrames,
      sampleCount: targetFrameSummary.sampleCount, maxGapMS: targetFrameSummary.maxMS }
    const approachLatency = { ...summarizeColdApproach(approachInputs, approachEnd, fixture, timeframe, paint.commits, paint.frameSamples, inputs.at(-1), 'rendered-window'),
      meaning: 'Raw rendered-content availability diagnostic; initial history hydration is not guaranteed and no 100 ms content deadline is asserted.' }
    const approachAcknowledgment = summarizeColdApproach(approachInputs, approachEnd, fixture, timeframe, paint.requestCommits,
      paint.frameSamples, inputs.at(-1), 'requested-cursor')
    phaseData.approachLatency = approachLatency
    phaseData.approachAcknowledgment = approachAcknowledgment
    assert.ok(targetCommit, 'The target chart snapshot must reach a renderer RAF sample.')
    assert.ok(paint.readyFrame, 'No captured target RAF contained the full price window and observed finite indicators.')
    assert.ok(sources.preparedTarget, 'No passive history publication witnessed the prepared target after the nearest source completed; the prefetch preparation gap cannot be measured without demand.')
    assert.equal(sources.preparedTarget.sourceCompletedAt, nearest.completedAt, 'The prepared witness must follow the exact nearest source request.')
    const timing = coldBoundaryTiming({ rendererTimeOrigin: timeOrigin, approachInputAt: approachInputs[0], finalInputAt: inputs.at(-1),
      firstTargetRAFAt: targetCommit.rafSampledAt, readyTargetRAFAt: paint.readyFrame.at,
      nearestStartedAt: nearest.startedAt, nearestCompletedAt: nearest.completedAt, preparedTargetAt: sources.preparedTarget.at })
    phaseData.timing = timing
    const missing = paint.readyFrame.bars.find(bar => bar.hour === fixture.firstMissingEnd)
    let observedFieldOracle, oracleError
    try { observedFieldOracle = await assertColdCanonicalViewport(electron, page, fixture, fixture.targetEnd, paint.readyFrame) }
    catch (error) { oracleError = error }
    phaseData.observedFieldOracle = observedFieldOracle
    const checks = [
      ['input bursts', () => assert.equal(paint.inputBursts.length, approachInputs.length + inputs.length, 'Every approach and boundary wheel burst must be counted.')],
      ['complete paints', () => assertCompletePaints(paint)],
      ['source RAF coverage', () => assert.ok(Number.isFinite(sourcePhaseStart) && Number.isFinite(paint.firstFrameAt) && paint.firstFrameAt <= sourcePhaseStart,
        'The renderer RAF probe started too late to cover the complete approach/source phase.')],
      ['cold source timing', () => assertColdBoundaryTiming(timing)],
      ['held statistics', () => assert.ok(missing && missing.oi === null && missing.buy === null && missing.sell === null,
        'The selected ready RAF must keep held optional statistics missing at the boundary.')],
      ['canonical viewport', () => { if (oracleError) throw oracleError }],
      ...(!offscreen ? [
        ['foreground presentation', () => assert.ok(latency.documentVisibility === 'visible' && latency.documentFocused, 'Native timing requires a visible, focused renderer.')],
        ['cold responsiveness', () => assertColdBoundaryResponsiveness({ approachAcknowledgment, finalLatency: latency,
          readyTargetInputToRAFMS: timing.inputToReadyRAFMS, sourcePhaseRAF: phaseData.sourcePhaseRAF, targetPhaseRAF: phaseData.targetPhaseRAF })],
      ] : []),
    ]
    const { results, failures } = collectAcceptanceChecks(checks)
    phaseData.checks = results
    if (failures.length) throw new AggregateError(failures, failures.map(error => error?.message ?? String(error)).join('\n'))
    const afterMetrics = cdp ? Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value])) : null
    const offscreenObservation = afterMetrics ? {
      rendererTaskMS: Number(((afterMetrics.TaskDuration - beforeMetrics.TaskDuration) * 1000).toFixed(3)),
      rendererScriptMS: Number(((afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration) * 1000).toFixed(3)),
      nativePaintMeasured: false,
    } : undefined
    return { timeframe, targetEnd: fixture.targetEnd, initialHistoryBars: fixture.initialHistoryBars, sourceDelayMS: fixture.sourceDelayMS,
      initiallyMissingCandles: 96 - before.length, nearestSourceCandles: Number(nearest.parameters.limit),
      nativePaintMeasured: false, foregroundRafObservationMeasured: !offscreen, rendererTargetObserved: true,
      nativePageToRafSampleMS: timing.rawPageToFirstRAFMS, coldTiming: timing, preparedTarget: sources.preparedTarget,
      approachLatency, approachAcknowledgment, sourcePhaseRAF: phaseData.sourcePhaseRAF, targetPhaseRAF: phaseData.targetPhaseRAF, inputBursts: paint.inputBursts,
      sourceTimeOrigin: sources.sourceTimeOrigin, sourceRequests: sources.requests, commitSamples: paint.commits, readyTargetFrame: phaseData.readyFrame,
      nativeSourceRequests: sources.requests.length, heldReservePages: heldReserve.length, heldStatisticsPages: heldStatistics.length,
      targetSnapshotShownWhilePending: initialTarget.loading,
      targetPriceOrIndicatorIncompleteAtSnapshot: initialTarget.incomplete,
      observedFieldOracle,
      targetSnapshotObservedBeforeReserveAndStatistics: true,
      duplicateSourcePages: 0,
      ...(offscreenObservation ? { offscreenObservation } : {}),
      ...latency, ...paint, readyFrame: undefined, frameSamples: undefined, captureTimings: undefined, requestCommits: undefined,
      commits: paint.commits.length, approachInput: approachInputs[0] }
  } catch (error) {
    const evidenceErrors = []
    if (paintStarted) {
      try {
        const paint = await finishPaintProbe(page, { readyTarget: inputs?.length ? { instId: fixture.instId, timeframe, endHour: fixture.targetEnd,
          intervalMS: fixture.intervalMS, afterAt: inputs.at(-1) } : null, includeRequestCommits: true, includeTimingEvidence: true })
        paintStarted = false
        phaseData.paint = paintPhaseEvidence(paint)
        if (paint.readyFrame) phaseData.readyFrame = { at: paint.readyFrame.at, endHour: paint.readyFrame.snapshot.endHour,
          bars: paint.readyFrame.bars.length, generation: paint.readyFrame.snapshot.generation }
      } catch (evidenceError) { evidenceErrors.push(`Paint evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (phaseData.rendererTimeOrigin === undefined) {
      try { phaseData.rendererTimeOrigin = await page.evaluate(() => performance.timeOrigin) }
      catch (evidenceError) { evidenceErrors.push(`Renderer clock: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    try { phaseData.sources = await probe({ action: 'coldBoundaryRead' }) }
    catch (evidenceError) { evidenceErrors.push(`Source evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    if (approachInputs?.length && phaseData.paint?.commits && phaseData.paint?.requestCommits) {
      try {
        const approachEnd = fixture.end - (fixture.initialHistoryBars - 96 - 256) * fixture.intervalMS
        const endAt = inputs?.at(-1) ?? Infinity
        phaseData.approachLatency ??= summarizeColdApproach(approachInputs, approachEnd, fixture, timeframe,
          phaseData.paint.commits, phaseData.paint.frameSamples, endAt, 'rendered-window')
        phaseData.approachAcknowledgment ??= summarizeColdApproach(approachInputs, approachEnd, fixture, timeframe,
          phaseData.paint.requestCommits, phaseData.paint.frameSamples, endAt, 'requested-cursor')
      } catch (evidenceError) { evidenceErrors.push(`Approach intent evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (!phaseData.finalLatency && inputs?.length && phaseData.paint?.commits) {
      try {
        const intents = inputs.map(at => ({ at, target: fixture.targetEnd, instId: fixture.instId, timeframe }))
        phaseData.finalIntentAccounting = accountChartIntents(intents, phaseData.paint.commits).map(intent => ({
          index: intent.index, inputAt: inputs[intent.index], target: intent.target, status: intent.status,
          supersededBy: intent.supersededBy, commitAt: intent.commit?.at ?? null, rafSampledAt: intent.commit?.rafSampledAt ?? null,
          committedTarget: intent.commit?.end ?? null, latencyMS: intent.latencyMS }))
      } catch (evidenceError) { evidenceErrors.push(`Final intent evidence: ${evidenceError?.message ?? String(evidenceError)}`) }
    }
    if (evidenceErrors.length) phaseData.evidenceErrors = evidenceErrors
    failure = new Error(`${error?.message ?? String(error)}\nCold-boundary phase data: ${JSON.stringify(phaseData)}`, { cause: error })
    throw failure
  } finally {
    const cleanupErrors = []
    try { await cdp?.detach() } catch (error) { cleanupErrors.push(error) }
    if (paintStarted) try { await finishPaintProbe(page) } catch (error) { cleanupErrors.push(error) }
    try { await probe({ action: 'coldBoundaryRemove' }) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      const message = cleanupErrors.map(error => error?.message ?? String(error)).join('\n')
      if (failure) failure.message += `\nCold-boundary cleanup failures: ${message}`
      else throw new AggregateError(cleanupErrors, `Cold-boundary cleanup failures: ${message}\nCold-boundary phase data: ${JSON.stringify(phaseData)}`)
    }
  }
}
