import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapshotOrder } from './snapshot-order.ts'

test('late replies cannot regress a snapshot or switch back to a retired collector', () => {
  const order = new SnapshotOrder()
  assert.equal(order.accept({ revision: 20, serviceSession: 'old' }), true)
  assert.equal(order.accept({ revision: 19, serviceSession: 'old' }), false)
  assert.equal(order.accept({ revision: 1, serviceSession: 'new' }), true)
  assert.equal(order.accept({ revision: 100, serviceSession: 'old' }), false)
  assert.equal(order.revision, 1)
  assert.equal(order.serviceSession, 'new')
  assert.equal(order.accept({ revision: 2, serviceSession: 'new' }), true)
})
