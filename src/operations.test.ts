import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { attachOperationSink, attachOperationJournalSink, beginOperation, measureOperation, recordOperation, hookOperationMethods, getOperationContext,
  runWithOperationContext, withOperationSuppressed, type OperationEvent, type OperationJournalEvent } from '../electron/services/operations.js'
// @ts-expect-error Node-only JS intentionally stays outside the renderer API.
import { databaseOperation, openRecordedDatabase } from '../electron/services/recorded-database.js'

test('recording preserves synchronous values, thrown identity and async completion, with one terminal event', async t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  const spec = { category: 'cpu' as const, name: 'test.calculate' }, value = {}
  assert.equal(measureOperation(spec, () => value), value)
  const failure = new TypeError('sensitive error body')
  assert.throws(() => measureOperation(spec, () => { throw failure }), error => error === failure)
  let release!: (value: object) => void
  const pending = measureOperation(spec, () => new Promise<object>(resolve => { release = resolve }))
  assert.equal(events.length, 2)
  release(value)
  assert.equal(await pending, value)
  const span = beginOperation(spec)
  span.end({ status: 'cancelled' }); span.end()
  assert.deepEqual(events.map(event => event.status), ['ok', 'error', 'ok', 'cancelled'])
  assert.ok(events.every(event => event.durationMS >= 0 && event.startedAt > 0))
  assert.equal(JSON.stringify(events).includes(failure.message), false)
})

test('shared span methods preserve asynchronous rejection and cancellation without measuring CPU across await', async t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => { if (event.name.startsWith('test.promise')) events.push(event) })
  t.after(unsubscribe)
  const failure = new TypeError('private asynchronous failure')
  await assert.rejects(measureOperation({ category: 'cpu', name: 'test.promise.rejected' }, async () => {
    await Promise.resolve()
    throw failure
  }), error => error === failure)
  const cancelled = Object.assign(new Error('private cancellation'), { name: 'AbortError' })
  await assert.rejects(measureOperation({ category: 'cpu', name: 'test.promise.cancelled' }, () => Promise.reject(cancelled)), error => error === cancelled)
  assert.deepEqual(events.map(event => [event.status, event.cpuTimeMS]), [['error', undefined], ['cancelled', undefined]])
  assert.equal(JSON.stringify(events).includes('private'), false)
})

test('recording accepts diagnostic scalars and excludes arbitrary payloads', t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  measureOperation({ category: 'network', name: 'test.request', attributes: { rows: 4, bytes: 99, apiKey: 'secret', body: 'private' } }, () => 1)
  assert.deepEqual(events[0].attributes, { rows: 4, bytes: 99 })
  assert.equal(JSON.stringify(events).includes('secret'), false)
  const badSink = attachOperationSink(() => { throw Error('diagnostics must not throw into app') })
  t.after(badSink)
  assert.equal(measureOperation({ category: 'cpu', name: 'test.safe' }, () => 42), 42)
})

test('span execution retains its own ancestry and scenario while inheriting execution-time suppression', t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  const span = beginOperation({ category: 'cpu', name: 'test.trusted-span' })
  const expected = { ...span.context }
  const publicContext = span.context
  span.context.traceId = 'public-context-was-mutated'
  runWithOperationContext({ traceId: 'other-trace', parentId: 'other-parent', scenarioId: 'other-scenario' }, () => span.run(() => {
    assert.deepEqual(getOperationContext(), expected)
  }))
  withOperationSuppressed(() => span.run(() => measureOperation({ category: 'cpu', name: 'test.suppressed-child' }, () => 1)))
  assert.equal(events.length, 0, 'A span created outside suppression cannot re-enable recording inside a suppressed I/O callback.')
  span.end()
  assert.equal(span.context, publicContext)
  assert.deepEqual(events.map(event => event.name), ['test.trusted-span'])
})

test('late public context access uses captured ancestry after private execution and completion', t => {
  const unsubscribe = attachOperationSink(() => {})
  t.after(unsubscribe)
  const span = runWithOperationContext({ traceId: 'captured-trace', scenarioId: 'captured-scenario' }, () => beginOperation({ category: 'cpu', name: 'test.late-context' }))
  const expected = span.run(() => getOperationContext())
  span.end()
  runWithOperationContext({ traceId: 'other-trace', scenarioId: 'other-scenario' }, () => {
    assert.deepEqual(span.context, expected)
    span.context.scenarioId = 'public-mutation'
    assert.deepEqual(span.run(() => getOperationContext()), expected)
  })
})

