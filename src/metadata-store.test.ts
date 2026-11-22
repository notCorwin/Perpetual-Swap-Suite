import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_PREFERENCES, MetadataStore, SettingsRevisionConflictError, validatePreferences } from '../electron/services/metadata-store.js'
import { emptyHistoryDownload } from '../electron/services/history-download.js'

const temporary = () => mkdtemp(join(tmpdir(), 'perp-metadata-'))
const catalogEntry = (instrumentID = 'BTC-USDT-SWAP') => ({ instrumentID, status: 'verified' as const, observedAt: 1000, expiresAt: 2000, preferencesRevision: 2, observations: { spread: 0.01 } })

test('preference schema owns immutable snapshots, reuses proven values and validates changed inputs', () => {
  const input = structuredClone(DEFAULT_PREFERENCES)
  const preferences = validatePreferences(input)
  assert.deepEqual(preferences, {
    chartDisplayMode: 'multi', showBollingerPriceLabels: false, rankingLookback: 15, historyDays: 30,
    liquidity: {
      spread: { enabled: true, maxPercent: 0.05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
      openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 },
    },
  })
  assert.equal(Reflect.set(preferences.liquidity.spread, 'maxPercent', 1), false)
  assert.equal(validatePreferences(preferences), preferences)
  input.liquidity.spread.maxPercent = 1
  assert.equal(preferences.liquidity.spread.maxPercent, 0.05)
  assert.equal(validatePreferences(input).liquidity.spread.maxPercent, 1)
  let reads = 0
  const changing = { ...input, get rankingLookback() { return ++reads === 1 ? 15 : -1 } }
  assert.throws(() => validatePreferences(changing), /rankingLookback/, 'A changing accessor cannot admit an unvalidated immutable snapshot.')
  assert.equal(DEFAULT_PREFERENCES.liquidity.spread.maxPercent, 0.05)
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES.liquidity.slippage), true)
  assert.equal(validatePreferences({ ...DEFAULT_PREFERENCES, historyDays: 3650 }).historyDays, 3650)
  for (const invalid of [
    { ...DEFAULT_PREFERENCES, rankingLookback: 7 }, { ...DEFAULT_PREFERENCES, rankingLookback: 0 }, { ...DEFAULT_PREFERENCES, rankingLookback: 9_007_199_254_740_990 },
    { ...DEFAULT_PREFERENCES, historyDays: 0 }, { ...DEFAULT_PREFERENCES, historyDays: 1.5 }, { ...DEFAULT_PREFERENCES, historyDays: 3651 },
    { ...DEFAULT_PREFERENCES, showBollingerPriceLabels: 1 },
    { ...DEFAULT_PREFERENCES, frostedBackgroundEnabled: true },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, spread: { enabled: true, maxPercent: Infinity } } },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, depth: { enabled: 1, minUSDT: 100 } } },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, slippage: { enabled: true, maxPercent: 0.1 } } },
  ]) assert.throws(() => validatePreferences(invalid), TypeError)
})

