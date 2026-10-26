import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertResourceDeliveryBudget, summarizeResourceDelivery } from '../../scripts/resource-acceptance.mjs'

const load = () => ({ state: 'complete', emitted: 3, completed: 3, plannedTicks: 3, failed: 0, maxScheduleLatenessMS: 0, cadenceMS: 100,
  ticks: [1, 2, 3].map(sequence => ({ sequence, plannedAt: sequence * 100, emittedAt: sequence * 100,
    receivedAt: sequence * 100 + 2, completedAt: sequence * 100 + 3, instId: 'BTC', timeframe: '5m' })) })
const commit = (sequence, delay = 20) => ({ sequence, instId: 'BTC', timeframe: '5m', committedAt: sequence * 100 + 10, nextFrameAt: sequence * 100 + delay })

test('resource acceptance rejects a middle stall even when the final input is fast', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), commit(2, 150), commit(3)])
  assert.throws(() => assertResourceDeliveryBudget(report), /waited 148/)
  assert.equal(report.samples.length, 3, 'A failed budget must retain every measured input for diagnostics.')
  assert.equal(report.samples[1].receiveToFrameMS, 148)
})
test('coalesced updates retain the scheduled wait of the older intent', () => {
  const input = load(); Object.assign(input.ticks[0], { plannedAt: 180, emittedAt: 180, receivedAt: 182, completedAt: 183 })
  const report = summarizeResourceDelivery(input, [commit(2), commit(3)])
  assert.equal(report.coalesced, 1)
  assert.equal(report.p95MS, null, 'Short samples do not masquerade as a tail distribution.')
  assert.equal(report.samples[0].scheduleToFrameMS, 40)
  assert.throws(() => assertResourceDeliveryBudget(summarizeResourceDelivery(load(), [commit(2), commit(3)])), /waited 118/)
})

test('a delayed input measures the viewport active when received while retaining its original schedule', () => {
  const input = load()
  Object.assign(input.ticks[1], { emittedAt: 240, receivedAt: 242, completedAt: 243 })
  input.maxScheduleLatenessMS = 40
  const report = summarizeResourceDelivery(input, [commit(1), { ...commit(2), instId: 'ETH', committedAt: 250, nextFrameAt: 260 },
    { ...commit(3), instId: 'ETH' }], { intents: [{ at: 0, instId: 'BTC', timeframe: '5m' }, { at: 210, instId: 'ETH', timeframe: '5m' }] })
  assert.equal(report.samples[1].receiveToFrameMS, 18)
  assert.equal(report.samples[1].scheduleToFrameMS, 60)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('source timestamps allow clock granularity but reject a reordered source chain', () => {
  const input = load()
  input.ticks[0].emittedAt = input.ticks[0].receivedAt + 1
  assert.doesNotThrow(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]))
  input.ticks[0].completedAt = input.ticks[0].receivedAt - 10
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
})
test('missing output, omitted scheduled input and unfinished intake cannot pass', () => {
  assert.throws(() => summarizeResourceDelivery(load(), [commit(1)]), /never reached/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), emitted: 2 }, []), /scheduled input/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), state: 'draining' }, []), /finish/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), maxScheduleLatenessMS: 101 }, []), /scheduler/)
})
