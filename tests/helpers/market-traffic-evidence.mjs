import assert from 'node:assert/strict'

export const marketTrafficEvidenceVersion = 'market-traffic-causal-freshness-v2'
export const marketTrafficEvidenceClock = 'process.hrtime.bigint() converted to integer microseconds; same-host Node monotonic clock'

const streamKey = (channel, instId) => `${channel}\u0000${instId}`
const payloadKey = event => `${event.channel}\u0000${event.instId}\u0000${event.payloadFingerprint}`
const sortUnique = (values, label) => {
  assert.ok(Array.isArray(values), `${label} must be an array.`)
  assert.ok(values.every(value => typeof value === 'string' && value.length > 0), `${label} must contain instrument IDs.`)
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate instrument IDs.`)
  return [...values].sort()
}
const monotonic = (value, label) => {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be integer monotonic microseconds.`)
  return value
}

function normalizedDemand(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a channel map.`)
  return Object.fromEntries(Object.keys(value).sort().map(channel => [channel, sortUnique(value[channel], `${label} ${channel}`)]))
}

function indexEvents(events, label, timestampField, startUS, deadlineUS, expectedKeys = null) {
  assert.ok(Array.isArray(events), `${label} must be an array.`)
  const index = new Map(), unexpected = []
  for (const event of events) {
    assert.ok(event && typeof event === 'object', `${label} contains an invalid event.`)
    const time = monotonic(event[timestampField], `${label} ${timestampField}`)
    const inDrain = time >= startUS && time <= deadlineUS
    const hasIdentity = typeof event.channel === 'string' && event.channel.length > 0
      && typeof event.instId === 'string' && event.instId.length > 0
      && typeof event.identity === 'string' && event.identity.length > 0
      && typeof event.payloadFingerprint === 'string' && /^[a-f0-9]{64}$/.test(event.payloadFingerprint)
    if (!hasIdentity) {
      if (inDrain) unexpected.push(event)
      continue
    }
    const key = payloadKey(event)
    if (expectedKeys && !expectedKeys.has(key)) {
      if (inDrain) unexpected.push(event)
      continue
    }
    const values = index.get(key) ?? []
    values.push(event)
    index.set(key, values)
  }
  assert.deepEqual(unexpected, [], `${label} contains an unidentified or unexpected event inside the bounded drain window.`)
  return index
}

function maxInterval(startedAt, endedAt, timestamps) {
  const boundaries = [startedAt, ...timestamps, endedAt]
  let maximum = { durationMS: 0, from: startedAt, to: startedAt }
  for (let index = 1; index < boundaries.length; index++) {
    const from = boundaries[index - 1], to = boundaries[index], durationMS = to - from
    if (durationMS > maximum.durationMS) maximum = { durationMS, from, to }
  }
  return maximum
}

function validateRounds(rounds, expected, fixtureEvents, allowNoFillTrades, sampleStartedMonotonicUS, sampleEndedMonotonicUS) {
  assert.ok(Array.isArray(rounds), 'Fixture cadence rounds must be an array.')
  const normalizedExpected = normalizedDemand(expected, 'Expected subscriptions')
  const emptyTradeStreams = new Set((normalizedExpected.trades ?? []).map(instId => streamKey('trades', instId))
    .filter(key => !fixtureEvents.some(event => streamKey(event.channel, event.instId) === key)))
  const allowEmptyTradeStreams = allowNoFillTrades && emptyTradeStreams.size > 0
  const streamEvents = new Map()
  const seenRoundIds = new Set()
  let priorRoundID = null

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
    const round = rounds[roundIndex]
    assert.ok(round && typeof round === 'object', 'Fixture cadence round is invalid.')
    assert.ok(Number.isSafeInteger(round.roundId) && round.roundId >= 1, 'Fixture cadence round ID must be a positive integer.')
    assert.equal(seenRoundIds.has(round.roundId), false, 'Fixture cadence round ID is duplicated.')
    seenRoundIds.add(round.roundId)
    if (priorRoundID !== null) assert.equal(round.roundId, priorRoundID + 1, 'Fixture cadence evidence is missing an intervening round.')
    priorRoundID = round.roundId
    const roundExpected = normalizedDemand(round.expectedSubscriptions, `Fixture round ${round.roundId} expected subscriptions`)
    assert.deepEqual(roundExpected, normalizedExpected, `Fixture round ${round.roundId} demand differs from the app subscription set.`)
    monotonic(round.startedAtMonotonicUS, `Fixture round ${round.roundId} start`)
    monotonic(round.endedAtMonotonicUS, `Fixture round ${round.roundId} end`)
    assert.ok(round.startedAtMonotonicUS >= sampleStartedMonotonicUS && round.endedAtMonotonicUS <= sampleEndedMonotonicUS,
      `Fixture round ${round.roundId} falls outside the half-open sample window.`)
    assert.ok(round.endedAtMonotonicUS >= round.startedAtMonotonicUS, `Fixture round ${round.roundId} has reversed monotonic bounds.`)
    assert.ok(Array.isArray(round.events), `Fixture round ${round.roundId} must list every emitted payload.`)

    const expectedStreams = Object.entries(normalizedExpected).flatMap(([channel, ids]) => ids.map(instId => streamKey(channel, instId)))
      .filter(key => !(allowEmptyTradeStreams && emptyTradeStreams.has(key)))
    const actualStreams = [...new Set(round.events.map(event => streamKey(event.channel, event.instId)))].sort()
    assert.deepEqual(actualStreams, expectedStreams.slice().sort(),
      `Fixture round ${round.roundId} did not emit the exact expected contract/channel set.`)
    for (const event of round.events) {
      assert.equal(event.roundId, round.roundId, `Fixture event was assigned to the wrong cadence round ${round.roundId}.`)
      const sentAt = monotonic(event.sentAtMonotonicUS, `Fixture round ${round.roundId} send`)
      assert.ok(sentAt >= round.startedAtMonotonicUS && sentAt <= round.endedAtMonotonicUS,
        `Fixture event send falls outside cadence round ${round.roundId}.`)
      const values = streamEvents.get(streamKey(event.channel, event.instId)) ?? []
      values.push(event)
      streamEvents.set(streamKey(event.channel, event.instId), values)
    }
  }
  if (rounds.length === 0) {
    const requiredStreams = Object.entries(normalizedExpected).flatMap(([channel, ids]) => ids.map(instId => streamKey(channel, instId)))
      .filter(key => !(allowEmptyTradeStreams && emptyTradeStreams.has(key)))
    assert.deepEqual(requiredStreams, [], 'Fixture cadence evidence has no complete rounds for required data streams.')
  }

  const flattenedRounds = rounds.flatMap(round => round.events)
  assert.deepEqual(flattenedRounds, fixtureEvents, 'Fixture round sidecars do not exactly match the measured send-event list.')
  for (const [key, events] of streamEvents) {
    events.sort((left, right) => left.sequence - right.sequence)
    for (let index = 0; index < events.length; index++) {
      assert.ok(Number.isSafeInteger(events[index].sequence) && events[index].sequence === index + 1,
        `Fixture stream ${key.replace('\u0000', '/')} has a missing or replayed sequence.`)
      if (index) assert.ok(events[index].sentAtMonotonicUS >= events[index - 1].sentAtMonotonicUS,
        `Fixture stream ${key.replace('\u0000', '/')} has non-monotonic send ordering.`)
    }
  }
}

function deriveEvidenceChannels({ expectedSubscriptions, fixtureEvents, nativeIngressEvents, callbackEvents,
  fixtureRounds, sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS, sampleEndedMonotonicUS,
  drainDeadlineMonotonicUS, cadenceMS, allowNoFillTrades }) {
  validateRounds(fixtureRounds, expectedSubscriptions, fixtureEvents, allowNoFillTrades,
    sampleStartedMonotonicUS, sampleEndedMonotonicUS)
  const expectedDrainDeadlineUS = fixtureEvents.length
    ? Math.max(...fixtureEvents.map(event => monotonic(event.sentAtMonotonicUS, 'Fixture send') + cadenceMS * 1_000))
    : sampleEndedMonotonicUS
  assert.equal(drainDeadlineMonotonicUS, expectedDrainDeadlineUS,
    'Bounded drain deadline must equal the latest in-window fixture send freshness deadline.')
  const expectedPayloads = new Set(fixtureEvents.map(event => {
    assert.ok(typeof event.identity === 'string' && event.identity.length > 0, 'Fixture payload identity is missing.')
    assert.ok(typeof event.payloadFingerprint === 'string' && /^[a-f0-9]{64}$/.test(event.payloadFingerprint), 'Fixture payload fingerprint is missing or invalid.')
    return payloadKey(event)
  }))
  assert.equal(expectedPayloads.size, fixtureEvents.length, 'Fixture payload fingerprint is ambiguous within the measured window.')
  const nativeByPayload = indexEvents(nativeIngressEvents, 'Native ingress evidence', 'nativeHandlerEnteredAtMonotonicUS',
    sampleStartedMonotonicUS, drainDeadlineMonotonicUS, expectedPayloads)
  const callbacksByPayload = indexEvents(callbackEvents, 'Application callback evidence', 'nativeHandlerEnteredAtMonotonicUS',
    sampleStartedMonotonicUS, drainDeadlineMonotonicUS, expectedPayloads)
  const expected = normalizedDemand(expectedSubscriptions, 'Expected subscriptions')
  const eventsByStream = new Map()
  const aggregateLatencies = { fixtureSendToNativeHandler: [], fixtureSendToCallbackEntry: [], fixtureSendToCallbackAcceptance: [] }
  const streamsWithNoTrades = new Set()
  if (allowNoFillTrades && !fixtureEvents.some(event => event.channel === 'trades')) {
    for (const instId of expected.trades ?? []) streamsWithNoTrades.add(streamKey('trades', instId))
  }

  for (const fixtureEvent of fixtureEvents) {
    const channel = fixtureEvent.channel, instId = fixtureEvent.instId, key = streamKey(channel, instId), identityKey = payloadKey(fixtureEvent)
    const sentAtUS = monotonic(fixtureEvent.sentAtMonotonicUS, `Fixture ${channel}/${instId} send`)
    assert.ok(sentAtUS >= sampleStartedMonotonicUS && sentAtUS < sampleEndedMonotonicUS,
      `Fixture ${channel}/${instId} send is outside the half-open sample window.`)
    assert.ok(Number.isSafeInteger(fixtureEvent.sentAt), `Fixture ${channel}/${instId} wall send time is invalid.`)
    const native = nativeByPayload.get(identityKey) ?? []
    const callback = callbacksByPayload.get(identityKey) ?? []
    assert.equal(native.length, 1, `Fixture ${channel}/${instId} payload must enter the native handler exactly once.`)
    assert.equal(callback.length, 1, `Fixture ${channel}/${instId} payload must have exactly one production callback.`)
    const ingress = native[0], accepted = callback[0]
    assert.equal(ingress.identity, fixtureEvent.identity, `Native ingress identity shifted for ${channel}/${instId}.`)
    assert.equal(accepted.identity, fixtureEvent.identity, `Application callback identity shifted for ${channel}/${instId}.`)
    assert.equal(ingress.payloadFingerprint, fixtureEvent.payloadFingerprint, `Native payload fingerprint shifted for ${channel}/${instId}.`)
    assert.equal(accepted.payloadFingerprint, fixtureEvent.payloadFingerprint, `Application payload fingerprint shifted for ${channel}/${instId}.`)
    assert.equal(accepted.nativeMessageSequence, ingress.nativeMessageSequence,
      `Application callback was replayed from a different native message for ${channel}/${instId}.`)
    assert.ok(Number.isSafeInteger(accepted.callbackID) && accepted.callbackID >= 1,
      `Application callback ID is missing for ${channel}/${instId}.`)
    assert.ok(Number.isSafeInteger(accepted.receivedAt) && accepted.receivedAt >= sampleStartedAt,
      `Application business receive time is invalid for ${channel}/${instId}.`)
    const nativeAtUS = monotonic(ingress.nativeHandlerEnteredAtMonotonicUS, `Native ${channel}/${instId} handler entry`)
    const callbackNativeAtUS = monotonic(accepted.nativeHandlerEnteredAtMonotonicUS, `Callback ${channel}/${instId} native entry`)
    const callbackEnteredAtUS = monotonic(accepted.callbackEnteredAtMonotonicUS, `Callback ${channel}/${instId} entry`)
    assert.equal(callbackNativeAtUS, nativeAtUS, `Native handler timestamp changed before callback for ${channel}/${instId}.`)
    assert.ok(nativeAtUS >= sentAtUS, `Native handler entry precedes the fixture socket write for ${channel}/${instId}.`)
    assert.ok(callbackEnteredAtUS >= nativeAtUS, `Application callback entry precedes native handler entry for ${channel}/${instId}.`)
    assert.ok(Number.isSafeInteger(accepted.callbackAcceptedAtMonotonicUS),
      `Application callback ${channel}/${instId} did not fulfill before the bounded drain deadline.`)
    const callbackAcceptedAtUS = monotonic(accepted.callbackAcceptedAtMonotonicUS, `Callback ${channel}/${instId} acceptance`)
    assert.ok(callbackAcceptedAtUS >= callbackEnteredAtUS, `Application acceptance precedes callback entry for ${channel}/${instId}.`)
    assert.ok(callbackAcceptedAtUS <= drainDeadlineMonotonicUS,
      `Application callback ${channel}/${instId} completed after the bounded send-event deadline.`)
    const deadlineAtUS = sentAtUS + cadenceMS * 1_000
    assert.ok(callbackAcceptedAtUS < deadlineAtUS,
      `Application callback ${channel}/${instId} missed its end-to-end freshness deadline of ${cadenceMS}ms.`)

    const latency = {
      fixtureSendToNativeHandlerUS: nativeAtUS - sentAtUS,
      fixtureSendToCallbackEntryUS: callbackEnteredAtUS - sentAtUS,
      fixtureSendToCallbackAcceptanceUS: callbackAcceptedAtUS - sentAtUS,
      freshnessDeadlineAtMonotonicUS: deadlineAtUS,
    }
    aggregateLatencies.fixtureSendToNativeHandler.push(latency.fixtureSendToNativeHandlerUS)
    aggregateLatencies.fixtureSendToCallbackEntry.push(latency.fixtureSendToCallbackEntryUS)
    aggregateLatencies.fixtureSendToCallbackAcceptance.push(latency.fixtureSendToCallbackAcceptanceUS)
    const values = eventsByStream.get(key) ?? []
    values.push({ fixtureEvent, ingress, accepted, latency })
    eventsByStream.set(key, values)
  }

  const streamKeys = Object.entries(expected).flatMap(([channel, ids]) => ids.map(instId => streamKey(channel, instId)))
  const channels = Object.fromEntries(Object.entries(expected).map(([channel, ids]) => [channel, {
    expectedContracts: ids.length,
    entries: ids.map(instId => {
      const key = streamKey(channel, instId), matched = eventsByStream.get(key) ?? []
      const acceptedCallbacks = [...new Map(matched.map(value => [value.accepted.callbackID, value.accepted])).values()]
      const received = acceptedCallbacks.map(value => value.receivedAt).sort((a, b) => a - b)
      const fixtureSent = matched.map(value => value.fixtureEvent.sentAt).sort((a, b) => a - b)
      const receiptWindowEnd = Math.max(sampleEndedAt, received.at(-1) ?? sampleEndedAt)
      const gap = maxInterval(sampleStartedAt, receiptWindowEnd, received)
      const latencyUS = {
        fixtureSendToNativeHandler: matched.map(value => value.latency.fixtureSendToNativeHandlerUS),
        fixtureSendToCallbackEntry: matched.map(value => value.latency.fixtureSendToCallbackEntryUS),
        fixtureSendToCallbackAcceptance: matched.map(value => value.latency.fixtureSendToCallbackAcceptanceUS),
      }
      const isEmptyTradeStream = channel === 'trades' && streamsWithNoTrades.has(key) && matched.length === 0
      return {
        instId,
        applicationReceiptCount: acceptedCallbacks.length,
        fixtureSendCount: matched.length,
        applicationReceivedAtTimestamps: received,
        fixtureSentAtTimestamps: fixtureSent,
        firstReceivedAt: received[0] ?? null,
        lastReceivedAt: received.at(-1) ?? null,
        maxIntervalMS: gap.durationMS,
        maxIntervalFrom: gap.from,
        maxIntervalTo: gap.to,
        causalEventCount: matched.length,
        eventLatenciesUS: latencyUS,
        maximumLatenciesUS: Object.fromEntries(Object.entries(latencyUS).map(([name, values]) => [name, Math.max(0, ...values)])),
        ...(channel === 'trades' ? {
          tradeMessageCount: acceptedCallbacks.length,
          fillCount: acceptedCallbacks.reduce((sum, value) => sum + (value.fillCount ?? 0), 0),
          noFillMessageCount: acceptedCallbacks.filter(value => value.fillCount === 0).length,
          ...(isEmptyTradeStream ? { noFixtureMessages: true } : {}),
        } : {}),
      }
    }),
  }]))
  for (const channel of Object.keys(channels)) for (const entry of channels[channel].entries) {
    const allowedNoFill = channel === 'trades' && allowNoFillTrades && entry.fixtureSendCount === 0
    if (!allowedNoFill) {
      assert.ok(entry.applicationReceiptCount > 0, `${channel}/${entry.instId} has no accepted app receipts.`)
      assert.ok(entry.maxIntervalMS <= Math.floor(cadenceMS * 1.5),
        `${channel}/${entry.instId} maximum receipt interval ${entry.maxIntervalMS}ms exceeded ${Math.floor(cadenceMS * 1.5)}ms.`)
    }
  }
  const aggregate = Object.fromEntries(Object.entries(aggregateLatencies).map(([name, values]) => [name,
    { count: values.length, maximumUS: Math.max(0, ...values), rawUS: values }]))
  return { channels, aggregateLatenciesUS: aggregate, streamCount: streamKeys.length }
}

export function createMarketTrafficEvidence({ expectedSubscriptions, applicationReceipts, nativeIngressEvents,
  fixtureDeliveries, fixtureRounds, sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS,
  sampleEndedMonotonicUS, drainDeadlineMonotonicUS, cadenceMS, allowNoFillTrades = false,
  probeObserverCostMonotonicUS = 0 }) {
  assert.ok(Number.isSafeInteger(sampleStartedAt) && Number.isSafeInteger(sampleEndedAt) && sampleEndedAt > sampleStartedAt,
    'Market traffic evidence requires a positive wall-clock sample window.')
  assert.ok(Number.isSafeInteger(cadenceMS) && cadenceMS >= 1, 'Market traffic evidence requires a positive fixture cadence.')
  monotonic(sampleStartedMonotonicUS, 'Sample start')
  monotonic(sampleEndedMonotonicUS, 'Sample end')
  monotonic(drainDeadlineMonotonicUS, 'Send-event drain deadline')
  assert.ok(sampleEndedMonotonicUS > sampleStartedMonotonicUS, 'Market traffic evidence requires a positive monotonic sample window.')
  assert.ok(Number.isSafeInteger(probeObserverCostMonotonicUS) && probeObserverCostMonotonicUS >= 0,
    'Probe observer cost must be nonnegative integer microseconds.')
  const fixtureEvents = fixtureDeliveries?.events
  const callbackEvents = applicationReceipts?.callbackEvents
  const normalizedExpected = normalizedDemand(expectedSubscriptions ?? {}, 'Expected subscriptions')
  const evidence = {
    version: marketTrafficEvidenceVersion,
    source: 'fixture socket write matched to native WebSocket handler entry and fulfilled production callback',
    clock: marketTrafficEvidenceClock,
    timestampUnit: 'integer microseconds',
    sampleStartedAt, sampleEndedAt, durationMS: sampleEndedAt - sampleStartedAt, cadenceMS,
    allowedMaxIntervalMS: Math.floor(cadenceMS * 1.5),
    sampleStartedMonotonicUS, sampleEndedMonotonicUS, drainDeadlineMonotonicUS,
    freshnessDeadlineMS: cadenceMS,
    probeObserverCostMonotonicUS,
    expectedSubscriptions: normalizedExpected,
    fixtureRounds,
    fixtureEvents,
    nativeIngressEvents,
    callbackEvents,
    channels: null,
    aggregateLatenciesUS: null,
  }
  try {
    const derived = deriveEvidenceChannels({ expectedSubscriptions: normalizedExpected, fixtureEvents,
      nativeIngressEvents, callbackEvents, fixtureRounds, sampleStartedAt, sampleEndedAt, sampleStartedMonotonicUS,
      sampleEndedMonotonicUS, drainDeadlineMonotonicUS, cadenceMS, allowNoFillTrades })
    evidence.channels = derived.channels
    evidence.aggregateLatenciesUS = derived.aggregateLatenciesUS
    validateMarketTrafficEvidence(evidence, { allowNoFillTrades })
    return evidence
  } catch (error) {
    if (error && typeof error === 'object') Object.defineProperty(error, 'marketTrafficEvidence', { value: evidence, configurable: true })
    throw error
  }
}

export function validateMarketTrafficEvidence(evidence, { allowNoFillTrades = false } = {}) {
  assert.equal(evidence?.version, marketTrafficEvidenceVersion, 'Market traffic evidence has an unsupported version.')
  assert.equal(evidence?.source, 'fixture socket write matched to native WebSocket handler entry and fulfilled production callback',
    'Market traffic evidence must prove a causal app callback receipt.')
  assert.equal(evidence?.clock, marketTrafficEvidenceClock, 'Market traffic evidence must identify its monotonic clock.')
  assert.equal(evidence?.timestampUnit, 'integer microseconds', 'Market traffic evidence must state its timestamp unit.')
  assert.ok(Number.isSafeInteger(evidence.sampleStartedAt) && Number.isSafeInteger(evidence.sampleEndedAt)
    && evidence.sampleEndedAt > evidence.sampleStartedAt, 'Market traffic evidence has an invalid wall-clock window.')
  assert.ok(Number.isSafeInteger(evidence.cadenceMS) && evidence.cadenceMS > 0, 'Market traffic evidence has an invalid cadence.')
  assert.equal(evidence.allowedMaxIntervalMS, Math.floor(evidence.cadenceMS * 1.5), 'Market traffic evidence has an invalid maximum receipt-gap budget.')
  assert.equal(evidence.durationMS, evidence.sampleEndedAt - evidence.sampleStartedAt, 'Market traffic evidence duration is inconsistent.')
  monotonic(evidence.sampleStartedMonotonicUS, 'Sample start')
  monotonic(evidence.sampleEndedMonotonicUS, 'Sample end')
  monotonic(evidence.drainDeadlineMonotonicUS, 'Send-event drain deadline')
  assert.ok(evidence.sampleEndedMonotonicUS > evidence.sampleStartedMonotonicUS, 'Market traffic evidence has an invalid monotonic window.')
  assert.equal(evidence.freshnessDeadlineMS, evidence.cadenceMS, 'Market traffic evidence has an invalid freshness deadline.')
  assert.ok(Number.isSafeInteger(evidence.probeObserverCostMonotonicUS) && evidence.probeObserverCostMonotonicUS >= 0,
    'Market traffic evidence has an invalid probe observer cost.')
  const derived = deriveEvidenceChannels({ expectedSubscriptions: evidence.expectedSubscriptions,
    fixtureEvents: evidence.fixtureEvents, nativeIngressEvents: evidence.nativeIngressEvents,
    callbackEvents: evidence.callbackEvents, fixtureRounds: evidence.fixtureRounds,
    sampleStartedAt: evidence.sampleStartedAt, sampleEndedAt: evidence.sampleEndedAt,
    sampleStartedMonotonicUS: evidence.sampleStartedMonotonicUS, sampleEndedMonotonicUS: evidence.sampleEndedMonotonicUS,
    drainDeadlineMonotonicUS: evidence.drainDeadlineMonotonicUS, cadenceMS: evidence.cadenceMS, allowNoFillTrades })
  assert.deepEqual(evidence.channels, derived.channels, 'Causal market traffic channel summaries are inconsistent.')
  assert.deepEqual(evidence.aggregateLatenciesUS, derived.aggregateLatenciesUS, 'Aggregate raw causal latency evidence is inconsistent.')
  assert.deepEqual(Object.keys(evidence.channels ?? {}).sort(), Object.keys(evidence.expectedSubscriptions ?? {}).sort(),
    'Market traffic evidence contains unexpected channel measurements.')
  return true
}
