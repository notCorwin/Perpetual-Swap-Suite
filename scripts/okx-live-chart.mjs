import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright'
import { createOKXRelay } from './okx-relay.mjs'
import { chartOutcomeWithRelayErrors, missingCandleEvidence, requiredMarketInputFailures } from './okx-live-evidence.mjs'

const root = process.cwd(), directory = resolve(root, process.env.OKX_LIVE_CHART_OUTPUT ?? `.build/okx-live-chart/${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`)
await mkdir(directory, { recursive: true })
const operations = process.env.PERPETUAL_SWAP_OPERATION_DIR ? join(process.env.PERPETUAL_SWAP_OPERATION_DIR, 'okx-live-chart') : join(directory, 'operations')
const reportPath = join(directory, 'result.json'), controller = new AbortController()
const report = { schemaVersion: 1, integration: 'real-okx-to-native-electron-svg', revision: process.env.GITHUB_SHA ?? null,
  node: process.version, startedAt: new Date().toISOString(), classification: 'running',
  operationDirectory: operations, provenance: 'Native upstream OKX HTTP/WebSocket; real app downstream native sockets, worker backend, SQLite, IPC, preload, React and selected SVG.',
  scope: { instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], timeframe: '5m', noSeededMarketValues: true, maxRuntimeMS: 90_000,
    metadataTransformations: 'Only instrument-discovery rows are restricted to BTC/ETH.', priceTransformations: 'None; exact upstream envelopes. Bounded FIFO relay holds later prices during exact assertions.' }, observations: [] }
