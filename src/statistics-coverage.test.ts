import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../electron/services/market-store.js'
import { STATISTICS_ABSENCE_POLICY, statisticsAbsenceExpiryAt } from '../electron/services/statistics-coverage.js'

const step = 300_000, hour = 3_600_000, day = 24 * hour, base = Date.UTC(2024, 0, 1)
const query = { instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: base, through: base }
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-statistics-coverage-')), store = await MarketStore.open(root)
  return { root, store, close: async () => { await store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('absence policy uses each slot age and always has a finite capped retry time', () => {
  const observedAt = base + day
  assert.equal(statisticsAbsenceExpiryAt('5m', observedAt - 2 * step, observedAt, 1), observedAt + 60_000)
  assert.equal(statisticsAbsenceExpiryAt('5m', observedAt - step, observedAt, 1_000), observedAt + 60_000)
  assert.equal(statisticsAbsenceExpiryAt('5m', base, observedAt, 1), observedAt + 6 * hour)
  assert.equal(statisticsAbsenceExpiryAt('5m', base, observedAt, 2), observedAt + 12 * hour)
  for (const attempts of [3, 4, 100, Number.MAX_SAFE_INTEGER]) {
    assert.equal(statisticsAbsenceExpiryAt('5m', base, observedAt, attempts), observedAt + STATISTICS_ABSENCE_POLICY.maximumLeaseMS)
  }
  assert.ok(Number.isSafeInteger(statisticsAbsenceExpiryAt('1H', base, Number.MAX_SAFE_INTEGER, 100)))
})

test('a mixed-age empty page persists independent slot and source observation metadata', async () => {
  const f = await fixture()
  try {
    const observedAt = Date.now(), through = Math.floor(observedAt / step) * step
    const page = { ...query, from: through - 3 * step, through, source: 'oi' as const, values: [], observedAt }
    await f.store.appendStatistics(page)
    await f.store.appendStatistics({ ...page, from: through, source: 'taker', observedAt: observedAt + 10 })
    const rows = await f.store.statistics({ ...page, source: undefined })
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map(row => row.statisticsOIObservedAt), Array(4).fill(observedAt))
    assert.deepEqual(rows.map(row => row.statisticsOIAbsenceAttempts), [1, 1, 1, 1])
    assert.deepEqual(rows.map(row => row.statisticsOIExpiresAt), rows.map(row => observedAt + (row.timestamp >= observedAt - 2 * step ? 60_000 : 6 * hour)))
    assert.equal(rows[0].statisticsOIExpiresAt, observedAt + 6 * hour)
    assert.equal(rows[3].statisticsOIExpiresAt, observedAt + 60_000)
    assert.equal(rows[0].statisticsTakerObservedAt, null)
    assert.equal(rows[0].statisticsTakerAbsenceAttempts, 0)
    assert.equal(rows[3].statisticsTakerObservedAt, observedAt + 10)
    assert.equal(rows[3].statisticsTakerAbsenceAttempts, 1)
    await f.store.appendStatistics({ ...page, through: page.from, instrument: 'ETH-USDT-SWAP' })
    const [isolated] = await f.store.statistics({ ...page, instrument: 'ETH-USDT-SWAP' })
    assert.equal(isolated.statisticsOIExpiresAt, rows[0].statisticsOIExpiresAt, 'Page boundaries cannot determine a slot lease.')
  } finally { await f.close() }
})

test('old empty observations back off across reopen but never become permanent coverage', async () => {
  const f = await fixture()
  let restarted: MarketStore | undefined
  try {
    let store = f.store, observedAt = Date.now() - 14 * day
    for (let attempt = 1; attempt <= 6; attempt++) {
      await store.appendStatistics({ ...query, source: 'oi', values: [], observedAt })
      const [row] = await store.statistics(query)
      const duration = Math.min(6 * hour * 2 ** (attempt - 1), day)
      assert.equal(row.statisticsOIObservedAt, observedAt)
      assert.equal(row.statisticsOIAbsenceAttempts, attempt)
      assert.equal(row.statisticsOIExpiresAt, observedAt + duration)
      assert.deepEqual(await store.statisticsMissingRanges({ ...query, source: 'oi' }), [{ from: base, through: base }])
      if (attempt === 2) {
        await f.store.close(); restarted = await MarketStore.open(f.root); store = restarted
        assert.deepEqual(await store.statistics(query), [row])
      }
      observedAt += duration
    }
    const [row] = await store.statistics(query)
    await store.appendStatistics({ ...query, source: 'oi', values: [], observedAt: row.statisticsOIObservedAt! - 1 })
    assert.deepEqual(await store.statistics(query), [row], 'A delayed older response cannot renew newer absence proof.')
    await store.appendStatistics({ ...query, source: 'taker', values: [], observedAt })
    const [both] = await store.statistics(query)
    assert.equal(both.statisticsOIAbsenceAttempts, 6)
    assert.equal(both.statisticsTakerAbsenceAttempts, 1, 'Sources have independent retry histories.')
  } finally { await restarted?.close(); await f.close() }
})

test('numeric corrections reset absence attempts and remain reusable through empty pages and reopen', async () => {
  const f = await fixture()
  let restarted: MarketStore | undefined
  try {
    const observedAt = Date.now() - 2 * day
    for (const source of ['oi', 'taker'] as const) await f.store.appendStatistics({ ...query, source, values: [], observedAt })
    await f.store.appendStatistics({ ...query, source: 'oi', values: [[base, 1_000]], observedAt: observedAt + 1, expiresAt: 1 })
    await f.store.appendStatistics({ ...query, source: 'taker', values: [[base, 20, 10]], observedAt: observedAt + 2, expiresAt: 1 })
    const [original] = await f.store.statistics(query)
    assert.equal(original.statisticsOIObservedAt, observedAt + 1)
    assert.equal(original.statisticsTakerObservedAt, observedAt + 2)
    assert.equal(original.statisticsOIAbsenceAttempts, 0)
    assert.equal(original.statisticsTakerAbsenceAttempts, 0)
    assert.equal(original.statisticsOIExpiresAt, null)
    assert.equal(original.statisticsTakerExpiresAt, null)
    await f.store.appendCandles([{ instrument: query.instrument, timeframe: query.timeframe, timestamp: base,
      open: 100, high: 101, low: 99, close: 100, volume: 1, baseVolume: 1, quoteVolume: 100, confirmed: true }])
    const [price] = await f.store.candles(query)
    assert.equal(price.statisticsOIObservedAt, original.statisticsOIObservedAt)
    assert.equal(price.statisticsTakerObservedAt, original.statisticsTakerObservedAt)
    await f.store.close(); restarted = await MarketStore.open(f.root)
    for (const source of ['oi', 'taker'] as const) {
      await restarted.appendStatistics({ ...query, source, values: [], observedAt: Date.now() })
      assert.deepEqual(await restarted.statisticsMissingRanges({ ...query, source }), [])
    }
    assert.deepEqual(await restarted.statistics(query), [original])
    const [merged] = await restarted.candles(query)
    assert.deepEqual([merged.oi, merged.sell, merged.buy], [1_000, 20, 10])
  } finally { await restarted?.close(); await f.close() }
})

test('default observation times and explicit fixture expiry overrides do not admit rejected pages', async () => {
  const f = await fixture()
  try {
    const page = { ...query, through: base + step, source: 'oi' as const, values: [] }
    await assert.rejects(f.store.appendStatistics({ ...page, values: [[base, 100], [base + step, NaN]] }), /quantities/)
    await assert.rejects(f.store.appendStatistics({ ...page, observedAt: -1 }), /observation time/)
    assert.deepEqual(await f.store.statistics(page), [])
    assert.deepEqual(await f.store.statisticsMissingRanges(page), [{ from: base, through: base + step }])
    const before = Date.now()
    await f.store.appendStatistics(page)
    const after = Date.now(), rows = await f.store.statistics(page)
    for (const row of rows) {
      assert.ok(row.statisticsOIObservedAt! >= before && row.statisticsOIObservedAt! <= after)
      assert.equal(row.statisticsOIExpiresAt, row.statisticsOIObservedAt! + 6 * hour)
    }
    await f.store.appendStatistics({ ...page, expiresAt: 1 })
    assert.ok((await f.store.statistics(page)).every(row => row.statisticsOIExpiresAt === 1))
    assert.deepEqual(await f.store.statisticsMissingRanges(page), [{ from: base, through: base + step }])
    await f.store.appendStatistics({ ...page, expiresAt: null })
    assert.ok((await f.store.statistics(page)).every(row => row.statisticsOIExpiresAt === null))
    assert.deepEqual(await f.store.statisticsMissingRanges(page), [{ from: base, through: base + step }])
  } finally { await f.close() }
})

test('SQLite v1 migration retains numeric history and expires unversioned imported null proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-statistics-v1-'))
  let store: MarketStore | undefined
  try {
    const future = Date.now() + day, database = new DatabaseSync(join(root, 'market.sqlite'))
    try {
      database.exec(`CREATE TABLE series (
        id INTEGER PRIMARY KEY, instrument TEXT NOT NULL, timeframe TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, price_revision INTEGER NOT NULL DEFAULT 0,
        candle_count INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER, UNIQUE(instrument,timeframe));
        CREATE TABLE statistics (
          series_id INTEGER NOT NULL, source INTEGER NOT NULL, timestamp INTEGER NOT NULL,
          value1 REAL, value2 REAL, expires_at INTEGER, written_at INTEGER NOT NULL,
          origin INTEGER NOT NULL, import_version INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(series_id,source,timestamp)) WITHOUT ROWID;
        INSERT INTO series(id,instrument,timeframe) VALUES(1,'BTC-USDT-SWAP','5m');
        PRAGMA user_version=1;`)
      const insert = database.prepare('INSERT INTO statistics VALUES(1,?,?,?,?,?,?,?,0)')
      insert.run(1, base, 1_000, null, 1, 100, 1)
      insert.run(2, base, 20, 10, 1, 100, 0)
      insert.run(1, base + step, null, null, future, 200, 1)
      insert.run(2, base + step, null, null, future, 200, 0)
      insert.run(1, base + 2 * step, null, null, null, 200, 0)
    } finally { database.close() }
    const range = { ...query, through: base + 2 * step }
    store = await MarketStore.open(root)
    const rows = await store.statistics(range)
    assert.deepEqual([rows[0].oi, rows[0].sell, rows[0].buy], [1_000, 20, 10])
    assert.equal(rows[0].statisticsOIAbsenceAttempts, 0)
    assert.equal(rows[0].statisticsTakerAbsenceAttempts, 0)
    assert.equal(rows[1].statisticsOIExpiresAt, future)
    assert.equal(rows[1].statisticsOIObservedAt, 200)
    assert.equal(rows[1].statisticsOIAbsenceAttempts, 1)
    assert.equal(rows[1].statisticsTakerExpiresAt, null)
    assert.equal(rows[1].statisticsTakerObservedAt, 200)
    assert.equal(rows[1].statisticsTakerAbsenceAttempts, 0)
    assert.equal(rows[2].statisticsOIExpiresAt, null)
    assert.deepEqual(await store.statisticsMissingRanges({ ...range, source: 'oi' }), [{ from: base + 2 * step, through: base + 2 * step }])
    assert.deepEqual(await store.statisticsMissingRanges({ ...range, source: 'taker' }), [{ from: base + step, through: base + 2 * step }])
    await store.appendStatistics({ ...range, from: base + step, through: base + step, source: 'taker', values: [], observedAt: Date.now() })
    const [renewed] = await store.statistics({ ...range, from: base + step, through: base + step })
    assert.equal(renewed.statisticsTakerAbsenceAttempts, 1)
    await store.close(); store = await MarketStore.open(root)
    assert.deepEqual(await store.statistics({ ...range, from: base + step, through: base + step }), [renewed])
    await store.close()
    const migrated = new DatabaseSync(join(root, 'market.sqlite'))
    try { assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 3) }
    finally { migrated.close() }
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})
