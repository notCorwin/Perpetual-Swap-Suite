import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../electron/services/market-store.js'

const instrument = 'BTC-USDT-SWAP'
const childStep = 300_000, quarterHour = childStep * 3
const base = Date.UTC(2024, 0, 1)
const child = (index: number, patch: Record<string, unknown> = {}) => ({
  instrument, timeframe: '5m', timestamp: base + index * childStep,
  open: 100 + index, high: 110 + index, low: 90 + index, close: 101 + index,
  volume: index + 1, baseVolume: (index + 1) / 10, quoteVolume: (index + 1) * 100,
  confirmed: true, ...patch,
})
const parent = (timeframe: '15m' | '1H', timestamp = base, patch: Record<string, unknown> = {}) => ({
  instrument, timeframe, timestamp,
  open: 500, high: 600, low: 400, close: 550, volume: 50, baseVolume: 5, quoteVolume: 25_000,
  confirmed: true, ...patch,
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-aggregate-')), store = await MarketStore.open(root)
  return { store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }) } }
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * Number.EPSILON * 8,
  `expected ${actual} to be within floating point rounding of ${expected}`)

test('aggregates complete contiguous 5m children into 15m and 1H while preserving every volume unit', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles(Array.from({ length: 12 }, (_, index) => child(index)))
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base + 3 * quarterHour }),
      { changed: 4, complete: 4, invalidated: 0 })
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '1H', from: base, through: base }),
      { changed: 1, complete: 1, invalidated: 0 })

    const fifteen = await f.store.candles({ instrument, timeframe: '15m', from: base, through: base + 3 * quarterHour })
    assert.deepEqual(fifteen.map(row => [row.timestamp, row.open, row.high, row.low, row.close]), [
      [base, 100, 112, 90, 103],
      [base + quarterHour, 103, 115, 93, 106],
      [base + 2 * quarterHour, 106, 118, 96, 109],
      [base + 3 * quarterHour, 109, 121, 99, 112],
    ])
    near(fifteen[0].volume, 1 + 2 + 3)
    near(fifteen[0].baseVolume!, 0.1 + 0.2 + 0.3)
    near(fifteen[0].quoteVolume!, 100 + 200 + 300)
    const [hourly] = await f.store.candles({ instrument, timeframe: '1H', from: base, through: base })
    assert.equal(hourly.open, 100)
    assert.equal(hourly.high, 121)
    assert.equal(hourly.low, 90)
    assert.equal(hourly.close, 112)
    near(hourly.volume, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12)
    near(hourly.baseVolume!, (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12) / 10)
    near(hourly.quoteVolume!, (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12) * 100)
    assert.equal(hourly.confirmed, true)
  } finally { await f.close() }
})

test('unchanged aggregates publish no mutations, and changed aggregates invalidate price checkpoints', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([child(0), child(1), child(2)])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 1, complete: 1, invalidated: 0 })
    const priceWatermark = await f.store.priceWatermark(instrument, '15m')
    await f.store.appendStatistics({ instrument, timeframe: '15m', from: base, through: base, source: 'oi', values: [[base, 1000]] })
    const revision = f.store.candleRevision(instrument, '15m')
    const checkpoint = { instrument, timeframe: '15m', timestamp: base, formulaVersion: 'aggregate-test-v1', state: { close: 103 }, sourceRevision: priceWatermark }
    assert.equal(await f.store.writeIndicatorCheckpoint(checkpoint), true)
    const changes: Array<{ instrument: string; timeframe: string; from: number; through: number; priceFrom: number | null }> = []
    const unsubscribe = f.store.subscribe(change => changes.push(change))
    const parentChanges = () => changes.filter(change => change.timeframe === '15m')

    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 0, complete: 1, invalidated: 0 })
    assert.equal(f.store.candleRevision(instrument, '15m'), revision)
    assert.equal(await f.store.priceWatermark(instrument, '15m'), priceWatermark)
    assert.equal((await f.store.readIndicatorCheckpoint({ instrument, timeframe: '15m', before: base, formulaVersion: 'aggregate-test-v1' }))?.state.close, 103)
    assert.deepEqual(parentChanges(), [])

    // Changing an interior child without changing aggregate OHLCV keeps the
    // parent row and its price checkpoint intact.
    await f.store.appendCandles([child(1, { open: 102, close: 103, high: 110, low: 90 })])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 0, complete: 1, invalidated: 0 })
    assert.deepEqual(parentChanges(), [])
    assert.equal((await f.store.readIndicatorCheckpoint({ instrument, timeframe: '15m', before: base, formulaVersion: 'aggregate-test-v1' }))?.state.close, 103)

    await f.store.appendCandles([child(2, { close: 115, high: 115 })])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 1, complete: 1, invalidated: 0 })
    assert.deepEqual(parentChanges().map(change => [change.timeframe, change.from, change.through, change.priceFrom]), [['15m', base, base, base]])
    assert.notEqual(await f.store.priceWatermark(instrument, '15m'), priceWatermark)
    assert.equal(await f.store.readIndicatorCheckpoint({ instrument, timeframe: '15m', before: base, formulaVersion: 'aggregate-test-v1' }), null)
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: base, through: base }))[0].oi, 1000)
    unsubscribe()
  } finally { await f.close() }
})

