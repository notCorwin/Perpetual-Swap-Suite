import assert from 'node:assert/strict'
import test from 'node:test'
import { ChartSeriesStore, type ChartSeriesResponse } from './chart-series-store.ts'

type Bar = { hour: number; confirmed: boolean; close: number; oi: number | null; buy: number | null; sell: number | null }
type Status = { error: string; candleState?: 'ready' | 'loading' | 'retrying'; candleRetryAt?: number | null; missingCandleRanges?: Array<{ from: number; through: number }>; statisticsState?: 'ready' | 'loading' | 'retrying'; oiState?: 'ready' | 'loading' | 'retrying'; takerState?: 'ready' | 'loading' | 'retrying' }
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
  assert.equal(result.entry?.barsRevision, 11)
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
  assert.equal(result.entry?.barsRevision, 10)
  assert.equal(result.entry?.status.error, 'candle retry')
  assert.equal(result.entry?.status.candleState, 'retrying')
  assert.equal(store.hasBars(key), true)
})

test('a status-only same-revision poll preserves repair progress while advancing direct source state', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  const missing = [{ from: hour, through: 2 * hour }]
  store.upsert(key, response(7, [bar(1), bar(2)], {
    error: '', candleState: 'loading', candleRetryAt: 9_000, missingCandleRanges: missing,
    statisticsState: 'loading', oiState: 'loading', takerState: 'loading',
  }))

  const result = store.upsert(key, response(7, [], {
    error: '', candleState: 'loading', candleRetryAt: 9_000, missingCandleRanges: missing,
    statisticsState: 'retrying', oiState: 'retrying', takerState: 'ready',
  }))

  assert.equal(result.accepted, true)
  assert.deepEqual(result.entry?.bars, [bar(1), bar(2)])
  assert.equal(result.entry?.status.candleState, 'loading')
  assert.equal(result.entry?.status.candleRetryAt, 9_000)
  assert.deepEqual(result.entry?.status.missingCandleRanges, missing)
  assert.equal(result.entry?.status.statisticsState, 'retrying')
  assert.equal(result.entry?.status.oiState, 'retrying')
  assert.equal(result.entry?.status.takerState, 'ready')
  assert.equal(result.entry?.barsRevision, 7)
})

test('a failed materialized read remains pending across equal status-only revisions', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(7, [bar(1, 101)]))

  // The status endpoint sees a new persisted source page, but the complete
  // read that would merge it into bars fails outside the store.
  store.upsert(key, response(8, [], { error: '', statisticsState: 'ready', oiState: 'ready', takerState: 'ready' }))
  const pending = store.get(key)
  assert.equal(pending?.revision, 8)
  assert.equal(pending?.barsRevision, 7)
  assert.equal(pending?.bars[0]?.oi, 1_001)

  // A later equal-revision status reply must still be distinguishable from
  // the retained r7 bars, so the renderer retries the materialized read.
  store.upsert(key, response(8, [], { error: '', statisticsState: 'ready', oiState: 'ready', takerState: 'ready' }))
  assert.equal(store.get(key)?.barsRevision, 7)

  store.upsert(key, response(8, [{ ...bar(1, 101), oi: 2_001 }]))
  assert.equal(store.get(key)?.barsRevision, 8)
  assert.equal(store.get(key)?.bars[0]?.oi, 2_001)
})

test('only materialized hours advance a visible window through distant previews and status polls', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '5m:PEPE-USDT-SWAP'
  store.upsert(key, response(10, [bar(1), bar(2), bar(3)]))
  const first = store.materializedWindow(key, 3 * hour, hour, 3)
  assert.equal(first?.revision, 10)
  store.upsert(key, { ...response(11, [bar(100)]), statusAuthoritative: false })
  assert.equal(store.get(key)?.barsRevision, 11)
  assert.deepEqual(store.materializedWindow(key, 3 * hour, hour, 3), first)
  store.upsert(key, response(12, [], { error: '', statisticsState: 'loading' }))
  assert.deepEqual(store.materializedWindow(key, 3 * hour, hour, 3), first)
  store.upsert(key, response(12, [bar(1), bar(2)]))
  assert.equal(store.materializedWindow(key, 3 * hour, hour, 3)?.revision, 10, 'All hours in the visible window must be materialized at the new revision')
  store.upsert(key, response(12, [bar(3)]))
  assert.equal(store.materializedWindow(key, 3 * hour, hour, 3)?.revision, 12)
  assert.equal(store.materializedWindow(key, 4 * hour, hour, 3), null, 'An absent hour cannot be treated as current')
  const partial = store.materializedWindow(key, 4 * hour, hour, 3, true)
  assert.equal(partial?.revision, 12, 'Candle repair may reuse the latest partial snapshot for cheap progress polling')
  store.upsert(key, response(13, [], { error: '', candleState: 'loading' }))
  assert.deepEqual(store.materializedWindow(key, 4 * hour, hour, 3, true), partial, 'Status-only polls must not postpone the bounded partial snapshot refresh')
})

test('window materialization resets with the collector and preserves accepted live-frame semantics', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '5m:PEPE-USDT-SWAP'
  store.upsert(key, response(10, [bar(1)]))
  const confirmed = store.materializedWindow(key, hour, hour, 1)
  store.upsert(key, response(11, [{ ...bar(1), confirmed: false, oi: null }]))
  assert.deepEqual(store.materializedWindow(key, hour, hour, 1), confirmed)
  store.upsert(key, response(12, [{ ...bar(2), confirmed: false }]))
  assert.equal(store.materializedWindow(key, 2 * hour, hour, 1)?.revision, 12, 'A genuinely new live candle participates in the live polling fast path')
  store.upsert(key, response(1, [], { error: '', statisticsState: 'loading' }, 'collector-b'))
  assert.equal(store.hasBars(key), true)
  assert.equal(store.materializedWindow(key, hour, hour, 1), null, 'Retained old-session bars have no new-session materialization')
  store.upsert(key, response(13, [bar(1)], { error: '' }, 'collector-a'))
  assert.equal(store.materializedWindow(key, hour, hour, 1), null)
  store.upsert(key, response(2, [bar(1)], { error: '' }, 'collector-b'))
  assert.equal(store.materializedWindow(key, hour, hour, 1)?.revision, 2)
})

test('a same-window cache preview cannot overwrite active statistics status', () => {
  const store = new ChartSeriesStore<Bar, Status>()
  const key = '1H:BTC-USDT-SWAP'
  store.upsert(key, response(10, [bar(1)], { error: '', statisticsState: 'loading', oiState: 'loading', takerState: 'ready' }))
  const preview: Response = {
    ...response(11, [bar(1, 202)], { error: '', statisticsState: 'ready', oiState: 'ready', takerState: 'ready' }),
    statusAuthoritative: false,
  }
  const result = store.upsert(key, preview)
  assert.equal(result.entry?.bars[0]?.close, 202)
  assert.equal(result.entry?.status.statisticsState, 'loading')
  assert.equal(result.entry?.status.oiState, 'loading')
  assert.equal(result.entry?.status.takerState, 'ready')
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