test('journal sink mutations cannot contaminate the private terminal attribute baseline', t => {
  const journal: OperationJournalEvent[] = [], unsubscribe = attachOperationJournalSink(event => {
    if (event.name !== 'test.sink-mutation') return
    if (event.phase === 'start') {
      assert.ok(event.attributes)
      Object.assign(event.attributes, { secret: 'private-body', rows: { payload: 'private-body' }, count: 99 })
    }
    journal.push(event)
  })
  t.after(unsubscribe)
  const span = beginOperation({ category: 'cpu', name: 'test.sink-mutation', attributes: { rows: 3, count: 4 } })
  span.end({ attributes: { count: 7 } })
  assert.deepEqual(journal[1].attributes, { rows: 3, count: 7 })
  assert.equal(JSON.stringify(journal[1]).includes('private-body'), false)
})

test('terminal attributes validate only new values and preserve deletion of invalid overrides', t => {
  const journal: OperationJournalEvent[] = [], unsubscribe = attachOperationJournalSink(event => { if (event.name === 'test.attribute-overrides') journal.push(event) })
  t.after(unsubscribe)
  const span = beginOperation({ category: 'cpu', name: 'test.attribute-overrides', attributes: { rows: 3, count: 4, reason: 'initial', bytes: 9 } })
  const original = structuredClone(journal[0].attributes)
  span.end({ attributes: { rows: NaN, count: 7, reason: 'x'.repeat(161), bytes: undefined, secret: 'not-recorded' } as unknown as Record<string, string | number> })
  assert.deepEqual(journal[0].attributes, original, 'Completing a span does not mutate its already emitted start attributes.')
  assert.deepEqual(journal[1].attributes, { count: 7 })
  assert.equal(JSON.stringify(journal).includes('not-recorded'), false)
})

test('terminal attribute ownership cannot mutate emitted starts or cause an ended span to publish again', t => {
  const journal: OperationJournalEvent[] = [], unsubscribe = attachOperationJournalSink(event => {
    if (event.name !== 'test.terminal-ownership') return
    journal.push(event)
    if (event.phase === 'end') Object.assign(event.attributes!, { count: 99, secret: 'terminal-observer-only' })
  })
  t.after(unsubscribe)
  for (const overrides of [undefined, { count: 6, rows: Number.NaN }]) {
    journal.length = 0
    const input = { rows: 3, count: 4 }, originalOverrides = overrides && { ...overrides }
    const span = beginOperation({ category: 'cpu', name: 'test.terminal-ownership', attributes: input })
    const start = structuredClone(journal[0])
    span.end({ attributes: overrides })
    span.end({ status: 'error', attributes: { count: 10 } })
    assert.equal(span.run(() => 42), 42)
    assert.equal(journal.length, 2)
    assert.deepEqual(journal[0], start)
    assert.deepEqual(input, { rows: 3, count: 4 })
    assert.deepEqual(overrides, originalOverrides)
    assert.equal(journal[1].attributes?.rows, overrides ? undefined : 3)
  }
})

test('completed observations retain their original facts when a start observer mutates the caller input', t => {
  const original = { category: 'cpu' as const, name: 'test.observation-snapshot', startedAt: 1000, durationMS: 12,
    status: 'ok' as 'ok' | 'error', cpuTimeMS: 7, attributes: { rows: 3 } }
  const events: OperationJournalEvent[] = []
  t.after(attachOperationJournalSink(event => {
    if (event.name !== original.name) return
    events.push(event)
    if (event.phase === 'start') {
      original.status = 'error'; original.durationMS = 99; original.cpuTimeMS = 88
      original.attributes.rows = 999
      Object.assign(event.attributes!, { rows: 777, secret: 'observer-only' })
    }
  }))
  recordOperation(original)
  assert.equal(events.length, 2)
  assert.equal(events[1].status, 'ok')
  assert.equal(events[1].durationMS, 12)
  assert.equal(events[1].cpuTimeMS, 7)
  assert.deepEqual(events[1].attributes, { rows: 3 })
})

test('static method metadata owns its registration snapshot while each invocation owns mutable attributes and context', t => {
  const observed: OperationJournalEvent[] = []
  t.after(attachOperationJournalSink(event => {
    if (event.name !== 'test.static-hook') return
    observed.push(structuredClone(event))
    Object.assign(event.attributes!, { rows: 999, secret: 'observer-only' })
  }))
  const original = { category: 'cpu' as const, name: 'test.static-hook', resource: 'original', attributes: { rows: 3, count: 4 } }
  const target = { factor: 2, calculate(value: number) { return { value: this.factor * value, context: getOperationContext() } } }
  hookOperationMethods(target, { calculate: original })
  original.name = 'changed-after-registration'; original.resource = 'changed-after-registration'
  Object.assign(original.attributes, { rows: 100, count: Number.NaN })
  for (let index = 0; index < 2; index++) {
    const result = runWithOperationContext({ traceId: `static-trace-${index}`, scenarioId: `static-scenario-${index}` }, () => target.calculate(index + 1))
    assert.equal(result.value, (index + 1) * 2)
    assert.equal(result.context.traceId, `static-trace-${index}`)
  }
  assert.equal(observed.length, 4)
  for (const [index, event] of observed.entries()) {
    assert.equal(event.resource, 'original')
    assert.deepEqual(event.attributes, { rows: 3, count: 4 })
    assert.equal(event.traceId, `static-trace-${Math.floor(index / 2)}`)
    assert.equal(event.scenarioId, `static-scenario-${Math.floor(index / 2)}`)
  }
})

