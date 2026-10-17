import assert from 'node:assert/strict'

export async function installNavigationProbe(electron, page, fixture) {
  const observePrepared = () => {
    window.__navigationPrepared = new Set()
    window.addEventListener('radar-chart-prepared', event => {
      const frame = event.detail
      if (frame?.instId && frame?.timeframe && frame.bars?.length >= 96) window.__navigationPrepared.add(`${frame.timeframe}:${frame.instId}`)
    })
  }
  await page.addInitScript(observePrepared)
  await page.evaluate(observePrepared)
  await electron.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const probe = { original, requests: [], ready: new Set(), held: false, heldSettled: false, holdInstId: null, release: null }
    const released = new Promise(resolve => { probe.release = resolve })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      const kind = ['chartUniverse', 'chartLocal', 'chartWindow'].find(key => key in value)
      let held = false
      if (kind) {
        const parameters = value[kind]
        probe.requests.push({ kind, ...parameters, at: Date.now() })
        if (kind === 'chartWindow' && parameters.instId === probe.holdInstId && Number.isFinite(parameters.endHour) && !probe.held) {
          held = probe.held = true
          await released
        }
      }
      try {
        const response = await original(event, value)
        if (kind === 'chartUniverse') for (const frame of response.frames ?? []) if (frame.bars?.length >= 96) probe.ready.add(`${frame.timeframe}:${frame.instId}`)
        return response
      } finally { if (held) probe.heldSettled = true }
    })
    globalThis.__instrumentNavigationProbe = probe
  })
  await page.evaluate(() => { window.__navigationPrepared ??= new Set() })
}

export async function waitForUniverseReady(electron, page, fixture, timeframe = fixture.timeframe) {
  const deadline = Date.now() + 30_000
  let ready = []
  while (Date.now() < deadline) {
    const hits = await electron.evaluate(() => [...globalThis.__instrumentNavigationProbe.ready])
    const events = await page.evaluate(() => [...window.__navigationPrepared ?? []])
    ready = [...new Set([...hits, ...events])]
    if (fixture.instIds.every(id => ready.includes(`${timeframe}:${id}`))) {
      const calls = (await navigationRequests(electron)).requests.filter(request => request.kind === 'chartUniverse'
        && request.timeframe === timeframe && fixture.instIds.every(id => request.instIds.includes(id)))
      await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); await new Promise(resolve => requestAnimationFrame(resolve)) })
      return { timeframe, candidateCount: fixture.instIds.length, readyCount: fixture.instIds.length, prewarmTotalMS: Date.now() - (calls[0]?.at ?? Date.now()), universeRequests: calls.length }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`The production list did not prewarm all ${timeframe} contracts: ${ready.join(', ')}.`)
}

export async function navigationRequests(electron) {
  return electron.evaluate(() => {
    const probe = globalThis.__instrumentNavigationProbe
    return { requests: probe.requests, held: probe.held, heldSettled: probe.heldSettled }
  })
}

export const selectionRequests = report => report.requests.filter(request => request.kind === 'chartLocal' || request.kind === 'chartWindow' && request.endHour === undefined)

export async function holdInstrumentHistory(electron, instId) {
  await electron.evaluate((_electron, instId) => { globalThis.__instrumentNavigationProbe.holdInstId = instId }, instId)
}

export async function releaseInstrumentHistory(electron) {
  await electron.evaluate(() => globalThis.__instrumentNavigationProbe.release())
}

export async function removeNavigationProbe(electron) {
  await electron.evaluate(({ ipcMain }) => {
    const probe = globalThis.__instrumentNavigationProbe
    if (!probe) return
    probe.release()
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', probe.original)
    delete globalThis.__instrumentNavigationProbe
  })
}

export async function waitForInstrument(page, instId, timeframe) {
  await page.waitForFunction(({ instId, timeframe }) => {
    const svg = document.querySelector('svg[data-rendered-inst]')
    const chart = svg?.closest('[data-chart-inst]')
    return svg?.getAttribute('data-rendered-inst') === instId
      && svg.getAttribute('data-rendered-timeframe') === timeframe
      && chart.getAttribute('data-chart-rendered-bars') === '96'
      && chart.getAttribute('data-chart-loading') === 'false'
  }, { instId, timeframe }, { timeout: 10_000 })
}

