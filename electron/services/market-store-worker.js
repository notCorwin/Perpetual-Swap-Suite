import { closeOperationRecording } from './operation-runtime.js'
import { onOperationMessage } from './worker-operations.js'
import { databaseOperation, openRecordedDatabase } from './recorded-database.js'
import { hasOperationRecording } from './operations.js'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CANDLE_INTERVALS, validateCandle, validateQuery } from './market-records.js'
import { statisticsMask, validTakerVolumes } from './statistics-state.js'
import { statisticsAbsenceExpiryAt } from './statistics-coverage.js'
import { aggregatePriceCandles } from './candle-aggregation.js'

const database = openRecordedDatabase(DatabaseSync, workerData.path, { readOnly: workerData.reader === true }, workerData.reader ? 'market-reader' : 'market-writer')
database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192;')
if (workerData.reader) database.exec('PRAGMA query_only=ON;')
else {
  const previousVersion = database.prepare('PRAGMA user_version').get().user_version
  if (previousVersion < 4) {
    const hasTable = name => database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)
    const hasManifest = hasTable('migration_partitions')
    const failed = hasManifest && database.prepare("SELECT 1 FROM migration_partitions WHERE status='failed' LIMIT 1").get()
      || hasTable('import_issues') && database.prepare('SELECT 1 FROM import_issues LIMIT 1').get()
    const complete = hasManifest && database.prepare("SELECT 1 FROM migration_partitions WHERE path='__complete__' AND status='completed'").get()
    const incomplete = existsSync(join(dirname(workerData.path), 'candles')) && !complete
    if (failed || incomplete) {
      database.close()
      await closeOperationRecording()
      throw new Error(failed
        ? 'Legacy archive migration has unresolved failures. Resolve failed partitions using the previous app version before upgrading. Recovery details remain in market.sqlite and original archive files are unchanged.'
        : 'Legacy archive migration is incomplete. Finish the SQLite migration using the previous app version before upgrading, or use a new data directory to download history again. Original archive files are unchanged.')
    }
  }
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=2000;
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY, instrument TEXT NOT NULL, timeframe TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, price_revision INTEGER NOT NULL DEFAULT 0,
      candle_count INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER,
      UNIQUE(instrument,timeframe));
    CREATE TABLE IF NOT EXISTS candles (
      series_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
      close REAL NOT NULL, volume REAL NOT NULL, base_volume REAL, quote_volume REAL,
      written_at INTEGER NOT NULL, origin INTEGER NOT NULL, import_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(series_id,timestamp)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS statistics (
      series_id INTEGER NOT NULL, source INTEGER NOT NULL, timestamp INTEGER NOT NULL,
      value1 REAL, value2 REAL, expires_at INTEGER, written_at INTEGER NOT NULL,
      origin INTEGER NOT NULL, import_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(series_id,source,timestamp)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS indicator_checkpoints (
      series_id INTEGER NOT NULL, formula TEXT NOT NULL, timestamp INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(series_id,formula,timestamp)) WITHOUT ROWID;`)
  const version = database.prepare('PRAGMA user_version').get().user_version
  if (version < 2) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec('ALTER TABLE statistics ADD COLUMN absence_attempts INTEGER NOT NULL DEFAULT 0;')
      // Keep observation times and downloaded values. Old imported nulls lack
      // versioned absence proof and must be checked again, never leased anew.
      database.exec(`UPDATE statistics SET absence_attempts=1 WHERE origin=1 AND (value1 IS NULL OR (source=2 AND value2 IS NULL));
        UPDATE statistics SET expires_at=NULL WHERE origin=0 AND (value1 IS NULL OR (source=2 AND value2 IS NULL));
        PRAGMA user_version=2; COMMIT;`)
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  if (version < 3) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec('ALTER TABLE statistics ADD COLUMN observed_volume REAL; PRAGMA user_version=3; COMMIT;')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  // Keep inert legacy columns to avoid rewriting every historical row on upgrade.
  if (version < 4) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`DROP TABLE IF EXISTS migration_partitions;
        DROP TABLE IF EXISTS import_issues;
        DROP TABLE IF EXISTS replacements;
        PRAGMA user_version=4; COMMIT;`)
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
}

const statements = new Map()
const statement = sql => { let value = statements.get(sql); if (!value) { value = database.prepare(sql); statements.set(sql, value) } return value }
const all = (sql, ...params) => statement(sql).all(...params)
const get = (sql, ...params) => statement(sql).get(...params)
const run = (sql, ...params) => statement(sql).run(...params)
const identity = query => get('SELECT * FROM series WHERE instrument=? AND timeframe=?', query.instrument, query.timeframe)
const ensureSeries = query => {
  run('INSERT OR IGNORE INTO series(instrument,timeframe) VALUES(?,?)', query.instrument, query.timeframe)
  return identity(query)
}
const priceFields = ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume']
const DERIVED_CANDLE_ORIGIN = 2
const toPrice = row => row && ({ timestamp: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close,
  volume: row.volume, baseVolume: row.base_volume, quoteVolume: row.quote_volume })
const mutate = (changes, series, timestamp, price = false, statistic = null) => {
  let change = changes.get(series.id)
  if (!change) { change = { instrument: series.instrument, timeframe: series.timeframe, from: timestamp, through: timestamp, priceFrom: null, priceThrough: null,
    oiFrom: null, oiThrough: null, takerFrom: null, takerThrough: null }; changes.set(series.id, change) }
  change.from = Math.min(change.from, timestamp); change.through = Math.max(change.through, timestamp)
  if (price) { change.priceFrom = Math.min(change.priceFrom ?? timestamp, timestamp); change.priceThrough = Math.max(change.priceThrough ?? timestamp, timestamp) }
  if (statistic) {
    const from = `${statistic}From`, through = `${statistic}Through`
    change[from] = Math.min(change[from] ?? timestamp, timestamp); change[through] = Math.max(change[through] ?? timestamp, timestamp)
  }
}
const transaction = (operation, validate) => {
  database.exec('BEGIN IMMEDIATE')
  try { const value = operation(); validate?.(); database.exec('COMMIT'); return value } catch (error) { database.exec('ROLLBACK'); throw error }
}
const finishMutations = (changes) => {
  for (const [id, change] of changes) {
    run('UPDATE series SET revision=revision+1, price_revision=price_revision+? WHERE id=?', change.priceFrom === null ? 0 : 1, id)
    if (change.priceFrom !== null) run('DELETE FROM indicator_checkpoints WHERE series_id=? AND timestamp>=?', id, change.priceFrom)
    const value = get('SELECT revision,price_revision FROM series WHERE id=?', id)
    change.revision = value.revision; change.priceRevision = value.price_revision
  }
  return [...changes.values()]
}
const refreshBounds = id => {
  const result = get('SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM candles WHERE series_id=?', id)
  run('UPDATE series SET candle_count=?, first_ts=?, last_ts=? WHERE id=?', result.count, result.first, result.last, id)
}

function writeStatistic(series, source, timestamp, first, second, expiresAt, changes,
  { preserveExistingSource = false, observedAt = Date.now(), observeAbsence = false, observedVolume = null } = {}) {
  const previous = get('SELECT * FROM statistics WHERE series_id=? AND source=? AND timestamp=?', series.id, source, timestamp)
  const needsPrice = source === 2 && (observedVolume !== null || previous?.observed_volume != null
    || first === 0 && second === 0 || previous?.value1 === 0 && previous.value2 === 0)
  const price = needsPrice ? get('SELECT volume,quote_volume FROM candles WHERE series_id=? AND timestamp=?', series.id, timestamp) : null
  const staleDerived = previous?.observed_volume != null && (!price || previous.observed_volume !== price.volume)
  const contradictionPrice = source === 2 && (first === 0 && second === 0 || previous?.value1 === 0 && previous.value2 === 0) ? price : null
  const traded = contradictionPrice?.volume > 0 || contradictionPrice?.quote_volume > 0
  const absent = first === null || source === 2 && (second === null || first === 0 && second === 0 && traded)
  const previousNumeric = previous?.value1 != null && (source === 1 || previous.value2 != null
    && !(previous.value1 === 0 && previous.value2 === 0 && traded))
  // Local, price-bound trade totals can improve as late trades arrive even if
  // candle volume is unchanged. Preserve independently acquired source data.
  if (preserveExistingSource && previousNumeric && !staleDerived
    && (observedVolume === null || previous.observed_volume == null)) return false
  // Absence is a bounded source observation, never a correction to a numeric fact.
  if (absent && previousNumeric && !staleDerived) return false
  if (previous && observedAt < previous.written_at && (absent || previousNumeric && !staleDerived)) return false
  if (first === null && previous?.value1 === 0 && previous.value2 === 0 && traded && !staleDerived) {
    // A fresh empty response can renew a contradicted zero placeholder's
    // unavailable proof. Merely receiving its price never renews that proof.
    first = previous.value1; second = previous.value2
  }
  const absenceAttempts = !absent ? 0 : observeAbsence ? Math.min(Number.MAX_SAFE_INTEGER, (previous?.absence_attempts ?? 0) + 1)
    : previous?.absence_attempts || 1
  expiresAt = expiresAt === undefined && absent && observeAbsence
    ? statisticsAbsenceExpiryAt(series.timeframe, timestamp, observedAt, absenceAttempts) : expiresAt ?? null
  if (previous && Object.is(previous.value1, first) && Object.is(previous.value2, second) && Object.is(previous.expires_at, expiresAt)
    && Object.is(previous.observed_volume, observedVolume) && previous.absence_attempts === absenceAttempts
    && (!observeAbsence || !absent || previous.written_at === observedAt)) {
    return false
  }
  run(`INSERT INTO statistics(series_id,source,timestamp,value1,value2,expires_at,written_at,origin,absence_attempts,observed_volume)
    VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(series_id,source,timestamp) DO UPDATE SET value1=excluded.value1,value2=excluded.value2,
    expires_at=excluded.expires_at,written_at=excluded.written_at,
    absence_attempts=excluded.absence_attempts,observed_volume=excluded.observed_volume`,
  series.id, source, timestamp, first, second, expiresAt, observedAt, absenceAttempts, observedVolume)
  mutate(changes, series, timestamp, false, source === 1 ? 'oi' : 'taker')
  return true
}

function append(rows, { replacement, lifetime } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Candles must be an array.')
  rows.forEach(validateCandle)
  const changes = new Map(), seriesCache = new Map(), bounds = new Set(), additions = new Map()
  const unique = new Map(rows.map(row => [`${row.instrument}:${row.timeframe}:${row.timestamp}`, row]))
  const currentLifetime = () => {
    if (lifetime && Atomics.load(new Int32Array(lifetime.buffer), 0) !== lifetime.epoch) throw Object.assign(new Error('The instrument lifetime was removed before the price commit.'), { name: 'AbortError' })
  }
  const fence = lifetime && new Int32Array(lifetime.buffer)
  if (fence && Atomics.compareExchange(fence, 1, 0, 1) !== 0) throw new Error('A price lifetime commit is already in progress.')
  try {
  currentLifetime()
  return transaction(() => {
    if (replacement) {
      const series = ensureSeries(replacement)
      run('DELETE FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<?', series.id, replacement.from, replacement.through + CANDLE_INTERVALS[replacement.timeframe])
      mutate(changes, series, replacement.from, true); changes.get(series.id).through = replacement.through; changes.get(series.id).priceThrough = replacement.through; bounds.add(series.id)
    }
    for (const row of unique.values()) {
      const key = `${row.instrument}:${row.timeframe}`
      let series = seriesCache.get(key)
      if (!series) { series = ensureSeries(row); seriesCache.set(key, series) }
      const previous = get('SELECT * FROM candles WHERE series_id=? AND timestamp=?', series.id, row.timestamp)
      const oldPrice = toPrice(previous), changed = !oldPrice || priceFields.some(field => !Object.is(oldPrice[field], row[field] ?? null))
      if (changed) {
        run(`INSERT INTO candles(series_id,timestamp,open,high,low,close,volume,base_volume,quote_volume,written_at,origin)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(series_id,timestamp) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
          close=excluded.close,volume=excluded.volume,base_volume=excluded.base_volume,quote_volume=excluded.quote_volume,
          written_at=excluded.written_at,origin=excluded.origin`, series.id, row.timestamp,
        row.open, row.high, row.low, row.close, row.volume, row.baseVolume ?? null, row.quoteVolume ?? null, Date.now(), 1)
        mutate(changes, series, row.timestamp, true)
        if (!previous) {
          const added = additions.get(series.id)
          if (added) {
            added.count += 1
            added.first = Math.min(added.first, row.timestamp)
            added.last = Math.max(added.last, row.timestamp)
          } else additions.set(series.id, { count: 1, first: row.timestamp, last: row.timestamp })
        }
      } else if (previous?.origin !== 1) {
        run('UPDATE candles SET origin=1 WHERE series_id=? AND timestamp=?', series.id, row.timestamp)
      }
      const mask = statisticsMask(row)
      if (mask & 1 || Number.isFinite(row.oi)) writeStatistic(series, 1, row.timestamp, row.oi ?? null, null, row.statisticsOIExpiresAt ?? null, changes,
        { observedAt: row.statisticsOIObservedAt ?? (row.writtenAt ?? (row.oi == null ? 0 : Date.now())) })
      if (mask & 2 || validTakerVolumes(row)) {
        const volumes = validTakerVolumes(row)
        writeStatistic(series, 2, row.timestamp, volumes?.sell ?? null, volumes?.buy ?? null, row.statisticsTakerExpiresAt ?? null, changes,
          { observedAt: row.statisticsTakerObservedAt ?? (row.writtenAt ?? (volumes ? Date.now() : 0)) })
      }
    }
    for (const [id, added] of additions) if (!bounds.has(id)) {
      run('UPDATE series SET candle_count=candle_count+?, first_ts=MIN(COALESCE(first_ts,?),?), last_ts=MAX(COALESCE(last_ts,?),?) WHERE id=?',
        added.count, added.first, added.first, added.last, added.last, id)
    }
    for (const id of bounds) refreshBounds(id)
    return { result: unique.size, mutations: finishMutations(changes) }
  }, currentLifetime)
  } finally { if (fence) { Atomics.store(fence, 1, 0); Atomics.notify(fence, 1) } }
}

function aggregateCandles(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'from') || !Object.hasOwn(input, 'through')) {
    throw new TypeError('Candle aggregation requires an explicit parent range.')
  }
  const query = validateQuery(input), targetStep = CANDLE_INTERVALS[query.timeframe], childStep = CANDLE_INTERVALS['5m']
  if (!['15m', '1H'].includes(query.timeframe) || query.from % targetStep || query.through % targetStep
    || input.invalidateIncomplete !== undefined && typeof input.invalidateIncomplete !== 'boolean') {
    throw new TypeError('Invalid candle aggregation range.')
  }
  const invalidateIncomplete = input.invalidateIncomplete === true
  const childThrough = Math.min(Number.MAX_SAFE_INTEGER, query.through + targetStep - childStep)

  return transaction(() => {
    const sourceSeries = identity({ instrument: query.instrument, timeframe: '5m' })
    const sourceRows = sourceSeries
      ? all(`SELECT timestamp,open,high,low,close,volume,base_volume AS baseVolume,quote_volume AS quoteVolume
        FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp`,
      sourceSeries.id, query.from, childThrough)
      : []
    const childrenByParent = new Map()
    for (const row of sourceRows) {
      const timestamp = Math.floor(row.timestamp / targetStep) * targetStep
      const children = childrenByParent.get(timestamp) ?? []
      children.push(row)
      childrenByParent.set(timestamp, children)
    }

    const aggregates = new Map()
    for (const [timestamp, children] of childrenByParent) {
      const aggregate = aggregatePriceCandles(children.map(child => ({
        ...child, instrument: query.instrument, timeframe: '5m', confirmed: true,
      })), query.timeframe)
      if (aggregate) aggregates.set(timestamp, aggregate)
    }

    let series = identity(query)
    if (!series && aggregates.size) series = ensureSeries(query)
    const existing = series
      ? new Map(all(`SELECT timestamp,open,high,low,close,volume,base_volume,quote_volume,origin
        FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<=?`, series.id, query.from, query.through)
        .map(row => [row.timestamp, row]))
      : new Map()
    const changes = new Map()
    let changed = 0, invalidated = 0, added = 0, firstAdded = null, lastAdded = null
    let deletedFirst = false, deletedLast = false

    for (let timestamp = query.from; timestamp <= query.through; timestamp += targetStep) {
      const aggregate = aggregates.get(timestamp), previous = existing.get(timestamp)
      if (aggregate) {
        // Default gap fills keep native history. Explicit invalidation on a
        // changed-child range allows a complete canonical aggregate to replace it.
        if (previous && previous.origin !== DERIVED_CANDLE_ORIGIN && !invalidateIncomplete) continue
        const oldPrice = toPrice(previous)
        const priceChanged = !oldPrice || priceFields.some(field => !Object.is(oldPrice[field], aggregate[field] ?? null))
        if (!priceChanged) continue
        run(`INSERT INTO candles(series_id,timestamp,open,high,low,close,volume,base_volume,quote_volume,written_at,origin)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(series_id,timestamp) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
          close=excluded.close,volume=excluded.volume,base_volume=excluded.base_volume,quote_volume=excluded.quote_volume,
          written_at=excluded.written_at,origin=excluded.origin`,
        series.id, timestamp, aggregate.open, aggregate.high, aggregate.low, aggregate.close, aggregate.volume, aggregate.baseVolume,
        aggregate.quoteVolume, Date.now(), DERIVED_CANDLE_ORIGIN)
        if (!previous) {
          added += 1
          firstAdded = Math.min(firstAdded ?? timestamp, timestamp)
          lastAdded = Math.max(lastAdded ?? timestamp, timestamp)
        }
        mutate(changes, series, timestamp, true)
        changed += 1
      } else if (invalidateIncomplete && previous?.origin === DERIVED_CANDLE_ORIGIN) {
        run('DELETE FROM candles WHERE series_id=? AND timestamp=?', series.id, timestamp)
        deletedFirst ||= timestamp === series.first_ts
        deletedLast ||= timestamp === series.last_ts
        mutate(changes, series, timestamp, true)
        changed += 1
        invalidated += 1
      }
    }
    if (added || invalidated) {
      // Check removed endpoints after all inserts and deletes, so a mixed batch
      // observes the final transaction state. Both lookups use the series key.
      const first = deletedFirst ? get('SELECT timestamp FROM candles WHERE series_id=? ORDER BY timestamp LIMIT 1', series.id)?.timestamp ?? null
        : firstAdded === null ? series.first_ts : Math.min(series.first_ts ?? firstAdded, firstAdded)
      const last = deletedLast ? get('SELECT timestamp FROM candles WHERE series_id=? ORDER BY timestamp DESC LIMIT 1', series.id)?.timestamp ?? null
        : lastAdded === null ? series.last_ts : Math.max(series.last_ts ?? lastAdded, lastAdded)
      run('UPDATE series SET candle_count=candle_count+?, first_ts=?, last_ts=? WHERE id=?', added - invalidated, first, last, series.id)
    }
    return { result: { changed, complete: aggregates.size, invalidated }, mutations: finishMutations(changes) }
  })
}

function appendStatistics(input) {
  const query = validateQuery(input), step = CANDLE_INTERVALS[query.timeframe]
  if (!['oi', 'taker'].includes(input.source) || query.from % step || query.through % step || !Array.isArray(input.values)
    || query.through - query.from > 65_535 * step) throw new TypeError('Invalid statistics page.')
  if (input.expiresAt != null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)) throw new TypeError('Invalid statistics expiry.')
  const observedAt = input.observedAt ?? Date.now()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TypeError('Invalid statistics observation time.')
  const source = input.source === 'oi' ? 1 : 2, observations = new Map()
  const hasPriceVolume = input.priceVolume !== undefined
  if (hasPriceVolume && (source !== 2 || query.from !== query.through || typeof input.priceVolume !== 'number'
    || !Number.isFinite(input.priceVolume) || input.priceVolume < 0)) throw new TypeError('Price-bound statistics require one Taker timestamp and a valid candle volume.')
  for (const value of input.values) {
    if (!Array.isArray(value) || !Number.isSafeInteger(value[0]) || value[0] % step) throw new TypeError('Statistics must follow the native period grid.')
    if (value[0] < query.from || value[0] > query.through) continue
    const amounts = value.slice(1, source === 1 ? 2 : 3)
    if (amounts.length !== (source === 1 ? 1 : 2) || amounts.some(amount => amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0))) throw new TypeError('Invalid statistics quantities.')
    observations.set(value[0], amounts)
  }
  if (hasPriceVolume) {
    const volumes = observations.get(query.from), total = volumes?.[0] + volumes?.[1]
    if (!volumes || volumes.some(amount => amount === null) || !Number.isFinite(total)
      || Math.abs(total - input.priceVolume) > Math.max(1e-8, input.priceVolume * 1e-10)) {
      throw new TypeError('Price-bound Taker volumes must reconcile to the candle volume.')
    }
  }
  return transaction(() => {
    let series = identity(query)
    if (hasPriceVolume) {
      const price = series && get('SELECT volume FROM candles WHERE series_id=? AND timestamp=?', series.id, query.from)
      if (!price || price.volume !== input.priceVolume) return { result: 0, mutations: [] }
    }
    series ??= ensureSeries(query)
    const changes = new Map()
    const observation = { preserveExistingSource: input.preserveExistingSource, observedAt, observeAbsence: true,
      observedVolume: hasPriceVolume ? input.priceVolume : null }
    let count = 0
    for (let timestamp = query.from; timestamp <= query.through; timestamp += step) {
      const values = observations.get(timestamp), first = values?.[0] ?? null, second = source === 1 ? null : values?.[1] ?? null
      if (source === 2 && (first === null || second === null)) {
        if (writeStatistic(series, source, timestamp, null, null, input.expiresAt, changes, observation)) count += 1
      } else if (writeStatistic(series, source, timestamp, first, second, input.expiresAt, changes, observation)) count += 1
    }
    return { result: count, mutations: finishMutations(changes) }
  })
}

const takerStale = '(t.observed_volume IS NOT NULL AND (c.volume IS NULL OR t.observed_volume<>c.volume))'
const takerContradiction = '(t.value1=0 AND t.value2=0 AND (c.volume>0 OR COALESCE(c.quote_volume,0)>0))'
const takerInvalid = `(${takerStale} OR ${takerContradiction})`
const mergedProjection = `c.timestamp,c.open,c.high,c.low,c.close,c.volume,c.base_volume AS baseVolume,c.quote_volume AS quoteVolume,
  c.written_at AS writtenAt,o.value1 AS oi,CASE WHEN ${takerInvalid} THEN NULL ELSE t.value1 END AS sell,CASE WHEN ${takerInvalid} THEN NULL ELSE t.value2 END AS buy,
  CASE WHEN o.value1 IS NOT NULL THEN NULL ELSE o.expires_at END AS statisticsOIExpiresAt,
  CASE WHEN ${takerStale} THEN NULL WHEN t.value1 IS NOT NULL AND t.value2 IS NOT NULL AND NOT ${takerContradiction} THEN NULL ELSE t.expires_at END AS statisticsTakerExpiresAt,
  o.written_at AS statisticsOIObservedAt,COALESCE(o.absence_attempts,0) AS statisticsOIAbsenceAttempts,
  CASE WHEN ${takerStale} THEN NULL ELSE t.written_at END AS statisticsTakerObservedAt,
  CASE WHEN ${takerStale} THEN 0 ELSE COALESCE(t.absence_attempts,0) END AS statisticsTakerAbsenceAttempts,
  8+CASE WHEN o.timestamp IS NULL THEN 0 ELSE 1 END+CASE WHEN t.timestamp IS NULL OR ${takerStale} THEN 0 ELSE 2 END AS statisticsVersion`
const mergedJoins = 'LEFT JOIN statistics o ON o.series_id=c.series_id AND o.source=1 AND o.timestamp=c.timestamp LEFT JOIN statistics t ON t.series_id=c.series_id AND t.source=2 AND t.timestamp=c.timestamp'
const candleRows = query => {
  const valid = validateQuery(query), series = identity(valid)
  if (!series) return []
  return all(`SELECT ${mergedProjection} FROM candles c ${mergedJoins} WHERE c.series_id=? AND c.timestamp>=? AND c.timestamp<=? ORDER BY c.timestamp ${valid.order === 'desc' ? 'DESC' : 'ASC'}${valid.limit ? ' LIMIT ?' : ''}`,
    series.id, valid.from, valid.through, ...(valid.limit ? [valid.limit] : [])).map(row => ({ instrument: query.instrument, timeframe: query.timeframe, ...row, confirmed: true }))
}
const statisticRows = query => {
  if (query.source !== undefined && !['oi', 'taker'].includes(query.source)) throw new TypeError('Invalid statistics source.')
  const valid = validateQuery(query), series = identity(valid)
  if (!series) return []
  const source = query.source === 'oi' ? 1 : query.source === 'taker' ? 2 : null
  const rows = all(`SELECT s.*,c.volume AS price_volume,c.quote_volume AS price_quote_volume FROM statistics s LEFT JOIN candles c ON c.series_id=s.series_id AND c.timestamp=s.timestamp
    WHERE s.series_id=? AND s.source ${source ? '=?' : 'IN (1,2)'} AND s.timestamp>=? AND s.timestamp<=? ORDER BY s.timestamp`, series.id, ...(source ? [source] : []), valid.from, valid.through)
  const result = new Map()
  for (const row of rows) {
    const value = result.get(row.timestamp) ?? { instrument: query.instrument, timeframe: query.timeframe, timestamp: row.timestamp, oi: null, sell: null, buy: null, statisticsVersion: 8,
      statisticsOIExpiresAt: null, statisticsTakerExpiresAt: null, statisticsOIObservedAt: null, statisticsTakerObservedAt: null, statisticsOIAbsenceAttempts: 0, statisticsTakerAbsenceAttempts: 0 }
    if (row.source === 1) {
      value.statisticsVersion |= row.source
      value.oi = row.value1; value.statisticsOIExpiresAt = row.value1 !== null ? null : row.expires_at
      value.statisticsOIObservedAt = row.written_at; value.statisticsOIAbsenceAttempts = row.absence_attempts
    }
    else {
      const staleDerived = row.observed_volume !== null && (row.price_volume == null || row.observed_volume !== row.price_volume)
      if (!staleDerived) value.statisticsVersion |= row.source
      const invalidZero = row.value1 === 0 && row.value2 === 0 && (row.price_volume > 0 || row.price_quote_volume > 0)
      value.sell = staleDerived || invalidZero ? null : row.value1; value.buy = staleDerived || invalidZero ? null : row.value2
      value.statisticsTakerExpiresAt = staleDerived ? null : value.sell !== null && value.buy !== null ? null : row.expires_at
      value.statisticsTakerObservedAt = staleDerived ? null : row.written_at
      value.statisticsTakerAbsenceAttempts = staleDerived ? 0 : row.absence_attempts
    }
    result.set(row.timestamp, value)
  }
  return [...result.values()]
}

// Return coverage facts from one SQLite read. Classify absence leases only
// after the worker response, including its queueing and transfer time.
function statisticsCoverage(query) {
  const valid = validateQuery(query), source = query.source, step = CANDLE_INTERVALS[valid.timeframe]
  if (!['oi', 'taker'].includes(source) || valid.from % step || valid.through % step) throw new TypeError('Invalid statistics coverage range.')
  const bit = source === 'oi' ? 1 : 2, rows = statisticRows(query), gaps = [], expiries = []
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  let next = valid.from
  const addGap = (from, through) => {
    if (from > through) return
    const previous = gaps.at(-1)
    if (previous && previous.through + step === from) previous.through = through
    else gaps.push({ from, through })
  }
  const addExpiry = row => {
    const expiresAt = Number(source === 'oi' ? row.statisticsOIExpiresAt : row.statisticsTakerExpiresAt), timestamp = row.timestamp
    const previous = expiries.at(-1)
    if (previous && Object.is(previous.expiresAt, expiresAt) && previous.through + step === timestamp) previous.through = timestamp
    else expiries.push({ from: timestamp, through: timestamp, expiresAt })
  }
  for (const row of rows) {
    const timestamp = row.timestamp, mask = statisticsMask(row)
    const numeric = source === 'oi' ? nonnegative(row.oi) : validTakerVolumes(row)
    if ((timestamp - valid.from) % step !== 0) {
      // Preserve the existing validation of non-grid leased legacy data.
      if ((mask & bit) && !numeric) addExpiry(row)
      continue
    }
    addGap(next, timestamp - step)
    next = timestamp + step
    if (!(mask & bit)) addGap(timestamp, timestamp)
    else if (!numeric) addExpiry(row)
  }
  addGap(next, valid.through)
  return { gaps, expiries }
}

function missingRanges(query, source = 'candles', verify = false) {
  if (!['candles', 'oi', 'taker'].includes(source)) throw new TypeError('Invalid history source.')
  const valid = validateQuery(query), step = CANDLE_INTERVALS[valid.timeframe], series = identity(valid)
  const from = Math.ceil(valid.from / step) * step, through = Math.floor(valid.through / step) * step
  if (from > through) return []
  if (!series) return [{ from, through }]
  // A series' bounds and count commit atomically with its unique, on-grid
  // candles. Equality proves every slot in the series exists, so a contained
  // range needs no scan. Audits deliberately inspect the facts themselves.
  if (!verify && source === 'candles' && series.first_ts !== null && series.last_ts !== null
    && from >= series.first_ts && through <= series.last_ts
    && series.candle_count === (series.last_ts - series.first_ts) / step + 1) return []
  const sourceBit = source === 'oi' ? 1 : 2
  const contradicted = source === 'taker' ? ' AND NOT(value1=0 AND value2=0 AND EXISTS(SELECT 1 FROM candles c WHERE c.series_id=statistics.series_id AND c.timestamp=statistics.timestamp AND (c.volume>0 OR c.quote_volume>0)))' : ''
  const staleDerived = source === 'taker' ? ' AND (observed_volume IS NULL OR EXISTS(SELECT 1 FROM candles c WHERE c.series_id=statistics.series_id AND c.timestamp=statistics.timestamp AND c.volume=statistics.observed_volume))' : ''
  const condition = source === 'candles' ? '' : ` AND source=?${staleDerived} AND ((value1 IS NOT NULL${source === 'taker' ? ' AND value2 IS NOT NULL' : ''}${contradicted}) OR expires_at>?)`
  const table = source === 'candles' ? 'candles' : 'statistics'
  const now = Date.now()
  const values = all(`WITH present AS (SELECT timestamp,LAG(timestamp,1,?) OVER(ORDER BY timestamp) AS previous FROM ${table}
    WHERE series_id=? AND timestamp>=? AND timestamp<=?${condition}) SELECT previous+? AS "from",timestamp-? AS through FROM present WHERE timestamp-previous>?`,
    from - step, series.id, from, through, ...(source === 'candles' ? [] : [sourceBit, now]), step, step, step)
  const last = get(`SELECT MAX(timestamp) AS timestamp FROM ${table} WHERE series_id=? AND timestamp>=? AND timestamp<=?${condition}`, series.id, from, through, ...(source === 'candles' ? [] : [sourceBit, now]))?.timestamp
  if (last == null) return [{ from, through }]
  if (last < through) values.push({ from: last + step, through })
  return values
}

function missingCompletePriceRanges(query) {
  const valid = validateQuery(query), step = CANDLE_INTERVALS[valid.timeframe], series = identity(valid)
  const from = Math.ceil(valid.from / step) * step, through = Math.floor(valid.through / step) * step
  if (from > through) return []
  if (!series) return [{ from, through }]
  // The sentinel closes the last gap in the same SQLite snapshot as every
  // other gap. Old files can contain non-grid rows or missing volume units.
  return all(`WITH present(timestamp) AS (
      SELECT timestamp FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<=?
        AND typeof(timestamp)='integer' AND timestamp%?=0
        AND typeof(base_volume) IN ('integer','real') AND base_volume>=0 AND base_volume<=1.7976931348623157e308
        AND typeof(quote_volume) IN ('integer','real') AND quote_volume>=0 AND quote_volume<=1.7976931348623157e308
      UNION ALL SELECT ?+?
    ), spans AS (
      SELECT timestamp,LAG(timestamp,1,?) OVER(ORDER BY timestamp) AS previous FROM present
    ) SELECT previous+? AS "from",timestamp-? AS through FROM spans WHERE timestamp-previous>? ORDER BY "from"`,
  series.id, from, through, step, through, step, from - step, step, step, step)
}

const commands = {
  validateCandles: rows => { if (!Array.isArray(rows)) throw new TypeError('Candles must be an array.'); rows.forEach(validateCandle); return { result: undefined } },
  append: (rows, options) => append(rows, options), appendStatistics, aggregateCandles,
  candles: query => ({ result: candleRows(query) }), statistics: query => ({ result: statisticRows(query) }),
  statisticsCoverage: query => ({ result: statisticsCoverage(query) }),
  missingRanges: (query, source) => ({ result: missingRanges(query, source) }),
  missingCompletePriceRanges: query => ({ result: missingCompletePriceRanges(query) }),
  coverage: query => { validateQuery(query); const value = identity(query); return { result: { count: value?.candle_count ?? 0, first: value?.first_ts ?? null, last: value?.last_ts ?? null } } },
  watermark: (query, priceOnly) => { validateQuery(query); const value = identity(query); return { result: `sqlite:${value?.id ?? 0}:${priceOnly ? value?.price_revision ?? 0 : value?.revision ?? 0}` } },
  checkpointRead: query => {
    validateQuery(query); const series = identity(query)
    if (!Number.isSafeInteger(query.before) || typeof query.formulaVersion !== 'string') throw new TypeError('Invalid indicator checkpoint query.')
    const row = series && get('SELECT value FROM indicator_checkpoints WHERE series_id=? AND formula=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1', series.id, query.formulaVersion, query.before)
    return { result: row ? JSON.parse(row.value) : null }
  },
  checkpointWrite: query => {
    validateQuery(query)
    if (!Number.isSafeInteger(query.timestamp) || query.timestamp < 0 || query.timestamp % CANDLE_INTERVALS[query.timeframe] || typeof query.formulaVersion !== 'string' || !query.state) throw new TypeError('Invalid indicator checkpoint.')
    const series = ensureSeries(query), watermark = `sqlite:${series.id}:${series.price_revision}`
    if (query.sourceRevision !== watermark && query.sourceRevision !== series.price_revision) return { result: false }
    const value = { timestamp: query.timestamp, state: query.state, formulaVersion: query.formulaVersion, sourceRevision: query.sourceRevision, ...(query.bollExpansion !== undefined ? { bollExpansion: query.bollExpansion } : {}) }
    const encoded = JSON.stringify(value, (_key, child) => { if (typeof child === 'number' && !Number.isFinite(child)) throw new TypeError('Indicator checkpoints require finite numbers.'); return child })
    run('INSERT OR REPLACE INTO indicator_checkpoints(series_id,formula,timestamp,value) VALUES(?,?,?,?)', series.id, query.formulaVersion, query.timestamp, encoded)
    return { result: true }
  },
  inspect: query => {
    const valid = validateQuery(query), series = identity(valid), gaps = missingRanges(valid, 'candles', true), issues = []
    let checkedRows = 0
    const rows = series ? statement(`SELECT timestamp,open,high,low,close,volume,base_volume AS baseVolume,quote_volume AS quoteVolume FROM candles
      WHERE series_id=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ${valid.order === 'desc' ? 'DESC' : 'ASC'}${valid.limit ? ' LIMIT ?' : ''}`)
      .iterate(series.id, valid.from, valid.through, ...(valid.limit ? [valid.limit] : [])) : []
    for (const row of rows) {
      checkedRows++
      const first = Math.floor(row.timestamp / CANDLE_INTERVALS[query.timeframe]) * CANDLE_INTERVALS[query.timeframe]
      const issue = reason => issues.push({ instrument: query.instrument, timeframe: query.timeframe, source: 'candles', from: first, through: first, reason, repairable: true })
      if (row.baseVolume == null) issue('missing-base-volume')
      if (row.quoteVolume == null) issue('missing-quote-volume')
      if (row.timestamp !== first) issue('invalid-grid')
      if (['open','high','low','close'].some(field => !Number.isFinite(row[field]) || row[field] <= 0)
        || row.high < Math.max(row.open,row.close,row.low) || row.low > Math.min(row.open,row.close,row.high)) issue('invalid-ohlc')
      if (['volume','baseVolume','quoteVolume'].some(field => row[field] !== null && (!Number.isFinite(row[field]) || row[field] < 0))) issue('negative-volume')
    }
    for (const gap of gaps) issues.push({ instrument: query.instrument, timeframe: query.timeframe, source: 'candles', ...gap, reason: 'gap', repairable: true })
    return { result: { issues, checkedRows, files: 1, missingRanges: gaps } }
  },
  integrity: () => ({ result: all('PRAGMA quick_check').map(row => row.quick_check) }),
  close: () => { if (!workerData.reader) database.exec('PRAGMA wal_checkpoint(PASSIVE)'); database.close(); return { result: undefined } },
}

onOperationMessage(parentPort, workerData.reader ? 'market-reader' : 'market-writer', ({ id, command, args }) => {
  const recording = hasOperationRecording(), started = recording ? performance.now() : undefined
  try {
    if (!commands[command]) throw new Error(`Unknown market store operation: ${command}`)
    const response = recording
      ? databaseOperation(`market.${command}`, () => commands[command](...args), { role: workerData.reader ? 'reader' : 'writer' })
      : commands[command](...args)
    return { id, ...response, ...(recording ? { durationMS: performance.now() - started } : {}) }
  } catch (error) { return { id, error: { message: error.message, name: error.name, code: error.code } } }
}, { closeWhen: message => message.command === 'close' })
parentPort.postMessage({ ready: true })