test('invalidation removes only incomplete derived prices and leaves independent statistics intact', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([child(0), child(1), child(2)])
    await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base })
    await f.store.appendStatistics({ instrument, timeframe: '15m', from: base, through: base, source: 'oi', values: [[base, 1234]] })
    await f.store.replaceCandles({ instrument, timeframe: '5m', from: base + childStep, through: base + childStep }, [])

    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 0, complete: 0, invalidated: 0 })
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: base, through: base })).length, 1)

    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base, invalidateIncomplete: true }),
      { changed: 1, complete: 0, invalidated: 1 })
    assert.deepEqual(await f.store.candles({ instrument, timeframe: '15m', from: base, through: base }), [])
    const [statistics] = await f.store.statistics({ instrument, timeframe: '15m', from: base, through: base })
    assert.equal(statistics.oi, 1234)

    // Default local gap materialization preserves native coarse history.
    await f.store.appendCandles([parent('15m', base, { high: 800, close: 777 })])
    await f.store.replaceCandles({ instrument, timeframe: '5m', from: base, through: base + 2 * childStep }, [child(0), child(1), child(2)])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 0, complete: 1, invalidated: 0 })
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: base, through: base }))[0].close, 777)
    await f.store.replaceCandles({ instrument, timeframe: '5m', from: base, through: base + 2 * childStep }, [child(0), child(1)])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base, invalidateIncomplete: true }),
      { changed: 0, complete: 0, invalidated: 0 })
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: base, through: base }))[0].close, 777)

    // A forced changed-child repair may replace that native price once the
    // complete canonical aggregate is proven, then later repairs update it.
    await f.store.replaceCandles({ instrument, timeframe: '5m', from: base, through: base + 2 * childStep },
      [child(0), child(1), child(2, { close: 115, high: 115 })])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base, invalidateIncomplete: true }),
      { changed: 1, complete: 1, invalidated: 0 })
    const [forcedCorrection] = await f.store.candles({ instrument, timeframe: '15m', from: base, through: base })
    assert.equal(forcedCorrection.close, 115)
    assert.equal(forcedCorrection.oi, 1234, 'A forced price correction preserves parent OI.')
    await f.store.appendCandles([child(2, { close: 116, high: 116 })])
    assert.deepEqual(await f.store.aggregateCandles({ instrument, timeframe: '15m', from: base, through: base }),
      { changed: 1, complete: 1, invalidated: 0 })
    assert.equal((await f.store.candles({ instrument, timeframe: '15m', from: base, through: base }))[0].close, 116)
  } finally { await f.close() }
})

