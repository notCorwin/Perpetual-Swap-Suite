import test from 'node:test'
import { strict as assert } from 'node:assert'
import { ChartFocus } from '../electron/services/chart-focus.js'

test('a fresh renderer session owns focus even when its local token restarts at zero', () => {
  const focus = new ChartFocus()
  const firstSession = focus.beginSession()
  assert.equal(focus.focus('BTC-USDT-SWAP', firstSession, 7).ok, true)
  const reloadedSession = focus.beginSession()
  const reloaded = focus.focus('ETH-USDT-SWAP', reloadedSession, 0)
  assert.equal(reloaded.ok, true)
  assert.ok(reloaded.sequence > 0)
  assert.equal(focus.focus('BTC-USDT-SWAP', firstSession, 8).ok, false)
})

test('within one renderer session, stale chart requests cannot retake focus', () => {
  const focus = new ChartFocus()
  const session = focus.beginSession()
  assert.equal(focus.focus('BTC-USDT-SWAP', session, 2).ok, true)
  assert.equal(focus.focus('ETH-USDT-SWAP', session, 3).ok, true)
  assert.equal(focus.focus('BTC-USDT-SWAP', session, 2).ok, false)
})
