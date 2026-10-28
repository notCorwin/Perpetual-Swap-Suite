#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { validateMarketTrafficEvidence } from '../tests/helpers/market-traffic-evidence.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const hiddenMode = 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness'
const foregroundMode = 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness'

function sumBytes(channels) {
  return Object.values(channels ?? {}).reduce((total, value) => total + value.payloadBytes, 0)
}

const summaryTolerance = 1e-6
const nearestRank = (values, fraction) => [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * fraction) - 1)]

function assertSummaryMatchesSamples(summary, samples, label) {
  assert.ok(Array.isArray(samples) && samples.length > 0, `${label} has no raw samples.`)
  assert.ok(Number.isSafeInteger(summary.sampleCount) && summary.sampleCount === samples.length,
    `${label} sample count does not match its raw samples.`)
  assert.ok(samples.every(value => Number.isFinite(value) && value >= 0), `${label} raw samples must be finite nonnegative values.`)
  const expected = { p50: nearestRank(samples, .5), p95: nearestRank(samples, .95), max: Math.max(...samples) }
  for (const [metric, value] of Object.entries(expected)) {
    assert.ok(Number.isFinite(summary[metric]) && summary[metric] >= 0, `${label} ${metric} must be a finite measurement.`)
    assert.ok(Math.abs(summary[metric] - value) <= summaryTolerance,
      `${label} ${metric} does not match its raw samples: summary=${summary[metric]}, measured=${value}.`)
  }
}

function validateComparisonBuildProvenance(report, label) {
  const build = report.app?.build
  assert.match(build?.revision ?? '', /^(?:[a-f\d]{40}|[a-f\d]{64})$/i, `${label} app build must identify a full Git revision.`)
  assert.equal(build.dirty, false, `${label} app build must have clean provenance.`)
  if (build.provenance === 'working-tree checkout') {
    assert.equal(report.app?.checkout?.dirty, false, `${label} selected checkout must have clean provenance.`)
    assert.equal(report.app?.checkout?.revision, build.revision, `${label} app build must match its selected checkout revision.`)
  } else assert.ok(typeof build.path === 'string' && build.path.length > 0,
    `${label} app build provenance must identify a checkout or packaged build metadata file.`)
}

