import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createMarketTrafficEvidence, validateMarketTrafficEvidence } from '../helpers/market-traffic-evidence.mjs'

const instId = 'T000-USDT-SWAP'
const sampleStartedAt = 1_798_000_000_000
const sampleEndedAt = sampleStartedAt + 7_000
const sampleStartedMonotonicUS = 100_000_000
const sampleEndedMonotonicUS = sampleStartedMonotonicUS + 7_000_000
const cadenceMS = 500

function makeCausalInput({ expectedSubscriptions = { tickers: [instId] }, allowNoFillTrades = false,
  acceptanceDelayUS = 20_000, ingressDelayUS = 1_000, callbackEntryDelayUS = 2_000,
  receiptWallDelayMS = 5, eventCount = 13, sendOffsetUS = 500_000 } = {}) {
  const fixtureEvents = [], fixtureRounds = [], nativeIngressEvents = [], callbackEvents = []
  let nativeMessageSequence = 0, callbackID = 0
  for (let index = 0; index < eventCount; index++) {
    const roundId = index + 1
    const sentAtMonotonicUS = sampleStartedMonotonicUS + sendOffsetUS + index * cadenceMS * 1_000
    const roundEvents = []
    for (const [channel, ids] of Object.entries(expectedSubscriptions)) for (const id of ids) {
      if (channel === 'trades' && allowNoFillTrades) continue
      const identity = JSON.stringify([channel, id, roundId])
      const payloadFingerprint = createHash('sha256').update(identity).digest('hex')
      const fixtureEvent = { channel, instId: id, identity, payloadFingerprint, roundId, sequence: index + 1,
        sentAt: sampleStartedAt + sendOffsetUS / 1_000 + index * cadenceMS, sentAtMonotonicUS }
      fixtureEvents.push(fixtureEvent)
      roundEvents.push(fixtureEvent)
      nativeMessageSequence++
      const nativeHandlerEnteredAtMonotonicUS = sentAtMonotonicUS + ingressDelayUS
      nativeIngressEvents.push({ channel, instId: id, identity, payloadFingerprint, nativeMessageSequence,
        nativeHandlerEnteredAtMonotonicUS })
      callbackID++
      callbackEvents.push({ channel, instId: id, identity, payloadFingerprint, nativeMessageSequence, callbackID,
        nativeHandlerEnteredAtMonotonicUS, callbackEnteredAtMonotonicUS: sentAtMonotonicUS + callbackEntryDelayUS,
        callbackAcceptedAtMonotonicUS: sentAtMonotonicUS + acceptanceDelayUS,
        receivedAt: sampleStartedAt + sendOffsetUS / 1_000 + index * cadenceMS + receiptWallDelayMS,
        fillCount: channel === 'trades' ? 1 : 0 })
    }
    const roundStart = roundEvents.length ? roundEvents[0].sentAtMonotonicUS
      : sampleStartedMonotonicUS + index * cadenceMS * 1_000
    fixtureRounds.push({ roundId, startedAtMonotonicUS: roundStart, endedAtMonotonicUS: roundStart,
      expectedSubscriptions, events: roundEvents })
  }
  const drainDeadlineMonotonicUS = fixtureEvents.length
    ? Math.max(...fixtureEvents.map(event => event.sentAtMonotonicUS + cadenceMS * 1_000)) : sampleEndedMonotonicUS
  return { expectedSubscriptions,
    applicationReceipts: { callbackEvents }, nativeIngressEvents,
    fixtureDeliveries: { events: fixtureEvents, rounds: fixtureRounds }, fixtureRounds,
    sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS, sampleEndedMonotonicUS,
    drainDeadlineMonotonicUS, cadenceMS, allowNoFillTrades }
}

function evidence(options) { return createMarketTrafficEvidence(makeCausalInput(options)) }

test('causally matched receipts preserve raw latency, full round coverage and the separate receipt-gap gate', () => {
  const result = evidence({ expectedSubscriptions: { tickers: [instId], books: [instId] } })
  const ticker = result.channels.tickers.entries[0]
  assert.equal(ticker.applicationReceiptCount, 13)
  assert.equal(ticker.fixtureSendCount, 13)
  assert.equal(ticker.maxIntervalMS, 505)
  assert.equal(ticker.firstReceivedAt, sampleStartedAt + 505)
  assert.equal(ticker.lastReceivedAt, sampleStartedAt + 6_505)
  assert.deepEqual(ticker.eventLatenciesUS.fixtureSendToNativeHandler, Array(13).fill(1_000))
  assert.deepEqual(ticker.eventLatenciesUS.fixtureSendToCallbackAcceptance, Array(13).fill(20_000))
  assert.equal(result.aggregateLatenciesUS.fixtureSendToCallbackAcceptance.count, 26)
  assert.equal(result.aggregateLatenciesUS.fixtureSendToCallbackAcceptance.maximumUS, 20_000)
  assert.equal(result.timestampUnit, 'integer microseconds')
  assert.equal(validateMarketTrafficEvidence(result), true)
})

