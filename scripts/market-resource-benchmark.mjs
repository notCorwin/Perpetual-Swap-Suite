import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { _electron } from 'playwright'
import { offscreenChartWindow, selectTimeframe } from './chart-acceptance.mjs'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { assertResourceDeliveryBudget, summarizeResourceDelivery } from './resource-acceptance.mjs'

const { values } = parseArgs({ options: { offscreen: { type: 'boolean' }, ticks: { type: 'string' }, 'cadence-ms': { type: 'string' } } })
const offscreen = values.offscreen === true
const ticks = Number(values.ticks ?? 60), cadenceMS = Number(values['cadence-ms'] ?? 500)
if (!Number.isSafeInteger(ticks) || ticks < 60 || ticks > 1200 || !Number.isSafeInteger(cadenceMS) || cadenceMS < 20 || cadenceMS > 2000) throw new Error('Resource workloads require 60–1200 ticks and a 20–2000 ms cadence.')
if (!offscreen) requireForegroundTests()

const root = fileURLToPath(new URL('..', import.meta.url))
const reportPath = resolve(root, process.env.PERPETUAL_SWAP_RESOURCE_REPORT ?? '.build/resource-benchmark.json')
const userData = await mkdtemp(join(tmpdir(), 'perp-market-resources-'))
const report = { generatedAt: new Date().toISOString(), mode: 'real Electron renderer, worker backend and SQLite; synthetic native intake',
  nativePresentationMeasured: false, timing: 'Scheduled synthetic input to SVG commit and next RAF opportunity; no native compositor presentation.',
  clock: 'Epoch-origin monotonic performance clocks for source schedule/receipt and renderer input/commit/RAF; 2 ms origin precision tolerance with raw clock deltas retained.',
  externalWebSocketTransportMeasured: false, externalNetworkMeasured: false, receiveToFrameBudgetMS: offscreen ? null : 100,
  samples: [], switches: [], history: [], memorySamples: [], viewIntents: [], outcome: 'running' }
let electron, page, stopped = false
const probe = input => electron.evaluate((_electron, value) => globalThis.__marketBackend.probe(value), input)

