import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectOperationBoundaries, checkOperationBoundaries } from '../../scripts/check-operation-boundaries.mjs'

test('application child execution and SQLite construction cannot bypass their recorded boundary', () => {
  assert.deepEqual(checkOperationBoundaries(), [])
  for (const source of [
    "import { Worker as Background } from 'node:worker_threads'; new Background(url)",
    "import * as workers from 'node:worker_threads'; new workers.Worker(url)",
    "import { DatabaseSync as DB } from 'node:sqlite'; new DB(path)",
    "const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(path)",
    "import sqlite from 'node:sqlite'; new sqlite.DatabaseSync(path)",
    "import { fork as child } from 'node:child_process'; child(file)",
  ]) assert.equal(inspectOperationBoundaries(source, 'electron/services/example.js').length, 1, source)
  assert.deepEqual(inspectOperationBoundaries('createOperationWorker(url); openRecordedDatabase(DatabaseSync, path)', 'electron/services/example.js'), [])
})
