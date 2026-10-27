import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, stat, utimes, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOperationSession, enforceOperationRetention, DEFAULT_OPERATION_RETENTION } from '../../electron/services/operation-retention.js'
import { gzipSync } from 'node:zlib'
import { encodeOperationJournal, operationJournalSuffix } from '../../electron/services/operation-journal.js'

const now = 1_800_000_000_000, day = 86_400_000
const dead = () => false
async function fixture(directory, { pid = 765432, schema = 2, health = {}, bytes = 1024, at = now } = {}) {
  await mkdir(directory, { recursive: true })
  const executionId = `${pid}-0-${randomUUID()}`, participantId = randomUUID()
  await writeFile(join(directory, `${executionId}.jsonl`), Buffer.alloc(bytes, 10))
  const value = { ...(schema === 2 ? { schemaVersion: 2, participantId, role: 'fixture', sourceFailures: 0, omittedRecords: 0, activeOperations: 0 } : {}),
    recorded: 2, persisted: 2, failed: 0, pending: 0, closed: true, executionId, ...health }
  await writeFile(join(directory, `${executionId}.health.json`), JSON.stringify(value))
  if (schema === 2) await writeFile(join(directory, `${participantId}.participant.json`), JSON.stringify({ schemaVersion: 2, id: participantId, status: 'ready', role: 'fixture', executionId }))
  for (const name of await readdir(directory)) if (name !== 'session.retention.json') await utimes(join(directory, name), at / 1000, at / 1000)
  return { executionId, participantId }
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'perp-operation-retention-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })

test('retention expires closed legacy sessions whole by age then capacity, retaining an explicit deletion audit', async t => {
  const root = await temporary(t), old = `${now - 10 * day}-765432`, recent = `${now - day}-765433`
  await fixture(join(root, old), { schema: 1, at: now - 9 * day })
  await fixture(join(root, recent), { at: now - day })
  const aged = await enforceOperationRetention(root, { now: () => now, maxBytes: Number.MAX_SAFE_INTEGER, isProcessAlive: dead })
  assert.deepEqual(aged.pruned.map(value => [value.id, value.reason]), [[old, 'age']])
  assert.equal(await exists(join(root, old)), false)
  assert.equal(await exists(join(root, recent)), true)
  const capacity = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.deepEqual(capacity.pruned.map(value => [value.id, value.reason]), [[recent, 'capacity']])
  assert.equal(await exists(join(root, recent)), false)
  const audit = (await readFile(join(root, capacity.auditFile), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(audit.map(value => value.phase), ['scheduled', 'deleted', 'scheduled', 'deleted'])
  assert.ok(capacity.metadataBytes > 0)
  assert.equal(capacity.retainedBytes, capacity.metadataBytes)
  assert.equal(capacity.overBudgetBytes, capacity.metadataBytes)
  const persisted = JSON.parse(await readFile(join(root, 'retention.json'), 'utf8'))
  assert.equal(persisted.state, 'over-budget')
  assert.equal(persisted.pruned[0].id, recent)
})

test('whole-session retention recognizes closed current journals and both legacy encodings', async t => {
  const root = await temporary(t), ids = []
  const formats = [['.jsonl', value => value], ['.jsonl.gz', gzipSync], [operationJournalSuffix, encodeOperationJournal]]
  for (const [index, [suffix, encode]] of formats.entries()) {
    const id = `${now - day}-${765432 + index}`, directory = join(root, id)
    const { executionId } = await fixture(directory, { pid: 765432 + index, health: { durableRecords: 2 }, at: now - day })
    const plain = join(directory, `${executionId}.jsonl`), file = join(directory, `${executionId}${suffix}`)
    const stored = encode(await readFile(plain))
    if (file !== plain) await rename(plain, file)
    await writeFile(file, stored)
    ids.push(id)
  }
  const result = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.deepEqual(result.pruned.map(value => value.id).sort(), ids.sort())
  assert.deepEqual(result.failures, [])
  for (const id of ids) assert.equal(await exists(join(root, id)), false)
})

test('leases preserve active and crashed sessions and surface protected over-budget data', async t => {
  const root = await temporary(t)
  const active = await createOperationSession({ root, now: () => now, pid: process.pid })
  await fixture(active.directory, { pid: process.pid, health: { closed: false, persisted: 0, pending: 2 } })
  const crashed = await createOperationSession({ root, now: () => now - 10 * day, pid: 765432 })
  await fixture(crashed.directory, { health: { closed: false, persisted: 0, pending: 2 }, at: now - 10 * day })
  const before = await readFile(join(active.directory, (await readdir(active.directory)).find(name => name.endsWith('.jsonl'))))
  const status = await enforceOperationRetention(root, { now: () => now, maxBytes: 1, isProcessAlive: pid => pid === process.pid })
  assert.equal(status.sessions.find(value => value.id === active.id).state, 'active')
  assert.equal(status.sessions.find(value => value.id === crashed.id).state, 'interrupted')
  assert.equal(status.pruned.length, 0)
  assert.ok(status.protectedBytes > 2048)
  assert.equal(status.state, 'over-budget')
  assert.ok(status.overBudgetBytes > 0)
  assert.ok(status.expiredProtectedSessions > 0)
  assert.deepEqual(await readFile(join(active.directory, (await readdir(active.directory)).find(name => name.endsWith('.jsonl')))), before)
})

test('fractional filesystem times remain valid across interrupted legacy cleanup and retry', async t => {
  const root = await temporary(t), id = `${now - day}-765432`, token = randomUUID()
  await fixture(join(root, id), { schema: 1, at: now - day + 0.625 })
  const initial = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.deepEqual(initial.pruned.map(value => value.id), [id], 'Actual filesystem mtimes may contain fractional milliseconds.')
  assert.deepEqual(initial.failures, [])
  const quarantine = join(root, `.pruning-${token}`)
  await fixture(quarantine, { schema: 1, at: now - day + 0.625 })
  await writeFile(join(quarantine, 'session.retention.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'perpetual-swap-operation-session', id, token: randomUUID(), pid: 765432,
    createdAt: now - day, updatedAt: now, state: 'closed', closedAt: now - day + 0.625,
    prune: { token, reason: 'capacity', requestedAt: now } }))
  const recovered = await enforceOperationRetention(root, { now: () => now, maxBytes: Number.MAX_SAFE_INTEGER, isProcessAlive: dead })
  assert.deepEqual(recovered.pruned.map(value => [value.id, value.reason]), [[id, 'interrupted-prune']])
  assert.equal(await exists(quarantine), false)
  assert.deepEqual(recovered.failures, [])
})

test('session heartbeat and close serialize atomically and completion requires every recorder to close durably', async t => {
  const root = await temporary(t), session = await createOperationSession({ root, now: () => now })
  await fixture(session.directory, { pid: process.pid, health: { durableRecords: 2 } })
  const beat = session.heartbeat(), closing = session.close()
  assert.equal(session.close(), closing)
  await Promise.all([beat, closing, session.heartbeat()])
  assert.equal(JSON.parse(await readFile(join(session.directory, 'session.retention.json'), 'utf8')).state, 'closed')
  assert.ok((await readdir(session.directory)).every(name => !name.startsWith('.tmp-')))
  const status = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: () => true })
  assert.ok(status.pruned.some(value => value.id === session.id), 'Explicitly closed healthy owned sessions may expire while their process remains alive.')
  const incomplete = await createOperationSession({ root, now: () => now })
  await fixture(incomplete.directory, { health: { durableRecords: 1 } })
  await assert.rejects(incomplete.close(), /healthy and closed/)
  assert.equal(JSON.parse(await readFile(join(incomplete.directory, 'session.retention.json'), 'utf8')).state, 'interrupted')
  assert.equal((await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })).pruned.length, 0)
  assert.equal(await exists(incomplete.directory), true)
})

