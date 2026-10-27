import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createMarketTrafficEvidence } from '../helpers/market-traffic-evidence.mjs'
import { compareMarketTrafficReports, validateMarketTrafficReport } from '../../scripts/market-traffic-comparison.mjs'

test('a single middle RAF stall cannot hide behind a healthy p95', () => {
  const value = report({ foreground: true })
  value.renderer.rafOpportunityGapMS.samples[200] = 150
  value.renderer.rafOpportunityGapMS.max = 150
  assert.throws(() => validateMarketTrafficReport(value, 'stalled'), /RAF stall/)
})

const candidateIDs = Array.from({ length: 10 }, (_, index) => `T${String(index).padStart(3, '0')}-USDT-SWAP`)
const requiredChannels = ['tickers', 'open-interest', 'candle5m']
const sampleStartedAt = 1_798_000_000_000
const sampleEndedAt = sampleStartedAt + 7_000
function trafficEvidence() {
  const expectedSubscriptions = { tickers: candidateIDs, 'open-interest': candidateIDs, books: candidateIDs.slice(0, 2),
    trades: candidateIDs.slice(0, 2), candle5m: candidateIDs, candle15m: [], candle1H: [] }
  const sampleStartedMonotonicUS = 100_000_000, sampleEndedMonotonicUS = sampleStartedMonotonicUS + 7_000_000
  const fixtureEvents = [], fixtureRounds = [], nativeIngressEvents = [], callbackEvents = []
  let nativeMessageSequence = 0, callbackID = 0
  for (let index = 0; index < 13; index++) {
    const roundId = index + 1, roundEvents = []
    const sentAtMonotonicUS = sampleStartedMonotonicUS + 500_000 + index * 500_000
    for (const [channel, ids] of Object.entries(expectedSubscriptions)) for (const instId of ids) {
      const identity = JSON.stringify([channel, instId, roundId])
      const payloadFingerprint = createHash('sha256').update(identity).digest('hex')
      const event = { channel, instId, identity, payloadFingerprint, roundId, sequence: index + 1,
        sentAt: sampleStartedAt + 500 + index * 500, sentAtMonotonicUS }
      fixtureEvents.push(event)
      roundEvents.push(event)
      nativeMessageSequence++
      const nativeHandlerEnteredAtMonotonicUS = sentAtMonotonicUS + 1_000
      nativeIngressEvents.push({ channel, instId, identity, payloadFingerprint, nativeMessageSequence, nativeHandlerEnteredAtMonotonicUS })
      callbackID++
      callbackEvents.push({ channel, instId, identity, payloadFingerprint, nativeMessageSequence, callbackID,
        nativeHandlerEnteredAtMonotonicUS, callbackEnteredAtMonotonicUS: sentAtMonotonicUS + 2_000,
        callbackAcceptedAtMonotonicUS: sentAtMonotonicUS + 20_000,
        receivedAt: sampleStartedAt + 505 + index * 500, fillCount: channel === 'trades' ? 1 : 0 })
    }
    fixtureRounds.push({ roundId, startedAtMonotonicUS: sentAtMonotonicUS, endedAtMonotonicUS: sentAtMonotonicUS,
      expectedSubscriptions, events: roundEvents })
  }
  return createMarketTrafficEvidence({ expectedSubscriptions,
    applicationReceipts: { callbackEvents }, nativeIngressEvents,
    fixtureDeliveries: { events: fixtureEvents, rounds: fixtureRounds }, fixtureRounds,
    sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS, sampleEndedMonotonicUS,
    drainDeadlineMonotonicUS: sampleEndedMonotonicUS, cadenceMS: 500 })
}

const channelEvidence = (multiplier, names = ['tickers', 'open-interest', 'books', 'trades', 'candle5m']) =>
  Object.fromEntries(names.map((name, index) => [name, { messages: 140, payloadBytes: multiplier * (index + 1) * 1_000 }]))

function samplesWithPercentile(count, median, p95, max) {
  const values = Array(count).fill(median)
  const p95Index = Math.max(0, Math.ceil(count * .95) - 1)
  for (let index = p95Index; index < count; index++) values[index] = p95
  values[count - 1] = Math.max(values[count - 1], max)
  return values
}

