import assert from 'node:assert/strict'
import test from 'node:test'
import { marketTrafficPayloadIdentity, marketTrafficWireFingerprint } from '../../electron/services/market-traffic-callback-probe.js'
import { replayInputDigest } from '../helpers/market-replay-input.mjs'

const event = (roundId, seqId, prevSeqId, ts = '1000') => {
  const wirePayload = { seqId, prevSeqId, ts, bids: [['1', '2']], asks: [] }
  return { roundId, ...marketTrafficPayloadIdentity('books', 'A', wirePayload, 'update'), wireAction: 'update', wirePayload, wireFingerprint: marketTrafficWireFingerprint(wirePayload, 'update') }
}
const rematch = item => Object.assign(item, marketTrafficPayloadIdentity(item.channel, item.instId, item.wirePayload, item.wireAction), { wireFingerprint: marketTrafficWireFingerprint(item.wirePayload, item.wireAction) })

test('replay digest normalizes warmup sequence and time but preserves actual book semantics', () => {
  const original = [event(1, 7, 6), event(2, 8, 7, '1500')]
  const warm = [event(1, 20, 19, '5000'), event(2, 21, 20, '5500')]
  const a = replayInputDigest(original), b = replayInputDigest(warm)
  assert.notEqual(a.payloadHash, b.payloadHash)
  assert.equal(a.normalizedInputHash, b.normalizedInputHash)
  const gap = structuredClone(warm); gap[1].wirePayload.seqId++; rematch(gap[1])
  assert.notEqual(a.normalizedInputHash, replayInputDigest(gap).normalizedInputHash)
  const snapshot = structuredClone(warm); snapshot[0].wireAction = 'snapshot'; snapshot[0].wirePayload.prevSeqId = -1; rematch(snapshot[0])
  assert.notEqual(a.normalizedInputHash, replayInputDigest(snapshot).normalizedInputHash)
  const price = structuredClone(warm); price[0].wirePayload.bids[0][0] = '2'; rematch(price[0])
  assert.notEqual(a.normalizedInputHash, replayInputDigest(price).normalizedInputHash)
})

test('full wire fingerprint detects omitted fields, extra book columns, types and frame action', () => {
  const original = event(1, 7, 6)
  const changes = [
    item => { item.wirePayload.extra = 'value' },
    item => { item.wirePayload.bids[0].push('extra') },
    item => { item.wirePayload.bids[0][0] = 1 },
    item => { item.wirePayload.prevSeqId = 5 },
    item => { item.wireAction = 'snapshot' },
  ]
  for (const change of changes) {
    const modified = structuredClone(original)
    change(modified)
    assert.notEqual(marketTrafficWireFingerprint(modified.wirePayload, modified.wireAction), original.wireFingerprint)
    assert.throws(() => replayInputDigest([modified]))
  }
})

test('timestamps preserve cross-stream timing, canonical types and dispatch order', () => {
  const first = event(1, 7, 6, '1000'), second = { ...event(1, 8, 7, '1010'), instId: 'B' }
  rematch(second)
  const original = replayInputDigest([first, second])
  const shifted = structuredClone([first, second])
  for (const item of shifted) { item.wirePayload.ts = String(Number(item.wirePayload.ts) + 1000); rematch(item) }
  assert.equal(replayInputDigest(shifted).normalizedInputHash, original.normalizedInputHash)
  shifted[1].wirePayload.ts = '2011'; rematch(shifted[1])
  assert.notEqual(replayInputDigest(shifted).normalizedInputHash, original.normalizedInputHash)
  assert.notEqual(replayInputDigest([second, first]).normalizedInputHash, original.normalizedInputHash)
  for (const invalid of [1000, '01000']) {
    const modified = structuredClone(first); modified.wirePayload.ts = invalid; rematch(modified)
    assert.throws(() => replayInputDigest([modified]), /canonical millisecond string/)
  }
})
