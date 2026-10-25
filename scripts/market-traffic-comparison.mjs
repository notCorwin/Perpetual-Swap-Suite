#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const baselineRevision = 'ab9cb551bd00252abf370a324fe17d1eeacd6db1'
const hiddenMode = 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness'
const foregroundMode = 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness'

function sumBytes(channels) {
  return Object.values(channels ?? {}).reduce((total, value) => total + value.payloadBytes, 0)
}

export function validateMarketTrafficReport(report, label, { baseline = false } = {}) {
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
    `market-traffic-v2-bookseq-${report.fixture.candidateCount}-${report.fixture.passingCount}-${report.fixture.spreadFailureCount}-seed-${report.fixture.seed}`,
    `${label} must use the sequence-correct book fixture protocol version.`)
  assert.equal(report.fixture.qualification.verified, report.fixture.passingCount, `${label} qualified the wrong number of candidates.`)
  assert.equal(report.fixture.qualification.failed, report.fixture.candidateCount - report.fixture.passingCount, `${label} failed the wrong number of candidates.`)
  assert.equal(report.fixture.qualification.unknown, 0, `${label} contains unresolved candidates.`)
  assert.equal(report.correctness?.allCandidatesHaveFreshTickerOpenInterestAnd5m, true, `${label} did not retain all required live channels.`)
  assert.equal(report.correctness?.outputMatchesLatestFixtureTickers, true, `${label} renderer output did not match the fixture.`)
  assert.ok(['live', 'connecting'].includes(report.correctness?.finalRealtimeState), `${label} disconnected or was recovering during measurement.`)
  assert.ok(report.correctness?.connectedWebSocketClients >= 3, `${label} has no connected native WebSocket transports.`)
  assert.equal(report.fixtureErrors?.length ?? 0, 0, `${label} recorded fixture protocol errors.`)
  const expectedIDs = report.correctness.passingIDs
  assert.equal(expectedIDs.length, report.fixture.passingCount, `${label} is missing qualified instrument IDs.`)
  assert.deepEqual([...expectedIDs].sort(), expectedIDs, `${label} candidate output IDs must be sorted.`)
  const required = ['tickers', 'open-interest', 'candle5m']
  assert.deepEqual(report.fixture.requiredChannels, required, `${label} must exercise all required live channels.`)
  for (const channel of required) {
    const subscribed = report.traffic.subscriptionCounts?.[channel] ?? []
    assert.equal(subscribed.length, report.fixture.candidateCount, `${label} is missing ${channel} subscriptions.`)
    assert.equal(new Set(subscribed).size, report.fixture.candidateCount, `${label} has duplicate ${channel} subscriptions.`)
    const fresh = report.traffic.freshness?.[channel] ?? []
    assert.equal(fresh.length, report.fixture.candidateCount, `${label} has incomplete ${channel} freshness evidence.`)
    const minimumMessages = Math.floor(report.fixture.durationSeconds * 1_000 / report.fixture.cadenceMS * .75)
    assert.ok(fresh.every(value => value.sampleMessages >= minimumMessages && subscribed.includes(value.instId) && value.ageMS !== null
      && value.ageMS <= Math.max(1_500, report.fixture.cadenceMS * 3)), `${label} has stale or missing ${channel} observations.`)
    assert.equal(new Set(fresh.map(value => value.instId)).size, report.fixture.candidateCount, `${label} freshness IDs are duplicated.`)
    assert.deepEqual(fresh.map(value => value.instId).sort(), [...subscribed].sort(), `${label} ${channel} freshness does not cover every subscribed candidate.`)
  }
  if (report.fixture.expectOptimized) {
    const eligible = new Set(report.correctness.passingIDs)
    for (const channel of ['books', 'trades']) {
      const demand = report.traffic.subscriptionCounts?.[channel] ?? []
      assert.ok(demand.length <= report.fixture.passingCount && demand.every(instId => eligible.has(instId)),
        `${label} optimized ${channel} demand exceeds verified/selected contracts.`)
    }
    for (const channel of ['candle15m', 'candle1H']) {
      assert.equal(report.traffic.subscriptionCounts?.[channel]?.length ?? 0, 0, `${label} has a remote ${channel} subscription.`)
      assert.equal(report.traffic.websocketPayloadBytesByChannel?.[channel]?.messages ?? 0, 0, `${label} measured remote ${channel} payloads.`)
    }
  }
  const websocketBytes = sumBytes(report.traffic?.websocketPayloadBytesByChannel)
  const httpBytes = sumBytes(report.traffic?.httpResponsePayloadBytesByChannel)
  assert.equal(report.traffic?.websocketPayloadBytes, websocketBytes, `${label} WebSocket payload total is inconsistent.`)
  assert.equal(report.traffic?.httpResponsePayloadBytes, httpBytes, `${label} HTTP payload total is inconsistent.`)
  assert.equal(report.traffic?.totalPayloadBytes, websocketBytes + httpBytes, `${label} total fixture payload bytes are inconsistent.`)
  assert.ok(report.traffic.totalPayloadBytes > 0, `${label} is a no-op traffic run.`)
  for (const channel of required) assert.ok((report.traffic.websocketPayloadBytesByChannel?.[channel]?.messages ?? 0) > 0,
    `${label} has no measured ${channel} payload.`)
  assert.ok(report.renderer?.frameCount >= report.fixture.durationSeconds * 15, `${label} has insufficient renderer frame samples.`)
  assert.ok(report.renderer?.searchInteractionMS?.count >= report.fixture.passingCount, `${label} has insufficient renderer interaction samples.`)
  for (const [name, value] of Object.entries({ frameGapP95: report.renderer.frameGapMS?.p95,
    interactionP95: report.renderer.searchInteractionMS?.p95 })) {
    assert.ok(Number.isFinite(value) && value >= 0, `${label} has no valid ${name} measurement.`)
  }
  if (baseline) {
    assert.equal(report.app?.build?.revision, baselineRevision, `${label} must use the clean ab9cb551 baseline app.`)
    assert.equal(report.app?.build?.dirty, false, `${label} baseline app must be clean.`)
    if (foreground) {
      assert.equal(report.app?.build?.provenance, 'working-tree checkout', `${label} foreground baseline must use the selected ab9cb551 source checkout.`)
      assert.equal(report.app?.checkout?.revision, baselineRevision, `${label} selected baseline checkout must be ab9cb551.`)
      assert.equal(report.app?.checkout?.dirty, false, `${label} selected baseline checkout must be clean.`)
    }
  } else {
    assert.equal(report.app?.build?.provenance, 'working-tree checkout', `${label} must measure the selected working tree.`)
    if (foreground) {
      assert.equal(report.app?.build?.dirty, false, `${label} foreground comparison checkout must be clean.`)
      assert.equal(report.app?.checkout?.dirty, false, `${label} selected checkout must be clean.`)
      assert.equal(report.app?.build?.revision, report.app?.checkout?.revision, `${label} app provenance must describe the selected checkout.`)
    }
  }
  if (foreground) {
    assert.equal(report.fixture?.readinessPhase, 'all-passing-15m-frames-ready-before-steady-state-sample',
      `${label} must sample only after the selected chart readiness barrier.`)
    assert.equal(report.fixture?.readiness?.timeframe, '15m', `${label} must use the same selected 15m readiness phase.`)
    assert.equal(report.fixture?.readiness?.expectedFrames, report.fixture.passingCount, `${label} readiness must cover each passing contract.`)
    assert.equal(report.fixture?.readiness?.readyFrames, report.fixture.passingCount, `${label} must have every passing chart ready.`)
    assert.ok(Number.isFinite(report.fixture.readiness.elapsedMS), `${label} is missing the readiness barrier measurement.`)
  }
}

