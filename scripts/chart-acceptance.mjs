import assert from 'node:assert/strict'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { barsWithIndicators } from '../electron/services/indicators.js'
import { accountChartIntents, assertScrollResponsiveness, assertWarmStatistics, summarizeLatencySamples } from './chart-acceptance-metrics.mjs'

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
  const button = page.locator('[aria-label="Chart timeframe"] button')
    .filter({ hasText: new RegExp(`^${timeframe}$`, 'i') })
  await button.click()
}

export async function waitForRendered(page, fixture, timeframe = fixture.timeframe, end = fixture.end) {
  try {
    await page.waitForFunction(({ instId, timeframe, end }) => {
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
      const svg = chart?.querySelector('svg[data-rendered-inst]')
      return svg?.getAttribute('data-rendered-inst') === instId
        && svg.getAttribute('data-rendered-timeframe') === timeframe
        && Number(chart.getAttribute('data-chart-completed-end') ?? svg.getAttribute('data-rendered-end')) === end
        && chart.getAttribute('data-chart-rendered-bars') === '96'
        && chart.getAttribute('data-chart-loading') === 'false'
    }, { instId: fixture.instId, timeframe, end }, { timeout: 20_000 })
  } catch (error) {
    const state = await page.locator('[data-chart-inst]').evaluate(chart => ({
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
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    return svg?.getAttribute('data-rendered-inst') === instId
      && svg.getAttribute('data-rendered-timeframe') === timeframe
      && Number(svg.getAttribute('data-rendered-end')) === end
      && Number(chart.getAttribute('data-chart-completed-end')) === end
      && chart.getAttribute('data-chart-rendered-bars') === '96'
  }, { instId: fixture.instId, timeframe, end }, { timeout: 20_000 })
}

export async function assertWorkspaceLayout(page) {
  const layout = await page.locator('[data-layout="market-workspace"]').evaluate(root => {
    const list = root.querySelector('[data-market-list]')
    const chart = root.querySelector('[data-chart-panel]')
    const toolbar = root.querySelector('[data-chart-toolbar]')
    const controlsRow = root.querySelector('[data-native-window-controls-row]')
    const rectangle = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
    return {
      designWidth: Number(root.dataset.designWidth), scale: Number(root.dataset.uiScale),
      viewport: { width: innerWidth, height: innerHeight }, root: rectangle(root),
      toolbar: toolbar ? rectangle(toolbar) : null,
      sidebarToolbar: controlsRow ? rectangle(controlsRow) : null,
      toolbarControls: toolbar ? [...toolbar.querySelectorAll('button')].map(rectangle) : [],
      nativeControls: controlsRow && window.radarDesktop.nativeWindowControls ? {
        row: rectangle(controlsRow), title: rectangle(controlsRow.querySelector('h1')), settings: rectangle(controlsRow.querySelector('a')),
        inset: Number.parseFloat(getComputedStyle(controlsRow).paddingInlineStart) * Number(root.dataset.uiScale),
      } : null,
      list: list ? rectangle(list) : null, chart: chart ? rectangle(chart) : null,
      documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    }
  })
  assert.equal(layout.designWidth, 1_600)
  assert.ok(layout.scale > 0)
  assert.ok(Math.abs(layout.scale - layout.viewport.width / 1_600) < 1e-5, `All UI must use one width scale: ${JSON.stringify(layout)}`)
  assert.ok(layout.list && layout.chart, 'The list and chart panel must remain mounted together.')
  assert.ok(layout.list.y === 0 && layout.chart.y === 0, 'Both original workspace columns must begin at the top of the window.')
  assert.ok(Math.abs(layout.list.height - layout.viewport.height) < 1 && Math.abs(layout.chart.height - layout.list.height) < 1, 'Both workspace columns must use the full window height.')
  if (layout.toolbar) assert.ok(layout.toolbar.y === 0 && Math.abs(layout.toolbar.x - layout.chart.x) < 1 && Math.abs(layout.toolbar.width - layout.chart.width) < 1, 'The existing chart toolbar must form the top of the chart column without an extra title bar.')
  if (layout.toolbar && layout.sidebarToolbar) {
    assert.ok(Math.abs(layout.toolbar.height - layout.sidebarToolbar.height) < 1, 'The sidebar and chart must share one toolbar height.')
    const center = layout.toolbar.y + layout.toolbar.height / 2
    assert.ok(layout.toolbarControls.every(control => Math.abs(control.y + control.height / 2 - center) < 1), 'All chart toolbar controls must share the same vertical center.')
  }
  if (layout.nativeControls) {
    const { row, title, settings, inset } = layout.nativeControls
    assert.ok(Math.abs(inset - 16 * layout.scale - 72) < 1 && row.height >= 35, 'Native traffic lights need fixed-size clearance at every workspace scale.')
    assert.ok(title.x >= row.x + inset - 1 && title.x + title.width <= settings.x + 1, 'Native controls, application title, and settings must not overlap.')
    assert.ok([title, settings].every(control => Math.abs(control.y + control.height / 2 - (row.y + row.height / 2)) < 1), 'Application title and settings must align with the chart toolbar controls.')
  }
  assert.ok(Math.abs(layout.list.width / layout.scale - 420) < 2, 'The contract list must keep its design width.')
  assert.ok(Math.abs(layout.chart.width / layout.scale - 1_180) < 2, 'The chart panel must keep its design width.')
  assert.ok(Math.abs(layout.list.x + layout.list.width - layout.chart.x) < 2, 'The chart must sit beside the contract list.')
  assert.ok(layout.documentWidth <= layout.viewport.width + 1 && layout.documentHeight <= layout.viewport.height + 1, 'The workspace must scroll inside its panels, not the window.')
  assert.equal(await page.getByRole('button', { name: /^(?:Back to Markets|Markets)$/i }).count(), 0)
  return layout
}

export async function assertIndicatorLegends(page, { requireFittedVolatility = false } = {}) {
  const reading = await page.locator('svg[data-rendered-inst]').evaluate(svg => {
    const fields = {
      'VWAP(14)': 'vwap', 'EMA(200)': 'ema', 'BOLL(20,2)': 'bollMiddle',
      'ROC(9)': 'roc', 'MAROC(9)': 'maroc', 'RSI(6)': 'rsi6', 'RSI(12)': 'rsi12', 'RSI(24)': 'rsi24',
      'ATR%(14)': 'atrPercent', 'BBW(20,2)': 'bbw', 'OI (Contracts)': 'oi',
    }
    const volatilityPanel = svg.querySelector('[data-chart-volatility-panel]')
    const colorProbe = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    colorProbe.setAttribute('fill', 'var(--muted-foreground)')
    svg.append(colorProbe)
    const mutedForeground = getComputedStyle(colorProbe).fill
    colorProbe.remove()
    return {
      foreground: getComputedStyle(document.body).color,
      mutedForeground,
      volatilityPanel: volatilityPanel ? { top: Number(volatilityPanel.getAttribute('data-chart-panel-top')), bottom: Number(volatilityPanel.getAttribute('data-chart-panel-bottom')) } : null,
      volatilityCoordinates: svg.querySelectorAll('[data-chart-volatility-axis], [data-chart-axis-label], [data-chart-axis-tick]').length,
      panels: [...svg.querySelectorAll('[data-chart-panel-header]')].map(header => ({ key: header.dataset.chartPanelHeader, y: header.getBBox().y })),
      legends: Object.entries(fields).map(([label, field]) => {
        const swatch = [...svg.querySelectorAll('[data-chart-legend]')].find(node => node.dataset.chartLegend === label)
        const group = swatch?.parentElement, texts = group?.querySelectorAll('text')
        const curve = svg.querySelector(`[data-chart-indicator="${field}"]`)
        return { label, field, panel: group?.closest('[data-chart-panel-header]')?.getAttribute('data-chart-panel-header'),
          labelFill: texts?.[0] ? getComputedStyle(texts[0]).fill : null,
          valueFill: texts?.[1] ? getComputedStyle(texts[1]).fill : null,
          swatchStroke: swatch ? getComputedStyle(swatch).stroke : null,
          curveStroke: curve ? getComputedStyle(curve).stroke : null,
          curveWidth: curve ? Number.parseFloat(getComputedStyle(curve).strokeWidth) : null,
          curveDash: curve ? getComputedStyle(curve).strokeDasharray : null,
          curve: curve?.getAttribute('d') ?? '', value: texts?.[1]?.textContent ?? '',
        }
      }),
    }
  })
  assert.deepEqual(reading.panels.map(panel => panel.key), ['price', 'roc', 'rsi', 'atr', 'oi', 'taker'])
  assert.ok(reading.panels.every((panel, index) => index === 0 || panel.y > reading.panels[index - 1].y), 'Panel titles must follow their visual order, with ATR% and BBW between RSI and OI.')
  for (const legend of reading.legends) {
    assert.ok(legend.curve, `${legend.label} must have a drawn curve.`)
    assert.equal(legend.labelFill, legend.panel === 'rsi' ? reading.mutedForeground : legend.curveStroke,
      `${legend.label} title must use ${legend.panel === 'rsi' ? 'muted text beside its colored swatch' : 'its curve color'}.`)
    assert.equal(legend.swatchStroke, legend.curveStroke, `${legend.label} swatch must match its curve.`)
    assert.equal(legend.valueFill, reading.foreground, `${legend.label} numeric value must retain the foreground text color.`)
    assert.equal(legend.curveWidth, 1, `${legend.label} must use a 1 px stroke.`)
    if (legend.field === 'atrPercent' || legend.field === 'bbw') {
      assert.equal(legend.panel, 'atr', 'ATR% and BBW must share one indicator panel.')
      assert.match(legend.value, /^\d+\.\d{2}%$/, `${legend.label} must show its percentage without a positive change sign.`)
    }
  }
  assert.equal(reading.legends.find(legend => legend.field === 'atrPercent').curveDash, 'none')
  assert.notEqual(reading.legends.find(legend => legend.field === 'bbw').curveDash, 'none', 'BBW must remain distinguishable by its dash pattern.')
  assert.equal(reading.volatilityCoordinates, 0, 'ATR% and BBW must hide their vertical coordinates and axis titles.')
  if (requireFittedVolatility) {
    const panel = reading.volatilityPanel
    assert.ok(panel && panel.bottom > panel.top, 'The volatility panel must expose its painted boundaries.')
    reading.volatilityFits = ['atrPercent', 'bbw'].map(field => {
      const curve = reading.legends.find(legend => legend.field === field).curve
      const points = curve.match(/[ML][^ML]+/g).map(command => command.slice(1).trim().split(/\s+/).map(Number))
      assert.ok(points.every(point => point.length === 2 && point.every(Number.isFinite)), `${field} must contain finite coordinates.`)
      const ys = points.map(([, y]) => y), top = Math.min(...ys), bottom = Math.max(...ys), height = panel.bottom - panel.top
      const fit = { field, top, bottom, fillRatio: (bottom - top) / height, topInset: (top - panel.top) / height, bottomInset: (panel.bottom - bottom) / height }
      assert.ok(fit.fillRatio >= .8, `${field} must use most of its independent panel height: ${JSON.stringify(fit)}`)
      assert.ok(fit.topInset >= .01 && fit.bottomInset >= .01, `${field} visible extrema need padding inside the panel: ${JSON.stringify(fit)}`)
      return fit
    })
  }
  return reading
}

export async function openChart(page, fixture, timeframe = fixture.timeframe) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  // Admission belongs to the requested timeframe's committed chart. A fixture
  // can intentionally have no sources for the previously saved timeframe.
  await selectTimeframe(page, timeframe)
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click({ timeout: 15_000 })
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
  await assertWorkspaceLayout(page)
  await waitForRendered(page, fixture, timeframe)
}

// Inspect the actual immutable data passed to Plot and its SVG, rather than
// treating the requested viewport or an aggregate loading flag as a render.
// __chartSnapshot is a reference to the rendered object; it avoids serializing
// 96 full bars into an attribute on every production animation frame.
export async function startPaintProbe(page, fixture, { requireMatureData = false, requireWarmStatistics = false, indicatorValidation = 'fixture' } = {}) {
  assert.ok(['fixture', 'finite', 'deferred-canonical'].includes(indicatorValidation), 'Unknown chart indicator validation contract.')
  if (requireWarmStatistics) {
    const { timeframe, bars } = await page.locator(`[data-chart-inst="${fixture.instId}"]`).evaluate(chart => ({
      timeframe: chart.__chartSnapshot?.timeframe,
      bars: (chart.__chartSnapshot?.bars ?? []).map(bar => ({
        hour: bar.hour, oi: bar.oi, buy: bar.buy, sell: bar.sell, oiObserved: bar.oiObserved,
        takerObserved: bar.takerObserved, statisticsObserved: bar.statisticsObserved, statisticsSources: bar.statisticsSources,
      })),
    }))
    assert.ok(fixture.series[timeframe], `The warm chart timeframe ${timeframe} must have a fixture oracle.`)
    assertWarmStatistics(bars, fixture.series[timeframe].bars)
  }
  await page.evaluate(({ instId, series, requireMatureData, requireWarmStatistics, indicatorValidation }) => {
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    if (!(chart instanceof HTMLElement)) throw new Error('No chart surface to inspect.')
    const expectedTimeframe = chart.__chartSnapshot?.timeframe
    if (!series[expectedTimeframe]) throw new Error('The initial chart needs a known fixture timeframe.')
    const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    const indicatorFields = fields.slice(4, -3), statisticFields = ['oi', 'buy', 'sell']
    const curveFields = [...indicatorFields, 'oi'], expectedGeometry = new WeakMap()
    const oracles = Object.fromEntries(Object.entries(series).map(([frame, entry]) => [frame, new Map(entry.bars.map(bar => [bar.hour, bar]))]))
    const probe = {
      instId, expectedTimeframe,
      active: true, frames: 0, pendingFrames: 0, paints: 0, minimumBars: Infinity, errors: [],
      frameGaps: [], frameSamples: [], validationSamples: [], inputBursts: [], commits: [], requestCommits: [], pendingWindows: [], previousFrame: null, previousSnapshot: null, previousBars: null,
      phase: 'initial', quality: [], known: new Map(), geometry: new Map(),
      raf: null, observer: null, schedulerObservers: [],
      scheduler: { counts: {}, entries: [], supportedEntryTypes: PerformanceObserver.supportedEntryTypes },
    }
    for (const type of ['longtask', 'long-animation-frame']) if (probe.scheduler.supportedEntryTypes.includes(type)) {
      const record = entries => {
        for (const entry of entries) {
          probe.scheduler.counts[type] = (probe.scheduler.counts[type] ?? 0) + 1
          probe.scheduler.entries.push({ type, startTime: entry.startTime, duration: entry.duration,
            blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: [...(entry.scripts ?? [])].slice(0, 5).map(script => ({ sourceURL: script.sourceURL, invoker: script.invoker,
              invokerType: script.invokerType, duration: script.duration, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) })
        }
        probe.scheduler.entries = probe.scheduler.entries.slice(-50)
      }
      const observer = new PerformanceObserver(list => record(list.getEntries()))
      observer.observe({ type })
      probe.schedulerObservers.push({ observer, record })
    }
    const fail = message => { if (probe.errors.length < 20) probe.errors.push(message) }
    const validateSample = (frame, timestamp, sampledAt) => {
      if (frame) {
        probe.frames += 1
        if (chart.dataset.chartLoading === 'true') probe.pendingFrames += 1
        if (probe.previousFrame !== null) {
          const gapMS = timestamp - probe.previousFrame
          probe.frameGaps.push(gapMS)
          probe.frameSamples.push({ at: sampledAt, gapMS })
        }
        probe.previousFrame = timestamp
      }
      const snapshot = chart.__chartSnapshot
      const svg = chart.querySelector('svg[data-rendered-inst]')
      if (!snapshot || !svg) { fail('The current chart SVG disappeared.'); return }
      const { timeframe } = snapshot
      const bars = chart.__chartRenderedBars ?? snapshot.bars
      const requestedEnd = Number(chart.dataset.chartRequestedEnd)
      if (Number.isFinite(requestedEnd) && requestedEnd > 0) {
        const previous = probe.requestCommits.at(-1)
        if (!previous || previous.end !== requestedEnd || previous.instId !== snapshot.instId || previous.timeframe !== timeframe) {
          probe.requestCommits.push({ at: sampledAt, rafSampledAt: frame ? sampledAt : null,
            end: requestedEnd, instId: snapshot.instId, timeframe })
        } else if (frame && previous.rafSampledAt === null) previous.rafSampledAt = sampledAt
      }
      if (frame && chart.dataset.chartLoading === 'true' && probe.pendingWindows.length < 10) probe.pendingWindows.push({
        at: sampledAt, end: snapshot.endHour, requestedEnd: chart.dataset.chartRequestedEnd, generation: snapshot.generation,
        bars: bars?.length, indicatorState: snapshot.indicatorState, priceState: snapshot.priceState,
        observedIndicators: bars?.filter(bar => bar.indicatorsObserved).length,
      })
      if (Array.isArray(bars)) {
        if (Number(svg.dataset.renderedStart) !== bars[0]?.hour || Number(svg.dataset.renderedEnd) !== bars.at(-1)?.hour) fail('SVG labels and the drawn range disagree.')
        if (Number(chart.dataset.chartStart) !== bars[0]?.hour || Number(chart.dataset.chartEnd) !== bars.at(-1)?.hour) fail('Header and actual plot refer to different ranges.')
        const requestedEnd = Number(chart.dataset.chartRequestedEnd)
        if (chart.dataset.chartLoading === 'false' && requestedEnd > 0 && requestedEnd !== snapshot.endHour) fail('The chart claims completion for a different requested range.')
      }
      // Plot geometry may change without a new snapshot (for example during
      // an effect). Check actual paths before the immutable-snapshot shortcut.
      if (Array.isArray(bars)) {
        let expected = expectedGeometry.get(bars)
        if (!expected || expected.intervalMS !== snapshot.intervalMS) {
          const firstAtLeft = bars[0]?.hour === bars.at(-1)?.hour - 95 * snapshot.intervalMS
          expected = { intervalMS: snapshot.intervalMS, curves: new Map(curveFields.map(field => {
            const samples = bars.filter(bar => typeof bar[field] === 'number' && Number.isFinite(bar[field])).length
            return [field, { samples, points: samples + (firstAtLeft && Number.isFinite(bars[0]?.[field]) ? 1 : 0) }]
          })) }
          expectedGeometry.set(bars, expected)
        }
        for (const field of curveFields) {
          const path = svg.querySelector(`[data-chart-indicator="${field}"]`), d = path?.getAttribute('d') ?? ''
          const previous = probe.geometry.get(field)
          if (previous?.d === d && previous.expected === expected) continue
          probe.geometry.set(field, { d, expected })
          const { samples, points: expectedPoints } = expected.curves.get(field)
          if (samples > 1 && !d) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost its ${field} SVG curve with ${samples} known samples.`)
          const clipId = svg.querySelector('[data-chart-wheel-content]')?.parentElement?.getAttribute('clip-path')?.match(/#([^)]*)/)?.[1]
          const clip = clipId ? svg.querySelector(`[id="${clipId}"] rect`) : null
          const coordinates = [...d.matchAll(/[ML]([\d.e+-]+)[ ,]+([\d.e+-]+)/gi)].map(point => Number(point[1]))
          if (clip) {
            const left = Number(clip.getAttribute('x')), right = left + Number(clip.getAttribute('width'))
            const inside = coordinates.filter(x => x >= left - .05 && x <= right + .05)
            const padding = expectedPoints > samples && inside.some(x => Math.abs(x - left) <= .05) ? 1 : 0
            if (inside.length !== samples + padding || coordinates.filter(x => x < left - .05).length > 1
              || coordinates.filter(x => x > right + .05).length > 1) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} ${field} SVG has ${coordinates.length} points; expected ${samples} visible samples and at most one adjacent sample per side.`)
          } else if (coordinates.length !== expectedPoints) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} ${field} SVG has ${coordinates.length} points for ${expectedPoints} known positions.`)
          if (/NaN|Infinity|undefined/.test(d)) fail('Nonfinite SVG geometry.')
        }
        if (requireMatureData) {
          for (const field of indicatorFields) if (!svg.querySelector(`[data-chart-indicator="${field}"]`)?.getAttribute('d')) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} has no ${field} SVG curve for mature local history.`)
          const expectsOI = bars.some(bar => Number.isFinite(oracles[timeframe]?.get(bar.hour)?.oi))
          const expectsTaker = bars.some(bar => Number.isFinite(oracles[timeframe]?.get(bar.hour)?.buy) && Number.isFinite(oracles[timeframe]?.get(bar.hour)?.sell))
          if ((requireWarmStatistics ? expectsOI : bars.some(bar => bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)))
            && svg.querySelector('[data-chart-oi]')?.getAttribute('data-chart-oi') !== 'complete') fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost complete observed OI geometry.`)
          if ((requireWarmStatistics ? expectsTaker : bars.some(bar => bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)))
            && svg.querySelector('[data-chart-taker]')?.getAttribute('data-chart-taker') !== 'complete') fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost complete observed Taker geometry.`)
        }
      }
      if (snapshot === probe.previousSnapshot && bars === probe.previousBars) {
        if (frame && probe.commits.at(-1)?.rafSampledAt === null) probe.commits.at(-1).rafSampledAt = sampledAt
        return
      }
      probe.previousSnapshot = snapshot
      probe.previousBars = bars
      probe.paints += 1
      const intervalMS = series[timeframe]?.intervalMS
      if (!Array.isArray(bars)) { fail('The rendered snapshot has no bars.'); return }
      probe.minimumBars = Math.min(probe.minimumBars, bars.length)
      // A mutation is a React commit; the following RAF callback samples that
      // DOM state. This does not prove that Electron's compositor presented it.
      probe.commits.push({ at: sampledAt, rafSampledAt: frame ? sampledAt : null, end: snapshot.endHour, instId: snapshot.instId, timeframe, phase: probe.phase })
      probe.quality.push({ phase: probe.phase, end: snapshot.endHour, timeframe, indicators: bars.filter(bar => indicatorFields.every(field => Number.isFinite(bar[field]))).length,
        oi: bars.filter(bar => Number.isFinite(bar.oi)).length, taker: bars.filter(bar => Number.isFinite(bar.buy) && Number.isFinite(bar.sell)).length })
      if (bars.length !== 96) fail(`Rendered ${bars.length} bars for ${timeframe}.`)
      if (snapshot.instId !== instId || svg.dataset.renderedInst !== instId) fail('Mixed instrument in the rendered surface.')
      if (svg.dataset.renderedTimeframe !== timeframe) fail('SVG and snapshot timeframes disagree.')
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index]
        if (!bar.confirmed) continue // Forming values are checked against the live payload, independently of the closed-bar oracle.
        const expected = oracles[timeframe]?.get(bar.hour)
        if (!expected) { fail(`Unexpected ${timeframe} timestamp ${bar.hour}.`); continue }
        if (index && bar.hour - bars[index - 1].hour !== intervalMS) fail(`Noncontiguous ${timeframe} candles at ${bar.hour}.`)
        const key = `${timeframe}:${snapshot.generation}:${bar.hour}`, previous = probe.known.get(key)
        const samePrice = previous && ['open', 'high', 'low', 'close'].every(field => previous[field] === bar[field])
        if (samePrice) for (const field of [...indicatorFields, ...statisticFields]) {
          if (Number.isFinite(previous[field]) && !Number.isFinite(bar[field])) fail(`${probe.phase}: ${key} downgraded previously drawn ${field} from ${previous[field]} to ${bar[field]} without a price change.`)
        }
        probe.known.set(key, { ...bar })
        const expectedOI = Number.isFinite(expected.oi)
        const expectedTaker = Number.isFinite(expected.buy) && Number.isFinite(expected.sell)
        if (requireWarmStatistics && expectedOI && !(bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1))) fail(`${probe.phase}: ${key} has fixture-known OI but it is not observed in the warm-statistics contract.`)
        if (requireWarmStatistics && expectedTaker && !(bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2))) fail(`${probe.phase}: ${key} has fixture-known Taker values but they are not observed in the warm-statistics contract.`)
        if (!bar.indicatorsObserved) for (const field of indicatorFields) {
          if (bar[field] !== null) fail(`${probe.phase}: ${key} retained ${field} without an observed calculation for its canonical generation.`)
        }
        for (const field of fields.filter(field => {
          if (['open', 'high', 'low', 'close'].includes(field)) return true
          if (field === 'oi') return (requireWarmStatistics && Number.isFinite(expected.oi))
            || (bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1))
          if (field === 'buy' || field === 'sell') return (requireWarmStatistics && Number.isFinite(expected[field]))
            || (bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2))
          if (requireMatureData && Number.isFinite(expected[field])) return true
          return bar.indicatorsObserved
        })) {
          const actual = bar[field], wanted = expected[field]
          // A new canonical prefix can legitimately change recursive values and
          // its warmup boundary. Deferred mode checks exact local inputs after
          // replay settles; it never substitutes the unseen provider archive.
          if (indicatorValidation !== 'fixture' && indicatorFields.includes(field)) {
            if (!Number.isFinite(actual) && !(indicatorValidation === 'deferred-canonical' && actual === null)) {
              fail(`${probe.phase}: ${timeframe} ${bar.hour} ${field} retracted to ${actual} during prefix acquisition.`)
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
      const oiCount = bars.filter(bar => bar.oi !== null).length
      const takerCount = bars.filter(bar => bar.buy !== null && bar.sell !== null).length
      const buyRectangles = bars.filter(bar => bar.buy !== null && bar.buy > 0).length
      const sellRectangles = bars.filter(bar => bar.sell !== null && bar.sell > 0).length
      if (Number(chart.dataset.chartOiSamples) !== oiCount || Number(chart.dataset.chartTakerSamples) !== takerCount) fail('Published statistics sample counts disagree with the actual snapshot.')
      const oi = svg.querySelector('[data-chart-oi]')
      const taker = svg.querySelector('[data-chart-taker]')
      if (Number(oi?.getAttribute('data-chart-oi-samples')) !== oiCount) fail('The actual OI geometry does not cover the snapshot.')
      if (Number(taker?.querySelector('[data-chart-taker-buy-samples]')?.getAttribute('data-chart-taker-buy-samples')) !== buyRectangles) fail('The actual Taker buy geometry does not cover the snapshot.')
      if (Number(taker?.querySelector('[data-chart-taker-sell-samples]')?.getAttribute('data-chart-taker-sell-samples')) !== sellRectangles) fail('The actual Taker sell geometry does not cover the snapshot.')
      for (const path of svg.querySelectorAll('path[d]')) if (/NaN|Infinity|undefined/.test(path.getAttribute('d'))) fail('Nonfinite SVG geometry.')
    }
    const sample = (frame = false, timestamp) => {
      const sampledAt = performance.now()
      try { validateSample(frame, timestamp ?? sampledAt, sampledAt) }
      finally { probe.validationSamples.push({ at: sampledAt, durationMS: performance.now() - sampledAt }) }
    }
    probe.observer = new MutationObserver(() => sample())
    probe.observer.observe(chart, { subtree: true, childList: true, attributes: true })
    const frame = timestamp => {
      if (!probe.active) return
      sample(true, timestamp)
      probe.raf = requestAnimationFrame(frame)
    }
    sample()
    probe.raf = requestAnimationFrame(frame)
    window.__chartPaintProbe = probe
  }, { instId: fixture.instId, series: fixture.series, requireMatureData, requireWarmStatistics, indicatorValidation })
}