function report({ baseline = false, foreground = false, multiplier = 1, seed = 17, frameGapP95MS = 16.7,
  interactionP95MS = 33.4 } = {}) {
  const passingIDs = candidateIDs.slice(0, 2)
  const receiptEvidence = trafficEvidence()
  const channels = channelEvidence(multiplier)
  const websocketPayloadBytes = Object.values(channels).reduce((sum, value) => sum + value.payloadBytes, 0)
  const revision = baseline ? 'a'.repeat(40) : 'b'.repeat(40)
  const appBuild = { provenance: 'working-tree checkout', revision, dirty: false }
  const interactionDurations = samplesWithPercentile(foreground ? 21 : 3, 33.4, interactionP95MS,
    foreground ? Math.max(42, interactionP95MS) : interactionP95MS)
  const searchSamples = interactionDurations.map((durationMS, index) => {
    const startedMS = index * 345
    return { startedMS, completedMS: startedMS + durationMS, durationMS,
      expectedResultCount: 1, actualResultCount: 1, correct: true }
  })
  const frameSamples = samplesWithPercentile(400, 16.7, frameGapP95MS, Math.max(25, frameGapP95MS))
  return {
    mode: foreground ? 'foreground-electron-loopback-market-traffic-and-renderer-responsiveness'
      : 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness',
    app: { build: appBuild, checkout: { revision, dirty: false } },
    runtime: { network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1',
      presentation: foreground ? { visible: true, focused: true, minimized: false, offscreen: false }
        : { visible: false, focused: false, minimized: false, offscreen: true },
      testPresentation: foreground ? 'foreground-native' : 'background-only-offscreen',
      ...(foreground ? { foregroundCIProof: { githubActions: true, runnerEnvironment: 'github-hosted', runnerOS: 'macOS' },
        executable: '/fixture/electron' } : { sourceFingerprint: 'a'.repeat(64) }), electronVersion: '44.9.0' },
    fixture: { candidateCount: 10, candidateIDs, passingCount: 2, spreadFailureCount: 4, oiFailureCount: 4, seed,
      dataFingerprint: `market-traffic-v3-app-receipts-10-2-4-seed-${seed}`, cadenceMS: 500, durationSeconds: 7,
      sampleStartedAt, expectOptimized: !baseline, requiredChannels,
      qualification: { total: 10, completed: 10, pending: 0, verified: 2, failed: 8, unknown: 0 },
      ...(foreground ? { readinessPhase: 'all-passing-15m-frames-ready-before-steady-state-sample',
        searchScenario: { version: 'distributed-input-v1', eventCount: 21, windowMS: 7_000, lastInputAtMS: 6_900 },
        readiness: { timeframe: '15m', expectedFrames: 2, readyFrames: 2, elapsedMS: 100,
          measurement: 'Bounded chart startup readiness warmup; elapsedMS is excluded from steady-state performance results.' } } : {}) },
    traffic: { durationSeconds: 7, websocketPayloadBytes, httpResponsePayloadBytes: 0, totalPayloadBytes: websocketPayloadBytes,
      websocketPayloadBytesByChannel: channels, httpResponsePayloadBytesByChannel: {},
      subscriptionCounts: structuredClone(receiptEvidence.expectedSubscriptions), receiptEvidence,
      configuredDemand: { candidateIDs, eligibleIDs: passingIDs, focusedInstrumentID: passingIDs[0], booksEnabled: true } },
    renderer: { frameCount: 400, rafOpportunityGapMS: { sampleCount: 400, p50: 16.7, p95: frameGapP95MS,
      max: Math.max(25, frameGapP95MS), samples: frameSamples },
      searchInputToSecondRAFMS: { sampleCount: searchSamples.length, p50: 33.4, p95: interactionP95MS,
        p95Interpretation: 'Empirical nearest-rank summary; descriptive at this sample count, not a tail guarantee.',
        max: Math.max(...interactionDurations), samples: searchSamples },
      measurement: 'Renderer RAF callback opportunity gaps. These timings do not measure SVG commit or native compositor paint; input timing ends at the second RAF.' },
    correctness: { finalRealtimeState: 'live', connectedWebSocketClients: 3,
      allCandidatesHaveContinuousTickerOpenInterestAnd5mReceipts: true, passingIDs,
      outputMatchesLatestFixtureTickers: true }, fixtureErrors: [],
  }
}

