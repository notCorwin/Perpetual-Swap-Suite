import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar, PreparedChartBar, PreparedChartLiveUpdate, PreparedChartResponse } from './chart-data.ts'
import { PreparedChartStore } from './chart-series-store.ts'
import { timeframeMilliseconds } from './timeframe.ts'
import { attachOperationSink, type OperationEvent } from '../electron/services/operations.js'

const hour = 3_600_000
const instId = 'BTC-USDT-SWAP'
const bar = (index: number, intervalMS = hour, overrides: Partial<PreparedChartBar> = {}): PreparedChartBar => ({
  hour: index * intervalMS, open: 100, high: 102, low: 99, close: 101,
  confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
  vwap: 100, ema: 100, bollUpper: 102, bollMiddle: 100, bollLower: 99,
  roc: 1, maroc: .5, rsi6: 50, rsi12: 51, rsi24: 52, atrPercent: 2.5, bbw: 6, oi: 1_000, buy: 20, sell: 30,
  ...overrides,
})
const bars = (start: number, count: number, intervalMS = hour) => Array.from({ length: count }, (_, index) => bar(start + index, intervalMS))
const response = (values: PreparedChartBar[], overrides: Partial<PreparedChartResponse> = {}): PreparedChartResponse => ({
  instId, timeframe: '1H', intervalMS: hour, generation: 1, revision: 1,
  endHour: values.at(-1)?.hour ?? null, latestEnd: values.at(-1)?.hour ?? null,
  oldestHour: values[0]?.hour ?? null, historyExhausted: false, bars: values,
  oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '', ...overrides,
})

test('resident window projection is reused until canonical bars or source metadata change', () => {
  const store = new PreparedChartStore(), events: OperationEvent[] = []
  store.ingest(response(bars(0, 400)))
  const stop = attachOperationSink(event => { if (event.name === 'chart.window.project') events.push(event) })
  try {
    const first = store.window(instId, '1H', 300 * hour)!
    for (let index = 0; index < 32; index++) assert.equal(store.window(instId, '1H', 300 * hour), first)
    assert.equal(events.length, 1, 'Unchanged navigation must not repeat the 96-slot projection or source checks.')

    store.ingest(response([bar(250, hour, { close: 102 })], { revision: 2, latestEnd: 399 * hour }))
    const corrected = store.window(instId, '1H', 300 * hour)!
    assert.equal(corrected.bars.find(value => value.hour === 250 * hour)!.close, 102)
    assert.equal(first.bars.find(value => value.hour === 250 * hour)!.close, 101)
    assert.equal(events.length, 2)

    store.ingest(response([], { revision: 3, endHour: 300 * hour, latestEnd: 399 * hour, realtimeState: 'live', priceObservedAt: 1_800_000_000_000 }))
    const refreshed = store.window(instId, '1H', 300 * hour)!
    assert.equal(refreshed.realtimeState, 'live')
    assert.equal(refreshed.priceObservedAt, 1_800_000_000_000)
    assert.equal(refreshed.bars, corrected.bars, 'Metadata changes preserve canonical bar identity.')
    assert.equal(events.length, 3)
    assert.equal(store.window(instId, '1H', 300 * hour), refreshed)
    assert.equal(events.length, 3)
  } finally { stop() }
})

test('partial price windows render independently of unknown indicators and statistics', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 12).map(value => ({ ...value, statisticsSources: 0, statisticsObserved: false, indicatorsObserved: false,
    oi: null, buy: null, sell: null, ema: null }))))
  const ready = store.window(instId, '1H')!
  assert.equal(ready.bars.length, 12)
  assert.equal(ready.priceState, 'partial'); assert.equal(ready.oiState, 'loading'); assert.equal(ready.takerState, 'loading')
  assert.equal(ready.indicatorState, 'loading'); assert.equal(ready.realtimeState, 'stale')
  store.ingest(response([{ ...bar(12), confirmed: false } as PreparedChartBar], { latestEnd: 12 * hour, revision: 2 }))
  assert.equal(store.window(instId, '1H'), null, 'An unconfirmed row cannot masquerade as a persisted completed candle.')
  store.ingest(response([bar(12)], { revision: 3 }))
  assert.equal(store.window(instId, '1H')?.bars.length, 13)
  assert.equal(store.window(instId, '1H', 13 * hour), null, 'An absent requested end remains a real price gap.')
})

test('known overscan lookups return only exact current-generation cached bars without filling gaps', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 96)))
  assert.deepEqual(store.knownBars(instId, '1H', [-hour, 0, 40 * hour, 95 * hour, 96 * hour]),
    [undefined, store.window(instId, '1H')!.bars[0], store.window(instId, '1H')!.bars[40], store.window(instId, '1H')!.bars[95], undefined])

  store.ingest(response([bar(96)], { generation: 2, revision: 1, latestEnd: 96 * hour }))
  assert.deepEqual(store.knownBars(instId, '1H', [0, 96 * hour]), [undefined, store.window(instId, '1H')!.bars[0]],
    'A generation change invalidates old adjacent slots even if their prior objects remain referenced elsewhere.')
  assert.deepEqual(store.knownBars(instId, '1H', [Number.NaN, 96 * hour + 1]), [undefined, undefined],
    'Invalid timestamps do not trigger a nearest-bar fallback.')
})

test('a present latest candle cannot certify a window with an interior price gap', () => {
  for (const compact of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H', instId)
    const complete = bars(104, 96), sparse = complete.filter((_, index) => index !== 40)
    const ingest = (values: PreparedChartBar[], revision: number) => {
      const frame = response(values, { revision, endHour: 199 * hour, latestEnd: 199 * hour, priceState: 'ready' })
      assert.equal(compact ? store.ingestLatest(frame) : store.ingest(frame), true)
    }
    ingest(sparse, 1)
    const partial = store.window(instId, '1H')!
    assert.equal(partial.bars.length, 95)
    assert.equal(partial.priceState, 'partial', 'All timestamp slots must exist, even when the producer claims readiness.')
    assert.equal(partial.indicatorState, 'ready'); assert.equal(partial.oiState, 'loading'); assert.equal(partial.takerState, 'loading')
    assert.deepEqual(store.readyBoundaries(instId, '1H'), [], 'Sparse prices provide no complete navigation runway.')
    ingest(compact ? complete : [complete[40]], 2)
    const repaired = store.window(instId, '1H')!
    assert.equal(repaired.priceState, 'ready')
    assert.deepEqual(repaired.bars.map(bar => bar.hour), complete.map(bar => bar.hour))
    assert.equal(repaired.bars[0], partial.bars[0], 'Repairing one slot reuses unchanged prepared observations.')
  }
})

test('detached live prices never certify an old completed chart as current', () => {
  for (const compact of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H', instId)
    const frame = response(bars(104, 96), { priceState: 'ready', liveBar: { ...bar(272), confirmed: false } })
    assert.equal(compact ? store.ingestLatest(frame) : store.ingest(frame), true)
    const latest = store.window(instId, '1H')!
    assert.equal(latest.priceState, 'stale')
    assert.equal(latest.bars.length, 96); assert.equal(latest.liveBar?.hour, 272 * hour)
    assert.equal(latest.indicatorState, 'ready', 'Actual confirmed indicators remain independently reusable.')
    if (!compact) assert.equal(store.window(instId, '1H', 198 * hour)?.priceState, 'partial', 'A historical window validates its own grid.')
  }
})

test('a known listing boundary certifies every available slot without requiring prelisting candles', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H', instId)
  store.ingestLatest(response(bars(188, 12), { historyExhausted: true, priceState: 'ready', liveBar: { ...bar(200), confirmed: false } }))
  const listed = store.window(instId, '1H')!
  assert.equal(listed.bars.length, 12)
  assert.equal(listed.priceState, 'ready')
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [{ firstEnd: 199 * hour, lastEnd: 199 * hour }])
})

test('historical price completeness retains missing source inputs independently of timestamp coverage', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H', instId)
  const partial = bars(0, 300).map(bar => ({ ...bar, priceComplete: bar.hour !== 150 * hour }))
  store.ingest(response(partial, { latestEnd: 299 * hour, endHour: 180 * hour, priceState: 'partial', revision: 1 }))
  assert.equal(store.window(instId, '1H', 180 * hour)?.bars.length, 96)
  assert.equal(store.window(instId, '1H', 180 * hour)?.priceState, 'partial')
  assert.equal(store.window(instId, '1H', 299 * hour)?.priceState, 'ready', 'A historical defect cannot poison a different complete viewport.')
  assert.ok(store.readyBoundaries(instId, '1H').every(range => !(range.firstEnd <= 180 * hour && range.lastEnd >= 180 * hour)))
  store.ingest(response([{ ...bar(150), priceComplete: true }], { latestEnd: 299 * hour, endHour: 180 * hour, priceState: 'ready', revision: 2 }))
  assert.equal(store.window(instId, '1H', 180 * hour)?.priceState, 'ready')
})

test('price freshness changes refresh memoized windows without invalidating historical data', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H', instId)
  const frame = response(bars(0, 200), { revision: 1, priceState: 'ready', priceAsOf: 199 * hour, realtimeState: 'stale' })
  store.ingest(frame)
  const current = store.window(instId, '1H')!, historical = store.window(instId, '1H', 100 * hour)!
  store.ingest({ ...frame, revision: 2, priceState: 'stale' })
  const stale = store.window(instId, '1H')!
  assert.equal(stale.priceState, 'stale')
  assert.equal(stale.bars, current.bars, 'Freshness updates do not rebuild prepared price data.')
  assert.equal(store.window(instId, '1H', 100 * hour), historical)
  assert.equal(store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 3, endHour: 199 * hour,
    liveBar: { ...bar(200), confirmed: false }, priceState: 'ready', priceAsOf: 200 * hour, realtimeState: 'live' }), true)
  const fresh = store.window(instId, '1H')!
  assert.equal(fresh.priceState, 'ready'); assert.equal(fresh.priceAsOf, 200 * hour)
  assert.equal(fresh.bars, current.bars)
  assert.equal(store.window(instId, '1H', 100 * hour)?.priceState, 'ready')
})

test('availability belongs to each window and explicitly observed nulls are complete data', () => {
  const store = new PreparedChartStore()
  const values = bars(0, 200)
  values[2] = bar(2, hour, { oi: null, ema: null })
  values[3] = bar(3, hour, { buy: null, sell: null })
  values[5] = bar(5, hour, { buy: 0, sell: 0 })
  store.ingest(response(values, { oiState: 'unavailable', takerState: 'unavailable', indicatorState: 'unavailable' }))
  const older = store.window(instId, '1H', 95 * hour)!
  assert.equal(older.oiState, 'unavailable')
  assert.equal(older.takerState, 'unavailable')
  assert.equal(older.indicatorState, 'unavailable')
  assert.deepEqual([older.bars[5].buy, older.bars[5].sell], [0, 0])
  const latest = store.window(instId, '1H')!
  assert.equal(latest.oiState, 'ready')
  assert.equal(latest.takerState, 'ready')
  assert.equal(latest.indicatorState, 'ready')
})

