import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_PREFERENCES, MetadataStore, SettingsRevisionConflictError, validatePreferences } from '../electron/services/metadata-store.js'
import { emptyHistoryDownload } from '../electron/services/history-download.js'

const temporary = () => mkdtemp(join(tmpdir(), 'perp-metadata-'))
const syncTask = (id = 'history-1') => ({
  id, schemaVersion: 1 as const, instrument: 'BTC-USDT-SWAP', timeframe: '5m' as const, source: 'candles', from: 0, through: 600_000,
  purpose: 'history', priority: 'background', status: 'queued' as const, createdAt: 1, updatedAt: 2, nextAttemptAt: null, attempts: 0,
  cursor: null, unavailableRanges: [], remaining: [{ from: 0, through: 600_000 }], writtenRecords: 0, lastError: null,
})
const catalogEntry = (instrumentID = 'BTC-USDT-SWAP') => ({ instrumentID, status: 'verified' as const, observedAt: 1000, expiresAt: 2000, preferencesRevision: 2, observations: { spread: 0.01 } })

test('sync checkpoint batches validate atomically and delete in one transaction', async () => {
  const root = await temporary(), store = await MetadataStore.open(root)
  try {
    store.putSyncTasks([syncTask('one'), syncTask('two')])
    assert.equal(store.listSyncTasks().length, 2)
    assert.throws(() => store.putSyncTasks([syncTask('three'), { ...syncTask('invalid'), through: -1 }]), TypeError)
    assert.equal(store.getSyncTask('three'), null)
    assert.equal(store.deleteSyncTasks(['one', 'two', 'absent']), 2)
    assert.deepEqual(store.listSyncTasks(), [])
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('preference schema has exact defaults, validates nested rules, and returns detached values', () => {
  const preferences = validatePreferences(DEFAULT_PREFERENCES)
  assert.deepEqual(preferences, {
    chartTimeframe: '15m', rankingLookback: 15, historyDays: 30,
    liquidity: {
      spread: { enabled: true, maxPercent: 0.05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: true, maxPercent: 0.1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
      openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 },
    },
  })
  preferences.liquidity.spread.maxPercent = 1
  assert.equal(DEFAULT_PREFERENCES.liquidity.spread.maxPercent, 0.05)
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES.liquidity.slippage), true)
  assert.equal(validatePreferences({ ...DEFAULT_PREFERENCES, historyDays: 3650 }).historyDays, 3650)
  for (const invalid of [
    { ...DEFAULT_PREFERENCES, rankingLookback: 7 }, { ...DEFAULT_PREFERENCES, rankingLookback: 0 }, { ...DEFAULT_PREFERENCES, rankingLookback: 9_007_199_254_740_990 },
    { ...DEFAULT_PREFERENCES, historyDays: 0 }, { ...DEFAULT_PREFERENCES, historyDays: 1.5 }, { ...DEFAULT_PREFERENCES, historyDays: 3651 },
    { ...DEFAULT_PREFERENCES, chartTimeframe: '1m' }, { ...DEFAULT_PREFERENCES, frostedBackgroundEnabled: true },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, spread: { enabled: true, maxPercent: Infinity } } },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, depth: { enabled: 1, minUSDT: 100 } } },
    { ...DEFAULT_PREFERENCES, liquidity: { ...DEFAULT_PREFERENCES.liquidity, slippage: { enabled: true, maxPercent: 0.1 } } },
  ]) assert.throws(() => validatePreferences(invalid), TypeError)
})

