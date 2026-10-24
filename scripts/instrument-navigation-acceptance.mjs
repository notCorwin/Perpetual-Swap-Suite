import assert from 'node:assert/strict'
import { assertWorkspaceLayout, selectTimeframe } from './chart-acceptance.mjs'

// Executed in the first document by the test-only Electron bootstrap. The first
// click happens as soon as the list has had its first paint opportunity, without
// a chart-readiness barrier or a request from the test driver.
export function startupNavigationProbe() {
  const probe = window.__navigationStartup = { documentAt: performance.timeOrigin, domAt: null, listAt: null, inputAt: null, commitAt: null, paintAt: null,
    instId: null, timeframe: null, framesToCommit: 0, framesToPaint: 0, previous: null, commits: [], samples: [], ready: new Set(), violations: [] }
  let stopped = false, clicking = false, raf = null
  document.addEventListener('DOMContentLoaded', () => { probe.domAt = performance.now() }, { once: true })
  window.addEventListener('radar-chart-prepared', event => {
    const frame = event.detail
    if (frame?.bars?.length >= 96) probe.ready.add(`${frame.timeframe}:${frame.instId}`)
  })
  const sample = () => {
    const rows = [...document.querySelectorAll('[aria-label^="View "][aria-label$=" chart"]')]
    // Progressive admission may expose the selected chart first. A switch is
    // possible as soon as a second already rendered contract enters the list.
    if (rows.length > 1 && probe.listAt === null) {
      probe.listAt = performance.now()
      requestAnimationFrame(() => {
        const selected = document.querySelector('[data-market-index][aria-selected="true"]')
        // Reconcile admission can replace an earlier mutation's row before
        // paint. Resolve the actual attached target at the input boundary.
        const row = [...document.querySelectorAll('[aria-label^="View "][aria-label$=" chart"]')].findLast(row => row !== selected)
        if (!row) { probe.listAt = null; return }
        probe.instId = row.getAttribute('aria-label').slice(5, -6)
        probe.timeframe = document.querySelector('[aria-label="Chart timeframe"] [aria-pressed="true"]')?.textContent
        probe.inputAt = performance.now()
        probe.preparedAtInput = [...probe.ready]
        clicking = true
        row.click()
      })
    }
    const chart = document.querySelector('[data-chart-inst]'), svg = chart?.querySelector('svg[data-rendered-inst]'), snapshot = chart?.__chartSnapshot
    if (!svg || !snapshot || snapshot.bars.length !== 96) return
    if (probe.previous !== snapshot) {
      probe.previous = snapshot
      probe.commits.push({ instId: snapshot.instId, timeframe: snapshot.timeframe, at: performance.now() })
      probe.samples.push(snapshot)
      if (svg.dataset.renderedInst !== snapshot.instId || svg.dataset.renderedTimeframe !== snapshot.timeframe
        || Number(svg.dataset.renderedEnd) !== snapshot.endHour || chart.dataset.chartInst !== snapshot.instId) probe.violations.push('A startup SVG combined different series identities.')
    }
    if (clicking && probe.commitAt === null && snapshot.instId === probe.instId && chart.dataset.chartLoading === 'false') {
      probe.commitAt = performance.now()
      requestAnimationFrame(() => { probe.paintAt = performance.now(); stop() })
    }
  }
  const observer = new MutationObserver(sample)
  observer.observe(document, { subtree: true, childList: true, attributes: true })
  const frame = () => {
    if (stopped) return
    if (probe.inputAt !== null) {
      if (probe.commitAt === null) probe.framesToCommit += 1
      probe.framesToPaint += 1
    }
    sample()
    if (!stopped) raf = requestAnimationFrame(frame)
  }
  const stop = () => { stopped = true; cancelAnimationFrame(raf); observer.disconnect() }
  probe.stop = stop
  raf = requestAnimationFrame(frame)
}

