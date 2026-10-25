import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { MarketStore } from '../../electron/services/market-store.js'

class ControlledWorker extends EventEmitter {
  constructor(threadId) {
    super()
    this.threadId = threadId
    this.dispatched = []
    this.busy = false
    this.current = null
  }
  postMessage(message) { this.dispatched.push(message) }
  completeCurrent(result) {
    assert.ok(this.current, 'A request must be active before it can be completed.')
    this.emit('message', { id: this.current.id, result })
  }
  ref() {}
  unref() {}
  async terminate() { return 0 }
}

const createStore = () => {
  const writer = new ControlledWorker(1), reader = new ControlledWorker(2)
  return { store: new MarketStore('/unused', '/unused/market.sqlite', writer, [reader]), writer, reader }
}

async function completeAll(reader, count) {
  while (reader.dispatched.length < count) {
    reader.completeCurrent()
    await Promise.resolve()
  }
  reader.completeCurrent()
}

test('database workers keep highest-rank priority and FIFO order within each rank', async () => {
  const { store, reader } = createStore()
  const requests = [['blocker', 'background'], ['foreground-1', 'foreground'], ['interactive-1', 'interactive'],
    ['prepared-1', 'prepared'], ['continuity-1', 'continuity'], ['repair-1', 'repair'], ['statistics-1', 'statistics'],
    ['prefetch-1', 'prefetch'], ['chart-warm-1', 'chartWarm'], ['background-1', 'background'],
    ['interactive-2', 'interactive'], ['foreground-2', 'foreground']]
  const tasks = requests.map(([command, priority]) => store.readers.request(command, [], priority))

  assert.equal(store.getDiagnostics().reads.queued, requests.length - 1)
  assert.equal(store.getDiagnostics().reads.maximumQueued, requests.length - 1)
  await completeAll(reader, requests.length)
  await Promise.all(tasks)

  assert.deepEqual(reader.dispatched.map(message => message.command), ['blocker', 'interactive-1', 'interactive-2',
    'foreground-1', 'prepared-1', 'repair-1', 'foreground-2', 'continuity-1', 'statistics-1', 'prefetch-1',
    'chart-warm-1', 'background-1'])
  assert.equal(store.getDiagnostics().reads.queued, 0)
})

test('database workers dispatch the globally oldest low-rank job after eight foreground selections', async () => {
  const { store, reader } = createStore()
  const requests = [['blocker', 'background'], ...Array.from({ length: 9 }, (_, index) => [`foreground-${index}`, 'foreground']),
    ['oldest-low-rank', 'prefetch'], ['newer-higher-low-rank', 'statistics'], ['newer-lowest-rank', 'background']]
  const tasks = requests.map(([command, priority]) => store.readers.request(command, [], priority))

  assert.equal(store.getDiagnostics().reads.queued, requests.length - 1)
  assert.equal(store.getDiagnostics().reads.maximumQueued, requests.length - 1)
  await completeAll(reader, requests.length)
  await Promise.all(tasks)

  assert.deepEqual(reader.dispatched.map(message => message.command), ['blocker',
    ...Array.from({ length: 8 }, (_, index) => `foreground-${index}`), 'oldest-low-rank', 'foreground-8',
    'newer-higher-low-rank', 'newer-lowest-rank'])
})

test('database worker failure rejects the active and queued requests and clears diagnostics', async () => {
  const { store, reader } = createStore()
  const tasks = [store.readers.request('active', [], 'foreground'), store.readers.request('queued-statistics', [], 'statistics'),
    store.readers.request('queued-background', [], 'background')]
  const rejectionOrder = []
  const observedTasks = tasks.map((task, index) => task.catch(error => { rejectionOrder.push(index); throw error }))
  const failure = new Error('reader unavailable')

  reader.emit('error', failure)
  const settled = await Promise.allSettled(observedTasks)
  assert.deepEqual(settled.map(result => result.status), ['rejected', 'rejected', 'rejected'])
  assert.deepEqual(rejectionOrder, [0, 1, 2])
  for (const result of settled) assert.equal(result.reason, failure)
  assert.equal(store.getDiagnostics().reads.queued, 0)
  await assert.rejects(store.readers.request('after-failure'), error => error === failure)
})

test('database worker close waits for admitted work before dispatching the close fence', async () => {
  const { store, writer, reader } = createStore()
  const request = store.readers.request('admitted-read', [], 'interactive')
  const closing = store.close()
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(reader.dispatched.map(message => message.command), ['admitted-read'])
  assert.deepEqual(writer.dispatched, [])

  reader.completeCurrent('read-result')
  assert.equal(await request, 'read-result')
  while (reader.dispatched.length < 2) await new Promise(resolve => setImmediate(resolve))
  assert.equal(reader.dispatched.at(-1).command, 'close')
  assert.deepEqual(writer.dispatched, [], 'The writer close fence follows the reader close fence.')
  reader.completeCurrent()
  while (writer.dispatched.length < 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(writer.dispatched[0].command, 'close')
  writer.completeCurrent()
  await closing
})
