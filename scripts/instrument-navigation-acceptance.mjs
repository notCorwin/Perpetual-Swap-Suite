import assert from 'node:assert/strict'
import { assertWorkspaceLayout, selectTimeframe } from './chart-acceptance.mjs'
import { assertNavigationResponsiveness, collectAcceptanceChecks } from './chart-acceptance-metrics.mjs'

function navigationTimingScope(presentation) {
  return presentation === 'foreground'
    ? { presentation, wallTime: 'native foreground input-to-SVG deadlines enforced: 50 ms for normal input and 100 ms for rapid input', frames: 'at most one renderer RAF sample enforced' }
    : { presentation, wallTime: 'input-to-SVG and input-to-RAF values are diagnostics; no native display deadline is inferred', frames: 'at most one renderer RAF sample enforced' }
}

// Executed in the first document by the test-only Electron bootstrap. Record
// list availability separately, then measure a selection after the renderer
// has received its canonical frame. Geometry is built as part of that selection.
export function startupNavigationProbe() {
  const probe = window.__navigationStartup = { documentAt: performance.timeOrigin, domAt: null, listAt: null, preparedAt: null, inputAt: null, commitAt: null, rafSampleAt: null,
    instId: null, timeframe: null, framesToCommit: 0, framesToRafSample: 0, previous: null, commits: [], samples: [], ready: new Set(), violations: [],
    readyAt: new Map(), allowInput: false, armedAt: null, inputPresentation: null }
  let stopped = false, clicking = false, inputQueued = false, raf = null
  document.addEventListener('DOMContentLoaded', () => { probe.domAt = performance.now() }, { once: true })
  window.addEventListener('radar-chart-prepared', event => {
    const frame = event.detail
    if (frame?.bars?.length === 96 && frame.indicatorState === 'ready'
      && ['ready', 'stale'].includes(frame.priceState) && frame.oiState === 'ready' && frame.takerState === 'ready') {
      const key = `${frame.timeframe}:${frame.instId}`
      probe.ready.add(key)
      if (!probe.readyAt.has(key)) probe.readyAt.set(key, performance.now())
    }
  })
  const sample = () => {
    const rows = [...document.querySelectorAll('[aria-label^="View "][aria-label$=" chart"]')]
    if (rows.length && probe.listAt === null) probe.listAt = performance.now()
    const selected = rows.find(row => row.getAttribute('aria-selected') === 'true')
    const timeframe = document.querySelector('[aria-label="Chart timeframe"] [aria-pressed="true"]')?.textContent?.trim()
    const canonicalTimeframe = timeframe?.toLowerCase() === '1h' ? '1H' : timeframe?.toLowerCase()
    const readyRow = row => probe.ready.has(`${canonicalTimeframe}:${row.getAttribute('aria-label').slice(5, -6)}`)
    const target = rows.findLast(row => row !== selected && readyRow(row))
    if (!clicking && !inputQueued && probe.allowInput && target && document.visibilityState === 'visible' && document.hasFocus()) {
      inputQueued = true
      requestAnimationFrame(() => {
        inputQueued = false
        if (!probe.allowInput || document.visibilityState !== 'visible' || !document.hasFocus()
          || !target.isConnected || target.getAttribute('aria-selected') === 'true' || !readyRow(target)) return
        probe.instId = target.getAttribute('aria-label').slice(5, -6)
        probe.timeframe = canonicalTimeframe
        probe.preparedAt = Math.max(probe.listAt, probe.readyAt.get(`${probe.timeframe}:${probe.instId}`) ?? performance.now())
        probe.allowInput = false
        probe.inputAt = performance.now()
        probe.inputPresentation = { armedAt: probe.armedAt, inputAt: probe.inputAt,
          documentVisibility: document.visibilityState, documentFocused: document.hasFocus() }
        probe.preparedAtInput = [...probe.ready]
        clicking = true
        target.click()
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
    if (clicking && probe.commitAt === null && snapshot.instId === probe.instId && snapshot.timeframe === probe.timeframe && chart.dataset.chartLoading === 'false') {
      probe.commitAt = performance.now()
      requestAnimationFrame(() => { probe.rafSampleAt = performance.now(); stop() })
    }
  }
  const observer = new MutationObserver(sample)
  observer.observe(document, { subtree: true, childList: true, attributes: true })
  const frame = () => {
    if (stopped) return
    if (probe.inputAt !== null) {
      if (probe.commitAt === null) probe.framesToCommit += 1
      probe.framesToRafSample += 1
    }
    sample()
    if (!stopped) raf = requestAnimationFrame(frame)
  }
  const stop = () => { stopped = true; cancelAnimationFrame(raf); observer.disconnect() }
  probe.stop = stop
  raf = requestAnimationFrame(frame)
}

export async function startupNavigationReport(page, launchedAt, fixture, { presentation = 'offscreen' } = {}) {
  await page.evaluate(() => {
    const probe = window.__navigationStartup
    if (!probe) throw new Error('The cold-start navigation probe is unavailable.')
    probe.armedAt = performance.now()
    probe.allowInput = true
  })
  await page.waitForFunction(() => window.__navigationStartup && window.__navigationStartup.rafSampleAt !== null, null, { timeout: 40_000 }).catch(async error => {
    const state = await page.evaluate(() => {
      const { samples, previous, stop, ready, readyAt, ...probe } = window.__navigationStartup ?? {}
      return { probe, rows: [...document.querySelectorAll('[data-market-index]')].map(row => ({ id: row.getAttribute('aria-label'), selected: row.getAttribute('aria-selected') })),
        rendererReady: [...(ready ?? [])],
        chart: document.querySelector('[data-chart-inst]')?.__chartSnapshot?.instId }
    })
    throw new Error(`Cold-start navigation did not finish: ${JSON.stringify(state)}`, { cause: error })
  })
  const report = await page.evaluate(({ launchedAt, instruments }) => {
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
    return { instId: probe.instId, timeframe: probe.timeframe, armedAt: probe.armedAt, inputPresentation: probe.inputPresentation,
      processToListMS: probe.documentAt + probe.listAt - launchedAt,
      documentToListMS: probe.listAt, domToListMS: probe.listAt - probe.domAt,
      processToFirstChartMS: probe.documentAt + probe.commits[0].at - launchedAt,
      domToFirstChartMS: probe.commits[0].at - probe.domAt,
      rendererFrameWaitMS: Math.max(0, probe.preparedAt - probe.listAt), listToInputMS: probe.inputAt - probe.listAt, inputToSVGCommitMS: probe.commitAt - probe.inputAt,
      inputToNextRafSampleMS: probe.rafSampleAt - probe.inputAt, framesToCommit: probe.framesToCommit, framesToRafSample: probe.framesToRafSample,
      inputEpoch: probe.documentAt + probe.inputAt, commitEpoch: probe.documentAt + probe.commitAt,
      rendererFramesBeforeInput: probe.preparedAtInput, commits: probe.commits, violations: probe.violations }
  }, { launchedAt, instruments: fixture.instruments.map(({ instId, series }) => ({ instId,
    series: Object.fromEntries(Object.entries(series).map(([frame, value]) => [frame, { bars: value.bars.slice(-96) }])) })) })
  return { timingScope: navigationTimingScope(presentation), ...report }
}

// Persist the same fixture's market catalog before a real process restart. Its
// normal finite metadata/ticker leases prevent socket continuity being invented
// by the test; completed chart rows and compact checkpoints remain untouched.
export async function persistNavigationCatalog(electron, _page) {
  return electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'persistNavigationCatalog' }))
}

