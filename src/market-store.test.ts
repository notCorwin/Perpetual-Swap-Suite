import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

test('complete price gaps match the public price predicate even for incomplete legacy rows', async () => {
  const f = await fixture(), range = { ...query, through: base + 8 * step }
  try {
    assert.deepEqual(await f.store.missingCompletePriceRanges(range), [{ from: base, through: range.through }])
    await f.store.appendCandles(Array.from({ length: 9 }, (_, index) => candle(index)))
    const database = new DatabaseSync(f.store.path)
    try {
      const update = database.prepare('UPDATE candles SET base_volume=?, quote_volume=? WHERE timestamp=?')
      update.run(null, 1, base)
      update.run(1, null, base + step)
      update.run(0, 0, base + 2 * step)
      update.run(Number.MAX_VALUE, Number.MAX_VALUE, base + 3 * step)
      update.run(Infinity, 1, base + 4 * step)
      update.run('not-a-number', 1, base + 5 * step)
      update.run(-1, 1, base + 6 * step)
    } finally { database.close() }
    const rows = await f.store.candles(range), expected: { from: number; through: number }[] = []
    for (const row of rows) if (!(row.confirmed && [row.baseVolume, row.quoteVolume].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0))) {
      const last = expected.at(-1)
      if (last && last.through + step === row.timestamp) last.through = row.timestamp
      else expected.push({ from: row.timestamp, through: row.timestamp })
    }
    assert.deepEqual(expected, [{ from: base, through: base + step }, { from: base + 4 * step, through: base + 6 * step }])
    assert.deepEqual(await f.store.missingCompletePriceRanges(range), expected)
    assert.deepEqual(await f.store.missingCandleRanges(range), [], 'The existing row-presence query retains its distinct contract.')
    await assert.rejects(f.store.missingCompletePriceRanges({ ...range, intervalMS: step * 3 }), /interval must match/)
  } finally { await f.close() }
})

test('complete price gaps ignore off-grid legacy rows and retain inclusive grid boundaries', async () => {
  const f = await fixture(), range = { ...query, through: base + 4 * step }
  try {
    await f.store.appendCandles([candle(0), candle(2), candle(4)])
    const database = new DatabaseSync(f.store.path)
    try {
      const insert = database.prepare(`INSERT INTO candles(series_id,timestamp,open,high,low,close,volume,base_volume,quote_volume,written_at,origin,import_version)
        SELECT series_id,?,open,high,low,close,volume,base_volume,quote_volume,written_at,origin,import_version FROM candles WHERE timestamp=?`)
      insert.run(base + step + 1, base)
      insert.run(base + 3 * step + 0.5, base)
    } finally { database.close() }
    const expected = [{ from: base + step, through: base + step }, { from: base + 3 * step, through: base + 3 * step }]
    assert.deepEqual(await f.store.missingCompletePriceRanges(range), expected)
    assert.deepEqual(await f.store.missingCompletePriceRanges({ ...range, from: base + 1, through: base + 4 * step - 1 }), expected)
    assert.deepEqual(await f.store.missingCompletePriceRanges({ ...range, from: base + 1, through: base + step - 1 }), [])
    assert.deepEqual(await f.store.missingCompletePriceRanges({ ...range, from: base + 4 * step, through: base + 4 * step }), [])
  } finally { await f.close() }
})

