import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'

async function fixture(t) {
  // A separate identity/context registry cannot replace the test sandbox's own
  // active recorder or contaminate concurrent files' ancestry.
  const url = new URL('../../electron/services/operations.js', import.meta.url)
  url.searchParams.set('context-fixture', t.name)
  const api = await import(url.href), storage = new AsyncLocalStorage()
  let runs = 0
  api.configureOperationPropagation({ get: () => storage.getStore(), run: (context, operation) => { runs++; return storage.run(context, operation) } })
  return { api, storage, runs: () => runs }
}

test('captured context owns validated IDs independently of registration input and public snapshot mutations', async t => {
  const { api, storage } = await fixture(t)
  api.configureOperationContext({ scenarioId: 'registration-scenario' })
  const input = { traceId: 'registered-trace', parentId: 'registered-parent' }
  let snapshot
  const run = storage.run(input, () => {
    snapshot = api.getOperationContext()
    return api.captureOperationContext()
  })
  Object.assign(input, { traceId: 'mutated-input', parentId: 'mutated-input' })
  Object.assign(snapshot, { traceId: 'mutated-snapshot', parentId: 'mutated-snapshot', scenarioId: 'mutated-snapshot' })
  api.configureOperationContext({ scenarioId: 'later-default-scenario' })
  storage.run({ traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario' }, () => run(() => {
    assert.deepEqual(api.getOperationContext(), { traceId: 'registered-trace', parentId: 'registered-parent', scenarioId: 'registration-scenario' })
  }))
})

test('captured absent IDs remove foreign ancestry while retaining every other invocation field', async t => {
  const { api, storage } = await fixture(t)
  const run = storage.run({}, () => api.captureOperationContext())
  const token = Symbol('execution-field'), lane = { priority: 'interactive' }
  const invocation = { traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario', suppressed: true, lane, [token]: 'retained' }
  storage.run(invocation, () => run(() => {
    assert.deepEqual(api.getOperationContext(), {})
    const context = storage.getStore()
    assert.equal(context.suppressed, true)
    assert.equal(context.lane, lane)
    assert.equal(context[token], 'retained')
    for (const key of ['traceId', 'parentId', 'scenarioId']) assert.equal(Object.hasOwn(context, key), false)
  }))
  assert.equal(invocation.traceId, 'foreign-trace', 'Resuming cannot mutate the caller context.')
})

test('captured context inherits invocation suppression and observes later mutations of provider execution fields', async t => {
  const { api, storage } = await fixture(t), events = []
  t.after(api.attachOperationSink(event => events.push(event)))
  const registered = { traceId: 'registered-trace', parentId: 'registered-parent', scenarioId: 'registered-scenario' }
  const run = storage.run({ ...registered, suppressed: true, lane: 'registration-lane' }, () => api.captureOperationContext())
  const invocation = { traceId: 'foreign-trace', suppressed: false, lane: 'first-lane' }
  storage.run(invocation, () => run(() => {
    assert.equal(storage.getStore().lane, 'first-lane')
    api.measureOperation({ category: 'cpu', name: 'context.invocation-visible' }, () => 1)
  }))
  invocation.lane = 'second-lane'; invocation.suppressed = true
  storage.run(invocation, () => run(() => {
    assert.equal(storage.getStore().lane, 'second-lane')
    assert.equal(api.isOperationSuppressed(), true)
    api.measureOperation({ category: 'cpu', name: 'context.invocation-suppressed' }, () => 2)
  }))
  assert.deepEqual(events.map(event => event.name), ['context.invocation-visible'])
  assert.equal(events[0].traceId, registered.traceId)
  assert.equal(events[0].parentId, registered.parentId)
})

test('matching captured IDs reuse the live context and preserve suppression without entering another scope', async t => {
  const { api, storage, runs } = await fixture(t)
  const ids = { traceId: 'same-trace', parentId: 'same-parent', scenarioId: 'same-scenario' }
  const run = storage.run(ids, () => api.captureOperationContext())
  const invocation = { ...ids, suppressed: true, lane: 'call-time-lane' }
  const before = runs()
  storage.run(invocation, () => assert.equal(run(() => {
    assert.equal(storage.getStore(), invocation)
    assert.equal(api.isOperationSuppressed(), true)
    return 42
  }), 42))
  assert.equal(runs(), before, 'Identical IDs do not need another AsyncLocalStorage scope.')
})

test('captured context isolates asynchronous invocation fields and restores the caller after throws or await', async t => {
  const { api, storage } = await fixture(t)
  const ids = { traceId: 'registered-trace', parentId: 'registered-parent', scenarioId: 'registered-scenario' }
  const run = storage.run(ids, () => api.captureOperationContext())
  const failure = new TypeError('original context failure')
  const caller = { traceId: 'caller-trace', lane: 'outer' }
  storage.run(caller, () => {
    assert.throws(() => run(() => { throw failure }), error => error === failure)
    assert.equal(storage.getStore(), caller)
  })
  await Promise.all(['a', 'b'].map(lane => storage.run({ traceId: `foreign-${lane}`, lane }, async () => {
    await run(async () => {
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(api.getOperationContext(), ids)
      assert.equal(storage.getStore().lane, lane)
    })
    assert.deepEqual(api.getOperationContext(), { traceId: `foreign-${lane}` })
    assert.equal(storage.getStore().lane, lane)
  })))
})

test('captured contexts reject malformed provider IDs once and preserve current public validation behavior', async t => {
  const { api, storage } = await fixture(t)
  const run = storage.run({ traceId: 'invalid trace', parentId: {}, scenarioId: '\0invalid' }, () => api.captureOperationContext())
  storage.run({ traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario', lane: 3 }, () => run(() => {
    assert.deepEqual(api.getOperationContext(), {})
    assert.equal(storage.getStore().lane, 3)
  }))
  storage.run({ traceId: 'prior-trace', parentId: 'prior-parent', scenarioId: 'prior-scenario', lane: 4 }, () => {
    api.runWithOperationContext({ traceId: 'accepted-trace', parentId: 'invalid parent', scenarioId: undefined }, () => {
      assert.deepEqual(api.getOperationContext(), { traceId: 'accepted-trace' })
      assert.equal(storage.getStore().lane, 4)
    })
  })
})
