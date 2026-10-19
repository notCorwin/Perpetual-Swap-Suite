import assert from 'node:assert/strict'
import test from 'node:test'
import { barsWithIndicators, buildIndicatorSeries, projectIndicatorCandle } from '../electron/services/indicators.js'
import { createLiquidityEvaluator, type LiquidityInput } from '../electron/services/liquidity.js'
import { attachOperationSink, measureOperation, type OperationEvent, type OperationJournalEvent } from '../electron/services/operations.js'
import { createChartGeometryCache } from './chart-geometry.ts'
import { initializeOperationTelemetry } from './operation-telemetry.ts'
import type { OperationBatch, OperationBridgeHooks, OperationSourceIdentity } from './desktop-contract.ts'

const candles = Array.from({ length: 220 }, (_, index) => ({ timestamp: index * 300_000,
  open: 100, close: 100, high: 101, low: 99, baseVolume: 1, confirmed: true }))

test('canonical computation records one batch and renderer reuse records only actual geometry work', () => {
  const events: OperationEvent[] = []
  const unsubscribe = attachOperationSink(event => events.push(event))
  try {
    const calculated = barsWithIndicators(candles)
    assert.ok(Math.abs(calculated.at(-1)!.ema! - 100) < 1e-9)
    assert.equal(events.length, 1, 'Individual candles must not generate separate operation spans.')
    assert.equal(events[0].name, 'indicators.build')
    assert.equal(events[0].attributes!.candles, 220)
    const bars = calculated.slice(-96)
    const geometry = createChartGeometryCache(text => text.length * 6)
    const options = { width: 960, height: 700, endHour: bars.at(-1)!.hour, intervalMS: 300_000 }
    const first = geometry(bars, options)
    const afterConstruction = events.length
    assert.equal(geometry(bars, { ...options }), first)
    assert.equal(events.length, afterConstruction, 'A cache hit performs no expensive geometry operation.')
    geometry(bars, { ...options, width: 1200 })
    assert.deepEqual(events.map(event => event.name), ['indicators.build', 'chart.geometry', 'chart.geometry'])
    assert.ok(events.every(event => event.category === 'cpu' && event.durationMS >= 0 && event.status === 'ok'))
  } finally { unsubscribe() }
})

test('liquidity diagnostics identify resident immutable books while every threshold is evaluated afresh', () => {
  const events: OperationEvent[] = []
  const unsubscribe = attachOperationSink(event => events.push(event))
  const input: LiquidityInput = {
    instrument: { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live',
      instCategory: '1', ruleType: 'normal', ctVal: '1', ctMult: '1', ctValCcy: 'BTC' },
    book: { bids: [['100', '2000']], asks: [['100.01', '2000']] }, asOf: 0,
    config: { spread: { enabled: false, maxPercent: 0.05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: false, maxPercent: 0.1, notionalUSDT: 100_000 }, volume24h: { enabled: false, minUSDT: 30_000_000 },
      openInterest: { enabled: false, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 } },
  }
  try {
    const evaluate = createLiquidityEvaluator()
    assert.equal(evaluate(input).eligible, true)
    assert.equal(evaluate({ ...input, config: { ...input.config, depth: { enabled: true, minUSDT: 300_000 } } }).eligible, false)
    assert.deepEqual(events.map(event => [event.name, event.attributes!.bookResident]), [
      ['liquidity.evaluate', false], ['liquidity.evaluate', true],
    ])
    assert.ok(events.every(event => event.resource === 'BTC-USDT-SWAP'))
  } finally { unsubscribe() }
})

test('live indicator revisions record the fixed-size projection without replaying confirmed history', () => {
  const { state } = buildIndicatorSeries(candles)
  const before = structuredClone(state), events: OperationEvent[] = []
  const unsubscribe = attachOperationSink(event => events.push(event))
  try {
    const live = projectIndicatorCandle(state, { ...candles.at(-1)!, timestamp: candles.length * 300_000, close: 101, high: 102, confirmed: false })
    assert.equal(live!.close, 101)
    assert.deepEqual(state, before)
    assert.deepEqual(events.map(event => event.name), ['indicators.project'])
    assert.equal(events[0].attributes!.candles, 1)
  } finally { unsubscribe() }
})

