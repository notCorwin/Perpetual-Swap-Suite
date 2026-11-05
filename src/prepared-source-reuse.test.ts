import assert from 'node:assert/strict'
import test from 'node:test'
import { PreparedChartPipeline } from '../electron/services/prepared-chart-service.js'

const interval = 900_000, instId = 'BTC-USDT-SWAP'
const candle = (timestamp: number, extra: Record<string, unknown> = {}) => ({ instrument: instId, timeframe: '15m', timestamp,
  open: 100, high: 102, low: 98, close: 101, volume: 100, baseVolume: 100, quoteVolume: 10_000,
  oi: 5_000, buy: 70, sell: 30, statisticsVersion: 11, confirmed: true, ...extra })
const fixture = (initial: ReturnType<typeof candle>[] = [], history: any = {}) => {
  let rows = initial
  const store = {
    async candles(query: any) { return rows.filter(row => row.timestamp >= (query.from ?? 0) && row.timestamp <= query.through)
      .sort((a, b) => query.order === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp).slice(0, query.limit ?? Infinity) },
    async coverage() { return { first: rows.at(0)?.timestamp ?? null, last: rows.at(-1)?.timestamp ?? null, count: rows.length } },
  }
  const pipeline: any = new PreparedChartPipeline({ store: store as any, history, normalize: (row: any) => row,
    revision: () => 0, instrument: () => undefined })
  return { pipeline, replace(value: typeof rows) { rows = value } }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('pending source plans follow repaired gaps, disjoint windows, eviction and full invalidation', async () => {
  const end = Math.floor(Date.now() / interval) * interval - interval, first = end - 4 * interval
  const rows = [0, 2, 4].map(index => candle(first + index * interval))
  const { pipeline, replace } = fixture(rows)
  try {
    await pipeline.local(instId, '15m')
    const state = pipeline.state(instId, '15m'), pending = (from = first, through = end) => pipeline.pendingSourceRanges(state, 'candles', from, through)
    assert.deepEqual(pending(), [{ from: first + interval, through: first + interval }, { from: end - interval, through: end - interval }])
    assert.deepEqual(pending(first, first), [])
    assert.deepEqual(pending(end - interval, end), [{ from: end - interval, through: end - interval }])
    replace([...rows, candle(first + interval), candle(end - interval)])
    await pipeline.read(state, undefined, 128)
    assert.deepEqual(pending(), [])
    pipeline.retainRows(state, 2, null)
    assert.deepEqual(pending(), [{ from: first, through: end - 2 * interval }])
    pipeline.invalidate(instId, '15m')
    assert.deepEqual(pending(), [{ from: first, through: end }])
  } finally { await pipeline.dispose() }
})

test('empty statistics leases expire at the boundary and later source observations repair cached gaps', async () => {
  const nativeNow = Date.now, now = Math.floor(nativeNow() / interval) * interval + 1000
  let clock = now
  Date.now = () => clock
  const end = Math.floor(now / interval) * interval - interval, expiry = now + 1000
  const row = candle(end, { oi: null, statisticsOIExpiresAt: expiry })
  const { pipeline } = fixture([row], { ensureStatistics() {} })
  try {
    await pipeline.local(instId, '15m')
    const state = pipeline.state(instId, '15m'), pending = () => pipeline.pendingSourceRanges(state, 'oi', end, end)
    assert.deepEqual(pending(), [])
    clock = expiry - 1; assert.deepEqual(pending(), [])
    clock = expiry; assert.deepEqual(pending(), [{ from: end, through: end }])
    clock = now; assert.deepEqual(pending(), [], 'A clock rollback must re-evaluate an expired lease rather than reuse a permanent gap.')
    clock = expiry; assert.deepEqual(pending(), [{ from: end, through: end }])
    assert.deepEqual(pipeline.pendingSourceRanges(state, 'taker', end, end), [])
    await pipeline.observeStatistics(instId, '15m', end, end, 'interactive', [candle(end)], 'oi')
    assert.deepEqual(pending(), [])
  } finally { await pipeline.dispose(); Date.now = nativeNow }
})

test('source task coverage is shared only while its job exists, including cancelled and replaced jobs', async () => {
  const { pipeline } = fixture(), state = pipeline.state(instId, '15m'), from = 100 * interval, through = from + 3 * interval
  const gate = deferred(), second = deferred()
  let acquisitions = 0
  try {
    const acquire = async () => { acquisitions++; await gate.promise; return true }
    const task = pipeline.sourceJob('shared', acquire, { state, source: 'candles', from, through: from + interval })
    assert.equal(pipeline.sourceJob('overlapping-consumer', acquire, { state, source: 'candles', from, through: from + interval }), task)
    const pending = () => pipeline.pendingSourceRanges(state, 'candles', from, through)
    assert.deepEqual(pending(), [{ from: from + 2 * interval, through }])
    assert.deepEqual(pipeline.pendingSourceRanges(state, 'oi', from, through), [{ from, through }])
    gate.resolve(); await task
    assert.equal(acquisitions, 1)
    assert.deepEqual(pending(), [{ from, through }])
    const replacement = pipeline.sourceJob('shared', async () => { await second.promise; return true }, { state, source: 'candles', from: from + 2 * interval, through })
    assert.deepEqual(pending(), [{ from, through: from + interval }])
    pipeline.reconcileSourceJobs()
    assert.deepEqual(pending(), [{ from, through }])
    await assert.rejects(replacement)
  } finally { gate.resolve(); second.resolve(); await pipeline.dispose() }
})

test('failure status and retry gates use only unresolved coverage of the same series and source', async () => {
  const nativeNow = Date.now, now = nativeNow()
  let clock = now
  Date.now = () => clock
  const end = Math.floor(now / interval) * interval - interval
  const { pipeline } = fixture([candle(end, { oi: null, statisticsVersion: 0 })], { ensureStatistics() {} })
  try {
    await pipeline.local(instId, '15m')
    const state = pipeline.state(instId, '15m'), retryAt = now + 5000
    const failure = { seriesKey: state.key, source: 'oi', from: end, through: end, failedAt: now,
      error: 'OI is offline.', retryAt, sourceEpoch: pipeline.sourceEpoch, inputVersion: state.oiVersion, focus: pipeline.focus }
    pipeline.sourceAttempts.set('oi', failure)
    pipeline.sourceAttempts.set('other', { ...failure, seriesKey: 'ETH-USDT-SWAP:15m', failedAt: now + 20, error: 'Other contract.' })
    pipeline.sourceAttempts.set('taker', { ...failure, source: 'taker', failedAt: now + 30, error: 'Other source.' })
    assert.equal(pipeline.sourceStatus(state, 'oi', end, end, 'loading').error, failure.error)
    assert.equal(pipeline.sourceBlocked(state, 'oi', end, end), true)
    assert.equal(pipeline.sourceRetryAt(state, 'oi', end, end), retryAt)
    clock = retryAt
    assert.equal(pipeline.sourceBlocked(state, 'oi', end, end), false)
    assert.equal(pipeline.sourceRetryAt(state, 'oi', end, end), 0)
    pipeline.sourceAttempts.set('oi', { ...failure, retryAt: undefined })
    assert.equal(pipeline.sourceBlocked(state, 'oi', end, end), true)
    pipeline.sourceEpoch += 1
    assert.equal(pipeline.sourceBlocked(state, 'oi', end, end), false)
    await pipeline.observeStatistics(instId, '15m', end, end, 'interactive', [candle(end)], 'oi')
    assert.equal(pipeline.sourceStatus(state, 'oi', end, end, 'loading').state, 'loading')
    assert.equal(pipeline.sourceBlocked(state, 'oi', end, end), false)
  } finally { await pipeline.dispose(); Date.now = nativeNow }
})