test('dynamic method metadata is validated for every invocation even when its factory reuses one object', t => {
  const events: OperationEvent[] = []
  t.after(attachOperationSink(event => { if (event.name === 'test.dynamic-hook') events.push(event) }))
  const specification = { category: 'cpu' as const, name: 'test.dynamic-hook', attributes: { rows: 1 } }
  const target = { calculate(value: number) { return value } }
  hookOperationMethods(target, { calculate: value => { specification.attributes.rows = value; return specification } })
  assert.equal(target.calculate(7), 7)
  assert.ok(Number.isNaN(target.calculate(Number.NaN)))
  assert.deepEqual(events.map(event => event.attributes), [{ rows: 7 }, {}])
})

test('a bulk database operation separates API calls from execution batches without recording bound values', t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  const database = openRecordedDatabase(DatabaseSync, ':memory:', {}, 'fixture')
  t.after(() => database.close())
  database.exec('CREATE TABLE data (value TEXT)')
  const insert = database.prepare('INSERT INTO data VALUES (?)')
  events.length = 0
  databaseOperation('market.append', () => {
    database.exec('BEGIN')
    insert.run('credential-should-never-be-logged')
    insert.run('second')
    database.exec('COMMIT')
    assert.equal(database.prepare('SELECT value FROM data').all().length, 2)
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'market.append')
  assert.deepEqual(events[0].attributes, { calls: 6, queryCount: 5, rows: 2, changes: 2 })
  assert.equal(JSON.stringify(events).includes('credential'), false)
  assert.throws(() => databaseOperation('market.failed', () => database.exec('SELECT missing FROM data')))
  assert.equal(events.at(-1)?.status, 'error')
})

test('database counters exclude metadata rows and count multi-statement exec as one execution batch', t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  const database = openRecordedDatabase(DatabaseSync, ':memory:', {}, 'fixture')
  t.after(() => database.close())
  assert.deepEqual(events[0].attributes, { role: 'fixture', calls: 1, queryCount: 0, rows: 0, changes: 0 })
  database.exec('CREATE TABLE data (value INTEGER); INSERT INTO data VALUES (1), (2)')
  assert.equal(events.at(-1)?.attributes?.queryCount, 1)
  events.length = 0
  databaseOperation('market.inspect', () => {
    const statement = database.prepare('SELECT value, 99 AS changes FROM data ORDER BY value')
    assert.equal(statement.columns().length, 2)
    assert.equal(statement.get().changes, 99)
    for (const row of statement.iterate()) { assert.equal(row.value, 1); break }
    database.exec('UPDATE data SET value = value + 1; UPDATE data SET value = value - 1')
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].attributes, { calls: 5, queryCount: 3, rows: 2, changes: 0 })
})

test('grouped iterators count consumed rows and record escaped consumption without changing completed groups', t => {
  const events: OperationEvent[] = [], unsubscribe = attachOperationSink(event => events.push(event))
  t.after(unsubscribe)
  const database = openRecordedDatabase(DatabaseSync, ':memory:', {}, 'fixture')
  t.after(() => database.close())
  database.exec('CREATE TABLE data (value INTEGER); INSERT INTO data VALUES (1), (2)')
  const statement = database.prepare('SELECT value FROM data ORDER BY value')
  events.length = 0
  let iterator!: Iterator<{ value: number }>
  databaseOperation('market.partial', () => {
    iterator = statement.iterate()
    assert.equal(iterator.next().value.value, 1)
  })
  const group = events[0]
  assert.equal(events.length, 1)
  assert.deepEqual(group.attributes, { calls: 1, queryCount: 1, rows: 1, changes: 0 })
  assert.equal(iterator.next().value.value, 2)
  assert.equal(events.length, 1, 'The escaped iterator remains lazy until completion.')
  assert.equal(iterator.next().done, true)
  assert.equal(events.length, 2)
  assert.deepEqual(group.attributes, { calls: 1, queryCount: 1, rows: 1, changes: 0 })
  assert.deepEqual(events[1].attributes, { role: 'fixture', measurement: 'iterator-consumption', calls: 0, queryCount: 0, rows: 1, changes: 0 })
})