function telemetryHost() {
  const batches: OperationBatch[] = [], attempts: OperationBatch[] = [], failures: { omitted: number }[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0, flush: (() => Promise<void>) | undefined, detach: (() => Promise<void>) | undefined
  let hooks: OperationBridgeHooks | undefined
  let fail = false, blocked = false, hold = false, release: (() => void) | undefined
  return {
    batches, attempts, timers, failures,
    flush: () => flush?.() ?? Promise.resolve(),
    detach: () => detach?.() ?? Promise.resolve(),
    hooks: () => hooks!,
    failNext: () => { fail = true },
    block: (value: boolean) => { blocked = value },
    holdNext: () => { hold = true },
    release: () => release?.(),
    host: {
      // Keep the enclosing sandbox's source identity while exercising bridge hooks.
      initialize: async (value: OperationBridgeHooks) => { hooks = value; return undefined as unknown as OperationSourceIdentity },
      recordOperations: async (batch: OperationBatch) => {
        attempts.push(structuredClone(batch))
        if (fail || blocked) { fail = false; throw new Error('Transient IPC failure') }
        if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve }) }
        batches.push(structuredClone(batch))
        return { batchId: batch.batchId, lastSequence: batch.events.at(-1)!.sequence }
      },
      reportFailure: async (value: { omitted: number }) => { failures.push(value) },
      timeOrigin: 1_000,
      schedule: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id },
      cancel: (id: number) => { timers.delete(id) },
      onFlush: (callback: () => Promise<void>) => { flush = callback; return () => { flush = undefined } },
      onStop: (callback: () => Promise<void>) => { detach = callback; return () => { detach = undefined } },
    },
  }
}

const ended = (batches: OperationBatch[]): OperationJournalEvent[] => batches.flatMap(batch => batch.events).filter(event => event.phase === 'end')

test('renderer retains lifecycle records until acknowledgment and retries the same immutable batch', async () => {
  const harness = telemetryHost(), stop = await initializeOperationTelemetry(harness.host)
  try {
    for (let index = 0; index < 63; index++) measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => index * index)
    assert.equal(harness.attempts.length, 0)
    assert.equal(harness.timers.size, 1)
    harness.holdNext()
    measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => 1)
    assert.equal(harness.attempts[0].events.length, 128)
    measureOperation({ category: 'cpu', name: 'fixture.during-handoff' }, () => 1)
    let acknowledged = false
    const draining = harness.flush().then(() => { acknowledged = true })
    await Promise.resolve()
    assert.equal(acknowledged, false, 'Flush must wait for the durable acknowledgment.')
    assert.equal(harness.batches.length, 0)
    harness.release()
    await draining
    assert.equal(ended(harness.batches).length, 65)
    measureOperation({ category: 'cpu', name: 'fixture.retry' }, () => 1)
    harness.failNext()
    await assert.rejects(harness.flush(), /Transient IPC failure/)
    const failedBatch = harness.attempts.at(-1)!
    await harness.flush()
    assert.deepEqual(harness.attempts.at(-1), failedBatch, 'Retries retain batch IDs, sequence numbers and source operation IDs.')
    measureOperation({ category: 'cpu', name: 'fixture.shutdown' }, () => 1)
  } finally { await stop() }
  assert.equal(ended(harness.batches).at(-1)!.name, 'fixture.shutdown')
  const records = harness.batches.flatMap(batch => batch.events)
  assert.equal(records.length, 134)
  assert.equal(new Set(records.map(event => `${event.id}:${event.phase}`)).size, 134)
  assert.equal(harness.timers.size, 0)
})