export async function startupNavigationReport(page, launchedAt, fixture) {
  await page.waitForFunction(() => window.__navigationStartup && window.__navigationStartup.paintAt !== null, null, { timeout: 10_000 }).catch(async error => {
    const state = await page.evaluate(() => {
      const { samples, previous, stop, ready, ...probe } = window.__navigationStartup ?? {}
      return { probe, rows: [...document.querySelectorAll('[data-market-index]')].map(row => ({ id: row.getAttribute('aria-label'), selected: row.getAttribute('aria-selected') })),
        plots: [...document.querySelectorAll('svg[data-prepared-chart-inst]')].map(svg => ({ ...svg.dataset })),
        chart: document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId }
    })
    throw new Error(`Cold-start navigation did not finish: ${JSON.stringify(state)}`, { cause: error })
  })
  return page.evaluate(({ launchedAt, instruments }) => {
    const probe = window.__navigationStartup
    const fields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    const oracle = new Map(instruments.map(({ instId, series }) => [instId, new Map(Object.entries(series).map(([frame, value]) => [frame, new Map(value.bars.map(bar => [bar.hour, bar]))]))]))
    for (const snapshot of probe.samples) for (const bar of snapshot.bars) {
      const expected = oracle.get(snapshot.instId)?.get(snapshot.timeframe)?.get(bar.hour)
      if (!expected) { probe.violations.push(`Unexpected startup source ${snapshot.instId}/${snapshot.timeframe}/${bar.hour}.`); break }
      for (const field of fields.filter(field => ['open', 'high', 'low', 'close'].includes(field) || ['oi', 'buy', 'sell'].includes(field) ? !['oi', 'buy', 'sell'].includes(field) || bar.statisticsObserved : bar.indicatorsObserved)) if (expected[field] === null ? bar[field] !== null
        : typeof bar[field] !== 'number' || !Number.isFinite(bar[field]) || Math.abs(bar[field] - expected[field]) > Math.max(1, Math.abs(expected[field])) * 1e-10) {
        if (probe.violations.length < 20) probe.violations.push(`Startup ${snapshot.instId}/${snapshot.timeframe}/${bar.hour}/${field} used another source value.`)
      }
    }
    return { instId: probe.instId, timeframe: probe.timeframe, processToListMS: probe.documentAt + probe.listAt - launchedAt,
      documentToListMS: probe.listAt, domToListMS: probe.listAt - probe.domAt,
      processToFirstChartMS: probe.documentAt + probe.commits[0].at - launchedAt,
      domToFirstChartMS: probe.commits[0].at - probe.domAt,
      listToInputMS: probe.inputAt - probe.listAt, inputToSVGCommitMS: probe.commitAt - probe.inputAt,
      inputToNextPaintMS: probe.paintAt - probe.inputAt, framesToCommit: probe.framesToCommit, framesToPaint: probe.framesToPaint,
      inputEpoch: probe.documentAt + probe.inputAt, commitEpoch: probe.documentAt + probe.commitAt,
      preparedBeforeInput: probe.preparedAtInput, commits: probe.commits, violations: probe.violations }
  }, { launchedAt, instruments: fixture.instruments.map(({ instId, series }) => ({ instId,
    series: Object.fromEntries(Object.entries(series).map(([frame, value]) => [frame, { bars: value.bars.slice(-96) }])) })) })
}

// Persist the same fixture's market catalog before a real process restart. Its
// normal finite metadata/ticker leases prevent socket continuity being invented
// by the test; completed chart rows and compact checkpoints remain untouched.
export async function persistNavigationCatalog(electron, _page) {
  return electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'persistNavigationCatalog' }))
}