test('price-only history refreshes cannot erase calculated indicators or observed statistics in the same canonical generation', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H', instId)
  store.ingest(response(bars(0, 150), { revision: 10 }))
  const original = store.window(instId, '1H', 100 * hour)!
  const pending = bars(0, 150).map(value => ({ ...value,
    indicatorsObserved: false, statisticsObserved: false, oiObserved: false, takerObserved: false, statisticsSources: 0,
    vwap: null, ema: null, bollUpper: null, bollMiddle: null, bollLower: null,
    roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null, oi: null, buy: null, sell: null,
  }))
  store.ingest(response(pending, { revision: 11, indicatorState: 'loading', oiState: 'loading', takerState: 'loading' }))
  const next = store.window(instId, '1H', 100 * hour)!
  for (const [index, value] of next.bars.entries()) for (const field of ['ema', 'vwap', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw', 'oi', 'buy', 'sell'] as const) assert.equal(value[field], original.bars[index][field])
  assert.equal(next.indicatorState, 'ready')
  assert.equal(next.oiState, 'ready')
  assert.equal(next.takerState, 'ready')
  assert.equal(store.window(instId, '1H')!.indicatorState, 'ready')
})

test('a changed canonical price and explicitly calculated nulls remain authoritative over prior indicators', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 96)))
  store.ingest(response([bar(95, hour, { close: 102, indicatorsObserved: false, ema: null })], { revision: 2 }))
  assert.equal(store.window(instId, '1H')!.bars.at(-1)!.ema, null)
  store.ingest(response([bar(95, hour, { close: 102, indicatorsObserved: true, ema: null, oi: null, oiObserved: true,
    buy: null, sell: null, takerObserved: true })], { revision: 3 }))
  const latest = store.window(instId, '1H')!
  assert.equal(latest.bars.at(-1)!.ema, null)
  assert.equal(latest.oiState, 'unavailable')
  assert.equal(latest.takerState, 'unavailable')
})

test('a newer indicator generation clears all old windows and rejects late old data', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 96), { generation: 10, revision: 50 }))
  const prior = store.window(instId, '1H')!
  store.ingest(response(bars(0, 48), { generation: 11, revision: 1, latestEnd: 95 * hour }))
  assert.equal(store.window(instId, '1H'), null)
  assert.equal(store.ingest(response(bars(0, 96), { generation: 9, revision: 1_000 })), false,
    'A never-before-seen lower generation is stale as well.')
  assert.equal(store.ingest(response(bars(0, 96), { generation: 10, revision: 1_001 })), false)
  store.ingest(response(bars(48, 48).map(value => ({ ...value, ema: 200 })), { generation: 11, revision: 2 }))
  const next = store.window(instId, '1H')!
  assert.notEqual(next, prior)
  assert.equal(next.bars.at(-1)?.ema, 200)
  assert.equal(prior.bars.at(-1)?.ema, 100, 'An already presented immutable snapshot never changes underneath React.')
})

test('reordered blocks can fill old ranges without overwriting newer observations', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 96), { revision: 10 }))
  store.ingest(response([bar(50, hour, { close: 110, high: 111 })], { revision: 20 }))
  store.ingest(response(bars(0, 201).map(value => ({ ...value, close: 105, high: 106 })), { revision: 11 }))
  const window = store.window(instId, '1H', 95 * hour)!
  assert.equal(window.bars[50].close, 110)
  assert.equal(window.bars[49].close, 105)
  assert.equal(store.latestEnd(instId, '1H'), 200 * hour)
  assert.equal(store.snapshotMeta(instId, '1H')?.revision, 20)
  assert.ok(store.window(instId, '1H', 200 * hour))
})

test('unchanged and distant blocks preserve memoized window identity and frozen data', () => {
  const store = new PreparedChartStore()
  let notifications = 0
  const unsubscribe = store.subscribe(instId, '1H', () => { notifications += 1 })
  const incoming = bars(0, 96)
  store.ingest(response(incoming))
  const first = store.window(instId, '1H')!
  incoming[0].close = 100.5
  assert.equal(first.bars[0].close, 101, 'Incoming transport objects are copied before caching.')
  store.ingest(response(bars(0, 96), { revision: 2 }))
  assert.equal(store.window(instId, '1H'), first)
  store.ingest(response(bars(300, 100), { revision: 3 }))
  assert.equal(store.window(instId, '1H', 95 * hour), first)
  store.ingest(response([bar(50, hour, { close: 110, high: 111 })], { revision: 4 }))
  assert.notEqual(store.window(instId, '1H', 95 * hour), first)
  assert.equal(first.bars[50].close, 101)
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.bars) && Object.isFrozen(first.bars[0]))
  assert.equal(notifications, 4)
  unsubscribe()
  store.ingest(response(bars(500, 96), { revision: 5 }))
  assert.equal(notifications, 4)
})

test('series subscriptions notify the changed instrument and timeframe after each mutation', () => {
  const store = new PreparedChartStore()
  const eth = 'ETH-USDT-SWAP'
  const fiveMinutes = 5 * 60_000
  store.setUniverse([instId, eth], '1H')
  store.ingest(response(bars(0, 200), { latestEnd: 199 * hour }))
  store.ingestLatest(response(bars(104, 96), { instId: eth }))
  store.ingestLatest(response(bars(104, 96, fiveMinutes), { timeframe: '5m', intervalMS: fiveMinutes }))

  const notifications: string[] = []
  let latest = store.window(instId, '1H')
  let historical = store.window(instId, '1H', 95 * hour)
  let otherInstrument = store.window(eth, '1H')
  let otherTimeframe = store.window(instId, '5m')
  const unsubscribe = [
    store.subscribe(instId, '1H', () => {
      notifications.push(`${instId}:1H`)
      latest = store.window(instId, '1H')
      historical = store.window(instId, '1H', 95 * hour)
    }),
    store.subscribe(eth, '1H', () => {
      notifications.push(`${eth}:1H`)
      otherInstrument = store.window(eth, '1H')
    }),
    store.subscribe(instId, '5m', () => {
      notifications.push(`${instId}:5m`)
      otherTimeframe = store.window(instId, '5m')
    }),
  ]
  const expectOnly = (key: string) => {
    assert.deepEqual(notifications, [key])
    notifications.length = 0
  }

  const revised = bars(104, 96).map((value, index) => index === 95 ? { ...value, close: 110, high: 111 } : value)
  assert.equal(store.ingestLatest(response(revised, { revision: 2 })), true)
  expectOnly(`${instId}:1H`)
  assert.equal(latest, store.window(instId, '1H'))
  assert.equal(latest?.bars.at(-1)?.close, 110)
  assert.equal(otherInstrument, store.window(eth, '1H'))
  assert.equal(otherTimeframe, store.window(instId, '5m'))

  assert.equal(store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 3, endHour: 199 * hour,
    liveBar: { ...bar(200), confirmed: false }, realtimeState: 'live' }), true)
  expectOnly(`${instId}:1H`)
  assert.equal(latest?.liveBar?.hour, 200 * hour)
  assert.equal(latest, store.window(instId, '1H'))

  assert.equal(store.ingest(response([bar(50, hour, { close: 105, high: 106 })], { revision: 4, endHour: 50 * hour, latestEnd: 199 * hour })), true)
  expectOnly(`${instId}:1H`)
  assert.equal(historical, store.window(instId, '1H', 95 * hour))
  assert.equal(historical?.bars[50]?.close, 105)

  assert.equal(store.ingestLatest(response(bars(104, 96), { revision: 5, sourceVersions: { price: 5, oi: 2, taker: 3 }, priceAsOf: 199 * hour })), true)
  expectOnly(`${instId}:1H`)
  assert.deepEqual(latest?.sourceVersions, { price: 5, oi: 2, taker: 3 })
  assert.equal(latest, store.window(instId, '1H'))

  assert.equal(store.ingestLatest(response(bars(104, 96).map(value => ({ ...value, close: 120, high: 121 })), { generation: 2, revision: 1 })), true)
  expectOnly(`${instId}:1H`)
  assert.equal(latest?.generation, 2)
  assert.equal(latest, store.window(instId, '1H'))

  assert.equal(store.ingestLatest(response(bars(104, 96, fiveMinutes), { timeframe: '5m', intervalMS: fiveMinutes, revision: 2 })), true)
  expectOnly(`${instId}:5m`)
  assert.equal(otherTimeframe, store.window(instId, '5m'))
  assert.equal(otherInstrument, store.window(eth, '1H'))

  unsubscribe[2]()
  assert.equal(store.ingestLatest(response(bars(104, 96, fiveMinutes), { timeframe: '5m', intervalMS: fiveMinutes, revision: 3 })), true)
  assert.deepEqual(notifications, [])
  unsubscribe[0]()
  unsubscribe[1]()
})

test('byte eviction and universe cleanup notify subscribers whose readable window disappears', () => {
  const eth = 'ETH-USDT-SWAP'
  const completed = bars(0, 96)
  const oneSeriesBytes = completed.reduce((total, value) => total + JSON.stringify(value).length * 2, 0)
  const pressured = new PreparedChartStore({ maxBytes: oneSeriesBytes })
  pressured.ingest(response(completed, { instId: eth }))
  let evictedWindow = pressured.window(eth, '1H')
  const evictions: string[] = []
  const unsubscribeEviction = pressured.subscribe(eth, '1H', () => {
    evictions.push(eth)
    evictedWindow = pressured.window(eth, '1H')
  })
  assert.equal(pressured.ingest(response(completed, { instId })), true)
  assert.deepEqual(evictions, [eth])
  assert.equal(evictedWindow, null, 'The eviction callback observes that the other series no longer has a readable history window.')
  assert.ok(pressured.window(instId, '1H'), 'The incoming series remains readable within the same byte budget.')
  unsubscribeEviction()

  const store = new PreparedChartStore()
  store.setUniverse([instId, eth], '1H')
  store.ingestLatest(response(bars(104, 96)))
  store.ingestLatest(response(bars(104, 96), { instId: eth }))
  let removedWindow = store.window(instId, '1H')
  let retainedWindow = store.window(eth, '1H')
  const changes: string[] = []
  const unsubscribeRemoved = store.subscribe(instId, '1H', () => {
    changes.push(instId)
    removedWindow = store.window(instId, '1H')
  })
  const unsubscribeRetained = store.subscribe(eth, '1H', () => {
    changes.push(eth)
    retainedWindow = store.window(eth, '1H')
  })
  store.setUniverse([eth], '1H')
  assert.deepEqual(changes, [instId])
  assert.equal(removedWindow, null, 'Dropping a candidate releases its latest frame and notifies its mounted plot.')
  assert.equal(retainedWindow, store.window(eth, '1H'))
  unsubscribeRemoved()
  unsubscribeRetained()
})

