import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

const root = new URL('..', import.meta.url).pathname
const HISTORY_PREVIEW_DELAY_MS = 1_500

async function waitForTimeframe(page, label) {
  await page.waitForFunction(value => {
    const button = [...document.querySelectorAll('[aria-label="Chart timeframe"] button')]
      .find(candidate => candidate.textContent?.trim().toLowerCase() === value.toLowerCase())
    return button?.getAttribute('data-state') === 'on'
      || button?.getAttribute('data-pressed') === 'true'
      || button?.getAttribute('aria-pressed') === 'true'
  }, label)
}

async function waitForChartReady(page, fixture) {
  await page.waitForFunction(({ instId, end }) => {
    const element = document.querySelector(`[data-chart-inst="${instId}"]`)
    return Number(element?.getAttribute('data-chart-end')) === end
      && element?.getAttribute('data-chart-rendered-bars') === '96'
      && element?.getAttribute('data-chart-loading') === 'false'
      && element?.getAttribute('data-chart-incomplete') === 'false'
      && element?.getAttribute('data-chart-candle-state') === 'ready'
      && element?.getAttribute('data-chart-statistics-state') === 'ready'
  }, fixture)
}

async function openBenchmarkChart(page, fixture) {
  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 15_000 })
  await market.click()
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible', timeout: 15_000 })
  await waitForTimeframe(page, fixture.timeframe)
  await waitForChartReady(page, fixture)
}

async function withBenchmarkApp({ previewDelayMS }, run) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-'))
  let electron
  try {
    electron = await _electron.launch({
      args: ['.', '--headless', '--disable-gpu'],
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        PERPETUAL_SWAP_E2E: '1',
        PERPETUAL_SWAP_E2E_PREVIEW_DELAY_MS: String(previewDelayMS),
        PERPETUAL_SWAP_USER_DATA: userData,
      },
    })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openBenchmarkChart(page, fixture)
    return { fixture, result: await run(page, fixture) }
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
}

async function startVisualProbe(page, instId) {
  await page.evaluate(id => {
    const chart = document.querySelector(`[data-chart-inst="${id}"]`)
    if (!(chart instanceof HTMLElement)) throw new Error('The chart was unavailable before the timeframe transition.')
    const probe = {
      active: true,
      samples: [],
      minimumRenderedBars: Infinity,
      zeroObserved: false,
      staleObserved: false,
      raf: 0,
      observer: null,
    }
    const sample = () => {
      const renderedBars = Number(chart.dataset.chartRenderedBars)
      const stale = chart.dataset.chartVisualStale === 'true'
      probe.samples.push({ renderedBars, stale })
      probe.minimumRenderedBars = Math.min(probe.minimumRenderedBars, renderedBars)
      probe.zeroObserved ||= !Number.isFinite(renderedBars) || renderedBars <= 0
      probe.staleObserved ||= stale
    }
    probe.observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.attributeName === 'data-chart-rendered-bars' && record.oldValue === '0') probe.zeroObserved = true
        if (record.attributeName === 'data-chart-visual-stale' && record.oldValue === 'true') probe.staleObserved = true
      }
      sample()
    })
    probe.observer.observe(chart, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-chart-rendered-bars', 'data-chart-target-bars', 'data-chart-visual-stale'],
    })
    const sampleFrame = () => {
      if (!probe.active) return
      sample()
      probe.raf = requestAnimationFrame(sampleFrame)
    }
    sample()
    probe.raf = requestAnimationFrame(sampleFrame)
    window.__chartVisualProbe = probe
  }, instId)
}

async function finishVisualProbe(page) {
  return page.evaluate(() => {
    const probe = window.__chartVisualProbe
    if (!probe) throw new Error('The chart visual probe was not installed.')
    probe.active = false
    cancelAnimationFrame(probe.raf)
    probe.observer?.disconnect()
    delete window.__chartVisualProbe
    return {
      observations: probe.samples.length,
      minimumRenderedBars: probe.minimumRenderedBars,
      zeroObserved: probe.zeroObserved,
      staleObserved: probe.staleObserved,
    }
  })
}

async function verifyFastTimeframeTransition(page, fixture) {
  await startVisualProbe(page, fixture.instId)
  const selector = '[aria-label="Chart timeframe"] button'
  await page.locator(selector).filter({ hasText: new RegExp(`^${fixture.alternateTimeframe}$`, 'i') }).click()
  // Wait only for the selection commit, not for its data request: the next
  // click deliberately interrupts the first load just as a fast user does.
  await waitForTimeframe(page, fixture.alternateTimeframe)
  await page.locator(selector).filter({ hasText: /^1h$/i }).click()
  await waitForTimeframe(page, fixture.timeframe)
  await waitForChartReady(page, fixture)
  const report = await finishVisualProbe(page)
  assert.equal(report.zeroObserved, false, 'A fast timeframe change removed the rendered chart surface.')
  assert.ok(report.minimumRenderedBars > 0, 'A fast timeframe change produced an empty chart surface.')
  return report
}

