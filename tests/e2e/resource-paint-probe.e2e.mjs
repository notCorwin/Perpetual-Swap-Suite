import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { buildIndicatorSeries } from '../../electron/services/indicators.js'
import { installResourcePaintProbe } from '../../scripts/resource-acceptance.mjs'
import { startRendererCPUCounter } from '../../scripts/renderer-cpu-counter.mjs'

test('resource paint capture stops before oracle work and retains repaired corruption in real Electron', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-resource-paint-'))
  const step = 900_000, asOf = step * 1000, periods = 320
  const source = Array.from({ length: periods }, (_, index) => {
    const close = 110 + index * .01
    return { timestamp: asOf - (periods - index) * step, open: close - .02, high: close + .06, low: close - .05,
      close, baseVolume: 100 + index % 7 }
  })
  const bars = buildIndicatorSeries(source, step).bars.slice(-96).map(bar => ({ ...bar, indicatorsObserved: true }))
  const fixture = { intervals: { '15m': step }, periods, asOf }
  let electron, page, counter
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ monitoringPaused: true, backgroundMonitoringEnabled: false }))
    electron = await _electron.launch({ args: ['.'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: directory } })
    page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false)
    await page.evaluate(({ bars, asOf, step }) => {
      const chart = document.createElement('section'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      Object.assign(chart.dataset, { chartInst: 'SCALE000-USDT-SWAP', chartEnd: String(asOf), chartRequestedEnd: String(asOf - step),
        chartRenderedBars: '96', chartVisualStale: 'false', chartLoading: 'false' })
      Object.assign(svg.dataset, { renderedInst: 'SCALE000-USDT-SWAP', renderedTimeframe: '15m', renderedEnd: String(asOf) })
      svg.setAttribute('aria-hidden', 'false'); svg.style.visibility = 'visible'
      label.dataset.chartPriceLabelValue = ''; label.textContent = '113.204 ↑'
      svg.append(label); chart.append(svg); document.body.prepend(chart)
      bars.forEach(Object.freeze)
      const snapshot = Object.freeze({ instId: 'SCALE000-USDT-SWAP', timeframe: '15m', endHour: asOf - step,
        bars: Object.freeze(bars), liveBar: Object.freeze({ hour: asOf, close: 113.204 }), priceObservedAt: 402,
        indicatorState: 'ready', oiState: 'loading', takerState: 'loading' })
      chart.__chartSnapshot = snapshot
      window.__resourcePaintFixture = { chart, label, snapshot }
    }, { bars, asOf, step })
    await page.evaluate(installResourcePaintProbe, fixture)
    await page.waitForFunction(() => window.__resourcePaint.records.some(window.__resourcePaint.isFrame))
    assert.equal(await page.evaluate(() => window.__resourcePaint.indicatorValuesChecked), 0)
    counter = await startRendererCPUCounter(page, { label: 'resource-probe-regression' })
    await page.evaluate(prefix => window.__resourcePaint.armCPU(prefix), counter.markerPrefix)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const stopped = await page.evaluate(() => window.__resourcePaint.stop())
    const cpu = await counter.stop()
    assert.equal(cpu.complete, true)
    assert.equal(cpu.samples[0].phase, 'start')
    assert.equal(cpu.samples.at(-1).phase, 'stop')
    assert.ok(cpu.samples.some(sample => sample.phase === 'raf'))
    assert.equal(await page.evaluate(() => window.__resourcePaint.indicatorValuesChecked), 0, 'CPU capture must end before numerical validation begins.')
    const healthy = await page.evaluate(() => window.__resourcePaint.finish())
    assert.equal(healthy.complete, true, JSON.stringify(healthy.violations))
    assert.equal(healthy.indicatorValuesChecked, 96 * 12)
    assert.equal(healthy.cpuMarkerTimings.samples, cpu.totalSamples)
    assert.equal(healthy.stopped.endedAt, stopped.endedAt)
    assert.ok(healthy.deferredValidation.reusedBarChecks > 0)

    // A new scope must retain the bad values even after the same mutable
    // source objects and the actual visible SVG label have been repaired.
    await page.evaluate(() => {
      const { chart, label, snapshot } = window.__resourcePaintFixture
      const mutableBars = snapshot.bars.map(bar => ({ ...bar }))
      mutableBars[0].ema += 7
      chart.__chartSnapshot = { ...snapshot, bars: mutableBars }
      label.textContent = '113.203 ↑'
    })
    await page.evaluate(installResourcePaintProbe, fixture)
    await page.waitForFunction(() => window.__resourcePaint.records.some(record => Number.isFinite(record.nextFrameAt)))
    await page.evaluate(() => {
      const { chart, label, snapshot } = window.__resourcePaintFixture
      chart.__chartSnapshot.bars[0].ema = snapshot.bars[0].ema
      label.textContent = '113.204 ↑'
      window.__resourcePaint.stop()
    })
    const corrupted = await page.evaluate(() => window.__resourcePaint.finish())
    assert.equal(corrupted.complete, false)
    assert.ok(corrupted.violations.some(value => /224\/ema/.test(value)))
    assert.ok(corrupted.violations.some(value => /RAF SVG live-price label/.test(value)))
    const count = corrupted.rendererCommits
    await page.evaluate(() => {
      window.__resourcePaintFixture.label.textContent = 'late mutation'
      window.__resourcePaint.recheck()
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await page.evaluate(() => window.__resourcePaint.records.length), count)
    await page.evaluate(() => {
      const { chart, label, snapshot } = window.__resourcePaintFixture
      chart.__chartSnapshot = snapshot; label.textContent = '113.204 ↑'
    })
    await page.evaluate(installResourcePaintProbe, fixture)
    await page.waitForFunction(() => window.__resourcePaint.records.some(window.__resourcePaint.isFrame))
    await page.evaluate(async () => {
      const { label } = window.__resourcePaintFixture
      label.textContent = '113.203 ↑'
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      label.textContent = '113.204 ↑'
      window.__resourcePaint.stop()
    })
    const domOnly = await page.evaluate(() => window.__resourcePaint.finish())
    assert.equal(domOnly.complete, false)
    assert.ok(domOnly.violations.some(value => /RAF SVG live-price label/.test(value)))
    context.diagnostic(JSON.stringify({ capture: healthy.captureTimings, markers: healthy.cpuMarkerTimings,
      deferred: healthy.deferredValidation, cpuSamples: cpu.totalSamples, artifact: cpu.artifact,
      corruptionViolations: corrupted.violations.length, domOnlyViolations: domOnly.violations.length }))
  } finally {
    try { await page?.evaluate(() => window.__resourcePaint?.stop()) } catch {}
    try { await counter?.stop() }
    finally { await electron?.close(); await rm(directory, { recursive: true, force: true }) }
  }
})
