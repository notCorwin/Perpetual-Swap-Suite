import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ChartNotificationEncoder } from '../electron/services/chart-notifications.js'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { PreparedChartStore } from './chart-series-store.ts'
import type { PreparedChartBar, PreparedChartNotification, PreparedChartResponse } from './chart-data.ts'

const instId = 'BTC-USDT-SWAP', timeframe = '15m', intervalMS = 900000
const fixture = async (t: TestContext) => {
  const pipeline = new PreparedChartPipeline({ store: { candles: async () => [], coverage: async () => ({ first: null, last: null, count: 0 }) } as never, history: {} as never, normalize: value => value, revision: () => 0, instrument: () => undefined, streaming: () => true })
  await pipeline.local(instId, timeframe)
  t.after(() => pipeline.dispose())
  return pipeline
}
const source = (close = 100) => ({ instrument: instId, timeframe, timestamp: Math.floor(Date.now() / intervalMS) * intervalMS,
  open: 100, high: 200, low: 99, close, volume: close, baseVolume: 1, quoteVolume: close, confirmed: false })
const completedBars = (firstHour: number, count: number): PreparedChartBar[] => Array.from({ length: count }, (_, index) => ({
  hour: firstHour + index * intervalMS, open: 100, high: 102, low: 99, close: 101, confirmed: true,
  statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
  vwap: 100, ema: 100, bollUpper: 102, bollMiddle: 100, bollLower: 99,
  roc: 1, maroc: .5, rsi6: 50, rsi12: 51, rsi24: 52, atrPercent: 2.5, bbw: 6,
  oi: 1_000, buy: 20, sell: 30,
}))
const isLive = (notification: PreparedChartNotification): notification is Extract<PreparedChartNotification, { type: 'live' }> =>
  'type' in notification && notification.type === 'live'

test('a forming-only cold chart keeps advancing through the actual pipeline, encoder and renderer store', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), store = new PreparedChartStore(), messages: PreparedChartNotification[] = []
  store.setUniverse([instId], timeframe, instId)
  pipeline.subscribe(frame => {
    const message = encoder.encode(frame)
    messages.push(message)
    if ('bars' in message) assert.equal(store.ingestLatest(message), true)
    else assert.equal(store.ingestLive(message), true)
  })
  await pipeline.setLive(instId, timeframe, source(100))
  const first = messages[0] as PreparedChartResponse
  assert.equal(first.endHour, null)
  assert.equal(store.window(instId, timeframe)?.liveBar?.close, 100)
  await pipeline.setLive(instId, timeframe, source(200))
  assert.equal(isLive(messages[1]), false, 'An unknown completed boundary must not become an unidentifiable live delta.')
  assert.equal(store.window(instId, timeframe)?.liveBar?.close, 200)
})

test('only latest boundaries compress and historical frames leave the latest base untouched', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const latest = { ...frames[0], endHour: end, latestEnd: end }, history = { ...latest, endHour: end - intervalMS }
  assert.equal(isLive(encoder.encode(latest)), false)
  assert.equal(isLive(encoder.encode(history)), false)
  assert.equal(isLive(encoder.encode({ ...latest, revision: latest.revision + 1 })), true, 'A full history frame must not replace the latest compression base.')
  const versions = { price: 7, oi: 8, taker: 9 }
  const update = encoder.encode({ ...latest, revision: latest.revision + 2, sourceVersions: versions, priceObservedAt: 123, realtimeState: 'stale' })
  assert.equal(isLive(update), true, 'The live payload carries changing source metadata.')
  assert.deepEqual(update.sourceVersions, versions)
  assert.equal(update.priceObservedAt, 123)
  assert.equal(update.realtimeState, 'stale')
  assert.equal(isLive(encoder.encode({ ...latest, revision: latest.revision + 3, sourceVersions: versions, priceObservedAt: 123, realtimeState: 'stale' })), true)
  assert.equal(isLive(encoder.encode({ ...history, endHour: history.endHour! - intervalMS, revision: history.revision + 4 })), false, 'History cursor replacement stays a complete frame.')
  assert.equal(isLive(encoder.encode({ ...latest, revision: latest.revision + 5, sourceVersions: versions, priceObservedAt: 123, realtimeState: 'stale' })), true, 'History updates must not change the latest compression base.')
  assert.equal(isLive(encoder.encode({ ...latest, generation: latest.generation + 1 })), false, 'A new canonical generation requires a completed frame.')
})