export async function startNavigationPaintProbe(page, fixture) {
  await page.evaluate(instruments => {
    const oracles = new Map(instruments.map(instrument => [instrument.instId,
      new Map(Object.entries(instrument.series).map(([timeframe, series]) => [timeframe, { intervalMS: series.intervalMS, bars: new Map(series.bars.map(bar => [bar.hour, bar])) }]))]))
    const fields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'logBBUpper', 'logBBMiddle', 'logBBLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'oi', 'buy', 'sell']
    const probe = { active: true, frames: 0, paints: 0, minimumBars: Infinity, violations: [], commits: [], previous: null, presentedSurface: null, raf: null, observer: null }
    const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
    const sample = (presentedFrame = false) => {
      const chart = document.querySelector('[data-chart-inst]')
      if (!chart) return // The user may return to the market list between clicks.
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      // Mounting from the market list is measured separately from the actual
      // input to its first complete SVG (at most one animation frame). An
      // early rAF callback can run before React's mount callback in that same
      // frame; only a previously presented surface can disappear here.
      if (!svg || !snapshot) { if (presentedFrame && chart === probe.presentedSurface) fail('Navigation removed the previously complete chart.'); return }
      probe.presentedSurface = chart
      if (svg.dataset.renderedInst !== snapshot.instId || svg.dataset.renderedTimeframe !== snapshot.timeframe) fail('The actual SVG combines different identities.')
      if (Number(svg.dataset.renderedStart) !== snapshot.bars[0]?.hour || Number(svg.dataset.renderedEnd) !== snapshot.endHour) fail('The rendered range and its labels disagree.')
      if (chart.dataset.chartInst !== snapshot.instId || Number(chart.dataset.chartEnd) !== snapshot.endHour) fail('Chart metadata and the drawn instrument disagree.')
      if (probe.previous === snapshot) return
      probe.previous = snapshot
      probe.paints += 1
      probe.minimumBars = Math.min(probe.minimumBars, snapshot.bars.length)
      probe.commits.push({ instId: snapshot.instId, timeframe: snapshot.timeframe, end: snapshot.endHour, at: performance.now() })
      if (snapshot.bars.length !== 96) fail(`A switch presented ${snapshot.bars.length} candles.`)
      const oracle = oracles.get(snapshot.instId)?.get(snapshot.timeframe)
      for (const [index, bar] of snapshot.bars.entries()) {
        const expected = oracle?.bars.get(bar.hour)
        if (!expected) { fail(`Unexpected source ${snapshot.instId}/${snapshot.timeframe}/${bar.hour}.`); continue }
        if (index && bar.hour - snapshot.bars[index - 1].hour !== oracle.intervalMS) fail('A switched chart contains noncontiguous periods.')
        if (!bar.confirmed || bar.statisticsObserved !== true || bar.indicatorsObserved !== true) fail('An unprepared candle entered the completed window.')
        for (const field of fields) {
          if (expected[field] === null ? bar[field] !== null : typeof bar[field] !== 'number' || !Number.isFinite(bar[field]) || Math.abs(bar[field] - expected[field]) > Math.max(1, Math.abs(expected[field])) * 1e-10) fail(`${snapshot.instId} ${bar.hour} ${field} has the wrong source value.`)
        }
      }
      if (Number(svg.querySelector('[data-chart-oi-samples]')?.getAttribute('data-chart-oi-samples')) !== 96) fail('OI geometry was incomplete after switching.')
      for (const side of ['buy', 'sell']) if (Number(svg.querySelector(`[data-chart-taker-${side}-samples]`)?.getAttribute(`data-chart-taker-${side}-samples`)) !== 96) fail(`Taker ${side} geometry was incomplete after switching.`)
      for (const path of svg.querySelectorAll('path[d]')) if (/NaN|Infinity|undefined/.test(path.getAttribute('d'))) fail('A switched chart contains invalid SVG geometry.')
    }
    probe.observer = new MutationObserver(() => sample())
    probe.observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true })
    const frame = () => { if (!probe.active) return; probe.frames += 1; sample(true); probe.raf = requestAnimationFrame(frame) }
    sample()
    probe.raf = requestAnimationFrame(frame)
    window.__navigationPaintProbe = probe
  }, fixture.instruments)
}

export async function finishNavigationPaintProbe(page) {
  return page.evaluate(() => {
    const probe = window.__navigationPaintProbe
    probe.active = false
    cancelAnimationFrame(probe.raf)
    probe.observer.disconnect()
    delete window.__navigationPaintProbe
    return { frames: probe.frames, paints: probe.paints, minimumBars: probe.minimumBars, violations: probe.violations, commits: probe.commits }
  })
}