test('aggregation requires complete parent bucket boundaries', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.store.aggregateCandles({ instrument, timeframe: '15m', from: base + 1, through: base + quarterHour }), /Invalid candle aggregation range/)
    // @ts-expect-error Exercise runtime rejection of an unsupported parent period.
    await assert.rejects(f.store.aggregateCandles({ instrument, timeframe: '5m', from: base, through: base }), /Invalid candle aggregation range/)
    // @ts-expect-error Exercise runtime rejection of a missing required boundary.
    await assert.rejects(f.store.aggregateCandles({ instrument, timeframe: '15m', from: base }), /explicit parent range/)
  } finally { await f.close() }
})

test('late archive imports preserve derived prices and their invalidation provenance', async () => {
  const f = await fixture(), range = { instrument, timeframe: '15m', from: base, through: base }
  try {
    await f.store.appendCandles([child(0), child(1), child(2)])
    await f.store.aggregateCandles({ ...range, timeframe: '15m' })
    const [derived] = await f.store.candles(range)
    // Exercise the same writer protocol used by the asynchronous archive importer.
    const writer = (f.store as any).writer
    await writer.request('append', [[{ ...derived, writtenAt: Date.now() + 1_000 }], { importing: true }])
    await writer.request('append', [[parent('15m', base, { oi: 123, statisticsVersion: 9, writtenAt: Date.now() + 2_000 })], { importing: true }])
    const [retained] = await f.store.candles(range)
    assert.deepEqual([retained.close, retained.volume, retained.oi], [derived.close, derived.volume, 123])
    await f.store.replaceCandles({ instrument, timeframe: '5m', from: base + childStep, through: base + childStep }, [])
    assert.equal((await f.store.aggregateCandles({ ...range, timeframe: '15m', invalidateIncomplete: true })).invalidated, 1)
    assert.deepEqual(await f.store.candles(range), [])
    assert.equal((await f.store.statistics(range))[0].oi, 123)
  } finally { await f.close() }
})

