import assert from 'node:assert/strict'

export async function selectTimeframe(page, timeframe) {
  const button = page.locator('[aria-label="Chart timeframe"] button')
    .filter({ hasText: new RegExp(`^${timeframe}$`, 'i') })
  await button.click()
}

export async function waitForRendered(page, fixture, timeframe = fixture.timeframe, end = fixture.end) {
  await page.waitForFunction(({ instId, timeframe, end }) => {
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    return svg?.getAttribute('data-rendered-inst') === instId
      && svg.getAttribute('data-rendered-timeframe') === timeframe
      && Number(svg.getAttribute('data-rendered-end')) === end
      && chart.getAttribute('data-chart-rendered-bars') === '96'
      && chart.getAttribute('data-chart-loading') === 'false'
  }, { instId: fixture.instId, timeframe, end }, { timeout: 20_000 })
}

export async function assertWorkspaceLayout(page) {
  const layout = await page.locator('[data-layout="market-workspace"]').evaluate(root => {
    const list = root.querySelector('[data-market-list]')
    const chart = root.querySelector('[data-chart-panel]')
    const rectangle = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
    return {
      designWidth: Number(root.dataset.designWidth), scale: Number(root.dataset.uiScale),
      viewport: { width: innerWidth, height: innerHeight }, root: rectangle(root),
      list: list ? rectangle(list) : null, chart: chart ? rectangle(chart) : null,
      documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    }
  })
  assert.equal(layout.designWidth, 1_600)
  assert.ok(layout.scale > 0)
  assert.ok(Math.abs(layout.scale - layout.viewport.width / 1_600) < 1e-5, `All UI must use one width scale: ${JSON.stringify(layout)}`)
  assert.ok(layout.list && layout.chart, 'The list and chart panel must remain mounted together.')
  assert.ok(Math.abs(layout.list.width / layout.scale - 420) < 2, 'The contract list must keep its design width.')
  assert.ok(Math.abs(layout.chart.width / layout.scale - 1_180) < 2, 'The chart panel must keep its design width.')
  assert.ok(Math.abs(layout.list.x + layout.list.width - layout.chart.x) < 2, 'The chart must sit beside the contract list.')
  assert.ok(layout.documentWidth <= layout.viewport.width + 1 && layout.documentHeight <= layout.viewport.height + 1, 'The workspace must scroll inside its panels, not the window.')
  assert.equal(await page.getByRole('button', { name: /^(?:Back to Markets|Markets)$/i }).count(), 0)
  return layout
}

export async function openChart(page, fixture, timeframe = fixture.timeframe) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click({ timeout: 15_000 })
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
  await assertWorkspaceLayout(page)
  await selectTimeframe(page, timeframe)
  await waitForRendered(page, fixture, timeframe)
}