let electron, relay, page, exited = false, assertionActive = false, stage = 'clock-probe'
let appClosed, processExited
const hardTimer = setTimeout(() => {
  report.classification = assertionActive || stage === 'close-app' ? 'app-failure' : 'harness-failure'; report.error = { name: 'TimeoutError', message: 'The 90 second hard runtime bound was exceeded.' }
  report.source = relay?.snapshot(); report.endedAt = new Date().toISOString()
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2)) } catch {}
  try { electron?.process().kill('SIGKILL') } catch {}
  process.exit(1)
}, 90_000)
const workTimer = setTimeout(() => controller.abort(new DOMException('Live chart acceptance exceeded its 80 second work budget.', 'TimeoutError')), 80_000)
class CheckFailure extends Error { constructor(classification, message) { super(message); this.name = 'LiveChartFailure'; this.classification = classification } }
const sleep = ms => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms)
  const abort = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); reject(controller.signal.reason) }
  function done() { controller.signal.removeEventListener('abort', abort); resolve() }
  if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true })
})
const until = async (condition, timeoutMS, classification, message) => {
  const deadline = performance.now() + timeoutMS
  while (true) { controller.signal.throwIfAborted(); const value = await condition(); if (value) return value; if (performance.now() >= deadline) throw new CheckFailure(classification, message); await sleep(100) }
}
const readChart = () => page.evaluate(() => {
  const workspace = document.querySelector('[data-chart-workspace]'), chart = workspace?.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
  const svg = chart?.querySelector('svg[data-rendered-inst]'), label = svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
  return { instId: chart?.getAttribute('data-chart-inst'), timeframe: chart?.getAttribute('data-chart-timeframe'),
    svgInstId: svg?.getAttribute('data-rendered-inst'), svgTimeframe: svg?.getAttribute('data-rendered-timeframe'), svgEnd: Number(svg?.getAttribute('data-rendered-end')),
    label, price: Number(label.split(/\s/)[0].replaceAll(',', '')), snapshot: snapshot ? { instId: snapshot.instId, timeframe: snapshot.timeframe,
      endHour: snapshot.endHour, liveBar: snapshot.liveBar && { hour: snapshot.liveBar.hour, open: snapshot.liveBar.open, high: snapshot.liveBar.high,
        low: snapshot.liveBar.low, close: snapshot.liveBar.close, confirmed: snapshot.liveBar.confirmed }, priceObservedAt: snapshot.priceObservedAt,
      realtimeState: snapshot.realtimeState, bars: snapshot.bars.length, generation: snapshot.generation } : null,
    statuses: [...(workspace?.querySelectorAll('[role="status"]') ?? [])].map(value => value.textContent?.trim()) }
})
try {
  const sentAt = Date.now(), clockResponse = await fetch('https://www.okx.com/api/v5/public/time', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]) })
  const clockBody = await clockResponse.json(), receivedAt = Date.now(), serverTime = Number(clockBody?.data?.[0]?.ts)
  report.clockProbe = { status: clockResponse.status, code: clockBody.code, sentAt, receivedAt, serverTime,
    offsetMS: serverTime - (sentAt + receivedAt) / 2, roundTripMS: receivedAt - sentAt }
  if (!clockResponse.ok || clockBody.code !== '0' || !Number.isFinite(serverTime)) throw new CheckFailure('external-unavailable', 'OKX public clock probe did not return a valid native timestamp.')
  if (Math.abs(report.clockProbe.offsetMS) > 10_000) throw new CheckFailure('harness-failure', 'Local and exchange clocks differ by more than10seconds; freshness comparisons would be invalid.')
  stage = 'isolated-setup'
  const { MetadataStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(root, 'electron/services/metadata-store.js')))
  const userData = join(directory, 'user-data'), metadata = await MetadataStore.open(userData)
  try { const preferences = structuredClone(DEFAULT_PREFERENCES); preferences.chartTimeframe = '5m'; for (const condition of Object.values(preferences.liquidity)) condition.enabled = false; metadata.updateSettings(preferences) }
  finally { metadata.close() }
  relay = await createOKXRelay({ signal: controller.signal })
  stage = 'launch-app'
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root, timeout: 12_000,
    env: { ...process.env, ...relay.environment, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_TEST_UI: 'background',
      PERPETUAL_SWAP_TEST_OWNER_PID: String(process.pid), PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_ALLOW_NETWORK: '0',
      PERPETUAL_SWAP_GPU_TRACE: '0', PERPETUAL_SWAP_USER_DATA: userData, PERPETUAL_SWAP_OPERATION_DIR: operations } })
  appClosed = new Promise(resolve => electron.once('close', resolve))
  const child = electron.process()
  processExited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  page = await electron.firstWindow(); await page.waitForLoadState('domcontentloaded')
  report.presentation = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() } })
  assert.deepEqual(report.presentation, { visible: false, focused: false, focusable: false })
  stage = 'real-source-observation'
  const previousByInstrument = new Map()
  const observe = async (instId, phase) => {
    const previous = previousByInstrument.get(instId)
    try { await until(() => page.locator(`[aria-label="View ${instId} chart"]`).count(), 25_000, 'app-failure', 'Real eligible BTC/ETH market rows did not reach the native app.') }
    catch (error) {
      const failures = requiredMarketInputFailures(relay.snapshot(), { instId, sinceOrder: previous?.sourceCheckpoint ?? 0 })
      if (failures.length) {
        report.inputFailures = failures
        throw new CheckFailure('external-unavailable', 'Current required OKX catalog/ticker HTTP inputs failed without later recovery.')
      }
      throw error
    }
    await page.locator(`[aria-label="View ${instId} chart"]`).evaluate(node => node.click())
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^5m$/i }).evaluate(node => node.click())
    relay.gate(instId)
    const gateAt = Date.now(), gateOrder = relay.checkpoint()
    let witness
    try { witness = await until(() => [...relay.witnesses].reverse().find(value => {
      const raw = value.raw, timestamp = Number(raw[0]), current = Date.now() + report.clockProbe.offsetMS
      return value.instId === instId && value.receivedAt >= gateAt && value.forwardedAt === null
        && timestamp === Math.floor(current / 300_000) * 300_000 && timestamp === Math.floor(Date.now() / 300_000) * 300_000
        && timestamp + 300_000 - current > 15_000
        && (!previous || JSON.stringify(raw.slice(0, 8)) !== JSON.stringify(previous.expected.raw.slice(0, 8)))
    }), 20_000, 'integration-failed', 'No fresh, distinct real 5m source candle arrived away from the closing boundary.') }
    catch (error) {
      if (error instanceof CheckFailure) {
        report.missingWitness = missingCandleEvidence(relay.snapshot(), { instId, sinceOrder: gateOrder })
        throw new CheckFailure(report.missingWitness.classification, report.missingWitness.reason)
      }
      throw error
    }
    const expected = { ...witness, raw: [...witness.raw] }
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(Number.isFinite(Number(expected.raw[index])))
    relay.deliver(witness.sequence); expected.forwardedAt = witness.forwardedAt
    report.pendingObservation = { phase, expected }
    assertionActive = true
    let actual
    await until(async () => {
      actual = await readChart()
      const live = actual.snapshot?.liveBar
      return actual.instId === instId && actual.snapshot?.timeframe === '5m' && actual.svgInstId === instId && actual.svgTimeframe === '5m'
        && actual.svgEnd === Number(expected.raw[0]) && live?.hour === Number(expected.raw[0]) && live.confirmed === false
        && ['open', 'high', 'low', 'close'].every((field, index) => live[field] === Number(expected.raw[index + 1]))
        && actual.price === Number(expected.raw[4]) && actual.snapshot.priceObservedAt >= expected.forwardedAt
        && Date.now() - actual.snapshot.priceObservedAt < 10_000 && actual.snapshot.realtimeState === 'live' && !actual.statuses.includes('Cached price') && !actual.statuses.includes('Live price')
    }, 8_000, 'app-failure', `A genuine, delivered ${instId} candle failed to reach the selected SVG with exact OHLC, identity and freshness.`)
    assertionActive = false
    if (previous) assert.ok(actual.snapshot.priceObservedAt > previous.actual.snapshot.priceObservedAt, 'New real candle delivery must advance the observed timestamp even when price repeats.')
    const observation = { phase, expected, actual, svgObservedAt: Date.now(), sourceVolume: Number(expected.raw[5]), rendererVolumeExposed: false,
      sourceCheckpoint: relay.checkpoint() }
    report.observations.push(observation); previousByInstrument.set(instId, observation); relay.release(instId)
    delete report.pendingObservation
  }
  await observe('BTC-USDT-SWAP', 'cold real source')
  await observe('BTC-USDT-SWAP', 'later native update; price need not change')
  await observe('ETH-USDT-SWAP', 'native contract identity switch')
  await observe('BTC-USDT-SWAP', 'warm return to real cached series')
  report.presentationAfter = await electron.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return { visible: window.isVisible(), focused: window.isFocused() } })
  assert.deepEqual(report.presentationAfter, { visible: false, focused: false })
  report.classification = 'passed'
} catch (error) {
  report.classification = error.classification ?? (assertionActive || stage === 'launch-app' ? 'app-failure' : stage === 'clock-probe' ? 'external-unavailable' : 'harness-failure')
  report.error = { name: error.name, message: error.message, code: error.cause?.code }
  Object.assign(report, chartOutcomeWithRelayErrors(report, relay?.snapshot()))
  if (page) try { report.lastChart = await readChart() } catch {}
  process.exitCode = 1
} finally {
  clearTimeout(workTimer)
  if (electron) {
    stage = 'close-app'
    let closeTimer
    try {
      // Closing Chromium can reject evaluate before its reply arrives. Observe
      // the real application close and child exit independently of that reply.
      void electron.evaluate(({ app }) => app.quit()).catch(error => { report.shutdownRequestError = error.name })
      const [, exit] = await Promise.race([Promise.all([appClosed, processExited]), new Promise((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Native app did not close within 10 seconds.')), 10_000)
      })])
      report.shutdown = exit
      exited = exit.code === 0 && exit.signal === null
    } catch (error) { report.shutdownError = error.message }
    finally { clearTimeout(closeTimer) }
  }
  if (electron && !exited) await electron.close().catch(() => {})
  if (report.classification === 'passed' && !exited) {
    report.classification = 'app-failure'; report.error = { name: 'UncleanShutdown', message: 'The real native app did not exit cleanly after its chart assertions.' }; process.exitCode = 1
  }
  await relay?.close()
  report.source = relay?.snapshot(); report.endedAt = new Date().toISOString()
  Object.assign(report, chartOutcomeWithRelayErrors(report, report.source))
  if (report.classification !== 'passed') process.exitCode = 1
  if (exited) {
    try { report.health = await Promise.all((await readdir(operations)).filter(file => file.endsWith('.health.json')).map(async file => JSON.parse(await readFile(join(operations, file), 'utf8')))) }
    catch (error) { report.recordingError = error.name }
    const roles = ['electron-main', 'market-backend', 'market-reader', 'market-writer', 'prepared-chart', 'renderer']
    if (report.classification === 'passed' && (report.recordingError || !roles.every(role => report.health?.some(value => value.role === role))
      || !report.health.every(value => value.closed && value.pending === 0 && value.failed === 0 && value.sourceFailures === 0 && value.omittedRecords === 0))) {
      report.classification = 'app-failure'; report.error = { name: 'RecordingIncomplete', message: 'Native app recording/worker coverage did not close durably.' }; process.exitCode = 1
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2)); clearTimeout(hardTimer)
  console.log(JSON.stringify({ reportPath, classification: report.classification, observations: report.observations.length, error: report.error }, null, 2))
}