test('late Taker results are skipped and price-volume mismatches become missing without hiding OI', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([child(0)])
    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'oi', values: [[base, 900]] }), 1)
    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker', values: [[base, 0.4, 0.6]], priceVolume: 1,
      preserveExistingSource: true }), 1)

    await f.store.appendCandles([child(0, { volume: 2 })])
    let [price] = await f.store.candles({ instrument, timeframe: '5m', from: base, through: base })
    assert.equal(price.oi, 900)
    assert.equal(price.sell, null)
    assert.equal(price.buy, null)
    assert.equal(Number(price.statisticsVersion) & 1, 1)
    assert.equal(Number(price.statisticsVersion) & 2, 0)
    let [taker] = await f.store.statistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' })
    assert.equal(taker.sell, null)
    assert.equal(taker.buy, null)
    assert.equal(taker.statisticsVersion & 2, 0)
    assert.deepEqual(await f.store.statisticsMissingRanges({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' }),
      [{ from: base, through: base }])

    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker', values: [[base, 0.4, 0.6]], priceVolume: 1,
      preserveExistingSource: true }), 0, 'A delayed result cannot commit after its candle volume changed.')
    assert.deepEqual(await f.store.statisticsMissingRanges({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' }),
      [{ from: base, through: base }])

    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker', values: [[base, 0.8, 1.2]], priceVolume: 2,
      preserveExistingSource: true }), 1, 'A current calculation replaces the stale derived value.')
    ;[price] = await f.store.candles({ instrument, timeframe: '5m', from: base, through: base })
    assert.deepEqual([price.oi, price.sell, price.buy], [900, 0.8, 1.2])
    assert.deepEqual(await f.store.statisticsMissingRanges({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' }), [])

    await f.store.appendCandles([child(0, { volume: 3 })])
    ;[price] = await f.store.candles({ instrument, timeframe: '5m', from: base, through: base })
    assert.equal(price.oi, 900)
    assert.equal(price.sell, null)
    assert.equal(price.buy, null)
    assert.deepEqual(await f.store.statisticsMissingRanges({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' }),
      [{ from: base, through: base }])
  } finally { await f.close() }
})

test('preserveExistingSource keeps native Taker facts across local writes and price corrections', async () => {
  const f = await fixture()
  try {
    await f.store.appendCandles([child(0)])
    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker', values: [[base, 0.25, 0.75]] }), 1)
    assert.equal(await f.store.appendStatistics({ instrument, timeframe: '5m', from: base, through: base, source: 'taker', values: [[base, 0.4, 0.6]],
      priceVolume: 1, preserveExistingSource: true }), 0)

    await f.store.appendCandles([child(0, { volume: 2 })])
    const [price] = await f.store.candles({ instrument, timeframe: '5m', from: base, through: base })
    assert.deepEqual([price.sell, price.buy], [0.25, 0.75])
    assert.deepEqual(await f.store.statisticsMissingRanges({ instrument, timeframe: '5m', from: base, through: base, source: 'taker' }), [])
  } finally { await f.close() }
})

test('a complete local Taker proof replaces earlier unavailable evidence', async () => {
  const f = await fixture(), range = { instrument, timeframe: '5m', from: base, through: base }
  try {
    await f.store.appendCandles([child(0)])
    await f.store.appendStatistics({ ...range, source: 'taker', values: [] })
    assert.equal((await f.store.candles(range))[0].buy, null)
    assert.equal(await f.store.appendStatistics({ ...range, source: 'taker', values: [[base, 0.4, 0.6]],
      priceVolume: 1, preserveExistingSource: true }), 1)
    const [saved] = await f.store.candles(range)
    assert.deepEqual([saved.sell, saved.buy, saved.statisticsTakerExpiresAt], [0.4, 0.6, null])
    assert.deepEqual(await f.store.statisticsMissingRanges({ ...range, source: 'taker' }), [])
  } finally { await f.close() }
})

test('observed candle volume migrates from v2 and survives reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-observed-volume-v2-'))
  let store: MarketStore | undefined
  try {
    const database = new DatabaseSync(join(root, 'market.sqlite'))
    try {
      database.exec(`CREATE TABLE series (
        id INTEGER PRIMARY KEY, instrument TEXT NOT NULL, timeframe TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, price_revision INTEGER NOT NULL DEFAULT 0,
        candle_count INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER, UNIQUE(instrument,timeframe));
        CREATE TABLE statistics (
          series_id INTEGER NOT NULL, source INTEGER NOT NULL, timestamp INTEGER NOT NULL,
          value1 REAL, value2 REAL, expires_at INTEGER, written_at INTEGER NOT NULL,
          origin INTEGER NOT NULL, import_version INTEGER NOT NULL DEFAULT 0, absence_attempts INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(series_id,source,timestamp)) WITHOUT ROWID;
        INSERT INTO series(id,instrument,timeframe) VALUES(1,'BTC-USDT-SWAP','5m');
        INSERT INTO statistics(series_id,source,timestamp,value1,value2,written_at,origin) VALUES(1,2,${base},3,7,${base},1);
        PRAGMA user_version=2;`)
    } finally { database.close() }

    store = await MarketStore.open(root)
    await store.appendCandles([child(0), child(1)])
    assert.equal(await store.appendStatistics({ instrument, timeframe: '5m', from: base + childStep, through: base + childStep, source: 'taker',
      values: [[base + childStep, 0.5, 1.5]], priceVolume: 2, preserveExistingSource: true }), 1)
    await store.close(); store = await MarketStore.open(root)

    const rows = await store.statistics({ instrument, timeframe: '5m', from: base, through: base + childStep })
    assert.deepEqual(rows.map(row => [row.sell, row.buy]), [[3, 7], [0.5, 1.5]])
    const migrated = new DatabaseSync(join(root, 'market.sqlite'))
    try {
      assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 3)
      assert.equal(migrated.prepare('SELECT observed_volume FROM statistics WHERE series_id=1 AND source=2 AND timestamp=?').get(base)!.observed_volume, null)
      assert.equal(migrated.prepare('SELECT observed_volume FROM statistics WHERE series_id=1 AND source=2 AND timestamp=?').get(base + childStep)!.observed_volume, 2)
    } finally { migrated.close() }
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})