export async function finishPaintProbe(page) {
  const report = await page.evaluate(() => {
    const probe = window.__chartPaintProbe
    if (!probe) throw new Error('No chart paint probe was installed.')
    probe.active = false
    cancelAnimationFrame(probe.raf)
    probe.observer.disconnect()
    for (const { observer, record } of probe.schedulerObservers) { record(observer.takeRecords()); observer.disconnect() }
    delete window.__chartPaintProbe
    return {
      frames: probe.frames, pendingFrames: probe.pendingFrames, pendingWindows: probe.pendingWindows, paints: probe.paints, minimumBars: probe.minimumBars,
      violations: probe.errors, commits: probe.commits, quality: probe.quality, scheduler: probe.scheduler,
      frameGaps: probe.frameGaps,
      droppedFrames: probe.frameGaps.filter(gap => gap > 25).length,
      probeValidationSamples: probe.validationSamples.length,
      totalProbeValidationMS: Number(probe.validationSamples.reduce((sum, sample) => sum + sample.durationMS, 0).toFixed(3)),
      validationDurations: probe.validationSamples.map(sample => sample.durationMS),
    }
  })
  const frameGaps = summarizeLatencySamples(report.frameGaps)
  const validation = summarizeLatencySamples(report.validationDurations)
  delete report.frameGaps
  delete report.validationDurations
  return { ...report, rafSampleCount: report.frames,
    p95FrameGapMS: frameGaps.p95MS, maxFrameGapMS: frameGaps.maxMS,
    p95FrameGapSampleCount: frameGaps.sampleCount, p95FrameGapSampleMinimum: frameGaps.p95SampleMinimum,
    p99FrameGapMS: frameGaps.p99MS, p99FrameGapSampleMinimum: frameGaps.p99SampleMinimum,
    p95ProbeValidationMS: validation.p95MS, maxProbeValidationMS: validation.maxMS,
    p95ProbeValidationSampleMinimum: validation.p95SampleMinimum }
}