test('leaving a renderer submits cancelled requests before an earlier durable ACK can resume the document', async () => {
  const harness = telemetryHost(), persisted = new Map<number, OperationJournalEvent>()
  let tail = Promise.resolve(), release: (() => void) | undefined, first = true
  const recordOperations = (batch: OperationBatch) => {
    harness.attempts.push(structuredClone(batch))
    const task = tail.then(async () => {
      if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
      for (const event of batch.events) {
        const previous = persisted.get(event.sequence)
        if (previous) assert.deepEqual(event, previous, 'A replay retains exactly the same operation lifecycle record.')
        else persisted.set(event.sequence, event)
      }
      return { batchId: batch.batchId, lastSequence: batch.events.at(-1)!.sequence }
    })
    tail = task.then(() => {})
    return task
  }
  const stop = await initializeOperationTelemetry({ ...harness.host, recordOperations })
  try {
    for (let index = 0; index < 63; index++) measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => index)
    const history = harness.hooks().beginRequest('chartWindow')
    const universe = harness.hooks().beginRequest('chartUniverse')
    assert.equal(harness.attempts.length, 1)
    await Promise.resolve()
    let acknowledged = false
    const detached = harness.detach().then(() => { acknowledged = true })
    const finalAttempts = harness.attempts.slice(1)
    assert.deepEqual(finalAttempts[0], harness.attempts[0], 'The in-flight batch can be replayed during final handoff.')
    assert.deepEqual(ended(finalAttempts).filter(event => event.name === 'desktop.request').map(event => [event.resource, event.status, event.attributes!.reason]), [
      ['chartWindow', 'cancelled', 'renderer-detached'], ['chartUniverse', 'cancelled', 'renderer-detached'],
    ], 'All cancellation records must be submitted synchronously, while the first durable ACK is still blocked.')
    assert.equal(persisted.size, 0)
    assert.equal(acknowledged, false)
    assert.throws(() => harness.hooks().beginRequest('snapshot'), { name: 'AbortError' })
    assert.doesNotThrow(() => harness.hooks().receive('radar:chart-prepared', {}, undefined), 'A detached document must not dispatch more business work.')
    harness.hooks().endRequest(history.id, 'ok')
    harness.hooks().endRequest(universe.id, 'error')
    release!()
    await detached
    assert.equal(persisted.size, 130)
    const requests = [...persisted.values()].filter(event => event.name === 'desktop.request')
    assert.equal(requests.length, 4)
    for (const start of requests.filter(event => event.phase === 'start')) {
      assert.equal(requests.filter(event => event.id === start.id && event.phase === 'end' && event.status === 'cancelled').length, 1)
    }
    assert.equal(harness.timers.size, 0)
  } finally { release?.(); await stop() }
})

test('a failed terminal handoff retries the retained immutable cancellation records', async () => {
  const harness = telemetryHost(), stop = await initializeOperationTelemetry(harness.host)
  harness.hooks().beginRequest('chartWindow')
  harness.failNext()
  await assert.rejects(harness.detach(), /Transient IPC failure/)
  const failedBatch = harness.attempts.at(-1)!
  assert.deepEqual(failedBatch.events.map(event => [event.phase, event.status]), [['start', 'running'], ['end', 'cancelled']])
  await stop()
  assert.deepEqual(harness.attempts.at(-1), failedBatch)
  assert.equal(harness.failures.length, 0)
})

test('persistent renderer handoff failure retains a contiguous bounded prefix and explicitly fails its source', async () => {
  const harness = telemetryHost()
  harness.block(true)
  const stop = await initializeOperationTelemetry(harness.host)
  try {
    for (let index = 0; index < 4_200; index++) measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => index)
    await assert.rejects(harness.flush(), /Transient IPC failure/)
    harness.block(false)
    await assert.rejects(harness.flush(), /incomplete/)
    const records = harness.batches.flatMap(batch => batch.events)
    assert.equal(records.length, 8_192)
    assert.ok(records.every((event, index) => !index || event.sequence === records[index - 1].sequence + 1))
    assert.equal(harness.failures.length, 1)
    assert.equal(harness.failures[0].omitted, 208)
    for (let index = 0; index < 2; index++) measureOperation({ category: 'cpu', name: 'fixture.after-overflow' }, () => index)
    await assert.rejects(harness.flush(), /incomplete/)
    assert.deepEqual(harness.failures.map(value => value.omitted), [208, 212], 'Later reports carry the cumulative source total, so IPC replays can be deduplicated.')
  } finally { await assert.rejects(stop(), /incomplete/) }
})