// Inspect the actual immutable data passed to Plot and its SVG, rather than
// treating the requested viewport or an aggregate loading flag as a paint.
// __chartSnapshot is a reference to the rendered object; it avoids serializing
// 96 full bars into an attribute on every production animation frame.
export async function startPaintProbe(page, fixture) {
  await page.evaluate(({ instId, series }) => {
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    if (!(chart instanceof HTMLElement)) throw new Error('No chart surface to inspect.')
    const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'oi', 'buy', 'sell']
    const oracles = Object.fromEntries(Object.entries(series).map(([frame, entry]) => [frame, new Map(entry.bars.map(bar => [bar.hour, bar]))]))
    const probe = {
      active: true, frames: 0, paints: 0, minimumBars: Infinity, errors: [],
      frameGaps: [], commits: [], previousFrame: null, previousSnapshot: null,
      raf: null, observer: null,
    }
    const fail = message => { if (probe.errors.length < 20) probe.errors.push(message) }
    const sample = (frame = false, timestamp = performance.now()) => {
      if (frame) {
        probe.frames += 1
        if (probe.previousFrame !== null) probe.frameGaps.push(timestamp - probe.previousFrame)
        probe.previousFrame = timestamp
      }
      const snapshot = chart.__chartSnapshot
      const svg = chart.querySelector('svg[data-rendered-inst]')
      if (!snapshot || !svg) { fail('A presented chart disappeared.'); return }
      const { bars, timeframe } = snapshot
      if (Array.isArray(bars)) {
        if (Number(svg.dataset.renderedStart) !== bars[0]?.hour || Number(svg.dataset.renderedEnd) !== bars.at(-1)?.hour) fail('SVG labels and the drawn range disagree.')
        if (Number(chart.dataset.chartStart) !== bars[0]?.hour || Number(chart.dataset.chartEnd) !== bars.at(-1)?.hour) fail('Header and actual plot refer to different ranges.')
        const requestedEnd = Number(chart.dataset.chartRequestedEnd)
        if (chart.dataset.chartLoading === 'false' && requestedEnd > 0 && requestedEnd !== bars.at(-1)?.hour) fail('The chart claims completion for a different requested range.')
      }
      if (snapshot === probe.previousSnapshot) {
        if (frame && probe.commits.at(-1)?.presentedAt === null) probe.commits.at(-1).presentedAt = performance.now()
        return
      }
      probe.previousSnapshot = snapshot
      probe.paints += 1
      const intervalMS = series[timeframe]?.intervalMS
      if (!Array.isArray(bars)) { fail('The rendered snapshot has no bars.'); return }
      probe.minimumBars = Math.min(probe.minimumBars, bars.length)
      // A mutation is a React commit; the following animation frame is the
      // first paint opportunity that includes that committed SVG. Keep both
      // times so input latency does not mistake a DOM mutation for a frame.
      probe.commits.push({ at: performance.now(), presentedAt: frame ? performance.now() : null, end: bars.at(-1)?.hour, timeframe })
      if (bars.length !== 96) fail(`Rendered ${bars.length} bars for ${timeframe}.`)
      if (snapshot.instId !== instId || svg.dataset.renderedInst !== instId) fail('Mixed instrument in the rendered surface.')
      if (svg.dataset.renderedTimeframe !== timeframe) fail('SVG and snapshot timeframes disagree.')
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index]
        const expected = oracles[timeframe]?.get(bar.hour)
        if (!expected) { fail(`Unexpected ${timeframe} timestamp ${bar.hour}.`); continue }
        if (index && bar.hour - bars[index - 1].hour !== intervalMS) fail(`Noncontiguous ${timeframe} candles at ${bar.hour}.`)
        for (const field of fields) {
          const actual = bar[field], wanted = expected[field]
          if (wanted === null) {
            if (actual !== null) fail(`${timeframe} ${bar.hour} ${field}: expected missing, got ${actual}.`)
          } else if (typeof actual !== 'number' || !Number.isFinite(actual)
            || Math.abs(actual - wanted) > Math.max(1, Math.abs(wanted)) * 1e-10) {
            fail(`${timeframe} ${bar.hour} ${field}: expected ${wanted}, got ${actual}.`)
          }
        }
        if (bar.confirmed && bar.statisticsObserved !== true) fail(`Unobserved statistics published at ${bar.hour}.`)
        if (bar.indicatorsObserved !== true) fail(`Unprepared indicators published at ${bar.hour}.`)
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
  }, { instId: fixture.instId, series: fixture.series })
}

export async function finishPaintProbe(page) {
  return page.evaluate(() => {
    const probe = window.__chartPaintProbe
    if (!probe) throw new Error('No chart paint probe was installed.')
    probe.active = false
    cancelAnimationFrame(probe.raf)
    probe.observer.disconnect()
    delete window.__chartPaintProbe
    const percentile = (values, ratio) => {
      const sorted = [...values].sort((left, right) => left - right)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
    }
    return {
      frames: probe.frames, paints: probe.paints, minimumBars: probe.minimumBars,
      violations: probe.errors, commits: probe.commits,
      p95FrameGapMS: Number(percentile(probe.frameGaps, .95).toFixed(3)),
      maxFrameGapMS: Number(Math.max(0, ...probe.frameGaps).toFixed(3)),
      droppedFrames: probe.frameGaps.filter(gap => gap > 25).length,
    }
  })
}

export function assertCompletePaints(report) {
  assert.ok(report.frames > 0, 'The acceptance probe must observe presented frames.')
  assert.ok(report.paints > 0, 'The acceptance probe must inspect the real rendered snapshot.')
  assert.equal(report.minimumBars, 96, 'Every presented window must contain 96 candles.')
  assert.deepEqual(report.violations, [], 'A rendered window was incomplete, mixed, or mathematically incorrect.')
}

export async function wheelBurst(page, { frames = 1, eventsPerFrame = 1, deltaY = 12, deltaX = 0, deltaMode = 0 }) {
  return page.evaluate(async options => {
    const plot = document.querySelector('[data-chart-plot]')
    if (!(plot instanceof HTMLElement)) throw new Error('The chart plot is unavailable.')
    const inputs = []
    for (let frame = 0; frame < options.frames; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      inputs.push(performance.now())
      for (let event = 0; event < options.eventsPerFrame; event += 1) {
        plot.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: options.deltaY, deltaX: options.deltaX, deltaMode: options.deltaMode }))
      }
    }
    return inputs
  }, { frames, eventsPerFrame, deltaY, deltaX, deltaMode })
}

