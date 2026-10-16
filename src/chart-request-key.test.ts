import assert from 'node:assert/strict'
import test from 'node:test'
import { chartRequestKey, isCurrentChartViewportGeneration, retainViewportTimers } from './chart-request-key.ts'

test('returning to a viewport starts a new foreground generation instead of sharing its stale request', () => {
  const firstA = chartRequestKey('history', '1H:BTC-USDT-SWAP', 1_700_000_000_000, 4, 10)
  const middleB = chartRequestKey('history', '1H:BTC-USDT-SWAP', 1_699_996_400_000, 4, 11)
  const returnedA = chartRequestKey('history', '1H:BTC-USDT-SWAP', 1_700_000_000_000, 4, 12)
  const inFlight = new Set([firstA])

  assert.notEqual(firstA, middleB)
  assert.notEqual(firstA, returnedA)
  assert.equal(inFlight.has(returnedA), false)
})

test('same-viewport rerenders retain its retry deadline while viewport changes cancel old deadlines', () => {
  const timers = new Map([['1H:BTC:100', 1], ['1H:BTC:99', 2]])
  const cancelled: number[] = []

  retainViewportTimers(timers, '1H:BTC:100', timer => cancelled.push(timer))
  retainViewportTimers(timers, '1H:BTC:100', timer => cancelled.push(timer))
  assert.deepEqual([...timers], [['1H:BTC:100', 1]])
  assert.deepEqual(cancelled, [2])

  retainViewportTimers(timers, '1H:BTC:98', timer => cancelled.push(timer))
  assert.equal(timers.size, 0)
  assert.deepEqual(cancelled, [2, 1])
})

test('retry timers belong to a committed foreground generation, not only its viewport end', () => {
  const firstA = chartRequestKey('history', '1H:BTC-USDT-SWAP', 100, 4, 10)
  const committedB = chartRequestKey('history', '1H:BTC-USDT-SWAP', 99, 4, 11)
  const returnedA = chartRequestKey('history', '1H:BTC-USDT-SWAP', 100, 4, 12)
  const timers = new Map([[firstA, 1]])
  const cancelled: number[] = []

  // An interrupted B render never receives a token, so the committed A retry
  // remains valid and may still wake its current viewport.
  retainViewportTimers(timers, firstA, timer => cancelled.push(timer))
  assert.deepEqual([...timers], [[firstA, 1]])

  // Once B commits, returning to A owns a different generation. Its effect
  // must not see A's old timer and skip the new retry indefinitely.
  assert.notEqual(firstA, committedB)
  retainViewportTimers(timers, returnedA, timer => cancelled.push(timer))
  assert.equal(timers.size, 0)
  assert.deepEqual(cancelled, [1])
})

test('same-viewport effect cleanup does not invalidate its in-flight generation', () => {
  const request = { cacheKey: '1H:BTC-USDT-SWAP', end: 1_700_000_000_000, focusToken: 12 }
  assert.equal(isCurrentChartViewportGeneration({ ...request }, request), true)

  // A -> B -> A has the same logical end but a newer foreground token, so
  // the earlier A response must still be discarded.
  assert.equal(isCurrentChartViewportGeneration({ ...request, focusToken: 14 }, request), false)
  assert.equal(isCurrentChartViewportGeneration({ ...request, end: request.end - 3_600_000 }, request), false)
})
