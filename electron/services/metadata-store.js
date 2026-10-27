import { openRecordedDatabase } from './recorded-database.js'
import { DEFAULT_PREFERENCES, validatePreferenceFields, validatePreferences } from './preferences.js'
export { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js'

const AUDIT_STATUSES = new Set(['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'])

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object.`)
}

function keys(value, allowed, label) {
  object(value, label)
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label} contains an unknown field.`)
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer.`)
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) throw new TypeError(`${label} must be a nonempty identifier.`)
}

function merge(current, patch) {
  const result = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(current[key] ?? {}, value) : value
  }
  return result
}

function jsonCopy(value) {
  const seen = new Set()
  function visit(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number' && Number.isFinite(current)) return
    if (typeof current !== 'object') throw new TypeError('Metadata must contain only JSON values.')
    if (seen.has(current)) throw new TypeError('Metadata must not contain cycles.')
    if (!Array.isArray(current)) object(current, 'Metadata')
    seen.add(current)
    for (const [key, child] of Object.entries(current)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Metadata contains a reserved field.')
      visit(child)
    }
    seen.delete(current)
  }
  visit(value)
  return JSON.parse(JSON.stringify(value))
}

function validateAnalysis(value) {
  object(value, 'Analysis settings')
  for (const field of ['model', 'apiKey']) if (Object.hasOwn(value, field) && typeof value[field] !== 'string') throw new TypeError('Analysis settings contain an invalid credential or model field.')
  return jsonCopy(value)
}

function validateRanges(value) {
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, 'from') || Object.hasOwn(value, 'through')) {
    // A corrupt file can have an unknown range. Keep that explicit, never zero.
    if (value.from !== null || value.through !== null) {
      integer(value.from, 'Range from'); integer(value.through, 'Range through')
      if (value.through < value.from) throw new TypeError('Range through must not precede from.')
    }
  }
  for (const child of Object.values(value)) if (child && typeof child === 'object') validateRanges(child)
}

function validateAudit(value) {
  const copy = jsonCopy(value)
  object(copy, 'Audit')
  identifier(copy.id, 'Job id')
  if (Object.hasOwn(copy, 'schemaVersion') && copy.schemaVersion !== 1) throw new TypeError('Unsupported metadata schema version.')
  if (!AUDIT_STATUSES.has(copy.status)) throw new TypeError('Invalid audit status.')
  if (Object.hasOwn(copy, 'phase') && !['inspect', 'repair', 'verify'].includes(copy.phase)) throw new TypeError('Invalid audit phase.')
  for (const field of ['createdAt', 'updatedAt', 'completedAt', 'nextAttemptAt', 'attempts', 'writtenRecords', 'checkedRows', 'checkedFiles', 'files', 'verificationCheckedRows', 'verificationFiles', 'repairIndex', 'verifyIndex']) {
    if (Object.hasOwn(copy, field) && copy[field] !== null) integer(copy[field], field)
  }
  // Audit issues may describe an invalid grid or timeframe; do not reject the
  // evidence that an audit is required to report.
  validateRanges(copy)
  return copy
}

function validateCatalog(value) {
  const copy = jsonCopy(value)
  object(copy, 'Catalog entry'); identifier(copy.instrumentID, 'Catalog instrumentID')
  if (!['verified', 'failed', 'unknown'].includes(copy.status)) throw new TypeError('Invalid catalog status.')
  integer(copy.observedAt, 'Catalog observedAt'); integer(copy.expiresAt, 'Catalog expiresAt'); integer(copy.preferencesRevision, 'Catalog preferencesRevision')
  if (copy.expiresAt < copy.observedAt) throw new TypeError('Catalog expiresAt must not precede observedAt.')
  if (Object.hasOwn(copy, 'schemaVersion') && copy.schemaVersion !== 1) throw new TypeError('Unsupported catalog schema version.')
  return copy
}

export class SettingsRevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Settings revision conflict: expected ${expectedRevision}, current ${actualRevision}.`)
    this.name = 'SettingsRevisionConflictError'
    this.code = 'SETTINGS_REVISION_CONFLICT'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export class MetadataStore {
  #database
  #closed = false

  static async open(root, options = {}) {
    identifier(root, 'Metadata root')
    const [{ DatabaseSync }, { mkdir, readFile, chmod }, { join }] = await Promise.all([import('node:sqlite'), import('node:fs/promises'), import('node:path')])
    await mkdir(root, { recursive: true })
    const path = join(root, 'metadata.sqlite')
    const database = openRecordedDatabase(DatabaseSync, path, undefined, 'metadata')
    const store = new MetadataStore(database)
    try {
      await chmod(path, 0o600)
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = database.prepare('PRAGMA user_version').get().user_version
      if (![0, 1, 2].includes(version)) throw new Error('Unsupported metadata database schema version.')
      if (version < 2) store.#transaction(() => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0), preferences TEXT NOT NULL CHECK (json_valid(preferences)));
          CREATE TABLE IF NOT EXISTS analysis_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL CHECK (json_valid(value)));
          CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)));
          CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)));
          CREATE TABLE IF NOT EXISTS history_download (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)));
          CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)));
          DROP TABLE IF EXISTS sync_tasks;
          PRAGMA user_version = 2;
        `)
        database.prepare('INSERT OR IGNORE INTO settings (id, revision, preferences) VALUES (1, 0, ?)').run(JSON.stringify(DEFAULT_PREFERENCES))
        database.prepare('INSERT OR IGNORE INTO analysis_settings (id, value) VALUES (1, ?)').run('{}')
      })
      if (!database.prepare('SELECT 1 FROM migrations WHERE id = ?').get('legacy-settings-v1')) {
        let legacy
        try {
          const content = await readFile(options.legacySettingsPath ?? join(root, 'settings.json'), 'utf8')
          try { legacy = JSON.parse(content) }
          catch { throw new Error('Legacy settings contain invalid JSON. The original file was preserved.') }
        }
        catch (error) {
          if (error?.code !== 'ENOENT') throw new Error('Legacy settings could not be imported. The original file was preserved.')
        }
        store.#importLegacy(legacy)
      }
      store.getSettings() // Validate persisted data on every open, not just writes.
      store.getAnalysisSettings()
      return store
    } catch (error) { store.close(); throw error }
  }

  constructor(database) { this.#database = database }

  #assertOpen() { if (this.#closed) throw new Error('Metadata store is closed.') }

  #transaction(operation) {
    this.#assertOpen()
    this.#database.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.#database.exec('COMMIT'); return result }
    catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #importLegacy(legacy) {
    this.#transaction(() => {
      if (this.#database.prepare('SELECT 1 FROM migrations WHERE id = ?').get('legacy-settings-v1')) return
      if (legacy !== undefined) {
        object(legacy, 'Legacy settings')
        const patch = Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).filter(key => Object.hasOwn(legacy, key)).map(key => [key, legacy[key]]))
        if (Object.hasOwn(legacy, 'preferences')) { validatePreferenceFields(legacy.preferences, true); Object.assign(patch, legacy.preferences) }
        if (Object.hasOwn(legacy, 'hourlyVolumeStabilityEnabled') && !patch.liquidity?.volumeStability) {
          patch.liquidity = merge(patch.liquidity ?? {}, { volumeStability: { enabled: legacy.hourlyVolumeStabilityEnabled } })
        }
        validatePreferenceFields(patch, true)
        const current = this.getSettings()
        const preferences = validatePreferences(merge(current.preferences, patch))
        this.#database.prepare('UPDATE settings SET revision = ?, preferences = ? WHERE id = 1').run(current.revision + 1, JSON.stringify(preferences))
        if (Object.hasOwn(legacy, 'analysis')) this.#database.prepare('UPDATE analysis_settings SET value = ? WHERE id = 1').run(JSON.stringify(validateAnalysis(legacy.analysis)))
      }
      this.#database.prepare('INSERT INTO migrations (id, value) VALUES (?, ?)').run('legacy-settings-v1', JSON.stringify({ schemaVersion: 1, imported: legacy !== undefined }))
    })
  }

  getSettings() {
    this.#assertOpen()
    const row = this.#database.prepare('SELECT revision, preferences FROM settings WHERE id = 1').get()
    integer(row.revision, 'Settings revision')
    return { schemaVersion: 1, revision: row.revision, preferences: validatePreferences(JSON.parse(row.preferences)) }
  }

  updateSettings(patch, options = {}) {
    validatePreferenceFields(patch, true)
    keys(options, ['expectedRevision'], 'Settings update options')
    if (Object.hasOwn(options, 'expectedRevision')) integer(options.expectedRevision, 'expectedRevision')
    return this.#transaction(() => {
      const current = this.getSettings()
      if (Object.hasOwn(options, 'expectedRevision') && options.expectedRevision !== current.revision) throw new SettingsRevisionConflictError(options.expectedRevision, current.revision)
      const preferences = validatePreferences(merge(current.preferences, patch))
      if (JSON.stringify(preferences) === JSON.stringify(current.preferences)) return current
      const revision = current.revision + 1
      integer(revision, 'Settings revision')
      this.#database.prepare('UPDATE settings SET revision = ?, preferences = ? WHERE id = 1').run(revision, JSON.stringify(preferences))
      return { schemaVersion: 1, revision, preferences }
    })
  }

  // Main-process credential access only. Never include this object in desktop IPC.
  getAnalysisSettings() {
    this.#assertOpen()
    return validateAnalysis(JSON.parse(this.#database.prepare('SELECT value FROM analysis_settings WHERE id = 1').get().value))
  }

  updateAnalysisSettings(patch) {
    validateAnalysis(patch)
    return this.#transaction(() => {
      const next = validateAnalysis(merge(this.getAnalysisSettings(), patch))
      this.#database.prepare('UPDATE analysis_settings SET value = ? WHERE id = 1').run(JSON.stringify(next))
      return next
    })
  }

  #put(table, id, value) {
    this.#assertOpen()
    this.#database.prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value`).run(id, JSON.stringify(value))
    return value
  }

  #get(table, id) {
    this.#assertOpen(); identifier(id, 'Metadata id')
    const row = this.#database.prepare(`SELECT value FROM ${table} WHERE id = ?`).get(id)
    return row ? JSON.parse(row.value) : null
  }

  #list(table) {
    this.#assertOpen()
    return this.#database.prepare(`SELECT value FROM ${table} ORDER BY id`).all().map(row => JSON.parse(row.value))
  }

  #delete(table, id) {
    this.#assertOpen(); identifier(id, 'Metadata id')
    return this.#database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0
  }

  saveAudit(audit) { const value = validateAudit(audit); return this.#put('audits', value.id, value) }
  getAudit(id) { const value = this.#get('audits', id); return value && validateAudit(value) }
  listAudits() { return this.#list('audits').map(validateAudit) }
  getHistoryDownload() { return this.#get('history_download', 'latest') }
  saveHistoryDownload(report) { return this.#put('history_download', 'latest', structuredClone(report)) }
  putCatalogEntry(entry) { const value = validateCatalog(entry); return this.#put('catalog', value.instrumentID, value) }
  saveCatalogRankings(entries) {
    this.#assertOpen()
    if (!Array.isArray(entries)) throw new TypeError('Catalog rankings must be an array.')
    const values = entries.map(entry => {
      keys(entry, ['instrumentID', 'lookback', 'rankingChange', 'rankingAsOf'], 'Catalog ranking')
      identifier(entry.instrumentID, 'Catalog ranking instrumentID')
      integer(entry.lookback, 'Catalog ranking lookback')
      integer(entry.rankingAsOf, 'Catalog ranking asOf')
      if (entry.lookback < 5 || entry.lookback % 5 || !Number.isSafeInteger(entry.lookback * 60_000)
        || entry.rankingAsOf % 300_000 || typeof entry.rankingChange !== 'number' || !Number.isFinite(entry.rankingChange)) throw new TypeError('Invalid confirmed catalog ranking.')
      return { instrumentID: entry.instrumentID, lookback: entry.lookback, rankingChange: entry.rankingChange, rankingAsOf: entry.rankingAsOf }
    })
    if (new Set(values.map(value => value.instrumentID)).size !== values.length) throw new TypeError('Catalog rankings contain duplicate instrument IDs.')
    if (!values.length) return []
    return this.#transaction(() => {
      const update = this.#database.prepare("UPDATE catalog SET value = json_set(value, '$.lastRanking', json(?)) WHERE id = ?")
      const updated = []
      for (const { instrumentID, ...ranking } of values) if (update.run(JSON.stringify(ranking), instrumentID).changes) updated.push(instrumentID)
      return updated
    })
  }
  getCatalogEntry(instrumentID) { const value = this.#get('catalog', instrumentID); return value && validateCatalog(value) }
  listCatalogEntries() { return this.#list('catalog').map(validateCatalog) }
  deleteCatalogEntry(instrumentID) { return this.#delete('catalog', instrumentID) }
  replaceCatalogEntries(entries) {
    if (!Array.isArray(entries)) throw new TypeError('Catalog entries must be an array.')
    const values = entries.map(validateCatalog)
    if (new Set(values.map(value => value.instrumentID)).size !== values.length) throw new TypeError('Catalog contains duplicate instrument IDs.')
    return this.#transaction(() => {
      this.#database.exec('DELETE FROM catalog')
      for (const value of values) this.#put('catalog', value.instrumentID, value)
      return values
    })
  }

  close() { if (!this.#closed) { this.#database.close(); this.#closed = true } }
}
