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

test('scheduled source timestamps stay on the monotonic epoch clock when wall time is adjusted', async context => {
  const timers = clock()
  let wallTime = 42
  context.mock.method(Date, 'now', () => wallTime)
  const load = startResourceWorkload({ ticks: 2, cadenceMS: 100, ...timers,
    tick: () => ({ receivedAt: performance.timeOrigin + timers.now() }) })
  await timers.advance(0)
  wallTime += 30_000
  await timers.advance(100)
  const records = load.snapshot({ includeTicks: true }).ticks
  assert.equal(load.snapshot().startedAt, performance.timeOrigin)
  assert.deepEqual(records.map(row => row.receivedAt - row.plannedAt), [0, 0])
  assert.equal(records[1].plannedAt - records[0].plannedAt, 100)
})

test('an early timer callback cannot emit an input before its declared schedule', async () => {
  let time = 0
  const callbacks = []
  const load = startResourceWorkload({ ticks: 2, cadenceMS: 100, epoch: 1000, now: () => time,
    schedule: (fn, delay) => { callbacks.push({ fn, delay }); return callbacks.length }, unschedule() {},
    tick: () => ({ receivedAt: 1000 + time }) })
  callbacks[0].fn()
  for (let index = 0; index < 4; index++) await Promise.resolve()
  time = 99.5
  callbacks[1].fn()
  assert.equal(load.snapshot().emitted, 1)
  assert.equal(callbacks[2].delay, 1)
  time = 100
  callbacks[2].fn()
  for (let index = 0; index < 4; index++) await Promise.resolve()
  const rows = load.snapshot({ includeTicks: true }).ticks
  assert.deepEqual(rows.map(row => row.emittedAt), [1000, 1100])
  assert.ok(rows.every(row => row.plannedAt <= row.emittedAt && row.emittedAt <= row.receivedAt && row.receivedAt <= row.completedAt))
})
