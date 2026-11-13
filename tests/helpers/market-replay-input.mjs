import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { marketTrafficPayloadIdentity, marketTrafficWireFingerprint } from '../../electron/services/market-traffic-callback-probe.js'

// Call only after the receipt oracle has matched every send to native ingress
// and an accepted application callback. Preserve the actual global dispatch order.
export function replayInputDigest(events) {
  assert.ok(Array.isArray(events) && events.length > 0, 'Replay requires matched input events.')
  const bases = new Map()
  const timestampFor = event => {
    const value = event.channel.startsWith('candle') ? event.wirePayload?.[0] : event.wirePayload?.ts
    assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)), 'Replay timestamp must be a canonical millisecond string.')
    return Number(value)
  }
  const timestampBase = Math.min(...events.map(timestampFor))
  const records = events.map(event => {
    assert.ok(event.wirePayload && event.identity && event.payloadFingerprint, 'Replay input is missing wire payload evidence.')
    const identity = marketTrafficPayloadIdentity(event.channel, event.instId, event.wirePayload, event.wireAction)
    assert.equal(identity?.identity, event.identity, 'Wire identity differs from matched receipt.')
    assert.equal(identity?.payloadFingerprint, event.payloadFingerprint, 'Wire payload differs from matched receipt.')
    assert.equal(marketTrafficWireFingerprint(event.wirePayload, event.wireAction), event.wireFingerprint, 'Wire fingerprint differs from matched receipt.')
    const payload = structuredClone(event.wirePayload), stream = `${event.channel}:${event.instId}`
    if (event.channel === 'books') {
      assert.ok(Number.isSafeInteger(payload.seqId) && Number.isSafeInteger(payload.prevSeqId), 'Invalid book sequence.')
      if (!bases.has(stream)) bases.set(stream, payload.seqId)
      const base = bases.get(stream)
      payload.seqId -= base
      if (payload.prevSeqId !== -1) payload.prevSeqId -= base
    }
    const normalizedTimestamp = String(timestampFor(event) - timestampBase)
    if (event.channel.startsWith('candle')) payload[0] = normalizedTimestamp
    else payload.ts = normalizedTimestamp
    return { roundId: event.roundId, channel: event.channel, instId: event.instId,
      action: event.wireAction, payload }
  })
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  return {
    payloadHash: sha(events.map(({ roundId, channel, instId, wireAction, wirePayload }) => ({ roundId, channel, instId, action: wireAction, payload: wirePayload }))),
    normalizedInputHash: sha(records),
    normalization: 'Matched dispatched payloads retain global dispatch order and frame action. All timestamps must be canonical millisecond strings and are offsets from one shared minimum timestamp. Book sequence and non-sentinel previous sequence are offsets from each stream’s first sequence; snapshot sentinel -1 remains unchanged. All other wire fields are retained.',
    bases: { bookSequence: Object.fromEntries(bases), timestamp: timestampBase },
    eventCount: events.length,
  }
}