export async function installNavigationProbe(electron, { omitUniverseInstId = null } = {}) {
  await electron.evaluate(({ ipcMain, BrowserWindow }, omitUniverseInstId) => {
    const original = ipcMain._invokeHandlers.get('radar:request')
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const originalSend = contents.send
    const probe = { original, contents, originalSend, requests: [], held: false, heldSettled: false,
      holdInstId: null, omitUniverseInstId, release: null }
    const released = new Promise(resolve => { probe.release = resolve })
    contents.send = function (channel, ...args) {
      const frame = args[0]
      if (channel === 'radar:chart-prepared' && frame?.instId === probe.omitUniverseInstId) return
      // Keep the blocked history boundary deterministic: its independent push
      // cannot complete the viewport ahead of the deliberately held disk read.
      if (channel === 'radar:chart-prepared' && frame?.instId === probe.holdInstId && !probe.heldSettled
        && Number.isFinite(frame.latestEnd) && frame.endHour !== frame.latestEnd) return
      return originalSend.call(this, channel, ...args)
    }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (event, value) => {
      const kind = ['chartUniverse', 'chartFocus', 'chartLocal', 'chartHistory', 'chartWindow'].find(key => key in value)
      let held = false
      if (kind) {
        const parameters = value[kind]
        probe.requests.push({ kind, ...parameters, at: Date.now() })
        // Hold an older viewport's durable read independently of explicit focus
        // demand. A new selection must not await this obsolete response.
        if (kind === 'chartHistory' && parameters.instId === probe.holdInstId && Number.isFinite(parameters.endHour) && !probe.held) {
          held = probe.held = true
          await released
        }
      }
      try {
        const response = await original(event, value)
        if (value.chartUniverse && probe.omitUniverseInstId) {
          return { ...response, frames: response.frames.filter(frame => frame.instId !== probe.omitUniverseInstId) }
        }
        return response
      } finally { if (held) probe.heldSettled = true }
    })
    globalThis.__instrumentNavigationProbe = probe
  }, omitUniverseInstId)
}