test('source status changes notify the series after its window reflects the new status', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  const withoutOi = bars(104, 96).map(value => ({ ...value, oi: null, oiObserved: false, statisticsObserved: false, statisticsSources: 0 }))
  assert.equal(store.ingestLatest(response(withoutOi, { oiState: 'loading' })), true)
  let snapshot = store.window(instId, '1H')
  const notifications: string[] = []
  const unsubscribe = store.subscribe(instId, '1H', () => {
    notifications.push(instId)
    snapshot = store.window(instId, '1H')
  })

  const oiStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'Open interest source offline', retryAt: 123_456 }
  assert.equal(store.ingestLatest(response(withoutOi, { revision: 2, oiState: 'error', oiStatus })), true)
  assert.deepEqual(notifications, [instId])
  assert.equal(snapshot?.oiState, 'error')
  assert.equal(snapshot?.oiStatus?.error, oiStatus.error)
  assert.equal(snapshot, store.window(instId, '1H'))
  unsubscribe()
})

test('live data stays separate from confirmed windows and never leaks into historical presentation', () => {
  const store = new PreparedChartStore()
  const live: Bar = { ...bar(100), confirmed: false, statisticsSources: 0, statisticsObserved: false, indicatorsObserved: false }
  store.ingest(response(bars(0, 100), { revision: 10, liveBar: live }))
  const historical = store.window(instId, '1H', 95 * hour)!
  const latest = store.window(instId, '1H')!
  assert.equal(historical.liveBar, undefined)
  assert.equal(latest.endHour, 99 * hour)
  assert.equal(latest.bars.at(-1)?.confirmed, true)
  assert.equal(latest.liveBar?.confirmed, false)
  store.ingest(response([], { revision: 11, liveBar: { ...live, close: 110, high: 111 } }))
  assert.equal(store.window(instId, '1H', 95 * hour), historical)
  assert.equal(store.window(instId, '1H')?.liveBar?.close, 110)
  store.ingest(response([], { revision: 9, liveBar: live }))
  assert.equal(store.window(instId, '1H')?.liveBar?.close, 110)
  store.ingest(response([bar(100)], { revision: 12 }))
  assert.equal(store.window(instId, '1H')?.endHour, 100 * hour)
  assert.equal(store.window(instId, '1H')?.liveBar, undefined)
})

test('forming-only subscription deltas retain the exact frozen completed window and clear their overlay', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  store.ingestLatest(response(bars(104, 96)))
  const completed = store.window(instId, '1H')!
  const live: Bar = { ...bar(200), confirmed: false }
  const delta: PreparedChartLiveUpdate = { type: 'live', instId, timeframe: '1H', generation: 1, revision: 2, endHour: 199 * hour, liveBar: live }
  assert.equal(store.ingestLive(delta), true)
  const next = store.window(instId, '1H')!
  assert.equal(next.bars, completed.bars, 'A forming update does not clone or rebuild any completed observation.')
  assert.equal(next.endHour, completed.endHour)
  assert.ok(next.bars.every((bar, index) => bar === completed.bars[index]))
  assert.equal(completed.liveBar, undefined)
  assert.equal(next.liveBar?.close, 101)
  live.close = 100.5
  assert.equal(next.liveBar?.close, 101, 'Transport objects cannot mutate a presented overlay.')
  assert.ok(Object.isFrozen(next) && Object.isFrozen(next.liveBar) && Object.isFrozen(next.bars))
  assert.equal(store.size, 0, 'Forming updates do not allocate deep navigation history.')
  assert.equal(store.ingestLive({ ...delta, revision: 3, liveBar: null }), true)
  assert.equal(store.window(instId, '1H')?.bars, completed.bars)
  assert.equal(store.window(instId, '1H')?.liveBar, undefined)
  assert.equal(next.liveBar?.close, 101, 'Clearing a newer overlay preserves the prior immutable view.')
})

test('live-only projections match full-frame projections across price, source, and boundary states', () => {
  const endHour = 199 * hour, complete = bars(104, 96)
  const readyStatus = { state: 'ready' as const, from: 104 * hour, through: endHour, inputVersion: 'basis-1' }
  const errorStatus = { state: 'error' as const, from: 104 * hour, through: endHour, error: 'source failed', retryAt: 42 }
  const attached: Bar = { ...bar(200), confirmed: false }
  const detached: Bar = { ...bar(203), confirmed: false }
  const frame = (values: PreparedChartBar[], overrides: Partial<PreparedChartResponse> = {}) => response(values, {
    endHour, latestEnd: endHour, priceState: 'ready', priceAsOf: endHour, priceObservedAt: 10, realtimeState: 'live',
    sourceVersions: { price: 1, oi: 2, taker: 3 }, liveBar: attached,
    priceStatus: readyStatus, oiStatus: readyStatus, takerStatus: readyStatus, indicatorStatus: readyStatus, ...overrides,
  })
  const cases = [
    ['ready', frame(complete)],
    ['stale', frame(complete, { priceState: 'stale' })],
    ['detached', frame(complete, { liveBar: detached })],
    ['no source statuses', frame(complete, { priceStatus: undefined, oiStatus: undefined, takerStatus: undefined, indicatorStatus: undefined })],
    ['complete prices supersede a source error', frame(complete, { priceStatus: errorStatus })],
    ['observed null values', frame(complete.map((value, index) => index === 10 ? { ...value, oi: null, buy: null, sell: null, ema: null } : value))],
    ['independent source failure', frame(complete.map(value => ({ ...value, oi: null, oiObserved: false, statisticsObserved: false, statisticsSources: 2 })), { oiStatus: errorStatus })],
    ['exhausted listing boundary', frame(bars(188, 12), { oldestHour: 188 * hour, historyExhausted: true })],
    ['partial price range', frame(complete.map((value, index) => index === 10 ? { ...value, priceComplete: false } : value), { priceStatus: undefined })],
    ['failed price range', frame(complete.filter((_, index) => index !== 10), { priceStatus: errorStatus })],
    ['forming only', frame([], { oldestHour: null })],
    ['forming only with price failure', frame([], { oldestHour: null, priceStatus: errorStatus })],
  ] as const

  for (const [name, initial] of cases) {
    const actual = new PreparedChartStore(), reference = new PreparedChartStore()
    actual.setUniverse([instId], '1H'); reference.setUniverse([instId], '1H')
    assert.equal(actual.ingestLatest(initial), true, name)
    assert.equal(reference.ingestLatest(initial), true, name)
    let full = initial
    const changes: Array<Partial<PreparedChartLiveUpdate> & { liveBar: Bar | null }> = [
      { liveBar: { ...attached, close: 100.5 }, priceState: 'ready', priceAsOf: 200 * hour, priceObservedAt: 20, sourceVersions: { price: 2, oi: 3, taker: 4 } },
      { liveBar: detached, priceState: 'ready', realtimeState: 'stale' },
      { liveBar: attached, priceState: 'stale', priceAsOf: null, priceObservedAt: null },
      ...(initial.bars.length ? [{ liveBar: null, priceState: 'ready' as const }] : []),
      { liveBar: { ...attached, close: 100.25 }, priceState: 'ready', realtimeState: 'live', sourceVersions: { price: 3, oi: 4, taker: 5 } },
    ]
    for (const [index, change] of changes.entries()) {
      const revision = index + 2
      const before = actual.window(instId, '1H')!, beforeCopy = structuredClone(before)
      const delta: PreparedChartLiveUpdate = { type: 'live', instId, timeframe: '1H', generation: 1, revision, endHour, ...change }
      full = { ...full, revision, liveBar: change.liveBar ?? undefined,
        priceState: change.priceState ?? full.priceState, priceAsOf: change.priceAsOf ?? full.priceAsOf,
        priceObservedAt: change.priceObservedAt ?? full.priceObservedAt, realtimeState: change.realtimeState ?? full.realtimeState,
        sourceVersions: change.sourceVersions ?? full.sourceVersions }
      assert.equal(actual.ingestLive(delta), true, `${name}: delta ${index}`)
      assert.equal(reference.ingestLatest(full), true, `${name}: full frame ${index}`)
      const result = actual.window(instId, '1H')!
      assert.deepEqual(result, reference.window(instId, '1H'), `${name}: full projection ${index}`)
      assert.deepEqual(before, beforeCopy, `${name}: previous snapshot ${index}`)
      assert.equal(result.bars, before.bars, `${name}: completed bars ${index}`)
      assert.equal(result.oiStatus, before.oiStatus, `${name}: OI status ${index}`)
      assert.equal(result.takerStatus, before.takerStatus, `${name}: taker status ${index}`)
      assert.equal(result.indicatorStatus, before.indicatorStatus, `${name}: indicator status ${index}`)
      if (JSON.stringify(result.priceStatus) === JSON.stringify(before.priceStatus)) assert.equal(result.priceStatus, before.priceStatus, `${name}: price status ${index}`)
      assert.ok(Object.isFrozen(result) && Object.isFrozen(result.bars))
      if (result.liveBar) assert.ok(Object.isFrozen(result.liveBar))
      for (const value of [result.priceStatus, result.oiStatus, result.takerStatus, result.indicatorStatus, result.sourceVersions]) {
        if (value) assert.ok(Object.isFrozen(value), `${name}: published metadata must be immutable`)
      }
    }

    if (!initial.bars.length) {
      const before = actual.window(instId, '1H')!, beforeCopy = structuredClone(before)
      assert.equal(actual.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 20, endHour, liveBar: null }), true)
      const { liveBar: _liveBar, ...withoutLive } = before
      const expected = { ...withoutLive, priceState: before.priceStatus?.state === 'error' ? 'error' : 'loading',
        priceStatus: before.priceStatus?.state === 'error' ? before.priceStatus : before.priceStatus && { state: 'loading', from: 104 * hour, through: endHour } }
      assert.deepEqual(actual.window(instId, '1H'), expected, `${name}: clearing the only forming bar`)
      assert.deepEqual(before, beforeCopy)
    }
  }
})

test('live price freshness is recalculated when a historical projection is repinned as latest', () => {
  const store = new PreparedChartStore(), reference = new PreparedChartStore(), endHour = 199 * hour
  store.setUniverse([instId], '1H', instId); reference.setUniverse([instId], '1H')
  const priceStatus = { state: 'ready' as const, from: 104 * hour, through: endHour }
  const initial = response(bars(104, 96), { priceState: 'stale', priceStatus })
  assert.equal(store.ingest(initial), true)
  assert.equal(store.window(instId, '1H')!.priceState, 'stale')
  assert.equal(store.ingest(response([bar(150)], { revision: 2, endHour: 150 * hour, latestEnd: 201 * hour })), true)
  const repinned = store.window(instId, '1H')!
  assert.equal(repinned.endHour, endHour); assert.equal(repinned.priceState, 'ready')
  assert.equal(store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 3, endHour, liveBar: null }), true)
  assert.equal(reference.ingestLatest({ ...initial, revision: 3 }), true)
  assert.equal(store.window(instId, '1H')!.priceState, 'stale')
  assert.equal(store.window(instId, '1H')!.bars, repinned.bars)
  assert.deepEqual(store.window(instId, '1H'), reference.window(instId, '1H'))
})