export async function installNavigationProbe(electron, page, fixture) {
  const observePrepared = () => {
    window.__navigationPrepared = new Set(window.__navigationStartup?.ready ?? [])
    window.addEventListener('radar-chart-prepared', event => {
      const frame = event.detail
      if (frame?.instId && frame?.timeframe && frame.bars?.length >= 96) window.__navigationPrepared.add(`${frame.timeframe}:${frame.instId}`)
    })
  }
  await page.addInitScript(observePrepared)
  await page.evaluate(observePrepared)
  await electron.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const probe = { original, requests: [], ready: new Set(globalThis.__navigationStartupRequests?.ready ?? []), held: false, heldSettled: false, holdInstId: null, release: null }
    const released = new Promise(resolve => { probe.release = resolve })
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      const kind = ['chartUniverse', 'chartLocal', 'chartHistory', 'chartWindow'].find(key => key in value)
      let held = false
      if (kind) {
        const parameters = value[kind]
        probe.requests.push({ kind, ...parameters, at: Date.now() })
        // Keep this one instrument intentionally cold before its first visit.
        // The test exercises switching away from a held preparation request;
        // ordinary selected instruments still hydrate their durable history.
        if (kind === 'chartHistory' && parameters.instId === probe.holdInstId) return null
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

// Benchmark setup explicitly requests the fixture projections. Production
// subscription admission never restores every candidate chart.
export async function waitForUniverseReady(electron, page, fixture, timeframe = fixture.timeframe) {
  const startedAt = Date.now(), ready = new Set()
  for (let index = 0; index < fixture.instIds.length; index += 4) {
    const ids = fixture.instIds.slice(index, index + 4)
    await Promise.all(ids.map(async instId => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const frame = await page.evaluate(value => window.radarDesktop.request({ chartLocal: value }), { instId, timeframe })
        if (frame?.bars.length >= 96 && frame.indicatorState !== 'loading') { ready.add(instId); return }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`The explicitly warmed fixture did not calculate ${instId}/${timeframe}.`)
    }))
  }
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); await new Promise(resolve => requestAnimationFrame(resolve)) })
  return { timeframe, candidateCount: fixture.instIds.length, readyCount: ready.size, prewarmTotalMS: Date.now() - startedAt, explicitFixtureWarmup: true }
}

export async function navigationRequests(electron) {
  return electron.evaluate(() => {
    const probe = globalThis.__instrumentNavigationProbe
    return { requests: probe.requests, held: probe.held, heldSettled: probe.heldSettled }
  })
}

export const selectionRequests = report => report.requests.filter(request => request.kind === 'chartLocal'
  || (request.kind === 'chartWindow' || request.kind === 'chartHistory') && request.endHour === undefined)

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
    const fields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    const probe = { active: true, frames: 0, paints: 0, minimumBars: Infinity, violations: [], commits: [], previous: null, presentedSurface: null, raf: null, observer: null }
    const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
    const sample = (presentedFrame = false) => {
      const chart = document.querySelector('[data-chart-inst]')
      if (!chart) return
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      // Preserve a complete prior frame while the next contract is preparing.
      // Initial mounting may precede the first complete SVG in the same frame.
      if (!svg || !snapshot) return
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
        if (!bar.confirmed) fail('A forming candle entered the persisted completed window.')
        for (const field of fields.filter(field => ['open', 'high', 'low', 'close'].includes(field) || ['oi', 'buy', 'sell'].includes(field) ? !['oi', 'buy', 'sell'].includes(field) || bar.statisticsObserved : bar.indicatorsObserved)) {
          if (expected[field] === null ? bar[field] !== null : typeof bar[field] !== 'number' || !Number.isFinite(bar[field]) || Math.abs(bar[field] - expected[field]) > Math.max(1, Math.abs(expected[field])) * 1e-10) fail(`${snapshot.instId} ${bar.hour} ${field} has the wrong source value.`)
        }
      }
      if (snapshot.oiState === 'ready' && Number(svg.querySelector('[data-chart-oi-samples]')?.getAttribute('data-chart-oi-samples')) !== snapshot.bars.length) fail('OI geometry was incomplete after switching.')
      for (const side of ['buy', 'sell']) if (snapshot.takerState === 'ready' && Number(svg.querySelector(`[data-chart-taker-${side}-samples]`)?.getAttribute(`data-chart-taker-${side}-samples`)) !== 96) fail(`Taker ${side} geometry was incomplete after switching.`)
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
        requestAnimationFrame(() => resolve({ ...result, inputToNextPaintMS: performance.now() - pending.started }))
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
  await page.waitForFunction(excluded => [...document.querySelectorAll('[aria-label^="View "][aria-label$=" chart"]')]
    .some(row => !excluded.includes(row.getAttribute('aria-label').slice(5, -6))), excluded, { timeout: 15_000 })
  const ids = await rows.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label').slice(5, -6)))
  const instId = ids.find(id => !excluded.includes(id))
  if (!instId) throw new Error('The market list did not contain another selectable contract.')
  return { instId, locator: page.locator(`[aria-label="View ${instId} chart"]`) }
}

