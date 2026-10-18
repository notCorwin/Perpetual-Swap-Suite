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
      && Number(chart.getAttribute('data-chart-completed-end') ?? svg.getAttribute('data-rendered-end')) === end
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
export async function startPaintProbe(page, fixture, { requireMatureData = false } = {}) {
  await page.evaluate(({ instId, series, requireMatureData }) => {
    const chart = document.querySelector(`[data-chart-inst="${instId}"]`)
    if (!(chart instanceof HTMLElement)) throw new Error('No chart surface to inspect.')
    const fields = ['open', 'high', 'low', 'close', 'vwap', 'ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'oi', 'buy', 'sell']
    const indicatorFields = fields.slice(4, 14), statisticFields = ['oi', 'buy', 'sell']
    const oracles = Object.fromEntries(Object.entries(series).map(([frame, entry]) => [frame, new Map(entry.bars.map(bar => [bar.hour, bar]))]))
    const probe = {
      active: true, frames: 0, pendingFrames: 0, paints: 0, minimumBars: Infinity, errors: [],
      frameGaps: [], commits: [], previousFrame: null, previousSnapshot: null,
      phase: 'initial', quality: [], known: new Map(), geometry: new Map(),
      raf: null, observer: null,
    }
    const fail = message => { if (probe.errors.length < 20) probe.errors.push(message) }
    const sample = (frame = false, timestamp = performance.now()) => {
      if (frame) {
        probe.frames += 1
        if (chart.dataset.chartLoading === 'true') probe.pendingFrames += 1
        if (probe.previousFrame !== null) probe.frameGaps.push(timestamp - probe.previousFrame)
        probe.previousFrame = timestamp
      }
      const snapshot = chart.__chartSnapshot
      const svg = chart.querySelector('svg[data-rendered-inst]')
      if (!snapshot || !svg) { fail('A presented chart disappeared.'); return }
      const { timeframe } = snapshot
      const bars = chart.__chartRenderedBars ?? snapshot.bars
      if (Array.isArray(bars)) {
        if (Number(svg.dataset.renderedStart) !== bars[0]?.hour || Number(svg.dataset.renderedEnd) !== bars.at(-1)?.hour) fail('SVG labels and the drawn range disagree.')
        if (Number(chart.dataset.chartStart) !== bars[0]?.hour || Number(chart.dataset.chartEnd) !== bars.at(-1)?.hour) fail('Header and actual plot refer to different ranges.')
        const requestedEnd = Number(chart.dataset.chartRequestedEnd)
        if (chart.dataset.chartLoading === 'false' && requestedEnd > 0 && requestedEnd !== snapshot.endHour) fail('The chart claims completion for a different requested range.')
      }
      // Plot geometry may change without a new snapshot (for example during
      // an effect). Check actual paths before the immutable-snapshot shortcut.
      if (Array.isArray(bars)) {
        const firstAtLeft = bars[0]?.hour === bars.at(-1)?.hour - 95 * snapshot.intervalMS
        for (const field of [...indicatorFields, 'oi']) {
          const samples = bars.filter(bar => typeof bar[field] === 'number' && Number.isFinite(bar[field])).length
          const path = svg.querySelector(`[data-chart-indicator="${field}"]`), d = path?.getAttribute('d') ?? ''
          if (samples > 1 && !d) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost its ${field} SVG curve with ${samples} known samples.`)
          if (probe.geometry.get(field) === d && snapshot === probe.previousSnapshot) continue
          probe.geometry.set(field, d)
          const points = (d.match(/[ML]/g) ?? []).length
          const expectedPoints = samples + (firstAtLeft && Number.isFinite(bars[0]?.[field]) ? 1 : 0)
          if (points !== expectedPoints) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} ${field} SVG has ${points} points for ${expectedPoints} known positions.`)
        }
        if (requireMatureData) {
          for (const field of indicatorFields) if (!svg.querySelector(`[data-chart-indicator="${field}"]`)?.getAttribute('d')) fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} has no ${field} SVG curve for mature local history.`)
          if (svg.querySelector('[data-chart-oi]')?.getAttribute('data-chart-oi') !== 'complete') fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost complete OI geometry.`)
          if (svg.querySelector('[data-chart-taker]')?.getAttribute('data-chart-taker') !== 'complete') fail(`${probe.phase}: ${timeframe} ${snapshot.endHour} lost complete Taker geometry.`)
        }
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
      probe.commits.push({ at: performance.now(), presentedAt: frame ? performance.now() : null, end: snapshot.endHour, timeframe, phase: probe.phase })
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
        for (const field of fields.filter(field => {
          if (['open', 'high', 'low', 'close'].includes(field)) return true
          if (requireMatureData && Number.isFinite(expected[field])) return true
          if (field === 'oi') return bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)
          if (field === 'buy' || field === 'sell') return bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)
          return bar.indicatorsObserved
        })) {
          const actual = bar[field], wanted = expected[field]
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
  }, { instId: fixture.instId, series: fixture.series, requireMatureData })
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
      frames: probe.frames, pendingFrames: probe.pendingFrames, paints: probe.paints, minimumBars: probe.minimumBars,
      violations: probe.errors, commits: probe.commits, quality: probe.quality,
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
  await wheelBurst(page, { deltaY: 12 })
  const deadline = Date.now() + 20_000
  let resident = 0
  while (Date.now() < deadline) {
    const requests = await readRequestProbe(electron)
    resident = requests.historyResponses.filter(response => response.timeframe === timeframe).at(-1)?.bars ?? 0
    if (resident > 96) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(resident > 96 && resident <= 1536, `History hydration must return a bounded price reserve: ${resident}`)
  await page.evaluate(async () => { for (let frame = 0; frame < 2; frame += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
  await wheelBurst(page, { deltaY: -12 })
  await waitForRendered(page, fixture, timeframe)
  return resident
}

export function separateSourceMaintenance(sourceRequests, fixture) {
  const historical = [], historicalExtensions = [], currentMaintenance = []
  const maxIntervalMS = Math.max(...Object.values(fixture.series).map(series => series.intervalMS))
  for (const request of sourceRequests) {
    const parameters = request.parameters ?? {}
    const after = Number(parameters.after), limit = Number(parameters.limit)
    const intervalMS = fixture.series[parameters.bar]?.intervalMS
    const latestCandles = request.path === '/market/candles' && limit === 2 && Number.isFinite(intervalMS)
      && parameters.after == null && parameters.before == null
    // Ranking refreshes read four recent 5m closes. Exclude them only when
    // their entire requested window is provably later than the chart fixture.
    const currentCandles = request.path === '/market/history-candles' && limit === 4
      && Number.isFinite(intervalMS) && Number.isFinite(after)
      && after > fixture.end + maxIntervalMS && after - limit * intervalMS > fixture.end
    const begin = Number(parameters.begin), end = Number(parameters.end)
    const currentRange = Number.isFinite(begin) && Number.isFinite(end) && end >= begin && begin > fixture.end
    const candleStart = fixture.series[parameters.bar]?.bars?.[0]?.hour
    const statisticsStart = fixture.series[parameters.period]?.bars?.[0]?.hour
    // Candle `after` and both statistics boundaries are exclusive (see
    // MarketHistory.fetchPrices/fetchStatistics), so equality with the first
    // persisted source period still proves a wholly older request.
    const olderCandles = request.path === '/market/history-candles' && Number.isFinite(after)
      && Number.isFinite(candleStart) && after <= candleStart && Number.isFinite(limit) && limit > 0
    const olderStatistics = ['/rubik/stat/contracts/open-interest-history', '/rubik/stat/taker-volume-contract'].includes(request.path)
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

export async function installRequestProbe(electron, instId, { holdHistorical = false, disableLocalHistory = false, initialHistoryBars = null, capHistoricalWindows = false, historicalDelayMS = 0 } = {}) {
  await electron.evaluate(async ({ ipcMain, BrowserWindow }, { instId, holdHistorical, disableLocalHistory, initialHistoryBars, capHistoricalWindows, historicalDelayMS }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const originalSend = contents.send
    await globalThis.__marketBackend.probe({ action: 'sourceInstall', instId })
    const probe = {
      original, contents, originalSend, calls: [], active: 0, maxActive: 0,
      historicalActive: 0, maxHistoricalActive: 0,
      historyCalls: [], historyResponses: [], transferredHistoryBars: 0, transferredWindowBars: 0,
      sourceCalls: 0, sourceRequests: [], holdSource: false, holdLatest: false, latestHeld: false,
      held: false, callsAtHold: null, release: null,
    }
    // Model a durable range that has not reached the renderer yet. Every
    // compact/local ingress observes the same cutoff, including pushed data,
    // while an actual historical prepare may extend it using the real store.
    const initialRange = response => {
      if (!Number.isSafeInteger(initialHistoryBars) || response?.instId !== instId || !Array.isArray(response.bars)) return response
      const first = response.latestEnd - (initialHistoryBars - 1) * response.intervalMS
      return { ...response, bars: response.bars.filter(bar => bar.hour >= first) }
    }
    contents.send = function (channel, ...args) {
      if (channel === 'radar:chart-prepared') args[0] = initialRange(args[0])
      return originalSend.call(this, channel, ...args)
    }
    const released = new Promise(resolve => { probe.release = resolve })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartHistory?.instId === instId) {
        probe.historyCalls.push({ ...value.chartHistory })
        const response = disableLocalHistory ? null : initialRange(await original(event, value))
        const bars = response?.bars.length ?? 0
        probe.transferredHistoryBars += bars
        probe.historyResponses.push({ ...value.chartHistory, bars })
        return response
      }
      if (value.chartWindow?.instId !== instId) {
        const response = await original(event, value)
        return value.chartUniverse ? { ...response, frames: response.frames.map(initialRange) }
          : value.chartLocal ? initialRange(response) : response
      }
      const historical = Number.isFinite(value.chartWindow.endHour)
      const call = { ...value.chartWindow, startedAt: Date.now(), completedAt: null }
      probe.calls.push(call)
      probe.active += 1
      probe.maxActive = Math.max(probe.maxActive, probe.active)
      if (historical) {
        probe.historicalActive += 1
        probe.maxHistoricalActive = Math.max(probe.maxHistoricalActive, probe.historicalActive)
      }
      try {
        if (probe.holdLatest && !Number.isFinite(value.chartWindow.endHour)) {
          probe.latestHeld = true
          await released
        } else if (holdHistorical && !probe.held && Number.isFinite(value.chartWindow.endHour)) {
          probe.held = true
          probe.callsAtHold = probe.calls.length
          await released
        }
        if (historical && historicalDelayMS > 0) await new Promise(resolve => setTimeout(resolve, historicalDelayMS))
        const response = await original(event, value)
        probe.transferredWindowBars += response?.bars.length ?? 0
        return historical && !capHistoricalWindows ? response : initialRange(response)
      } finally {
        call.completedAt = Date.now()
        probe.active -= 1
        if (historical) probe.historicalActive -= 1
      }
    })
    globalThis.__chartRequestProbe = probe
  }, { instId, holdHistorical, disableLocalHistory, initialHistoryBars, capHistoricalWindows, historicalDelayMS })
}

export async function releaseRequestProbe(electron) {
  await electron.evaluate(async () => { globalThis.__chartRequestProbe?.release(); await globalThis.__marketBackend.probe({ action: 'sourceRelease' }) })
}

export async function readRequestProbe(electron) {
  return electron.evaluate(async () => {
    const probe = globalThis.__chartRequestProbe
    const sourceRequests = await globalThis.__marketBackend.probe({ action: 'sourceRead' })
    return {
      calls: probe.calls, active: probe.active, maxActive: probe.maxActive,
      historicalActive: probe.historicalActive, maxHistoricalActive: probe.maxHistoricalActive,
      historyCalls: probe.historyCalls, historyResponses: probe.historyResponses,
      transferredHistoryBars: probe.transferredHistoryBars, transferredWindowBars: probe.transferredWindowBars,
      transferredBars: probe.transferredHistoryBars + probe.transferredWindowBars,
      sourceCalls: sourceRequests.length, sourceRequests, held: probe.held, latestHeld: probe.latestHeld, callsAtHold: probe.callsAtHold,
    }
  })
}

export async function removeRequestProbe(electron) {
  await electron.evaluate(async ({ ipcMain }) => {
    const probe = globalThis.__chartRequestProbe
    if (!probe) return
    probe.release()
    await globalThis.__marketBackend.probe({ action: 'sourceRemove' })
    probe.contents.send = probe.originalSend
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', probe.original)
    delete globalThis.__chartRequestProbe
  })
}

// Exercise a cold boundary while real wheel events keep arriving. Restricting
// every initial ingress prevents the normal bulk durable read from turning
// this into an already-warmed navigation test.
export async function measureLatencyCoveredPrefetch(electron, page, fixture) {
  const initialHistoryBars = 1_000
  const historicalDelayMS = 1_500
  const frames = 576
  const candlesPerFrame = 2
  await installRequestProbe(electron, fixture.instId, { initialHistoryBars, historicalDelayMS })
  try {
    await openChart(page, fixture)
    // Admit the bounded durable range through an actual history gesture;
    // opening latest deliberately performs no deep-history IPC.
    await wheelBurst(page, { deltaY: 12 })
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    const deadline = Date.now() + 20_000
    let initial
    do {
      initial = await readRequestProbe(electron)
      if (initial.historyResponses.some(response => response.timeframe === fixture.timeframe && response.bars === initialHistoryBars)) break
      assert.ok(Date.now() < deadline, 'The initial renderer history must stop at the artificial cold boundary.')
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    await page.evaluate(async () => { for (let index = 0; index < 2; index += 1) await new Promise(resolve => requestAnimationFrame(resolve)) })
    await wheelBurst(page, { deltaY: -12 })
    await waitForRendered(page, fixture)
    assert.deepEqual(initial.calls.filter(call => Number.isFinite(call.endHour)), [],
      'The cold boundary must still be beyond the idle prefetch runway before wheel input.')
    await startPaintProbe(page, fixture)
    const inputs = await wheelBurst(page, { frames, deltaY: 24 })
    const expectedEnd = fixture.end - frames * candlesPerFrame * fixture.intervalMS
    await waitForRendered(page, fixture, fixture.timeframe, expectedEnd)
    const latency = await measurePaintLatency(page, {
      inputs, targets: inputs.map((_, index) => fixture.end - (index + 1) * candlesPerFrame * fixture.intervalMS),
    })
    const paint = await finishPaintProbe(page)
    assertCompletePaints(paint)
    const requests = await readRequestProbe(electron)
    assert.equal(paint.pendingFrames, 0, `Latency-covered scrolling must never expose an unprepared requested viewport: ${JSON.stringify({ calls: requests.calls, sourceRequests: requests.sourceRequests, historyResponses: requests.historyResponses.length, inputDurationMS: inputs.at(-1) - inputs[0], pendingFrames: paint.pendingFrames })}`)
    assert.ok(latency.latestInputToPaintMS < 100, `The latest wheel input took ${latency.latestInputToPaintMS} ms to paint.`)
    const historical = requests.calls.filter(call => Number.isFinite(call.endHour))
    const first = historical[0]
    assert.ok(first, 'Approaching the cold boundary must issue a historical prefetch.')
    const requestTime = first.startedAt - timeOrigin
    const responseTime = first.completedAt - timeOrigin
    assert.ok(requestTime > inputs[0] && responseTime < inputs.at(-1),
      'Historical work must start and finish during the ongoing wheel gesture, without waiting for scroll end.')
    assert.ok(first.completedAt - first.startedAt >= historicalDelayMS,
      'The measured historical request must include the full artificial network latency.')
    const firstMissingEnd = fixture.end - initialHistoryBars * fixture.intervalMS
    assert.equal(first.endHour, firstMissingEnd, 'Prefetch must extend the adjacent complete viewport rather than skip a 96-candle page.')
    assert.ok(first.historyBars > 96, 'A latency-covered prefetch must prepare a bulk range.')
    const inputsAtRequest = inputs.filter(input => input <= requestTime).length
    const runwayAtRequest = initialHistoryBars - 96 - inputsAtRequest * candlesPerFrame
    assert.ok(runwayAtRequest >= 192, `Only ${runwayAtRequest} resident candles remained when prefetch started.`)
    assert.equal(requests.maxHistoricalActive, 1, 'Continuous wheel input may not start concurrent historical requests.')
    assert.ok(historical.length <= 3, `A single cold-boundary traversal issued ${historical.length} historical requests.`)
    const sources = separateSourceMaintenance(requests.sourceRequests, fixture)
    assert.deepEqual(sources.historical, [], 'Prefetch must reuse persisted source candles and statistics within the latency test range.')
    return {
      initialHistoryBars, historicalDelayMS, continuousWheelFrames: frames,
      scrolledCandles: frames * candlesPerFrame, crossedInitialBoundary: true,
      runwayAtRequest, prefetchHistoryBars: first.historyBars,
      prefetchStartedDuringGesture: true, prefetchCompletedDuringGesture: true,
      historicalRequests: historical.length, maxConcurrentHistoricalRequests: requests.maxHistoricalActive,
      olderSourceExtensions: sources.historicalExtensions.length,
      repeatedSourceDownloads: sources.historical.length,
      ...latency, ...paint, commits: paint.commits.length,
    }
  } finally { await releaseRequestProbe(electron); await removeRequestProbe(electron) }
}
