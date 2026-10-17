import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'

const root = new URL('..', import.meta.url).pathname
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
      PERPETUAL_SWAP_USER_DATA: userData,
    },
  })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
  await page.reload({ waitUntil: 'domcontentloaded' })

  const market = page.locator(`[aria-label="View ${fixture.instId} chart"]`)
  await market.waitFor({ state: 'visible', timeout: 15_000 })
  await market.click()
  const chart = page.locator(`[data-chart-inst="${fixture.instId}"]`)
  await chart.waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^5m$/ }).click()
  await page.waitForFunction(({ instId, end }) => {
    const element = document.querySelector(`[data-chart-inst="${instId}"]`)
    return Number(element?.getAttribute('data-chart-end')) === end
      && element?.getAttribute('data-chart-rendered-bars') === '96'
      && element?.getAttribute('data-chart-loading') === 'false'
      && element?.getAttribute('data-chart-incomplete') === 'false'
      && element?.getAttribute('data-chart-candle-state') === 'ready'
      && element?.getAttribute('data-chart-statistics-state') === 'ready'
  }, fixture)

  const report = await page.evaluate(async ({ instId, end, warmFrames, boundaryFrames }) => {
    const period = 300_000
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
      const inputs = [], frameGaps = []
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

    const warmExpected = end - warmFrames * perFrameCandles * period
    const warm = await sweep(warmFrames, warmExpected)

    // The resident range ends 499 candles before the initial end. This sweep
    // crosses its 96-candle viewport floor. Depending on whether the async
    // prefetch finishes during the sweep, it can settle at the old floor or
    // four candles beyond it; both are correct, and the next phase verifies
    // that the newly prefetched range makes movement continuous.
    const boundaryStarted = performance.now()
    const boundary = await sweep(boundaryFrames, {
      min: end - 408 * period,
      max: end - 404 * period,
    })
    await waitFor(() => Number(chart.dataset.chartCacheStart) <= end - 900 * period)
    const cacheExtensionFromBoundaryMS = performance.now() - boundaryStarted
    const resumedExpected = boundary.end - 8 * perFrameCandles * period
    const resumed = await sweep(8, resumedExpected)
    mutations.disconnect()
    observer?.disconnect()
    return {
      warm,
      boundary,
      cacheExtensionFromBoundaryMS: Number(cacheExtensionFromBoundaryMS.toFixed(3)),
      resumed,
      mode: 'headless-controller-latency',
      longTasks: longTasks.length,
      longestLongTaskMS: Number(Math.max(0, ...longTasks).toFixed(3)),
      cacheStart: Number(chart.dataset.chartCacheStart),
    }
  }, fixture)

  assert.equal(report.warm.end, fixture.end - fixture.warmFrames * 12 * 300_000)
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
  assert.ok(report.boundary.end >= fixture.end - 408 * 300_000)
  assert.ok(report.boundary.end <= fixture.end - 404 * 300_000)
  assert.equal(report.resumed.end, report.boundary.end - 8 * 12 * 300_000)
  assert.equal(report.resumed.renderedBars, 96)
  assert.equal(report.resumed.loading, 'false')
  assert.equal(report.resumed.incomplete, 'false')
  assert.equal(report.resumed.candleState, 'ready')
  assert.equal(report.resumed.statisticsState, 'ready')
  assert.ok(report.cacheStart <= fixture.end - 900 * 300_000)
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), fixture, report }, null, 2))
} finally {
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
}