test('live reuse retains immutable metadata and invalidates on full corrections and generation changes', () => {
  const store = new PreparedChartStore(), full = new PreparedChartStore(), endHour = 199 * hour
  store.setUniverse([instId], '1H', instId); full.setUniverse([instId], '1H', instId)
  const versions = { price: 1, oi: 2, taker: 3 }, live: Bar = { ...bar(200), confirmed: false }
  const status = { state: 'ready' as const, from: 104 * hour, through: endHour }
  let frame = response(bars(104, 96), { liveBar: live, sourceVersions: versions, priceState: 'ready', oiStatus: status })
  assert.equal(store.ingest(frame), true); assert.equal(full.ingest(frame), true)
  const first = store.window(instId, '1H')!, firstCopy = structuredClone(first), meta = store.snapshotMeta(instId, '1H')!
  assert.ok(Object.isFrozen(meta.oiStatus) && Object.isFrozen(meta.sourceStatuses)
    && meta.sourceStatuses!.every(value => Object.isFrozen(value) && Object.isFrozen(value.status)))
  versions.oi = 99; live.close = 100.5; status.through = 104 * hour
  assert.deepEqual(first, firstCopy, 'Transport mutations cannot change a previously published view.')
  assert.equal(meta.oiStatus!.through, endHour, 'Source metadata remains detached from the transport.')

  const nextVersions = { price: 2, oi: 2, taker: 3 }, nextLive: Bar = { ...bar(200), confirmed: false, close: 100.5 }
  const delta: PreparedChartLiveUpdate = { type: 'live', instId, timeframe: '1H', generation: 1, revision: 2, endHour,
    liveBar: nextLive, priceObservedAt: 20, sourceVersions: nextVersions }
  assert.equal(store.ingestLive(delta), true)
  const updated = store.window(instId, '1H')!, updatedCopy = structuredClone(updated)
  nextVersions.oi = 90; nextLive.close = 100.25
  assert.deepEqual(updated, updatedCopy, 'Live payloads are detached from the frozen view.')
  assert.deepEqual(first, firstCopy)
  assert.notEqual(updated.sourceVersions, first.sourceVersions)
  assert.equal(store.ingestLive({ ...delta, revision: 3, liveBar: { ...updated.liveBar! }, sourceVersions: { ...updated.sourceVersions! } }), true)
  assert.equal(store.window(instId, '1H'), updated, 'An equal live update keeps the entire published object.')
  assert.equal(store.ingestLive({ ...delta, revision: 4, liveBar: { ...updated.liveBar! }, priceObservedAt: 21, sourceVersions: { ...updated.sourceVersions! } }), true)
  assert.equal(store.window(instId, '1H')!.sourceVersions, updated.sourceVersions, 'Equal source versions retain their identity even when freshness changes.')

  const corrected = bars(104, 96).map((value, index) => index === 40 ? { ...value, close: 102, oi: null } : value)
  frame = response(corrected, { revision: 5, liveBar: { ...updated.liveBar! }, sourceVersions: { ...updated.sourceVersions! }, priceState: 'ready',
    oiStatus: { state: 'ready', from: 104 * hour, through: endHour } })
  assert.equal(store.ingest(frame), true); assert.equal(full.ingest(frame), true)
  const correction = store.window(instId, '1H')!
  assert.equal(correction.bars[40].close, 102); assert.equal(correction.oiState, 'unavailable')
  assert.notEqual(correction.bars, first.bars)
  assert.deepEqual(first, firstCopy)
  const afterCorrection = { ...delta, revision: 6, liveBar: { ...updated.liveBar! }, sourceVersions: { ...updated.sourceVersions! } }
  assert.equal(store.ingestLive(afterCorrection), true)
  assert.equal(full.ingest({ ...frame, revision: 6, priceObservedAt: afterCorrection.priceObservedAt }), true)
  assert.deepEqual(store.window(instId, '1H'), full.window(instId, '1H'))
  assert.equal(store.window(instId, '1H')!.bars, correction.bars)

  const newGeneration = response(bars(188, 12), { generation: 2, revision: 1, oldestHour: 188 * hour, historyExhausted: true,
    liveBar: { ...bar(200), confirmed: false }, priceState: 'ready' })
  assert.equal(store.ingestLatest(newGeneration), true); assert.equal(full.ingestLatest(newGeneration), true)
  const regenerated = store.window(instId, '1H')!
  assert.equal(regenerated.generation, 2); assert.equal(regenerated.priceState, 'partial'); assert.equal(regenerated.bars.length, 12)
  assert.equal(store.snapshotMeta(instId, '1H')!.oldestHour, 104 * hour, 'A new generation cannot move an established listing boundary forward.')
  assert.equal(store.ingestLive({ ...afterCorrection, revision: 100 }), false, 'Old provenance cannot update a new generation.')
  assert.equal(store.window(instId, '1H'), regenerated)
  assert.equal(store.ingestLive({ ...afterCorrection, generation: 2, revision: 2 }), true)
  assert.equal(full.ingestLatest({ ...newGeneration, revision: 2, liveBar: afterCorrection.liveBar!, priceObservedAt: afterCorrection.priceObservedAt,
    sourceVersions: afterCorrection.sourceVersions }), true)
  assert.deepEqual(store.window(instId, '1H'), full.window(instId, '1H'))
  const repaired = response(bars(104, 96), { generation: 2, revision: 3, historyExhausted: true, liveBar: afterCorrection.liveBar!, priceState: 'ready' })
  assert.equal(store.ingestLatest(repaired), true); assert.equal(full.ingestLatest(repaired), true)
  assert.equal(store.window(instId, '1H')!.priceState, 'ready')
  assert.deepEqual(store.window(instId, '1H'), full.window(instId, '1H'))
  assert.deepEqual(first, firstCopy)
})

test('forming deltas require an existing exact generation and completed end and reject stale or malformed input', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  const live: Bar = { ...bar(200), confirmed: false }
  const delta: PreparedChartLiveUpdate = { type: 'live', instId, timeframe: '1H', generation: 1, revision: 10, endHour: 199 * hour, liveBar: live }
  assert.equal(store.ingestLive(delta), false, 'A delta cannot authorize its own completed source frame.')
  store.ingestLatest(response(bars(104, 96), { revision: 10 }))
  const previous = store.window(instId, '1H')
  for (const invalid of [
    { ...delta, generation: 2 },
    { ...delta, generation: 0 },
    { ...delta, revision: 9 },
    { ...delta, revision: 10.5 },
    { ...delta, endHour: 198 * hour },
    { ...delta, liveBar: { ...live, hour: 199 * hour } },
    { ...delta, liveBar: { ...live, hour: 200 * hour + 1 } },
    { ...delta, liveBar: { ...live, confirmed: true } },
    { ...delta, liveBar: { ...live, confirmed: undefined as unknown as boolean } },
    { ...delta, liveBar: undefined as unknown as Bar },
    { ...delta, liveBar: { ...live, high: Number.NaN } },
    { ...delta, liveBar: { ...live, close: 200 } },
  ]) {
    assert.equal(store.ingestLive(invalid), false)
    assert.equal(store.window(instId, '1H'), previous)
  }
  assert.equal(store.ingestLatest(response(bars(104, 96), { generation: 2 })), true, 'A rejected delta cannot poison a later complete generation.')
  assert.equal(store.ingestLive({ ...delta, generation: 2 }), true)
  assert.equal(store.size, 0)
})

test('full frames also require a validated forming bar before presenting it', () => {
  for (const compact of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H')
    const invalid = { ...bar(200), confirmed: undefined as unknown as boolean }
    const frame = response(bars(104, 96), { liveBar: invalid })
    assert.equal(compact ? store.ingestLatest(frame) : store.ingest(frame), true)
    assert.equal(store.window(instId, '1H')!.liveBar, undefined)
    assert.equal(store.window(instId, '1H')!.priceState, 'ready')
  }
  for (const endHour of [null, 199 * hour]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H')
    const invalid = { ...bar(200), confirmed: undefined as unknown as boolean }
    assert.equal(store.ingestLatest(response([], { endHour, latestEnd: endHour, liveBar: invalid })), false,
      'An invalid forming bar cannot establish a boundary or admit an empty frame.')
    assert.equal(store.window(instId, '1H'), null)
  }
})

test('forming deltas preserve deep durable history bounds when compact latest outlives raw bar pressure', () => {
  const store = new PreparedChartStore({ maxBarsPerSeries: 96 })
  store.setUniverse([instId], '1H')
  store.ingestLatest(response(bars(104, 96), { oldestHour: null }))
  store.ingest(response(bars(0, 96), { endHour: 95 * hour, latestEnd: 199 * hour, oldestHour: 0, historyExhausted: true, revision: 2 }))
  const historical = store.window(instId, '1H', 95 * hour)!
  assert.equal(store.snapshotMeta(instId, '1H')?.oldestHour, 0)
  assert.equal(store.snapshotMeta(instId, '1H')?.historyExhausted, true)
  assert.equal(store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 3, endHour: 199 * hour,
    liveBar: { ...bar(200), confirmed: false } }), true)
  assert.equal(store.snapshotMeta(instId, '1H')?.oldestHour, 0, 'A compact overlay cannot erase a durable listing boundary.')
  assert.equal(store.snapshotMeta(instId, '1H')?.historyExhausted, true)
  assert.equal(store.snapshotMeta(instId, '1H')?.revision, 3)
  assert.equal(store.window(instId, '1H', 95 * hour), historical)
  assert.equal(historical.liveBar, undefined)
})

test('ready boundaries represent complete ranges and prefetch fills gaps without moving a window', () => {
  const store = new PreparedChartStore()
  store.ingest(response([...bars(0, 100), ...bars(200, 100)]))
  const first = store.window(instId, '1H', 99 * hour)
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [
    { firstEnd: 95 * hour, lastEnd: 99 * hour }, { firstEnd: 295 * hour, lastEnd: 299 * hour },
  ])
  assert.equal(store.hasRange(instId, '1H', 0, 99 * hour), true)
  assert.equal(store.hasRange(instId, '1H', 0, 200 * hour), false)
  assert.equal(store.window(instId, '1H', 180 * hour), null)
  store.ingest(response(bars(100, 100), { revision: 2 }))
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [{ firstEnd: 95 * hour, lastEnd: 299 * hour }])
  assert.equal(store.window(instId, '1H', 99 * hour), first)
  assert.ok(store.window(instId, '1H', 180 * hour))
})

test('instrument and native timeframe caches have independent generations and history bounds', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 100), { generation: 20, historyExhausted: true }))
  store.ingest(response(bars(0, 100, 300_000), { timeframe: '5m', intervalMS: 300_000, generation: 1, latestEnd: 99 * 300_000, oldestHour: 0 }))
  store.ingest(response(bars(0, 100), { instId: 'ETH-USDT-SWAP', generation: 1 }))
  assert.equal(store.size, 3)
  assert.equal(store.window(instId, '5m')?.intervalMS, 300_000)
  assert.equal(store.snapshotMeta(instId, '1H')?.historyExhausted, true)
  assert.equal(store.snapshotMeta(instId, '5m')?.historyExhausted, false)
  assert.equal(store.oldestHour(instId, '1H'), 0)
  assert.equal(store.ingest(response(bars(0, 96), { timeframe: '5m', intervalMS: hour })), false)
  assert.ok(store.window('ETH-USDT-SWAP', '1H'))
})