test('a complete 96-bar history frame and its metadata round-trip through the renderer store', () => {
  const encoder = new ChartNotificationEncoder(), store = new PreparedChartStore()
  store.setUniverse([instId], timeframe, instId)
  const bars = completedBars(104 * intervalMS, 96), endHour = bars.at(-1)!.hour
  const firstVersions = { price: 4, oi: 5, taker: 6 }
  const first: PreparedChartResponse = {
    instId, timeframe, intervalMS, endHour, latestEnd: endHour + 96 * intervalMS, oldestHour: bars[0].hour,
    historyExhausted: false, generation: 2, revision: 10, bars,
    priceState: 'ready', priceAsOf: endHour, priceObservedAt: 1_000, realtimeState: 'live', sourceVersions: firstVersions,
    oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '',
  }
  const full = encoder.encode(first)
  assert.equal(isLive(full), false)
  assert.ok('bars' in full)
  assert.equal(store.ingest(full), true)
  assert.equal(store.window(instId, timeframe, endHour)?.bars.length, 96)
  assert.deepEqual(store.snapshotMeta(instId, timeframe)?.sourceVersions, firstVersions)
  assert.equal(store.snapshotMeta(instId, timeframe)?.priceObservedAt, 1_000)

  const nextVersions = { price: 7, oi: 8, taker: 9 }
  const changed: PreparedChartResponse = { ...first, revision: 11, sourceVersions: nextVersions, priceObservedAt: 2_000 }
  const changedFull = encoder.encode(changed)
  assert.equal(isLive(changedFull), false)
  assert.ok('bars' in changedFull)
  assert.equal(changedFull.bars, bars, 'Metadata changed while the immutable source bars reference stayed the same.')
  assert.equal(store.ingest(changedFull), true)
  assert.deepEqual(store.snapshotMeta(instId, timeframe)?.sourceVersions, nextVersions)
  assert.equal(store.snapshotMeta(instId, timeframe)?.priceObservedAt, 2_000)
})

test('latest source metadata changes are carried by deltas and persisted to snapshot metadata', () => {
  const encoder = new ChartNotificationEncoder(), store = new PreparedChartStore()
  store.setUniverse([instId], timeframe, instId)
  const bars = completedBars(104 * intervalMS, 96), endHour = bars.at(-1)!.hour
  const firstVersions = { price: 4, oi: 5, taker: 6 }
  const first: PreparedChartResponse = {
    instId, timeframe, intervalMS, endHour, latestEnd: endHour, oldestHour: bars[0].hour,
    historyExhausted: false, generation: 2, revision: 10, bars,
    priceState: 'ready', priceAsOf: endHour, priceObservedAt: 1_000, realtimeState: 'live', sourceVersions: firstVersions,
    oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '',
  }
  const firstFull = encoder.encode(first)
  assert.ok('bars' in firstFull)
  assert.equal(store.ingestLatest(firstFull), true)

  const nextVersions = { price: 7, oi: 8, taker: 9 }
  const changed: PreparedChartResponse = { ...first, revision: 11, sourceVersions: nextVersions, priceObservedAt: 2_000,
    priceAsOf: endHour + intervalMS, realtimeState: 'stale', priceState: 'stale' }
  const changedLive = encoder.encode(changed)
  assert.ok(isLive(changedLive), 'Volatile metadata changes do not invalidate an otherwise matching latest frame.')
  assert.equal(changedLive.sourceVersions, nextVersions)
  assert.equal(changedLive.priceObservedAt, 2_000)
  assert.equal(changedLive.priceAsOf, endHour + intervalMS)
  assert.equal(changedLive.realtimeState, 'stale')
  assert.equal(changedLive.priceState, 'stale')
  assert.equal(store.ingestLive(changedLive), true)
  assert.deepEqual(store.snapshotMeta(instId, timeframe)?.sourceVersions, nextVersions)
  assert.equal(store.snapshotMeta(instId, timeframe)?.priceObservedAt, 2_000)
  assert.equal(store.snapshotMeta(instId, timeframe)?.priceAsOf, endHour + intervalMS)
  assert.equal(store.snapshotMeta(instId, timeframe)?.realtimeState, 'stale')
  assert.equal(store.snapshotMeta(instId, timeframe)?.priceState, 'stale')

  const sameValuesNewObject = encoder.encode({ ...changed, revision: 12, sourceVersions: { ...nextVersions } })
  assert.ok(isLive(sameValuesNewObject), 'Recreated volatile metadata remains eligible for a latest delta.')
  assert.equal(store.ingestLive(sameValuesNewObject), true)
})