test('independent connections merge settings at the latest revision and reject stale conditional writes', async () => {
  const root = await temporary()
  const first = await MetadataStore.open(root)
  const second = await MetadataStore.open(root)
  try {
    assert.equal(first.getSettings().revision, 0)
    first.updateSettings({ chartTimeframe: '1H', liquidity: { spread: { maxPercent: 0.02 } } })
    second.updateSettings({ rankingLookback: 60, liquidity: { spread: { enabled: false }, slippage: { notionalUSDT: 50_000 } } })
    const merged = first.getSettings()
    assert.equal(merged.revision, 2)
    assert.equal(merged.preferences.chartTimeframe, '1H')
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

test('one-time legacy import retains private analysis, maps stability, and discards glass settings', async () => {
  const root = await temporary()
  const path = join(root, 'settings.json')
  const legacy = { hourlyVolumeStabilityEnabled: true, windowBlurRadius: 64, frostedBackgroundEnabled: true, analysis: { model: 'fixture-model', apiKey: 'fixture-private-value', provider: { name: 'fixture' } } }
  await writeFile(path, JSON.stringify(legacy))
  let store = await MetadataStore.open(root)
  try {
    const settings = store.getSettings()
    assert.equal(settings.revision, 1)
    assert.equal(settings.preferences.liquidity.volumeStability.enabled, true)
    assert.deepEqual(store.getAnalysisSettings(), legacy.analysis)
    assert.equal(JSON.stringify(settings).includes('fixture-private-value'), false)
    assert.equal('analysis' in settings, false)
    assert.equal('frostedBackgroundEnabled' in settings.preferences, false)
    store.updateAnalysisSettings({ model: 'fixture-next' })
    assert.equal(store.getAnalysisSettings().apiKey, 'fixture-private-value')
    const returned = store.getAnalysisSettings()
    returned.apiKey = ''
    assert.equal(store.getAnalysisSettings().apiKey, 'fixture-private-value')
    await writeFile(path, JSON.stringify({ ...legacy, hourlyVolumeStabilityEnabled: false, analysis: { model: 'ignored' } }))
    store.close(); store = await MetadataStore.open(root)
    assert.equal(store.getSettings().preferences.liquidity.volumeStability.enabled, true)
    assert.equal(store.getAnalysisSettings().model, 'fixture-next')
    assert.equal(store.getSettings().revision, 1)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).analysis.model, 'ignored', 'Migration never rewrites its source.')
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('malformed legacy input is preserved without error snippets and can be retried after correction', async () => {
  const root = await temporary()
  const path = join(root, 'old-settings.json')
  try {
    const malformed = '{"analysis":{"apiKey":"fixture-private-value"},broken}'
    await writeFile(path, malformed)
    await assert.rejects(MetadataStore.open(root, { legacySettingsPath: path }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(String(error).includes('fixture-private-value'), false)
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(await readFile(path, 'utf8'), malformed)
    await writeFile(path, JSON.stringify({ chartTimeframe: '5m', analysis: { model: 'fixture' } }))
    const store = await MetadataStore.open(root, { legacySettingsPath: path })
    try { assert.equal(store.getSettings().preferences.chartTimeframe, '5m'); assert.equal(store.getSettings().revision, 1) }
    finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy sync, audit and manual download checkpoints persist across restart', async () => {
  const root = await temporary()
  let store = await MetadataStore.open(root)
  try {
    const task = syncTask()
    store.putSyncTask(task)
    const checkpoint = { id: 'audit-1', schemaVersion: 1 as const, status: 'running' as const, phase: 'inspect' as const, targets: [{ instrument: 'BTC-USDT-SWAP', timeframe: '5m', from: 0, through: 600_000 }], cursor: { targetIndex: 0, nextFrom: 300_000 }, issues: [{ type: 'off-grid', timeframe: 'invalid', from: 42, through: 42 }], checkedRows: 2, createdAt: 1, updatedAt: 2, completedAt: null }
    store.saveAudit(checkpoint)
    const download = { ...emptyHistoryDownload(), phase: 'cancelled' as const, startedAt: 1, finishedAt: 2 }
    store.saveHistoryDownload(download)
    task.remaining.length = 0
    assert.deepEqual(store.getSyncTask(task.id)?.remaining, [{ from: 0, through: 600_000 }])
    assert.throws(() => store.putSyncTask({ ...syncTask(), from: 1 }), /grid/)
    assert.throws(() => store.putSyncTask({ ...syncTask(), from: 900_000, through: 0 }), /precede/)
    assert.throws(() => store.putSyncTask({ ...syncTask(), attempts: NaN }), TypeError)
    assert.throws(() => store.putSyncTask({ ...syncTask(), remaining: [{ from: 0, through: Infinity }] }), TypeError)
    assert.throws(() => store.saveAudit({ ...checkpoint, status: 'unknown' } as never), /status/)
    assert.throws(() => store.saveAudit({ ...checkpoint, checkedRows: -1 }), TypeError)
    store.close(); store = await MetadataStore.open(root)
    assert.equal(store.listSyncTasks().length, 1)
    assert.deepEqual(store.getAudit(checkpoint.id), checkpoint)
    assert.equal(store.listAudits().length, 1)
    assert.deepEqual(store.getHistoryDownload(), download)
    assert.equal(store.getSyncTask('missing'), null)
    assert.equal(store.deleteSyncTask(task.id), true)
    assert.equal(store.deleteSyncTask(task.id), false)
    const database = new DatabaseSync(join(root, 'metadata.sqlite'))
    try {
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name)
      assert.deepEqual(tables, ['analysis_settings', 'audits', 'catalog', 'history_download', 'migrations', 'settings', 'sync_tasks'])
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
