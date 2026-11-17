import { test } from 'node:test'
import { verifyAppIdle } from '../support/app-idle-suite.mjs'

test('simulated app idle retains historical UI and background work, then resumes the latest source', { timeout: 180_000 }, verifyAppIdle)
