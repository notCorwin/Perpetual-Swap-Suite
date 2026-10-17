import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { assertCompletePaints, finishPaintProbe, installRequestProbe, openChart, readRequestProbe, releaseRequestProbe, removeRequestProbe, selectTimeframe, startPaintProbe, waitForRendered, wheelBurst } from './chart-acceptance.mjs'

const root = new URL('..', import.meta.url).pathname

async function withBenchmarkApp(run) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-radar-chart-scroll-'))
  let electron
  try {
    electron = await _electron.launch({
      args: ['.', '--headless', '--disable-gpu'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData },
    })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const fixture = await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedChartScrollBenchmark' } }))
    await openChart(page, fixture)
    return await run(electron, page, fixture)
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
}

const performanceReport = await withBenchmarkApp(async (electron, page, fixture) => {
  const timeframes = []
  for (const timeframe of fixture.timeframes) {
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, fixture, timeframe)
    await installRequestProbe(electron, fixture.instId)
    await startPaintProbe(page, fixture)
    try {
      const intervalMS = fixture.series[timeframe].intervalMS
      const phases = []
      let distance = 0
      const sweep = async (name, options, candles) => {
        const startingDistance = distance
        const inputs = await wheelBurst(page, options)
        distance += candles
        const end = fixture.end - distance * intervalMS
        await waitForRendered(page, fixture, timeframe, end)
        const observation = await page.evaluate(({ expectedEnd, inputs, targets }) => {
          const commits = window.__chartPaintProbe.commits
          const latencies = inputs.flatMap((input, index) => {
            const commit = commits.find(commit => commit.end === targets[index] && commit.at >= input)
            return commit ? [commit.at - input] : []
          }).sort((left, right) => left - right)
          const percentile = ratio => Number((latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))] ?? 0).toFixed(3))
          return {
            paintedAt: commits.findLast(commit => commit.end === expectedEnd)?.at ?? performance.now(), settledAt: performance.now(),
            committedInputs: latencies.length, supersededInputs: inputs.length - latencies.length,
            p50InputToPaintMS: percentile(.5), p95InputToPaintMS: percentile(.95),
          }
        }, { expectedEnd: end, inputs, targets: inputs.map((_, index) => fixture.end - (startingDistance + candles / inputs.length * (index + 1)) * intervalMS) })
        phases.push({
          name, frames: options.frames ?? 1, eventsPerFrame: options.eventsPerFrame ?? 1,
          candles, end, committedInputs: observation.committedInputs, supersededInputs: observation.supersededInputs,
          p50InputToPaintMS: observation.p50InputToPaintMS, p95InputToPaintMS: observation.p95InputToPaintMS,
          latestInputToPaintMS: Number(Math.max(0, observation.paintedAt - inputs.at(-1)).toFixed(3)),
          latestInputToSettledMS: Number(Math.max(0, observation.settledAt - inputs.at(-1)).toFixed(3)),
        })
      }
      await sweep('resident', { frames: 18, eventsPerFrame: 3, deltaY: 12 }, 54)
      await sweep('high-velocity', { frames: 12, eventsPerFrame: 32, deltaY: 24 }, 768)
      await sweep('reversal', { frames: 6, eventsPerFrame: 32, deltaY: -24 }, -384)
      await sweep('one-frame-1200-candle-jump', { deltaY: 14_400 }, 1_200)
      await sweep('horizontal-reversal', { deltaX: 2_400, deltaY: 0 }, -200)
      await sweep('line-mode', { deltaY: -9, deltaMode: 1 }, -12)
      const paint = await finishPaintProbe(page)
      assertCompletePaints(paint)
      const requests = await readRequestProbe(electron)
      assert.equal(requests.maxActive, 1, 'The chart must serialize preparation and coalesce pending input.')
      assert.equal(requests.sourceCalls, 0, `Scrolling complete durable data must not redownload it: ${JSON.stringify(requests.sourceRequests)}`)
      timeframes.push({
        timeframe, phases, ...paint, commits: paint.commits.length,
        preparedRequests: requests.calls.length, maxConcurrentRequests: requests.maxActive,
        repeatedSourceDownloads: requests.sourceCalls,
      })
    } finally { await removeRequestProbe(electron) }
  }
  return { nativePeriods: fixture.timeframes, persistedPeriodsPerTimeframe: fixture.periods, timeframes }
})

const delayedHistory = await withBenchmarkApp(async (electron, page, fixture) => {
  // Prime native latest snapshots before measuring history. A first visit
  // legitimately checks the live tail and is not a duplicate history read.
  for (const timeframe of fixture.timeframes) {
    await selectTimeframe(page, timeframe)
    await waitForRendered(page, fixture, timeframe)
  }
  await installRequestProbe(electron, fixture.instId, { holdHistorical: true })
  await startPaintProbe(page, fixture)
  try {
    const started = Date.now()
    await wheelBurst(page, { deltaY: 14_400 })
    while (!(await readRequestProbe(electron)).held) {
      assert.ok(Date.now() - started < 10_000, 'The chart did not request its uncached target.')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await wheelBurst(page, { frames: 4, eventsPerFrame: 32, deltaY: 12 })
    await wheelBurst(page, { frames: 2, eventsPerFrame: 32, deltaY: -12 })
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - started))))
    const expectedEnd = fixture.end - 1_264 * fixture.intervalMS
    const heldEnd = Number(await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-end'))
    assert.equal(heldEnd, fixture.end, 'An incomplete target must never replace the last correct paint.')
    const heldRequests = await readRequestProbe(electron)
    assert.equal(heldRequests.calls.length, heldRequests.callsAtHold, `A held request must not accumulate an IPC backlog: ${JSON.stringify(heldRequests.calls)}`)
    await releaseRequestProbe(electron)
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    await selectTimeframe(page, '5m')
    await selectTimeframe(page, '15m')
    await selectTimeframe(page, '1H')
    await waitForRendered(page, fixture)
    const paint = await finishPaintProbe(page)
    assertCompletePaints(paint)
    const requests = await readRequestProbe(electron)
    assert.equal(requests.sourceCalls, 0, `Prepared timeframe switches unexpectedly downloaded source data: ${JSON.stringify(requests.sourceRequests)}`)
    assert.ok(!paint.commits.some(commit => commit.end === fixture.end - 1_200 * fixture.intervalMS), 'An obsolete held target was drawn after newer input.')
    return {
      heldForMS: 1_500, heldEnd, expectedEnd, latestIntentPreserved: true,
      ...paint, commits: paint.commits.length,
      preparedRequests: requests.calls.length, maxConcurrentRequests: requests.maxActive,
      repeatedSourceDownloads: requests.sourceCalls,
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
})

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'real-electron-svg-frame-correctness-and-controller-latency',
  performance: performanceReport,
  delayedHistory,
}, null, 2))
