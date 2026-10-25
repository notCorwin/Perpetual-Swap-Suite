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

const root = fileURLToPath(new URL('../', import.meta.url))
const baselineRevision = 'ab9cb551bd00252abf370a324fe17d1eeacd6db1'
const { values } = parseArgs({
  options: {
    'app-root': { type: 'string' }, output: { type: 'string' },
    'candidate-count': { type: 'string' }, 'passing-count': { type: 'string' },
    'spread-failure-count': { type: 'string' }, 'duration-seconds': { type: 'string' }, 'cadence-ms': { type: 'string' },
    'expect-optimized': { type: 'boolean' }, foreground: { type: 'boolean' },
  },
  allowPositionals: false,
})

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
const benchmarkMode = foreground
  ? 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness'
  : 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness'
if (candidateCount < 3 || candidateCount > 100) throw new Error('--candidate-count must be between 3 and 100.')
if (durationSeconds < 5 || durationSeconds > 10) throw new Error('--duration-seconds must be between 5 and 10.')
if (cadenceMS < 100 || cadenceMS > 2_000) throw new Error('--cadence-ms must be between 100 and 2000.')
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

function checkoutMetadata() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
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
  if (foreground) return { presentation: 'native-foreground-window', sourceFingerprint: null, executable: runtime.executable,
    electronVersion: runtime.electronVersion, packaged: runtime.packaged, appPath: runtime.appPath }
  const guard = JSON.parse(await readFile(process.env.PERPETUAL_SWAP_TEST_GUARD, 'utf8'))
  if (runtime.executable !== guard.executable) throw new Error(`App did not use the protected test Electron runtime: ${runtime.executable}`)
  return { presentation: guard.presentation, sourceFingerprint: guard.sourceFingerprint, executable: runtime.executable,
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

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const app = await appEntryFor(values['app-root'] ?? root)
const checkout = checkoutMetadata(), target = await targetMetadata(app, checkout)
if (app.selected === '/Applications/Perpetual Swap Suite.app'
  && (target.revision !== baselineRevision || target.dirty !== false)) {
  throw new Error(`Installed traffic baseline must be the clean ${baselineRevision} app; found ${target.revision} (dirty=${target.dirty}).`)
}
const output = resolve(values.output ?? join(root, '.build/traffic-optimization/market-traffic.json'))
const userData = process.env.PERPETUAL_SWAP_USER_DATA
if (!userData || (!foreground && !process.env.PERPETUAL_SWAP_TEST_GUARD)) throw new Error('Protected sandbox user data is required.')
const fixture = await createMarketTrafficExchange({ candidateCount, passingCount, spreadFailureCount, seed: 17 })
let electron, cadence, failureMeasurements
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
  if (expectOptimized) {
    const demandDeadline = Date.now() + 30_000
    const validDemand = () => {
      acknowledgements = fixture.currentAcknowledgements
      const bookIDs = acknowledgements.books ?? [], tradeIDs = acknowledgements.trades ?? []
      return bookIDs.length <= passingCount && tradeIDs.length <= passingCount
        && bookIDs.every(instId => qualifyingIDs.has(instId)) && tradeIDs.every(instId => qualifyingIDs.has(instId))
        && (acknowledgements.candle15m ?? []).length === 0 && (acknowledgements.candle1H ?? []).length === 0
    }
    while (!validDemand() && Date.now() < demandDeadline) await sleep(50)
    assert.equal(validDemand(), true, 'Optimized subscription demand must limit books/trades to verified contracts and remove remote 15m/1H channels.')
    optimizedDemand.checked = true
    optimizedDemand.bookIDs = [...(acknowledgements.books ?? [])].sort()
    optimizedDemand.tradeIDs = [...(acknowledgements.trades ?? [])].sort()
    optimizedDemand.candle15mCount = (acknowledgements.candle15m ?? []).length
    optimizedDemand.candle1HCount = (acknowledgements.candle1H ?? []).length
  }
  assert.deepEqual(fixture.errors, [], 'The fixture observed an invalid or unexpected production request.')

  cadence = fixture.startCadence(cadenceMS)
  await sleep(cadenceMS)
  // The sample clock starts after qualification, connection setup and the
  // initial cadence message. Only steady-state fixture traffic is measured.
  if (foreground) await assertForeground(electron, page)
  const sampleStartedAt = fixture.beginSample()
  await page.evaluate(requireForeground => {
    const state = { gaps: [], interactions: [], lastFrame: null, startedAt: performance.now(), active: true,
      presentation: { requiredForeground: requireForeground, samples: 0, totalViolations: 0, violations: [] } }
    const checkPresentation = () => {
      if (!state.active) return
      state.presentation.samples++
      if (requireForeground && (document.visibilityState !== 'visible' || !document.hasFocus())) {
        state.presentation.totalViolations++
        if (state.presentation.violations.length < 10) state.presentation.violations.push({
          at: performance.now(), visibility: document.visibilityState, focused: document.hasFocus() })
      }
    }
    document.addEventListener('visibilitychange', checkPresentation)
    window.addEventListener('blur', checkPresentation)
    const frame = now => {
      if (!state.active) return
      checkPresentation()
      if (state.lastFrame !== null) state.gaps.push(now - state.lastFrame)
      state.lastFrame = now
      requestAnimationFrame(frame)
    }
    document.addEventListener('input', event => {
      if (event.target?.getAttribute?.('aria-label') !== 'Search contracts') return
      checkPresentation()
      const started = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => state.interactions.push(performance.now() - started)))
    }, true)
    globalThis.__marketTrafficResponsiveness = state
    checkPresentation()
    requestAnimationFrame(frame)
  }, foreground)
  const search = page.locator('input[aria-label="Search contracts"]')
  const searches = fixture.instIds.slice(0, passingCount).map(instId => instId.slice(0, 4))
  const interactionTask = (async () => {
    for (const term of [...searches, '']) {
      await search.fill(term)
      await sleep(30)
    }
  })()
  await Promise.all([interactionTask, sleep(durationSeconds * 1_000)])
  cadence.stop()
  await sleep(50)
  const renderer = await page.evaluate(() => {
    const state = globalThis.__marketTrafficResponsiveness
    state.active = false
    const percentile = (values, fraction) => {
      const sorted = [...values].sort((left, right) => left - right)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
    }
    return { elapsedMS: performance.now() - state.startedAt, frameCount: state.gaps.length, presentation: state.presentation,
      frameGapMS: { p50: percentile(state.gaps, .5), p95: percentile(state.gaps, .95), max: Math.max(0, ...state.gaps) },
      searchInteractionMS: { count: state.interactions.length, p50: percentile(state.interactions, .5),
        p95: percentile(state.interactions, .95), max: Math.max(0, ...state.interactions) } }
  })
  failureMeasurements = {
    schemaVersion: 1,
    mode: benchmarkMode,
    partial: true,
    generatedAt: new Date().toISOString(),
    app: { path: app.selected, entry: app.entry, build: target, checkout },
    runtime: { ...runtime, testPresentation: foreground ? 'foreground-native' : runtime.presentation, presentation,
      network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1' },
    fixture: { candidateCount, passingCount, spreadFailureCount, oiFailureCount: fixture.oiFailureCount, seed: fixture.seed,
      dataFingerprint: `market-traffic-v2-bookseq-${candidateCount}-${passingCount}-${spreadFailureCount}-seed-${fixture.seed}`,
      cadenceMS, durationSeconds, sampleStartedAt, expectOptimized },
    renderer: { ...renderer, measurement: foreground
      ? 'Native foreground renderer RAF gaps and React search input to next-frame latency; native compositor paint was not measured.'
      : 'Hidden offscreen renderer RAF gaps and React search input to next-frame latency; no native compositor paint claim.' },
  }
  const traffic = fixture.endSample()
  if (foreground) assert.equal(renderer.presentation.totalViolations, 0, 'Foreground visibility and focus must hold throughout sampling.')
  assert.ok(Math.abs(traffic.durationSeconds - durationSeconds) <= 0.75,
    `Steady-state traffic sample duration drifted outside the bounded window: ${traffic.durationSeconds}s.`)
  const delivery = fixture.deliverySummary(), finalValues = fixture.latestValues
  let finalSnapshot, outputMatchesLatest = false
  const outputDeadline = Date.now() + 1_000
  while (Date.now() < outputDeadline) {
    finalSnapshot = await page.evaluate(() => window.radarDesktop.request({ snapshot: {} }))
    outputMatchesLatest = (finalSnapshot.rows ?? []).length === passingCount && finalSnapshot.rows.every(row => {
      const expected = Number(finalValues[`tickers:${row.instId}`]?.last)
      return Number.isFinite(expected) && Math.abs(row.lastPrice - expected) < 1e-8
    })
    if (outputMatchesLatest) break
    await sleep(25)
  }
  const freshLimitMS = Math.max(1_500, cadenceMS * 3)
  const freshness = Object.fromEntries(requiredChannels.map(channel => [channel, fixture.instIds.map(instId => {
    const key = `${channel}:${instId}`, record = delivery.byChannel[channel]?.entries.find(value => value.instId === instId)
    const sampleMessages = traffic.deliveries[channel]?.[instId] ?? 0
    return { instId, sampleMessages, lastSentAt: record?.lastSentAt ?? null,
      ageMS: record?.lastSentAt == null ? null : Date.now() - record.lastSentAt,
      latestFixtureValue: finalValues[key] ?? null }
  })]))
  for (const channel of requiredChannels) {
    const channelMessages = traffic.websocket[channel]?.messages ?? 0
    assert.ok(channelMessages >= Math.floor(durationSeconds * 1_000 / cadenceMS * candidateCount * 0.75),
      `The ${channel} channel did not deliver a bounded steady-state stream.`)
    const unseen = freshness[channel].filter(value => value.sampleMessages < Math.floor(durationSeconds * 1_000 / cadenceMS * 0.75)
      || value.ageMS === null || value.ageMS > freshLimitMS)
    assert.deepEqual(unseen, [], `Every candidate's ${channel} observation must stay fresh for the complete steady-state sample.`)
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
  assert.ok(renderer.searchInteractionMS.count >= passingCount, 'Renderer did not process all search interactions.')
  if (expectOptimized) {
    assert.ok(renderer.frameGapMS.p95 <= 50, `Optimized renderer frame-gap p95 exceeded 50ms: ${renderer.frameGapMS.p95}`)
    assert.ok(renderer.searchInteractionMS.p95 <= 50, `Optimized renderer search-response p95 exceeded 50ms: ${renderer.searchInteractionMS.p95}`)
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
    app: { path: app.selected, entry: app.entry, build: target, checkout },
    runtime: { ...runtime, testPresentation: runtime.presentation, presentation,
      network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1' },
    fixture: { candidateCount, passingCount, spreadFailureCount, oiFailureCount: fixture.oiFailureCount, seed: fixture.seed,
      dataFingerprint: `market-traffic-v2-bookseq-${candidateCount}-${passingCount}-${spreadFailureCount}-seed-${fixture.seed}`,
      qualification: { total: finalSnapshot.catalogProgress.total, completed: finalSnapshot.catalogProgress.completed,
        pending: finalSnapshot.catalogProgress.pending, verified: finalSnapshot.catalogProgress.verified,
        failed: finalSnapshot.catalogProgress.failed, unknown: finalSnapshot.catalogProgress.unknown },
      requiredChannels, cadenceMS, durationSeconds, sampleStartedAt, expectOptimized },
    traffic: { durationSeconds: traffic.durationSeconds, websocketPayloadBytes, httpResponsePayloadBytes,
      totalPayloadBytes: websocketPayloadBytes + httpResponsePayloadBytes,
      websocketPayloadBytesByChannel: traffic.websocket, httpResponsePayloadBytesByChannel: traffic.http,
      subscriptionAcknowledgementBytesByChannel: traffic.acknowledgements,
      subscriptionCounts: fixture.currentAcknowledgements,
      freshness, fixtureRequests: fixture.requests.length, fixtureRequestBytes: fixture.requests.reduce((sum, value) => sum + (value.requestPayloadBytes ?? 0), 0) },
    renderer: { ...renderer, measurement: foreground
      ? 'Native foreground renderer RAF gaps and React search input to next-frame latency; native compositor paint was not measured.'
      : 'Hidden offscreen renderer RAF gaps and React search input to next-frame latency; no native compositor paint claim.' },
    correctness: { finalRealtimeState: finalSnapshot.realtimeState, connectedWebSocketClients: fixture.readyState.clients,
      allCandidatesHaveFreshTickerOpenInterestAnd5m: true,
      passingIDs: (finalSnapshot.rows ?? []).map(row => row.instId).sort(),
      failures: finalSnapshot.catalogProgress.failed, unknown: finalSnapshot.catalogProgress.unknown,
      outputMatchesLatestFixtureTickers: outputMatchesLatest, optimizedDemand },
    fixtureErrors: fixture.errors,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ report: output, ...report }, null, 2))
} catch (error) {
  const requestCounts = Object.fromEntries([...new Set(fixture.requests.map(request => request.path))].map(path => [path,
    fixture.requests.filter(request => request.path === path).length]))
  const channels = Object.fromEntries(Object.entries(fixture.currentAcknowledgements).map(([channel, ids]) => [channel, ids.length]))
  const deliveryCounts = Object.fromEntries(Object.entries(fixture.deliverySummary().byChannel).map(([channel, value]) => [channel, value.instrumentCount]))
  const diagnostics = { benchmarkFailure: error.message, fixtureErrors: fixture.errors,
    fixtureRequests: requestCounts, fixtureReadyClients: fixture.readyState.clients,
    fixtureSubscriptions: channels, instrumentsWithFixtureDeliveries: deliveryCounts }
  if (failureMeasurements) {
    try {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify({ ...failureMeasurements, outcome: 'failed', failure: error.message, diagnostics }, null, 2)}\n`)
      diagnostics.partialFailureReport = output
    } catch (reportError) { diagnostics.partialFailureReportError = reportError.message }
  }
  console.error(JSON.stringify(diagnostics, null, 2))
  throw error
} finally {
  cadence?.stop()
  if (electron) await electron.close()
  if (fixture) await fixture.close()
}
