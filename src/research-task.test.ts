import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { ResearchJob } from './research-types.ts'
import { researchByteSize, researchDuration, researchFilePercent, researchWaiting } from './research-task.ts'

const downloading = (): ResearchJob => ({ id: 'job', phase: 'preparing', completed: 0, total: 3, message: 'archive.zip', error: '', updatedAt: 1000,
  preparation: { stage: 'downloading', filename: 'archive.zip', instrument: 'BTC-USDT-SWAP', receivedBytes: 250, totalBytes: 1000, pages: 0 } })

test('file progress uses actual bytes and treats unknown lengths as indeterminate', () => {
  const job = downloading()
  assert.equal(researchFilePercent(job), 25)
  job.preparation!.totalBytes = undefined
  assert.equal(researchFilePercent(job), undefined)
  job.preparation!.stage = 'fetching'; job.preparation!.fraction = 0.75
  assert.equal(researchFilePercent(job), 75)
})

test('slow and small downloads retain visible byte and time precision', () => {
  assert.equal(researchByteSize(500), '500 B')
  assert.equal(researchByteSize(0.5), '0.5 B')
  assert.equal(researchByteSize(1250), '1.25 KB')
  assert.equal(researchByteSize(2_500_000), '2.5 MB')
  assert.equal(researchDuration(undefined), 'Estimating…')
  assert.equal(researchDuration(Infinity), 'Estimating…')
  assert.equal(researchDuration(61.2), '1m 2s')
  assert.equal(researchDuration(90000), '1d 1h')
})

test('stalled network feedback is distinct from failures and local import work', () => {
  const job = downloading()
  assert.equal(researchWaiting(job, 15000), '')
  assert.match(researchWaiting(job, 16000), /No data received for 15s.*no error/)
  job.phase = 'failed'
  assert.equal(researchWaiting(job, 16000), '')
  job.phase = 'preparing'; job.preparation!.stage = 'importing'
  assert.equal(researchWaiting(job, 16000), '')
})

test('archive directory scans have waiting feedback before file downloads begin', () => {
  const job: ResearchJob = { id: 'planning', phase: 'planning', completed: 4, total: 10, message: 'Checking spread archive catalog', error: '', updatedAt: 1000,
    catalog: { kind: 'spread', completed: 4, total: 10, message: 'Checking spread archive catalog', waitingForResponse: true, remainingSeconds: 60 } }
  assert.match(researchWaiting(job, 21000), /No data received for 20s/)
  job.catalog!.waitingForResponse = false
  assert.equal(researchWaiting(job, 21000), '')
})
