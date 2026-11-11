import assert from 'node:assert/strict'
import test from 'node:test'
import { isPriceFresh, watchPriceCountdown, watchPriceFreshness } from './price-clock.ts'

test('freshness expires once at the observation deadline without polling', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const updates: number[] = []
  const stop = watchPriceFreshness({ observedAt: 500, realtime: 'live', active: true, displayedAt: 1000, isActive: () => true, onTime: now => updates.push(now) })
  assert.equal(isPriceFresh(500, 'live', Date.now()), true)
  t.mock.timers.tick(29499)
  assert.deepEqual(updates, [])
  t.mock.timers.tick(1)
  assert.deepEqual(updates, [30500])
  assert.equal(isPriceFresh(500, 'live', Date.now()), false)
  t.mock.timers.tick(60000)
  assert.deepEqual(updates, [30500])
  stop?.()
})

test('freshness cleanup and presentation gates prevent idle updates', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const onTime = () => assert.fail('An inactive or disposed clock cannot publish')
  const props = { observedAt: 500, realtime: 'live' as const, active: true, displayedAt: 1000, isActive: () => true, onTime }
  watchPriceFreshness(props)?.()
  watchPriceFreshness({ ...props, isActive: () => false })
  assert.equal(watchPriceFreshness({ ...props, active: false }), undefined)
  assert.equal(watchPriceFreshness({ ...props, realtime: 'stale' }), undefined)
  assert.equal(watchPriceFreshness({ ...props, observedAt: null }), undefined)
  t.mock.timers.tick(60000)
})

test('resuming after expiry reconciles stale display immediately without another timer', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 40000 })
  const updates: number[] = []
  assert.equal(watchPriceFreshness({ observedAt: 500, realtime: 'live', active: true, displayedAt: 1000, isActive: () => true, onTime: now => updates.push(now) }), undefined)
  assert.deepEqual(updates, [40000])
  assert.equal(isPriceFresh(null, 'live', 40000), false)
  assert.equal(isPriceFresh(40000, 'stale', 40000), false)
  t.mock.timers.tick(60000)
  assert.deepEqual(updates, [40000])
})

test('countdown starts on visibility, suppresses idle ticks and stops on cleanup', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  let active = true
  const updates: number[] = [], onTime = (now: number) => updates.push(now)
  assert.equal(watchPriceCountdown(false, () => active, onTime), undefined)
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [])
  const stop = watchPriceCountdown(true, () => active, onTime)
  assert.deepEqual(updates, [2000])
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [2000, 3000])
  active = false
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [2000, 3000])
  stop?.()
  active = true
  t.mock.timers.tick(1000)
  assert.deepEqual(updates, [2000, 3000])
})
