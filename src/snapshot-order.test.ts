import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapshotOrder } from './snapshot-order.ts'
import { mergeChartBars } from './chart-snapshot.ts'

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

test('historical overlays preserve newer corrected candles and completed states', () => {
  const live = { revision: 10, bars: [{ hour: 2, confirmed: true, close: 120 }, { hour: 3, confirmed: false, close: 130 }] }
  const history = { revision: 9, bars: [{ hour: 1, confirmed: true, close: 100 }, { hour: 2, confirmed: true, close: 110 }, { hour: 3, confirmed: true, close: 125 }] }
  assert.deepEqual(mergeChartBars(live, history), [history.bars[0], live.bars[0], history.bars[2]])
  const correction = { ...history, revision: 11, bars: [{ hour: 2, confirmed: true, close: 115 }] }
  assert.equal(mergeChartBars(live, correction).find(bar => bar.hour === 2)?.close, 115)
})

test('charts do not mix cached history from a previous collector process', () => {
  const live = { revision: 1, serviceSession: 'new', bars: [{ hour: 2, confirmed: true, close: 120 }] }
  const history = { revision: 100, serviceSession: 'old', bars: [{ hour: 2, confirmed: true, close: 110 }] }
  assert.deepEqual(mergeChartBars(live, history), live.bars)
})