try {
  const launchedAt = Date.now()
  electron = await _electron.launch({ args: ['.'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  report.windowBeforeBenchmark = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused() } })
  // Test-mode windows start hidden. A visible-paint budget requires an actual
  // foreground window rather than the OS cadence of an occluded renderer.
  if (offscreen) report.offscreenWindow = await offscreenChartWindow(electron)
  else {
    await electron.evaluate(({ BrowserWindow, app }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); app.focus({ steal: true }); window.focus() })
    await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), null, { timeout: 5_000 })
  }
  report.documentVisibility = await page.evaluate(() => ({ state: document.visibilityState, focused: document.hasFocus() }))
  report.benchmarkWindow = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused() } })
  assert.equal(report.benchmarkWindow.visible, !offscreen, 'The benchmark must use its declared native window presentation.')
  assert.equal(report.benchmarkWindow.focused, !offscreen)
  report.windowAvailableMS = Date.now() - launchedAt
  report.gpuFeatureStatus = await electron.evaluate(({ app }) => app.getGPUFeatureStatus())
  report.appMetricsAtStart = await electron.evaluate(({ app }) => app.getAppMetrics())
  await page.evaluate(() => {
    const state = window.__resourceScheduler = { timeOrigin: performance.timeOrigin, supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
      phase: 'fixed-rate-intake', active: false, startedAt: null, endedAt: null,
      counts: {}, entries: { longtask: [], 'long-animation-frame': [] } }
    const observers = []
    const record = (type, entries) => {
      if (!state.active) return
      for (const entry of entries) {
        if (entry.startTime + entry.duration < state.startedAt) continue
        state.counts[type] = (state.counts[type] ?? 0) + 1
        if (state.entries[type].length >= 50) continue
        state.entries[type].push({ name: entry.name, startTime: entry.startTime, duration: entry.duration,
          blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: [...(entry.scripts ?? [])].slice(0, 5).map(script => ({ sourceURL: script.sourceURL, invoker: script.invoker,
            invokerType: script.invokerType, duration: script.duration, executionStart: script.executionStart,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) })
      }
    }
    for (const type of Object.keys(state.entries)) if (state.supportedEntryTypes.includes(type)) {
      const observer = new PerformanceObserver(list => record(type, list.getEntries()))
      observer.observe({ type, buffered: true })
      observers.push({ type, observer })
    }
    window.__armResourceScheduler = () => {
      for (const { observer } of observers) observer.takeRecords()
      state.startedAt = performance.now()
      state.active = true
    }
    window.__finishResourceScheduler = () => {
      for (const { type, observer } of observers) { record(type, observer.takeRecords()); observer.disconnect() }
      state.endedAt = performance.now()
      state.active = false
      return state
    }
  })
  report.idleFrameCadence = await page.evaluate(() => new Promise(resolve => {
    const startedAt = performance.now(), gaps = []
    let previous = null
    const frame = timestamp => {
      if (previous !== null) gaps.push(timestamp - previous)
      previous = timestamp
      if (timestamp - startedAt < 1000) { requestAnimationFrame(frame); return }
      gaps.sort((left, right) => left - right)
      resolve({ startedAt, durationMS: timestamp - startedAt, frames: gaps.length,
        medianMS: gaps[Math.floor((gaps.length - 1) * .5)] ?? null, p95MS: gaps[Math.floor((gaps.length - 1) * .95)] ?? null,
        maxMS: gaps.at(-1) ?? null, visibilityState: document.visibilityState, focused: document.hasFocus() })
    }
    requestAnimationFrame(frame)
  }))
  const fixture = await probe({ action: 'scaleSeed', count: 287, periods: 320 })
  report.fixture = fixture
  report.appMetricsAfterSeed = await electron.evaluate(({ app }) => app.getAppMetrics())
  assert.equal(fixture.rowsSeeded, 287 * 3 * 320)
  await page.evaluate(fixture => {
    const state = window.__resourcePaint = { records: [], violations: [], indicatorValuesChecked: 0, previous: null, frameGaps: [], previousFrame: null }
    const near = (actual, expected, description) => {
      if (expected === null ? actual !== null : typeof actual !== 'number' || Math.abs(actual - expected) > Math.max(1, Math.abs(expected)) * 1e-10) {
        if (state.violations.length < 40) state.violations.push(`${description}: ${actual} != ${expected}`)
      }
    }
    const sample = () => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot, svg = chart?.querySelector('svg[data-rendered-inst]')
      if (!snapshot?.instId?.startsWith('SCALE') || !svg || snapshot === state.previous) return
      state.previous = snapshot
      if (svg.dataset.renderedInst !== snapshot.instId || svg.dataset.renderedTimeframe !== snapshot.timeframe) state.violations.push('SVG mixed native series identities.')
      const instrument = Number(snapshot.instId.slice(5, 8)), step = fixture.intervals[snapshot.timeframe]
      const first = Math.floor(fixture.asOf / step) * step - fixture.periods * step
      const baseline = 100 + instrument * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[snapshot.timeframe]
      for (const value of snapshot.bars) {
        const index = (value.hour - first) / step, close = baseline + index * .01
        if (!Number.isInteger(index) || index < 0 || index >= fixture.periods) { state.violations.push('A persisted candle fell outside its seeded native range.'); continue }
        for (const [field, expected] of Object.entries({ open: close - .02, high: close + .06, low: close - .05, close })) near(value[field], expected, `${snapshot.instId}/${snapshot.timeframe}/${index}/${field}`)
        if (value.indicatorsObserved) {
          const middle = close - .095, deviation = .01 * Math.sqrt(399 / 12)
          const roc = i => (baseline + i * .01 - (baseline + (i - 9) * .01)) / Math.abs(baseline + (i - 9) * .01) * 100
          let numerator = 0, denominator = 0
          for (let i = Math.max(0, index - 13); i <= index; i += 1) { const volume = 100 + i % 7; numerator += (baseline + i * .01 + .01 / 3) * volume; denominator += volume }
          const expected = { ema: index >= 199 ? close - .995 : null,
            bollMiddle: index >= 19 ? middle : null, bollUpper: index >= 19 ? middle + 2 * deviation : null, bollLower: index >= 19 ? middle - 2 * deviation : null,
            vwap: index >= 13 ? numerator / denominator : null, roc: index >= 9 ? roc(index) : null,
            maroc: index >= 17 ? Array.from({ length: 9 }, (_, offset) => roc(index - offset)).reduce((a, b) => a + b, 0) / 9 : null,
            rsi6: index >= 6 ? 100 : null, rsi12: index >= 12 ? 100 : null, rsi24: index >= 24 ? 100 : null,
            atrPercent: index >= 13 ? .11 / close * 100 : null, bbw: index >= 19 ? 4 * deviation / middle * 100 : null }
          for (const [field, expectedValue] of Object.entries(expected)) { near(value[field], expectedValue, `${snapshot.instId}/${snapshot.timeframe}/${index}/${field}`); state.indicatorValuesChecked += 1 }
        }
      }
      const label = chart.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
      const liveVisible = snapshot.liveBar && Number(svg.dataset.renderedEnd) === snapshot.liveBar.hour
      if (liveVisible) near(Number(label.split(/\s/)[0].replaceAll(',', '')), snapshot.liveBar.close, 'Visible SVG live-price label')
      const record = { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour,
        livePrice: snapshot.liveBar?.close ?? null, priceObservedAt: snapshot.priceObservedAt,
        sequence: liveVisible ? Math.round((snapshot.liveBar.close - baseline - fixture.periods * .01) * 1000) : 0,
        committedAt: performance.timeOrigin + performance.now(), nextFrameAt: null, label, bars: snapshot.bars.length,
        indicatorState: snapshot.indicatorState, oiState: snapshot.oiState, takerState: snapshot.takerState }
      state.records.push(record)
      requestAnimationFrame(() => { record.nextFrameAt = performance.timeOrigin + performance.now() })
    }
    new MutationObserver(sample).observe(document, { subtree: true, attributes: true, childList: true })
    const frame = timestamp => { if (state.previousFrame !== null) state.frameGaps.push(timestamp - state.previousFrame); state.previousFrame = timestamp; sample(); requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  }, fixture)
  await page.waitForFunction(() => Number(document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count')) === 287, null, { timeout: 60_000 })
  const rendererFramesStartedAt = Date.now()
  await page.waitForFunction(async ({ instIds, timeframes }) => {
    const { frames } = await window.radarDesktop.request({ chartUniverse: {} })
    const canonical = frames.filter(frame => frame.bars?.length === 96 && frame.indicatorState === 'ready'
      && ['ready', 'stale'].includes(frame.priceState) && ['ready', 'unavailable'].includes(frame.oiState)
      && ['ready', 'unavailable'].includes(frame.takerState))
    const ready = new Set(canonical.map(frame => `${frame.instId}:${frame.timeframe}`))
    if (!instIds.every(instId => timeframes.every(timeframe => ready.has(`${instId}:${timeframe}`)))) return false
    // Route the full renderer universe through App's ordinary notification
    // handler; only the selected contract creates SVG geometry.
    for (const frame of canonical) window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
    return true
  }, fixture, { timeout: 120_000, polling: 500 })
  report.rendererFrameBarrier = { readyPairs: fixture.instIds.length * fixture.timeframes.length,
    waitAfterListMS: Date.now() - rendererFramesStartedAt, demand: 'Canonical frames delivered through the renderer prepared-frame event.' }
  const focus = fixture.instIds[0], timeframe = '15m'
  let sequence = 0
  const choose = async (instId, phase) => {
    const expected = sequence ? 100 + Number(instId.slice(5, 8)) * 3 + 10 + fixture.periods * .01 + sequence * .001 : null
    report.pendingSelection = { instId, phase, expected }
    const selectedBeforeSearch = await page.evaluate(() => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId ?? null)
    await page.getByRole('textbox', { name: 'Search contracts' }).fill(instId)
    const selectedBeforeClick = await page.evaluate(() => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId ?? null)
    assert.equal(selectedBeforeClick, selectedBeforeSearch, 'Filtering contracts must preserve chart selection until a row is selected.')
    // The search filters the list; the row click selects the chart. Capture
    // that semantic input in its renderer task, excluding driver round trips.
    const inputAt = await page.locator(`[aria-label="View ${instId} chart"]`).evaluate(node => {
      const at = performance.timeOrigin + performance.now()
      node.click()
      return at
    })
    report.pendingSelection.inputAt = inputAt
    report.viewIntents.push({ at: inputAt, instId, timeframe: '15m' })
    await page.waitForFunction(({ instId, inputAt, expected }) => window.__resourcePaint.records.some(record => record.instId === instId && record.nextFrameAt >= inputAt && record.bars === 96 && record.indicatorState === 'ready' && (expected === null || record.livePrice >= expected)), { instId, inputAt, expected }, { timeout: 20_000 })
    const value = await page.evaluate(({ instId, inputAt, expected }) => window.__resourcePaint.records.find(record => record.instId === instId && record.nextFrameAt >= inputAt && record.bars === 96 && record.indicatorState === 'ready' && (expected === null || record.livePrice >= expected)), { instId, inputAt, expected })
    report.switches.push({ phase, instId, inputMode: 'row click after search filtering', selectedBeforeClick, rowClickToFrameMS: value.nextFrameAt - inputAt, bars: value.bars, indicatorState: value.indicatorState, expected, actualPrice: value.livePrice })
    delete report.pendingSelection
  }
  await choose(fixture.instIds[1], 'first selection after renderer frame delivery')
  await choose(focus, 'first local selection')
  await selectTimeframe(page, timeframe)
  await page.waitForFunction(({ focus, timeframe }) => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId === focus && document.querySelector('[data-chart-inst]')?.__chartSnapshot?.timeframe === timeframe, { focus, timeframe })
  report.backgroundReady = await probe({ action: 'backgroundStart' })
  report.backgroundStarted = true
  const loadInputAt = await page.evaluate(() => {
    window.__resourcePaint.frameGaps = []; window.__resourcePaint.previousFrame = null
    window.__armResourceScheduler()
    return performance.timeOrigin + performance.now()
  })
  report.viewIntents.push({ at: loadInputAt, instId: focus, timeframe })
  report.loadStart = await probe({ action: 'scaleLoadStart', ticks, cadenceMS, focusInstId: focus, timeframe })
  const loadDeadline = performance.now() + ticks * cadenceMS + 20_000
  let load, nextMemorySample = 0
  const monitor = async () => {
    do {
      await sleep(50)
      load = await probe({ action: 'scaleLoadRead' })
      assert.ok(performance.now() < loadDeadline, 'Fixed-rate intake did not settle within its bounded deadline.')
      if (performance.now() >= nextMemorySample) {
        report.memorySamples.push({ at: Date.now(), processes: await electron.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKB: memory.workingSetSize }))) })
        nextMemorySample = performance.now() + 1000
      }
    } while (load.state === 'emitting' || load.state === 'draining')
    load = await probe({ action: 'scaleLoadRead', includeTicks: true })
    sequence = load.ticks.at(-1)?.sequence ?? 0
  }
  const interact = async () => {
    await sleep(Math.min(500, cadenceMS * 5))
    for (const index of [286, 175, 96, 14]) { await choose(fixture.instIds[index], 'selection during fixed-rate intake'); await choose(focus, 'warm revisit during fixed-rate intake') }
    const currentEnd = Math.floor(fixture.asOf / fixture.intervals[timeframe]) * fixture.intervals[timeframe] - fixture.intervals[timeframe]
    for (const distance of [64, -64]) {
      const expectedEnd = distance > 0 ? currentEnd - 64 * fixture.intervals[timeframe] : currentEnd
      const inputAt = await page.evaluate(distance => {
        const inputAt = performance.timeOrigin + performance.now()
        document.querySelector('[data-chart-plot]').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: distance * 12 }))
        return inputAt
      }, distance)
      report.viewIntents.push({ at: inputAt, instId: focus, timeframe, historical: distance > 0 })
      await page.waitForFunction(({ focus, expectedEnd, inputAt }) => window.__resourcePaint.records.some(record => record.instId === focus && record.endHour === expectedEnd && record.bars === 96 && record.nextFrameAt >= inputAt), { focus, expectedEnd, inputAt }, { timeout: 20_000 })
      const frame = await page.evaluate(({ focus, expectedEnd, inputAt }) => window.__resourcePaint.records.find(record => record.instId === focus && record.endHour === expectedEnd && record.bars === 96 && record.nextFrameAt >= inputAt), { focus, expectedEnd, inputAt })
      report.history.push({ distance, expectedEnd, inputToFrameMS: frame.nextFrameAt - inputAt, bars: frame.bars, oiState: frame.oiState, takerState: frame.takerState })
    }
  }
  await Promise.all([monitor(), interact()])
  await page.waitForFunction(({ focus, sequence }) => window.__resourcePaint.records.some(record => record.instId === focus && record.sequence === sequence && record.nextFrameAt !== null), { focus, sequence }, { timeout: 10_000 })
  const commits = await page.evaluate(() => window.__resourcePaint.records)
  report.rendererCommits = commits
  report.load = load
  report.foregroundFrameCadence = await page.evaluate(() => {
    const gaps = [...window.__resourcePaint.frameGaps].sort((left, right) => left - right)
    return { frames: gaps.length, medianMS: gaps[Math.floor((gaps.length - 1) * .5)], p95MS: gaps[Math.floor((gaps.length - 1) * .95)], maxMS: gaps.at(-1), visibilityState: document.visibilityState, focused: document.hasFocus() }
  })
  report.schedulerAfterTicks = await page.evaluate(() => window.__finishResourceScheduler())
  assert.ok(load.ticks.every(tick => tick.nativeUpdates === fixture.instIds.length * fixture.timeframes.length),
    'Every fixed-rate input must update the complete contract/timeframe universe before visible-series timing can acknowledge it.')
  report.delivery = summarizeResourceDelivery(load, commits, { intents: report.viewIntents })
  report.samples = report.delivery.samples
  assertResourceDeliveryBudget(report.delivery, report.receiveToFrameBudgetMS)
  if (!offscreen) {
    assert.ok(report.switches.every(value => value.rowClickToFrameMS <= 100), 'A prepared contract selection exceeded the 100 ms row-click-to-RAF budget during the resource workload.')
    assert.ok(report.foregroundFrameCadence.maxMS < 100, 'Continuous market intake caused a renderer RAF stall of at least 100 ms.')
    assert.ok(report.foregroundFrameCadence.p95MS <= 50, 'Continuous market intake exceeded the 50 ms renderer RAF p95 budget.')
  }
  await page.waitForFunction(() => window.__resourcePaint.indicatorValuesChecked > 0, null, { timeout: 30_000 })
  report.correctness = await page.evaluate(() => ({ violations: window.__resourcePaint.violations, indicatorValuesChecked: window.__resourcePaint.indicatorValuesChecked, rendererCommits: window.__resourcePaint.records.length }))
  report.background = await probe({ action: 'backgroundStatus' })
  report.appMetricsAfterLoad = await electron.evaluate(({ app }) => app.getAppMetrics())
  report.schedulerAfterLoad = await page.evaluate(() => window.__resourceScheduler)
  report.rendererMemoryAfterLoad = await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null)
  report.final = await probe({ action: 'scaleStop' }); stopped = true
  assert.deepEqual(report.correctness.violations, [])
  assert.equal(report.final.actualRows, fixture.rowsSeeded)
  assert.equal(report.final.minimumRowsPerSeries, fixture.periods)
  assert.ok(report.final.heldStatistics > 0, 'The benchmark must actually hold native statistics requests.')
  assert.ok(report.background.writtenRecords > 0, 'The benchmark must perform background archive writes.')
  assert.ok(report.background.archiveRows > report.backgroundReady.writtenRecords, 'Background archive writes must continue during the measured workload.')
  assert.deepEqual(report.final.liveMismatches, [], 'Every synthetic native series must retain the latest accepted revision.')
  assert.ok(report.switches.some(value => value.phase.includes('during fixed-rate')) && report.history.length === 2,
    'The workload must exercise selection and reversal while background writes and intake continue.')
  report.outcome = 'passed'
} catch (error) {
  report.outcome = 'failed'; report.error = error.stack ?? error.message
  if (page) {
    try { report.failureRenderer = await page.evaluate(() => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
      return { search: document.querySelector('[aria-label="Search contracts"]')?.value,
        selectedRow: document.querySelector('[data-market-index][aria-selected="true"]')?.getAttribute('aria-label'),
        chart: chart ? Object.fromEntries([...chart.attributes].filter(value => value.name.startsWith('data-chart')).map(value => [value.name, value.value])) : null,
        snapshot: snapshot ? { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour, generation: snapshot.generation, revision: snapshot.revision, bars: snapshot.bars.length, liveBar: snapshot.liveBar } : null,
        lastRecords: window.__resourcePaint?.records.slice(-12), violations: window.__resourcePaint?.violations }
    }) } catch {} }
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  if (electron && !stopped) { try { report.final = await probe({ action: 'scaleStop' }) } catch {} }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
  console.log(JSON.stringify({ report: reportPath, outcome: report.outcome, samples: report.samples.length, scheduleToFrameMaxMS: report.delivery?.maxMS ?? null }, null, 2))
}