test('only a proven listing floor admits short viewports into ready boundaries', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(100, 12)))
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [])
  store.ingest(response(bars(100, 12), { revision: 2, historyExhausted: true }))
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [{ firstEnd: 100 * hour, lastEnd: 111 * hour }], 'A new floor proof invalidates the cached boundaries even when prices are identical.')
})

test('a new source-unavailability annotation replaces only the affected immutable window', () => {
  const store = new PreparedChartStore()
  const values = bars(0, 200)
  values[10] = bar(10, hour, { oi: null })
  store.ingest(response(values))
  const older = store.window(instId, '1H', 95 * hour)!
  const latest = store.window(instId, '1H')
  store.ingest(response([bar(10, hour, { oi: null, oiUnavailableReason: 'not-published' })], { revision: 2 }))
  const updated = store.window(instId, '1H', 95 * hour)!
  assert.notEqual(updated, older)
  assert.equal(updated.bars[10].oiUnavailableReason, 'not-published')
  assert.equal(older.bars[10].oiUnavailableReason, undefined)
  assert.equal(store.window(instId, '1H'), latest)
})

test('bar pressure preserves the requested viewport and evicted ends require a fresh local read', () => {
  const store = new PreparedChartStore({ maxBarsPerSeries: 128 })
  store.ingest(response(bars(0, 201), { endHour: 100 * hour, oldestHour: 0 }))
  const held = store.window(instId, '1H', 100 * hour)!
  assert.equal(held.bars.length, 96)
  assert.equal(held.bars[0].hour, 5 * hour, 'The requested window must survive a wider response containing nearer future samples.')
  assert.equal(store.hasRange(instId, '1H', 5 * hour, 100 * hour), true)
  assert.equal(store.window(instId, '1H', 200 * hour), null)
  store.ingest(response(bars(300, 201), { endHour: 400 * hour, revision: 2, oldestHour: 0 }))
  assert.equal(store.window(instId, '1H', 100 * hour), null)
  assert.equal(store.window(instId, '1H', 400 * hour)?.bars.length, 96)
  assert.ok(store.readyBoundaries(instId, '1H').every(range => range.firstEnd > 100 * hour), 'Eviction must discard old ready boundaries and memoized windows.')
  assert.equal(store.oldestHour(instId, '1H'), 0, 'A resident cache edge must not replace the proven provider boundary.')
  store.ingest(response(bars(5, 96).map(value => ({ ...value, close: 110, high: 111 })), { revision: 3, endHour: 100 * hour, latestEnd: 500 * hour }))
  const revisited = store.window(instId, '1H', 100 * hour)!
  assert.equal(revisited.bars.length, 96)
  assert.ok(revisited.bars.every(value => value.close === 110))
  assert.ok(held.bars.every(value => value.close === 101))
  assert.ok(Object.isFrozen(held) && Object.isFrozen(held.bars))
})

test('bar eviction changes the navigation residency watermark while compact observations keep their input version', () => {
  const store = new PreparedChartStore({ maxBarsPerSeries: 96 })
  const versions = { price: 1, oi: 1, taker: 1 }
  store.setUniverse([instId], '1H', instId)
  store.ingest(response(bars(104, 96), { sourceVersions: versions }))
  const epoch = store.historyEpoch(instId, '1H')
  store.ingestLatest(response(bars(104, 96), { revision: 2, sourceVersions: versions }))
  assert.equal(store.historyEpoch(instId, '1H'), epoch)
  store.ingest(response(bars(0, 96), { revision: 3, latestEnd: 199 * hour, sourceVersions: versions }))
  assert.ok(store.historyEpoch(instId, '1H') > epoch, 'Evicted observations cannot retain a failure/hydration certificate for the old residency.')
  assert.deepEqual(store.snapshotMeta(instId, '1H')?.sourceVersions, versions)
  assert.ok(store.window(instId, '1H'), 'The independently retained latest projection remains available.')
})

test('series LRU honors metadata and window reads while evicted snapshots stay immutable', () => {
  const store = new PreparedChartStore({ maxSeries: 2 })
  const eth = 'ETH-USDT-SWAP', sol = 'SOL-USDT-SWAP'
  store.ingest(response(bars(0, 96)))
  const btcWindow = store.window(instId, '1H')!
  store.ingest(response(bars(100, 96), { instId: eth }))
  const heldETH = store.window(eth, '1H')!
  store.snapshotMeta(instId, '1H')
  store.ingest(response(bars(200, 96), { instId: sol }))
  assert.equal(store.size, 2)
  assert.equal(store.window(eth, '1H'), null, 'A recently used BTC metadata view must keep BTC ahead of the older ETH series.')
  assert.equal(store.window(instId, '1H'), btcWindow)
  store.ingest(response(bars(100, 96).map(value => ({ ...value, close: 150, high: 151 })), { instId: eth, revision: 2 }))
  assert.equal(store.size, 2)
  assert.equal(store.window(sol, '1H'), null, 'Reading the BTC window must promote its series before the revisit.')
  assert.ok(store.window(eth, '1H')?.bars.every(value => value.close === 150))
  assert.ok(heldETH.bars.every(value => value.close === 101))
})

test('window memo LRU remains bounded without changing complete cached values', () => {
  const store = new PreparedChartStore({ maxWindowsPerSeries: 2 })
  store.ingest(response(bars(0, 100)))
  const first = store.window(instId, '1H', 95 * hour)!
  const second = store.window(instId, '1H', 96 * hour)!
  assert.equal(store.window(instId, '1H', 95 * hour), first)
  store.window(instId, '1H', 97 * hour)
  assert.equal(store.window(instId, '1H', 95 * hour), first, 'A memo read promotes the active window.')
  const revisited = store.window(instId, '1H', 96 * hour)!
  assert.notEqual(revisited, second)
  assert.deepEqual(revisited, second)
  assert.equal(revisited.bars.length, 96)
  assert.ok(revisited.bars.every(value => value.confirmed && value.statisticsObserved && value.indicatorsObserved))
})

test('the complete navigation universe retains compact latest frames independently of history pressure', () => {
  const store = new PreparedChartStore({ maxSeries: 2 })
  const ids = Array.from({ length: 20 }, (_, index) => `NAV${index}-USDT-SWAP`)
  store.setUniverse(ids, '1H')
  ids.forEach((id, index) => store.ingestLatest(response(bars(104, 96).map(value => ({ ...value, close: 200 + index, high: 201 + index })), { instId: id })))
  assert.equal(store.latestSize, 20)
  assert.equal(store.size, 0, 'Prewarming compact frames must not allocate full history series.')
  const held = store.window(ids[0], '1H')!
  ids.forEach((id, index) => store.ingest(response(bars(0, 200).map(value => ({ ...value, close: 200 + index, high: 201 + index })), { instId: id, revision: 2 })))
  assert.equal(store.size, 2)
  ids.forEach((id, index) => assert.ok(store.window(id, '1H')?.bars.every(value => value.close === 200 + index)))
  assert.equal(store.window(ids[0], '1H'), held)
  store.setUniverse([ids[0]], '1H')
  assert.equal(store.latestSize, 1, 'Candidates removed from navigation release their compact memory.')
  assert.ok(held.bars.every(value => value.close === 200))
})

test('native timeframe changes retain every candidate compact frame and release removed membership', () => {
  const store = new PreparedChartStore({ maxSeries: 2 })
  const ids = Array.from({ length: 20 }, (_, index) => `NATIVE${index}-USDT-SWAP`)
  const frames = ['5m', '15m', '1H'] as const
  store.setUniverse(ids, '15m')
  for (const [index, id] of ids.entries()) for (const timeframe of frames) {
    const intervalMS = timeframeMilliseconds(timeframe)
    assert.equal(store.ingestLatest(response(bars(104, 96, intervalMS).map(bar => ({ ...bar, close: 200 + index, high: 201 + index })), {
      instId: id, timeframe, intervalMS,
    })), true)
  }
  assert.equal(store.latestSize, ids.length * frames.length)
  assert.equal(store.size, 0, 'Pinning native frames does not allocate navigation histories.')
  const held = store.window(ids[0], '15m')!
  for (const timeframe of frames) {
    store.setUniverse(ids.toReversed(), timeframe)
    for (const [index, id] of ids.entries()) for (const native of frames) {
      const ready = store.window(id, native)!
      assert.equal(ready.timeframe, native)
      assert.equal(ready.bars.length, 96)
      assert.ok(ready.bars.every(bar => bar.close === 200 + index))
    }
  }
  assert.equal(store.window(ids[0], '15m'), held, 'Period changes preserve immutable compact window identity.')
  store.setUniverse([ids[0]], '5m')
  assert.equal(store.latestSize, 3)
  for (const timeframe of frames) {
    assert.equal(store.window(ids[1], timeframe), null)
    assert.ok(store.window(ids[0], timeframe))
  }
})

test('ready latest does not advance to an unprepared raw tail and generation changes invalidate both caches', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  store.ingestLatest(response(bars(104, 96), { generation: 10 }))
  const held = store.window(instId, '1H')!
  store.ingest(response(bars(0, 96), { generation: 10, revision: 2, latestEnd: 250 * hour }))
  assert.equal(store.window(instId, '1H'), held)
  assert.equal(store.latestEnd(instId, '1H'), 199 * hour)
  store.ingest(response(bars(0, 96), { generation: 11, revision: 1, latestEnd: 250 * hour }))
  assert.equal(store.window(instId, '1H'), null)
  assert.equal(store.latestEnd(instId, '1H'), null, 'Raw history metadata cannot authorize a latest prepared frame.')
  assert.ok(store.window(instId, '1H', 95 * hour))
  assert.equal(store.ingestLatest(response(bars(104, 96), { generation: 10, revision: 100 })), false)
  store.ingestLatest(response(bars(104, 96).map(value => ({ ...value, ema: 200 })), { generation: 12 }))
  assert.equal(store.window(instId, '1H', 95 * hour), null, 'A latest correction must invalidate old historical indicator anchors.')
  assert.ok(store.window(instId, '1H')?.bars.every(value => value.ema === 200))
  assert.ok(held.bars.every(value => value.ema === 100))
})

test('a historical bulk response replaces the latest indicator generation atomically', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  store.ingestLatest(response(bars(104, 96)))
  const previous = store.window(instId, '1H')!
  store.ingest(response(bars(0, 200).map(bar => ({ ...bar, ema: 200 })), {
    generation: 2, endHour: 100 * hour, latestEnd: 199 * hour,
  }))
  assert.equal(store.window(instId, '1H')?.endHour, 199 * hour)
  assert.ok(store.window(instId, '1H')?.bars.every(bar => bar.ema === 200))
  assert.ok(previous.bars.every(bar => bar.ema === 100), 'The previously painted snapshot remains immutable.')
  assert.ok(store.window(instId, '1H', 100 * hour)?.bars.every(bar => bar.ema === 200))
})

