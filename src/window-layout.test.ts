import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundWindowLaunch, windowToolbarLayout } from '../electron/window-layout.js'

test('window chrome keeps its normal density and traffic-light alignment across compact and wide windows', () => {
  for (const width of [800, 1000, 1200, 1510, 1710, 2600]) {
    assert.deepEqual(windowToolbarLayout(width, true), {
      scale: 1, height: 36, controlsInset: 72, buttonsPosition: { x: 12, y: 10 },
    })
    assert.deepEqual(windowToolbarLayout(width, false), {
      scale: 1, height: 36, controlsInset: 0, buttonsPosition: undefined,
    })
  }
})


test('background relaunch is explicit and cannot override test presentation guards', () => {
  assert.equal(backgroundWindowLaunch([]), false)
  assert.equal(backgroundWindowLaunch(['--background-launch']), true)
  assert.equal(backgroundWindowLaunch(['--background-launch'], true, false), false)
  assert.equal(backgroundWindowLaunch(['--background-launch'], false, true), false)
})
