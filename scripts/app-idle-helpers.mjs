import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { _electron } from 'playwright'
import { startSampling } from '../experiments/runtime-comparison/measurement/index.mjs'
import { waitForAsyncCondition } from './async-readiness.mjs'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const probe = (electron, input) => electron.evaluate((_, value) => globalThis.__marketBackend.probe(value), input)
export const presentationState = electron => electron.evaluate(() => globalThis.__presentationTest.getState())
export const setActive = (electron, active) => electron.evaluate((_, active) => globalThis.__presentationTest.setActive(active), active)

/** Only the prepared, background-only test app may run these measurements. */
export async function launchIdleApp({ operationRecording = true } = {}) {
  if (process.platform !== 'darwin' || process.env.PERPETUAL_SWAP_SANDBOX !== '1'
    || process.env.PERPETUAL_SWAP_TEST_UI !== 'background' || !process.env.PERPETUAL_SWAP_TEST_GUARD) {
    throw new Error('Run on macOS through node scripts/test-sandbox.mjs command --desktop -- node ... (background guard required).')
  }
  const userData = await mkdtemp(join(tmpdir(), 'perp-idle-test-'))
  let electron, sampler
  try {
    electron = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined,
      PERPETUAL_SWAP_USER_DATA: userData, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_OPERATION_TRACE: operationRecording ? '1' : '0',
      PERPETUAL_SWAP_OPERATION_DIR: operationRecording ? process.env.PERPETUAL_SWAP_OPERATION_DIR : '' } })
    // This one constant sampler covers setup, measurement, and reactivation;
    // worker threads are included in their parent process counters.
    sampler = await startSampling({ rootPids: [electron.process().pid], intervalMS: 1000, includeWebKit: false,
      onSample(sample) { assert.equal(sample.frontmostIsRuntime, false, 'The test runtime must never be the frontmost application (including unknown focus state).') } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.radarDesktop))
    assert.equal(await page.evaluate(() => window.radarDesktop.operationRecording), operationRecording, 'The selected tracing control must reach the renderer.')
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
        offscreen: window.webContents.isOffscreen(), alwaysOnTop: window.isAlwaysOnTop() }
    })
    assert.deepEqual(native, { visible: false, focused: false, focusable: false, offscreen: true, alwaysOnTop: false })
    // The initial document load starts its own snapshot epoch. Full tracing
    // can keep that legitimate asynchronous barrier pending past DOM ready.
    await waitForAsyncCondition(async () => {
      const state = await presentationState(electron)
      if (state.error) throw new Error(state.error)
      return state.active ? state : false
    }, { description: 'initial simulated active presentation snapshot', timeoutMS: 20_000, pollingMS: 25 })
    let stopped = false
    return { electron, page, sampler, native, userData, async close() {
      if (stopped) return null
      stopped = true
      let resources, failure
      try { resources = await sampler.stop() } catch (error) { failure = error }
      try { await electron.close() } catch (error) { failure ??= error }
      await rm(userData, { recursive: true, force: true })
      if (failure) throw failure
      return resources
    } }
  } catch (error) {
    await sampler?.stop().catch(() => {})
    await electron?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
    throw error
  }
}

