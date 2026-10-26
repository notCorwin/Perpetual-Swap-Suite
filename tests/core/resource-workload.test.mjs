import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startResourceWorkload } from '../../electron/resource-workload.js'

function clock() {
  let time = 0, next = 0
  const timers = new Map()
  return { now: () => time, schedule(fn, delay) { const id = ++next; timers.set(id, { at: time + delay, fn }); return id },
    unschedule: id => timers.delete(id),
    async advance(through) {
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry || entry[1].at > through) break
        timers.delete(entry[0]); time = entry[1].at; entry[1].fn()
        await Promise.resolve()
      }
      time = through
      for (let i = 0; i < 4; i++) await Promise.resolve()
    },
  }
}

test('fixed-rate intake keeps emitting while earlier work is blocked and exposes backlog', async () => {
  const timers = clock(), releases = [], sequences = []
  const load = startResourceWorkload({ ticks: 4, cadenceMS: 100, epoch: 1000, ...timers,
    tick: ({ sequence }) => { sequences.push(sequence); return new Promise(resolve => releases.push(() => resolve({ expected: sequence }))) } })
  await timers.advance(300)
  assert.deepEqual(sequences, [1, 2, 3, 4])
  assert.equal(load.snapshot().state, 'draining')
  assert.equal(load.snapshot().pending, 4)
  assert.equal(load.snapshot().maxPending, 4)
  releases.forEach(release => release())
  await timers.advance(301)
  assert.equal(load.snapshot().state, 'complete')
  assert.deepEqual(load.snapshot({ includeTicks: true }).ticks.map(row => row.plannedAt), [1000, 1100, 1200, 1300])
  assert.equal(load.snapshot().completed, 4)
})

test('failed ticks remain explicit and cancellation stops subsequent admission', async () => {
  const timers = clock()
  const load = startResourceWorkload({ ticks: 5, cadenceMS: 100, ...timers, tick: () => { throw new Error('injected intake failure') } })
  await timers.advance(100)
  load.cancel()
  await timers.advance(1000)
  assert.equal(load.snapshot().state, 'cancelled')
  assert.equal(load.snapshot().emitted, 2)
  assert.equal(load.snapshot().failed, 2)
  assert.ok(load.snapshot({ includeTicks: true }).ticks.every(row => row.error === 'injected intake failure'))
})
