import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ChartNotificationEncoder } from '../electron/services/chart-notifications.js'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'
import { PreparedChartStore } from './chart-series-store.ts'
import type { PreparedChartNotification, PreparedChartResponse } from './chart-data.ts'

const instId = 'BTC-USDT-SWAP', timeframe = '15m', intervalMS = 900000
const fixture = (t: TestContext) => {
  const pipeline = new PreparedChartPipeline({ store: {} as never, history: {} as never, normalize: value => value, revision: () => 0, instrument: () => undefined, streaming: () => true })
  pipeline.setUniverse([instId], timeframe, instId)
  t.after(() => pipeline.dispose())
  return pipeline
}
const source = (close = 100) => ({ instrument: instId, timeframe, timestamp: Math.floor(Date.now() / intervalMS) * intervalMS,
  open: 100, high: 200, low: 99, close, volume: close, baseVolume: 1, quoteVolume: close, confirmed: false })
const isLive = (notification: PreparedChartNotification) => 'type' in notification && notification.type === 'live'

test('a forming-only cold chart keeps advancing through the actual pipeline, encoder and renderer store', async t => {
  const pipeline = fixture(t), encoder = new ChartNotificationEncoder(), store = new PreparedChartStore(), messages: PreparedChartNotification[] = []
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
  assert.equal(encoder.size, 1)
})

test('known latest and historical boundaries retain separate compression state and preserve source metadata', async t => {
  const pipeline = fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const latest = { ...frames[0], endHour: end, latestEnd: end }, history = { ...latest, endHour: end - intervalMS }
  assert.equal(isLive(encoder.encode(latest)), false)
  assert.equal(isLive(encoder.encode(history)), false)
  const versions = { price: 7, oi: 8, taker: 9 }
  const update = encoder.encode({ ...latest, revision: latest.revision + 2, sourceVersions: versions, priceObservedAt: 123, realtimeState: 'stale' })
  assert.equal(isLive(update), true)
  assert.deepEqual(update.sourceVersions, versions)
  assert.equal(update.priceObservedAt, 123)
  assert.equal(update.realtimeState, 'stale')
  assert.equal(isLive(encoder.encode({ ...history, revision: history.revision + 3 })), true)
  assert.equal(isLive(encoder.encode({ ...latest, generation: latest.generation + 1 })), false, 'A new canonical generation requires a completed frame.')
})

test('compression retains a bounded LRU and an evicted frame starts with a complete notification', async t => {
  const pipeline = fixture(t), encoder = new ChartNotificationEncoder(2), frames: PreparedChartResponse[] = []
  pipeline.subscribe(frame => frames.push(frame))
  await pipeline.setLive(instId, timeframe, source())
  const end = source().timestamp - intervalMS
  const a = { ...frames[0], endHour: end, latestEnd: end }, b = { ...a, instId: 'ETH-USDT-SWAP' }, c = { ...a, instId: 'SOL-USDT-SWAP' }
  encoder.encode(a); encoder.encode(b)
  assert.equal(isLive(encoder.encode({ ...a, revision: a.revision + 1 })), true)
  encoder.encode(c)
  assert.equal(encoder.size, 2)
  assert.equal(isLive(encoder.encode({ ...a, revision: a.revision + 2 })), true, 'Recently used frames retain their compression base.')
  assert.equal(isLive(encoder.encode({ ...b, revision: b.revision + 2 })), false, 'The oldest unused frame is evicted.')
  assert.equal(encoder.size, 2)
})


test('source error and retry metadata changes require full frames even when bars and state are unchanged', async t => {
  const pipeline = fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
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


test('price repair retry changes remain full notifications and cannot be compressed away with unchanged cached bars', async t => {
  const pipeline = fixture(t), encoder = new ChartNotificationEncoder(), frames: PreparedChartResponse[] = []
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