export async function seedAndPrepare(electron, page, { count, periods }) {
  const fixture = await probe(electron, { action: 'scaleSeed', count, periods })
  assert.equal(fixture.rowsSeeded, count * periods * 3)
  await page.waitForFunction(count => Number(document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count')) === count, count, { timeout: 90_000 })
  const readiness = await waitForAsyncCondition(() => page.evaluate(async ({ instIds, timeframes }) => {
    const { frames } = await window.radarDesktop.request({ chartUniverse: {} })
    const ready = frames.filter(frame => frame.bars?.length === 96 && frame.indicatorState === 'ready' && ['ready', 'stale'].includes(frame.priceState))
    const keys = new Set(ready.map(frame => `${frame.instId}:${frame.timeframe}`))
    if (!instIds.every(instId => timeframes.every(frame => keys.has(`${instId}:${frame}`)))) return false
    // Same preparation barrier as the existing resource benchmark, outside the measured phases.
    for (const frame of ready) window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
    return { readyPairs: keys.size, frames: frames.length }
  }, fixture), { description: 'all seeded native chart series and indicators', timeoutMS: 180_000, pollingMS: 500 })
  assert.equal(readiness.readyPairs, count * 3)
  return { fixture, readiness }
}

export async function selectChart(page, instId, timeframe) {
  await page.getByRole('textbox', { name: 'Search contracts' }).fill(instId)
  await page.locator(`[aria-label="View ${instId} chart"]`).evaluate(node => node.click())
  await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: new RegExp(`^${timeframe}$`, 'i') }).evaluate(node => node.click())
  await page.waitForFunction(({ instId, timeframe }) => {
    const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    return snapshot?.instId === instId && snapshot?.timeframe === timeframe && svg?.dataset.renderedInst === instId
      && svg?.dataset.renderedTimeframe === timeframe && Number(svg.dataset.renderedEnd) === snapshot.endHour
      && chart.dataset.chartVisualStale === 'false' && chart.dataset.chartLoading === 'false'
      && Number(chart.dataset.chartRenderedBars) === 96 && snapshot.indicatorState === 'ready'
  }, { instId, timeframe }, { timeout: 60_000 })
}

// Listen before invoking the main-process transition: the event may precede
// the IPC response. It records the actual SVG/snapshot at the promised RAF.
export async function installReadyRecorder(page) {
  await page.evaluate(() => {
    if (window.__idleReadyRecorder) throw new Error('A presentation ready recorder is already installed.')
    const records = []
    const handler = event => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
      const svg = chart?.querySelector('svg[data-rendered-inst]')
      const row = snapshot?.instId ? document.querySelector(`[aria-label="View ${snapshot.instId} chart"]`) : null
      records.push({ epoch: event.detail?.epoch, at: Date.now(), marker: document.documentElement.dataset.presentationEpoch,
        instId: snapshot?.instId, timeframe: snapshot?.timeframe, endHour: snapshot?.endHour,
        liveBar: snapshot?.liveBar ? { hour: snapshot.liveBar.hour, close: snapshot.liveBar.close } : null,
        bars: snapshot?.bars?.length, indicatorState: snapshot?.indicatorState,
        chartInst: chart?.dataset.chartInst, chartEnd: Number(chart?.dataset.chartEnd),
        visualStale: chart?.dataset.chartVisualStale, loading: chart?.dataset.chartLoading,
        renderedBars: Number(chart?.dataset.chartRenderedBars), renderedInst: svg?.dataset.renderedInst,
        renderedTimeframe: svg?.dataset.renderedTimeframe, renderedEnd: Number(svg?.dataset.renderedEnd),
        visible: Boolean(svg?.isConnected && svg.getAttribute('aria-hidden') !== 'true' && svg.style.visibility !== 'hidden'),
        priceLabel: svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? null,
        marketPrice: row?.querySelectorAll('td')[1]?.textContent ?? null,
        marketCount: Number(document.querySelector('[data-total-market-count]')?.getAttribute('data-total-market-count')) })
    }
    window.addEventListener('radar-presentation-ready', handler)
    window.__idleReadyRecorder = { records, remove() { window.removeEventListener('radar-presentation-ready', handler); delete window.__idleReadyRecorder } }
  })
}
export async function removeReadyRecorder(page) { await page.evaluate(() => window.__idleReadyRecorder?.remove()) }

export async function awaitReady(page, update) {
  assert.ok(Number.isSafeInteger(update?.epoch) && Number.isFinite(update.startedAt), `Invalid presentation update: ${JSON.stringify(update)}`)
  const handle = await page.waitForFunction(epoch => {
    if (document.documentElement.dataset.presentationEpoch !== String(epoch)) return false
    return window.__idleReadyRecorder?.records.find(record => record.epoch === epoch) || false
  }, update.epoch, { timeout: 30_000 })
  try {
    const record = await handle.jsonValue()
    assert.equal(record.marker, String(update.epoch), 'Ready event must observe its own committed epoch marker.')
    assert.ok(record.at >= update.startedAt, 'Ready event precedes the main-process activation timestamp.')
    return { ...record, latencyMS: record.at - update.startedAt }
  } finally { await handle.dispose() }
}

