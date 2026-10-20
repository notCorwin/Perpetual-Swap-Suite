import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'

const step = 300_000, base = Date.UTC(2024, 0, 1)
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base + 9 * step }
const candle = (index: number, close = 100) => ({ instrument: query.instrument, timeframe: query.timeframe, timestamp: base + index * step,
  open: 100, high: Math.max(101, close), low: 99, close, volume: 1, baseVolume: 1, quoteVolume: 100, confirmed: true })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-sqlite-')), store = await MarketStore.open(root)
  return { root, store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('confirmed facts use worker-owned SQLite and indexed bounded native ranges', async () => {
  const f = await fixture()
  try {
    const threads = f.store.workerThreadIds
    assert.ok(threads.writer > 0)
    assert.equal(new Set([threads.writer, ...threads.readers]).size, 3)
    await f.store.appendCandles(Array.from({ length: 10 }, (_, index) => candle(index)))
    assert.deepEqual((await f.store.candles({ ...query, from: base + 3 * step, through: base + 6 * step, limit: 2, order: 'desc' })).map(row => row.timestamp), [base + 6 * step, base + 5 * step])
    assert.deepEqual(await f.store.coverage(query.instrument, query.timeframe), { count: 10, first: base, last: base + 9 * step })
    assert.ok((await readdir(f.root)).includes('market.sqlite'))
    assert.ok(!(await readdir(f.root)).includes('candles'))
    assert.deepEqual(await f.store.integrityCheck(), ['ok'])
  } finally { await f.close() }
})

test('source observations commit before candles and preserve numeric truth across empty renewals', async () => {
  const f = await fixture()
  try {
    const source = { ...query, through: base + step, source: 'oi' as const, expiresAt: Date.now() + 60_000 }
    await f.store.appendStatistics({ ...source, values: [[base, 1_000]] })
    await f.store.appendStatistics({ ...source, source: 'taker', values: [[base, 10, 20]] })
    assert.deepEqual(await f.store.candles(query), [])
    const observations = await f.store.statistics(query)
    assert.equal(observations.length, 2)
    assert.equal(observations[0].oi, 1_000)
    assert.equal(observations[1].statisticsOIExpiresAt, source.expiresAt)
    await f.store.appendCandles([candle(0), candle(1)])
    let [row] = await f.store.candles(query)
    assert.equal(row.oi, 1_000); assert.equal(row.sell, 10); assert.equal(row.buy, 20)
    const price = await f.store.priceWatermark(query.instrument, query.timeframe)
    await f.store.appendStatistics({ ...source, values: [] })
    await f.store.appendStatistics({ ...source, source: 'taker', values: [] })
    ;[row] = await f.store.candles(query)
    assert.equal(row.oi, 1_000); assert.equal(row.sell, 10); assert.equal(row.buy, 20)
    assert.equal(await f.store.priceWatermark(query.instrument, query.timeframe), price)
  } finally { await f.close() }
})

test('native coverage reports exact gaps and independently expires explicit absence', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([0, 1, 3, 6, 7, 8, 9].map(index => candle(index)))
    assert.deepEqual(await f.store.missingCandleRanges(query), [{ from: base + 2 * step, through: base + 2 * step }, { from: base + 4 * step, through: base + 5 * step }])
    const source = { ...query, source: 'oi' as const, values: [[base, 100]], expiresAt: 1 }
    await f.store.appendStatistics(source)
    assert.deepEqual(await f.store.statisticsMissingRanges(source), [{ from: base + step, through: query.through }])
    await f.store.appendStatistics({ ...source, expiresAt: Date.now() + 60_000 })
    assert.deepEqual(await f.store.statisticsMissingRanges(source), [])
  } finally { await f.close() }
})

test('a later traded price invalidates Taker zero placeholders without renewing their original proof', async () => {
  const f = await fixture()
  try {
    const source = { ...query, through: base, source: 'taker' as const, values: [[base, 0, 0]], expiresAt: 1 }
    await f.store.appendStatistics(source)
    assert.equal((await f.store.statistics(source))[0].buy, 0, 'A source is admitted independently before its price exists.')
    await f.store.appendCandles([candle(0)])
    const [observation] = await f.store.statistics(source), [price] = await f.store.candles(source)
    assert.equal(observation.buy, null); assert.equal(observation.sell, null)
    assert.equal(observation.statisticsTakerExpiresAt, 1)
    assert.equal(price.buy, null); assert.equal(price.statisticsTakerExpiresAt, 1)
    assert.deepEqual(await f.store.statisticsMissingRanges(source), [{ from: base, through: base }])
    const renewed = Date.now() + 60_000
    await f.store.appendStatistics({ ...source, values: [], expiresAt: renewed })
    assert.equal((await f.store.statistics(source))[0].statisticsTakerExpiresAt, renewed)
    assert.deepEqual(await f.store.statisticsMissingRanges(source), [])
  } finally { await f.close() }
})

test('a rejected batch changes neither facts nor coverage, and missing units stay unknown', async () => {
  const f = await fixture()
  try {
    for (const patch of [{ confirmed: false }, { timestamp: base + 1 }, { high: 90 }, { open: Infinity }, { volume: -1 }, { baseVolume: -1 }, { oi: '10' }]) {
      await assert.rejects(f.store.appendCandles([candle(0), { ...candle(1), ...patch } as any]))
      assert.deepEqual(await f.store.candles(query), [])
      assert.equal((await f.store.coverage(query.instrument, query.timeframe)).count, 0)
    }
    await f.store.appendCandles([{ ...candle(0), baseVolume: null }])
    assert.equal((await f.store.candles(query))[0].baseVolume, null)
    assert.equal((await f.store.inspectCandles({ ...query, through: base })).issues[0].reason, 'missing-base-volume')
  } finally { await f.close() }
})