test('a constant one-cadence acceptance delay fails despite equal counts and healthy receipt cadence', () => {
  const input = makeCausalInput({ acceptanceDelayUS: cadenceMS * 1_000 })
  assert.equal(input.applicationReceipts.callbackEvents.length, input.fixtureDeliveries.events.length)
  assert.throws(() => createMarketTrafficEvidence(input), error => {
    assert.equal(error.marketTrafficEvidence.fixtureEvents.length, input.fixtureDeliveries.events.length)
    assert.equal(error.marketTrafficEvidence.nativeIngressEvents.length, input.nativeIngressEvents.length)
    assert.equal(error.marketTrafficEvidence.callbackEvents.length, input.applicationReceipts.callbackEvents.length)
    return /freshness deadline/.test(error.message)
  })
})

test('the prior 1.5-cadence business receive-gap gate remains independent of causal acceptance', () => {
  const input = makeCausalInput({ receiptWallDelayMS: 500 })
  assert.ok(input.applicationReceipts.callbackEvents.every(event =>
    event.callbackAcceptedAtMonotonicUS - input.fixtureDeliveries.events.find(value => value.payloadFingerprint === event.payloadFingerprint).sentAtMonotonicUS < cadenceMS * 1_000))
  assert.throws(() => createMarketTrafficEvidence(input), /maximum receipt interval/)
})

test('quick native handler entry cannot hide a late fulfilled production callback', () => {
  const input = makeCausalInput({ acceptanceDelayUS: 501_000 })
  assert.ok(input.nativeIngressEvents.every((event, index) =>
    event.nativeHandlerEnteredAtMonotonicUS - input.fixtureDeliveries.events[index].sentAtMonotonicUS === 1_000))
  assert.throws(() => createMarketTrafficEvidence(input), /freshness deadline/)
})

test('shifted, replayed and missing callback identities fail causal matching', () => {
  const shifted = makeCausalInput()
  shifted.applicationReceipts.callbackEvents[0].payloadFingerprint = shifted.applicationReceipts.callbackEvents[1].payloadFingerprint
  assert.throws(() => createMarketTrafficEvidence(shifted), /exactly one production callback/)

  const replayed = makeCausalInput()
  replayed.applicationReceipts.callbackEvents.push({ ...replayed.applicationReceipts.callbackEvents[0], callbackID: 99_999 })
  assert.throws(() => createMarketTrafficEvidence(replayed), /exactly one production callback/)

  const unidentified = makeCausalInput()
  unidentified.applicationReceipts.callbackEvents[0].payloadFingerprint = null
  assert.throws(() => createMarketTrafficEvidence(unidentified), /unidentified or unexpected event/)
})

test('fixture cadence rounds cannot be shifted or silently omitted', () => {
  const shiftedRound = makeCausalInput()
  shiftedRound.fixtureRounds[0].events[0].roundId++
  shiftedRound.fixtureDeliveries.events[0].roundId++
  assert.throws(() => createMarketTrafficEvidence(shiftedRound), /wrong cadence round/)

  const missingRound = makeCausalInput()
  missingRound.fixtureRounds.splice(4, 1)
  missingRound.fixtureDeliveries.rounds = missingRound.fixtureRounds
  missingRound.fixtureRounds = missingRound.fixtureRounds
  assert.throws(() => createMarketTrafficEvidence(missingRound), /missing an intervening round/)
})

