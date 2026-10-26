import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitForAsyncCondition } from '../../scripts/async-readiness.mjs'

test('readiness retries fulfilled false results and waits for actual asynchronous completion', async () => {
  let calls = 0, active = 0, maxActive = 0
  const expected = { readyPairs: 861 }
  const actual = await waitForAsyncCondition(async () => {
    calls += 1; active += 1; maxActive = Math.max(maxActive, active)
    await sleep(5)
    active -= 1
    return calls === 3 ? expected : false
  }, { description: 'all prepared frames', timeoutMS: 1000, pollingMS: 1 })
  assert.equal(actual, expected)
  assert.equal(calls, 3)
  assert.equal(maxActive, 1, 'Retries must not overlap expensive IPC reads.')
})

test('permanently false readiness fails with its named condition', async () => {
  let calls = 0
  await assert.rejects(waitForAsyncCondition(async () => { calls += 1; return false }, {
    description: 'durable historical candle', timeoutMS: 50, pollingMS: 5,
  }), /Timed out after 50 ms waiting for durable historical candle/)
  assert.ok(calls > 1)
})

test('a pending readiness request cannot outlive the readiness deadline', async () => {
  let calls = 0
  await assert.rejects(waitForAsyncCondition(() => { calls += 1; return new Promise(() => {}) }, {
    description: 'stalled worker response', timeoutMS: 20, pollingMS: 1,
  }), /waiting for stalled worker response/)
  assert.equal(calls, 1)
})

test('readiness propagates source errors instead of retrying them as missing data', async () => {
  const sourceError = new Error('worker disconnected')
  await assert.rejects(waitForAsyncCondition(async () => { throw sourceError }, {
    description: 'worker data', timeoutMS: 1000,
  }), error => error === sourceError)
})
