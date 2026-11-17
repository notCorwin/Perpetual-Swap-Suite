import { test } from 'node:test'
import { verifyAppIdle } from '../support/app-idle-suite.mjs'

test('one minute of app idle retains UI while native market and archive work continue', { timeout: 540_000 }, t => verifyAppIdle(t, { soak: true }))