test('complete cache eviction retains the session generation watermark against late replies', () => {
  const store = new PreparedChartStore({ maxSeries: 1 })
  const eth = 'ETH-USDT-SWAP'
  store.setUniverse([instId], '1H')
  store.ingest(response(bars(0, 96), { generation: 10 }))
  const held = store.window(instId, '1H')!
  store.setUniverse([eth], '1H')
  store.ingest(response(bars(100, 96), { instId: eth }))
  assert.equal(store.window(instId, '1H'), null, 'Both the compact frame and history entry have been evicted.')
  assert.equal(store.ingest(response(bars(0, 96), { generation: 9, revision: 100 })), false)
  assert.equal(store.window(instId, '1H'), null, 'A late reply cannot resurrect an obsolete calculation generation.')
  store.setUniverse([instId], '1H')
  assert.equal(store.ingestLatest(response(bars(0, 96), { generation: 9, revision: 101 })), false)
  const corrected = response(bars(0, 96).map(value => ({ ...value, ema: 200 })), { generation: 11 })
  assert.equal(store.ingestLatest(corrected), true)
  store.setUniverse([], '1H')
  assert.equal(store.window(instId, '1H'), null)
  assert.equal(store.ingest(response(bars(0, 96), { generation: 10, revision: 102 })), false)
  assert.equal(store.ingest(corrected), true, 'An evicted key may be rehydrated at its current or a newer generation.')
  assert.ok(store.window(instId, '1H')?.bars.every(value => value.ema === 200))
  assert.ok(held.bars.every(value => value.ema === 100))
})


test('rendered candidates retain compact inputs under byte pressure and release them with membership', () => {
  const store = new PreparedChartStore({ maxBytes: 300_000 })
  const ids = Array.from({ length: 80 }, (_, index) => `BYTE${index}-USDT-SWAP`)
  store.setUniverse(ids, '1H', ids[0])
  for (const id of ids) store.ingestLatest(response(bars(104, 96), { instId: id }))
  assert.equal(store.latestSize, ids.length, 'Every listed chart retains its compact inputs independently of the history budget.')
  assert.equal(store.size, 0, 'Candidate residency must not pin deep histories.')
  assert.ok(store.window(ids[0], '1H'), 'The selected frame survives background candidate pressure.')
  assert.ok(store.window(ids[1], '1H'), 'An unselected listed chart cannot be evicted and reconstructed on selection.')
  store.setUniverse([ids[0]], '1H', ids[0])
  assert.equal(store.latestSize, 1, 'Removing candidates releases their compact working set.')
})

test('live freshness metadata reaches retained history and an old bulk read cannot rewind it', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H', instId)
  store.ingest(response(bars(0, 200), { revision: 5, sourceVersions: { price: 5, oi: 2, taker: 3 }, priceObservedAt: 1000, realtimeState: 'stale' }))
  store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 10, endHour: 199 * hour,
    liveBar: { ...bar(200), confirmed: false }, priceObservedAt: 2000, priceAsOf: 200 * hour,
    realtimeState: 'live', sourceVersions: { price: 5, oi: 4, taker: 6 } })
  assert.equal(store.snapshotMeta(instId, '1H')?.priceObservedAt, 2000)
  assert.equal(store.snapshotMeta(instId, '1H')?.realtimeState, 'live')
  assert.deepEqual(store.snapshotMeta(instId, '1H')?.sourceVersions, { price: 5, oi: 4, taker: 6 })
  store.ingest(response(bars(0, 100), { revision: 6, latestEnd: 199 * hour, priceObservedAt: 1100, realtimeState: 'stale', sourceVersions: { price: 4, oi: 1, taker: 2 } }))
  assert.equal(store.snapshotMeta(instId, '1H')?.priceObservedAt, 2000)
  assert.equal(store.snapshotMeta(instId, '1H')?.realtimeState, 'live')
  assert.deepEqual(store.snapshotMeta(instId, '1H')?.sourceVersions, { price: 5, oi: 4, taker: 6 })
  assert.equal(store.window(instId, '1H')?.liveBar?.hour, 200 * hour)
})

test('price generation resets retain bounded independent statistics without certifying old prices or technical fields', () => {
  const store = new PreparedChartStore({ maxBarsPerSeries: 200 })
  store.setUniverse([instId], '1H', instId)
  store.ingest(response(bars(0, 200)))
  const previous = store.window(instId, '1H', 95 * hour)!
  const raw = (values: PreparedChartBar[]) => values.map(value => ({ ...value,
    indicatorsObserved: false, statisticsObserved: false, oiObserved: false, takerObserved: false, statisticsSources: 0,
    vwap: null, ema: null, bollUpper: null, bollMiddle: null, bollLower: null,
    roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null, oi: null, buy: null, sell: null,
  }))
  store.ingestLatest(response(raw(bars(104, 96)), { generation: 2, revision: 2 }))
  const latest = store.window(instId, '1H')!
  assert.equal(latest.generation, 2); assert.equal(latest.indicatorState, 'loading')
  assert.ok(latest.bars.every(value => value.ema === null && value.oi === 1_000 && value.buy === 20 && value.sell === 30))
  assert.equal(store.window(instId, '1H', 95 * hour), null, 'Old-generation prices cannot establish a new-generation window.')
  assert.equal(store.hasRange(instId, '1H', 0, 95 * hour), false)
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [{ firstEnd: 199 * hour, lastEnd: 199 * hour }])
  store.ingest(response(raw(bars(0, 96)), { generation: 2, revision: 3, endHour: 95 * hour, latestEnd: 199 * hour }))
  const historical = store.window(instId, '1H', 95 * hour)!
  assert.equal(historical.generation, 2); assert.equal(historical.indicatorState, 'loading')
  assert.ok(historical.bars.every(value => value.ema === null && !value.indicatorsObserved && value.oi === 1_000 && value.buy === 20 && value.sell === 30))
  assert.equal(historical.oiState, 'ready'); assert.equal(historical.takerState, 'ready')
  assert.deepEqual(store.readyBoundaries(instId, '1H'), [{ firstEnd: 95 * hour, lastEnd: 95 * hour }, { firstEnd: 199 * hour, lastEnd: 199 * hour }], 'Promoting an old statistics carrier also updates price-range provenance.')
  assert.ok(previous.bars.every(value => value.ema === 100 && value.indicatorsObserved), 'An immutable prior presentation is retained separately from new-generation validity.')
  assert.equal(store.size, 1, 'Statistical provenance reuses the bounded series instead of a second cache.')
})

test('compact latest generation changes retain proven statistics but accept explicit source corrections', () => {
  const store = new PreparedChartStore()
  store.setUniverse([instId], '1H')
  store.ingestLatest(response(bars(104, 96)))
  const raw = bars(104, 96).map(value => ({ ...value, close: 102,
    indicatorsObserved: false, statisticsObserved: false, oiObserved: false, takerObserved: false, statisticsSources: 0,
    vwap: null, ema: null, bollUpper: null, bollMiddle: null, bollLower: null,
    roc: null, maroc: null, rsi6: null, rsi12: null, rsi24: null, atrPercent: null, bbw: null, oi: null, buy: null, sell: null,
  }))
  store.ingestLatest(response(raw, { generation: 2, revision: 2 }))
  const pending = store.window(instId, '1H')!
  assert.equal(pending.generation, 2)
  assert.ok(pending.bars.every(value => value.close === 102 && value.ema === null && value.oi === 1_000 && value.buy === 20 && value.sell === 30))
  assert.equal(store.size, 0, 'A compact-only key stays compact across a generation reset.')
  store.ingestLatest(response(raw.map(value => ({ ...value, oiObserved: true, takerObserved: true, statisticsSources: 3, statisticsObserved: true })), { generation: 3, revision: 3 }))
  const unavailable = store.window(instId, '1H')!
  assert.equal(unavailable.oiState, 'unavailable'); assert.equal(unavailable.takerState, 'unavailable')
  assert.ok(unavailable.bars.every(value => value.oi === null && value.buy === null && value.sell === null))
  assert.equal(store.ingestLatest(response(bars(104, 96), { generation: 2, revision: 100 })), false)
  store.ingestLatest(response(bars(104, 96).map(value => ({ ...value, oi: 2_000, buy: 40, sell: 60 })), { generation: 3, revision: 4 }))
  assert.ok(store.window(instId, '1H')!.bars.every(value => value.oi === 2_000 && value.buy === 40 && value.sell === 60))
})

test('byte ownership remains exact across promotion, generation carriers, replacement and both eviction limits', () => {
  const store = new PreparedChartStore({ maxSeries: 2, maxBarsPerSeries: 128, maxBytes: 10_000_000 })
  const eth = 'ETH-USDT-SWAP', sol = 'SOL-USDT-SWAP'
  const accounting = store as unknown as {
    seriesBytes: number; latestBytes: number
    series: Map<string, { byteSize: number; bars: Map<number, { bar: PreparedChartBar }> }>
    latestFrames: Map<string, { window: { bars: readonly PreparedChartBar[] } }>
  }
  const bytes = (values: readonly PreparedChartBar[]) => values.reduce((total, value) => total + JSON.stringify(value).length * 2, 0)
  const verify = () => {
    let history = 0, latest = 0
    for (const entry of accounting.series.values()) {
      const actual = bytes([...entry.bars.values()].map(value => value.bar))
      assert.equal(entry.byteSize, actual)
      history += actual
    }
    for (const entry of accounting.latestFrames.values()) latest += bytes(entry.window.bars)
    assert.equal(accounting.seriesBytes, history); assert.equal(accounting.latestBytes, latest)
    assert.ok(history >= 0 && latest >= 0)
  }
  store.setUniverse([instId, eth], '1H', instId)
  store.ingestLatest(response(bars(104, 96))); verify()
  const immutable = store.window(instId, '1H')!
  store.ingest(response(bars(0, 200))); verify()
  assert.equal(accounting.series.size, 1)
  assert.ok(accounting.seriesBytes > 0 && accounting.latestBytes > 0, 'History and compact projections each retain their own logical payload charge.')
  store.ingestLatest(response([bar(199, hour, { indicatorsObserved: false, ema: null, oi: null, buy: null, sell: null,
    statisticsSources: 0, statisticsObserved: false, oiObserved: false, takerObserved: false })], { generation: 2, revision: 2 }))
  verify()
  assert.equal(store.window(instId, '1H')!.bars.at(-1)!.oi, 1_000)
  const beforePromotion = accounting.seriesBytes
  store.ingest(response([bar(198)], { generation: 2, revision: 3, latestEnd: 199 * hour })); verify()
  assert.equal(accounting.seriesBytes, beforePromotion, 'A provenance-only promotion keeps the existing payload charge.')
  store.ingest(response([bar(198, hour, { oi: 12_345_678, close: 110, high: 111 })], { generation: 2, revision: 4, latestEnd: 199 * hour })); verify()
  store.ingest(response(bars(200, 201), { generation: 2, revision: 5 })); verify()
  assert.equal([...accounting.series.values()][0].bars.size, 128)
  store.ingest(response(bars(0, 150), { instId: eth })); verify()
  store.snapshotMeta(instId, '1H')
  store.ingest(response(bars(0, 96), { instId: sol })); verify()
  assert.equal(store.size, 2); assert.equal(store.window(eth, '1H', 95 * hour), null)
  store.setUniverse([instId], '1H', instId); verify()
  assert.equal(store.latestSize, 1)
  assert.ok(immutable.bars.every(value => value.ema === 100 && value.oi === 1_000), 'Eviction/accounting cannot mutate an already presented frame.')
})

