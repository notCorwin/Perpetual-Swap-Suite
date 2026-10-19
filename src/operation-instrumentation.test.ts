import assert from 'node:assert/strict'
import test from 'node:test'
import { barsWithIndicators, buildIndicatorSeries, projectIndicatorCandle } from '../electron/services/indicators.js'
import { createLiquidityEvaluator, type LiquidityInput } from '../electron/services/liquidity.js'
import { attachOperationSink, measureOperation, type OperationEvent, type OperationJournalEvent } from '../electron/services/operations.js'
import { createChartGeometryCache } from './chart-geometry.ts'
import { initializeOperationTelemetry } from './operation-telemetry.ts'
import type { OperationBatch } from './desktop-contract.ts'

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
  let nextTimer = 0, flush: (() => Promise<void>) | undefined
  let fail = false, blocked = false, hold = false, release: (() => void) | undefined
  return {
    batches, attempts, timers, failures,
    flush: () => flush?.() ?? Promise.resolve(),
    failNext: () => { fail = true },
    block: (value: boolean) => { blocked = value },
    holdNext: () => { hold = true },
    release: () => release?.(),
    host: {
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
  } finally { await assert.rejects(stop(), /incomplete/) }
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