test('coverage remains exact across mixed-series batches, repairs, and protected imports', async () => {
  const f = await fixture(), eth = 'ETH-USDT-SWAP'
  const ethCandle = (index: number) => ({ ...candle(index), instrument: eth })
  try {
    await f.store.appendCandles([candle(3), ethCandle(2), candle(1), candle(3, 105), ethCandle(0)])
    assert.deepEqual(await f.store.coverage(query.instrument, query.timeframe), { count: 2, first: base + step, last: base + 3 * step })
    assert.deepEqual(await f.store.coverage(eth, query.timeframe), { count: 2, first: base, last: base + 2 * step })

    await f.store.appendCandles([candle(3, 110), candle(0), candle(4), ethCandle(1)])
    assert.deepEqual(await f.store.coverage(query.instrument, query.timeframe), { count: 4, first: base, last: base + 4 * step })
    assert.deepEqual(await f.store.coverage(eth, query.timeframe), { count: 3, first: base, last: base + 2 * step })

    await f.store.replaceCandles({ ...query, from: base, through: base + step }, [candle(1)])
    assert.deepEqual(await f.store.coverage(query.instrument, query.timeframe), { count: 3, first: base + step, last: base + 4 * step })
    // Importing cannot resurrect the repaired range or replace a newer native price.
    await (f.store as any).writer.request('append', [[{ ...candle(0), writtenAt: 100 }, { ...candle(3, 120), writtenAt: 100 },
      { ...candle(5), writtenAt: 100 }, { ...ethCandle(3), writtenAt: 100 }], { importing: true }])
    assert.deepEqual(await f.store.coverage(query.instrument, query.timeframe), { count: 4, first: base + step, last: base + 5 * step })
    assert.deepEqual(await f.store.coverage(eth, query.timeframe), { count: 4, first: base, last: base + 3 * step })
    assert.deepEqual((await f.store.candles(query)).map(row => [row.timestamp, row.close]), [
      [base + step, 100], [base + 3 * step, 110], [base + 4 * step, 100], [base + 5 * step, 100],
    ])
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
    assert.ok(observations.every(row => row.statisticsVersion === 11))
    assert.equal(observations[0].oi, 1_000)
    assert.equal(observations[1].statisticsOIExpiresAt, source.expiresAt)
    await f.store.appendCandles([candle(0), candle(1)])
    let [row] = await f.store.candles(query)
    assert.equal(row.oi, 1_000); assert.equal(row.sell, 10); assert.equal(row.buy, 20)
    assert.equal(row.statisticsVersion, 11, 'Complete numeric observations use the same source format as empty observations.')
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

test('compact statistics coverage retains source gaps, leases, and price-dependent taker validity', async () => {
  const f = await fixture(), expiresAt = Date.now() + 60_000
  try {
    await f.store.appendCandles([candle(1), candle(2)])
    await f.store.appendStatistics({ ...query, source: 'oi', from: base, through: base, values: [[base, 42]] })
    await f.store.appendStatistics({ ...query, source: 'oi', from: base + step, through: base + 2 * step, values: [], expiresAt })
    await f.store.appendStatistics({ ...query, source: 'oi', from: base + 4 * step, through: base + 4 * step, values: [], expiresAt: null })
    const oi = await f.store.statisticsCoverage({ ...query, through: base + 4 * step, source: 'oi' })
    assert.deepEqual(oi, { gaps: [{ from: base + 3 * step, through: base + 3 * step }], expiries: [
      { from: base + step, through: base + 2 * step, expiresAt }, { from: base + 4 * step, through: base + 4 * step, expiresAt: 0 },
    ] })

    await f.store.appendStatistics({ ...query, source: 'taker', from: base, through: base, values: [[base, 1, 2]] })
    await f.store.appendStatistics({ ...query, source: 'taker', from: base + step, through: base + step, values: [[base + step, 0, 0]], expiresAt })
    await f.store.appendStatistics({ ...query, source: 'taker', from: base + 2 * step, through: base + 2 * step,
      values: [[base + 2 * step, 0.4, 0.6]], priceVolume: 1 })
    await f.store.appendCandles([{ ...candle(2), volume: 2 }])
    const taker = await f.store.statisticsCoverage({ ...query, through: base + 3 * step, source: 'taker' })
    assert.deepEqual(taker, { gaps: [{ from: base + 2 * step, through: base + 3 * step }],
      expiries: [{ from: base + step, through: base + step, expiresAt }] })
  } finally { await f.close() }
})

test('compact statistics coverage preserves malformed legacy observations for validation', async () => {
  const f = await fixture(), expiresAt = Date.now() + 60_000, end = base + 4 * step
  try {
    await f.store.appendCandles([candle(2), candle(3)])
    for (const source of ['oi', 'taker'] as const) {
      const values = Array.from({ length: 5 }, (_, i) => source === 'oi' ? [base + i * step, 1] : [base + i * step, 1, 1])
      await f.store.appendStatistics({ ...query, through: end, source, values })
    }
    const database = new DatabaseSync(f.store.path)
    try {
      const series = database.prepare('SELECT id FROM series WHERE instrument=? AND timeframe=?').get(query.instrument, query.timeframe) as { id: number }
      const update = database.prepare('UPDATE statistics SET value1=?, value2=?, expires_at=?, observed_volume=? WHERE series_id=? AND source=? AND timestamp=?')
      update.run(-1, null, expiresAt, null, series.id, 1, base)
      update.run('bad', null, expiresAt, null, series.id, 1, base + step)
      update.run(Infinity, null, expiresAt, null, series.id, 1, base + 2 * step)
      update.run(null, null, expiresAt, null, series.id, 1, base + 3 * step)
      database.prepare(`INSERT INTO statistics(series_id,source,timestamp,value1,value2,expires_at,written_at,origin,import_version,absence_attempts,observed_volume)
        VALUES(?,1,?,NULL,NULL,?,0,1,0,1,NULL)`).run(series.id, base + 3 * step + 1, expiresAt)
      update.run(1, null, expiresAt, null, series.id, 2, base)
      update.run(-1, 1, expiresAt, null, series.id, 2, base + step)
      update.run(0, 0, expiresAt, null, series.id, 2, base + 2 * step)
      update.run(1, 1, expiresAt, 99, series.id, 2, base + 3 * step)
    } finally { database.close() }
    assert.deepEqual(await f.store.statisticsCoverage({ ...query, through: end, source: 'oi' }), { gaps: [], expiries: [
      { from: base, through: base + 2 * step, expiresAt: 0 },
      { from: base + 3 * step, through: base + 3 * step, expiresAt },
      { from: base + 3 * step + 1, through: base + 3 * step + 1, expiresAt },
    ] })
    assert.deepEqual(await f.store.statisticsCoverage({ ...query, through: end, source: 'taker' }), {
      gaps: [{ from: base + 3 * step, through: base + 3 * step }], expiries: [
        { from: base, through: base, expiresAt }, { from: base + step, through: base + step, expiresAt: 0 },
        { from: base + 2 * step, through: base + 2 * step, expiresAt },
      ],
    })
  } finally { await f.close() }
})

test('coverage follows continuous series bounds through gaps, replacement and imported facts', async () => {
  const f = await fixture(), range = { ...query, through: base + 4 * step }
  try {
    assert.deepEqual(await f.store.missingCandleRanges(range), [{ from: base, through: range.through }])
    await f.store.appendCandles([0, 1, 3, 4].map(index => candle(index)))
    assert.deepEqual(await f.store.missingCandleRanges(range), [{ from: base + 2 * step, through: base + 2 * step }])
    await f.store.appendCandles([candle(2), candle(2)])
    assert.deepEqual(await f.store.missingCandleRanges(range), [])
    assert.deepEqual(await f.store.missingCandleRanges({ ...range, from: base + 1, through: base + 4 * step - 1 }), [])
    assert.deepEqual(await f.store.missingCandleRanges({ ...range, through: base + 5 * step }), [{ from: base + 5 * step, through: base + 5 * step }])

    await f.store.replaceCandles({ ...range, from: base + 2 * step, through: base + 2 * step }, [])
    assert.deepEqual(await f.store.missingCandleRanges(range), [{ from: base + 2 * step, through: base + 2 * step }])
    // Imported rows cannot resurrect a replaced range; native repairs can.
    await (f.store as any).writer.request('append', [[{ ...candle(2), writtenAt: 100 }], { importing: true }])
    assert.deepEqual(await f.store.missingCandleRanges(range), [{ from: base + 2 * step, through: base + 2 * step }])
    await f.store.appendCandles([candle(2)])
    assert.deepEqual(await f.store.missingCandleRanges(range), [])

    const expired = { ...range, source: 'oi' as const, values: [[base, 10]], expiresAt: 1 }
    await f.store.appendStatistics(expired)
    assert.deepEqual(await f.store.statisticsMissingRanges(expired), [{ from: base + step, through: range.through }])
    await f.store.appendStatistics({ ...expired, expiresAt: Date.now() + 60_000 })
    assert.deepEqual(await f.store.statisticsMissingRanges(expired), [])
  } finally { await f.close() }
})

test('integrity inspection detects gaps even if series metadata was corrupted', async () => {
  const f = await fixture(), range = { ...query, through: base + 2 * step }
  try {
    await f.store.appendCandles([candle(0), candle(1), candle(2)])
    const database = new DatabaseSync(f.store.path)
    try { database.prepare('DELETE FROM candles WHERE timestamp=?').run(base + step) } finally { database.close() }
    const inspection = await f.store.inspectCandles(range)
    assert.deepEqual(inspection.missingRanges, [{ from: base + step, through: base + step }])
    assert.ok(inspection.issues.some(issue => issue.reason === 'gap' && issue.from === base + step))
  } finally { await f.close() }
})

test('inspection preserves issue order, query limits, and covered gaps', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([2, 4, 6].map(index => ({ ...candle(index), baseVolume: null })))
    const database = new DatabaseSync(f.store.path)
    try {
      const insert = database.prepare('INSERT INTO import_issues(path,instrument,timeframe,from_ts,through_ts,reason,detail) VALUES(?,?,?,?,?,?,?)')
      insert.run('z', query.instrument, query.timeframe, base + 5 * step, base + 5 * step, 'corrupt-file', 'first')
      insert.run('a', query.instrument, query.timeframe, base, base + step, 'corrupt-file', 'second')
    } finally { database.close() }
    const report = await f.store.inspectCandles({ ...query, order: 'desc', limit: 2 })
    assert.equal(report.checkedRows, 2)
    assert.deepEqual(report.issues.map(issue => [issue.reason, issue.from, issue.file]), [
      ['missing-base-volume', base + 6 * step, undefined], ['missing-base-volume', base + 4 * step, undefined],
      ['corrupt-file', base + 5 * step, 'z'], ['corrupt-file', base, 'a'],
      ['gap', base + 3 * step, undefined], ['gap', base + 7 * step, undefined],
    ])
    assert.deepEqual(report.missingRanges, [{ from: base + 3 * step, through: base + 3 * step }, { from: base + 7 * step, through: base + 9 * step }])
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

test('price coverage versions ignore statistic writes and retain bounded changed ranges', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([candle(0), candle(1)])
    const priceRevision = f.store.candlePriceRevision(query.instrument, query.timeframe)
    await f.store.appendStatistics({ ...query, source: 'oi', values: [[base, 100]], expiresAt: Date.now() + 60_000 })
    assert.equal(f.store.candlePriceRevision(query.instrument, query.timeframe), priceRevision)
    assert.deepEqual(f.store.candlePriceChangesSince(query.instrument, query.timeframe, priceRevision), { revision: priceRevision, ranges: [] })
    await f.store.appendCandles([candle(3), candle(4)])
    await f.store.replaceCandles({ ...query, from: base, through: base }, [])
    const latest = f.store.candlePriceRevision(query.instrument, query.timeframe)
    assert.deepEqual(f.store.candlePriceChangesSince(query.instrument, query.timeframe, priceRevision), { revision: latest,
      ranges: [{ from: base, through: base }, { from: base + 3 * step, through: base + 4 * step }] })
    for (const invalid of [{}, { priceFrom: base, priceThrough: undefined }, { priceFrom: base - step, priceThrough: base }]) {
      const before = f.store.candlePriceRevision(query.instrument, query.timeframe)
      const takerBefore = f.store.statisticsCoverageRevision(query.instrument, query.timeframe, 'taker')
      ;(f.store as any).committed([{ instrument: query.instrument, timeframe: query.timeframe, from: base, through: base, ...invalid }])
      assert.deepEqual(f.store.candlePriceChangesSince(query.instrument, query.timeframe, before), { revision: before + 1, ranges: null })
      assert.deepEqual(f.store.statisticsCoverageChangesSince(query.instrument, query.timeframe, 'taker', takerBefore), { revision: takerBefore + 1, ranges: null })
    }
    for (let index = 0; index < 257; index++) (f.store as any).committed([{ instrument: query.instrument, timeframe: query.timeframe,
      from: base, through: base, priceFrom: base, priceThrough: base }])
    const truncated = f.store.candlePriceRevision(query.instrument, query.timeframe)
    assert.deepEqual(f.store.candlePriceChangesSince(query.instrument, query.timeframe, priceRevision), { revision: truncated, ranges: null })
  } finally { await f.close() }
})

test('statistics coverage versions isolate sources and retain price-dependent taker invalidation', async () => {
  const f = await fixture()
  let restarted: MarketStore | undefined
  try {
    const version = (source: 'oi' | 'taker') => f.store.statisticsCoverageRevision(query.instrument, query.timeframe, source)
    const changes = (source: 'oi' | 'taker', revision: number) => f.store.statisticsCoverageChangesSince(query.instrument, query.timeframe, source, revision)
    await f.store.appendStatistics({ ...query, through: base, source: 'oi', values: [[base, 100]] })
    assert.deepEqual([version('oi'), version('taker')], [1, 0])
    await f.store.appendStatistics({ ...query, from: base + step, through: base + step, source: 'taker', values: [[base + step, 0, 0]] })
    assert.deepEqual([version('oi'), version('taker')], [1, 1])
    await f.store.appendCandles([candle(1)])
    assert.deepEqual([version('oi'), version('taker')], [1, 2], 'Price can invalidate Taker zero or price-bound facts, but not OI.')
    assert.equal((await f.store.statistics({ ...query, source: 'taker' }))[0].sell, null)
    assert.deepEqual(changes('oi', 0), { revision: 1, ranges: [{ from: base, through: base }] })
    assert.deepEqual(changes('taker', 0), { revision: 2, ranges: [{ from: base + step, through: base + step }] })
    await f.store.appendStatistics({ ...query, from: base + 2 * step, through: base + 2 * step, source: 'oi', values: [], expiresAt: Date.now() + 60_000 })
    assert.deepEqual([version('oi'), version('taker')], [2, 2], 'An empty OI lease changes only OI coverage.')
    await (f.store as any).writer.request('append', [[{ ...candle(3), oi: 77, statisticsVersion: 9, writtenAt: 100 }], { importing: true }])
    assert.deepEqual([version('oi'), version('taker')], [3, 3], 'Import records both its OI and its price effects.')
    assert.deepEqual(changes('oi', 2), { revision: 3, ranges: [{ from: base + 3 * step, through: base + 3 * step }] })
    await (f.store as any).writer.request('append', [[{ ...candle(1), oi: 55, statisticsVersion: 9, writtenAt: 101 }], { importing: true }])
    assert.deepEqual([version('oi'), version('taker')], [4, 3], 'An OI-only import cannot invalidate Taker.')
    const oiBeforeUnknown = version('oi'), takerBeforeUnknown = version('taker')
    ;(f.store as any).committed([{ instrument: query.instrument, timeframe: query.timeframe, from: base + 4 * step,
      through: base + 4 * step, priceFrom: null, priceThrough: null }])
    assert.equal(changes('oi', oiBeforeUnknown).ranges, null)
    assert.equal(changes('taker', takerBeforeUnknown).ranges, null)
    const old = version('oi')
    for (let index = 0; index < 257; index++) (f.store as any).committed([{ instrument: query.instrument, timeframe: query.timeframe,
      from: base, through: base, priceFrom: null, priceThrough: null, oiFrom: base, oiThrough: base, takerFrom: null, takerThrough: null }])
    assert.deepEqual(changes('oi', old), { revision: version('oi'), ranges: null })
    await f.store.close(); restarted = await MarketStore.open(f.root)
    assert.equal(restarted.statisticsCoverageRevision(query.instrument, query.timeframe, 'oi'), 0)
    assert.equal((await restarted.statistics({ ...query, source: 'oi' })).find(value => value.timestamp === base)?.oi, 100)
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
