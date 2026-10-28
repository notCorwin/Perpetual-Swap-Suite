import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startRendererCPUCounter } from '../../scripts/renderer-cpu-counter.mjs'

function browser({ enableError, disableError, detachError, drain } = {}) {
  const session = new EventEmitter(), calls = []
  session.send = async (method, options) => {
    calls.push([method, options])
    if (method === 'Performance.enable' && enableError) throw enableError
    if (method === 'Performance.disable') { drain?.(); if (disableError) throw disableError }
  }
  session.detach = async () => { calls.push(['detach']); if (detachError) throw detachError }
  const page = { context: () => ({ newCDPSession: async target => { assert.equal(target, page); return session } }) }
  return { page, session, calls }
}
const emit = (session, prefix, index, metrics = [{ name: 'Timestamp', value: 100 + index / 100 }, { name: 'ThreadTime', value: index / 1_000 }], metadata = {}) =>
  session.emit('Performance.metrics', { title: `${prefix}${JSON.stringify({ at: index * 10, timeOrigin: 1_000, phase: 'raf', index,
    rafTimestamp: index * 10, previousRafTimestamp: index ? (index - 1) * 10 : null, callbackAt: index * 10, ...metadata })}`, metrics })

test('renderer CPU counter drains matching markers before detach and preserves raw clock units', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  let prefix
  const host = browser({ drain: () => emit(host.session, prefix, 1, [{ name: 'Timestamp', value: 50.01 }, { name: 'ThreadTime', value: .013 }]) })
  try {
    const counter = await startRendererCPUCounter(host.page, { label: 'fixture/15m', directory })
    prefix = counter.markerPrefix
    emit(host.session, 'unrelated:', 0)
    emit(host.session, prefix, 0, [{ name: 'ThreadTime', value: .012 }, { name: 'Timestamp', value: 50 },
      { name: 'LayoutDuration', value: .003 }, { name: 'JSHeapUsedSize', value: 100 }, { name: 'IgnoredCounter', value: 100 }])
    const stopping = counter.stop()
    assert.equal(counter.stop(), stopping)
    const report = await stopping
    assert.deepEqual(host.calls, [['Performance.enable', { timeDomain: 'threadTicks' }], ['Performance.disable', undefined], ['detach']])
    assert.equal(host.session.listenerCount('Performance.metrics'), 0)
    assert.equal(report.complete, true)
    assert.equal(report.sampleCount, 2)
    assert.equal(report.samples[0].metrics.ThreadTime, .012)
    assert.equal(report.samples[0].timeOrigin + report.samples[0].at, 1_000)
    assert.equal(report.samples[1].rafTimestamp - report.samples[1].previousRafTimestamp, 10)
    assert.equal(report.samples[1].timeOrigin + report.samples[1].callbackAt, 1_010)
    assert.equal(report.rafEvidence.totalSamples, 2)
    assert.equal(report.rafEvidence.invalidSamples, 0)
    assert.equal(report.samples[0].metrics.IgnoredCounter, undefined)
    assert.match(report.units.ThreadTime, /renderer main-thread CPU seconds/)
    assert.equal(report.units.JSHeapUsedSize, 'bytes')
    assert.throws(() => { report.samples[0].metrics.ThreadTime = -1 }, TypeError)
    emit(host.session, prefix, 3)
    assert.equal(report.sampleCount, 2)
    assert.deepEqual(JSON.parse(await readFile(report.artifact, 'utf8')), report)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer CPU counter retains bounded recent evidence and declares loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  const host = browser()
  try {
    const counter = await startRendererCPUCounter(host.page, { directory, capacity: 2 })
    for (let index = 0; index < 5; index++) emit(host.session, counter.markerPrefix, index)
    const report = await counter.stop()
    assert.equal(report.complete, false)
    assert.equal(report.totalSamples, 5)
    assert.equal(report.droppedSamples, 3)
    assert.deepEqual(report.samples.map(sample => sample.index), [3, 4])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('missing CPU evidence and protocol failures remain visible while cleanup always runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  const host = browser({ enableError: new Error('Unsupported thread ticks'), disableError: new Error('Disable failed'), detachError: new Error('Detach failed') })
  try {
    const counter = await startRendererCPUCounter(host.page, { directory })
    emit(host.session, counter.markerPrefix, 0, [{ name: 'Timestamp', value: 100 }])
    host.session.emit('Performance.metrics', { title: `${counter.markerPrefix}{broken`, metrics: [] })
    const report = await counter.stop()
    assert.equal(report.complete, false)
    assert.equal(report.samples[0].metrics.ThreadTime, undefined, 'A missing native CPU counter must never become zero CPU.')
    assert.deepEqual(report.captureErrors.map(error => error.stage), ['enable', 'metrics', 'marker', 'disable', 'detach'])
    assert.equal(host.session.listenerCount('Performance.metrics'), 0)
    assert.equal(host.calls.at(-1)[0], 'detach')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an empty counter reports missing markers rather than successful zero CPU', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  try {
    const counter = await startRendererCPUCounter(browser().page, { directory })
    const report = await counter.stop()
    assert.equal(report.complete, false)
    assert.deepEqual(report.captureErrors.map(error => error.stage), ['markers'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer CPU evidence rejects counter resets, origin changes and missing or reordered markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  const cases = [
    { metadata: {}, metrics: [{ name: 'Timestamp', value: 100.01 }, { name: 'ThreadTime', value: .009 }], stage: 'clock' },
    { metadata: {}, metrics: [{ name: 'Timestamp', value: 99 }, { name: 'ThreadTime', value: .011 }], stage: 'clock' },
    { metadata: { timeOrigin: 2_000 }, stage: 'clock' },
    { metadata: { at: 19 }, stage: 'clock' },
    { metadata: { index: 0 }, stage: 'sequence' },
    { metadata: { index: 2 }, stage: 'sequence' },
  ]
  try {
    for (const [index, scenario] of cases.entries()) {
      const host = browser()
      const counter = await startRendererCPUCounter(host.page, { directory, label: `invalid-${index}` })
      emit(host.session, counter.markerPrefix, 0, [{ name: 'Timestamp', value: 100 }, { name: 'ThreadTime', value: .010 }], { at: 20 })
      emit(host.session, counter.markerPrefix, 1,
        scenario.metrics ?? [{ name: 'Timestamp', value: 100.01 }, { name: 'ThreadTime', value: .011 }], { at: 30, ...scenario.metadata })
      const report = await counter.stop()
      assert.equal(report.complete, false)
      assert.ok(report.captureErrors.some(error => error.stage === scenario.stage), JSON.stringify(report.captureErrors))
      assert.equal(report.samples.length, 2, 'Keep the raw reset/reordered witness for diagnosis instead of correcting its counters.')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('missing or invalid raw RAF evidence remains explicit without altering native CPU counters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-counter-'))
  try {
    const host = browser(), counter = await startRendererCPUCounter(host.page, { directory })
    emit(host.session, counter.markerPrefix, 0, undefined, { rafTimestamp: undefined, callbackAt: undefined })
    emit(host.session, counter.markerPrefix, 1, undefined, { previousRafTimestamp: 20 })
    emit(host.session, counter.markerPrefix, 2, undefined, { callbackAt: 21 })
    const report = await counter.stop()
    assert.equal(report.complete, false)
    assert.deepEqual(report.captureErrors.map(error => error.stage), ['raf', 'raf', 'raf'])
    assert.equal(report.rafEvidence.totalSamples, 3)
    assert.equal(report.rafEvidence.invalidSamples, 3)
    assert.equal(report.samples[1].previousRafTimestamp, 20, 'Retain the invalid raw witness; do not repair its timestamp.')
    assert.equal(report.samples[2].metrics.ThreadTime, .002)
    assert.equal(report.samples[2].metrics.ProcessTime, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