export function validateMarketTrafficReport(report, label, { baseline = false } = {}) {
  assert.notEqual(report?.diagnosticOnly, true, `${label} diagnostic profiling cannot satisfy traffic acceptance or serve as a comparison baseline.`)
  const foreground = report.mode === foregroundMode
  assert.ok(foreground || report.mode === hiddenMode, `${label} is not the deterministic loopback market benchmark.`)
  assert.equal(report.runtime?.network, 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1', `${label} must be loopback-only.`)
  if (foreground) {
    assert.deepEqual(report.runtime?.presentation, { visible: true, focused: true, minimized: false, offscreen: false }, `${label} must remain visible, focused and native.`)
    assert.equal(report.runtime?.testPresentation, 'foreground-native', `${label} must use the native foreground presentation.`)
    assert.deepEqual(report.runtime?.foregroundCIProof, { githubActions: true, runnerEnvironment: 'github-hosted', runnerOS: 'macOS' },
      `${label} is missing the hosted macOS foreground proof from requireForegroundTests.`)
    assert.ok(report.runtime?.executable && report.runtime?.electronVersion, `${label} is missing the actual Electron runtime identity.`)
  } else {
    assert.deepEqual(report.runtime?.presentation, { visible: false, focused: false, minimized: false, offscreen: true }, `${label} must remain hidden and unfocused.`)
    assert.equal(report.runtime?.testPresentation, 'background-only-offscreen', `${label} must use the protected background-only Electron bundle.`)
    assert.ok(report.runtime?.sourceFingerprint && report.runtime?.electronVersion, `${label} is missing protected Electron runtime identity.`)
  }
  assert.ok(report.fixture?.candidateCount >= 3 && report.fixture.candidateCount <= 100, `${label} has an invalid candidate count.`)
  assert.ok(report.fixture?.durationSeconds >= 5 && report.fixture.durationSeconds <= 10, `${label} has an invalid fixed sample duration.`)
  assert.ok(Number.isFinite(report.traffic?.durationSeconds)
    && Math.abs(report.traffic.durationSeconds - report.fixture.durationSeconds) <= .75, `${label} traffic window drifted from its fixed duration.`)
  assert.ok(report.fixture?.cadenceMS >= 100 && report.fixture.cadenceMS <= 2_000, `${label} has an invalid deterministic message cadence.`)
  assert.equal(report.fixture?.qualification?.total, report.fixture.candidateCount, `${label} did not settle the complete candidate universe.`)
  assert.equal(report.fixture.qualification.completed, report.fixture.candidateCount, `${label} left candidates unprocessed.`)
  assert.equal(report.fixture.qualification.pending, 0, `${label} still has qualification work pending.`)
  assert.ok(report.fixture.passingCount > 0 && report.fixture.passingCount < report.fixture.candidateCount, `${label} lacks both passing and failing candidates.`)
  assert.equal(report.fixture.dataFingerprint,
    `market-traffic-v3-app-receipts-${report.fixture.candidateCount}-${report.fixture.passingCount}-${report.fixture.spreadFailureCount}-seed-${report.fixture.seed}`,
    `${label} must use the accepted-receipt market fixture protocol version.`)
  assert.equal(report.fixture.qualification.verified, report.fixture.passingCount, `${label} qualified the wrong number of candidates.`)
  assert.equal(report.fixture.qualification.failed, report.fixture.candidateCount - report.fixture.passingCount, `${label} failed the wrong number of candidates.`)
  assert.equal(report.fixture.qualification.unknown, 0, `${label} contains unresolved candidates.`)
  assert.equal(report.correctness?.allCandidatesHaveContinuousTickerOpenInterestAnd5mReceipts, true, `${label} did not retain all required live channels.`)
  assert.equal(report.correctness?.outputMatchesLatestFixtureTickers, true, `${label} renderer output did not match the fixture.`)
  assert.ok(['live', 'connecting'].includes(report.correctness?.finalRealtimeState), `${label} disconnected or was recovering during measurement.`)
  assert.ok(report.correctness?.connectedWebSocketClients >= 3, `${label} has no connected native WebSocket transports.`)
  assert.equal(report.fixtureErrors?.length ?? 0, 0, `${label} recorded fixture protocol errors.`)
  const expectedIDs = report.correctness.passingIDs
  assert.equal(expectedIDs.length, report.fixture.passingCount, `${label} is missing qualified instrument IDs.`)
  assert.deepEqual([...expectedIDs].sort(), expectedIDs, `${label} candidate output IDs must be sorted.`)
  const required = ['tickers', 'open-interest', 'candle5m']
  assert.deepEqual(report.fixture.requiredChannels, required, `${label} must exercise all required live channels.`)
  assert.deepEqual(report.fixture.candidateIDs?.length, report.fixture.candidateCount, `${label} must identify the complete fixture candidate set.`)
  assert.equal(new Set(report.fixture.candidateIDs).size, report.fixture.candidateCount, `${label} fixture candidate IDs are duplicated.`)
  assert.deepEqual([...report.fixture.candidateIDs].sort(), report.fixture.candidateIDs, `${label} fixture candidate IDs must be sorted.`)
  const receiptEvidence = report.traffic.receiptEvidence
  validateMarketTrafficEvidence(receiptEvidence)
  assert.equal(receiptEvidence.sampleStartedAt, report.fixture.sampleStartedAt, `${label} receipt timestamps must use the fixture sample start.`)
  assert.ok(Math.abs(receiptEvidence.durationMS / 1_000 - report.fixture.durationSeconds) <= .75, `${label} receipt window drifted from the measured traffic duration.`)
  assert.deepEqual(report.traffic.configuredDemand?.candidateIDs, report.fixture.candidateIDs,
    `${label} subscription demand must be derived from the complete candidate universe.`)
  assert.deepEqual(report.traffic.configuredDemand?.eligibleIDs, report.correctness.passingIDs,
    `${label} subscription demand must use the app's eligible market list.`)
  const expectedSubscriptions = receiptEvidence.expectedSubscriptions
  for (const channel of ['tickers', 'open-interest', 'candle5m']) {
    assert.deepEqual(expectedSubscriptions[channel], report.fixture.candidateIDs, `${label} is missing ${channel} candidate demand.`)
  }
  const focused = report.traffic.configuredDemand.focusedInstrumentID
  assert.deepEqual(expectedSubscriptions.trades,
    [...new Set([...report.traffic.configuredDemand.eligibleIDs, focused].filter(Boolean))].sort(),
    `${label} trades must cover configured eligible and focused demand.`)
  if (report.traffic.configuredDemand.booksEnabled) {
    assert.ok(expectedSubscriptions.books.length > 0, `${label} configured books demand cannot be empty.`)
    for (const instId of report.traffic.configuredDemand.eligibleIDs) assert.ok(expectedSubscriptions.books.includes(instId),
      `${label} configured books demand is missing eligible ${instId}.`)
  } else assert.deepEqual(expectedSubscriptions.books, [], `${label} requested books while depth and slippage filters are disabled.`)
  const expectedChannelSet = new Set(Object.keys(expectedSubscriptions))
  const acknowledgedChannels = Object.keys(report.traffic.subscriptionCounts ?? {}).filter(channel => channel !== 'instruments')
  assert.ok(acknowledgedChannels.every(channel => expectedChannelSet.has(channel)), `${label} acknowledged an unconfigured channel.`)
  for (const channel of Object.keys(expectedSubscriptions)) {
    const expected = expectedSubscriptions[channel], acknowledged = report.traffic.subscriptionCounts?.[channel] ?? []
    assert.deepEqual(acknowledged, expected, `${label} ${channel} acknowledgements do not match configured demand.`)
  }
  for (const channel of required) assert.ok((report.traffic.websocketPayloadBytesByChannel?.[channel]?.messages ?? 0) > 0,
    `${label} has no measured ${channel} payload.`)
  if (report.fixture.expectOptimized) {
    for (const channel of ['candle15m', 'candle1H']) {
      assert.deepEqual(expectedSubscriptions[channel] ?? [], [], `${label} has a remote ${channel} subscription.`)
      assert.equal(report.traffic.websocketPayloadBytesByChannel?.[channel]?.messages ?? 0, 0, `${label} measured remote ${channel} payloads.`)
    }
  }
  const websocketBytes = sumBytes(report.traffic?.websocketPayloadBytesByChannel)
  const httpBytes = sumBytes(report.traffic?.httpResponsePayloadBytesByChannel)
  assert.equal(report.traffic?.websocketPayloadBytes, websocketBytes, `${label} WebSocket payload total is inconsistent.`)
  assert.equal(report.traffic?.httpResponsePayloadBytes, httpBytes, `${label} HTTP payload total is inconsistent.`)
  assert.equal(report.traffic?.totalPayloadBytes, websocketBytes + httpBytes, `${label} total fixture payload bytes are inconsistent.`)
  assert.ok(report.traffic.totalPayloadBytes > 0, `${label} is a no-op traffic run.`)
  assert.ok(report.renderer?.frameCount >= report.fixture.durationSeconds * 15, `${label} has insufficient renderer frame samples.`)
  assert.equal(report.renderer?.rafOpportunityGapMS?.sampleCount, report.renderer?.frameCount, `${label} RAF opportunity sample count is inconsistent.`)
  assert.equal(report.renderer?.rafOpportunityGapMS?.samples?.length, report.renderer?.rafOpportunityGapMS?.sampleCount, `${label} RAF opportunity timestamps are incomplete.`)
  assert.ok(report.renderer?.searchInputToSecondRAFMS?.sampleCount >= report.fixture.passingCount, `${label} has insufficient renderer interaction samples.`)
  assert.equal(report.renderer?.searchInputToSecondRAFMS?.samples?.length, report.renderer?.searchInputToSecondRAFMS?.sampleCount, `${label} input-to-RAF samples are incomplete.`)
  assertSummaryMatchesSamples(report.renderer.rafOpportunityGapMS,
    report.renderer.rafOpportunityGapMS.samples, `${label} RAF opportunity gap`)
  const interactionSamples = report.renderer.searchInputToSecondRAFMS.samples
  const interactionDurations = interactionSamples.map((sample, index) => {
    assert.ok(Number.isFinite(sample?.startedMS) && sample.startedMS >= 0, `${label} search sample ${index} has an invalid start time.`)
    assert.ok(Number.isFinite(sample?.completedMS) && Number.isFinite(sample?.durationMS) && sample.durationMS >= 0,
      `${label} search sample ${index} has an invalid or missing duration.`)
    assert.ok(Math.abs(sample.completedMS - sample.startedMS - sample.durationMS) <= summaryTolerance,
      `${label} search sample ${index} duration does not match its raw timestamps.`)
    return sample.durationMS
  })
  assertSummaryMatchesSamples(report.renderer.searchInputToSecondRAFMS, interactionDurations,
    `${label} input-to-second-RAF`)
  for (const [name, value] of Object.entries({ rafOpportunityGapP95: report.renderer.rafOpportunityGapMS?.p95,
    rafOpportunityGapMax: report.renderer.rafOpportunityGapMS?.max,
    inputToSecondRAFP95: report.renderer.searchInputToSecondRAFMS?.p95,
    inputToSecondRAFMax: report.renderer.searchInputToSecondRAFMS?.max })) {
    assert.ok(Number.isFinite(value) && value >= 0, `${label} has no valid ${name} measurement.`)
  }
  assert.match(report.renderer?.measurement ?? '', /RAF callback opportunity gaps/,
    `${label} must label renderer timing as RAF opportunity measurements.`)
  assert.match(report.renderer.measurement, /do not measure SVG commit or native compositor paint/,
    `${label} must state that renderer timing is not SVG commit or native paint.`)
  assert.match(report.renderer.searchInputToSecondRAFMS.p95Interpretation ?? '', /descriptive at this sample count/,
    `${label} must identify the small-sample empirical search p95 as descriptive.`)
  if (report.fixture.expectOptimized) {
    assert.ok(report.renderer.rafOpportunityGapMS.p95 <= 50, `${label} optimized renderer RAF opportunity gap p95 exceeded 50ms.`)
    assert.ok(report.renderer.searchInputToSecondRAFMS.p95 <= 50, `${label} optimized input-to-second-RAF p95 exceeded 50ms.`)
    assert.ok(report.renderer.rafOpportunityGapMS.max < 100, `${label} optimized renderer had a RAF stall of at least 100ms.`)
    assert.ok(report.renderer.searchInputToSecondRAFMS.max < 100, `${label} optimized renderer had a search stall of at least 100ms.`)
  }
  if (baseline) {
    assert.ok(report.app?.build?.revision, `${label} baseline app identity is missing.`)
    assert.equal(report.app?.build?.dirty, false, `${label} baseline app must be clean.`)
  } else {
    assert.equal(report.app?.build?.provenance, 'working-tree checkout', `${label} must measure the selected working tree.`)
    if (foreground) {
      assert.equal(report.app?.build?.dirty, false, `${label} foreground comparison checkout must be clean.`)
      assert.equal(report.app?.checkout?.dirty, false, `${label} selected checkout must be clean.`)
      assert.equal(report.app?.build?.revision, report.app?.checkout?.revision, `${label} app provenance must describe the selected checkout.`)
    }
  }
  if (foreground) {
    assert.equal(report.fixture?.searchScenario?.version, 'distributed-input-v1', `${label} must use distributed search sampling.`)
    const schedule = report.fixture.searchScenario, interactions = report.renderer.searchInputToSecondRAFMS
    assert.ok(schedule.eventCount >= 21 && schedule.windowMS === report.fixture.durationSeconds * 1_000
      && schedule.lastInputAtMS === schedule.windowMS - 100, `${label} has an invalid fixed search schedule.`)
    assert.equal(interactions.sampleCount, schedule.eventCount, `${label} did not complete every declared search event.`)
    assert.equal(interactions.samples?.length, schedule.eventCount, `${label} lacks per-input search evidence.`)
    assert.ok(interactions.samples.every(sample => sample.correct && sample.actualResultCount === sample.expectedResultCount),
      `${label} did not verify the filtered results for every timed search.`)
    assert.ok(interactions.samples.at(-1).startedMS - interactions.samples[0].startedMS >= schedule.windowMS * .8,
      `${label} search inputs must span the steady-state sample, rather than an initial burst.`)
    assert.equal(report.fixture?.readinessPhase, 'all-passing-15m-frames-ready-before-steady-state-sample',
      `${label} must sample only after the selected chart readiness barrier.`)
    assert.equal(report.fixture?.readiness?.timeframe, '15m', `${label} must use the same selected 15m readiness phase.`)
    assert.equal(report.fixture?.readiness?.expectedFrames, report.fixture.passingCount, `${label} readiness must cover each passing contract.`)
    assert.equal(report.fixture?.readiness?.readyFrames, report.fixture.passingCount, `${label} must have every passing chart ready.`)
    assert.ok(Number.isFinite(report.fixture.readiness.elapsedMS), `${label} is missing the readiness barrier measurement.`)
    assert.equal(report.fixture.readiness.measurement,
      'Bounded chart startup readiness warmup; elapsedMS is excluded from steady-state performance results.',
      `${label} must identify readiness elapsed time as startup warmup rather than a performance result.`)
  }
}

const closeToNoRegression = (before, after, absolute, relative) => ({ before, after,
  allowedIncrease: Number(Math.max(absolute, before * relative).toFixed(3)),
  passed: after <= before + Math.max(absolute, before * relative) })

export function compareMarketTrafficReports(before, after) {
  validateMarketTrafficReport(before, 'before', { baseline: true })
  validateMarketTrafficReport(after, 'after')
  validateComparisonBuildProvenance(before, 'Before')
  validateComparisonBuildProvenance(after, 'After')
  assert.notEqual(after.app.build.revision, before.app.build.revision,
    'Before/after comparison requires distinct clean app build revisions.')
  assert.equal(after.mode, before.mode, 'Before/after reports must use the same presentation mode.')
  const foreground = before.mode === foregroundMode
  assert.equal(before.fixture.expectOptimized, false, 'Before report must measure the installed baseline without optimized-only assertions.')
  assert.equal(after.fixture.expectOptimized, true, 'After report must enable --expect-optimized assertions.')
  for (const key of ['candidateCount', 'passingCount', 'spreadFailureCount', 'oiFailureCount', 'seed', 'dataFingerprint', 'cadenceMS', 'durationSeconds']) {
    assert.equal(after.fixture[key], before.fixture[key], `Before/after fixture input ${key} must match exactly.`)
  }
  assert.deepEqual(after.fixture.candidateIDs, before.fixture.candidateIDs, 'Before/after fixture candidate IDs must match exactly.')
  assert.equal(after.runtime.electronVersion, before.runtime.electronVersion, 'Before/after must use the same Electron version.')
  if (foreground) {
    assert.deepEqual(after.fixture.searchScenario, before.fixture.searchScenario, 'Before/after must use the same search schedule.')
    assert.equal(after.runtime.executable, before.runtime.executable, 'Before/after must use the same actual Electron executable.')
    assert.equal(after.fixture.readinessPhase, before.fixture.readinessPhase, 'Before/after must cross the same chart readiness phase before sampling.')
    for (const key of ['timeframe', 'expectedFrames', 'readyFrames']) assert.equal(after.fixture.readiness[key], before.fixture.readiness[key],
      `Before/after chart readiness ${key} must match.`)
    assert.deepEqual(after.correctness.passingIDs, before.correctness.passingIDs, 'Before/after must qualify the same candidate output set.')
  } else {
    assert.equal(after.runtime.sourceFingerprint, before.runtime.sourceFingerprint, 'Before/after must use the same protected Electron bundle.')
  }
  const optimizationRemovableChannels = new Set(['candle15m', 'candle1H'])
  const measuredChannels = Object.keys(before.traffic.receiptEvidence.expectedSubscriptions)
    .filter(channel => !optimizationRemovableChannels.has(channel))
  assert.deepEqual(Object.keys(after.traffic.receiptEvidence.expectedSubscriptions).filter(channel => !optimizationRemovableChannels.has(channel)).sort(),
    measuredChannels.slice().sort(), 'Before/after must measure the same retained channel set.')
  for (const channel of measuredChannels) {
    const beforeIDs = before.traffic.receiptEvidence.expectedSubscriptions[channel]
    const afterIDs = after.traffic.receiptEvidence.expectedSubscriptions[channel]
    assert.deepEqual(afterIDs, beforeIDs, `Before/after must retain the same ${channel} instrument coverage.`)
    const beforeEntries = new Map(before.traffic.receiptEvidence.channels[channel].entries.map(value => [value.instId, value]))
    for (const entry of after.traffic.receiptEvidence.channels[channel].entries) {
      assert.equal(entry.fixtureSendCount, beforeEntries.get(entry.instId).fixtureSendCount,
        `Before/after ${channel}/${entry.instId} fixture send counts must match exactly.`)
    }
  }
  const beforeChannels = before.traffic.websocketPayloadBytesByChannel ?? {}, afterChannels = after.traffic.websocketPayloadBytesByChannel ?? {}
  const channelNames = [...new Set([...Object.keys(beforeChannels), ...Object.keys(afterChannels)])].sort()
  const websocket = Object.fromEntries(channelNames.map(channel => {
    const left = beforeChannels[channel]?.payloadBytes ?? 0, right = afterChannels[channel]?.payloadBytes ?? 0
    return [channel, { beforePayloadBytes: left, afterPayloadBytes: right, savedPayloadBytes: left - right,
      beforePayloadBytesPerSecond: Number((left / before.traffic.durationSeconds).toFixed(2)),
      afterPayloadBytesPerSecond: Number((right / after.traffic.durationSeconds).toFixed(2)),
      savedPercent: left ? Number(((left / before.traffic.durationSeconds - right / after.traffic.durationSeconds)
        / (left / before.traffic.durationSeconds) * 100).toFixed(2)) : null }]
  }))
  const beforeTotal = before.traffic.totalPayloadBytes, afterTotal = after.traffic.totalPayloadBytes
  const beforeRate = beforeTotal / before.traffic.durationSeconds, afterRate = afterTotal / after.traffic.durationSeconds
  const beforeHTTP = before.traffic.httpResponsePayloadBytesByChannel ?? {}, afterHTTP = after.traffic.httpResponsePayloadBytesByChannel ?? {}
  const httpChannelNames = [...new Set([...Object.keys(beforeHTTP), ...Object.keys(afterHTTP)])].sort()
  const httpByChannel = Object.fromEntries(httpChannelNames.map(channel => {
    const left = beforeHTTP[channel]?.payloadBytes ?? 0, right = afterHTTP[channel]?.payloadBytes ?? 0
    return [channel, { beforePayloadBytes: left, afterPayloadBytes: right, savedPayloadBytes: left - right,
      beforePayloadBytesPerSecond: Number((left / before.traffic.durationSeconds).toFixed(2)),
      afterPayloadBytesPerSecond: Number((right / after.traffic.durationSeconds).toFixed(2)) }]
  }))
  const responsiveness = {
    rafOpportunityGapP95MS: closeToNoRegression(before.renderer.rafOpportunityGapMS.p95, after.renderer.rafOpportunityGapMS.p95, 2, .15),
    inputToSecondRAFP95MS: closeToNoRegression(before.renderer.searchInputToSecondRAFMS.p95, after.renderer.searchInputToSecondRAFMS.p95, 3, .2),
  }
  for (const [name, result] of Object.entries(responsiveness)) assert.equal(result.passed, true,
    `Renderer responsiveness regressed beyond the bounded noise allowance for ${name}: ${JSON.stringify(result)}`)
  if (!foreground) {
    assert.ok(after.renderer.rafOpportunityGapMS.p95 <= 50, 'After RAF opportunity gap p95 exceeded the 50ms responsiveness budget.')
    assert.ok(after.renderer.searchInputToSecondRAFMS.p95 <= 75, 'After input-to-second-RAF p95 exceeded the 75ms hidden renderer budget.')
  }
  assert.ok(afterRate < beforeRate,
    `Optimized total payload rate must decrease: before=${beforeRate.toFixed(2)} B/s, after=${afterRate.toFixed(2)} B/s.`)
  return {
    schemaVersion: 1,
    mode: foreground ? 'before-after-foreground-loopback-market-traffic-comparison' : 'before-after-loopback-market-traffic-comparison',
    generatedAt: new Date().toISOString(),
    fixture: before.fixture,
    traffic: { beforeTotalPayloadBytes: beforeTotal, afterTotalPayloadBytes: afterTotal,
      savedPayloadBytes: beforeTotal - afterTotal,
      beforePayloadBytesPerSecond: Number(beforeRate.toFixed(2)), afterPayloadBytesPerSecond: Number(afterRate.toFixed(2)),
      savedPercent: Number(((beforeRate - afterRate) / beforeRate * 100).toFixed(2)), websocketByChannel: websocket, httpByChannel,
      beforeHTTPResponsePayloadBytes: before.traffic.httpResponsePayloadBytes,
      afterHTTPResponsePayloadBytes: after.traffic.httpResponsePayloadBytes },
    responsiveness,
    correctness: { before: before.correctness, after: after.correctness },
    provenance: { beforeRevision: before.app.build.revision, afterRevision: after.app.build.revision,
      ...(foreground ? { electronExecutable: before.runtime.executable } : { protectedRuntimeFingerprint: before.runtime.sourceFingerprint }),
      presentation: foreground ? 'native-foreground-window' : 'background-only-offscreen' },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false })
  if (!values.before || !values.after) throw new Error('Provide --before and --after market traffic report paths.')
  const before = JSON.parse(await readFile(resolve(values.before), 'utf8'))
  const after = JSON.parse(await readFile(resolve(values.after), 'utf8'))
  const result = compareMarketTrafficReports(before, after)
  if (values.output) {
    const output = resolve(values.output)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
}