test('integrity inspection finds missing volume units and verifies their persisted replacements', async () => {
  const f = await fixture(), target = { ...query, through: base + 4 * step }
  try {
    await f.store.appendCandles([
      { ...candle(0), baseVolume: null },
      { ...candle(1), quoteVolume: null },
      { ...candle(2), baseVolume: null, quoteVolume: null },
      { ...candle(3), volume: 0, baseVolume: 0, quoteVolume: 0 },
    ])
    const inspection = await f.store.inspectCandles(target)
    assert.equal(inspection.checkedRows, 4)
    assert.deepEqual(inspection.issues.map(({ from, through, reason, repairable }) => ({ from, through, reason, repairable })), [
      { from: base, through: base, reason: 'missing-base-volume', repairable: true },
      { from: base + step, through: base + step, reason: 'missing-quote-volume', repairable: true },
      { from: base + 2 * step, through: base + 2 * step, reason: 'missing-base-volume', repairable: true },
      { from: base + 2 * step, through: base + 2 * step, reason: 'missing-quote-volume', repairable: true },
      { from: base + 4 * step, through: base + 4 * step, reason: 'gap', repairable: true },
    ])
    assert.deepEqual(inspection.missingRanges, [{ from: base + 4 * step, through: base + 4 * step }])

    await f.store.replaceCandles({ ...target, through: base + 2 * step }, [candle(0), candle(1), { ...candle(2), quoteVolume: null }])
    assert.deepEqual((await f.store.inspectCandles({ ...target, through: base + 3 * step })).issues.map(issue => issue.reason), ['missing-quote-volume'],
      'Persisting only part of the required units cannot certify a repaired range.')
    await f.store.replaceCandles({ ...target, from: base + 2 * step, through: base + 2 * step }, [candle(2)])
    await f.store.appendCandles([candle(4)])
    const verified = await f.store.inspectCandles(target)
    assert.equal(verified.checkedRows, 5)
    assert.deepEqual(verified.issues, [])
    assert.deepEqual(verified.missingRanges, [])
    assert.deepEqual((await f.store.candles(target)).map(({ baseVolume, quoteVolume }) => [baseVolume, quoteVolume]), [[1, 100], [1, 100], [1, 100], [0, 0], [1, 100]])
  } finally { await f.close() }
})

test('durable versions survive restart and same-batch revisions are deterministic', async () => {
  const f = await fixture()
  let restarted: MarketStore | undefined
  try {
    await f.store.appendCandles([candle(0), candle(0, 101)])
    const watermark = await f.store.candleWatermark(query.instrument, query.timeframe)
    const revision = f.store.candleRevision(query.instrument, query.timeframe)
    assert.deepEqual(f.store.candleChangesSince(query.instrument, query.timeframe, 0), { revision, ranges: [{ from: base, through: base }] })
    await f.store.close(); restarted = await MarketStore.open(f.root)
    assert.equal((await restarted.candles(query))[0].close, 101)
    assert.equal(await restarted.candleWatermark(query.instrument, query.timeframe), watermark)
    await restarted.replaceCandles({ ...query, through: base }, [])
    assert.deepEqual(await restarted.candles(query), [])
    assert.notEqual(await restarted.candleWatermark(query.instrument, query.timeframe), watermark)
  } finally { await restarted?.close(); await f.close() }
})

test('checkpoint validity follows price corrections while statistics and later appends preserve earlier seeds', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([0, 1, 2].map(index => candle(index)))
    const checkpoint = { instrument: query.instrument, timeframe: query.timeframe, timestamp: base + step, formulaVersion: 'test-v1', state: { count: 2, ema: 100 }, sourceRevision: await f.store.priceWatermark(query.instrument, query.timeframe) }
    assert.equal(await f.store.writeIndicatorCheckpoint(checkpoint), true)
    await f.store.appendCandles([candle(3)])
    await f.store.appendStatistics({ ...query, source: 'oi', values: [[base, 100]], expiresAt: Date.now() + 60_000 })
    assert.deepEqual((await f.store.readIndicatorCheckpoint({ ...query, before: query.through, formulaVersion: 'test-v1' }))?.state, checkpoint.state)
    await f.store.appendCandles([candle(0, 110)])
    assert.equal(await f.store.readIndicatorCheckpoint({ ...query, before: query.through, formulaVersion: 'test-v1' }), null)
    assert.equal(await f.store.writeIndicatorCheckpoint(checkpoint), false)
  } finally { await f.close() }
})

test('close joins accepted transactions and rejects subsequent requests', async () => {
  const f = await fixture()
  try {
    const accepted = f.store.appendCandles(Array.from({ length: 1_000 }, (_, index) => candle(index))), closing = f.store.close()
    await assert.rejects(f.store.candles(query), /closed/)
    await accepted; await closing
    const restarted = await MarketStore.open(f.root)
    try { assert.equal((await restarted.coverage(query.instrument, query.timeframe)).count, 1_000) }
    finally { await restarted.close() }
  } finally { await f.close() }
})
