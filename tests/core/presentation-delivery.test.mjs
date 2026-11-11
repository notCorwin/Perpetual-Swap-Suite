import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeChartWire } from '../../electron/chart-wire.js'
import { PresentationDelivery } from '../../electron/services/presentation-delivery.js'
import { PresentationLifecycle } from '../../electron/services/presentation-lifecycle.js'

const update = { epoch: 2, active: true, snapshot: { frames: [] } }
function renderer() {
  const sent = []
  return { sent, isDestroyed: () => false, send(channel, value) { sent.push({ channel, value }) } }
}
const gateway = owner => decodeChartWire(owner.sent.at(-1).value.snapshot).gateway
const queue = (delivery, owner, id = 'analysis') => {
  delivery.chunk(owner, id, Buffer.from('complete '))
  delivery.chunk(owner, id, Buffer.from('response'))
  delivery.terminal(owner, { id, type: 'end' })
}
const expected = id => [{ id, type: 'data', base64: Buffer.from('complete response').toString('base64') }, { id, type: 'end' }]

test('encoding and send failures retain response ownership until one successful restoration', () => {
  const owner = renderer(), delivery = new PresentationDelivery({ getState: () => ({ active: false }) })
  queue(delivery, owner)
  assert.throws(() => delivery.publish(owner, { ...update, snapshot: { unsupported: new Map() } }), /plain data/)
  const send = owner.send
  owner.send = () => { throw new Error('Send failed') }
  assert.throws(() => delivery.publish(owner, update), /Send failed/)
  owner.send = send
  delivery.publish(owner, update)
  assert.deepEqual(gateway(owner), expected('analysis'))
  delivery.publish(owner, update)
  assert.deepEqual(gateway(owner), [])
})

test('active responses use immediate notifications; idle responses preserve bytes and terminal errors', () => {
  let active = true
  const owner = renderer(), notifications = []
  const delivery = new PresentationDelivery({ getState: () => ({ active }), notify: (...args) => notifications.push(args) })
  queue(delivery, owner)
  assert.equal(notifications.length, 3)
  assert.deepEqual(notifications[0], [owner, 'radar:gateway-stream', { id: 'analysis', type: 'data', base64: Buffer.from('complete ').toString('base64') }])
  active = false
  const bytes = Buffer.from('original')
  delivery.chunk(owner, 'failure', bytes)
  bytes.fill(0)
  const terminal = { id: 'failure', type: 'error', message: 'Gateway stream interrupted.' }
  delivery.terminal(owner, terminal)
  delivery.publish(owner, update)
  assert.deepEqual(gateway(owner), [{ id: 'failure', type: 'data', base64: Buffer.from('original').toString('base64') }, terminal])
})

test('restoration respects owner, cancellation, destruction and shutdown boundaries', () => {
  let closing = false
  const first = renderer(), second = renderer()
  const delivery = new PresentationDelivery({ getState: () => ({ active: false }), isClosing: () => closing })
  queue(delivery, first, 'cancelled'); delivery.discard('cancelled')
  queue(delivery, first, 'destroyed'); delivery.discardOwner(first)
  queue(delivery, second, 'retained')
  first.isDestroyed = () => true
  queue(delivery, first, 'ignored')
  delivery.publish(first, update)
  assert.equal(first.sent.length, 0)
  first.isDestroyed = () => false
  closing = true
  queue(delivery, first, 'closing')
  closing = false
  delivery.publish(first, { epoch: 1, active: false })
  assert.deepEqual(first.sent.at(-1).value, { epoch: 1, active: false })
  delivery.publish(first, update)
  assert.deepEqual(gateway(first), [])
  delivery.publish(second, update)
  assert.deepEqual(gateway(second), expected('retained'))
})

test('lifecycle restoration delivers analysis that completed while inactive', async () => {
  const owner = renderer()
  let lifecycle
  const delivery = new PresentationDelivery({ getState: () => lifecycle.getState(), notify: (target, channel, detail) => target.send(channel, detail) })
  lifecycle = new PresentationLifecycle({ active: true, pause: () => {}, resume: async () => ({ frames: [] }), publish: value => delivery.publish(owner, value) })
  await lifecycle.setActive(false)
  queue(delivery, owner)
  assert.equal(owner.sent.length, 1)
  await lifecycle.setActive(true)
  assert.deepEqual(gateway(owner), expected('analysis'))
  delivery.terminal(owner, { id: 'next', type: 'end' })
  assert.equal(owner.sent.at(-1).channel, 'radar:gateway-stream')
})
