import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketStore } from '../electron/services/market-store.js'
import { MarketService } from '../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../electron/services/metadata-store.js'

const instId = 'BTC-USDT-SWAP'
const instrument = { instId, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '1', ctMult: '1', ctValCcy: 'BTC', ruleType: 'normal' }
const ticker = { instId, last: '100', bidPx: '99.99', askPx: '100' }
const book = { asks: [['100', '2000']], bids: [['99.99', '2000']] }
const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
const fixture = async (fetcher: typeof fetch) => {
  const preferences = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(preferences.liquidity)) rule.enabled = false
  preferences.liquidity.depth.enabled = true
  const root = await mkdtemp(join(tmpdir(), 'perp-catalog-metadata-'))
  const store = await MarketStore.open(root)
  const service = new MarketService(store, () => preferences, fetcher, false)
  await service.ready
  // These tests exercise qualification, without scheduling unrelated chart or history work.
  service.updateRanking = async () => undefined
  service.readListBars = async () => ({ bars: [] })
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, preferences, close }
}

test('renewal uses changed contract units even when the new metadata cannot prove sufficient depth', async () => {
  let currentInstrument = instrument
  const f = await fixture(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([currentInstrument])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    if (url.pathname.endsWith('/market/books')) return response([book])
    throw new Error(`Unexpected ${url}`)
  })
  try {
    await f.service.refresh()
    assert.equal(f.service.catalog.has(instId), true)
    currentInstrument = { ...instrument, ctVal: '0.01' }
    await f.service.renewCatalog()
    await Promise.all([...f.service.candidateTasks.values()])
    assert.equal(f.service.renewalTargets.get(instId).ctVal, '0.01')
    assert.equal(f.service.metadata.getCatalogEntry(instId).status, 'unknown')
    assert.equal((await f.service.snapshot()).rows.length, 0)
    await f.service.renewCatalog()
    await Promise.all([...f.service.candidateTasks.values()])
    assert.equal(f.service.metadata.getCatalogEntry(instId).instrument.ctVal, '0.01')
    assert.equal(f.service.metadata.getCatalogEntry(instId).status, 'unknown', 'An old, larger contract value must not restore qualification.')
    assert.equal((await f.service.snapshot()).rows.length, 0)
  } finally { await f.close() }
})

test('a candidate with obsolete units cannot overwrite a newer check after historical preparation', async () => {
  let currentInstrument = instrument
  const f = await fixture(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return response([currentInstrument])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    if (url.pathname.endsWith('/market/books')) return response([book])
    throw new Error(`Unexpected ${url}`)
  })
  let release!: () => void
  const historicalGate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const historicalStarted = new Promise<void>(resolve => { started = resolve })
  let staleCheck: Promise<unknown> | undefined
  try {
    f.preferences.liquidity.volume24h.enabled = true
    const step = 300_000, asOf = Math.floor(Date.now() / step) * step
    await f.store.appendCandles(Array.from({ length: 287 }, (_, index) => ({
      instrument: instId, timeframe: '5m', timestamp: asOf - (288 - index) * step,
      open: 100, high: 100, low: 100, close: 100, volume: 1, baseVolume: 1, quoteVolume: 200_000, confirmed: true,
    })))
    let sourceCalls = 0
    f.service.history.ensurePrices = async () => {
      if (sourceCalls++ === 0) { started(); await historicalGate }
      return { rows: [] }
    }
    const configKey = JSON.stringify(f.preferences.liquidity), signal = new AbortController().signal
    await f.service.discoverInstruments(configKey, signal, 'foreground')
    staleCheck = f.service.checkCandidate(instrument, f.preferences.liquidity, configKey, signal)
    await historicalStarted
    currentInstrument = { ...instrument, ctVal: '0.01' }
    await f.service.discoverInstruments(configKey, signal, 'foreground')
    await f.service.checkCandidate(currentInstrument, f.preferences.liquidity, configKey, signal)
    assert.equal(sourceCalls, 2, 'Changed metadata must start a new check instead of joining the obsolete task.')
    const currentRecord = f.service.metadata.getCatalogEntry(instId)
    assert.equal(currentRecord.status, 'unknown')
    assert.equal(currentRecord.instrument.ctVal, '0.01')
    release(); await staleCheck
    assert.deepEqual(f.service.metadata.getCatalogEntry(instId), currentRecord, 'The older historical task must not publish or restore old units.')
    assert.equal((await f.service.snapshot()).rows.length, 0)
  } finally { release(); await staleCheck; await f.close() }
})

test('instrument discovery failure cannot renew an old qualification lease', async () => {
  let unavailable = false, bookCalls = 0
  const f = await fixture(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/public/instruments')) return unavailable ? new Response('', { status: 503 }) : response([instrument])
    if (url.pathname.endsWith('/market/tickers')) return response([ticker])
    if (url.pathname.endsWith('/market/books')) { bookCalls += 1; return response([book]) }
    throw new Error(`Unexpected ${url}`)
  })
  try {
    await f.service.refresh()
    const previous = f.service.metadata.getCatalogEntry(instId)
    unavailable = true
    await f.service.renewCatalog()
    assert.deepEqual(f.service.metadata.getCatalogEntry(instId), previous)
    assert.equal(bookCalls, 1, 'Live observations cannot extend qualification when current metadata is unavailable.')
    const now = Date.now(), expired = { ...previous, observedAt: now - 90_001, expiresAt: now - 1,
      observations: { ...previous.observations, book: { ...previous.observations.book, observedAt: now - 90_001, expiresAt: now - 1 } } }
    f.service.metadata.putCatalogEntry(expired)
    f.service.catalog.set(instId, expired)
    assert.equal((await f.service.snapshot()).rows.length, 0)
    await f.service.renewCatalog()
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.rows.length, 0)
    assert.match(snapshot.error, /instruments.*503/i)
    assert.deepEqual(f.service.metadata.getCatalogEntry(instId), expired, 'An expired lease must remain expired after a metadata outage.')
  } finally { await f.close() }
})