// Observe automatic backend preparation through the pure resident-frame read.
// Neither local reads nor the measurement driver admit chart work.
export async function waitForUniverseReady(electron, page, fixture, { omitInstId = null } = {}) {
  const startedAt = Date.now(), timeframes = ['5m', '15m', '1H']
  const snapshot = await page.evaluate(() => window.radarDesktop.request({ snapshot: { sinceRevision: -1 } }))
  const qualified = snapshot.rows.map(row => row.instId)
  assert.deepEqual([...qualified].sort(), [...fixture.instIds].sort(), 'The navigation fixture must cover the entire backend-qualified universe.')
  const expected = timeframes.flatMap(timeframe => qualified.filter(instId => instId !== omitInstId).map(instId => `${timeframe}:${instId}`))
  const ready = new Set()
  while (Date.now() - startedAt < 40_000) {
    const keys = await page.evaluate(async omittedInstId => {
      const { frames } = await window.radarDesktop.request({ chartUniverse: {} })
      const canonical = frames.filter(frame => frame.instId !== omittedInstId && frame.bars?.length === 96 && frame.indicatorState === 'ready'
        && ['ready', 'stale'].includes(frame.priceState) && frame.oiState === 'ready' && frame.takerState === 'ready')
      const keys = canonical.map(frame => `${frame.timeframe}:${frame.instId}`)
      const delivered = window.__navigationCanonicalFrames ??= new Set()
      // Feed the canonical frames through the same renderer event App uses for
      // backend publications. The controller/store receives data, but no
      // hidden chart surfaces are mounted or prepared by this barrier.
      for (const frame of canonical) {
        const key = `${frame.timeframe}:${frame.instId}`
        if (delivered.has(key)) continue
        window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
        delivered.add(key)
      }
      return keys
    }, omitInstId)
    for (const key of keys) ready.add(key)
    if (expected.every(key => ready.has(key))) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.deepEqual(expected.filter(key => !ready.has(key)), [], 'The renderer must receive every canonical qualified contract frame except the deliberately unprepared candidate.')
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
  return { candidateCount: fixture.instIds.length, frameCount: expected.length, omittedInstId: omitInstId,
    readyFrameCount: expected.filter(key => ready.has(key)).length,
    rendererFrameWaitMS: Date.now() - startedAt, frames: timeframes.map(timeframe => ({ timeframe, instrumentCount: fixture.instIds.length,
      readyCount: fixture.instIds.filter(id => ready.has(`${timeframe}:${id}`)).length })) }
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
    probe.contents.send = probe.originalSend
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

export async function startNavigationFrameProbe(page, fixture, { requirePreparedStatistics = true } = {}) {
  await page.evaluate(({ instruments, requirePreparedStatistics }) => {
    const oracles = new Map(instruments.map(instrument => [instrument.instId,
      new Map(Object.entries(instrument.series).map(([timeframe, series]) => [timeframe, { intervalMS: series.intervalMS, bars: new Map(series.bars.map(bar => [bar.hour, bar])) }]))]))
    const probe = { active: true, requirePreparedStatistics, oracles, rafSamples: 0, snapshotChanges: 0, minimumBars: Infinity, violations: [], commits: [], observations: [],
      snapshotCaptureMS: 0, snapshotCaptureMaxMS: 0, snapshotValidationMS: 0, previous: null, observedSurface: null, raf: null, observer: null }
    const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
    const sample = () => {
      const chart = document.querySelector('[data-chart-inst]')
      if (!chart) return
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const snapshot = chart.__chartSnapshot
      // Preserve a complete prior frame while the next contract is preparing.
      // Initial mounting may precede the first complete SVG in the same frame.
      if (!svg || !snapshot) return
      if (requirePreparedStatistics && (snapshot.oiState !== 'ready' || snapshot.takerState !== 'ready')) {
        fail('Fixture-known OI/Taker states became unavailable during prepared navigation.')
      }
      probe.observedSurface = chart
      if (svg.dataset.renderedInst !== snapshot.instId || svg.dataset.renderedTimeframe !== snapshot.timeframe) fail('The actual SVG combines different identities.')
      if (Number(svg.dataset.renderedStart) !== snapshot.bars[0]?.hour || Number(svg.dataset.renderedEnd) !== snapshot.endHour) fail('The rendered range and its labels disagree.')
      if (chart.dataset.chartInst !== snapshot.instId || Number(chart.dataset.chartEnd) !== snapshot.endHour) fail('Chart metadata and the drawn instrument disagree.')
      if (probe.previous === snapshot) return
      probe.previous = snapshot
      probe.snapshotChanges += 1
      probe.minimumBars = Math.min(probe.minimumBars, snapshot.bars.length)
      const at = performance.now()
      const captureStartedAt = performance.now()
      // PreparedChartStore freezes its windows, arrays, and bars. The mutable
      // synthetic snapshot in the negative fixture is copied once here so the
      // deferred oracle still checks exactly what was observed at commit time.
      const retainedSnapshot = Object.isFrozen(snapshot) ? snapshot : Object.freeze({
        ...snapshot, bars: Object.freeze(snapshot.bars.map(bar => Object.freeze({ ...bar }))),
      })
      const geometry = Object.freeze({
        oiSamples: svg.querySelector('[data-chart-oi-samples]')?.getAttribute('data-chart-oi-samples'),
        takerBuySamples: svg.querySelector('[data-chart-taker-buy-samples]')?.getAttribute('data-chart-taker-buy-samples'),
        takerSellSamples: svg.querySelector('[data-chart-taker-sell-samples]')?.getAttribute('data-chart-taker-sell-samples'),
        pathData: Object.freeze(Array.from(svg.querySelectorAll('path[d]'), path => path.getAttribute('d'))),
      })
      probe.commits.push({ instId: snapshot.instId, timeframe: snapshot.timeframe, end: snapshot.endHour, at })
      probe.observations.push(Object.freeze({ snapshot: retainedSnapshot, geometry }))
      const captureMS = performance.now() - captureStartedAt
      probe.snapshotCaptureMS += captureMS
      probe.snapshotCaptureMaxMS = Math.max(probe.snapshotCaptureMaxMS, captureMS)
    }
    probe.observer = new MutationObserver(() => sample())
    probe.observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true })
    const frame = () => { if (!probe.active) return; probe.rafSamples += 1; sample(); probe.raf = requestAnimationFrame(frame) }
    sample()
    probe.raf = requestAnimationFrame(frame)
    window.__navigationPaintProbe = probe
  }, { instruments: fixture.instruments, requirePreparedStatistics })
}

