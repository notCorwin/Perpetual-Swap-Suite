import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar, PreparedChartBar, PreparedChartLiveUpdate, PreparedChartResponse } from './chart-data.ts'
import { PreparedChartStore } from './chart-series-store.ts'
import { timeframeMilliseconds } from './timeframe.ts'

const hour = 3_600_000
const instId = 'BTC-USDT-SWAP'
const bar = (index: number, intervalMS = hour, overrides: Partial<PreparedChartBar> = {}): PreparedChartBar => ({
  hour: index * intervalMS, open: 100, high: 102, low: 99, close: 101,
  confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
  vwap: 100, ema: 100, bollUpper: 102, bollMiddle: 100, bollLower: 99,
  roc: 1, maroc: .5, rsi6: 50, rsi12: 51, rsi24: 52, oi: 1_000, buy: 20, sell: 30,
  ...overrides,
})
const bars = (start: number, count: number, intervalMS = hour) => Array.from({ length: count }, (_, index) => bar(start + index, intervalMS))
const response = (values: PreparedChartBar[], overrides: Partial<PreparedChartResponse> = {}): PreparedChartResponse => ({
  instId, timeframe: '1H', intervalMS: hour, generation: 1, revision: 1,
  endHour: values.at(-1)?.hour ?? null, latestEnd: values.at(-1)?.hour ?? null,
  oldestHour: values[0]?.hour ?? null, historyExhausted: false, bars: values,
  oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '', ...overrides,
})

test('only an exact contiguous prepared 96-candle window is renderable', () => {
  const store = new PreparedChartStore()
  store.ingest(response(bars(0, 95), { latestEnd: 95 * hour }))
  assert.equal(store.window(instId, '1H'), null)
  for (const invalid of [
    { ...bar(95), confirmed: false },
    { ...bar(95), statisticsSources: 1 },
    { ...bar(95), indicatorsObserved: false },
    { ...bar(95), statisticsObserved: false },
    { ...bar(95), statisticsObserved: undefined },
    { ...bar(95), high: 90 },
  ]) {
    store.ingest(response([invalid as PreparedChartBar], { revision: 2, latestEnd: 95 * hour }))
    assert.equal(store.window(instId, '1H'), null, 'Aggregate ready statuses cannot authorize an unprepared sample.')
  }
  store.ingest(response([bar(95)], { revision: 3 }))
  const ready = store.window(instId, '1H')!
  assert.equal(ready.bars.length, 96)
  assert.deepEqual(ready.bars.map(value => value.hour), Array.from({ length: 96 }, (_, index) => index * hour))
  assert.equal(store.window(instId, '1H', 96 * hour), null, 'The cache never substitutes a nearby window.')
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
  const unsubscribe = store.subscribe(() => { notifications += 1 })
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
    { ...delta, liveBar: { ...live, close: 200 } },
  ]) {
    assert.equal(store.ingestLive(invalid), false)
    assert.equal(store.window(instId, '1H'), previous)
  }
  assert.equal(store.ingestLatest(response(bars(104, 96), { generation: 2 })), true, 'A rejected delta cannot poison a later complete generation.')
  assert.equal(store.ingestLive({ ...delta, generation: 2 }), true)
  assert.equal(store.size, 0)
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

test('bar pressure preserves the requested exact window and an evicted revisit never returns partial data', () => {
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