export async function measurePaintLatency(page, { inputs, targets }) {
  const latestInput = inputs.at(-1)
  const expectedEnd = targets.at(-1)
  await page.waitForFunction(({ latestInput, expectedEnd }) => window.__chartPaintProbe?.commits.some(commit =>
    commit.end === expectedEnd && commit.at >= latestInput && commit.presentedAt !== null), { latestInput, expectedEnd })
  return page.evaluate(({ inputs, targets }) => {
    const commits = window.__chartPaintProbe.commits
    const matching = inputs.map((input, index) => commits.find(commit => commit.end === targets[index] && commit.at >= input && commit.presentedAt !== null))
    const latencies = matching.flatMap((commit, index) => commit ? [commit.presentedAt - inputs[index]] : []).sort((left, right) => left - right)
    const percentile = ratio => Number((latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))] ?? 0).toFixed(3))
    const latest = matching.at(-1)
    return {
      committedInputs: latencies.length, supersededInputs: inputs.length - latencies.length,
      p50InputToPaintMS: percentile(.5), p95InputToPaintMS: percentile(.95),
      latestInputToPaintMS: Number((latest.presentedAt - inputs.at(-1)).toFixed(3)),
      latestInputToCommitMS: Number((latest.at - inputs.at(-1)).toFixed(3)),
    }
  }, { inputs, targets })
}

export async function waitForLocalHistory(electron, page, fixture, timeframe = fixture.timeframe) {
  const preparedBars = fixture.series[timeframe].bars.filter(bar => bar.ema !== null).length
  const deadline = Date.now() + 20_000
  while (true) {
    const requests = await readRequestProbe(electron)
    if (requests.historyResponses.some(response => response.timeframe === timeframe && response.bars === preparedBars)) break
    assert.ok(Date.now() < deadline, `The focused ${timeframe} series did not preload its ${preparedBars} initialized durable candles: ${JSON.stringify(requests.historyResponses)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  // IPC counting happens in the main process. Let the renderer receive and
  // synchronously ingest that response before starting the wheel measurement.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 2; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve))
  })
  return preparedBars
}

export async function installRequestProbe(electron, instId, { holdHistorical = false, disableLocalHistory = false } = {}) {
  await electron.evaluate(({ ipcMain }, { instId, holdHistorical, disableLocalHistory }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const { MarketService } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/services/market-service.js')
    const originalGet = MarketService.prototype.get
    const probe = {
      original, MarketService, originalGet, calls: [], active: 0, maxActive: 0,
      historyCalls: [], historyResponses: [], transferredHistoryBars: 0, transferredWindowBars: 0,
      sourceCalls: 0, sourceRequests: [], holdSource: false, holdLatest: false, latestHeld: false,
      held: false, callsAtHold: null, release: null,
    }
    const released = new Promise(resolve => { probe.release = resolve })
    MarketService.prototype.get = function (path, parameters, ...rest) {
      if (parameters?.instId === instId) {
        probe.sourceCalls += 1
        probe.sourceRequests.push({ path, parameters: { ...parameters } })
        if (probe.holdSource) return released.then(() => originalGet.call(this, path, parameters, ...rest))
      }
      return originalGet.call(this, path, parameters, ...rest)
    }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartHistory?.instId === instId) {
        probe.historyCalls.push({ ...value.chartHistory })
        const response = disableLocalHistory ? null : await original(event, value)
        const bars = response?.bars.length ?? 0
        probe.transferredHistoryBars += bars
        probe.historyResponses.push({ ...value.chartHistory, bars })
        return response
      }
      if (value.chartWindow?.instId !== instId) return original(event, value)
      probe.calls.push({ ...value.chartWindow })
      probe.active += 1
      probe.maxActive = Math.max(probe.maxActive, probe.active)
      try {
        if (probe.holdLatest && !Number.isFinite(value.chartWindow.endHour)) {
          probe.latestHeld = true
          await released
        } else if (holdHistorical && !probe.held && Number.isFinite(value.chartWindow.endHour)) {
          probe.held = true
          probe.callsAtHold = probe.calls.length
          await released
        }
        const response = await original(event, value)
        probe.transferredWindowBars += response?.bars.length ?? 0
        return response
      } finally { probe.active -= 1 }
    })
    globalThis.__chartRequestProbe = probe
  }, { instId, holdHistorical, disableLocalHistory })
}

export async function releaseRequestProbe(electron) {
  await electron.evaluate(() => globalThis.__chartRequestProbe?.release())
}

export async function readRequestProbe(electron) {
  return electron.evaluate(() => {
    const probe = globalThis.__chartRequestProbe
    return {
      calls: probe.calls, active: probe.active, maxActive: probe.maxActive,
      historyCalls: probe.historyCalls, historyResponses: probe.historyResponses,
      transferredHistoryBars: probe.transferredHistoryBars, transferredWindowBars: probe.transferredWindowBars,
      transferredBars: probe.transferredHistoryBars + probe.transferredWindowBars,
      sourceCalls: probe.sourceCalls, sourceRequests: probe.sourceRequests, held: probe.held, latestHeld: probe.latestHeld, callsAtHold: probe.callsAtHold,
    }
  })
}

export async function removeRequestProbe(electron) {
  await electron.evaluate(({ ipcMain }) => {
    const probe = globalThis.__chartRequestProbe
    if (!probe) return
    probe.release()
    probe.MarketService.prototype.get = probe.originalGet
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', probe.original)
    delete globalThis.__chartRequestProbe
  })
}
