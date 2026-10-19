import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { selectTimeframe } from './chart-acceptance.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const reportPath = resolve(root, process.env.PERPETUAL_SWAP_RESOURCE_REPORT ?? '.build/resource-benchmark.json')
const userData = await mkdtemp(join(tmpdir(), 'perp-market-resources-'))
const percentile = values => values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * .95)] ?? null
const report = { generatedAt: new Date().toISOString(), mode: 'real Electron renderer, worker backend and SQLite; synthetic native intake',
  externalWebSocketTransportMeasured: false, externalNetworkMeasured: false, receiptToPaintBudgetMS: 100,
  samples: [], switches: [], history: [], outcome: 'running' }
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
  await electron.evaluate(({ BrowserWindow, app }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); app.focus({ steal: true }); window.focus() })
  await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), null, { timeout: 5_000 })
  report.documentVisibility = await page.evaluate(() => ({ state: document.visibilityState, focused: document.hasFocus() }))
  report.benchmarkWindow = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused() } })
  assert.equal(report.benchmarkWindow.visible, true, 'The renderer paint benchmark requires a visible native window.')
  report.windowAvailableMS = Date.now() - launchedAt
  report.gpuFeatureStatus = await electron.evaluate(({ app }) => app.getGPUFeatureStatus())
  report.appMetricsAtStart = await electron.evaluate(({ app }) => app.getAppMetrics())
  await page.evaluate(() => {
    const state = window.__resourceScheduler = { timeOrigin: performance.timeOrigin, supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
      counts: {}, entries: { longtask: [], 'long-animation-frame': [] } }
    for (const type of Object.keys(state.entries)) if (state.supportedEntryTypes.includes(type)) {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) {
        state.counts[type] = (state.counts[type] ?? 0) + 1
        if (state.entries[type].length >= 50) continue
        state.entries[type].push({ name: entry.name, startTime: entry.startTime, duration: entry.duration,
          blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: [...(entry.scripts ?? [])].slice(0, 5).map(script => ({ sourceURL: script.sourceURL, invoker: script.invoker,
            invokerType: script.invokerType, duration: script.duration, executionStart: script.executionStart,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) })
      } }).observe({ type, buffered: true })
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
      const record = { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour,
        livePrice: snapshot.liveBar?.close ?? null, priceObservedAt: snapshot.priceObservedAt,
        committedAt: performance.timeOrigin + performance.now(), paintedAt: null, label, bars: snapshot.bars.length,
        indicatorState: snapshot.indicatorState, oiState: snapshot.oiState, takerState: snapshot.takerState }
      state.records.push(record)
      requestAnimationFrame(() => { record.paintedAt = performance.timeOrigin + performance.now() })
    }
    new MutationObserver(sample).observe(document, { subtree: true, attributes: true, childList: true })
    const frame = timestamp => { if (state.previousFrame !== null) state.frameGaps.push(timestamp - state.previousFrame); state.previousFrame = timestamp; sample(); requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  }, fixture)
  await page.waitForFunction(() => Number(document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count')) === 287, null, { timeout: 60_000 })
  const focus = fixture.instIds[0], timeframe = '15m'
  let sequence = 0
  const choose = async (instId, phase) => {
    // Searching can change the requested chart before the subsequent row
    // click. Measure from the first real input, including that possible paint.
    const inputAt = await page.evaluate(() => performance.timeOrigin + performance.now())
    const expected = sequence ? 100 + Number(instId.slice(5, 8)) * 3 + 10 + fixture.periods * .01 + sequence * .001 : null
    report.pendingSelection = { instId, phase, inputAt, expected }
    await page.getByRole('textbox', { name: 'Search contracts' }).fill(instId)
    const selectedBeforeClick = await page.evaluate(() => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId ?? null)
    await page.locator(`[aria-label="View ${instId} chart"]`).evaluate(node => node.click())
    await page.waitForFunction(({ instId, inputAt, expected }) => window.__resourcePaint.records.some(record => record.instId === instId && record.paintedAt >= inputAt && record.bars > 0 && (expected === null || record.livePrice === expected)), { instId, inputAt, expected }, { timeout: 20_000 })
    const value = await page.evaluate(({ instId, inputAt, expected }) => window.__resourcePaint.records.find(record => record.instId === instId && record.paintedAt >= inputAt && record.bars > 0 && (expected === null || record.livePrice === expected)), { instId, inputAt, expected })
    report.switches.push({ phase, instId, inputMode: 'search entry and row click', selectedBeforeClick, inputToPaintMS: value.paintedAt - inputAt, bars: value.bars, indicatorState: value.indicatorState, expected, actualPrice: value.livePrice })
    delete report.pendingSelection
  }
  await choose(fixture.instIds[1], 'initial cold local selection')
  await choose(focus, 'first local selection')
  await selectTimeframe(page, timeframe)
  await page.waitForFunction(({ focus, timeframe }) => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId === focus && document.querySelector('[data-chart-inst]')?.__chartSnapshot?.timeframe === timeframe, { focus, timeframe })
  report.backgroundReady = await probe({ action: 'backgroundStart' })
  report.backgroundStarted = true
  const tickAndMeasure = async () => {
    const update = await probe({ action: 'scaleTick', sequence: ++sequence, focusInstId: focus, timeframe })
    await page.waitForFunction(value => window.__resourcePaint.records.some(record => record.instId === value.instId && record.timeframe === value.timeframe && record.livePrice === value.expected && record.paintedAt !== null), update, { timeout: 10_000 })
    const paint = await page.evaluate(value => window.__resourcePaint.records.find(record => record.instId === value.instId && record.timeframe === value.timeframe && record.livePrice === value.expected && record.paintedAt !== null), update)
    const labelPrice = Number(paint.label.split(/\s/)[0].replaceAll(',', ''))
    assert.ok(Math.abs(labelPrice - update.expected) < 1e-5, `The SVG price label did not contain update ${sequence}: ${paint.label}`)
    report.samples.push({ sequence, receivedAt: update.receivedAt, committedAt: paint.committedAt, paintedAt: paint.paintedAt,
      receiptToCommitMS: paint.committedAt - update.receivedAt, receiptToPaintMS: paint.paintedAt - update.receivedAt,
      nativeUpdates: update.nativeUpdates, expected: update.expected, label: paint.label })
  }
  for (let index = 0; index < 60; index += 1) await tickAndMeasure()
  report.foregroundFrameCadence = await page.evaluate(() => {
    const gaps = [...window.__resourcePaint.frameGaps].sort((left, right) => left - right)
    return { frames: gaps.length, medianMS: gaps[Math.floor((gaps.length - 1) * .5)], p95MS: gaps[Math.floor((gaps.length - 1) * .95)], maxMS: gaps.at(-1), visibilityState: document.visibilityState, focused: document.hasFocus() }
  })
  report.schedulerAfterTicks = await page.evaluate(() => window.__resourceScheduler)
  for (const index of [286, 175, 96, 14]) { await choose(fixture.instIds[index], 'cold bounded local selection'); await choose(focus, 'warm revisit') }
  const currentEnd = Math.floor(fixture.asOf / fixture.intervals[timeframe]) * fixture.intervals[timeframe] - fixture.intervals[timeframe]
  for (const distance of [64, -64]) {
    const expectedEnd = distance > 0 ? currentEnd - 64 * fixture.intervals[timeframe] : currentEnd
    const inputAt = await page.evaluate(distance => {
      const inputAt = performance.timeOrigin + performance.now()
      document.querySelector('[data-chart-plot]').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: distance * 12 }))
      return inputAt
    }, distance)
    await page.waitForFunction(({ focus, expectedEnd, inputAt }) => window.__resourcePaint.records.some(record => record.instId === focus && record.endHour === expectedEnd && record.paintedAt >= inputAt), { focus, expectedEnd, inputAt }, { timeout: 20_000 })
    const paint = await page.evaluate(({ focus, expectedEnd, inputAt }) => window.__resourcePaint.records.find(record => record.instId === focus && record.endHour === expectedEnd && record.paintedAt >= inputAt), { focus, expectedEnd, inputAt })
    report.history.push({ distance, expectedEnd, inputToPaintMS: paint.paintedAt - inputAt, bars: paint.bars, oiState: paint.oiState, takerState: paint.takerState })
  }
  await page.waitForFunction(() => window.__resourcePaint.indicatorValuesChecked > 0, null, { timeout: 30_000 })
  report.correctness = await page.evaluate(() => ({ violations: window.__resourcePaint.violations, indicatorValuesChecked: window.__resourcePaint.indicatorValuesChecked, rendererCommits: window.__resourcePaint.records.length }))
  report.background = await probe({ action: 'backgroundStatus' })
  report.appMetricsAfterLoad = await electron.evaluate(({ app }) => app.getAppMetrics())
  report.schedulerAfterLoad = await page.evaluate(() => window.__resourceScheduler)
  report.rendererMemoryAfterLoad = await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null)
  report.final = await probe({ action: 'scaleStop' }); stopped = true
  report.receiptToPaintP95MS = percentile(report.samples.map(sample => sample.receiptToPaintMS))
  assert.deepEqual(report.correctness.violations, [])
  assert.equal(report.final.actualRows, fixture.rowsSeeded)
  assert.equal(report.final.minimumRowsPerSeries, fixture.periods)
  assert.ok(report.final.heldStatistics > 0, 'The benchmark must actually hold native statistics requests.')
  assert.ok(report.background.writtenRecords > 0, 'The benchmark must perform background archive writes.')
  assert.ok(report.background.archiveRows > report.backgroundReady.writtenRecords, 'Background archive writes must continue during the measured workload.')
  assert.ok(report.receiptToPaintP95MS <= 100, `Receipt-to-renderer-paint p95 ${report.receiptToPaintP95MS} ms exceeded 100 ms.`)
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
  throw error
} finally {
  if (electron && !stopped) { try { report.final = await probe({ action: 'scaleStop' }) } catch {} }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
  console.log(JSON.stringify({ report: reportPath, outcome: report.outcome, samples: report.samples.length, receiptToPaintP95MS: report.receiptToPaintP95MS ?? null }, null, 2))
}