test('market traffic comparison requires equal live coverage and reports measured savings', () => {
  const result = compareMarketTrafficReports(report({ baseline: true, multiplier: 3 }), report({ multiplier: 2 }))
  assert.equal(result.traffic.beforeTotalPayloadBytes, 45_000)
  assert.equal(result.traffic.afterTotalPayloadBytes, 30_000)
  assert.equal(result.traffic.savedPayloadBytes, 15_000)
  assert.equal(result.traffic.savedPercent, 33.33)
  assert.equal(result.responsiveness.rafOpportunityGapP95MS.passed, true)
})

test('comparison rejects a mutated causal stream summary before pairing', () => {
  const before = report({ baseline: true, multiplier: 3 })
  const after = report({ multiplier: 2 })
  const entry = after.traffic.receiptEvidence.channels.tickers.entries[0]
  entry.fixtureSendCount++
  assert.throws(() => compareMarketTrafficReports(before, after), /Causal market traffic channel summaries are inconsistent/)
})

test('paired comparison requires distinct clean app revisions', () => {
  const before = report({ baseline: true, foreground: true, multiplier: 3 })
  const sameBuild = report({ foreground: true, multiplier: 2 })
  sameBuild.app.build.revision = before.app.build.revision
  sameBuild.app.checkout.revision = before.app.build.revision
  assert.throws(() => compareMarketTrafficReports(before, sameBuild), /distinct clean app build revisions/)

  const dirtyBuild = report({ multiplier: 2 })
  dirtyBuild.app.build.dirty = true
  assert.throws(() => compareMarketTrafficReports(before, dirtyBuild), /After app build must have clean provenance/)

  const unknownProvenance = report({ baseline: true, foreground: true, multiplier: 3 })
  delete unknownProvenance.app.build.provenance
  const after = report({ foreground: true, multiplier: 2 })
  assert.throws(() => compareMarketTrafficReports(unknownProvenance, after), /must identify a checkout or packaged build metadata file/)
})

test('renderer timing summaries are recomputed from finite raw samples', () => {
  const before = report({ baseline: true, foreground: true, multiplier: 3 })
  const staleP95 = report({ foreground: true, multiplier: 2 })
  staleP95.renderer.searchInputToSecondRAFMS.p95 += 1
  assert.throws(() => compareMarketTrafficReports(before, staleP95), /input-to-second-RAF p95 does not match its raw samples/)

  const nullP95 = report({ foreground: true, multiplier: 2 })
  nullP95.renderer.rafOpportunityGapMS.p95 = null
  assert.throws(() => compareMarketTrafficReports(before, nullP95), /RAF opportunity gap p95 must be a finite measurement/)

  const invalidSample = report({ foreground: true, multiplier: 2 })
  invalidSample.renderer.searchInputToSecondRAFMS.samples[0].durationMS = Number.NaN
  assert.throws(() => compareMarketTrafficReports(before, invalidSample), /has an invalid or missing duration/)
})

test('market traffic comparison rejects changed fixtures, missing receipt intervals and renderer regressions', () => {
  const before = report({ baseline: true, multiplier: 3 })
  assert.throws(() => compareMarketTrafficReports(before, report({ multiplier: 2, seed: 18 })), /seed must match/)
  const missingMiddle = report({ multiplier: 2 })
  missingMiddle.traffic.receiptEvidence.channels.tickers.entries[0].applicationReceivedAtTimestamps.splice(5, 1)
  assert.throws(() => compareMarketTrafficReports(before, missingMiddle), /Causal market traffic channel summaries are inconsistent/)
  assert.throws(() => compareMarketTrafficReports(before, report({ multiplier: 2, frameGapP95MS: 60 })), /RAF opportunity gap|regressed/)
})

test('market traffic comparison requires a reduction in total payload rate', () => {
  const before = report({ baseline: true, multiplier: 3 })
  for (const multiplier of [3, 4]) {
    assert.throws(() => compareMarketTrafficReports(before, report({ multiplier })), /Optimized total payload rate must decrease/)
  }
})

