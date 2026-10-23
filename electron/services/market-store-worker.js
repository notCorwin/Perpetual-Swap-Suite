import { onOperationMessage } from './worker-operations.js'
import { databaseOperation, openRecordedDatabase } from './recorded-database.js'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { CANDLE_INTERVALS, validateCandle, validateQuery } from './market-records.js'
import { statisticsMask, validTakerVolumes } from './statistics-state.js'
import { statisticsAbsenceExpiryAt } from './statistics-coverage.js'

const database = openRecordedDatabase(DatabaseSync, workerData.path, { readOnly: workerData.reader === true }, workerData.reader ? 'market-reader' : 'market-writer')
database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192;')
if (workerData.reader) database.exec('PRAGMA query_only=ON;')
else {
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
    CREATE TABLE IF NOT EXISTS replacements (
      series_id INTEGER NOT NULL, from_ts INTEGER NOT NULL, through_ts INTEGER NOT NULL,
      PRIMARY KEY(series_id,from_ts,through_ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS indicator_checkpoints (
      series_id INTEGER NOT NULL, formula TEXT NOT NULL, timestamp INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(series_id,formula,timestamp)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS migration_partitions (
      path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS import_issues (
      path TEXT PRIMARY KEY, instrument TEXT NOT NULL, timeframe TEXT NOT NULL, from_ts INTEGER NOT NULL,
      through_ts INTEGER NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL);`)
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
const toPrice = row => row && ({ timestamp: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close,
  volume: row.volume, baseVolume: row.base_volume, quoteVolume: row.quote_volume })
const mutate = (changes, series, timestamp, price = false) => {
  let change = changes.get(series.id)
  if (!change) { change = { instrument: series.instrument, timeframe: series.timeframe, from: timestamp, through: timestamp, priceFrom: null, priceThrough: null }; changes.set(series.id, change) }
  change.from = Math.min(change.from, timestamp); change.through = Math.max(change.through, timestamp)
  if (price) { change.priceFrom = Math.min(change.priceFrom ?? timestamp, timestamp); change.priceThrough = Math.max(change.priceThrough ?? timestamp, timestamp) }
}
const transaction = operation => {
  database.exec('BEGIN IMMEDIATE')
  try { const value = operation(); database.exec('COMMIT'); return value } catch (error) { database.exec('ROLLBACK'); throw error }
}
const finishMutations = (changes, imported = false) => {
  for (const [id, change] of changes) {
    run('UPDATE series SET revision=revision+1, price_revision=price_revision+? WHERE id=?', change.priceFrom === null ? 0 : 1, id)
    if (change.priceFrom !== null) run('DELETE FROM indicator_checkpoints WHERE series_id=? AND timestamp>=?', id, change.priceFrom)
    const value = get('SELECT revision,price_revision FROM series WHERE id=?', id)
    change.revision = value.revision; change.priceRevision = value.price_revision
    change.imported = imported
  }
  return [...changes.values()]
}
const refreshBounds = id => {
  const result = get('SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last FROM candles WHERE series_id=?', id)
  run('UPDATE series SET candle_count=?, first_ts=?, last_ts=? WHERE id=?', result.count, result.first, result.last, id)
}

function writeStatistic(series, source, timestamp, first, second, expiresAt, changes,
  { importing = false, importVersion = 0, preserveExistingSource = false, observedAt = importing ? importVersion : Date.now(), observeAbsence = false } = {}) {
  const previous = get('SELECT * FROM statistics WHERE series_id=? AND source=? AND timestamp=?', series.id, source, timestamp)
  if (importing && previous && (previous.origin === 1 || previous.import_version > importVersion)) return false
  if (preserveExistingSource && previous) return false
  const price = source === 2 && (first === 0 && second === 0 || previous?.value1 === 0 && previous.value2 === 0)
    ? get('SELECT volume,quote_volume FROM candles WHERE series_id=? AND timestamp=?', series.id, timestamp) : null
  const traded = price?.volume > 0 || price?.quote_volume > 0
  const absent = first === null || source === 2 && (second === null || first === 0 && second === 0 && traded)
  const previousNumeric = previous?.value1 != null && (source === 1 || previous.value2 != null
    && !(previous.value1 === 0 && previous.value2 === 0 && traded))
  // Absence is a bounded source observation, never a correction to a numeric fact.
  if (absent && previousNumeric) return false
  if (absent && previous && observedAt < previous.written_at) return false
  if (first === null && previous?.value1 === 0 && previous.value2 === 0 && traded) {
    // A fresh empty response can renew a contradicted zero placeholder's
    // unavailable proof. Merely receiving its price never renews that proof.
    first = previous.value1; second = previous.value2
  }
  const absenceAttempts = !absent ? 0 : observeAbsence ? Math.min(Number.MAX_SAFE_INTEGER, (previous?.absence_attempts ?? 0) + 1)
    : previous?.absence_attempts || 1
  expiresAt = expiresAt === undefined && absent && observeAbsence
    ? statisticsAbsenceExpiryAt(series.timeframe, timestamp, observedAt, absenceAttempts) : expiresAt ?? null
  if (previous && Object.is(previous.value1, first) && Object.is(previous.value2, second) && Object.is(previous.expires_at, expiresAt)
    && previous.absence_attempts === absenceAttempts && (!observeAbsence || !absent || previous.written_at === observedAt)) {
    if (!importing && previous.origin === 0) run('UPDATE statistics SET origin=1,import_version=0 WHERE series_id=? AND source=? AND timestamp=?', series.id, source, timestamp)
    return false
  }
  run(`INSERT INTO statistics(series_id,source,timestamp,value1,value2,expires_at,written_at,origin,import_version,absence_attempts)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(series_id,source,timestamp) DO UPDATE SET value1=excluded.value1,value2=excluded.value2,
    expires_at=excluded.expires_at,written_at=excluded.written_at,origin=excluded.origin,import_version=excluded.import_version,absence_attempts=excluded.absence_attempts`,
  series.id, source, timestamp, first, second, expiresAt, observedAt, importing ? 0 : 1, importVersion, absenceAttempts)
  mutate(changes, series, timestamp)
  return true
}

function append(rows, { importing = false, replacement, partition } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Candles must be an array.')
  rows.forEach(validateCandle)
  const changes = new Map(), seriesCache = new Map(), bounds = new Set()
  const unique = new Map(rows.map(row => [`${row.instrument}:${row.timeframe}:${row.timestamp}`, row]))
  return transaction(() => {
    if (replacement) {
      const series = ensureSeries(replacement)
      run('DELETE FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<?', series.id, replacement.from, replacement.through + CANDLE_INTERVALS[replacement.timeframe])
      run('INSERT OR IGNORE INTO replacements(series_id,from_ts,through_ts) VALUES(?,?,?)', series.id, replacement.from, replacement.through)
      run('DELETE FROM import_issues WHERE instrument=? AND timeframe=? AND from_ts>=? AND through_ts<=?', replacement.instrument, replacement.timeframe, replacement.from, replacement.through)
      mutate(changes, series, replacement.from, true); changes.get(series.id).through = replacement.through; changes.get(series.id).priceThrough = replacement.through; bounds.add(series.id)
    }
    for (const row of unique.values()) {
      const key = `${row.instrument}:${row.timeframe}`
      let series = seriesCache.get(key)
      if (!series) { series = ensureSeries(row); seriesCache.set(key, series) }
      const previous = get('SELECT * FROM candles WHERE series_id=? AND timestamp=?', series.id, row.timestamp)
      const importVersion = Number(row.writtenAt ?? 0)
      const protectedPrice = importing && (get('SELECT 1 FROM replacements WHERE series_id=? AND from_ts<=? AND through_ts>=? LIMIT 1', series.id, row.timestamp, row.timestamp)
        || previous && (previous.origin === 1 || previous.import_version > importVersion))
      const oldPrice = toPrice(previous), changed = !oldPrice || priceFields.some(field => !Object.is(oldPrice[field], row[field] ?? null))
      if (changed && !protectedPrice) {
        run(`INSERT INTO candles(series_id,timestamp,open,high,low,close,volume,base_volume,quote_volume,written_at,origin,import_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(series_id,timestamp) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
          close=excluded.close,volume=excluded.volume,base_volume=excluded.base_volume,quote_volume=excluded.quote_volume,
          written_at=excluded.written_at,origin=excluded.origin,import_version=excluded.import_version`, series.id, row.timestamp,
        row.open, row.high, row.low, row.close, row.volume, row.baseVolume ?? null, row.quoteVolume ?? null, importing ? importVersion : Date.now(), importing ? 0 : 1, importVersion)
        mutate(changes, series, row.timestamp, true)
        if (!previous) {
          run('UPDATE series SET candle_count=candle_count+1, first_ts=MIN(COALESCE(first_ts,?),?), last_ts=MAX(COALESCE(last_ts,?),?) WHERE id=?', row.timestamp, row.timestamp, row.timestamp, row.timestamp, series.id)
        }
      } else if (!importing && previous?.origin === 0) run('UPDATE candles SET origin=1,import_version=0 WHERE series_id=? AND timestamp=?', series.id, row.timestamp)
      const mask = statisticsMask(row)
      if (mask & 1 || !importing && Number.isFinite(row.oi)) writeStatistic(series, 1, row.timestamp, row.oi ?? null, null, row.statisticsOIExpiresAt ?? null, changes,
        { importing, importVersion, observedAt: row.statisticsOIObservedAt ?? (importing ? importVersion : row.writtenAt ?? (row.oi == null ? 0 : Date.now())) })
      if (mask & 2 || !importing && validTakerVolumes(row)) {
        const volumes = validTakerVolumes(row)
        writeStatistic(series, 2, row.timestamp, volumes?.sell ?? null, volumes?.buy ?? null, row.statisticsTakerExpiresAt ?? null, changes,
          { importing, importVersion, observedAt: row.statisticsTakerObservedAt ?? (importing ? importVersion : row.writtenAt ?? (volumes ? Date.now() : 0)) })
      }
    }
    for (const id of bounds) refreshBounds(id)
    if (partition) {
      run('INSERT OR REPLACE INTO migration_partitions(path,fingerprint,status,value) VALUES(?,?,?,?)', partition.path, partition.fingerprint, 'completed', JSON.stringify({ rows: rows.length }))
      run('DELETE FROM import_issues WHERE path=?', partition.path)
    }
    return { result: unique.size, mutations: finishMutations(changes, importing) }
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
  for (const value of input.values) {
    if (!Array.isArray(value) || !Number.isSafeInteger(value[0]) || value[0] % step) throw new TypeError('Statistics must follow the native period grid.')
    if (value[0] < query.from || value[0] > query.through) continue
    const amounts = value.slice(1, source === 1 ? 2 : 3)
    if (amounts.length !== (source === 1 ? 1 : 2) || amounts.some(amount => amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0))) throw new TypeError('Invalid statistics quantities.')
    observations.set(value[0], amounts)
  }
  return transaction(() => {
    const series = ensureSeries(query), changes = new Map()
    const observation = { preserveExistingSource: input.preserveExistingSource, observedAt, observeAbsence: true }
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

const takerContradiction = '(t.value1=0 AND t.value2=0 AND (c.volume>0 OR COALESCE(c.quote_volume,0)>0))'
const mergedProjection = `c.timestamp,c.open,c.high,c.low,c.close,c.volume,c.base_volume AS baseVolume,c.quote_volume AS quoteVolume,
  c.written_at AS writtenAt,o.value1 AS oi,CASE WHEN ${takerContradiction} THEN NULL ELSE t.value1 END AS sell,CASE WHEN ${takerContradiction} THEN NULL ELSE t.value2 END AS buy,
  CASE WHEN o.value1 IS NOT NULL THEN NULL ELSE o.expires_at END AS statisticsOIExpiresAt,
  CASE WHEN t.value1 IS NOT NULL AND t.value2 IS NOT NULL AND NOT ${takerContradiction} THEN NULL ELSE t.expires_at END AS statisticsTakerExpiresAt,
  o.written_at AS statisticsOIObservedAt,COALESCE(o.absence_attempts,0) AS statisticsOIAbsenceAttempts,
  t.written_at AS statisticsTakerObservedAt,COALESCE(t.absence_attempts,0) AS statisticsTakerAbsenceAttempts,
  CASE WHEN o.timestamp IS NOT NULL AND o.value1 IS NOT NULL AND t.timestamp IS NOT NULL AND t.value1 IS NOT NULL AND t.value2 IS NOT NULL AND NOT ${takerContradiction} THEN 1
    ELSE 8+CASE WHEN o.timestamp IS NULL THEN 0 ELSE 1 END+CASE WHEN t.timestamp IS NULL THEN 0 ELSE 2 END END AS statisticsVersion`
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
    value.statisticsVersion |= row.source
    if (row.source === 1) {
      value.oi = row.value1; value.statisticsOIExpiresAt = row.value1 !== null ? null : row.expires_at
      value.statisticsOIObservedAt = row.written_at; value.statisticsOIAbsenceAttempts = row.absence_attempts
    }
    else {
      const invalidZero = row.value1 === 0 && row.value2 === 0 && (row.price_volume > 0 || row.price_quote_volume > 0)
      value.sell = invalidZero ? null : row.value1; value.buy = invalidZero ? null : row.value2
      value.statisticsTakerExpiresAt = value.sell !== null && value.buy !== null ? null : row.expires_at
      value.statisticsTakerObservedAt = row.written_at; value.statisticsTakerAbsenceAttempts = row.absence_attempts
    }
    result.set(row.timestamp, value)
  }
  return [...result.values()]
}

function missingRanges(query, source = 'candles') {
  if (!['candles', 'oi', 'taker'].includes(source)) throw new TypeError('Invalid history source.')
  const valid = validateQuery(query), step = CANDLE_INTERVALS[valid.timeframe], series = identity(valid)
  const from = Math.ceil(valid.from / step) * step, through = Math.floor(valid.through / step) * step
  if (from > through) return []
  if (!series) return [{ from, through }]
  const sourceBit = source === 'oi' ? 1 : 2
  const contradicted = source === 'taker' ? ' AND NOT(value1=0 AND value2=0 AND EXISTS(SELECT 1 FROM candles c WHERE c.series_id=statistics.series_id AND c.timestamp=statistics.timestamp AND (c.volume>0 OR c.quote_volume>0)))' : ''
  const condition = source === 'candles' ? '' : ` AND source=? AND ((value1 IS NOT NULL${source === 'taker' ? ' AND value2 IS NOT NULL' : ''}${contradicted}) OR expires_at>?)`
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

const commands = {
  validateCandles: rows => { if (!Array.isArray(rows)) throw new TypeError('Candles must be an array.'); rows.forEach(validateCandle); return { result: undefined } },
  append: (rows, options) => append(rows, options), appendStatistics,
  candles: query => ({ result: candleRows(query) }), statistics: query => ({ result: statisticRows(query) }),
  candleTimestamps: query => {
    const valid = validateQuery(query), series = identity(valid)
    return { result: series ? all('SELECT timestamp FROM candles WHERE series_id=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp', series.id, valid.from, valid.through).map(row => row.timestamp) : [] }
  },
  missingRanges: (query, source) => ({ result: missingRanges(query, source) }),
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
  checkpointInvalidate: query => { validateQuery(query); const series = identity(query); if (series) run('DELETE FROM indicator_checkpoints WHERE series_id=? AND timestamp>=?', series.id, query.from); return { result: undefined } },
  migrationState: path => ({ result: get('SELECT * FROM migration_partitions WHERE path=?', path) ?? null }),
  migrationReport: () => ({ result: { complete: Boolean(get("SELECT 1 FROM migration_partitions WHERE path='__complete__'")),
    completedPartitions: get("SELECT COUNT(*) AS count FROM migration_partitions WHERE path!='__complete__' AND status='completed'").count,
    failedPartitions: get("SELECT COUNT(*) AS count FROM migration_partitions WHERE status='failed'").count,
    importedRows: get("SELECT COALESCE(SUM(json_extract(value,'$.rows')),0) AS count FROM migration_partitions WHERE status='completed' AND path!='__complete__'").count,
    issues: all('SELECT path,instrument,timeframe,from_ts AS "from",through_ts AS through,reason,detail FROM import_issues') } }),
  migrationComplete: () => { run("INSERT OR REPLACE INTO migration_partitions(path,fingerprint,status,value) VALUES('__complete__','','completed','{}')"); return { result: undefined } },
  migrationFailure: value => {
    run('INSERT OR REPLACE INTO migration_partitions(path,fingerprint,status,value) VALUES(?,?,?,?)', value.path, value.fingerprint, 'failed', JSON.stringify({ error: value.detail }))
    run('INSERT OR REPLACE INTO import_issues(path,instrument,timeframe,from_ts,through_ts,reason,detail) VALUES(?,?,?,?,?,?,?)', value.path, value.instrument, value.timeframe, value.from, value.through, value.reason ?? 'corrupt-file', value.detail)
    return { result: undefined }
  },
  inspect: query => {
    const valid = validateQuery(query), rows = candleRows(valid), gaps = missingRanges(valid), issues = []
    for (const row of rows) {
      const first = Math.floor(row.timestamp / CANDLE_INTERVALS[query.timeframe]) * CANDLE_INTERVALS[query.timeframe]
      const issue = reason => issues.push({ instrument: query.instrument, timeframe: query.timeframe, source: 'candles', from: first, through: first, reason, repairable: true })
      if (row.baseVolume == null) issue('missing-base-volume')
      if (row.quoteVolume == null) issue('missing-quote-volume')
      if (row.timestamp !== first) issue('invalid-grid')
      if (['open','high','low','close'].some(field => !Number.isFinite(row[field]) || row[field] <= 0)
        || row.high < Math.max(row.open,row.close,row.low) || row.low > Math.min(row.open,row.close,row.high)) issue('invalid-ohlc')
      if (['volume','baseVolume','quoteVolume'].some(field => row[field] !== null && (!Number.isFinite(row[field]) || row[field] < 0))) issue('negative-volume')
    }
    const failures = all('SELECT * FROM import_issues WHERE instrument=? AND timeframe=? AND from_ts<=? AND through_ts>=?', query.instrument, query.timeframe, query.through, query.from)
    for (const row of failures) issues.push({ instrument: row.instrument, timeframe: row.timeframe, source: 'candles', from: row.from_ts, through: row.through_ts, reason: row.reason, repairable: true, file: row.path, detail: row.detail })
    for (const gap of gaps) if (!failures.some(row => row.from_ts <= gap.from && row.through_ts >= gap.through)) issues.push({ instrument: query.instrument, timeframe: query.timeframe, source: 'candles', ...gap, reason: 'gap', repairable: true })
    return { result: { issues, checkedRows: rows.length, files: 1, missingRanges: gaps.filter(gap => !failures.some(row => row.from_ts <= gap.from && row.through_ts >= gap.through)) } }
  },
  integrity: () => ({ result: all('PRAGMA quick_check').map(row => row.quick_check) }),
  close: () => { if (!workerData.reader) database.exec('PRAGMA wal_checkpoint(PASSIVE)'); database.close(); return { result: undefined } },
}

onOperationMessage(parentPort, workerData.reader ? 'market-reader' : 'market-writer', ({ id, command, args }) => {
  const started = performance.now()
  try {
    if (!commands[command]) throw new Error(`Unknown market store operation: ${command}`)
    const response = databaseOperation(`market.${command}`, () => commands[command](...args), { role: workerData.reader ? 'reader' : 'writer' })
    return { id, ...response, durationMS: performance.now() - started }
  } catch (error) { return { id, error: { message: error.message, name: error.name, code: error.code } } }
}, { closeWhen: message => message.command === 'close' })
parentPort.postMessage({ ready: true })
