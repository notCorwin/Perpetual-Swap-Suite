import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { ResearchJob } from './research-types.ts'
import { researchByteSize, researchDuration, researchFilePercent, researchPlanningDescription, researchPlanningStage, researchProgressLabel, researchTaskActive, researchWaiting } from './research-task.ts'

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

test('local checking has its own units, phase wording, estimate and stalled feedback', () => {
  const job: ResearchJob = { id: 'local', phase: 'planning', completed: 720, total: 6000, message: 'Checking BTC candles', error: '', updatedAt: 1000,
    planning: { stage: 'coverage', unit: 'hours', completed: 720, total: 6000, message: 'Checking BTC candles', remainingSeconds: 120 } }
  assert.equal(researchProgressLabel(job), 'Hourly inputs checked')
  assert.equal(researchPlanningStage(job), 'Checking local input coverage')
  assert.match(researchPlanningDescription(job), /Checking cached hours and missing intervals/)
  assert.doesNotMatch(researchPlanningDescription(job), /Reading.*catalog/)
  assert.equal(researchDuration(job.planning!.remainingSeconds), '2m 0s')
  assert.match(researchWaiting(job, 21000), /Last check progress update.*20s/)
  assert.doesNotMatch(researchWaiting(job, 21000), /Waiting for OKX/)
  job.phase = 'failed'; job.error = 'Local database read failed'
  assert.equal(researchWaiting(job, 21000), '')
})

test('every planning phase explains its current work instead of repeating catalog wording', () => {
  const job: ResearchJob = { id: 'plan', phase: 'planning', completed: 0, total: 1, message: '', error: '' }
  for (const stage of ['registry', 'localImport', 'missing', 'sources', 'cache', 'coverage', 'saving']) {
    job.planning = { stage, unit: 'steps', completed: 0, total: 1, message: '' }
    assert.doesNotMatch(researchPlanningDescription(job), /Reading published archive catalogs/)
    assert.notEqual(researchPlanningStage(job), 'Starting planning')
  }
  job.catalog = { kind: 'candle', completed: 0, total: 2, message: '', waitingForResponse: true }
  assert.equal(researchProgressLabel(job), 'Catalog pages checked')
  assert.match(researchPlanningDescription(job), /Reading published archive catalogs/)
})

test('rate limits show automatic retry countdown without pausing the task or losing progress', () => {
  const job: ResearchJob = { id: 'retry', phase: 'planning', completed: 165, total: 222, message: '', error: '',
    catalog: { kind: 'candle', completed: 165, total: 222, message: '', waitingForResponse: true, retryAt: 6000 } }
  assert.equal(researchTaskActive(job), true)
  assert.match(researchWaiting(job, 1000), /Retrying automatically in 5s/)
  assert.match(researchWaiting(job, 6000), /Retrying the current request automatically/)
  assert.equal(job.completed, 165)
  job.catalog = undefined
  job.planning = { stage: 'registry', unit: 'steps', completed: 0, total: 1, message: '', retryAt: 6000 }
  assert.match(researchWaiting(job, 1000), /Retrying automatically in 5s/)
  job.planning = undefined
  job.phase = 'preparing'; job.catalog = undefined
  job.preparation = { stage: 'fetching', filename: 'REST', instrument: 'BTC-USDT-SWAP', receivedBytes: 50, pages: 2, fraction: 0.75, retryAt: 6000 }
  assert.match(researchWaiting(job, 1000), /Retrying automatically in 5s/)
  assert.equal(researchFilePercent(job), 75)
  job.preparation.retryAt = undefined
  assert.equal(researchWaiting(job, 1000), '')
  job.phase = 'paused'; job.preparation.retryAt = 6000
  assert.equal(researchWaiting(job, 1000), '')
})
