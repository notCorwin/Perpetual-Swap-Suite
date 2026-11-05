import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('market-clock offset aligns epochs while timers retain real elapsed time', async () => {
  const offset = 600000
  const code = `
    const actual = () => new Date().getTime();
    const before = { real: actual(), date: Date.now(), monotonic: performance.now() };
    setTimeout(() => console.log(JSON.stringify({ before, after: { real: actual(), date: Date.now(), monotonic: performance.now() }, epochGap: performance.timeOrigin + performance.now() - actual() })), 120);
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', fileURLToPath(new URL('./clock.mjs', import.meta.url)), '-e', code], {
    env: { ...process.env, RADAR_COMPARE_CLOCK_OFFSET_MS: String(offset) },
  })
  const { before, after, epochGap } = JSON.parse(stdout)
  assert.ok(Math.abs(before.date - before.real - offset) < 10)
  assert.ok(Math.abs(epochGap - offset) < 10)
  assert.ok(after.monotonic - before.monotonic >= 100)
  assert.ok(Math.abs(after.date - before.date - (after.monotonic - before.monotonic)) < 10)
})