export function expectedClose(fixture, instId, timeframe, sequence) {
  const index = fixture.instIds.indexOf(instId)
  if (index < 0 || !Object.hasOwn(fixture.intervals, timeframe) || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid synthetic chart oracle input.')
  return 100 + index * 3 + ({ '5m': 0, '15m': 10, '1H': 20 })[timeframe] + fixture.periods * .01 + sequence * .001
}

export function assertReadyFrame(frame, { instId, timeframe, expected, historicalEnd, marketExpected, marketCount } = {}) {
  assert.equal(frame.instId, instId); assert.equal(frame.chartInst, instId); assert.equal(frame.renderedInst, instId)
  assert.equal(frame.timeframe, timeframe); assert.equal(frame.renderedTimeframe, timeframe)
  assert.equal(frame.visible, true); assert.equal(frame.visualStale, 'false'); assert.equal(frame.loading, 'false')
  assert.equal(frame.renderedBars, 96); assert.equal(frame.bars, 96); assert.equal(frame.indicatorState, 'ready')
  assert.equal(frame.renderedEnd, frame.chartEnd)
  if (marketCount !== undefined) assert.equal(frame.marketCount, marketCount, 'The ready market list is incomplete.')
  if (marketExpected !== undefined) {
    const price = Number(frame.marketPrice?.replaceAll(',', ''))
    assert.ok(frame.marketPrice != null && Number.isFinite(price) && Math.abs(price - marketExpected) < 1e-8,
      `Market list price ${frame.marketPrice} does not match ${marketExpected}.`)
  }
  if (historicalEnd !== undefined) {
    assert.equal(frame.endHour, historicalEnd); assert.equal(frame.renderedEnd, historicalEnd)
  } else {
    assert.ok(frame.liveBar && Number.isFinite(frame.liveBar.close), 'A live ready frame must contain the latest quote.')
    assert.equal(frame.renderedEnd, frame.liveBar.hour)
    assert.ok(Math.abs(frame.liveBar.close - expected) < 1e-8, `Expected live close ${expected}, got ${frame.liveBar.close}.`)
    const label = Number(frame.priceLabel?.replaceAll(',', '').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/i)?.[0])
    assert.ok(Number.isFinite(label) && Math.abs(label - expected) < 1e-8, `SVG price ${frame.priceLabel} does not match ${expected}.`)
  }
}

export async function waitLoad(electron, condition, timeoutMS = 30_000) {
  return waitForAsyncCondition(async () => {
    const load = await probe(electron, { action: 'scaleLoadRead' })
    if (load.failed || load.state === 'failed') throw new Error(`Synthetic source failed: ${JSON.stringify(load)}`)
    if (load.state === 'complete' && !condition(load)) throw new Error('Synthetic source ended before the requested phase completed.')
    return condition(load) && load
  }, { description: 'fixed-rate source ticks', timeoutMS, pollingMS: 100 })
}

/** Choose whole sampler intervals containing exactly the requested source ticks. */
export function phaseWindow(samples, ticks, { start, end, tickCount, expectedUpdates }) {
  const within = samples.filter(sample => sample.timestampMS >= start && sample.timestampMS <= end)
  let chosen = null
  for (let first = 0; first < within.length - 1; first++) for (let last = first + 1; last < within.length; last++) {
    const from = within[first].timestampMS, through = within[last].timestampMS
    const source = ticks.filter(tick => tick.emittedAt > from && tick.emittedAt <= through)
    if (source.length !== tickCount) continue
    // A sample window cannot borrow source processing from an adjacent phase.
    const preceding = ticks.filter(tick => tick.emittedAt <= from).at(-1)
    if (preceding && (preceding.completedAt == null || preceding.completedAt > from)) continue
    if (source.some((tick, index) => tick.error || tick.completedAt == null || tick.nativeUpdates !== expectedUpdates
      || tick.completedAt > through || index && tick.sequence !== source[index - 1].sequence + 1)) continue
    const candidate = { samples: within.slice(first, last + 1), ticks: source, from, through }
    if (!chosen || candidate.through - candidate.from > chosen.through - chosen.from) chosen = candidate
  }
  if (!chosen) throw new Error(`No complete sampler window contained exactly ${tickCount} consecutive, complete source ticks; observed ${within.length} samples in the phase.`)
  return chosen
}
export const delay = sleep