export async function exerciseInstrumentNavigation(electron, page, fixture, { awaitInitialPreparation = true, holdHistory = true } = {}) {
  const phases = []
  const setupStartedAt = Date.now(), preparation = []
  let heldHistory = null
  // Generating a fixture's first canonical checkpoints is setup, separately
  // measured by the cold-start probe. Period changes below never wait here.
  if (awaitInitialPreparation) for (const timeframe of fixture.timeframes) preparation.push(await waitForUniverseReady(electron, page, fixture, timeframe))
  const initialPreparation = awaitInitialPreparation ? { sourceFixtureSeedMS: fixture.seedCompletedAt - fixture.seedStartedAt,
    remainingCheckpointPreparationMS: Date.now() - setupStartedAt, totalFromSourceFixtureStartMS: Date.now() - fixture.seedStartedAt,
    frames: preparation } : null
  await startNavigationPaintProbe(page, fixture)
  const nextFrame = async (trigger, { maximumMS = awaitInitialPreparation ? 50 : 150, ...options } = {}) => {
    const before = selectionRequests(await navigationRequests(electron)).length
    const result = await measureNavigation(page, trigger, options)
    const after = selectionRequests(await navigationRequests(electron)).length
    assert.ok(after - before <= 2, `A selection must use bounded local hydration: ${JSON.stringify({ result, requests: selectionRequests(await navigationRequests(electron)).slice(before) })}`)
    assert.ok(result.framesToCommit <= (awaitInitialPreparation ? 1 : 10), `${result.instId} needed ${result.framesToCommit} animation frames to switch.`)
    assert.ok(result.inputToSVGCommitMS <= maximumMS, `${result.instId} blocked input for ${result.inputToSVGCommitMS.toFixed(1)} ms (budget ${maximumMS} ms).`)
    return { ...result, selectionIPC: after - before }
  }
  for (const timeframe of [fixture.timeframe, ...fixture.timeframes.filter(frame => frame !== fixture.timeframe)]) {
    await page.locator('[data-market-list] [aria-label^="View "]').first().waitFor({ state: 'visible' })
    let timeframeSwitch = null
    if (await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-timeframe') !== timeframe) {
      const instId = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
      timeframeSwitch = await nextFrame(() => selectTimeframe(page, timeframe), { expectedInstId: instId, timeframe })
    }
    await assertWorkspaceLayout(page)
    const ready = new Set([...(await electron.evaluate(() => [...globalThis.__instrumentNavigationProbe.ready])),
      ...(await page.evaluate(() => [...window.__navigationPrepared ?? []]))])
    const prewarm = { timeframe, candidateCount: fixture.instIds.length, readyCount: fixture.instIds.filter(id => ready.has(`${timeframe}:${id}`)).length }
    const currentlySelected = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
    const first = await firstVisibleMarket(page, [currentlySelected])
    const holdThisPhase = holdHistory && heldHistory === null
    let heldStartedAt = null
    if (holdThisPhase) await holdInstrumentHistory(electron, first.instId)
    const firstVisit = await nextFrame(() => first.locator.click(), { expectedInstId: first.instId, timeframe })
    if (holdThisPhase) {
      heldStartedAt = Date.now()
      // 650 candles exceeds the compact pages. The fixture also covers the
      // bulk prefetch reserve and 199 earlier observations for EMA200.
      await page.locator('[data-chart-plot]').dispatchEvent('wheel', { deltaY: 7_800 })
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
    await assertWorkspaceLayout(page)
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
    let beforeBurst
    const rapid = await nextFrame(async () => { beforeBurst = await page.evaluate(() => {
      // Capture the boundary in the same task as the actual input. A benign
      // current-contract publication during measurement setup precedes this
      // burst and cannot be mistaken for an intermediate keyboard selection.
      const offset = window.__navigationPaintProbe.commits.length
      for (let index = 0; index < 37; index += 1) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      return offset
    }) }, { expectedInstId, timeframe, maximumMS: 100 })
    const rapidPaints = await page.evaluate(offset => window.__navigationPaintProbe.commits.slice(offset), beforeBurst)
    assert.ok(rapidPaints.every(paint => paint.instId === expectedInstId), 'A coalesced key burst must only present its final requested instrument.')
    phases.push({ timeframe, prewarm, timeframeSwitch, firstVisit, mouseSwitch, keyboard, rapid, distinctContracts: new Set(order).size })
  }
  const paints = await finishNavigationPaintProbe(page)
  assertNavigationPaints(paints)
  return { phases, initialPreparation, heldHistory, ...paints, commits: paints.commits.length }
}