test('repeated full and compact forming frames preserve the byte budget and evict only unpinned candidates when it grows', () => {
  const eth = 'ETH-USDT-SWAP', sol = 'SOL-USDT-SWAP', completed = bars(104, 96)
  const payload = completed.reduce((total, value) => total + JSON.stringify(value).length * 2, 0)
  const store = new PreparedChartStore({ maxBytes: 2 * payload + 1000 })
  store.setUniverse([instId, eth, sol], '1H', instId)
  store.ingestLatest(response(completed))
  store.ingestLatest(response(completed, { instId: eth }))
  const live: Bar = { ...bar(200), confirmed: false }
  for (let revision = 2; revision <= 300; revision += 1) {
    const update = { ...live, close: 101 + revision / 1000 }
    if (revision % 2) store.ingestLatest(response(completed, { revision, liveBar: update }))
    else store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision, endHour: 199 * hour, liveBar: update })
  }
  assert.equal(store.size, 0); assert.equal(store.latestSize, 2)
  assert.ok(store.window(eth, '1H'), 'Repeated updates of the same completed payload cannot accumulate byte charges.')
  store.ingestLatest(response(completed, { instId: sol }))
  assert.equal(store.latestSize, 3)
  assert.ok(store.window(instId, '1H'), 'The active compact frame stays pinned.')
  assert.ok(store.window(eth, '1H'), 'Every rendered candidate stays resident under pressure.')
  assert.ok(store.window(sol, '1H'))
  store.setUniverse([instId, sol], '1H', instId)
  assert.equal(store.latestSize, 2)
  assert.equal(store.window(eth, '1H'), null)
})


test('source errors and retry deadlines survive window derivation and live deltas while the other source renders', () => {
  for (const compact of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H', instId)
    const values = bars(104, 96).map(value => ({ ...value, oi: null, oiObserved: false, takerObserved: true, statisticsObserved: false, statisticsSources: 2 }))
    const oiStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'OI source offline', retryAt: 123_456 }
    const ingest = (frame: PreparedChartResponse) => compact ? store.ingestLatest(frame) : store.ingest(frame)
    assert.equal(ingest(response(values, { oiState: 'error', oiStatus })), true)
    const failed = store.window(instId, '1H')!
    assert.equal(failed.oiState, 'error'); assert.equal(failed.oiStatus?.error, 'OI source offline'); assert.equal(failed.oiStatus?.retryAt, 123_456)
    assert.equal(failed.takerState, 'ready'); assert.ok(failed.bars.every(bar => bar.buy === 20 && bar.sell === 30))
    const waiting = { ...oiStatus, error: 'OI rate limit', retryAt: 234_567 }
    assert.equal(ingest(response(values, { revision: 2, oiState: 'error', oiStatus: waiting })), true)
    const retry = store.window(instId, '1H')!
    assert.notEqual(retry, failed); assert.equal(retry.bars, failed.bars)
    assert.equal(retry.oiStatus?.error, 'OI rate limit'); assert.equal(retry.oiStatus?.retryAt, 234_567)
    assert.equal(store.ingestLive({ type: 'live', instId, timeframe: '1H', generation: 1, revision: 3, endHour: 199 * hour,
      liveBar: { ...bar(200), confirmed: false } }), true)
    assert.equal(store.window(instId, '1H')?.oiState, 'error'); assert.equal(store.window(instId, '1H')?.oiStatus?.retryAt, 234_567)
    assert.equal(ingest(response(values.map(value => ({ ...value, oi: 1_000, oiObserved: true, statisticsSources: 3, statisticsObserved: true })), {
      revision: 4, oiStatus: { state: 'ready', from: 104 * hour, through: 199 * hour },
    })), true)
    assert.equal(store.window(instId, '1H')?.oiState, 'ready'); assert.equal(store.window(instId, '1H')?.oiStatus?.error, undefined)
    assert.equal(store.window(instId, '1H')?.takerState, 'ready')
  }
})

test('a reserve status cannot erase a disjoint visible source error or poison unrelated windows', () => {
  const store = new PreparedChartStore()
  const values = bars(0, 300).map(value => ({ ...value, oi: null, oiObserved: false, takerObserved: true, statisticsObserved: false, statisticsSources: 2 }))
  store.ingest(response(values, { oiState: 'error', oiStatus: { state: 'error', from: 204 * hour, through: 299 * hour, error: 'Visible OI failed', retryAt: 123_456 } }))
  assert.equal(store.window(instId, '1H', 299 * hour)?.oiState, 'error')
  assert.equal(store.window(instId, '1H', 99 * hour)?.oiState, 'loading')
  store.ingest(response(values.slice(0, 100), { revision: 2, endHour: 99 * hour, latestEnd: 299 * hour,
    oiStatus: { state: 'unavailable', reason: 'unsupported', from: 4 * hour, through: 99 * hour },
  }))
  assert.equal(store.window(instId, '1H', 99 * hour)?.oiStatus?.reason, 'unsupported')
  assert.equal(store.window(instId, '1H', 299 * hour)?.oiState, 'error')
  assert.equal(store.window(instId, '1H', 299 * hour)?.oiStatus?.error, 'Visible OI failed')
})

test('statuses touching only observed edges cannot hide failures and retries supersede only the missing slots they cover', () => {
  for (const compact of [false, true]) for (const edgeState of ['loading', 'ready'] as const) for (const empty of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H', instId)
    const values = bars(104, 96).map((value, index) => index < 16
      ? empty ? { ...value, oi: null, buy: null, sell: null } : value
      : { ...value, oi: null, buy: null, sell: null, oiObserved: false, takerObserved: false, statisticsObserved: false, statisticsSources: 0 })
    const oiStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'OI failed', retryAt: 123_456 }
    const takerStatus = { ...oiStatus, error: 'Taker failed', retryAt: 234_567 }
    const ingest = (frame: PreparedChartResponse) => compact ? store.ingestLatest(frame) : store.ingest(frame)
    ingest(response(values, { oiState: 'error', takerState: 'error', oiStatus, takerStatus }))
    const failed = store.window(instId, '1H')!
    const edge = { state: edgeState, from: 24 * hour, through: 119 * hour }
    ingest(response(values, { revision: 2, oiState: edgeState, takerState: edgeState, oiStatus: edge, takerStatus: edge }))
    assert.equal(store.window(instId, '1H'), failed, 'An unrelated edge status cannot change the visible failure, including observed-empty edges.')
    assert.equal(failed.oiStatus?.error, 'OI failed'); assert.equal(failed.oiStatus?.retryAt, 123_456)
    assert.equal(failed.takerStatus?.error, 'Taker failed'); assert.equal(failed.takerStatus?.retryAt, 234_567)

    ingest(response(values, { revision: 3, oiStatus: { state: 'loading', from: 120 * hour, through: 159 * hour } }))
    const partialRetry = store.window(instId, '1H')!
    assert.equal(partialRetry.oiState, 'error'); assert.equal(partialRetry.oiStatus?.retryAt, 123_456)
    assert.equal(partialRetry.takerState, 'error'); assert.equal(partialRetry.takerStatus?.retryAt, 234_567)
    ingest(response(values, { revision: 4, oiStatus: { state: 'ready', from: 160 * hour, through: 199 * hour } }))
    const retrying = store.window(instId, '1H')!
    assert.equal(retrying.oiState, 'loading', 'Newer statuses supersede every failed slot, but readiness still requires observations.')
    assert.equal(retrying.oiStatus?.error, undefined); assert.equal(retrying.oiStatus?.retryAt, undefined)
    assert.equal(retrying.takerState, 'error'); assert.equal(retrying.takerStatus?.retryAt, 234_567)
    assert.equal(retrying.bars, failed.bars, 'Status changes reuse the prepared bars.')
    assert.equal(failed.oiState, 'error', 'Previously presented snapshots remain immutable.')
  }
})

test('a partially overlapping reserve retry leaves uncovered historical failures visible without affecting complete windows', () => {
  const store = new PreparedChartStore()
  const values = bars(104, 196).map(value => value.hour <= 183 * hour
    ? { ...value, oi: null, buy: null, sell: null, oiObserved: false, takerObserved: false, statisticsObserved: false, statisticsSources: 0 } : value)
  const oiStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'Historical OI failed', retryAt: 123_456 }
  const takerStatus = { ...oiStatus, error: 'Historical Taker failed', retryAt: 234_567 }
  store.ingest(response(values, { endHour: 199 * hour, oiStatus, takerStatus }))
  const latest = store.window(instId, '1H', 299 * hour)!
  const reserve = bars(24, 96).map(value => ({ ...value, oi: null, buy: null, sell: null,
    oiObserved: false, takerObserved: false, statisticsObserved: false, statisticsSources: 0 }))
  const loading = { state: 'loading' as const, from: 24 * hour, through: 119 * hour }
  store.ingest(response(reserve, { revision: 2, latestEnd: 299 * hour, oiStatus: loading, takerStatus: loading }))
  const historical = store.window(instId, '1H', 199 * hour)!
  assert.equal(historical.bars.length, 96); assert.equal(historical.bars.filter(value => value.oi !== null).length, 16)
  assert.equal(historical.indicatorState, 'ready')
  assert.equal(historical.oiState, 'error'); assert.equal(historical.oiStatus?.error, 'Historical OI failed'); assert.equal(historical.oiStatus?.retryAt, 123_456)
  assert.equal(historical.takerState, 'error'); assert.equal(historical.takerStatus?.error, 'Historical Taker failed'); assert.equal(historical.takerStatus?.retryAt, 234_567)
  assert.equal(store.window(instId, '1H', 119 * hour)?.oiState, 'loading')
  assert.equal(store.window(instId, '1H', 119 * hour)?.takerState, 'loading')
  assert.equal(store.window(instId, '1H', 299 * hour), latest)
  store.ingest(response([], { revision: 3, endHour: 199 * hour, latestEnd: 299 * hour,
    oiStatus: { state: 'loading', from: 120 * hour, through: 183 * hour } }))
  const retrying = store.window(instId, '1H', 199 * hour)!
  assert.equal(retrying.oiState, 'loading'); assert.equal(retrying.oiStatus?.retryAt, undefined)
  assert.equal(retrying.takerState, 'error'); assert.equal(retrying.takerStatus?.retryAt, 234_567)
})