async function runScrollBenchmark(page, fixture) {
  return page.evaluate(async ({ instId, end, warmFrames, boundaryFrames, intervalMS }) => {
    const period = intervalMS
    const perFrameCandles = 12
    const percentile = (values, ratio) => {
      const ordered = [...values].sort((left, right) => left - right)
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0
    }
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    const plot = document.querySelector('[data-chart-plot]')
    if (!(chart instanceof HTMLElement) || !(plot instanceof HTMLElement)) throw new Error('The benchmark chart did not render.')
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const waitFor = async (predicate, timeout = 10_000, expected = '') => {
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        if (predicate()) return
        await nextFrame()
      }
      throw new Error(`Timed out waiting for a chart paint${expected ? ` (${expected}; actual ${chart.dataset.chartEnd})` : ''}.`)
    }
    const longTasks = []
    let observer
    try {
      observer = new PerformanceObserver(entries => longTasks.push(...entries.getEntries().map(entry => entry.duration)))
      observer.observe({ type: 'longtask', buffered: true })
    } catch {}
    const commits = []
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'data-chart-end')) {
        commits.push({ at: performance.now(), end: Number(chart.dataset.chartEnd) })
      }
    })
    mutations.observe(chart, { attributes: true, attributeFilter: ['data-chart-end'] })
    const waitForStableEnd = async () => {
      let stableFrames = 0
      let previousEnd = chart.dataset.chartEnd
      while (stableFrames < 3) {
        await nextFrame()
        if (chart.dataset.chartEnd === previousEnd) stableFrames += 1
        else {
          previousEnd = chart.dataset.chartEnd
          stableFrames = 0
        }
      }
      return Number(previousEnd)
    }
    const sweep = async (frames, expectedEnd) => {
      const inputs = []
      const frameGaps = []
      let previousFrame = performance.now()
      for (let index = 0; index < frames; index += 1) {
        const frame = await new Promise(resolve => requestAnimationFrame(resolve))
        frameGaps.push(frame - previousFrame)
        previousFrame = frame
        inputs.push(performance.now())
        plot.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 144 }))
      }
      if (typeof expectedEnd === 'number') {
        await waitFor(() => Number(chart.dataset.chartEnd) === expectedEnd, 10_000, `expected ${expectedEnd}`)
      } else {
        await waitFor(() => {
          const currentEnd = Number(chart.dataset.chartEnd)
          return currentEnd >= expectedEnd.min && currentEnd <= expectedEnd.max
        }, 10_000, `expected between ${expectedEnd.min} and ${expectedEnd.max}`)
      }
      await waitForStableEnd()
      const settledAt = performance.now()
      const inputToCommit = inputs.map(input => (commits.find(commit => commit.at >= input)?.at ?? settledAt) - input)
      return {
        frames,
        end: Number(chart.dataset.chartEnd),
        renderedBars: Number(chart.dataset.chartRenderedBars),
        loading: chart.dataset.chartLoading,
        incomplete: chart.dataset.chartIncomplete,
        candleState: chart.dataset.chartCandleState,
        statisticsState: chart.dataset.chartStatisticsState,
        p50InputToCommitMS: Number(percentile(inputToCommit, .5).toFixed(3)),
        p95InputToCommitMS: Number(percentile(inputToCommit, .95).toFixed(3)),
        maxInputToCommitMS: Number(Math.max(...inputToCommit).toFixed(3)),
        droppedFrames: frameGaps.filter(gap => gap > 25).length,
        maxFrameGapMS: Number(Math.max(...frameGaps).toFixed(3)),
      }
    }

    try {
      const warmExpected = end - warmFrames * perFrameCandles * period
      const warm = await sweep(warmFrames, warmExpected)
      // The native 1H result initially keeps 500 chart candles. This phase
      // reaches that resident floor while the passive prefetch races it.
      const boundaryStarted = performance.now()
      const boundary = await sweep(boundaryFrames, {
        min: end - 408 * period,
        max: end - 404 * period,
      })
      await waitFor(() => Number(chart.dataset.chartCacheStart) <= end - 900 * period)
      const cacheExtensionFromBoundaryMS = performance.now() - boundaryStarted
      const resumedExpected = boundary.end - 8 * perFrameCandles * period
      const resumed = await sweep(8, resumedExpected)
      return {
        periodMS: period,
        warm,
        boundary,
        cacheExtensionFromBoundaryMS: Number(cacheExtensionFromBoundaryMS.toFixed(3)),
        resumed,
        mode: 'headless-controller-latency',
        longTasks: longTasks.length,
        longestLongTaskMS: Number(Math.max(0, ...longTasks).toFixed(3)),
        cacheStart: Number(chart.dataset.chartCacheStart),
      }
    } finally {
      mutations.disconnect()
      observer?.disconnect()
    }
  }, fixture)
}