export async function finishNavigationFrameProbe(page) {
  return page.evaluate(() => {
    const probe = window.__navigationPaintProbe
    probe.active = false
    cancelAnimationFrame(probe.raf)
    probe.observer.disconnect()
    const validationStartedAt = performance.now()
    const fields = ['open', 'high', 'low', 'close', 'ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell']
    const fail = message => { if (probe.violations.length < 20) probe.violations.push(message) }
    for (const { snapshot, geometry } of probe.observations) {
      if (snapshot.bars.length !== 96) fail(`A switch snapshot contains ${snapshot.bars.length} candles.`)
      const oracle = probe.oracles.get(snapshot.instId)?.get(snapshot.timeframe)
      for (const [index, bar] of snapshot.bars.entries()) {
        const expected = oracle?.bars.get(bar.hour)
        if (!expected) { fail(`Unexpected source ${snapshot.instId}/${snapshot.timeframe}/${bar.hour}.`); continue }
        if (index && bar.hour - snapshot.bars[index - 1].hour !== oracle.intervalMS) fail('A switched chart contains noncontiguous periods.')
        if (!bar.confirmed) fail('A forming candle entered the persisted completed window.')
        const oiObserved = bar.oiObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 1)
        const takerObserved = bar.takerObserved ?? bar.statisticsObserved ?? Boolean((bar.statisticsSources ?? 0) & 2)
        if (probe.requirePreparedStatistics && Number.isFinite(expected.oi) && !oiObserved) fail('Fixture-known OI observation disappeared during prepared navigation.')
        if (probe.requirePreparedStatistics && Number.isFinite(expected.buy) && Number.isFinite(expected.sell) && !takerObserved) fail('Fixture-known Taker observation disappeared during prepared navigation.')
        for (const field of fields) {
          if (!(['open', 'high', 'low', 'close'].includes(field)
            || (field === 'oi' ? probe.requirePreparedStatistics || oiObserved
              : ['buy', 'sell'].includes(field) ? probe.requirePreparedStatistics || takerObserved : bar.indicatorsObserved))) continue
          if (expected[field] === null ? bar[field] !== null : typeof bar[field] !== 'number' || !Number.isFinite(bar[field]) || Math.abs(bar[field] - expected[field]) > Math.max(1, Math.abs(expected[field])) * 1e-10) {
            fail(`${snapshot.instId} ${bar.hour} ${field} has the wrong source value.`)
          }
        }
      }
      if (snapshot.oiState === 'ready' && Number(geometry.oiSamples) !== snapshot.bars.length) fail('OI geometry was incomplete after switching.')
      if (snapshot.takerState === 'ready' && Number(geometry.takerBuySamples) !== 96) fail('Taker buy geometry was incomplete after switching.')
      if (snapshot.takerState === 'ready' && Number(geometry.takerSellSamples) !== 96) fail('Taker sell geometry was incomplete after switching.')
      for (const path of geometry.pathData) if (/NaN|Infinity|undefined/.test(path)) fail('A switched chart contains invalid SVG geometry.')
    }
    probe.snapshotValidationMS = performance.now() - validationStartedAt
    delete window.__navigationPaintProbe
    return { rafSamples: probe.rafSamples, snapshotChanges: probe.snapshotChanges, minimumBars: probe.minimumBars, violations: probe.violations, commits: probe.commits,
      capture: { snapshots: probe.observations.length, totalMS: probe.snapshotCaptureMS, maxMS: probe.snapshotCaptureMaxMS },
      validation: { snapshots: probe.observations.length, totalMS: probe.snapshotValidationMS } }
  })
}