export function assertCompletePaints(report) {
  assert.ok(report.frames > 0, 'The acceptance probe must observe renderer animation frames.')
  assert.ok(report.paints > 0, 'The acceptance probe must inspect the real rendered snapshot.')
  assert.equal(report.minimumBars, 96, 'Every observed window must contain 96 candles.')
  assert.deepEqual(report.violations, [], 'A rendered window was incomplete, mixed, or mathematically incorrect.')
}

export async function wheelBurst(page, { frames = 1, eventsPerFrame = 1, deltaY = 12, deltaX = 0, deltaMode = 0 }) {
  return page.evaluate(async options => {
    const plot = document.querySelector('[data-chart-plot]')
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

export async function measureChartIntentLatency(page, { inputs, targets, requireForeground = true, milestone = 'rendered-window' }) {
  assert.ok(['rendered-window', 'requested-cursor'].includes(milestone), 'Unknown chart intent acknowledgment milestone.')
  const commitKey = milestone === 'requested-cursor' ? 'requestCommits' : 'commits'
  const latestInput = inputs.at(-1)
  const expectedEnd = targets.at(-1)
  await page.waitForFunction(({ latestInput, expectedEnd, commitKey }) => window.__chartPaintProbe?.[commitKey].some(commit =>
    commit.end === expectedEnd && commit.instId === window.__chartPaintProbe.instId
    && commit.timeframe === window.__chartPaintProbe.expectedTimeframe
    && commit.at >= latestInput && commit.rafSampledAt !== null), { latestInput, expectedEnd, commitKey })
  const observation = await page.evaluate(({ inputs, targets, requireForeground, commitKey }) => {
    if (requireForeground && (document.visibilityState !== 'visible' || !document.hasFocus())) throw new Error('Foreground renderer timing lost its visible, focused window.')
    const probe = window.__chartPaintProbe, commits = probe[commitKey]
    for (const { observer, record } of probe.schedulerObservers) record(observer.takeRecords())
    const bursts = inputs.map(input => probe.inputBursts.find(burst => burst.lastAt === input))
    if (bursts.some(burst => !burst)) throw new Error('Every measured wheel burst must include its first and final input timestamps.')
    const latestBurst = bursts.at(-1), startedAt = bursts[0].firstAt
    return {
      visibility: document.visibilityState, focused: document.hasFocus(), commits, instId: probe.instId, timeframe: probe.expectedTimeframe,
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
      documentVisibility: observation.visibility, documentFocused: observation.focused,
      scheduler: observation.scheduler.filter(entry => entry.startTime <= endAt),
      committedInputs: accounted.filter(intent => intent.status === 'committed').length,
      supersededInputs: accounted.filter(intent => intent.status === 'coalesced').length,
      unaccountedInputs: accounted.filter(intent => intent.status === 'unaccounted').map(({ index, target }) => ({ index, target })),
      intents: accounted.map(({ index, target, status, supersededBy, latencyMS }) => ({ index, target, status, supersededBy, latencyMS })),
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
  }
  if (report.unaccountedInputs.length) {
    throw new Error(`Chart intents disappeared without a committed target or coalescing successor: ${JSON.stringify(report.unaccountedInputs)}`)
  }
  if (requireForeground) {
    try { assertScrollResponsiveness(report) }
    catch (error) { throw new Error(`${error.message}\nScroll timing: ${JSON.stringify(report)}`, { cause: error }) }
  }
  return report
}

export async function waitForLocalHistory(electron, page, fixture, timeframe = fixture.timeframe, { requireIndicators = false } = {}) {
  await wheelBurst(page, { deltaY: 12 })
  const deadline = Date.now() + 20_000
  const intervalMS = fixture.series[timeframe].intervalMS, warmEnd = fixture.end - intervalMS
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
      const chart = document.querySelector(`[data-chart-inst="${instId}"]`), snapshot = chart?.__chartSnapshot
      const bars = chart?.__chartRenderedBars ?? snapshot?.bars
      const fields = ['vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
      return snapshot?.instId === instId && snapshot.timeframe === timeframe && snapshot.endHour === end
        && snapshot.indicatorState === 'ready' && chart.dataset.chartLoading === 'false' && bars?.length === 96
        && bars.every(bar => bar.indicatorsObserved && fields.every(field => Number.isFinite(bar[field])))
    }, { instId: fixture.instId, timeframe, end: warmEnd }, { timeout: Math.max(1, deadline - Date.now()) })
  }
  await page.evaluate(async () => { for (let frame = 0; frame < 2; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
  await wheelBurst(page, { deltaY: -12 })
  await waitForRendered(page, fixture, timeframe)
  return resident
}

export function separateSourceMaintenance(sourceRequests, fixture) {
  const historical = [], historicalExtensions = [], currentMaintenance = []
  for (const request of sourceRequests) {
    const parameters = request.parameters ?? {}
    const after = Number(parameters.after), limit = Number(parameters.limit)
    const intervalMS = fixture.series[parameters.bar]?.intervalMS
    const latestCandles = request.path === '/market/candles' && limit === 2 && Number.isFinite(intervalMS)
      && parameters.after == null && parameters.before == null
    // Ranking and selected-chart repairs request at most one current viewport.
    // Exclude them only when every possible returned slot is later than the
    // fixture. An overlapping, unbounded or ambiguous cursor still fails.
    const currentCandles = request.path === '/market/history-candles' && Number.isSafeInteger(limit) && limit > 0 && limit <= 96
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
      if (response?.instId !== instId || !['5m', '15m', '1H'].includes(response.timeframe) || !Array.isArray(response.bars) || response.bars.length <= 96) return
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
      return first === null ? response : { ...response, bars: response.bars.filter(bar => bar.hour >= first) }
    }
    const extension = (response, kind, startedAt, readCompletedAt = Date.now()) => {
      const previousFloor = floor(response)
      if (!probe.extendHistory || previousFloor === null || !response.bars.length) return null
      if (!probe.delayFloors.has(response.timeframe)) probe.delayFloors.set(response.timeframe, previousFloor)
      const delayFloor = probe.delayFloors.get(response.timeframe)
      if (response.bars[0].hour >= delayFloor) return null
      const record = { kind, instId: response.instId, timeframe: response.timeframe, endHour: response.endHour,
        startedAt, readCompletedAt, completedAt: null, previousFloor, first: response.bars[0].hour, end: response.bars.at(-1).hour, bars: response.bars.length }
      probe.extensions.push(record)
      return record
    }
    const delivered = (response, record) => {
      if (record) {
        probe.deliveredFloors.set(response.timeframe, Math.min(probe.deliveredFloors.get(response.timeframe), response.bars[0].hour))
        Object.assign(record, { completedAt: Date.now(), first: response.bars[0].hour, end: response.bars.at(-1).hour, bars: response.bars.length })
      }
      const result = clip(response)
      rememberHistory(result)
      return result
    }
    contents.send = function (channel, ...args) {
      if (channel !== 'radar:chart-prepared') return originalSend.call(this, channel, ...args)
      const response = args[0]
      if (response?.instId === instId && Array.isArray(response.bars)) {
        probe.preparedPushes += 1
        probe.preparedPushBars += response.bars.length
        if (response.bars.length > 96) {
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
        const entry = pending ?? { args, record, timer: null }
        if (pending) {
          clearTimeout(entry.timer); probe.timers.delete(entry.timer)
          entry.args = args
          entry.record.readCompletedAt = record.readCompletedAt
          probe.extensions.pop()
        }
        probe.pendingPushes.set(response.timeframe, entry)
        const timer = setTimeout(() => {
          probe.timers.delete(timer); probe.pendingPushes.delete(response.timeframe)
          if (probe.closed) return
          entry.args[0] = delivered(entry.args[0], entry.record)
          originalSend.call(contents, channel, ...entry.args)
        }, historicalDelayMS)
        entry.timer = timer
        probe.timers.add(timer)
        return
      }
      args[0] = delivered(response, record)
      return originalSend.call(this, channel, ...args)
    }
    const released = new Promise(resolve => { probe.release = resolve })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartFocus) {
        probe.focusCalls.push({ ...value.chartFocus, at: Date.now() })
        return original(event, value)
      }
      if (value.chartWindow) probe.legacyWindowCalls += 1
      const kind = value.chartHistory?.instId === instId ? 'history' : value.chartLocal?.instId === instId ? 'local' : null
      if (!kind) {
        const response = await original(event, value)
        return value.chartUniverse ? { ...response, frames: response.frames.map(clip) } : response
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
        const response = await original(event, value)
        call.readCompletedAt = Date.now()
        if (kind === 'history' && probe.holdHistorical && !probe.held && Number.isFinite(query.endHour)) {
          held = probe.held = true; probe.heldCall = call; probe.callsAtHold = probe.calls.length
          await released
        } else if (kind === 'local' && probe.holdLocal) await released
        const record = extension(response, kind, call.startedAt, call.readCompletedAt)
        if (record && historicalDelayMS > 0) await new Promise(resolve => setTimeout(resolve, historicalDelayMS))
        const result = delivered(response, record)
        call.bars = result?.bars.length ?? 0
        call.first = result?.bars[0]?.hour ?? null; call.end = result?.bars.at(-1)?.hour ?? null
        call.delayedExtension = Boolean(record)
        if (kind === 'history') {
          probe.transferredHistoryBars += call.bars
          probe.historyResponses.push({ ...query, bars: call.bars, first: call.first, end: call.end })
        }
        return result
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
  const foreground = offscreen ? null : await foregroundPaintWindow(electron, page)
  if (offscreen) {
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() }
    })
    assert.deepEqual(native, { visible: false, focused: false, offscreen: true })
  }
  try {
    await installRequestProbe(electron, fixture.instId, { historicalDelayMS })
    await openChart(page, fixture)
    // Delay only facts beyond the genuinely admitted range. Silently clipping
    // already delivered facts gives the backend a false view of client runway.
    await waitForLocalHistory(electron, page, fixture, fixture.timeframe, { requireIndicators: true })
    await waitForRendered(page, fixture)
    const initial = await readRequestProbe(electron)
    const admitted = initial.historyFrames[fixture.timeframe]
    assert.ok(admitted && admitted.calculated === admitted.bars)
    assert.equal(admitted.end, fixture.end, 'The initial delivered range must end at the fixture latest candle.')
    const initialHistoryBars = (fixture.end - admitted.first) / fixture.intervalMS + 1
    assert.equal(initialHistoryBars, admitted.bars, 'The initial delivered reserve must contain every native candle slot.')
    assert.ok(initialHistoryBars > 96 && initialHistoryBars <= 1536)
    assert.ok(frames * candlesPerFrame > initialHistoryBars - 95, 'The gesture must cross the actual delivered boundary.')
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    assert.deepEqual(initial.extensions, [], 'Initial preparation must finish before delayed delivery begins.')
    await electron.evaluate((_, { timeframe, first }) => {
      globalThis.__chartRequestProbe.deliveredFloors.set(timeframe, first)
    }, { timeframe: fixture.timeframe, first: admitted.first })
    await startPaintProbe(page, fixture)
    await electron.evaluate(() => { globalThis.__chartRequestProbe.extendHistory = true })
    const inputs = await wheelBurst(page, { frames, deltaY: 24 })
    const expectedEnd = fixture.end - frames * candlesPerFrame * fixture.intervalMS
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    const latency = await measureChartIntentLatency(page, {
      inputs, targets: inputs.map((_, index) => fixture.end - (index + 1) * candlesPerFrame * fixture.intervalMS), requireForeground: !offscreen,
    })
    const paint = await finishPaintProbe(page)
    assertCompletePaints(paint)
    const requests = await readRequestProbe(electron)
    assert.equal(paint.pendingFrames, 0, `Latency-covered scrolling must never expose an unprepared requested viewport: ${JSON.stringify({ calls: requests.calls, sourceRequests: requests.sourceRequests, historyResponses: requests.historyResponses.length, inputDurationMS: inputs.at(-1) - inputs[0], pendingFrames: paint.pendingFrames, pendingWindows: paint.pendingWindows })}`)
    if (!offscreen) assert.ok(latency.maxInputToRafSampleMS < 100, `A wheel intent took ${latency.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target. ${JSON.stringify(latency)}`)
    const extensions = requests.extensions.filter(record => record.completedAt !== null && record.startedAt >= timeOrigin + inputs[0])
    const first = extensions[0]
    assert.ok(first, 'Backend reserve preparation must extend the delivered history during the gesture.')
    const requestTime = first.startedAt - timeOrigin
    const responseTime = first.completedAt - timeOrigin
    assert.ok(requestTime >= inputs[0] && responseTime < inputs.at(-1),
      'A delayed history delivery must start and finish while wheel input is still arriving.')
    const observedDeliveryMS = first.completedAt - first.readCompletedAt
    assert.ok(observedDeliveryMS >= historicalDelayMS, 'The actual prepared data must spend the full configured interval behind the delivery gate.')
    const initialFirst = fixture.end - (initialHistoryBars - 1) * fixture.intervalMS
    assert.ok(first.first < initialFirst && first.end >= initialFirst && first.bars > 96,
      'A real bulk response must extend continuously across the original delivered boundary.')
    const crossingIndex = Math.ceil((initialHistoryBars - 95) / candlesPerFrame) - 1
    assert.ok(responseTime < inputs[crossingIndex], 'Backend reserve data must reach the renderer before the first viewport crosses the original boundary.')
    const inputsAtRequest = inputs.filter(input => input <= requestTime).length
    const runwayAtRequest = initialHistoryBars - 96 - inputsAtRequest * candlesPerFrame
    assert.ok(runwayAtRequest >= 192, `Only ${runwayAtRequest} resident candles remained when backend history delivery started.`)
    assert.ok(requests.maxHistoricalActive <= 2, 'Continuous input must keep durable reads within two independent lanes.')
    assert.equal(requests.legacyWindowCalls, 0)
    const delayedReads = requests.calls.filter(call => call.delayedExtension)
    const readBudget = 2 * (Math.ceil((inputs.at(-1) - inputs[0]) / historicalDelayMS) + 1)
    assert.ok(delayedReads.length <= readBudget, `A cold-boundary traversal admitted ${delayedReads.length} delayed disk reads (budget ${readBudget}).`)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    assert.deepEqual(sources.historical, [], 'Prefetch must reuse persisted source candles and statistics within the latency test range.')
    return {
      foregroundWindow: foreground?.native, environment: foreground?.environment, idleFrameCadence: foreground?.idleFrameCadence,
      timingScope: offscreen
        ? { presentation: 'offscreen', wallTime: 'input-to-renderer-RAF values are diagnostics; no native display deadline is inferred', frames: 'all renderer RAF and pending-frame assertions remain enforced' }
        : { presentation: 'native foreground', wallTime: '100 ms maximum intent-to-renderer-RAF deadline enforced', frames: 'all renderer RAF and pending-frame assertions remain enforced' },
      nativePaintMeasured: false, foregroundRafObservationMeasured: !offscreen,
      initialHistoryBars, initialHistoryFirst: admitted.first, historicalDelayMS, continuousWheelFrames: frames,
      scrolledCandles: frames * candlesPerFrame, crossedInitialBoundary: true,
      runwayAtRequest, deliveredHistoryBars: first.bars, observedHistoryDeliveryMS: observedDeliveryMS,
      prefetchStartedDuringGesture: true, prefetchCompletedDuringGesture: true,
      historicalRequests: delayedReads.length, delayedBackendPushes: extensions.filter(record => record.kind === 'push').length,
      maxConcurrentHistoricalRequests: requests.maxHistoricalActive,
      olderSourceExtensions: sources.historicalExtensions.length,
      repeatedSourceDownloads: sources.historical.length,
      ...latency, ...paint, commits: paint.commits.length,
    }
  } finally {
    try { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
    finally { await foreground?.restore() }
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
  const foreground = offscreen ? null : await foregroundPaintWindow(electron, page)
  const native = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() }
  })
  assert.deepEqual(native, { visible: !offscreen, focused: !offscreen, offscreen }, 'Cold missing-window measurement must use its declared window presentation.')
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  const fixture = await probe({ action: 'coldBoundaryInstall', timeframe, scenario: 'full-missing-window', sourceDelayMS: 1_800, failNearestCandles: failSource })
  let probeInstalled = false, paintStarted = false
  try {
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
    await page.waitForFunction(({ instId, end }) => Number(document.querySelector(`[data-chart-inst="${instId}"]`)?.dataset.chartRequestedEnd) === end,
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
      inputs: latestInputs, targets: latestTargets, requireForeground: !offscreen, milestone: 'requested-cursor',
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
        const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
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
        const snapshot = document.querySelector(`[data-chart-inst="${instId}"]`)?.__chartSnapshot
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
    const paint = await finishPaintProbe(page)
    paintStarted = false
    assertCompletePaints(paint)
    if (!offscreen) assert.ok(paint.maxFrameGapMS < 100,
      `A completely absent viewport caused a renderer RAF stall of at least 100 ms: ${JSON.stringify({ maxFrameGapMS: paint.maxFrameGapMS, scheduler: paint.scheduler })}`)
    // End the timing phase at the terminal UI state. Reading and independently
    // checking its SQLite prefix is correctness verification outside that phase.
    const observedFieldOracle = await assertColdCanonicalViewport(electron, page, fixture, finalWindow.renderedEnd)
    assert.equal(finalWindow.indicatorState, observedFieldOracle.expectedIndicatorState,
      'Indicator readiness must describe the available SQLite prefix, including its real warmup boundary.')
    const requests = await readRequestProbe(electron)
    assert.ok(requests.maxHistoricalActive <= 2, `Cold acquisition exceeded the two historical read lanes: ${JSON.stringify(requests)}`)
    assert.equal(requests.legacyWindowCalls, 0)
    const sourceKeys = sourceSnapshot.requests.map(request => `${request.source}:${request.from}:${request.through}`)
    const duplicatePages = sourceKeys.length - new Set(sourceKeys).size
    assert.ok(sourceSnapshot.requests.length <= 8, `A single cold viewport admitted too many source requests: ${JSON.stringify(sourceSnapshot.requests)}`)
    assert.ok(duplicatePages <= (failSource ? 1 : 0), `The same cold source page was requested repeatedly: ${JSON.stringify(sourceSnapshot.requests)}`)
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
      nativePaintMeasured: false, rendererRafSamples: paint.frames, ...paint }
  } finally {
    if (paintStarted) await finishPaintProbe(page)
    if (probeInstalled) { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
    await probe({ action: 'coldBoundaryRemove' })
    await foreground?.restore()
  }
}

async function readColdWindowState(page, instId) {
  return page.locator(`[data-chart-inst="${instId}"]`).evaluate(chart => {
    const svg = chart.querySelector('svg[data-rendered-inst]')
    return { loading: chart.dataset.chartLoading === 'true', incomplete: chart.dataset.chartIncomplete === 'true',
      requestedEnd: Number(chart.dataset.chartRequestedEnd), completedEnd: Number(chart.dataset.chartCompletedEnd),
      renderedEnd: Number(svg?.dataset.renderedEnd), candleState: chart.dataset.chartCandleState,
      statisticsState: chart.dataset.chartStatisticsState, oiState: chart.dataset.chartOiState,
      takerState: chart.dataset.chartTakerState,
      indicatorState: chart.querySelector('[data-chart-status]')?.dataset.chartIndicatorState ?? null,
      alert: document.querySelector('[role="alert"]')?.textContent ?? '' }
  })
}

async function assertColdCanonicalViewport(electron, page, fixture, endHour) {
  const timeframe = fixture.timeframe
  const recovered = await page.locator(`[data-chart-inst="${fixture.instId}"]`).evaluate(chart => {
    const snapshot = chart.__chartSnapshot
    return { endHour: snapshot?.endHour, bars: (chart.__chartRenderedBars ?? snapshot?.bars ?? []).map(bar => ({
      ...bar,
      oiObserved: bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1),
      takerObserved: bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2),
    })) }
  })
  assert.equal(recovered.endHour, endHour)
  assert.equal(recovered.bars.length, 96)
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
      for (const field of indicatorFieldsObserved) assert.equal(bar[field], null,
        `${timeframe} ${bar.hour} must not retain an old ${field} curve while that indicator is unobserved.`)
    }
    if (bar.oiObserved) { observedOIBars += 1; assertCanonical(bar.oi, expected, 'oi') }
    else assert.equal(bar.oi, null, `${timeframe} ${bar.hour} must keep unobserved OI explicitly missing.`)
    if (bar.takerObserved) {
      observedTakerBars += 1
      assertCanonical(bar.buy, expected, 'buy'); assertCanonical(bar.sell, expected, 'sell')
    } else {
      assert.equal(bar.buy, null, `${timeframe} ${bar.hour} must keep unobserved taker buys explicitly missing.`)
      assert.equal(bar.sell, null, `${timeframe} ${bar.hour} must keep unobserved taker sells explicitly missing.`)
    }
  }
  const expectedIndicatorState = recovered.bars.every(bar => indicatorFieldsObserved.every(field => Number.isFinite(oracle.get(bar.hour)?.[field]))) ? 'ready' : 'unavailable'
  return { priceBars: recovered.bars.length, indicatorBars: observedIndicatorBars, oiBars: observedOIBars, takerBars: observedTakerBars, expectedIndicatorState,
    checksCanonicalValues: true, unobservedFieldsRemainNull: true }
}

