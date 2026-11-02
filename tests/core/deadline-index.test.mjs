import assert from 'node:assert/strict'
import test from 'node:test'
import { DeadlineIndex } from '../../electron/services/deadline-index.js'

test('bulk initialization preserves first insertion order and latest value', () => {
  const index = new DeadlineIndex([['a', 50], ['b', 10], ['a', 10], ['c', 20]])
  assert.equal(index.size, 3)
  assert.deepEqual(index.peek(), { key: 'a', deadline: 10 })
  assert.equal(index.get('c'), 20)
  index.delete('a')
  assert.deepEqual(index.peek(), { key: 'b', deadline: 10 })
  assert.throws(() => new DeadlineIndex([['a', -1]]), TypeError)
})

test('deadlines update, delete and retain insertion order for ties', () => {
  const index = new DeadlineIndex()
  assert.equal(index.size, 0)
  assert.equal(index.peek(), null)
  assert.equal(index.get('missing'), undefined)
  assert.equal(index.delete('missing'), false)
  index.set('a', 20); index.set('b', 10); index.set('c', 10)
  assert.equal(index.get('a'), 20)
  assert.deepEqual(index.peek(), { key: 'b', deadline: 10 })
  index.set('a', 10)
  assert.equal(index.get('a'), 10)
  assert.deepEqual(index.peek(), { key: 'a', deadline: 10 }, 'Updating preserves the original admission order.')
  index.set('a', 30)
  assert.deepEqual(index.peek(), { key: 'b', deadline: 10 })
  assert.equal(index.delete('b'), true)
  assert.equal(index.get('b'), undefined)
  assert.deepEqual(index.peek(), { key: 'c', deadline: 10 })
  index.set('b', 10)
  assert.deepEqual(index.peek(), { key: 'c', deadline: 10 }, 'Reinsertion starts a new lifetime.')
  index.delete('c'); index.delete('b'); index.delete('a')
  assert.equal(index.size, 0)
  assert.equal(index.peek(), null)
  index.set('a', 1); index.clear()
  assert.equal(index.size, 0)
  assert.equal(index.peek(), null)
  assert.equal(index.get('a'), undefined)
})

test('invalid deadlines cannot mutate a previously indexed entry', () => {
  const index = new DeadlineIndex()
  index.set('a', 0)
  for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => index.set('a', invalid), TypeError)
    assert.deepEqual(index.peek(), { key: 'a', deadline: 0 })
  }
  index.set('a', Number.MAX_SAFE_INTEGER)
  assert.deepEqual(index.peek(), { key: 'a', deadline: Number.MAX_SAFE_INTEGER })
})

test('repeated updates and deletions agree with a stable reference at scale', () => {
  const index = new DeadlineIndex(), expected = new Map()
  let seed = 0x136420
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
  for (let step = 0; step < 20_000; step++) {
    const key = random(1_000), deadline = random(100)
    if (random(5) === 0) assert.equal(index.delete(key), expected.delete(key))
    else { index.set(key, deadline); expected.set(key, deadline) }
    if (step % 31 === 0) {
      const next = [...expected].sort((a, b) => a[1] - b[1])[0]
      assert.deepEqual(index.peek(), next ? { key: next[0], deadline: next[1] } : null)
      assert.equal(index.size, expected.size)
      assert.equal(index.get(key), expected.get(key))
    }
  }
  for (const key of expected.keys()) index.delete(key)
  assert.equal(index.size, 0)
  assert.equal(index.peek(), null)
})
