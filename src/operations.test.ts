import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { attachOperationSink, beginOperation, measureOperation, type OperationEvent } from '../electron/services/operations.js'
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