test('compression keeps a live base for 861 interleaved immutable chart series', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const base = frames[0], end = source().timestamp - intervalMS
  const series = Array.from({ length: 287 * 3 }, (_, index) => ({
    ...base,
    instId: `MARKET-${Math.floor(index / 3)}-USDT-SWAP`,
    timeframe: (['5m', '15m', '1H'] as const)[index % 3],
    endHour: end,
    latestEnd: end,
    priceState: 'ready' as const,
    priceAsOf: end,
    priceObservedAt: 1_000,
    realtimeState: 'stale' as const,
    sourceVersions: { price: 0, oi: 0, taker: 0 },
    bars: [...base.bars],
  }))

  for (const frame of series) assert.equal(isLive(encoder.encode(frame)), false)
  for (const [index, frame] of series.entries()) {
    const update = { ...frame, revision: frame.revision + 1, priceState: 'stale' as const,
      priceAsOf: end + intervalMS, priceObservedAt: 2_000 + index, realtimeState: 'live' as const,
      sourceVersions: { price: index + 1, oi: index + 2, taker: index + 3 } }
    const message = encoder.encode(update)
    assert.ok(isLive(message), `Series ${index} should keep a delta while its live metadata changes.`)
    assert.equal(message.priceObservedAt, update.priceObservedAt)
    assert.equal(message.priceAsOf, update.priceAsOf)
    assert.equal(message.realtimeState, update.realtimeState)
    assert.equal(message.priceState, update.priceState)
    assert.deepEqual(message.sourceVersions, update.sourceVersions)
  }
})

test('a shared bars array cannot carry a live delta across instrument or timeframe identity', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS, bars = [...frames[0].bars]
  const first = { ...frames[0], endHour: end, latestEnd: end, bars }
  const otherInstrument = { ...first, instId: 'ETH-USDT-SWAP' }
  const otherTimeframe = { ...first, timeframe: '5m' as const }

  assert.equal(isLive(encoder.encode(first)), false)
  assert.equal(isLive(encoder.encode({ ...first, revision: first.revision + 1 })), true)
  assert.equal(isLive(encoder.encode(otherInstrument)), false)
  assert.equal(isLive(encoder.encode(otherTimeframe)), false)
})


test('source error and retry metadata changes require full frames even when bars and state are unchanged', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const frame = { ...frames[0], endHour: end, latestEnd: end, oiState: 'error' as const,
    oiStatus: { state: 'error' as const, from: end - 95 * intervalMS, through: end, error: 'OI unavailable', retryAt: 1000 } }
  assert.equal(isLive(encoder.encode(frame)), false)
  assert.equal(isLive(encoder.encode({ ...frame, revision: frame.revision + 1 })), true)
  const delayed = { ...frame, revision: frame.revision + 2, oiStatus: { ...frame.oiStatus, error: 'OI rate limit', retryAt: 2000 } }
  const message = encoder.encode(delayed)
  assert.equal(isLive(message), false)
  assert.equal((message as PreparedChartResponse).oiStatus?.retryAt, 2000)
  assert.equal((message as PreparedChartResponse).oiStatus?.error, 'OI rate limit')
  assert.equal(isLive(encoder.encode({ ...delayed, revision: frame.revision + 3 })), true)
})


test('indicator error details and recovery input versions cross the notification boundary', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const frame = { ...frames[0], endHour: end, latestEnd: end, indicatorState: 'error' as const,
    indicatorStatus: { state: 'error' as const, from: end - 95 * intervalMS, through: end,
      error: 'Worker unavailable', inputVersion: 'input-1', retryOn: 'worker-recovery' as const } }
  encoder.encode(frame)
  const changed = { ...frame, revision: frame.revision + 1, indicatorStatus: { ...frame.indicatorStatus, inputVersion: 'input-2', error: 'Invalid calculation input', retryOn: 'input-change' as const } }
  const message = encoder.encode(changed)
  assert.equal(isLive(message), false)
  assert.deepEqual((message as PreparedChartResponse).indicatorStatus, changed.indicatorStatus)
  assert.equal(isLive(encoder.encode({ ...changed, revision: changed.revision + 1 })), true)
})

test('price repair retry changes remain full notifications and cannot be compressed away with unchanged cached bars', async t => {
  const pipeline = await fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const frame = { ...frames[0], endHour: end, latestEnd: end, priceState: 'error' as const, error: 'Price source offline',
    priceStatus: { state: 'error' as const, from: end - 95 * intervalMS, through: end, error: 'Price source offline', retryAt: 1000 } }
  assert.equal(isLive(encoder.encode(frame)), false)
  assert.equal(isLive(encoder.encode({ ...frame, revision: frame.revision + 1 })), true)
  const changed = encoder.encode({ ...frame, revision: frame.revision + 2, priceStatus: { ...frame.priceStatus, retryAt: 2000 } })
  assert.equal(isLive(changed), false)
  assert.equal((changed as PreparedChartResponse).priceStatus?.retryAt, 2000)
})
