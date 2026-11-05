import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite, { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { databaseOperation, installRecordedSQLite, openRecordedDatabase, recordedDatabase } from '../../electron/services/recorded-database.js'
import { constructRecordedWebSocket, recordedWebSocketFactory } from '../../electron/services/network-operations.js'
import { attachOperationSink, configureOperationContext, hasOperationRecording } from '../../electron/services/operations.js'

// The normal test sandbox preloads a recorder. Exercise the production policy
// in a fresh process, while still running this file as part of that suite.
if (hasOperationRecording()) {
  test('disabled recording paths in an uninstrumented process', () => {
    const child = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PERPETUAL_SWAP_OPERATION_DIR: '' },
    })
    if (child.error) throw child.error
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  })
} else {
test('disabled database tracing avoids instrumentation and preserves SQLite transactions and iteration', () => {
  assert.equal(hasOperationRecording(), false)
  let clockReads = 0
  configureOperationContext({}, () => { clockReads++; return 0 })
  const metadata = new Proxy({}, { ownKeys() { throw new Error('telemetry metadata was read') } })
  const failure = new Error('transaction failed')
  const database = openRecordedDatabase(DatabaseSync, ':memory:', undefined, metadata)
  try {
    assert.equal(recordedDatabase(database, metadata), database)
    assert.equal(databaseOperation('setup', () => {
      database.exec('CREATE TABLE candles (value INTEGER); BEGIN; INSERT INTO candles VALUES (1); COMMIT')
      return 42
    }, metadata, metadata), 42)
    assert.throws(() => databaseOperation('rollback', () => {
      database.exec('BEGIN; INSERT INTO candles VALUES (2)')
      try { throw failure } finally { database.exec('ROLLBACK') }
    }, metadata), error => error === failure)
    assert.deepEqual([...database.prepare('SELECT value FROM candles').iterate()].map(row => row.value), [1])
    assert.equal(clockReads, 0)

    class FakeDatabase { exec() {} }
    const original = FakeDatabase.prototype.exec
    const module = { DatabaseSync: FakeDatabase }
    assert.equal(installRecordedSQLite(module), false)
    assert.equal(module.DatabaseSync, FakeDatabase)
    assert.equal(FakeDatabase.prototype.exec, original)
  } finally { database.close() }
})

test('disabled WebSocket tracing leaves transports and their business listeners untouched', () => {
  assert.equal(hasOperationRecording(), false)
  const url = { toString() { throw new Error('URL was inspected') } }
  const attributes = new Proxy({}, { ownKeys() { throw new Error('telemetry attributes were inspected') } })
  const listeners = new Map(), sent = []
  const socket = Object.freeze({
    readyState: 1,
    addEventListener(type, listener) { assert.equal(this, socket); listeners.set(type, listener) },
    removeEventListener(type) { assert.equal(this, socket); listeners.delete(type) },
    send(value) { assert.equal(this, socket); sent.push(value) },
    close() { assert.equal(this, socket); sent.push('closed') },
  })
  const failure = new Error('connection failed')
  const factory = function (input) { assert.equal(this, undefined); assert.equal(input, url); return socket }
  const holder = { connect: recordedWebSocketFactory(factory, 'test') }
  assert.equal(holder.connect(url), socket)
  assert.equal(constructRecordedWebSocket(() => socket, url, attributes), socket)
  assert.equal(listeners.size, 0)
  let received
  socket.addEventListener('message', event => { received = event.data })
  listeners.get('message')({ data: 'market update' })
  socket.send('subscribe')
  socket.close()
  assert.equal(received, 'market update')
  assert.deepEqual(sent, ['subscribe', 'closed'])
  assert.throws(() => recordedWebSocketFactory(() => { throw failure }, 'test')(url), error => error === failure)
  assert.throws(() => constructRecordedWebSocket(() => { throw failure }, url, attributes), error => error === failure)
})

test('a detached WebSocket recorder stops inspecting traffic and removes only its own listeners', () => {
  const stop = attachOperationSink(() => {})
  const listeners = new Map(), sent = []
  const socket = Object.freeze({
    readyState: 1,
    addEventListener(type, listener) {
      assert.equal(this, socket)
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { assert.equal(this, socket); listeners.get(type)?.delete(listener) },
    send(value) { assert.equal(this, socket); sent.push(value) },
    close() { assert.equal(this, socket); sent.push('closed') },
  })
  let received = 0
  socket.addEventListener('message', () => received++)
  try {
    const recorded = recordedWebSocketFactory(() => socket, 'test')('ws://localhost/feed')
    stop()
    const payload = { get size() { throw new Error('payload was inspected') } }
    recorded.send(payload)
    recorded.close()
    const event = { get data() { throw new Error('message was inspected') }, get code() { throw new Error('close was inspected') } }
    for (const listener of listeners.get('message')) listener(event)
    for (const listener of listeners.get('close')) listener(event)
    assert.equal(received, 1)
    assert.equal(listeners.get('message').size, 1)
    assert.deepEqual(sent, [payload, 'closed'])
  } finally { stop() }
})

test('installed SQLite hooks bypass recording after detachment, including constructors and backup', async () => {
  const events = []
  const stop = attachOperationSink(event => events.push(event))
  const directory = mkdtempSync(join(tmpdir(), 'recording-fast-path-'))
  let database, second, readOnly
  try {
    assert.equal(installRecordedSQLite(sqlite), true)
    database = openRecordedDatabase(sqlite.DatabaseSync, ':memory:', {}, 'market')
    database.exec('CREATE TABLE candles (value INTEGER); INSERT INTO candles VALUES (1)')
    const statement = database.prepare('SELECT value FROM candles ORDER BY value')
    const prepare = database.prepare, iterate = statement.iterate
    assert.equal(events.filter(event => event.name === 'sqlite.open').length, 1)
    stop()

    database.exec('BEGIN; INSERT INTO candles VALUES (2); COMMIT')
    assert.deepEqual([...iterate()].map(row => row.value), [1, 2])
    assert.equal(prepare('SELECT COUNT(*) AS count FROM candles').get().count, 2)
    second = new sqlite.DatabaseSync(':memory:')
    second.exec('CREATE TABLE test (value INTEGER)')
    const backupPath = join(directory, 'backup.sqlite')
    await sqlite.backup(database, backupPath)
    readOnly = openRecordedDatabase(sqlite.DatabaseSync, backupPath, { readOnly: true }, 'reader')
    assert.deepEqual([...readOnly.prepare('SELECT value FROM candles ORDER BY value').iterate()].map(row => row.value), [1, 2])
    assert.throws(() => readOnly.exec('INSERT INTO candles VALUES (3)'), /readonly/i)
  } finally {
    stop()
    readOnly?.close()
    second?.close()
    database?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
}