export function assertNavigationPaints(report) {
  assert.ok(report.frames > 0)
  assert.equal(report.minimumBars, 96)
  assert.deepEqual(report.violations, [], 'A navigation frame was incomplete or used another contract’s values.')
}

// Capture the actual input event and the subsequent actual SVG commit. Node
// locator/action latency is deliberately excluded from this measurement.
export async function measureNavigation(page, trigger, { expectedInstId = null, sourceInstId = null, timeframe = null, timeoutMS = 1_000 } = {}) {
  await page.evaluate(({ expectedInstId, sourceInstId, timeframe, timeoutMS }) => {
    const source = sourceInstId ?? document.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-inst')
    const expectedFrame = timeframe ?? document.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-timeframe')
    const pending = { done: false, started: null, frames: 0, raf: null, observer: null, result: null, timer: null }
    window.__navigationMeasurement = new Promise((resolve, reject) => {
      const cleanup = () => {
        pending.done = true
        clearTimeout(pending.timer)
        cancelAnimationFrame(pending.raf)
        pending.observer.disconnect()
        window.removeEventListener('keydown', input, true)
        window.removeEventListener('click', input, true)
      }
      const sample = () => {
        if (pending.done || pending.started === null) return
        const svg = document.querySelector('svg[data-rendered-inst]')
        const id = svg?.getAttribute('data-rendered-inst')
        const chart = svg?.closest('[data-chart-inst]')
        if (!id || expectedFrame && svg.getAttribute('data-rendered-timeframe') !== expectedFrame || (expectedInstId ? id !== expectedInstId : id === source) || chart.dataset.chartRenderedBars !== '96' || chart.dataset.chartLoading !== 'false') return
        const result = { instId: id, inputToSVGCommitMS: performance.now() - pending.started, framesToCommit: pending.frames }
        cleanup()
        resolve(result)
      }
      const frame = () => { if (pending.done) return; if (pending.started !== null) pending.frames += 1; sample(); if (!pending.done) pending.raf = requestAnimationFrame(frame) }
      const timeout = () => { cleanup(); reject(new Error('The requested contract did not commit a complete chart before the navigation deadline.')) }
      const input = event => {
        if (pending.started !== null || event.type === 'keydown' && !event.key.startsWith('Arrow')) return
        pending.started = performance.now()
        clearTimeout(pending.timer)
        pending.timer = setTimeout(timeout, timeoutMS)
      }
      pending.observer = new MutationObserver(sample)
      pending.observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true })
      pending.raf = requestAnimationFrame(frame)
      window.addEventListener('keydown', input, true)
      window.addEventListener('click', input, true)
      pending.timer = setTimeout(timeout, 30_000)
    })
    // A failed assertion may read the promise later than its timeout.
    window.__navigationMeasurement.catch(() => {})
  }, { expectedInstId, sourceInstId, timeframe, timeoutMS })
  await trigger()
  return page.evaluate(() => window.__navigationMeasurement)
}

export async function firstVisibleMarket(page, excluded = []) {
  const rows = page.locator('[aria-label^="View "][aria-label$=" chart"]')
  await rows.first().waitFor({ state: 'visible', timeout: 15_000 })
  const ids = await rows.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label').slice(5, -6)))
  const instId = ids.find(id => !excluded.includes(id))
  if (!instId) throw new Error('The market list did not contain another selectable contract.')
  return { instId, locator: page.locator(`[aria-label="View ${instId} chart"]`) }
}

