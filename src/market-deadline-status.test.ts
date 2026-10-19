import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

test('a market push arriving before the closing deadline callback reports queued revalidation without starting source work', async t => {
  const step = 300_000, instId = 'BTC-USDT-SWAP'
  let now = Math.floor(Date.now() / step) * step + step - 15_000
  t.mock.method(Date, 'now', () => now)
  const root = await mkdtemp(join(tmpdir(), 'perp-deadline-status-'))
  const store = await MarketStore.open(root)
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const [key, rule] of Object.entries(preferences.liquidity)) rule.enabled = key === 'volume24h'
  let fetches = 0
  const service = new MarketService(store, () => preferences, async input => {
    fetches += 1
    const path = new URL(String(input)).pathname
    const data = path.endsWith('/public/instruments')
      ? [{ instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }]
      : path.endsWith('/market/tickers') ? [{ instId, last: '100', bidPx: '99.99', askPx: '100' }] : null
    assert.ok(data, `Snapshot status must not acquire ${path}.`)
    return new Response(JSON.stringify({ code: '0', data }))
  }, false)
  try {
    await service.ready
    service.projectListEntry = async () => null
    service.updateRanking = async () => undefined
    service.scheduleListProjection = () => undefined
    const asOf = Math.floor(now / step) * step
    await store.appendCandles(Array.from({ length: 288 }, (_, index) => ({ instrument: instId, timeframe: '5m',
      timestamp: asOf - (288 - index) * step, open: 99, high: 101, low: 98, close: 100,
      volume: 2_000, baseVolume: 20, quoteVolume: 200_000, confirmed: true })))
    await service.refresh()
    assert.equal(service.catalog.get(instId)?.status, 'verified')
    const acquired = fetches
    service.autoRefresh = true
    now = asOf + step
    assert.equal(service.marketDeadlineAt, now)
    const queued = await service.snapshot()
    assert.deepEqual(queued.rows, [])
    assert.equal(queued.catalogProgress.unknown, 1)
    assert.equal(queued.catalogProgress.pending, 1)
    assert.equal(queued.loading, true)
    assert.equal(queued.error, '')
    assert.equal(service.sourceRecoveries.size, 0, 'A read-only snapshot must not dispatch the queued deadline.')
    assert.equal(fetches, acquired)
    service.autoRefresh = false
    service.processMarketDeadline()
    const stopped = await service.snapshot()
    assert.equal(stopped.catalogProgress.pending, 0)
    assert.equal(stopped.loading, false)
    assert.match(stopped.error, /verification is unavailable/i, 'Data without scheduled acquisition must remain explicitly unavailable.')
  } finally { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