test('market traffic comparison rejects pending, disconnected, empty and non-optimized after runs', () => {
  const before = report({ baseline: true, multiplier: 3 })
  const pending = report({ multiplier: 2 }); pending.fixture.qualification.pending = 1
  assert.throws(() => compareMarketTrafficReports(before, pending), /pending/)
  const disconnected = report({ multiplier: 2 }); disconnected.correctness.finalRealtimeState = 'disconnected'
  assert.throws(() => compareMarketTrafficReports(before, disconnected), /disconnected/)
  const empty = report({ multiplier: 2 }); empty.traffic.totalPayloadBytes = 0
  assert.throws(() => compareMarketTrafficReports(before, empty), /inconsistent/)
  const remotePeriods = report({ multiplier: 2 }); remotePeriods.traffic.subscriptionCounts.candle15m = candidateIDs
  assert.throws(() => compareMarketTrafficReports(before, remotePeriods), /candle15m acknowledgements/)
})

test('optimized foreground reports retain the absolute 50ms RAF and search budgets', () => {
  const before = report({ baseline: true, foreground: true, multiplier: 3, interactionP95MS: 49 })
  const tooSlowSearch = report({ foreground: true, multiplier: 2, interactionP95MS: 50.1 })
  assert.throws(() => compareMarketTrafficReports(before, tooSlowSearch), /input-to-second-RAF p95 exceeded 50ms/)
  const tooSlowRAF = report({ foreground: true, multiplier: 2, frameGapP95MS: 50.1 })
  assert.throws(() => compareMarketTrafficReports(before, tooSlowRAF), /RAF opportunity gap p95 exceeded 50ms/)
})

test('foreground comparison rejects presentation, readiness, runtime and paired regressions', () => {
  const before = report({ baseline: true, foreground: true, interactionP95MS: 40 })
  const goodAfter = report({ foreground: true, interactionP95MS: 40 })

  const wrongPresentation = report({ foreground: false })
  assert.throws(() => compareMarketTrafficReports(before, wrongPresentation), /same presentation mode/)

  const wrongReadiness = structuredClone(goodAfter)
  wrongReadiness.fixture.readinessPhase = 'sampled-before-chart-ready'
  assert.throws(() => compareMarketTrafficReports(before, wrongReadiness), /chart readiness barrier/)

  const wrongExecutable = structuredClone(goodAfter)
  wrongExecutable.runtime.executable = '/different/electron'
  assert.throws(() => compareMarketTrafficReports(before, wrongExecutable), /same actual Electron executable/)

  const wrongCoverage = structuredClone(goodAfter)
  wrongCoverage.correctness.passingIDs = [candidateIDs[0], candidateIDs[2]]
  assert.throws(() => compareMarketTrafficReports(before, wrongCoverage), /eligible market list/)

  const regressed = report({ foreground: true, interactionP95MS: 49 })
  assert.throws(() => compareMarketTrafficReports(before, regressed), /inputToSecondRAFP95MS/)
})

test('foreground search measurements require complete, distributed, correct result samples', () => {
  const before = report({ baseline: true, foreground: true, multiplier: 3 })
  const after = report({ foreground: true, multiplier: 2 })
  const incomplete = structuredClone(after)
  incomplete.renderer.searchInputToSecondRAFMS.sampleCount = 7
  incomplete.renderer.searchInputToSecondRAFMS.samples.length = 7
  incomplete.renderer.searchInputToSecondRAFMS.p50 = 33.4
  incomplete.renderer.searchInputToSecondRAFMS.p95 = 33.4
  incomplete.renderer.searchInputToSecondRAFMS.max = 33.4
  assert.throws(() => compareMarketTrafficReports(before, incomplete), /every declared search event/)
  const burst = structuredClone(after)
  burst.renderer.searchInputToSecondRAFMS.samples.forEach((sample, index) => {
    sample.startedMS = index * 30
    sample.completedMS = sample.startedMS + sample.durationMS
  })
  assert.throws(() => compareMarketTrafficReports(before, burst), /initial burst/)
  const wrongResults = structuredClone(after)
  wrongResults.renderer.searchInputToSecondRAFMS.samples[3].correct = false
  wrongResults.renderer.searchInputToSecondRAFMS.samples[3].actualResultCount = 2
  assert.throws(() => compareMarketTrafficReports(before, wrongResults), /filtered results/)
})