test('legacy migration protects live child PIDs, inconsistent counts and unclaimed participants', async t => {
  const root = await temporary(t), live = `${now - day}-765432`, damaged = `${now - day}-765434`, unclaimed = `${now - day}-765435`
  await fixture(join(root, live), { schema: 1, pid: 765433 })
  await fixture(join(root, damaged), { health: { recorded: 3 } })
  await fixture(join(root, unclaimed))
  const id = randomUUID()
  await writeFile(join(root, unclaimed, `${id}.participant.json`), JSON.stringify({ schemaVersion: 2, id, role: 'child', status: 'registered' }))
  const status = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: pid => pid === 765433 })
  assert.equal(status.pruned.length, 0)
  assert.equal(status.sessions.find(value => value.id === live).state, 'active')
  assert.equal(status.sessions.find(value => value.id === damaged).state, 'interrupted')
  assert.equal(status.sessions.find(value => value.id === unclaimed).state, 'interrupted')
  assert.equal(await exists(join(root, live)), true)
})

test('retention never follows symlinks or deletes unknown user files and reports unmeasured nested data', async t => {
  const root = await temporary(t), outside = await temporary(t), name = `${now - day}-765432`
  await fixture(join(root, name))
  const secret = join(outside, 'user.txt'); await writeFile(secret, 'must survive')
  await symlink(secret, join(root, name, 'unrelated.txt'))
  await symlink(outside, join(root, 'linked-session'))
  await mkdir(join(root, 'unrecognized', 'nested'), { recursive: true })
  await writeFile(join(root, 'unrecognized', 'nested', 'user.db'), Buffer.alloc(4096))
  const status = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.equal(status.pruned.length, 0)
  assert.equal(status.state, 'blocked')
  assert.equal(status.unmeasuredPaths, 1)
  assert.equal(await readFile(secret, 'utf8'), 'must survive')
  assert.equal(await exists(join(root, name)), true)
  const linkedRoot = join(root, 'outside-root'); await symlink(outside, linkedRoot)
  await assert.rejects(enforceOperationRetention(linkedRoot), /real directory/)
  await assert.rejects(createOperationSession({ root: linkedRoot }), /real directory/)
})

