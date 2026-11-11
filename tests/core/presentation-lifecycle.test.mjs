import assert from 'node:assert/strict'
import test from 'node:test'
import { PresentationLifecycle } from '../../electron/services/presentation-lifecycle.js'

test('app deactivation gates publication immediately and resumption publishes only its consistent snapshot', async () => {
  const events = [], calls = []
  const lifecycle = new PresentationLifecycle({ active: true, now: () => 123,
    pause: epoch => { calls.push(['pause', epoch]); return Promise.resolve() },
    resume: async epoch => { calls.push(['resume', epoch]); return { market: { revision: epoch }, frames: [] } },
    publish: state => events.push(state) })
  const idle = lifecycle.setActive(false)
  assert.equal(lifecycle.getState().active, false)
  assert.deepEqual(events, [{ epoch: 1, active: false, startedAt: 123 }])
  await idle
  await lifecycle.setActive(true)
  assert.deepEqual(calls, [['pause', 1], ['pause', 2], ['resume', 2]])
  assert.equal(events.at(-1).snapshot.market.revision, 2)
  assert.equal(events.at(-1).active, true)
  assert.equal(lifecycle.getState().snapshot, undefined, 'Large snapshots do not become a retained UI-event queue.')
  const count = events.length
  await lifecycle.setActive(true)
  assert.equal(events.length, count, 'Duplicate application activation is not a new restoration.')
})

test('late resume snapshots cannot undo idle or supersede a newer activation', async () => {
  const pending = new Map(), events = []
  const lifecycle = new PresentationLifecycle({ active: true,
    pause: () => {}, resume: epoch => new Promise(resolve => pending.set(epoch, resolve)), publish: state => events.push(state) })
  await lifecycle.setActive(false)
  const first = lifecycle.setActive(true)
  await Promise.resolve()
  await lifecycle.setActive(false)
  const last = lifecycle.setActive(true)
  await Promise.resolve()
  pending.get(2)({ market: { revision: 2 } })
  await first
  assert.equal(lifecycle.getState().active, false)
  pending.get(4)({ market: { revision: 4 } })
  await last
  assert.deepEqual(events.filter(state => state.active).map(state => state.snapshot.market.revision), [4])
})

test('failed catch-up retains the last frame and never advertises an active stale presentation', async () => {
  const failures = [], events = [], pauses = []
  const lifecycle = new PresentationLifecycle({ active: false, pause: epoch => { pauses.push(epoch) },
    resume: async () => { throw new Error('Reader unavailable') },
    publish: state => events.push(state), failed: (...args) => failures.push(args) })
  await lifecycle.setActive(true)
  assert.equal(lifecycle.getState().active, false)
  assert.equal(events.some(state => state.active), false)
  assert.equal(failures[0][1].message, 'Reader unavailable')
  assert.deepEqual(pauses, [1, 1], 'A failed catch-up stops restarted preparation as well as notifications.')
  lifecycle.resume = async () => ({ frames: [] })
  await lifecycle.setActive(true, { refresh: true })
  assert.equal(lifecycle.getState().active, true)
  lifecycle.publish = update => { if (update.active) throw new Error('Encoding failed') }
  await lifecycle.setActive(true, { refresh: true })
  assert.equal(lifecycle.getState().active, false)
  assert.equal(failures.at(-1)[1].message, 'Encoding failed')
})
