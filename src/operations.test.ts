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

test('a bulk database operation counts statements and rows without recording bound values', t => {
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
  assert.deepEqual(events[0].attributes, { queryCount: 6, rows: 2, changes: 2 })
  assert.equal(JSON.stringify(events).includes('credential'), false)
  assert.throws(() => databaseOperation('market.failed', () => database.exec('SELECT missing FROM data')))
  assert.equal(events.at(-1)?.status, 'error')
})
