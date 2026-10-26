import assert from 'node:assert/strict'

export const marketTrafficEvidenceVersion = 'market-traffic-app-receipts-v1'

const sortUnique = (values, label) => {
  assert.ok(Array.isArray(values), `${label} must be an array.`)
  assert.ok(values.every(value => typeof value === 'string' && value.length > 0), `${label} must contain instrument IDs.`)
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate instrument IDs.`)
  return [...values].sort()
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

function timestampsFor(events, channel, instId, timestampField) {
  const value = events?.[channel]?.[instId] ?? []
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.events)) return value.events.map(event => event?.[timestampField])
  return null
}

export function createMarketTrafficEvidence({ expectedSubscriptions, applicationReceipts, fixtureDeliveries,
  sampleStartedAt, sampleEndedAt, cadenceMS, allowNoFillTrades = false }) {
  assert.ok(Number.isSafeInteger(sampleStartedAt) && Number.isSafeInteger(sampleEndedAt) && sampleEndedAt > sampleStartedAt,
    'Market traffic evidence requires a positive, timestamped sample window.')
  assert.ok(Number.isSafeInteger(cadenceMS) && cadenceMS >= 1, 'Market traffic evidence requires a positive fixture cadence.')
  const expected = Object.fromEntries(Object.entries(expectedSubscriptions ?? {}).map(([channel, ids]) => [channel, sortUnique(ids, `${channel} expected subscriptions`)]))
  const allowedMaxIntervalMS = Math.floor(cadenceMS * 1.5)
  const channels = Object.fromEntries(Object.entries(expected).map(([channel, ids]) => [channel, {
    expectedContracts: ids.length,
    entries: ids.map(instId => {
      const receivedAtTimestamps = timestampsFor(applicationReceipts, channel, instId, 'receivedAt')
      const sentAtTimestamps = timestampsFor(fixtureDeliveries, channel, instId, 'sentAt')
      assert.ok(receivedAtTimestamps, `Application receipt evidence is missing ${channel}/${instId}.`)
      assert.ok(sentAtTimestamps, `Fixture send evidence is missing ${channel}/${instId}.`)
      const normalize = (values, source) => {
        assert.ok(values.every(value => Number.isSafeInteger(value) && value >= sampleStartedAt && value <= sampleEndedAt),
          `${source} ${channel}/${instId} contains a timestamp outside the complete measurement window.`)
        return [...values].sort((left, right) => left - right)
      }
      const received = normalize(receivedAtTimestamps, 'Application receipt')
      const sent = normalize(sentAtTimestamps, 'Fixture send')
      const gap = maxInterval(sampleStartedAt, sampleEndedAt, received)
      const tradeStats = applicationReceipts?.tradeStats?.[instId] ?? {}
      return {
        instId,
        applicationReceiptCount: received.length,
        fixtureSendCount: sent.length,
        applicationReceivedAtTimestamps: received,
        fixtureSentAtTimestamps: sent,
        firstReceivedAt: received[0] ?? null,
        lastReceivedAt: received.at(-1) ?? null,
        maxIntervalMS: gap.durationMS,
        maxIntervalFrom: gap.from,
        maxIntervalTo: gap.to,
        ...(channel === 'trades' ? {
          tradeMessageCount: tradeStats.messageCount ?? received.length,
          fillCount: tradeStats.fillCount ?? 0,
          noFillMessageCount: tradeStats.noFillMessageCount ?? 0,
        } : {}),
      }
    }),
  }]))
  const evidence = { version: marketTrafficEvidenceVersion, source: 'market-service accepted callbacks after native parsing',
    sampleStartedAt, sampleEndedAt, durationMS: sampleEndedAt - sampleStartedAt, cadenceMS, allowedMaxIntervalMS,
    expectedSubscriptions: expected, channels }
  validateMarketTrafficEvidence(evidence, { allowNoFillTrades })
  return evidence
}

export function validateMarketTrafficEvidence(evidence, { allowNoFillTrades = false } = {}) {
  assert.equal(evidence?.version, marketTrafficEvidenceVersion, 'Market traffic evidence has an unsupported version.')
  assert.equal(evidence?.source, 'market-service accepted callbacks after native parsing', 'Market traffic evidence must prove app callback receipt.')
  const { sampleStartedAt, sampleEndedAt, cadenceMS } = evidence
  assert.ok(Number.isSafeInteger(sampleStartedAt) && Number.isSafeInteger(sampleEndedAt) && sampleEndedAt > sampleStartedAt,
    'Market traffic evidence has an invalid measurement window.')
  assert.ok(Number.isSafeInteger(cadenceMS) && cadenceMS > 0, 'Market traffic evidence has an invalid cadence.')
  assert.equal(evidence.allowedMaxIntervalMS, Math.floor(cadenceMS * 1.5), 'Market traffic evidence has an invalid maximum interval budget.')
  assert.equal(evidence.durationMS, sampleEndedAt - sampleStartedAt, 'Market traffic evidence duration is inconsistent.')
  for (const [channel, expectedIDs] of Object.entries(evidence.expectedSubscriptions ?? {})) {
    const sortedIDs = sortUnique(expectedIDs, `${channel} expected subscriptions`)
    assert.deepEqual(expectedIDs, sortedIDs, `${channel} expected subscriptions must be sorted.`)
    const result = evidence.channels?.[channel]
    assert.ok(result, `Market traffic evidence is missing required ${channel} receipts.`)
    assert.equal(result.expectedContracts, expectedIDs.length, `${channel} receipt coverage count is inconsistent.`)
    assert.equal(result.entries?.length, expectedIDs.length, `${channel} receipt evidence does not cover every expected contract.`)
    assert.deepEqual(result.entries.map(value => value.instId), expectedIDs, `${channel} receipts are missing, duplicated, or unsorted.`)
    for (const value of result.entries) {
      const received = value.applicationReceivedAtTimestamps
      const sent = value.fixtureSentAtTimestamps
      assert.ok(Array.isArray(received) && Array.isArray(sent), `${channel}/${value.instId} must include complete timestamp series.`)
      assert.equal(value.applicationReceiptCount, received.length, `${channel}/${value.instId} application receipt count is inconsistent.`)
      assert.equal(value.fixtureSendCount, sent.length, `${channel}/${value.instId} fixture send count is inconsistent.`)
      assert.ok(received.every(time => Number.isSafeInteger(time) && time >= sampleStartedAt && time <= sampleEndedAt),
        `${channel}/${value.instId} has an app receipt outside the measurement window.`)
      assert.ok(sent.every(time => Number.isSafeInteger(time) && time >= sampleStartedAt && time <= sampleEndedAt),
        `${channel}/${value.instId} has a fixture send outside the measurement window.`)
      assert.equal(value.applicationReceiptCount, value.fixtureSendCount,
        `${channel}/${value.instId} application receipt count does not match fixture deliveries.`)
      const gap = maxInterval(sampleStartedAt, sampleEndedAt, [...received].sort((left, right) => left - right))
      assert.equal(value.maxIntervalMS, gap.durationMS, `${channel}/${value.instId} maximum receipt interval is inconsistent.`)
      assert.equal(value.maxIntervalFrom, gap.from, `${channel}/${value.instId} maximum interval start is inconsistent.`)
      assert.equal(value.maxIntervalTo, gap.to, `${channel}/${value.instId} maximum interval end is inconsistent.`)
      const allowedNoFill = channel === 'trades' && allowNoFillTrades && value.fixtureSendCount === 0
      if (!allowedNoFill) {
        assert.ok(value.applicationReceiptCount > 0, `${channel}/${value.instId} has no accepted app receipts.`)
        assert.ok(value.maxIntervalMS <= evidence.allowedMaxIntervalMS,
          `${channel}/${value.instId} maximum receipt interval ${value.maxIntervalMS}ms exceeded ${evidence.allowedMaxIntervalMS}ms.`)
      }
      if (channel === 'trades') {
        assert.equal(value.tradeMessageCount, value.applicationReceiptCount, `trades/${value.instId} message count is inconsistent.`)
        assert.ok(Number.isSafeInteger(value.fillCount) && value.fillCount >= 0, `trades/${value.instId} has an invalid fill count.`)
        assert.ok(Number.isSafeInteger(value.noFillMessageCount) && value.noFillMessageCount >= 0, `trades/${value.instId} has an invalid no-fill message count.`)
        assert.ok(value.noFillMessageCount <= value.tradeMessageCount, `trades/${value.instId} has more no-fill messages than accepted messages.`)
      }
    }
  }
  assert.deepEqual(Object.keys(evidence.channels ?? {}).sort(), Object.keys(evidence.expectedSubscriptions ?? {}).sort(),
    'Market traffic evidence contains unexpected channel measurements.')
  return true
}
