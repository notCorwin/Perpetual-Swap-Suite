import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessResourceBudgets, assertResourceDeliveryBudget, summarizeResourceDelivery } from '../../scripts/resource-acceptance.mjs'

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

test('source timestamps on one monotonic clock reject every reordered edge', () => {
  const input = load()
  input.ticks[0].emittedAt = input.ticks[0].receivedAt + 1
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
  input.ticks[0].emittedAt = input.ticks[0].plannedAt - .1
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
  input.ticks[0].emittedAt = input.ticks[0].plannedAt
  input.ticks[0].completedAt = input.ticks[0].receivedAt - 10
  assert.throws(() => summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)]), /ordered.*source timestamps/)
})

test('cross-process origin precision retains raw deltas without turning a submillisecond offset into a negative latency', () => {
  const records = [{ ...commit(1), committedAt: 101.5, nextFrameAt: 101.75 }, commit(2), commit(3)]
  const report = summarizeResourceDelivery(load(), records)
  assert.equal(report.samples[0].receiveToCommitClockDeltaMS, -.5)
  assert.equal(report.samples[0].receiveToFrameClockDeltaMS, -.25)
  assert.equal(report.samples[0].receiveToCommitMS, 0)
  assert.equal(report.samples[0].receiveToFrameMS, 0)
  assert.equal(report.crossProcessOriginToleranceMS, 2)
  assert.throws(() => summarizeResourceDelivery(load(), [{ ...records[0], committedAt: 90, nextFrameAt: 120 }, commit(2), commit(3)]), /ordered receive\/commit\/RAF/)
})

test('a selection that supersedes the old viewport acknowledges the global market update in the new visible series', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), { ...commit(2), instId: 'ETH' }, { ...commit(3), instId: 'ETH' }], {
    intents: [{ at: 0, instId: 'BTC', timeframe: '5m' }, { at: 206, instId: 'ETH', timeframe: '5m' }],
  })
  assert.equal(report.samples[1].instId, 'ETH')
  assert.equal(report.samples[1].receiveToFrameMS, 18)
  assert.doesNotThrow(() => assertResourceDeliveryBudget(report))
})

test('clock-ambiguous transitions to history stay measured instead of silently excluding a possibly live input', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), { ...commit(2), committedAt: 220, nextFrameAt: 230 }, commit(3)], {
    intents: [{ at: 0, instId: 'BTC', timeframe: '5m' }, { at: 201, instId: 'BTC', timeframe: '5m', historical: true },
      { at: 215, instId: 'BTC', timeframe: '5m', historical: false }],
  })
  assert.deepEqual(report.historicalViewportInputs, [])
  assert.equal(report.viewportOriginAmbiguities[0].sequence, 2)
  assert.equal(report.samples[1].receiveToFrameMS, 28)
})

test('a definitely historical viewport is an explicit exclusion bounded by the live-input minimum', () => {
  const report = summarizeResourceDelivery(load(), [commit(1), commit(3)], {
    intents: [{ at: 0, instId: 'BTC', timeframe: '5m' }, { at: 150, instId: 'BTC', timeframe: '5m', historical: true },
      { at: 250, instId: 'BTC', timeframe: '5m', historical: false }],
  })
  assert.deepEqual(report.historicalViewportInputs, [2])
  assert.deepEqual(report.viewportOriginAmbiguities, [])
  assert.equal(report.count, 2)
})
test('missing output, omitted scheduled input and unfinished intake cannot pass', () => {
  assert.throws(() => summarizeResourceDelivery(load(), [commit(1)]), /never reached/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), emitted: 2 }, []), /scheduled input/)
  assert.throws(() => summarizeResourceDelivery({ ...load(), state: 'draining' }, []), /finish/)
})

test('source overload retains valid delivery samples and still fails its unchanged cadence budget', () => {
  const input = { ...load(), maxScheduleLatenessMS: 101 }
  const delivery = summarizeResourceDelivery(input, [commit(1), commit(2), commit(3)])
  assert.equal(delivery.samples.length, 3)
  const failures = assessResourceBudgets({ load: input, delivery }, { offscreen: true })
  assert.deepEqual(failures.map(value => value.gate), ['source-cadence'])
  assert.match(failures[0].message, /101 ms.*100 ms/)
})

test('independent resource budget failures remain visible instead of masking one another', () => {
  const input = { ...load(), maxScheduleLatenessMS: 101 }
  const failures = assessResourceBudgets({ load: input, delivery: { receiveToFrameMaxMS: 110 },
    switches: [{ rowClickToFrameMS: 155 }], frameCadence: { maxMS: 101, p95MS: 51 } })
  assert.deepEqual(failures.map(value => value.gate), ['source-cadence', 'receive-to-raf', 'prepared-selection', 'raf-gap', 'raf-p95'])
  assert.deepEqual(assessResourceBudgets({ load: load(), delivery: { receiveToFrameMaxMS: 100 },
    switches: [{ rowClickToFrameMS: 100 }], frameCadence: { maxMS: 99.9, p95MS: 50 } }), [])
})

test('foreground resource budgets reject missing or non-finite measurements', () => {
  const failures = assessResourceBudgets({ load: { ...load(), maxScheduleLatenessMS: NaN },
    delivery: { receiveToFrameMaxMS: NaN }, switches: [], frameCadence: { maxMS: null, p95MS: null } })
  assert.equal(failures.length, 5)
})
