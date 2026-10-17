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

export async function openChart(page, fixture, timeframe = fixture.timeframe) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator(`[aria-label="View ${fixture.instId} chart"]`).click({ timeout: 15_000 })
  await page.locator(`[data-chart-inst="${fixture.instId}"]`).waitFor({ state: 'visible' })
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
      if (snapshot === probe.previousSnapshot) return
      probe.previousSnapshot = snapshot
      probe.paints += 1
      const intervalMS = series[timeframe]?.intervalMS
      if (!Array.isArray(bars)) { fail('The rendered snapshot has no bars.'); return }
      probe.minimumBars = Math.min(probe.minimumBars, bars.length)
      probe.commits.push({ at: performance.now(), end: bars.at(-1)?.hour, timeframe })
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

export async function installRequestProbe(electron, instId, { holdHistorical = false } = {}) {
  await electron.evaluate(({ ipcMain }, { instId, holdHistorical }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const { MarketService } = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)('./electron/services/market-service.js')
    const originalGet = MarketService.prototype.get
    const probe = { original, MarketService, originalGet, calls: [], active: 0, maxActive: 0, sourceCalls: 0, sourceRequests: [], held: false, callsAtHold: null, release: null }
    const released = new Promise(resolve => { probe.release = resolve })
    MarketService.prototype.get = function (path, parameters, ...rest) {
      if (parameters?.instId === instId) { probe.sourceCalls += 1; probe.sourceRequests.push({ path, parameters: { ...parameters } }) }
      return originalGet.call(this, path, parameters, ...rest)
    }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      if (value.chartWindow?.instId !== instId) return original(event, value)
      probe.calls.push({ ...value.chartWindow })
      probe.active += 1
      probe.maxActive = Math.max(probe.maxActive, probe.active)
      try {
        if (holdHistorical && !probe.held && Number.isFinite(value.chartWindow.endHour)) {
          probe.held = true
          probe.callsAtHold = probe.calls.length
          await released
        }
        return await original(event, value)
      } finally { probe.active -= 1 }
    })
    globalThis.__chartRequestProbe = probe
  }, { instId, holdHistorical })
}

export async function releaseRequestProbe(electron) {
  await electron.evaluate(() => globalThis.__chartRequestProbe?.release())
}

export async function readRequestProbe(electron) {
  return electron.evaluate(() => {
    const probe = globalThis.__chartRequestProbe
    return { calls: probe.calls, active: probe.active, maxActive: probe.maxActive, sourceCalls: probe.sourceCalls, sourceRequests: probe.sourceRequests, held: probe.held, callsAtHold: probe.callsAtHold }
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