const closeToNoRegression = (before, after, absolute, relative) => ({ before, after,
  allowedIncrease: Number(Math.max(absolute, before * relative).toFixed(3)),
  passed: after <= before + Math.max(absolute, before * relative) })

export function compareMarketTrafficReports(before, after) {
  validateMarketTrafficReport(before, 'before', { baseline: true })
  validateMarketTrafficReport(after, 'after')
  assert.equal(after.mode, before.mode, 'Before/after reports must use the same presentation mode.')
  const foreground = before.mode === foregroundMode
  assert.equal(before.fixture.expectOptimized, false, 'Before report must measure the installed baseline without optimized-only assertions.')
  assert.equal(after.fixture.expectOptimized, true, 'After report must enable --expect-optimized assertions.')
  for (const key of ['candidateCount', 'passingCount', 'spreadFailureCount', 'oiFailureCount', 'seed', 'dataFingerprint', 'cadenceMS', 'durationSeconds']) {
    assert.equal(after.fixture[key], before.fixture[key], `Before/after fixture input ${key} must match exactly.`)
  }
  assert.equal(after.runtime.electronVersion, before.runtime.electronVersion, 'Before/after must use the same Electron version.')
  if (foreground) {
    assert.equal(after.runtime.executable, before.runtime.executable, 'Before/after must use the same actual Electron executable.')
    assert.equal(after.fixture.readinessPhase, before.fixture.readinessPhase, 'Before/after must cross the same chart readiness phase before sampling.')
    for (const key of ['timeframe', 'expectedFrames', 'readyFrames']) assert.equal(after.fixture.readiness[key], before.fixture.readiness[key],
      `Before/after chart readiness ${key} must match.`)
    assert.deepEqual(after.correctness.passingIDs, before.correctness.passingIDs, 'Before/after must qualify the same candidate output set.')
  } else {
    assert.equal(after.runtime.sourceFingerprint, before.runtime.sourceFingerprint, 'Before/after must use the same protected Electron bundle.')
  }
  for (const channel of ['tickers', 'open-interest', 'candle5m']) {
    assert.deepEqual(after.traffic.subscriptionCounts[channel], before.traffic.subscriptionCounts[channel],
      `Before/after must retain the same ${channel} candidate coverage.`)
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
    frameGapP95MS: closeToNoRegression(before.renderer.frameGapMS.p95, after.renderer.frameGapMS.p95, 2, .15),
    searchInteractionP95MS: closeToNoRegression(before.renderer.searchInteractionMS.p95, after.renderer.searchInteractionMS.p95, 3, .2),
  }
  for (const [name, result] of Object.entries(responsiveness)) assert.equal(result.passed, true,
    `Renderer responsiveness regressed beyond the bounded noise allowance for ${name}: ${JSON.stringify(result)}`)
  if (!foreground) {
    assert.ok(after.renderer.frameGapMS.p95 <= 50, 'After frame gap p95 exceeded the 50ms responsiveness budget.')
    assert.ok(after.renderer.searchInteractionMS.p95 <= 75, 'After search interaction p95 exceeded the 75ms hidden renderer budget.')
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
