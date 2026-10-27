#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'
import { requireForegroundTests } from '../electron/test-presentation.js'
import { createMarketTrafficExchange } from '../tests/helpers/market-traffic-exchange.mjs'
import { createMarketTrafficEvidence } from '../tests/helpers/market-traffic-evidence.mjs'
import { inspectMarketTrafficReadiness } from '../tests/helpers/market-traffic-readiness.mjs'
import { compareMarketTrafficReports, validateMarketTrafficReport } from './market-traffic-comparison.mjs'
import { startRendererDiagnostics } from './renderer-diagnostics.mjs'
import { installMainLoopWitness } from './main-loop-witness.mjs'
import { installMarketTrafficRendererProbe } from './market-traffic-renderer-probe.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({
  options: {
    'app-root': { type: 'string' }, output: { type: 'string' },
    'candidate-count': { type: 'string' }, 'passing-count': { type: 'string' },
    'spread-failure-count': { type: 'string' }, 'duration-seconds': { type: 'string' }, 'cadence-ms': { type: 'string' },
    'expect-optimized': { type: 'boolean' }, foreground: { type: 'boolean' }, diagnostic: { type: 'boolean' },
    'wait-ready': { type: 'boolean' }, 'baseline-report': { type: 'string' },
  },
  allowPositionals: false,
})
const diagnosticDirectory = process.env.PERPETUAL_SWAP_RENDERER_DIAGNOSTICS
if (diagnosticDirectory && !values.diagnostic) throw new Error('Normal traffic acceptance rejects renderer profiling. Use --diagnostic only for a separate diagnostic run.')
if (values.diagnostic && !diagnosticDirectory) throw new Error('--diagnostic requires PERPETUAL_SWAP_RENDERER_DIAGNOSTICS for its separate profile output.')