async function nativeColdBoundary(electron, page, { timeframe = '15m', offscreen = false } = {}) {
  const probe = value => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), value)
  const fixture = await probe({ action: 'coldBoundaryInstall', timeframe })
  let paintStarted = false
  let cdp, beforeMetrics
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
    await startPaintProbe(page, fixture, { indicatorValidation: 'finite' })
    paintStarted = true
    const approachDistance = fixture.initialHistoryBars - 96 - 256
    const approachInputs = await wheelBurst(page, { deltaY: approachDistance * 12 })
    await waitForRendered(page, fixture, timeframe, fixture.end - approachDistance * fixture.intervalMS)
    const deadline = Date.now() + 10_000
    let sources
    do {
      sources = await probe({ action: 'coldBoundaryRead' })
      if (sources.requests.some(request => request.source === 'candles' && request.completedAt !== null)
        && sources.requests.some(request => request.source === 'candles' && request.held && request.completedAt === null)
        && sources.requests.some(request => request.source !== 'candles' && request.held && request.completedAt === null)) break
      assert.ok(Date.now() < deadline, `Native prefetch did not publish its nearest page before the held reserve: ${JSON.stringify(sources)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    const inputs = await wheelBurst(page, { deltaY: (fixture.targetDistance - approachDistance) * 12 })
    await waitForTargetSnapshot(page, fixture, timeframe, fixture.targetEnd)
    const initialTarget = await page.locator(`[data-chart-inst="${fixture.instId}"]`).evaluate(chart => ({
      loading: chart.dataset.chartLoading === 'true', incomplete: chart.dataset.chartIncomplete === 'true',
      renderedBars: Number(chart.dataset.chartRenderedBars), end: Number(chart.dataset.chartCompletedEnd),
    }))
    assert.equal(initialTarget.renderedBars, 96)
    assert.equal(initialTarget.end, fixture.targetEnd)
    const indicatorFields = ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
    await page.waitForFunction(({ targetEnd, firstMissingEnd, indicatorFields }) => {
      const snapshot = document.querySelector('[data-chart-inst]')?.__chartSnapshot
      const missing = snapshot?.bars.find(bar => bar.hour === firstMissingEnd)
      return snapshot?.endHour === targetEnd && snapshot.bars.length === 96
        && snapshot.bars.every(bar => indicatorFields.every(field => Number.isFinite(bar[field])))
        && missing && missing.oi === null && missing.buy === null && missing.sell === null
    }, { targetEnd: fixture.targetEnd, firstMissingEnd: fixture.firstMissingEnd, indicatorFields }, { timeout: 10_000 })
    const observedFieldOracle = await assertColdCanonicalViewport(electron, page, fixture, fixture.targetEnd)
    const latency = offscreen ? null : await measureChartIntentLatency(page, { inputs, targets: [fixture.targetEnd] })
    if (latency) assert.ok(latency.maxInputToRafSampleMS < 100, `A boundary intent took ${latency.maxInputToRafSampleMS} ms to reach its exact or coalesced chart target. ${JSON.stringify(latency)}`)
    sources = await probe({ action: 'coldBoundaryRead' })
    const nearest = sources.requests.find(request => request.source === 'candles' && request.through === fixture.firstMissingEnd)
    assert.ok(nearest?.completedAt !== null && nearest?.completedAt !== undefined,
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
    await page.waitForFunction(({ instId, timeframe, end }) => window.__chartPaintProbe?.commits.some(commit =>
      commit.instId === instId && commit.timeframe === timeframe && commit.end === end && Number.isFinite(commit.rafSampledAt)),
    { instId: fixture.instId, timeframe, end: fixture.targetEnd }, { timeout: 5000 })
    const paint = await finishPaintProbe(page)
    paintStarted = false
    assertCompletePaints(paint)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    const targetCommit = paint.commits.find(commit => commit.end === fixture.targetEnd && commit.instId === fixture.instId
      && commit.timeframe === timeframe && Number.isFinite(commit.rafSampledAt))
    assert.ok(targetCommit, 'The target chart snapshot must reach a renderer RAF sample.')
    const nativePageToRafSampleMS = offscreen ? null : Number((timeOrigin + targetCommit.rafSampledAt - nearest.completedAt).toFixed(3))
    if (nativePageToRafSampleMS !== null) assert.ok(nativePageToRafSampleMS < 1_000, `The nearest native page waited ${nativePageToRafSampleMS} ms to reach a renderer RAF sample despite its complete prices and indicator warmup.`)
    const afterMetrics = cdp ? Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value])) : null
    const offscreenObservation = afterMetrics ? {
      rendererTaskMS: Number(((afterMetrics.TaskDuration - beforeMetrics.TaskDuration) * 1000).toFixed(3)),
      rendererScriptMS: Number(((afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration) * 1000).toFixed(3)),
      nativePaintMeasured: false,
    } : undefined
    return { timeframe, initialHistoryBars: fixture.initialHistoryBars, sourceDelayMS: fixture.sourceDelayMS,
      initiallyMissingCandles: 96 - before.length, nearestSourceCandles: Number(nearest.parameters.limit),
      nativePaintMeasured: false, foregroundRafObservationMeasured: !offscreen, rendererTargetObserved: true,
      ...(nativePageToRafSampleMS === null ? {} : { nativePageToRafSampleMS }),
      nativeSourceRequests: sources.requests.length, heldReservePages: heldReserve.length, heldStatisticsPages: heldStatistics.length,
      targetSnapshotShownWhilePending: initialTarget.loading,
      targetPriceOrIndicatorIncompleteAtSnapshot: initialTarget.incomplete,
      observedFieldOracle,
      targetSnapshotObservedBeforeReserveAndStatistics: true,
      duplicateSourcePages: 0,
      ...(offscreenObservation ? { offscreenObservation } : {}),
      ...(latency ?? {}), ...paint, commits: paint.commits.length, approachInput: approachInputs[0] }
  } finally {
    await cdp?.detach()
    if (paintStarted) await finishPaintProbe(page)
    await probe({ action: 'coldBoundaryRemove' })
  }
}