test('deletion audits rotate within two bounded segments and refuse foreign or symlinked audit files', async t => {
  const root = await temporary(t), name = `${now - day}-765432`
  await fixture(join(root, name))
  const header = `${JSON.stringify({ schemaVersion: 1, kind: 'perpetual-swap-operation-retention' })}\n`
  const padding = JSON.stringify({ schemaVersion: 1, kind: 'perpetual-swap-operation-retention', padding: 'x'.repeat(500) }) + '\n'
  const content = header + padding.repeat(Math.floor((256 * 1024 - header.length - 50) / padding.length))
  await writeFile(join(root, 'retention-deletions.ndjson'), content)
  // Reserve only enough remaining bytes for neither scheduled nor deleted line.
  await writeFile(join(root, 'retention-deletions.ndjson'), ' '.repeat(256 * 1024 - content.length - 10), { flag: 'a' })
  const status = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.equal(status.pruned.length, 1)
  assert.ok((await stat(join(root, 'retention-deletions.ndjson'))).size <= 256 * 1024)
  assert.ok((await stat(join(root, 'retention-deletions.1.ndjson'))).size <= 256 * 1024)
  const other = await temporary(t), otherName = `${now - day}-765433`, outside = join(other, 'user.txt')
  await fixture(join(other, otherName)); await writeFile(outside, 'private user content')
  await symlink(outside, join(other, 'retention-deletions.ndjson'))
  await assert.rejects(enforceOperationRetention(other, { now: () => now, maxBytes: 0, isProcessAlive: dead }), /Unsafe operation retention metadata/)
  assert.equal(await readFile(outside, 'utf8'), 'private user content')
  assert.equal(await exists(join(other, otherName)), true)
})

test('a live cleanup lock blocks another sweeper without mutating sessions or claiming measured bytes', async t => {
  const root = await temporary(t), name = `${now - day}-765432`
  await fixture(join(root, name))
  await writeFile(join(root, 'retention.lock'), JSON.stringify({ schemaVersion: 1, kind: 'perpetual-swap-operation-retention', pid: process.pid }))
  const busy = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: () => true })
  assert.equal(busy.state, 'blocked'); assert.equal(busy.busy, true); assert.equal(busy.unmeasuredPaths, 1)
  assert.equal(await exists(join(root, name)), true)
  const finished = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.equal(finished.pruned.length, 1, 'A dead valid cleanup lease is reclaimed.')
  assert.deepEqual(DEFAULT_OPERATION_RETENTION, { maxAgeMS: 7 * day, maxBytes: 512 * 1024 * 1024 })
})


test('retention validates portable graphics paths and preserves incomplete native captures', async t => {
  const root = await temporary(t), ids = [`${now - day}-765432`, `${now - day}-765433`]
  for (const [index, id] of ids.entries()) {
    const directory = join(root, id), prefix = `chromium-765432-${randomUUID()}`
    await fixture(directory)
    await writeFile(join(directory, `${prefix}.trace.json`), '{}')
    await writeFile(join(directory, `${prefix}.status.json`), JSON.stringify({ schemaVersion: 2,
      enabled: true, complete: index === 0, file: `${prefix}.trace.json` }))
  }
  const result = await enforceOperationRetention(root, { now: () => now, maxBytes: 0, isProcessAlive: dead })
  assert.deepEqual(result.pruned.map(value => value.id), [ids[0]])
  assert.equal(result.sessions.find(value => value.id === ids[1]).state, 'interrupted')
  assert.equal(await exists(join(root, ids[1])), true)
})
