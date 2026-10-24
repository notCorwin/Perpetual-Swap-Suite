import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarketBackend } from '../../electron/services/market-backend.js'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange, nativeIntervals } from '../helpers/native-exchange.mjs'

const waitFor = async (condition, description) => {
  const deadline = performance.now() + 20_000
  while (!await condition()) {
    assert.ok(performance.now() < deadline, `Backend did not ${description} without a renderer.`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('backend collection, gap repair, and all-period preparation run before any renderer or chart read', { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-backend-lifecycle-'))
  const exchange = await createNativeExchange()
  let backend
  try {
    const metadata = await MetadataStore.open(userData)
    try {
      const preferences = structuredClone(DEFAULT_PREFERENCES)
      for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
      metadata.updateSettings(preferences)
    } finally { metadata.close() }
    const store = await MarketStore.open(join(userData, 'MarketData'))
    try { await store.appendCandles(exchange.closedCandles) } finally { await store.close() }

    // Workers copy the environment at construction. No BrowserWindow, preload,
    // renderer subscription, snapshot, universe read, or focus command exists.
    const previous = Object.fromEntries(Object.keys(exchange.environment).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, exchange.environment)
      backend = new MarketBackend({ userData, testMode: true })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const published = new Map()
    backend.on('chart', frame => { if (Array.isArray(frame.bars)) published.set(`${frame.instId}:${frame.timeframe}`, frame) })
    await backend.ready
    const ids = exchange.instruments.map(value => value.instId)
    await Promise.all(ids.flatMap(instId => Object.keys(nativeIntervals).map(timeframe => exchange.waitForSubscription(instId, `candle${timeframe}`))))
    await exchange.waitForHeldHistory()
    assert.ok(await exchange.releaseHistory() > 0, 'Automatic collection must acquire the genuinely missing closed candle.')
    await waitFor(() => ids.every(instId => Object.keys(nativeIntervals).every(timeframe => {
      const frame = published.get(`${instId}:${timeframe}`)
      return frame?.bars.length === 96 && frame.indicatorState === 'ready'
        && frame.oiState === 'unavailable' && frame.takerState === 'unavailable'
    })), 'publish every qualified native frame and its successful-empty source status')

    const repaired = await backend.request({ e2e: { action: 'readCandles', instrument: ids[0], timeframe: '15m', from: exchange.deferredEnd, through: exchange.deferredEnd } })
    assert.equal(repaired.length, 1)
    assert.equal(repaired[0].confirmed, true)
    const changed = exchange.sendCandle(ids[1], '5m', { timestamp: Math.floor(exchange.asOf / nativeIntervals['5m']) * nativeIntervals['5m'] - nativeIntervals['5m'], close: 551.25, confirmed: true })
    await waitFor(async () => {
      const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[1], timeframe: '5m', from: changed.hour, through: changed.hour } })
      return rows[0]?.close === changed.close
    }, 'persist an unselected contract update')
    await waitFor(() => published.get(`${ids[1]}:5m`)?.bars.at(-1)?.close === changed.close, 'recalculate the unselected native frame')

    // With sources settled, observational reads cannot manufacture new repair
    // work, focus ownership, or source demand for any period.
    await backend.probe({ action: 'sourceInstall', instId: ids[0] })
    const first = await backend.request({ snapshot: {} })
    assert.equal(first.rows.length, ids.length)
    assert.equal('timeframe' in first, false)
    assert.equal('listProgress' in first, false)
    for (let pass = 0; pass < 2; pass++) {
      const universe = await backend.request({ chartUniverse: {} })
      assert.equal(universe.frames.length, ids.length * Object.keys(nativeIntervals).length)
      assert.deepEqual(new Set(universe.frames.map(frame => `${frame.instId}:${frame.timeframe}`)), new Set(published.keys()))
      for (const timeframe of Object.keys(nativeIntervals)) {
        assert.ok(await backend.request({ chartLocal: { instId: ids[0], timeframe } }))
        await backend.request({ chartHistory: { instId: ids[0], timeframe } })
      }
      const same = await backend.request({ snapshot: { sinceRevision: first.revision, serviceSession: first.serviceSession } })
      if (!same.unchanged) assert.deepEqual(same.rows.map(row => row.instId).sort(), [...ids].sort())
    }
    assert.deepEqual(await backend.probe({ action: 'sourceRead' }), [], 'Snapshot, resident-frame, local, and history reads must not start downloads.')
    assert.deepEqual(exchange.errors, [])
  } finally {
    await exchange.releaseHistory().catch(() => {})
    await backend?.dispose()
    await exchange.close()
    await rm(userData, { recursive: true, force: true })
  }
})