export async function exerciseInstrumentNavigation(electron, page, fixture) {
  const phases = []
  let heldHistory = null
  await startNavigationPaintProbe(page, fixture)
  const nextFrame = async (trigger, options) => {
    const before = selectionRequests(await navigationRequests(electron)).length
    const result = await measureNavigation(page, trigger, options)
    const after = selectionRequests(await navigationRequests(electron)).length
    assert.equal(after - before, 0, 'A prewarmed selection must not wait for chartLocal/chartWindow IPC.')
    assert.ok(result.framesToCommit <= 1, `${result.instId} needed ${result.framesToCommit} animation frames to switch.`)
    return { ...result, selectionIPC: after - before }
  }
  for (const timeframe of [fixture.timeframe, ...fixture.timeframes.filter(frame => frame !== fixture.timeframe)]) {
    if (await page.locator('svg[data-rendered-inst]').count()) await page.getByRole('button', { name: 'Markets', exact: true }).click()
    await page.locator('[aria-label="Radar timeframe"] button').filter({ hasText: new RegExp(`^${timeframe}$`, 'i') }).click()
    // Opportunity scores can legitimately reorder while native list readings
    // warm up. Use the fixture's fixed turnover ranking for the exact full-lap
    // cache residency check, through the same sort control a user selects.
    const turnoverSort = page.getByRole('button', { name: 'Sort by Turnover', exact: true })
    if (await turnoverSort.getAttribute('aria-pressed') !== 'true') await turnoverSort.click()
    const prewarm = await waitForUniverseReady(electron, page, fixture, timeframe)
    const first = await firstVisibleMarket(page)
    const holdThisPhase = heldHistory === null
    let heldStartedAt = null
    if (holdThisPhase) await holdInstrumentHistory(electron, first.instId)
    const firstVisit = await nextFrame(() => first.locator.click(), { expectedInstId: first.instId, timeframe })
    if (holdThisPhase) {
      heldStartedAt = Date.now()
      await page.locator('[data-chart-plot]').dispatchEvent('wheel', { deltaY: 9_600 })
      while (!(await navigationRequests(electron)).held) {
        const elapsed = Date.now() - heldStartedAt
        if (elapsed >= 10_000) {
          const requests = (await navigationRequests(electron)).requests.slice(-10)
          const chart = await page.locator('[data-chart-inst]').evaluate(node => ({ instId: node.dataset.chartInst, requestedEnd: node.dataset.chartRequestedEnd, end: node.dataset.chartEnd, loading: node.dataset.chartLoading }))
          assert.fail(`The first instrument did not start history: ${JSON.stringify({ first: first.instId, chart, requests })}`)
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await page.getByRole('button', { name: 'Markets', exact: true }).click()
    const second = await firstVisibleMarket(page, [first.instId])
    const mouseSwitch = await nextFrame(() => second.locator.click(), { expectedInstId: second.instId, sourceInstId: first.instId, timeframe })
    await page.locator('svg[data-rendered-inst]').focus()
    if (holdThisPhase) {
      const switched = await nextFrame(() => page.keyboard.press('ArrowDown'), { sourceInstId: second.instId, timeframe })
      const paintCount = await page.evaluate(() => window.__navigationPaintProbe.commits.length)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - heldStartedAt))))
      assert.equal((await navigationRequests(electron)).heldSettled, false, 'The old history job must remain unresolved during the switch.')
      await releaseInstrumentHistory(electron)
      const releaseDeadline = Date.now() + 15_000
      while (!(await navigationRequests(electron)).heldSettled) {
        assert.ok(Date.now() < releaseDeadline, 'The old history response did not finish after release.')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await waitForInstrument(page, switched.instId, timeframe)
      const latePaints = await page.evaluate(offset => window.__navigationPaintProbe.commits.slice(offset), paintCount)
      assert.ok(latePaints.every(paint => paint.instId === switched.instId), 'The obsolete instrument repainted after the new selection.')
      heldHistory = { heldForMS: 1_500, sourceInstId: first.instId, mouseSwitch, ...switched, lateWrongInstrumentPaints: 0 }
    }
    const initial = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
    const order = [initial]
    const keyboard = []
    for (let index = 0; index < fixture.instIds.length; index += 1) {
      const result = await nextFrame(() => page.keyboard.press('ArrowDown'), { timeframe })
      keyboard.push(result)
      order.push(result.instId)
    }
    const lap = JSON.stringify({ timeframe, order })
    assert.equal(new Set(order).size, fixture.instIds.length, `Keyboard navigation must visit the entire prepared universe: ${lap}`)
    assert.equal(order.at(-1), initial, `Revisiting the first contract after more than twelve switches must remain immediate: ${lap}`)
    const expectedInstId = order[37 % fixture.instIds.length]
    const beforeBurst = await page.evaluate(() => window.__navigationPaintProbe.commits.length)
    const rapid = await nextFrame(() => page.evaluate(() => {
      for (let index = 0; index < 37; index += 1) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    }), { expectedInstId, timeframe })
    const rapidPaints = await page.evaluate(offset => window.__navigationPaintProbe.commits.slice(offset), beforeBurst)
    assert.ok(rapidPaints.every(paint => paint.instId === expectedInstId), 'A coalesced key burst must only present its final requested instrument.')
    phases.push({ timeframe, prewarm, firstVisit, mouseSwitch, keyboard, rapid, distinctContracts: new Set(order).size })
  }
  const paints = await finishNavigationPaintProbe(page)
  assertNavigationPaints(paints)
  return { phases, heldHistory, ...paints, commits: paints.commits.length }
}