test('leaving an exhausted renderer submits omitted evidence before held batch acknowledgments', async () => {
  const harness = telemetryHost(), reports: { omitted: number }[] = []
  let releaseReport: (() => void) | undefined
  const stop = await initializeOperationTelemetry({ ...harness.host, reportFailure: value => {
    reports.push(value)
    return new Promise<void>(resolve => { releaseReport = resolve })
  } })
  harness.holdNext()
  for (let index = 0; index < 4_200; index++) measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => index)
  let completed = false
  const detached = harness.detach().finally(() => { completed = true })
  // Attach the rejection handler immediately: this source must fail even though
  // the 8192 retained records form a perfectly paired sequence of operations.
  const rejected = assert.rejects(detached, /incomplete/)
  const repeated = assert.rejects(stop(), /incomplete/)
  assert.equal(reports.length, 1, 'Shutdown must submit failure evidence without waiting for a batch ACK.')
  assert.equal(reports[0].omitted, 208)
  assert.equal(completed, false)
  harness.release()
  await Promise.resolve()
  assert.equal(completed, false, 'A final flush must also await the omitted-evidence acknowledgment.')
  releaseReport!()
  await Promise.all([rejected, repeated])
  await assert.rejects(stop(), /incomplete/)
  assert.equal(reports.length, 1, 'Concurrent drains and repeated shutdown do not count the same omissions again.')
  const records = new Map(harness.batches.flatMap(batch => batch.events).map(event => [event.sequence, event]))
  assert.equal(records.size, 8_192)
  assert.equal([...records.values()].filter(event => event.phase === 'start').length, 4_096)
  assert.equal([...records.values()].filter(event => event.phase === 'end').length, 4_096)
})

test('terminal omission evidence retries a failed cumulative report without resending an acknowledged total', async () => {
  const harness = telemetryHost(), reports: { omitted: number }[] = []
  let fail = true
  const stop = await initializeOperationTelemetry({ ...harness.host, reportFailure: async value => {
    reports.push(value)
    if (fail) { fail = false; throw new Error('Failure-report transport unavailable') }
  } })
  harness.holdNext()
  for (let index = 0; index < 4_100; index++) measureOperation({ category: 'cpu', name: 'fixture.compute' }, () => index)
  const detached = assert.rejects(harness.detach(), /Failure-report transport unavailable/)
  assert.deepEqual(reports.map(value => value.omitted), [8])
  harness.release()
  await detached
  await assert.rejects(stop(), /incomplete/)
  await assert.rejects(stop(), /incomplete/)
  assert.deepEqual(reports.map(value => value.omitted), [8, 8], 'An unsuccessful submission retries the same cumulative total; an acknowledged total is never submitted again.')
})

test('renderer long-frame observations and undelivered shutdown entries preserve their elapsed timing', async () => {
  const harness = telemetryHost(), callbacks: PerformanceObserverCallback[] = [], observed: string[] = [], queued: PerformanceEntry[] = []
  class Observer {
    static supportedEntryTypes = ['long-animation-frame']
    constructor(callback: PerformanceObserverCallback) { callbacks.push(callback) }
    observe(options: PerformanceObserverInit) { observed.push(options.type!) }
    takeRecords() { return queued.splice(0) }
    disconnect() {}
  }
  const stop = await initializeOperationTelemetry({ ...harness.host, Observer: Observer as unknown as typeof PerformanceObserver })
  try {
    assert.deepEqual(observed, ['long-animation-frame'])
    callbacks[0]({ getEntries: () => [{ entryType: 'long-animation-frame', startTime: 10, duration: 75, blockingDuration: 25, renderStart: 60 }] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver)
    await harness.flush()
    const event = ended(harness.batches)[0]
    assert.equal(event.name, 'renderer.long-animation-frame')
    assert.equal(event.startedAt, 1_010)
    assert.equal(event.durationMS, 75)
    assert.equal(event.category, 'cpu')
    assert.equal(event.cpuTimeMS, undefined)
    assert.equal(event.attributes!.measurement, 'observed-wall')
    assert.equal(event.attributes!.blockingDurationMS, 25)
    assert.equal(event.attributes!.renderDurationMS, 25)
    queued.push({ entryType: 'long-animation-frame', startTime: 100, duration: 80 } as PerformanceEntry)
  } finally { await stop() }
  assert.equal(ended(harness.batches).at(-1)!.startedAt, 1_100)
})