async function runLatePreviewRegression(page, fixture) {
  return page.evaluate(async ({ instId, end, warmFrames, boundaryFrames, intervalMS }) => {
    const period = intervalMS
    const perFrameCandles = 12
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    const plot = document.querySelector('[data-chart-plot]')
    if (!(chart instanceof HTMLElement) || !(plot instanceof HTMLElement)) throw new Error('The regression chart did not render.')
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const waitFor = async (predicate, timeout = 10_000, expected = '') => {
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        if (predicate()) return
        await nextFrame()
      }
      throw new Error(`Timed out waiting for ${expected || 'the delayed history response'}.`)
    }
    const scroll = async frames => {
      for (let index = 0; index < frames; index += 1) {
        await nextFrame()
        plot.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 144 }))
      }
    }

    const initialCacheStart = Number(chart.dataset.chartCacheStart)
    const residentFloor = initialCacheStart + 95 * period
    await scroll(warmFrames)
    await waitFor(() => Number(chart.dataset.chartEnd) === end - warmFrames * perFrameCandles * period, 5_000, 'the warm scroll')
    await scroll(boundaryFrames)
    await waitFor(() => Number(chart.dataset.chartEnd) === residentFloor, 5_000, 'the resident history floor')
    // These are intentionally discarded inputs. Before the fix, they stayed
    // in the wheel queue and replayed when a delayed response extended cache.
    await scroll(4)
    const endAfterStoppedInput = Number(chart.dataset.chartEnd)
    const extensionTarget = initialCacheStart - 400 * period
    const cacheWasDelayedAtFloor = Number(chart.dataset.chartCacheStart) > extensionTarget
    await waitFor(() => Number(chart.dataset.chartCacheStart) <= extensionTarget, 15_000, 'the delayed preview cache extension')
    const endWhenDataArrived = Number(chart.dataset.chartEnd)
    for (let index = 0; index < 5; index += 1) await nextFrame()
    const endAfterIdle = Number(chart.dataset.chartEnd)
    await scroll(8)
    const endAfterFreshInput = residentFloor - 8 * perFrameCandles * period
    await waitFor(() => Number(chart.dataset.chartEnd) === endAfterFreshInput, 5_000, 'fresh user input after the cache extension')
    return {
      periodMS: period,
      initialCacheStart,
      residentFloor,
      cacheStartAfterExtension: Number(chart.dataset.chartCacheStart),
      cacheWasDelayedAtFloor,
      endAfterStoppedInput,
      endWhenDataArrived,
      endAfterIdle,
      endAfterFreshInput: Number(chart.dataset.chartEnd),
    }
  }, fixture)
}

const normal = await withBenchmarkApp({ previewDelayMS: 0 }, async (page, fixture) => {
  const timeframeTransition = await verifyFastTimeframeTransition(page, fixture)
  const report = await runScrollBenchmark(page, fixture)
  assert.equal(report.periodMS, fixture.intervalMS)
  assert.equal(report.warm.end, fixture.end - fixture.warmFrames * 12 * fixture.intervalMS)
  assert.equal(report.warm.renderedBars, 96)
  assert.equal(report.warm.loading, 'false')
  assert.equal(report.warm.incomplete, 'false')
  assert.equal(report.warm.candleState, 'ready')
  assert.equal(report.warm.statisticsState, 'ready')
  assert.equal(report.boundary.renderedBars, 96)
  assert.equal(report.boundary.loading, 'false')
  assert.equal(report.boundary.incomplete, 'false')
  assert.equal(report.boundary.candleState, 'ready')
  assert.equal(report.boundary.statisticsState, 'ready')
  assert.ok(report.boundary.end >= fixture.end - 408 * fixture.intervalMS)
  assert.ok(report.boundary.end <= fixture.end - 404 * fixture.intervalMS)
  assert.equal(report.resumed.end, report.boundary.end - 8 * 12 * fixture.intervalMS)
  assert.equal(report.resumed.renderedBars, 96)
  assert.equal(report.resumed.loading, 'false')
  assert.equal(report.resumed.incomplete, 'false')
  assert.equal(report.resumed.candleState, 'ready')
  assert.equal(report.resumed.statisticsState, 'ready')
  assert.ok(report.cacheStart <= fixture.end - 900 * fixture.intervalMS)
  return { timeframeTransition, report }
})

const latePreview = await withBenchmarkApp({ previewDelayMS: HISTORY_PREVIEW_DELAY_MS }, async (page, fixture) => {
  const report = await runLatePreviewRegression(page, fixture)
  assert.equal(report.periodMS, fixture.intervalMS)
  assert.equal(report.cacheWasDelayedAtFloor, true, 'The E2E delay did not hold history data past the resident floor.')
  assert.equal(report.endAfterStoppedInput, report.residentFloor)
  assert.equal(report.endWhenDataArrived, report.residentFloor, 'A delayed history response replayed old wheel input.')
  assert.equal(report.endAfterIdle, report.residentFloor, 'The chart advanced without new user input after history arrived.')
  assert.equal(report.endAfterFreshInput, report.residentFloor - 8 * 12 * fixture.intervalMS)
  return report
})

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixture: normal.fixture,
  performance: normal.result,
  latePreviewRegression: { delayedByMS: HISTORY_PREVIEW_DELAY_MS, ...latePreview.result },
}, null, 2))
