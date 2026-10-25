import assert from 'node:assert/strict'
import test from 'node:test'
import { compareMarketTrafficReports } from '../../scripts/market-traffic-comparison.mjs'

const candidateIDs = Array.from({ length: 10 }, (_, index) => `T${String(index).padStart(3, '0')}-USDT-SWAP`)
const requiredChannels = ['tickers', 'open-interest', 'candle5m']
const channelEvidence = (multiplier, names = requiredChannels) => Object.fromEntries(names.map((name, index) => [name,
  { messages: 140, payloadBytes: multiplier * (index + 1) * 1_000 }]))
const freshness = () => Object.fromEntries(requiredChannels.map(channel => [channel, candidateIDs.map(instId => ({
  instId, sampleMessages: 14, lastSentAt: 1_798_000_000_000, ageMS: 100, latestFixtureValue: { channel },
}))]))

function report({ baseline, multiplier = 1, seed = 17, ageMS = 100, frameGapP95MS = 16.7, interactionP95MS = 33.4 } = {}) {
  const channels = channelEvidence(multiplier)
  const websocketPayloadBytes = Object.values(channels).reduce((sum, value) => sum + value.payloadBytes, 0)
  const appBuild = baseline ? { revision: 'ab9cb551bd00252abf370a324fe17d1eeacd6db1', dirty: false }
    : { provenance: 'working-tree checkout', revision: 'feature-revision', dirty: true }
  const values = freshness()
  for (const channel of requiredChannels) for (const value of values[channel]) value.ageMS = ageMS
  const passingIDs = candidateIDs.slice(0, 2)
  return {
    mode: 'hidden-electron-loopback-market-traffic-and-renderer-responsiveness',
    app: { build: appBuild },
    runtime: { network: 'external network disabled; injected HTTP/WebSocket origins are 127.0.0.1',
      presentation: { visible: false, focused: false, minimized: false, offscreen: true },
      testPresentation: 'background-only-offscreen', sourceFingerprint: 'a'.repeat(64), electronVersion: '44.9.0' },
    fixture: { candidateCount: 10, passingCount: 2, spreadFailureCount: 4, oiFailureCount: 4, seed,
      dataFingerprint: `market-traffic-v2-bookseq-10-2-4-seed-${seed}`, cadenceMS: 500, durationSeconds: 7,
      expectOptimized: !baseline, requiredChannels, qualification: { total: 10, completed: 10, pending: 0, verified: 2, failed: 8, unknown: 0 } },
    traffic: { durationSeconds: 7, websocketPayloadBytes, httpResponsePayloadBytes: 0, totalPayloadBytes: websocketPayloadBytes,
      websocketPayloadBytesByChannel: channels, httpResponsePayloadBytesByChannel: {},
      subscriptionCounts: { ...Object.fromEntries(requiredChannels.map(channel => [channel, candidateIDs])),
        ...(baseline ? { books: candidateIDs, trades: candidateIDs, candle15m: candidateIDs, candle1H: candidateIDs }
          : { books: candidateIDs.slice(0, 2), trades: candidateIDs.slice(0, 2) }) }, freshness: values },
    renderer: { frameCount: 400, frameGapMS: { p50: 16.7, p95: frameGapP95MS, max: 25 },
      searchInteractionMS: { count: 3, p50: 33.4, p95: interactionP95MS, max: 42 } },
    correctness: { finalRealtimeState: 'live', connectedWebSocketClients: 3, allCandidatesHaveFreshTickerOpenInterestAnd5m: true,
      passingIDs, outputMatchesLatestFixtureTickers: true }, fixtureErrors: [],
  }
}

test('market traffic comparison requires equal live coverage and reports measured savings', () => {
  const result = compareMarketTrafficReports(report({ baseline: true, multiplier: 3 }), report({ multiplier: 2 }))
  assert.equal(result.traffic.beforeTotalPayloadBytes, 18_000)
  assert.equal(result.traffic.afterTotalPayloadBytes, 12_000)
  assert.equal(result.traffic.savedPayloadBytes, 6_000)
  assert.equal(result.traffic.savedPercent, 33.33)
  assert.equal(result.responsiveness.frameGapP95MS.passed, true)
})

test('market traffic comparison rejects changed fixtures, stale channels and renderer regressions', () => {
  const before = report({ baseline: true, multiplier: 3 })
  assert.throws(() => compareMarketTrafficReports(before, report({ multiplier: 2, seed: 18 })), /seed must match/)
  assert.throws(() => compareMarketTrafficReports(before, report({ multiplier: 2, ageMS: 3_000 })), /stale or missing/)
  assert.throws(() => compareMarketTrafficReports(before, report({ multiplier: 2, frameGapP95MS: 60 })), /frame-gap|regressed/)
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
  assert.throws(() => compareMarketTrafficReports(before, remotePeriods), /remote candle15m/)
})
