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
import { assessResourceBudgets, installResourcePaintProbe, summarizeResourceDelivery } from './resource-acceptance.mjs'
import { waitForAsyncCondition } from './async-readiness.mjs'
import { startRendererDiagnostics } from './renderer-diagnostics.mjs'
import { startRendererCPUCounter } from './renderer-cpu-counter.mjs'

const { values } = parseArgs({ options: { offscreen: { type: 'boolean' }, diagnostic: { type: 'boolean' }, ticks: { type: 'string' }, 'cadence-ms': { type: 'string' } } })
const offscreen = values.offscreen === true
const diagnosticDirectory = process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS
if (diagnosticDirectory && !values.diagnostic) throw new Error('Normal resource acceptance rejects renderer profiling. Use --diagnostic only for a separate diagnostic run.')
if (values.diagnostic && !diagnosticDirectory) throw new Error('--diagnostic requires PERPETUAL_SWAP_RENDERER_DIAGNOSTICS for its separate profile output.')
const ticks = Number(values.ticks ?? 60), cadenceMS = Number(values['cadence-ms'] ?? 500)
if (!Number.isSafeInteger(ticks) || ticks < 60 || ticks > 1200 || !Number.isSafeInteger(cadenceMS) || cadenceMS < 20 || cadenceMS > 2000) throw new Error('Resource workloads require 60–1200 ticks and a 20–2000 ms cadence.')
// Retain the full declared workload, including the 40-minute maximum, at known
// display rates through 240 Hz. The extra three minutes cover setup selections,
// interaction waits and draining. The counter grows on admission, not up front.
const cpuCapacityBasis = { inputDurationMS: ticks * cadenceMS, additionalWindowMS: 180_000, maximumRAFRateHz: 240 }
const cpuCapacity = Math.ceil((cpuCapacityBasis.inputDurationMS + cpuCapacityBasis.additionalWindowMS) * cpuCapacityBasis.maximumRAFRateHz / 1000) + 2
if (!offscreen) requireForegroundTests()

const root = fileURLToPath(new URL('..', import.meta.url))
const reportPath = resolve(root, process.env.PERPETUAL_SWAP_RESOURCE_REPORT ?? '.build/resource-benchmark.json')
const userData = await mkdtemp(join(tmpdir(), 'perp-market-resources-'))
const report = { generatedAt: new Date().toISOString(), mode: 'real Electron renderer, worker backend and SQLite; synthetic native intake',
  diagnosticOnly: values.diagnostic === true,
  nativePresentationMeasured: false, timing: 'Scheduled synthetic input to SVG commit and a RAF opportunity that rechecks the displayed chart; no native compositor presentation.',
  clock: 'Epoch-origin monotonic performance clocks for source schedule/receipt and renderer input/commit/RAF; 2 ms origin precision tolerance with raw clock deltas retained.',
  externalWebSocketTransportMeasured: false, externalNetworkMeasured: false, receiveToFrameBudgetMS: offscreen ? null : 100,
  samples: [], switches: [], history: [], memorySamples: [], viewIntents: [], outcome: 'running' }
