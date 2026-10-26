import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeResourceDelivery } from '../../scripts/resource-acceptance.mjs'

const load = () => ({ state: 'complete', emitted: 3, completed: 3, plannedTicks: 3, failed: 0, maxScheduleLatenessMS: 0, cadenceMS: 100,
  ticks: [1, 2, 3].map(sequence => ({ sequence, plannedAt: sequence * 100, receivedAt: sequence * 100 + 2, instId: 'BTC', timeframe: '5m' })) })
const commit = (sequence, delay = 20) => ({ sequence, instId: 'BTC', timeframe: '5m', committedAt: sequence * 100 + 10, nextFrameAt: sequence * 100 + delay })

test('resource acceptance rejects a middle stall even when the final input is fast', () => {
  assert.throws(() => summarizeResourceDelivery(load(), [commit(1), commit(2, 150), commit(3)]), /waited 148/)
})
test('coalesced updates retain the scheduled wait of the older intent', () => {
  const input = load(); input.ticks[0].plannedAt = 180; input.ticks[0].receivedAt = 182
  const report = summarizeResourceDelivery(input, [commit(2), commit(3)])
  assert.equal(report.coalesced, 1)
  assert.equal(report.p95MS, null, 'Short samples do not masquerade as a tail distribution.')
  assert.equal(report.samples[0].scheduleToFrameMS, 40)
  assert.throws(() => summarizeResourceDelivery(load(), [commit(2), commit(3)]), /waited 118/)
})
test('missing output, omitted scheduled input and unfinished intake cannot pass', () => {
  assert.throws(() => summarizeResourceDelivery(load(), [commit(1)]), /never reached/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), emitted: 2 }, []), /scheduled input/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), state: 'draining' }, []), /finish/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), maxScheduleLatenessMS: 101 }, []), /scheduler/)
})