test('acceptance after the send window but before the event freshness deadline is retained', () => {
  const input = makeCausalInput({ acceptanceDelayUS: 20_000 })
  input.sampleEndedAt = sampleStartedAt + 6_600
  input.sampleEndedMonotonicUS = sampleStartedMonotonicUS + 6_600_000
  input.drainDeadlineMonotonicUS = sampleStartedMonotonicUS + 7_000_000
  const lastFixture = input.fixtureDeliveries.events.at(-1)
  const lastRoundFixture = input.fixtureRounds.at(-1).events.at(-1)
  lastFixture.sentAtMonotonicUS = sampleStartedMonotonicUS + 6_500_000
  lastRoundFixture.sentAtMonotonicUS = sampleStartedMonotonicUS + 6_500_000
  input.fixtureRounds.at(-1).startedAtMonotonicUS = sampleStartedMonotonicUS + 6_500_000
  input.fixtureRounds.at(-1).endedAtMonotonicUS = sampleStartedMonotonicUS + 6_500_000
  const lastNative = input.nativeIngressEvents.at(-1)
  lastNative.nativeHandlerEnteredAtMonotonicUS = sampleStartedMonotonicUS + 6_501_000
  const lastCallback = input.applicationReceipts.callbackEvents.at(-1)
  lastCallback.nativeHandlerEnteredAtMonotonicUS = sampleStartedMonotonicUS + 6_501_000
  lastCallback.callbackEnteredAtMonotonicUS = sampleStartedMonotonicUS + 6_502_000
  lastCallback.callbackAcceptedAtMonotonicUS = sampleStartedMonotonicUS + 6_650_000
  lastCallback.receivedAt = sampleStartedAt + 6_650
  const result = createMarketTrafficEvidence(input)
  assert.equal(result.channels.tickers.entries[0].applicationReceiptCount, 13)
  assert.ok(result.channels.tickers.entries[0].lastReceivedAt > result.sampleEndedAt)
})

test('an acceptance at or after the bounded freshness deadline fails', () => {
  const input = makeCausalInput({ eventCount: 1, sendOffsetUS: 6_900_000, acceptanceDelayUS: cadenceMS * 1_000 })
  input.fixtureRounds[0].startedAtMonotonicUS = sampleEndedMonotonicUS - 100_000
  input.fixtureRounds[0].endedAtMonotonicUS = sampleEndedMonotonicUS - 100_000
  input.fixtureDeliveries.events[0].sentAtMonotonicUS = sampleEndedMonotonicUS - 100_000
  input.fixtureRounds[0].events[0].sentAtMonotonicUS = sampleEndedMonotonicUS - 100_000
  input.nativeIngressEvents[0].nativeHandlerEnteredAtMonotonicUS = sampleEndedMonotonicUS - 99_000
  input.applicationReceipts.callbackEvents[0].nativeHandlerEnteredAtMonotonicUS = sampleEndedMonotonicUS - 99_000
  input.applicationReceipts.callbackEvents[0].callbackEnteredAtMonotonicUS = sampleEndedMonotonicUS - 98_000
  input.applicationReceipts.callbackEvents[0].callbackAcceptedAtMonotonicUS = sampleEndedMonotonicUS + 400_000
  input.drainDeadlineMonotonicUS = sampleEndedMonotonicUS + 400_000
  assert.throws(() => createMarketTrafficEvidence(input), /freshness deadline/)
})

test('trade demand is retained when the fixture sends no trade messages', () => {
  const result = evidence({ expectedSubscriptions: { trades: [instId] }, allowNoFillTrades: true, eventCount: 2 })
  const trade = result.channels.trades.entries[0]
  assert.deepEqual(result.expectedSubscriptions.trades, [instId])
  assert.equal(trade.applicationReceiptCount, 0)
  assert.equal(trade.fixtureSendCount, 0)
  assert.equal(trade.fillCount, 0)
  assert.equal(trade.noFixtureMessages, true)
  assert.equal(validateMarketTrafficEvidence(result, { allowNoFillTrades: true }), true)
})

test('invalid monotonic clock ordering and non-integer microseconds fail', () => {
  const beforeNative = makeCausalInput()
  beforeNative.nativeIngressEvents[0].nativeHandlerEnteredAtMonotonicUS = beforeNative.fixtureDeliveries.events[0].sentAtMonotonicUS - 1
  beforeNative.applicationReceipts.callbackEvents[0].nativeHandlerEnteredAtMonotonicUS = beforeNative.nativeIngressEvents[0].nativeHandlerEnteredAtMonotonicUS
  assert.throws(() => createMarketTrafficEvidence(beforeNative), /precedes the fixture socket write/)

  const beforeEntry = makeCausalInput()
  beforeEntry.applicationReceipts.callbackEvents[0].callbackEnteredAtMonotonicUS = sampleStartedMonotonicUS
  assert.throws(() => createMarketTrafficEvidence(beforeEntry), /precedes native handler entry/)

  const fractional = makeCausalInput()
  fractional.nativeIngressEvents[0].nativeHandlerEnteredAtMonotonicUS += 0.5
  assert.throws(() => createMarketTrafficEvidence(fractional), /integer monotonic microseconds/)
})