let electron, page, stopDiagnostics, rendererCPUCounter, rendererCPUStopped = false
let stopped = false, measurementsStopped = false, paintValidated = false
const probe = input => electron.evaluate((_electron, value) => globalThis.__marketBackend.probe(value), input)
const stopMeasurements = async () => {
  if (!page || measurementsStopped) return
  const result = await page.evaluate(() => ({ capture: window.__resourcePaint?.stop(), scheduler: window.__finishResourceScheduler?.() }))
  measurementsStopped = true
  if (result.capture) report.paintCaptureStopped = result.capture
  if (result.scheduler) report.schedulerAfterTicks = result.scheduler
}
const finishDiagnostics = async () => {
  const finish = stopDiagnostics
  stopDiagnostics = undefined
  await finish?.()
}
const stopRendererCPU = async () => {
  if (!rendererCPUCounter || rendererCPUStopped) return
  rendererCPUStopped = true
  const retain = value => {
    const { samples, ...summary } = value
    const markers = { start: samples[0]?.phase === 'start' && samples[0]?.index === 0,
      raf: samples.some(sample => sample.phase === 'raf'), stop: samples.at(-1)?.phase === 'stop' }
    report.rendererCPU = { ...summary, capacityBasis: cpuCapacityBasis, markers,
      complete: summary.complete && markers.start && markers.raf && markers.stop }
  }
  try { retain(await rendererCPUCounter.stop()) }
  catch (error) {
    if (error.rendererCPUCounter) {
      retain(error.rendererCPUCounter)
      report.rendererCPU.complete = false
      report.rendererCPU.artifactError = error.stack ?? error.message
    }
    throw error
  }
}
const validatePaint = async () => {
  if (!page || paintValidated) return
  const value = await page.evaluate(() => window.__resourcePaint?.finish())
  if (value) { report.correctness = value; paintValidated = true }
}
const secondaryFailure = (stage, error) => {
  report.secondaryErrors ??= []
  report.secondaryErrors.push({ stage, error: error.stack ?? error.message ?? String(error) })
  report.outcome = 'failed'; process.exitCode = 1
}

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
  if (report.diagnosticOnly) stopDiagnostics = await startRendererDiagnostics(electron, page, diagnosticDirectory)
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
  await page.evaluate(installResourcePaintProbe, fixture)
  await page.waitForFunction(() => Number(document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count')) === 287, null, { timeout: 60_000 })
  const rendererFramesStartedAt = Date.now()
  const readiness = await waitForAsyncCondition(() => page.evaluate(async ({ instIds, timeframes }) => {
    const { frames } = await window.radarDesktop.request({ chartUniverse: {} })
    // The fixture deliberately holds optional statistics requests. Price and
    // exact indicators must become ready independently of those pending lanes.
    const canonical = frames.filter(frame => frame.bars?.length === 96 && frame.indicatorState === 'ready'
      && ['ready', 'stale'].includes(frame.priceState))
    const ready = new Set(canonical.map(frame => `${frame.instId}:${frame.timeframe}`))
    const states = source => Object.fromEntries([...new Set(frames.map(frame => frame[source]))]
      .map(state => [state, frames.filter(frame => frame[source] === state).length]))
    const readiness = window.__resourceUniverseReadiness = { readyPairs: ready.size, receivedPairs: frames.length,
      expectedPairs: instIds.length * timeframes.length, oiStates: states('oiState'), takerStates: states('takerState') }
    if (!instIds.every(instId => timeframes.every(timeframe => ready.has(`${instId}:${timeframe}`)))) return false
    // Route the full renderer universe through App's ordinary notification
    // handler; only the selected contract creates SVG geometry.
    for (const frame of canonical) window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
    return readiness
  }, fixture), { description: 'all canonical frames to reach the renderer', timeoutMS: 120_000, pollingMS: 500 })
  assert.equal(readiness.readyPairs, fixture.instIds.length * fixture.timeframes.length)
  report.rendererFrameBarrier = { ...readiness,
    required: '96-bar prices and exact indicators; optional OI/Taker requests remain intentionally held.',
    waitAfterListMS: Date.now() - rendererFramesStartedAt, demand: 'Canonical frames delivered through the renderer prepared-frame event.' }
  // Backend frame delivery does not mean the initial SVG has reached a RAF.
  // Start prepared-selection timing only after that visible baseline exists;
  // retain its preparation wait separately from subsequent input latency.
  const focus = fixture.instIds[0], timeframe = '15m'
  const currentEnd = Math.floor(fixture.asOf / fixture.intervals[timeframe]) * fixture.intervals[timeframe] - fixture.intervals[timeframe]
  const selectedFrameWaitStartedAt = performance.now()
  const selectedRaf = await page.waitForFunction(({ focus, timeframe }) => {
    const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    const record = window.__resourcePaint.records.at(-1)
    if (!snapshot || !record || snapshot.instId !== focus || snapshot.timeframe !== timeframe
      || svg?.dataset.renderedInst !== focus || svg.dataset.renderedTimeframe !== timeframe
      || Number(svg.dataset.renderedEnd) !== snapshot.endHour
      || snapshot !== window.__resourcePaint.previous || record.instId !== snapshot.instId
      || record.timeframe !== snapshot.timeframe || record.bars !== 96 || record.indicatorState !== 'ready'
      || !window.__resourcePaint.isFrame(record)) return false
    const { instId, committedAt, nextFrameAt } = record
    return { instId, timeframe, committedAt, nextFrameAt }
  }, { focus, timeframe }, { timeout: 20_000 })
  report.rendererFrameBarrier.selectedRaf = await selectedRaf.jsonValue()
  await selectedRaf.dispose()
  report.rendererFrameBarrier.selectedRaf.waitAfterUniverseMS = performance.now() - selectedFrameWaitStartedAt
  rendererCPUCounter = await startRendererCPUCounter(page, { label: 'market-resources', capacity: cpuCapacity,
    directory: join(dirname(reportPath), 'process-witness') })
  await page.evaluate(prefix => window.__resourcePaint.armCPU(prefix), rendererCPUCounter.markerPrefix)
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
    report.viewIntents.push({ at: inputAt, instId, timeframe: '15m', liveEndHour: currentEnd })
    await page.waitForFunction(({ instId, inputAt, expected }) => window.__resourcePaint.records.some(record => window.__resourcePaint.isFrame(record) && record.instId === instId && record.timeframe === '15m' && record.nextFrameAt >= inputAt && record.bars === 96 && record.indicatorState === 'ready' && (expected === null || record.frame.livePrice >= expected)), { instId, inputAt, expected }, { timeout: 20_000 })
    const value = await page.evaluate(({ instId, inputAt, expected }) => window.__resourcePaint.records.find(record => window.__resourcePaint.isFrame(record) && record.instId === instId && record.timeframe === '15m' && record.nextFrameAt >= inputAt && record.bars === 96 && record.indicatorState === 'ready' && (expected === null || record.frame.livePrice >= expected)), { instId, inputAt, expected })
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
  report.viewIntents.push({ at: loadInputAt, instId: focus, timeframe, liveEndHour: currentEnd })
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
    for (const distance of [64, -64]) {
      const expectedEnd = distance > 0 ? currentEnd - 64 * fixture.intervals[timeframe] : currentEnd
      const inputAt = await page.evaluate(distance => {
        const inputAt = performance.timeOrigin + performance.now()
        document.querySelector('[data-chart-plot]').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: distance * 12 }))
        window.__resourcePaint.recheck()
        return inputAt
      }, distance)
      report.viewIntents.push({ at: inputAt, instId: focus, timeframe, endHour: expectedEnd, liveEndHour: currentEnd, historical: distance > 0 })
      await page.waitForFunction(({ focus, timeframe, expectedEnd, inputAt }) => window.__resourcePaint.records.some(record => window.__resourcePaint.isFrame(record) && record.instId === focus && record.timeframe === timeframe && record.frame.endHour === expectedEnd && record.bars === 96 && record.nextFrameAt >= inputAt), { focus, timeframe, expectedEnd, inputAt }, { timeout: 20_000 })
      const frame = await page.evaluate(({ focus, timeframe, expectedEnd, inputAt }) => window.__resourcePaint.records.find(record => window.__resourcePaint.isFrame(record) && record.instId === focus && record.timeframe === timeframe && record.frame.endHour === expectedEnd && record.bars === 96 && record.nextFrameAt >= inputAt), { focus, timeframe, expectedEnd, inputAt })
      report.history.push({ distance, expectedEnd, inputToFrameMS: frame.nextFrameAt - inputAt, bars: frame.bars, oiState: frame.oiState, takerState: frame.takerState })
    }
  }
  // Join both measurement owners even when one fails. Neither memory sampling
  // nor an in-flight interaction may overlap deferred numerical validation.
  const workloadFailures = []
  await Promise.allSettled([['monitor', monitor], ['interaction', interact]].map(async ([phase, operation]) => {
    try { await operation() }
    catch (error) { workloadFailures.push({ phase, error }); throw error }
  }))
  if (workloadFailures.length) {
    report.workloadErrors = workloadFailures.map(({ phase, error }) => ({ phase, error: error.stack ?? error.message ?? String(error) }))
    throw workloadFailures[0].error
  }
  const finalIntent = report.viewIntents.at(-1)
  assert.ok(finalIntent && !finalIntent.historical && finalIntent.instId === focus && finalIntent.timeframe === timeframe,
    'The fixed-rate workload must finish on the selected live viewport.')
  await page.waitForFunction(input => window.__resourcePaint.readyForLatest(input),
    { instId: focus, timeframe, sequence, afterAt: finalIntent.at }, { timeout: 10_000 })
  await stopMeasurements()
  await stopRendererCPU()
  const commits = await page.evaluate(() => window.__resourcePaint.records)
  report.rendererCommits = commits
  report.load = load
  report.foregroundFrameCadence = await page.evaluate(() => {
    const gaps = [...window.__resourcePaint.frameGaps].sort((left, right) => left - right)
    return { frames: gaps.length, medianMS: gaps[Math.floor((gaps.length - 1) * .5)], p95MS: gaps[Math.floor((gaps.length - 1) * .95)], maxMS: gaps.at(-1), visibilityState: document.visibilityState, focused: document.hasFocus() }
  })
  assert.ok(load.ticks.every(tick => tick.nativeUpdates === fixture.instIds.length * fixture.timeframes.length),
    'Every fixed-rate input must update the complete contract/timeframe universe before visible-series timing can acknowledge it.')
  report.delivery = summarizeResourceDelivery(load, commits, { intents: report.viewIntents })
  report.samples = report.delivery.samples
  report.acceptanceFailures = assessResourceBudgets({ load, delivery: report.delivery, switches: report.switches,
    frameCadence: report.foregroundFrameCadence }, { offscreen })
  report.background = await probe({ action: 'backgroundStatus' })
  report.appMetricsAfterLoad = await electron.evaluate(({ app }) => app.getAppMetrics())
  report.schedulerAfterLoad = await page.evaluate(() => window.__resourceScheduler)
  report.rendererMemoryAfterLoad = await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null)
  report.final = await probe({ action: 'scaleStop' }); stopped = true
  await finishDiagnostics()
  await validatePaint()
  assert.equal(report.correctness.complete, true, 'Resource paint capture or deferred validation failed; all retained evidence is in correctness.')
  assert.equal(report.rendererCPU.complete, true, 'Resource renderer CPU evidence must retain its complete start/RAF/stop marker stream.')
  assert.ok(report.correctness.indicatorValuesChecked > 0, 'Resource acceptance must validate observed numerical indicators.')
  assert.deepEqual(report.correctness.violations, [])
  assert.equal(report.final.actualRows, fixture.rowsSeeded)
  assert.equal(report.final.minimumRowsPerSeries, fixture.periods)
  assert.ok(report.final.heldStatistics > 0, 'The benchmark must actually hold native statistics requests.')
  assert.ok(report.background.writtenRecords > 0, 'The benchmark must perform background archive writes.')
  assert.ok(report.background.archiveRows > report.backgroundReady.writtenRecords, 'Background archive writes must continue during the measured workload.')
  assert.deepEqual(report.final.liveMismatches, [], 'Every synthetic native series must retain the latest accepted revision.')
  assert.ok(report.switches.some(value => value.phase.includes('during fixed-rate')) && report.history.length === 2,
    'The workload must exercise selection and reversal while background writes and intake continue.')
  assert.deepEqual(report.acceptanceFailures, [], 'Resource performance budgets failed; all independent failures and samples are retained.')
  report.outcome = report.diagnosticOnly ? 'diagnostic-passed' : 'passed'
} catch (error) {
  report.outcome = 'failed'; report.error = error.stack ?? error.message
  if (page) {
    try { report.failureRenderer = await page.evaluate(() => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
      return { search: document.querySelector('[aria-label="Search contracts"]')?.value,
        selectedRow: document.querySelector('[data-market-index][aria-selected="true"]')?.getAttribute('aria-label'),
        chart: chart ? Object.fromEntries([...chart.attributes].filter(value => value.name.startsWith('data-chart')).map(value => [value.name, value.value])) : null,
        snapshot: snapshot ? { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour, generation: snapshot.generation, revision: snapshot.revision, bars: snapshot.bars.length, liveBar: snapshot.liveBar } : null,
        lastRecords: window.__resourcePaint?.records.slice(-12), violations: window.__resourcePaint?.violations,
        universeReadiness: window.__resourceUniverseReadiness }
    }) } catch {} }
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  try { await stopMeasurements() } catch (error) { secondaryFailure('stop-measurements', error) }
  try { await stopRendererCPU() } catch (error) { secondaryFailure('stop-renderer-cpu', error) }
  if (electron && !stopped) {
    try { report.final = await probe({ action: 'scaleStop' }); stopped = true }
    catch (error) { secondaryFailure('stop-source', error) }
  }
  try { await finishDiagnostics() } catch (error) { secondaryFailure('stop-diagnostics', error) }
  try { await validatePaint() } catch (error) { secondaryFailure('validate-paint', error) }
  if (report.correctness && !report.correctness.complete) { report.outcome = 'failed'; process.exitCode = 1 }
  if (report.rendererCPU && !report.rendererCPU.complete) { report.outcome = 'failed'; process.exitCode = 1 }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
  console.log(JSON.stringify({ report: reportPath, outcome: report.outcome, samples: report.samples.length, scheduleToFrameMaxMS: report.delivery?.maxMS ?? null }, null, 2))
}
