import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { encodeOperationJournal, readOperationJournal, operationJournalSuffix, isOperationJournal, operationJournalExecutionId } from '../../electron/services/operation-journal.js'

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'operation-journal-codec-'))
  try { return await operation(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
async function decode(path) {
  const chunks = []
  for await (const chunk of readOperationJournal(path)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('bounded journal frames preserve arbitrary bytes, Unicode and empty checkpoints across file chunks', () => fixture(async directory => {
  const raw = Buffer.concat([Buffer.from('Unicode: 界\n'), randomBytes(3 * 1024 * 1024 + 17)])
  const empty = encodeOperationJournal(Buffer.alloc(0)), encoded = encodeOperationJournal(raw)
  const path = join(directory, `execution${operationJournalSuffix}`)
  await writeFile(path, Buffer.concat([empty, encoded, empty]))
  assert.deepEqual(await decode(path), raw)
  await writeFile(path, empty)
  assert.deepEqual(await decode(path), Buffer.alloc(0))
  assert.equal(isOperationJournal(path), true)
  assert.equal(operationJournalExecutionId(`execution${operationJournalSuffix}`), 'execution')
}))

test('framed journals reject corrupt data, altered lengths, trailing bytes and every kind of torn frame', () => fixture(async directory => {
  const first = encodeOperationJournal(Buffer.from('first complete checkpoint\n'))
  const second = encodeOperationJournal(Buffer.from('second checkpoint\n'))
  const checksum = Buffer.from(first); checksum[15] ^= 1
  const payload = Buffer.from(first); payload[payload.length - 1] ^= 1
  const swallowed = Buffer.concat([first, second]); swallowed.writeUInt32BE(swallowed.length - 16, 4)
  const oversizedRaw = Buffer.from(first); oversizedRaw.writeUInt32BE(1024 * 1024 + 1, 8)
  const oversizedPayload = Buffer.from(first); oversizedPayload.writeUInt32BE(0xffffffff, 4)
  const wrongDecodedSize = Buffer.from(first); wrongDecodedSize.writeUInt32BE(1, 8)
  const badMagic = Buffer.from(first); badMagic[0] ^= 1
  const cases = [Buffer.alloc(0), first.subarray(0, 7), first.subarray(0, first.length - 1), checksum, payload,
    swallowed, oversizedRaw, oversizedPayload, wrongDecodedSize, badMagic, Buffer.concat([first, Buffer.from('trailing')])]
  for (const [index, bytes] of cases.entries()) {
    const path = join(directory, `corrupt-${index}${operationJournalSuffix}`)
    await writeFile(path, bytes)
    await assert.rejects(decode(path), undefined, `Corruption case ${index} cannot be accepted.`)
  }
  const torn = join(directory, `torn${operationJournalSuffix}`)
  await writeFile(torn, Buffer.concat([first, second.subarray(0, second.length - 1)]))
  const recovered = []
  await assert.rejects(async () => { for await (const chunk of readOperationJournal(torn)) recovered.push(chunk) }, /Truncated/)
  assert.deepEqual(Buffer.concat(recovered), Buffer.from('first complete checkpoint\n'), 'Complete checkpoints remain readable while the torn tail still fails.')
}))

test('saved plain and gzip journals remain reviewable alongside framed journals', () => fixture(async directory => {
  const raw = Buffer.from('{"saved":"界"}\n')
  for (const [suffix, stored] of [['.jsonl', raw], ['.jsonl.gz', gzipSync(raw)], [operationJournalSuffix, encodeOperationJournal(raw)]]) {
    const name = `saved${suffix}`, path = join(directory, name)
    assert.equal(isOperationJournal(name), true)
    assert.equal(operationJournalExecutionId(name), 'saved')
    await writeFile(path, stored)
    assert.deepEqual(await decode(path), raw)
  }
  assert.equal(isOperationJournal('saved.health.json'), false)
}))
