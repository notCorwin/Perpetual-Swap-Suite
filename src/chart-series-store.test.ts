import assert from 'node:assert/strict'
import test from 'node:test'
import { ChartSeriesStore, type ChartSeriesResponse } from './chart-series-store.ts'

type Bar = { hour: number; confirmed: boolean; close: number; oi: number | null; buy: number | null; sell: number | null }
type Status = { error: string; candleState?: 'ready' | 'loading' | 'retrying' }
type Response = ChartSeriesResponse<Bar, Status>

const hour = 3_600_000
const response = (revision: number, bars: Bar[], status: Status = { error: '', candleState: 'ready' }, serviceSession = 'collector-a'): Response => ({
  ...status,
  bars,
  revision,
  serviceSession,
})
const bar = (index: number, close = 100 + index): Bar => ({
  hour: index * hour,
  confirmed: true,
  close,
  oi: 1_000 + index,
  buy: 10 + index,
  sell: 5 + index,
})

test('merges non-empty 1H responses into one canonical primary series', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(10, [bar(1), bar(2)]), 1)
  const result = store.upsert(key, response(11, [bar(2, 202), bar(3)]), 2)

  assert.equal(result.accepted, true)
  assert.deepEqual(result.entry?.bars.map(value => [value.hour, value.close]), [[hour, 101], [2 * hour, 202], [3 * hour, 103]])
  assert.equal(result.entry?.latestKnownHour, 3 * hour)
  assert.equal(result.entry?.revision, 11)
  assert.equal(result.entry?.loadedAt, 2)
})

test('an empty response updates status without blanking an already rendered series', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(10, [bar(1), bar(2)]), 1)
  const result = store.upsert(key, response(11, [], { error: 'candle retry', candleState: 'retrying' }), 2)

  assert.equal(result.accepted, true)
  assert.deepEqual(result.entry?.bars, [bar(1), bar(2)])
  assert.equal(result.entry?.latestKnownHour, 2 * hour)
  assert.equal(result.entry?.revision, 11)
  assert.equal(result.entry?.status.error, 'candle retry')
  assert.equal(result.entry?.status.candleState, 'retrying')
  assert.equal(store.hasBars(key), true)
})

test('retains every primary series instead of evicting a rendered 1H target for other keys', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const selected = '1H:BTC-USDT-SWAP'
  store.upsert(selected, response(1, [bar(1)]))

  for (let index = 0; index < 32; index++) {
    store.upsert(`1H:PREVIEW-${index}-USDT-SWAP`, response(1, [bar(index + 10)]))
  }

  assert.equal(store.size, 33)
  assert.equal(store.get(selected)?.bars[0]?.hour, hour)
  assert.equal(store.hasBars(selected), true)
})

test('a new collector session keeps old bars through an empty reply, then replaces them atomically', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(20, [bar(1, 101), bar(2, 102)], { error: '' }, 'collector-a'))

  const pending = store.upsert(key, response(1, [], { error: 'warming', candleState: 'loading' }, 'collector-b'))
  assert.equal(pending.accepted, true)
  assert.deepEqual(pending.entry?.bars.map(value => value.close), [101, 102])
  assert.equal(pending.entry?.serviceSession, 'collector-b')
  assert.equal(pending.entry?.barsServiceSession, 'collector-a')
  assert.equal(pending.entry?.status.candleState, 'loading')

  const lateOldSession = store.upsert(key, response(21, [bar(3, 999)], { error: '' }, 'collector-a'))
  assert.equal(lateOldSession.accepted, false)
  assert.deepEqual(lateOldSession.entry?.bars.map(value => value.close), [101, 102])

  const refreshed = store.upsert(key, response(2, [bar(3, 303)], { error: '' }, 'collector-b'))
  assert.equal(refreshed.accepted, true)
  assert.deepEqual(refreshed.entry?.bars.map(value => value.close), [303])
  assert.equal(refreshed.entry?.barsServiceSession, 'collector-b')
  assert.equal(refreshed.entry?.latestKnownHour, 3 * hour)
})

test('late replies from a retired session cannot overwrite the new canonical series', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(20, [bar(1, 101)], { error: '' }, 'collector-a'))
  store.upsert(key, response(1, [bar(2, 202)], { error: '' }, 'collector-b'))
  const stale = store.upsert(key, response(99, [bar(3, 999)], { error: '' }, 'collector-a'))

  assert.equal(stale.accepted, false)
  assert.deepEqual(stale.entry?.bars.map(value => value.close), [202])
  assert.equal(stale.entry?.serviceSession, 'collector-b')
})