test('unsupported statistics must cover every unobserved slot within a proven listing floor', () => {
  const store = new PreparedChartStore()
  const values = bars(188, 12).map(value => ({ ...value, oi: null, oiObserved: false, takerObserved: true, statisticsObserved: false, statisticsSources: 2 }))
  const unsupported = { state: 'unavailable' as const, reason: 'unsupported' as const, from: 188 * hour, through: 193 * hour }
  store.ingest(response(values, { historyExhausted: true, oiStatus: unsupported }))
  const pending = store.window(instId, '1H')!
  assert.equal(pending.oiState, 'loading'); assert.equal(pending.oiStatus?.reason, undefined)
  store.ingest(response([], { revision: 2, endHour: 199 * hour, latestEnd: 199 * hour,
    oiStatus: { ...unsupported, from: 194 * hour, through: 199 * hour } }))
  const unavailable = store.window(instId, '1H')!
  assert.equal(unavailable.oiState, 'unavailable'); assert.equal(unavailable.oiStatus?.reason, 'unsupported')
  assert.equal(unavailable.takerState, 'ready'); assert.equal(unavailable.bars, pending.bars)
  store.ingest(response([], { revision: 3, endHour: 199 * hour, latestEnd: 199 * hour,
    oiStatus: { state: 'ready', from: 199 * hour, through: 199 * hour } }))
  assert.equal(store.window(instId, '1H')?.oiState, 'loading', 'A newer ready status still needs an actual observation.')
})


test('missing timestamps cannot override incoming statistic errors with numeric or observed-empty bars', () => {
  for (const compact of [false, true]) for (const empty of [false, true]) {
    const store = new PreparedChartStore()
    store.setUniverse([instId], '1H', instId)
    const complete = bars(104, 96).map(value => empty ? { ...value, oi: null, buy: null, sell: null } : value)
    const sparse = complete.filter((_, index) => index !== 40)
    const oiStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour, error: 'OI request failed', retryAt: 123_456 }
    const takerStatus = { ...oiStatus, error: 'Taker request failed', retryAt: 234_567 }
    const ingest = (frame: PreparedChartResponse) => compact ? store.ingestLatest(frame) : store.ingest(frame)
    ingest(response(sparse, { oiState: 'error', takerState: 'error', oiStatus, takerStatus }))
    const failed = store.window(instId, '1H')!
    assert.equal(failed.bars.length, 95); assert.equal(failed.priceState, 'partial')
    assert.equal(failed.oiState, 'error'); assert.equal(failed.oiStatus?.error, 'OI request failed'); assert.equal(failed.oiStatus?.retryAt, 123_456)
    assert.equal(failed.takerState, 'error'); assert.equal(failed.takerStatus?.error, 'Taker request failed'); assert.equal(failed.takerStatus?.retryAt, 234_567)
    const edge = { state: 'ready' as const, from: 198 * hour, through: 199 * hour }
    ingest(response(sparse, { revision: 2, oiStatus: edge, takerStatus: edge }))
    assert.equal(store.window(instId, '1H')?.oiStatus?.retryAt, 123_456, 'A known edge cannot certify the absent interior timestamp.')
    assert.equal(store.window(instId, '1H')?.takerStatus?.retryAt, 234_567)
    ingest(response(compact ? complete : [complete[40]], { revision: 3, endHour: 199 * hour, latestEnd: 199 * hour }))
    const recovered = store.window(instId, '1H')!
    assert.equal(recovered.oiState, empty ? 'unavailable' : 'ready'); assert.equal(recovered.oiStatus?.error, undefined)
    assert.equal(recovered.takerState, empty ? 'unavailable' : 'ready'); assert.equal(recovered.takerStatus?.error, undefined)
  }
})

test('price failure metadata is scoped to the affected incomplete window and survives unrelated reserve statuses', () => {
  const store = new PreparedChartStore()
  const complete = bars(0, 300), values = complete.filter(value => value.hour !== 240 * hour)
  const priceStatus = { state: 'error' as const, from: 204 * hour, through: 299 * hour, error: 'Prices offline', retryAt: 123_456 }
  store.ingest(response(values, { priceState: 'error', priceStatus, error: 'Prices offline' }))
  const failed = store.window(instId, '1H', 299 * hour)!
  assert.equal(failed.priceState, 'error'); assert.equal(failed.priceStatus?.error, 'Prices offline'); assert.equal(failed.priceStatus?.retryAt, 123_456)
  assert.equal(store.window(instId, '1H', 99 * hour)?.priceState, 'ready')
  assert.equal(store.window(instId, '1H', 99 * hour)?.priceStatus, undefined)
  store.ingest(response(values.slice(0, 100), { revision: 2, endHour: 99 * hour, latestEnd: 299 * hour, priceStatus: { state: 'ready', from: 4 * hour, through: 99 * hour } }))
  assert.equal(store.window(instId, '1H', 299 * hour)?.priceState, 'error')
  assert.equal(store.window(instId, '1H', 299 * hour)?.priceStatus?.retryAt, 123_456)
  store.ingest(response([complete[240]], { revision: 3, endHour: 299 * hour, latestEnd: 299 * hour, priceState: 'ready' }))
  assert.equal(store.window(instId, '1H', 299 * hour)?.priceState, 'ready')
  assert.equal(store.window(instId, '1H', 299 * hour)?.priceStatus?.error, undefined)
})

test('source failures survive arbitrarily many unrelated statuses and expire with their resident navigation data', () => {
  const store = new PreparedChartStore({ maxBarsPerSeries: 512 })
  const values = bars(0, 400).map(value => value.hour >= 104 * hour && value.hour < 120 * hour
    ? { ...value, oi: null, oiObserved: false, statisticsObserved: false, statisticsSources: 2 } : value)
  store.ingest(response(values, { oiStatus: { state: 'error', from: 104 * hour, through: 119 * hour, error: 'Resident OI failure' } }))
  let revision = 1
  for (let index = 200; index < 240; index += 1) store.ingest(response([], { revision: ++revision, endHour: 399 * hour, latestEnd: 399 * hour,
    oiStatus: { state: 'loading', from: index * hour, through: index * hour },
  }))
  assert.equal(store.window(instId, '1H', 199 * hour)?.oiStatus?.error, 'Resident OI failure')
  // Repeated subranges replace and coalesce their own validity intervals.
  for (let index = 0; index < 80; index += 1) store.ingest(response([], { revision: ++revision, endHour: 399 * hour, latestEnd: 399 * hour,
    oiStatus: { state: 'loading', from: (200 + index % 40) * hour, through: (200 + index % 40) * hour },
  }))
  assert.ok(store.snapshotMeta(instId, '1H')!.sourceStatuses!.length <= 3)
  store.ingest(response([], { revision: ++revision, endHour: 399 * hour, latestEnd: 399 * hour,
    oiStatus: { state: 'ready', from: 104 * hour, through: 111 * hour },
  }))
  assert.equal(store.window(instId, '1H', 199 * hour)?.oiState, 'error', 'Only the covered half of a failure has been superseded.')
  store.ingest(response([], { revision: ++revision, endHour: 399 * hour, latestEnd: 399 * hour,
    oiStatus: { state: 'ready', from: 112 * hour, through: 119 * hour },
  }))
  assert.equal(store.window(instId, '1H', 199 * hour)?.oiState, 'loading', 'A successful source status clears the failure; numeric readiness still needs observations.')
  store.ingest(response(bars(1000, 512), { revision: ++revision }))
  assert.ok(store.snapshotMeta(instId, '1H')!.sourceStatuses!.every(value => value.status.from >= 905 * hour))
  assert.equal(store.window(instId, '1H', 199 * hour), null)
})

test('indicator errors retain their input and range until covered by recovery, independently of statistics', () => {
  const store = new PreparedChartStore()
  const values = bars(104, 196).map(value => value.hour < 200 * hour ? { ...value, indicatorsObserved: false, ema: null } : value)
  const indicatorStatus = { state: 'error' as const, from: 104 * hour, through: 199 * hour,
    error: 'Invalid indicator input', inputVersion: 'price:1', retryOn: 'input-change' as const }
  store.ingest(response(values, { indicatorStatus }))
  const failed = store.window(instId, '1H', 199 * hour)!
  assert.equal(failed.indicatorState, 'error'); assert.equal(failed.indicatorStatus?.inputVersion, 'price:1')
  assert.equal(failed.oiState, 'ready'); assert.equal(failed.priceState, 'ready')
  store.ingest(response([], { revision: 2, endHour: 299 * hour, latestEnd: 299 * hour,
    indicatorStatus: { state: 'ready', from: 204 * hour, through: 299 * hour, inputVersion: 'price:1' },
  }))
  assert.equal(store.window(instId, '1H', 199 * hour), failed)
  assert.equal(store.window(instId, '1H', 299 * hour)?.indicatorState, 'ready')
  store.ingest(response([], { revision: 3, endHour: 199 * hour, latestEnd: 299 * hour,
    indicatorStatus: { state: 'loading', from: 104 * hour, through: 199 * hour, inputVersion: 'price:2' },
  }))
  const recovering = store.window(instId, '1H', 199 * hour)!
  assert.equal(recovering.indicatorState, 'loading'); assert.equal(recovering.indicatorStatus?.error, undefined)
  assert.equal(recovering.bars, failed.bars)
  store.ingest(response(bars(104, 96), { revision: 4, endHour: 199 * hour, latestEnd: 299 * hour,
    indicatorStatus: { state: 'ready', from: 104 * hour, through: 199 * hour, inputVersion: 'price:2' },
  }))
  assert.equal(store.window(instId, '1H', 199 * hour)?.indicatorState, 'ready')
  assert.equal(store.window(instId, '1H', 199 * hour)?.indicatorStatus?.inputVersion, 'price:2')
  assert.equal(failed.indicatorState, 'error')
})

test('percentage fields admit only finite numbers or null and completeness corrections invalidate navigation bounds', () => {
  for (const field of ['roc', 'maroc'] as const) for (const value of ['Infinity', '-Infinity', Infinity, -Infinity, NaN]) {
    const store = new PreparedChartStore()
    const values = bars(104, 96)
    store.ingest(response(values.map((bar, index) => index === 40 ? { ...bar, [field]: value } as unknown as PreparedChartBar : bar)))
    assert.equal(store.window(instId, '1H')?.priceState, 'partial')
    assert.equal(store.window(instId, '1H')?.bars.length, 95)
  }
  const store = new PreparedChartStore()
  store.ingest(response(bars(104, 96)))
  assert.equal(store.readyBoundaries(instId, '1H').length, 1)
  store.ingest(response([{ ...bar(150), priceComplete: false }], { revision: 2, endHour: 199 * hour, latestEnd: 199 * hour }))
  assert.equal(store.window(instId, '1H')?.priceState, 'partial')
  assert.equal(store.readyBoundaries(instId, '1H').length, 0)
  store.ingest(response([bar(150)], { revision: 3, endHour: 199 * hour, latestEnd: 199 * hour }))
  assert.equal(store.window(instId, '1H')?.priceState, 'ready')
  assert.equal(store.readyBoundaries(instId, '1H').length, 1)
})