const numberOption = (name, fallback) => {
  const value = Number(values[name] ?? fallback)
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be a whole number.`)
  return value
}
const candidateCount = numberOption('candidate-count', 50)
const passingCount = numberOption('passing-count', 6)
const spreadFailureCount = numberOption('spread-failure-count', Math.floor((candidateCount - passingCount) / 2))
const durationSeconds = numberOption('duration-seconds', 7)
const cadenceMS = numberOption('cadence-ms', 500)
const expectOptimized = values['expect-optimized'] === true
const foreground = values.foreground === true
const baselineReportPath = values['baseline-report'] ? resolve(values['baseline-report']) : null
if (values.diagnostic && baselineReportPath) throw new Error('Diagnostic profiling cannot be compared with an acceptance baseline.')
const waitReady = foreground || values['wait-ready'] === true
const searchEventCount = (passingCount + 1) * (foreground ? Math.ceil(21 / (passingCount + 1)) : 1)
const searchScenario = foreground ? { version: 'distributed-input-v1', eventCount: searchEventCount,
  windowMS: durationSeconds * 1_000, lastInputAtMS: durationSeconds * 1_000 - 100 } : null
const benchmarkMode = foreground
  ? 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness'
  : 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness'
const searchMeasurement = `${foreground ? 'Native foreground' : 'Hidden offscreen'} renderer RAF callback opportunity gaps and input-to-second-RAF scheduling latency. These timings do not measure SVG commit or native compositor paint; filtered result counts are sampled after the second RAF.`
if (candidateCount < 3 || candidateCount > 100) throw new Error('--candidate-count must be between 3 and 100.')
if (durationSeconds < 5 || durationSeconds > 10) throw new Error('--duration-seconds must be between 5 and 10.')
if (cadenceMS < 100 || cadenceMS > 2_000) throw new Error('--cadence-ms must be between 100 and 2000.')
if (baselineReportPath && !foreground) throw new Error('--baseline-report is supported only with --foreground.')
if (baselineReportPath && !expectOptimized) throw new Error('--baseline-report requires --expect-optimized for the after run.')
if (foreground) {
  // This check rejects local --foreground use before app resolution or launch.
  requireForegroundTests()
  if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_TEST_UI !== 'foreground'
    || process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '0') {
    throw new Error('Run foreground market traffic measurement through scripts/test-sandbox.mjs command --desktop --foreground with network disabled.')
  }
} else if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_TEST_UI !== 'background'
  || process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '0' || !process.env.PERPETUAL_SWAP_TEST_GUARD) {
  throw new Error('Run through scripts/test-sandbox.mjs command --desktop. The hidden protected runtime and network-disabled sandbox are required.')
}

async function appEntryFor(appRoot) {
  const selected = resolve(appRoot), info = await stat(selected).catch(() => null)
  if (!info) throw new Error(`App root does not exist: ${selected}`)
  if (info.isFile() && extname(selected) === '.asar') return { selected, entry: selected, cwd: dirname(selected) }
  if (!info.isDirectory()) throw new Error(`App root must be a project directory, .asar file, or .app bundle: ${selected}`)
  if (selected.endsWith('.app')) {
    const resources = join(selected, 'Contents', 'Resources'), archive = join(resources, 'app.asar'), unpacked = join(resources, 'app')
    if (await stat(archive).then(value => value.isFile()).catch(() => false)) return { selected, entry: archive, cwd: resources }
    if (await stat(unpacked).then(value => value.isDirectory()).catch(() => false)) return { selected, entry: unpacked, cwd: resources }
    throw new Error(`The selected app has neither app.asar nor Resources/app: ${selected}`)
  }
  if (!await stat(join(selected, 'package.json')).then(value => value.isFile()).catch(() => false)) {
    throw new Error(`Working-tree app root does not contain package.json: ${selected}`)
  }
  return { selected, entry: selected, cwd: selected }
}

function checkoutMetadata(directory = root) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).trim())
  return { revision, dirty }
}

async function targetMetadata(app, checkout) {
  if (!app.selected.endsWith('.app') && !app.selected.endsWith('.asar')) {
    return { path: app.selected, provenance: 'working-tree checkout', revision: checkout.revision, dirty: checkout.dirty }
  }
  const path = app.selected.endsWith('.app') ? join(app.selected, 'Contents', 'Resources', 'build-revision.json')
    : join(dirname(app.selected), 'build-revision.json')
  try { return { path, ...JSON.parse(await readFile(path, 'utf8')) } }
  catch { return { path, revision: null, dirty: null } }
}

async function runtimeMetadata(electron) {
  const runtime = await electron.evaluate(({ app }) => ({ executable: process.execPath, electronVersion: process.versions.electron,
    packaged: app.isPackaged, appPath: app.getAppPath() }))
  if (foreground) return { presentation: 'native-foreground-window', testPresentation: 'foreground-native', sourceFingerprint: null,
    executable: runtime.executable, electronVersion: runtime.electronVersion, packaged: runtime.packaged, appPath: runtime.appPath,
    foregroundCIProof: { githubActions: process.env.GITHUB_ACTIONS === 'true', runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
      runnerOS: process.env.RUNNER_OS ?? null } }
  const guard = JSON.parse(await readFile(process.env.PERPETUAL_SWAP_TEST_GUARD, 'utf8'))
  if (runtime.executable !== guard.executable) throw new Error(`App did not use the protected test Electron runtime: ${runtime.executable}`)
  return { presentation: guard.presentation, testPresentation: guard.presentation, sourceFingerprint: guard.sourceFingerprint, executable: runtime.executable,
    electronVersion: runtime.electronVersion, packaged: runtime.packaged, appPath: runtime.appPath }
}

async function assertHidden(electron) {
  const state = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), offscreen: window.webContents.isOffscreen() }
  })
  assert.deepEqual(state, { visible: false, focused: false, minimized: false, offscreen: true }, 'App must remain hidden, unfocused and offscreen.')
  return state
}

async function assertForeground(electron, page) {
  requireForegroundTests()
  const id = await electron.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('Foreground measurement requires the app window.')
    if (window.isMinimized()) window.restore()
    window.show()
    app.focus({ steal: true })
    window.focus()
    return window.id
  })
  await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), null, { timeout: 5_000 })
  const state = await electron.evaluate(({ BrowserWindow }, windowId) => {
    const window = BrowserWindow.fromId(windowId)
    return { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), offscreen: window.webContents.isOffscreen() }
  }, id)
  assert.deepEqual(state, { visible: true, focused: true, minimized: false, offscreen: false },
    'Foreground market traffic measurement requires a visible, focused, non-offscreen native window.')
  return state
}

async function waitForSelectedFrames(page, instIds) {
  const startedAt = performance.now(), timeframe = '15m', timeoutMS = 120_000
  const firstObservedReadyAtMS = new Map()
  await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: /^15m$/i }).click()
  let observed = { readyIDs: [], missingIDs: [...instIds].sort(), terminalStates: [] }
  while (performance.now() - startedAt < timeoutMS) {
    const summaries = await page.evaluate(async ({ instIds, timeframe }) => {
      const { frames } = await window.radarDesktop.request({ chartUniverse: {} })
      const selected = new Map(frames.filter(frame => instIds.includes(frame.instId) && frame.timeframe === timeframe)
        .map(frame => [frame.instId, frame]))
      const candidates = instIds.map(instId => {
        const frame = selected.get(instId)
        if (!frame) return { instId, timeframe, present: false }
        return { instId, timeframe, present: true, barCount: frame.bars?.length ?? 0,
          firstBarHour: frame.bars?.[0]?.hour ?? null, lastBarHour: frame.bars?.at(-1)?.hour ?? null,
          endHour: frame.endHour ?? null, latestEnd: frame.latestEnd ?? null, oldestHour: frame.oldestHour ?? null,
          historyExhausted: frame.historyExhausted ?? null, generation: frame.generation ?? null, revision: frame.revision ?? null,
          indicatorState: frame.indicatorState ?? null, indicatorStatus: frame.indicatorStatus ?? null,
          priceState: frame.priceState ?? null, priceStatus: frame.priceStatus ?? null,
          oiState: frame.oiState ?? null, oiStatus: frame.oiStatus ?? null,
          takerState: frame.takerState ?? null, takerStatus: frame.takerStatus ?? null,
          sourceVersions: frame.sourceVersions ?? null, error: frame.error ?? null }
      })
      const canonical = frames.filter(frame => instIds.includes(frame.instId) && frame.timeframe === timeframe
        && frame.bars?.length === 96 && frame.indicatorState === 'ready'
        && ['ready', 'stale'].includes(frame.priceState) && ['ready', 'unavailable'].includes(frame.oiState)
        && ['ready', 'unavailable'].includes(frame.takerState))
      const delivered = window.__marketTrafficReadyFrames ??= new Set()
      for (const frame of canonical) if (!delivered.has(frame.instId)) {
        window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail: frame }))
        delivered.add(frame.instId)
      }
      return candidates
    }, { instIds, timeframe })
    observed = inspectMarketTrafficReadiness(instIds, timeframe, summaries)
    const elapsedMS = performance.now() - startedAt
    for (const instId of observed.readyIDs) if (!firstObservedReadyAtMS.has(instId)) firstObservedReadyAtMS.set(instId, elapsedMS)
    if (observed.missingIDs.length === 0) break
    await sleep(100)
  }
  const evidence = { timeframe, expectedFrames: instIds.length, readyFrames: observed.readyIDs.length,
    readyIDs: observed.readyIDs, missingIDs: observed.missingIDs,
    terminalStates: observed.terminalStates.map(frame => ({ ...frame, firstObservedReadyAtMS: firstObservedReadyAtMS.get(frame.instId) ?? null })),
    elapsedMS: performance.now() - startedAt, timeoutMS,
    measurement: 'Bounded chart startup readiness warmup; elapsedMS is excluded from steady-state performance results.' }
  readinessFailureEvidence = evidence
  if (evidence.missingIDs.length) {
    const error = new Error(`Every qualified selected-period frame must be ready within the bounded ${timeoutMS / 1_000}s startup warmup. Missing: ${evidence.missingIDs.join(', ')}.`)
    error.readinessEvidence = evidence
    throw error
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return evidence
}

function fixtureRequestEvidence(requests) {
  return requests.map(({ path, parameters, receivedAt, respondedAt, responseChannel, responsePayloadBytes }) => ({
    path, parameters, receivedAt, respondedAt: respondedAt ?? null, responseChannel: responseChannel ?? null,
    responsePayloadBytes: responsePayloadBytes ?? 0,
  }))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let baselineReport = null
if (baselineReportPath) {
  try {
    baselineReport = JSON.parse(await readFile(baselineReportPath, 'utf8'))
    validateMarketTrafficReport(baselineReport, 'baseline', { baseline: true })
    if (baselineReport.mode !== 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness') {
      throw new Error('Baseline report must use the native foreground presentation.')
    }
    assert.equal(baselineReport.fixture.expectOptimized, false, 'Foreground baseline report must omit optimized-only assertions.')
  } catch (error) {
    throw new Error(`Invalid --baseline-report ${baselineReportPath}: ${error.message}`)
  }
}
const app = await appEntryFor(values['app-root'] ?? root)
const checkout = checkoutMetadata(app.selected.endsWith('.app') || app.selected.endsWith('.asar') ? root : app.selected)
const target = await targetMetadata(app, checkout)
const output = resolve(values.output ?? join(root, '.build/traffic-optimization/market-traffic.json'))
const userData = process.env.PERPETUAL_SWAP_USER_DATA
if (!userData || (!foreground && !process.env.PERPETUAL_SWAP_TEST_GUARD)) throw new Error('Protected sandbox user data is required.')
const fixture = await createMarketTrafficExchange({ candidateCount, passingCount, spreadFailureCount, seed: 17 })
let electron, cadence, failureMeasurements, completedReport, runtimeEvidence, presentationEvidence, readinessFailureEvidence, stopDiagnostics, mainLoopStarted = false
try {
  electron = await _electron.launch({ args: [app.entry], cwd: app.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '1',
      PERPETUAL_SWAP_E2E_HTTP_ORIGIN: fixture.environment.PERPETUAL_SWAP_E2E_HTTP_ORIGIN,
      PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN: fixture.environment.PERPETUAL_SWAP_E2E_WEBSOCKET_ORIGIN,
      PERPETUAL_SWAP_USER_DATA: userData } })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const presentation = foreground ? await assertForeground(electron, page) : await assertHidden(electron)
  const runtime = await runtimeMetadata(electron)
  presentationEvidence = presentation
  runtimeEvidence = runtime
  await page.waitForSelector('input[aria-label="Search contracts"]', { timeout: 30_000 })

  let snapshot
  const qualificationDeadline = Date.now() + 120_000
  while (Date.now() < qualificationDeadline) {
    snapshot = await page.evaluate(() => window.radarDesktop.request({ snapshot: {} }))
    const progress = snapshot.catalogProgress
    const settled = progress?.total === candidateCount && progress.completed === candidateCount && progress.pending === 0
      && progress.verified === passingCount && progress.failed === candidateCount - passingCount && progress.unknown === 0
    const ids = new Set((snapshot.rows ?? []).map(row => row.instId))
    const rightRows = fixture.instIds.slice(0, passingCount).every(instId => ids.has(instId))
    if (settled && rightRows && ['live', 'connecting'].includes(snapshot.realtimeState)) break
    await sleep(100)
  }
  assert.ok(snapshot, 'The app never returned a market snapshot.')
  assert.deepEqual(snapshot.catalogProgress, { total: candidateCount, completed: candidateCount, pending: 0,
    verified: passingCount, failed: candidateCount - passingCount, unknown: 0 }, 'The production parser must qualify exactly the deterministic passing set.')
  assert.equal(snapshot.catalogSource, 'live', 'The candidate result must come from the live fixture path.')
  assert.ok(['live', 'connecting'].includes(snapshot.realtimeState), 'Realtime must not be disconnected or recovering before sampling.')
  assert.deepEqual((snapshot.rows ?? []).map(row => row.instId).sort(), fixture.instIds.slice(0, passingCount).sort(),
    'The rendered market list must contain exactly the passing fixture contracts.')
  await page.waitForFunction(count => document.querySelector('[data-market-count]')?.getAttribute('data-market-count') === String(count),
    passingCount, { timeout: 5_000 })
  assert.equal(await page.locator('[data-market-count]').getAttribute('data-market-count'), String(passingCount),
    'The renderer must present all passing candidates before measurement.')

  const requiredChannels = ['tickers', 'open-interest', 'candle5m']
  const ackDeadline = Date.now() + 30_000
  let acknowledgements = fixture.currentAcknowledgements
  while (Date.now() < ackDeadline && requiredChannels.some(channel => (acknowledgements[channel] ?? []).length !== candidateCount)) {
    await sleep(50)
    acknowledgements = fixture.currentAcknowledgements
  }
  for (const channel of requiredChannels) {
    const subscribed = acknowledgements[channel] ?? []
    assert.equal(subscribed.length, candidateCount, `Every candidate must have a live ${channel} subscription.`)
    assert.deepEqual(subscribed.filter(id => id !== 'SWAP').sort(), fixture.instIds.slice().sort(), `The ${channel} subscription set must be complete.`)
  }
  assert.ok(fixture.readyState.clients >= 3, 'The app must open public and business loopback WebSockets.')
  const qualifyingIDs = new Set((snapshot.rows ?? []).map(row => row.instId))
  const optimizedDemand = { checked: false, bookIDs: [], tradeIDs: [], candle15mCount: null, candle1HCount: null }
  assert.deepEqual(fixture.errors, [], 'The fixture observed an invalid or unexpected production request.')

  cadence = fixture.startCadence(cadenceMS)
  // Keep live fixture observations flowing while chart startup work settles.
  // The fixed steady-state sample still starts only after readiness plus one
  // complete cadence interval.
  const readiness = waitReady ? await waitForSelectedFrames(page, [...qualifyingIDs]) : null
  await sleep(cadenceMS)
  // The sample clock starts after qualification, connection setup and the
  // initial cadence message. Only steady-state fixture traffic is measured.
  if (foreground) await assertForeground(electron, page)
  const appDemand = await electron.evaluate(() => globalThis.__marketBackend.probe({ action: 'marketTrafficEvidence', phase: 'arm' }))
  assert.equal(appDemand.source, 'market-service accepted callbacks after native parsing', 'Application receipt capture must use the production service callbacks.')
  const expectedSubscriptions = appDemand.expectedSubscriptions
  assert.deepEqual(expectedSubscriptions.tickers, fixture.instIds, 'Configured ticker demand must cover every fixture candidate.')
  assert.deepEqual(expectedSubscriptions['open-interest'], fixture.instIds, 'Configured open-interest demand must cover every fixture candidate.')
  assert.deepEqual(expectedSubscriptions.candle5m, fixture.instIds, 'The production canonical candle source must cover every fixture candidate.')
  assert.deepEqual(appDemand.marketDemand.eligibleIDs, [...qualifyingIDs].sort(), 'Receipt demand must use the actual eligible market universe.')
  assert.deepEqual(expectedSubscriptions.trades,
    [...new Set([...appDemand.marketDemand.eligibleIDs, appDemand.marketDemand.focusedInstrumentID].filter(Boolean))].sort(),
    'Trade demand must cover the eligible market list and the focused chart contract.')
  if (appDemand.marketDemand.booksEnabled) for (const instId of qualifyingIDs) {
    assert.ok(expectedSubscriptions.books.includes(instId), `Configured depth/slippage checks require a book for eligible ${instId}.`)
  }
  if (expectOptimized) {
    assert.deepEqual(expectedSubscriptions.candle15m, [], 'The production chart must derive 15m from its canonical 5m source.')
    assert.deepEqual(expectedSubscriptions.candle1H, [], 'The production chart must derive 1H from its canonical 5m source.')
  }
  const demandDeadline = Date.now() + 30_000
  const demandAcknowledged = () => {
    acknowledgements = fixture.currentAcknowledgements
    const expectedChannels = new Set(Object.keys(expectedSubscriptions))
    const activeChannels = Object.keys(acknowledgements).filter(channel => channel !== 'instruments')
    return activeChannels.every(channel => expectedChannels.has(channel))
      && Object.entries(expectedSubscriptions).every(([channel, ids]) =>
        JSON.stringify([...(acknowledgements[channel] ?? [])].sort()) === JSON.stringify(ids))
  }
  while (!demandAcknowledged() && Date.now() < demandDeadline) await sleep(50)
  assert.equal(demandAcknowledged(), true, 'Acknowledged fixture subscriptions must match the app-derived configured eligible/focus demand exactly.')
  if (expectOptimized) {
    optimizedDemand.checked = true
    optimizedDemand.bookIDs = [...expectedSubscriptions.books]
    optimizedDemand.tradeIDs = [...expectedSubscriptions.trades]
    optimizedDemand.candle15mCount = expectedSubscriptions.candle15m.length
    optimizedDemand.candle1HCount = expectedSubscriptions.candle1H.length
  }
  if (values.diagnostic) stopDiagnostics = await startRendererDiagnostics(electron, page, diagnosticDirectory)
  await electron.evaluate(installMainLoopWitness)
  mainLoopStarted = true
  const sampleWindow = await fixture.beginSample()
  const sampleStartedAt = sampleWindow.startedAt
  await page.evaluate(installMarketTrafficRendererProbe, { requireForeground: foreground, passingIDs: [...qualifyingIDs] })
  const search = page.locator('input[aria-label="Search contracts"]')
  const searches = fixture.instIds.slice(0, passingCount).map(instId => instId.slice(0, 4))
  const interactionTask = (async () => {
    const terms = [...searches, ''], startedAt = performance.now()
    for (let index = 0; index < searchEventCount; index++) {
      if (foreground) await sleep(Math.max(0, startedAt + index * searchScenario.lastInputAtMS / (searchEventCount - 1) - performance.now()))
      await search.fill(terms[index % terms.length])
      if (!foreground) await sleep(30)
    }
  })()
  await Promise.all([interactionTask, sleep(durationSeconds * 1_000)])
  const traffic = fixture.endSample()
  failureMeasurements = {
    schemaVersion: 1, mode: benchmarkMode, partial: true, generatedAt: new Date().toISOString(),
    diagnosticOnly: values.diagnostic === true,
    app: { path: app.selected, entry: app.entry, build: target, checkout },
    runtime: { ...runtime, testPresentation: runtime.testPresentation, presentation,
      network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1' },
    fixture: { asOf: fixture.asOf, candidateCount, passingCount, spreadFailureCount, oiFailureCount: fixture.oiFailureCount, seed: fixture.seed,
      candidateIDs: fixture.instIds,
      dataFingerprint: `market-traffic-v3-app-receipts-${candidateCount}-${passingCount}-${spreadFailureCount}-seed-${fixture.seed}`,
      cadenceMS, durationSeconds, sampleStartedAt, expectOptimized, readiness, searchScenario,
      readinessPhase: readiness ? 'all-passing-15m-frames-ready-before-steady-state-sample' : null },
    rawFixtureSample: traffic,
    renderer: null,
  }
  let rendererCaptureError
  const renderer = await page.evaluate(() => globalThis.__marketTrafficResponsiveness.stop())
    .catch(error => { rendererCaptureError = error; return null })
  failureMeasurements.renderer = renderer ? { ...renderer, measurement: searchMeasurement } : null
  if (rendererCaptureError) failureMeasurements.rendererCaptureError = rendererCaptureError.message
  const mainProcess = await electron.evaluate(() => globalThis.__mainLoopWitness.stop())
  mainLoopStarted = false
  failureMeasurements.mainProcess = mainProcess
  const appReceipts = await electron.evaluate((_, sample) => globalThis.__marketBackend.probe({ action: 'marketTrafficEvidence', phase: 'end',
    sampleStartedAt: sample.startedAt, sampleEndedAt: sample.endedAt,
    sampleStartedMonotonicUS: sample.startedAtMonotonicUS, sampleEndedMonotonicUS: sample.endedAtMonotonicUS,
    drainDeadlineMonotonicUS: sample.drainDeadlineMonotonicUS }), traffic).catch(error => {
    failureMeasurements.applicationCaptureError = error.message
    throw error
  })
  failureMeasurements.rawApplicationReceipts = appReceipts
  if (rendererCaptureError) throw rendererCaptureError
  assert.equal(appReceipts.captureError, undefined, `Application capture failed: ${JSON.stringify(appReceipts.captureError)}`)
  assert.deepEqual(appReceipts.expectedSubscriptions, expectedSubscriptions,
    'The configured eligible/focus demand must stay unchanged through the sample.')
  const receiptEvidence = createMarketTrafficEvidence({ expectedSubscriptions,
    applicationReceipts: appReceipts.applicationReceipts, nativeIngressEvents: appReceipts.nativeIngressEvents,
    fixtureDeliveries: traffic, fixtureRounds: traffic.rounds,
    sampleStartedAt: traffic.startedAt, sampleEndedAt: traffic.endedAt,
    sampleStartedMonotonicUS: traffic.startedAtMonotonicUS, sampleEndedMonotonicUS: traffic.endedAtMonotonicUS,
    drainDeadlineMonotonicUS: traffic.drainDeadlineMonotonicUS, cadenceMS,
    allowNoFillTrades: true,
    probeObserverCostMonotonicUS: appReceipts.probeObserverCostMonotonicUS })
  if (foreground) assert.equal(renderer.presentation.totalViolations, 0, 'Foreground visibility and focus must hold throughout sampling.')
  assert.ok(Math.abs(traffic.durationSeconds - durationSeconds) <= 0.75,
    `Steady-state traffic sample duration drifted outside the bounded window: ${traffic.durationSeconds}s.`)
  const finalValues = fixture.latestValues
  let finalSnapshot, outputMatchesLatest = false
  const outputDeadline = Date.now() + 1_000
  while (Date.now() < outputDeadline) {
    finalSnapshot = await page.evaluate(() => window.radarDesktop.request({ snapshot: {} }))
    outputMatchesLatest = (finalSnapshot.rows ?? []).length === passingCount && finalSnapshot.rows.every(row => {
      const expected = Number(finalValues[`tickers:${row.instId}`]?.last)
      return Number.isFinite(expected) && Math.abs(row.lastPrice - expected) < 1e-8
    })
    if (outputMatchesLatest && JSON.stringify(finalSnapshot.catalogProgress) === JSON.stringify(snapshot.catalogProgress)) break
    await sleep(25)
  }
  assert.ok(['live', 'connecting'].includes(finalSnapshot.realtimeState), 'Realtime cannot disconnect or recover during the sample.')
  assert.ok(fixture.readyState.clients >= 3, 'The public and business loopback transports must stay connected for the sample.')
  if (expectOptimized) for (const channel of ['candle15m', 'candle1H']) {
    assert.equal(traffic.websocket[channel]?.messages ?? 0, 0, `Optimized mode must send no remote ${channel} stream payloads.`)
  }
  assert.deepEqual(finalSnapshot.catalogProgress, snapshot.catalogProgress, 'Qualification must stay settled during the sample.')
  assert.deepEqual((finalSnapshot.rows ?? []).map(row => row.instId).sort(), fixture.instIds.slice(0, passingCount).sort(),
    'Candidate output must remain correct throughout the sample.')
  assert.equal(outputMatchesLatest, true, 'Rendered passing tickers must match the latest fixture values.')
  assert.ok(renderer.frameCount >= durationSeconds * 15, 'Renderer RAF sampling is incomplete; reject disconnected/no-op runs.')
  assert.ok(renderer.searchInputToSecondRAFMS.sampleCount >= passingCount, 'Renderer did not process all search interactions.')
  assert.equal(renderer.searchInputToSecondRAFMS.sampleCount, searchEventCount, 'Renderer must complete the entire declared search schedule.')
  if (foreground) assert.ok(renderer.searchInputToSecondRAFMS.samples.every(sample => sample.correct), 'Every timed input must render the expected filtered contract count.')
  if (expectOptimized) {
    assert.ok(renderer.rafOpportunityGapMS.p95 <= 50, `Optimized renderer RAF opportunity gap p95 exceeded 50ms: ${renderer.rafOpportunityGapMS.p95}`)
    assert.ok(renderer.searchInputToSecondRAFMS.p95 <= 50, `Optimized input-to-second-RAF p95 exceeded 50ms: ${renderer.searchInputToSecondRAFMS.p95}`)
  }
  assert.deepEqual(fixture.errors, [], 'The fixture observed a production protocol or endpoint error during measurement.')
  const unsolicitedHTTP = fixture.requests.filter(request => !request.respondedAt || request.responsePayloadBytes <= 0)
  assert.deepEqual(unsolicitedHTTP, [], 'Every production HTTP request must receive a measured fixture response.')
  const websocketPayloadBytes = Object.values(traffic.websocket).reduce((sum, value) => sum + value.payloadBytes, 0)
  const httpResponsePayloadBytes = Object.values(traffic.http).reduce((sum, value) => sum + value.payloadBytes, 0)
  const report = {
    schemaVersion: 1,
    mode: benchmarkMode,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: values.diagnostic === true,
    app: { path: app.selected, entry: app.entry, build: target, checkout },
    runtime: { ...runtime, testPresentation: runtime.testPresentation, presentation,
      network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1' },
    fixture: { asOf: fixture.asOf, candidateCount, passingCount, spreadFailureCount, oiFailureCount: fixture.oiFailureCount, seed: fixture.seed,
      candidateIDs: fixture.instIds,
      dataFingerprint: `market-traffic-v3-app-receipts-${candidateCount}-${passingCount}-${spreadFailureCount}-seed-${fixture.seed}`,
      qualification: { total: finalSnapshot.catalogProgress.total, completed: finalSnapshot.catalogProgress.completed,
        pending: finalSnapshot.catalogProgress.pending, verified: finalSnapshot.catalogProgress.verified,
        failed: finalSnapshot.catalogProgress.failed, unknown: finalSnapshot.catalogProgress.unknown },
      requiredChannels, cadenceMS, durationSeconds, sampleStartedAt, expectOptimized, readiness, searchScenario,
      readinessPhase: readiness ? 'all-passing-15m-frames-ready-before-steady-state-sample' : null },
    traffic: { durationSeconds: traffic.durationSeconds,
      measurement: 'Application payload bytes: WebSocket text before framing and HTTP response bodies. HTTP requests, headers, WebSocket framing, and TCP/TLS overhead are not measured.',
      websocketPayloadBytes, httpResponsePayloadBytes,
      totalPayloadBytes: websocketPayloadBytes + httpResponsePayloadBytes,
      websocketPayloadBytesByChannel: traffic.websocket, httpResponsePayloadBytesByChannel: traffic.http,
      subscriptionAcknowledgementBytesByChannel: traffic.acknowledgements,
      subscriptionCounts: fixture.currentAcknowledgements, receiptEvidence,
      configuredDemand: appReceipts.marketDemand,
      fixtureRequests: fixture.requests.length,
      fixtureRequestDetails: fixtureRequestEvidence(fixture.requests) },
    renderer: { ...renderer, measurement: searchMeasurement },
    mainProcess,
    correctness: { finalRealtimeState: finalSnapshot.realtimeState, connectedWebSocketClients: fixture.readyState.clients,
      allCandidatesHaveContinuousTickerOpenInterestAnd5mReceipts: true,
      passingIDs: (finalSnapshot.rows ?? []).map(row => row.instId).sort(),
      failures: finalSnapshot.catalogProgress.failed, unknown: finalSnapshot.catalogProgress.unknown,
      outputMatchesLatestFixtureTickers: outputMatchesLatest, optimizedDemand },
    fixtureErrors: fixture.errors,
  }
  await mkdir(dirname(output), { recursive: true })
  completedReport = report
  if (expectOptimized && !stopDiagnostics) validateMarketTrafficReport(report, 'current')
  if (baselineReport) {
    try {
      const comparison = compareMarketTrafficReports(baselineReport, report)
      report.comparison = { baselineReport: baselineReportPath, outcome: 'passed', result: comparison }
    } catch (error) {
      report.outcome = 'failed'
      report.failure = error.message
      report.comparison = { baselineReport: baselineReportPath, outcome: 'failed', failure: error.message }
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
      throw error
    }
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ report: output, diagnosticOnly: values.diagnostic === true, candidates: candidateCount, qualified: passingCount,
    completeRounds: receiptEvidence.fixtureRounds.length, matchedPayloads: receiptEvidence.fixtureEvents.length,
    maximumSendToCallbackAcceptanceMS: receiptEvidence.aggregateLatenciesUS.fixtureSendToCallbackAcceptance.maximumUS / 1_000,
    totalPayloadBytes: report.traffic.totalPayloadBytes }, null, 2))
} catch (error) {
  if (failureMeasurements && error?.marketTrafficEvidence) failureMeasurements.rawCausalEvidence = error.marketTrafficEvidence
  const requestCounts = Object.fromEntries([...new Set(fixture.requests.map(request => request.path))].map(path => [path,
    fixture.requests.filter(request => request.path === path).length]))
  const channels = Object.fromEntries(Object.entries(fixture.currentAcknowledgements).map(([channel, ids]) => [channel, ids.length]))
  const deliveryCounts = Object.fromEntries(Object.entries(fixture.deliverySummary().byChannel).map(([channel, value]) => [channel, value.instrumentCount]))
  const diagnostics = { benchmarkFailure: error.message, fixtureErrors: fixture.errors, fixtureAsOf: fixture.asOf,
    fixtureRequests: requestCounts, fixtureReadyClients: fixture.readyState.clients,
    fixtureSubscriptions: channels, instrumentsWithFixtureDeliveries: deliveryCounts,
    fixtureRequestDetails: fixtureRequestEvidence(fixture.requests),
    ...(error.readinessEvidence ?? readinessFailureEvidence ? { chartReadiness: error.readinessEvidence ?? readinessFailureEvidence } : {}) }
  if (completedReport) {
    try {
      completedReport.outcome = 'failed'
      completedReport.failure ??= error.message
      completedReport.diagnostics = diagnostics
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(completedReport, null, 2)}\n`)
      diagnostics.partialFailureReport = output
    } catch (reportError) { diagnostics.partialFailureReportError = reportError.message }
  } else if (failureMeasurements) {
    try {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify({ ...failureMeasurements, outcome: 'failed', failure: error.message, diagnostics }, null, 2)}\n`)
      diagnostics.partialFailureReport = output
    } catch (reportError) { diagnostics.partialFailureReportError = reportError.message }
  } else {
    try {
      const partial = { schemaVersion: 1, mode: benchmarkMode, partial: true, outcome: 'failed', generatedAt: new Date().toISOString(),
        failure: error.message, diagnostics,
        app: { path: app.selected, entry: app.entry, build: target, checkout },
        runtime: runtimeEvidence ? { ...runtimeEvidence, presentation: presentationEvidence,
          network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1' } : null,
        fixture: { asOf: fixture.asOf, candidateCount, passingCount, spreadFailureCount, oiFailureCount: fixture.oiFailureCount, seed: fixture.seed,
          dataFingerprint: `market-traffic-v3-app-receipts-${candidateCount}-${passingCount}-${spreadFailureCount}-seed-${fixture.seed}`,
          cadenceMS, durationSeconds, expectOptimized, readiness: readinessFailureEvidence ?? null } }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(partial, null, 2)}\n`)
      diagnostics.partialFailureReport = output
    } catch (reportError) { diagnostics.partialFailureReportError = reportError.message }
  }
  console.error(JSON.stringify(diagnostics, null, 2))
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  cadence?.stop()
  if (mainLoopStarted) {
    try { await electron.evaluate(() => globalThis.__mainLoopWitness?.stop()) }
    catch (error) { console.error(error); process.exitCode = 1 }
  }
  try { await stopDiagnostics?.() } catch (error) { console.error(error); process.exitCode = 1 }
  if (electron) await electron.close()
  if (fixture) await fixture.close()
}