test('unchanged preference saves keep their durable revision', async () => {
  const root = await temporary(), store = await MetadataStore.open(root)
  try {
    const before = store.getSettings()
    assert.deepEqual(store.updateSettings({}), before)
    assert.deepEqual(store.getSettings(), before)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('identical metadata checkpoints cause no SQLite commit and changed values survive reopen', async () => {
  const root = await temporary()
  let store = await MetadataStore.open(root)
  const observer = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true })
  const version = () => observer.prepare('PRAGMA data_version').get()!.data_version
  const audit = { id: 'checkpoint', status: 'running' as const, phase: 'inspect' as const, checkedRows: 42 }
  const download = emptyHistoryDownload(), catalog = catalogEntry()
  try {
    store.saveAudit(audit); store.saveHistoryDownload(download); store.putCatalogEntry(catalog)
    const before = version()
    for (let count = 0; count < 20; count++) {
      store.saveAudit(structuredClone(audit))
      store.saveHistoryDownload(structuredClone(download))
      store.putCatalogEntry(structuredClone(catalog))
    }
    assert.equal(version(), before, 'Unchanged checkpoints must not dirty database pages or append to the WAL.')
    const changed = { ...catalog, observedAt: 1500 }
    store.putCatalogEntry(changed)
    assert.notEqual(version(), before)
    store.close(); store = await MetadataStore.open(root)
    assert.deepEqual(store.getCatalogEntry(catalog.instrumentID), changed)
    assert.deepEqual(store.getAudit(audit.id), audit)
    assert.deepEqual(store.getHistoryDownload(), download)
  } finally { observer.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('independent connections merge settings at the latest revision and reject stale conditional writes', async () => {
  const root = await temporary()
  const first = await MetadataStore.open(root)
  const second = await MetadataStore.open(root)
  try {
    assert.equal(first.getSettings().revision, 0)
    first.updateSettings({ liquidity: { spread: { maxPercent: 0.02 } } })
    second.updateSettings({ rankingLookback: 60, liquidity: { spread: { enabled: false }, slippage: { notionalUSDT: 50_000 } } })
    const merged = first.getSettings()
    assert.equal(merged.revision, 2)
    assert.equal(merged.preferences.rankingLookback, 60)
    assert.deepEqual(merged.preferences.liquidity.spread, { enabled: false, maxPercent: 0.02 })
    assert.deepEqual(merged.preferences.liquidity.slippage, { enabled: true, maxPercent: 0.1, notionalUSDT: 50_000 })
    assert.throws(() => second.updateSettings({ historyDays: 7 }, { expectedRevision: 1 }), (error: unknown) => {
      assert.ok(error instanceof SettingsRevisionConflictError)
      assert.equal(error.code, 'SETTINGS_REVISION_CONFLICT')
      assert.equal(error.actualRevision, 2)
      return true
    })
    assert.deepEqual(first.getSettings(), merged)
    second.updateSettings({ historyDays: 14 }, { expectedRevision: merged.revision })
    first.close(); second.close()
    const reopened = await MetadataStore.open(root)
    try { assert.equal(reopened.getSettings().preferences.historyDays, 14); assert.equal(reopened.getSettings().revision, 3) }
    finally { reopened.close() }
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }) }
})

test('invalid partial saves have no side effects and SQLite failures roll back the transaction', async () => {
  const root = await temporary()
  const store = await MetadataStore.open(root)
  const database = new DatabaseSync(join(root, 'metadata.sqlite'))
  try {
    const original = store.getSettings()
    const invalidPatches = [
      { chartTimeframe: '5m', historyDays: -1 }, { liquidity: { spread: { enabled: 'yes' } } },
      { liquidity: { depth: { enabled: false, legacyThreshold: 10 } } }, { analysis: { apiKey: 'fixture-only' } },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ]
    for (const patch of invalidPatches) assert.throws(() => store.updateSettings(patch as never), TypeError)
    assert.deepEqual(store.getSettings(), original)
    database.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'Injected transaction failure'); END")
    assert.throws(() => store.updateSettings({ historyDays: 9 }), /Injected transaction failure/)
    assert.deepEqual(store.getSettings(), original)
    database.exec('DROP TRIGGER fail_settings')
    assert.equal(store.updateSettings({ historyDays: 9 }).revision, 1)
    const permissions = (await stat(join(root, 'metadata.sqlite'))).mode & 0o777
    assert.equal(permissions, 0o600)
  } finally { database.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('audit and manual download checkpoints persist across restart', async () => {
  const root = await temporary()
  let store = await MetadataStore.open(root)
  try {
    const checkpoint = { id: 'audit-1', schemaVersion: 1 as const, status: 'running' as const, phase: 'inspect' as const, targets: [{ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: 0, through: 600_000 }], cursor: { targetIndex: 0, nextFrom: 300_000 }, issues: [{ type: 'off-grid', timeframe: 'invalid', from: 42, through: 42 }], checkedRows: 2, createdAt: 1, updatedAt: 2, completedAt: null }
    store.saveAudit(checkpoint)
    const download = { ...emptyHistoryDownload(), phase: 'cancelled' as const, startedAt: 1, finishedAt: 2 }
    store.saveHistoryDownload(download)
    assert.throws(() => store.saveAudit({ ...checkpoint, status: 'unknown' } as never), /status/)
    assert.throws(() => store.saveAudit({ ...checkpoint, checkedRows: -1 }), TypeError)
    store.close(); store = await MetadataStore.open(root)
    assert.deepEqual(store.getAudit(checkpoint.id), checkpoint)
    assert.equal(store.listAudits().length, 1)
    assert.deepEqual(store.getHistoryDownload(), download)
    const database = new DatabaseSync(join(root, 'metadata.sqlite'))
    try {
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name)
      assert.deepEqual(tables, ['analysis_settings', 'audits', 'catalog', 'history_download', 'settings'])
    } finally { database.close() }
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('catalog snapshots replace atomically and cannot silently renew observation freshness', async () => {
  const root = await temporary()
  const store = await MetadataStore.open(root)
  const database = new DatabaseSync(join(root, 'metadata.sqlite'))
  try {
    const btc = catalogEntry()
    store.putCatalogEntry(btc)
    assert.deepEqual(store.getCatalogEntry(btc.instrumentID), btc)
    store.putCatalogEntry({ ...btc, status: 'unknown' })
    assert.equal(store.getCatalogEntry(btc.instrumentID)?.expiresAt, 2000)
    const before = store.listCatalogEntries()
    assert.throws(() => store.replaceCatalogEntries([catalogEntry('ETH-USDT-SWAP'), { ...btc, expiresAt: 0 }]), /precede/)
    assert.throws(() => store.replaceCatalogEntries([btc, btc]), /duplicate/)
    assert.deepEqual(store.listCatalogEntries(), before)
    database.exec("CREATE TRIGGER fail_catalog BEFORE INSERT ON catalog BEGIN SELECT RAISE(ABORT, 'Injected catalog failure'); END")
    assert.throws(() => store.replaceCatalogEntries([catalogEntry('ETH-USDT-SWAP')]), /Injected catalog failure/)
    assert.deepEqual(store.listCatalogEntries(), before, 'Deleting the old catalog rolls back when a later insertion fails.')
    database.exec('DROP TRIGGER fail_catalog')
    store.replaceCatalogEntries([catalogEntry('ETH-USDT-SWAP')])
    assert.equal(store.getCatalogEntry(btc.instrumentID), null)
    assert.equal(store.deleteCatalogEntry('ETH-USDT-SWAP'), true)
    assert.deepEqual(store.listCatalogEntries(), [])
  } finally { database.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('ranking batches preserve qualification observations, roll back together, and never recreate deleted contracts', async () => {
  const root = await temporary(), store = await MetadataStore.open(root)
  const database = new DatabaseSync(join(root, 'metadata.sqlite'))
  try {
    const first = catalogEntry(), second = catalogEntry('ETH-USDT-SWAP')
    store.putCatalogEntry(first); store.putCatalogEntry(second)
    const rankings = [
      { instrumentID: first.instrumentID, lookback: 15, rankingChange: 12.5, rankingAsOf: 600_000 },
      { instrumentID: second.instrumentID, lookback: 30, rankingChange: -4, rankingAsOf: 600_000 },
    ]
    assert.throws(() => store.saveCatalogRankings([rankings[0], { ...rankings[1], rankingAsOf: 1 }]), /Invalid confirmed/)
    assert.deepEqual(store.getCatalogEntry(first.instrumentID), first)
    database.exec("CREATE TRIGGER fail_rank_batch BEFORE UPDATE ON catalog WHEN NEW.id = 'ETH-USDT-SWAP' BEGIN SELECT RAISE(ABORT, 'Injected ranking failure'); END")
    assert.throws(() => store.saveCatalogRankings(rankings), /Injected ranking failure/)
    assert.deepEqual(store.getCatalogEntry(first.instrumentID), first, 'A later ranking failure must roll back earlier updates in the batch.')
    database.exec('DROP TRIGGER fail_rank_batch')
    const latest = { ...first, status: 'unknown' as const, observedAt: 3000, expiresAt: 3000, observations: { spread: 0.02 } }
    store.putCatalogEntry(latest)
    store.deleteCatalogEntry(second.instrumentID)
    assert.deepEqual(store.saveCatalogRankings(rankings), [first.instrumentID])
    assert.deepEqual(store.getCatalogEntry(first.instrumentID), { ...latest, lastRanking: { lookback: 15, rankingChange: 12.5, rankingAsOf: 600_000 } })
    assert.equal(store.getCatalogEntry(second.instrumentID), null)
  } finally { database.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('existing SQLite preferences gain the multi default and preserve a saved indicator-mode choice', async () => {
  const root = await temporary()
  let store = await MetadataStore.open(root)
  try {
    store.updateSettings({ historyDays: 45 })
    store.close()
    const database = new DatabaseSync(join(root, 'metadata.sqlite'))
    try {
      const row = database.prepare('SELECT preferences FROM settings WHERE id=1').get()!
      const old = JSON.parse(row.preferences as string)
      delete old.chartDisplayMode
      delete old.showBollingerPriceLabels
      database.prepare('UPDATE settings SET preferences=? WHERE id=1').run(JSON.stringify(old))
    } finally { database.close() }
    store = await MetadataStore.open(root)
    assert.equal(store.getSettings().preferences.chartDisplayMode, 'multi')
    assert.equal(store.getSettings().preferences.showBollingerPriceLabels, false)
    assert.equal(store.getSettings().preferences.historyDays, 45)
    store.updateSettings({ chartDisplayMode: 'indicators', showBollingerPriceLabels: true })
    store.close(); store = await MetadataStore.open(root)
    assert.equal(store.getSettings().preferences.chartDisplayMode, 'indicators')
    assert.equal(store.getSettings().preferences.showBollingerPriceLabels, true)
    assert.throws(() => store.updateSettings({ chartDisplayMode: 'unknown' } as any), /chartDisplayMode/)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('unsupported metadata schemas are rejected without changing existing data', async () => {
  const root = await temporary()
  try {
    const database = new DatabaseSync(join(root, 'metadata.sqlite'))
    try { database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('preserved'); PRAGMA user_version=1;") }
    finally { database.close() }
    await assert.rejects(MetadataStore.open(root), /Unsupported metadata database schema version/)
    const retained = new DatabaseSync(join(root, 'metadata.sqlite'), { readOnly: true })
    try { assert.equal(retained.prepare('SELECT value FROM retained').get()!.value, 'preserved') }
    finally { retained.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