export function assertNavigationFrames(report) {
  const diagnostics = JSON.stringify({ snapshots: report.snapshotChanges, capture: report.capture, validation: report.validation })
  assert.ok(report.rafSamples > 0, `The probe needs renderer RAF samples. ${diagnostics}`)
  assert.equal(report.minimumBars, 96, `Every observed window must contain 96 bars. ${diagnostics}`)
  assert.deepEqual(report.violations, [], `A renderer snapshot was incomplete or used another contract’s values. ${diagnostics}`)
  assert.equal(report.capture.snapshots, report.snapshotChanges)
  assert.equal(report.validation.snapshots, report.snapshotChanges, 'Every captured snapshot must receive the deferred oracle checks.')
  for (const value of [report.capture.totalMS, report.capture.maxMS, report.validation.totalMS]) assert.ok(Number.isFinite(value) && value >= 0)
}

// Capture the actual input event and the subsequent actual SVG commit. Node
// locator/action latency is deliberately excluded from this measurement.
export async function measureNavigation(page, trigger, { expectedInstId = null, sourceInstId = null, timeframe = null, timeoutMS = 1_000 } = {}) {
  await page.evaluate(({ expectedInstId, sourceInstId, timeframe, timeoutMS }) => {
    const source = sourceInstId ?? document.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-inst')
    const expectedFrame = timeframe ?? document.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-timeframe')
    const pending = { done: false, started: null, inputType: null, inputKey: null, selectionAcknowledgedAt: null, frames: 0, raf: null, observer: null, result: null, timer: null }
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
        if (expectedInstId && pending.selectionAcknowledgedAt === null
          && document.querySelector(`[aria-label="View ${expectedInstId} chart"]`)?.getAttribute('aria-selected') === 'true') {
          pending.selectionAcknowledgedAt = performance.now()
        }
        const svg = document.querySelector('svg[data-rendered-inst]')
        const id = svg?.getAttribute('data-rendered-inst')
        const chart = svg?.closest('[data-chart-inst]')
        if (!id || expectedFrame && svg.getAttribute('data-rendered-timeframe') !== expectedFrame || (expectedInstId ? id !== expectedInstId : id === source) || chart.dataset.chartRenderedBars !== '96' || chart.dataset.chartLoading !== 'false') return
        const commitAt = performance.now()
        const result = { instId: id, timeframe: expectedFrame, sourceInstId: source,
          rendererTimeOrigin: performance.timeOrigin, inputAt: pending.started, commitAt, inputType: pending.inputType, inputKey: pending.inputKey,
          inputToSVGCommitMS: commitAt - pending.started, framesToCommit: pending.frames,
          probeCaptureMS: (window.__navigationPaintProbe?.snapshotCaptureMS ?? 0) - pending.captureStartedMS,
          inputToSelectionAcknowledgedMS: pending.selectionAcknowledgedAt === null ? null : pending.selectionAcknowledgedAt - pending.started }
        cleanup()
        requestAnimationFrame(() => {
          const rafSampleAt = performance.now()
          resolve({ ...result, rafSampleAt, inputToNextRafSampleMS: rafSampleAt - pending.started })
        })
      }
      const frame = () => { if (pending.done) return; if (pending.started !== null) pending.frames += 1; sample(); if (!pending.done) pending.raf = requestAnimationFrame(frame) }
      const timeout = () => { cleanup(); reject(new Error('The requested contract did not commit a complete chart before the navigation deadline.')) }
      const input = event => {
        if (pending.started !== null || event.type === 'keydown' && !event.key.startsWith('Arrow')) return
        pending.started = performance.now()
        pending.inputType = event.type; pending.inputKey = event.type === 'keydown' ? event.key : null
        pending.captureStartedMS = window.__navigationPaintProbe?.snapshotCaptureMS ?? 0
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

export async function exerciseInstrumentNavigation(electron, page, fixture, { holdHistory = true, presentation = 'offscreen', unpreparedInstId = null } = {}) {
  assert.ok(presentation === 'offscreen' || presentation === 'foreground', `Unknown navigation presentation: ${presentation}`)
  assert.ok(unpreparedInstId === null || fixture.instIds.includes(unpreparedInstId), 'The unprepared selection must be in the navigation fixture.')
  const phases = [], measurements = [], timingChecks = []
  let heldHistory = null
  // First launch and restart use the same renderer-received frame barrier.
  // Chart geometry is still created during each measured selection.
  const initialPreparation = { sourceFixtureSeedMS: fixture.seedCompletedAt - fixture.seedStartedAt,
    ...await waitForUniverseReady(electron, page, fixture, { omitInstId: unpreparedInstId }) }
  await page.waitForFunction(() => document.querySelector('svg[data-rendered-inst]')
    && document.querySelector('[data-chart-inst]')?.dataset.chartLoading === 'false', null, { timeout: 10_000 })
  let sharedSurface = await page.locator('svg[data-rendered-inst]').elementHandle()
  const assertSharedSurface = async phase => {
    assert.equal(await page.locator('svg[data-rendered-inst]').count(), 1, `${phase} must leave exactly one active chart SVG.`)
    assert.equal(await page.locator('svg[data-prepared-chart-inst]').count(), 1, `${phase} must not retain hidden candidate SVGs.`)
    assert.equal(await sharedSurface.evaluate(svg => svg.isConnected && svg === document.querySelector('svg[data-rendered-inst]')), true,
      `${phase} must reuse the current chart SVG node.`)
  }
  if (presentation === 'foreground') {
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), offscreen: window.webContents.isOffscreen() }
    })
    assert.deepEqual(native, { visible: true, focused: true, minimized: false, offscreen: false },
      'Foreground navigation timing requires a visible, focused native window.')
    assert.equal(await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), true,
      'Foreground navigation timing requires a visible, focused document.')
  } else {
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'Offscreen navigation acceptance must never take macOS window focus.')
  }
  const initialInstId = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
  const initialTimeframe = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-timeframe')
  if (initialTimeframe !== fixture.timeframe) {
    await selectTimeframe(page, fixture.timeframe)
    await waitForInstrument(page, initialInstId, fixture.timeframe)
  }
  await startNavigationFrameProbe(page, fixture, { requirePreparedStatistics: unpreparedInstId === null })
  const nextFrame = async (trigger, { rapid = false, requireLocal = false, ...options } = {}) => {
    const before = selectionRequests(await navigationRequests(electron)).length
    const result = await measureNavigation(page, trigger, options)
    const newRequests = selectionRequests(await navigationRequests(electron)).slice(before)
    const after = before + newRequests.length
    assert.ok(after - before <= 2, `A selection must use bounded local hydration: ${JSON.stringify({ result, requests: newRequests })}`)
    if (requireLocal) assert.ok(newRequests.some(request => request.kind === 'chartLocal' && request.instId === result.instId),
      `${result.instId} had no prepared renderer frame and must hydrate from durable local history.`)
    if (!requireLocal) {
      await assertSharedSurface(`${result.instId}/${result.timeframe ?? options.timeframe ?? 'current timeframe'} selection`)
    }
    measurements.push({ ...result, rapid, requireLocal, selectionIPC: after - before })
    timingChecks.push([`${measurements.length - 1}: ${result.instId}/${result.timeframe}`, () =>
      assertNavigationResponsiveness(result, { presentation, rapid, requireLocal })])
    return { ...result, selectionIPC: after - before }
  }
  let unpreparedSelection = null
  if (unpreparedInstId) {
    const current = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
    assert.notEqual(current, unpreparedInstId, 'The unprepared candidate must not already be selected.')
    const target = page.locator(`[aria-label="View ${unpreparedInstId} chart"]`)
    await target.waitFor({ state: 'visible', timeout: 15_000 })
    unpreparedSelection = await nextFrame(() => target.click(), {
      expectedInstId: unpreparedInstId, sourceInstId: current, timeframe: fixture.timeframe, requireLocal: true,
    })
    unpreparedSelection.rendererFrameAvailableBeforeInput = false
    unpreparedSelection.hydratedFromLocalHistory = true
    unpreparedSelection.preparedSwitchBudgetApplied = false
    const coldFrames = await finishNavigationFrameProbe(page)
    assertNavigationFrames(coldFrames)
    unpreparedSelection.coldFramesChecked = coldFrames.snapshotChanges
    unpreparedSelection.probeCosts = { capture: coldFrames.capture, validation: coldFrames.validation,
      inputToSVGCommitAdjusted: false }
    initialPreparation.beforeColdSelection = { ...initialPreparation }
    await electron.evaluate(() => { globalThis.__instrumentNavigationProbe.omitUniverseInstId = null })
    Object.assign(initialPreparation, await waitForUniverseReady(electron, page, fixture))
    await sharedSurface.dispose()
    sharedSurface = await page.locator('svg[data-rendered-inst]').elementHandle()
    await assertSharedSurface(`${unpreparedInstId} ready for subsequent prepared selection timing`)
    await startNavigationFrameProbe(page, fixture)
  }
  for (const timeframe of [fixture.timeframe, ...fixture.timeframes.filter(frame => frame !== fixture.timeframe)]) {
    await page.locator('[data-market-list] [aria-label^="View "]').first().waitFor({ state: 'visible' })
    let timeframeSwitch = null
    if (await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-timeframe') !== timeframe) {
      const previousSVG = await page.locator('svg[data-rendered-inst]').elementHandle()
      assert.ok(previousSVG)
      const instId = await page.locator('svg[data-rendered-inst]').getAttribute('data-rendered-inst')
      timeframeSwitch = await nextFrame(() => selectTimeframe(page, timeframe), { expectedInstId: instId, timeframe })
      await assertSharedSurface(`${timeframe} timeframe switch`)
      await previousSVG.dispose()
    }
    await assertWorkspaceLayout(page)
    const rendererFrames = initialPreparation.frames.find(frame => frame.timeframe === timeframe)
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
    if (holdThisPhase) {
      const switched = await nextFrame(() => page.keyboard.press('ArrowDown'), { sourceInstId: second.instId, timeframe })
      const commitCount = await page.evaluate(() => window.__navigationPaintProbe.commits.length)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - heldStartedAt))))
      assert.equal((await navigationRequests(electron)).heldSettled, false, 'The old history job must remain unresolved during the switch.')
      await releaseInstrumentHistory(electron)
      const releaseDeadline = Date.now() + 15_000
      while (!(await navigationRequests(electron)).heldSettled) {
        assert.ok(Date.now() < releaseDeadline, 'The old history response did not finish after release.')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await waitForInstrument(page, switched.instId, timeframe)
      const lateCommits = await page.evaluate(offset => window.__navigationPaintProbe.commits.slice(offset), commitCount)
      assert.ok(lateCommits.every(commit => commit.instId === switched.instId), 'The obsolete instrument committed after the new selection.')
      heldHistory = { heldForMS: 1_500, sourceInstId: first.instId, mouseSwitch, ...switched, lateWrongInstrumentCommits: 0 }
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
    }) }, { expectedInstId, timeframe, rapid: true })
    const rapidCommits = await page.evaluate(offset => window.__navigationPaintProbe.commits.slice(offset), beforeBurst)
    assert.ok(rapidCommits.every(commit => commit.instId === expectedInstId), 'A coalesced key burst must only commit its final requested instrument.')
    phases.push({ timeframe, rendererFrames, timeframeSwitch, firstVisit, mouseSwitch, keyboard, rapid, distinctContracts: new Set(order).size })
  }
  await sharedSurface.dispose()
  const frameReport = await finishNavigationFrameProbe(page)
  const { results: checks, failures } = collectAcceptanceChecks([
    ['canonical navigation frames', () => assertNavigationFrames(frameReport)], ...timingChecks,
  ])
  if (failures.length) {
    const evidence = { presentation, measurements, checks, initialPreparation, heldHistory, frameReport }
    throw new Error(`${failures.map(error => error?.message ?? String(error)).join('\n')}\nNavigation phase data: ${JSON.stringify(evidence)}`,
      { cause: new AggregateError(failures) })
  }
  if (presentation === 'foreground') {
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), offscreen: window.webContents.isOffscreen() }
    })
    assert.deepEqual(native, { visible: true, focused: true, minimized: false, offscreen: false },
      'The native window must remain foreground throughout navigation acceptance.')
    assert.equal(await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), true,
      'The document must remain foreground throughout navigation acceptance.')
  } else {
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false,
      'Offscreen navigation acceptance must never take macOS window focus.')
  }
  const timingScope = { ...navigationTimingScope(presentation), probeCosts: {
    capture: frameReport.capture, validation: frameReport.validation, inputToSVGCommitAdjusted: false,
  } }
  return { timingScope, phases, initialPreparation, unpreparedSelection, heldHistory,
    ...frameReport, commits: frameReport.commits.length }
}
